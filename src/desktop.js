// Live view of Jena's virtual desktop over noVNC (view-only). Falls back to a sleeping state
// whenever the stream is down, and keeps retrying quietly.
import RFB from '@novnc/novnc';

export class Desktop {
  constructor(root, { url }) {
    this.root = root;
    this.screen = root.querySelector('.desk-screen');
    this.sleep = root.querySelector('.desk-sleep');
    this.badge = root.querySelector('.desk-badge');
    this.url = url;
    this.rfb = null;
    this.retry = 4000;
    new ResizeObserver(() => this.fit()).observe(this.screen);
    setInterval(() => this.fit(), 2000); // her screen size can change when her machine restarts
    if (!url) this.asleep('no desktop stream configured yet');
    else this.connect();
  }

  setUrl(url) {
    if (url === this.url) return;
    this.url = url;
    this.teardown();
    this.connect();
  }

  connect() {
    if (!this.url) return;
    this.asleep('waking up…', true);
    try {
      const rfb = new RFB(this.screen, this.url, { shared: true });
      rfb.viewOnly = true;
      rfb.scaleViewport = false; // we scale it ourselves to COVER the panel edge to edge (no gray bars)
      rfb.clipViewport = false;
      rfb.resizeSession = false;
      rfb.background = 'transparent';
      rfb.qualityLevel = 7;
      rfb.compressionLevel = 4;
      rfb.addEventListener('connect', () => { this.retry = 4000; this.awake(); this.fit(); });
      rfb.addEventListener('disconnect', () => this.onDrop());
      rfb.addEventListener('securityfailure', () => this.onDrop());
      this.rfb = rfb;
    } catch (e) {
      this.onDrop();
    }
  }

  // cover-fit: scale her desktop so it fills the whole panel; her screen (1600x704) already matches the
  // panel's shape on the stage layout, and on phones the panel takes her screen's shape, so nothing is cut off there.
  fit() {
    const canvas = this.screen.querySelector('canvas');
    if (!canvas) return;
    const fw = canvas.width, fh = canvas.height;
    if (!fw || !fh) return;
    this.root.style.setProperty('--desk-ar', `${fw} / ${fh}`);
    const W = this.screen.clientWidth, H = this.screen.clientHeight;
    const s = Math.max(W / fw, H / fh);
    canvas.style.transformOrigin = '0 0';
    canvas.style.transform = `translate(${(W - fw * s) / 2}px, ${(H - fh * s) / 2}px) scale(${s})`;
    this.fitInfo = { fw, fh, W, H, scale: +s.toFixed(3) };
  }

  onDrop() {
    this.teardown();
    this.asleep("her machine is napping. it'll wake up when she does");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.retry);
    this.retry = Math.min(this.retry * 1.6, 30000);
  }

  teardown() {
    if (this.rfb) { try { this.rfb.disconnect(); } catch {} this.rfb = null; }
    this.screen.innerHTML = '';
  }

  awake() {
    this.root.classList.add('is-live');
    this.root.classList.remove('is-asleep', 'is-waking');
    this.badge.textContent = 'LIVE';
  }

  asleep(why, waking = false) {
    this.root.classList.remove('is-live');
    this.root.classList.toggle('is-waking', waking);
    this.root.classList.toggle('is-asleep', !waking);
    this.badge.textContent = waking ? 'CONNECTING' : 'ASLEEP';
    this.sleep.querySelector('.why').textContent = why;
  }
}
