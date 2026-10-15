// AI Dashboard — local cockpit: my tasks + their next action, teammates' PRs to review,
// every Claude session I start, and the local stack. 127.0.0.1 only, zero dependencies.

process.removeAllListeners('warning'); // node:sqlite's "experimental" notice

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brutalRules, setBrutalRules, AUTO_REVIEW_CHORE, SELF_REVIEW_CHORE, BATCH, CHORES, CUSTOM, EFFORTS, EPIC_PLAN, IDEA, MODELS, REVIEW_CHORE, STANDUP, choreByKey, nextChore } from './chores.mjs';
import { MOBILE_REPO, config, radarWatches, repoBySlug, repoDefaultPath, saveRepos, sizeOf } from './config.mjs';
import { existsSync } from 'node:fs';
import { bump, db, kv, logEvent, update, version } from './db.mjs';
import { autoReviewState, runAutoReview } from './autoreview.mjs';
import { syncGithub } from './github.mjs';
import { setSlackStatus, slackItems, syncSlack } from './slack.mjs';
import { generateStandup, listStandups, standupTick } from './standup.mjs';
import { generateIdeas, ideaById, ideasState, ideasTick, setIdeaStatus } from './ideas.mjs';
import { graphOps, graphState, isWorktree, scanWorktrees } from './graph.mjs';
import { fleetFile, fleetRow, fleetState, fleetTimeline, scanFleet } from './fleet.mjs';
import { scanUsage, usageStats } from './usage.mjs';
import { DatabaseSync } from 'node:sqlite';
import { jiraSource, resetJiraToken, syncJira } from './jira.mjs';
import { PLAN_TOOLS, launch, listSessions, liveAgents, slim, openInTerminal, openTerminalAt, transcriptFile, pollSessions, postDraftReview, replySession, reviewFromTranscript, stopSession, transcript } from './sessions.mjs';
import { onStackLog, refreshStack, stackStatus, startStack, stopStack, switchStack } from './stack.mjs';
import { reviewWorktree, scratchWorktree, taskWorktree } from './worktrees.mjs';
import { sh } from './sh.mjs';
import { repoCatalog } from './repocatalog.mjs';
import { checkOnboarding, fixCommand, onboardingState } from './onboarding.mjs';

// Session name prefix: "eric-ai-MO-123-…", so the Fleet tells whose dashboard started it.
const SLUG = String(config.firstName ?? 'me').normalize('NFD').replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'me';
const WEB = join(dirname(fileURLToPath(import.meta.url)), '../web');

// ---- model -----------------------------------------------------------------
function buildTasks(sessions = listSessions()) {
  const issues = db.prepare('SELECT * FROM issues').all();
  const mine = db.prepare("SELECT * FROM prs WHERE kind = 'mine' AND closed_at IS NULL").all();
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
  const byKey = new Map();
  for (const s of sessions) for (const k of keysOf(s)) byKey.set(k, [...(byKey.get(k) ?? []), s]);
  return [...tasks.values()].map((t) => {
    const own = byKey.get(t.key) ?? [];
    const cost = own.reduce((a, s) => a + (s.cost_usd ?? 0) / Math.max(1, keysOf(s).length), 0);
    t.doneChores = new Set(own.filter((s) => s.state === 'done').map((s) => s.chore));
    const next = nextChore(t);
    const lines = t.pr ? t.pr.additions + t.pr.deletions : 0;
    return {
      key: t.key, issue: t.issue, pr: t.pr, size: t.pr ? sizeOf(lines) : null, lines,
      next: next && { key: next.key, label: next.label },
      sessions: own.slice(0, 3).map(slim), sessionCount: own.length, cost,
    };
  }).sort((a, b) => (b.pr?.updated ?? b.issue?.updated ?? '').localeCompare(a.pr?.updated ?? a.issue?.updated ?? ''));
}

const REVIEW_KINDS = ['ai-review', 'auto-review', 'self-review'];
const parseReview = (s) => { try { return s.review_json ? JSON.parse(s.review_json) : null; } catch { return null; } };

