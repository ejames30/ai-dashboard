import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();

export const config = {
  port: Number(process.env.PORT ?? 4317),
  me: 'ejames30',
  email: 'eric@hivebrite.com',
  dataDir: process.env.GOBLIN_DATA ?? join(HOME, '.claude/pr-autoreview'),

  // Every repo the cockpit tracks. `path` is the main clone; task worktrees live in
  // <path>/.claude/worktrees/<name> — inside the repo, so Claude already trusts them
  // and git already ignores them.
  repos: [
    {
      slug: 'Hivebrite/hivebrite-mobile',
      path: join(HOME, 'HiveBrite/hivebrite-mobile'),
      base: 'master',
      // Where the local stack runs: a detached checkout, never the main clone, so
      // switching what the simulator shows never touches a branch you're working on.
      stack: {
        path: join(HOME, 'HiveBrite/hivebrite-mobile-stack'),
        cwd: 'apps/mobile_app',
        install: ['pnpm', ['install', '--frozen-lockfile']],
        start: ['pnpm', ['start']],
        port: 8081,
      },
    },
  ],

  jira: {
    site: 'https://hivebrite.atlassian.net',
    // API token from https://id.atlassian.com/manage-profile/security/api-tokens, stored with:
    //   security add-generic-password -s goblin-jira -a eric@hivebrite.com -w <token>
    keychainService: 'goblin-jira',
    jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
  },

  syncEveryMs: 3 * 60_000,
  sessionPollMs: 5_000,

  // Lines changed (additions + deletions) → size bucket. Lines, not files: many files
  // with a few lines each reviews faster than one file rewritten.
  sizes: [
    { key: 'S', max: 100 },
    { key: 'M', max: 400 },
    { key: 'L', max: 1000 },
    { key: 'XL', max: Infinity },
  ],
};

export const sizeOf = (lines) => config.sizes.find((s) => lines <= s.max).key;
export const repoBySlug = (slug) => config.repos.find((r) => r.slug === slug);
