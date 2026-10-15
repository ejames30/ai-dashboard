#!/bin/zsh
# AI Dashboard — guided setup for anyone on the mobile team. Idempotent: rerun it any time.
#   1. tools: Node 24, gh, Claude Code, pnpm (installs what's missing, asks first)
#   2. logins: gh + claude
#   3. who you are (team.json, matched on your GitHub login) → ~/.claude/pr-autoreview/profile.json
#   4. the hivebrite-mobile clone
#   5. the always-on service (install.sh), then opens the Onboarding page, which checks
#      the claude.ai connectors (Atlassian, Slack) and walks you through what's left.
set -e
cd "${0:A:h}"
ROOT=$PWD
DATA=${AI_DASHBOARD_DATA:-$HOME/.claude/pr-autoreview}
PROFILE=$DATA/profile.json

bold() { print -P "%B$1%b"; }
ok()   { print -P "  %F{green}✓%f $1"; }
warn() { print -P "  %F{yellow}!%f $1"; }
fail() { print -P "  %F{red}✗%f $1"; exit 1; }
ask()  { local a; read "a?  $1 " ; print -r -- "${a:-$2}"; }
confirm() { local a; read "a?  $1 [Y/n] "; [[ -z $a || $a == [yYoO]* ]]; }
has()  { command -v "$1" >/dev/null 2>&1; }

[[ $(uname) == Darwin ]] || fail "macOS only (launchd, Keychain, notifications)."

