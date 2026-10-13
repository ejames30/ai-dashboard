import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(join(config.dataDir, 'ai-dashboard.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  -- Jira issues assigned to me (REST with a token, else the Atlassian connector).
  CREATE TABLE IF NOT EXISTS issues (
    key TEXT PRIMARY KEY, summary TEXT, status TEXT, status_category TEXT,
    type TEXT, priority TEXT, url TEXT, updated TEXT, synced_at TEXT
  );

  -- Open PRs in tracked repos: mine (kind='mine') and teammates' (kind='review').
  CREATE TABLE IF NOT EXISTS prs (
    repo TEXT, number INTEGER, kind TEXT, title TEXT, author TEXT, url TEXT,
    head TEXT, base TEXT, head_sha TEXT, is_draft INTEGER, additions INTEGER, deletions INTEGER,
    changed_files INTEGER, mergeable TEXT, review_decision TEXT, checks TEXT,
    unresolved_threads INTEGER, comments INTEGER, requested_me INTEGER,
    my_review TEXT, issue_key TEXT, updated TEXT, synced_at TEXT,
    PRIMARY KEY (repo, number)
  );

  -- Every Claude session the cockpit started.
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, session_id TEXT, name TEXT, chore TEXT, task TEXT,
    repo TEXT, pr INTEGER, model TEXT, effort TEXT, prompt TEXT, cwd TEXT,
    state TEXT, rc_url TEXT, started_at TEXT, ended_at TEXT,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
    turns INTEGER DEFAULT 0, error TEXT, posted_url TEXT
  );

  -- Open epics I can plan on: those of config.jira.epicProjects + parents of my tickets.
  CREATE TABLE IF NOT EXISTS epics (
    key TEXT PRIMARY KEY, summary TEXT, status TEXT, status_category TEXT, url TEXT, updated TEXT, synced_at TEXT
  );

  -- Everything the machine does, append-only: auto-review checks, launches, posts, Slack syncs…
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, kind TEXT, repo TEXT, pr INTEGER, session TEXT, message TEXT, data TEXT
  );
  CREATE INDEX IF NOT EXISTS events_at ON events (at);

  -- One row per Claude API message across ALL my Claude Code transcripts (~/.claude/projects).
  CREATE TABLE IF NOT EXISTS usage (
    msg_id TEXT PRIMARY KEY, ts TEXT, day TEXT, project TEXT, session_id TEXT, model TEXT,
    input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, cost REAL, dashboard INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS usage_day ON usage (day);

  -- Slack messages worth my attention, as triaged by Claude.
  CREATE TABLE IF NOT EXISTS slack (
    id TEXT PRIMARY KEY, ts TEXT, channel TEXT, author TEXT, text TEXT, summary TEXT, why TEXT, action TEXT,
    priority TEXT, kind TEXT, permalink TEXT, first_seen TEXT, status TEXT DEFAULT 'new'
  );

  -- Frozen rollups of \`usage\` (recomputed only for the days / sessions a scan touched).
  CREATE TABLE IF NOT EXISTS usage_hour (
    day TEXT, hour INTEGER, project TEXT, fam TEXT,
    cost REAL, tokens INTEGER, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, n INTEGER,
    PRIMARY KEY (day, hour, project, fam)
  );
  CREATE TABLE IF NOT EXISTS usage_sess (
    session_id TEXT PRIMARY KEY, first TEXT, project TEXT, fam TEXT,
    cost REAL, tokens INTEGER, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, n INTEGER
  );

  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);

// Columns added after the first release: ALTER is a no-op error once they exist.
for (const sql of [
  'ALTER TABLE sessions ADD COLUMN cost_usd REAL DEFAULT 0',
  'ALTER TABLE sessions ADD COLUMN tasks TEXT', // JSON array of ticket keys for a multi-ticket session
  'ALTER TABLE sessions ADD COLUMN title TEXT', // what the session is about (PR title, epic summary)
  'ALTER TABLE sessions ADD COLUMN head_sha TEXT', // reviews: the commit that was reviewed
  'ALTER TABLE sessions ADD COLUMN review_json TEXT', // reviews: the parsed {summary, comments}
  'ALTER TABLE sessions ADD COLUMN epic TEXT', // epic plans: the epic key
  'ALTER TABLE sessions ADD COLUMN author TEXT', // reviews: PR author
  'ALTER TABLE issues ADD COLUMN parent_key TEXT',
  'ALTER TABLE prs ADD COLUMN closed_at TEXT', // kept as history once merged/closed
  'ALTER TABLE issues ADD COLUMN parent_summary TEXT',
]) {
  try { db.exec(sql); } catch {}
}

export const kv = {
  get: (k) => {
    const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
    return row ? JSON.parse(row.v) : undefined;
  },
  set: (k, v) => { db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v)); bump(`kv:${k}`); },
};

// Data versions: every write bumps its table's counter, so the server can cache whatever is
// derived from a table until that table actually changes (see memo in index.mjs).
const versions = new Map();
export const bump = (name) => versions.set(name, (versions.get(name) ?? 0) + 1);
export const version = (...names) => names.map((n) => versions.get(n) ?? 0).join('.');

/** Upsert a row object into `table`, keyed by the table's primary key. */
export function upsert(table, row) {
  const cols = Object.keys(row);
  const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  db.prepare(sql).run(...cols.map((c) => row[c] ?? null));
  bump(table);
}

export function update(table, where, patch) {
  const cols = Object.keys(patch);
  const keys = Object.keys(where);
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}`;
  db.prepare(sql).run(...cols.map((c) => patch[c] ?? null), ...keys.map((k) => where[k]));
  bump(table);
}

/** Append to the event log (also what the live pages stream). */
export function logEvent(kind, message, extra = {}) {
  const { repo = null, pr = null, session = null, ...data } = extra;
  db.prepare('INSERT INTO events (at, kind, repo, pr, session, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), kind, repo, pr, session, message, Object.keys(data).length ? JSON.stringify(data) : null);
  bump('events');
}
