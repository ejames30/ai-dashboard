#!/bin/zsh
# (Re)install the Goblin launchd agent from this repo. Idempotent.
set -e
cd "${0:A:h}"
name=com.eric.goblin
launchctl bootout "gui/$(id -u)/$name" 2>/dev/null || true
cp "launchd/$name.plist" ~/Library/LaunchAgents/
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/$name.plist
echo "goblin → http://localhost:4317   (logs: ~/Library/Logs/goblin.log)"
