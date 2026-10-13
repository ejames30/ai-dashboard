import { config } from './config.mjs';
import { bump, db, kv, logEvent, upsert } from './db.mjs';
import { sh } from './sh.mjs';

// Slack, minus the noise: a headless Claude reads my DMs, mentions, threads and team
// channels through the claude.ai Slack connector (read-only tools only) and keeps what
// actually needs me. Items keep their status (new / done / snoozed) across syncs.

const READ_TOOLS = ['slack_search_public_and_private', 'slack_read_channel', 'slack_read_thread', 'slack_read_user_profile',
  'slack_search_users', 'slack_list_user_channels', 'slack_search_channels'].map((t) => `mcp__claude_ai_Slack__${t}`);

const contextLines = () => {
  const prs = db.prepare("SELECT number, title FROM prs WHERE kind = 'mine' AND closed_at IS NULL").all();
  const issues = db.prepare("SELECT key, summary FROM issues WHERE status_category = 'indeterminate'").all();
  return `My open PRs (hivebrite-mobile): ${prs.map((p) => `#${p.number} ${p.title}`).join(' | ').slice(0, 2500)}
My Jira tickets in progress: ${issues.map((i) => `${i.key} ${i.summary}`).join(' | ').slice(0, 2500)}`;
};

function prompt(sinceIso) {
  const c = config.slack;
  return `You triage Slack for ${c.me} (Slack user ${c.userId}), ${c.role}. Use ONLY the read tools. Look at messages since ${sinceIso}:
1. DMs and group DMs to him; 2. messages mentioning him (search his user id ${c.userId}) or his groups ${c.groups.join(', ')};
3. replies in threads he started or replied in; 4. in channels he is a member of (slack_list_user_channels), mainly ${c.channels.join(', ')}: anything asking the mobile team / him something, about his PRs or tickets below, or a prod incident / release / store issue touching mobile.
${contextLines()}

NOISE — drop it: bots and CI/GitHub/Jira notifications (unless a human asks him something in them), social chatter, announcements needing no action, anything he already answered or reacted to, his own messages.
Read a thread when needed to know whether it is still open. Keep at most 25 items.
Output ONLY a JSON array, no prose, no fences. Each item:
{"id": "<channelId>-<message ts>", "ts": "<ISO time>", "channel": "#name or DM name", "author": "display name", "text": "<original text, max 300 chars>",
 "summary": "<French, one line>", "why": "<French: why it matters to him>", "action": "<French: what he should do, or empty>",
 "priority": "urgent" | "important" | "fyi", "kind": "dm" | "mention" | "thread" | "team" | "incident", "permalink": "<slack permalink if known>"}
urgent = someone blocked on him / prod incident / direct question waiting > 2h. Empty array if nothing matters.`;
}

let running = false;
export async function syncSlack({ force = false, model } = {}) {
  const c = config.slack;
  if (!c.enabled || running) return { skipped: true };
  const last = kv.get('slack') ?? {};
  const now = new Date();
  const workHours = now.getDay() >= 1 && now.getDay() <= 5 && now.getHours() >= c.hours[0] && now.getHours() < c.hours[1];
  if (!force && (!workHours || (last.at && now - new Date(last.at) < c.everyMs))) return { skipped: true };
  running = true;
  kv.set('slack', { ...last, running: true });
  // Look back to the previous run with an overlap, at least 2h, at most 3 days.
  const since = new Date(Math.max(now - 3 * 86_400_000, Math.min(now - 2 * 3_600_000, last.at ? new Date(last.at) - 3_600_000 : now - 86_400_000)));
  try {
    const out = await sh('claude', ['-p', '--model', model ?? c.model, '--output-format', 'json', '--permission-mode', 'dontAsk', '--allowedTools', ...READ_TOOLS, '--', prompt(since.toISOString())], {
      cwd: config.dataDir, input: '', timeout: 600_000,
    });
    const result = JSON.parse(out);
    if (result.is_error) throw new Error(String(result.result).slice(0, 200));
    const text = String(result.result);
    const items = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    let fresh = 0;
    for (const i of items) {
      if (!i?.id) continue;
      const prev = db.prepare('SELECT status, first_seen FROM slack WHERE id = ?').get(i.id);
      if (!prev) fresh += 1;
      upsert('slack', {
        id: i.id, ts: i.ts, channel: i.channel, author: i.author, text: i.text, summary: i.summary, why: i.why, action: i.action,
        priority: ['urgent', 'important', 'fyi'].includes(i.priority) ? i.priority : 'fyi', kind: i.kind, permalink: i.permalink,
        first_seen: prev?.first_seen ?? now.toISOString(), status: prev?.status ?? 'new',
      });
      if (!prev && i.priority === 'urgent') {
        sh('osascript', ['-e', `display notification "${String(i.summary ?? '').replace(/["\\]/g, '')}" with title "Slack — urgent" subtitle "${String(i.channel ?? '').replace(/["\\]/g, '')}" sound name "Glass"`]).catch(() => {});
      }
    }
    const cost = result.total_cost_usd ?? 0;
    kv.set('slack', { at: now.toISOString(), count: items.length, fresh, cost, error: null, running: false, model: model ?? c.model });
    logEvent('slack', `Slack trié : ${items.length} message(s) gardé(s), ${fresh} nouveau(x) · $${cost.toFixed(3)}`);
    return { count: items.length, fresh };
  } catch (e) {
    kv.set('slack', { ...last, error: e.message.slice(0, 300), running: false });
    logEvent('slack-error', `Tri Slack en échec : ${e.message.slice(0, 200)}`);
    throw e;
  } finally {
    running = false;
  }
}

export const slackItems = () => db.prepare("SELECT * FROM slack WHERE ts >= ? ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, ts DESC")
  .all(new Date(Date.now() - 7 * 86_400_000).toISOString());
export const setSlackStatus = (id, status) => { db.prepare('UPDATE slack SET status = ? WHERE id = ?').run(status, id); bump('slack'); };
