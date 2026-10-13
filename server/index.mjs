// Eric's AI Dashboard — local cockpit: my tasks + their next action, teammates' PRs to review,
// every Claude session I start, and the local stack. 127.0.0.1 only, zero dependencies.

process.removeAllListeners('warning'); // node:sqlite's "experimental" notice

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTO_REVIEW_CHORE, BATCH, CHORES, CUSTOM, EFFORTS, MODELS, REVIEW_CHORE, choreByKey, nextChore } from './chores.mjs';
import { config, repoBySlug, sizeOf } from './config.mjs';
import { db, kv } from './db.mjs';
import { autoReviewState, runAutoReview } from './autoreview.mjs';
import { syncGithub } from './github.mjs';
import { jiraSource, resetJiraToken, syncJira } from './jira.mjs';
import { launch, listSessions, openInTerminal, pollSessions, postDraftReview, replySession, stopSession, transcript } from './sessions.mjs';
import { onStackLog, refreshStack, stackStatus, startStack, stopStack, switchStack } from './stack.mjs';
import { reviewWorktree, scratchWorktree, taskWorktree } from './worktrees.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '../web');

// ---- model -----------------------------------------------------------------
function buildTasks() {
  const issues = db.prepare('SELECT * FROM issues').all();
  const mine = db.prepare("SELECT * FROM prs WHERE kind = 'mine'").all();
  const sessions = listSessions();
  const tasks = new Map();
  for (const issue of issues) tasks.set(issue.key, { key: issue.key, issue, pr: null });
  for (const pr of mine) {
    const key = pr.issue_key ?? `PR-${pr.number}`;
    const t = tasks.get(key) ?? { key, issue: null, pr: null };
    if (!t.pr || pr.number > t.pr.number) t.pr = pr; // several PRs per ticket: the latest leads
    tasks.set(key, t);
  }
  // A multi-ticket session counts for each of its tickets, its cost split evenly between them.
  const keysOf = (s) => { try { return s.tasks ? JSON.parse(s.tasks) : s.task ? [s.task] : []; } catch { return []; } };
  return [...tasks.values()].map((t) => {
    const own = sessions.filter((s) => keysOf(s).includes(t.key));
    const cost = own.reduce((a, s) => a + (s.cost_usd ?? 0) / Math.max(1, keysOf(s).length), 0);
    t.doneChores = new Set(own.filter((s) => s.state === 'done').map((s) => s.chore));
    const next = nextChore(t);
    const lines = t.pr ? t.pr.additions + t.pr.deletions : 0;
    return {
      key: t.key, issue: t.issue, pr: t.pr, size: t.pr ? sizeOf(lines) : null, lines,
      next: next && { key: next.key, label: next.label },
      sessions: own.slice(0, 5), sessionCount: own.length, cost,
    };
  }).sort((a, b) => (b.pr?.updated ?? b.issue?.updated ?? '').localeCompare(a.pr?.updated ?? a.issue?.updated ?? ''));
}

function buildReviews() {
  const sessions = listSessions().filter((s) => ['ai-review', 'auto-review'].includes(s.chore));
  return db.prepare("SELECT * FROM prs WHERE kind = 'review'").all().map((pr) => ({
    ...pr,
    lines: pr.additions + pr.deletions,
    size: sizeOf(pr.additions + pr.deletions),
    session: sessions.find((s) => s.repo === pr.repo && s.pr === pr.number) ?? null,
  })).sort((a, b) => a.lines - b.lines);
}

async function state() {
  return {
    me: config.me,
    tasks: buildTasks(),
    reviews: buildReviews(),
    sessions: listSessions(),
    stack: await stackStatus(),
    sync: kv.get('sync') ?? null,
    jira: { ...(kv.get('jira') ?? {}), source: await jiraSource(), site: config.jira.site, service: config.jira.keychainService, email: config.email },
    autoReview: autoReviewState(),
    chores: [...CHORES, CUSTOM, REVIEW_CHORE, AUTO_REVIEW_CHORE, BATCH].map(({ key, label, model, effort }) => ({ key, label, model, effort })),
    models: MODELS,
    efforts: EFFORTS,
  };
}

