import { existsSync, readFileSync } from 'node:fs';
import { config } from './config.mjs';
import { bump, db, kv, upsert } from './db.mjs';
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

const FIELDS = ['summary', 'status', 'issuetype', 'priority', 'updated', 'parent'];
const toRow = (i) => ({
  key: i.key,
  summary: i.fields.summary,
  status: i.fields.status?.name,
  status_category: i.fields.status?.statusCategory?.key,
  type: i.fields.issuetype?.name,
  priority: i.fields.priority?.name,
  updated: i.fields.updated,
  parent_key: i.fields.parent?.key ?? null,
  parent_summary: i.fields.parent?.fields?.summary ?? null,
});

async function search(t, jql) {
  const auth = Buffer.from(`${config.email}:${t}`).toString('base64');
  const res = await fetch(`${config.jira.site}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jql, maxResults: 200, fields: FIELDS }),
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).issues.map(toRow);
}

const viaRest = async (t) => ({ issues: await search(t, config.jira.jql), epics: await search(t, config.jira.epicJql) });

const MCP_TOOLS = ['mcp__claude_ai_Atlassian__getAccessibleAtlassianResources', 'mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql'];

// The model only drives the tool call; the issues are read straight from the raw tool
// result (which Claude Code writes to a file when it's big). Having Haiku re-type ~200
// issues as JSON was slow, ~$0.30, and broke whenever the answer got truncated.
let cloudId = null;

async function mcpPage(jql, cursor) {
  const prompt = `${cloudId ? `Atlassian cloudId is ${cloudId}.` : `Get the Atlassian cloudId for ${new URL(config.jira.site).host}.`} Then make exactly ONE searchJiraIssuesUsingJql call with jql ${JSON.stringify(jql)}, fields ${JSON.stringify(FIELDS)}, maxResults 100${cursor ? `, nextPageToken ${JSON.stringify(cursor)}` : ''}. Don't read or summarise the result. Reply only "ok".`;
  const out = await sh('claude', ['-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--allowedTools', ...MCP_TOOLS, '--', prompt], {
    cwd: config.dataDir, input: '', timeout: 240_000,
  });
  const events = out.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const calls = new Set();
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    for (const b of e.message?.content ?? []) {
      if (b.type !== 'tool_use' || !b.input?.jql) continue;
      calls.add(b.id);
      cloudId ??= b.input.cloudId;
    }
  }
  const result = events.find((e) => e.type === 'result') ?? {};
  for (const e of events) {
    if (e.type !== 'user') continue;
    for (const b of e.message?.content ?? []) {
      if (b.type !== 'tool_result' || !calls.has(b.tool_use_id)) continue;
      let text = Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join('') : String(b.content ?? '');
      const saved = text.match(/saved to (\/\S+?\.txt)/)?.[1];
      if (saved && existsSync(saved)) text = readFileSync(saved, 'utf8');
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`Atlassian connector: ${text.slice(0, 200)}`); }
      const page = data.issues ?? {};
      return {
        rows: (page.nodes ?? []).filter((n) => n?.key && n.fields).map(toRow),
        next: page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null,
        cost: result.total_cost_usd ?? 0,
      };
    }
  }
  throw new Error(`Atlassian connector: no search result${result.is_error ? ` (${String(result.result).slice(0, 160)})` : ''}`);
}

async function mcpSearch(jql) {
  const rows = [];
  let cost = 0, cursor = null;
  for (let i = 0; i < 5; i++) {
    const p = await mcpPage(jql, cursor);
    rows.push(...p.rows); cost += p.cost; cursor = p.next;
    if (!cursor) break;
  }
  return { rows, cost };
}

async function viaMcp() {
  const a = await mcpSearch(config.jira.jql);
  const b = await mcpSearch(config.jira.epicJql).catch((e) => { console.error('jira epics', e.message); return { rows: [], cost: 0 }; });
  if (!a.rows.length) throw new Error('Atlassian connector returned no issues');
  return { issues: a.rows, epics: b.rows, cost: a.cost + b.cost };
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
    const { issues, epics = [], cost = 0 } = t ? await viaRest(t) : await viaMcp();
    db.exec('BEGIN');
    db.exec('DELETE FROM issues');
    const now = new Date().toISOString();
    for (const i of issues) {
      if (!i.key) continue;
      upsert('issues', {
        key: i.key, summary: i.summary, status: i.status, status_category: i.status_category,
        type: i.type, priority: i.priority, url: `${config.jira.site}/browse/${i.key}`, updated: i.updated, synced_at: now,
        parent_key: i.parent_key ?? null, parent_summary: i.parent_summary ?? null,
      });
    }
    db.exec('DELETE FROM epics');
    const parents = issues.filter((i) => i.parent_key).map((i) => ({ key: i.parent_key, summary: i.parent_summary }));
    for (const e of [...parents, ...epics]) {
      if (!e.key) continue;
      upsert('epics', {
        key: e.key, summary: e.summary, status: e.status ?? null, status_category: e.status_category ?? null,
        url: `${config.jira.site}/browse/${e.key}`, updated: e.updated ?? null, synced_at: now,
      });
    }
    db.exec('COMMIT');
    bump('issues'); bump('epics');
    kv.set('jira', { at: now, source: t ? 'token' : 'mcp', count: issues.length, epics: epics.length, cost, error: null, running: false });
    return { count: issues.length };
  } catch (e) {
    kv.set('jira', { ...last, error: e.message, running: false });
    throw e;
  } finally {
    running = false;
  }
}
