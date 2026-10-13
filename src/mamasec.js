// Dev panel → "🔐 Mama: devices & keys" (mama only). This device's trust (forget it), mama's other trusted devices.
// More sections (passkeys, Accounts vault, GitHub sign-in) plug in below as they ship.
import { trust, forgetDevice, addPasskey, loginWithPasskey, preparePasskey, passkeySupported } from './trust.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (t) => (t ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '?');
const key = () => localStorage.getItem('jena.dmKey') || '';
export const sec = { devices: null, out: '', sections: [] };

async function api(path, b) {
  const r = await fetch(path, { method: b ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': key() }, body: b ? JSON.stringify(b) : undefined }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }));
  const d = await r.json().catch(() => ({}));
  return { status: r.status, ...d };
}
sec.api = api;

export function renderSecurity() {
  const t = trust.state;
  let h = '<div class="dp-card" id="sec-device"><h3>This device</h3>';
  if (!key()) {
    h += '<p>Not unlocked on this device yet. Unlock once with your passcode (the private DM drawer, the 🔑 on her desktop, or Ask mama) and this device is remembered as yours for a year: no more passcode for take over, files, the dev panel, Tab Live or sign-ins.</p>';
  } else if (t?.trusted) {
    h += `<p>✅ <b>Trusted mama device</b> · ${esc(t.label || 'this browser')} · since ${day(t.since)} · until ${day(t.expires)}</p>
      <p><small>No passcode prompts here. The passcode is asked again only if the stream/public chat tries a mama-only command, or a request from here looks suspicious.</small></p>
      <p><button data-sec="forget">🚫 Forget this device</button></p>`;
  } else {
    h += '<p>checking this device…</p>';
  }
  h += '</div>';
  if (key()) {
    const ds = sec.devices;
    h += `<div class="dp-card"><h3>Mama's trusted devices</h3>${!ds ? '<p>loading…</p>' : ds.devices?.length ? `<ul>${ds.devices.slice().reverse().map((d) => `<li>${esc(d.label || 'device')} · since ${day(d.iat * 1000)}${d.id === ds.me ? ' · <b>this one</b>' : ''}</li>`).join('')}</ul>` : '<p>none recorded on her box yet</p>'}${ds?.revoked ? `<p><small>${ds.revoked} forgotten device(s)</small></p>` : ''}</div>`;
    if (!ds) { sec.devices = { loading: true }; api('/api/trust', { action: 'devices' }).then((d) => { sec.devices = d; sec.rerender?.(); }); }
  }
  for (const s of sec.sections) { try { h += s.render(); } catch (e) { h += `<p class="dp-warn">${esc(e.message)}</p>`; } }
  if (sec.out) h += `<pre id="sec-out">${esc(sec.out)}</pre>`;
  return h;
}

export async function handleSecurityClick(e, rerender) {
  sec.rerender = rerender;
  const a = e.target.closest?.('[data-sec]')?.dataset.sec;
  if (!a) { for (const s of sec.sections) if (s.click && (await s.click(e, rerender))) return true; return false; }
  if (a === 'forget') {
    if (!confirm('Forget this device? It goes back to asking for the passcode.')) return true;
    await forgetDevice();
    sec.out = 'forgotten: this device is locked again';
    sec.devices = null;
    rerender();
    return true;
  }
  return false;
}
trust.listeners.add(() => sec.rerender?.());

// ---------------- Passkeys ----------------
const pk = { list: null, out: '', prepAt: 0 };
sec.sections.push({
  render() {
    const sup = passkeySupported();
    if (!key()) {
      if (sup && Date.now() - pk.prepAt > 120000) { pk.prepAt = Date.now(); preparePasskey('login'); }
      return `<div class="dp-card" id="sec-passkey"><h3>🔑 Passkey</h3><p>${sup ? '<button data-pk="login">🔑 Unlock with Face ID / passkey</button>' : 'This browser has no passkey support.'}</p>${pk.out ? `<p><small>${esc(pk.out)}</small></p>` : ''}</div>`;
    }
    if (!pk.list) { pk.list = { loading: true }; api('/api/passkey', { action: 'list' }).then((d) => { pk.list = d; sec.rerender?.(); }); }
    if (sup && Date.now() - pk.prepAt > 120000) { pk.prepAt = Date.now(); preparePasskey('reg'); }
    const L = pk.list;
    const rows = L?.credentials?.length ? `<ul>${L.credentials.map((c) => `<li>🔑 ${esc(c.label || 'passkey')} · added ${day(c.created)}${c.used ? ' · last used ' + day(c.used) : ''} <button data-pk="del" data-id="${esc(c.id)}">remove</button></li>`).join('')}</ul>` : L?.loading ? '<p>loading…</p>' : L?.ok === false ? `<p class="dp-warn">${esc(L.error)}</p>` : '<p>No passkey yet.</p>';
    return `<div class="dp-card" id="sec-passkey"><h3>🔑 Passkeys (Face ID / Touch ID / Windows Hello)</h3>
      <p><small>For ${esc(L?.rpId || location.host)}. Add one on your iPhone in Safari: tap the button, then Face ID. After that, any new device (or this one after “forget”) unlocks with Face ID instead of the passcode.</small></p>
      ${rows}<p>${sup ? '<button data-pk="add">➕ Add a passkey on this device</button>' : '<i>this browser has no passkey support</i>'}</p>${pk.out ? `<p><small>${esc(pk.out)}</small></p>` : ''}</div>`;
  },
  async click(e, rerender) {
    const b = e.target.closest?.('[data-pk]');
    if (!b) return false;
    const a = b.dataset.pk;
    if (a === 'add') { pk.out = 'waiting for Face ID / your device…'; rerender(); const d = await addPasskey(); pk.out = d.ok ? '✅ passkey added' : d.error === 'cancelled' ? 'cancelled' : `couldn't add it: ${d.error}`; pk.list = null; pk.prepAt = 0; rerender(); return true; }
    if (a === 'login') { pk.out = 'waiting for Face ID / your device…'; rerender(); const d = await loginWithPasskey(); pk.out = d.ok ? '✅ unlocked: this device is trusted now' : d.error === 'cancelled' ? 'cancelled' : `couldn't unlock: ${d.error}`; pk.prepAt = 0; rerender(); if (d.ok) setTimeout(() => location.reload(), 900); return true; }
    if (a === 'del') { if (!confirm('Remove this passkey? That device will need the passcode again.')) return true; const d = await api('/api/passkey', { action: 'delete', id: b.dataset.id }); pk.out = d.ok ? 'removed' : d.error; pk.list = null; rerender(); return true; }
    return false;
  },
});

// ---------------- Accounts vault (Jena's site logins; encrypted on her box) ----------------
const V = { list: null, out: '', form: { site: '', username: '', password: '', notes: '' }, editing: null, shown: {} };
const vf = (id) => document.getElementById(id);
function snapForm() {
  if (!vf('sec-v-site')) return;
  V.form = { site: vf('sec-v-site').value, username: vf('sec-v-user').value, password: vf('sec-v-pass').value, notes: vf('sec-v-notes').value };
}
sec.sections.push({
  render() {
    if (!key()) return '';
    snapForm();
    if (!V.list) { V.list = { loading: true }; api('/api/vault', { op: 'list' }).then((d) => { V.list = d; sec.rerender?.(); }); }
    const L = V.list;
    const rows = L?.entries?.length
      ? `<table class="dp-t"><tr><th>site</th><th>username</th><th>password</th><th></th></tr>${L.entries.map((e) => { const s = V.shown[e.id]; return `<tr><td><b>${esc(e.site)}</b></td><td>${s ? esc(s.username) : esc(e.user)}</td><td>${s ? `<code>${esc(s.password)}</code>` : e.has_password ? '••••••••' : '<i>none</i>'}${s && s.notes ? `<br><small>${esc(s.notes)}</small>` : ''}</td><td><button data-v="reveal" data-id="${e.id}">${s ? '🙈 hide' : '👁 reveal'}</button> <button data-v="edit" data-id="${e.id}">✏️ edit</button> <button data-v="del" data-id="${e.id}">🗑</button></td></tr>`; }).join('')}</table>`
      : L?.loading ? '<p>loading…</p>' : L?.ok === false ? `<p class="dp-warn">${esc(L.error || L.summary)}</p>` : '<p>No accounts saved yet.</p>';
    const f = V.form;
    queueMicrotask(() => { const p = vf('sec-v-pass'); if (p && p.value !== f.password) p.value = f.password || ''; });
    return `<div class="dp-card" id="sec-vault"><h3>🗝 Accounts · Jena's site logins</h3>
      <p><small>Encrypted on her box (AES-256-GCM, key only on her box). Values show only here, on a trusted device, when you tap reveal; never on stream, in logs or in Tab Live. Jena's own browser fills these on sign-in pages by itself; a CAPTCHA or a 2FA code always raises the Take over card for you instead.</small></p>
      ${rows}
      <h4 style="margin:12px 0 4px">${V.editing ? 'Edit account' : 'Add an account'}</h4>
      <p style="display:flex;flex-wrap:wrap;gap:6px"><input id="sec-v-site" placeholder="site (e.g. github.com)" value="${esc(f.site)}" size="22" autocomplete="off">
      <input id="sec-v-user" placeholder="username / email" value="${esc(f.username)}" size="22" autocomplete="off">
      <input id="sec-v-pass" type="password" placeholder="${V.editing ? 'password (blank = keep)' : 'password'}" size="18" autocomplete="new-password">
      <input id="sec-v-notes" placeholder="notes (optional)" value="${esc(f.notes)}" size="22" autocomplete="off"></p>
      <p><button data-v="save">💾 ${V.editing ? 'save changes' : 'add account'}</button>${V.editing ? ' <button data-v="cancel">cancel</button>' : ''}</p>${V.out ? `<p><small>${esc(V.out)}</small></p>` : ''}</div>`;
  },
  async click(e, rerender) {
    const b = e.target.closest?.('[data-v]');
    if (!b) return false;
    const a = b.dataset.v, id = b.dataset.id;
    snapForm();
    if (a === 'reveal') {
      if (V.shown[id]) { delete V.shown[id]; rerender(); return true; }
      const d = await api('/api/vault', { op: 'reveal', id });
      if (d.ok) { V.shown[id] = d; setTimeout(() => { delete V.shown[id]; rerender(); }, 30000); } else V.out = d.error || d.summary;
      rerender(); return true;
    }
    if (a === 'edit') {
      const d = V.shown[id] || (await api('/api/vault', { op: 'reveal', id }));
      if (!d.ok) { V.out = d.error || d.summary; rerender(); return true; }
      V.editing = id; V.form = { site: d.site, username: d.username, password: '', notes: d.notes || '' }; V.out = ''; rerender(); return true;
    }
    if (a === 'cancel') { V.editing = null; V.form = { site: '', username: '', password: '', notes: '' }; rerender(); return true; }
    if (a === 'del') {
      if (!confirm('Delete this saved account?')) return true;
      const d = await api('/api/vault', { op: 'delete', id }); V.out = d.ok ? 'deleted' : d.error || d.summary; V.list = null; delete V.shown[id]; rerender(); return true;
    }
    if (a === 'save') {
      const f = V.form;
      if (!f.site.trim()) { V.out = 'the site is needed'; rerender(); return true; }
      const d = await api('/api/vault', { op: V.editing ? 'edit' : 'add', id: V.editing || undefined, site: f.site.trim(), username: f.username, password: f.password, notes: f.notes });
      V.out = d.ok ? (V.editing ? '✅ saved' : '✅ added') : d.error || d.summary;
      if (d.ok) { V.form = { site: '', username: '', password: '', notes: '' }; V.editing = null; V.list = null; V.shown = {}; }
      rerender(); return true;
    }
    return false;
  },
});

// ---------------- GitHub CLI: "Sign Jena into GitHub" (mama finishes it on github.com; Tab never signs in) ----------------
const G = { st: null, out: '', timer: null };
function ghPoll() {
  clearTimeout(G.timer);
  if (G.st?.state !== 'waiting_for_mama') return;
  G.timer = setTimeout(async () => { const d = await api('/api/ghauth', { op: 'status' }); if (d.ok) G.st = { ...G.st, ...d }; sec.rerender?.(); ghPoll(); }, 5000);
}
sec.sections.push({
  render() {
    if (!key()) return '';
    if (!G.st) { G.st = { loading: true }; api('/api/ghauth', { op: 'status' }).then((d) => { G.st = d; sec.rerender?.(); ghPoll(); }); }
    const s = G.st;
    let body;
    if (s?.loading) body = '<p>checking…</p>';
    else if (s?.ok === false) body = `<p class="dp-warn">${esc(s.error || s.summary)}</p><p><button data-gh="start">🐙 Sign Jena into GitHub</button></p>`;
    else if (s?.signed_in) body = `<p>✅ Jena's GitHub CLI is signed in${s.account ? ` as <b>${esc(s.account)}</b>` : ''}.</p>`;
    else if (s?.state === 'waiting_for_mama' && s.code) body = `<p>1. Open <a href="${esc(s.url)}" target="_blank" rel="noopener"><b>github.com/login/device</b></a> (signed in as Jena's GitHub account)</p>
        <p>2. Enter this code: <code style="font-size:22px;letter-spacing:3px;padding:2px 8px;border:1px solid #b48cff;border-radius:8px">${esc(s.code)}</code> <button data-gh="copy">copy</button></p>
        <p><small>waiting for you to approve it… (the code is good for about 15 min)</small> <button data-gh="cancel">cancel</button></p>`;
    else body = `<p>Not signed in yet. Tap the button: her box starts <code>gh auth login --web</code> as Jena and shows you a one-time code. You approve it on github.com yourself.</p><p><button data-gh="start">🐙 Sign Jena into GitHub</button></p>`;
    return `<div class="dp-card" id="sec-gh"><h3>🐙 GitHub CLI on her desktop</h3>${body}${G.out ? `<p><small>${esc(G.out)}</small></p>` : ''}</div>`;
  },
  async click(e, rerender) {
    const b = e.target.closest?.('[data-gh]');
    if (!b) return false;
    const a = b.dataset.gh;
    if (a === 'start') { G.out = 'asking GitHub for a code…'; rerender(); const d = await api('/api/ghauth', { op: 'start' }); G.st = d; G.out = d.ok ? '' : ''; rerender(); ghPoll(); return true; }
    if (a === 'cancel') { const d = await api('/api/ghauth', { op: 'cancel' }); G.st = { ok: true, state: 'idle', signed_in: false }; G.out = d.ok ? 'cancelled' : d.error; rerender(); return true; }
    if (a === 'copy') { try { await navigator.clipboard.writeText(G.st.code); G.out = 'code copied'; } catch { G.out = 'copy it by hand'; } rerender(); return true; }
    return false;
  },
});