/** Every review session, newest first, with its verdict counts: the Brutal reviews page. */
function buildReviewHistory(sessions = listSessions()) {
  const prs = db.prepare('SELECT * FROM prs').all();
  return sessions.filter((s) => REVIEW_KINDS.includes(s.chore)).map((s) => {
    const r = parseReview(s);
    const count = (sev) => (r?.comments ?? []).filter((c) => c.severity === sev).length;
    const pr = prs.find((p) => p.repo === s.repo && p.number === s.pr) ?? null;
    return {
      id: s.id, chore: s.chore, state: s.state, pr: s.pr, repo: s.repo, title: s.title ?? pr?.title ?? null,
      author: s.author ?? pr?.author ?? null, url: pr?.url ?? (s.pr ? `https://github.com/${s.repo}/pull/${s.pr}` : null),
      open: !!pr && !pr.closed_at, outdated: !!(pr && s.head_sha && pr.head_sha !== s.head_sha),
      started_at: s.started_at, ended_at: s.ended_at, cost_usd: s.cost_usd, model: s.model, posted_url: s.posted_url, error: s.error,
      summary: r?.summary ?? null, comments: r?.comments ?? [],
      counts: { critical: count('critical'), warning: count('warning'), suggestion: count('suggestion') },
    };
  });
}

function buildReviews(all = listSessions()) {
  const sessions = all.filter((s) => REVIEW_KINDS.includes(s.chore)).map(slim);
  return db.prepare("SELECT * FROM prs WHERE kind = 'review' AND closed_at IS NULL").all().map((pr) => {
    const session = sessions.find((s) => s.repo === pr.repo && s.pr === pr.number) ?? null;
    return {
      ...pr,
      lines: pr.additions + pr.deletions,
      size: sizeOf(pr.additions + pr.deletions),
      session,
      outdated: !!(session?.head_sha && session.head_sha !== pr.head_sha),
      auto: radarWatches(pr),
      team: config.team.find((m) => m.login === pr.author)?.name ?? null,
    };
  }).sort((a, b) => a.lines - b.lines);
}

/** Epics: open ones + my tickets' parents, each with my tickets under it and its plan sessions. */
function buildEpics(all = listSessions()) {
  const issues = db.prepare('SELECT key, summary, status, status_category, parent_key FROM issues').all();
  const sessions = all.filter((s) => s.epic);
  return db.prepare('SELECT * FROM epics').all().map((e) => ({
    ...e,
    mine: issues.filter((i) => i.parent_key === e.key).map((i) => ({ key: i.key, summary: i.summary, status: i.status, status_category: i.status_category })),
    plans: sessions.filter((s) => s.epic === e.key).map((s) => ({ id: s.id, state: s.state, started_at: s.started_at, cost_usd: s.cost_usd })),
  })).sort((a, b) => b.mine.length - a.mine.length || (b.updated ?? '').localeCompare(a.updated ?? ''));
}

