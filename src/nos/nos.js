// N•OS liquid-glass window system for the site (Q-UI). Ported from the approved N•OS window demo
// (files/nos-window-demo, checker PASS): real WebGL2 refraction glass under every window, menu and popover,
// the top-right ARC (click = close, swipe down from the arc = close gesture), the PILL (swipe down = minimize, swipe up = maximize, tap = program info),
// the ••• on the top line (tap = File | Edit | View glass bar, hold = move), a hidden resize corner that
// jiggles when the window can't resize, and a soft shadow. Never runs in OBS / stream layouts; ?nos=0 turns it off.
// PHONE (Saidie 4:59 PM Oct 15): a full native mobile-app experience, not the desktop window squeezed onto a phone:
// no close button, no pill, no moving or resizing; only the ••• bar (tap = File | Edit | View). Laptop/tablet keep
// the window version. Windows stay locked inside the screen and never cover the phone's top bar or tab bar.
import './nos.css';

const R = 24;                      // uniform window corner radius (Saidie's spec)
const HOLD_MS = 350;               // ••• press-and-hold before the window moves
const SWIPE = 26;                  // px of pill travel that counts as a swipe
const CLOSE_PULL = 70;             // px of arc pull (any direction) that closes the window
const ARC_SWIPE = 34;              // px of downward swipe starting on the arc that closes the window (gesture)
const ARC_TAP = 8;                 // px of travel still counted as a click on the arc
const EDGE = 8;                    // a moved window stays this far inside the screen (locked in, never loose)
const MAXP = 14;                   // max panes per GL layer

export const NOS_ABOUT = [
  ['Model', 'NCOM Slate PRO'], ['Manufacture', 'NCOM Systems'], ['Legal', '\u00a9 2025 NCOM Systems'],
  ['Build Type', 'NCOM-Ouijaboard'], ['Build runner', 'OuijaBoard SDK'], ['OS', 'N\u2022OS'],
];
const APPS = {
  'avatar-panel': { title: 'Jena', about: 'Jena live: her avatar, her voice and her moves.' },
  desktop: { title: 'Virtual desktop', about: 'Jena\u2019s own computer screen, streamed live from her box.' },
  chat: { title: 'Chat', about: 'Talk to Jena. Stream chat shows here when she\u2019s live.' },
  thoughts: { title: 'Thought chain', about: 'Each step Jena thinks through before she answers.' },
  'body-panel': { title: 'Body', about: 'What Jena senses of her own body, live.' },
  'nos-about': { title: 'About N\u2022OS', about: 'The N\u2022OS window system by NCOM Systems.' },
};
const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => 1 - Math.pow(1 - t, 3);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isPhone = () => document.body.classList.contains('m-app');
const isMama = () => { try { return !!localStorage.getItem('jena.dmKey'); } catch { return false; } };

