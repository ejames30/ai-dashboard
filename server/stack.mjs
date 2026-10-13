import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { kv } from './db.mjs';
import { env, git, sh } from './sh.mjs';

// The local stack runs from a dedicated detached checkout (repo.stack.path), never the
// main clone: a detached HEAD holds no branch lock, so it can show any task's latest code
// while that branch stays checked out in the task's worktree. "Refresh" pulls the new
// commits in and Metro hot-reloads them.

const LOG_LINES = 400;
let proc = null;
let log = [];
let listeners = new Set();
let busy = null; // 'installing' | 'switching' while a step runs

export const onStackLog = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const push = (line) => {
  log.push(line);
  if (log.length > LOG_LINES) log = log.slice(-LOG_LINES);
  listeners.forEach((fn) => fn(line));
};

const repo = () => config.repos.find((r) => r.stack);
const lockHash = (dir) => {
  const f = join(dir, 'pnpm-lock.yaml');
  return existsSync(f) ? createHash('sha1').update(readFileSync(f)).digest('hex') : null;
};

async function portOwner(port) {
  const out = await sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).catch(() => '');
  return out.trim().split('\n').filter(Boolean).map(Number);
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    push(`$ ${cmd} ${args.join(' ')}`);
    const p = spawn(cmd, args, { cwd, env });
    const out = (d) => d.toString().split('\n').filter(Boolean).forEach(push);
    p.stdout.on('data', out);
    p.stderr.on('data', out);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function ensureCheckout(r) {
  if (existsSync(r.stack.path)) return;
  await git(r.path, ['fetch', '--quiet', 'origin', r.base]);
  await git(r.path, ['worktree', 'add', '--quiet', '--detach', r.stack.path, `origin/${r.base}`]);
  busy = 'installing';
  await run(...r.stack.install, r.stack.path);
}

/** Point the stack at a branch (or a PR head) and reinstall only if the lockfile moved. */
export async function switchStack({ branch, pr }) {
  const r = repo();
  busy = 'switching';
  try {
    await ensureCheckout(r);
    const before = lockHash(r.stack.path);
    const ref = pr ? `refs/ai-dashboard/stack-pr-${pr}` : `origin/${branch}`;
    await git(r.path, ['fetch', '--quiet', '--force', 'origin', pr ? `pull/${pr}/head:${ref}` : branch]);
    await git(r.stack.path, ['checkout', '--quiet', '--detach', '--force', ref]);
    const sha = (await git(r.stack.path, ['rev-parse', '--short', 'HEAD'])).trim();
    kv.set('stack', { branch: branch ?? null, pr: pr ?? null, ref, sha, at: new Date().toISOString() });
    push(`→ ${branch ?? `PR #${pr}`} @ ${sha}`);
    if (lockHash(r.stack.path) !== before) {
      busy = 'installing';
      await run(...r.stack.install, r.stack.path);
    }
  } finally {
    busy = null;
  }
}

/** Pull the latest commits of whatever the stack points at. */
export async function refreshStack() {
  const cur = kv.get('stack');
  if (!cur) throw new Error('stack has no branch yet');
  await switchStack({ branch: cur.branch, pr: cur.pr });
}

export async function startStack() {
  const r = repo();
  if (proc) return;
  try { await ensureCheckout(r); } finally { busy = null; }
  const owners = await portOwner(r.stack.port);
  if (owners.length) throw new Error(`port ${r.stack.port} already used by pid ${owners.join(', ')} — stop that Metro first`);
  const [cmd, args] = r.stack.start;
  push(`$ ${cmd} ${args.join(' ')}  (port ${r.stack.port})`);
  const file = createWriteStream(join(config.dataDir, 'stack.log'), { flags: 'a' });
  proc = spawn(cmd, args, { cwd: join(r.stack.path, r.stack.cwd), env: { ...env, FORCE_COLOR: '0' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (d) => { file.write(d); d.toString().split('\n').filter(Boolean).forEach(push); };
  proc.stdout.on('data', out);
  proc.stderr.on('data', out);
  proc.on('close', (code) => { push(`■ stack exited (${code})`); proc = null; file.end(); });
}

export function stopStack() {
  if (!proc) return;
  try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
}

export async function stackStatus() {
  const r = repo();
  if (!r) return null;
  return {
    path: r.stack.path,
    port: r.stack.port,
    exists: existsSync(r.stack.path),
    running: !!proc,
    pid: proc?.pid ?? null,
    busy,
    current: kv.get('stack') ?? null,
    log: log.slice(-200),
  };
}

process.on('exit', stopStack);
