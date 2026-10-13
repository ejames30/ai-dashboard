# Eric's AI Dashboard

Local dev cockpit on `http://localhost:4317` (127.0.0.1 only, zero dependencies, Node 24 + built-in SQLite). Inspired by a teammate's Task Goblin.

| Tab | What |
| --- | --- |
| **Tâches** | My Jira issues (when a token is set) ∪ my open PRs, joined by ticket key. Size, checks, conflicts, unresolved threads, review decision, and the **next action** — the first matching *chore*. |
| **Reviews** | Teammates' open PRs grouped by size (lines changed, not files). **AI review** runs a read-only Claude session and turns its findings into a **pending GitHub review** with inline comments — I edit and submit it myself. |
| **Sessions** | Every session launched from here: state (Need input = `blocked`), claude.ai link, model/effort, tokens, duration, per-day and per-chore charts. |
| **Stack** | Detached checkout of any branch/PR in `~/HiveBrite/hivebrite-mobile-stack` + Metro. Refresh pulls new commits → hot reload. Never touches the main clone. |

## How sessions run

`claude --bg --remote-control <name> --model … --effort …` in a **worktree per task** under `<repo>/.claude/worktrees/` (inside the trusted repo, git-ignored). A branch already checked out in another worktree is reused there. State comes from `claude agents --json --all`; the claude.ai link from `claude logs`; tokens from the session transcript.

Chores (`server/chores.mjs`), first match wins: conflicts → failing checks → unresolved comments → self review (Fable) → draft ready for review → start ticket. The modal lets me change model, effort and prompt before launching. **+ Prompt libre** starts a session in a fresh worktree on master.

## Review safety

A teammate's diff is untrusted. The review session runs in `dontAsk` mode with only `Read/Grep/Glob`, `git diff/log/show/blame`, `gh pr view/diff` — no write, no post. It ends with a JSON block; the server creates the pending review.

## Setup

```bash
./install.sh                     # (re)load the launchd agent com.eric.ai-dashboard (KeepAlive)
tail -f ~/Library/Logs/ai-dashboard.log
# Jira (optional): token from id.atlassian.com, then
security add-generic-password -s ai-dashboard-jira -a eric@hivebrite.com -w <token>
```

Data: `~/.claude/pr-autoreview/ai-dashboard.db`. Repos, sizes, Jira JQL, stack command: `server/config.mjs`.
