// Jena's virtual desktop for the public site and OBS: CENSORED frames only, never the raw VNC stream.
// Her box OCRs every frame and blacks out emails, IPs, codes, keys and phone numbers before it leaves her
// machine; sign-in pages, inboxes, keys in a terminal, mama driving, or a filter hiccup/lag over 2 s turn the
// whole picture into a "private moment" card (box/desktop/jena_censor.py). This view just polls that picture
// (/box/shot.jpg, ~2 per second at most; the box's honest pace is lower when it's busy).
// Mama's raw takeover lives only in the passcode dev panel.

const POLL_MS = 500;

// wss://host/websockify (what /api/config announces) or https://host -> https://host
export function boxBase(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url).trim());
    const proto = u.protocol === 'wss:' || u.protocol === 'https:' ? 'https:' : 'http:';
    return `${proto}//${u.host}`;
  } catch { return null; }
}

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
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.kick(); });
    this.setUrl(url, true);
    setInterval(() => this.pollStatus(), 2500);
  }

  setUrl(url, first = false) {
    const base = boxBase(url);
    if (!first && base === this.base) return;
    this.base = base;
    this.url = url;
    this.fails = 0;
    if (!base) { this.asleep('no desktop stream configured yet'); return; }
    this.asleep('waking up…', true);
    this.kick();
  }

  kick() { clearTimeout(this.timer); this.timer = setTimeout(() => this.next(), 0); }

  next() {
    clearTimeout(this.timer);
    if (!this.base) return;
    if (document.hidden && !document.body.classList.contains('obs')) { this.timer = setTimeout(() => this.next(), 2000); return; }
    const t0 = performance.now();
    const back = this.imgs[1 - this.front];
    const done = (ok) => {
      back.onload = back.onerror = null;
      if (ok) {
        this.fails = 0;
        this.frames++;
        back.style.opacity = '1';
        this.imgs[this.front].style.opacity = '0';
        this.front = 1 - this.front;
        const fw = back.naturalWidth, fh = back.naturalHeight;
        if (fw && fh) this.root.style.setProperty('--desk-ar', `${fw} / ${fh}`);
        this.fitInfo = { fw, fh, W: this.screen.clientWidth, H: this.screen.clientHeight, mode: 'censored' };
        if (this.state !== 'live') this.awake();
      } else if (++this.fails >= 3) {
        this.asleep("her machine is napping. it'll wake up when she does");
      }
      const wait = ok ? Math.max(0, POLL_MS - (performance.now() - t0)) : Math.min(30000, 2000 * this.fails);
      this.timer = setTimeout(() => this.next(), wait);
    };
    back.onload = () => done(true);
    back.onerror = () => done(false);
    back.src = `${this.base}/box/shot.jpg?t=${Date.now()}`;
  }

  async pollStatus() {
    if (!this.base || this.state === 'asleep' || document.hidden) return;
    const s = await fetch(`${this.base}/box/censor.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    this.censor = s;
    if (this.state === 'live') this.badge.textContent = s && s.state === 'private' ? 'PRIVATE' : 'LIVE';
    this.root.classList.toggle('is-private', !!(s && s.state === 'private'));
  }

  fit() {}   // the <img> covers the panel by itself (object-fit: cover)

  teardown() { clearTimeout(this.timer); this.imgs.forEach((im) => { im.removeAttribute('src'); im.style.opacity = '0'; }); }

  awake() {
    this.state = 'live';
    this.root.classList.add('is-live');
    this.root.classList.remove('is-asleep', 'is-waking');
    this.badge.textContent = 'LIVE';
    this.badge.title = 'privacy-filtered: private stuff is blacked out on her box before it leaves';
  }

  asleep(why, waking = false) {
    this.state = waking ? 'waking' : 'asleep';
    this.root.classList.remove('is-live', 'is-private');
    this.root.classList.toggle('is-waking', waking);
    this.root.classList.toggle('is-asleep', !waking);
    this.badge.textContent = waking ? 'CONNECTING' : 'ASLEEP';
    this.sleep.querySelector('.why').textContent = why;
    if (!waking) this.imgs.forEach((im) => { im.style.opacity = '0'; });
  }
}
