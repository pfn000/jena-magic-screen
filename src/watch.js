// Jena watchdog, page side (two small jobs, nothing private leaves this page):
//  1. Reporter: notices her desktop panel or brain badge flipping asleep <-> awake over and over, the desktop
//     staying asleep for minutes, or JS errors piling up, and POSTs a tiny no-PII report to her box
//     (/api/incident -> her box's watchdog, which cross-checks with what the box itself sees). Rate-limited.
//  2. Health view: inside the developer panel's "Health" tab (passcode only), the watchdog's live state:
//     every service, flaps, the recovery ladder, known-good commits and the incident log.
const WIN = 10 * 60 * 1000, FLAP_N = 3, MAX_REPORTS = 3;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const scrub = (s) => String(s || '').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]').replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1').replace(/\b\d{6,}\b/g, '[num]').slice(0, 200);
const rid = Math.random().toString(36).slice(2, 10);   // random per page load, not tied to anyone
const view = new URLSearchParams(location.search).get('obs') === '1' ? 'obs' : new URLSearchParams(location.search).get('dev') === '1' ? 'dev' : 'main';
const device = matchMedia('(max-width: 700px)').matches ? 'phone' : 'desktop';
let build = '';
fetch('/api/config', { cache: 'no-store' }).then((r) => r.json()).then((c) => { build = (c?.build?.commit || '').slice(0, 7); }).catch(() => {});

const sent = [];
export const watchLog = [];   // what this page reported (for the dev panel + tests)
async function report(kind, panel, count, windowS, msg) {
  const now = Date.now();
  while (sent.length && now - sent[0] > WIN) sent.shift();
  if (sent.length >= MAX_REPORTS) return null;
  sent.push(now);
  const b = { kind, panel, count, window_s: windowS, msg: scrub(msg), build, view, device, rid };
  const r = await fetch('/api/incident', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b), keepalive: true }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
  watchLog.push({ at: now, sent: b, answer: r });
  return r;
}

// a panel that flips between asleep and awake: count wake-ups inside 10 min
function watchFlips(el, isAsleep, panel, kind) {
  if (!el) return;
  let asleep = isAsleep(), since = Date.now(), wakes = [], stuckSent = 0;
  new MutationObserver(() => {
    const a = isAsleep();
    if (a === asleep) return;
    asleep = a; since = Date.now();
    if (!a) {
      const now = Date.now(); wakes = wakes.filter((t) => now - t < WIN); wakes.push(now);
      if (wakes.length >= FLAP_N) { report(kind, panel, wakes.length, Math.round((now - wakes[0]) / 1000), `${panel} went asleep and woke up ${wakes.length}x`); wakes = []; }
    }
  }).observe(el, { attributes: true, attributeFilter: ['class'] });
  setInterval(() => {   // stuck asleep for 3+ min while someone is actually looking
    if (asleep && !document.hidden && Date.now() - since > 180000 && Date.now() - stuckSent > 30 * 60000) {
      stuckSent = Date.now(); report('panel_stuck', panel, 1, Math.round((Date.now() - since) / 1000), `${panel} asleep for ${Math.round((Date.now() - since) / 60000)} min`);
    }
  }, 30000);
}

function startReporter() {
  const desk = document.getElementById('desktop');
  watchFlips(desk, () => desk.classList.contains('is-asleep') || desk.classList.contains('is-waking'), 'desktop', 'panel_flap');
  const badge = document.querySelector('#thoughts .brain-badge') || document.querySelector('.brain-badge');
  watchFlips(badge, () => badge.classList.contains('is-off'), 'brain', 'brain_flap');
  let errs = [], first = '', timer = null;
  const onErr = (m) => {
    errs.push(Date.now()); if (!first) first = m;
    if (!timer) timer = setTimeout(() => { const n = errs.length; timer = null; if (n >= 3) report('js_error', 'page', n, 60, first); errs = []; first = ''; }, 60000);
  };
  addEventListener('error', (e) => onErr(`${e.message || 'error'} @ ${(e.filename || '').split('/').pop()}:${e.lineno || 0}`));
  addEventListener('unhandledrejection', (e) => onErr('unhandled: ' + String(e.reason?.message || e.reason || '').slice(0, 120)));
}

