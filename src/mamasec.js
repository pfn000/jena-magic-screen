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
