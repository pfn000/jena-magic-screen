// REAL LIQUID GLASS — the refraction layer (Saidie, Oct 21 2026, 12:55 PM: "actually use liquid glass and not this weird
// frosted shit ... it can be blurred in the background, but like there needs to be also depth"). Three paths, best first:
//  1. N•OS WebGL (body.nos-gl; iPhone Safari included): src/nos/nos.js draws lens glass under every shell piece (clear: 1):
//     a sharp, slightly magnified middle, the rim bending what is behind it, a chromatic edge, thickness shading and a drop
//     shadow. The DOM layer only adds the rim light (glass.css "r3").
//  2. Chromium without N•OS GL (body.lg-refract): one SVG filter per piece, used as backdrop-filter: url(#…). Its displacement
//     map is built for that piece's exact size and corner radius, so the backdrop bends at the rim like a lens; red, green and
//     blue are displaced by different amounts (chromatic edge).
//  3. Anything else (Safari/Firefox without WebGL, where url() backdrop filters do nothing): clear glass with a mild blur,
//     rim highlights and depth, CSS only.
// The menu slide (the tab bubble's spring + jelly) is not touched here.
const SEL = ['#m-tabs', '#m-speak', '#m-top .m-id', '#m-top .m-actions', '#tip-btn', '#stage > .panel'];
const NS = 'http://www.w3.org/2000/svg';

export function mountLiquidGlass() {
  const body = document.body, Q = new URLSearchParams(location.search), ua = navigator.userAgent;
  if (Q.get('obs') === '1' || body.classList.contains('obs') || body.classList.contains('stream')) return null;
  // url() inside backdrop-filter renders only in Chromium (Blink); WebKit (every iOS browser) and Firefox ignore it
  const blink = !!navigator.userAgentData?.brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge|Opera/.test(b.brand)) || (/Chrome\/\d/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua));
  const allowed = blink && Q.get('lgsvg') !== '0';   // never on WebKit/Gecko, whatever the URL says
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
  svg.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none';
  body.append(svg);
  const items = new Map(); let uid = 0, raf = 0;

  // displacement map for a rounded rect: R/G = 128 + 127 * (x/y offset); 0 in the flat middle, strongest at the rim, pointing
  // inward (samples stay inside the piece), plus a faint inward pull everywhere = a touch of magnification (a lens)
  function mapFor(w, h, rad, bevel) {
    const s = Math.min(1, 220 / Math.max(w, h));
    const W = Math.max(8, Math.round(w * s)), H = Math.max(8, Math.round(h * s));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'), img = g.createImageData(W, H), D = img.data;
    const hw = W / 2, hh = H / 2, r = Math.min(rad * s, hw, hh), b = Math.max(2, bevel * s);
    const sd = (x, y) => { const qx = Math.abs(x - hw) - (hw - r), qy = Math.abs(y - hh) - (hh - r); return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const px = x + 0.5, py = y + 0.5, d = sd(px, py);
      let nx = sd(px + 0.5, py) - sd(px - 0.5, py), ny = sd(px, py + 0.5) - sd(px, py - 0.5);
      const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      const t = Math.min(1, Math.max(0, 1 + d / b)), prof = t * t * (3 - 2 * t) * t;   // eased, rim-heavy
      const mx = (hw - px) / hw * 0.08 * (1 - prof), my = (hh - py) / hh * 0.08 * (1 - prof);
      const dx = Math.max(-1, Math.min(1, -nx * prof + mx)), dy = Math.max(-1, Math.min(1, -ny * prof + my));
      const i = (y * W + x) * 4;
      D[i] = Math.round(128 + dx * 127); D[i + 1] = Math.round(128 + dy * 127); D[i + 2] = 128; D[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }
  function filterFor(id, card) {
    const f = document.createElementNS(NS, 'filter');
    f.id = id; f.setAttribute('color-interpolation-filters', 'sRGB');
    f.setAttribute('x', '0'); f.setAttribute('y', '0'); f.setAttribute('width', '100%'); f.setAttribute('height', '100%');
    const ch = (k) => ['1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'][k];
    f.innerHTML = `<feImage result="map" x="0" y="0" width="10" height="10" preserveAspectRatio="none"/>
      <feGaussianBlur in="SourceGraphic" stdDeviation="${card ? 1.6 : 0.5}" result="src"/>
      <feDisplacementMap in="src" in2="map" scale="0" xChannelSelector="R" yChannelSelector="G" result="d0"/>
      <feColorMatrix in="d0" type="matrix" values="${ch(0)}" result="c0"/>
      <feDisplacementMap in="src" in2="map" scale="0" xChannelSelector="R" yChannelSelector="G" result="d1"/>
      <feColorMatrix in="d1" type="matrix" values="${ch(1)}" result="c1"/>
      <feDisplacementMap in="src" in2="map" scale="0" xChannelSelector="R" yChannelSelector="G" result="d2"/>
      <feColorMatrix in="d2" type="matrix" values="${ch(2)}" result="c2"/>
      <feBlend in="c0" in2="c1" mode="screen" result="c01"/>
      <feBlend in="c01" in2="c2" mode="screen" result="rgb"/>
      <feColorMatrix in="rgb" type="saturate" values="1.3"/>`;
    svg.append(f);
    return f;
  }
  function update(el) {
    let it = items.get(el);
    const r = el.getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height);
    if (w < 4 || h < 4) return;
    const card = el.matches('#stage > .panel');
    if (!it) { it = { id: 'lgf-' + (++uid), card, w: 0, h: 0, key: '' }; it.f = filterFor(it.id, card); items.set(el, it); el.dataset.lgf = it.id; el.style.setProperty('--lgf', `url(#${it.id})`); }
    if (w === it.w && h === it.h) return;
    it.w = w; it.h = h;
    const img = it.f.querySelector('feImage'); img.setAttribute('width', w); img.setAttribute('height', h);
    const rad = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || h / 2, h / 2, w / 2);
    const bevel = card ? Math.min(26, h * 0.2, w * 0.2) : Math.min(20, h * 0.36);
    const scale = card ? 34 : Math.min(48, h * 0.75);   // offset (px) at the rim = scale / 2
    const sc = [1, 0.9, 0.8];   // red bends most, blue least: the chromatic edge
    it.f.querySelectorAll('feDisplacementMap').forEach((m, k) => m.setAttribute('scale', (scale * sc[k]).toFixed(1)));
    clearTimeout(it.t);   // a piece that is still animating (the bar folding) stretches its last map until it settles
    it.t = setTimeout(() => { const key = `${it.w}x${it.h}:${rad}:${bevel}`; if (key !== it.key) { it.key = key; img.setAttribute('href', mapFor(it.w, it.h, rad, bevel)); } }, it.key ? 140 : 0);
  }
  function scan() {
    raf = 0;
    const on = allowed && !body.classList.contains('nos-gl');   // N•OS's WebGL lens wins where it runs (one lens, not two)
    body.classList.toggle('lg-refract', on);
    if (!on) return;
    for (const s of SEL) for (const el of document.querySelectorAll(s)) { update(el); ro.observe(el); }
  }
  const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(scan); });
  const mo = new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(scan); });
  mo.observe(body, { attributes: true, attributeFilter: ['class'] });
  addEventListener('resize', () => { if (!raf) raf = requestAnimationFrame(scan); });
  setTimeout(scan, 0); setTimeout(scan, 1500); setTimeout(scan, 5000);
  return { scan, items };
}
