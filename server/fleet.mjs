import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { config } from './config.mjs';
import { bump, db } from './db.mjs';
import { liveAgents } from './sessions.mjs';

// The fleet: EVERY Claude Code session on this Mac (terminal, background, dashboard), not only
// the dashboard's. Each transcript is folded incrementally into one `fleet` row (title, branch,
// last message / tool, PRs, who it messaged); subagents come from <session>/subagents/*.meta.json;
// live status from `claude agents`. Costs come from the usage rollups.

const ROOT = join(homedir(), '.claude/projects');
db.exec(`CREATE TABLE IF NOT EXISTS fleet (
  session_id TEXT PRIMARY KEY, project TEXT, file TEXT, offset INTEGER, cwd TEXT, branch TEXT, title TEXT, last_prompt TEXT,
  last_text TEXT, last_tool TEXT, first_at TEXT, last_at TEXT, prs TEXT, talks TEXT, model TEXT, subagents TEXT
)`);

const toolLine = (b) => {
  const i = b.input ?? {};
  const what = i.command ?? i.description ?? i.file_path ?? i.pattern ?? i.prompt ?? i.query ?? i.to ?? '';
  return `${b.name}: ${String(what).split('\n')[0]}`.slice(0, 200);
};

async function fold(row, file, from) {
  const rl = createInterface({ input: createReadStream(file, { start: from }), crlfDelay: Infinity });
  let bytes = from;
  const prs = new Map((row.prs ? JSON.parse(row.prs) : []).map((p) => [p.number, p]));
  const talks = row.talks ? JSON.parse(row.talks) : {};
  for await (const line of rl) {
    if (!line.endsWith('}')) break;
    bytes += Buffer.byteLength(line) + 1;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'ai-title' && e.aiTitle) row.title = e.aiTitle;
    else if (e.type === 'last-prompt' && e.lastPrompt) row.last_prompt = e.lastPrompt.slice(0, 300);
    else if (e.type === 'pr-link' && e.prNumber) prs.set(e.prNumber, { number: e.prNumber, url: e.prUrl, repo: e.prRepository });
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.cwd) row.cwd = e.cwd;
    if (e.gitBranch) row.branch = e.gitBranch;
    if (e.timestamp) { row.last_at = e.timestamp; row.first_at ??= e.timestamp; }
    const m = e.message;
    if (e.type === 'assistant' && m) {
      if (m.model && m.model !== '<synthetic>') row.model = m.model;
      for (const b of m.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) { row.last_text = b.text.trim().slice(0, 400); row.last_tool = null; }
        if (b.type === 'tool_use') {
          row.last_tool = toolLine(b);
          if (b.name === 'SendMessage' && b.input?.to && b.input.recipient_kind !== 'agent') talks[b.input.to] = (talks[b.input.to] ?? 0) + 1;
        }
      }
    }
  }
  row.offset = bytes;
  row.prs = JSON.stringify([...prs.values()]);
  row.talks = JSON.stringify(talks);
  return row;
}