/** The Repos page: every tracked repo, its clone, its radar, its last sync. */
const cloning = new Set();
function buildRepos() {
  const synced = kv.get('repoSync') ?? {};
  return config.repos.map((r) => ({
    slug: r.slug, path: r.path, base: r.base, radar: r.radar, mobile: r.slug === MOBILE_REPO,
    cloned: existsSync(join(r.path, '.git')), cloning: cloning.has(r.slug), sync: synced[r.slug] ?? null,
    open: db.prepare('SELECT COUNT(*) n FROM prs WHERE repo = ? AND closed_at IS NULL').get(r.slug).n,
  }));
}
const repoList = () => config.repos.map(({ slug, path, base, radar }) => ({ slug, path, base, radar }));
async function reposOp(body) {
  const slug = String(body.slug ?? '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) throw httpError(400, 'repo attendu sous la forme owner/name');
  const repo = repoBySlug(slug);
  if (body.op === 'add') {
    if (repo) throw httpError(409, `${slug} est déjà suivi`);
    const info = await sh('gh', ['api', `repos/${slug}`, '--jq', '[.full_name, .default_branch] | @tsv']).catch(() => null);
    if (!info) throw httpError(404, `${slug} introuvable ou pas d’accès avec ton compte gh`);
    const [full, base] = info.trim().split('\t');
    const path = String(body.path ?? '').trim().replace(/^~(?=\/)/, process.env.HOME) || repoDefaultPath(full);
    saveRepos([...repoList(), { slug: full, path, base, radar: body.radar !== false }]);
    logEvent('repos', `Repo ajouté : ${full} (${base}) — ${path}`);
  } else if (!repo) throw httpError(404, `${slug} n’est pas suivi`);
  else if (body.op === 'radar') {
    saveRepos(repoList().map((r) => (r.slug === slug ? { ...r, radar: !!body.on } : r)));
    logEvent('repos', `Radar ${body.on ? 'activé' : 'coupé'} sur ${slug}`);
  } else if (body.op === 'remove') {
    if (slug === MOBILE_REPO) throw httpError(400, 'hivebrite-mobile reste toujours suivi');
    saveRepos(repoList().filter((r) => r.slug !== slug));
    db.prepare('DELETE FROM prs WHERE repo = ? AND closed_at IS NULL').run(slug); bump('prs');
    logEvent('repos', `Repo retiré : ${slug} (le clone reste sur le disque)`);
  } else if (body.op === 'clone') {
    if (existsSync(join(repo.path, '.git')) || cloning.has(slug)) return;
    cloning.add(slug); bump('reposCfg');
    sh('mkdir', ['-p', dirname(repo.path)])
      .then(() => sh('gh', ['repo', 'clone', slug, repo.path], { timeout: 30 * 60_000 }))
      .then(() => logEvent('repos', `Clone terminé : ${slug} → ${repo.path}`), (e) => logEvent('repos', `Clone de ${slug} en échec : ${e.message.slice(0, 200)}`))
      .finally(() => { cloning.delete(slug); bump('reposCfg'); scanWorktrees().catch(() => {}); pushState(); });
    return;
  } else throw httpError(400, `op inconnue ${body.op}`);
  bump('reposCfg');
  githubNow().catch(() => {}).finally(() => scanWorktrees().catch(() => {}).finally(pushState));
}

// Static-ish bits, computed once.
const CHORE_LIST = [...CHORES, CUSTOM, REVIEW_CHORE, AUTO_REVIEW_CHORE, BATCH, EPIC_PLAN, STANDUP, IDEA].map(({ key, label, model, effort }) => ({ key, label, model, effort }));

// Each section is rebuilt only when one of the tables it reads has changed (db.version):
// a session ticking its token count no longer recomputes Jira, epics or the review history.
const memo = new Map();
const cached = (name, deps, build) => {
  const v = version(...deps);
  const hit = memo.get(name);
  if (hit?.v === v) return hit.value;
  const value = build();
  memo.set(name, { v, value, json: JSON.stringify(value) });
  return value;
};
const sessionsNow = () => cached('_sessions', ['sessions'], () => listSessions());
const TABLES = ['issues', 'epics', 'prs', 'sessions', 'events', 'usage', 'slack'];

async function state() {
  const sessions = sessionsNow();
  return {
    me: config.me,
    profile: { login: config.me, name: config.name, firstName: config.firstName },
    tasks: cached('tasks', ['issues', 'prs', 'sessions'], () => buildTasks(sessions)),
    reviews: cached('reviews', ['prs', 'sessions'], () => buildReviews(sessions)),
    reviewHistory: cached('reviewHistory', ['prs', 'sessions'], () => buildReviewHistory(sessions)),
    epics: cached('epics', ['epics', 'issues', 'sessions'], () => buildEpics(sessions)),
    sessions: cached('sessions', ['sessions'], () => sessions.map(slim)),
    stack: await stackStatus(),
    sync: kv.get('sync') ?? null,
    jira: { ...(kv.get('jira') ?? {}), source: await jiraSource(), site: config.jira.site, service: config.jira.keychainService, email: config.email },
    autoReview: cached('autoReview', ['prs', 'sessions', 'kv:autoReview'], autoReviewState),
    team: config.team,
    events: cached('events', ['events'], () => db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 150').all()),
    slack: cached('slack', ['slack', 'kv:slack'], () => ({ ...(kv.get('slack') ?? {}), enabled: config.slack.enabled, model: config.slack.model, items: slackItems() })),
    db: cached('db', TABLES, () => ({ path: join(config.dataDir, 'ai-dashboard.db'), tables: Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n])) })),
    standups: cached('standups', ['standups'], listStandups),
    ideas: cached('ideas', ['ideas'], ideasState),
    graph: cached('graph', ['graph', 'worktrees'], graphState),
    fleet: cached('fleet', ['fleetLive'], () => fleetSnap),
    repos: cached('repos', ['reposCfg', 'kv:repoSync', 'prs', 'events'], buildRepos),
    brutalRules: cached('brutalRules', ['kv:brutalRules'], brutalRules),
    onboarding: cached('onboarding', ['kv:onboarding'], onboardingState),
    chores: CHORE_LIST,
    models: MODELS,
    efforts: EFFORTS,
  };
}

