import { config } from './config.mjs';
import { bump, db } from './db.mjs';
import { git } from './sh.mjs';

// The Atelier: every git worktree of every repo, stored in the DB (scanned in the background,
// never on page load), plus the board I draw on top — node positions, my own nodes (notes,
// tickets, epics) and the links I drag between things.

db.exec(`
  CREATE TABLE IF NOT EXISTS worktrees (
    path TEXT PRIMARY KEY, repo TEXT, branch TEXT, head TEXT, dirty INTEGER, ahead INTEGER, behind INTEGER,
    last_commit_at TEXT, last_subject TEXT, scanned_at TEXT
  );
  CREATE TABLE IF NOT EXISTS graph_pos (id TEXT PRIMARY KEY, x REAL, y REAL);
  CREATE TABLE IF NOT EXISTS graph_nodes (id TEXT PRIMARY KEY, type TEXT, label TEXT, ref TEXT, data TEXT, created_at TEXT);
  CREATE TABLE IF NOT EXISTS graph_edges (id TEXT PRIMARY KEY, src TEXT, dst TEXT, label TEXT, created_at TEXT);
`);

async function inspect(repo, wt) {
  const [status, counts, last] = await Promise.all([
    git(wt.path, ['status', '--porcelain']).catch(() => ''),
    wt.branch ? git(wt.path, ['rev-list', '--left-right', '--count', '@{u}...HEAD']).catch(() => '') : Promise.resolve(''),
    git(wt.path, ['log', '-1', '--format=%cI%x00%s']).catch(() => ''),
  ]);
  const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
  const [at, subject] = last.trim().split('\0');
  return {
    path: wt.path, repo: repo.slug, branch: wt.branch, head: wt.head?.slice(0, 9) ?? null,
    dirty: status.split('\n').filter(Boolean).length, ahead: Number.isFinite(ahead) ? ahead : null, behind: Number.isFinite(behind) ? behind : null,
    last_commit_at: at || null, last_subject: subject ?? null, scanned_at: new Date().toISOString(),
  };
}

let scanning = null;
export function scanWorktrees() {
  scanning ??= (async () => {
    const rows = [];
    for (const repo of config.repos) {
      const out = await git(repo.path, ['worktree', 'list', '--porcelain']).catch(() => '');
      const wts = out.split('\n\n').filter(Boolean).map((b) => ({
        path: b.match(/^worktree (.+)$/m)?.[1], head: b.match(/^HEAD (\w+)/m)?.[1], branch: b.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null,
      })).filter((w) => w.path);
      for (let i = 0; i < wts.length; i += 4) rows.push(...await Promise.all(wts.slice(i, i + 4).map((w) => inspect(repo, w))));
    }
    db.exec('BEGIN');
    db.exec('DELETE FROM worktrees');
    const ins = db.prepare('INSERT INTO worktrees VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(r.path, r.repo, r.branch, r.head, r.dirty, r.ahead, r.behind, r.last_commit_at, r.last_subject, r.scanned_at);
    db.exec('COMMIT');
    bump('worktrees');
    return rows.length;
  })().finally(() => { scanning = null; });
  return scanning;
}

export const graphState = () => ({
  worktrees: db.prepare('SELECT * FROM worktrees ORDER BY last_commit_at DESC').all(),
  pos: Object.fromEntries(db.prepare('SELECT id, x, y FROM graph_pos').all().map((p) => [p.id, [p.x, p.y]])),
  nodes: db.prepare('SELECT * FROM graph_nodes').all().map((n) => ({ ...n, data: n.data ? JSON.parse(n.data) : null })),
  edges: db.prepare('SELECT * FROM graph_edges').all(),
});

export const isWorktree = (path) => !!db.prepare('SELECT 1 FROM worktrees WHERE path = ?').get(path);

const rid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const graphOps = {
  pos({ items = [] }) {
    const up = db.prepare('INSERT INTO graph_pos (id, x, y) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET x = excluded.x, y = excluded.y');
    db.exec('BEGIN'); for (const { id, x, y } of items) up.run(String(id), Number(x), Number(y)); db.exec('COMMIT');
    bump('graph');
  },
  resetPos() { db.exec('DELETE FROM graph_pos'); bump('graph'); },
  addNode({ type, label, ref, data, x, y }) {
    if (!['note', 'ticket', 'epic', 'pr', 'group'].includes(type)) throw Object.assign(new Error('bad node type'), { code: 400 });
    const id = rid(`n-${type}`);
    db.prepare('INSERT INTO graph_nodes VALUES (?, ?, ?, ?, ?, ?)').run(id, type, String(label ?? '').slice(0, 500), ref ?? null, data ? JSON.stringify(data) : null, new Date().toISOString());
    if (x != null) db.prepare('INSERT OR REPLACE INTO graph_pos VALUES (?, ?, ?)').run(id, x, y);
    bump('graph');
    return id;
  },
  editNode({ id, label }) { db.prepare('UPDATE graph_nodes SET label = ? WHERE id = ?').run(String(label ?? '').slice(0, 500), id); bump('graph'); },
  deleteNode({ id }) {
    db.prepare('DELETE FROM graph_nodes WHERE id = ?').run(id);
    db.prepare('DELETE FROM graph_edges WHERE src = ? OR dst = ?').run(id, id);
    db.prepare('DELETE FROM graph_pos WHERE id = ?').run(id);
    bump('graph');
  },
  addEdge({ src, dst, label }) {
    if (!src || !dst || src === dst) throw Object.assign(new Error('bad edge'), { code: 400 });
    const dup = db.prepare('SELECT id FROM graph_edges WHERE (src = ? AND dst = ?) OR (src = ? AND dst = ?)').get(src, dst, dst, src);
    if (dup) return dup.id;
    const id = rid('e');
    db.prepare('INSERT INTO graph_edges VALUES (?, ?, ?, ?, ?)').run(id, src, dst, label ?? null, new Date().toISOString());
    bump('graph');
    return id;
  },
  deleteEdge({ id }) { db.prepare('DELETE FROM graph_edges WHERE id = ?').run(id); bump('graph'); },
};
