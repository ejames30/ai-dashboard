import { config } from './config.mjs';
import { db, upsert } from './db.mjs';
import { ghGraphql } from './sh.mjs';

const PR_FIELDS = `
  ... on PullRequest {
    number title url isDraft additions deletions changedFiles mergeable reviewDecision
    headRefName headRefOid baseRefName updatedAt
    author { login __typename }
    comments { totalCount }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    reviewThreads(first: 100) { nodes { isResolved } }
    reviews(last: 30) { nodes { author { login } state } }
  }`;

const search = async (q) =>
  (await ghGraphql(`query($q: String!) { search(query: $q, type: ISSUE, first: 50) { nodes { ${PR_FIELDS} } } }`, { q })).search.nodes;

export const ISSUE_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const issueKeyOf = (pr) => (pr.headRefName.match(ISSUE_KEY) ?? pr.title.match(ISSUE_KEY))?.[1] ?? null;

function row(repo, kind, pr, requested) {
  const mine = pr.reviews.nodes.filter((r) => r.author?.login === config.me);
  return {
    repo,
    number: pr.number,
    kind,
    title: pr.title,
    author: pr.author?.login,
    url: pr.url,
    head: pr.headRefName,
    base: pr.baseRefName,
    head_sha: pr.headRefOid,
    is_draft: pr.isDraft ? 1 : 0,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changedFiles,
    mergeable: pr.mergeable,
    review_decision: pr.reviewDecision,
    checks: pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    unresolved_threads: pr.reviewThreads.nodes.filter((t) => !t.isResolved).length,
    comments: pr.comments.totalCount,
    requested_me: requested.has(pr.number) ? 1 : 0,
    my_review: mine.at(-1)?.state ?? null,
    issue_key: issueKeyOf(pr),
    updated: pr.updatedAt,
    synced_at: new Date().toISOString(),
  };
}

export async function syncGithub() {
  for (const { slug } of config.repos) {
    const base = `repo:${slug} is:pr is:open`;
    // Teammates' drafts too: I want to see the mobile team's work in progress, not only what's ready.
    const [mine, others, teamDrafts, requested] = await Promise.all([
      search(`${base} author:@me`),
      search(`${base} -author:@me draft:false`),
      search(`${base} draft:true ${config.team.map((m) => `author:${m.login}`).join(' ')}`),
      search(`${base} review-requested:@me`),
    ]);
    const seen = new Set(others.map((p) => p.number));
    others.push(...teamDrafts.filter((p) => !seen.has(p.number)));
    const requestedSet = new Set(requested.map((p) => p.number));
    const rows = [
      ...mine.map((p) => row(slug, 'mine', p, requestedSet)),
      ...others.filter((p) => p.author?.__typename !== 'Bot').map((p) => row(slug, 'review', p, requestedSet)),
    ];
    db.exec('BEGIN');
    // Merged/closed PRs stay as history, flagged closed_at.
    const open = new Set(rows.map((r) => r.number));
    const now = new Date().toISOString();
    for (const { number } of db.prepare('SELECT number FROM prs WHERE repo = ? AND closed_at IS NULL').all(slug)) {
      if (!open.has(number)) db.prepare('UPDATE prs SET closed_at = ? WHERE repo = ? AND number = ?').run(now, slug, number);
    }
    rows.forEach((r) => upsert('prs', { ...r, closed_at: null }));
    db.exec('COMMIT');
  }
}