// ---------------- Health view (dev panel only; the box answers details only with mama's passcode)
let cache = '', ver = 0, busy = false, lastAt = 0;
const dot = (ok) => `<i class="dot ${ok ? 'ok' : 'bad'}"></i>`;
const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`; };
function renderHealth(d, err) {
  if (err) return `<div id="wd-health" class="dp-card"><h3>Watchdog</h3><p>${esc(err)}</p></div>`;
  const w = d.data || {};
  if (!w.private) return `<div id="wd-health" class="dp-card"><h3>Watchdog</h3><p>status: <b>${esc(w.status || '?')}</b> · details are mama-only: unlock the private DM drawer with your passcode first</p></div>`;
  const pill = { healthy: 'ready', trouble: 'checking', degraded: 'blocked' }[w.status] || '';
  const units = Object.entries(w.units || {}).map(([n, u]) => `<tr><td>${dot(u.active === 'active' && (!u.probe || u.probe.ok) && !u.degraded)}${esc(n.replace('jena-', ''))}</td><td>${esc(u.active)}${u.probe ? ` · ${u.probe.ms} ms` : ''}</td><td>${u.flaps_10min}</td><td>${u.ladder ? 'L' + u.ladder : '—'}${u.degraded ? ' ⚠️' : ''}</td><td>${esc((u.known_good?.commits || []).join(' ') || '—')}</td></tr>`).join('');
  const inc = (w.incidents || []).slice(-14).reverse().map((i) => `<li><small>${ago(i.ts)}</small> <b>${esc(i.unit)}</b> ${esc(i.what)} · ${esc(i.action)}${i.result ? ' → ' + esc(i.result).slice(0, 160) : ''}</li>`).join('');
  const f = w.frame || {}, t = w.tunnel || {}, c = w.chat_probe || {};
  return `<div id="wd-health" class="dp-card"><h3>Watchdog <span class="dp-pill ${pill}">${esc(w.status)}</span>${w.paused ? ' <span class="dp-pill">paused</span>' : ''}</h3>
    <p>checks every service every 20 s · flap = 3 restarts / sleep-wake cycles in 10 min → restart → roll back to the last known-good files → degraded</p>
    <p>${dot(t.ok)} public tunnel ${t.ms ?? '?'} ms · ${dot(f.fresh)} desktop frame ${esc(f.censor_state || '?')}${f.screen_age_s != null ? ` (${f.screen_age_s}s)` : ''} · ${dot(w.firefox_alive)} Firefox · ${dot(c.ok)} chat reply probe ${c.ms ?? '?'} ms</p>
    <div style="overflow-x:auto"><table class="wd-t"><tr><th>service</th><th>state</th><th>flaps</th><th>ladder</th><th>known-good</th></tr>${units}</table></div>
    <h4>Incidents</h4><ul class="wd-inc">${inc || '<li>none yet</li>'}</ul><p class="dp-foot">watchdog read ${ago(d._at)}</p></div>`;
}
async function pullHealth() {
  if (busy || Date.now() - lastAt < 8000) return; busy = true; lastAt = Date.now();
  const key = localStorage.getItem('jena.dmKey') || '';
  try {
    const r = await fetch('/api/box?what=watch', { headers: { 'X-Jena-Key': key }, cache: 'no-store' });
    const d = await r.json(); d._at = Date.now();
    cache = r.status === 401 ? renderHealth(null, 'Watchdog details are mama-only: unlock the private DM drawer with your passcode first') : d.online === false ? renderHealth(null, 'her box did not answer: ' + (d.error || '')) : renderHealth(d);
  } catch (e) { cache = renderHealth(null, 'could not reach the watchdog: ' + e.message); }
  ver++; cache = cache.replace('<div id="wd-health"', `<div data-v="${ver}" id="wd-health"`); busy = false; place();
}
function place() {
  const dp = document.getElementById('devpanel'), body = dp?.querySelector('.dp-body');
  const on = dp && !dp.hidden && dp.querySelector('nav button.on')?.dataset.tab === 'health';
  if (!on || !body) return;
  const old = body.querySelector('#wd-health');
  if (old && old.dataset.v === String(ver)) return;   // already showing this read (no re-insert loop)
  if (old) old.remove();
  if (cache) body.insertAdjacentHTML('afterbegin', cache);
}
function startHealthView() {
  if (!document.getElementById('wd-css')) {
    const st = document.createElement('style'); st.id = 'wd-css';
    st.textContent = '#wd-health table.wd-t{border-collapse:collapse;font-size:12px;width:100%}#wd-health .wd-t td,#wd-health .wd-t th{padding:3px 6px;border-bottom:1px solid rgba(255,255,255,.1);text-align:left;white-space:nowrap}#wd-health .wd-inc{font-size:12px;padding-left:16px;max-height:260px;overflow:auto;word-break:break-word}#wd-health .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:#c33}#wd-health .dot.ok{background:#2c3}';
    document.head.appendChild(st);
  }
  const hook = () => {
    const dp = document.getElementById('devpanel'); if (!dp) return false;
    new MutationObserver(() => place()).observe(dp.querySelector('.dp-body'), { childList: true });
    setInterval(() => { const on = !dp.hidden && dp.querySelector('nav button.on')?.dataset.tab === 'health'; if (on) pullHealth(); }, 2000);
    return true;
  };
  if (!hook()) { const t = setInterval(() => { if (hook()) clearInterval(t); }, 1000); setTimeout(() => clearInterval(t), 60000); }
}

if (typeof window !== 'undefined') {
  const go = () => { startReporter(); if (view !== 'obs') startHealthView(); };
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', go) : go();
  window.__jenaWatch = { log: watchLog, report };
}