function subagents(project, sid) {
  const dir = join(ROOT, project, sid, 'subagents');
  if (!existsSync(dir)) return [];
  const now = Date.now();
  return readdirSync(dir).filter((f) => f.endsWith('.meta.json')).map((f) => {
    const id = f.replace(/^agent-|\.meta\.json$/g, '');
    let meta = {};
    try { meta = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch {}
    const log = join(dir, `agent-${id}.jsonl`);
    const st = existsSync(log) ? statSync(log) : null;
    return { id, desc: meta.description ?? meta.agentType ?? id, type: meta.agentType, size: st?.size ?? 0, running: !!st && now - st.mtimeMs < 90_000, at: st?.mtime?.toISOString() };
  }).sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
}

const get = db.prepare('SELECT * FROM fleet WHERE session_id = ?');
const put = db.prepare(`INSERT OR REPLACE INTO fleet (session_id, project, file, offset, cwd, branch, title, last_prompt, last_text, last_tool, first_at, last_at, prs, talks, model, subagents)
  VALUES (@session_id, @project, @file, @offset, @cwd, @branch, @title, @last_prompt, @last_text, @last_tool, @first_at, @last_at, @prs, @talks, @model, @subagents)`);

let scanning = null;
/** Fold new transcript bytes of every session touched in the last `days`. Cheap when nothing moved. */
export function scanFleet() {
  scanning ??= (async () => {
    const since = Date.now() - config.fleet.days * 86_400_000;
    let changed = false;
    for (const project of readdirSync(ROOT)) {
      let files;
      try { files = readdirSync(join(ROOT, project)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const file = join(ROOT, project, f);
        const st = statSync(file);
        if (st.mtimeMs < since) continue;
        const sid = f.slice(0, -6);
        const prev = get.get(sid) ?? { session_id: sid, project, file, offset: 0, cwd: null, branch: null, title: null, last_prompt: null, last_text: null, last_tool: null, first_at: null, last_at: null, prs: null, talks: null, model: null, subagents: null };
        const subs = JSON.stringify(subagents(project, sid));
        if (prev.offset >= st.size && prev.subagents === subs) continue;
        const row = prev.offset < st.size ? await fold({ ...prev, file }, file, prev.offset) : { ...prev };
        row.subagents = subs;
        put.run(row);
        changed = true;
      }
    }
    if (changed) bump('fleet');
    return changed;
  })().finally(() => { scanning = null; });
  return scanning;
}

const STATUS = (a) => {
  if (!a) return 'ended';
  if (a.kind === 'interactive') return a.status === 'busy' ? 'working' : 'idle';
  return { running: 'working', working: 'working', busy: 'working', starting: 'working', blocked: 'input', idle: 'idle', done: 'idle' }[a.state] ?? 'ended';
};

/** The fleet as the page draws it: repo → worktree → sessions, with cost and live status. */
export async function fleetState() {
  const since = new Date(Date.now() - config.fleet.days * 86_400_000).toISOString();
  const rows = db.prepare('SELECT * FROM fleet WHERE last_at >= ? ORDER BY last_at DESC').all(since);
  const agents = (await liveAgents()) ?? [];
  const bySid = new Map(agents.filter((a) => a.sessionId).map((a) => [a.sessionId, a]));
  const costs = new Map(db.prepare('SELECT session_id, cost, tokens, n FROM usage_sess').all().map((r) => [r.session_id, r]));
  const worktrees = db.prepare('SELECT path, repo, branch FROM worktrees').all().sort((a, b) => b.path.length - a.path.length);
  const repoPaths = new Map(config.repos.map((r) => [r.slug, r.path]));
  const dash = new Map(db.prepare('SELECT id, session_id, chore, title, name FROM sessions WHERE session_id IS NOT NULL').all().map((r) => [r.session_id, r]));
  // The dashboard's own headless runs (Jira/Slack/stand-up) live in its data dir: not part of the fleet.
  const sessions = rows.filter((r) => r.cwd && !r.cwd.startsWith(config.dataDir) && !r.cwd.startsWith('/private/tmp')).map((r) => {
    const a = bySid.get(r.session_id);
    // A session whose worktree has since been removed keeps its own column, flagged gone.
    const own = r.cwd.match(/^(.*\/\.claude\/worktrees\/[^/]+)/)?.[1];
    let wt = worktrees.find((w) => r.cwd === w.path || r.cwd.startsWith(`${w.path}/`));
    const gone = !!own && wt?.path !== own;
    if (gone) wt = { path: own, repo: wt?.repo, branch: null };
    const repo = wt?.repo ?? r.cwd.replace(homedir(), '~').split('/').slice(0, 3).join('/');
    const c = costs.get(r.session_id);
    const d = dash.get(r.session_id);
    return {
      sid: r.session_id, name: a?.name ?? d?.name ?? `${r.cwd.split('/').pop()}-${r.session_id.slice(0, 2)}`, agentId: a?.id ?? null, kind: a?.kind ?? null,
      status: STATUS(a), cwd: r.cwd, repo, worktree: wt?.path ?? r.cwd, main: !gone && !!wt && wt.path === repoPaths.get(wt.repo), gone,
      branch: wt?.branch ?? r.branch, wtName: (wt?.path ?? r.cwd).split('/').pop(),
      title: d?.title ?? r.title ?? r.last_prompt?.slice(0, 80) ?? '(sans titre)', last: r.last_tool ? { tool: r.last_tool } : { text: r.last_text ?? '' },
      first_at: r.first_at, last_at: r.last_at, model: r.model, cost: c?.cost ?? 0, tokens: c?.tokens ?? 0,
      prs: JSON.parse(r.prs ?? '[]'), talks: JSON.parse(r.talks ?? '{}'), subagents: JSON.parse(r.subagents ?? '[]'),
      dashboard: dash.get(r.session_id)?.id ?? null, chore: dash.get(r.session_id)?.chore ?? null,
    };
  });
  return { sessions, worktrees: db.prepare('SELECT * FROM worktrees').all(), days: config.fleet.days };
}

export const fleetFile = (sid) => get.get(sid)?.file ?? null;
export const fleetRow = (sid) => get.get(sid) ?? null;

/** 15-minute activity bins per session over the last `hours`, from the usage table. */
export function fleetTimeline(hours = 24) {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  return db.prepare(`SELECT session_id sid, CAST((strftime('%s', ts) - strftime('%s', ?)) / 900 AS INTEGER) bin, SUM(cost) cost, COUNT(*) n
    FROM usage WHERE ts >= ? GROUP BY sid, bin`).all(since, since);
}
