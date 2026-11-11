// Exclusion audit: UI. All statistics come from src/audit.js.
import * as A from './src/audit.js';

const LS_KEY = 'lf-exclusion-audit-v1';
const CHIP = ['orange', 'blue', 'purple', 'green', 'gray', 'indigo', 'yellow', 'red'];
const AV = ['#e08a3c', '#5b8def', '#9b6bd6', '#3fa66a', '#d4644f', '#4aa3b5', '#c9a227', '#7a7a7a'];
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (x) => Math.round(x).toLocaleString('en-US');
const pct = (x, d = 1) => (100 * x).toFixed(d) + '%';
const fmtDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

let DB = null;      // { mailbox, prep, uniDraws, catIndex }
let S = loadState();

// First visit: the first 60 draws are pre-reviewed by the simulated reviewer
// (ground truth) so the page opens on a finished audit. Reset starts fresh.
const SEEDED_REVIEWS = 60;
function loadState() {
  const def = { labels: null, guarded: {}, manual: [], showTruth: false, showRandom: true };
  try { return { ...def, ...(JSON.parse(localStorage.getItem(LS_KEY)) || {}) }; } catch { return def; }
}
function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch { /* private mode */ } }

// ---------------------------------------------------------------- data
async function boot() {
  renderLoading();
  try {
    const [mbRes, prRes] = await Promise.all([fetch('data/mailbox.json'), fetch('data/prior.json')]);
    if (!mbRes.ok || !prRes.ok) throw new Error(`HTTP ${mbRes.status}/${prRes.status}`);
    const mailbox = A.unpack(await mbRes.json());
    const prior = await prRes.json();
    const prep = A.prepare(mailbox, prior.coef);
    const N = prep.items.length;
    const uniDraws = A.drawSequence(new Float64Array(N).fill(1 / N), A.QUEUE_LEN, A.UNIFORM_SEED);
    const catIndex = Object.fromEntries(mailbox.categories.map((c, i) => [c.id, i]));
    DB = { mailbox, prep, uniDraws, catIndex };
    if (!Array.isArray(S.labels)) { S.labels = Array.from(prep.queue.slice(0, SEEDED_REVIEWS), (i) => prep.items[i].y); S.seeded = true; save(); }
    S.labels = S.labels.filter((v) => v === 0 || v === 1).slice(0, A.QUEUE_LEN);
    route();
  } catch (e) {
    renderError(e);
  }
}

function summary() { return A.summarize(DB.prep, S.labels, { guarded: S.guarded, manual: S.manual }); }
function labelOf(i) {
  const { queue } = DB.prep;
  for (let t = 0; t < S.labels.length; t++) if (queue[t] === i) return S.labels[t];
  return null;
}
function isSynced(i) { return labelOf(i) === 1 || S.manual.includes(i) || (DB.prep.items[i].crm && S.guarded[DB.prep.items[i].c]); }

// Advance past queue positions whose item was already reviewed (draws are with replacement).
function autofill() {
  const { queue } = DB.prep;
  for (;;) {
    const t = S.labels.length;
    if (t >= A.QUEUE_LEN) return;
    const i = queue[t];
    let prev = null;
    for (let s = 0; s < t; s++) if (queue[s] === i) { prev = S.labels[s]; break; }
    if (prev === null) return;
    S.labels.push(prev);
  }
}

function label(v) {
  if (!DB || S.labels.length >= A.QUEUE_LEN) return;
  autofill();
  S.labels.push(v);
  autofill();
  save();
  if (v === 1) toast('Syncing to the CRM. It may take a moment to appear.');
  route();
}
function undo() {
  if (!S.labels.length) return;
  // Pop the last real review and any auto-filled repeats after it.
  const { queue } = DB.prep;
  for (;;) {
    const t = S.labels.length - 1;
    if (t < 0) break;
    const i = queue[t];
    let first = true;
    for (let s = 0; s < t; s++) if (queue[s] === i) { first = false; break; }
    S.labels.pop();
    if (first) break;
  }
  save(); route();
}
function simulate(k) {
  autofill();
  for (let j = 0; j < k && S.labels.length < A.QUEUE_LEN; j++) { S.labels.push(DB.prep.items[DB.prep.queue[S.labels.length]].y); autofill(); }
  save(); route();
}

// ---------------------------------------------------------------- routing
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '') || 'excluded/audit';
  const [path, qs] = h.split('?');
  return { parts: path.split('/').filter(Boolean), q: new URLSearchParams(qs || '') };
}
function route() {
  if (!DB) return;
  const { parts, q } = parseHash();
  closeMenu();
  if (parts[0] === 'settings') return renderSettings();
  if (parts[0] === 'excluded' && (parts[1] === 'mail' || parts[1] === 'meetings')) return renderList(parts[1], q);
  if (parts[0] === 'excluded' && parts[1] === 'audit' && parts[2] === 'category' && parts[3] in DB.catIndex) return renderCategory(DB.catIndex[parts[3]]);
  return renderAudit();
}
let rzT = null;
window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(route, 150); });
window.addEventListener('hashchange', () => { route(); $('#scroll').scrollTop = 0; });

function crumbs(extra = []) {
  const base = [['Settings', '#/settings'], ['Mail and calendar', '#/settings'], ['jesse@acme.com', '#/settings']];
  const all = [...base, ...extra];
  $('#crumbs').innerHTML = `<i data-lucide="settings" style="color:var(--color-content-tertiary)"></i>` + all.map(([t, href], k) =>
    k === all.length - 1 ? `<span class="cur">${esc(t)}</span>` : `<a href="${href}">${esc(t)}</a><span class="sep">/</span>`).join('');
}
function icons() { if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.6 } }); }