// ---- live ------------------------------------------------------------------
const clients = new Set();
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const broadcast = (event, data) => clients.forEach((res) => send(res, event, data));
let pushTimer;
let last = {}; // section → JSON last sent
// Coalesced (250 ms), skipped when no tab is open, and only the sections that changed are sent.
const pushState = () => {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    if (!clients.size) return;
    const st = await state();
    const patch = {};
    for (const [k, v] of Object.entries(st)) {
      const j = memo.get(k)?.value === v ? memo.get(k).json : JSON.stringify(v);
      if (last[k] !== j) { patch[k] = v; last[k] = j; }
    }
    if (!Object.keys(patch).length) return;
    const body = JSON.stringify(patch);
    clients.forEach((res) => res.write(`event: patch\ndata: ${body}\n\n`));
  }, 250);
};
onStackLog((line) => broadcast('stacklog', line));

// ---- sync loops --------------------------------------------------------------
// GitHub + the auto-review check; concurrent callers share the run in flight.
let ghFlight = null;
function githubNow({ forceRadar = false } = {}) {
  if (ghFlight && forceRadar) return ghFlight.finally(() => githubNow({ forceRadar }));
  ghFlight ??= (async () => {
    const errors = [];
    await syncGithub().catch((e) => errors.push(`GitHub: ${e.message}`));
    await runAutoReview(startAutoReview, { force: forceRadar })
      .then((n) => n.length && console.log(`auto-review started for #${n.join(', #')}`))
      .catch((e) => errors.push(`Auto-review: ${e.message}`));
    kv.set('sync', { at: new Date().toISOString(), errors });
    pushState();
    if (errors.length) throw new Error(errors.join(' · '));
  })().finally(() => { ghFlight = null; });
  return ghFlight;
}

async function sync({ force = false } = {}) {
  // Jira / Slack go through headless Claude (tens of seconds): they push when they land.
  syncJira({ force }).catch((e) => console.error('jira', e.message)).finally(pushState);
  syncSlack({ force }).catch((e) => console.error('slack', e.message)).finally(pushState);
  pushState();
  await githubNow().catch(() => {});
}

