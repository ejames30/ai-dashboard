import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(join(config.dataDir, 'goblin.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  -- Jira issues assigned to me (only filled when a Jira token is configured).
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

  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);

export const kv = {
  get: (k) => {
    const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
    return row ? JSON.parse(row.v) : undefined;
  },
  set: (k, v) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v)),
};

/** Upsert a row object into `table`, keyed by the table's primary key. */
export function upsert(table, row) {
  const cols = Object.keys(row);
  const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  db.prepare(sql).run(...cols.map((c) => row[c] ?? null));
}

export function update(table, where, patch) {
  const cols = Object.keys(patch);
  const keys = Object.keys(where);
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}`;
  db.prepare(sql).run(...cols.map((c) => patch[c] ?? null), ...keys.map((k) => where[k]));
}