// ---------------------------------------------------------------- shared bits
function catChip(c) { const cat = DB.mailbox.categories[c]; return `<span class="chip ${CHIP[c]}">${esc(cat.name)}</span>`; }
function initials(name) { return name.replace(/\(.*\)/, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join(''); }
function avatar(name) { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `<span class="avatar" style="background:${AV[h % AV.length]}" aria-hidden="true">${esc(initials(name))}</span>`; }
function statusCell(i) {
  const l = labelOf(i), it = DB.prep.items[i];
  if (l === 1) return `<span class="status"><span class="ring ok"></span>Belongs in CRM</span>`;
  if (S.manual.includes(i)) return `<span class="status"><span class="ring sync"></span>Synced anyway</span>`;
  if (it.crm && S.guarded[it.c]) return `<span class="status"><span class="ring sync"></span>Kept by CRM guard</span>`;
  if (l === 0) return `<span class="status"><span class="ring no"></span>Correctly excluded</span>`;
  return `<span class="status faint"><span class="ring"></span>Not reviewed</span>`;
}
function excludedTabs(active) {
  const items = DB.prep.items;
  const mail = items.filter((it) => it.k === 'm').length, meet = items.length - mail;
  const tab = (id, label, count) => `<a role="tab" aria-selected="${active === id}" class="tab ${active === id ? 'active' : ''}" href="#/excluded/${id}">${label}${count !== null ? ` <span class="c num">${fmt(count)}</span>` : ''}${id === 'audit' ? ' <span class="new">New</span>' : ''}</a>`;
  return `<div class="tabs" role="tablist" aria-label="Excluded activity" style="margin:20px 0 16px">${tab('mail', 'Mail', mail)}${tab('meetings', 'Meetings', meet)}${tab('audit', 'Audit', null)}</div>`;
}
function header() {
  return `<div style="display:flex;align-items:flex-start;gap:12px">
    <div style="flex:1"><h1 class="h1">Excluded activity</h1>
    <p class="sub">Mail and meetings your exclusion categories kept out of the CRM for jesse@acme.com.</p></div>
    <button class="btn" id="exp-csv"><i data-lucide="download"></i>Export</button>
    <a class="btn" href="#/settings"><i data-lucide="sliders-horizontal"></i>Exclusion settings</a>
    <button class="icon-btn" id="more-btn" aria-label="More actions" style="margin-top:1px"><i data-lucide="ellipsis"></i></button></div>`;
}
function wireHeader(sm) {
  $('#exp-csv').onclick = () => exportCSV(sm);
  $('#more-btn').onclick = (e) => openMenu(e.currentTarget, [
    ['rotate-ccw', 'Reset audit', () => { if (confirm('Clear all spot-checks and changes made in this demo?')) { S = { ...loadStateDefaults() }; save(); route(); } }],
    ['download', 'Export spot-checks (JSON)', () => exportJSON()],
  ]);
}
function loadStateDefaults() { return { labels: [], guarded: {}, manual: [], showTruth: false, showRandom: true, seeded: false }; }

// ---------------------------------------------------------------- Audit view
function seriesTotal(n) {
  const { f, pi, queue } = DB.prep;
  const out = [];
  for (let t = 0; t < n; t++) {
    const m = t + 1;
    if (m < 2) continue;
    const r = A.ppiEstimate(f, pi, queue, S.labels, { n: m }); // exact same estimator as the summary
    out.push({ t: m, est: r.est, lo: r.lo, hi: r.hi });
  }
  return out;
}
function seriesUniform(n) {
  const y = DB.prep.items.map((it) => it.y), N = y.length, out = [];
  let k = 0;
  for (let t = 0; t < n; t++) { k += y[DB.uniDraws[t]]; if (t + 1 >= 2) { const w = A.wilsonCount(N, t + 1, k); out.push({ t: t + 1, lo: w.lo, hi: w.hi }); } }
  return out;
}

function chartSVG(n, W = 640) {
  const H = 260, L = 44, R = 12, T = 12, B = 28;
  const ser = seriesTotal(n);
  const uni = S.showRandom ? seriesUniform(Math.max(n, 2)) : [];
  const truth = A.trueHidden(DB.prep.items);
  const xmax = Math.max(60, n + 5);
  let ymax = 50;
  for (const p of ser.slice(Math.min(8, Math.max(0, ser.length - 1)))) ymax = Math.max(ymax, p.hi);
  if (S.showTruth) ymax = Math.max(ymax, truth);
  // Scale to the audit's own range; the random-spot-check band is clipped at the top.
  ymax = ymax * 1.15;
  const nice = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return 10 * p; };
  const step = nice(ymax / 4); ymax = step * Math.ceil(ymax / step);
  const X = (t) => L + (W - L - R) * (t / xmax), Y = (v) => T + (H - T - B) * (1 - Math.min(v, ymax) / ymax);
  let g = '';
  for (let v = 0; v <= ymax + 1e-9; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--color-border-subtle)"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  const xstep = xmax > 200 ? 50 : xmax > 100 ? 25 : 10;
  for (let t = 0; t <= xmax; t += xstep) g += `<text x="${X(t)}" y="${H - 8}" text-anchor="middle">${t}</text>`;
  const area = (pts, key1, key2) => pts.length ? 'M' + pts.map((p) => `${X(p.t).toFixed(1)},${Y(p[key2]).toFixed(1)}`).join('L') + 'L' + pts.slice().reverse().map((p) => `${X(p.t).toFixed(1)},${Y(p[key1]).toFixed(1)}`).join('L') + 'Z' : '';
  const line = (pts, key) => pts.length ? 'M' + pts.map((p) => `${X(p.t).toFixed(1)},${Y(p[key]).toFixed(1)}`).join('L') : '';
  let body = '';
  if (uni.length) body += `<path d="${area(uni.filter((p) => p.t >= 5 && p.t <= Math.max(n, 2)), 'lo', 'hi')}" fill="var(--color-neutral-t1)" stroke="var(--color-neutral-t5)" stroke-dasharray="3 3"/>`;
  body += `<path d="${area(ser, 'lo', 'hi')}" fill="var(--color-blue-t3)" opacity=".75"/>`;
  body += `<path d="${line(ser, 'est')}" fill="none" stroke="var(--color-blue-z7)" stroke-width="1.75"/>`;
  if (S.showTruth) body += `<line x1="${L}" x2="${W - R}" y1="${Y(truth)}" y2="${Y(truth)}" stroke="var(--color-green-z8)" stroke-dasharray="5 4"/><text x="${W - R}" y="${Y(truth) - 5}" text-anchor="end" style="fill:var(--color-green-z8)">True count ${truth}</text>`;
  const jv = A.jevOnly(DB.prep.jevF);
  body += `<line x1="${L}" x2="${W - R}" y1="${Y(jv)}" y2="${Y(jv)}" stroke="var(--color-neutral-t6)" stroke-dasharray="1 3"/><text x="${W - R}" y="${Y(jv) + 13}" text-anchor="end">Jev alone ${fmt(jv)}</text>`;
  if (!ser.length) body += `<text x="${(L + W) / 2}" y="${H / 2}" text-anchor="middle" style="font-size:12px">Review two spot-checks to start the estimate</text>`;
  const last = ser[ser.length - 1];
  if (last) body += `<circle cx="${X(last.t)}" cy="${Y(last.est)}" r="3.5" fill="var(--color-blue-z7)" stroke="#fff" stroke-width="1.5"/>`;
  return { svg: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Estimated hidden real conversations versus number of spot-checks"><g>${g}</g>${body}<rect id="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/></svg>`, ser, uni, X, xmax, W, L, R };
}

function renderAudit() {
  crumbs([['Excluded activity', '#/excluded/audit'], ['Audit', '#/excluded/audit']]);
  autofill();
  const sm = summary();
  const n = S.labels.length, items = DB.prep.items, N = items.length;
  const t = sm.total;
  const ready = n >= 2;
  const crmTotal = items.filter((it) => it.crm).length;
  const anyGuard = Object.values(S.guarded).some(Boolean);
  const allGuardSm = A.summarize(DB.prep, S.labels, { guarded: Object.fromEntries(DB.mailbox.categories.map((_, c) => [c, true])), manual: S.manual });
  const next = n < A.QUEUE_LEN ? DB.prep.queue[n] : null;

  const stats = `<div class="card white stats">
    <div class="stat"><div class="k">Real conversations hidden <i data-lucide="info" title="Prediction-powered estimate with a 95% interval"></i></div>
      <div class="v">${ready ? '≈ ' + fmt(t.est) : '–'}${ready ? `<small>95%: ${fmt(t.lo)}–${fmt(t.hi)}</small>` : ''}</div>
      <div class="d">${ready ? `from ${fmt(sm.unique)} spot-checks of ${fmt(N)} excluded items` : 'Review a few spot-checks to estimate'}</div></div>
    <div class="stat"><div class="k">Found and synced</div><div class="v">${fmt(sm.total.found)}</div><div class="d">real conversations you marked</div></div>
    <div class="stat"><div class="k">Jev's probabilities alone</div><div class="v">${fmt(sm.jev)}</div><div class="d">expected misses if taken at face value</div></div>
    ${anyGuard
      ? `<div class="stat"><div class="k">Still hidden</div><div class="v">${ready ? '≤ ' + fmt(sm.remainingUpper) : '–'}<small>95% upper bound</small></div><div class="d">after the CRM guard returned ${fmt(sm.back)} items</div></div>`
      : `<div class="stat"><div class="k">On open CRM records</div><div class="v">${fmt(crmTotal)}<small>${ready ? '≈ ' + fmt(allGuardSm.recovered.est) + ' real' : ''}</small></div><div class="d">excluded items with someone on an open opportunity or account</div></div>`}
  </div>`;

  let spot;
  if (next === null) {
    spot = `<div class="card white spot"><div class="panel-head"><span class="h3">Spot-check</span></div><div class="empty"><i data-lucide="check-circle-2"></i><div>All ${A.QUEUE_LEN} draws reviewed.</div></div></div>`;
  } else {
    const it = items[next];
    const crmText = it.crm ? `On open record${it.acct ? ' · ' + esc(it.acct) : ''}` : 'No open CRM records';
    spot = `<div class="card white spot" aria-label="Spot-check">
      <div class="panel-head"><span class="h3">Spot-check</span><span class="faint num">Draw ${fmt(n + 1)} · ${fmt(sm.unique)} reviewed</span></div>
      <div class="spot-body">
        <div class="from">${avatar(it.from)}<span>${esc(it.from)}</span><span class="faint" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.email)}</span><span class="faint" style="margin-left:auto">${fmtDate(it.d)}</span></div>
        <div class="subj">${it.k === 'e' ? '<i data-lucide="calendar" style="vertical-align:-3px;margin-right:4px"></i>' : ''}${esc(it.subj)}</div>
        <div class="snip">${esc(it.snip)}</div>
        <div class="meta">
          <span class="mk">Category</span><span>${catChip(it.c)}</span>
          <span class="mk">Jev match</span><span class="num"><span class="bar"><i style="width:${(100 * (it.p - 0.5) / 0.5).toFixed(0)}%"></i></span>${it.p.toFixed(3)}</span>
          <span class="mk">CRM</span><span>${it.crm ? '<i data-lucide="building" style="vertical-align:-3px;color:var(--color-content-tertiary)"></i> ' : ''}${crmText}</span>
          <span class="mk">Why this one</span><span class="muted">Drawn with chance ${(DB.prep.pi[next] * 100).toFixed(3)}% per draw</span>
        </div>
      </div>
      <div class="spot-actions">
        <button class="btn" id="b-yes" aria-keyshortcuts="S"><i data-lucide="corner-up-left"></i>Belongs in CRM <kbd>S</kbd></button>
        <button class="btn" id="b-no" aria-keyshortcuts="E">Correctly excluded <kbd>E</kbd></button>
        <button class="btn ghost" id="b-undo" ${n ? '' : 'disabled'} aria-keyshortcuts="U">Undo <kbd>U</kbd></button>
      </div>
      <div class="demo-row"><span class="chip gray" style="height:18px;font-size:.6875rem">Demo</span>${S.seeded ? '<span>First 60 reviews simulated.</span>' : ''}
        <button class="btn" id="b-sim">Review next 10 for me</button>
        <label class="toggle"><input type="checkbox" id="t-truth" ${S.showTruth ? 'checked' : ''}>True count</label>
        <label class="toggle"><input type="checkbox" id="t-rand" ${S.showRandom ? 'checked' : ''}>Random spot-checks</label></div>
    </div>`;
  }

  const chart = `<div class="card white"><div class="panel-head"><span class="h3">Estimate as you review</span><span class="faint">Spot-checks</span></div>
    <div class="legend"><span><span class="sw" style="background:var(--color-blue-z7);height:2px"></span>Estimate</span><span><span class="sw" style="background:var(--color-blue-t3)"></span>95% range</span>${S.showRandom ? '<span><span class="sw" style="background:var(--color-neutral-t1);border:1px dashed var(--color-neutral-t5)"></span>Same number of random spot-checks (simulated)</span>' : ''}${S.showTruth ? '<span><span class="sw" style="border-top:1px dashed var(--color-green-z8);height:0"></span>True count (simulated)</span>' : ''}</div>
    <div class="chart" id="chart" style="min-height:260px"></div></div>`;

  const guardBack = items.filter((it) => it.crm && !S.guarded[it.c]).length;
  const fix = anyGuard
    ? `<div class="card white fix"><div class="ic"><i data-lucide="shield-check"></i></div><div class="body"><div class="row-title">CRM guard is on for ${Object.values(S.guarded).filter(Boolean).length} categories</div>
       <div class="row-desc">${fmt(sm.back)} excluded items with someone on an open record were synced back${ready ? `, an estimated ${fmt(sm.recovered.est)} of them real conversations` : ''}. ${ready ? `At most ${fmt(sm.remainingUpper)} real conversations are still hidden (95%); spot-check more to tighten this.` : ''}</div></div>
       <a class="btn" href="#/settings">Edit in settings</a></div>`
    : `<div class="card white fix"><div class="ic"><i data-lucide="shield"></i></div><div class="body"><div class="row-title">Keep activity with open CRM records in the CRM</div>
       <div class="row-desc">Exclusion categories read only the email or meeting, never your CRM. ${fmt(guardBack)} excluded items include someone on an open opportunity or account${ready ? `. Syncing them back returns an estimated ${fmt(allGuardSm.recovered.est)} real conversations; at most ${fmt(allGuardSm.remainingUpper)} would stay hidden (95%)` : ''}.</div></div>
       <button class="btn primary" id="b-guard">Review change</button></div>`;

  const rows = sm.byCategory.map((r) => {
    const cat = DB.mailbox.categories[r.c];
    const showRange = r.checked >= 8;
    return `<tr data-cat="${cat.id}" tabindex="0" class="row-link" aria-label="Open ${esc(cat.name)}">
      <td>${catChip(r.c)}</td>
      <td class="r">${fmt(r.excluded)}</td><td class="r">${fmt(r.checked)}</td><td class="r">${fmt(r.found)}</td>
      <td class="r">${ready ? '≈ ' + fmt(r.est) : '–'}${ready && showRange ? ` <span class="faint">(${fmt(r.lo)}–${fmt(r.hi)})</span>` : ''}</td>
      <td class="r muted">${fmt(r.jev)}</td><td class="r">${fmt(r.crmCount)}</td>
      <td>${S.guarded[r.c] ? '<span class="status"><span class="ring sync"></span>On</span>' : '<span class="faint">Off</span>'}</td></tr>`;
  }).join('');
  const table = `<div class="section-title">By category <span class="faint">· ranges shown once a category has 8+ spot-checks</span></div>
    <div class="card white" style="overflow:hidden"><table class="tbl" aria-label="Audit by category"><thead><tr>
    <th><span class="h"><i data-lucide="tag"></i>Category</span></th>
    <th class="r"><span class="h">Excluded</span></th><th class="r"><span class="h">Spot-checked</span></th><th class="r"><span class="h">Real found</span></th>
    <th class="r"><span class="h">Est. hidden</span></th><th class="r"><span class="h">Jev alone</span></th><th class="r"><span class="h"><i data-lucide="building"></i>On open records</span></th><th><span class="h"><i data-lucide="shield"></i>CRM guard</span></th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;

  $('#view').innerHTML = header() + excludedTabs('audit') + stats + `<div class="grid2"><div>${chart}${fix}</div>${spot}</div>` + table + methodNote();
  icons();
  wireHeader(sm);
  if ($('#b-yes')) { $('#b-yes').onclick = () => label(1); $('#b-no').onclick = () => label(0); $('#b-undo').onclick = undo; $('#b-sim').onclick = () => simulate(10);
    $('#t-truth').onchange = (e) => { S.showTruth = e.target.checked; save(); route(); };
    $('#t-rand').onchange = (e) => { S.showRandom = e.target.checked; save(); route(); }; }
  if ($('#b-guard')) $('#b-guard').onclick = () => openGuardDialog(Object.fromEntries(DB.mailbox.categories.map((_, c) => [c, true])));
  document.querySelectorAll('tr[data-cat]').forEach((tr) => { const go = () => { location.hash = `#/excluded/audit/category/${tr.dataset.cat}`; }; tr.onclick = go; tr.onkeydown = (e) => { if (e.key === 'Enter') go(); }; });
  const box = $('#chart');
  const ch = chartSVG(n, Math.max(320, Math.round(box.clientWidth - 16)));
  box.innerHTML = ch.svg;
  wireChart(ch);
}

