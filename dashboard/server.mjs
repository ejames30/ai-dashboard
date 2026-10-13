// Local dashboard for the PR auto brutal-review agent.
// Zero dependencies. Binds 127.0.0.1 only.
//
//   GET  /                  → index.html
//   GET  /api/state         → { agent, events }      (full history, page bootstrap)
//   GET  /api/run/:id       → { stream: [...], body } (one review: tool timeline + final comment)
//   GET  /live              → SSE: `event` (new events.jsonl line), `stream` (new line of a running review), `agent`
//   POST /api/agent/:action → run-now | pause | resume   (needs X-Dashboard header → forces CORS preflight, so
//                                                         a random website can't trigger it from your browser)

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4317);
const DATA = process.env.PR_AUTOREVIEW_DATA ?? join(homedir(), '.claude/pr-autoreview');
const EVENTS = join(DATA, 'events.jsonl');
const RUNS = join(DATA, 'runs');
const LABEL = 'com.eric.pr-autoreview';
const PLIST = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const UID = process.getuid();
const POLL_MS = 500;
const RUN_ID = /^[0-9]+-pr-[0-9]+$/;

const clients = new Set();
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const broadcast = (event, data) => clients.forEach((res) => send(res, event, data));

const parseLines = (text) =>
  text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });

async function readJsonl(path) {
  if (!existsSync(path)) return [];
  return parseLines(await readFile(path, 'utf8'));
}

// ---- tailing ---------------------------------------------------------------
// Each tailed file remembers its byte offset; new complete lines are pushed to SSE clients.
const tails = new Map(); // path → { offset, rest }

async function tail(path, onLine) {
  if (!existsSync(path)) return;
  const t = tails.get(path) ?? { offset: (await stat(path)).size, rest: '' };
  tails.set(path, t);
  const { size } = await stat(path);
  if (size < t.offset) t.offset = 0; // truncated
  if (size === t.offset) return;
  const fh = await open(path, 'r');
  const buf = Buffer.alloc(size - t.offset);
  await fh.read(buf, 0, buf.length, t.offset);
  await fh.close();
  t.offset = size;
  const chunk = t.rest + buf.toString('utf8');
  const lines = chunk.split('\n');
  t.rest = lines.pop();
  parseLines(lines.join('\n')).forEach(onLine);
}

const active = new Set(); // run ids currently reviewing

async function tick() {
  await tail(EVENTS, (ev) => {
    if (ev.type === 'review_start') {
      active.add(ev.id);
      tails.set(join(RUNS, `${ev.id}.stream.jsonl`), { offset: 0, rest: '' });
    }
    if (ev.type === 'review_done' || (ev.type === 'review_failed' && ev.id)) active.delete(ev.id);
    broadcast('event', ev);
  });
  for (const id of active) {
    await tail(join(RUNS, `${id}.stream.jsonl`), (line) => {
      const slim = slimStreamLine(line);
      if (slim) broadcast('stream', { id, line: slim });
    });
  }
}

// Keep only what the timeline shows — the raw stream carries the whole system prompt on init.
function slimStreamLine(l) {
  if (l.type === 'assistant') {
    return { type: 'assistant', content: (l.message?.content ?? []).map((c) =>
      c.type === 'tool_use' ? { type: 'tool_use', name: c.name, input: c.input }
      : c.type === 'text' ? { type: 'text', text: c.text } : { type: c.type }) };
  }
  if (l.type === 'user') {
    return { type: 'tool_result', content: (l.message?.content ?? []).filter((c) => c.type === 'tool_result')
      .map((c) => ({ is_error: !!c.is_error, size: JSON.stringify(c.content ?? '').length })) };
  }
  if (l.type === 'result') {
    return { type: 'result', cost: l.total_cost_usd, duration_ms: l.duration_ms, turns: l.num_turns, is_error: l.is_error };
  }
  if (l.type === 'system' && l.subtype === 'init') return { type: 'init', model: l.model };
  return null;
}

// ---- launchd ---------------------------------------------------------------
async function agentStatus() {
  try {
    const { stdout } = await run('launchctl', ['print', `gui/${UID}/${LABEL}`]);
    const pick = (re) => stdout.match(re)?.[1];
    return {
      loaded: true,
      running: pick(/^\tstate = (.+)$/m) === 'running',
      runs: Number(pick(/^\truns = (\d+)/m) ?? 0),
      lastExit: pick(/^\tlast exit code = (.+)$/m),
      interval: Number(pick(/run interval = (\d+)/) ?? 300),
    };
  } catch {
    return { loaded: false };
  }
}

const ACTIONS = {
  'run-now': ['kickstart', `gui/${UID}/${LABEL}`],
  pause: ['bootout', `gui/${UID}/${LABEL}`],
  resume: ['bootstrap', `gui/${UID}`, PLIST],
};

// ---- http ------------------------------------------------------------------
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await readFile(join(HERE, 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, { agent: await agentStatus(), events: await readJsonl(EVENTS), active: [...active] });
    }
    const runMatch = url.pathname.match(/^\/api\/run\/([^/]+)$/);
    if (req.method === 'GET' && runMatch && RUN_ID.test(runMatch[1])) {
      const id = runMatch[1];
      const stream = (await readJsonl(join(RUNS, `${id}.stream.jsonl`))).map(slimStreamLine).filter(Boolean);
      const bodyPath = join(RUNS, `${id}.md`);
      return json(res, 200, { stream, body: existsSync(bodyPath) ? await readFile(bodyPath, 'utf8') : null });
    }
    if (req.method === 'GET' && url.pathname === '/live') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const act = url.pathname.match(/^\/api\/agent\/([a-z-]+)$/);
    if (req.method === 'POST' && act && ACTIONS[act[1]]) {
      if (req.headers['x-dashboard'] !== '1') return json(res, 403, { error: 'missing header' });
      try { await run('launchctl', ACTIONS[act[1]]); } catch (e) { return json(res, 500, { error: String(e.stderr || e) }); }
      const agent = await agentStatus();
      broadcast('agent', agent);
      return json(res, 200, agent);
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`pr-autoreview dashboard → http://localhost:${PORT}`));

// Bootstrap: reviews that started but never finished (dashboard restarted mid-review) are still tailed.
for (const ev of await readJsonl(EVENTS)) {
  if (ev.type === 'review_start') active.add(ev.id);
  if (ev.type === 'review_done' || ev.type === 'review_failed') active.delete(ev.id);
}
await tail(EVENTS, () => {}); // set offset to end; running streams start tailing from their current end too
setInterval(() => tick().catch((e) => console.error(e)), POLL_MS);
setInterval(async () => broadcast('agent', await agentStatus()), 10_000);
