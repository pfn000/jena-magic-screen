// Motion tuning file (Saidie, Oct 20 1:38 PM): /motion-tuning.json is read at start and re-read whenever it changes
// (polled every few seconds), so the offline motion analysis can push better constants without a code change.
// Every key is optional; anything missing keeps its built-in default. Listeners get the merged object.
export const DEFAULT_TUNING = {
  version: 1,
  polish: { core: [1.4, 0.5], head: [1.6, 0.8], arms: [2.0, 0.9], legs: [2.2, 0.8], fingers: [2.6, 0.5], wristMaxDeg: 31, limits: true, smooth: true },
  face: { oneEuro: { blink: [6.0, 4.0], other: [2.2, 6.0] }, coarticulation: 0.35, lidFollow: 0.6 },
  camera: { omega: 2.6, modeOmega: 1.4, leadSec: 0.18, deadZone: 0.012 },
  moves: { fadeIn: 0.9, fadeOut: 1.1, minFade: 0.3, rate: [0.86, 1.1], amplitude: [0.82, 1.0], mirrorChance: 0.4, weights: {}, banned: [] },
  antiLoop: { history: 20, poseWindowSec: 3, poseSimilarity: 0.012 },
  telemetry: { enabled: 'local', hz: 120, batchSec: 4, jerkSpike: 2500, endpoint: '/motion-log' },
};
const merge = (a, b) => { if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b; const o = { ...a }; for (const k of Object.keys(b)) o[k] = (a && typeof a[k] === 'object' && !Array.isArray(a[k])) ? merge(a[k], b[k]) : b[k]; return o; };

export class Tuning {
  constructor(url = '/motion-tuning.json', { pollMs = 4000 } = {}) {
    this.url = url; this.v = structuredClone(DEFAULT_TUNING); this.listeners = []; this.text = null; this.loads = 0; this.error = null;
    this.ready = this.load();
    this.timer = setInterval(() => this.load(), pollMs);
  }
  async load() {
    try {
      const r = await fetch(this.url, { cache: 'no-store' });
      if (!r.ok) { this.error = 'http ' + r.status; return this.v; }
      const t = await r.text();
      if (t === this.text) return this.v;
      this.text = t; this.v = merge(structuredClone(DEFAULT_TUNING), JSON.parse(t)); this.loads++; this.error = null; this.at = Date.now();
      for (const f of this.listeners) { try { f(this.v); } catch (e) { console.warn('tuning listener', e); } }
    } catch (e) { this.error = String(e.message || e); }
    return this.v;
  }
  on(f) { this.listeners.push(f); try { f(this.v); } catch {} return () => { this.listeners = this.listeners.filter((x) => x !== f); }; }
  get() { return this.v; }
}