// "Refresh this page": exactly the sources a page shows, forced, awaited.
const SOURCES = {
  github: () => githubNow(),
  jira: () => syncJira({ force: true }),
  slack: () => syncSlack({ force: true }),
  radar: () => githubNow({ forceRadar: true }),
  sessions: () => pollSessions(onReviewDone),
  usage: () => scanUsage().then(() => kv.set('usageScannedAt', new Date().toISOString())),
  stack: async () => {},
  graph: () => scanWorktrees(),
  fleet: () => scanWorktrees().then(fleetTick),
  onboarding: () => checkOnboarding(),
};
const SCOPES = {
  home: ['github', 'jira', 'slack', 'sessions'], mine: ['github', 'sessions'], tasks: ['github', 'jira', 'sessions'], jira: ['jira'], epics: ['jira', 'sessions'],
  reviews: ['github', 'sessions'], radar: ['radar', 'sessions'], brutal: ['github', 'sessions'], slack: ['slack'],
  sessions: ['sessions'], usage: ['usage'], stack: ['stack'], data: ['usage'], atelier: ['graph', 'sessions', 'github'], fleet: ['fleet', 'usage'], onboarding: ['onboarding'],
};
async function refresh(scope) {
  const names = SCOPES[scope] ?? Object.keys(SOURCES);
  const results = await Promise.allSettled(names.map((n) => SOURCES[n]()));
  pushState();
  return Object.fromEntries(names.map((n, i) => [n, results[i].status === 'fulfilled' ? 'ok' : String(results[i].reason?.message ?? results[i].reason).slice(0, 200)]));
}

async function onReviewDone(session) {
  const pr = db.prepare('SELECT * FROM prs WHERE repo = ? AND number = ? AND closed_at IS NULL').get(session.repo, session.pr);
  if (!pr) return { error: 'PR no longer open' };
  const out = await postDraftReview(session, pr);
  const auto = session.chore === 'auto-review';
  let counts = '';
  try { const c = JSON.parse(out.review_json ?? '{}').comments ?? []; counts = ` — ${['critical', 'warning', 'suggestion'].map((k) => `${c.filter((x) => x.severity === k).length} ${{ warning: 'major', suggestion: 'improvement' }[k] ?? k}`).join(', ')}`; } catch {}
  logEvent(out.error ? 'review-error' : auto ? 'review-posted' : 'review-draft',
    out.error ? `Review #${pr.number} non postée : ${out.error}` : `${auto ? 'Brutal review postée' : 'Brouillon de review créé'} sur #${pr.number}${counts}`,
    { repo: pr.repo, pr: pr.number, session: session.id });
  return out;
}

// Reviews posted before review_json existed: parse them once from their transcript.
for (const s of db.prepare(`SELECT * FROM sessions WHERE chore IN ('ai-review','auto-review') AND review_json IS NULL AND session_id IS NOT NULL`).all()) {
  try { const r = reviewFromTranscript(s); if (r) update('sessions', { id: s.id }, { review_json: JSON.stringify(r) }); } catch {}
}

setInterval(sync, config.syncEveryMs);
setInterval(() => pollSessions(onReviewDone).then((c) => c && pushState()).catch((e) => console.error('poll', e.message)), config.sessionPollMs);
setInterval(pushState, 15_000); // stack status, relative times
const usageTick = () => scanUsage().then((n) => { kv.set('usageScannedAt', new Date().toISOString()); if (n) pushState(); }).catch((e) => console.error('usage', e.message));
setInterval(usageTick, 60_000);
usageTick();
setInterval(() => standupTick()?.finally(pushState), 60_000);
setInterval(() => ideasTick()?.finally(pushState), 60_000);
// Fleet: fold new transcript bytes + live status every 5 s; push only when the picture changed.
let fleetSnap = null, fleetJson = '';
let fleetBusy = false;
const fleetTick = async () => {
  if (fleetBusy) return;
  fleetBusy = true;
  try {
    await scanFleet();
    const f = await fleetState();
    const j = JSON.stringify(f);
    if (j !== fleetJson) { fleetJson = j; fleetSnap = f; bump('fleetLive'); pushState(); }
  } catch (e) { console.error('fleet', e.message); } finally { fleetBusy = false; }
};
setInterval(fleetTick, 5000);
fleetTick();
const wtTick = () => scanWorktrees().then(pushState).catch((e) => console.error('worktrees', e.message));
setInterval(wtTick, 2 * 60_000);
wtTick();
sync();
const onboardingTick = () => checkOnboarding().finally(pushState);
setInterval(onboardingTick, 60 * 60_000);
onboardingTick();

