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
const money = (n) => (!n ? '–' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
const costCell = (t) => (t.sessionCount ? `<span class="cost">${money(t.cost)}</span><div class="muted small">${t.sessionCount} session${t.sessionCount > 1 ? 's' : ''}</div>` : '<span class="muted small">–</span>');
const SEL = new Set(); // ticket keys picked for a multi-ticket session
const selCell = (key) => `<td class="sel"><input type="checkbox" data-sel="${esc(key)}" ${SEL.has(key) ? 'checked' : ''} aria-label="Sélectionner ${esc(key)}"></td>`;
const sessionLink = (s) => `<a href="#" data-open-session="${s.id}" title="Voir la conversation">${sessionBadge(s)}</a>`;
const rcLink = (s) => `<button class="ghost" data-term="${s.id}" title="claude attach dans Warp">Terminal</button>${s.rc_url ? ` <a href="${esc(s.rc_url)}" target="_blank" rel="noopener" class="small muted">web ↗</a>` : ''}`;

// ---- tasks -----------------------------------------------------------------
function renderTasks() {
  const tasks = S.tasks.filter((t) => t.pr || t.issue?.status_category === 'indeterminate' || t.sessions.length);
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
    return `<tr class="${SEL.has(t.key) ? 'picked' : ''}">
      ${selCell(t.key)}
      <td><div class="title">${t.key.startsWith('PR-') ? '' : `<a class="key" href="${esc(jira)}" target="_blank">${esc(t.key)}</a> `}${esc(t.issue?.summary ?? pr?.title)}</div>
        <div class="sub">${t.issue ? `${esc(t.issue.type)} · ${esc(t.issue.status)} · ` : ''}${pr ? `<span class="mono">${esc(pr.head)}</span>` : 'pas encore de PR'}</div></td>
      <td>${pr ? `<a href="${esc(pr.url)}" target="_blank">#${pr.number}</a> ${pr.is_draft ? '<span class="badge">draft</span>' : ''}<div class="small"><span class="size">${t.size}</span> <span class="muted mono">+${pr.additions} −${pr.deletions}</span></div>` : ''}</td>
      <td class="wrap">${state}</td>
      <td>${last ? `${sessionLink(last)} ${rcLink(last)}<div class="muted small">${esc(last.chore)} · ${ago(last.started_at)}</div>` : ''}</td>
      <td>${costCell(t)}</td>
      <td><div class="row-actions">
        ${t.next ? `<button class="chore" data-chore="${t.next.key}" data-task="${esc(t.key)}">${esc(t.next.label)}</button>` : ''}
        <select data-task-chore="${esc(t.key)}" title="Lancer une autre chore"><option value="">⋯</option>${S.chores.filter((c) => c.key !== 'ai-review').map((c) => `<option value="${c.key}">${esc(c.label)}</option>`).join('')}</select>
        ${pr ? `<button class="ghost" data-stack-branch="${esc(pr.head)}" title="Charger dans le stack local">▶</button>` : ''}
      </div></td>
    </tr>`;
  }).join('');
  $('#tab-tasks').innerHTML = `<div class="panel"><div class="scroll"><table>
    <colgroup><col style="width:34px"><col><col style="width:110px"><col style="width:230px"><col style="width:160px"><col style="width:90px"><col style="width:290px"></colgroup>
    <thead><tr><th class="sel"></th><th>Tâche</th><th>PR</th><th>État</th><th>Dernière session</th><th>Coût est.</th><th style="text-align:right">Next action</th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>`;
}

// ---- jira ------------------------------------------------------------------
const J = { q: '', project: '', cat: 'open' };
const CATS = [['open', 'Tous ouverts'], ['indeterminate', 'En cours'], ['new', 'À faire']];
const PRIO_CLASS = (p = '') => (/high|highest|critical|blocker|p1|p2/i.test(p) ? 'high' : /medium|p3/i.test(p) ? 'med' : '');

function renderJira() {
  const jira = S.jira;
  const issues = S.tasks.filter((t) => t.issue);
  $('#cJira').textContent = issues.length || '';
  $('#jInfo').innerHTML = jira.running ? '<span class="dot live"></span> sync Jira…'
    : jira.at ? `${jira.count} tickets · ${jira.source === 'token' ? 'API' : 'via connecteur Atlassian'} · il y a ${ago(jira.at)}${jira.cost ? ` · $${jira.cost.toFixed(2)}` : ''}`
    : 'pas encore synchronisé';

  const projects = [...new Set(issues.map((t) => t.key.split('-')[0]))].sort();
  const sel = $('#jProject');
  if (sel.dataset.v !== projects.join()) {
    sel.innerHTML = `<option value="">Tous les projets</option>${projects.map((p) => `<option>${p}</option>`).join('')}`;
    sel.value = J.project;
    sel.dataset.v = projects.join();
  }
  $('#jCats').innerHTML = CATS.map(([k, l]) => `<button data-jcat="${k}" class="${J.cat === k ? 'on' : ''}">${l}</button>`).join('');

  const q = J.q.toLowerCase();
  const shown = issues.filter((t) =>
    (!J.project || t.key.startsWith(`${J.project}-`)) &&
    (J.cat === 'open' || t.issue.status_category === J.cat) &&
    (!q || t.key.toLowerCase().includes(q) || (t.issue.summary ?? '').toLowerCase().includes(q)));

  if (!issues.length) return ($('#jList').innerHTML = `<div class="panel"><div class="empty">${jira.running ? 'Lecture de tes tickets via le connecteur Atlassian (≈ 40 s)…' : jira.error ? `Erreur Jira : ${esc(jira.error)}` : 'Aucun ticket assigné.'}</div></div>`);
  if (!shown.length) return ($('#jList').innerHTML = '<div class="panel"><div class="empty">Aucun ticket ne correspond aux filtres.</div></div>');

  const order = { indeterminate: 0, new: 1 };
  const groups = new Map();
  [...shown].sort((a, b) => (order[a.issue.status_category] ?? 2) - (order[b.issue.status_category] ?? 2) || (b.issue.updated ?? '').localeCompare(a.issue.updated ?? ''))
    .forEach((t) => { const k = t.issue.status ?? '—'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });

  const choreOptions = S.chores.filter((c) => c.key !== 'ai-review').map((c) => `<option value="${c.key}">${esc(c.label)}</option>`).join('');
  $('#jList').innerHTML = [...groups].map(([status, list]) => `
    <div class="panel"><h2>${esc(status)} <span class="count">${list.length}</span></h2><div class="scroll"><table>
      <colgroup><col style="width:34px"><col style="width:96px"><col><col style="width:120px"><col style="width:110px"><col style="width:120px"><col style="width:140px"><col style="width:90px"><col style="width:250px"></colgroup>
      <tbody>${list.map((t) => {
        const i = t.issue, pr = t.pr, last = t.sessions[0];
        const primary = t.next ?? { key: pr ? 'custom' : 'start-task', label: pr ? 'Lancer Claude' : 'Démarrer la tâche' };
        return `<tr class="${SEL.has(t.key) ? 'picked' : ''}">
          ${selCell(t.key)}
          <td><a class="key" href="${esc(i.url)}" target="_blank">${esc(t.key)}</a></td>
          <td><div class="title">${esc(i.summary)}</div><div class="sub">mis à jour il y a ${ago(i.updated)}</div></td>
          <td class="small">${esc(i.type)}</td>
          <td class="prio ${PRIO_CLASS(i.priority)}">${esc(i.priority ?? '')}</td>
          <td>${pr ? `<a href="${esc(pr.url)}" target="_blank">#${pr.number}</a> ${checksBadge(pr.checks)}` : '<span class="muted small">pas de PR</span>'}</td>
          <td>${last ? `${sessionLink(last)} ${rcLink(last)}` : ''}</td>
          <td>${costCell(t)}</td>
          <td><div class="row-actions">
            <button class="chore" data-chore="${primary.key}" data-task="${esc(t.key)}">${esc(primary.label)}</button>
            <select data-task-chore="${esc(t.key)}" title="Lancer une autre chore"><option value="">⋯</option>${choreOptions}</select>
          </div></td></tr>`;
      }).join('')}</tbody></table></div></div>`).join('');
}
$('#jSearch').addEventListener('input', (e) => { J.q = e.target.value; renderJira(); });
$('#jProject').addEventListener('change', (e) => { J.project = e.target.value; renderJira(); });
document.addEventListener('click', (e) => { const c = e.target.closest('[data-jcat]'); if (c) { J.cat = c.dataset.jcat; renderJira(); } });

// ---- reviews ---------------------------------------------------------------
function renderReviews() {
  const reviews = S.reviews;
  $('#cReviews').textContent = reviews.filter((r) => !r.my_review).length || '';
  if (!reviews.length) return ($('#tab-reviews').innerHTML = '<div class="panel"><div class="empty">Aucune PR de collègue ouverte.</div></div>');
  const MY = { PENDING: ['accent', 'brouillon prêt'], APPROVED: ['ok', 'approuvée'], CHANGES_REQUESTED: ['err', 'changes demandés'], COMMENTED: ['info', 'commentée'] };
  const a = S.autoReview;
  const autoLine = a?.enabled ? `<div class="panel"><div class="small" style="padding:10px 14px">🤖 <b>Brutal review auto</b> : chaque nouvelle PR prête de ${a.authors.map((x) => `@${esc(x)}`).join(', ')} est relue et le résultat <b>posté</b> sur la PR (check toutes les 3 min, depuis ${a.since ? new Date(a.since).toLocaleString('fr-FR') : 'le prochain sync'}).</div></div>` : '';
  $('#tab-reviews').innerHTML = autoLine + ['S', 'M', 'L', 'XL'].map((size) => {
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
  const cost = (list) => list.reduce((a, s) => a + (s.cost_usd ?? 0), 0);
  const since = (days) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - days + 1); return ss.filter((s) => new Date(s.started_at) >= d); };
  const finished = ss.filter((s) => s.ended_at);
  const avgMs = finished.length ? finished.reduce((a, s) => a + (new Date(s.ended_at) - new Date(s.started_at)), 0) / finished.length : 0;

  const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - 13 + i); return d.toDateString(); });
  const perDay = days.map((d) => cost(ss.filter((s) => new Date(s.started_at).toDateString() === d)));
  const maxDay = Math.max(0.01, ...perDay);
  const byChore = Object.entries(ss.reduce((m, s) => { const c = (m[s.chore] ??= { n: 0, cost: 0 }); c.n += 1; c.cost += s.cost_usd ?? 0; return m; }, {})).sort((a, b) => b[1].cost - a[1].cost);
  const maxChore = Math.max(0.01, ...byChore.map(([, c]) => c.cost));
  const label = (k) => S.chores.find((c) => c.key === k)?.label ?? k;
  const what = (s) => { try { const k = s.tasks && JSON.parse(s.tasks); if (k) return k.join(', '); } catch {} return s.task ?? (s.pr ? `PR #${s.pr}` : 'libre'); };

  $('#tab-sessions').innerHTML = `
    <div class="stats">
      <div class="stat"><b>${live.length}</b><small>actives</small></div>
      <div class="stat"><b>${ss.filter((s) => s.state === 'blocked').length}</b><small>need input</small></div>
      <div class="stat"><b>${money(cost(since(1)))}</b><small>coût est. aujourd'hui</small></div>
      <div class="stat"><b>${money(cost(since(7)))}</b><small>7 derniers jours</small></div>
      <div class="stat"><b>${money(cost(ss))}</b><small>total · ${ss.length} sessions</small></div>
      <div class="stat"><b>${fmtMs(avgMs)}</b><small>durée moyenne</small></div>
    </div>
    <p class="muted small" style="margin:-6px 0 14px">Coûts estimés au prix API (tokens du transcript × tarif du modèle, cache inclus) — ton siège Enterprise n'est pas facturé ainsi.</p>
    <div class="grid2" style="margin-bottom:16px">
      <div class="panel" style="margin:0"><h2>Coût / jour (14 j)</h2><div class="bars" style="margin-bottom:14px">${perDay.map((n, i) => `<div style="height:${(n / maxDay) * 100}%" title="${money(n)}"><span>${i % 2 ? '' : new Date(days[i]).getDate()}</span></div>`).join('')}</div></div>
      <div class="panel" style="margin:0"><h2>Par chore</h2><div class="chorebars">${byChore.map(([k, c]) => `<span>${esc(label(k))} <span class="muted">×${c.n}</span></span><div class="b" style="width:${(c.cost / maxChore) * 100}%"></div><span class="cost">${money(c.cost)}</span>`).join('') || '<span class="muted">rien encore</span>'}</div></div>
    </div>
    <div class="panel"><div class="scroll"><table>
      <colgroup><col><col style="width:150px"><col style="width:130px"><col style="width:120px"><col style="width:80px"><col style="width:80px"><col style="width:90px"><col style="width:80px"><col style="width:150px"></colgroup>
      <thead><tr><th>Session</th><th>Chore</th><th>Modèle</th><th>État</th><th>Démarrée</th><th>Durée</th><th>Tokens</th><th>Coût est.</th><th></th></tr></thead>
      <tbody>${ss.map((s) => `<tr class="clickable" data-open-session="${s.id}">
        <td><div class="title mono">${esc(s.name)}</div><div class="sub">${esc(what(s))}</div></td>
        <td>${esc(label(s.chore))}</td>
        <td class="mono">${esc(s.model)} · ${esc(s.effort)}</td>
        <td>${sessionBadge(s)}${s.error ? `<div class="small" style="color:var(--err)">${esc(s.error)}</div>` : ''}</td>
        <td class="muted">${ago(s.started_at)}</td>
        <td class="muted">${dur(s.started_at, s.ended_at)}</td>
        <td class="mono">${kfmt(tokens(s))}<div class="muted small">${s.turns} tours</div></td>
        <td class="cost">${money(s.cost_usd)}</td>
        <td><div class="row-actions">${rcLink(s)} ${['starting', 'running', 'working', 'busy', 'blocked', 'idle', 'done'].includes(s.state) ? `<button class="ghost" data-stop="${s.id}">stop</button>` : ''}</div></td>
      </tr>`).join('') || '<tr><td colspan="9" class="empty">Aucune session lancée.</td></tr>'}</tbody></table></div></div>`;
}

