// Small helpers for her self-view panels (FACE, BODY, other angles). They render her scene into a tiny
// offscreen target and copy the pixels out. A plain readPixels makes the page WAIT for the GPU to finish
// everything (a stall on the main stage every time a panel refreshes, which is what made her look choppy).
// The async read (WebGL2 pixel-buffer + fence) lets the frame carry on and picks the pixels up when ready.
export const canReadAsync = (r) => !!(r?.capabilities?.isWebGL2 && typeof r.readRenderTargetPixelsAsync === 'function');

// on the page and not hidden (a collapsed panel costs nothing)
export const shown = (el) => !!(el && el.isConnected && el.getClientRects().length && !document.hidden);

// copy a GL (bottom-up) RGBA buffer into ImageData rows (top-down); opaque=true forces alpha 255
export function flipInto(src, img, w, h, opaque = false) {
  const dst = img.data, row = w * 4;
  for (let y = 0; y < h; y++) dst.set(src.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  if (opaque) for (let i = 3; i < dst.length; i += 4) dst[i] = 255;
}

// one-euro filter (Casiez et al.): smooths jitter when still, follows fast moves without lag
export class OneEuro {
  constructor(minCutoff = 1.5, beta = 0.6, dCutoff = 1.0) { this.mc = minCutoff; this.b = beta; this.dc = dCutoff; this.x = null; this.dx = 0; }
  static a(dt, fc) { const r = 2 * Math.PI * fc * dt; return r / (r + 1); }
  f(v, dt) {
    if (this.x == null || !(dt > 0)) { this.x = v; this.dx = 0; return v; }
    const dx = (v - this.x) / dt;
    this.dx += OneEuro.a(dt, this.dc) * (dx - this.dx);
    const fc = this.mc + this.b * Math.abs(this.dx);
    this.x += OneEuro.a(dt, fc) * (v - this.x);
    return this.x;
  }
}