bold "1/5 · Outils"
# Node 24 (node:sqlite). nvm first if the person uses it, then Homebrew.
[[ -s $HOME/.nvm/nvm.sh ]] && source "$HOME/.nvm/nvm.sh" >/dev/null
node_major() { has node && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if (( $(node_major) < 24 )); then
  if typeset -f nvm >/dev/null; then
    confirm "Node 24 manque — l'installer avec nvm ?" && nvm install 24 && nvm alias default 24
  elif has brew; then
    confirm "Node 24 manque — l'installer avec Homebrew (node@24) ?" && brew install node@24 && export PATH="$(brew --prefix node@24)/bin:$PATH"
  fi
  (( $(node_major) >= 24 )) || fail "Node 24+ requis : installe-le (https://nodejs.org) puis relance ./setup.sh"
fi
ok "node $(node -v)"

if ! has gh; then
  has brew || fail "Installe Homebrew (https://brew.sh) ou gh (https://cli.github.com), puis relance."
  confirm "gh (GitHub CLI) manque — l'installer avec Homebrew ?" && brew install gh
fi
ok "gh $(gh --version | head -1 | awk '{print $3}')"

if ! has claude; then
  confirm "Claude Code manque — l'installer ?" && curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
  has claude || fail "Claude Code introuvable après installation : ouvre un nouveau terminal et relance."
fi
ok "claude $(claude --version | awk '{print $1}')"

if ! has pnpm; then
  corepack enable pnpm 2>/dev/null || npm install -g pnpm >/dev/null
fi
has pnpm && ok "pnpm $(pnpm --version)" || warn "pnpm absent (Stack local) : npm install -g pnpm"

bold "2/5 · Connexions"
if ! gh api user --jq .login >/dev/null 2>&1; then
  warn "gh n'est pas connecté — on le fait maintenant (navigateur)."
  gh auth login -h github.com -p https -w
fi
LOGIN=$(gh api user --jq .login)
ok "GitHub : $LOGIN"
if ! claude auth status 2>/dev/null | grep -q '"loggedIn": true'; then
  warn "Claude Code n'est pas connecté — connecte-toi avec ton compte claude.ai Hivebrite."
  claude auth login
fi
ok "Claude Code connecté"

bold "3/5 · Qui es-tu ?"
# Match the GitHub login against team.json; otherwise pick from the list.
MEMBER=$(node -e '
  const t = require("./team.json").members, l = process.argv[1].toLowerCase();
  const m = t.find((x) => x.login.toLowerCase() === l); if (m) console.log(m.login);' "$LOGIN")
if [[ -z $MEMBER ]]; then
  warn "$LOGIN n'est pas dans team.json. Qui es-tu ?"
  node -e 'require("./team.json").members.forEach((m, i) => console.log(`    ${i + 1}. ${m.name} (${m.login})`))'
  N=$(ask "Numéro :")
  MEMBER=$(node -e 'console.log(require("./team.json").members[Number(process.argv[1]) - 1]?.login ?? "")' "$N")
  [[ -n $MEMBER ]] || fail "Ajoute-toi dans team.json (login, name, firstName) puis relance."
  [[ ${MEMBER:l} == ${LOGIN:l} ]] || warn "gh est connecté en $LOGIN mais tu es $MEMBER : les PR « à moi » seront celles de $LOGIN."
fi
NAME=$(node -e 'console.log(require("./team.json").members.find((m) => m.login === process.argv[1]).name)' "$MEMBER")
ok "$NAME ($MEMBER)"

mkdir -p "$DATA"
OLD_EMAIL=$(node -e 'try { console.log(require(process.argv[1]).email ?? "") } catch { console.log("") }' "$PROFILE")
GIT_EMAIL=$(git config --global user.email 2>/dev/null || true)
DEFAULT_EMAIL=$OLD_EMAIL
[[ -z $DEFAULT_EMAIL && $GIT_EMAIL == *@hivebrite.com ]] && DEFAULT_EMAIL=$GIT_EMAIL
EMAIL=$(ask "Ton email Hivebrite (Atlassian) [${DEFAULT_EMAIL:-aucun}] :" "$DEFAULT_EMAIL")

bold "4/5 · Le repo hivebrite-mobile"
OLD_REPO=$(node -e 'try { console.log(require(process.argv[1]).repoPath ?? "") } catch { console.log("") }' "$PROFILE")
REPO=${OLD_REPO:-$HOME/HiveBrite/hivebrite-mobile}
if [[ ! -d $REPO/.git ]]; then
  REPO=$(ask "Où est (ou sera) ton clone ? [$REPO]" "$REPO")
  REPO=${REPO/#\~/$HOME}
  if [[ ! -d $REPO/.git ]] && confirm "Pas de clone dans $REPO — cloner Hivebrite/hivebrite-mobile ?"; then
    mkdir -p "${REPO:h}" && gh repo clone Hivebrite/hivebrite-mobile "$REPO"
  fi
fi
[[ -d $REPO/.git ]] && ok "$REPO" || warn "pas de clone : l'Onboarding te le rappellera"

# Profile: keep whatever the person already set (autoReview, slack…), update the rest.
node -e '
  const fs = require("fs"), [file, login, email, repo, home] = process.argv.slice(1);
  let p = {}; try { p = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  p.login = login;
  if (email) p.email = email; else delete p.email;
  if (repo !== `${home}/HiveBrite/hivebrite-mobile`) p.repoPath = repo; else delete p.repoPath;
  // v2: the radar is on for everyone; v1 setups wrote autoReview: false for all but Eric.
  if (!p.setupVersion && p.autoReview === false) delete p.autoReview;
  p.setupVersion = 2;
  p.autoReview ??= true;
  p.slack ??= true;
  fs.writeFileSync(file, JSON.stringify(p, null, 2) + "\n");' "$PROFILE" "$MEMBER" "$EMAIL" "$REPO" "$HOME"
ok "profil → ${PROFILE/#$HOME/~}"

bold "5/5 · Service"
./install.sh
for i in {1..30}; do curl -fs -o /dev/null http://localhost:${PORT:-4317}/api/state && break; sleep 1; done
open "http://localhost:${PORT:-4317}/#onboarding"
print
bold "C'est parti 🎉  La page Onboarding vient de s'ouvrir : elle vérifie tes connecteurs claude.ai"
print "  (Atlassian, Slack) et te donne le correctif pour chaque étape qui manque."
