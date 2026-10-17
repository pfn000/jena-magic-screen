// Mama's takeover screen. One module for every way mama drives Jena's real desktop (:99):
//  * double-click (or double-tap) on the desktop panel -> 60 min, Jena's own hands/autonomy paused meanwhile;
//  * the dev panel's "take over" button; a sign-in ask (signin.js mounts the same screen inside its window).
// What it fixes / adds (Saidie, Oct 13):
//  * iPhone keyboard: typing goes through a hidden, focused textarea that always holds a sentinel character, so
//    Backspace ALWAYS produces an input event (iOS sends nothing for Backspace in an empty field). beforeinput:
//    deleteContentBackward -> BackSpace, insertText -> the characters, insertLineBreak -> Return. Plus a key row:
//    ⌫ ⏎ Tab Esc ← ↑ ↓ → Ctrl (sticky).
//  * Cursor: noVNC 1.7 treats ANY touch-capable device (iPhone, and Windows laptops with a touchscreen) as "no CSS
//    cursors": it sets the canvas to cursor:none and draws its cursor on its own <canvas> appended to <body> at
//    z-index 65535 — underneath our takeover window (z-index 100001+), so the cursor was invisible. Now our own
//    cursor is drawn inside the takeover screen at the pointer (mouse) / last tap (touch) position, and on a mouse
//    device the normal arrow is forced back on over the picture.
//  * Phone mode: from a phone-size screen the box turns :99 portrait (same shape as the phone, 704 tall) and back
//    to 1600x704 when mama is done; the public/OBS view holds its last frame meanwhile (box: jena_takeover.py).
//    Touch maps 1:1: tap = click, swipe = scroll, long-press = right-click, a swipe from the bottom edge (or ✋ drag
//    mode) = a mouse drag. Two fingers pinch-zoom / pan (any mode).
// Mama never sees a lock card, a censor or "private" text here: this is her raw desktop.
import RFB from '@novnc/novnc';

const XK = { BackSpace: 0xff08, Tab: 0xff09, Return: 0xff0d, Escape: 0xff1b, Home: 0xff50, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, End: 0xff57, Delete: 0xffff, Control_L: 0xffe3 };
const CODE = { BackSpace: 'Backspace', Tab: 'Tab', Return: 'Enter', Escape: 'Escape', Home: 'Home', Left: 'ArrowLeft', Up: 'ArrowUp', Right: 'ArrowRight', Down: 'ArrowDown', End: 'End', Delete: 'Delete', Control_L: 'ControlLeft' };
const SENTINEL = '\u200b\u200b\u200b\u200b';   // invisible; Backspace always has something to delete
const KEY = 'jena.dmKey';
export const isTouch = () => matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
// "phone-size": a narrow portrait screen (an iPhone, or a desktop browser squeezed to phone size). ?phone=0/1 overrides.
export function isPhoneView() {
  const q = new URLSearchParams(location.search).get('phone');
  if (q === '1') return true; if (q === '0') return false;
  const w = window.visualViewport?.width || innerWidth, h = window.visualViewport?.height || innerHeight;
  return w <= 600 && h > w * 1.2;
}

