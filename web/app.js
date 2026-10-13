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
  standup: ['Stand-up', 'Écrit tout seul chaque jour de semaine à 9h à partir de ce que tu as vraiment fait — ou à la demande'],
  tasks: ['Tâches', 'Tes PR et tes tickets en cours, avec la prochaine action suggérée'],
  jira: ['Jira', 'Tous les tickets qui te sont assignés'],
  epics: ['Epics & plans', 'Lance un plan sur un epic : Claude lit les tickets et le code, propose un découpage, attend ton go'],
  reviews: ["PR de l'équipe", 'Les PR de la team mobile (drafts compris) et des autres, à traiter depuis ici'],
  radar: ['Radar auto-review', 'Ce que la brutal review automatique surveille, lance et trouve — en direct'],
  slack: ['Slack filtré', 'Seulement ce qui a besoin de toi : DMs, mentions, threads, incidents — le bruit en moins'],
  usage: ['Conso IA', 'Tokens et coût estimé de TOUTES tes sessions Claude Code sur ce Mac'],
  data: ['Journal & base', 'Tout ce que la machine fait, et ta base locale SQLite interrogeable'],
  brutal: ['Brutal reviews', 'Chaque review faite par Claude : verdict, findings, coût'],
  atelier: ['Atelier', 'Tes worktrees, tes agents, leurs PR et tickets — déplace, ajoute, relie'],
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
window.addEventListener('hashchange', () => { showPage(pageFromHash()); if (S) { render([]); renderFresh(); } });
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
    `<button data-fchip="${page}|${c.name}|${esc(v)}" class="${(f.chips[c.name] ?? c.dflt ?? c.options[0][0]) === v ? 'on' : ''}">${esc(label)}${n != null ? `<em>${n}</em>` : ''}</button>`).join('')}</div>`).join('');
  const selects = (def.selects ?? []).map((s) => `<select data-fsel="${page}|${s.name}"><option value="">${esc(s.all)}</option>${s.options.map(([v, l]) =>
    `<option value="${esc(v)}" ${f.sel[s.name] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`).join('');
  const dirty = f.q || Object.values(f.sel).some(Boolean) || Object.entries(f.chips).some(([k, v]) => { const c = (def.chips ?? []).find((x) => x.name === k); return c && v !== (c.dflt ?? c.options[0][0]); });
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
const readyToMerge = (pr) => pr && !pr.is_draft && pr.review_decision === 'APPROVED' && pr.checks === 'SUCCESS' && pr.mergeable === 'MERGEABLE' && !pr.unresolved_threads;
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
  for (const t of S.tasks.filter((x) => readyToMerge(x.pr))) {
    items.push({ c: 'emerald', ico: '✓', t: `Prête à merger — ${t.key.startsWith('PR-') ? '' : `${t.key} · `}${t.issue?.summary ?? t.pr.title}`, s: `PR #${t.pr.number} · approuvée, checks verts, sans conflit`, a: `<a class="badge ok" href="${esc(t.pr.url)}" target="_blank">Merger sur GitHub ↗</a>`, w: 0.7 });
  }
  for (const r of S.reviews.filter((x) => x.requested_me && !x.my_review)) {
    items.push({ c: 'sky', ico: '⇄', t: `Review demandée : #${r.number} ${r.title}`, s: `@${r.author} · ${sizeTag(r.size).replace(/<[^>]+>/g, '')} · ${r.additions + r.deletions} lignes`, a: `<button class="brutal" data-review="${r.number}" data-repo="${esc(r.repo)}">⚡ Brutal review</button> <a href="${esc(r.url)}" target="_blank">ouvrir ↗</a>`, w: 2 });
  }
  for (const r of S.reviewHistory.filter((x) => x.error && x.open)) {
    items.push({ c: 'rose', ico: '✗', t: `Review #${r.pr} non postée`, s: r.error, a: `<button data-review="${r.pr}" data-repo="${esc(r.repo)}" data-rchore="${r.chore}">Relancer</button>`, w: 1 });
  }
  for (const m of (S.slack?.items ?? []).filter((x) => x.status === 'new' && x.priority !== 'fyi')) {
    items.push({ c: m.priority === 'urgent' ? 'rose' : 'amber', ico: '#', t: `${m.channel} · ${m.summary}`, s: m.action || m.why || m.author, a: `${m.permalink ? `<a href="${esc(m.permalink)}" target="_blank">Slack ↗</a>` : ''} <button class="ghost" data-slack="${esc(m.id)}" data-st="done">✓</button>`, w: m.priority === 'urgent' ? 0 : 0.5 });
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
    <div class="hero"><button class="hero-btn" id="standupBtn">☀ Préparer mon stand-up</button><h2>${hello} Eric 👋</h2>
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
  ['all', 'Tout'], ['merge', 'Prêtes à merger', (t) => readyToMerge(t.pr)], ['action', 'Action requise', (t) => t.next && t.next.key !== 'start-task'], ['checks', 'Checks KO', (t) => ['FAILURE', 'ERROR'].includes(t.pr?.checks)],
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
    <colgroup><col style="width:38px"><col style="width:34%"><col style="width:110px"><col><col style="width:150px"><col style="width:80px"><col style="width:320px"></colgroup>
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
  ['all', 'Toutes'], ['todo', 'Pas relues', (r) => !r.my_review && !r.session && !r.is_draft], ['requested', 'Review demandée', (r) => r.requested_me && !r.my_review],
  ['running', 'Review en cours', (r) => r.session && ACTIVE.includes(r.session.state)], ['done', 'Relues par Claude', (r) => r.session?.posted_url],
  ['outdated', 'Nouveaux commits', (r) => r.outdated], ['draft', 'Drafts', (r) => r.is_draft], ['mine', 'Ma review', (r) => r.my_review],
];
const MY = { PENDING: ['warn', 'brouillon à soumettre'], APPROVED: ['ok', 'approuvée'], CHANGES_REQUESTED: ['err', 'changes demandés'], COMMENTED: ['info', 'commentée'] };
const initials = (n) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
function renderReviews() {
  const all = S.reviews;
  $('#c-reviews').textContent = all.filter((r) => r.team && !r.my_review && !r.session && !r.is_draft).length || '';
  const a = S.autoReview;
  filterBar('reviews', {
    search: 'Rechercher (#, titre, auteur)…',
    chips: [
      { name: 'who', options: [['team', 'Équipe mobile', all.filter((r) => r.team).length], ['others', 'Autres', all.filter((r) => !r.team).length], ['all', 'Tous', all.length]] },
      { name: 'state', options: REVIEW_STATES.map(([k, l, fn]) => [k, l, fn ? all.filter(fn).length : all.length]) },
      { name: 'size', options: [['all', 'Taille'], ...['S', 'M', 'L', 'XL'].map((x) => [x, x, all.filter((r) => r.size === x).length])] },
    ],
    selects: [{ name: 'author', all: 'Tous les auteurs', options: [...new Set(all.map((r) => r.author))].sort().map((x) => [x, `${all.find((r) => r.author === x)?.team ?? `@${x}`}${a?.authors.includes(x) ? ' ⚡' : ''}`]) }],
    extra: a?.enabled ? `<a href="#radar" class="badge pink" title="Brutal review postée automatiquement sur les nouvelles PR prêtes de ${esc(a.authors.join(', '))}">⚡ auto ON · radar →</a>` : '',
  });
  const f = fget('reviews');
  const who = chip('reviews', 'who', 'team');
  const fn = REVIEW_STATES.find(([k]) => k === chip('reviews', 'state', 'all'))?.[2];
  const size = chip('reviews', 'size', 'all');
  const reviews = all.filter((r) => (who === 'all' || (who === 'team') === !!r.team) && (!fn || fn(r)) && (size === 'all' || r.size === size)
    && (!sel('reviews', 'author') || r.author === sel('reviews', 'author')) && textMatch(f.q, `#${r.number}`, r.title, r.author, r.team));
  // One card per teammate: what they have open and what waits on me.
  const devs = S.team.map((m) => {
    const prs = all.filter((r) => r.author === m.login);
    return `<div class="dev ${sel('reviews', 'author') === m.login ? 'on' : ''}" data-dev="${esc(m.login)}">
      <span class="avatar">${esc(initials(m.name))}</span>
      <div><b>${esc(m.name)}</b><small>@${esc(m.login)}${a?.authors.includes(m.login) ? ' · ⚡ auto' : ''}</small></div>
      <div class="devstats"><span title="PR ouvertes"><b>${prs.filter((r) => !r.is_draft).length}</b> prêtes</span><span title="Drafts"><b>${prs.filter((r) => r.is_draft).length}</b> drafts</span>
        <span class="${prs.some((r) => r.requested_me && !r.my_review) ? 'hot' : ''}" title="Review demandée, pas encore faite"><b>${prs.filter((r) => r.requested_me && !r.my_review).length}</b> pour moi</span></div></div>`;
  }).join('');
  const table = reviews.length ? `<div class="panel"><div class="scroll"><table>
    <colgroup><col><col style="width:130px"><col style="width:110px"><col style="width:150px"><col style="width:190px"><col style="width:330px"></colgroup>
    <thead><tr><th>PR</th><th>Taille</th><th>Checks</th><th>Ma review</th><th>Brutal review</th><th></th></tr></thead>
    <tbody>${reviews.map((r) => {
      const s = r.session, my = MY[r.my_review];
      return `<tr>
        <td><div class="title"><a href="${esc(r.url)}" target="_blank">#${r.number}</a> ${r.is_draft ? '<span class="badge">draft</span> ' : ''}${esc(r.title)}</div>
          <div class="sub">${r.team ? `<b>${esc(r.team)}</b>` : `@${esc(r.author)}`}${r.auto ? ' ⚡' : ''} · ${ago(r.updated)}${r.requested_me ? ' · <b style="color:var(--sky)">review demandée</b>' : ''}${r.unresolved_threads ? ` · 💬 ${r.unresolved_threads}` : ''}</div></td>
        <td>${sizeTag(r.size)} ${diffTag(r.additions, r.deletions)}<div class="muted small">${r.changed_files} fichiers</div></td>
        <td>${checksBadge(r.checks)}${r.mergeable === 'CONFLICTING' ? ' <span class="badge err">conflits</span>' : ''}</td>
        <td>${my ? `<span class="badge ${my[0]}">${my[1]}</span>` : decisionBadge(r.review_decision)}</td>
        <td>${s ? `${sessionLink(s)} ${r.outdated ? '<span class="badge warn" title="Nouveaux commits depuis la review">obsolète</span>' : ''}${s.error ? `<div class="small" style="color:var(--rose)">${esc(s.error)}</div>` : ''}` : ''}</td>
        <td><div class="row-actions">
          ${s?.posted_url ? `<a href="${esc(s.posted_url)}" target="_blank">${s.chore === 'auto-review' ? 'postée' : 'brouillon'} ↗</a>` : ''}
          <button class="brutal" data-review="${r.number}" data-repo="${esc(r.repo)}" data-rchore="auto-review" title="Brutal review postée directement sur la PR">⚡ Poster</button>
          <button data-review="${r.number}" data-repo="${esc(r.repo)}" title="Brutal review en brouillon GitHub, tu soumets toi-même">Brouillon</button>
          <button class="ghost" data-stack-pr="${r.number}" title="Charger dans le stack local">▶</button>
        </div></td></tr>`;
    }).join('')}</tbody></table></div></div>` : `<div class="panel"><div class="empty">${all.length ? 'Aucune PR ne correspond aux filtres.' : 'Aucune PR de collègue ouverte.'}</div></div>`;
  $('#r-reviews').innerHTML = `<div class="devs">${devs}</div>${table}`;
}
document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-dev]');
  if (!d) return;
  const f = fget('reviews');
  f.sel.author = f.sel.author === d.dataset.dev ? '' : d.dataset.dev;
  f.chips.who = 'team'; saveF(); renderReviews();
});
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