// Read-only connection for the SQL console: it can't write, whatever the query says.
const ro = new DatabaseSync(join(config.dataDir, 'ai-dashboard.db'), { readOnly: true });

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
    const self = body.chore === 'self-review';
    const pr = db.prepare('SELECT * FROM prs WHERE kind = ? AND closed_at IS NULL AND repo = ? AND number = ?').get(self ? 'mine' : 'review', body.repo, Number(body.pr));
    if (!pr) throw httpError(404, 'PR not found');
    const chore = self ? SELF_REVIEW_CHORE : body.chore === 'auto-review' ? AUTO_REVIEW_CHORE : REVIEW_CHORE;
    return { chore, pr, prompt: chore.prompt(pr) };
  }
  if (body.kind === 'idea') {
    const idea = ideaById(Number(body.idea));
    if (!idea) throw httpError(404, 'idea not found');
    return { chore: IDEA, idea, prompt: IDEA.prompt(idea) };
  }
  if (body.kind === 'epic') {
    const key = String(body.epic ?? '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) throw httpError(400, 'epic key like MO-1234 expected');
    const epic = db.prepare('SELECT * FROM epics WHERE key = ?').get(key) ?? { key, summary: '', url: `${config.jira.site}/browse/${key}` };
    return { chore: EPIC_PLAN, epic, prompt: EPIC_PLAN.prompt(epic) };
  }
  const task = body.task ? findTask(body.task) : null;
  const chore = choreByKey(body.chore) ?? CUSTOM;
  if (body.kind === 'here') {
    if (!isWorktree(body.cwd)) throw httpError(400, 'unknown worktree');
    return { chore, task, here: body.cwd, prompt: `You are in the existing worktree ${body.cwd} — work here, on its current branch.\n\n${chore.prompt(task)}` };
  }
  return { chore, task, prompt: chore.prompt(task) };
}

async function startSession(body) {
  const d = choreDefaults(body);
  const model = MODELS.includes(body.model) ? body.model : d.chore.model;
  const effort = EFFORTS.includes(body.effort) ? body.effort : d.chore.effort;
  const prompt = (body.prompt ?? d.prompt).trim();
  const repo = repoBySlug(d.pr?.repo ?? d.task?.pr?.repo ?? config.repos[0].slug);
  const cwd = d.here ? d.here : d.pr ? await reviewWorktree(repo, d.pr) : d.task ? await taskWorktree(repo, d.task) : await scratchWorktree(repo, d.tasks ? 'batch' : d.epic ? `plan-${d.epic.key}` : d.idea ? `idea-${d.idea.id}` : 'custom');
  const label = d.here ? `${d.here.split('/').pop()}${d.task ? `-${d.task.key}` : ''}` : d.pr ? `review-${d.pr.number}` : d.task ? d.task.key : d.tasks ? `${d.tasks.length}-tickets` : d.epic ? d.epic.key : d.idea ? `idea-${d.idea.id}` : 'custom';
  return launch({
    name: `${SLUG}-ai-${label}-${d.chore.key}`.slice(0, 60),
    cwd, model, effort, prompt,
    readOnly: !!d.pr,
    allow: d.epic ? PLAN_TOOLS : null,
    row: {
      title: d.idea?.title ?? d.pr?.title ?? d.epic?.summary ?? d.task?.issue?.summary ?? d.task?.pr?.title ?? null,
      head_sha: d.pr?.head_sha ?? null, author: d.pr?.author ?? null, epic: d.epic?.key ?? null,
      chore: d.chore.key, task: d.task?.key ?? null, tasks: d.tasks ? JSON.stringify(d.tasks.map((t) => t.key)) : null,
      repo: repo.slug, pr: d.pr?.number ?? d.task?.pr?.number ?? null,
    },
  });
}