// ---- live ------------------------------------------------------------------
const clients = new Set();
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const broadcast = (event, data) => clients.forEach((res) => send(res, event, data));
let pushTimer;
const pushState = () => { clearTimeout(pushTimer); pushTimer = setTimeout(async () => broadcast('state', await state()), 100); };
onStackLog((line) => broadcast('stacklog', line));

// ---- sync loops --------------------------------------------------------------
let syncing = false;
async function sync({ force = false } = {}) {
  // Jira can take ~40s through the connector: it runs on its own and pushes when it lands.
  syncJira({ force }).catch((e) => console.error('jira', e.message)).finally(pushState);
  pushState();
  if (syncing) return;
  syncing = true;
  const errors = [];
  await syncGithub().catch((e) => errors.push(`GitHub: ${e.message}`));
  await runAutoReview(startAutoReview)
    .then((n) => n.length && console.log(`auto-review started for #${n.join(', #')}`))
    .catch((e) => errors.push(`Auto-review: ${e.message}`));
  kv.set('sync', { at: new Date().toISOString(), errors });
  syncing = false;
  pushState();
}

async function onReviewDone(session) {
  const pr = db.prepare('SELECT * FROM prs WHERE repo = ? AND number = ?').get(session.repo, session.pr);
  if (!pr) return { error: 'PR no longer open' };
  return postDraftReview(session, pr);
}

setInterval(sync, config.syncEveryMs);
setInterval(() => pollSessions(onReviewDone).then((c) => c && pushState()).catch((e) => console.error('poll', e.message)), config.sessionPollMs);
setInterval(pushState, 15_000); // stack status, relative times
sync();

// ---- actions -----------------------------------------------------------------
function findTask(key) {
  const t = buildTasks().find((x) => x.key === key);
  if (!t) throw httpError(404, `task ${key} not found`);
  return { ...t, doneChores: new Set() };
}

function choreDefaults(body) {
  if (body.kind === 'batch') {
    const keys = (Array.isArray(body.tasks) ? body.tasks : String(body.tasks ?? '').split(',')).filter(Boolean);
    if (keys.length < 2) throw httpError(400, 'pick at least 2 tickets');
    const tasks = keys.map(findTask);
    return { chore: BATCH, tasks, prompt: BATCH.prompt(tasks) };
  }
  if (body.kind === 'review') {
    const pr = db.prepare("SELECT * FROM prs WHERE kind = 'review' AND repo = ? AND number = ?").get(body.repo, Number(body.pr));
    if (!pr) throw httpError(404, 'PR not found');
    return { chore: REVIEW_CHORE, pr, prompt: REVIEW_CHORE.prompt(pr) };
  }
  const task = body.task ? findTask(body.task) : null;
  const chore = choreByKey(body.chore) ?? CUSTOM;
  return { chore, task, prompt: chore.prompt(task) };
}

async function startSession(body) {
  const d = choreDefaults(body);
  const model = MODELS.includes(body.model) ? body.model : d.chore.model;
  const effort = EFFORTS.includes(body.effort) ? body.effort : d.chore.effort;
  const prompt = (body.prompt ?? d.prompt).trim();
  const repo = repoBySlug(d.pr?.repo ?? d.task?.pr?.repo ?? config.repos[0].slug);
  const cwd = d.pr ? await reviewWorktree(repo, d.pr) : d.task ? await taskWorktree(repo, d.task) : await scratchWorktree(repo, d.tasks ? 'batch' : 'custom');
  const label = d.pr ? `review-${d.pr.number}` : d.task ? d.task.key : d.tasks ? `${d.tasks.length}-tickets` : 'custom';
  return launch({
    name: `eric-ai-${label}-${d.chore.key}`.slice(0, 60),
    cwd, model, effort, prompt,
    readOnly: !!d.pr,
    row: {
      chore: d.chore.key, task: d.task?.key ?? null, tasks: d.tasks ? JSON.stringify(d.tasks.map((t) => t.key)) : null,
      repo: repo.slug, pr: d.pr?.number ?? d.task?.pr?.number ?? null,
    },
  });
}