// ---- radar: the auto brutal review, live ---------------------------------------------
const RADAR_STATUS = {
  queued: ['warn', 'en file'], launched: ['live', 'lancée'], reviewing: ['live', 'review en cours'], posted: ['ok', 'postée'],
  error: ['err', 'erreur'], baseline: ['', 'ignorée (déjà ouverte à l’activation)'], mine: ['info', 'déjà relue par toi'], draft: ['', 'draft — attend « ready »'],
};
const EVENT_ICON = { 'auto-check': ['sky', '◉'], 'auto-launch': ['violet', '▶'], 'review-posted': ['pink', '⚡'], 'review-draft': ['emerald', '✎'], 'review-error': ['rose', '✗'], 'auto-error': ['rose', '✗'], 'auto-review': ['amber', '★'], 'session-start': ['violet', '▶'], 'session-blocked': ['pink', '✋'], 'session-done': ['emerald', '✓'], slack: ['sky', '#'], 'slack-error': ['rose', '#'] };
const eventRow = (e) => { const [c, i] = EVENT_ICON[e.kind] ?? ['violet', '•']; return `<div class="ev c-${c}"><span class="ico">${i}</span><div><div>${esc(e.message)}</div><div class="faint small">${new Date(e.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' })} · ${esc(e.kind)}${e.pr ? ` · <a href="https://github.com/${esc(e.repo)}/pull/${e.pr}" target="_blank">#${e.pr}</a>` : ''}</div></div></div>`; };
const liveFeeds = {}; // session id → last tool lines, filled by polling the transcript
async function pollLiveReviews() {
  if (!S || pageFromHash() !== 'radar') return;
  const live = S.sessions.filter((s) => ['auto-review', 'ai-review'].includes(s.chore) && ACTIVE.includes(s.state));
  await Promise.all(live.map(async (s) => {
    const r = await fetch(`/api/sessions/${s.id}/transcript`).catch(() => null);
    if (!r?.ok) return;
    const { items } = await r.json();
    liveFeeds[s.id] = items.slice(-10);
  }));
  const el = $('#radarLive');
  if (el) el.innerHTML = radarLive();
}
function radarLive() {
  const live = S.sessions.filter((s) => ['auto-review', 'ai-review'].includes(s.chore) && ACTIVE.includes(s.state));
  if (!live.length) return '<div class="empty">Aucune review en cours — la prochaine nouvelle PR de l’équipe démarrera ici.</div>';
  return live.map((s) => `<div class="rv"><div class="rv-head"><span class="dot live"></span><div class="grow"><div class="title">#${s.pr} ${esc(s.title ?? '')}</div>
    <div class="sub">${s.author ? `@${esc(s.author)} · ` : ''}${esc(s.model)} · ${dur(s.started_at)} · ${s.turns} tours · <span class="cost">${money(s.cost_usd)}</span></div></div>
    <button class="ghost" data-open-session="${s.id}">Conversation</button>${termBtn(s)}</div>
    <div class="ticker">${(liveFeeds[s.id] ?? []).map((m) => m.role === 'tool' ? `<div><b>${esc(m.name)}</b> ${esc(m.text)}</div>` : `<div class="say">${esc(m.text.slice(0, 220))}</div>`).join('') || '<div class="faint">démarrage…</div>'}</div></div>`).join('');
}
function renderRadar() {
  const a = S.autoReview;
  if (!a) return;
  const live = S.sessions.filter((s) => s.chore === 'auto-review' && ACTIVE.includes(s.state));
  $('#radarDot').className = `dot ${live.length ? 'live' : a.enabled ? 'ok' : ''}`;
  const next = a.lastCheck ? Math.max(0, new Date(a.lastCheck).getTime() + a.everyMs - Date.now()) : null;
  const posted = S.reviewHistory.filter((r) => r.chore === 'auto-review');
  const events = S.events.filter((e) => /^(auto|review)/.test(e.kind));
  $('#page-radar').innerHTML = `
    <div class="hero radar"><div class="radar-ring ${a.enabled && a.active ? 'on' : ''}"><span></span></div>
      <div><h2>${!a.enabled ? 'Radar coupé' : a.active ? 'Radar actif' : `Radar en pause · reprend à ${a.hours[0]}h`} ${live.length ? `· <span style="color:var(--violet)">${live.length} review${live.length > 1 ? 's' : ''} en cours</span>` : ''}</h2>
      <p>Surveille ${a.authors.map((x) => `<b>${esc(S.team.find((m) => m.login === x)?.name ?? x)}</b>`).join(', ')} sur hivebrite-mobile · check toutes les ${Math.round(a.everyMs / 60000)} min · ${a.maxConcurrent} en parallèle max</p>
      <p class="small">Automatique de ${a.hours[0]}h à ${a.hours[1]}h · dernier check ${a.lastCheck ? `il y a ${ago(a.lastCheck)}` : '—'} · ${a.active ? `prochain dans <b id="radarNext" data-at="${a.lastCheck ? new Date(a.lastCheck).getTime() + a.everyMs : ''}">${next != null ? fmtMs(next) : '—'}</b>` : '<b>en pause</b> — check manuel possible'}</p></div>
      <span class="spacer"></span><button class="primary" id="radarCheck">◉ Checker maintenant</button></div>
    <div class="kpis">
      <div class="kpi violet"><b>${a.watched.length}</b><small>PR surveillées</small></div>
      <div class="kpi pink"><b>${posted.length}</b><small>reviews postées</small></div>
      <div class="kpi rose"><b>${posted.reduce((n, r) => n + r.counts.critical, 0)}</b><small>findings critiques</small></div>
      <div class="kpi amber"><b>${posted.reduce((n, r) => n + r.counts.warning, 0)}</b><small>warnings</small></div>
      <div class="kpi emerald"><b>${money(posted.reduce((n, r) => n + (r.cost_usd ?? 0), 0))}</b><small>coût est. total</small></div>
    </div>
    <div class="grid2">
      <div>
        <div class="panel"><h2><span class="dot live"></span> En direct</h2><div id="radarLive">${radarLive()}</div></div>
        <div class="panel"><h2>PR surveillées <span class="count">${a.watched.length}</span></h2><div class="feed">${a.watched.map((w) => {
          const [cls, label] = RADAR_STATUS[w.status] ?? ['', w.status];
          return `<div class="item c-${w.status === 'posted' ? 'pink' : w.status === 'error' ? 'rose' : 'violet'}"><span class="ico">${w.status === 'posted' ? '⚡' : w.status === 'baseline' ? '·' : '◉'}</span>
            <div style="min-width:0"><div class="t"><a href="${esc(w.url)}" target="_blank">#${w.number}</a> ${esc(w.title)}</div><div class="s">${esc(S.team.find((m) => m.login === w.author)?.name ?? w.author)} · ${w.size} lignes${w.outdated ? ' · nouveaux commits depuis la review' : ''}</div></div>
            <div class="row-actions"><span class="badge ${cls}">${esc(label)}</span>${w.session ? `<button class="ghost" data-open-session="${w.session.id}">voir</button>` : ''}${['baseline', 'mine'].includes(w.status) || w.outdated ? `<button class="brutal" data-review="${w.number}" data-repo="${esc(w.repo)}" data-rchore="auto-review">⚡ Lancer</button>` : ''}</div></div>`;
        }).join('') || '<div class="empty">Aucune PR ouverte de ces auteurs.</div>'}</div></div>
      </div>
      <div>
        <div class="panel"><h2>⚡ Ce que le radar a trouvé</h2>${posted.slice(0, 8).map((r) => `<div class="rv"><div class="rv-head"><div class="grow"><div class="title">${r.url ? `<a href="${esc(r.url)}" target="_blank">#${r.pr}</a>` : `#${r.pr}`} ${esc(r.title ?? '')}</div><div class="sub">${esc(S.team.find((m) => m.login === r.author)?.name ?? r.author ?? '')} · ${ago(r.started_at)} · <span class="cost">${money(r.cost_usd)}</span></div></div>${r.summary ? sevPills(r.counts) : sessionBadge(r)}</div>
          ${r.comments.filter((c) => c.severity !== 'suggestion').slice(0, 3).map((c) => `<div class="finding ${esc(c.severity)}"><div class="loc">${SEV_LABEL[c.severity] ?? ''} · ${esc(c.path)}:${esc(c.line)}</div><div class="md">${md(c.body.slice(0, 400))}</div></div>`).join('')}</div>`).join('') || '<div class="empty">Rien encore — les findings apparaîtront ici dès la première review postée.</div>'}</div>
        <div class="panel"><h2>Journal du radar</h2><div class="evlist">${events.slice(0, 40).map(eventRow).join('') || '<div class="empty">Le premier check arrive au prochain sync.</div>'}</div></div>
      </div>
    </div>`;
}
setInterval(() => { const el = $('#radarNext'); if (el?.dataset.at) el.textContent = fmtMs(Math.max(0, Number(el.dataset.at) - Date.now())) || '0s'; }, 1000);
setInterval(pollLiveReviews, 3000);

// ---- stand-up --------------------------------------------------------------------------
let standupSel = null;
const dayLabel = (iso) => new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
function renderStandup() {
  const list = S.standups ?? [];
  const pending = list.find((x) => x.pending);
  const cur = list.find((x) => x.id === standupSel) ?? list.find((x) => x.result) ?? null;
  $('#standupDot').className = `dot ${pending ? 'live' : list[0]?.day === new Date().toISOString().slice(0, 10) && list[0]?.result ? 'ok' : ''}`;
  const r = cur?.result, f = cur?.facts;
  const commits = f ? f.pushed.reduce((n, p) => n + p.commits.length, 0) : 0;
  const sect = (title, ico, cls, items, empty) => `<div class="su-sect ${cls}"><h3><span>${ico}</span>${title}</h3>${items?.length ? `<ul>${items.map((i) => `<li class="md">${md(i)}</li>`).join('')}</ul>` : `<div class="faint">${empty}</div>`}</div>`;
  $('#page-standup').innerHTML = `
    <div class="hero su-hero">
      <div class="su-date"><small>${cur ? `${dayLabel(cur.since)}${new Date(cur.until) - new Date(cur.since) > 86_400_000 ? ` → ${dayLabel(new Date(new Date(cur.until) - 1))}` : ''}` : 'Pas encore de stand-up'}</small>
        <h2>${r ? esc(r.headline) : pending ? 'J’écris ton stand-up…' : 'Ton stand-up de ce matin'}</h2>
        <p>${cur ? `${cur.auto ? '⏰ généré automatiquement' : '✍ généré à la demande'} à ${new Date(cur.generated_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · ${esc(cur.model)}${cur.cost ? ` · $${cur.cost.toFixed(3)}` : ''}` : 'Généré automatiquement chaque jour de semaine à 9h — ou maintenant.'}</p></div>
      <span class="spacer"></span>
      <div class="row-actions">${r ? '<button class="primary" id="standupCopy">⧉ Copier pour Slack</button>' : ''}
        <button id="standupGen" ${pending ? 'disabled' : ''}>${pending ? '<span class="dot live"></span> écriture…' : '↻ Générer maintenant'}</button>
        <button class="ghost" id="standupGenOpus" ${pending ? 'disabled' : ''} title="Même chose avec Opus">Opus</button></div>
    </div>
    ${cur?.error ? `<div class="panel"><div class="empty" style="color:var(--rose)">✗ ${esc(cur.error)}</div></div>` : ''}
    ${f ? `<div class="kpis">
      <div class="kpi emerald"><b>${f.merged.length}</b><small>PR mergées</small></div>
      <div class="kpi violet"><b>${f.opened.length}</b><small>PR ouvertes</small></div>
      <div class="kpi sky"><b>${commits}</b><small>commits poussés</small></div>
      <div class="kpi pink"><b>${f.reviewed.length + f.brutal.length}</b><small>reviews données</small></div>
      <div class="kpi amber"><b>${f.jira.length}</b><small>tickets bougés</small></div>
      <div class="kpi"><b>${f.sessions.length}</b><small>sessions Claude</small></div></div>` : ''}
    ${r ? `<div class="su-grid">
      ${sect('Hier', '✓', 'done', r.yesterday, 'Rien de notable sur la période.')}
      ${sect("Aujourd'hui", '→', 'next', r.today, 'Rien de planifié.')}
      ${sect('Blocages', '⛔', 'block', r.blockers, 'Aucun blocage 🎉')}
    </div>
    <div class="grid2">
      <div class="panel"><h2>Prêt à coller dans Slack</h2><pre class="log su-slack">${esc(r.slack)}</pre></div>
      <div class="panel"><h2>Les faits utilisés</h2><div class="su-facts">
        ${f.merged.map((p) => `<a class="badge ok" href="${esc(p.url)}" target="_blank">✓ #${p.number} mergée</a>`).join('')}
        ${f.opened.map((p) => `<a class="badge ai" href="${esc(p.url)}" target="_blank">＋ #${p.number} ouverte</a>`).join('')}
        ${f.pushed.map((p) => `<a class="badge info" href="${esc(p.url)}" target="_blank">↑ #${p.number} · ${p.commits.length} commit${p.commits.length > 1 ? 's' : ''}</a>`).join('')}
        ${f.reviewed.map((p) => `<a class="badge pink" href="${esc(p.url)}" target="_blank">⇄ review #${p.number} (@${esc(p.author)})</a>`).join('')}
        ${f.jira.map((i) => `<a class="badge warn" href="${esc(i.url)}" target="_blank">◆ ${esc(i.key)} · ${esc(i.status)}</a>`).join('')}
        ${!f.merged.length && !f.opened.length && !f.pushed.length && !f.reviewed.length && !f.jira.length ? '<span class="faint">Aucune activité trouvée sur la période.</span>' : ''}
      </div></div>
    </div>` : ''}
    ${list.length > 1 ? `<div class="panel"><h2>Historique</h2><div class="su-hist">${list.filter((x) => x.result || x.error).map((x) => `<button data-standup="${x.id}" class="${cur?.id === x.id ? 'on' : ''}"><b>${new Date(x.generated_at).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })}</b><small>${x.auto ? 'auto' : 'manuel'}</small></button>`).join('')}</div></div>` : ''}`;
}

// ---- slack ------------------------------------------------------------------------------
const PRIO = { urgent: ['rose', '🔥 Urgent'], important: ['amber', '★ Important'], fyi: ['sky', 'ℹ︎ Pour info'] };
const KIND = { dm: 'DM', mention: 'Mention', thread: 'Thread', team: 'Équipe', incident: 'Incident' };
function renderSlack() {
  const sl = S.slack ?? { items: [] };
  const items = sl.items ?? [];
  $('#c-slack').textContent = items.filter((i) => i.status === 'new' && i.priority !== 'fyi').length || '';
  filterBar('slack', {
    search: 'Rechercher (texte, auteur, canal)…',
    chips: [
      { name: 'status', options: [['new', 'À traiter', items.filter((i) => i.status === 'new').length], ['snoozed', 'Plus tard', items.filter((i) => i.status === 'snoozed').length], ['done', 'Traités', items.filter((i) => i.status === 'done').length], ['all', 'Tout', items.length]] },
      { name: 'prio', options: [['all', 'Priorité'], ...Object.entries(PRIO).map(([k, [, l]]) => [k, l, items.filter((i) => i.priority === k).length])] },
      { name: 'kind', options: [['all', 'Type'], ...Object.entries(KIND).map(([k, l]) => [k, l, items.filter((i) => i.kind === k).length])] },
    ],
    selects: [{ name: 'channel', all: 'Tous les canaux', options: [...new Set(items.map((i) => i.channel))].sort().map((c) => [c, c]) }],
    extra: `<span class="muted small">${sl.running ? '<span class="dot live"></span> tri en cours…' : sl.at ? `trié il y a ${ago(sl.at)} · ${esc(sl.model ?? '')}${sl.cost ? ` · $${sl.cost.toFixed(3)}` : ''}` : 'jamais trié'}</span>
      <button id="slackSync" ${sl.running ? 'disabled' : ''}>⟳ Trier</button><button class="primary" id="slackDeep" ${sl.running ? 'disabled' : ''} title="Même tri avec Sonnet : plus fin, plus cher">Analyse fine</button>`,
  });
  const f = fget('slack');
  const st = chip('slack', 'status', 'new'), pr = chip('slack', 'prio', 'all'), kd = chip('slack', 'kind', 'all');
  const list = items.filter((i) => (st === 'all' || i.status === st) && (pr === 'all' || i.priority === pr) && (kd === 'all' || i.kind === kd)
    && (!sel('slack', 'channel') || i.channel === sel('slack', 'channel')) && textMatch(f.q, i.text, i.summary, i.author, i.channel));
  if (sl.error) $('#r-slack').dataset.err = sl.error;
  $('#r-slack').innerHTML = `${sl.error ? `<div class="panel"><div class="empty" style="color:var(--rose)">Dernier tri en échec : ${esc(sl.error)}</div></div>` : ''}
    ${list.length ? `<div class="slack">${list.map((i) => { const [c, l] = PRIO[i.priority] ?? PRIO.fyi; return `<div class="sm c-${c} ${i.status !== 'new' ? 'dim' : ''}">
      <div class="sm-head"><span class="badge" style="color:var(--c);background:var(--c-s);border-color:transparent">${l}</span> <span class="badge">${esc(KIND[i.kind] ?? i.kind ?? '')}</span>
        <b>${esc(i.channel)}</b> <span class="muted">· ${esc(i.author)} · ${ago(i.ts)}</span><span class="spacer"></span>
        ${i.permalink ? `<a href="${esc(i.permalink)}" target="_blank">Ouvrir ↗</a>` : ''}
        ${i.status === 'new' ? `<button class="ghost" data-slack="${esc(i.id)}" data-st="snoozed">Plus tard</button><button data-slack="${esc(i.id)}" data-st="done">✓ Traité</button>` : `<button class="ghost" data-slack="${esc(i.id)}" data-st="new">Rouvrir</button>`}</div>
      <div class="sm-sum">${esc(i.summary)}</div>
      ${i.why ? `<div class="small muted">Pourquoi : ${esc(i.why)}</div>` : ''}
      ${i.action ? `<div class="sm-act">→ ${esc(i.action)}</div>` : ''}
      ${i.text ? `<blockquote>${esc(i.text)}</blockquote>` : ''}</div>`; }).join('')}</div>`
      : `<div class="panel"><div class="empty">${items.length ? 'Rien ne correspond — profite 🎉' : sl.running ? 'Premier tri en cours (≈ 1-2 min)…' : 'Aucun message trié. Clique « Trier ».'}</div></div>`}`;
}
RENDER.slack = renderSlack;

// ---- usage / conso IA ------------------------------------------------------------------
const MODEL_COLOR = { opus: 'var(--violet)', fable: 'var(--pink)', sonnet: 'var(--sky)', haiku: 'var(--emerald)' };
let U = null, uKey = '';
const uCache = new Map(); // query → stats, reused until the server says the data moved
async function loadUsage(force) {
  const q = new URLSearchParams({ days: chip('usage', 'days', '30'), model: sel('usage', 'model'), project: sel('usage', 'project') }).toString();
  if (!force && q === uKey && U) return;
  if (!force && uCache.has(q)) { uKey = q; U = uCache.get(q); return renderUsage(); }
  uKey = q;
  const r = await fetch(`/api/usage?${q}`);
  if (!r.ok) return;
  const data = await r.json();
  if (force && data.version === U?.version && uKey === q) return; // nothing new since last fetch
  if (data.version !== U?.version) uCache.clear();
  uCache.set(q, data);
  if (uKey === q) { U = data; renderUsage(); }
}
function renderUsage() {
  filterBar('usage', {
    chips: [{ name: 'days', dflt: '30', options: [['1', "Aujourd'hui"], ['7', '7 jours'], ['30', '30 jours'], ['90', '90 jours'], ['365', '1 an']] }],
    selects: [
      { name: 'model', all: 'Tous les modèles', options: ['opus', 'fable', 'sonnet', 'haiku'].map((m) => [m, m]) },
      { name: 'project', all: 'Tous les projets', options: (U?.projects ?? []).map((p) => [p, p]) },
    ],
    extra: `<span class="faint small">${U?.scannedAt ? `transcripts scannés il y a ${ago(U.scannedAt)}` : 'scan en cours…'}</span>`,
  });
  const want = new URLSearchParams({ days: chip('usage', 'days', '30'), model: sel('usage', 'model'), project: sel('usage', 'project') }).toString();
  if (!U || uKey !== want) { loadUsage(); if (!U) return ($('#r-usage').innerHTML = '<div class="panel"><div class="empty">Chargement…</div></div>'); if (uKey !== want) return; }
  const t = U.total;
  const hit = t.cache_read / Math.max(1, t.input + t.cache_read + t.cache_write);
  const days = [...new Set(U.perDay.map((d) => d.day))].sort();
  const allDays = []; if (days.length) { const d0 = new Date(days[0]), d1 = new Date(); for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) allDays.push(d.toISOString().slice(0, 10)); }
  const perDay = allDays.map((d) => ({ d, parts: U.perDay.filter((x) => x.day === d) }));
  const maxDay = Math.max(0.01, ...perDay.map((x) => x.parts.reduce((a, p) => a + p.cost, 0)));
  const bar = (list, color = () => 'var(--grad)') => { const max = Math.max(0.01, ...list.map((g) => g.cost)); return `<div class="hbars">${list.map((g) => `<span title="${esc(g.key)}">${esc(g.key)} <span class="faint">${kfmt(g.tokens)}</span></span><div class="b" style="width:${(g.cost / max) * 100}%;background:${color(g.key)}"></div><span class="cost">${money(g.cost)}</span>`).join('') || '<span class="muted">rien</span>'}</div>`; };
  const maxH = Math.max(0.01, ...U.byHour);
  $('#r-usage').innerHTML = `
    <div class="kpis">
      <div class="kpi pink"><b>${money(t.cost)}</b><small>coût est. · ${U.days} j</small></div>
      <div class="kpi violet"><b>${kfmt(t.tokens)}</b><small>tokens au total</small></div>
      <div class="kpi sky"><b>${kfmt(t.output)}</b><small>tokens générés (output)</small></div>
      <div class="kpi emerald"><b>${Math.round(hit * 100)}%</b><small>lu depuis le cache</small></div>
      <div class="kpi amber"><b>${money(t.cost / Math.max(1, Math.min(U.days, allDays.length || 1)))}</b><small>moyenne / jour</small></div>
      <div class="kpi"><b>${kfmt(t.n)}</b><small>appels modèle</small></div>
    </div>
    <div class="panel"><h2>Coût / jour par modèle ${Object.entries(MODEL_COLOR).map(([m, c]) => `<span class="legend"><i style="background:${c}"></i>${m}</span>`).join('')}</h2>
      <div class="bars stacked">${perDay.map(({ d, parts }) => { const tot = parts.reduce((a, p) => a + p.cost, 0); return `<div title="${d} · ${money(tot)}" style="height:${(tot / maxDay) * 100}%">${parts.sort((a, b) => b.cost - a.cost).map((p) => `<i style="flex:${p.cost};background:${MODEL_COLOR[p.fam] ?? 'var(--faint)'}"></i>`).join('')}<span>${perDay.length > 20 ? (new Date(d).getDate() % 5 ? '' : new Date(d).getDate()) : new Date(d).getDate()}</span></div>`; }).join('')}</div></div>
    <div class="grid3">
      <div class="panel"><h2>Par modèle</h2>${bar(U.byModel, (k) => MODEL_COLOR[k] ?? 'var(--faint)')}</div>
      <div class="panel"><h2>Dashboard vs interactif</h2>${bar(U.bySource)}</div>
      <div class="panel"><h2>Par chore</h2>${bar(U.byChore.map((g) => ({ ...g, key: choreLabel(g.key) })))}</div>
    </div>
    <div class="grid2">
      <div class="panel"><h2>Par projet</h2>${bar(U.byProject)}</div>
      <div class="panel"><h2>Par heure de la journée</h2><div class="hours">${U.byHour.map((c, h) => `<div title="${h}h · ${money(c)}" style="--a:${c / maxH}"><span>${h % 3 ? '' : h}</span></div>`).join('')}</div>
        <div class="faint small" style="padding:0 16px 14px">Tokens : ${kfmt(t.input)} input · ${kfmt(t.output)} output · ${kfmt(t.cache_read)} lus du cache · ${kfmt(t.cache_write)} écrits en cache</div></div>
    </div>
    <div class="panel"><h2>Sessions les plus chères</h2><div class="scroll"><table>
      <colgroup><col><col style="width:160px"><col style="width:100px"><col style="width:110px"><col style="width:100px"><col style="width:90px"></colgroup>
      <thead><tr><th>Session</th><th>Projet</th><th>Modèle</th><th>Tokens</th><th>Date</th><th>Coût est.</th></tr></thead>
      <tbody>${U.sessions.map((x) => `<tr><td><div class="title">${esc(x.name ?? (x.chore ? choreLabel(x.chore) : 'session interactive'))}</div><div class="sub mono">${esc(x.key)}</div></td><td class="small">${esc(x.proj ?? '')}</td><td class="mono">${esc(x.fam ?? '')}</td><td class="mono">${kfmt(x.tokens)}<div class="faint small">${x.n} appels</div></td><td class="muted">${x.first ? ago(x.first) : ''}</td><td class="cost">${money(x.cost)}</td></tr>`).join('')}</tbody></table></div></div>
    <p class="faint small">Estimation au prix API de chaque appel (input, output, cache lu/écrit) — ton siège Claude Enterprise n'est pas facturé ainsi. Source : tous les transcripts de ~/.claude/projects, rescannés toutes les 5 min.</p>`;
}
RENDER.usage = () => { loadUsage(); renderUsage(); };

// ---- journal & base ----------------------------------------------------------------------
const PRESETS = [
  ['Coût par jour (30 j)', "SELECT day, ROUND(SUM(cost), 2) AS cost_usd, SUM(output) AS output_tokens FROM usage WHERE day >= date('now', '-30 days') GROUP BY day ORDER BY day DESC"],
  ['Reviews postées', "SELECT started_at, pr, author, title, ROUND(cost_usd, 2) AS cost, posted_url FROM sessions WHERE chore IN ('auto-review','ai-review') ORDER BY started_at DESC"],
  ['PR fermées (historique)', "SELECT number, kind, author, title, closed_at FROM prs WHERE closed_at IS NOT NULL ORDER BY closed_at DESC"],
  ['Mes tickets par epic', "SELECT parent_key, parent_summary, COUNT(*) AS tickets, SUM(status_category = 'indeterminate') AS en_cours FROM issues GROUP BY parent_key ORDER BY tickets DESC"],
  ['Slack urgent', "SELECT ts, channel, author, summary, status FROM slack WHERE priority = 'urgent' ORDER BY ts DESC"],
  ['Schéma', "SELECT name, sql FROM sqlite_master WHERE type = 'table'"],
];
function renderData() {
  const kinds = [...new Set(S.events.map((e) => e.kind))].sort();
  filterBar('data', {
    search: 'Filtrer le journal…',
    selects: [{ name: 'kind', all: 'Tous les événements', options: kinds.map((k) => [k, k]) }],
  });
  if ($('#page-data').contains(document.activeElement) && document.activeElement.matches('textarea')) return;
  const f = fget('data');
  const evs = S.events.filter((e) => (!sel('data', 'kind') || e.kind === sel('data', 'kind')) && textMatch(f.q, e.message, e.kind, e.pr));
  const prev = $('#sqlq')?.value;
  $('#r-data').innerHTML = `<div class="grid2">
    <div class="panel"><h2>Journal <span class="count">${evs.length}</span></h2><div class="evlist tall">${evs.map(eventRow).join('') || '<div class="empty">Rien encore.</div>'}</div></div>
    <div>
      <div class="panel"><h2>Base locale</h2><div style="padding:12px 16px" class="small">
        <div class="mono" style="user-select:all">${esc(S.db.path)}</div>
        <div class="tables">${Object.entries(S.db.tables).map(([k, n]) => `<span class="badge">${esc(k)} <b>${kfmt(n)}</b></span>`).join(' ')}</div>
        <div class="faint">Tout est stocké ici : tickets, epics, PR (fermées comprises), sessions + coûts, reviews, journal, tokens de chaque appel modèle, Slack trié. Ouvre-la aussi avec <span class="mono">sqlite3</span>.</div></div></div>
      <div class="panel"><h2>Console SQL (lecture seule)</h2><div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px">
        <div class="chips">${PRESETS.map(([l], i) => `<button data-preset="${i}">${esc(l)}</button>`).join('')}</div>
        <textarea id="sqlq" rows="4" class="mono" placeholder="SELECT … (⌘↩ pour exécuter)">${esc(prev ?? PRESETS[0][1])}</textarea>
        <div class="actions"><button class="primary" id="sqlRun">Exécuter</button></div>
        <div id="sqlOut" class="sqlout">${lastSql}</div></div></div>
    </div></div>`;
}
let lastSql = '';
async function runSql() {
  try {
    const { rows } = await post('/api/sql', { q: $('#sqlq').value });
    const cols = rows.length ? Object.keys(rows[0]) : [];
    lastSql = rows.length ? `<div class="faint small">${rows.length} ligne(s)</div><div class="scroll"><table class="md"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(typeof r[c] === 'number' && !Number.isInteger(r[c]) ? r[c].toFixed(4) : r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="muted">Aucune ligne.</div>';
  } catch (e) { lastSql = `<div style="color:var(--rose)">${esc(e.message)}</div>`; }
  $('#sqlOut').innerHTML = lastSql;
}
document.addEventListener('click', (e) => {
  const p = e.target.closest('[data-preset]');
  if (p) { $('#sqlq').value = PRESETS[p.dataset.preset][1]; runSql(); }
  if (e.target.id === 'sqlRun') runSql();
});
document.addEventListener('keydown', (e) => { if (e.target.id === 'sqlq' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runSql(); } });
RENDER.data = renderData;

// ---- ⌘K palette -------------------------------------------------------------------------
function paletteItems(q) {
  const out = Object.entries(PAGES).map(([k, [t]]) => ({ ico: '→', t, s: 'Page', go: () => (location.hash = k) }));
  for (const t of S.tasks) out.push({ ico: '▤', t: `${t.key} ${t.issue?.summary ?? t.pr?.title ?? ''}`, s: t.pr ? `PR #${t.pr.number}` : 'ticket', go: () => window.open(t.pr?.url ?? `${S.jira.site}/browse/${t.key}`, '_blank') });
  for (const r of S.reviews) out.push({ ico: '⇄', t: `#${r.number} ${r.title}`, s: r.team ?? `@${r.author}`, go: () => window.open(r.url, '_blank') });
  for (const e of S.epics ?? []) out.push({ ico: '✦', t: `${e.key} ${e.summary ?? ''}`, s: 'epic — Entrée pour planifier', go: () => openChore({ kind: 'epic', epic: e.key }) });
  for (const s of S.sessions) out.push({ ico: '▶', t: what(s), s: `session · ${choreLabel(s.chore)}`, go: () => openDrawer(s.id) });
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return out.filter((i) => words.every((w) => `${i.t} ${i.s}`.toLowerCase().includes(w))).slice(0, 12);
}
let palSel = 0, palList = [];
function renderPalette() {
  palList = paletteItems($('#pq').value);
  palSel = Math.min(palSel, Math.max(0, palList.length - 1));
  $('#pres').innerHTML = palList.map((i, n) => `<div class="pi ${n === palSel ? 'on' : ''}" data-pi="${n}"><span>${i.ico}</span><b>${esc(i.t)}</b><small>${esc(i.s)}</small></div>`).join('') || '<div class="empty">Rien trouvé</div>';
}
function openPalette() { if (!S) return; $('#pq').value = ''; palSel = 0; renderPalette(); $('#palette').showModal(); $('#pq').focus(); }
$('#pq').addEventListener('input', () => { palSel = 0; renderPalette(); });
$('#pq').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { palSel = Math.min(palList.length - 1, palSel + 1); renderPalette(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { palSel = Math.max(0, palSel - 1); renderPalette(); e.preventDefault(); }
  if (e.key === 'Enter' && palList[palSel]) { $('#palette').close(); palList[palSel].go(); }
});
$('#pres').addEventListener('click', (e) => { const i = e.target.closest('[data-pi]'); if (i) { $('#palette').close(); palList[i.dataset.pi].go(); } });
$('#palette').addEventListener('click', (e) => { if (e.target.id === 'palette') $('#palette').close(); });
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openPalette(); } });
$('#paletteBtn').onclick = openPalette;

