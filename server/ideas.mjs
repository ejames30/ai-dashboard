import { config } from './config.mjs';
import { bump, db, logEvent } from './db.mjs';
import { gh, git, sh } from './sh.mjs';

// The innovation corner: every weekday morning a headless Claude, run read-only inside the main
// checkout, proposes a handful of concrete ideas — product features, dev XP, CI/CD, quality,
// perf, AI tooling — grounded in the repo, recent work, CI stats and the ecosystem's news.
// Ideas are kept (new / kept / dismissed / launched) so it never pitches the same thing twice.

db.exec(`CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT, batch INTEGER, category TEXT, title TEXT, pitch TEXT, why TEXT,
  effort TEXT, impact INTEGER, first_step TEXT, sources TEXT, status TEXT DEFAULT 'new', created_at TEXT
);
CREATE TABLE IF NOT EXISTS idea_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT, started_at TEXT, auto INTEGER, model TEXT, cost REAL, count INTEGER, error TEXT, done INTEGER DEFAULT 0)`);

export const CATEGORIES = { feature: 'Feature app', devxp: 'Dev XP', ci: 'CI / CD', quality: 'Qualité & tests', perf: 'Performance', ai: 'IA & outillage', team: 'Équipe & process' };

const TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(gh run list:*)', 'Bash(gh pr list:*)', 'Bash(gh run view:*)', 'Bash(ls:*)'];
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function context(repo) {
  const [log, runs] = await Promise.all([
    git(repo.path, ['log', '--since=14.days', '--format=%h %s', 'origin/master']).catch(() => ''),
    gh(['run', 'list', '-R', repo.slug, '-L', '200', '--json', 'workflowName,conclusion']).catch(() => '[]'),
  ]);
  const ci = {};
  for (const r of JSON.parse(runs)) { const w = (ci[r.workflowName] ??= {}); w[r.conclusion || 'running'] = (w[r.conclusion || 'running'] ?? 0) + 1; }
  const past = db.prepare("SELECT title, status FROM ideas ORDER BY id DESC LIMIT 120").all();
  const cost = db.prepare("SELECT ROUND(SUM(cost), 0) c FROM usage WHERE day >= date('now', '-7 days')").get()?.c ?? 0;
  return { log: log.split('\n').slice(0, 80).join('\n'), ci, past, cost };
}

const PROMPT = (repo, c, n) => `You run the innovation corner of ${config.slack.me}'s dashboard. He is a mobile engineer on Hivebrite's React Native + Expo app (repo ${repo.slug}, you are in its main checkout, read-only). Propose ${n} NEW ideas that would make the team's life better or the app better.

Mix the categories (${Object.entries(CATEGORIES).map(([k, v]) => `${k} = ${v}`).join(', ')}) — at least one "feature", one "devxp" and one "ci".
Ground every idea in something real: a file/pattern in this repo (read AGENTS.md files, package.json, .github/workflows, features/), the recent commits, the CI stats below, or a recent ecosystem change (Expo, React Native, EAS, GitHub Actions, Claude Code — use WebSearch for news from the last weeks). No generic advice ("add more tests"): each idea is specific, doable, and says what it unlocks.

Recent commits on master (14 days):
${c.log}

CI runs (last 200, by workflow → conclusions): ${JSON.stringify(c.ci)}
Claude spend, last 7 days (API estimate): ~$${c.cost}
Already proposed — never repeat or rephrase these: ${JSON.stringify(c.past.map((p) => p.title))}

Output ONLY a JSON array, no prose, no fences. Each item:
{"category": "<one of ${Object.keys(CATEGORIES).join('|')}>", "title": "<short, punchy, French>", "pitch": "<2-3 sentences, French: what and why it matters>",
 "why": "<French: the concrete evidence — file paths, numbers, the release/news that makes it possible now>", "effort": "S|M|L", "impact": <1-5>,
 "first_step": "<French: the very first thing to do, in one sentence>", "sources": ["<repo path or URL>", ...]}`;

let running = null;
export function generateIdeas({ auto = false, n = 6, model = 'sonnet' } = {}) {
  running ??= (async () => {
    const repo = config.repos[0];
    const day = ymd(new Date());
    const run = db.prepare('INSERT INTO idea_runs (day, started_at, auto, model) VALUES (?, ?, ?, ?)').run(day, new Date().toISOString(), auto ? 1 : 0, model).lastInsertRowid;
    bump('ideas');
    try {
      const c = await context(repo);
      const out = JSON.parse(await sh('claude', ['-p', '--model', model, '--output-format', 'json', '--permission-mode', 'dontAsk', '--allowedTools', ...TOOLS, '--', PROMPT(repo, c, n)], {
        cwd: repo.path, input: '', timeout: 900_000,
      }));
      if (out.is_error) throw new Error(String(out.result).slice(0, 200));
      const text = String(out.result);
      const items = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
      const ins = db.prepare('INSERT INTO ideas (day, batch, category, title, pitch, why, effort, impact, first_step, sources, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const i of items) {
        if (!i?.title) continue;
        ins.run(day, run, CATEGORIES[i.category] ? i.category : 'devxp', i.title, i.pitch ?? '', i.why ?? '', ['S', 'M', 'L'].includes(i.effort) ? i.effort : 'M',
          Math.max(1, Math.min(5, Number(i.impact) || 3)), i.first_step ?? '', JSON.stringify(i.sources ?? []), new Date().toISOString());
      }
      db.prepare('UPDATE idea_runs SET cost = ?, count = ?, done = 1 WHERE id = ?').run(out.total_cost_usd ?? 0, items.length, run);
      logEvent('ideas', `${items.length} nouvelles idées ${auto ? '(auto) ' : ''}· $${(out.total_cost_usd ?? 0).toFixed(2)}`);
    } catch (e) {
      db.prepare('UPDATE idea_runs SET error = ?, done = 1 WHERE id = ?').run(e.message.slice(0, 300), run);
      logEvent('ideas-error', `Idées en échec : ${e.message.slice(0, 200)}`);
    } finally {
      bump('ideas');
    }
  })().finally(() => { running = null; });
  return running;
}

/** Weekdays, from config.ideas.hour:minute, once a day. */
export function ideasTick() {
  const now = new Date();
  const [h, m] = config.ideas.at;
  if (now.getDay() === 0 || now.getDay() === 6 || now.getHours() * 60 + now.getMinutes() < h * 60 + m) return null;
  if (db.prepare('SELECT 1 FROM idea_runs WHERE day = ? AND (auto = 1 OR (done = 1 AND error IS NULL))').get(ymd(now))) return null;
  return generateIdeas({ auto: true });
}

export const ideasState = () => ({
  categories: CATEGORIES,
  ideas: db.prepare('SELECT * FROM ideas ORDER BY id DESC LIMIT 300').all().map((i) => ({ ...i, sources: JSON.parse(i.sources ?? '[]') })),
  runs: db.prepare('SELECT * FROM idea_runs ORDER BY id DESC LIMIT 10').all(),
});
export const setIdeaStatus = (id, status) => { db.prepare('UPDATE ideas SET status = ? WHERE id = ?').run(status, id); bump('ideas'); };
export const ideaById = (id) => db.prepare('SELECT * FROM ideas WHERE id = ?').get(id);