// ---- session drawer: read the conversation and answer it -------------------
let openSession = null;
let convoTimer = null;
async function loadConvo() {
  if (!openSession) return;
  const res = await fetch(`/api/sessions/${openSession}/transcript`);
  if (!res.ok) return;
  const { session: s, items } = await res.json();
  $('#sTitle').textContent = s.name;
  $('#sMeta').innerHTML = `${sessionBadge(s)} · ${esc(s.model)} · ${esc(s.effort)} · ${s.turns} tours · <span class="cost">${money(s.cost_usd)}</span> · démarrée il y a ${ago(s.started_at)}`;
  $('#sLinks').innerHTML = `${rcLink(s)} ${['starting', 'running', 'working', 'busy', 'blocked'].includes(s.state) ? `<button class="ghost" data-stop="${s.id}">stop</button>` : ''}`;
  $('#sHint').textContent = s.state === 'blocked' ? 'Claude attend une réponse — ton message la débloque.'
    : ['running', 'working', 'busy', 'starting'].includes(s.state) ? 'Claude travaille : envoyer l’interrompt et reprend avec ton message.'
    : 'La session reprend avec ton message, contexte intact.';
  const el = $('#sConvo');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.innerHTML = items.map((m) => m.role === 'tool'
    ? `<div class="msg tool"><b>${esc(m.name)}</b> ${esc(m.text)}</div>`
    : `<div class="msg ${m.role}">${esc(m.text)}</div>`).join('') || '<div class="muted">La session démarre…</div>';
  if (atBottom) el.scrollTop = el.scrollHeight;
}
function openDrawer(id) {
  openSession = id;
  $('#sConvo').innerHTML = '';
  $('#sessionModal').showModal();
  loadConvo().then(() => { const el = $('#sConvo'); el.scrollTop = el.scrollHeight; });
  clearInterval(convoTimer);
  convoTimer = setInterval(loadConvo, 3000);
}
$('#sessionModal').addEventListener('close', () => { openSession = null; clearInterval(convoTimer); });
$('#sClose').onclick = () => $('#sessionModal').close();
async function sendReply(e) {
  e?.preventDefault();
  const text = $('#sText').value.trim();
  if (!text || !openSession) return;
  $('#sSend').disabled = true;
  try {
    await post(`/api/sessions/${openSession}/reply`, { text });
    $('#sText').value = '';
    toast('Message envoyé');
    setTimeout(loadConvo, 1500);
  } catch (err) { toast(err.message); } finally { $('#sSend').disabled = false; }
}
$('#sReply').addEventListener('submit', sendReply);
$('#sText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendReply(e); });

// ---- multi-ticket selection --------------------------------------------------
function renderSelbar() {
  const keys = [...SEL];
  $('#selbar').innerHTML = keys.length ? `<b>${keys.length} ticket${keys.length > 1 ? 's' : ''}</b><span class="keys">${keys.map(esc).join(', ')}</span>
    <button class="primary" id="batchBtn" ${keys.length < 2 ? 'disabled title="Choisis au moins 2 tickets"' : ''}>Session groupée</button>
    <button class="ghost" id="selClear">Vider</button>` : '';
}
document.addEventListener('change', (e) => {
  const key = e.target.dataset?.sel;
  if (!key) return;
  e.target.checked ? SEL.add(key) : SEL.delete(key);
  e.target.closest('tr')?.classList.toggle('picked', e.target.checked);
  renderSelbar();
});

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
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = S.sessions.filter((s) => new Date(s.started_at) >= start).reduce((a, s) => a + (s.cost_usd ?? 0), 0);
  $('#costToday').textContent = today ? `aujourd'hui ${money(today)}` : '';
  const sync = S.sync;
  $('#syncInfo').textContent = sync ? `sync il y a ${ago(sync.at)}${sync.errors.length ? ' · ⚠ erreur' : ''}` : 'sync…';
  $('#syncInfo').title = sync?.errors.join('\n') ?? '';
  const parts = [];
  if (S.jira.error && !S.jira.running) parts.push(`⚠ Jira : ${esc(S.jira.error)}`);
  if (sync?.errors.length) parts.push(`⚠ ${sync.errors.map(esc).join(' · ')}`);
  const blocked = S.sessions.filter((s) => s.state === 'blocked');
  if (blocked.length) parts.push(`<b>${blocked.length} session(s) attendent ta réponse :</b> ${blocked.map((s) => `<a href="#" data-open-session="${s.id}">${esc(s.name)}</a>`).join(', ')}`);
  $('#banner').innerHTML = parts.join('<br>');
  document.title = blocked.length ? `(${blocked.length}) Eric's AI Dashboard` : "Eric's AI Dashboard";
}

