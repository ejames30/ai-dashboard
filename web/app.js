const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - new Date(ts)) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} j`;
};
const dur = (a, b) => {
  if (!a) return '–';
  const ms = (b ? new Date(b) : new Date()) - new Date(a);
  const m = Math.floor(ms / 60000);
  return m < 1 ? `${Math.round(ms / 1000)}s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
};
const fmtMs = (ms) => { const m = Math.floor(ms / 60000); return !ms ? '–' : m < 1 ? `${Math.round(ms / 1000)}s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };
const kfmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0));
const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 3500); };

async function post(path, body = {}) {
  const res = await fetch(path, { method: 'POST', headers: { 'X-Dashboard': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

let S = null;
let stackLog = [];

// ---- tabs ------------------------------------------------------------------
const tabFromHash = () => (location.hash.slice(1) || 'tasks');
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === `tab-${name}`));
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => { location.hash = b.dataset.tab; }));
window.addEventListener('hashchange', () => showTab(tabFromHash()));
showTab(tabFromHash());

// ---- shared bits -----------------------------------------------------------
const SESSION_STATE = {
  starting: ['live', 'démarre'], running: ['live', 'en cours'], working: ['live', 'en cours'], busy: ['live', 'en cours'],
  blocked: ['accent', 'Need input'], idle: ['info', 'en attente'], done: ['ok', 'terminé'],
  failed: ['err', 'échec'], error: ['err', 'échec'], stopped: ['', 'arrêté'], killed: ['', 'arrêté'], gone: ['', 'supprimé'],
};
const sessionBadge = (s) => {
  const [cls, label] = SESSION_STATE[s.state] ?? ['', s.state];
  return `<span class="badge ${cls}">${['live'].includes(cls) ? '● ' : ''}${esc(label)}</span>`;
};
const checksBadge = (c) => ({ SUCCESS: '<span class="badge ok">✓ checks</span>', FAILURE: '<span class="badge err">✗ checks</span>', ERROR: '<span class="badge err">✗ checks</span>', PENDING: '<span class="badge warn">… checks</span>', EXPECTED: '<span class="badge warn">… checks</span>' }[c] ?? '<span class="muted small">–</span>');
const decisionBadge = (d) => ({ APPROVED: '<span class="badge ok">approuvée</span>', CHANGES_REQUESTED: '<span class="badge err">changes</span>', REVIEW_REQUIRED: '<span class="badge">review requise</span>' }[d] ?? '');
const rcLink = (s) => (s.rc_url ? `<a href="${esc(s.rc_url)}" target="_blank" rel="noopener">ouvrir ↗</a>` : '');

// ---- tasks -----------------------------------------------------------------
function renderTasks() {
  const tasks = S.tasks;
  $('#cTasks').textContent = tasks.length || '';
  if (!tasks.length) return ($('#tab-tasks').innerHTML = '<div class="panel"><div class="empty">Aucune tâche. Configure Jira ou ouvre une PR.</div></div>');
  const rows = tasks.map((t) => {
    const pr = t.pr;
    const last = t.sessions[0];
    const jira = `${S.jira.site}/browse/${t.key}`;
    const state = pr ? [
      checksBadge(pr.checks),
      pr.mergeable === 'CONFLICTING' ? '<span class="badge err">conflits</span>' : '',
      pr.unresolved_threads ? `<span class="badge warn">${pr.unresolved_threads} commentaire(s)</span>` : '',
      decisionBadge(pr.review_decision),
    ].filter(Boolean).join(' ') : '';
    return `<tr>
      <td><div class="title">${t.key.startsWith('PR-') ? '' : `<a class="key" href="${esc(jira)}" target="_blank">${esc(t.key)}</a> `}${esc(t.issue?.summary ?? pr?.title)}</div>
        <div class="sub">${t.issue ? `${esc(t.issue.type)} · ${esc(t.issue.status)} · ` : ''}${pr ? `<span class="mono">${esc(pr.head)}</span>` : 'pas encore de PR'}</div></td>
      <td>${pr ? `<a href="${esc(pr.url)}" target="_blank">#${pr.number}</a> ${pr.is_draft ? '<span class="badge">draft</span>' : ''}<div class="small"><span class="size">${t.size}</span> <span class="muted mono">+${pr.additions} −${pr.deletions}</span></div>` : ''}</td>
      <td class="wrap">${state}</td>
      <td>${last ? `${sessionBadge(last)} ${rcLink(last)}<div class="muted small">${esc(last.chore)} · ${ago(last.started_at)}</div>` : ''}</td>
      <td><div class="row-actions">
        ${t.next ? `<button class="chore" data-chore="${t.next.key}" data-task="${esc(t.key)}">${esc(t.next.label)}</button>` : ''}
        <select data-task-chore="${esc(t.key)}" title="Lancer une autre chore"><option value="">⋯</option>${S.chores.filter((c) => c.key !== 'ai-review').map((c) => `<option value="${c.key}">${esc(c.label)}</option>`).join('')}</select>
        ${pr ? `<button class="ghost" data-stack-branch="${esc(pr.head)}" title="Charger dans le stack local">▶</button>` : ''}
      </div></td>
    </tr>`;
  }).join('');
  $('#tab-tasks').innerHTML = `<div class="panel"><div class="scroll"><table>
    <colgroup><col><col style="width:110px"><col style="width:250px"><col style="width:170px"><col style="width:290px"></colgroup>
    <thead><tr><th>Tâche</th><th>PR</th><th>État</th><th>Dernière session</th><th style="text-align:right">Next action</th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>`;
}

// ---- reviews ---------------------------------------------------------------
function renderReviews() {
  const reviews = S.reviews;
  $('#cReviews').textContent = reviews.filter((r) => !r.my_review).length || '';
  if (!reviews.length) return ($('#tab-reviews').innerHTML = '<div class="panel"><div class="empty">Aucune PR de collègue ouverte.</div></div>');
  const MY = { PENDING: ['accent', 'brouillon prêt'], APPROVED: ['ok', 'approuvée'], CHANGES_REQUESTED: ['err', 'changes demandés'], COMMENTED: ['info', 'commentée'] };
  $('#tab-reviews').innerHTML = ['S', 'M', 'L', 'XL'].map((size) => {
    const group = reviews.filter((r) => r.size === size);
    if (!group.length) return '';
    return `<div class="panel"><h2><span class="size">${size}</span> ${group.length} PR</h2><div class="scroll"><table class="fixed">
      <colgroup><col><col style="width:110px"><col style="width:100px"><col style="width:140px"><col style="width:190px"><col style="width:250px"></colgroup><tbody>${group.map((r) => {
      const s = r.session;
      const my = MY[r.my_review];
      return `<tr>
        <td><div class="title"><a href="${esc(r.url)}" target="_blank">#${r.number}</a> ${esc(r.title)}</div>
          <div class="sub">@${esc(r.author)} · ${ago(r.updated)} ${r.requested_me ? '· <b>review demandée</b>' : ''}</div></td>
        <td class="mono">+${r.additions} −${r.deletions}<div class="muted small">${r.changed_files} fichiers</div></td>
        <td>${checksBadge(r.checks)}</td>
        <td>${my ? `<span class="badge ${my[0]}">${my[1]}</span>` : ''}</td>
        <td>${s ? `${sessionBadge(s)} ${rcLink(s)} ${s.error ? `<div class="small" style="color:var(--err)">${esc(s.error)}</div>` : ''}` : ''}</td>
        <td><div class="row-actions">
          ${s?.posted_url ? `<a href="${esc(s.posted_url)}" target="_blank">voir le brouillon ↗</a>` : ''}
          <button class="chore" data-review="${r.number}" data-repo="${esc(r.repo)}">AI review</button>
          <button class="ghost" data-stack-pr="${r.number}" title="Charger dans le stack local">▶</button>
        </div></td></tr>`;
    }).join('')}</tbody></table></div></div>`;
  }).join('');
}

// ---- sessions + analytics --------------------------------------------------
function renderSessions() {
  const ss = S.sessions;
  const live = ss.filter((s) => ['starting', 'running', 'working', 'busy', 'blocked'].includes(s.state));
  $('#cSessions').textContent = live.length || '';
  const tokens = (s) => s.input_tokens + s.output_tokens + s.cache_write_tokens;
  const total = ss.reduce((a, s) => a + tokens(s), 0);
  const cache = ss.reduce((a, s) => a + s.cache_read_tokens, 0);
  const finished = ss.filter((s) => s.ended_at);
  const avgMs = finished.length ? finished.reduce((a, s) => a + (new Date(s.ended_at) - new Date(s.started_at)), 0) / finished.length : 0;

  const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - 13 + i); return d.toDateString(); });
  const perDay = days.map((d) => ss.filter((s) => new Date(s.started_at).toDateString() === d).length);
  const maxDay = Math.max(1, ...perDay);
  const byChore = Object.entries(ss.reduce((m, s) => ((m[s.chore] = (m[s.chore] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const maxChore = Math.max(1, ...byChore.map((c) => c[1]));
  const label = (k) => S.chores.find((c) => c.key === k)?.label ?? k;

  $('#tab-sessions').innerHTML = `
    <div class="stats">
      <div class="stat"><b>${live.length}</b><small>actives</small></div>
      <div class="stat"><b>${ss.filter((s) => s.state === 'blocked').length}</b><small>need input</small></div>
      <div class="stat"><b>${ss.length}</b><small>sessions au total</small></div>
      <div class="stat"><b>${kfmt(total)}</b><small>tokens (hors cache lu)</small></div>
      <div class="stat"><b>${kfmt(cache)}</b><small>tokens lus en cache</small></div>
      <div class="stat"><b>${fmtMs(avgMs)}</b><small>durée moyenne</small></div>
    </div>
    <div class="grid2" style="margin-bottom:16px">
      <div class="panel" style="margin:0"><h2>Sessions / jour (14 j)</h2><div class="bars" style="margin-bottom:14px">${perDay.map((n, i) => `<div style="height:${(n / maxDay) * 100}%" title="${n}"><span>${i % 2 ? '' : new Date(days[i]).getDate()}</span></div>`).join('')}</div></div>
      <div class="panel" style="margin:0"><h2>Par chore</h2><div class="chorebars">${byChore.map(([k, n]) => `<span>${esc(label(k))}</span><div class="b" style="width:${(n / maxChore) * 100}%"></div><span class="muted">${n}</span>`).join('') || '<span class="muted">rien encore</span>'}</div></div>
    </div>
    <div class="panel"><div class="scroll"><table>
      <thead><tr><th>Session</th><th>Chore</th><th>Modèle</th><th>État</th><th>Démarrée</th><th>Durée</th><th>Tokens</th><th></th></tr></thead>
      <tbody>${ss.map((s) => `<tr>
        <td><div class="title mono">${esc(s.name)}</div><div class="sub">${esc(s.task ?? (s.pr ? `PR #${s.pr}` : 'libre'))}</div></td>
        <td>${esc(label(s.chore))}</td>
        <td class="mono">${esc(s.model)} · ${esc(s.effort)}</td>
        <td>${sessionBadge(s)}${s.error ? `<div class="small" style="color:var(--err)">${esc(s.error)}</div>` : ''}</td>
        <td class="muted">${ago(s.started_at)}</td>
        <td class="muted">${dur(s.started_at, s.ended_at)}</td>
        <td class="mono">${kfmt(tokens(s))}<div class="muted small">${s.turns} tours</div></td>
        <td><div class="row-actions">${rcLink(s)} ${['starting', 'running', 'working', 'busy', 'blocked', 'idle', 'done'].includes(s.state) ? `<button class="ghost" data-stop="${s.id}">stop</button>` : ''}</div></td>
      </tr>`).join('') || '<tr><td colspan="8" class="empty">Aucune session lancée.</td></tr>'}</tbody></table></div></div>`;
}

// ---- stack -----------------------------------------------------------------
function renderStack() {
  const st = S.stack;
  if (!st) return ($('#tab-stack').innerHTML = '<div class="panel"><div class="empty">Aucun repo avec un stack configuré.</div></div>');
  $('#stackDot').className = `dot ${st.busy ? 'warn' : st.running ? 'ok' : ''}`;
  const cur = st.current;
  const options = [
    ...S.tasks.filter((t) => t.pr).map((t) => `<option value="b:${esc(t.pr.head)}">${esc(t.key)} — ${esc(t.pr.head)}</option>`),
    ...S.reviews.map((r) => `<option value="p:${r.number}">PR #${r.number} @${esc(r.author)} — ${esc(r.title.slice(0, 50))}</option>`),
    '<option value="b:master">master</option>',
  ].join('');
  $('#tab-stack').innerHTML = `
    <div class="panel"><h2>Stack local</h2>
      <div class="stackbar">
        <span class="dot ${st.busy ? 'warn' : st.running ? 'ok' : ''}"></span>
        <b>${st.busy ? esc(st.busy) + '…' : st.running ? `Metro tourne · port ${st.port}` : 'arrêté'}</b>
        <span class="muted">${cur ? `${esc(cur.branch ?? `PR #${cur.pr}`)} @ <span class="mono">${esc(cur.sha)}</span> · ${ago(cur.at)}` : 'aucune branche chargée'}</span>
        <span class="spacer"></span>
        <select id="stackRef">${options}</select>
        <button id="stackSwitch" ${st.busy ? 'disabled' : ''}>Charger</button>
        <button id="stackRefresh" ${!cur || st.busy ? 'disabled' : ''} title="Récupérer les derniers commits (hot reload)">⟳ Refresh</button>
        ${st.running ? '<button id="stackStop">Stop</button>' : `<button class="primary" id="stackStart" ${st.busy ? 'disabled' : ''}>Start</button>`}
      </div>
      <div class="muted small" style="padding:0 14px 10px">Checkout détaché dans <span class="mono">${esc(st.path)}</span>${st.exists ? '' : ' (créé + pnpm install au premier usage)'} — jamais ton clone principal.</div>
      <pre class="log" id="stackLog"></pre>
    </div>`;
  if (cur) $('#stackRef').value = cur.pr ? `p:${cur.pr}` : `b:${cur.branch}`;
  renderStackLog();
}
function renderStackLog() {
  const el = $('#stackLog');
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.textContent = stackLog.join('\n') || '—';
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// ---- header ----------------------------------------------------------------
function renderHeader() {
  const sync = S.sync;
  $('#syncInfo').textContent = sync ? `sync il y a ${ago(sync.at)}${sync.errors.length ? ' · ⚠ erreur' : ''}` : 'sync…';
  $('#syncInfo').title = sync?.errors.join('\n') ?? '';
  const parts = [];
  if (!S.jira.configured) parts.push(`Jira non connecté — les tâches viennent seulement de tes PRs. Crée un token sur <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank">id.atlassian.com</a>, puis : <code>security add-generic-password -s ${esc(S.jira.service)} -a ${esc(S.jira.email)} -w &lt;token&gt;</code> et clique Sync.`);
  if (sync?.errors.length) parts.push(`⚠ ${sync.errors.map(esc).join(' · ')}`);
  const blocked = S.sessions.filter((s) => s.state === 'blocked');
  if (blocked.length) parts.push(`<b>${blocked.length} session(s) attendent ta réponse :</b> ${blocked.map((s) => `${rcLink(s) ? `<a href="${esc(s.rc_url)}" target="_blank">${esc(s.name)}</a>` : esc(s.name)}`).join(', ')}`);
  $('#banner').innerHTML = parts.join('<br>');
  document.title = blocked.length ? `(${blocked.length}) Eric's AI Dashboard` : "Eric's AI Dashboard";
}

function render() {
  renderHeader(); renderTasks(); renderReviews(); renderSessions(); renderStack();
}

// ---- chore modal -----------------------------------------------------------
let pending = null;
async function openChore(params) {
  const q = new URLSearchParams(params);
  const res = await fetch(`/api/chore?${q}`);
  const d = await res.json();
  if (!res.ok) return toast(d.error);
  pending = params;
  $('#mTitle').textContent = d.label;
  $('#mSub').textContent = params.kind === 'review' ? `PR #${params.pr}` : params.task ?? 'Session libre dans un nouveau worktree sur master';
  $('#mModel').innerHTML = S.models.map((m) => `<option ${m === d.model ? 'selected' : ''}>${m}</option>`).join('');
  $('#mEffort').innerHTML = S.efforts.map((e) => `<option ${e === d.effort ? 'selected' : ''}>${e}</option>`).join('');
  $('#mPrompt').value = d.prompt;
  $('#mNote').textContent = params.kind === 'review'
    ? 'Lecture seule : Claude ne peut ni écrire ni poster. Le dashboard transforme sa review en brouillon GitHub que tu relis et soumets toi-même.'
    : 'Session Claude Code en arrière-plan, Remote Control activé : tu peux la suivre ou lui répondre depuis claude.ai.';
  $('#modal').showModal();
}
$('#choreForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'start') return;
  e.preventDefault();
  $('#mStart').disabled = true;
  try {
    await post('/api/sessions', { ...pending, model: $('#mModel').value, effort: $('#mEffort').value, prompt: $('#mPrompt').value });
    $('#modal').close();
    toast('Session lancée');
  } catch (err) {
    toast(err.message);
  } finally {
    $('#mStart').disabled = false;
  }
});

// ---- events ----------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.chore && b.dataset.task) return openChore({ kind: 'task', task: b.dataset.task, chore: b.dataset.chore });
    if (b.dataset.review) return openChore({ kind: 'review', repo: b.dataset.repo, pr: b.dataset.review });
    if (b.dataset.stop) { await post(`/api/sessions/${b.dataset.stop}/stop`); return toast('Session arrêtée'); }
    if (b.dataset.stackBranch) { await post('/api/stack/switch', { branch: b.dataset.stackBranch }); location.hash = 'stack'; return; }
    if (b.dataset.stackPr) { await post('/api/stack/switch', { pr: b.dataset.stackPr }); location.hash = 'stack'; return; }
    if (b.id === 'customBtn') return openChore({ kind: 'custom', chore: 'custom' });
    if (b.id === 'syncBtn') { b.disabled = true; await post('/api/sync'); b.disabled = false; return toast('Synchronisé'); }
    if (b.id === 'stackSwitch') { const [k, v] = $('#stackRef').value.split(/:(.*)/); return post('/api/stack/switch', k === 'p' ? { pr: v } : { branch: v }); }
    if (b.id === 'stackRefresh') return post('/api/stack/refresh');
    if (b.id === 'stackStart') return post('/api/stack/start');
    if (b.id === 'stackStop') return post('/api/stack/stop');
  } catch (err) {
    toast(err.message);
  }
});
document.addEventListener('change', (e) => {
  const t = e.target.dataset.taskChore;
  if (t && e.target.value) { openChore({ kind: 'task', task: t, chore: e.target.value }); e.target.value = ''; }
});

// ---- live ------------------------------------------------------------------
function connect() {
  const es = new EventSource('/live');
  es.addEventListener('state', (e) => {
    S = JSON.parse(e.data);
    if (!stackLog.length && S.stack?.log) stackLog = S.stack.log;
    // Keep an open <select> usable: skip re-rendering the tab the pointer is in while a select has focus.
    if (document.activeElement?.tagName === 'SELECT') { renderHeader(); return; }
    render();
  });
  es.addEventListener('stacklog', (e) => { stackLog.push(JSON.parse(e.data)); if (stackLog.length > 400) stackLog = stackLog.slice(-400); renderStackLog(); });
  es.onerror = () => { $('#syncInfo').textContent = 'déconnecté du serveur…'; };
}
// ?snapshot: one fetch, no live stream (headless screenshots never settle on an open SSE).
if (new URLSearchParams(location.search).has('snapshot')) fetch('/api/state').then((r) => r.json()).then((d) => { S = d; stackLog = d.stack?.log ?? []; render(); });
else connect();
setInterval(() => S && !document.activeElement?.matches('select, textarea') && renderSessions(), 30_000);
