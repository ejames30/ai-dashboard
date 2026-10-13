import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { db, logEvent, update, upsert } from './db.mjs';
import { gh, sh } from './sh.mjs';

// Sessions are real interactive Claude Code sessions started with `claude --bg` and
// Remote Control on, so each one shows up in claude.ai/code where I can follow it or
// answer it. `claude agents --json --all` is the source of truth for their state.

// `done` is NOT terminal: a finished turn can be continued from claude.ai, so it's still polled.
const TERMINAL = new Set(['failed', 'error', 'stopped', 'killed', 'exited', 'gone']);
const POLL_WINDOW_MS = 3 * 86_400_000; // stop polling sessions older than this
const SESSION_SETTINGS = JSON.stringify({ enableAllProjectMcpServers: true }); // no MCP approval prompt in a fresh worktree

// A teammate's diff is untrusted, so the review session may only read.
const REVIEW_TOOLS = [
  'Read', 'Grep', 'Glob',
  'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git blame:*)',
  'Bash(gh pr view:*)', 'Bash(gh pr diff:*)',
];

// Epic plans read Jira/Confluence and the code without asking; anything else still prompts.
export const PLAN_TOOLS = [
  ...REVIEW_TOOLS, 'Bash(git grep:*)', 'Bash(ls:*)',
  ...['getAccessibleAtlassianResources', 'searchJiraIssuesUsingJql', 'getJiraIssue', 'getJiraIssueRemoteIssueLinks', 'search', 'fetch',
    'getConfluencePage', 'searchConfluenceUsingCql', 'getConfluencePageDescendants'].map((t) => `mcp__claude_ai_Atlassian__${t}`),
];

export async function launch({ name, cwd, model, effort, prompt, readOnly, allow, row }) {
  const args = ['--bg', '-n', name, '--remote-control', name, '--model', model, '--effort', effort, '--settings', SESSION_SETTINGS];
  if (readOnly) args.push('--permission-mode', 'dontAsk', '--allowedTools', ...REVIEW_TOOLS);
  else if (allow?.length) args.push('--allowedTools', ...allow);
  args.push('--', prompt);
  const out = await sh('claude', args, { cwd, timeout: 60_000 });
  const id = out.match(/backgrounded · ([0-9a-f]+)/)?.[1];
  if (!id) throw new Error(`claude --bg gave no session id: ${out.slice(0, 300)}`);
  upsert('sessions', { ...row, id, name, cwd, model, effort, prompt, state: 'starting', started_at: new Date().toISOString() });
  logEvent('session-start', `Session lancée : ${row.title ?? name} (${row.chore}, ${model}/${effort})`, { repo: row.repo, pr: row.pr, session: id });
  return id;
}

export const listSessions = () => db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 300').all();

// ---- cost ------------------------------------------------------------------
// Anthropic API list prices, $ per million tokens (claude-api skill, cached 2026-10-06).
// Cache writes: 1.25x input for the 5-minute TTL, 2x for 1 hour. On a Claude Enterprise
// seat this is an ESTIMATE of what the same tokens would cost on the API, not a bill.
const PRICES = [
  { match: /fable|mythos/, input: 10, output: 50, cacheRead: 0.25 },
  { match: /opus/, input: 4, output: 20, cacheRead: 0.2 },
  { match: /sonnet/, input: 2, output: 10, cacheRead: 0.2 },
  { match: /haiku/, input: 0.1, output: 0.5, cacheRead: 0.01 },
];

export function costOf(model = '', u) {
  const p = PRICES.find((x) => x.match.test(model)) ?? PRICES[1];
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h);
  return ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output + (u.cache_read_input_tokens ?? 0) * p.cacheRead
    + w5m * p.input * 1.25 + w1h * p.input * 2) / 1e6;
}

// ---- polling ---------------------------------------------------------------
const transcriptPath = (cwd, sessionId) =>
  join(homedir(), '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);

function usageOf(cwd, sessionId) {
  const path = transcriptPath(cwd, sessionId);
  if (!existsSync(path)) return null;
  const seen = new Set();
  const u = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: 0, cost_usd: 0 };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) continue;
    let msg;
    try { msg = JSON.parse(line).message; } catch { continue; }
    if (!msg?.usage || seen.has(msg.id)) continue; // a message is written once per content block
    seen.add(msg.id);
    u.input_tokens += msg.usage.input_tokens ?? 0;
    u.output_tokens += msg.usage.output_tokens ?? 0;
    u.cache_read_tokens += msg.usage.cache_read_input_tokens ?? 0;
    u.cache_write_tokens += msg.usage.cache_creation_input_tokens ?? 0;
    u.cost_usd += costOf(msg.model, msg.usage);
    u.turns += 1;
  }
  return u;
}

