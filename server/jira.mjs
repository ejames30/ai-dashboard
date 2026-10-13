import { config } from './config.mjs';
import { db, kv, upsert } from './db.mjs';
import { sh } from './sh.mjs';

// Two ways to read my Jira issues:
//  - REST with an API token from the keychain: instant, used whenever a token exists;
//  - otherwise a headless Haiku through the claude.ai Atlassian connector: no token to
//    manage, ~40s and a few cents, so it runs on its own slower cadence.

let token; // cached once looked up; null = looked, none

async function getToken() {
  if (token !== undefined) return token;
  try {
    token = (await sh('security', ['find-generic-password', '-s', config.jira.keychainService, '-w'])).trim() || null;
  } catch {
    token = null;
  }
  return token;
}

export const resetJiraToken = () => { token = undefined; };
export const jiraSource = async () => ((await getToken()) ? 'token' : 'mcp');

async function viaRest(t) {
  const auth = Buffer.from(`${config.email}:${t}`).toString('base64');
  const res = await fetch(`${config.jira.site}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jql: config.jira.jql, maxResults: 200, fields: ['summary', 'status', 'issuetype', 'priority', 'updated'] }),
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).issues.map((i) => ({
    key: i.key,
    summary: i.fields.summary,
    status: i.fields.status?.name,
    status_category: i.fields.status?.statusCategory?.key,
    type: i.fields.issuetype?.name,
    priority: i.fields.priority?.name,
    updated: i.fields.updated,
  }));
}

const MCP_TOOLS = ['mcp__claude_ai_Atlassian__getAccessibleAtlassianResources', 'mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql'];

async function viaMcp() {
  const prompt = `Use the Atlassian tools: get the cloudId for ${new URL(config.jira.site).host}, then search JQL "${config.jira.jql}" with fields summary,status,issuetype,priority,updated, maxResults 200 (page through if there are more).
Output ONLY a JSON array, no prose, no fences: [{"key","summary","status","status_category","type","priority","updated"}]. status_category is the status category key (new / indeterminate / done).`;
  const out = await sh('claude', ['-p', '--model', 'haiku', '--output-format', 'json', '--permission-mode', 'dontAsk', '--allowedTools', ...MCP_TOOLS, '--', prompt], {
    cwd: config.dataDir, input: '', timeout: 240_000,
  });
  const result = JSON.parse(out);
  if (result.is_error) throw new Error(`Atlassian connector: ${String(result.result).slice(0, 200)}`);
  const text = String(result.result).trim();
  const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  const issues = JSON.parse(json);
  if (!Array.isArray(issues)) throw new Error('Atlassian connector returned no array');
  return { issues, cost: result.total_cost_usd ?? 0 };
}

let running = false;

/** Sync Jira. With no token, the MCP path only runs when `force` or when the last MCP sync is older than mcpEveryMs. */
export async function syncJira({ force = false } = {}) {
  if (running) return { skipped: 'already running' };
  const t = await getToken();
  const last = kv.get('jira') ?? {};
  if (!t && !force && last.at && Date.now() - new Date(last.at) < config.jira.mcpEveryMs) return { skipped: 'fresh' };
  running = true;
  kv.set('jira', { ...last, running: true });
  try {
    const { issues, cost = 0 } = t ? { issues: await viaRest(t) } : await viaMcp();
    db.exec('BEGIN');
    db.exec('DELETE FROM issues');
    const now = new Date().toISOString();
    for (const i of issues) {
      if (!i.key) continue;
      upsert('issues', {
        key: i.key, summary: i.summary, status: i.status, status_category: i.status_category,
        type: i.type, priority: i.priority, url: `${config.jira.site}/browse/${i.key}`, updated: i.updated, synced_at: now,
      });
    }
    db.exec('COMMIT');
    kv.set('jira', { at: now, source: t ? 'token' : 'mcp', count: issues.length, cost, error: null, running: false });
    return { count: issues.length };
  } catch (e) {
    kv.set('jira', { ...last, error: e.message, running: false });
    throw e;
  } finally {
    running = false;
  }
}