const CSS = `
.tk-stage{position:relative;flex:1;min-height:0;overflow:hidden;background:#000;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.tk-zoom{position:absolute;inset:0;transform-origin:0 0;will-change:transform}
.tk-screen{position:absolute;inset:0}
.tk-fine .tk-screen canvas{cursor:default!important}
.tk-cursor{position:absolute;left:0;top:0;width:22px;height:22px;pointer-events:none;z-index:6;transform:translate(-100px,-100px);filter:drop-shadow(0 0 1.5px #000) drop-shadow(0 0 3px rgba(255,122,217,.9));transition:opacity .2s}
.tk-cursor.tk-tap::after{content:"";position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid #ff7ad9;animation:tkping .45s ease-out forwards}
@keyframes tkping{from{transform:scale(.4);opacity:1}to{transform:scale(1.3);opacity:0}}
.tk-keys{display:flex;gap:5px;padding:6px 6px calc(6px + env(safe-area-inset-bottom));background:#1d1b2e;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;flex:none}
.tk-keys::-webkit-scrollbar{display:none}
.tk-keys button{flex:none;min-width:40px;height:36px;padding:0 9px;border-radius:9px;border:1px solid #4a4466;background:#2b2840;color:#fff;font:600 15px system-ui,sans-serif;touch-action:manipulation}
.tk-keys button.on{background:#b48cff;color:#1d1b2e;border-color:#b48cff}
.tk-keys button:active{background:#4a4466}
.tk-kbin{position:absolute;left:0;bottom:0;width:1px;height:1px;opacity:0;border:0;padding:0;font-size:16px;resize:none;color:transparent;background:transparent;caret-color:transparent}
#mama-takeover{position:fixed;inset:0;z-index:100002;background:#0e0d16;color:#fff;display:flex;flex-direction:column;font:14px system-ui,sans-serif;height:100dvh}
#mama-takeover header{display:flex;align-items:center;gap:6px;padding:6px 8px;padding-top:max(6px,env(safe-area-inset-top));background:#1d1b2e;border-bottom:1px solid #b48cff;flex:none}
#mama-takeover header b{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
#mama-takeover header .tk-st{font-size:12px;opacity:.85;white-space:nowrap;font-variant-numeric:tabular-nums}
#mama-takeover header button{padding:6px 10px;border-radius:9px;border:1px solid #fff;background:none;color:#fff;font:600 13px system-ui;white-space:nowrap}
#mama-takeover header .tk-done{border:0;background:#38c172;color:#06200f}
`;
function css() { if (!document.getElementById('tk-css')) { const s = document.createElement('style'); s.id = 'tk-css'; s.textContent = CSS; document.head.appendChild(s); } }
const CURSOR_SVG = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M2 1 L2 18 L6.5 13.8 L9.6 20.6 L12.6 19.3 L9.6 12.6 L15.6 12.6 Z" fill="#fff" stroke="#1d1b2e" stroke-width="1.6" stroke-linejoin="round"/></svg>';

