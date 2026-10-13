# pr-autoreview

Auto **brutal review** of every new teammate PR on `Hivebrite/hivebrite-mobile`, posted as a PR comment — plus a live local dashboard.

- `bin/run.sh` — polled by launchd every 5 min. Picks open, non-draft, non-bot PRs not authored by `ejames30` and not in `seen.txt`, checks each out in a detached worktree (`~/HiveBrite/pr-review-wt/pr-N`), runs headless `claude -p` with **read-only** tools against `apps/mobile_app/.claude/commands/brutal-review.md`, posts the result with `gh pr comment`, removes the worktree.
- `dashboard/` — zero-dependency Node server on `http://localhost:4317` (127.0.0.1 only). Live via SSE: each review's tool calls as Claude makes them, the final comment, cost/duration, poll history, and Run now / Pause / Resume buttons.

## Data (`~/.claude/pr-autoreview/`)

| File | What |
| --- | --- |
| `events.jsonl` | one line per step: `poll_start`, `review_start`, `review_done`, `posted`, `dry_run`, `review_failed`, `poll_end` |
| `runs/<poll>-pr-<N>.stream.jsonl` | raw `claude --output-format stream-json` of one review |
| `runs/<poll>-pr-<N>.md` | the comment body |
| `seen.txt` | PR numbers already reviewed — delete a line to re-review |

## Commands

```bash
./install.sh                                          # (re)load both launchd agents
DRY_RUN=1 bin/run.sh 3541                             # review one PR, don't post (shows up in the dashboard)
tail -f ~/Library/Logs/pr-autoreview.log
launchctl bootout gui/$(id -u)/com.eric.pr-autoreview # stop polling (or the Pause button)
```

## Why Claude can't post

The diff is written by someone else and is untrusted (prompt injection). Claude gets `Read/Grep/Glob` + `git diff/log/show/blame` + `gh pr view/diff` only; the script does the posting.