function methodNote() {
  return `<p class="faint" style="margin-top:20px;max-width:820px;line-height:1.5">How it works: each spot-check is drawn at random, favouring items the audit prior (Jev's probability plus whether anyone on the thread is on an open CRM record) thinks might be real, with a floor so every item can be drawn. The estimate is Jev-prior total plus the average correction from spot-checks, reweighted by each draw's chance (prediction-powered inference). It stays unbiased even when Jev is confidently wrong. Review in order: skipping a draw would bias the estimate.</p>`;
}

function wireChart(ch) {
  const svg = $('#chart svg'), tip = $('#tip');
  if (!svg) return;
  const hit = svg.querySelector('#hit');
  hit.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const xv = ((e.clientX - r.left) / r.width) * ch.W;
    const t = Math.round(((xv - ch.L) / (ch.W - ch.L - ch.R)) * ch.xmax);
    const p = ch.ser.find((q) => q.t === t), u = ch.uni.find((q) => q.t === t);
    if (!p) { tip.style.display = 'none'; return; }
    tip.innerHTML = `<div><b>${t} spot-checks</b></div><div style="margin-top:4px">Estimate <b class="num">${fmt(p.est)}</b></div><div class="muted">95% range ${fmt(p.lo)}–${fmt(p.hi)}</div>${u ? `<div class="muted">Random spot-checks ${fmt(u.lo)}–${fmt(u.hi)}</div>` : ''}`;
    tip.style.display = 'block'; tip.style.left = e.clientX + 14 + 'px'; tip.style.top = e.clientY + 14 + 'px';
  });
  hit.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

