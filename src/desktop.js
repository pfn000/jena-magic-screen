// Jena's virtual desktop panel. Two views, picked per device:
//  * MAMA VIEW (this device holds mama's dev passcode, not OBS): her smooth, RAW, full-fps desktop through a one-time
//    view-only token (/api/mama watch -> wss://box/websockify-watch?t=…, the view-only VNC). Never censored, never
//    public; nothing ever covers it (lock cards are for the public/OBS view only). ?public=1 shows mama the public view instead.
//  * PUBLIC / OBS: censored frames only (box/desktop/jena_censor.py OCRs + blacks out emails, IPs, codes, keys,
//    phones on her box). A slow read never flashes the lock card: the last good censored frame stays up until the
//    next one is ready. The whole-screen card only shows for real private states (sign-in page, inbox, keys on
//    screen, mama driving, a private sign-in window). Frames arrive by long-poll (?since=seq), so a new picture
//    shows the moment the box has one and nothing is re-downloaded when nothing changed.
// Badge: ● LIVE (OBS open, her Twitch live, or mama's "Live now" switch: the censor is strict) / OFF-AIR.

const WATCH_RETRY_MS = 4000;

// wss://host/websockify (what /api/config announces) or https://host -> https://host
export function boxBase(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url).trim());
    const proto = u.protocol === 'wss:' || u.protocol === 'https:' ? 'https:' : 'http:';
    return `${proto}//${u.host}`;
  } catch { return null; }
}

// her box tags each frame with a JPEG comment "jena-censor seq=N state=… reason=…" (proxies drop custom headers)
async function readSeq(blob) {
  try {
    const b = new Uint8Array(await blob.slice(0, 96).arrayBuffer());
    if (b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff || b[3] !== 0xfe) return null;
    const m = /seq=(\d+)/.exec(new TextDecoder().decode(b.subarray(6, 4 + ((b[4] << 8) | b[5]))));
    return m ? +m[1] : null;
  } catch { return null; }
}

const qs = new URLSearchParams(location.search);
if (!document.getElementById('desk-js-css')) {
  const st = document.createElement('style'); st.id = 'desk-js-css';
  st.textContent = '#desktop.is-reconnecting .desk-badge::after{content:" ·";animation:deskdot 1s steps(2) infinite}@keyframes deskdot{50%{opacity:.2}}#desktop .desk-badge.on-air{background:#e5143c;color:#fff}';
  document.head.appendChild(st);
}
const OBS = qs.get('obs') === '1' || document.body.classList.contains('obs');

export class Desktop {
  constructor(root, { url }) {
    this.root = root;
    this.screen = root.querySelector('.desk-screen');
    this.sleep = root.querySelector('.desk-sleep');
    this.badge = root.querySelector('.desk-badge');
    this.base = null;
    this.fails = 0;
    this.state = 'asleep';
    this.censor = null;
    this.frames = 0;
    this.shown = [];          // times a NEW public frame went on screen (client fps)
    this.seq = null;
    this.mode = 'public';
    this.imgs = [0, 1].map(() => {
      const im = document.createElement('img');
      im.alt = "Jena's desktop (privacy-filtered)";
      im.decoding = 'async';
      im.draggable = false;
      im.className = 'desk-frame';
      im.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;pointer-events:none;';
      return im;
    });
    this.front = 0;
    this.screen.innerHTML = '';
    this.imgs.forEach((im) => this.screen.appendChild(im));
    this.vnc = document.createElement('div');
    this.vnc.className = 'desk-mama';
    this.vnc.style.cssText = 'position:absolute;inset:0;display:none;background:#000;';
    this.screen.appendChild(this.vnc);
    // "I'm mama" key on the panel: one passcode entry on this device -> her raw, uncensored view from then on
    this.mamaBtn = document.createElement('button');
    this.mamaBtn.type = 'button';
    this.mamaBtn.className = 'desk-mama-key';
    this.mamaBtn.textContent = '🔑 mama view';
    this.mamaBtn.title = 'mama: enter your passcode once on this device to see her desktop raw, smooth and uncensored';
    this.mamaBtn.style.cssText = 'position:absolute;left:8px;bottom:8px;z-index:4;padding:4px 10px;border:0;border-radius:999px;background:rgba(46,33,66,.8);color:#f8eaff;font:700 12px system-ui;cursor:pointer;';
    this.mamaBtn.addEventListener('click', () => this.unlockMama());
    if (!OBS) this.screen.appendChild(this.mamaBtn);
    this.syncMamaBtn();
    document.addEventListener('visibilitychange', () => { if (document.hidden) return; if (this.mode === 'public') this.kick(); else if (!this.rfb) this.startMama(); });
    window.addEventListener('online', () => { if (this.mode === 'mama' && !this.rfb) this.startMama(); else if (this.mode === 'public') this.kick(); });
    // self-heal: a mama view with no live connection and nothing scheduled gets restarted
    setInterval(() => { if (this.mode === 'mama' && !this.rfb && !document.hidden && Date.now() - (this.mamaTried || 0) > 20000) this.startMama(); }, 10000);
    this.setUrl(url, true);
    setInterval(() => this.pollStatus(), 2500);
    this.bindTakeover();
  }

