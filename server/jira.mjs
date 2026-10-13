import { config } from './config.mjs';
import { db, upsert } from './db.mjs';
import { sh } from './sh.mjs';

let token; // cached once found; null = looked and none

async function getToken() {
  if (token !== undefined) return token;
  try {
    token = (await sh('security', ['find-generic-password', '-s', config.jira.keychainService, '-w'])).trim() || null;
  } catch {
    token = null;
  }
  return token;
}

export const jiraConfigured = async () => !!(await getToken());
export const resetJiraToken = () => { token = undefined; };

export async function syncJira() {
  const t = await getToken();
  if (!t) return { skipped: 'no token' };
  const auth = Buffer.from(`${config.email}:${t}`).toString('base64');
  const res = await fetch(`${config.jira.site}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jql: config.jira.jql, maxResults: 100, fields: ['summary', 'status', 'issuetype', 'priority', 'updated'] }),
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const { issues } = await res.json();
  db.exec('BEGIN');
  db.exec('DELETE FROM issues');
  for (const i of issues) {
    upsert('issues', {
      key: i.key,
      summary: i.fields.summary,
      status: i.fields.status?.name,
      status_category: i.fields.status?.statusCategory?.key,
      type: i.fields.issuetype?.name,
      priority: i.fields.priority?.name,
      url: `${config.jira.site}/browse/${i.key}`,
      updated: i.fields.updated,
      synced_at: new Date().toISOString(),
    });
  }
  db.exec('COMMIT');
  return { count: issues.length };
}
