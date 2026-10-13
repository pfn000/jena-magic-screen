// Jena's virtual desktop panel. Two views, picked per device:
//  * MAMA VIEW (this device holds mama's dev passcode, not OBS): her smooth, RAW, full-fps desktop through a one-time
//    view-only token (/api/mama watch -> wss://box/websockify-watch?t=…, the view-only VNC). Never censored, never
//    public; a private sign-in window only adds a small corner pill. ?public=1 shows mama the public view instead.
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
    this.cover = document.createElement('a');   // mama view: a small corner pill while a private sign-in window is open
    this.cover.className = 'desk-signin-pill';
    this.cover.style.cssText = 'position:absolute;right:8px;bottom:8px;display:none;padding:5px 10px;border-radius:999px;background:rgba(46,33,66,.88);color:#f8eaff;font:700 12px system-ui;text-decoration:none;z-index:3;';
    this.cover.textContent = '🔑 sign-in window open';
    this.cover.addEventListener('click', (e) => {   // opens the sign-in window when the dev panel shows its card
      const open = document.querySelector('[data-ask-signin]');
      if (open) { e.preventDefault(); open.click(); } else if (!this.cover.getAttribute('href')) e.preventDefault();
    });
    this.screen.appendChild(this.cover);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && this.mode === 'public') this.kick(); });
    this.setUrl(url, true);
    setInterval(() => this.pollStatus(), 2500);
  }

  wantsMama() { return !OBS && qs.get('public') !== '1' && !!localStorage.getItem('jena.dmKey'); }

  setUrl(url, first = false) {
    const base = boxBase(url);
    if (!first && base === this.base) return;
    this.base = base;
    this.url = url;
    this.fails = 0;
    this.seq = null;
    if (!base) { this.asleep('no desktop stream configured yet'); return; }
    if (this.state !== 'live') this.asleep('waking up…', true);
    if (this.wantsMama()) this.startMama(); else this.startPublic();
  }

  // ---------------- MAMA VIEW: raw, smooth, view-only ----------------
  async startMama() {
    this.mode = 'mama';
    clearTimeout(this.timer);
    const key = localStorage.getItem('jena.dmKey');
    const r = await fetch('/api/mama', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': key || '' }, body: JSON.stringify({ action: 'watch' }) })
      .then((x) => x.json().then((d) => ({ status: x.status, ...d }))).catch(() => null);
    if (!r || !r.ok || !r.ws) {
      // wrong/old passcode or an older box without the watch door: the public (censored) view
      this.mamaWhy = r ? (r.error || r.summary || `status ${r.status}`) : 'no answer';
      this.startPublic();
      if (r && r.status !== 401) this.watchRetry = setTimeout(() => { if (this.mode === 'public' && this.wantsMama()) this.startMama(); }, 60000);
      return;
    }
    let RFB;
    try { RFB = (await import('@novnc/novnc')).default; } catch { this.startPublic(); return; }
    try { this.rfb?.disconnect(); } catch {}
    this.vnc.innerHTML = '';
    this.vnc.style.display = 'block';
    this.imgs.forEach((im) => { im.style.opacity = '0'; });
    const rfb = new RFB(this.vnc, r.ws, { shared: true });
    rfb.viewOnly = true; rfb.scaleViewport = true; rfb.resizeSession = false; rfb.focusOnClick = false; rfb.showDotCursor = true;   // her cursor is drawn into the picture by the box too
    rfb.background = '#000';
    this.rfb = rfb;
    rfb.addEventListener('connect', () => { this.mamaOk = Date.now(); this.awake(); });
    rfb.addEventListener('disconnect', () => {
      if (this.rfb !== rfb) return;
      this.rfb = null;
      if (this.mode !== 'mama') return;
      this.asleep('reconnecting mama view…', true);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.startMama(), WATCH_RETRY_MS);
    });
  }

  // ---------------- PUBLIC / OBS: censored frames, no flashing ----------------
  startPublic() {
    this.mode = 'public';
    try { this.rfb?.disconnect(); } catch {}
    this.rfb = null;
    this.vnc.style.display = 'none';
    this.cover.style.display = 'none';
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
      if (this.state === 'live' && quiet < 20000) this.root.classList.add('is-reconnecting');
      else if (this.fails >= 4 && quiet >= 20000 && this.state !== 'asleep') this.asleep("her machine is napping. it'll wake up when she does");
    }
    // long-poll answers as soon as there is a new frame; old boxes (no seq) are polled ~3/s
    const wait = !ok ? Math.min(30000, 1500 * this.fails) : this.seq != null ? 0 : Math.max(0, 330 - (performance.now() - t0));
    this.timer = setTimeout(() => this.next(), wait);
  }

  show(src) {
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
    if (this.mode === 'mama') {
      const on = s.reason === 'signin';
      this.cover.style.display = on ? 'block' : 'none';
      if (on) this.cover.textContent = document.querySelector('[data-ask-signin]') ? '🔑 sign-in window open, tap to open it' : '🔑 sign-in window open';
    }
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
