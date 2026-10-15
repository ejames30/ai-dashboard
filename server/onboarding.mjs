import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE_PATH, TEAM, config, profile } from './config.mjs';
import { kv } from './db.mjs';
import { sh } from './sh.mjs';

// Onboarding: everything the dashboard needs on this laptop, checked for real (CLIs logged in,
// claude.ai connectors authenticated, repo cloned…). Each failed check carries its fix: a text,
// a link, and/or a command the dashboard opens in a terminal. Checks run at start, hourly, on demand.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LAUNCHD_LABEL = 'com.hivebrite.ai-dashboard';
const CONNECTORS_URL = 'https://claude.ai/settings/connectors';

// The claude.ai connectors the dashboard calls by tool name (mcp__claude_ai_<Name>__…).
const CONNECTORS = [
  { name: 'Atlassian', why: 'Jira sans token, plans d’epics, stand-up', required: true },
  { name: 'Slack', why: 'Slack filtré (tri des DMs, mentions, threads)', required: () => config.slack.enabled },
];

const quiet = (cmd, args, opts) => sh(cmd, args, { timeout: 30_000, ...opts }).then((out) => out.trim());
const ok = (detail) => ({ ok: true, detail });
const ko = (detail, fix) => ({ ok: false, detail, fix });

/** `claude mcp list` → { "claude.ai Atlassian": "Connected" | "Needs authentication" | "Failed …" }. ~40 s: it pings every server. */
async function mcpStatuses() {
  const out = await sh('claude', ['mcp', 'list'], { timeout: 180_000, cwd: config.dataDir });
  const map = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?): .* - [✔✘!] (.+)$/);
    if (m) map[m[1].trim()] = m[2].trim();
  }
  return map;
}

const CHECKS = [
  {
    key: 'profile', group: 'Toi', label: 'Profil', required: true,
    run: async () => {
      if (!profile.login) return ko(config.me ? `Pas encore de profil — deviné depuis gh : ${config.me}` : 'Pas de profil', { text: 'Lance le setup depuis le dossier du projet : il te demande qui tu es et écrit ton profil.', cmd: './setup.sh' });
      if (!TEAM.some((m) => m.login.toLowerCase() === profile.login.toLowerCase())) return ko(`${profile.login} n’est pas dans team.json`, { text: 'Ajoute-toi dans team.json (login GitHub, nom, prénom), puis relance ./setup.sh.' });
      return ok(`${config.name} · ${profile.login}${config.email ? ` · ${config.email}` : ''} — ${PROFILE_PATH.replace(process.env.HOME, '~')}`);
    },
  },
  {
    key: 'node', group: 'Outils', label: 'Node 24+', required: true,
    run: async () => (Number(process.versions.node.split('.')[0]) >= 24 ? ok(process.version)
      : ko(`${process.version} — node:sqlite demande Node 24`, { text: 'Installe Node 24 (nvm install 24) puis relance ./setup.sh pour repointer le service.', cmd: 'nvm install 24 && ./setup.sh' })),
  },
  {
    key: 'gh', group: 'Outils', label: 'GitHub CLI connecté', required: true,
    run: async () => {
      const login = await quiet('gh', ['api', 'user', '--jq', '.login']).catch(() => null);
      if (!login) return ko('gh absent ou non connecté', { text: 'Connecte gh à github.com (HTTPS, navigateur).', cmd: 'gh auth login -h github.com -p https -w' });
      if (config.me && login.toLowerCase() !== config.me.toLowerCase()) return ko(`gh est connecté en ${login}, ton profil dit ${config.me}`, { text: 'Change de compte gh ou relance ./setup.sh.', cmd: 'gh auth switch' });
      return ok(login);
    },
  },
  {
    key: 'repoAccess', group: 'Outils', label: 'Accès à hivebrite-mobile', required: true,
    run: async () => {
      const slug = config.repos[0].slug;
      const push = await quiet('gh', ['api', `repos/${slug}`, '--jq', '.permissions.push']).catch(() => null);
      return push === 'true' ? ok(`${slug} · écriture`) : push === 'false' ? ko(`${slug} · lecture seule`, { text: 'Il faut le droit d’écriture pour poster des reviews : demande l’accès à l’équipe.' })
        : ko(`${slug} inaccessible`, { text: 'Vérifie que ton compte gh est dans l’orga Hivebrite (SSO autorisé sur le token).', cmd: 'gh auth refresh -h github.com -s repo,read:org' });
    },
  },
  {
    key: 'claude', group: 'Outils', label: 'Claude Code connecté', required: true,
    run: async () => {
      const v = await quiet('claude', ['--version']).catch(() => null);
      if (!v) return ko('claude introuvable', { text: 'Installe Claude Code.', cmd: 'curl -fsSL https://claude.ai/install.sh | bash' });
      const st = await quiet('claude', ['auth', 'status']).then(JSON.parse).catch(() => ({}));
      return st.loggedIn ? ok(`${v.split(' ')[0]} · ${st.authMethod ?? 'connecté'}`) : ko(`${v.split(' ')[0]} · pas connecté`, { text: 'Connecte-toi avec ton compte claude.ai Hivebrite.', cmd: 'claude auth login' });
    },
  },
  {
    key: 'pnpm', group: 'Outils', label: 'pnpm', required: false,
    run: async () => {
      const v = await quiet('pnpm', ['--version']).catch(() => null);
      return v ? ok(v) : ko('absent — le Stack local et les sessions en ont besoin', { text: 'Active pnpm via corepack.', cmd: 'corepack enable pnpm' });
    },
  },
  {
    key: 'repo', group: 'Code', label: 'Clone hivebrite-mobile', required: true,
    run: async () => {
      const { path, slug } = config.repos[0];
      if (!existsSync(join(path, '.git'))) return ko(`rien dans ${path.replace(process.env.HOME, '~')}`, { text: 'Clone le repo à cet endroit (ou mets "repoPath" dans ton profil).', cmd: `mkdir -p ${JSON.stringify(dirname(path))} && gh repo clone ${slug} ${JSON.stringify(path)}` });
      return ok(path.replace(process.env.HOME, '~'));
    },
  },
  {
    key: 'brutal', group: 'Code', label: 'Commande /brutal-review', required: false,
    run: async () => {
      const f = join(config.repos[0].path, 'apps/mobile_app/.claude/commands/brutal-review.md');
      return existsSync(f) ? ok('apps/mobile_app/.claude/commands/brutal-review.md') : ko('introuvable — les reviews utiliseront une checklist générique', { text: 'Mets ton clone à jour (git pull sur master).' });
    },
  },
  {
    key: 'service', group: 'Optionnel', label: 'Service en arrière-plan', required: false,
    run: async () => {
      const on = await quiet('launchctl', ['print', `gui/${process.getuid()}/${LAUNCHD_LABEL}`]).then(() => true, () => false);
      return on ? ok(`${LAUNCHD_LABEL} · redémarre tout seul`) : ko('lancé à la main — il s’arrêtera avec le terminal', { text: 'Installe le service launchd (KeepAlive).', cmd: './install.sh' });
    },
  },
  {
    key: 'jiraToken', group: 'Optionnel', label: 'Token Jira', required: false,
    run: async () => {
      const has = await quiet('security', ['find-generic-password', '-s', config.jira.keychainService]).then(() => true, () => false);
      if (has && config.email) return ok('REST direct : sync gratuit et instantané');
      return ko(has ? 'token trouvé mais pas d’email dans ton profil' : 'absent — Jira passe par le connecteur Atlassian (~40 s, quelques centimes)', {
        text: `Crée un token sur id.atlassian.com, puis : security add-generic-password -s ${config.jira.keychainService} -a ${config.email ?? '<toi>@hivebrite.com'} -w <token>`,
        url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      });
    },
  },
  {
    key: 'warp', group: 'Optionnel', label: 'Warp', required: false,
    run: async () => (existsSync('/Applications/Warp.app') ? ok('les sessions s’ouvrent dans Warp') : ko('absent — Terminal.app sera utilisé', { url: 'https://www.warp.dev' })),
  },
];