  // Saidie (1:39 PM): double-click her desktop -> mama has it for a whole hour, Jena's own hands pause, and the
  // changes stay. A double-tap does the same on a phone (then her desktop turns phone-shaped: phone mode).
  bindTakeover() {
    if (OBS) return;
    window.addEventListener('jena-trusted', () => { if (this.mode !== 'mama' && this.wantsMama()) { clearTimeout(this.watchRetry); this.startMama(); } });
    const isMama = () => this.mode === 'mama' || !!localStorage.getItem('jena.dmKey');
    const go = () => { if (!isMama() || document.getElementById('mama-takeover')) return; import('./takeover.js').then((m) => m.openTakeover({ source: 'double_click' })); };
    // capture phase: noVNC's own mouse/touch handlers on the canvas stop these events from bubbling
    // a mouse double-click is detected from two pointerdowns: noVNC captures the pointer on mousedown (its capture
    // div takes the mouseup), so the browser's own dblclick lands on <body>, never on this panel (1600 px bug).
    // The whole desk body counts, so it also works while the picture is still connecting.
    const area = this.screen.parentElement || this.screen;
    const skip = (e) => e.target === this.mamaBtn || !!e.target?.closest?.('button, a, input, textarea, select');
    let pd = 0, px = 0, py = 0;
    area.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.button !== 0 || skip(e)) return;
      const now = Date.now();
      if (now - pd < 450 && Math.hypot(e.clientX - px, e.clientY - py) < 12) { pd = 0; go(); }
      else { pd = now; px = e.clientX; py = e.clientY; }
    }, true);
    area.addEventListener('dblclick', (e) => { if (skip(e)) return; e.preventDefault(); go(); }, true);
    let last = 0, lx = 0, ly = 0;
    area.addEventListener('touchend', (e) => {
      if (skip(e)) return;
      const t = e.changedTouches[0]; if (!t || e.touches.length) return;
      const now = Date.now();
      if (now - last < 350 && Math.hypot(t.clientX - lx, t.clientY - ly) < 30) { last = 0; if (e.cancelable) e.preventDefault(); go(); }
      else { last = now; lx = t.clientX; ly = t.clientY; }
    }, { passive: false, capture: true });
    if (isMama()) this.screen.title = 'double-click: take over her desktop for an hour (her hands pause)';
  }

  wantsMama() { return !OBS && qs.get('public') !== '1' && !!localStorage.getItem('jena.dmKey'); }

  setUrl(url, first = false) {
    // the site can briefly forget her box's address (a cold server instance): keep using the last one that worked
    // and ask again right away with backoff (2 s, 4 s, 8 s … 15 s), instead of sitting on "asleep" while she is busy
    let base = boxBase(url);
    if (!base) {
      base = boxBase(localStorage.getItem('jena.lastBox'));
      this.refetchConfig();
    } else { this.cfgTry = 0; clearTimeout(this.cfgTimer); }
    if (!first && base === this.base) return;
    this.base = base;
    this.url = url;
    this.fails = 0;
    this.seq = null;
    // mama's raw view doesn't need the address at all (her box answers /api/mama watch), so it never waits on it
    if (this.wantsMama()) { if (this.state !== 'live') this.asleep('connecting to her desktop…', true); this.startMama(); return; }
    if (!base) { this.asleep('finding her desktop…', true); return; }
    if (this.state !== 'live') this.asleep('waking up…', true);
    this.startPublic();
  }

  refetchConfig() {
    clearTimeout(this.cfgTimer);
    this.cfgTry = (this.cfgTry || 0) + 1;
    const wait = Math.min(15000, 1000 * 2 ** Math.min(4, this.cfgTry));
    this.cfgTimer = setTimeout(async () => {
      const c = await fetch('/api/config', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
      if (c?.desktopUrl) this.setUrl(c.desktopUrl); else this.refetchConfig();
    }, wait);
  }

  syncMamaBtn() { if (this.mamaBtn) this.mamaBtn.style.display = !OBS && this.mode !== 'mama' ? 'block' : 'none'; }

  // the "🔑 mama view" key. A trusted device never gets a passcode box here: the cookie hands its key back first.
  // Only a device that was never trusted (or was locked on purpose) sees the shared passcode card (trust.js).
  async unlockMama() {
    // the ONE trusted check (src/trust.js): a trusted device (token or the HttpOnly cookie) goes straight to mama view,
    // nothing asked; only a never-trusted device sees Face ID / the passcode, once. No prompt of its own here.
    const k = window.jenaTrust?.ensureMama ? await window.jenaTrust.ensureMama('Mama view of her desktop') : '';
    if (!k) return;
    clearTimeout(this.watchRetry);
    this.startMama();
  }

  // ---------------- MAMA VIEW: raw, smooth, view-only ----------------
  async startMama() {
    this.mode = 'mama';
    this.mamaTried = Date.now();
    this.syncMamaBtn();
    clearTimeout(this.timer);
    const key = localStorage.getItem('jena.dmKey');
    const r = await fetch('/api/mama', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': key || '' }, body: JSON.stringify({ action: 'watch' }) })
      .then((x) => x.json().then((d) => ({ status: x.status, ...d }))).catch(() => null);
    if (!r || !r.ok || !r.ws) {
      this.mamaWhy = r ? (r.error || r.summary || `status ${r.status}`) : 'no answer';
      if (r && r.status === 401) {   // the saved key was refused: a trusted device gets it back from its cookie, silently
        if (!this.reTrusted) { this.reTrusted = true; const { restoreTrust } = await import('./takeover.js'); if (await restoreTrust()) { this.startMama(); return; } }
        this.startPublic(); return;   // never trusted (or locked on purpose): the public view
      }
      // her box didn't answer this time (tunnel blip, cold server): stay on mama view, keep the last picture, try again soon
      this.mamaFails = (this.mamaFails || 0) + 1;
      if (this.state === 'live' && this.rfb) this.root.classList.add('is-reconnecting');
      else if (this.state !== 'live') this.asleep('reconnecting to her desktop…', true);
      else this.root.classList.add('is-reconnecting');
      if (this.mamaFails % 3 === 0) this.refetchConfig();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { if (this.mode === 'mama') this.startMama(); }, Math.min(15000, 2000 * this.mamaFails));
      return;
    }
    this.mamaFails = 0;
    this.reTrusted = false;
    let RFB;
    try { RFB = (await import('@novnc/novnc')).default; } catch { this.startPublic(); return; }
    try { this.rfb?.disconnect(); } catch {}
    this.vnc.querySelectorAll('div').forEach((el) => { el.style.position = 'absolute'; el.style.inset = '0'; el.dataset.old = '1'; });   // old picture stays under the new one until it connects
    this.vnc.style.display = 'block';
    this.imgs.forEach((im) => { im.style.opacity = '0'; });
    const rfb = new RFB(this.vnc, r.ws, { shared: true });
    rfb.viewOnly = true; rfb.scaleViewport = true; rfb.resizeSession = false; rfb.focusOnClick = false; rfb.showDotCursor = true;   // her cursor is drawn into the picture by the box too
    rfb.background = '#000';
    this.rfb = rfb;
    rfb.addEventListener('connect', () => { this.mamaOk = Date.now(); this.root.classList.remove('is-reconnecting'); this.vnc.querySelectorAll('[data-old]').forEach((el) => el.remove()); try { localStorage.setItem('jena.lastBox', this.base); } catch {} this.awake(); });
    rfb.addEventListener('disconnect', () => {
      if (this.rfb !== rfb) return;
      this.rfb = null;
      if (this.mode !== 'mama') return;
      // a blip never blanks the panel: the last picture stays with a small reconnecting dot
      this.root.classList.add('is-reconnecting');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.startMama(), this.mamaOk && Date.now() - this.mamaOk < 30000 ? WATCH_RETRY_MS : 1500);
    });
  }

  // ---------------- PUBLIC / OBS: censored frames, no flashing ----------------
  startPublic() {
    this.mode = 'public';
    this.syncMamaBtn();
    try { this.rfb?.disconnect(); } catch {}
    this.rfb = null;
    this.vnc.style.display = 'none';
    this.kick();
  }

  kick() { clearTimeout(this.timer); this.timer = setTimeout(() => this.next(), 0); }

  async next() {
    clearTimeout(this.timer);
    if (!this.base || this.mode !== 'public') return;
    if (document.hidden && !OBS) { this.timer = setTimeout(() => this.next(), 2000); return; }
    const t0 = performance.now();
    let ok = false;
    try {
      const q = `${this.seq != null ? `since=${this.seq}&` : ''}${OBS ? 'obs=1&' : ''}t=${Date.now()}`;
      const res = await fetch(`${this.base}/box/shot.jpg?${q}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (res.status === 204) ok = true;
      else if (res.ok) {
        const blob = await res.blob();
        this.seq = await readSeq(blob);
        ok = await this.show(URL.createObjectURL(blob));
      }
    } catch { ok = false; }
    if (ok) { this.fails = 0; this.lastOk = Date.now(); this.root.classList.remove('is-reconnecting'); }
    else {
      this.fails++;
      // a tunnel hiccup never blanks the panel: the last good frame stays up with a small "reconnecting" dot;
      // only 20 s+ with nothing at all is "napping"
      const quiet = Date.now() - (this.lastShown || 0);
      if (this.fails % 3 === 0) this.refetchConfig();   // her tunnel address may have changed: ask the site again
      if (this.state === 'live' && quiet < 60000) this.root.classList.add('is-reconnecting');
      else if (this.fails >= 6 && quiet >= 60000 && this.state !== 'asleep' && this.censor?.age_ms > 60000) this.asleep("her machine is napping. it'll wake up when she does");
      else if (this.state !== 'live') this.asleep('reconnecting to her desktop…', true);
    }
    // long-poll answers as soon as there is a new frame; old boxes (no seq) are polled ~3/s
    const wait = !ok ? Math.min(30000, 1500 * this.fails) : this.seq != null ? 0 : Math.max(0, 330 - (performance.now() - t0));
    this.timer = setTimeout(() => this.next(), wait);
  }

  show(src) {
    // viewer-facing layout while mama's private popup is up: keep the last clean frame (main.js sets hold)
    if (this.hold) { try { URL.revokeObjectURL(src); } catch {} return Promise.resolve(true); }
    return new Promise((resolve) => {
      const back = this.imgs[1 - this.front];
      back.onload = () => {
        back.onload = back.onerror = null;
        // swap only once the new picture is decoded: the old one stays up until then (no blank, no card flash)
        back.style.opacity = '1';
        const old = this.imgs[this.front];
        old.style.opacity = '0';
        if (old.src.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(old.src), 1000);
        this.front = 1 - this.front;
        this.frames++;
        this.lastShown = Date.now();
        if (this.frames % 20 === 1) try { localStorage.setItem('jena.lastBox', this.base); } catch {}
        const now = performance.now();
        this.shown = this.shown.filter((t) => now - t < 10000); this.shown.push(now);
        const fw = back.naturalWidth, fh = back.naturalHeight;
        if (fw && fh) this.root.style.setProperty('--desk-ar', `${fw} / ${fh}`);
        this.fitInfo = { fw, fh, W: this.screen.clientWidth, H: this.screen.clientHeight, mode: 'censored' };
        if (this.state !== 'live') this.awake();
        resolve(true);
      };
      back.onerror = () => { back.onload = back.onerror = null; URL.revokeObjectURL(src); resolve(false); };
      back.src = src;
    });
  }

  // measured on this device: new censored frames shown per second over the last 10 s
  stats() {
    const now = performance.now();
    return { mode: this.mode, fps: Math.round((this.shown.filter((t) => now - t < 10000).length / 10) * 100) / 100, frames: this.frames, seq: this.seq, box: this.censor, mamaWhy: this.mamaWhy || null };
  }

  async pollStatus() {
    if (!this.base || document.hidden) return;
    const s = await fetch(`${this.base}/box/censor.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    this.censor = s;
    if (!s) return;   // a missed status poll changes nothing on screen
    // debounced: the badge's private state only flips after two polls in a row agree
    const priv = s.state === 'private';
    this.privRun = priv === this.privLast ? (this.privRun || 0) + 1 : 1; this.privLast = priv;
    if (this.privRun >= 2) this.root.classList.toggle('is-private', this.mode === 'public' && priv);
    // mama view is ALWAYS raw: no lock card, no sign-in text, nothing censored (Saidie's rule). Lock cards are public/OBS only.
    this.paintBadge();
  }

  paintBadge() {
    if (this.state !== 'live') return;
    const s = this.censor || {};
    const air = s.live ? '● LIVE' : 'OFF-AIR';
    if (this.mode === 'mama') {
      this.badge.textContent = `MAMA VIEW · ${air}`;
      this.badge.title = 'only you see this: raw, full speed, view-only. The public/OBS view stays privacy-filtered.';
    } else {
      this.badge.textContent = s.state === 'private' ? `${air} · 🔒` : air;
      this.badge.title = `privacy-filtered on her box${s.live ? ' (strict: live)' : ''}${s.fps != null ? ` · ${s.fps} new frames/s` : ''}`;
    }
    this.badge.classList.toggle('on-air', !!s.live);
  }

  fit() {}   // the <img> covers the panel by itself (object-fit: cover); noVNC scales itself

  teardown() {
    clearTimeout(this.timer);
    try { this.rfb?.disconnect(); } catch {}
    this.imgs.forEach((im) => { im.removeAttribute('src'); im.style.opacity = '0'; });
  }

  awake() {
    this.state = 'live';
    this.root.classList.add('is-live');
    this.root.classList.remove('is-asleep', 'is-waking');
    this.badge.textContent = this.mode === 'mama' ? 'MAMA VIEW' : 'OFF-AIR';
    this.paintBadge();
  }

  asleep(why, waking = false) {
    this.state = waking ? 'waking' : 'asleep';
    this.root.classList.remove('is-live', 'is-private', 'is-reconnecting');
    this.root.classList.toggle('is-waking', waking);
    this.root.classList.toggle('is-asleep', !waking);
    this.badge.textContent = waking ? 'CONNECTING' : 'ASLEEP';
    this.sleep.querySelector('.why').textContent = why;
    if (!waking) this.imgs.forEach((im) => { im.style.opacity = '0'; });
  }
}