export function mountNOS({ obs = false } = {}) {
  const q = new URLSearchParams(location.search);
  if (obs || q.get('obs') === '1' || q.get('nos') === '0' || document.body.classList.contains('obs') || document.body.classList.contains('stream')) return null;
  if (window.__nos) return window.__nos;
  const body = document.body;
  body.classList.add('nos');
  let dark = q.get('glass') === 'dark' || (() => { try { return localStorage.getItem('nos.glass') === 'dark'; } catch { return false; } })();
  body.classList.toggle('nos-dark', dark);

  /* ---------------- GL layers ---------------- */
  const base = document.createElement('canvas'); base.id = 'nos-gl'; base.setAttribute('aria-hidden', 'true');
  const over = document.createElement('canvas'); over.id = 'nos-gl2'; over.setAttribute('aria-hidden', 'true');
  ($('#bg') || body.firstChild).after(base);
  body.append(over);
  const G1 = makeGL(base, false), G2 = makeGL(over, true);
  const gl = !!(G1 && G2);
  body.classList.toggle('nos-gl', gl);
  if (!gl) body.classList.add('nos-nogl');

  /* wallpaper: her room, cover-fit to the viewport (same picture #bg showed) */
  const wpImg = new Image(); let wpReady = false;
  wpImg.onload = () => { wpReady = true; paintWallpaper(); };
  wpImg.onerror = () => { wpReady = false; paintWallpaper(); };
  wpImg.src = '/bg-room.jpg';
  const wp = document.createElement('canvas');
  let VW = innerWidth, VH = innerHeight, DPR = Math.min(devicePixelRatio || 1, 2);
  function paintWallpaper() {
    const s = Math.min(1.25, 2048 / Math.max(VW, VH));
    const W = Math.max(2, Math.round(VW * s)), H = Math.max(2, Math.round(VH * s));
    wp.width = W; wp.height = H;
    const g = wp.getContext('2d');
    if (wpReady) {
      const k = Math.max(W / wpImg.naturalWidth, H / wpImg.naturalHeight);
      const w = wpImg.naturalWidth * k, h = wpImg.naturalHeight * k;
      g.drawImage(wpImg, (W - w) / 2, (H - h) / 2, w, h);
      g.fillStyle = 'rgba(240,225,255,0.16)'; g.fillRect(0, 0, W, H);
    } else {
      const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#ffd6ee'); gr.addColorStop(0.5, '#e6d6ff'); gr.addColorStop(1, '#ffe9d1');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }
    for (const G of [G1, G2]) if (G) G.upload(wp);
    dirty = true;
  }

  /* ---------------- windows ---------------- */
  const wins = new Map();   // el -> state
  let zTop = 30;
  const dock = document.createElement('nav'); dock.id = 'nos-dock'; dock.setAttribute('aria-label', 'Minimized and closed windows');
  body.append(dock);
  const toast = document.createElement('div'); toast.id = 'nos-toast'; toast.setAttribute('role', 'status'); body.append(toast);
  let toastT;
  const say = (t) => { toast.textContent = t; toast.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toast.classList.remove('show'), 1800); };

  function appFor(el) { return APPS[el.id] || { title: el.getAttribute('aria-label') || 'Window', about: '' }; }
  function attach(el) {
    if (wins.has(el)) return;
    el.classList.add('nos-win'); el.dataset.pillInfo = 'true';
    const ch = document.createElement('div'); ch.className = 'nos-chrome';
    ch.innerHTML = `<button type="button" class="nos-dots" aria-label="${esc(appFor(el).title)} menu (hold to move)"><i></i><i></i><i></i></button>
      <div class="nos-pill" role="button" tabindex="0" aria-label="Swipe down to minimize, swipe up to maximize, tap for window info"><i></i></div>
      <div class="nos-arc" role="button" tabindex="0" aria-label="Drag to close"><svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true"><path d="M16 7 A17 17 0 0 1 33 24"/></svg></div>
      <div class="nos-rz" aria-hidden="true"><svg viewBox="0 0 56 56"><path d="M50 20 V32 A18 18 0 0 1 32 50 H20"/></svg></div>
      <div class="nos-nope">this window can\u2019t resize</div>`;
    el.append(ch);
    const W = { el, ch, mode: 'normal', tx: 0, ty: 0, s: 1, op: 1, lift: 0, w: null, h: null, max: null, anim: null, top: false };
    wins.set(el, W);
    wireDots(W); wirePill(W); wireArc(W); wireResize(W);
    el.addEventListener('pointerdown', () => raise(W), true);
  }
  function scan() {
    for (const el of document.querySelectorAll('#stage > .panel, #avatar-panel, #nos-about')) attach(el);
    for (const [el, W] of wins) if (!el.isConnected) { wins.delete(el); renderDock(); }
  }
  function raise(W) { if (isPhone()) return; if (W.el.id === 'avatar-panel' && !W.max) return; W.el.style.zIndex = String(W.top ? 60 : ++zTop); }
  function apply(W) {
    const el = W.el;
    const t = (W.tx || W.ty || W.s !== 1) ? `translate(${W.tx}px, ${W.ty}px) scale(${W.s})` : '';
    el.style.transform = t;
    el.style.opacity = W.op >= 0.999 ? '' : String(W.op);
    el.style.visibility = W.op < 0.01 ? 'hidden' : '';
    // a window pulled out of its spot can overlap another one: frost what is under it (the GL glass is one layer)
    el.classList.toggle('nos-lifted', !!(W.max || Math.abs(W.tx) > 2 || Math.abs(W.ty) > 2 || W.w != null || el.id === 'nos-about'));
    if (W.max) Object.assign(el.style, { left: W.max.x + 'px', top: W.max.y + 'px', width: W.max.w + 'px', height: W.max.h + 'px' });
    else if (W.w != null) { el.style.width = W.w + 'px'; el.style.height = W.h + 'px'; }
    dirty = true;
  }
  function tween(W, to, ms = 420, done) {
    const from = {}; for (const k in to) from[k] = k === 'max' ? { ...W.max } : W[k];
    const t0 = performance.now(); W.anim = { done };
    const id = W.anim;
    const step = (now) => {
      if (W.anim !== id) return;
      const p = clamp((now - t0) / ms, 0, 1), e = ease(p);
      for (const k in to) {
        if (k === 'max') { const a = from.max, b = to.max; W.max = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, w: a.w + (b.w - a.w) * e, h: a.h + (b.h - a.h) * e }; }
        else W[k] = from[k] + (to[k] - from[k]) * e;
      }
      apply(W);
      if (p < 1) requestAnimationFrame(step); else { W.anim = null; done && done(); }
    };
    requestAnimationFrame(step);
  }
  function areaRect() {   // where a maximized window goes
    if (isPhone()) {
      const top = ($('#m-top')?.getBoundingClientRect().bottom || 56) + 10;
      const bot = ($('#m-tabs')?.getBoundingClientRect().top || VH) - 10;
      return { x: 10, y: top, w: VW - 20, h: bot - top };
    }
    return { x: 16, y: 16, w: VW - 32, h: VH - 32 };
  }
  function dockTarget(W) {
    const r = W.el.getBoundingClientRect(), d = dock.getBoundingClientRect();
    const cx = d.width ? d.left + d.width / 2 : VW / 2, cy = d.height ? d.top + d.height / 2 : VH - 60;
    return { x: cx - (r.left + r.width / 2) + W.tx, y: cy - (r.top + r.height / 2) + W.ty };
  }
  function syncMax() {   // a maximized window is the only thing on screen: the others step out of the way
    const any = [...wins.values()].some((X) => X.mode === 'max' || X.restoring);
    body.classList.toggle('nos-has-max', any);
    for (const X of wins.values()) X.el.classList.toggle('nos-under-max', any && X.mode !== 'max' && !X.restoring && X.el.id !== 'nos-about');
    dirty = true;
  }
  function maximize(W) {
    if (W.mode === 'max' || isPhone()) return;
    closeMenus();
    const r = W.el.getBoundingClientRect();
    W.home = { tx: W.tx, ty: W.ty };
    W.tx = 0; W.ty = 0;
    W.max = { x: r.left, y: r.top, w: r.width, h: r.height };
    W.el.classList.add('nos-max'); W.mode = 'max'; W.el.style.zIndex = '58';
    apply(W); syncMax();
    tween(W, { max: areaRect() }, 460);
    say(`${appFor(W.el).title}: maximized \u00b7 swipe the pill down to restore`);
  }
  function restore(W) {
    if (W.mode !== 'max') return;
    closeMenus();
    const el = W.el, cur = { ...W.max };
    // where it lives in the layout: measure with the inline frame removed, then animate back there
    el.classList.remove('nos-max'); Object.assign(el.style, { left: '', top: '', width: '', height: '' }); W.max = null;
    if (W.w != null) { el.style.width = W.w + 'px'; el.style.height = W.h + 'px'; }
    el.style.transform = '';
    const home = el.getBoundingClientRect();
    const tx = W.home?.tx || 0, ty = W.home?.ty || 0;
    el.classList.add('nos-max'); W.max = cur; W.mode = 'normal'; W.restoring = true; apply(W); syncMax();
    tween(W, { max: { x: home.left + tx, y: home.top + ty, w: home.width, h: home.height } }, 420, () => {
      el.classList.remove('nos-max'); W.max = null; Object.assign(el.style, { left: '', top: '', width: '', height: '' });
      W.tx = tx; W.ty = ty; W.restoring = false; apply(W); syncMax(); if (el.id !== 'nos-about') el.style.zIndex = '';
    });
  }
  function minimize(W, closed = false) {
    if (W.mode === 'min' || W.mode === 'closed' || isPhone()) return;
    closeMenus();
    if (W.mode === 'max') { // drop the maximized frame first so the window remembers its own spot
      W.el.classList.remove('nos-max'); Object.assign(W.el.style, { left: '', top: '', width: '', height: '' }); W.max = null;
      W.tx = W.home?.tx || 0; W.ty = W.home?.ty || 0; W.mode = 'normal'; apply(W); syncMax();
    }
    W.mode = closed ? 'closed' : 'min';
    W.saved = { tx: W.tx, ty: W.ty };
    renderDock();
    const d = closed ? { x: W.tx + 60, y: W.ty - 60 } : dockTarget(W);
    tween(W, { tx: d.x, ty: d.y, s: closed ? 0.6 : 0.16, op: 0 }, closed ? 300 : 460, () => { W.el.classList.add('nos-hidden'); dirty = true; });
    if (W.el.id === 'nos-about' && closed) setTimeout(() => { W.el.remove(); scan(); }, 340);
  }
  function reopen(W) {
    if (W.mode !== 'min' && W.mode !== 'closed') return;
    const back = W.saved || { tx: 0, ty: 0 };
    W.el.classList.remove('nos-hidden');
    const from = W.mode === 'min' ? dockTarget(W) : { x: back.tx, y: back.ty + 30 };
    W.tx = from.x; W.ty = from.y; W.s = W.mode === 'min' ? 0.16 : 0.85; W.op = 0; W.mode = 'normal'; apply(W);
    renderDock();
    tween(W, { tx: back.tx, ty: back.ty, s: 1, op: 1 }, 460);
    if (isPhone()) { const tab = W.el.id === 'body-panel' ? 'body' : W.el.id; const b = $(`#m-tabs [data-tab="${tab}"]`); if (b && !b.classList.contains('on')) b.click(); }
  }
  function renderDock() {
    const list = [...wins.values()].filter((W) => W.mode === 'min' || W.mode === 'closed');
    dock.innerHTML = '';
    for (const W of list) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'nos-chip';
      b.innerHTML = W.mode === 'closed' ? `<span>\u21ba</span> Reopen ${esc(appFor(W.el).title)}` : `<i></i> ${esc(appFor(W.el).title)}`;
      b.onclick = () => reopen(W);
      dock.append(b);
    }
    dock.classList.toggle('show', list.length > 0);
    dirty = true;
  }
  // phone: picking a tab brings that window back if it was closed or minimized
  document.addEventListener('click', (e) => {
    const t = e.target.closest?.('#m-tabs [data-tab]'); if (!t) return;
    const el = t.dataset.tab === 'body' ? $('#body-panel') : document.getElementById(t.dataset.tab);
    const W = el && wins.get(el); if (W && (W.mode === 'min' || W.mode === 'closed')) setTimeout(() => reopen(W), 0);
  });

  /* ---------------- pointer helpers ---------------- */
  function track(node, h) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      try { node.setPointerCapture(e.pointerId); } catch {}
      const st = { x0: e.clientX, y0: e.clientY, t0: performance.now(), id: e.pointerId, dx: 0, dy: 0 };
      h.down && h.down(st, e);
      const mv = (ev) => { if (ev.pointerId !== st.id) return; st.dx = ev.clientX - st.x0; st.dy = ev.clientY - st.y0; h.move && h.move(st, ev); };
      const up = (ev) => {
        if (ev.pointerId !== st.id) return;
        node.removeEventListener('pointermove', mv); node.removeEventListener('pointerup', up); node.removeEventListener('pointercancel', up);
        st.dx = ev.clientX - st.x0; st.dy = ev.clientY - st.y0; st.dt = performance.now() - st.t0;
        h.up && h.up(st, ev);
      };
      node.addEventListener('pointermove', mv); node.addEventListener('pointerup', up); node.addEventListener('pointercancel', up);
    });
  }

  /* keep a window fully inside the screen (or at least its top line, if it is bigger than the screen) */
  function lockIn(W) {
    if (W.mode !== 'normal' || W.max) return;
    const r = W.el.getBoundingClientRect();
    let dx = 0, dy = 0;
    if (r.width <= VW - 2 * EDGE) { if (r.left < EDGE) dx = EDGE - r.left; else if (r.right > VW - EDGE) dx = VW - EDGE - r.right; }
    else dx = EDGE - r.left;
    if (r.height <= VH - 2 * EDGE) { if (r.top < EDGE) dy = EDGE - r.top; else if (r.bottom > VH - EDGE) dy = VH - EDGE - r.bottom; }
    else dy = EDGE - r.top;
    if (dx || dy) { W.tx += dx; W.ty += dy; apply(W); }
  }

  /* ••• : tap = program menu bar, hold = move the window (laptop/tablet only; a phone app doesn't move) */
  function wireDots(W) {
    const dots = $('.nos-dots', W.ch);
    let holdT = null, moving = false, sx = 0, sy = 0;
    track(dots, {
      down(st) {
        moving = false; sx = W.tx; sy = W.ty; holdT = null;
        if (isPhone() || W.mode !== 'normal') return;
        holdT = setTimeout(() => { try { getSelection()?.removeAllRanges(); } catch {} moving = true; dots.classList.add('held'); closeMenus(); raise(W); W.lift = 1; dirty = true; }, HOLD_MS);
      },
      move(st) {
        if (!moving && !isPhone() && W.mode === 'normal' && Math.hypot(st.dx, st.dy) > 9 && performance.now() - st.t0 > 140) { clearTimeout(holdT); holdT = null; try { getSelection()?.removeAllRanges(); } catch {} moving = true; dots.classList.add('held'); closeMenus(); raise(W); W.lift = 1; }
        if (!moving || W.mode !== 'normal') return;
        W.tx = sx + st.dx; W.ty = sy + st.dy;
        apply(W); lockIn(W);
      },
      up(st) {
        clearTimeout(holdT); dots.classList.remove('held');
        if (moving) {
          moving = false; W.lift = 0;
          if (isPhone()) tween(W, { tx: 0, ty: 0 }, 380); else lockIn(W);
          return;
        }
        if (Math.hypot(st.dx, st.dy) < 10) toggleMenu(W);
      },
    });
  }

  /* pill: swipe down = minimize, swipe up = maximize, tap = program info */
  function wirePill(W) {
    const pill = $('.nos-pill', W.ch);
    track(pill, {
      down() { pill.classList.add('on'); },
      move(st) { if (W.mode === 'normal' && !W.anim) { W.ty = (W.saved0 ??= W.ty) + clamp(st.dy * 0.25, -14, 14); apply(W); } },
      up(st) {
        pill.classList.remove('on');
        if (W.saved0 != null) { W.ty = W.saved0; W.saved0 = null; apply(W); }
        if (st.dy > SWIPE && Math.abs(st.dy) > Math.abs(st.dx)) { W.mode === 'max' ? restore(W) : minimize(W); return; }
        if (st.dy < -SWIPE && Math.abs(st.dy) > Math.abs(st.dx)) { if (W.mode !== 'max') maximize(W); return; }
        if (Math.hypot(st.dx, st.dy) < 10) toggleInfo(W);
      },
    });
    pill.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleInfo(W); } if (e.key === 'ArrowDown') minimize(W); if (e.key === 'ArrowUp') maximize(W); });
  }

  /* arc (laptop/tablet): CLICK closes; a SWIPE DOWN that starts on the arc closes (gesture); a long pull away closes too.
     A short wobble that is neither springs back. Phones have no arc (no close button on a phone app). */
  function closeWin(W, how) {
    if (isPhone() || W.mode === 'min' || W.mode === 'closed') return;
    minimize(W, true);
    say(`${appFor(W.el).title} closed \u00b7 reopen it from the dock`);
    try { window.dispatchEvent(new CustomEvent('nos:close', { detail: { id: W.el.id, how } })); } catch {}
  }
  function wireArc(W) {
    const arc = $('.nos-arc', W.ch);
    let s0, pulled;
    const verdict = (st) => {
      const pull = Math.hypot(st.dx, st.dy);
      if (pull <= ARC_TAP) return 'click';
      if (st.dy >= ARC_SWIPE && st.dy >= Math.abs(st.dx) * 0.7) return 'swipe-down';
      if (st.dy >= 18 && st.dt && st.dy / st.dt > 0.45 && st.dy >= Math.abs(st.dx) * 0.7) return 'flick-down';
      if (pull > CLOSE_PULL) return 'pull';
      return null;
    };
    track(arc, {
      down() { arc.classList.add('on'); closeMenus(); closeInfo(); s0 = { tx: W.tx, ty: W.ty, s: W.s, op: W.op }; pulled = false; },
      move(st) {
        if (W.mode !== 'normal') return;
        const pull = Math.hypot(st.dx, st.dy);
        if (!pulled && pull <= ARC_TAP) return;
        pulled = true;
        const down = Math.max(0, st.dy), k = clamp(Math.max(down / ARC_SWIPE, pull / CLOSE_PULL), 0, 1);
        W.tx = s0.tx + st.dx * 0.12; W.ty = s0.ty + down * 0.35;
        W.s = 1 - k * 0.05; W.op = 1 - k * 0.3;
        arc.classList.toggle('armed', !!verdict({ ...st, dt: performance.now() - st.t0 }) && pull > ARC_TAP); apply(W);
      },
      up(st) {
        arc.classList.remove('on', 'armed');
        const v = W.mode === 'normal' || W.mode === 'max' ? verdict(st) : null;
        if (v) { if (pulled) { W.tx = s0.tx; W.ty = s0.ty; } closeWin(W, v); }
        else if (pulled) tween(W, { tx: s0.tx, ty: s0.ty, s: 1, op: 1 }, 300);
      },
    });
    arc.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Delete') { e.preventDefault(); closeWin(W, 'key'); } });
  }

  /* hidden resize corner (bottom-right); jiggles when the window can't resize */
  function canResize(W) { return !isPhone() && W.mode === 'normal'; }
  function jiggle(W) {
    W.el.classList.remove('nos-jiggle'); void W.el.offsetWidth; W.el.classList.add('nos-jiggle');
    W.ch.classList.add('nope'); setTimeout(() => W.ch.classList.remove('nope'), 1300);
    let k = 0; const base = W.tx; const t = setInterval(() => { k++; W.tx = base + [6, -6, 4, -4, 2, 0][k - 1]; apply(W); if (k >= 6) clearInterval(t); }, 45);
  }
  function wireResize(W) {
    const rz = $('.nos-rz', W.ch);
    let r0, hitWall;
    track(rz, {
      down() {
        if (!canResize(W)) { jiggle(W); r0 = null; return; }
        rz.classList.add('show'); r0 = W.el.getBoundingClientRect(); hitWall = false;
        W.el.classList.add('nos-sized');
      },
      move(st) {
        if (!r0) return;
        const minW = 260, minH = 180, maxW = VW - r0.left - 8, maxH = VH - r0.top - 8;
        const w = r0.width + st.dx, h = r0.height + st.dy;
        W.w = clamp(w, minW, maxW); W.h = clamp(h, minH, maxH);
        hitWall = w < minW - 24 || h < minH - 24 || w > maxW + 24 || h > maxH + 24;
        apply(W);
      },
      up() { rz.classList.remove('show'); if (r0 && hitWall) jiggle(W); r0 = null; },
    });
  }

  /* ---------------- menus: ••• bar (File | Edit | View), dropdown, pill info ---------------- */
  const bar = document.createElement('nav'); bar.id = 'nos-menubar'; bar.className = 'nos-glass-ui'; bar.setAttribute('aria-label', 'Program menu');
  bar.innerHTML = '<button type="button" data-m="file">File</button><button type="button" data-m="edit">Edit</button><button type="button" data-m="view">View</button>';
  const sub = document.createElement('div'); sub.id = 'nos-submenu'; sub.className = 'nos-glass-ui'; sub.setAttribute('role', 'menu');
  const info = document.createElement('section'); info.id = 'nos-info'; info.className = 'nos-glass-ui'; info.setAttribute('aria-label', 'Program info'); info.dataset.pillInfo = 'true';
  body.append(bar, sub, info);
  const M = { win: null, v: 0, subKey: null, sv: 0, info: null, iv: 0 };
  const SUBS = {
    file: (W) => [
      ...(W.el.id === 'chat' || W.el.id === 'avatar-panel' ? [['Give Jena a file\u2026', 'gift']] : []),
      ['About N\u2022OS', 'about'],
      ...(isPhone() ? [['App info', 'info']] : []),
      ...(isMama() && window.__jenaDev ? [['Developer panel', 'dev']] : []),
      ...(isPhone() ? [] : [['Close window', 'close']]),   // a phone app has no close
    ],
    edit: (W) => [
      ['Copy window text', 'copy'],
      ...($('#talk-input') && (W.el.id === 'chat') ? [['Clear my draft', 'clear']] : []),
    ],
    view: () => [
      ['Bigger text', 'zin'], ['Smaller text', 'zout'],
      [dark ? 'Light glass' : 'Dark glass', 'theme'],
      ...(isPhone() ? [] : [['Reset windows', 'reset']]),
    ],
  };
  function toggleMenu(W) { if (M.win === W && M.v > 0.5) closeMenus(); else openMenu(W); }
  function openMenu(W) {
    closeInfo(); M.win = W; M.subKey = null; sub.style.visibility = 'hidden'; M.sv = 0;
    for (const b of bar.children) b.classList.remove('open');
    bar.style.visibility = 'visible'; animM('v', 1, 420);
  }
  function closeMenus() { if (M.v > 0 || M.win) animM('v', 0, 260, () => { bar.style.visibility = 'hidden'; M.win = null; }); closeSub(); closeInfo(); }
  function openSub(k) {
    const W = M.win; if (!W) return;
    M.subKey = k; sub.innerHTML = SUBS[k](W).map(([t, a]) => `<button type="button" role="menuitem" data-a="${a}">${esc(t)}</button>`).join('');
    for (const b of bar.children) b.classList.toggle('open', b.dataset.m === k);
    sub.style.visibility = 'visible'; M.sv = 0; animM('sv', 1, 360);
  }
  function closeSub() { if (M.sv > 0) animM('sv', 0, 220, () => { sub.style.visibility = 'hidden'; M.subKey = null; }); for (const b of bar.children) b.classList.remove('open'); }
  let anims = {};
  function animM(k, to, ms, done) {
    const from = M[k], t0 = performance.now(), id = {}; anims[k] = id;
    const step = (now) => { if (anims[k] !== id) return; const p = clamp((now - t0) / ms, 0, 1); M[k] = from + (to - from) * ease(p); layoutMenus(); if (p < 1) requestAnimationFrame(step); else done && done(); };
    requestAnimationFrame(step);
  }
  bar.addEventListener('click', (e) => { const k = e.target.closest('button')?.dataset.m; if (!k || M.v < 0.9) return; M.subKey === k && M.sv > 0.5 ? closeSub() : openSub(k); });
  sub.addEventListener('click', async (e) => {
    const a = e.target.closest('button')?.dataset.a, W = M.win; if (!a || !W) return;
    closeMenus();
    if (a === 'close') closeWin(W, 'menu');
    else if (a === 'info') openInfo(W);
    else if (a === 'about') openAbout();
    else if (a === 'dev') window.__jenaDev?.open();
    else if (a === 'gift') $('#file-input')?.click();
    else if (a === 'copy') {
      const txt = [...W.el.childNodes].filter((n) => !(n.classList && n.classList.contains('nos-chrome'))).map((n) => n.innerText || n.textContent || '').join('\n').replace(/\n{3,}/g, '\n\n').trim();
      try { await navigator.clipboard.writeText(txt); say('Copied'); } catch { say('Copy isn\u2019t allowed here'); }
    }
    else if (a === 'clear') { const i = $('#talk-input'); if (i) { i.value = ''; i.dispatchEvent(new Event('input')); } say('Draft cleared'); }
    else if (a === 'zin' || a === 'zout') { const z = clamp((parseFloat(W.el.dataset.zoom) || 1) + (a === 'zin' ? 0.1 : -0.1), 0.8, 1.5); W.el.dataset.zoom = z.toFixed(1); W.el.style.setProperty('--nos-zoom', z.toFixed(1)); W.el.classList.toggle('nos-zoomed', z !== 1); say(`Text ${Math.round(z * 100)}%`); }
    else if (a === 'theme') { dark = !dark; body.classList.toggle('nos-dark', dark); try { localStorage.setItem('nos.glass', dark ? 'dark' : 'light'); } catch {} dirty = true; }
    else if (a === 'reset') resetAll();
  });
  function resetAll(quiet) {
    for (const W of wins.values()) {
      if (W.mode === 'min' || W.mode === 'closed') { W.el.classList.remove('nos-hidden'); }
      W.el.classList.remove('nos-max', 'nos-sized'); W.anim = null; W.max = null; W.w = W.h = null; W.home = null;
      Object.assign(W.el.style, { left: '', top: '', width: '', height: '', zIndex: '' });
      W.mode = 'normal'; W.restoring = false; W.tx = W.ty = 0; W.s = 1; W.op = 1; apply(W);
    }
    renderDock(); syncMax(); if (!quiet) say('Windows reset');
  }

  function toggleInfo(W) { if (M.info === W && M.iv > 0.5) closeInfo(); else openInfo(W); }
  function openInfo(W) {
    closeMenus(); M.info = W;
    const app = appFor(W.el), r = W.el.getBoundingClientRect();
    const ops = [`<button type="button" data-op="top">Always on top<em class="chk${W.top ? ' on' : ''}"></em></button>`, '<button type="button" data-op="about">About N\u2022OS</button>'];
    if (isMama() && window.__jenaDev) ops.push('<button type="button" data-op="dev">Developer panel <em>mama</em></button>');
    info.innerHTML = `<div class="nos-hero"><b>Jena</b><span>N\u2022OS app \u00b7 NCOM</span></div>
      <p class="nos-i-title">${esc(app.title)}</p><p class="nos-i-about">${esc(app.about)}</p>
      <p class="nos-i-meta"><span>${Math.round(r.width)} \u00d7 ${Math.round(r.height)}</span><span>N\u2022OS window</span><span>${dark ? 'dark' : 'light'} glass</span></p>
      <dl class="nos-rows">${NOS_ABOUT.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <div class="nos-ops">${ops.join('')}</div>`;
    info.style.visibility = 'visible'; M.iv = 0; animM('iv', 1, 420);
  }
  function closeInfo() { if (M.iv > 0) animM('iv', 0, 240, () => { info.style.visibility = 'hidden'; M.info = null; }); }
  info.addEventListener('click', (e) => {
    const b = e.target.closest('button'), W = M.info; if (!b || !W) return;
    const op = b.dataset.op;
    if (op === 'top') { W.top = !W.top; b.querySelector('.chk')?.classList.toggle('on', W.top); W.el.style.zIndex = W.top ? '60' : ''; say(W.top ? `${appFor(W.el).title} stays on top` : 'Always on top: off'); }
    if (op === 'about') { closeInfo(); openAbout(); }
    if (op === 'dev') { closeInfo(); window.__jenaDev?.open(); }
  });
  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (M.v > 0 && !bar.contains(t) && !sub.contains(t) && !t.closest?.('.nos-dots')) closeMenus();
    if (M.iv > 0 && !info.contains(t) && !t.closest?.('.nos-pill')) closeInfo();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenus(); closeInfo(); } });

  function layoutMenus() {
    const W = M.win;
    if (W) {
      const r = W.el.getBoundingClientRect();
      const bw = bar.scrollWidth || 190;
      bar.style.left = Math.round(clamp(r.left + r.width / 2 - bw / 2, 6, VW - bw - 6)) + 'px'; bar.style.top = Math.round(r.top + 3) + 'px';
      bar.style.transform = `scaleX(${0.4 + 0.6 * M.v})`; bar.style.opacity = String(clamp(M.v * 1.6 - 0.6, 0, 1));
      bar.style.pointerEvents = M.v > 0.9 ? 'auto' : 'none';
      W.ch.querySelector('.nos-dots').style.opacity = String(Math.max(0, 1 - M.v * 2));
      if (M.subKey) {
        const b = bar.querySelector(`[data-m=${M.subKey}]`), br = bar.getBoundingClientRect(), sw = 196;
        sub.style.left = Math.round(clamp(br.left + (b ? b.offsetLeft : 0) - 6, 8, VW - sw - 8)) + 'px';
        sub.style.top = Math.round(br.bottom + 6) + 'px';
        sub.style.transform = `translateY(${(1 - M.sv) * -6}px) scale(${0.94 + 0.06 * M.sv})`; sub.style.opacity = String(clamp(M.sv * 1.4, 0, 1));
        sub.style.pointerEvents = M.sv > 0.9 ? 'auto' : 'none';
      }
    }
    for (const X of wins.values()) if (X !== W) X.ch.querySelector('.nos-dots').style.opacity = '';
    if (M.info) {
      const r = M.info.el.getBoundingClientRect(), w = Math.min(290, Math.max(220, r.width - 28), VW - 16);
      info.style.width = w + 'px';
      const ih = info.offsetHeight;
      info.style.left = Math.round(clamp(r.right - 14 - w, 8, VW - w - 8)) + 'px';
      info.style.top = Math.round(clamp(r.top + 18, 8, Math.max(8, VH - ih - 8))) + 'px';
      info.style.transform = `scale(${0.9 + 0.1 * M.iv})`; info.style.opacity = String(clamp(M.iv * 1.4, 0, 1));
      info.style.pointerEvents = M.iv > 0.9 ? 'auto' : 'none';
    }
    dirty = true;
  }

  /* ---------------- About N•OS window ---------------- */
  function openAbout() {
    let el = $('#nos-about');
    if (!el) {
      el = document.createElement('section'); el.id = 'nos-about'; el.className = 'panel nos-floating'; el.setAttribute('aria-label', 'About N\u2022OS');
      el.innerHTML = `<div class="nos-about-in"><div class="nos-sym"><img src="/nos/ncom-symbol.png" width="174" height="90" alt="NCOM symbol"></div>
        <h2>N\u2022OS</h2><dl class="nos-rows">${NOS_ABOUT.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>`;
      body.append(el); scan();
    }
    const W = wins.get(el); if (W.mode === 'min' || W.mode === 'closed') reopen(W);
    W.el.style.zIndex = '74';
  }

  /* ---------------- render loop ---------------- */
  let dirty = true, sig = '';
  function panesFor() {
    const A = [], B = [];
    const phone = isPhone();
    for (const W of wins.values()) {
      const el = W.el;
      if (el.classList.contains('nos-hidden') || el.classList.contains('nos-under-max') || W.op < 0.01) continue;
      if (phone && el.id === 'avatar-panel') continue;
      const cs = el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
      if (!cs) continue;
      const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
      const k = r.width / (el.offsetWidth || r.width);
      (el.id === 'nos-about' ? B : A).push({ r, rad: Math.min(R * k, r.height / 2), op: W.op * (el.id === 'avatar-panel' ? 0.55 : 1), sh: W.mode === 'max' ? 0.6 : 1, lift: W.lift, menu: 0, refr: 7, bevel: 18 });
    }
    for (const sel of ['#m-top', '#m-tabs']) { const el = $(sel); if (el && phone) { const r = el.getBoundingClientRect(); if (r.height) A.push({ r, rad: 0.01, op: 1, sh: 0.4, lift: 0, menu: 0.6, refr: 4, bevel: 10, flat: 1 }); } }
    if (dock.classList.contains('show')) for (const c of dock.children) { const r = c.getBoundingClientRect(); B.push({ r, rad: r.height / 2, op: 1, sh: 0.6, lift: 0, menu: 0.5, refr: 5, bevel: 12 }); }
    if (M.v > 0.01 && bar.style.visibility === 'visible') B.push({ r: bar.getBoundingClientRect(), rad: Math.min(24, bar.offsetHeight / 2 || 20), op: M.v, sh: 0.7, lift: 0, menu: 1, refr: 6, bevel: 12 });
    if (M.sv > 0.01 && M.subKey) B.push({ r: sub.getBoundingClientRect(), rad: 24, op: M.sv, sh: 0.8, lift: 0, menu: 1, refr: 6, bevel: 14 });
    if (M.iv > 0.01 && M.info) B.push({ r: info.getBoundingClientRect(), rad: 24, op: M.iv, sh: 0.8, lift: 0, menu: 1, refr: 7, bevel: 16 });
    return [A.slice(0, MAXP), B.slice(0, MAXP)];
  }
  function frame() {
    requestAnimationFrame(frame);
    if (!gl) return;
    if (M.v > 0 || M.iv > 0) layoutMenus();
    const [A, B] = panesFor();
    const s = (dark ? 'd' : 'l') + VW + 'x' + VH + A.map((p) => [p.r.left, p.r.top, p.r.width, p.r.height, p.op, p.lift].map((v) => Math.round(v * 10)).join(',')).join('|') + '#' + B.map((p) => [p.r.left, p.r.top, p.r.width, p.r.height, p.op].map((v) => Math.round(v * 10)).join(',')).join('|');
    if (!dirty && s === sig) return;
    dirty = false; sig = s;
    G1.draw(A, [], VW, VH, DPR, dark, 0);
    G2.draw(B, A, VW, VH, DPR, dark, 1);
  }
  function resize() {
    VW = innerWidth; VH = innerHeight; DPR = Math.min(devicePixelRatio || 1, 2);
    for (const c of [base, over]) { c.width = Math.round(VW * DPR); c.height = Math.round(VH * DPR); }
    const ph = isPhone();
    if (ph && !wasPhone && wins.size) resetAll(true);   // into the phone app: every window back in its place, nothing closed
    wasPhone = ph;
    for (const W of wins.values()) { if (W.mode === 'max' && !W.anim) { W.max = areaRect(); apply(W); } else if (!ph && W.mode === 'normal' && (W.tx || W.ty)) lockIn(W); }
    paintWallpaper();
  }
  let wasPhone = isPhone();
  addEventListener('resize', resize);
  new MutationObserver(() => { if (isPhone() !== wasPhone) resize(); }).observe(body, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(() => { scan(); dirty = true; }).observe($('#stage') || body, { childList: true });
  new MutationObserver(() => { dirty = true; }).observe(body, { attributes: true, attributeFilter: ['class', 'data-tab'] });
  scan(); resize(); requestAnimationFrame(frame);
  if (gl) {
    base.addEventListener('webglcontextlost', (e) => { e.preventDefault(); body.classList.remove('nos-gl'); body.classList.add('nos-nogl'); });
  }
  const api = { wins, maximize: (id) => maximize(wins.get(document.getElementById(id))), minimize: (id) => minimize(wins.get(document.getElementById(id))), close: (id) => minimize(wins.get(document.getElementById(id)), true), reopen: (id) => reopen(wins.get(document.getElementById(id))), openMenu: (id) => openMenu(wins.get(document.getElementById(id))), openSub, openInfo: (id) => openInfo(wins.get(document.getElementById(id))), openAbout, resetAll, closeMenus, gl };
  window.__nos = api;
  return api;
}