// ---------------------------------------------------------------- Category drill-down
function renderCategory(c) {
  const cat = DB.mailbox.categories[c];
  crumbs([['Excluded activity', '#/excluded/audit'], ['Audit', '#/excluded/audit'], [cat.name, location.hash]]);
  const sm = summary(), r = sm.byCategory[c];
  const { items, f } = DB.prep;
  const idx = items.map((_, i) => i).filter((i) => items[i].c === c);
  const ready = S.labels.length >= 2;
  // Histogram of Jev match probability, stacked by review status.
  const bins = 20, H = Array.from({ length: bins }, () => [0, 0, 0]);
  for (const i of idx) { const b = Math.min(bins - 1, Math.floor((items[i].p - 0.5) / 0.5 * bins)); const l = labelOf(i); H[b][l === 1 ? 0 : l === 0 ? 1 : 2]++; }
  const W = Math.max(480, Math.round(($('#view').clientWidth || 1080) - parseFloat(getComputedStyle($('#view')).paddingLeft) * 2 - 18)), HH = 200, L = 40, R = 10, T = 10, B = 26;
  const ymax = Math.max(5, ...H.map((h) => h[0] + h[1] + h[2]));
  const bw = (W - L - R) / bins;
  let bars = '';
  H.forEach((h, b) => {
    let y0 = HH - B;
    [[h[0], 'var(--color-green-z6)'], [h[1], 'var(--color-neutral-t8)'], [h[2], 'var(--color-neutral-t4)']].forEach(([v, col]) => {
      if (!v) return; const hgt = (HH - T - B) * v / ymax; y0 -= hgt;
      bars += `<rect x="${(L + b * bw + 1.5).toFixed(1)}" y="${y0.toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${hgt.toFixed(1)}" rx="2" fill="${col}"><title>${(0.5 + b * 0.025).toFixed(3)}–${(0.525 + b * 0.025).toFixed(3)}: ${v}</title></rect>`;
    });
  });
  let axis = '';
  for (let k = 0; k <= 4; k++) { const v = Math.round(ymax * k / 4), y = HH - B - (HH - T - B) * k / 4; axis += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="var(--color-border-subtle)"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">${v}</text>`; }
  for (let k = 0; k <= 10; k += 2) axis += `<text x="${L + (W - L - R) * k / 10}" y="${HH - 8}" text-anchor="middle">${(0.5 + k * 0.05).toFixed(1)}</text>`;
  const sorted = idx.slice().sort((a, b) => f[b] - f[a]);
  const lim = Math.min(sorted.length, +(new URLSearchParams(location.hash.split('?')[1] || '').get('rows') || 40));
  const rows = sorted.slice(0, lim).map((i) => itemRow(i, false)).join('');
  const back = idx.filter((i) => items[i].crm).length;
  $('#view').innerHTML = `<a class="btn ghost" href="#/excluded/audit" style="margin:-6px 0 10px -8px"><i data-lucide="arrow-left"></i>Audit</a>
    <div style="display:flex;align-items:flex-start;gap:12px"><div style="flex:1"><h1 class="h1">${esc(cat.name)}</h1><p class="sub">${esc(cat.desc)} <span class="faint">· ${esc(cat.applies)}</span></p></div>
    <a class="btn" href="#/excluded/${cat.applies.includes('Mail') ? 'mail' : 'meetings'}?cat=${cat.id}"><i data-lucide="list"></i>See excluded</a></div>
    <div class="card white stats" style="margin-top:20px">
      <div class="stat"><div class="k">Real conversations hidden</div><div class="v">${ready ? '≈ ' + fmt(r.est) : '–'}${ready && r.checked >= 8 ? `<small>95%: ${fmt(r.lo)}–${fmt(r.hi)}</small>` : ''}</div><div class="d">${r.checked >= 8 ? `${fmt(r.checked)} spot-checks in this category` : `${fmt(r.checked)} spot-checks here; range shows at 8+`}</div></div>
      <div class="stat"><div class="k">Excluded</div><div class="v">${fmt(r.excluded)}</div><div class="d">mail and meetings</div></div>
      <div class="stat"><div class="k">Real found</div><div class="v">${fmt(r.found)}</div><div class="d">of ${fmt(r.checked)} reviewed</div></div>
      <div class="stat"><div class="k">On open records</div><div class="v">${fmt(back)}</div><div class="d">${ready && back ? `≈ ${fmt(r.guardEst)} real if synced back` : 'would sync back with the CRM guard'}</div></div>
    </div>
    <div class="card white" style="margin-top:16px"><div class="panel-head"><span class="h3">Jev match probability</span><span class="faint">${fmt(r.excluded)} items</span></div>
      <div class="legend"><span><span class="sw" style="background:var(--color-green-z6)"></span>Belongs in CRM</span><span><span class="sw" style="background:var(--color-neutral-t8)"></span>Correctly excluded</span><span><span class="sw" style="background:var(--color-neutral-t4)"></span>Not reviewed</span></div>
      <div class="chart"><svg viewBox="0 0 ${W} ${HH}" role="img" aria-label="Histogram of Jev match probability">${axis}${bars}</svg></div></div>
    <div class="section-title">Most likely to be real <span class="faint">· sorted by audit prior</span></div>
    <div class="card white" style="overflow:hidden">${itemTable(rows)}${lim < sorted.length ? `<div class="more"><a class="btn ghost" href="#/excluded/audit/category/${cat.id}?rows=${lim + 60}">Show more</a></div>` : ''}</div>`;
  icons(); wireRows();
}

function itemTable(rows) {
  if (!rows) return `<div class="empty"><i data-lucide="inbox"></i><div>No excluded activity matches.</div></div>`;
  return `<table class="tbl" aria-label="Excluded activity"><thead><tr>
    <th><span class="h"><i data-lucide="mail"></i>Subject</span></th><th><span class="h"><i data-lucide="user"></i>From</span></th><th><span class="h"><i data-lucide="tag"></i>Category</span></th>
    <th><span class="h"><i data-lucide="calendar"></i>Date</span></th><th class="r"><span class="h">Jev match</span></th><th class="r"><span class="h">Audit prior</span></th><th><span class="h"><i data-lucide="circle-dashed"></i>Status</span></th><th style="width:40px"></th></tr></thead><tbody>${rows}</tbody></table>`;
}
function itemRow(i) {
  const it = DB.prep.items[i];
  return `<tr data-i="${i}"><td class="ellip">${it.k === 'e' ? '<i data-lucide="calendar" style="vertical-align:-3px;margin-right:6px;color:var(--color-content-tertiary)"></i>' : ''}<span class="ul">${esc(it.subj)}</span></td>
    <td class="ellip" style="max-width:200px">${esc(it.from)}</td><td>${catChip(it.c)}</td><td class="muted">${fmtDate(it.d)}</td>
    <td class="r">${it.p.toFixed(3)}</td><td class="r">${pct(DB.prep.f[i])}</td><td>${statusCell(i)}</td>
    <td><button class="icon-btn row-menu" data-i="${i}" aria-label="More actions"><i data-lucide="ellipsis"></i></button></td></tr>`;
}
function wireRows() {
  document.querySelectorAll('.row-menu').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const i = +b.dataset.i;
      openMenu(b, isSynced(i) && !S.manual.includes(i) ? [['info', 'Already in the CRM', null]] : S.manual.includes(i)
        ? [['undo-2', 'Exclude again', () => { S.manual = S.manual.filter((x) => x !== i); save(); route(); }]]
        : [['corner-up-left', 'Sync anyway', () => { S.manual.push(i); save(); toast('Syncing to the CRM. It may take a moment to appear.'); route(); }]]);
    };
  });
}

