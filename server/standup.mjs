import { config } from './config.mjs';
import { bump, db, logEvent } from './db.mjs';
import { ghGraphql, sh } from './sh.mjs';

// The stand-up: facts gathered here, deterministically (GitHub, Jira as synced, the dashboard's
// own sessions and reviews), then ONE headless Claude call turns them into the text. Generated
// on its own every weekday at 9:00 for the previous working day (Monday covers Fri → Sun), or
// on demand. Each one is kept in `standups`.

db.exec(`CREATE TABLE IF NOT EXISTS standups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT, since TEXT, until TEXT, generated_at TEXT, auto INTEGER,
  model TEXT, cost REAL, facts TEXT, result TEXT, error TEXT
)`);

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The previous working day: [start, end) in local time. Monday → since Friday 00:00. */
export function previousWorkday(now = new Date()) {
  const end = new Date(now); end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - (end.getDay() === 1 ? 3 : end.getDay() === 0 ? 2 : 1));
  return { start, end };
}

const PR = `number title url state isDraft createdAt mergedAt updatedAt headRefName additions deletions
  author { login }
  reviews(last: 30) { nodes { author { login } state submittedAt } }
  commits(last: 60) { nodes { commit { committedDate messageHeadline author { user { login } } } } }`;
const search = async (q) => (await ghGraphql(`query($q: String!) { search(query: $q, type: ISSUE, first: 60) { nodes { ... on PullRequest { ${PR} } } } }`, { q })).search.nodes;

async function gatherFacts(start, end) {
  const inRange = (ts) => ts && new Date(ts) >= start && new Date(ts) < end;
  const range = `${ymd(start)}..${ymd(new Date(end - 1))}`;
  const repos = config.repos.map((r) => r.slug);
  const facts = { period: { from: start.toISOString(), to: end.toISOString() }, merged: [], opened: [], pushed: [], reviewed: [], jira: [], sessions: [], brutal: [], today: {} };
  for (const repo of repos) {
    const [mine, reviewed] = await Promise.all([
      search(`repo:${repo} is:pr author:@me updated:${range}`),
      search(`repo:${repo} is:pr -author:@me reviewed-by:@me updated:${range}`),
    ]);
    for (const p of mine) {
      const ref = { repo, number: p.number, title: p.title, url: p.url, branch: p.headRefName, size: p.additions + p.deletions };
      if (inRange(p.mergedAt)) facts.merged.push(ref);
      else if (inRange(p.createdAt)) facts.opened.push({ ...ref, draft: p.isDraft });
      const commits = p.commits.nodes.filter((c) => inRange(c.commit.committedDate) && (c.commit.author?.user?.login ?? config.me) === config.me);
      if (commits.length && !inRange(p.mergedAt)) facts.pushed.push({ ...ref, commits: commits.map((c) => c.commit.messageHeadline).slice(-8) });
    }
    for (const p of reviewed) {
      const mineReviews = p.reviews.nodes.filter((r) => r.author?.login === config.me && inRange(r.submittedAt));
      if (mineReviews.length) facts.reviewed.push({ repo, number: p.number, title: p.title, url: p.url, author: p.author?.login, verdict: mineReviews.at(-1).state });
    }
  }
  facts.jira = db.prepare('SELECT key, summary, status, status_category, type, url FROM issues WHERE updated >= ? AND updated < ?')
    .all(start.toISOString(), end.toISOString());
  facts.sessions = db.prepare('SELECT chore, title, task, pr, state, model, ROUND(cost_usd, 2) cost FROM sessions WHERE started_at >= ? AND started_at < ?')
    .all(start.toISOString(), end.toISOString());
  facts.brutal = db.prepare("SELECT pr, title, author, chore, posted_url FROM sessions WHERE chore IN ('auto-review','ai-review') AND posted_url IS NOT NULL AND started_at >= ? AND started_at < ?")
    .all(start.toISOString(), end.toISOString());
  // What's on my plate now, for "Aujourd'hui" / "Blocages".
  facts.today = {
    inProgress: db.prepare("SELECT key, summary, status FROM issues WHERE status_category = 'indeterminate' ORDER BY updated DESC LIMIT 15").all(),
    myPrs: db.prepare("SELECT number, title, url, checks, mergeable, review_decision, unresolved_threads, is_draft FROM prs WHERE kind = 'mine' AND closed_at IS NULL ORDER BY updated DESC LIMIT 20").all(),
    reviewRequests: db.prepare("SELECT number, title, url, author FROM prs WHERE kind = 'review' AND closed_at IS NULL AND requested_me = 1 AND my_review IS NULL").all(),
    slack: db.prepare("SELECT channel, author, summary, action FROM slack WHERE status = 'new' AND priority IN ('urgent','important') ORDER BY ts DESC LIMIT 10").all(),
  };
  return facts;
}

