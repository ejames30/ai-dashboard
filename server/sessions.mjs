import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { db, update, upsert } from './db.mjs';
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

export async function launch({ name, cwd, model, effort, prompt, readOnly, row }) {
  const args = ['--bg', '-n', name, '--remote-control', name, '--model', model, '--effort', effort, '--settings', SESSION_SETTINGS];
  if (readOnly) args.push('--permission-mode', 'dontAsk', '--allowedTools', ...REVIEW_TOOLS);
  args.push('--', prompt);
  const out = await sh('claude', args, { cwd, timeout: 60_000 });
  const id = out.match(/backgrounded · ([0-9a-f]+)/)?.[1];
  if (!id) throw new Error(`claude --bg gave no session id: ${out.slice(0, 300)}`);
  upsert('sessions', { ...row, id, name, cwd, model, effort, prompt, state: 'starting', started_at: new Date().toISOString() });
  return id;
}

export const listSessions = () => db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 300').all();

// ---- polling ---------------------------------------------------------------
const transcriptPath = (cwd, sessionId) =>
  join(homedir(), '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);

function usageOf(cwd, sessionId) {
  const path = transcriptPath(cwd, sessionId);
  if (!existsSync(path)) return null;
  const seen = new Set();
  const u = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: 0 };
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
    u.turns += 1;
  }
  return u;
}

async function rcUrl(id) {
  const logs = await sh('claude', ['logs', id], { timeout: 20_000 }).catch(() => '');
  return logs.match(/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/)?.[0] ?? null;
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
    if (state === 'done' && s.chore === 'ai-review' && !s.posted_url && !s.error) Object.assign(patch, await onReviewDone({ ...s, ...patch }));
    if (Object.entries(patch).some(([k, v]) => s[k] !== v)) {
      update('sessions', { id: s.id }, patch);
      changed = true;
    }
  }
  return changed;
}

export async function stopSession(id) {
  await sh('claude', ['stop', id]).catch(() => {});
  update('sessions', { id }, { state: 'stopped', ended_at: new Date().toISOString() });
}

// ---- AI review → pending GitHub review -------------------------------------
const SEVERITY = { critical: '🚨 **Critique**', warning: '⚠️ **Warning**', suggestion: '💡 **Suggestion**' };

/** Turn the review session's JSON into a PENDING review: visible only to me until I submit it. */
/** The last ```json block of the session's final assistant messages. */
function reviewFromTranscript(session) {
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

export async function postDraftReview(session, pr) {
  let review;
  try { review = reviewFromTranscript(session); } catch (e) { return { error: `invalid review JSON: ${e.message}` }; }
  if (!review) return { error: 'no ```json review in the final message' };
  const comments = (review.comments ?? []).filter((c) => c.path && Number.isInteger(c.line)).map((c) => ({
    path: c.path, line: c.line, side: 'RIGHT', body: `${SEVERITY[c.severity] ?? ''}\n\n${c.body}`.trim(),
  }));
  const summary = `${review.summary ?? ''}\n\n<sub>Review drafted with Claude, checked by me before submitting.</sub>`;
  const post = (payload) => gh(['api', '-X', 'POST', `repos/${session.repo}/pulls/${pr.number}/reviews`, '--input', '-'], { input: JSON.stringify(payload) });
  try {
    await post({ commit_id: pr.head_sha, body: summary, comments });
  } catch (e) {
    if (/pending review/i.test(e.message)) return { error: 'you already have a pending review on this PR — submit or delete it first' };
    // A line outside a diff hunk makes GitHub reject the whole review: keep everything, inline in the body.
    const inline = comments.map((c) => `**\`${c.path}:${c.line}\`** — ${c.body}`).join('\n\n---\n\n');
    try { await post({ commit_id: pr.head_sha, body: `${summary}\n\n${inline}` }); }
    catch (e2) { return { error: e2.message.slice(0, 300) }; }
  }
  return { posted_url: `${pr.url}/files`, error: null };
}
