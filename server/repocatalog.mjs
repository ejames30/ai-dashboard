import { TEAM, config } from './config.mjs';
import { gh } from './sh.mjs';

// The Hivebrite repos you can add from the Repos page: every non-archived repo of the org you
// can see, ranked by how many PRs the team opened there in the last 60 days. ~10 s to build,
// cached 6 h; built on first open of the page, not at start.

const ORG = config.repos[0].slug.split('/')[0];
const TTL = 6 * 3_600_000;
let cache = null;
let flight = null;

async function teamActivity() {
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  const counts = new Map();
  await Promise.all(TEAM.map(async (m) => {
    const out = await gh(['search', 'prs', '--owner', ORG, '--author', m.login, '--created', `>=${since}`, '--limit', '300', '--json', 'repository', '--jq', '.[].repository.nameWithOwner']).catch(() => '');
    for (const slug of out.split('\n').filter(Boolean)) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }));
  return counts;
}

async function build() {
  const [list, counts] = await Promise.all([
    gh(['repo', 'list', ORG, '--limit', '1000', '--no-archived', '--json', 'nameWithOwner,description,pushedAt,primaryLanguage']).then(JSON.parse),
    teamActivity(),
  ]);
  const repos = list.map((r) => ({
    slug: r.nameWithOwner, description: r.description || '', language: r.primaryLanguage?.name ?? null, pushedAt: r.pushedAt,
    teamPrs: counts.get(r.nameWithOwner) ?? 0,
    generated: /^openapi-.*-sdk$/.test(r.nameWithOwner.split('/')[1]), // generated SDKs: hidden unless searched
  })).sort((a, b) => b.teamPrs - a.teamPrs || b.pushedAt.localeCompare(a.pushedAt));
  return { at: new Date().toISOString(), org: ORG, repos };
}

export function repoCatalog({ force = false } = {}) {
  if (!force && cache && Date.now() - new Date(cache.at) < TTL) return Promise.resolve(cache);
  flight ??= build().then((c) => (cache = c)).finally(() => { flight = null; });
  return flight;
}
