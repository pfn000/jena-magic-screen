// Update banner: the page asks /api/version every 30 s which commit is live. When it changes, a small banner says
// "✨ Jena just got an update, refreshing in 10s" with "now" and "later". The reload never happens while mama is
// typing, recording a voice note, in a desktop takeover or in a private sign-in window: the countdown pauses and
// resumes once she's done. ?obs=1 gets only a small quiet badge (OBS reloads on its own schedule).
// Also: a "🧠 brain restarting…" pill while her brain's health check blips offline after being online.
import { softReloadTo } from './refresh.js';

const POLL_MS = 30000, COUNT_S = 10, LATER_MS = 10 * 60000;
const mine = (typeof __COMMIT__ !== 'undefined' && __COMMIT__) || '';

// Anything that a reload would break. Each check reads what the other modules put in the page.
export function busyReason() {
  const a = document.activeElement;
  if (a && (/INPUT|TEXTAREA/.test(a.tagName) || a.isContentEditable) && a.type !== 'button') {
    if (a.value || a.isContentEditable || a.tagName === 'TEXTAREA') return 'typing';
  }
  if ([...document.querySelectorAll('input:not([type=password]):not([type=file]):not([type=checkbox]):not([type=radio]), textarea')]
    .some((i) => i.value && i.offsetParent)) return 'typing';
  if (document.querySelector('.mic-status.rec:not([hidden]), .mic-status.busy:not([hidden])')) return 'recording';
  if (window.__jenaVoice?.recording || window.__jenaMic?.state === 'recording') return 'recording';
  if (document.getElementById('takeover')) return 'takeover';
  if (document.getElementById('signin-win')) return 'sign-in';
  // a live noVNC canvas mama can type into (not the view-only desktop stream) = she's in a private window or takeover
  if ([...document.querySelectorAll('canvas')].some((c) => c.closest('#signin-win, #takeover, .si-screen'))) return 'private window';
  if (window.__jenaDesktop?.takeover || window.__jenaSignin?.open) return 'private window';
  return '';
}

function css() {
  if (document.getElementById('upd-css')) return;
  const s = document.createElement('style'); s.id = 'upd-css';
  s.textContent = `#upd-bar{position:fixed;left:10px;right:10px;top:max(10px,env(safe-area-inset-top));margin:0 auto;z-index:100002;
  display:flex;align-items:center;gap:8px;max-width:460px;box-sizing:border-box;padding:9px 10px 9px 14px;border-radius:16px;
  background:rgba(29,27,46,.94);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid #b48cff;color:#fff;
  font:600 14px/1.25 system-ui,-apple-system,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);animation:updIn .35s ease-out}
  #upd-bar .t{flex:1;min-width:0}#upd-bar small{display:block;font-weight:500;opacity:.75;font-size:11.5px}
  #upd-bar button{flex:none;white-space:nowrap;border:0;border-radius:11px;padding:7px 12px;font:700 13px system-ui,sans-serif;cursor:pointer}
  #upd-bar .now{background:#b48cff;color:#1d1b2e}#upd-bar .later{background:none;color:#fff;border:1px solid rgba(255,255,255,.5)}
  @keyframes updIn{from{opacity:0;translate:0 -10px}to{opacity:1;translate:0 0}}
  #upd-badge{position:fixed;right:8px;bottom:8px;z-index:100002;padding:3px 8px;border-radius:9px;background:rgba(0,0,0,.45);color:#cdb8ff;
  font:600 11px system-ui,sans-serif;pointer-events:none}
  #brain-pill{position:fixed;left:50%;top:calc(max(10px,env(safe-area-inset-top)) + 64px);transform:translateX(-50%);z-index:100002;padding:6px 12px;
  border-radius:999px;background:rgba(29,27,46,.92);border:1px solid #ffcf6e;color:#ffe9b8;font:600 13px system-ui,sans-serif;
  box-shadow:0 4px 16px rgba(0,0,0,.4);animation:updIn .3s ease-out}
  #brain-pill.obs{top:8px;left:auto;right:8px;transform:none;font-size:11px;padding:3px 8px;box-shadow:none;animation:none}`;
  document.head.appendChild(s);
}

export function startUpdates({ obs = false } = {}) {
  css();
  let live = null, dismissedFor = null, laterUntil = 0, bar = null, left = COUNT_S, tick = null;

  const check = async () => {
    const v = await fetch('/api/version', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const sha = v?.sha;
    if (!sha) return;
    if (!mine) { live = live || sha; if (sha === live) return; } // local/preview builds: compare against first seen
    else if (sha === mine) return;
    if (sha !== live) { live = sha; dismissedFor = null; }
    show();
  };

  const show = () => {
    if (obs) {
      if (!document.getElementById('upd-badge')) {
        const b = document.createElement('div'); b.id = 'upd-badge'; b.textContent = `✨ update ready · ${live.slice(0, 7)}`;
        document.body.appendChild(b);
      }
      return;
    }
    if (bar || dismissedFor === live || Date.now() < laterUntil) return;
    bar = document.createElement('div'); bar.id = 'upd-bar'; bar.setAttribute('role', 'status');
    bar.innerHTML = '<span class="t"><span class="msg"></span><small class="sub"></small></span><button class="now">now</button><button class="later">later</button>';
    document.body.appendChild(bar);
    left = COUNT_S;
    bar.querySelector('.now').onclick = () => go(true);
    bar.querySelector('.later').onclick = () => { dismissedFor = live; laterUntil = Date.now() + LATER_MS; hide(); };
    render();
    tick = setInterval(() => {
      const why = busyReason();
      if (!why && left > 0) left -= 1;
      render(why);
      if (left <= 0 && !why) go(false);
    }, 1000);
  };

  const render = (why = busyReason()) => {
    if (!bar) return;
    bar.querySelector('.msg').textContent = why ? '✨ Jena just got an update' : `✨ Jena just got an update, refreshing in ${left}s`;
    bar.querySelector('.sub').textContent = why ? `waiting till you're done (${why}) · nothing gets lost` : 'your chat stays put';
  };
  const hide = () => { clearInterval(tick); tick = null; bar?.remove(); bar = null; };
  const go = (forced) => {
    if (!forced && busyReason()) return;
    hide();
    softReloadTo(live);
  };

  setTimeout(check, 4000);
  setInterval(() => { if (!document.hidden || !bar) check(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });

  // brain restarting pill: her health goes online -> offline (a blip), pill stays until it's back
  let wasOnline = null, pill = null, pillTimer = null;
  window.addEventListener('jena-health', (e) => {
    const on = !!e.detail?.online;
    if (wasOnline && !on && !pill) {
      pill = document.createElement('div'); pill.id = 'brain-pill'; if (obs) pill.className = 'obs';
      pill.textContent = '🧠 brain restarting…';
      document.body.appendChild(pill);
      clearTimeout(pillTimer); pillTimer = setTimeout(() => { if (pill) pill.textContent = '🧠 brain is taking a nap, messages get queued'; }, 90000);
    }
    if (on && pill) { clearTimeout(pillTimer); pill.textContent = '🧠 back!'; const p = pill; pill = null; setTimeout(() => p.remove(), 1800); }
    wasOnline = on;
  });

  window.__jenaUpdates = { get live() { return live; }, mine, check, busyReason, demo: (sha = 'f00dfacecafe') => { live = sha; dismissedFor = null; laterUntil = 0; show(); } };
}
