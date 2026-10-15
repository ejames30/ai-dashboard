import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const dataDir = process.env.AI_DASHBOARD_DATA ?? join(HOME, '.claude/pr-autoreview');
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

// Shared: the team roster (team.json, in the repo). Personal: profile.json, written by setup.sh.
export const TEAM = readJson(new URL('../team.json', import.meta.url)).members;
export const PROFILE_PATH = join(dataDir, 'profile.json');
export const profile = readJson(PROFILE_PATH) ?? {};
// No profile yet (setup.sh not run): guess who I am from gh, so the dashboard still starts.
const ghLogin = () => { try { return execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: 10_000 }).trim(); } catch { return null; } };
const login = profile.login ?? ghLogin();
const member = TEAM.find((m) => m.login.toLowerCase() === login?.toLowerCase()) ?? {};
const teammates = TEAM.filter((m) => m !== member);

export const config = {
  port: Number(process.env.PORT ?? 4317),
  me: login,
  name: profile.name ?? member.name ?? login,
  firstName: profile.firstName ?? member.firstName ?? login,
  email: profile.email ?? null,
  dataDir,

  // Every repo the cockpit tracks. `path` is the main clone; task worktrees live in
  // <path>/.claude/worktrees/<name> — inside the repo, so Claude already trusts them
  // and git already ignores them.
  repos: [
    {
      slug: 'Hivebrite/hivebrite-mobile',
      path: profile.repoPath ?? join(HOME, 'HiveBrite/hivebrite-mobile'),
      base: 'master',
      // Where the local stack runs: a detached checkout, never the main clone, so
      // switching what the simulator shows never touches a branch you're working on.
      stack: {
        path: `${profile.repoPath ?? join(HOME, 'HiveBrite/hivebrite-mobile')}-stack`,
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
    //   security add-generic-password -s ai-dashboard-jira -a <you>@hivebrite.com -w <token>
    keychainService: 'ai-dashboard-jira',
    jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
    // Epics offered on the Epics page (on top of my tickets' parents).
    epicJql: 'issuetype = Epic AND project in (MO, MOB) AND statusCategory != Done ORDER BY updated DESC',
    // Without a token, issues come through a headless Claude + the Atlassian connector: slower and not free, so less often.
    mcpEveryMs: 30 * 60_000, // ~3 headless Haiku runs ≈ $0.02 per sync; a token makes it free and instant
  },

  // My teammates (team.json minus me): their PRs lead the "PR de l'équipe" page (drafts included).
  team: teammates.map((m) => ({ login: m.login, name: m.firstName })),

  // New ready PRs from these teammates get a brutal review POSTED automatically (see autoreview.mjs).
  // Off unless the profile turns it on: with it on everywhere, each PR would get one review per laptop.
  autoReview: {
    enabled: profile.autoReview === true,
    authors: teammates.map((m) => m.login),
    maxConcurrent: 3,
    hours: [8, 20], // automatic checks only from 8:00 to 20:00; outside, a manual check still works
  },

  // Slack triage through the claude.ai connector (read-only tools), weekdays 8h–20h, every 10 min.
  slack: {
    enabled: profile.slack !== false,
    me: profile.name ?? member.name ?? login,
    userId: profile.slackUserId ?? member.slackUserId ?? null, // null: the triage looks it up by name
    role: 'mobile engineer (React Native) at Hivebrite, mobile squad',
    groups: ['@mobile', '@mobile-team'],
    channels: ['#squad-mobile', '#squad-mobile-pr', '#mobile-app-testing-result', '#incidents', '#releases'],
    model: 'haiku', // "Analyse fine" in the UI runs it with sonnet
    everyMs: 10 * 60_000,
    hours: [8, 20], // Monday–Friday only; outside, "Trier" / ⟳ still works
  },

  // Fleet: every Claude Code session on this Mac touched in the last `days`.
  fleet: { days: 3 },

  // Innovation corner: fresh ideas every weekday from this time (after the stand-up).
  ideas: { at: [9, 30] },

  // Stand-up written automatically on weekdays at this hour, for the previous working day.
  standup: { hour: 9 },

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
