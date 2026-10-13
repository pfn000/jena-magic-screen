// Dev panel → "🔐 Mama: devices & keys" (mama only). This device's trust (forget it), mama's other trusted devices.
// More sections (passkeys, Accounts vault, GitHub sign-in) plug in below as they ship.
import { trust, forgetDevice } from './trust.js';

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