async function startAutoReview(pr) {
  const repo = repoBySlug(pr.repo);
  const c = AUTO_REVIEW_CHORE;
  return launch({
    name: `${SLUG}-ai-review-${pr.number}-auto-review`,
    cwd: await reviewWorktree(repo, pr), model: c.model, effort: c.effort, prompt: c.prompt(pr),
    readOnly: true,
    row: { chore: c.key, task: null, tasks: null, repo: repo.slug, pr: pr.number, title: pr.title, head_sha: pr.head_sha, author: pr.author },
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
    if (req.method === 'GET' && pathname === '/api/fleet/timeline') return json(res, 200, { bins: fleetTimeline(Number(searchParams.get('hours') ?? 24)) });
    const ft = pathname.match(/^\/api\/fleet\/([0-9a-f-]{36})\/transcript$/);
    if (req.method === 'GET' && ft) {
      const f = fleetSnap?.sessions.find((x) => x.sid === ft[1]) ?? fleetRow(ft[1]);
      if (!f) throw httpError(404, 'session not found');
      return json(res, 200, { session: f, items: transcriptFile(fleetFile(ft[1])) });
    }
    if (req.method === 'GET' && pathname === '/api/repos/catalog') return json(res, 200, await repoCatalog({ force: searchParams.has('force') }));
    if (req.method === 'GET' && pathname === '/api/usage') return json(res, 200, usageStats(Object.fromEntries(searchParams)));
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
      const st = await state();
      for (const [k, v] of Object.entries(st)) last[k] ??= JSON.stringify(v);
      send(res, 'state', st);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST') {
      // Custom header → a cross-site page can't send it without a CORS preflight we never answer.
      if (req.headers['x-dashboard'] !== '1') return json(res, 403, { error: 'missing X-Dashboard header' });
      const body = await readBody(req);
      if (pathname === '/api/slack/sync') {
        syncSlack({ force: true, model: body.model === 'sonnet' ? 'sonnet' : undefined }).catch(() => {}).finally(pushState);
        pushState();
        return json(res, 202, { ok: true });
      }
      const ss = pathname.match(/^\/api\/slack\/(.+)\/status$/);
      if (ss) { setSlackStatus(decodeURIComponent(ss[1]), ['new', 'done', 'snoozed'].includes(body.status) ? body.status : 'new'); pushState(); return json(res, 200, { ok: true }); }
      if (pathname === '/api/sql') {
        const q = String(body.q ?? '').trim();
        if (!/^(select|with|pragma table_info)\b/i.test(q)) throw httpError(400, 'lecture seule : SELECT / WITH uniquement');
        const rows = ro.prepare(q).all().slice(0, 1000);
        return json(res, 200, { rows });
      }
      if (pathname === '/api/ideas') { generateIdeas({ model: body.model === 'opus' ? 'opus' : 'sonnet' }).finally(pushState); pushState(); return json(res, 202, { ok: true }); }
      const is = pathname.match(/^\/api\/ideas\/(\d+)\/status$/);
      if (is) { setIdeaStatus(Number(is[1]), ['new', 'kept', 'dismissed', 'launched', 'done'].includes(body.status) ? body.status : 'new'); pushState(); return json(res, 200, { ok: true }); }
      if (pathname === '/api/standup') { generateStandup({ model: body.model === 'opus' ? 'opus' : 'sonnet' }).finally(pushState); pushState(); return json(res, 202, { ok: true }); }
      const g = pathname.match(/^\/api\/graph\/(pos|resetPos|addNode|editNode|deleteNode|addEdge|deleteEdge)$/);
      if (g) { const id = graphOps[g[1]](body); pushState(); return json(res, 200, { ok: true, id }); }
      const fr = pathname.match(/^\/api\/fleet\/([0-9a-f-]{36})\/(reply|terminal)$/);
      if (fr) {
        const f = fleetSnap?.sessions.find((x) => x.sid === fr[1]);
        if (!f) throw httpError(404, 'session not found');
        const live = ((await liveAgents(0)) ?? []).find((a) => a.sessionId === f.sid);
        if (fr[2] === 'terminal') {
          await openTerminalAt(f.cwd, live?.kind === 'background' ? `claude attach ${live.id}` : live ? null : `claude --resume ${f.sid}`, f.name);
          return json(res, 200, { ok: true, note: live?.kind === 'interactive' ? 'déjà ouverte dans un autre terminal' : null });
        }
        const text = String(body.text ?? '').trim();
        if (!text) throw httpError(400, 'empty message');
        if (live?.kind === 'interactive') throw httpError(409, 'Session ouverte dans un terminal : réponds-y là-bas (ou ferme-la pour la reprendre ici).');
        if (live) { await sh('claude', ['stop', live.id]).catch(() => {}); await new Promise((r) => setTimeout(r, 1500)); }
        await sh('claude', ['--bg', '--resume', f.sid, '--', text], { cwd: f.cwd, timeout: 60_000 });
        logEvent('fleet-reply', `Message envoyé à ${f.name} : ${text.slice(0, 120)}`);
        setTimeout(fleetTick, 2000);
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/worktree/create') {
        const repo = repoBySlug(body.repo);
        const name = String(body.name ?? '').trim();
        if (!repo || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{1,80}$/.test(name)) throw httpError(400, 'nom de branche invalide');
        const base = String(body.base || repo.base);
        const dir = join(repo.path, '.claude/worktrees', name.replace(/[^A-Za-z0-9_-]/g, '-'));
        await sh('git', ['fetch', '--quiet', 'origin', base], { cwd: repo.path });
        await sh('git', ['worktree', 'add', '--quiet', '-b', name, dir, `origin/${base}`], { cwd: repo.path });
        await scanWorktrees();
        logEvent('worktree', `Worktree créé : ${name} (depuis ${base})`);
        pushState();
        return json(res, 200, { ok: true, path: dir });
      }
      if (pathname === '/api/worktree/remove') {
        const w = db.prepare('SELECT * FROM worktrees WHERE path = ?').get(body.path);
        if (!w) throw httpError(404, 'worktree inconnu');
        if (config.repos.some((r) => r.path === w.path)) throw httpError(400, 'le checkout principal ne se supprime pas');
        if (w.dirty && !body.force) throw httpError(409, `${w.dirty} fichier(s) modifié(s) non commités — confirme la suppression forcée`);
        const repo = repoBySlug(w.repo);
        await sh('git', ['worktree', 'remove', ...(body.force ? ['--force'] : []), w.path], { cwd: repo.path });
        await scanWorktrees();
        logEvent('worktree', `Worktree supprimé : ${w.path} (branche ${w.branch ?? 'détachée'} conservée)`);
        pushState();
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/worktree/terminal') {
        if (!isWorktree(body.path)) throw httpError(400, 'unknown worktree');
        await openTerminalAt(body.path, body.claude ? 'claude' : null);
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/repos') { await reposOp(body); pushState(); return json(res, 200, { ok: true }); }
      if (pathname === '/api/brutal-rules') {
        try { setBrutalRules(String(body.op), body); } catch (e) { throw httpError(400, e.message); }
        pushState();
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/onboarding/check') { onboardingTick(); pushState(); return json(res, 202, { ok: true }); }
      if (pathname === '/api/onboarding/fix') {
        const f = fixCommand(String(body.key ?? ''));
        if (!f) throw httpError(404, 'pas de commande pour ce check');
        await openTerminalAt(f.cwd, f.cmd, f.title);
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/refresh') return json(res, 200, { results: await refresh(String(body.scope ?? '')) });
      if (pathname === '/api/sync') { resetJiraToken(); await sync({ force: true }); return json(res, 200, { ok: true }); }
      if (pathname === '/api/sessions') {
        const id = await startSession(body);
        if (body.kind === 'idea') setIdeaStatus(Number(body.idea), 'launched');
        pushState();
        return json(res, 200, { id });
      }
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
}).listen(config.port, '127.0.0.1', () => console.log(`${config.firstName}'s AI Dashboard → http://localhost:${config.port}`));
