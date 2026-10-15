#!/bin/zsh
# (Re)install the AI Dashboard launchd agent for whoever runs it. Idempotent.
# The plist is generated: this clone's path, the current Node 24, your home.
set -e
cd "${0:A:h}"
name=com.hivebrite.ai-dashboard
uid=$(id -u)
[[ -s $HOME/.nvm/nvm.sh ]] && source "$HOME/.nvm/nvm.sh" >/dev/null
node=$(command -v node) || { echo "node introuvable — lance ./setup.sh"; exit 1; }
(( $($node -p 'process.versions.node.split(".")[0]') >= 24 )) || { echo "Node 24+ requis ($node est $($node -v))"; exit 1; }

# The pre-team agent, if this Mac still has it.
launchctl bootout "gui/$uid/com.eric.ai-dashboard" 2>/dev/null && rm -f ~/Library/LaunchAgents/com.eric.ai-dashboard.plist || true

mkdir -p ~/Library/LaunchAgents ~/Library/Logs
plist=~/Library/LaunchAgents/$name.plist
cat > $plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$name</string>
  <key>ProgramArguments</key>
  <array><string>$node</string><string>--no-warnings=ExperimentalWarning</string><string>$PWD/server/index.mjs</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/ai-dashboard.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/ai-dashboard.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$uid/$name" 2>/dev/null || true
# bootout returns before the agent is gone; bootstrapping too early fails with "Input/output error".
for i in {1..20}; do launchctl print "gui/$uid/$name" >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap "gui/$uid" $plist
echo "AI Dashboard → http://localhost:${PORT:-4317}   (logs: ~/Library/Logs/ai-dashboard.log)"
