// Voice Notes Command Center
// All database access goes through /api/*, which holds the Supabase key
// server side and checks the login cookie on every call.

const S = {
  notes: [], waiting: [], contacts: {}, handoffs: [], loaded: false,
  jobsFilter: 'active', jobType: 'all', loopsScope: 'all', waitingTab: 'open',
  vaultTab: 'all', vaultQuery: '',
  expanded: new Set(), editing: null, handoffing: null
};
const app = document.getElementById('app');
const DAY = 86400000;

/* ---------- small helpers ---------- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');
const daysSince = (ts) => Math.floor((Date.now() - new Date(ts).getTime()) / DAY);
const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const todayStr = () => new Date().toLocaleDateString('en-CA');
function dayLabel(ts) {
  const d = new Date(ts), t = new Date();
  const k = d.toDateString();
  if (k === t.toDateString()) return 'Today';
  if (k === new Date(Date.now() - DAY).toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
}
function ago(ts) {
  const d = daysSince(ts);
  if (d <= 0) return 'Today';
  if (d === 1) return '1 day';
  return d + ' days';
}
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- job names ----------
   The same job gets logged several ways ("5403 Soledad Mountain",
   "Soledad Mountain", "UNKNOWN: Soledad Mountain"). Group them under one
   key without touching the data. "Taft / Streamview" counts for both. */
