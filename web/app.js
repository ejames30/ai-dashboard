// Eric's AI Dashboard — one SSE state, eight pages, a filter bar on every list.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (s) => (window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parse(String(s ?? ''), { breaks: true })) : `<p>${esc(s)}</p>`);
const ago = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - new Date(ts)) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} j`;
};
const fmtMs = (ms) => { const m = Math.floor(ms / 60000); return !ms ? '–' : m < 1 ? `${Math.round(ms / 1000)}s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };
const dur = (a, b) => (a ? fmtMs((b ? new Date(b) : new Date()) - new Date(a)) : '–');
const kfmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0));
const money = (n) => (!n ? '–' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 3500); };
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const startOfDay = (daysBack = 0) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - daysBack); return d; };

async function post(path, body = {}) {
  const res = await fetch(path, { method: 'POST', headers: { 'X-Dashboard': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

let S = null;
let stackLog = [];

// ---- theme -------------------------------------------------------------------
const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
applyTheme(store.get('theme', null));
$('#themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next); store.set('theme', next);
};

// ---- pages -------------------------------------------------------------------
const PAGES = {
  home: ["Aujourd'hui", 'Tout ce qui attend une action, au même endroit'],
  tasks: ['Tâches', 'Tes PR et tes tickets en cours, avec la prochaine action suggérée'],
  jira: ['Jira', 'Tous les tickets qui te sont assignés'],
  epics: ['Epics & plans', 'Lance un plan sur un epic : Claude lit les tickets et le code, propose un découpage, attend ton go'],
  reviews: ['PR à relire', "Les PR ouvertes de l'équipe"],
  brutal: ['Brutal reviews', 'Chaque review faite par Claude : verdict, findings, coût'],
  sessions: ['Sessions', 'Chaque session Claude lancée depuis le dashboard'],
  stack: ['Stack local', 'Metro sur un checkout détaché, jamais ton clone principal'],
};
const pageFromHash = () => (PAGES[location.hash.slice(1)] ? location.hash.slice(1) : 'home');
function showPage(name) {
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.page === name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('on', p.id === `page-${name}`));
  $('#pageTitle').textContent = PAGES[name][0];
  $('#pageSub').textContent = PAGES[name][1];
}
document.querySelectorAll('#nav a').forEach((a) => (a.onclick = () => { location.hash = a.dataset.page; }));
window.addEventListener('hashchange', () => showPage(pageFromHash()));
showPage(pageFromHash());

// ---- filter bars -------------------------------------------------------------
// F[page] = { q, chips: {name: value}, sel: {name: value} } — remembered per browser.
const F = store.get('filters', {});
const fget = (page) => (F[page] ??= { q: '', chips: {}, sel: {} });
const saveF = () => store.set('filters', F);
const textMatch = (q, ...fields) => !q || fields.some((f) => String(f ?? '').toLowerCase().includes(q.toLowerCase()));

/** def: { search, chips: [{name, options: [[value, label, count]]}], selects: [{name, all, options: [[value, label]]}] } */
function filterBar(page, def) {
  const bar = $(`#f-${page}`);
  if (bar.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
  const f = fget(page);
  const chips = (def.chips ?? []).map((c) => `<div class="chips">${c.options.map(([v, label, n]) =>
    `<button data-fchip="${page}|${c.name}|${esc(v)}" class="${(f.chips[c.name] ?? c.options[0][0]) === v ? 'on' : ''}">${esc(label)}${n != null ? `<em>${n}</em>` : ''}</button>`).join('')}</div>`).join('');
  const selects = (def.selects ?? []).map((s) => `<select data-fsel="${page}|${s.name}"><option value="">${esc(s.all)}</option>${s.options.map(([v, l]) =>
    `<option value="${esc(v)}" ${f.sel[s.name] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`).join('');
  const dirty = f.q || Object.values(f.sel).some(Boolean) || Object.entries(f.chips).some(([k, v]) => v !== (def.chips ?? []).find((c) => c.name === k)?.options[0][0]);
  bar.innerHTML = `${def.search ? `<div class="search"><input type="search" data-fq="${page}" placeholder="${esc(def.search)}" value="${esc(f.q)}"></div>` : ''}${chips}${selects}
    ${def.extra ?? ''}${dirty ? `<button class="ghost reset" data-freset="${page}">Réinitialiser</button>` : ''}`;
}
const chip = (page, name, dflt) => fget(page).chips[name] ?? dflt;
const sel = (page, name) => fget(page).sel[name] ?? '';
const RENDER = {}; // page → results renderer, called on filter changes

document.addEventListener('input', (e) => {
  const page = e.target.dataset?.fq;
  if (!page) return;
  fget(page).q = e.target.value; saveF(); RENDER[page]?.();
});
document.addEventListener('change', (e) => {
  const k = e.target.dataset?.fsel;
  if (!k) return;
  const [page, name] = k.split('|');
  fget(page).sel[name] = e.target.value; saveF(); RENDER[page]?.(); e.target.blur();
});
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-fchip]');
  if (c) { const [page, name, v] = c.dataset.fchip.split('|'); fget(page).chips[name] = v; saveF(); return RENDER[page]?.(); }
  const r = e.target.closest('[data-freset]');
  if (r) { F[r.dataset.freset] = { q: '', chips: {}, sel: {} }; saveF(); RENDER[r.dataset.freset]?.(); }
});

// ---- shared bits ---------------------------------------------------------------
const LIVE = ['starting', 'running', 'working', 'busy'];
const ACTIVE = [...LIVE, 'blocked'];
const SESSION_STATE = {
  starting: ['live', 'démarre'], running: ['live', 'en cours'], working: ['live', 'en cours'], busy: ['live', 'en cours'],
  blocked: ['accent', 'attend ta réponse'], idle: ['info', 'en pause'], done: ['ok', 'terminé'],
  failed: ['err', 'échec'], error: ['err', 'échec'], stopped: ['', 'arrêté'], killed: ['', 'arrêté'], gone: ['', 'supprimé'],
};
const sessionBadge = (s) => {
  const [cls, label] = SESSION_STATE[s.state] ?? ['', s.state];
  return `<span class="badge ${cls}">${cls === 'live' ? '<span class="dot live"></span>' : ''}${esc(label)}</span>`;
};
const checksBadge = (c) => ({ SUCCESS: '<span class="badge ok">✓ checks</span>', FAILURE: '<span class="badge err">✗ checks</span>', ERROR: '<span class="badge err">✗ checks</span>', PENDING: '<span class="badge warn">◌ checks</span>', EXPECTED: '<span class="badge warn">◌ checks</span>' }[c] ?? '');
const decisionBadge = (d) => ({ APPROVED: '<span class="badge ok">approuvée</span>', CHANGES_REQUESTED: '<span class="badge err">changes demandés</span>', REVIEW_REQUIRED: '<span class="badge">review requise</span>' }[d] ?? '');
const sizeTag = (s) => (s ? `<span class="size ${s}">${s}</span>` : '');
const diffTag = (a, d) => `<span class="mono"><span class="add">+${a}</span> <span class="del">−${d}</span></span>`;
const costCell = (t) => (t.sessionCount ? `<span class="cost">${money(t.cost)}</span><div class="muted small">${t.sessionCount} session${t.sessionCount > 1 ? 's' : ''}</div>` : '<span class="faint small">–</span>');
const SEL = new Set(); // tickets picked for a multi-ticket session
const selCell = (key) => `<td class="sel"><input type="checkbox" data-sel="${esc(key)}" ${SEL.has(key) ? 'checked' : ''} aria-label="Sélectionner ${esc(key)}"></td>`;
const sessionLink = (s) => `<a href="#" data-open-session="${s.id}" title="Voir la conversation">${sessionBadge(s)}</a>`;
const termBtn = (s) => `<button class="ghost" data-term="${s.id}" title="claude attach dans Warp">⌘ Terminal</button>`;
const choreLabel = (k) => S.chores.find((c) => c.key === k)?.label ?? k;
const choreOptions = () => S.chores.filter((c) => !['ai-review', 'auto-review', 'batch', 'epic-plan'].includes(c.key)).map((c) => `<option value="${c.key}">${esc(c.label)}</option>`).join('');
const prState = (pr) => [
  checksBadge(pr.checks),
  pr.mergeable === 'CONFLICTING' ? '<span class="badge err">conflits</span>' : '',
  pr.unresolved_threads ? `<span class="badge warn">💬 ${pr.unresolved_threads}</span>` : '',
  decisionBadge(pr.review_decision),
  pr.is_draft ? '<span class="badge">draft</span>' : '',
].filter(Boolean).join(' ');
const project = (key) => key.split('-')[0];
const what = (s) => { try { const k = s.tasks && JSON.parse(s.tasks); if (k) return k.join(', '); } catch {} return s.title ?? s.task ?? s.epic ?? (s.pr ? `PR #${s.pr}` : 'session libre'); };

// ---- home ----------------------------------------------------------------------
function actionItems() {
  const items = [];
  for (const s of S.sessions.filter((x) => x.state === 'blocked')) {
    items.push({ c: 'pink', ico: '✋', t: `Claude attend ta réponse — ${what(s)}`, s: `${choreLabel(s.chore)} · ${s.model} · depuis ${ago(s.started_at)}`, a: `<button class="primary" data-open-session="${s.id}">Répondre</button> ${termBtn(s)}`, w: 0 });
  }
  for (const t of S.tasks.filter((x) => x.pr && x.next)) {
    const urgent = ['fix-conflicts', 'fix-checks', 'address-comments'].includes(t.next.key);
    items.push({ c: urgent ? 'rose' : 'violet', ico: urgent ? '⚠' : '→', t: `${t.key.startsWith('PR-') ? '' : `${t.key} · `}${t.issue?.summary ?? t.pr.title}`, s: `PR #${t.pr.number} · ${prState(t.pr).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}`, a: `<button class="chore" data-chore="${t.next.key}" data-task="${esc(t.key)}">${esc(t.next.label)}</button>`, w: urgent ? 1 : 3 });
  }
  for (const r of S.reviews.filter((x) => x.requested_me && !x.my_review)) {
    items.push({ c: 'sky', ico: '⇄', t: `Review demandée : #${r.number} ${r.title}`, s: `@${r.author} · ${sizeTag(r.size).replace(/<[^>]+>/g, '')} · ${r.additions + r.deletions} lignes`, a: `<button class="brutal" data-review="${r.number}" data-repo="${esc(r.repo)}">⚡ Brutal review</button> <a href="${esc(r.url)}" target="_blank">ouvrir ↗</a>`, w: 2 });
  }
  for (const r of S.reviewHistory.filter((x) => x.error && x.open)) {
    items.push({ c: 'rose', ico: '✗', t: `Review #${r.pr} non postée`, s: r.error, a: `<button data-review="${r.pr}" data-repo="${esc(r.repo)}" data-rchore="${r.chore}">Relancer</button>`, w: 1 });
  }
  return items.sort((a, b) => a.w - b.w);
}

function renderHome() {
  const ss = S.sessions;
  const cost = (list) => list.reduce((a, s) => a + (s.cost_usd ?? 0), 0);
  const today = ss.filter((s) => new Date(s.started_at) >= startOfDay());
  const live = ss.filter((s) => LIVE.includes(s.state));
  const blocked = ss.filter((s) => s.state === 'blocked');
  const myPrs = S.tasks.filter((t) => t.pr);
  const toReview = S.reviews.filter((r) => !r.my_review && !r.session);
  const rv7 = S.reviewHistory.filter((r) => new Date(r.started_at) >= startOfDay(6));
  const critical = rv7.reduce((a, r) => a + r.counts.critical, 0);
  const items = actionItems();
  $('#c-home').textContent = items.filter((i) => i.w <= 1).length || '';
  const h = new Date().getHours();
  const hello = h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir';

  $('#page-home').innerHTML = `
    <div class="hero"><h2>${hello} Eric 👋</h2>
      <p>${items.length ? `<b>${items.length}</b> chose${items.length > 1 ? 's' : ''} à traiter` : 'Rien ne t’attend — tout roule'} · ${live.length} session${live.length > 1 ? 's' : ''} en cours · ${myPrs.length} PR ouvertes · ${S.tasks.filter((t) => t.issue?.status_category === 'indeterminate').length} tickets en cours</p></div>
    <div class="kpis">
      <div class="kpi pink" data-go="sessions"><b>${blocked.length}</b><small>attendent ta réponse</small></div>
      <div class="kpi violet" data-go="sessions"><b>${live.length}</b><small>sessions en cours</small></div>
      <div class="kpi amber" data-go="tasks"><b>${myPrs.filter((t) => t.next).length}</b><small>de mes PR à faire avancer</small></div>
      <div class="kpi sky" data-go="reviews"><b>${toReview.length}</b><small>PR d'équipe sans review</small></div>
      <div class="kpi rose" data-go="brutal"><b>${critical}</b><small>findings critiques · 7 j</small></div>
      <div class="kpi emerald"><b>${money(cost(today))}</b><small>coût est. aujourd'hui · ${today.length} sessions</small></div>
    </div>
    <div class="grid2">
      <div>
        <div class="panel"><h2>⚡ À traiter maintenant <span class="count">${items.length}</span></h2><div class="feed">
          ${items.slice(0, 12).map((i) => `<div class="item c-${i.c}"><span class="ico">${i.ico}</span><div style="min-width:0"><div class="t">${esc(i.t)}</div><div class="s">${esc(i.s)}</div></div><div class="row-actions">${i.a}</div></div>`).join('') || '<div class="empty">Inbox zéro ✨</div>'}
          ${items.length > 12 ? `<div class="item"><span></span><a href="#tasks" class="small">+ ${items.length - 12} autres → Tâches</a><span></span></div>` : ''}
        </div></div>
      </div>
      <div>
        <div class="panel"><h2><span class="dot live"></span> En cours <span class="count">${live.length + blocked.length}</span></h2><div class="feed">
          ${[...blocked, ...live].map((s) => `<div class="item c-violet clickable" data-open-session="${s.id}"><span class="ico">▶</span><div style="min-width:0"><div class="t">${esc(what(s))}</div><div class="s">${esc(choreLabel(s.chore))} · ${esc(s.model)} · ${dur(s.started_at)} · ${money(s.cost_usd)}</div></div><div class="row-actions">${sessionBadge(s)}</div></div>`).join('') || '<div class="empty">Aucune session active.</div>'}
        </div></div>
        <div class="panel"><h2>⚡ Dernières brutal reviews</h2><div class="feed">
          ${S.reviewHistory.slice(0, 6).map((r) => `<div class="item c-pink clickable" data-go="brutal"><span class="ico">⚡</span><div style="min-width:0"><div class="t">#${r.pr} ${esc(r.title ?? '')}</div><div class="s">${r.author ? `@${esc(r.author)} · ` : ''}${r.chore === 'auto-review' ? 'auto, postée' : r.chore === 'self-review' ? 'self review' : 'brouillon'} · ${ago(r.started_at)}</div></div>${sevPills(r.counts)}</div>`).join('') || '<div class="empty">Aucune review encore.</div>'}
        </div></div>
      </div>
    </div>`;
}

// ---- tasks ---------------------------------------------------------------------
const TASK_STATES = [
  ['all', 'Tout'], ['action', 'Action requise', (t) => t.next], ['checks', 'Checks KO', (t) => ['FAILURE', 'ERROR'].includes(t.pr?.checks)],
  ['conflicts', 'Conflits', (t) => t.pr?.mergeable === 'CONFLICTING'], ['comments', 'Commentaires', (t) => t.pr?.unresolved_threads > 0],
  ['draft', 'Draft', (t) => t.pr?.is_draft], ['nopr', 'Sans PR', (t) => !t.pr], ['running', 'Session active', (t) => t.sessions.some((s) => ACTIVE.includes(s.state))],
];
function renderTasks() {
  const all = S.tasks.filter((t) => t.pr || t.issue?.status_category === 'indeterminate' || t.sessions.length);
  $('#c-tasks').textContent = all.length || '';
  const projects = [...new Set(all.map((t) => (t.key.startsWith('PR-') ? 'Sans ticket' : project(t.key))))].sort();
  filterBar('tasks', {
    search: 'Rechercher (clé, titre, branche)…',
    chips: [{ name: 'state', options: TASK_STATES.map(([k, l, fn]) => [k, l, fn ? all.filter(fn).length : all.length]) }],
    selects: [{ name: 'project', all: 'Tous les projets', options: projects.map((p) => [p, p]) }],
  });
  const f = fget('tasks');
  const fn = TASK_STATES.find(([k]) => k === chip('tasks', 'state', 'all'))?.[2];
  const pj = sel('tasks', 'project');
  const tasks = all.filter((t) => (!fn || fn(t)) && (!pj || (pj === 'Sans ticket' ? t.key.startsWith('PR-') : project(t.key) === pj))
    && textMatch(f.q, t.key, t.issue?.summary, t.pr?.title, t.pr?.head));
  if (!tasks.length) return ($('#r-tasks').innerHTML = `<div class="panel"><div class="empty">${all.length ? 'Aucune tâche ne correspond aux filtres.' : 'Aucune tâche. Configure Jira ou ouvre une PR.'}</div></div>`);
  $('#r-tasks').innerHTML = `<div class="panel"><div class="scroll"><table>
    <colgroup><col style="width:38px"><col style="width:34%"><col style="width:110px"><col><col style="width:150px"><col style="width:80px"><col style="width:260px"></colgroup>
    <thead><tr><th class="sel"></th><th>Tâche</th><th>PR</th><th>État</th><th>Dernière session</th><th>Coût est.</th><th style="text-align:right">Next action</th></tr></thead>
    <tbody>${tasks.map((t) => {
      const pr = t.pr, last = t.sessions[0];
      return `<tr class="${SEL.has(t.key) ? 'picked' : ''}">
        ${selCell(t.key)}
        <td><div class="title">${t.key.startsWith('PR-') ? '' : `<a class="key" href="${esc(`${S.jira.site}/browse/${t.key}`)}" target="_blank">${esc(t.key)}</a> `}${esc(t.issue?.summary ?? pr?.title)}</div>
          <div class="sub">${t.issue ? `${esc(t.issue.type)} · ${esc(t.issue.status)} · ` : ''}${pr ? `<span class="mono">${esc(pr.head)}</span>` : 'pas encore de PR'}</div></td>
        <td>${pr ? `<a href="${esc(pr.url)}" target="_blank">#${pr.number}</a> ${sizeTag(t.size)}<div class="small">${diffTag(pr.additions, pr.deletions)}</div>` : ''}</td>
        <td class="wrap">${pr ? prState(pr) : ''}</td>
        <td>${last ? `${sessionLink(last)}<div class="muted small">${esc(choreLabel(last.chore))} · ${ago(last.started_at)}</div>` : ''}</td>
        <td>${costCell(t)}</td>
        <td><div class="row-actions">
          ${t.next ? `<button class="chore" data-chore="${t.next.key}" data-task="${esc(t.key)}">${esc(t.next.label)}</button>` : ''}
          <select data-task-chore="${esc(t.key)}" title="Lancer une autre chore"><option value="">⋯</option>${choreOptions()}</select>
          ${last ? termBtn(last) : ''}
          ${pr ? `<button class="ghost" data-stack-branch="${esc(pr.head)}" title="Charger dans le stack local">▶</button>` : ''}
        </div></td></tr>`;
    }).join('')}</tbody></table></div></div>`;
}
RENDER.tasks = renderTasks;

// ---- jira ----------------------------------------------------------------------
const PRIO_CLASS = (p = '') => (/high|highest|critical|blocker|p1|p2/i.test(p) ? 'high' : /medium|p3/i.test(p) ? 'med' : '');
function renderJira() {
  const jira = S.jira;
  const issues = S.tasks.filter((t) => t.issue);
  $('#c-jira').textContent = issues.length || '';
  const uniq = (fn) => [...new Set(issues.map(fn).filter(Boolean))].sort();
  const info = jira.running ? '<span class="dot live"></span> sync Jira…'
    : jira.at ? `${jira.count} tickets · ${jira.source === 'token' ? 'API' : 'connecteur Atlassian'} · ${ago(jira.at)}${jira.cost ? ` · $${jira.cost.toFixed(2)}` : ''}` : 'pas encore synchronisé';
  filterBar('jira', {
    search: 'Rechercher un ticket (clé ou titre)…',
    chips: [{ name: 'cat', options: [['open', 'Tous', issues.length], ['indeterminate', 'En cours', issues.filter((t) => t.issue.status_category === 'indeterminate').length], ['new', 'À faire', issues.filter((t) => t.issue.status_category === 'new').length]] },
      { name: 'pr', options: [['any', 'PR : toutes'], ['with', 'Avec PR'], ['without', 'Sans PR']] }],
    selects: [
      { name: 'project', all: 'Projet', options: uniq((t) => project(t.key)).map((p) => [p, p]) },
      { name: 'type', all: 'Type', options: uniq((t) => t.issue.type).map((p) => [p, p]) },
      { name: 'prio', all: 'Priorité', options: uniq((t) => t.issue.priority).map((p) => [p, p]) },
      { name: 'epic', all: 'Epic', options: [...new Map(issues.filter((t) => t.issue.parent_key).map((t) => [t.issue.parent_key, `${t.issue.parent_key} · ${(t.issue.parent_summary ?? '').slice(0, 40)}`]))] },
    ],
    extra: `<span class="muted small">${info}</span>`,
  });
  const f = fget('jira');
  const cat = chip('jira', 'cat', 'open'), prf = chip('jira', 'pr', 'any');
  const shown = issues.filter((t) => (cat === 'open' || t.issue.status_category === cat)
    && (prf === 'any' || (prf === 'with') === !!t.pr)
    && (!sel('jira', 'project') || project(t.key) === sel('jira', 'project'))
    && (!sel('jira', 'type') || t.issue.type === sel('jira', 'type'))
    && (!sel('jira', 'prio') || t.issue.priority === sel('jira', 'prio'))
    && (!sel('jira', 'epic') || t.issue.parent_key === sel('jira', 'epic'))
    && textMatch(f.q, t.key, t.issue.summary));
  if (!issues.length) return ($('#r-jira').innerHTML = `<div class="panel"><div class="empty">${jira.running ? 'Lecture de tes tickets via le connecteur Atlassian (≈ 40 s)…' : jira.error ? `Erreur Jira : ${esc(jira.error)}` : 'Aucun ticket assigné.'}</div></div>`);
  if (!shown.length) return ($('#r-jira').innerHTML = '<div class="panel"><div class="empty">Aucun ticket ne correspond aux filtres.</div></div>');
  const order = { indeterminate: 0, new: 1 };
  const groups = new Map();
  [...shown].sort((a, b) => (order[a.issue.status_category] ?? 2) - (order[b.issue.status_category] ?? 2) || (b.issue.updated ?? '').localeCompare(a.issue.updated ?? ''))
    .forEach((t) => { const k = t.issue.status ?? '—'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
  $('#r-jira').innerHTML = [...groups].map(([status, list]) => `
    <div class="panel"><h2>${list[0].issue.status_category === 'indeterminate' ? '<span class="dot live"></span>' : '<span class="dot"></span>'} ${esc(status)} <span class="count">${list.length}</span></h2><div class="scroll"><table>
      <colgroup><col style="width:38px"><col style="width:100px"><col><col style="width:110px"><col style="width:100px"><col style="width:130px"><col style="width:150px"><col style="width:90px"><col style="width:260px"></colgroup>
      <tbody>${list.map((t) => {
        const i = t.issue, pr = t.pr, last = t.sessions[0];
        const primary = t.next ?? { key: pr ? 'custom' : 'start-task', label: pr ? 'Lancer Claude' : 'Démarrer la tâche' };
        return `<tr class="${SEL.has(t.key) ? 'picked' : ''}">
          ${selCell(t.key)}
          <td><a class="key" href="${esc(i.url)}" target="_blank">${esc(t.key)}</a></td>
          <td><div class="title">${esc(i.summary)}</div><div class="sub">${i.parent_key ? `✦ ${esc(i.parent_key)} ${esc(i.parent_summary ?? '')} · ` : ''}mis à jour il y a ${ago(i.updated)}</div></td>
          <td class="small">${esc(i.type)}</td>
          <td class="prio ${PRIO_CLASS(i.priority)}">${esc(i.priority ?? '')}</td>
          <td>${pr ? `<a href="${esc(pr.url)}" target="_blank">#${pr.number}</a> ${checksBadge(pr.checks)}` : '<span class="faint small">pas de PR</span>'}</td>
          <td>${last ? sessionLink(last) : ''}</td>
          <td>${costCell(t)}</td>
          <td><div class="row-actions">
            <button class="chore" data-chore="${primary.key}" data-task="${esc(t.key)}">${esc(primary.label)}</button>
            <select data-task-chore="${esc(t.key)}" title="Lancer une autre chore"><option value="">⋯</option>${choreOptions()}</select>
          </div></td></tr>`;
      }).join('')}</tbody></table></div></div>`).join('');
}
RENDER.jira = renderJira;

// ---- epics ---------------------------------------------------------------------
function renderEpics() {
  const epics = S.epics ?? [];
  $('#c-epics').textContent = epics.filter((e) => e.plans.some((p) => ACTIVE.includes(p.state))).length || '';
  filterBar('epics', {
    search: 'Rechercher un epic…',
    chips: [{ name: 'scope', options: [['mine', 'Avec mes tickets', epics.filter((e) => e.mine.length).length], ['all', 'Tous', epics.length], ['planned', 'Planifiés', epics.filter((e) => e.plans.length).length]] }],
    selects: [{ name: 'project', all: 'Projet', options: [...new Set(epics.map((e) => project(e.key)))].sort().map((p) => [p, p]) }],
    extra: '<div class="planbar"><input id="epicKey" placeholder="MO-1234" aria-label="Clé d’epic"><button class="primary" id="epicGo">✦ Planifier</button></div>',
  });
  const f = fget('epics');
  const scope = chip('epics', 'scope', 'mine');
  const shown = epics.filter((e) => (scope === 'all' || (scope === 'mine' ? e.mine.length : e.plans.length))
    && (!sel('epics', 'project') || project(e.key) === sel('epics', 'project'))
    && textMatch(f.q, e.key, e.summary, ...e.mine.map((m) => m.summary)));
  if (!epics.length) return ($('#r-epics').innerHTML = '<div class="panel"><div class="empty">Pas encore d’epics — ils arrivent au prochain sync Jira (bouton ⟳ Sync). Tu peux déjà planifier un epic par sa clé ci-dessus.</div></div>');
  if (!shown.length) return ($('#r-epics').innerHTML = '<div class="panel"><div class="empty">Aucun epic ne correspond aux filtres.</div></div>');
  $('#r-epics').innerHTML = `<div class="epics">${shown.map((e) => {
    const plan = e.plans[0];
    return `<div class="epic">
      <div><a class="key" href="${esc(e.url)}" target="_blank">${esc(e.key)}</a> ${e.status ? `<span class="badge ${e.status_category === 'indeterminate' ? 'live' : ''}">${esc(e.status)}</span>` : ''}</div>
      <h3>${esc(e.summary ?? '(sans titre)')}</h3>
      ${e.mine.length ? `<ul>${e.mine.slice(0, 6).map((m) => `<li><span class="dot ${m.status_category === 'indeterminate' ? 'live' : ''}"></span><span class="mono">${esc(m.key)}</span> <span class="muted">${esc(m.summary)}</span></li>`).join('')}${e.mine.length > 6 ? `<li class="faint">+ ${e.mine.length - 6} autres</li>` : ''}</ul>` : '<div class="faint small">Aucun de tes tickets dedans</div>'}
      <div class="foot">
        ${plan ? `<button data-open-session="${plan.id}">📄 Voir le plan</button> ${sessionBadge(plan)} <span class="cost muted">${money(plan.cost_usd)}</span>` : ''}
        <span class="spacer"></span>
        <button class="${plan ? '' : 'primary'}" data-epic="${esc(e.key)}">✦ ${plan ? 'Replanifier' : 'Planifier'}</button>
      </div></div>`;
  }).join('')}</div>`;
}
RENDER.epics = renderEpics;

// ---- PR à relire -------------------------------------------------------------------
const REVIEW_STATES = [
  ['all', 'Toutes'], ['todo', 'Pas relues', (r) => !r.my_review && !r.session], ['running', 'Review en cours', (r) => r.session && ACTIVE.includes(r.session.state)],
  ['done', 'Relues par Claude', (r) => r.session?.posted_url], ['outdated', 'Nouveaux commits', (r) => r.outdated], ['mine', 'Ma review', (r) => r.my_review],
];
const MY = { PENDING: ['warn', 'brouillon à soumettre'], APPROVED: ['ok', 'approuvée'], CHANGES_REQUESTED: ['err', 'changes demandés'], COMMENTED: ['info', 'commentée'] };
function renderReviews() {
  const all = S.reviews;
  $('#c-reviews').textContent = all.filter((r) => !r.my_review && !r.session).length || '';
  const authors = [...new Set(all.map((r) => r.author))].sort();
  const a = S.autoReview;
  filterBar('reviews', {
    search: 'Rechercher (#, titre, auteur)…',
    chips: [
      { name: 'state', options: REVIEW_STATES.map(([k, l, fn]) => [k, l, fn ? all.filter(fn).length : all.length]) },
      { name: 'size', options: [['all', 'Taille'], ...['S', 'M', 'L', 'XL'].map((s) => [s, s, all.filter((r) => r.size === s).length])] },
    ],
    selects: [{ name: 'author', all: 'Tous les auteurs', options: authors.map((x) => [x, `@${x}${a?.authors.includes(x) ? ' ⚡' : ''}`]) }],
    extra: a?.enabled ? `<span class="badge pink" title="Nouvelles PR prêtes de ${esc(a.authors.join(', '))} : brutal review postée automatiquement">⚡ auto ON · ${a.authors.length} auteurs</span>` : '',
  });
  const f = fget('reviews');
  const fn = REVIEW_STATES.find(([k]) => k === chip('reviews', 'state', 'all'))?.[2];
  const size = chip('reviews', 'size', 'all');
  const reviews = all.filter((r) => (!fn || fn(r)) && (size === 'all' || r.size === size) && (!sel('reviews', 'author') || r.author === sel('reviews', 'author'))
    && textMatch(f.q, `#${r.number}`, r.title, r.author));
  if (!reviews.length) return ($('#r-reviews').innerHTML = `<div class="panel"><div class="empty">${all.length ? 'Aucune PR ne correspond aux filtres.' : 'Aucune PR de collègue ouverte.'}</div></div>`);
  $('#r-reviews').innerHTML = `<div class="panel"><div class="scroll"><table>
    <colgroup><col><col style="width:130px"><col style="width:110px"><col style="width:150px"><col style="width:190px"><col style="width:330px"></colgroup>
    <thead><tr><th>PR</th><th>Taille</th><th>Checks</th><th>Ma review</th><th>Brutal review</th><th></th></tr></thead>
    <tbody>${reviews.map((r) => {
      const s = r.session, my = MY[r.my_review];
      return `<tr>
        <td><div class="title"><a href="${esc(r.url)}" target="_blank">#${r.number}</a> ${esc(r.title)}</div>
          <div class="sub">@${esc(r.author)}${r.auto ? ' ⚡' : ''} · ${ago(r.updated)}${r.requested_me ? ' · <b style="color:var(--sky)">review demandée</b>' : ''}</div></td>
        <td>${sizeTag(r.size)} ${diffTag(r.additions, r.deletions)}<div class="muted small">${r.changed_files} fichiers</div></td>
        <td>${checksBadge(r.checks)}</td>
        <td>${my ? `<span class="badge ${my[0]}">${my[1]}</span>` : ''}</td>
        <td>${s ? `${sessionLink(s)} ${r.outdated ? '<span class="badge warn" title="Nouveaux commits depuis la review">obsolète</span>' : ''}${s.error ? `<div class="small" style="color:var(--rose)">${esc(s.error)}</div>` : ''}` : ''}</td>
        <td><div class="row-actions">
          ${s?.posted_url ? `<a href="${esc(s.posted_url)}" target="_blank">${s.chore === 'auto-review' ? 'postée' : 'brouillon'} ↗</a>` : ''}
          <button class="brutal" data-review="${r.number}" data-repo="${esc(r.repo)}" data-rchore="auto-review" title="Brutal review postée directement sur la PR">⚡ Poster</button>
          <button data-review="${r.number}" data-repo="${esc(r.repo)}" title="Brutal review en brouillon GitHub, tu soumets toi-même">Brouillon</button>
          <button class="ghost" data-stack-pr="${r.number}" title="Charger dans le stack local">▶</button>
        </div></td></tr>`;
    }).join('')}</tbody></table></div></div>`;
}
RENDER.reviews = renderReviews;

// ---- brutal reviews ----------------------------------------------------------------
const sevPills = (c) => `<span class="sev"><span class="c ${c.critical ? '' : 'z'}">${c.critical} crit</span><span class="w ${c.warning ? '' : 'z'}">${c.warning} warn</span><span class="s ${c.suggestion ? '' : 'z'}">${c.suggestion} sugg</span></span>`;
const SEV_LABEL = { critical: '🚨 Critical', warning: '⚠️ Warning', suggestion: '💡 Suggestion' };
function renderBrutal() {
  const all = S.reviewHistory ?? [];
  $('#c-brutal').textContent = all.filter((r) => new Date(r.started_at) >= startOfDay()).length || '';
  const authors = [...new Set(all.map((r) => r.author).filter(Boolean))].sort();
  filterBar('brutal', {
    search: 'Rechercher (#, titre, auteur, fichier, finding)…',
    chips: [
      { name: 'kind', options: [['all', 'Toutes', all.length], ['auto-review', 'Auto postées', all.filter((r) => r.chore === 'auto-review').length], ['ai-review', 'Brouillons', all.filter((r) => r.chore === 'ai-review').length], ['self-review', 'Self review', all.filter((r) => r.chore === 'self-review').length]] },
      { name: 'sev', options: [['all', 'Sévérité'], ['critical', '🚨 avec critique', all.filter((r) => r.counts.critical).length], ['clean', '✓ clean', all.filter((r) => r.summary && !r.comments.length).length]] },
      { name: 'when', options: [['all', 'Toujours'], ['1', "Aujourd'hui"], ['7', '7 jours']] },
    ],
    selects: [{ name: 'author', all: 'Tous les auteurs', options: authors.map((x) => [x, `@${x}`]) }],
  });
  const f = fget('brutal');
  const kind = chip('brutal', 'kind', 'all'), sev = chip('brutal', 'sev', 'all'), when = chip('brutal', 'when', 'all');
  const list = all.filter((r) => (kind === 'all' || r.chore === kind)
    && (sev === 'all' || (sev === 'critical' ? r.counts.critical : r.summary && !r.comments.length))
    && (when === 'all' || new Date(r.started_at) >= startOfDay(Number(when) - 1))
    && (!sel('brutal', 'author') || r.author === sel('brutal', 'author'))
    && textMatch(f.q, `#${r.pr}`, r.title, r.author, r.summary, ...r.comments.map((c) => `${c.path} ${c.body}`)));
  const sum = (k) => list.reduce((a, r) => a + r.counts[k], 0);
  const posted = list.filter((r) => r.posted_url).length;
  $('#r-brutal').innerHTML = `
    <div class="kpis">
      <div class="kpi pink"><b>${list.length}</b><small>reviews</small></div>
      <div class="kpi emerald"><b>${posted}</b><small>postées / brouillons créés</small></div>
      <div class="kpi rose"><b>${sum('critical')}</b><small>findings critiques</small></div>
      <div class="kpi amber"><b>${sum('warning')}</b><small>warnings</small></div>
      <div class="kpi sky"><b>${sum('suggestion')}</b><small>suggestions</small></div>
      <div class="kpi violet"><b>${money(list.reduce((a, r) => a + (r.cost_usd ?? 0), 0))}</b><small>coût est. · ${money(list.length ? list.reduce((a, r) => a + (r.cost_usd ?? 0), 0) / list.length : 0)} / review</small></div>
    </div>
    <div class="panel">${list.map((r) => `<div class="rv">
      <div class="rv-head">
        <span class="ico c-pink" style="width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:var(--pink-s);color:var(--pink)">⚡</span>
        <div class="grow">
          <div class="title">${r.url ? `<a href="${esc(r.url)}" target="_blank">#${r.pr}</a>` : `#${r.pr ?? '?'}`} ${esc(r.title ?? '')}</div>
          <div class="sub">${r.author ? `@${esc(r.author)} · ` : ''}${r.chore === 'auto-review' ? '<span class="badge pink">auto · postée</span>' : r.chore === 'self-review' ? '<span class="badge ai">self review</span>' : '<span class="badge">brouillon</span>'} · ${ago(r.started_at)} · ${esc(r.model)} · <span class="cost">${money(r.cost_usd)}</span>${r.outdated ? ' · <span class="badge warn">nouveaux commits depuis</span>' : ''}${!r.open && r.pr ? ' · <span class="faint">PR fermée</span>' : ''}</div>
        </div>
        ${r.summary ? sevPills(r.counts) : sessionBadge(r)}
        <div class="row-actions">
          ${r.posted_url ? `<a href="${esc(r.posted_url)}" target="_blank">GitHub ↗</a>` : ''}
          <button class="ghost" data-open-session="${r.id}">Conversation</button>
          ${r.open && r.chore !== 'self-review' ? `<button class="brutal" data-review="${r.pr}" data-repo="${esc(r.repo)}" data-rchore="${r.chore}">↻ Relancer</button>` : ''}
        </div>
      </div>
      ${r.error ? `<div class="small" style="color:var(--rose);margin-top:8px">✗ ${esc(r.error)}</div>` : ''}
      ${r.summary ? `<div class="verdict md">${md(r.summary)}</div>` : ''}
      ${r.comments.length ? `<details class="findings"><summary>${r.comments.length} finding${r.comments.length > 1 ? 's' : ''}</summary>
        ${['critical', 'warning', 'suggestion'].flatMap((sv) => r.comments.filter((c) => c.severity === sv)).map((c) => `<div class="finding ${esc(c.severity)}"><div class="loc">${SEV_LABEL[c.severity] ?? ''} · ${esc(c.path)}:${esc(c.line)}</div><div class="md">${md(c.body)}</div></div>`).join('')}</details>` : ''}
    </div>`).join('') || '<div class="empty">Aucune brutal review ne correspond.</div>'}</div>`;
}
RENDER.brutal = renderBrutal;

// ---- sessions ----------------------------------------------------------------------
function renderSessions() {
  const ss = S.sessions;
  const live = ss.filter((s) => ACTIVE.includes(s.state));
  $('#c-sessions').textContent = live.length || '';
  const cost = (list) => list.reduce((a, s) => a + (s.cost_usd ?? 0), 0);
  filterBar('sessions', {
    search: 'Rechercher (nom, ticket, PR, titre)…',
    chips: [
      { name: 'state', options: [['all', 'Toutes', ss.length], ['active', 'Actives', live.length], ['blocked', 'Attendent', ss.filter((s) => s.state === 'blocked').length], ['done', 'Terminées', ss.filter((s) => s.state === 'done').length], ['failed', 'Échecs', ss.filter((s) => ['failed', 'error'].includes(s.state) || s.error).length]] },
      { name: 'when', options: [['all', 'Toujours'], ['1', "Aujourd'hui"], ['7', '7 jours'], ['30', '30 jours']] },
    ],
    selects: [
      { name: 'chore', all: 'Toutes les chores', options: [...new Set(ss.map((s) => s.chore))].map((k) => [k, choreLabel(k)]) },
      { name: 'model', all: 'Tous les modèles', options: [...new Set(ss.map((s) => s.model))].map((m) => [m, m]) },
    ],
  });
  const f = fget('sessions');
  const st = chip('sessions', 'state', 'all'), when = chip('sessions', 'when', 'all');
  const list = ss.filter((s) => (st === 'all' || (st === 'active' ? ACTIVE.includes(s.state) : st === 'failed' ? ['failed', 'error'].includes(s.state) || s.error : s.state === st))
    && (when === 'all' || new Date(s.started_at) >= startOfDay(Number(when) - 1))
    && (!sel('sessions', 'chore') || s.chore === sel('sessions', 'chore'))
    && (!sel('sessions', 'model') || s.model === sel('sessions', 'model'))
    && textMatch(f.q, s.name, s.task, s.tasks, s.title, s.epic, s.pr && `#${s.pr}`));
  const finished = list.filter((s) => s.ended_at);
  const avgMs = finished.length ? finished.reduce((a, s) => a + (new Date(s.ended_at) - new Date(s.started_at)), 0) / finished.length : 0;
  const days = [...Array(14)].map((_, i) => startOfDay(13 - i).toDateString());
  const perDay = days.map((d) => cost(list.filter((s) => new Date(s.started_at).toDateString() === d)));
  const maxDay = Math.max(0.01, ...perDay);
  const byChore = Object.entries(list.reduce((m, s) => { const c = (m[s.chore] ??= { n: 0, cost: 0 }); c.n += 1; c.cost += s.cost_usd ?? 0; return m; }, {})).sort((a, b) => b[1].cost - a[1].cost);
  const maxChore = Math.max(0.01, ...byChore.map(([, c]) => c.cost));
  const tokens = (s) => s.input_tokens + s.output_tokens + s.cache_write_tokens;
  $('#r-sessions').innerHTML = `
    <div class="kpis">
      <div class="kpi violet"><b>${list.filter((s) => LIVE.includes(s.state)).length}</b><small>en cours</small></div>
      <div class="kpi pink"><b>${list.filter((s) => s.state === 'blocked').length}</b><small>attendent ta réponse</small></div>
      <div class="kpi emerald"><b>${money(cost(list.filter((s) => new Date(s.started_at) >= startOfDay())))}</b><small>coût est. aujourd'hui</small></div>
      <div class="kpi sky"><b>${money(cost(list.filter((s) => new Date(s.started_at) >= startOfDay(6))))}</b><small>7 derniers jours</small></div>
      <div class="kpi amber"><b>${money(cost(list))}</b><small>sélection · ${list.length} sessions</small></div>
      <div class="kpi"><b>${fmtMs(avgMs)}</b><small>durée moyenne</small></div>
    </div>
    <div class="grid2">
      <div class="panel"><h2>Coût / jour · 14 j</h2><div class="bars">${perDay.map((n, i) => `<div style="height:${(n / maxDay) * 100}%" title="${money(n)}"><span>${i % 2 ? '' : new Date(days[i]).getDate()}</span></div>`).join('')}</div></div>
      <div class="panel"><h2>Par chore</h2><div class="hbars">${byChore.map(([k, c]) => `<span>${esc(choreLabel(k))} <span class="faint">×${c.n}</span></span><div class="b" style="width:${(c.cost / maxChore) * 100}%"></div><span class="cost">${money(c.cost)}</span>`).join('') || '<span class="muted">rien encore</span>'}</div></div>
    </div>
    <p class="faint small" style="margin:-4px 2px 14px">Coûts estimés au prix API (tokens du transcript × tarif du modèle, cache inclus) — ton siège Enterprise n'est pas facturé ainsi.</p>
    <div class="panel"><div class="scroll"><table>
      <colgroup><col><col style="width:160px"><col style="width:130px"><col style="width:150px"><col style="width:80px"><col style="width:80px"><col style="width:90px"><col style="width:80px"><col style="width:170px"></colgroup>
      <thead><tr><th>Session</th><th>Chore</th><th>Modèle</th><th>État</th><th>Démarrée</th><th>Durée</th><th>Tokens</th><th>Coût est.</th><th></th></tr></thead>
      <tbody>${list.map((s) => `<tr class="clickable" data-open-session="${s.id}">
        <td><div class="title">${esc(what(s))}</div><div class="sub mono">${esc(s.name)}</div></td>
        <td>${esc(choreLabel(s.chore))}</td>
        <td class="mono">${esc(s.model)} · ${esc(s.effort)}</td>
        <td>${sessionBadge(s)}${s.error ? `<div class="small" style="color:var(--rose)">${esc(s.error)}</div>` : ''}</td>
        <td class="muted">${ago(s.started_at)}</td>
        <td class="muted">${dur(s.started_at, s.ended_at)}</td>
        <td class="mono">${kfmt(tokens(s))}<div class="faint small">${s.turns} tours</div></td>
        <td class="cost">${money(s.cost_usd)}</td>
        <td><div class="row-actions">${termBtn(s)} ${ACTIVE.includes(s.state) || ['idle', 'done'].includes(s.state) ? `<button class="ghost" data-stop="${s.id}">stop</button>` : ''}</div></td>
      </tr>`).join('') || '<tr><td colspan="9" class="empty">Aucune session ne correspond.</td></tr>'}</tbody></table></div></div>`;
}
RENDER.sessions = renderSessions;

// ---- session drawer --------------------------------------------------------------
let openSession = null;
let convoTimer = null;
async function loadConvo() {
  if (!openSession) return;
  const res = await fetch(`/api/sessions/${openSession}/transcript`);
  if (!res.ok) return;
  const { session: s, items } = await res.json();
  $('#sTitle').textContent = what(s);
  $('#sMeta').innerHTML = `${sessionBadge(s)} · ${esc(choreLabel(s.chore))} · ${esc(s.model)} · ${esc(s.effort)} · ${s.turns} tours · <span class="cost">${money(s.cost_usd)}</span> · il y a ${ago(s.started_at)}`;
  $('#sLinks').innerHTML = `${termBtn(s)}${s.rc_url ? ` <a href="${esc(s.rc_url)}" target="_blank" class="small muted">web ↗</a>` : ''} ${ACTIVE.includes(s.state) ? `<button class="ghost" data-stop="${s.id}">stop</button>` : ''}`;
  $('#sHint').textContent = s.state === 'blocked' ? 'Claude attend une réponse — ton message la débloque.'
    : LIVE.includes(s.state) ? 'Claude travaille : envoyer l’interrompt et reprend avec ton message.' : 'La session reprend avec ton message, contexte intact.';
  const el = $('#sConvo');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  const sig = `${items.length}:${items.at(-1)?.text?.length ?? 0}`;
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.innerHTML = items.map((m) => m.role === 'tool' ? `<div class="msg tool"><b>${esc(m.name)}</b> ${esc(m.text)}</div>`
      : m.role === 'assistant' ? `<div class="msg assistant md">${md(m.text)}</div>` : `<div class="msg user">${esc(m.text)}</div>`).join('') || '<div class="muted">La session démarre…</div>';
    if (atBottom) el.scrollTop = el.scrollHeight;
  }
}
function openDrawer(id) {
  openSession = id;
  const el = $('#sConvo'); el.innerHTML = ''; el.dataset.sig = '';
  $('#sessionModal').showModal();
  loadConvo().then(() => { el.scrollTop = el.scrollHeight; });
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

// ---- multi-ticket selection --------------------------------------------------------
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

// ---- stack -------------------------------------------------------------------------
function renderStack() {
  const st = S.stack;
  if (!st) return ($('#page-stack').innerHTML = '<div class="panel"><div class="empty">Aucun repo avec un stack configuré.</div></div>');
  $('#stackDot').className = `dot ${st.busy ? 'warn' : st.running ? 'ok' : ''}`;
  if ($('#page-stack').contains(document.activeElement) && document.activeElement.matches('select')) return renderStackLog();
  const cur = st.current;
  const options = [
    ...S.tasks.filter((t) => t.pr).map((t) => `<option value="b:${esc(t.pr.head)}">${esc(t.key)} — ${esc(t.pr.head)}</option>`),
    ...S.reviews.map((r) => `<option value="p:${r.number}">PR #${r.number} @${esc(r.author)} — ${esc(r.title.slice(0, 50))}</option>`),
    '<option value="b:master">master</option>',
  ].join('');
  $('#page-stack').innerHTML = `
    <div class="panel"><h2>Stack local</h2>
      <div class="stackbar">
        <span class="dot ${st.busy ? 'warn' : st.running ? 'ok' : ''}"></span>
        <b>${st.busy ? `${esc(st.busy)}…` : st.running ? `Metro tourne · port ${st.port}` : 'arrêté'}</b>
        <span class="muted">${cur ? `${esc(cur.branch ?? `PR #${cur.pr}`)} @ <span class="mono">${esc(cur.sha)}</span> · ${ago(cur.at)}` : 'aucune branche chargée'}</span>
        <span class="spacer"></span>
        <select id="stackRef">${options}</select>
        <button id="stackSwitch" ${st.busy ? 'disabled' : ''}>Charger</button>
        <button id="stackRefresh" ${!cur || st.busy ? 'disabled' : ''} title="Récupérer les derniers commits (hot reload)">⟳ Refresh</button>
        ${st.running ? '<button id="stackStop">Stop</button>' : `<button class="primary" id="stackStart" ${st.busy ? 'disabled' : ''}>Start</button>`}
      </div>
      <div class="faint small" style="padding:0 16px 10px">Checkout détaché dans <span class="mono">${esc(st.path)}</span>${st.exists ? '' : ' (créé + pnpm install au premier usage)'}.</div>
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

// ---- chrome --------------------------------------------------------------------------
function renderChrome() {
  const today = S.sessions.filter((s) => new Date(s.started_at) >= startOfDay()).reduce((a, s) => a + (s.cost_usd ?? 0), 0);
  $('#costToday').textContent = money(today) === '–' ? '$0.00' : money(today);
  const sync = S.sync;
  $('#syncInfo').textContent = sync ? `sync il y a ${ago(sync.at)}${sync.errors.length ? ' · ⚠ erreur' : ''}` : 'sync…';
  $('#syncInfo').title = sync?.errors.join('\n') ?? '';
  const parts = [];
  if (S.jira.error && !S.jira.running) parts.push(`⚠ Jira : ${esc(S.jira.error)}`);
  if (sync?.errors.length) parts.push(`⚠ ${sync.errors.map(esc).join(' · ')}`);
  $('#banner').innerHTML = parts.join('<br>');
  const blocked = S.sessions.filter((s) => s.state === 'blocked').length;
  document.title = blocked ? `(${blocked}) Eric's AI Dashboard` : "Eric's AI Dashboard";
}

function render() {
  renderChrome();
  for (const fn of [renderHome, renderTasks, renderJira, renderEpics, renderReviews, renderBrutal, renderSessions, renderStack]) {
    try { fn(); } catch (e) { console.error(fn.name, e); }
  }
}

// ---- chore modal ---------------------------------------------------------------------
let pending = null;
async function openChore(params) {
  const res = await fetch(`/api/chore?${new URLSearchParams(params)}`);
  const d = await res.json();
  if (!res.ok) return toast(d.error);
  pending = params;
  $('#mTitle').textContent = d.label;
  $('#mSub').textContent = params.kind === 'review' ? `PR #${params.pr}`
    : params.kind === 'epic' ? `Epic ${params.epic} — worktree détaché sur master, lecture seule jusqu’à ton go`
    : params.kind === 'batch' ? `${params.tasks.split(',').length} tickets : ${params.tasks.replaceAll(',', ', ')} — un worktree, une branche par ticket`
    : params.task ?? 'Session libre dans un nouveau worktree sur master';
  $('#mModel').innerHTML = S.models.map((m) => `<option ${m === d.model ? 'selected' : ''}>${m}</option>`).join('');
  $('#mEffort').innerHTML = S.efforts.map((e) => `<option ${e === d.effort ? 'selected' : ''}>${e}</option>`).join('');
  $('#mPrompt').value = d.prompt;
  $('#mNote').textContent = params.kind === 'review'
    ? (params.chore === 'auto-review' ? '⚡ Lecture seule. La review sera POSTÉE telle quelle sur la PR dès qu’elle est finie.' : 'Lecture seule. Le dashboard en fait un brouillon GitHub que tu relis et soumets toi-même.')
    : params.kind === 'epic' ? 'Claude lit l’epic, ses tickets, Confluence et le code sans te demander, puis te rend le plan ici. Rien n’est modifié avant ton go.'
    : 'Session Claude Code locale en arrière-plan : réponds-lui ici, ou ouvre-la dans le terminal.';
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
    toast('Session lancée 🚀');
  } catch (err) {
    toast(err.message);
  } finally {
    $('#mStart').disabled = false;
  }
});

// ---- events ------------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-go]');
  if (go && !e.target.closest('button, a')) { location.hash = go.dataset.go; return; }
  const open = e.target.closest('[data-open-session]');
  if (open && !e.target.closest('button:not([data-open-session]), a[target]')) { e.preventDefault(); return openDrawer(open.dataset.openSession); }
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'selClear') { SEL.clear(); renderSelbar(); return render(); }
  if (b.id === 'batchBtn') return openChore({ kind: 'batch', tasks: [...SEL].join(',') });
  try {
    if (b.dataset.chore && b.dataset.task) return openChore({ kind: 'task', task: b.dataset.task, chore: b.dataset.chore });
    if (b.dataset.review) return openChore({ kind: 'review', repo: b.dataset.repo, pr: b.dataset.review, ...(b.dataset.rchore === 'auto-review' ? { chore: 'auto-review' } : {}) });
    if (b.dataset.epic) return openChore({ kind: 'epic', epic: b.dataset.epic });
    if (b.id === 'epicGo') { const k = $('#epicKey').value.trim(); return k ? openChore({ kind: 'epic', epic: k }) : toast('Tape une clé d’epic, ex. MO-1234'); }
    if (b.dataset.term) { await post(`/api/sessions/${b.dataset.term}/terminal`); return toast('Ouvert dans Warp'); }
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
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'epicKey') $('#epicGo').click(); });
document.addEventListener('change', (e) => {
  const t = e.target.dataset.taskChore;
  if (t && e.target.value) { openChore({ kind: 'task', task: t, chore: e.target.value }); e.target.value = ''; }
});
// Keyboard: g then h/t/j/e/r/b/s to jump.
let gPressed = 0;
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey) return;
  if (e.key === 'g') { gPressed = Date.now(); return; }
  const map = { h: 'home', t: 'tasks', j: 'jira', e: 'epics', r: 'reviews', b: 'brutal', s: 'sessions', l: 'stack' };
  if (Date.now() - gPressed < 800 && map[e.key]) { location.hash = map[e.key]; gPressed = 0; }
});

// ---- live --------------------------------------------------------------------------
function connect() {
  const es = new EventSource('/live');
  es.addEventListener('state', (e) => {
    S = JSON.parse(e.data);
    if (!stackLog.length && S.stack?.log) stackLog = S.stack.log;
    if (document.activeElement?.matches('textarea') || document.activeElement?.closest('tbody select')) { renderChrome(); return; }
    render();
  });
  es.addEventListener('stacklog', (e) => { stackLog.push(JSON.parse(e.data)); if (stackLog.length > 400) stackLog = stackLog.slice(-400); renderStackLog(); });
  es.onerror = () => { $('#syncInfo').textContent = 'déconnecté du serveur…'; };
}
// ?snapshot: one fetch, no live stream (headless screenshots never settle on an open SSE).
if (new URLSearchParams(location.search).has('snapshot')) fetch('/api/state').then((r) => r.json()).then((d) => { S = d; stackLog = d.stack?.log ?? []; render(); });
else connect();
setInterval(() => S && !document.activeElement?.matches('select, textarea, input') && (renderHome(), renderSessions()), 30_000);
