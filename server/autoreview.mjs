import { config, radarWatches } from './config.mjs';
import { db, kv, logEvent } from './db.mjs';

// Auto brutal review: every sync, each NEW ready-for-review PR from the listed teammates
// gets one read-only review session; when it's done the result is POSTED on the PR
// (onReviewDone, chore 'auto-review') — no draft step, by design.
//
// "New" = not open yet when auto-review was first switched on: the baseline is the set of
// PRs open at that moment, so turning it on doesn't spray reviews over the whole backlog.
// Each PR is reviewed once; a draft is picked up when it's marked ready.

const key = (pr) => `${pr.repo}#${pr.number}`;
const watchedPrs = () => db.prepare("SELECT * FROM prs WHERE kind = 'review' AND closed_at IS NULL").all().filter(radarWatches);

/** What the radar shows: config, last check, and every watched PR with why it is (not) reviewed. */
export function autoReviewState() {
  const a = config.autoReview;
  const s = kv.get('autoReview') ?? {};
  const done = new Set(s.done ?? []);
  const baseline = new Set(s.baseline ?? s.done ?? []);
  const sessions = db.prepare("SELECT id, pr, repo, state, posted_url, error, started_at, head_sha FROM sessions WHERE chore = 'auto-review' ORDER BY started_at DESC").all();
  const watched = watchedPrs().map((pr) => {
    const session = sessions.find((x) => x.repo === pr.repo && x.pr === pr.number) ?? null;
    const status = pr.is_draft ? 'draft' : session ? (session.error ? 'error' : session.posted_url ? 'posted' : 'reviewing')
      : baseline.has(key(pr)) ? 'baseline' : pr.my_review ? 'mine' : done.has(key(pr)) ? 'launched' : 'queued';
    return { repo: pr.repo, number: pr.number, title: pr.title, author: pr.author, url: pr.url, size: pr.additions + pr.deletions, is_draft: pr.is_draft, status, session, outdated: !!(session?.head_sha && session.head_sha !== pr.head_sha) };
  });
  return {
    enabled: a.enabled, authors: a.authors, scopes: a.scopes, repos: config.repos.map((r) => ({ slug: r.slug, radar: r.radar })), maxConcurrent: a.maxConcurrent, everyMs: config.syncEveryMs, hours: a.hours, active: inHours(),
    since: s.since ?? null, lastCheck: s.lastCheck ?? null, reviewed: sessions.length, watched,
  };
}

const inHours = () => { const h = new Date().getHours(); return h >= config.autoReview.hours[0] && h < config.autoReview.hours[1]; };

/** Launch review sessions for new PRs. `start(pr)` launches one and resolves when it's started. `force` = manual check. */
export async function runAutoReview(start, { force = false } = {}) {
  const a = config.autoReview;
  if (!a.enabled || (!force && !inHours())) return [];
  // Drafts too, so the radar shows them; they're only reviewed once ready.
  const prs = watchedPrs().filter((pr) => !pr.is_draft);
  let s = kv.get('autoReview');
  if (!s) {
    s = { since: new Date().toISOString(), done: prs.map(key), baseline: prs.map(key) };
    kv.set('autoReview', s);
    logEvent('auto-review', `Auto-review activé — ${prs.length} PR déjà ouvertes ignorées (baseline)`);
    return [];
  }
  s.baseline ??= s.done;
  // Per repo, same rule: a repo whose radar just came on (added, or switched back on) has its
  // open PRs baselined on its first synced check, never reviewed as a backlog. Pre-v2 state = mobile only.
  const synced = kv.get('repoSync') ?? {};
  const radarOn = config.repos.filter((r) => r.radar).map((r) => r.slug);
  const known = (s.repos ?? [config.repos[0].slug]).filter((slug) => radarOn.includes(slug));
  const newRepos = radarOn.filter((slug) => !known.includes(slug) && synced[slug]?.at);
  if (newRepos.length) {
    const keys = prs.filter((pr) => newRepos.includes(pr.repo)).map(key);
    s = { ...s, repos: [...known, ...newRepos], done: [...new Set([...s.done, ...keys])], baseline: [...new Set([...s.baseline, ...keys])] };
    logEvent('auto-review', `Radar activé sur ${newRepos.join(', ')} — ${keys.length} PR déjà ouvertes ignorées (baseline)`);
  } else s = { ...s, repos: known };
  kv.set('autoReview', s);
  const done = new Set(s.done);
  const running = db.prepare("SELECT COUNT(*) n FROM sessions WHERE chore = 'auto-review' AND state IN ('starting','running','working','busy','blocked')").get().n;
  const fresh = prs.filter((pr) => s.repos.includes(pr.repo) && !done.has(key(pr)) && !pr.my_review);
  const todo = fresh.slice(0, Math.max(0, a.maxConcurrent - running));
  s = { ...s, lastCheck: new Date().toISOString() };
  kv.set('autoReview', s);
  logEvent('auto-check', (force ? 'Check manuel · ' : '') + (fresh.length
    ? `${prs.length} PR surveillées · ${fresh.length} nouvelle(s) · ${todo.length} lancée(s)${fresh.length > todo.length ? ` · ${fresh.length - todo.length} en file (max ${a.maxConcurrent} en parallèle)` : ''}`
    : `${prs.length} PR surveillées · rien de nouveau`));
  const started = [];
  for (const pr of todo) {
    done.add(key(pr)); // before launching: a crash mid-launch must not loop on the same PR
    kv.set('autoReview', { ...s, done: [...done] });
    try {
      const id = await start(pr);
      started.push(pr.number);
      logEvent('auto-launch', `Brutal review lancée sur #${pr.number} « ${pr.title} » (@${pr.author}, ${pr.additions + pr.deletions} lignes)`, { repo: pr.repo, pr: pr.number, session: id });
    } catch (e) {
      logEvent('auto-error', `Échec du lancement sur #${pr.number} : ${e.message}`, { repo: pr.repo, pr: pr.number });
    }
  }
  return started;
}
