// What she's watching while she does a learned move: the real video (YouTube embed, so it plays at the video's own
// frame rate) with the skeleton she tracked drawn over it in sync. The tracking was done offline on EVERY frame of
// the clip (moves-pipeline/overlay.py, MediaPipe VIDEO mode, smoothed with zero lag) and is drawn on each screen
// refresh, interpolated between tracked frames, against a video clock that is extrapolated between the player's
// coarse time reports, so the skeleton glides instead of stepping.
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32], [15, 17], [15, 19], [15, 21], [17, 19], [16, 18], [16, 20], [16, 22], [18, 20],
  [0, 2], [0, 5], [2, 7], [5, 8], [9, 10]];
const OFFSET = 0.4; // the clip pipeline trims 0.4 s off the front of the source section

let apiReady = null;
function ytApi() {
  if (apiReady) return apiReady;
  apiReady = new Promise((res, rej) => {
    if (window.YT?.Player) return res(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { try { prev?.(); } catch {} res(window.YT); };
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.async = true;
    s.onerror = () => { apiReady = null; rej(new Error('youtube api blocked')); };
    document.head.appendChild(s);
    setTimeout(() => rej(new Error('youtube api timeout')), 15000);
  });
  return apiReady;
}

const overlays = new Map();
async function loadOverlay(url) {
  if (overlays.has(url)) return overlays.get(url);
  const p = fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  overlays.set(url, p);
  return p;
}

export class WatchVideo {
  constructor() {
    this.active = null;
    this.stats = { drawFps: 0, overlayFps: 0, sourceFps: 0, playing: false };
    window.__jenaWatch2 = this;
  }

  // anchor: the <a> wrapping the card's thumbnail. meta: the clip's library entry. playing: moves.playing.
  async play(anchor, meta, playing, overlayUrl) {
    const vid = /[?&]v=([\w-]{11})/.exec(meta.source?.url || '')?.[1];
    if (!anchor || !vid) return;
    this.stop();
    const src = meta.source || {};
    const t0 = (+src.start || 0) + OFFSET + (+playing?.start || 0);
    const box = document.createElement('div');
    box.className = 'thumb watch';
    box.innerHTML = '<div class="watch-video"></div><canvas class="watch-overlay"></canvas><span class="watch-tag">● watching · her tracking</span>';
    const img = anchor.querySelector('img');
    anchor.replaceChildren(box);
    const cv = box.querySelector('canvas');
    const st = { box, anchor, img, cv, player: null, raf: 0, ov: null, alive: true, vt: t0, at: performance.now(), lastRep: -1, rate: 1, frames: 0, idx: new Set(), sec: performance.now(), endAt: 0 };
    this.active = st;
    const [YT, ov] = await Promise.all([ytApi().catch(() => null), loadOverlay(overlayUrl)]);
    if (!st.alive) return;
    st.ov = ov;
    this.stats.sourceFps = ov?.source_fps || ov?.fps || 0;
    if (!YT) { this.restore(st); return; }
    st.player = new YT.Player(box.querySelector('.watch-video'), {
      videoId: vid, width: 160, height: 90,
      playerVars: { autoplay: 1, mute: 1, controls: 0, playsinline: 1, modestbranding: 1, rel: 0, disablekb: 1, fs: 0, iv_load_policy: 3, start: Math.floor(t0) },
      events: {
        onReady: (e) => { try { e.target.mute(); e.target.seekTo(t0, true); e.target.playVideo(); } catch {} },
        onStateChange: (e) => { this.stats.playing = e.data === 1; if (e.data === 1) { st.vt = e.target.getCurrentTime(); st.at = performance.now(); } },
        onError: () => this.restore(st),
      },
    });
    const loop = () => { if (!st.alive) return; this.draw(st); st.raf = requestAnimationFrame(loop); };
    st.raf = requestAnimationFrame(loop);
    // stop with the move (plus a beat), never run longer than 30 s
    const len = Math.min(30, ((+playing?.len || 10) / (+playing?.rate || 1)) + 1.5);
    st.endAt = performance.now() + len * 1000;
  }

  // the video's clock: the player reports time in coarse steps; between reports it advances with real time
  clock(st) {
    const p = st.player, now = performance.now();
    let rep = null, state = -1;
    try { rep = p?.getCurrentTime?.(); state = p?.getPlayerState?.(); } catch {}
    const playing = state === 1;
    const pred = st.vt + (playing ? (now - st.at) / 1000 * st.rate : 0);
    if (rep != null && rep !== st.lastRep) {
      st.lastRep = rep;
      if (Math.abs(rep - pred) > 0.25 || !playing) { st.vt = rep; st.at = now; return rep; }
      // a gentle pull toward the reported time so it never drifts
      st.vt = pred + (rep - pred) * 0.15; st.at = now; return st.vt;
    }
    if (!playing) { st.vt = pred; st.at = now; }
    return pred;
  }

  draw(st) {
    const now = performance.now();
    if (now > st.endAt) { try { st.player?.pauseVideo?.(); } catch {} st.alive = false; cancelAnimationFrame(st.raf); return; }
    const { cv, ov } = st;
    const W = cv.clientWidth || 160, H = cv.clientHeight || 90, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    st.frames++;
    if (now - st.sec >= 1000) {
      this.stats.drawFps = Math.round(st.frames * 1000 / (now - st.sec)); this.stats.overlayFps = Math.round(st.idx.size * 1000 / (now - st.sec));
      st.frames = 0; st.idx.clear(); st.sec = now;
    }
    if (!ov?.lm?.length) return;
    const t = this.clock(st) - (+ov.start || 0);
    const f = t * ov.fps;
    const i = Math.floor(f), a = f - i;
    const A = ov.lm[i], B = ov.lm[i + 1];
    if (!A) return;
    if (this.stats.playing) st.idx.add(i);
    // the video is letterboxed inside the 16:9 box
    const ar = ov.aspect || 16 / 9, boxAr = W / H;
    let vw = W, vh = H, ox = 0, oy = 0;
    if (ar > boxAr) { vh = W / ar; oy = (H - vh) / 2; } else { vw = H * ar; ox = (W - vw) / 2; }
    const pt = (k) => {
      const x = B ? A[k * 3] + (B[k * 3] - A[k * 3]) * a : A[k * 3];
      const y = B ? A[k * 3 + 1] + (B[k * 3 + 1] - A[k * 3 + 1]) * a : A[k * 3 + 1];
      return [ox + x / 1000 * vw, oy + y / 1000 * vh, A[k * 3 + 2]];
    };
    const P = []; for (let k = 0; k < 33; k++) P.push(pt(k));
    g.lineCap = 'round'; g.lineWidth = 1.6; g.strokeStyle = 'rgba(255,120,220,.95)'; g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 2;
    g.beginPath();
    for (const [p, q] of BONES) { if (P[p][2] < 3 || P[q][2] < 3) continue; g.moveTo(P[p][0], P[p][1]); g.lineTo(P[q][0], P[q][1]); }
    g.stroke();
    g.fillStyle = '#fff';
    for (let k = 11; k < 33; k++) { if (P[k][2] < 3) continue; g.beginPath(); g.arc(P[k][0], P[k][1], 1.5, 0, 6.3); g.fill(); }
  }

  restore(st) {
    st.alive = false; cancelAnimationFrame(st.raf);
    if (st.img && st.anchor.isConnected) st.anchor.replaceChildren(st.img);
  }

  // a new video replaces the old one; the old card goes back to its thumbnail
  stop() {
    const st = this.active; if (!st) return;
    try { st.player?.destroy?.(); } catch {}
    this.restore(st); this.active = null;
  }
}