const PROMPT = (facts) => `Write ${config.slack.me}'s daily stand-up (mobile engineer, React Native, Hivebrite) from these FACTS ONLY — never invent work.
Facts (JSON): ${JSON.stringify(facts)}

Rules: French, concise, concrete, no filler. Group related items (a PR and its ticket = one line). Link PRs as [#123](url) and tickets as [MO-123](url) when a url is known.
"Hier" = what was done in the period (merged, opened, pushed, reviews given, brutal reviews, tickets moved). "Aujourd'hui" = the most useful next steps from facts.today (failing checks, conflicts, comments to address, reviews requested, tickets in progress) — max 5, the most important first. "Blocages" = only real ones (waiting on someone, a review, a flag, a backend) — empty if none.
Output ONLY one JSON object, no fences:
{"headline": "<one short sentence summing up the day>",
 "yesterday": ["<markdown bullet>", ...], "today": ["<markdown bullet>", ...], "blockers": ["<markdown bullet>", ...],
 "stats": {"merged": n, "opened": n, "reviews": n, "commits": n},
 "slack": "<the stand-up as plain Slack text: *Hier* / *Aujourd'hui* / *Blocages* with • bullets, PR as #123, ready to paste>"}`;

let running = null;
export function generateStandup({ auto = false, model = 'sonnet' } = {}) {
  running ??= (async () => {
    const { start, end } = previousWorkday();
    const day = ymd(new Date());
    const id = db.prepare('INSERT INTO standups (day, since, until, generated_at, auto, model) VALUES (?, ?, ?, ?, ?, ?)')
      .run(day, start.toISOString(), end.toISOString(), new Date().toISOString(), auto ? 1 : 0, model).lastInsertRowid;
    bump('standups');
    try {
      const facts = await gatherFacts(start, end);
      db.prepare('UPDATE standups SET facts = ? WHERE id = ?').run(JSON.stringify(facts), id);
      const out = JSON.parse(await sh('claude', ['-p', '--model', model, '--output-format', 'json', '--tools', '', '--', PROMPT(facts)], { cwd: config.dataDir, input: '', timeout: 240_000 }));
      if (out.is_error) throw new Error(String(out.result).slice(0, 200));
      const text = String(out.result);
      const result = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      db.prepare('UPDATE standups SET result = ?, cost = ? WHERE id = ?').run(JSON.stringify(result), out.total_cost_usd ?? 0, id);
      logEvent('standup', `Stand-up ${auto ? 'auto ' : ''}généré (${ymd(start)} → ${ymd(new Date(end - 1))}) · $${(out.total_cost_usd ?? 0).toFixed(3)}`);
    } catch (e) {
      db.prepare('UPDATE standups SET error = ? WHERE id = ?').run(e.message.slice(0, 300), id);
      logEvent('standup-error', `Stand-up en échec : ${e.message.slice(0, 200)}`);
    } finally {
      bump('standups');
    }
  })().finally(() => { running = null; });
  return running;
}

/** Weekdays at 9:00 (or the first minute after, if the Mac was asleep): once per day. */
export function standupTick() {
  const now = new Date();
  if (now.getDay() === 0 || now.getDay() === 6 || now.getHours() < config.standup.hour) return null;
  const done = db.prepare('SELECT 1 FROM standups WHERE day = ? AND (auto = 1 OR result IS NOT NULL)').get(ymd(now)); // a manual one counts too
  return done ? null : generateStandup({ auto: true });
}

export const listStandups = () => db.prepare('SELECT id, day, since, until, generated_at, auto, model, cost, result, error, facts FROM standups ORDER BY id DESC LIMIT 30').all()
  .map((s) => ({ ...s, result: s.result ? JSON.parse(s.result) : null, facts: s.facts ? JSON.parse(s.facts) : null, pending: !s.result && !s.error }));
