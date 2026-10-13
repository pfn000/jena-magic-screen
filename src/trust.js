// Mama's trusted device (api/_lib/mama.js). One passcode unlock on a device -> a 1-year signed token, kept as an
// HttpOnly cookie AND in localStorage ('jena.dmKey', the slot every mama feature already reads). From then on
// take over, file send, dev panel, Tab Live, sign-in and her raw desktop just work, with no prompt.
// The passcode is asked again only when the API answers with X-Jena-Step-Up:
//   mama_only  = the public/stream side tried a mama-only command (it was blocked; mama can approve it here)
//   suspicious = a request from this trusted device looked unusual, so it needs the passcode once
const KEY = 'jena.dmKey';
const PREFIX = 'jmt1.';
const OBS = new URLSearchParams(location.search).get('obs') === '1';
const nativeFetch = window.fetch.bind(window);
const get = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
const set = (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {} };

export const trust = { state: null, listeners: new Set() };
const emit = () => trust.listeners.forEach((f) => { try { f(trust.state); } catch {} });

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'device';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${os} · ${br}`;
}

// a passcode (typed into ANY of the existing unlock boxes) becomes a trusted-device token right away
export async function trustWithPasscode(pass) {
  const r = await nativeFetch('/api/trust', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': pass }, body: JSON.stringify({ action: 'issue', label: deviceLabel() }) }).catch(() => null);
  if (!r) return { ok: false, error: 'no answer' };
  const d = await r.json().catch(() => ({}));
  if (r.ok && d.token) { set(d.token); trust.state = { trusted: true, ...d }; emit(); }
  return { ok: r.ok && !!d.token, ...d };
}

export async function forgetDevice() {
  await nativeFetch('/api/trust', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': get() }, body: JSON.stringify({ action: 'forget' }) }).catch(() => null);
  set('');
  trust.state = { trusted: false };
  emit();
}

let upgrading = false;
async function sync(first = false) {
  if (upgrading) return;
  const v = get();
  upgrading = true;
  try {
    if (v && !v.startsWith(PREFIX)) { await trustWithPasscode(v); return; }   // an old saved passcode: upgrade it, no prompt
    const r = await nativeFetch('/api/trust', { credentials: 'same-origin', cache: 'no-store', headers: v ? { 'X-Jena-Key': v } : {} }).catch(() => null);
    if (!r || !r.ok) return;   // offline: keep whatever we have
    const d = await r.json().catch(() => null);
    if (!d) return;
    if (d.trusted) {
      trust.state = d;
      if (!v && d.token) {   // localStorage was cleared but the cookie remembers this device: restore mama mode
        set(d.token);
        if (first && !sessionStorage.getItem('jena.trustReload')) { sessionStorage.setItem('jena.trustReload', '1'); location.reload(); return; }
      }
    } else {
      trust.state = { trusted: false, revoked: d.revoked };
      if (v && v.startsWith(PREFIX) && d.enabled !== false) set('');   // forgotten / expired token: back to locked
    }
    emit();
  } finally { upgrading = false; }
}

// ---------------- the passcode prompt (only for step-ups) ----------------
let open = null;
export function askPasscode(title, detail) {
  if (open) return open;
  open = new Promise((resolve) => {
    const w = document.createElement('div');
    w.id = 'mama-stepup';
    w.style.cssText = 'position:fixed;inset:0;z-index:100002;display:flex;align-items:center;justify-content:center;background:rgba(10,8,20,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);font:15px system-ui,sans-serif';
    w.innerHTML = `<form style="width:min(340px,calc(100vw - 32px));background:rgba(32,26,52,.96);color:#f8eaff;border:1px solid #b48cff;border-radius:20px;padding:18px 18px 14px;box-shadow:0 10px 40px rgba(0,0,0,.45)">
      <b style="display:block;font-size:16px;margin-bottom:6px">🔐 ${title}</b>
      <p style="margin:0 0 12px;opacity:.85;font-size:13px;line-height:1.35"></p>
      <input type="password" autocomplete="current-password" placeholder="mama's passcode" style="font-size:16px;padding:11px;border-radius:12px;border:1px solid #8a76b8;background:#15121f;color:#fff;width:100%;box-sizing:border-box">
      <div style="display:flex;gap:8px;margin-top:12px"><button type="button" data-x style="flex:1;padding:10px;border-radius:12px;border:1px solid #8a76b8;background:none;color:#f8eaff">not now</button>
      <button style="flex:1;padding:10px;border-radius:12px;border:0;background:#b48cff;color:#1d1b2e;font-weight:700">unlock</button></div></form>`;
    w.querySelector('p').textContent = detail || '';
    const done = (v) => { w.remove(); open = null; resolve(v); };
    w.querySelector('[data-x]').onclick = () => done('');
    w.querySelector('form').onsubmit = (e) => { e.preventDefault(); done(w.querySelector('input').value.trim()); };
    document.body.appendChild(w);
    setTimeout(() => w.querySelector('input').focus(), 30);
  });
  return open;
}

const isApi = (input) => { try { return new URL(typeof input === 'string' ? input : input.url, location.href).pathname.startsWith('/api/'); } catch { return false; } };
let lastPublicAsk = 0;
window.fetch = async (input, init = {}) => {
  const res = await nativeFetch(input, init);
  if (OBS || !isApi(input)) return res;
  const su = res.headers.get('x-jena-step-up');
  if (!su) return res;
  const retry = (pass, patch) => {
    const h = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined) || {});
    h.set('X-Jena-Key', pass);
    let b = init.body;
    if (patch && typeof b === 'string') { try { b = JSON.stringify({ ...JSON.parse(b), ...patch }); } catch {} }
    return nativeFetch(input, { ...init, headers: h, body: b });
  };
  if (su === 'suspicious' && res.status === 401) {
    const d = await res.clone().json().catch(() => ({}));
    const pass = await askPasscode('Passcode needed once', `This request looks unusual (${d.why || 'flagged by the safety check'}), so it needs mama's passcode. Your device stays trusted.`);
    if (!pass) return res;
    const again = await retry(pass);
    if (again.status === 401) await askPasscode('Wrong passcode', 'That passcode was not right, so the request was not sent.').catch(() => {});
    return again;
  }
  if (su === 'mama_only') {   // the request went through as a normal (public) message; the mama-only part was blocked
    if (Date.now() - lastPublicAsk < 60000) return res;
    lastPublicAsk = Date.now();
    let said = '';
    try { said = JSON.parse(init.body || '{}').message || ''; } catch {}
    const src = (() => { try { return JSON.parse(init.body || '{}').source; } catch { return ''; } })();
    const pass = await askPasscode('Mama-only command blocked', `${src === 'twitch' ? 'Someone on stream' : 'The public chat'} asked Jena: “${said.slice(0, 120)}”. Only mama can do that. Type the passcode to run it as mama.`);
    if (!pass) return res;
    const again = await retry(pass, { user: 'mama', source: 'stage' });
    if (again.ok && !get()) trustWithPasscode(pass);   // and remember this device as mama's from now on
    return again;
  }
  return res;
};

if (!OBS) {
  sync(true);
  setInterval(() => { const v = get(); if (v && !v.startsWith(PREFIX)) sync(); }, 2000);   // passcode just typed somewhere -> trust it
  setInterval(() => sync(), 10 * 60000);
  window.addEventListener('storage', (e) => { if (e.key === KEY) sync(); });
}
window.jenaTrust = { trust, forgetDevice, trustWithPasscode, askPasscode };