async function startAutoReview(pr) {
  const repo = repoBySlug(pr.repo);
  const c = AUTO_REVIEW_CHORE;
  return launch({
    name: `eric-ai-review-${pr.number}-auto-review`,
    cwd: await reviewWorktree(repo, pr), model: c.model, effort: c.effort, prompt: c.prompt(pr),
    readOnly: true,
    row: { chore: c.key, task: null, tasks: null, repo: repo.slug, pr: pr.number },
  });
}

const STACK = {
  switch: (b) => switchStack({ branch: b.branch, pr: b.pr ? Number(b.pr) : null }),
  start: () => startStack(),
  stop: () => stopStack(),
  refresh: () => refreshStack(),
};

// ---- http --------------------------------------------------------------------
const httpError = (code, message) => Object.assign(new Error(message), { code });
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (d) => (s += d));
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
});
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && STATIC[pathname]) {
      const [file, type] = STATIC[pathname];
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
      return res.end(await readFile(join(WEB, file)));
    }
    if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, await state());
    if (req.method === 'GET' && pathname === '/api/chore') {
      const d = choreDefaults(Object.fromEntries(searchParams));
      return json(res, 200, { key: d.chore.key, label: d.chore.label, model: d.chore.model, effort: d.chore.effort, prompt: d.prompt });
    }
    const tr = pathname.match(/^\/api\/sessions\/([0-9a-f]+)\/transcript$/);
    if (req.method === 'GET' && tr) {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(tr[1]);
      if (!session) throw httpError(404, 'session not found');
      return json(res, 200, { session, items: transcript(session) });
    }
    if (req.method === 'GET' && pathname === '/live') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      clients.add(res);
      send(res, 'state', await state());
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST') {
      // Custom header → a cross-site page can't send it without a CORS preflight we never answer.
      if (req.headers['x-dashboard'] !== '1') return json(res, 403, { error: 'missing X-Dashboard header' });
      const body = await readBody(req);
      if (pathname === '/api/sync') { resetJiraToken(); await sync({ force: true }); return json(res, 200, { ok: true }); }
      if (pathname === '/api/sessions') { const id = await startSession(body); pushState(); return json(res, 200, { id }); }
      const reply = pathname.match(/^\/api\/sessions\/([0-9a-f]+)\/reply$/);
      if (reply) {
        const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(reply[1]);
        if (!session) throw httpError(404, 'session not found');
        if (!String(body.text ?? '').trim()) throw httpError(400, 'empty message');
        await replySession(session, body.text.trim());
        pushState();
        return json(res, 200, { ok: true });
      }
      const term = pathname.match(/^\/api\/sessions\/([0-9a-f]+)\/terminal$/);
      if (term) {
        const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(term[1]);
        if (!session) throw httpError(404, 'session not found');
        await openInTerminal(session);
        return json(res, 200, { ok: true });
      }
      const stop = pathname.match(/^\/api\/sessions\/([0-9a-f]+)\/stop$/);
      if (stop) { await stopSession(stop[1]); pushState(); return json(res, 200, { ok: true }); }
      const st = pathname.match(/^\/api\/stack\/([a-z]+)$/);
      if (st && STACK[st[1]]) {
        STACK[st[1]](body).then(pushState, (e) => broadcast('stacklog', `✗ ${e.message}`));
        pushState();
        return json(res, 202, { ok: true });
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    json(res, e.code && Number.isInteger(e.code) ? e.code : 500, { error: e.message });
  }
}).listen(config.port, '127.0.0.1', () => console.log(`Eric's AI Dashboard → http://localhost:${config.port}`));
