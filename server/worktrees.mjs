import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './sh.mjs';

// One worktree per task, under <repo>/.claude/worktrees/ — Claude trusts it (it's inside
// the trusted repo) and git ignores it. A branch already checked out elsewhere (one of my
// hand-made wt-* folders) is reused where it is instead of fighting git's branch lock.

const safe = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '-');
const wtDir = (repo, name) => join(repo.path, '.claude/worktrees', safe(name));

async function worktrees(repo) {
  const out = await git(repo.path, ['worktree', 'list', '--porcelain']);
  return out.split('\n\n').filter(Boolean).map((block) => ({
    path: block.match(/^worktree (.+)$/m)?.[1],
    branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null,
  }));
}

const localBranchExists = async (repo, branch) =>
  git(repo.path, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);

/** Worktree for one of my tasks: on its PR branch, or detached on origin/<base> when there's no PR yet. */
export async function taskWorktree(repo, task) {
  if (task.pr) {
    const branch = task.pr.head;
    const existing = (await worktrees(repo)).find((w) => w.branch === branch);
    if (existing) return existing.path;
    await git(repo.path, ['fetch', '--quiet', 'origin', branch]);
    const dir = wtDir(repo, task.key);
    if (await localBranchExists(repo, branch)) await git(repo.path, ['worktree', 'add', '--quiet', dir, branch]);
    else await git(repo.path, ['worktree', 'add', '--quiet', '--track', '-b', branch, dir, `origin/${branch}`]);
    return dir;
  }
  const dir = wtDir(repo, task.key);
  if (existsSync(dir)) return dir;
  await git(repo.path, ['fetch', '--quiet', 'origin', repo.base]);
  await git(repo.path, ['worktree', 'add', '--quiet', '--detach', dir, `origin/${repo.base}`]);
  return dir;
}

/** Detached checkout of a teammate's PR head, refreshed to its latest commit. */
export async function reviewWorktree(repo, pr) {
  const ref = `refs/ai-dashboard/pr-${pr.number}`;
  await git(repo.path, ['fetch', '--quiet', '--force', 'origin', pr.base, `pull/${pr.number}/head:${ref}`]);
  const dir = wtDir(repo, `review-${pr.number}`);
  if (existsSync(dir)) await git(dir, ['checkout', '--quiet', '--detach', '--force', ref]);
  else await git(repo.path, ['worktree', 'add', '--quiet', '--detach', dir, ref]);
  return dir;
}

/** Fresh detached worktree on origin/<base>: a free-form prompt, or a multi-ticket session. */
export async function scratchWorktree(repo, prefix = 'custom') {
  const dir = wtDir(repo, `${prefix}-${Date.now()}`);
  await git(repo.path, ['fetch', '--quiet', 'origin', repo.base]);
  await git(repo.path, ['worktree', 'add', '--quiet', '--detach', dir, `origin/${repo.base}`]);
  return dir;
}
