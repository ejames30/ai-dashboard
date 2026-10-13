#!/bin/zsh
# (Re)install both launchd agents from this repo. Idempotent.
set -e
cd "${0:A:h}"
for name in com.eric.pr-autoreview com.eric.pr-autoreview-dashboard; do
  launchctl bootout "gui/$(id -u)/$name" 2>/dev/null || true
  cp "launchd/$name.plist" ~/Library/LaunchAgents/
  launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/$name.plist
  echo "loaded $name"
done
echo "dashboard → http://localhost:4317"