const SUFFIX = /\s+(dr|drive|st|street|ave|avenue|rd|road|ct|court|ln|lane|way|pl|place|blvd|cir|circle)\.?$/i;
const display = {};
function rawJobs(name) {
  const first = String(name || '').split('\n')[0].trim();
  if (!first || /^general$/i.test(first)) return [];
  return first.split(/\s*\/\s*|\s+and\s+/i).map((p) => p.replace(/^unknown:\s*/i, '').trim()).filter(Boolean);
}
function jobKey(part) {
  return part.toLowerCase().replace(/^\d+\s+/, '').replace(SUFFIX, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function jobKeys(n) {
  const parts = rawJobs(n.job_name);
  if (!parts.length) return ['general'];
  return [...new Set(parts.map(jobKey).filter(Boolean))];
}
function learnNames() {
  for (const k in display) delete display[k];
  display.general = 'General';
  for (const n of S.notes) {
    for (const p of rawJobs(n.job_name)) {
      const k = jobKey(p);
      const cur = display[k];
      // Prefer the version with a street number, then the longer one.
      const score = (s) => (/^\d/.test(s) ? 1000 : 0) + s.length;
      if (!cur || score(p) > score(cur)) display[k] = p;
    }
  }
  for (const w of S.waiting) {
    for (const p of rawJobs(w.job)) { const k = jobKey(p); if (!display[k]) display[k] = p; }
  }
}
const jobName = (k) => display[k] || k;
const jobHref = (k) => '#/job/' + encodeURIComponent(k);

/* ---------- note helpers ---------- */
const isOpen = (n) => n.is_open_loop === true && n.loop_resolved !== true;
const isLoop = (n) => n.is_open_loop === true;
function title(n) {
  if (n.title) return n.title;
  const act = String(n.action_required || '').split('|')[0].trim();
  if (act && !/^none$/i.test(act)) return act;
  const src = String(n.transcript || n.claude_response || 'Untitled note').replace(/\s+/g, ' ').trim();
  return src.length > 90 ? src.slice(0, 88).replace(/\s+\S*$/, '') + '…' : src;
}
function typeOf(n) {
  const t = (n.entry_type || n.kind || '').toLowerCase();
  if (t) return t;
  return String(n.note_type || '').toUpperCase() === 'JOBSITE' ? 'jobsite' : 'note';
}
const handoffFor = (id) => S.handoffs.find((h) => Number(h.voice_note_id) === Number(id) && h.status !== 'done');
function person(n) {
  const p = String(n.sub_or_person || '').trim();
  return p && !/^(none|n\/a|unknown)$/i.test(p) ? p : '';
}
function waitingOpen(w) { return w.status === 'open' && !(w.snooze_until && w.snooze_until > todayStr()); }
function contact(w) { return S.contacts[w.contact_id] || null; }
function matches(n, q) {
  const hay = [title(n), n.transcript, n.claude_response, n.job_name, n.sub_or_person, n.trade, n.loop_code, n.theme].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/* ---------- data ---------- */
async function api(path, opts) {
  const r = await fetch(path, {
    method: opts && opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin'
  });
  let data = {};
  try { data = await r.json(); } catch (e) { /* empty */ }
  if (r.status === 401 && data.error === 'login') { showLogin(); throw new Error('login'); }
  if (r.status === 503 && data.error === 'setup') { showSetup(); throw new Error('setup'); }
  if (!r.ok || data.ok === false) throw new Error(data.error || (r.status + ' ' + r.statusText));
  return data;
}
async function load(force) {
  if (S.loaded && !force) return;
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spin');
  try {
    const d = await api('/api/notes');
    S.notes = d.rows || [];
    S.waiting = d.waiting || [];
    S.handoffs = d.handoffs || [];
    S.contacts = {};
    (d.contacts || []).forEach((c) => { S.contacts[c.id] = c; });
    S.loaded = true;
    learnNames();
  } finally { btn.classList.remove('spin'); }
}

/* ---------- shared pieces ---------- */
function loopPill(n) {
  if (!isLoop(n)) return '';
  const open = isOpen(n);
  const code = n.loop_code || ('#' + n.id);
  return `<span class="pill code ${open ? 'warn' : 'ok'}">${esc(code)} · ${open ? 'open' : 'closed'}</span>`;
}
function prioPill(n) {
  const p = String(n.priority || '').toUpperCase();
  if (!p) return '';
  return `<span class="pill ${p === 'HIGH' ? 'warn' : 'quiet'}">${esc(cap(p))}</span>`;
}
function editorHtml(n) {
  const jobs = Object.keys(display).filter((k) => k !== 'general').map(jobName).sort();
  const curJob = String(n.job_name || '').split('\n')[0].trim();
  if (curJob && !jobs.includes(curJob) && curJob !== 'General') jobs.unshift(curJob);
  const opt = (v, cur, label) => `<option value="${esc(v)}"${String(v) === String(cur || '') ? ' selected' : ''}>${esc(label || v || 'None')}</option>`;
  return `
  <form class="editor" data-form="tags" data-id="${n.id}">
    <label>Job<select name="job_name">${opt('General', curJob || 'General')}${jobs.map((j) => opt(j, curJob)).join('')}</select></label>
    <label>Person<input name="sub_or_person" value="${esc(n.sub_or_person || '')}"></label>
    <label>Trade<input name="trade" value="${esc(n.trade || '')}"></label>
    <label>Type<select name="entry_type">${['', 'task', 'observation', 'decision', 'idea', 'reflection'].map((t) => opt(t, n.entry_type, t ? cap(t) : 'None')).join('')}</select></label>
    <label>Priority<select name="priority">${['', 'HIGH', 'MED', 'LOW'].map((p) => opt(p, String(n.priority || '').toUpperCase(), p ? cap(p) : 'None')).join('')}</select></label>
    <label>Work or personal<select name="work_or_personal">${['', 'work', 'personal'].map((p) => opt(p, String(n.work_or_personal || '').toLowerCase(), p ? cap(p) : 'None')).join('')}</select></label>
    <label class="full">Title<input name="title" value="${esc(title(n))}"></label>
    <div class="actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button class="btn solid" type="submit">Save tags</button></div>
  </form>`;
}
function handoffHtml(n) {
  return `
  <form class="editor" data-form="handoff" data-id="${n.id}">
    <label class="full">What should Duet do with this?<textarea name="request">${esc(title(n))}</textarea></label>
    <div class="actions"><button type="button" class="btn" data-act="cancel">Cancel</button><button class="btn sage" type="submit">Send to Duet</button></div>
  </form>`;
}
function noteCard(n, opts) {
  const o = opts || {};
  const open = S.expanded.has(n.id);
  const h = handoffFor(n.id);
  const keys = jobKeys(n);
  const tags = [
    o.showJob ? keys.map((k) => `<a href="${jobHref(k)}" style="text-decoration:underline;text-underline-offset:3px">${esc(jobName(k))}</a>`).join(', ') : '',
    esc(person(n)), esc(n.trade || '')
  ].filter(Boolean).join(' · ');
  const body = n.transcript || n.claude_response || '';
  return `
  <article class="note${isOpen(n) ? ' is-open' : ''}" id="note-${n.id}">
    <div class="note-meta">
      <span class="when">${o.showDate ? esc(fmtDate(n.created_at)) + ' · ' : ''}${esc(fmtTime(n.created_at))}</span>
      <span class="pill">${esc(cap(typeOf(n)))}</span>
      ${loopPill(n)}${prioPill(n)}
      ${h ? '<span class="pill duet">With Duet</span>' : ''}
    </div>
    <h3>${esc(title(n))}</h3>
    ${body ? `<p class="body${open ? '' : ' clamp'}">${esc(body)}</p>` : ''}
    ${open && n.claude_response && n.transcript ? `<div class="extract"><b>Claude's read</b>${esc(n.claude_response)}</div>` : ''}
    ${body.length > 140 || n.claude_response ? `<button class="more" data-act="expand" data-id="${n.id}">${open ? 'Show less' : 'Show more'}</button>` : ''}
    ${S.editing === n.id ? editorHtml(n) : ''}
    ${S.handoffing === n.id ? handoffHtml(n) : ''}
    <div class="note-foot">
      <span class="tags">${tags || '&nbsp;'}</span>
      ${isLoop(n) ? `<button class="btn dark" data-act="${isOpen(n) ? 'close' : 'reopen'}" data-id="${n.id}">${isOpen(n) ? 'Close loop' : 'Reopen'}</button>` : ''}
      <button class="btn" data-act="edit" data-id="${n.id}">Edit tags</button>
      ${h ? `<button class="btn sage" disabled>With Duet</button>` : `<button class="btn sage" data-act="handoff" data-id="${n.id}"><span class="desk-only">Hand off to </span><span class="mobile-only">To </span>Duet</button>`}
    </div>
  </article>`;
}
function timeline(notes, showJob) {
  if (!notes.length) return '<div class="empty">Nothing here yet.</div>';
  let last = '', out = '';
  for (const n of notes) {
    const d = dayLabel(n.created_at);
    if (d !== last) { out += `<p class="day">${esc(d)}</p>`; last = d; }
    out += noteCard(n, { showJob });
  }
  return out;
}
function chips(name, items, cur) {
  return `<div class="chips">${items.map(([v, label, count]) =>
    `<button class="chip${v === cur ? ' on' : ''}" data-chip="${name}" data-v="${v}">${esc(label)}${count != null ? ` <span class="mono">${count}</span>` : ''}</button>`).join('')}</div>`;
}

/* ---------- views ---------- */
function jobsData() {
  const map = {};
  for (const n of S.notes) {
    for (const k of jobKeys(n)) {
      const j = map[k] || (map[k] = { key: k, notes: [], open: 0, people: {} });
      j.notes.push(n);
      if (isOpen(n)) j.open++;
      const p = person(n);
      if (p && !/jobtread/i.test(p)) j.people[p] = (j.people[p] || 0) + 1;
    }
  }
  for (const w of S.waiting) {
    if (!waitingOpen(w)) continue;
    const keys = rawJobs(w.job).map(jobKey);
    for (const k of keys) if (map[k]) map[k].waiting = (map[k].waiting || 0) + 1;
  }
  return Object.values(map).map((j) => {
    j.last = j.notes[0];
    j.age = daysSince(j.last.created_at);
    j.waiting = j.waiting || 0;
    j.who = Object.entries(j.people).sort((a, b) => b[1] - a[1]).slice(0, 2).map((e) => e[0]).join(', ');
    return j;
  });
}
function statusPill(age) {
  if (age < 14) return '<span class="pill ok">Active</span>';
  if (age < 30) return `<span class="pill quiet">Quiet ${age} days</span>`;
  return `<span class="pill warn">Quiet ${age} days</span>`;
}

function viewJobs() {
  const all = jobsData();
  const general = all.find((j) => j.key === 'general');
  const jobs = all.filter((j) => j.key !== 'general').sort((a, b) => a.age - b.age);
  const shown = jobs.filter((j) => S.jobsFilter === 'all' || (S.jobsFilter === 'active' ? j.age < 14 : j.age >= 14));
  const now = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const genOpen = general ? general.notes.filter(isOpen) : [];
  const genStale = genOpen.filter((n) => daysSince(n.created_at) >= 14).length;
  return `
  <div class="page-head">
    <div><p class="eyebrow">${esc(now)}</p><h1>Jobs</h1></div>
    ${chips('jobsFilter', [['active', 'Active', jobs.filter((j) => j.age < 14).length], ['quiet', 'Quiet 14+ days', jobs.filter((j) => j.age >= 14).length], ['all', 'All jobs', jobs.length]], S.jobsFilter)}
  </div>
  ${shown.length ? `<div class="grid">${shown.map((j) => `
    <a class="job-card" href="${jobHref(j.key)}">
      <div class="job-top">
        <div style="min-width:0"><h2>${esc(jobName(j.key))}</h2>${j.who ? `<p class="who">${esc(j.who)}</p>` : ''}</div>
        ${statusPill(j.age)}
      </div>
      <p class="last">${esc(title(j.last))}</p>
      <div class="counts">
        <span class="${j.open ? 'hot' : ''}"><strong>${j.open}</strong> open loops</span>
        <span class="${j.waiting ? 'hot' : ''}"><strong>${j.waiting}</strong> waiting</span>
        <span class="right">${j.notes.length} note${j.notes.length === 1 ? '' : 's'} · ${esc(fmtDate(j.last.created_at))}</span>
      </div>
    </a>`).join('')}</div>` : '<div class="empty">No jobs in this view.</div>'}
  ${general ? `
  <h2 class="section-title">Not tied to a job</h2>
  <a class="general-card" href="${jobHref('general')}">
    <div style="flex:1 1 260px"><h3>General and personal</h3>
      <p>${genOpen.length ? esc(genOpen.slice(0, 3).map(title).join(' · ')) : esc(title(general.last))}</p></div>
    <span style="font-size:13px"><strong style="font-size:15px">${genOpen.length}</strong> open loops${genStale ? ` · ${genStale} stale` : ''}</span>
    <span style="font-size:13px">${general.notes.length} notes · ${esc(fmtDate(general.last.created_at))}</span>
  </a>` : ''}`;
}

function viewJob(key) {
  const j = jobsData().find((x) => x.key === key);
  if (!j) return `<a class="back" href="#/jobs">← All jobs</a><div class="empty">No notes for this job.</div>`;
  const variants = [...new Set(j.notes.flatMap((n) => rawJobs(n.job_name)).filter((p) => jobKey(p) === key && p !== jobName(key)))];
  const groups = {
    all: j.notes,
    loops: j.notes.filter(isLoop),
    records: j.notes.filter((n) => (n.kind || '').toLowerCase() === 'record'),
    decisions: j.notes.filter((n) => typeOf(n) === 'decision'),
    ideas: j.notes.filter((n) => typeOf(n) === 'idea' || typeOf(n) === 'reflection')
  };
  if (!groups[S.jobType]) S.jobType = 'all';
  const typeChips = chips('jobType', [['all', 'All', groups.all.length], ['loops', 'Loops', groups.loops.length], ['records', 'Records', groups.records.length], ['decisions', 'Decisions', groups.decisions.length], ['ideas', 'Ideas', groups.ideas.length]], S.jobType);
  const people = Object.entries(j.people).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const waiting = S.waiting.filter((w) => w.status === 'open' && rawJobs(w.job).map(jobKey).includes(key));
  const duet = S.handoffs.filter((h) => h.status !== 'done' && j.notes.some((n) => Number(n.id) === Number(h.voice_note_id)));
  return `
  <a class="back" href="#/jobs"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>All jobs</a>
  <div class="page-head" style="margin-top:6px">
    <div><h1>${esc(key === 'general' ? 'General and personal' : jobName(key))}</h1>
      <p class="sub">${[j.who, variants.length ? 'also logged as ' + variants.map((v) => '“' + v + '”').join(', ') : '', j.notes.length + ' notes'].filter(Boolean).map(esc).join(' · ')}</p></div>
    <div class="stats">
      <span><strong>${j.open}</strong>open loops</span>
      <span><strong>${waiting.length}</strong>waiting</span>
      <span><strong>${esc(fmtDate(j.last.created_at))}</strong>last note</span>
    </div>
  </div>
  <div class="two-col">
    <section class="timeline" aria-label="Notes"><div class="mobile-only" style="overflow-x:auto;padding-bottom:4px">${typeChips}</div>${timeline(groups[S.jobType], false)}</section>
    <aside class="side">
      <div class="panel desk-only"><h2>Show</h2>${typeChips}</div>
      ${people.length ? `<div class="panel"><h2>People on this job</h2><ul>${people.map(([p, c]) => `<li>${esc(p)} <span>· ${c} note${c > 1 ? 's' : ''}</span></li>`).join('')}</ul></div>` : ''}
      ${waiting.length ? `<div class="panel"><h2>Waiting on</h2><ul>${waiting.map((w) => `<li>${esc(w.item)} <span>· ${esc((contact(w) || {}).name || 'someone')} · ${esc(ago(w.date_asked + 'T12:00:00'))}</span></li>`).join('')}</ul></div>` : ''}
      ${duet.length ? `<div class="panel"><h2>With Duet</h2><ul>${duet.map((h) => `<li>${esc(h.request)} <span>· ${esc(fmtDate(h.created_at))}</span></li>`).join('')}</ul></div>` : ''}
    </aside>
  </div>`;
}

function loopCard(n, closed) {
  const age = daysSince(n.created_at);
  const cls = closed ? 'age-ok' : age >= 14 ? 'age-warn' : age >= 7 ? 'age-quiet' : 'age-ok';
  const k = jobKeys(n)[0];
  const meta = [jobName(k), person(n), n.priority ? cap(n.priority) : ''].filter(Boolean).join(' · ');
  const h = handoffFor(n.id);
  return `
  <article class="loop">
    <div class="loop-top"><span class="mono" style="color:var(--slate)">${esc(n.loop_code || '#' + n.id)}</span><span class="${cls}">${closed ? 'Closed ' + esc(fmtDate(n.resolved_at)) : esc(ago(n.created_at))}</span></div>
    <h3><a href="${jobHref(k)}">${esc(title(n))}</a></h3>
    <p class="meta">${esc(meta)}</p>
    ${S.handoffing === n.id ? handoffHtml(n) : ''}
    <div class="row">
      ${closed ? `<button class="btn" data-act="reopen" data-id="${n.id}">Reopen</button>`
        : `<button class="btn dark" data-act="close" data-id="${n.id}">Close</button>
           ${h ? '<button class="btn sage" disabled>With Duet</button>' : `<button class="btn sage" data-act="handoff" data-id="${n.id}">To Duet</button>`}`}
    </div>
  </article>`;
}
function viewLoops() {
  const scope = (n) => S.loopsScope === 'all' || String(n.work_or_personal || '').toLowerCase() === S.loopsScope;
  const open = S.notes.filter(isOpen).filter(scope).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const withDuet = open.filter((n) => handoffFor(n.id));
  const rest = open.filter((n) => !handoffFor(n.id));
  const fresh = rest.filter((n) => daysSince(n.created_at) < 14).reverse();
  const stale = rest.filter((n) => daysSince(n.created_at) >= 14);
  const closed = S.notes.filter((n) => isLoop(n) && n.loop_resolved === true && n.resolved_at && daysSince(n.resolved_at) <= 7).filter(scope)
    .sort((a, b) => new Date(b.resolved_at) - new Date(a.resolved_at));
  const col = (name, hint, list, isClosed, emptyText) => `
    <section class="col"><h2>${esc(name)} <span class="mono" style="color:var(--muted)">${list.length}</span></h2><p class="hint">${esc(hint)}</p>
    ${list.length ? list.map((n) => loopCard(n, isClosed)).join('') : `<p class="empty-col">${esc(emptyText)}</p>`}</section>`;
  return `
  <div class="page-head"><h1>Open loops</h1>
    ${chips('loopsScope', [['all', 'All'], ['work', 'Work'], ['personal', 'Personal']], S.loopsScope)}</div>
  <div class="board">
    ${col('Open', 'Under 14 days old', fresh, false, 'Nothing new.')}
    ${col('Going stale', '14+ days with no movement', stale, false, 'Nothing going stale.')}
    ${col('With Duet', 'Handed off, Duet is working it', withDuet, false, 'Nothing handed off.')}
    ${col('Recently closed', 'Closed in the last 7 days', closed, true, 'Nothing closed this week.')}
  </div>`;
}

function viewWaiting() {
  const t = todayStr();
  const lists = {
    open: S.waiting.filter(waitingOpen),
    snoozed: S.waiting.filter((w) => w.status === 'open' && w.snooze_until && w.snooze_until > t),
    done: S.waiting.filter((w) => w.status !== 'open').sort((a, b) => new Date(b.closed_at || 0) - new Date(a.closed_at || 0)).slice(0, 50)
  };
  const rows = lists[S.waitingTab] || [];
  const row = (w) => {
    const c = contact(w) || {};
    const age = daysSince(w.date_asked + 'T12:00:00');
    const sms = c.phone ? `sms:${encodeURIComponent(c.phone)}?&body=${encodeURIComponent('Hi ' + (c.name || '').split(' ')[0] + ', checking in on ' + w.item + (w.job ? ' for ' + w.job : '') + '. Any update?')}` : '';
    const jobKeysW = rawJobs(w.job).map(jobKey);
    return `<tr>
      <td><strong>${esc(c.name || 'Unknown')}</strong><small>${esc(cap(String(w.type || 'other').replace(/_/g, ' ')))}</small></td>
      <td>${esc(w.item)}${w.notes ? `<small>${esc(w.notes)}</small>` : ''}</td>
      <td>${jobKeysW.length ? jobKeysW.map((k) => `<a href="${jobHref(k)}">${esc(jobName(k))}</a>`).join(', ') : '<small>No job set</small>'}</td>
      <td><span class="${age >= 7 ? 'age-warn' : age >= 3 ? 'age-quiet' : 'age-ok'}">${esc(ago(w.date_asked + 'T12:00:00'))}</span><small>Asked ${esc(fmtDate(w.date_asked + 'T12:00:00'))}${w.snooze_until && S.waitingTab === 'snoozed' ? ' · back ' + esc(fmtDate(w.snooze_until + 'T12:00:00')) : ''}</small></td>
      <td class="mono">${w.nudge_count || 0}</td>
      <td class="actions">${S.waitingTab === 'done'
        ? `<button class="btn" data-wact="reopen" data-id="${w.id}">Reopen</button>`
        : `${sms ? `<a class="btn sage" style="display:inline-flex;align-items:center" href="${sms}" data-wact="nudge" data-id="${w.id}">Text</a>` : `<button class="btn sage" data-wact="nudge" data-id="${w.id}">Log nudge</button>`}
           <button class="btn dark" data-wact="done" data-id="${w.id}">Got it</button>
           ${S.waitingTab === 'open' ? `<button class="btn" data-wact="snooze" data-id="${w.id}">Snooze 3d</button>` : ''}`}</td>
    </tr>`;
  };
  return `
  <div class="page-head">
    <div><h1>Waiting on</h1><p class="sub">Who owes you what. Oldest first. Same list the 6:30 AM chase uses.</p></div>
    ${chips('waitingTab', [['open', 'Open', lists.open.length], ['snoozed', 'Snoozed', lists.snoozed.length], ['done', 'Done']], S.waitingTab)}
  </div>
  ${rows.length ? `<div class="table-box"><table>
    <thead><tr><th>Waiting on</th><th>Item</th><th>Job</th><th>Asked</th><th>Nudges</th><th style="text-align:right">Actions</th></tr></thead>
    <tbody>${rows.map(row).join('')}</tbody></table></div>`
    : `<div class="empty">${S.waitingTab === 'open' ? 'Nobody owes you anything right now.' : 'Nothing here.'}</div>`}`;
}

const VAULT = {
  ideas: (n) => typeOf(n) === 'idea' || (n.kind || '').toLowerCase() === 'idea',
  records: (n) => (n.kind || '').toLowerCase() === 'record',
  decisions: (n) => typeOf(n) === 'decision',
  reflections: (n) => typeOf(n) === 'reflection' || (n.kind || '').toLowerCase() === 'reflection',
  projects: (n) => (n.kind || '').toLowerCase() === 'project'
};
function viewVault() {
  const inVault = (n) => !isOpen(n) && Object.values(VAULT).some((f) => f(n));
  const base = S.notes.filter(inVault);
  const q = S.vaultQuery.trim();
  const searched = q ? base.filter((n) => matches(n, q)) : base;
  const list = S.vaultTab === 'all' ? searched : searched.filter(VAULT[S.vaultTab]);
  const count = (k) => searched.filter(VAULT[k]).length;
  return `
  <div class="page-head"><div><h1>Vault</h1><p class="sub">Everything that is not a to do: ideas, records, decisions, reflections.</p></div></div>
  <form class="big-search" data-form="vault" role="search">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
    <label class="sr" for="vault-q">Search the vault</label>
    <input id="vault-q" name="q" type="search" value="${esc(q)}" placeholder="What did I say about the floor bid at Isabella?">
  </form>
  <div style="margin-bottom:22px">${chips('vaultTab', [['all', 'All', searched.length], ['ideas', 'Ideas', count('ideas')], ['records', 'Records', count('records')], ['decisions', 'Decisions', count('decisions')], ['reflections', 'Reflections', count('reflections')], ['projects', 'Projects', count('projects')]], S.vaultTab)}</div>
  <div class="timeline" style="max-width:860px">${timeline(list.slice(0, 150), true)}</div>`;
}

function viewSearch(q) {
  const hits = S.notes.filter((n) => matches(n, q));
  return `
  <div class="page-head"><div><p class="eyebrow">Search</p><h1>“${esc(q)}”</h1><p class="sub">${hits.length} note${hits.length === 1 ? '' : 's'}</p></div></div>
  <div class="timeline" style="max-width:860px">${timeline(hits.slice(0, 150), true)}</div>`;
}

/* ---------- login ---------- */
function showLogin() {
  app.innerHTML = `
  <form class="login" data-form="login">
    <h1>Command Center</h1>
    <p class="sub" style="margin:0">Enter your dashboard password.</p>
    <label class="sr" for="pw">Password</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
    <p class="err" id="login-err"></p>
    <button class="btn solid" type="submit">Sign in</button>
  </form>`;
}
function showSetup() {
  app.innerHTML = `<div class="login"><h1>One setup step</h1><p class="sub" style="margin:0">Add <b>DASHBOARD_PASSWORD</b> in Vercel under Project › Settings › Environment Variables, then redeploy.</p></div>`;
}

/* ---------- router ---------- */
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [view, ...rest] = h.split('/');
  return { view: view || 'jobs', arg: rest.join('/') };
}
function paintNav(view) {
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === view || (view === 'job' && a.dataset.nav === 'jobs')));
  const open = S.notes.filter(isOpen).length;
  const wait = S.waiting.filter(waitingOpen).length;
  document.getElementById('nav-loops').textContent = S.loaded ? open : '';
  document.getElementById('nav-waiting').textContent = S.loaded ? wait : '';
}
function render() {
  const { view, arg } = route();
  paintNav(view);
  if (!S.loaded) return;
  let html;
  if (view === 'job') html = viewJob(arg);
  else if (view === 'loops') html = viewLoops();
  else if (view === 'waiting') html = viewWaiting();
  else if (view === 'vault') html = viewVault();
  else if (view === 'search') html = viewSearch(arg);
  else html = viewJobs();
  app.innerHTML = html;
}
async function boot() {
  try { await load(); render(); }
  catch (e) {
    if (e.message !== 'login' && e.message !== 'setup') app.innerHTML = `<div class="error">Could not load notes: ${esc(e.message)}</div>`;
  }
}

/* ---------- actions ---------- */
const byId = (id) => S.notes.find((n) => Number(n.id) === Number(id));
async function setLoop(id, resolved, btn) {
  if (btn) { btn.disabled = true; btn.textContent = resolved ? 'Closing…' : 'Reopening…'; }
  try {
    const d = await api('/api/resolve-loop', { method: 'POST', body: { id: Number(id), resolved } });
    Object.assign(byId(id), d.row);
    const n = byId(id);
    toast(`${n.loop_code || '#' + id} ${resolved ? 'closed' : 'reopened'}`);
  } catch (e) { if (e.message !== 'login') toast('Could not update: ' + e.message); }
  render();
}

document.addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-chip]');
  if (chip) { S[chip.dataset.chip] = chip.dataset.v; render(); return; }

  const a = e.target.closest('[data-act]');
  if (a) {
    const id = Number(a.dataset.id);
    const act = a.dataset.act;
    if (act === 'expand') { S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id); render(); }
    else if (act === 'close') setLoop(id, true, a);
    else if (act === 'reopen') setLoop(id, false, a);
    else if (act === 'edit') { S.editing = S.editing === id ? null : id; S.handoffing = null; render(); focusForm(id); }
    else if (act === 'handoff') { S.handoffing = S.handoffing === id ? null : id; S.editing = null; render(); focusForm(id); }
    else if (act === 'cancel') { S.editing = null; S.handoffing = null; render(); }
    return;
  }

  const w = e.target.closest('[data-wact]');
  if (w) {
    const act = w.dataset.wact;
    if (w.tagName !== 'A') e.preventDefault();
    w.setAttribute('disabled', '');
    try {
      const d = await api('/api/waiting', { method: 'POST', body: { id: w.dataset.id, action: act } });
      Object.assign(S.waiting.find((x) => x.id === w.dataset.id), d.row);
      toast({ done: 'Marked as received', snooze: 'Snoozed 3 days', nudge: 'Nudge logged', reopen: 'Reopened' }[act]);
    } catch (err) { if (err.message !== 'login') toast('Could not update: ' + err.message); }
    render();
  }
});
function focusForm(id) {
  const f = document.querySelector(`form[data-id="${id}"]`);
  if (f) { const el = f.querySelector('textarea, input, select'); if (el) el.focus(); }
}

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const kind = f.dataset.form;
  const data = Object.fromEntries(new FormData(f).entries());

  if (kind === 'login') {
    const err = document.getElementById('login-err');
    err.textContent = '';
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: data.password }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { err.textContent = d.error === 'setup' ? d.message : (d.error || 'Could not sign in'); return; }
      app.innerHTML = '<div class="loading">Loading your notes…</div>';
      boot();
    } catch (x) { err.textContent = x.message; }
    return;
  }
  if (kind === 'vault') { S.vaultQuery = data.q || ''; render(); const i = document.getElementById('vault-q'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } return; }

  const id = Number(f.dataset.id);
  const btn = f.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    if (kind === 'tags') {
      if (data.title === title(byId(id))) delete data.title;
      const d = await api('/api/update-note', { method: 'POST', body: { id, fields: data } });
      Object.assign(byId(id), d.row);
      learnNames();
      S.editing = null;
      toast('Tags saved');
    } else if (kind === 'handoff') {
      const n = byId(id);
      const d = await api('/api/handoff', { method: 'POST', body: { voice_note_id: id, request: data.request, job_name: jobName(jobKeys(n)[0]) } });
      S.handoffs.unshift(d.row);
      S.handoffing = null;
      toast('Sent to Duet');
    }
  } catch (x) { if (x.message !== 'login') { toast('Could not save: ' + x.message); btn.disabled = false; return; } }
  render();
});

document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  if (q) location.hash = '#/search/' + encodeURIComponent(q);
});
document.getElementById('refresh-btn').addEventListener('click', async () => {
  try { await load(true); render(); toast('Up to date'); }
  catch (e) { if (e.message !== 'login' && e.message !== 'setup') toast('Refresh failed: ' + e.message); }
});
window.addEventListener('hashchange', () => { S.editing = null; S.handoffing = null; S.jobType = 'all'; render(); window.scrollTo(0, 0); });
document.addEventListener('visibilitychange', () => {
  // Pick up notes recorded while the tab was in the background.
  if (document.visibilityState === 'visible' && S.loaded && Date.now() - (S.lastLoad || 0) > 60000) { S.lastLoad = Date.now(); load(true).then(render).catch(() => {}); }
});

boot();