async function connectorChecks() {
  let map;
  try { map = await mcpStatuses(); } catch (e) {
    return CONNECTORS.map((c) => ({ key: `mcp-${c.name}`, group: 'Connecteurs claude.ai', label: c.name, required: true, ok: false, detail: `claude mcp list a échoué : ${e.message.slice(0, 160)}` }));
  }
  return CONNECTORS.map((c) => {
    const status = map[`claude.ai ${c.name}`];
    const required = typeof c.required === 'function' ? c.required() : c.required;
    const base = { key: `mcp-${c.name}`, group: 'Connecteurs claude.ai', label: c.name, required, why: c.why };
    if (status === 'Connected') return { ...base, ok: true, detail: `connecté · ${c.why}` };
    return {
      ...base, ok: false,
      detail: status ? `${status} · sert à : ${c.why}` : `pas ajouté à ton compte · sert à : ${c.why}`,
      fix: status
        ? { text: `Dans le terminal qui s’ouvre, tape /mcp, choisis « claude.ai ${c.name} » puis Authenticate. Ou connecte-le depuis claude.ai → Paramètres → Connecteurs.`, cmd: 'claude', url: CONNECTORS_URL }
        : { text: `Ajoute le connecteur ${c.name} sur claude.ai (Paramètres → Connecteurs) avec ton compte Hivebrite, puis Re-vérifier.`, url: CONNECTORS_URL },
    };
  });
}

let flight = null;
/** Runs every check (the connector one takes ~40 s); concurrent callers share the run. */
export function checkOnboarding() {
  flight ??= (async () => {
    kv.set('onboarding', { ...(kv.get('onboarding') ?? {}), running: true });
    const [base, mcp] = await Promise.all([
      Promise.all(CHECKS.map(async ({ run, ...c }) => ({ ...c, ...(await run().catch((e) => ko(e.message.slice(0, 200)))) }))),
      connectorChecks(),
    ]);
    const checks = [...base, ...mcp];
    kv.set('onboarding', { at: new Date().toISOString(), running: false, checks, missing: checks.filter((c) => !c.ok && c.required).length });
  })().catch((e) => kv.set('onboarding', { ...(kv.get('onboarding') ?? {}), running: false, error: e.message })).finally(() => { flight = null; });
  return flight;
}

export const onboardingState = () => kv.get('onboarding') ?? { running: true, checks: [] };

/** The fix command of a check, opened in a terminal in the project folder. Only commands we wrote run. */
export function fixCommand(key) {
  const c = (kv.get('onboarding')?.checks ?? []).find((x) => x.key === key);
  return c?.fix?.cmd ? { cwd: ROOT, cmd: c.fix.cmd, title: `setup · ${c.label}` } : null;
}