/* ---------------- WebGL2 liquid glass (the demo's shader, generalised to many panes) ---------------- */
const VS = `#version 300 es
in vec2 a; void main(){ gl_Position = vec4(a,0.,1.); }`;
const FS = `#version 300 es
precision highp float;
#define N ${MAXP}
uniform sampler2D uTex; uniform vec2 uView; uniform float uDpr, uDark, uLayer; uniform int uN, uNU;
// uRect = centre.xy, half-size.zw   uPar = radius, opacity, shadow scale, lift   uExt = menu-ness, refraction px, bevel px, flat
uniform vec4 uRect[N]; uniform vec4 uPar[N]; uniform vec4 uExt[N];
uniform vec4 uURect[N]; uniform vec4 uUPar[N];   // overlay: the windows under the menus (seen frosted through them)
out vec4 o;
float sdRB(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q,0.)) + min(max(q.x,q.y),0.) - r; }
vec3 wall(vec2 p, float lod){ return textureLod(uTex, clamp(p/uView, vec2(0.001), vec2(0.999)), lod).rgb; }
vec3 tintIt(vec3 g, float k){
  vec3 tint = uDark > .5 ? vec3(1.0, 0.74, 0.40) : vec3(1.0, 0.985, 0.995);
  float tA = uDark > .5 ? 0.26 + 0.10*k : 0.40 + 0.22*k;
  g = mix(g, tint * (uDark > .5 ? 0.42 : 1.0), tA);
  g = g * (uDark > .5 ? 0.93 - 0.22*k : 1.02) + (uDark > .5 ? 0.02 : 0.03);
  return g;
}
vec3 bg(vec2 p, float lod){
  vec3 c = wall(p, lod);
  if (uLayer < .5) return c;
  for (int j = 0; j < N; j++) {
    if (j >= uNU) break;
    float d = sdRB(p - uURect[j].xy, uURect[j].zw, uUPar[j].x);
    if (d < 1.) c = mix(c, tintIt(wall(p, max(lod, 3.6)), 0.), smoothstep(0.8, -0.8, d) * uUPar[j].y);
  }
  return c;
}
void main(){
  vec2 p = vec2(gl_FragCoord.x, uView.y*uDpr - gl_FragCoord.y) / uDpr;
  bool over = uLayer > .5;
  vec3 col = over ? vec3(0.) : wall(p, 0.4);
  float al = over ? 0. : 1.;
  for (int i = 0; i < N; i++) {
    if (i >= uN) break;
    float op = uPar[i].y; if (op < 0.003) continue;
    vec4 Rc = uRect[i]; float rad = uPar[i].x;
    float far = sdRB(p - Rc.xy, Rc.zw, rad);
    if (far > 90.) continue;
    float lift = uPar[i].w, sk = uPar[i].z;
    float oy = (12. + 10.*lift) * sk, bl = (32. + 18.*lift) * mix(0.6, 1., sk);
    float ds = sdRB(p - Rc.xy - vec2(0., oy), Rc.zw, rad);
    float sh = (1. - smoothstep(-bl*0.45, bl, ds)) * (0.20 + 0.08*lift) * mix(0.55, 1., sk);
    float dt = sdRB(p - Rc.xy - vec2(0., 2.), Rc.zw, rad);
    sh += (1. - smoothstep(-3., 6., dt)) * 0.10;
    float shA = clamp(sh, 0., 0.55) * op * (uDark > .5 ? 1. : .75);
    col *= 1. - shA; al = shA + al * (1. - shA);
    float d = far;
    if (d > 1.5) continue;
    vec2 e = vec2(1.25, 0.);
    vec2 n = normalize(vec2(sdRB(p+e.xy-Rc.xy,Rc.zw,rad)-sdRB(p-e.xy-Rc.xy,Rc.zw,rad), sdRB(p+e.yx-Rc.xy,Rc.zw,rad)-sdRB(p-e.yx-Rc.xy,Rc.zw,rad)) + 1e-5);
    float mk = uExt[i].x, bevel = uExt[i].z;
    float edge = clamp(1. + d/bevel, 0., 1.);
    float prof = edge*edge*edge;
    vec2 off = n * prof * uExt[i].y;
    vec2 q = p + off;
    float lod = mix(3.4, 1.6, prof), rr0 = mix(16., 5., prof);
    vec3 g = bg(q, lod) * 0.16;
    for (int k = 0; k < 12; k++) {
      float an = float(k) * 0.5236 + 0.26, rr = (k % 2 == 0) ? rr0 : rr0 * 0.5;
      g += bg(q + vec2(cos(an), sin(an)) * rr, lod) * 0.07;
    }
    if (prof > 0.04) {
      float cr = bg(p + off*1.10, 1.6).r, cb = bg(p + off*0.88, 1.6).b;
      g.r = mix(g.r, cr, prof*0.6); g.b = mix(g.b, cb, prof*0.6);
    }
    g = tintIt(g, mk * (1. - prof*0.7));
    g += prof * (uDark > .5 ? vec3(0.10,0.08,0.05) : vec3(0.06));
    float rim = smoothstep(1.7, 0.0, abs(d + 0.9));
    float lit = pow(max(dot(n, normalize(vec2(-0.55,-0.85))), 0.), 1.4);
    float bounce = pow(max(dot(n, normalize(vec2(0.55,0.85))), 0.), 2.0);
    g += rim * (0.28 + 0.75*lit + 0.35*bounce) * vec3(1.0, 0.96, 0.9);
    g += smoothstep(9., 0., -d) * lit * 0.10;
    float a = smoothstep(0.8, -0.8, d) * op;
    col = g * a + col * (1. - a); al = a + al * (1. - a);
  }
  o = over ? vec4(col, al) : vec4(col, 1.);
}`;

