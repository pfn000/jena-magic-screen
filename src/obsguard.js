// Stream safety for the OBS view (?obs=1). Saidie, 2026-10-13: "even if the website refreshes or the website
// updates in its back ends, the stream won't stop." So on this page:
//  * a new deploy never reloads it and never shows a banner (src/updates.js). It changes only when mama presses
//    "📺 reload OBS view" in her dev panel: that marks a time on her box (/box/tab-live/obs-reload, mama only), and
//    this page, which polls the public /api/tablive?what=obs every 20 s, reloads once when it sees a newer mark;
//  * the last good site config (box address, desktop stream) is kept in localStorage by src/config.js, so a
//    backend that is down, slow or changed at load time still gets a full page (STREAM_SAFETY.md).
const POLL_MS = 20000;
export function obsGuard() {
  let base = null, fails = 0;
  const tick = async () => {
    let d = null;
    try { const r = await fetch('/api/tablive?what=obs', { cache: 'no-store', signal: AbortSignal.timeout(6000) }); if (r.ok) d = await r.json(); } catch {}
    const at = +(d && d.reload_at) || 0;
    if (d) fails = 0; else fails++;
    if (base === null) { if (d) base = at; }
    else if (at > base) { base = at; try { sessionStorage.setItem('jena.obsReloadAt', String(at)); } catch {} location.reload(); return; }
    setTimeout(tick, d ? POLL_MS : Math.min(120000, POLL_MS * (1 + fails)));
  };
  // a page that came up from a reload request starts from that mark, so it can't loop
  try { const s = +sessionStorage.getItem('jena.obsReloadAt'); if (s) base = s; } catch {}
  setTimeout(tick, 3000);
  window.__jenaObsGuard = { get base() { return base; } };
}

// mama's dev panel button: mark "reload now" on her box; every open OBS view picks it up within ~20 s
export async function requestObsReload(btn) {
  const msg = btn?.parentElement?.querySelector('.dp-obs-msg');
  const say = (t) => { if (msg) msg.textContent = t; };
  say('asking her box…');
  try {
    const r = await fetch('/api/tablive?what=obs-reload', { method: 'POST', headers: { 'X-Jena-Key': localStorage.getItem('jena.dmKey') || '' }, cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    say(r.ok && d.ok ? 'done: the OBS view switches to the newest version within ~20 s' : `didn't go through: ${d.error || 'HTTP ' + r.status}`);
  } catch (e) { say(`didn't go through: ${e.message}`); }
}