function render() {
  renderHeader(); renderTasks(); renderJira(); renderReviews(); renderSessions(); renderStack();
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
  $('#mSub').textContent = params.kind === 'review' ? `PR #${params.pr}` : params.kind === 'batch' ? `${params.tasks.split(',').length} tickets : ${params.tasks.replaceAll(',', ', ')} — un seul worktree sur master, une branche par ticket` : params.task ?? 'Session libre dans un nouveau worktree sur master';
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
    if (pending.kind === 'batch') { SEL.clear(); renderSelbar(); }
    toast('Session lancée');
  } catch (err) {
    toast(err.message);
  } finally {
    $('#mStart').disabled = false;
  }
});

// ---- events ----------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open-session]');
  if (open && !e.target.closest('button, a[target]')) { e.preventDefault(); return openDrawer(open.dataset.openSession); }
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'selClear') { SEL.clear(); renderSelbar(); return render(); }
  if (b.id === 'batchBtn') return openChore({ kind: 'batch', tasks: [...SEL].join(',') });
  try {
    if (b.dataset.chore && b.dataset.task) return openChore({ kind: 'task', task: b.dataset.task, chore: b.dataset.chore });
    if (b.dataset.review) return openChore({ kind: 'review', repo: b.dataset.repo, pr: b.dataset.review });
    if (b.dataset.term) { await post(`/api/sessions/${b.dataset.term}/terminal`); return toast('Ouvert dans le terminal'); }
    if (b.dataset.stop) { await post(`/api/sessions/${b.dataset.stop}/stop`); return toast('Session arrêtée'); }
    if (b.dataset.stackBranch) { await post('/api/stack/switch', { branch: b.dataset.stackBranch }); location.hash = 'stack'; return; }
    if (b.dataset.stackPr) { await post('/api/stack/switch', { pr: b.dataset.stackPr }); location.hash = 'stack'; return; }
    if (b.id === 'customBtn') return openChore({ kind: 'custom', chore: 'custom' });
    if (b.id === 'syncBtn') { b.disabled = true; await post('/api/sync').finally(() => (b.disabled = false)); return toast('GitHub synchronisé · Jira en cours'); }
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
    if (document.activeElement?.matches('select, input, textarea')) { renderHeader(); return; }
    render();
  });
  es.addEventListener('stacklog', (e) => { stackLog.push(JSON.parse(e.data)); if (stackLog.length > 400) stackLog = stackLog.slice(-400); renderStackLog(); });
  es.onerror = () => { $('#syncInfo').textContent = 'déconnecté du serveur…'; };
}
// ?snapshot: one fetch, no live stream (headless screenshots never settle on an open SSE).
if (new URLSearchParams(location.search).has('snapshot')) fetch('/api/state').then((r) => r.json()).then((d) => { S = d; stackLog = d.stack?.log ?? []; render(); });
else connect();
setInterval(() => S && !document.activeElement?.matches('select, textarea') && renderSessions(), 30_000);
