# AI Dashboard — mobile team

Each person's local dev cockpit on `http://localhost:4317` (127.0.0.1 only, zero dependencies, Node 24 + built-in SQLite). Inspired by a teammate's Task Goblin.

**Install (2 min, macOS):**

```bash
git clone https://github.com/ejames30/ai-dashboard.git ~/ai-dashboard && cd ~/ai-dashboard && ./setup.sh
```

Then follow the **Onboarding** page that opens (http://localhost:4317/#onboarding) — details in [Setup](#setup-anyone-on-the-mobile-team).

| Tab | What |
| --- | --- |
| **Tâches** | My Jira issues (when a token is set) ∪ my open PRs, joined by ticket key. Size, checks, conflicts, unresolved threads, review decision, and the **next action** — the first matching *chore*. |
| **Reviews** | Teammates' open PRs grouped by size (lines changed, not files). **AI review** runs a read-only Claude session and turns its findings into a **pending GitHub review** with inline comments — I edit and submit it myself. |
| **Jira** | Every ticket assigned to me, grouped by status, searchable and filterable. Launch Claude on any ticket (any chore, model, effort, prompt), or tick several and start **one grouped session** for them. |
| **Sessions** | Every session launched from here: state (Need input = `blocked`), **estimated cost** (transcript tokens × API list price, cache included), per-day cost and per-chore charts. Click a row to **read the conversation and reply** from the dashboard. macOS notification when a session needs me or finishes. |
| **Stack** | Detached checkout of any branch/PR in `~/HiveBrite/hivebrite-mobile-stack` + Metro. Refresh pulls new commits → hot reload. Never touches the main clone. |

## How sessions run

`claude --bg --remote-control <name> --model … --effort …` in a **worktree per task** under `<repo>/.claude/worktrees/` (inside the trusted repo, git-ignored). A branch already checked out in another worktree is reused there. State comes from `claude agents --json --all`; the claude.ai link from `claude logs`; tokens from the session transcript.

Replying from the dashboard: a running/blocked session is stopped, then `claude --bg --resume <session-id> -- "<message>"` — **with no other flag** — wakes the same session with its saved options. Passing flags starts a copy instead.

Per-ticket cost sums its sessions; a grouped session's cost is split evenly between its tickets. Costs are API-price estimates, not what an Enterprise seat is billed.

Jira: REST when a token is in the keychain (`ai-dashboard-jira`), otherwise a headless Haiku through the claude.ai Atlassian connector (~40 s, ~$0.25 per sync, every 2 h + the Sync button).

Chores (`server/chores.mjs`), first match wins: conflicts → failing checks → unresolved comments → self review (Fable) → draft ready for review → start ticket. The modal lets me change model, effort and prompt before launching. **+ Prompt libre** starts a session in a fresh worktree on master.

## Review safety

A teammate's diff is untrusted. The review session runs in `dontAsk` mode with only `Read/Grep/Glob`, `git diff/log/show/blame`, `gh pr view/diff` — no write, no post. It ends with a JSON block; the server creates the pending review.

## Setup (anyone on the mobile team)

```bash
git clone https://github.com/ejames30/ai-dashboard.git ~/ai-dashboard && cd ~/ai-dashboard
./setup.sh
```

`setup.sh` is guided and can be rerun any time. It:

1. installs what's missing (asks first): Node 24, `gh`, Claude Code, pnpm;
2. logs you into `gh` and `claude` if needed;
3. finds you in **`team.json`** by your GitHub login (Eric, Malek, Jérémie, Tobiasz, Thomas) and writes your **profile** to `~/.claude/pr-autoreview/profile.json`;
4. clones `Hivebrite/hivebrite-mobile` to `~/HiveBrite/hivebrite-mobile` if it isn't there;
5. installs the launchd service (`com.hivebrite.ai-dashboard`, KeepAlive) and opens **http://localhost:4317/#onboarding**.

The **Onboarding** page checks everything for real — tools logged in, repo access, the clone, and the **claude.ai connectors the dashboard calls (Atlassian, Slack)** via `claude mcp list` — and gives each missing step its fix: a link, or a command it opens in your terminal. A banner points there as long as a required step is missing. Rechecked hourly and on « Re-vérifier ».

Connector missing or « Needs authentication »: claude.ai → Settings → Connectors, or `claude` then `/mcp` → *claude.ai Atlassian* / *claude.ai Slack* → Authenticate.

### Your profile

`~/.claude/pr-autoreview/profile.json` — personal, never in the repo. After editing it, `./install.sh` restarts the service.

| Key | Default | What |
| --- | --- | --- |
| `login` | from setup | your GitHub login (must be in `team.json`) |
| `email` | from setup | your Atlassian email, for the Jira token |
| `autoReview` | `true` | the radar: post a brutal review on teammates' new PRs automatically (8h–20h). Every laptop posts its own, so a PR gets one review per teammate with it on |
| `slack` | `true` | Slack triage every 10 min on weekdays |
| `slackUserId` | — | your Slack ID (else the triage looks you up by name) |
| `repoPath` | `~/HiveBrite/hivebrite-mobile` | where your clone lives |

New teammate: add them to `team.json` (`login`, `name`, `firstName`), commit, they run `./setup.sh`.

### Jira token (optional, recommended)

Without it Jira goes through the Atlassian connector (~40 s, a few cents per sync). With it, sync is free and instant:

```bash
security add-generic-password -s ai-dashboard-jira -a <you>@hivebrite.com -w <token from id.atlassian.com>
```

Logs: `tail -f ~/Library/Logs/ai-dashboard.log`. Data: `~/.claude/pr-autoreview/ai-dashboard.db`. Repos, sizes, Jira JQL, Slack channels, stack command: `server/config.mjs`.
