// Goblin — local cockpit: my tasks + their next action, teammates' PRs to review,
// every Claude session I start, and the local stack. 127.0.0.1 only, zero dependencies.

process.removeAllListeners('warning'); // node:sqlite's "experimental" notice

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHORES, CUSTOM, EFFORTS, MODELS, REVIEW_CHORE, choreByKey, nextChore } from './chores.mjs';
import { config, repoBySlug, sizeOf } from './config.mjs';
import { db, kv } from './db.mjs';
import { syncGithub } from './github.mjs';
import { jiraConfigured, resetJiraToken, syncJira } from './jira.mjs';
import { launch, listSessions, pollSessions, postDraftReview, stopSession } from './sessions.mjs';
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
  return [...tasks.values()].map((t) => {
    const own = sessions.filter((s) => s.task === t.key);
    t.doneChores = new Set(own.filter((s) => s.state === 'done').map((s) => s.chore));
    const next = nextChore(t);
    const lines = t.pr ? t.pr.additions + t.pr.deletions : 0;
    return {
      key: t.key, issue: t.issue, pr: t.pr, size: t.pr ? sizeOf(lines) : null, lines,
      next: next && { key: next.key, label: next.label },
      sessions: own.slice(0, 5),
    };
  }).sort((a, b) => (b.pr?.updated ?? b.issue?.updated ?? '').localeCompare(a.pr?.updated ?? a.issue?.updated ?? ''));
}

function buildReviews() {
  const sessions = listSessions().filter((s) => s.chore === 'ai-review');
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
    jira: { configured: await jiraConfigured(), site: config.jira.site, service: config.jira.keychainService, email: config.email },
    chores: [...CHORES, CUSTOM, REVIEW_CHORE].map(({ key, label, model, effort }) => ({ key, label, model, effort })),
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
async function sync() {
  if (syncing) return;
  syncing = true;
  const errors = [];
  await syncGithub().catch((e) => errors.push(`GitHub: ${e.message}`));
  await syncJira().catch((e) => errors.push(`Jira: ${e.message}`));
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
  const cwd = d.pr ? await reviewWorktree(repo, d.pr) : d.task ? await taskWorktree(repo, d.task) : await scratchWorktree(repo);
  const label = d.pr ? `review-${d.pr.number}` : d.task ? d.task.key : 'custom';
  return launch({
    name: `goblin-${label}-${d.chore.key}`.slice(0, 60),
    cwd, model, effort, prompt,
    readOnly: !!d.pr,
    row: { chore: d.chore.key, task: d.task?.key ?? null, repo: repo.slug, pr: d.pr?.number ?? d.task?.pr?.number ?? null },
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
    if (req.method === 'GET' && pathname === '/live') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      clients.add(res);
      send(res, 'state', await state());
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST') {
      // Custom header → a cross-site page can't send it without a CORS preflight we never answer.
      if (req.headers['x-goblin'] !== '1') return json(res, 403, { error: 'missing X-Goblin header' });
      const body = await readBody(req);
      if (pathname === '/api/sync') { resetJiraToken(); await sync(); return json(res, 200, { ok: true }); }
      if (pathname === '/api/sessions') { const id = await startSession(body); pushState(); return json(res, 200, { id }); }
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
}).listen(config.port, '127.0.0.1', () => console.log(`goblin → http://localhost:${config.port}`));