// Mount a live takeover screen into `host` (a flex column). -> { rfb, showKeyboard(), destroy(), state }
export function mountTakeover(host, { ws, protocol, onState = () => {}, keys = true } = {}) {
  css();
  const touch = isTouch();
  host.classList.add('tk-host'); if (!touch) host.classList.add('tk-fine');
  host.style.display = 'flex'; host.style.flexDirection = 'column';
  host.innerHTML = `<div class="tk-stage"><div class="tk-zoom"><div class="tk-screen"></div></div><div class="tk-cursor">${CURSOR_SVG}</div>
    <textarea class="tk-kbin" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="enter" aria-label="type on Jena's desktop"></textarea></div>
    ${keys ? `<div class="tk-keys">
      <button data-k="kb" title="keyboard">⌨️</button><button data-k="BackSpace" title="backspace">⌫</button><button data-k="Return" title="enter">⏎</button>
      <button data-k="Tab">Tab</button><button data-k="Escape">Esc</button><button data-k="Left">←</button><button data-k="Up">↑</button><button data-k="Down">↓</button><button data-k="Right">→</button>
      <button data-k="ctrl" title="Ctrl: sticks for the next key">Ctrl</button><button data-k="drag" title="drag mode: one finger drags (move windows, select)">✋</button><button data-k="zoom" title="reset zoom">1:1</button></div>` : ''}`;
  const stage = host.querySelector('.tk-stage'), zoomEl = host.querySelector('.tk-zoom'), screen = host.querySelector('.tk-screen');
  const cur = host.querySelector('.tk-cursor'), kb = host.querySelector('.tk-kbin');
  const st = { connected: false, ctrl: false, drag: false, z: 1, tx: 0, ty: 0, fx: null, fy: null, sent: [] };
  const rfb = new RFB(screen, ws, { shared: true, wsProtocols: protocol ? [protocol, 'binary'] : ['binary'] });
  rfb.viewOnly = false; rfb.scaleViewport = true; rfb.clipViewport = false; rfb.resizeSession = false;
  rfb.focusOnClick = !touch; rfb.showDotCursor = false; rfb.background = '#000';
  const hideNoVncCursor = () => document.querySelectorAll('body > canvas').forEach((c) => { if (c.style.zIndex === '65535') c.style.setProperty('display', 'none', 'important'); });
  rfb.addEventListener('connect', () => { st.connected = true; hideNoVncCursor(); onState('connected'); if (!touch) rfb.focus(); });
  rfb.addEventListener('disconnect', (ev) => { st.connected = false; onState(ev.detail?.clean ? 'closed' : 'dropped'); });
  rfb.addEventListener('desktopname', () => hideNoVncCursor());

  const canvas = () => screen.querySelector('canvas');
  const fb = () => ({ w: rfb._fbWidth || canvas()?.width || 1, h: rfb._fbHeight || canvas()?.height || 1 });
  // client point -> framebuffer pixel, and back (works with the pinch-zoom transform: the canvas rect includes it)
  const toFb = (cx, cy) => { const c = canvas(); if (!c) return null; const r = c.getBoundingClientRect(), f = fb(); return { x: Math.max(0, Math.min(f.w - 1, (cx - r.left) * f.w / r.width)), y: Math.max(0, Math.min(f.h - 1, (cy - r.top) * f.h / r.height)) }; };
  const drawCursor = (tap) => {
    const c = canvas(); if (!c || st.fx == null) return;
    const r = c.getBoundingClientRect(), s = stage.getBoundingClientRect(), f = fb();
    const x = r.left - s.left + st.fx * r.width / f.w, y = r.top - s.top + st.fy * r.height / f.h;
    cur.style.transform = `translate(${x - 2}px,${y - 1}px)`;
    if (tap) { cur.classList.remove('tk-tap'); void cur.offsetWidth; cur.classList.add('tk-tap'); }
  };
  // a pointer event in framebuffer pixels -> noVNC (element coords before its own scale)
  const send = (fx, fy, mask) => {
    const c = canvas(); if (!c || !st.connected) return;
    const r = c.getBoundingClientRect(), f = fb();
    const ex = fx * (r.width / f.w) / st.z, ey = fy * (r.height / f.h) / st.z;   // = element px at zoom 1
    rfb._sendMouse(ex, ey, mask);
    st.fx = fx; st.fy = fy; drawCursor(false);
    st.sent.push([Math.round(fx), Math.round(fy), mask]); if (st.sent.length > 40) st.sent.shift();
  };
  const click = (p, btn = 1) => { send(p.x, p.y, 0); send(p.x, p.y, btn); setTimeout(() => send(p.x, p.y, 0), 40); drawCursor(true); };

  // ---- mouse (laptop): noVNC drives it; we only follow it with our cursor
  stage.addEventListener('mousemove', (e) => { const p = toFb(e.clientX, e.clientY); if (p) { st.fx = p.x; st.fy = p.y; drawCursor(false); } }, { capture: true, passive: true });
  stage.addEventListener('mousedown', () => drawCursor(true), { capture: true, passive: true });
  new ResizeObserver(() => drawCursor(false)).observe(stage);

  // ---- touch: our own mapping (noVNC's touch gestures never see these events)
  const T = { mode: null, t0: 0, x0: 0, y0: 0, p0: null, lp: null, acc: 0, pinch: null };
  const applyZoom = () => { zoomEl.style.transform = `translate(${st.tx}px,${st.ty}px) scale(${st.z})`; drawCursor(false); };
  const resetZoom = () => { st.z = 1; st.tx = 0; st.ty = 0; applyZoom(); };
  const stop = (e) => { e.stopPropagation(); if (e.cancelable) e.preventDefault(); };
  stage.addEventListener('touchstart', (e) => {
    stop(e);
    if (e.target === kb) return;
    clearTimeout(T.lp);
    if (e.touches.length >= 2) {   // pinch / pan the view
      if (T.mode === 'drag' && T.p0) send(st.fx, st.fy, 0);
      const [a, b] = e.touches; const s = stage.getBoundingClientRect();
      T.mode = 'pinch';
      T.pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), mx: (a.clientX + b.clientX) / 2 - s.left, my: (a.clientY + b.clientY) / 2 - s.top, z: st.z, tx: st.tx, ty: st.ty };
      return;
    }
    const t = e.touches[0];
    Object.assign(T, { mode: null, t0: Date.now(), x0: t.clientX, y0: t.clientY, p0: toFb(t.clientX, t.clientY), acc: 0 });
    if (!T.p0) return;
    send(T.p0.x, T.p0.y, 0);
    T.lp = setTimeout(() => { if (T.mode === null) { T.mode = 'long'; click(T.p0, 4); navigator.vibrate?.(15); } }, 550);   // long-press = right-click (mask bit 3 = button 3)
  }, { capture: true, passive: false });
  stage.addEventListener('touchmove', (e) => {
    stop(e);
    if (T.mode === 'pinch' && e.touches.length >= 2) {
      const [a, b] = e.touches; const s = stage.getBoundingClientRect(), P = T.pinch;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const mx = (a.clientX + b.clientX) / 2 - s.left, my = (a.clientY + b.clientY) / 2 - s.top;
      const z = Math.max(1, Math.min(5, P.z * d / P.d));
      st.tx = mx - (P.mx - P.tx) * (z / P.z); st.ty = my - (P.my - P.ty) * (z / P.z); st.z = z;
      const W = s.width, H = s.height;   // keep the picture on screen
      st.tx = Math.min(0, Math.max(W - W * z, st.tx)); st.ty = Math.min(0, Math.max(H - H * z, st.ty));
      applyZoom(); return;
    }
    const t = e.touches[0]; if (!t || !T.p0) return;
    const dx = t.clientX - T.x0, dy = t.clientY - T.y0;
    if (T.mode === null && Math.hypot(dx, dy) > 9) {
      clearTimeout(T.lp);
      const f = fb(), edge = T.p0.y > f.h * 0.93;
      T.mode = (st.drag || edge) ? 'drag' : 'scroll';
      if (T.mode === 'drag') send(T.p0.x, T.p0.y, 1);
      T.ly = t.clientY;
    }
    if (T.mode === 'drag') { const p = toFb(t.clientX, t.clientY); if (p) send(p.x, p.y, 1); }
    else if (T.mode === 'scroll') {
      T.acc += t.clientY - T.ly; T.ly = t.clientY;
      const step = 28;
      while (Math.abs(T.acc) >= step) {   // finger up = page moves up = wheel down (button 5); down = wheel up (4)
        const m = T.acc < 0 ? 16 : 8;
        send(T.p0.x, T.p0.y, m); send(T.p0.x, T.p0.y, 0);
        T.acc += T.acc < 0 ? step : -step;
      }
    }
  }, { capture: true, passive: false });
  const touchEnd = (e) => {
    stop(e);
    clearTimeout(T.lp);
    if (T.mode === 'pinch') { if (e.touches.length === 0) { if (st.z < 1.05) resetZoom(); T.mode = 'done'; } return; }
    if (T.mode === 'drag') { send(st.fx, st.fy, 0); }
    else if (T.mode === null && T.p0 && Date.now() - T.t0 < 550) { click(T.p0, 1); }
    T.mode = 'done';
  };
  stage.addEventListener('touchend', touchEnd, { capture: true, passive: false });
  stage.addEventListener('touchcancel', touchEnd, { capture: true, passive: false });
  // ctrl/⌘ + wheel on a laptop zooms the view too (the "fullscreen with zoom" for non-phone use)
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    stop(e);
    const s = stage.getBoundingClientRect(), mx = e.clientX - s.left, my = e.clientY - s.top, z0 = st.z;
    const z = Math.max(1, Math.min(5, z0 * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    st.tx = Math.min(0, Math.max(s.width - s.width * z, mx - (mx - st.tx) * z / z0)); st.ty = Math.min(0, Math.max(s.height - s.height * z, my - (my - st.ty) * z / z0)); st.z = z;
    applyZoom();
  }, { capture: true, passive: false });

  // ---- keyboard: hidden textarea with a sentinel (iPhone / Android / iPad)
  const keysym = (ch) => { const c = ch.codePointAt(0); return c < 0x100 ? c : 0x01000000 + c; };
  const tapKey = (name) => {
    if (!st.connected) return;
    if (st.ctrl) rfb.sendKey(XK.Control_L, 'ControlLeft', true);
    rfb.sendKey(XK[name], CODE[name]);
    if (st.ctrl) { rfb.sendKey(XK.Control_L, 'ControlLeft', false); setCtrl(false); }
  };
  const typeText = (txt) => {
    if (!st.connected) return;
    for (const ch of String(txt || '')) {
      if (ch === '\n') { tapKey('Return'); continue; }
      if (ch === '\u200b') continue;
      if (st.ctrl) { rfb.sendKey(XK.Control_L, 'ControlLeft', true); rfb.sendKey(keysym(ch.toLowerCase()), null); rfb.sendKey(XK.Control_L, 'ControlLeft', false); setCtrl(false); }
      else rfb.sendKey(keysym(ch), null);
    }
  };
  const resetKb = () => { kb.value = SENTINEL; try { kb.setSelectionRange(SENTINEL.length, SENTINEL.length); } catch {} };
  resetKb();
  let composing = false;
  kb.addEventListener('compositionstart', () => { composing = true; });
  kb.addEventListener('compositionend', (e) => { composing = false; typeText(e.data); resetKb(); });
  kb.addEventListener('beforeinput', (e) => {
    if (composing || e.inputType === 'insertCompositionText') return;   // committed at compositionend
    const t = e.inputType;
    if (t.startsWith('deleteContentBackward') || t === 'deleteWordBackward' || t === 'deleteSoftLineBackward' || t === 'deleteHardLineBackward') {
      e.preventDefault();
      if (t === 'deleteWordBackward') { rfb.sendKey(XK.Control_L, 'ControlLeft', true); rfb.sendKey(XK.BackSpace, 'Backspace'); rfb.sendKey(XK.Control_L, 'ControlLeft', false); }
      else tapKey('BackSpace');
    } else if (t.startsWith('deleteContentForward') || t === 'deleteWordForward') { e.preventDefault(); tapKey('Delete'); }
    else if (t === 'insertLineBreak' || t === 'insertParagraph') { e.preventDefault(); tapKey('Return'); }
    else if (t.startsWith('insert')) { e.preventDefault(); typeText(e.data ?? e.dataTransfer?.getData('text/plain') ?? ''); }
    else return;
    resetKb();
  });
  // fallback for keyboards whose beforeinput can't be cancelled: diff against the sentinel
  kb.addEventListener('input', () => {
    if (composing) return;
    const v = kb.value;
    if (v === SENTINEL) return;
    if (v.startsWith(SENTINEL)) typeText(v.slice(SENTINEL.length));
    else if (SENTINEL.startsWith(v)) for (let i = v.length; i < SENTINEL.length; i++) tapKey('BackSpace');
    else typeText(v.replace(/\u200b/g, ''));
    resetKb();
  });
  // hardware keys on the textarea (iPad keyboard, a laptop typing into it): non-text keys + ctrl combos
  const HW = { Escape: 'Escape', Tab: 'Tab', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Home: 'Home', End: 'End' };
  kb.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (HW[e.key]) { e.preventDefault(); tapKey(HW[e.key]); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.length === 1) { e.preventDefault(); rfb.sendKey(XK.Control_L, 'ControlLeft', true); rfb.sendKey(keysym(e.key.toLowerCase()), null); rfb.sendKey(XK.Control_L, 'ControlLeft', false); }
  });
  const showKeyboard = () => { resetKb(); kb.focus({ preventScroll: true }); };
  // tapping the picture on a phone also brings the keyboard back if it was open
  let kbOpen = false;
  kb.addEventListener('focus', () => { kbOpen = true; }); kb.addEventListener('blur', () => { kbOpen = false; });
  stage.addEventListener('touchend', () => { if (kbOpen) setTimeout(() => kb.focus({ preventScroll: true }), 0); }, { passive: true });

  // ---- key row
  const row = host.querySelector('.tk-keys');
  const setCtrl = (on) => { st.ctrl = on; row?.querySelector('[data-k="ctrl"]')?.classList.toggle('on', on); };
  row?.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });   // keep the keyboard up
  row?.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const k = b.dataset.k;
    if (k === 'kb') { if (kbOpen) kb.blur(); else showKeyboard(); return; }
    if (k === 'ctrl') { setCtrl(!st.ctrl); return; }
    if (k === 'drag') { st.drag = !st.drag; b.classList.toggle('on', st.drag); return; }
    if (k === 'zoom') { resetZoom(); return; }
    tapKey(k);
    if (!touch) rfb.focus();
  });

  return {
    rfb, state: st, showKeyboard, typeText, tapKey, toFb, click, send, resetZoom,
    destroy() { try { rfb.disconnect(); } catch {} host.innerHTML = ''; },
  };
}

