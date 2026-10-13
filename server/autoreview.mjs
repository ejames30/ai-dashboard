import { config } from './config.mjs';
import { db, kv } from './db.mjs';

// Auto brutal review: every sync, each NEW ready-for-review PR from the listed teammates
// gets one read-only review session; when it's done the result is POSTED on the PR
// (onReviewDone, chore 'auto-review') — no draft step, by design.
//
// "New" = not open yet when auto-review was first switched on: the baseline is the set of
// PRs open at that moment, so turning it on doesn't spray reviews over the whole backlog.
// Each PR is reviewed once; a draft is picked up when it's marked ready.

const key = (pr) => `${pr.repo}#${pr.number}`;

export function autoReviewState() {
  const a = config.autoReview;
  const s = kv.get('autoReview') ?? {};
  return { enabled: a.enabled, authors: a.authors, since: s.since ?? null, reviewed: (s.done ?? []).length };
}

/** Launch review sessions for new PRs. `start(pr)` launches one and resolves when it's started. */
export async function runAutoReview(start) {
  const a = config.autoReview;
  if (!a.enabled) return [];
  const prs = db.prepare(`SELECT * FROM prs WHERE kind = 'review' AND is_draft = 0 AND author IN (${a.authors.map(() => '?').join(',')})`).all(...a.authors);
  let s = kv.get('autoReview');
  if (!s) {
    s = { since: new Date().toISOString(), done: prs.map(key) };
    kv.set('autoReview', s);
    return [];
  }
  const done = new Set(s.done);
  const running = db.prepare("SELECT COUNT(*) n FROM sessions WHERE chore = 'auto-review' AND state IN ('starting','running','working','busy','blocked')").get().n;
  const todo = prs.filter((pr) => !done.has(key(pr)) && !pr.my_review).slice(0, Math.max(0, a.maxConcurrent - running));
  const started = [];
  for (const pr of todo) {
    done.add(key(pr)); // before launching: a crash mid-launch must not loop on the same PR
    kv.set('autoReview', { ...s, done: [...done] });
    try { await start(pr); started.push(pr.number); }
    catch (e) { console.error(`auto-review #${pr.number}`, e.message); }
  }
  return started;
}
