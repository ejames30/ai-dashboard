import { createReadStream, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { db, kv } from './db.mjs';
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
      insert.run(m.id, ts, day, project, e.sessionId ?? null, m.model, u.input_tokens ?? 0, u.output_tokens ?? 0,
        u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, costOf(m.model, u));
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
  } finally {
    kv.set('usageOffsets', offsets);
    scanning = false;
  }
  return changed;
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
const family = (m) => (/fable|mythos/.test(m) ? 'fable' : /opus/.test(m) ? 'opus' : /sonnet/.test(m) ? 'sonnet' : /haiku/.test(m) ? 'haiku' : m);

/** Everything the Conso page draws, for one period and optional model/project filters. */
export function usageStats({ days = 30, model = '', project = '' } = {}) {
  const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - Number(days) + 1);
  const rows = db.prepare(`SELECT u.*, CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS dash, s.name AS sname, s.chore AS chore
    FROM usage u LEFT JOIN sessions s ON s.session_id = u.session_id WHERE u.ts >= ?`).all(since.toISOString())
    .map((r) => ({ ...r, fam: family(r.model), proj: prettyProject(r.project) }))
    .filter((r) => (!model || r.fam === model) && (!project || r.proj === project));
  const tok = (r) => r.input + r.output + r.cache_read + r.cache_write;
  const group = (fn) => {
    const m = new Map();
    for (const r of rows) {
      const k = fn(r);
      const g = m.get(k) ?? { key: k, cost: 0, tokens: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, n: 0 };
      g.cost += r.cost; g.tokens += tok(r); g.input += r.input; g.output += r.output; g.cache_read += r.cache_read; g.cache_write += r.cache_write; g.n += 1;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.cost - a.cost);
  };
  const total = group(() => 'all')[0] ?? { cost: 0, tokens: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, n: 0 };
  const sessions = group((r) => r.session_id ?? '?').slice(0, 15).map((g) => {
    const r = rows.find((x) => (x.session_id ?? '?') === g.key);
    return { ...g, name: r?.sname ?? null, chore: r?.chore ?? null, proj: r?.proj, fam: r?.fam, first: rows.filter((x) => x.session_id === g.key).reduce((a, x) => (a < x.ts ? a : x.ts), r?.ts) };
  });
  const allRows = db.prepare('SELECT DISTINCT project FROM usage').all().map((r) => prettyProject(r.project));
  return {
    days: Number(days), total,
    perDay: group((r) => `${r.day}|${r.fam}`).map((g) => { const [day, fam] = g.key.split('|'); return { day, fam, cost: g.cost, tokens: g.tokens }; }),
    byModel: group((r) => r.fam),
    byProject: group((r) => r.proj).slice(0, 12),
    bySource: group((r) => (r.dash ? 'Dashboard' : 'Interactif')),
    byChore: group((r) => r.chore ?? (r.dash ? 'autre' : 'interactif')).slice(0, 10),
    byHour: Array.from({ length: 24 }, (_, h) => rows.filter((r) => new Date(r.ts).getHours() === h).reduce((a, r) => a + r.cost, 0)),
    sessions,
    projects: [...new Set(allRows)].sort(),
    scannedAt: kv.get('usageScannedAt') ?? null,
  };
}