async function rcUrl(id) {
  const logs = await sh('claude', ['logs', id], { timeout: 20_000 }).catch(() => '');
  return logs.match(/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/)?.[0] ?? null;
}

// A macOS notification when a session needs me or has finished, so the dashboard needn't stay in view.
function notify(s, state) {
  const title = state === 'blocked' ? 'Claude attend ta réponse' : 'Session terminée';
  const msg = `${s.name}`.replace(/["\\]/g, '');
  sh('osascript', ['-e', `display notification "${msg}" with title "Eric's AI Dashboard" subtitle "${title}" sound name "Glass"`]).catch(() => {});
}

/** Refresh every non-terminal session. Returns true when something changed. */
export async function pollSessions(onReviewDone) {
  const since = new Date(Date.now() - POLL_WINDOW_MS).toISOString();
  const open = db.prepare(`SELECT * FROM sessions WHERE started_at > ? AND state NOT IN (${[...TERMINAL].map(() => '?').join(',')})`).all(since, ...TERMINAL);
  if (!open.length) return false;
  const agents = JSON.parse(await sh('claude', ['agents', '--json', '--all'], { timeout: 30_000 }));
  const byId = new Map(agents.map((a) => [a.id, a]));
  let changed = false;
  for (const s of open) {
    const a = byId.get(s.id);
    const state = a ? a.state ?? (a.status === 'busy' ? 'running' : 'idle') : 'gone';
    const patch = { state, session_id: a?.sessionId ?? s.session_id };
    if (!s.rc_url) patch.rc_url = await rcUrl(s.id);
    const usage = patch.session_id && usageOf(s.cwd, patch.session_id);
    if (usage) Object.assign(patch, usage);
    if ((TERMINAL.has(state) || state === 'done') && s.state !== state) patch.ended_at = new Date().toISOString();
    if (state === 'done' && ['ai-review', 'auto-review'].includes(s.chore) && !s.posted_url && !s.error) Object.assign(patch, await onReviewDone({ ...s, ...patch }));
    if (state !== s.state && (state === 'blocked' || state === 'done')) {
      notify(s, state);
      logEvent(`session-${state}`, `${s.title ?? s.name} — ${state === 'blocked' ? 'attend ta réponse' : 'terminée'}`, { repo: s.repo, pr: s.pr, session: s.id });
    }
    if (Object.entries(patch).some(([k, v]) => s[k] !== v)) {
      update('sessions', { id: s.id }, patch);
      changed = true;
    }
  }
  return changed;
}

// ---- conversation from the dashboard ---------------------------------------
const toolSummary = (name, input = {}) =>
  String(input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.prompt ?? input.query ?? '').slice(0, 200);

/** The session's conversation, slimmed for display: my messages, Claude's text, its tool calls. */
export function transcript(session) {
  if (!session.session_id) return [];
  const path = transcriptPath(session.cwd, session.session_id);
  if (!existsSync(path)) return [];
  const items = [];
  const seen = new Set();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    if (!m || (e.type !== 'user' && e.type !== 'assistant') || e.isMeta) continue;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? [];
    for (const b of blocks) {
      const key = `${m.id ?? e.uuid}:${b.id ?? b.text?.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (b.type === 'text' && b.text.trim() && !b.text.startsWith('<')) items.push({ role: e.type, text: b.text, ts: e.timestamp });
      if (b.type === 'tool_use') items.push({ role: 'tool', name: b.name, text: toolSummary(b.name, b.input), ts: e.timestamp });
    }
  }
  return items.slice(-300);
}

/**
 * Send a message to a session from the dashboard. A running or blocked session is stopped
 * first: `claude --bg --resume` with NO flags then wakes the same session (same id, saved
 * model/settings) with my message as the next turn. Passing flags would start a copy instead.
 */
export async function replySession(session, text) {
  if (!session.session_id) throw new Error('session has no id yet');
  if (!['done', 'idle', 'stopped', 'gone'].includes(session.state)) {
    await sh('claude', ['stop', session.id]).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
  }
  await sh('claude', ['--bg', '--resume', session.session_id, '--', text], { cwd: session.cwd, timeout: 60_000 });
  update('sessions', { id: session.id }, { state: 'running', ended_at: null });
}

/**
 * Open the session in my terminal (Warp) through `claude attach`: same local session,
 * just a TUI on it. A Warp launch configuration is the only way to make Warp run a command;
 * Terminal.app is the fallback when Warp isn't there.
 */
export async function openInTerminal(session) {
  const cmd = `claude attach ${session.id}`;
  if (existsSync('/Applications/Warp.app')) {
    const dir = join(homedir(), '.warp/launch_configurations');
    mkdirSync(dir, { recursive: true });
    const file = `ai-dashboard-${session.id}.yaml`;
    writeFileSync(join(dir, file), `---\nname: ai-dashboard-${session.id}\nwindows:\n  - tabs:\n      - title: ${JSON.stringify(session.name)}\n        layout:\n          cwd: ${JSON.stringify(session.cwd)}\n          commands:\n            - exec: ${JSON.stringify(cmd)}\n`);
    await sh('open', [`warp://launch/${file}`]);
    return;
  }
  const script = `cd ${JSON.stringify(session.cwd)} && ${cmd}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  await sh('osascript', ['-e', `tell application "Terminal" to do script "${script}"`, '-e', 'tell application "Terminal" to activate']);
}

export async function stopSession(id) {
  await sh('claude', ['stop', id]).catch(() => {});
  update('sessions', { id }, { state: 'stopped', ended_at: new Date().toISOString() });
}

// ---- AI review → pending GitHub review -------------------------------------
const SEVERITY = { critical: '🚨 **Critical**', warning: '⚠️ **Warning**', suggestion: '💡 **Suggestion**' };

/** Turn the review session's JSON into a PENDING review: visible only to me until I submit it. */
/** The last ```json block of the session's final assistant messages. */
export function reviewFromTranscript(session) {
  const path = transcriptPath(session.cwd, session.session_id);
  if (!existsSync(path)) return null;
  const texts = readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    if (!line.includes('"assistant"')) return [];
    try {
      const m = JSON.parse(line).message;
      return (m?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text);
    } catch { return []; }
  });
  for (const text of texts.reverse()) {
    // Comment bodies can hold their own ``` fences, so the block runs to the LAST fence.
    const start = text.lastIndexOf('```json');
    const end = text.lastIndexOf('```');
    if (start !== -1 && end > start) return JSON.parse(text.slice(start + 7, end));
  }
  return null;
}

/** Posts the review: PENDING (only I see it) for 'ai-review', submitted as a comment review for 'auto-review'. */
export async function postDraftReview(session, pr) {
  const publish = session.chore === 'auto-review';
  let review;
  try { review = reviewFromTranscript(session); } catch (e) { return { error: `invalid review JSON: ${e.message}` }; }
  if (!review) return { error: 'no ```json review in the final message' };
  const review_json = JSON.stringify(review);
  const comments = (review.comments ?? []).filter((c) => c.path && Number.isInteger(c.line)).map((c) => ({
    path: c.path, line: c.line, side: 'RIGHT', body: `${SEVERITY[c.severity] ?? ''}\n\n${c.body}`.trim(),
  }));
  const footer = publish ? '<sub>🤖 Automated brutal review (Claude), posted by Eric\'s AI Dashboard.</sub>' : '<sub>Review drafted with Claude, checked by me before submitting.</sub>';
  const summary = `${review.summary ?? ''}\n\n${footer}`;
  const event = publish ? { event: 'COMMENT' } : {};
  const post = (payload) => gh(['api', '-X', 'POST', `repos/${session.repo}/pulls/${pr.number}/reviews`, '--input', '-'], { input: JSON.stringify(payload) });
  try {
    await post({ commit_id: pr.head_sha, body: summary, comments, ...event });
  } catch (e) {
    if (/pending review/i.test(e.message) && !publish) return { error: 'you already have a pending review on this PR — submit or delete it first' };
    // A line outside a diff hunk makes GitHub reject the whole review: keep everything, inline in the body.
    const inline = comments.map((c) => `**\`${c.path}:${c.line}\`** — ${c.body}`).join('\n\n---\n\n');
    const body = `${summary}\n\n${inline}`;
    try { await post({ commit_id: pr.head_sha, body, ...event }); }
    catch (e2) {
      // A pending review of mine blocks a second review: a plain PR comment still gets through.
      if (!publish) return { error: e2.message.slice(0, 300), review_json };
      try { await gh(['pr', 'comment', String(pr.number), '-R', session.repo, '--body-file', '-'], { input: body }); }
      catch (e3) { return { error: e3.message.slice(0, 300), review_json }; }
      return { posted_url: pr.url, error: null, review_json };
    }
  }
  return { posted_url: `${pr.url}/files`, error: null, review_json };
}
