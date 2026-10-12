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
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = 'transparent';
      rfb.qualityLevel = 7;
      rfb.compressionLevel = 4;
      rfb.addEventListener('connect', () => { this.retry = 4000; this.awake(); });
      rfb.addEventListener('disconnect', () => this.onDrop());
      rfb.addEventListener('securityfailure', () => this.onDrop());
      this.rfb = rfb;
    } catch (e) {
      this.onDrop();
    }
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