// ---------------------------------------------------------------- Mail / Meetings lists
function renderList(kind, q) {
  crumbs([['Excluded activity', `#/excluded/${kind}`], [kind === 'mail' ? 'Mail' : 'Meetings', `#/excluded/${kind}`]]);
  const sm = summary();
  const { items } = DB.prep;
  const catId = q.get('cat'), c = catId in DB.catIndex ? DB.catIndex[catId] : null;
  const qq = (q.get('q') || '').toLowerCase();
  const lim = +(q.get('rows') || 60);
  let idx = items.map((_, i) => i).filter((i) => items[i].k === (kind === 'mail' ? 'm' : 'e') && (c === null || items[i].c === c));
  if (qq) idx = idx.filter((i) => (items[i].subj + ' ' + items[i].from + ' ' + items[i].email).toLowerCase().includes(qq));
  idx.sort((a, b) => (items[b].d > items[a].d ? 1 : items[b].d < items[a].d ? -1 : a - b));
  const opts = DB.mailbox.categories.map((cat, k) => `<option value="${cat.id}" ${k === c ? 'selected' : ''}>${esc(cat.name)}</option>`).join('');
  const mk = (extra) => { const p = new URLSearchParams(q); for (const [k, v] of Object.entries(extra)) v === null ? p.delete(k) : p.set(k, v); const s = p.toString(); return `#/excluded/${kind}${s ? '?' + s : ''}`; };
  $('#view').innerHTML = header() + excludedTabs(kind) + `<div class="card white" style="overflow:hidden">
    <div class="toolbar"><label class="search"><i data-lucide="search"></i><span class="sr-only">Search</span><input id="q" placeholder="Search subject or sender" value="${esc(q.get('q') || '')}"></label>
      <label class="sr-only" for="catsel">Category</label><select id="catsel" class="pill" style="height:28px"><option value="">All categories</option>${opts}</select>
      <span class="grow"></span><span class="faint num">${fmt(idx.length)} ${kind === 'mail' ? 'emails' : 'meetings'}</span></div>
    ${itemTable(idx.slice(0, lim).map((i) => itemRow(i)).join(''))}
    ${lim < idx.length ? `<div class="more"><a class="btn ghost" href="${mk({ rows: lim + 100 })}">Show more</a></div>` : ''}</div>`;
  icons(); wireHeader(sm); wireRows();
  $('#catsel').onchange = (e) => { location.hash = mk({ cat: e.target.value || null, rows: null }); };
  const qi = $('#q');
  qi.onkeydown = (e) => { if (e.key === 'Enter') location.hash = mk({ q: qi.value || null, rows: null }); };
}

