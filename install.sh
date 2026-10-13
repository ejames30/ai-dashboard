#!/bin/zsh
# (Re)install the AI Dashboard launchd agent from this repo. Idempotent.
set -e
cd "${0:A:h}"
name=com.eric.ai-dashboard
launchctl bootout "gui/$(id -u)/$name" 2>/dev/null || true
cp "launchd/$name.plist" ~/Library/LaunchAgents/
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/$name.plist
echo "Eric's AI Dashboard → http://localhost:4317   (logs: ~/Library/Logs/ai-dashboard.log)"
