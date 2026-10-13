import { createReadStream, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { bump, db, kv, version } from './db.mjs';
import { costOf } from './sessions.mjs';

// AI consumption across EVERY Claude Code session on this Mac, not just the dashboard's:
// each transcript in ~/.claude/projects is scanned incrementally (byte offset per file) and
// each API message lands once in `usage`, priced at API list prices (an estimate on a seat).

const ROOT = join(homedir(), '.claude/projects');

function* files(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

const insert = db.prepare(`INSERT OR IGNORE INTO usage (msg_id, ts, day, project, session_id, model, input, output, cache_read, cache_write, cost)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const touched = { days: new Set(), sessions: new Set() };

async function scanFile(path, from) {
  const project = path.slice(ROOT.length + 1).split('/')[0];
  const rl = createInterface({ input: createReadStream(path, { start: from }), crlfDelay: Infinity });
  let bytes = from;
  let pendingBytes = 0;
  db.exec('BEGIN');
  try {
    for await (const line of rl) {
      pendingBytes = Buffer.byteLength(line) + 1;
      if (!line.endsWith('}')) break; // a line still being written: retry next scan
      bytes += pendingBytes;
      if (!line.includes('"usage"')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const m = e.message;
      if (e.type !== 'assistant' || !m?.usage || !m.id || !m.model || m.model === '<synthetic>') continue;
      const u = m.usage;
      const ts = e.timestamp ?? new Date().toISOString();
      const d = new Date(ts);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const r = insert.run(m.id, ts, day, project, e.sessionId ?? null, m.model, u.input_tokens ?? 0, u.output_tokens ?? 0,
        u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, costOf(m.model, u));
      if (r.changes) { touched.days.add(day); touched.sessions.add(e.sessionId ?? '?'); }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return bytes;
}

let scanning = false;
export async function scanUsage() {
  if (scanning) return 0;
  scanning = true;
  const offsets = kv.get('usageOffsets') ?? {};
  let changed = 0;
  try {
    for (const path of files(ROOT)) {
      const size = statSync(path).size;
      if ((offsets[path] ?? 0) >= size) continue;
      offsets[path] = await scanFile(path, offsets[path] ?? 0);
      changed += 1;
    }
    refreshRollups();
  } finally {
    kv.set('usageOffsets', offsets);
    scanning = false;
  }
  return changed;
}

// Past days never change once scanned: the rollups are rebuilt only for what a scan touched,
// and the Conso page reads them instead of the raw per-message table.
const FAM = `CASE WHEN model LIKE '%fable%' OR model LIKE '%mythos%' THEN 'fable' WHEN model LIKE '%opus%' THEN 'opus'
  WHEN model LIKE '%sonnet%' THEN 'sonnet' WHEN model LIKE '%haiku%' THEN 'haiku' ELSE model END`;
const SUMS = 'SUM(cost), SUM(input + output + cache_read + cache_write), SUM(input), SUM(output), SUM(cache_read), SUM(cache_write), COUNT(*)';
function refreshRollups() {
  const empty = !db.prepare('SELECT 1 FROM usage_hour LIMIT 1').get();
  if (!empty && !touched.days.size) return;
  const days = empty ? null : [...touched.days];
  const sids = empty ? null : [...touched.sessions];
  const inList = (xs) => xs.map(() => '?').join(',');
  db.exec('BEGIN');
  try {
    if (empty) { db.exec('DELETE FROM usage_hour'); db.exec('DELETE FROM usage_sess'); } else {
      db.prepare(`DELETE FROM usage_hour WHERE day IN (${inList(days)})`).run(...days);
      db.prepare(`DELETE FROM usage_sess WHERE session_id IN (${inList(sids)})`).run(...sids);
    }
    db.prepare(`INSERT INTO usage_hour SELECT day, CAST(strftime('%H', ts, 'localtime') AS INTEGER) h, project, ${FAM} fam, ${SUMS}
      FROM usage ${empty ? '' : `WHERE day IN (${inList(days)})`} GROUP BY day, h, project, fam`).run(...(days ?? []));
    db.prepare(`INSERT INTO usage_sess SELECT COALESCE(session_id, '?'), MIN(ts), MAX(project), MAX(${FAM}), ${SUMS}
      FROM usage ${empty ? '' : `WHERE COALESCE(session_id, '?') IN (${inList(sids)})`} GROUP BY COALESCE(session_id, '?')`).run(...(sids ?? []));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  touched.days.clear(); touched.sessions.clear();
  bump('usage');
}

/** "-Users-eric-HiveBrite-hivebrite-mobile--claude-worktrees-review-3540" → "hivebrite-mobile". */
const prettyProject = (p) => {
  if (/-claude-pr-autoreview$/.test(p)) return 'dashboard (sync Jira/Slack)';
  if (/^-private-tmp|^-tmp/.test(p)) return 'tmp';
  const s = p.replace(/^-Users-[^-]+-/, '').replace(/--claude-worktrees-.*$/, '').replace(/-+wt-.*$/, '');
  const parts = s.split('-').filter(Boolean);
  // HiveBrite/<repo>/<subdir…> → the repo, folding monorepo subfolders (apps/mobile_app…) into it.
  if (/^HiveBrite$/i.test(parts[0])) return parts[1] === 'hivebrite' && parts[2] ? `hivebrite-${parts[2]}` : parts.slice(1, 3).join('-') || 'HiveBrite';
  if (parts[0] === 'perso') return `perso/${parts.slice(1).join('-')}`;
  return s || p;
};

const ZERO = { cost: 0, tokens: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, n: 0 };
const COLS = 'SUM(cost) cost, SUM(tokens) tokens, SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, SUM(cache_write) cache_write, SUM(n) n';
const add = (a, b) => Object.fromEntries(Object.keys(ZERO).map((k) => [k, (a[k] ?? 0) + (b[k] ?? 0)]));
const fold = (rows, keyOf) => {
  const m = new Map();
  for (const r of rows) { const k = keyOf(r); m.set(k, { ...add(m.get(k) ?? ZERO, r), key: k }); }
  return [...m.values()].sort((a, b) => b.cost - a.cost);
};
const memo = new Map(); // params → { v, out }

/** Everything the Conso page draws, read from the rollups and memoised until a scan adds data. */
export function usageStats({ days = 30, model = '', project = '' } = {}) {
  const key = `${days}|${model}|${project}|${new Date().toDateString()}`;
  const v = version('usage');
  const hit = memo.get(key);
  if (hit?.v === v) return hit.out;
  const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - Number(days) + 1);
  const sinceDay = since.toISOString().slice(0, 10);
  const projects = db.prepare('SELECT DISTINCT project FROM usage_sess').all().map((r) => r.project).filter(Boolean);
  const raw = project ? projects.filter((p) => prettyProject(p) === project) : null;
  const filt = (dateCol) => {
    const w = [`${dateCol} >= ?`]; const a = [dateCol === 'day' ? sinceDay : since.toISOString()];
    if (model) { w.push('fam = ?'); a.push(model); }
    if (raw) { w.push(`project IN (${raw.map(() => '?').join(',') || "''"})`); a.push(...raw); }
    return [w.join(' AND '), a];
  };
  const [hw, ha] = filt('day');
  const H = (select, group) => db.prepare(`SELECT ${select}, ${COLS} FROM usage_hour WHERE ${hw} ${group ? `GROUP BY ${group}` : ''}`).all(...ha);
  const [sw, sa] = filt('first');
  const sess = db.prepare(`SELECT * FROM usage_sess WHERE ${sw}`).all(...sa);
  const dash = new Map(db.prepare('SELECT session_id, name, chore FROM sessions WHERE session_id IS NOT NULL').all().map((r) => [r.session_id, r]));
  const hours = Array(24).fill(0);
  for (const r of H('hour', 'hour')) hours[r.hour] = r.cost;
  const total = H('1 one')[0];
  const out = {
    days: Number(days),
    total: total?.n ? total : ZERO,
    perDay: H('day, fam', 'day, fam').map((r) => ({ day: r.day, fam: r.fam, cost: r.cost, tokens: r.tokens })),
    byModel: fold(H('fam', 'fam'), (r) => r.fam),
    byProject: fold(H('project', 'project'), (r) => prettyProject(r.project)).slice(0, 12),
    bySource: fold(sess, (r) => (dash.has(r.session_id) ? 'Dashboard' : 'Interactif')),
    byChore: fold(sess, (r) => dash.get(r.session_id)?.chore ?? 'interactif').slice(0, 10),
    byHour: hours,
    sessions: [...sess].sort((a, b) => b.cost - a.cost).slice(0, 15).map((r) => {
      const d = dash.get(r.session_id);
      return { ...r, key: r.session_id, name: d?.name ?? null, chore: d?.chore ?? null, proj: prettyProject(r.project ?? '') };
    }),
    projects: [...new Set(projects.map(prettyProject))].sort(),
    scannedAt: kv.get('usageScannedAt') ?? null,
    version: v,
  };
  memo.set(key, { v, out });
  return out;
}