// ---------------------------------------------------------------- Settings (account page)
let PENDING = null;
function renderSettings() {
  crumbs([]);
  const sm = summary();
  const ready = S.labels.length >= 2;
  if (!PENDING) PENDING = { ...S.guarded };
  const changes = DB.mailbox.categories.filter((_, c) => !!PENDING[c] !== !!S.guarded[c]).length;
  const rows = DB.mailbox.categories.map((cat, c) => {
    const r = sm.byCategory[c], on = !!PENDING[c], changed = on !== !!S.guarded[c];
    return `<div class="card-row cat-row ${changed ? 'pending' : ''}"><div style="flex:1;min-width:0">
      <div class="row-title">${esc(cat.name)} <span class="applies">${esc(cat.applies)}</span></div>
      <div class="row-desc">${esc(cat.desc)}</div>
      <div class="audit-line"><i data-lucide="activity"></i>${ready ? `≈ ${fmt(r.est)} real conversations hidden` : 'Not audited yet'} · ${fmt(r.excluded)} excluded · ${fmt(r.crmCount)} on open records <a class="ul" href="#/excluded/audit/category/${cat.id}" style="text-decoration:underline;text-decoration-color:var(--color-neutral-t4)">See audit</a></div></div>
      <div style="display:flex;align-items:center;gap:8px;color:var(--color-content-secondary)"><span>Keep open CRM records</span>
      <button class="switch" role="switch" aria-checked="${on}" aria-label="Keep activity with open CRM records for ${esc(cat.name)}" data-c="${c}"></button>
      <button class="icon-btn" aria-label="Category actions"><i data-lucide="ellipsis"></i></button></div></div>`;
  }).join('');
  $('#view').innerHTML = `<h1 class="h1">Mail and calendar</h1><p class="sub">Manage record creation settings from your connected mail and calendar accounts</p>
    <div class="card" style="margin-top:28px">
      <div class="card-row" style="padding:16px"><span style="width:40px;height:40px;border-radius:10px;border:1px solid var(--color-border-subtle);display:grid;place-items:center;background:#fff">${gLogo()}</span>
        <div style="flex:1"><div class="row-title">jesse@acme.com</div><div class="row-desc">Google mail and calendar account</div></div>
        <span style="display:inline-flex;align-items:center;gap:8px"><span class="dot" style="background:#09ae3f"></span>Connected</span><button class="icon-btn" aria-label="Account actions"><i data-lucide="ellipsis"></i></button></div>
      <div class="card-row"><div style="flex:1"><div class="row-title">Backsync range</div><div class="row-desc">Choose how far back to sync your mail and calendar</div></div><span class="pill">3 months</span></div>
      <div class="card-row"><div style="flex:1"><div class="row-title">Calendar sync</div><div class="row-desc">Choose which meetings to track in Lightfield</div></div><span class="pill">External meetings only</span></div>
      <div class="card-row"><div style="flex:1"><div class="row-title">Account and contact creation</div><div class="row-desc">Control how new records are automatically created from emails and calendar meetings</div></div><span class="pill">When you reach out</span></div>
    </div>
    <div class="section-title">Exclusions</div>
    <div class="card"><div class="card-row" style="padding:14px 16px"><div style="flex:1"><div class="row-title">Excluded activity types</div><div class="row-desc">Lightfield checks every email and meeting from this account against these descriptions and keeps matches out of the CRM.</div></div>
      <a class="btn" href="#/excluded/audit">See excluded activity</a></div>${rows}
      <div class="card-row" style="justify-content:flex-end;gap:8px"><button class="btn ghost" id="discard" ${changes ? '' : 'disabled'}>Discard</button><button class="btn primary" id="apply" ${changes ? '' : 'disabled'}>Apply changes${changes ? ` (${changes})` : ''}</button></div></div>`;
  icons();
  document.querySelectorAll('.switch').forEach((sw) => { sw.onclick = () => { const c = +sw.dataset.c; PENDING[c] = !PENDING[c]; renderSettings(); }; });
  $('#discard').onclick = () => { PENDING = { ...S.guarded }; renderSettings(); };
  $('#apply').onclick = () => openGuardDialog(PENDING);
}
function gLogo() { return `<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`; }

