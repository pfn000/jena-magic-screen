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
      if (!v && d.token && first) {   // localStorage was cleared but the cookie remembers this device: restore mama mode (on load only; 'lock' stays locked until reload)
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
  if (su === 'mama_only') {   // went through as a normal public message (her gateway refused the mama-only part); never hold the reply
    if (Date.now() - lastPublicAsk > 60000) {
      lastPublicAsk = Date.now();
      let said = '', src = '';
      try { const j = JSON.parse(init.body || '{}'); said = j.message || ''; src = j.source || ''; } catch {}
      askPasscode('Mama-only command blocked', `${src === 'twitch' ? 'Someone on stream' : 'The public chat'} asked Jena: “${said.slice(0, 120)}”. Only mama can do that, so it was not done. Type the passcode to run it as mama.`).then(async (pass) => {
        if (!pass) return;
        const t = await trustWithPasscode(pass);   // right passcode -> this device is mama's from now on
        if (!t.ok) { askPasscode('Wrong passcode', 'That passcode was not right, so nothing ran.'); return; }
        window.jena?.think?.(said, 'mama');
      });
    }
    return res;
  }
  return res;
};

// ---------------- passkeys (Face ID on iPhone Safari, Touch ID, Windows Hello) ----------------
const toBuf = (s) => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); s += '==='.slice((s.length + 3) % 4); return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer; };
const toB64u = (b) => { const a = new Uint8Array(b); let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const passkeySupported = () => !!(window.PublicKeyCredential && navigator.credentials?.create);
const pkApi = (b) => nativeFetch('/api/passkey', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': get() }, body: JSON.stringify(b) }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
// options are fetched ahead of the tap: Safari only shows Face ID from a fresh tap, so the tap must go straight to it
const pre = { reg: null, login: null };
export async function preparePasskey(kind) {
  const o = await pkApi({ action: kind === 'reg' ? 'register-options' : 'login-options' });
  pre[kind] = o.ok ? { ...o, at: Date.now() } : null;
  return o;
}
const fresh = (kind) => (pre[kind] && Date.now() - pre[kind].at < 150000 ? pre[kind] : null);
export async function addPasskey(label) {
  const o = fresh('reg') || (await preparePasskey('reg'));
  pre.reg = null;
  if (!o.ok) return o;
  const pk = o.publicKey;
  const cred = await navigator.credentials.create({ publicKey: { ...pk, challenge: toBuf(pk.challenge), user: { ...pk.user, id: toBuf(pk.user.id) }, excludeCredentials: (pk.excludeCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })) } }).catch((e) => ({ error: e.name === 'NotAllowedError' ? 'cancelled' : e.message }));
  if (cred.error) return { ok: false, error: cred.error };
  return pkApi({ action: 'register', token: o.token, label: label || deviceLabel(), credential: { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, response: { clientDataJSON: toB64u(cred.response.clientDataJSON), attestationObject: toB64u(cred.response.attestationObject), transports: cred.response.getTransports?.() || [] } } });
}
export async function loginWithPasskey() {
  const o = fresh('login') || (await preparePasskey('login'));
  pre.login = null;
  if (!o.ok) return o;
  const pk = o.publicKey;
  const cred = await navigator.credentials.get({ publicKey: { ...pk, challenge: toBuf(pk.challenge), allowCredentials: (pk.allowCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })) } }).catch((e) => ({ error: e.name === 'NotAllowedError' ? 'cancelled' : e.message }));
  if (cred.error) return { ok: false, error: cred.error };
  const d = await pkApi({ action: 'login', token: o.token, label: deviceLabel() + ' · passkey', credential: { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, response: { clientDataJSON: toB64u(cred.response.clientDataJSON), authenticatorData: toB64u(cred.response.authenticatorData), signature: toB64u(cred.response.signature), userHandle: cred.response.userHandle ? toB64u(cred.response.userHandle) : null } } });
  if (d.ok && d.token) { set(d.token); trust.state = { trusted: true, ...d }; emit(); }
  return d;
}
// a "Face ID / passkey" button on the private drawer's unlock form (the passcode box stays as the fallback)
function passkeyOnLock() {
  const f = document.getElementById('dm-unlock');
  if (!f || f.querySelector('.pk-btn') || !passkeySupported()) return;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'pk-btn';
  btn.textContent = '🔑 use Face ID / passkey';
  btn.style.cssText = 'margin-top:8px;width:100%;padding:9px;border-radius:12px;border:1px solid #b48cff;background:none;color:inherit;font:600 14px system-ui;cursor:pointer';
  btn.onclick = async () => {
    const err = document.getElementById('dm-err');
    const d = await loginWithPasskey();
    if (d.ok) location.reload();
    else if (err) err.textContent = d.error === 'cancelled' ? '' : `passkey: ${d.error}`;
  };
  f.appendChild(btn);
  btn.addEventListener('pointerenter', () => { if (!fresh('login')) preparePasskey('login'); }, { once: true });
  document.getElementById('dm-toggle')?.addEventListener('click', () => { if (!get()) preparePasskey('login'); });
}

// a one-tap trust link from Tab (/?trust=…): this device becomes mama's with nothing to type
async function redeemLink() {
  const q = new URLSearchParams(location.search);
  const link = q.get('trust');
  if (!link) return false;
  q.delete('trust');
  history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
  const r = await nativeFetch('/api/trust', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'redeem', link, label: deviceLabel() }) }).catch(() => null);
  const d = r ? await r.json().catch(() => ({})) : {};
  if (d.ok && d.token) { set(d.token); try { sessionStorage.removeItem('jena.locked'); } catch {} trust.state = { trusted: true, ...d }; emit(); location.reload(); return true; }
  setTimeout(() => askPasscode('Trust link did not work', `${d.error || 'no answer from the site'}. Ask Tab for a fresh link, or type the passcode once.`).then((p) => p && trustWithPasscode(p)), 500);
  return false;
}

// the key went missing mid-visit (a 401 somewhere cleared it, another tab, a reload race) but the cookie still
// says this is mama's device: put it back silently. Only an explicit 'lock' (private drawer) keeps it locked.
let lastRestore = 0;
async function restore() {
  if (get() || Date.now() - lastRestore < 15000) return;
  try { if (sessionStorage.getItem('jena.locked') === '1') return; } catch {}
  lastRestore = Date.now();
  const r = await nativeFetch('/api/trust', { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
  const d = r && r.ok ? await r.json().catch(() => null) : null;
  if (d?.trusted && d.token && !get()) { set(d.token); trust.state = d; emit(); document.getElementById('dm')?.classList.remove('locked'); }
}
document.addEventListener('click', (e) => {
  if (e.target?.closest?.('#dm-lock')) { try { sessionStorage.setItem('jena.locked', '1'); } catch {} }
  if (e.target?.closest?.('#dm-unlock button, .desk-mama-key, [data-ask-unlock], #go')) { try { sessionStorage.removeItem('jena.locked'); } catch {} }
}, true);

if (!OBS) {
  redeemLink().then((done) => { if (!done) sync(true); });
  setInterval(restore, 3000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', passkeyOnLock); else setTimeout(passkeyOnLock, 0);
  setInterval(() => { const v = get(); if (v && !v.startsWith(PREFIX)) sync(); }, 2000);   // passcode just typed somewhere -> trust it
  setInterval(() => sync(), 10 * 60000);
  window.addEventListener('storage', (e) => { if (e.key === KEY) sync(); });
}
window.jenaTrust = { trust, forgetDevice, trustWithPasscode, askPasscode, addPasskey, loginWithPasskey, passkeySupported };