// ---------------------------------------------------------------- the full-screen takeover window
const headers = () => ({ 'Content-Type': 'application/json', 'X-Jena-Key': localStorage.getItem(KEY) || '' });
async function mama(body) {
  return fetch('/api/mama', { method: 'POST', headers: headers(), credentials: 'same-origin', body: JSON.stringify({ action: 'takeover', ...body }) })
    .then(async (x) => { const t = await x.text(); try { return { status: x.status, ...JSON.parse(t) }; } catch { return { ok: false, retry: true, summary: 'her box is reconnecting' }; } })
    .catch(() => ({ ok: false, retry: true, summary: 'her box is reconnecting' }));
}
// mama's trusted device lives in an HttpOnly cookie too: when the saved key is gone, ask the site to hand it back.
// true = this device is mama's again (nothing typed). Only an explicit 'lock' in the private drawer keeps it locked.
export async function restoreTrust() {
  try { if (sessionStorage.getItem('jena.locked') === '1') return false; } catch {}
  const r = await fetch('/api/trust', { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
  const d = r && r.ok ? await r.json().catch(() => null) : null;
  if (d?.trusted && d.token) { try { localStorage.setItem(KEY, d.token); } catch {} return true; }
  return false;
}
// a one-use token for her full-control desktop; her tunnel can be mid-restart (HTML answer): 3 tries over ~8 s
export async function takeoverToken(extra = {}) {
  let last = null;
  const body = { source: 'takeover', ...extra };
  if (body.phone === undefined && isPhoneView()) {   // the stage size the picture will get (minus header + key row)
    const vv = window.visualViewport; body.phone = { w: Math.round(vv?.width || innerWidth), h: Math.round((vv?.height || innerHeight) - 96) };
  }
  let restored = false;
  for (let i = 0; i < 3; i++) {
    const r = await mama(body);
    if (r.ok && r.ws) return r;
    if (r.status === 401 || r.error === 'wrong key') {
      // a trusted device whose saved key went missing (iPhone Safari can drop localStorage): the cookie puts it back, no prompt
      if (!restored && (restored = true) && await restoreTrust()) { i--; continue; }
      return { ok: false, auth: true, summary: 'mama sign-in needed' };
    }
    last = r;
    await new Promise((res) => setTimeout(res, 1500 + i * 2000));
  }
  return { ok: false, summary: (last && (last.summary || last.error)) || 'her box did not answer' };
}
export const takeoverDone = () => mama({ op: 'end' });

export function openTakeover({ source = 'takeover', title } = {}) {
  css();
  document.getElementById('mama-takeover')?.remove();
  const w = document.createElement('section');
  w.id = 'mama-takeover';
  w.innerHTML = `<header><b>🖐 ${title || "you have Jena's desk · it's yours until you press Done"}</b>
    <span class="tk-st">connecting…</span>
    ${document.fullscreenEnabled ? '<button class="tk-fs" title="fullscreen">⛶</button>' : ''}<button class="tk-done">✓ Done</button></header><div class="tk-body" style="flex:1;min-height:0"></div>`;
  document.body.appendChild(w);
  const st = w.querySelector('.tk-st'), body = w.querySelector('.tk-body');
  let ctl = null, closed = false, tries = 0, authTried = false;   // infinite hold: no countdown, only ✓ Done ends it
  const phone = isPhoneView();
  w.dataset.phone = phone ? '1' : '0';
  const tick = () => {
    if (!ctl?.state.connected) return;
    st.textContent = phone ? 'connected · phone mode' : 'connected';
  };
  const timer = setInterval(tick, 1000);
  const retry = () => { if (!closed) setTimeout(connect, Math.min(30000, 1500 * 2 ** Math.min(tries++, 5))); };   // retry forever: 1.5 s, 3, 6, 12, 24, then every 30 s
  const connect = async () => {
    st.textContent = tries ? 'reconnecting…' : 'connecting…';
    const r = await takeoverToken({ source, infinite: true });
    if (closed) return;
    if (!r.ok && r.auth && !authTried) {   // key missing in this tab: the one trusted check (cookie / Face ID), then straight back in
      authTried = true;
      const k = await window.jenaTrust?.ensureMama?.('Taking over her desktop');
      if (k && !closed) return connect();
    }
    if (!r.ok) { st.textContent = r.auth ? 'signed out · sign in again to keep her desk' : (r.summary || 'could not connect'); if (!r.auth) retry(); return; }
    if (r.phone) w.dataset.portrait = r.phone.join('x');
    ctl?.destroy();
    ctl = mountTakeover(body, { ws: r.ws, protocol: r.protocol, onState: (s) => {
      if (s === 'connected') { tries = 0; tick(); }
      else if (!closed && (s === 'dropped' || s === 'closed')) { st.textContent = 'reconnecting…'; retry(); }   // any disconnect not from ✓ Done (phone slept, tunnel blip, clean server close): back in, same session, never gives up
      else if (!closed) st.textContent = 'disconnected';
    } });
    w.ctl = ctl;
  };
  const finish = async () => {
    if (closed) return; closed = true; clearInterval(timer);
    st.textContent = 'giving it back…';
    try { ctl?.rfb.disconnect(); } catch {}
    const r = await takeoverDone();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    body.innerHTML = `<p style="padding:24px;line-height:1.5">✓ Jena has her desktop back. Everything you changed stays as you left it${r?.summary && r.summary !== 'ended' ? `, and she got a note about it:<br><small style="opacity:.8">${String(r.summary).replace(/[&<>]/g, '')}</small>` : '.'}</p>`;
    setTimeout(() => w.remove(), 4500);
  };
  w.querySelector('.tk-done').onclick = finish;
  w.querySelector('.tk-fs')?.addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else w.requestFullscreen?.().catch(() => {}); });
  connect();
  return w;
}