function openGuardDialog(next) {
  const cats = DB.mailbox.categories;
  const items = DB.prep.items;
  const changed = cats.map((_, c) => c).filter((c) => !!next[c] !== !!S.guarded[c]);
  if (!changed.length) { toast('No pending changes'); return; }
  const ready = S.labels.length >= 2;
  const after = A.summarize(DB.prep, S.labels, { guarded: next, manual: S.manual });
  const lines = changed.map((c) => {
    const k = items.filter((it) => it.c === c && it.crm).length;
    return `<div><span>${next[c] ? 'Keep open CRM records' : 'Stop keeping open CRM records'} · ${esc(cats[c].name)}</span><span class="muted num">${next[c] ? '+' : '−'}${fmt(k)} items</span></div>`;
  }).join('');
  $('#dialog').innerHTML = `<div class="dialog-head"><div class="h3" id="dlg-title">Apply changes</div></div>
    <div class="dialog-body"><div class="muted">Activity in these categories that includes someone on an open opportunity or account will sync to the CRM. Other activity stays excluded.</div>
    <div class="summary-list">${lines}</div>
    ${ready ? `<div class="muted" style="margin-top:12px">Audit after this change: ${fmt(after.back)} items sync back, an estimated <b class="num" style="color:var(--color-content-primary)">${after.recovered ? fmt(after.recovered.est) : 0}</b> of them real conversations. At most ${fmt(after.remainingUpper)} would stay hidden (95%).</div>` : ''}</div>
    <div class="dialog-foot"><button class="btn ghost" id="d-cancel">Cancel</button><button class="btn primary" id="d-ok">Apply changes</button></div>`;
  $('#overlay').classList.add('open');
  icons();
  $('#d-ok').focus();
  $('#d-cancel').onclick = closeDialog;
  $('#d-ok').onclick = () => {
    S.guarded = Object.fromEntries(cats.map((_, c) => [c, !!next[c]]));
    PENDING = { ...S.guarded };
    save(); closeDialog();
    toast('Changes applied. Rechecking mail and meetings for jesse@acme.com');
    route();
  };
}
function closeDialog() { $('#overlay').classList.remove('open'); }
$('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeDialog(); });

// ---------------------------------------------------------------- menu, toast, export
function openMenu(anchor, entries) {
  const m = $('#menu');
  m.innerHTML = entries.map(([ic, text], k) => `<button role="menuitem" data-k="${k}" ${entries[k][2] ? '' : 'disabled'}><i data-lucide="${ic}"></i>${esc(text)}</button>`).join('');
  icons();
  const r = anchor.getBoundingClientRect();
  m.style.display = 'block';
  m.style.top = Math.min(window.innerHeight - m.offsetHeight - 8, r.bottom + 4) + 'px';
  m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px';
  m.querySelectorAll('button').forEach((b) => { b.onclick = () => { const fn = entries[+b.dataset.k][2]; closeMenu(); if (fn) fn(); }; });
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}
function closeMenu() { const m = $('#menu'); if (m) m.style.display = 'none'; }
let toastT = null;
function toast(msg) { const t = $('#toast'); t.innerHTML = `<i data-lucide="check" style="width:14px;height:14px"></i>${esc(msg)}`; icons(); t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
function exportCSV(sm) {
  const rows = [{ category: 'All categories', excluded: DB.prep.items.length, spot_checked: sm.unique, real_found: sm.total.found, est_hidden: sm.total.est.toFixed(1), ci95_low: sm.total.lo.toFixed(1), ci95_high: sm.total.hi.toFixed(1), jev_alone: sm.jev.toFixed(1), on_open_records: DB.prep.items.filter((i) => i.crm).length, crm_guard: '' },
    ...sm.byCategory.map((r) => ({ category: DB.mailbox.categories[r.c].name, excluded: r.excluded, spot_checked: r.checked, real_found: r.found, est_hidden: r.est.toFixed(1), ci95_low: r.checked >= 8 ? r.lo.toFixed(1) : '', ci95_high: r.checked >= 8 ? r.hi.toFixed(1) : '', jev_alone: r.jev.toFixed(1), on_open_records: r.crmCount, crm_guard: S.guarded[r.c] ? 'on' : 'off' }))];
  download('exclusion-audit-jesse@acme.com.csv', A.toCSV(rows), 'text/csv');
  toast('Exported audit as CSV');
}
function exportJSON() {
  const { queue, items, pi } = DB.prep;
  const out = S.labels.map((l, t) => ({ draw: t + 1, id: items[queue[t]].id, subject: items[queue[t]].subj, category: DB.mailbox.categories[items[queue[t]].c].name, jev_match: items[queue[t]].p, draw_probability: pi[queue[t]], belongs_in_crm: l === 1 }));
  download('exclusion-audit-spot-checks.json', JSON.stringify(out, null, 1), 'application/json');
}

// ---------------------------------------------------------------- keyboard + states
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input,select,textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') { closeDialog(); closeMenu(); return; }
  if ($('#overlay').classList.contains('open')) return;
  const onAudit = parseHash().parts[1] === 'audit' && !parseHash().parts[2];
  if (!onAudit) return;
  if (e.key === 's' || e.key === 'S') { e.preventDefault(); label(1); }
  else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); label(0); }
  else if (e.key === 'u' || e.key === 'U') { e.preventDefault(); undo(); }
});
$('#copy-link').onclick = async () => { try { await navigator.clipboard.writeText(location.href); toast('Link copied'); } catch { toast(location.href); } };

function renderLoading() {
  $('#crumbs').innerHTML = '<span class="skeleton" style="width:260px;height:14px;display:inline-block"></span>';
  $('#view').innerHTML = `<div class="skeleton" style="width:260px;height:30px"></div><div class="skeleton" style="width:420px;height:16px;margin-top:12px"></div>
    <div class="skeleton" style="height:96px;margin-top:40px;border-radius:10px"></div><div class="skeleton" style="height:320px;margin-top:16px;border-radius:10px"></div>`;
  icons();
}
function renderError(e) {
  $('#view').innerHTML = `<div class="card white error"><i data-lucide="cloud-off"></i><div class="row-title" style="margin-top:8px">Couldn't load excluded activity</div><div class="row-desc">${esc(e.message)}</div><button class="btn" style="margin-top:14px" id="retry">Try again</button></div>`;
  icons(); $('#retry').onclick = boot;
}

boot();