function makeGL(c, overlay) {
  let g;
  try { g = c.getContext('webgl2', overlay ? { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true } : { antialias: false, alpha: false, preserveDrawingBuffer: true }); } catch { g = null; }
  if (!g) return null;
  const sh = (t, s) => { const o = g.createShader(t); g.shaderSource(o, s); g.compileShader(o); if (!g.getShaderParameter(o, g.COMPILE_STATUS)) { console.warn('[nos] shader', g.getShaderInfoLog(o)); return null; } return o; };
  const vs = sh(g.VERTEX_SHADER, VS), fs = sh(g.FRAGMENT_SHADER, FS);
  if (!vs || !fs) return null;
  const pr = g.createProgram(); g.attachShader(pr, vs); g.attachShader(pr, fs); g.linkProgram(pr);
  if (!g.getProgramParameter(pr, g.LINK_STATUS)) { console.warn('[nos] link', g.getProgramInfoLog(pr)); return null; }
  g.useProgram(pr);
  const buf = g.createBuffer(); g.bindBuffer(g.ARRAY_BUFFER, buf);
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
  const loc = g.getAttribLocation(pr, 'a'); g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);
  const tex = g.createTexture(); g.bindTexture(g.TEXTURE_2D, tex);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR_MIPMAP_LINEAR); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  const U = {}; for (const n of ['uTex', 'uView', 'uDpr', 'uDark', 'uLayer', 'uN', 'uNU', 'uRect', 'uPar', 'uExt', 'uURect', 'uUPar']) U[n] = g.getUniformLocation(pr, n);
  const pack = (list, f) => { const a = new Float32Array(MAXP * 4); list.forEach((p, i) => a.set(f(p), i * 4)); return a; };
  return {
    upload(img) { g.bindTexture(g.TEXTURE_2D, tex); g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, img); g.generateMipmap(g.TEXTURE_2D); },
    draw(panes, under, VW, VH, DPR, dark, layer) {
      g.viewport(0, 0, c.width, c.height);
      if (layer && !panes.length) { g.clearColor(0, 0, 0, 0); g.clear(g.COLOR_BUFFER_BIT); return; }
      g.useProgram(pr);
      g.uniform1i(U.uTex, 0); g.uniform2f(U.uView, VW, VH); g.uniform1f(U.uDpr, c.width / VW); g.uniform1f(U.uDark, dark ? 1 : 0); g.uniform1f(U.uLayer, layer);
      g.uniform1i(U.uN, panes.length); g.uniform1i(U.uNU, under.length);
      const rect = (p) => [p.r.left + p.r.width / 2, p.r.top + p.r.height / 2, p.r.width / 2, p.r.height / 2];
      g.uniform4fv(U.uRect, pack(panes, rect));
      g.uniform4fv(U.uPar, pack(panes, (p) => [p.rad, p.op, p.sh, p.lift]));
      g.uniform4fv(U.uExt, pack(panes, (p) => [p.menu, p.refr, p.bevel, p.flat || 0]));
      g.uniform4fv(U.uURect, pack(under, rect));
      g.uniform4fv(U.uUPar, pack(under, (p) => [p.rad, p.op, 0, 0]));
      g.drawArrays(g.TRIANGLES, 0, 3);
    },
  };
}