// ---- atelier: worktrees × agents × PRs × tickets, on a board --------------------------
// Auto nodes come from the data (repo → worktrees → sessions / PR → ticket); my own nodes
// (notes, tickets, epics) and links are stored server-side. Drag a node to move it, drag
// from its ● port onto another node to link them — a ticket dropped on a worktree offers to
// launch Claude there, on a session to send it the ticket.
const G = { pan: [40, 20], zoom: 0.9, pos: {}, sel: null, drag: null, link: null, built: null };
try { Object.assign(G, store.get('atelierView', {})); } catch {}
const wtName = (p) => p.split('/').filter(Boolean).slice(-1)[0];
function buildGraph() {
  const g = S.graph ?? { worktrees: [], nodes: [], edges: [], pos: {} };
  const f = fget('atelier');
  const nodes = [], edges = [];
  const add = (n) => { nodes.push(n); return n.id; };
  const link = (src, dst, manual, extra = {}) => edges.push({ src, dst, manual, ...extra });
  const onlyActive = chip('atelier', 'scope', 'all') === 'active';
  const prsByBranch = new Map(S.tasks.filter((t) => t.pr).map((t) => [t.pr.head, t]));
  const reviewByNum = new Map(S.reviews.map((r) => [r.number, r]));
  const repos = [...new Set(g.worktrees.map((w) => w.repo))];
  for (const r of repos) add({ id: `repo:${r}`, type: 'repo', label: r.split('/')[1], sub: r });
  for (const w of g.worktrees) {
    const sessions = S.sessions.filter((s) => s.cwd && (s.cwd === w.path || s.cwd.startsWith(`${w.path}/`)));
    const active = sessions.some((s) => ACTIVE.includes(s.state));
    const t = w.branch ? prsByBranch.get(w.branch) : null;
    const reviewNum = Number(wtName(w.path).match(/^review-(\d+)$/)?.[1]) || null;
    if (onlyActive && !active && !w.dirty && !t) continue;
    const id = add({ id: `wt:${w.path}`, type: 'worktree', w, active, label: wtName(w.path), sub: w.branch ?? `détaché @ ${w.head}` });
    link(`repo:${w.repo}`, id, false);
    for (const s of sessions.filter((x) => !onlyActive || ACTIVE.includes(x.state)).slice(0, 4)) {
      link(id, add({ id: `s:${s.id}`, type: 'session', s, label: what(s), sub: `${choreLabel(s.chore)} · ${s.model}` }), false);
    }
    if (t) {
      const pid = add({ id: `pr:${t.pr.number}`, type: 'pr', pr: t.pr, label: `#${t.pr.number}`, sub: t.pr.title });
      link(id, pid, false);
      if (t.issue) link(pid, add({ id: `t:${t.key}`, type: 'ticket', key: t.key, issue: t.issue, label: t.key, sub: t.issue.summary }), false);
    } else if (reviewNum && reviewByNum.get(reviewNum)) {
      const r = reviewByNum.get(reviewNum);
      link(id, add({ id: `pr:${r.number}`, type: 'pr', pr: r, label: `#${r.number}`, sub: `${r.title} · @${r.author}` }), false);
    }
  }
  const have = new Set(nodes.map((n) => n.id));
  for (const n of g.nodes) {
    if (n.type === 'ticket' && have.has(`t:${n.ref}`)) { n.alias = `t:${n.ref}`; continue; }
    const issue = n.type === 'ticket' ? S.tasks.find((t) => t.key === n.ref)?.issue : null;
    const epic = n.type === 'epic' ? (S.epics ?? []).find((e) => e.key === n.ref) : null;
    add({ id: n.id, type: n.type, manual: true, label: n.type === 'note' ? n.label : n.ref ?? n.label, sub: issue?.summary ?? epic?.summary ?? (n.type === 'note' ? '' : n.label), key: n.ref, issue });
  }
  const alias = Object.fromEntries(g.nodes.filter((n) => n.alias).map((n) => [n.id, n.alias]));
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of g.edges) { const src = alias[e.src] ?? e.src, dst = alias[e.dst] ?? e.dst; if (ids.has(src) && ids.has(dst)) link(src, dst, true, { id: e.id, label: e.label }); }
  // Default layout: one row per worktree, its things fanned out to the right.
  const COL = { repo: 0, worktree: 300, session: 640, pr: 960, ticket: 1280, note: 1600, epic: 1600, group: 1600 };
  let row = 0; const used = {};
  for (const n of nodes) {
    if (g.pos[n.id]) { n.x = g.pos[n.id][0]; n.y = g.pos[n.id][1]; continue; }
    const col = COL[n.type] ?? 1280;
    if (n.type === 'worktree') row = Math.max(row, used[300] ?? 0);
    const y = Math.max(used[col] ?? 0, n.type === 'worktree' || n.type === 'repo' ? row : (used[col] ?? 0));
    n.x = col; n.y = n.type === 'repo' ? 0 : y;
    used[col] = n.y + (n.type === 'worktree' ? 124 : 104);
    if (n.type === 'worktree') row = n.y;
  }
  const q = f.q.toLowerCase();
  for (const n of nodes) n.hit = !q || `${n.label} ${n.sub}`.toLowerCase().includes(q);
  return { nodes, edges };
}
const NODE_W = 260;
function nodeHtml(n) {
  const sel = G.sel === n.id ? 'sel' : '';
  const dim = n.hit ? '' : 'dim';
  const base = (cls, head, body = '', actions = '') => `<div class="gn ${cls} ${sel} ${dim}" data-gn="${esc(n.id)}" style="transform:translate(${n.x}px,${n.y}px)">
    <div class="gn-head">${head}</div>${body ? `<div class="gn-body">${body}</div>` : ''}<div class="gn-act">${actions}</div><span class="port" data-port="${esc(n.id)}" title="Glisse vers un autre élément pour les relier"></span></div>`;
  if (n.type === 'repo') return base('repo', `<span class="gi">⬢</span><b>${esc(n.label)}</b>`, `<span class="faint">${esc(n.sub)}</span>`);
  if (n.type === 'worktree') {
    const w = n.w;
    return base(`worktree ${n.active ? 'live' : ''}`, `<span class="gi">⑂</span><b>${esc(n.label)}</b>${n.active ? '<span class="dot live"></span>' : ''}`,
      `<div class="mono small">${esc(n.sub)}</div><div class="gn-tags">${w.dirty ? `<span class="badge warn">● ${w.dirty} modif.</span>` : '<span class="badge ok">propre</span>'}${w.ahead ? `<span class="badge info">↑${w.ahead}</span>` : ''}${w.behind ? `<span class="badge err">↓${w.behind}</span>` : ''}${w.last_commit_at ? `<span class="faint small">${ago(w.last_commit_at)}</span>` : ''}</div>`,
      `<button class="ghost" data-wt-term="${esc(w.path)}" title="Ouvrir dans Warp">⌘</button><button class="ghost" data-wt-claude="${esc(w.path)}" title="Lancer Claude ici">▶</button>`);
  }
  if (n.type === 'session') return base(`session ${ACTIVE.includes(n.s.state) ? 'live' : ''}`, `<span class="gi">✦</span><b>${esc(n.label)}</b>`, `${sessionBadge(n.s)} <span class="faint small">${esc(n.sub)} · ${money(n.s.cost_usd)}</span>`,
    `<button class="ghost" data-open-session="${n.s.id}" title="Conversation">💬</button><button class="ghost" data-term="${n.s.id}" title="Terminal">⌘</button>`);
  if (n.type === 'pr') return base('pr', `<span class="gi">⇄</span><b>${esc(n.label)}</b> ${checksBadge(n.pr.checks)}`, `<div class="small gn-clip">${esc(n.sub)}</div>`, `<a class="ghost" href="${esc(n.pr.url)}" target="_blank">↗</a>`);
  if (n.type === 'ticket') return base(`ticket ${n.manual ? 'mine' : ''}`, `<span class="gi">◆</span><b>${esc(n.label)}</b>${n.issue ? ` <span class="faint small">${esc(n.issue.status)}</span>` : ''}`, `<div class="small gn-clip">${esc(n.sub ?? '')}</div>`,
    `<a class="ghost" href="${esc(`${S.jira.site}/browse/${n.key}`)}" target="_blank">↗</a>${n.manual ? `<button class="ghost" data-gdel="${esc(n.id)}" title="Retirer">✕</button>` : ''}`);
  if (n.type === 'epic') return base('epic', `<span class="gi">✦</span><b>${esc(n.label)}</b>`, `<div class="small gn-clip">${esc(n.sub ?? '')}</div>`, `<button class="ghost" data-epic="${esc(n.key)}" title="Planifier">✦</button><button class="ghost" data-gdel="${esc(n.id)}">✕</button>`);
  return base('note', `<span class="gi">✎</span><span class="gn-note" contenteditable="true" data-gnote="${esc(n.id)}" spellcheck="false">${esc(n.label || 'Note…')}</span>`, '', `<button class="ghost" data-gdel="${esc(n.id)}">✕</button>`);
}
function edgePath(a, b) {
  const x1 = a.x + NODE_W, y1 = a.y + 28, x2 = b.x, y2 = b.y + 28;
  const dx = Math.max(60, Math.abs(x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}
function renderAtelier() {
  if (G.drag || G.link) return; // never rebuild under the pointer
  filterBar('atelier', {
    search: 'Surligner (worktree, branche, ticket, session)…',
    chips: [{ name: 'scope', options: [['all', 'Tout'], ['active', 'Actifs seulement']] }],
    extra: `<button data-gadd="note">＋ Note</button><button data-gadd="ticket">＋ Ticket</button><button data-gadd="epic">＋ Epic</button>
      <span class="spacer"></span><button class="ghost" data-gzoom="-">−</button><button class="ghost" data-gzoom="fit">Ajuster</button><button class="ghost" data-gzoom="+">＋</button>
      <button class="ghost" id="gReset" title="Remettre la disposition automatique">⟲ Disposition auto</button>`,
  });
  const { nodes, edges } = (G.built = buildGraph());
  const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const wrap = $('#r-atelier');
  if (!wrap.querySelector('.gwrap')) wrap.innerHTML = `<div class="gwrap" id="gWrap"><div class="gworld" id="gWorld"><svg class="gedges" id="gEdges"></svg><div id="gNodes"></div></div>
    <div class="ghint">Glisse le fond pour te déplacer · molette pour zoomer · glisse un ● sur un autre élément pour les relier · Suppr pour effacer un lien</div></div>`;
  $('#gNodes').innerHTML = nodes.map(nodeHtml).join('');
  $('#gEdges').innerHTML = `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>
    ${edges.map((e, i) => { const a = by[e.src], b = by[e.dst]; if (!a || !b) return ''; return `<path class="ge ${e.manual ? 'manual' : ''} ${G.sel === e.id ? 'sel' : ''}" data-ei="${i}" ${e.id ? `data-ge="${e.id}"` : ''} d="${edgePath(a, b)}" marker-end="url(#ah)"/>${e.label ? `<text x="${(a.x + NODE_W + b.x) / 2}" y="${(a.y + b.y) / 2 + 22}" class="gel">${esc(e.label)}</text>` : ''}`; }).join('')}
    <path id="gTemp" class="ge temp" d=""/>`;
  applyView();
}
function applyView() { const w = $('#gWorld'); if (w) w.style.transform = `translate(${G.pan[0]}px,${G.pan[1]}px) scale(${G.zoom})`; store.set('atelierView', { pan: G.pan, zoom: G.zoom }); }
const toWorld = (e) => { const r = $('#gWrap').getBoundingClientRect(); return [(e.clientX - r.left - G.pan[0]) / G.zoom, (e.clientY - r.top - G.pan[1]) / G.zoom]; };
function fitView() {
  const ns = G.built?.nodes ?? []; if (!ns.length) return;
  const r = $('#gWrap').getBoundingClientRect();
  const minX = Math.min(...ns.map((n) => n.x)), maxX = Math.max(...ns.map((n) => n.x + NODE_W)), minY = Math.min(...ns.map((n) => n.y)), maxY = Math.max(...ns.map((n) => n.y + 90));
  G.zoom = Math.max(0.25, Math.min(1.2, Math.min(r.width / (maxX - minX + 80), r.height / (maxY - minY + 80))));
  G.pan = [40 - minX * G.zoom, 40 - minY * G.zoom]; applyView();
}
document.addEventListener('mousedown', (e) => {
  if (pageFromHash() !== 'atelier' || !e.target.closest('#gWrap') || e.button !== 0) return;
  const port = e.target.closest('[data-port]');
  if (port) { e.preventDefault(); G.link = { src: port.dataset.port }; return; }
  if (e.target.closest('button, a, [contenteditable]')) return;
  const node = e.target.closest('[data-gn]');
  const edge = e.target.closest('[data-ge]');
  if (edge) { G.sel = edge.dataset.ge; renderAtelier(); return; }
  if (node) {
    const n = G.built.nodes.find((x) => x.id === node.dataset.gn);
    const [wx, wy] = toWorld(e);
    G.drag = { id: n.id, el: node, dx: wx - n.x, dy: wy - n.y, n, moved: false };
    G.sel = n.id; document.querySelectorAll('.gn.sel').forEach((x) => x.classList.remove('sel')); node.classList.add('sel');
  } else { G.drag = { pan: true, sx: e.clientX - G.pan[0], sy: e.clientY - G.pan[1] }; G.sel = null; }
});
document.addEventListener('mousemove', (e) => {
  if (G.link) {
    const a = G.built.nodes.find((n) => n.id === G.link.src); const [wx, wy] = toWorld(e);
    $('#gTemp')?.setAttribute('d', edgePath(a, { x: wx, y: wy - 28 }));
    document.querySelectorAll('.gn.drop').forEach((x) => x.classList.remove('drop'));
    e.target.closest?.('[data-gn]')?.classList.add('drop');
    return;
  }
  if (!G.drag) return;
  if (G.drag.pan) { G.pan = [e.clientX - G.drag.sx, e.clientY - G.drag.sy]; applyView(); return; }
  const [wx, wy] = toWorld(e);
  const n = G.drag.n; n.x = Math.round(wx - G.drag.dx); n.y = Math.round(wy - G.drag.dy); G.drag.moved = true;
  G.drag.el.style.transform = `translate(${n.x}px,${n.y}px)`;
  const by = Object.fromEntries(G.built.nodes.map((x) => [x.id, x]));
  G.built.edges.forEach((ed, i) => { if (ed.src === n.id || ed.dst === n.id) $(`#gEdges [data-ei="${i}"]`)?.setAttribute('d', edgePath(by[ed.src], by[ed.dst])); });
});
document.addEventListener('mouseup', async (e) => {
  if (G.link) {
    const src = G.link.src; G.link = null;
    document.querySelectorAll('.gn.drop').forEach((x) => x.classList.remove('drop'));
    $('#gTemp')?.setAttribute('d', '');
    const dst = e.target.closest?.('[data-gn]')?.dataset.gn;
    if (dst && dst !== src) await onConnect(src, dst);
    return;
  }
  const d = G.drag; G.drag = null;
  if (d && !d.pan && d.moved) await post('/api/graph/pos', { items: [{ id: d.id, x: d.n.x, y: d.n.y }] }).catch((err) => toast(err.message));
  if (d?.pan) applyView();
});
$('#r-atelier')?.addEventListener('wheel', (e) => {
  if (!e.target.closest('#gWrap')) return;
  e.preventDefault();
  const r = $('#gWrap').getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const z = Math.max(0.2, Math.min(2, G.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  G.pan = [mx - ((mx - G.pan[0]) * z) / G.zoom, my - ((my - G.pan[1]) * z) / G.zoom]; G.zoom = z; applyView();
}, { passive: false });
const nodeById = (id) => G.built.nodes.find((n) => n.id === id);
async function onConnect(src, dst) {
  let a = nodeById(src), b = nodeById(dst);
  const pick = (type) => (a.type === type ? a : b.type === type ? b : null);
  const ticket = pick('ticket'), wt = pick('worktree'), sess = pick('session');
  await post('/api/graph/addEdge', { src, dst }).catch((err) => toast(err.message));
  if (ticket && wt) {
    const t = S.tasks.find((x) => x.key === ticket.key);
    return openChore({ kind: 'here', cwd: wt.w.path, ...(t ? { task: t.key, chore: t.next?.key ?? 'start-task' } : { chore: 'custom' }) });
  }
  if (ticket && sess) {
    openDrawer(sess.s.id);
    $('#sText').value = `Prends aussi en charge ${ticket.key}${ticket.sub ? ` — « ${ticket.sub} »` : ''} (${S.jira.site}/browse/${ticket.key}). Lis le ticket (Atlassian) et dis-moi comment tu l'intègres avant de coder.`;
    return toast('Message préparé — relis et envoie');
  }
  if (wt && pick('epic')) return openChore({ kind: 'epic', epic: pick('epic').key });
  toast('Relié ✓');
}
async function addGraphNode(type) {
  const r = $('#gWrap').getBoundingClientRect();
  const [x, y] = [(r.width / 2 - G.pan[0]) / G.zoom - NODE_W / 2, (r.height / 2 - G.pan[1]) / G.zoom - 40];
  if (type === 'note') return post('/api/graph/addNode', { type, label: 'Nouvelle note', x, y });
  const key = prompt(type === 'ticket' ? 'Clé du ticket (ex. MO-4692) :' : 'Clé de l’epic (ex. MO-4688) :')?.trim().toUpperCase();
  if (!key) return;
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return toast('Clé invalide');
  const label = type === 'ticket' ? S.tasks.find((t) => t.key === key)?.issue?.summary : (S.epics ?? []).find((e) => e.key === key)?.summary;
  return post('/api/graph/addNode', { type, ref: key, label: label ?? key, x, y });
}
document.addEventListener('click', async (e) => {
  if (pageFromHash() !== 'atelier') return;
  const b = e.target.closest('button');
  try {
    if (b?.dataset.gadd) return await addGraphNode(b.dataset.gadd);
    if (b?.dataset.gzoom) { if (b.dataset.gzoom === 'fit') return fitView(); G.zoom = Math.max(0.2, Math.min(2, G.zoom * (b.dataset.gzoom === '+' ? 1.2 : 1 / 1.2))); return applyView(); }
    if (b?.id === 'gReset') { if (confirm('Remettre toutes les positions en disposition automatique ?')) { await post('/api/graph/resetPos'); setTimeout(fitView, 400); } return; }
    if (b?.dataset.gdel) return await post('/api/graph/deleteNode', { id: b.dataset.gdel });
    if (b?.dataset.wtTerm) { await post('/api/worktree/terminal', { path: b.dataset.wtTerm }); return toast('Ouvert dans Warp'); }
    if (b?.dataset.wtClaude) return openChore({ kind: 'here', cwd: b.dataset.wtClaude, chore: 'custom' });
  } catch (err) { toast(err.message); }
});
document.addEventListener('keydown', async (e) => {
  if (pageFromHash() !== 'atelier' || e.target.matches('input, textarea, [contenteditable]') || !G.sel) return;
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const edge = S.graph?.edges.find((x) => x.id === G.sel);
  const node = S.graph?.nodes.find((x) => x.id === G.sel);
  if (edge) await post('/api/graph/deleteEdge', { id: edge.id });
  else if (node) await post('/api/graph/deleteNode', { id: node.id });
  else return toast('Les éléments automatiques ne se suppriment pas — seulement tes liens et tes nœuds');
  G.sel = null;
});
document.addEventListener('focusout', (e) => {
  const id = e.target.dataset?.gnote;
  if (id) post('/api/graph/editNode', { id, label: e.target.textContent.trim() }).catch(() => {});
});
RENDER.atelier = renderAtelier;

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
  if (sync?.at && Date.now() - new Date(sync.at) > 15 * 60_000) parts.push(`⚠ Dernier sync GitHub il y a ${ago(sync.at)} — clique « ⟳ Actualiser »`);
  $('#banner').innerHTML = parts.join('<br>');
  const blocked = S.sessions.filter((s) => s.state === 'blocked').length;
  document.title = blocked ? `(${blocked}) Eric's AI Dashboard` : "Eric's AI Dashboard";
}

// ---- per-page refresh ---------------------------------------------------------------
// Which sources each page shows (mirrors SCOPES on the server) and how old each one is.
const PAGE_SOURCES = {
  standup: ['github', 'jira'], atelier: ['github'], home: ['github', 'jira', 'slack'], tasks: ['github', 'jira'], jira: ['jira'], epics: ['jira'], reviews: ['github'], radar: ['github'],
  brutal: ['github'], slack: ['slack'], sessions: [], usage: ['usage'], stack: [], data: ['usage'],
};
const SOURCE_LABEL = { github: 'GitHub', jira: 'Jira', slack: 'Slack', usage: 'Transcripts' };
const STALE_MS = { github: 10 * 60_000, jira: 45 * 60_000, slack: 60 * 60_000, usage: 15 * 60_000 };
const sourceAt = (k) => ({ github: S.sync?.at, jira: S.jira?.at, slack: S.slack?.at, usage: U?.scannedAt }[k]);
function renderFresh() {
  if (!S) return;
  const src = PAGE_SOURCES[pageFromHash()] ?? [];
  $('#pageFresh').innerHTML = src.length ? src.map((k) => { const at = sourceAt(k); const old = !at || Date.now() - new Date(at) > STALE_MS[k];
    return `<div class="${old ? 'old' : ''}"><b>${SOURCE_LABEL[k]}</b> ${at ? `il y a ${ago(at)}` : 'jamais'}</div>`; }).join('')
    : '<div><b>Live</b> · mis à jour en continu</div>';
}
let refreshing = false;
async function refreshPage() {
  if (refreshing) return;
  refreshing = true;
  const btn = $('#refreshBtn'), page = pageFromHash();
  btn.classList.add('spin'); btn.disabled = true; btn.textContent = '⟳ Actualisation…';
  const slow = (PAGE_SOURCES[page] ?? []).some((k) => k === 'jira' || k === 'slack');
  if (slow) toast('Jira / Slack passent par Claude : ~30 s à 2 min');
  try {
    const { results } = await post('/api/refresh', { scope: page });
    const r = await fetch('/api/state');
    if (r.ok) { S = await r.json(); saveState(); }
    if (page === 'usage') { uCache.clear(); U = null; }
    render();
    const ko = Object.entries(results).filter(([, v]) => v !== 'ok');
    toast(ko.length ? `⚠ ${ko.map(([k, v]) => `${k} : ${v}`).join(' · ')}` : 'À jour ✓');
  } catch (e) { toast(e.message); } finally {
    refreshing = false; btn.classList.remove('spin'); btn.disabled = false; btn.textContent = '⟳ Actualiser';
  }
}
$('#refreshBtn').onclick = refreshPage;
document.addEventListener('keydown', (e) => { if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.target.matches('input, textarea, select') && !document.querySelector('dialog[open]')) refreshPage(); });
setInterval(renderFresh, 15_000);

// Only the page on screen is rendered; the others are marked stale and drawn when opened.
// A page is skipped when none of the state sections it reads changed.
const PAGE_FN = {
  standup: [() => renderStandup(), ['standups']],
  atelier: [() => renderAtelier(), ['graph', 'sessions', 'tasks', 'reviews', 'epics']],
  home: [() => renderHome(), ['sessions', 'tasks', 'reviews', 'reviewHistory', 'slack']],
  tasks: [() => renderTasks(), ['tasks', 'chores']], jira: [() => renderJira(), ['tasks', 'jira']], epics: [() => renderEpics(), ['epics']],
  reviews: [() => renderReviews(), ['reviews', 'autoReview', 'team']], radar: [() => renderRadar(), ['autoReview', 'sessions', 'reviewHistory', 'events']],
  brutal: [() => renderBrutal(), ['reviewHistory']], slack: [() => renderSlack(), ['slack']], sessions: [() => renderSessions(), ['sessions']],
  usage: [() => RENDER.usage(), []], stack: [() => renderStack(), ['stack', 'tasks', 'reviews']], data: [() => renderData(), ['events', 'db']],
};
const stale = new Set(Object.keys(PAGE_FN));
function renderCounts() {
  const n = (id, v) => { const el = $(id); if (el && el.textContent !== String(v || '')) el.textContent = v || ''; };
  n('#c-tasks', S.tasks.filter((t) => t.pr || t.issue?.status_category === 'indeterminate' || t.sessions.length).length);
  n('#c-jira', S.tasks.filter((t) => t.issue).length);
  n('#c-epics', (S.epics ?? []).filter((e) => e.plans.some((p) => ACTIVE.includes(p.state))).length);
  n('#c-reviews', S.reviews.filter((r) => r.team && !r.my_review && !r.session && !r.is_draft).length);
  n('#c-brutal', (S.reviewHistory ?? []).filter((r) => new Date(r.started_at) >= startOfDay()).length);
  n('#c-slack', (S.slack?.items ?? []).filter((i) => i.status === 'new' && i.priority !== 'fyi').length);
  n('#c-sessions', S.sessions.filter((x) => ACTIVE.includes(x.state)).length);
  n('#c-home', actionItems().filter((i) => i.w <= 1).length);
  const live = S.sessions.filter((x) => x.chore === 'auto-review' && ACTIVE.includes(x.state));
  $('#radarDot').className = `dot ${live.length ? 'live' : S.autoReview?.enabled ? 'ok' : ''}`;
  if (S.stack) $('#stackDot').className = `dot ${S.stack.busy ? 'warn' : S.stack.running ? 'ok' : ''}`;
}
function render(changed) {
  renderChrome();
  renderFresh();
  renderCounts();
  for (const [page, [, deps]] of Object.entries(PAGE_FN)) if (!changed || deps.some((d) => changed.includes(d))) stale.add(page);
  const page = pageFromHash();
  if (!stale.has(page)) return;
  stale.delete(page);
  try { PAGE_FN[page][0](); } catch (e) { console.error(page, e); }
}

// ---- chore modal ---------------------------------------------------------------------
let pending = null;
async function openChore(params) {
  const res = await fetch(`/api/chore?${new URLSearchParams(params)}`);
  const d = await res.json();
  if (!res.ok) return toast(d.error);
  pending = params;
  $('#mTitle').textContent = d.label;
  $('#mSub').textContent = params.kind === 'here' ? `Dans le worktree ${params.cwd}${params.task ? ` · ${params.task}` : ''} — sur sa branche actuelle`
    : params.kind === 'review' ? `PR #${params.pr}`
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
    if (b.id === 'radarCheck') return refreshPage();
    if (b.id === 'standupBtn') { location.hash = 'standup'; return; }
    if (b.id === 'standupGen' || b.id === 'standupGenOpus') { await post('/api/standup', b.id === 'standupGenOpus' ? { model: 'opus' } : {}); return toast('Stand-up en cours d’écriture (~30 s)'); }
    if (b.dataset.standup) { standupSel = Number(b.dataset.standup); return renderStandup(); }
    if (b.id === 'standupCopy') { const s = (S.standups ?? []).find((x) => x.id === standupSel) ?? S.standups?.find((x) => x.result); await navigator.clipboard.writeText(s?.result?.slack ?? ''); return toast('Copié — colle-le dans Slack ✓'); }
    if (b.id === 'slackSync' || b.id === 'slackDeep') { await post('/api/slack/sync', b.id === 'slackDeep' ? { model: 'sonnet' } : {}); return toast('Tri Slack lancé (≈ 1-2 min)'); }
    if (b.dataset.slack) { await post(`/api/slack/${encodeURIComponent(b.dataset.slack)}/status`, { status: b.dataset.st }); return; }
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
  const map = { w: 'atelier', h: 'home', t: 'tasks', j: 'jira', e: 'epics', r: 'reviews', a: 'radar', b: 'brutal', k: 'slack', s: 'sessions', u: 'usage', l: 'stack', d: 'data' };
  if (Date.now() - gPressed < 800 && map[e.key]) { location.hash = map[e.key]; gPressed = 0; }
});

// ---- live --------------------------------------------------------------------------
// Last state kept in the browser: a reload paints instantly, then the stream catches up.
let saveTimer;
const saveState = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set('lastState', S), 3000); };
let pendingChanged = null;
function apply(changed) {
  if (document.activeElement?.matches('textarea') || document.activeElement?.closest('tbody select')) {
    pendingChanged = [...(pendingChanged ?? []), ...changed]; renderChrome(); renderCounts(); return;
  }
  render(changed);
}
document.addEventListener('focusout', () => { if (pendingChanged) { const c = pendingChanged; pendingChanged = null; setTimeout(() => render(c), 0); } });
function connect() {
  const es = new EventSource('/live');
  es.addEventListener('state', (e) => {
    S = JSON.parse(e.data);
    if (!stackLog.length && S.stack?.log) stackLog = S.stack.log;
    saveState();
    apply(Object.keys(S));
  });
  es.addEventListener('patch', (e) => {
    const p = JSON.parse(e.data);
    Object.assign(S, p);
    saveState();
    apply(Object.keys(p));
  });
  es.addEventListener('stacklog', (e) => { stackLog.push(JSON.parse(e.data)); if (stackLog.length > 400) stackLog = stackLog.slice(-400); renderStackLog(); });
  es.onerror = () => { $('#syncInfo').textContent = 'déconnecté du serveur…'; };
}
// ?snapshot: one fetch, no live stream (headless screenshots never settle on an open SSE).
if (new URLSearchParams(location.search).has('snapshot')) fetch('/api/state').then((r) => r.json()).then((d) => { S = d; stackLog = d.stack?.log ?? []; render(); });
else {
  const cachedState = store.get('lastState', null);
  if (cachedState?.tasks) { S = cachedState; render(); }
  connect();
}
// Relative times ("il y a 3 min") on the visible page.
setInterval(() => { if (S && !document.activeElement?.matches('select, textarea, input') && ['home', 'sessions'].includes(pageFromHash())) { stale.add(pageFromHash()); render([]); } }, 30_000);
setInterval(() => S && pageFromHash() === 'usage' && loadUsage(true), 60_000);
