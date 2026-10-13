// What she's watching while she does a learned move: the real clip she learned it from, playing at the video's own
// frame rate, with the skeleton she tracked drawn over it frame-for-frame. The tracking was done offline on EVERY
// frame of the clip (moves-pipeline/overlay.py, MediaPipe VIDEO mode, smoothed with zero lag). The clip itself is a
// small muted mp4 next to it (public/moves/<id>.mp4, same frames as the tracking), and the skeleton is drawn on each
// frame the browser actually presents (requestVideoFrameCallback), so the two never drift. Clips without a local mp4
// (learned on her box) fall back to the YouTube embed with a time-extrapolated overlay.
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
function loadOverlay(url) {
  if (!overlays.has(url)) overlays.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return overlays.get(url);
}

export class WatchVideo {
  constructor() {
    this.active = null;
    // videoFps: frames per second the browser actually presented (measured); overlayFps: skeleton redraws per second
    this.stats = { mode: null, videoFps: 0, overlayFps: 0, sourceFps: 0, dropped: 0, playing: false, error: null };
    window.__jenaWatch2 = this;
  }

  // anchor: the <a> wrapping the card's thumbnail. meta: the clip's library entry. playing: moves.playing.
  async play(anchor, meta, playing, overlayUrl) {
    const vid = /[?&]v=([\w-]{11})/.exec(meta.source?.url || '')?.[1];
    if (!anchor) return;
    this.stop();
    const box = document.createElement('div');
    box.className = 'thumb watch';
    box.innerHTML = '<canvas class="watch-overlay"></canvas><span class="watch-tag">● watching · her tracking</span>';
    const img = anchor.querySelector('img');
    anchor.replaceChildren(box);
    const st = { box, anchor, img, cv: box.querySelector('canvas'), alive: true, ov: null, raf: 0, n: 0, sec: performance.now(), pf0: null, lastIdx: -1,
      from: OFFSET + (+playing?.start || 0), len: Math.min(30, ((+playing?.len || 10) / (+playing?.rate || 1)) + 1.5) };
    this.active = st;
    st.ov = await loadOverlay(overlayUrl);
    if (!st.alive) return;
    this.stats.sourceFps = st.ov?.source_fps || st.ov?.fps || 0;
    const mp4 = overlayUrl.replace(/-overlay\.json$/, '.mp4');
    const ok = await this.playLocal(st, mp4);
    if (!st.alive || ok) return;
    if (vid) this.playYouTube(st, vid, meta); else this.restore(st);
  }

  // the local clip: exact frame sync
  playLocal(st, src) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.className = 'watch-video'; v.muted = true; v.defaultMuted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
      v.preload = 'auto'; v.src = src;
      st.video = v;
      let settled = false;
      const fail = () => { if (settled) return; settled = true; v.remove(); st.video = null; resolve(false); };
      v.addEventListener('error', fail, { once: true });
      setTimeout(() => { if (!settled && v.readyState < 1) fail(); }, 8000);
      v.addEventListener('loadedmetadata', () => {
        if (settled) return; settled = true;
        st.box.prepend(v);
        this.stats.mode = 'clip';
        try { v.currentTime = Math.min(st.from, Math.max(0, v.duration - 1)); } catch {}
        v.play().catch(() => {});
        st.endAt = performance.now() + st.len * 1000;
        v.addEventListener('playing', () => { this.stats.playing = true; });
        v.addEventListener('pause', () => { this.stats.playing = false; });
        if ('requestVideoFrameCallback' in v) {
          const onFrame = (now, md) => {
            if (!st.alive) return;
            this.frame(st, md.mediaTime, md.presentedFrames);
            if (performance.now() > st.endAt) { v.pause(); return; }
            v.requestVideoFrameCallback(onFrame);
          };
          v.requestVideoFrameCallback(onFrame);
        } else {
          const loop = () => { if (!st.alive) return; this.frame(st, v.currentTime, null); if (performance.now() > st.endAt) { v.pause(); return; } st.raf = requestAnimationFrame(loop); };
          st.raf = requestAnimationFrame(loop);
        }
        resolve(true);
      }, { once: true });
    });
  }

  // one presented video frame: count it, draw the skeleton for exactly that frame
  frame(st, mediaTime, presented) {
    const now = performance.now();
    const ov = st.ov;
    const idx = ov ? Math.round(mediaTime * ov.fps) : -1;
    if (idx !== st.lastIdx) { st.n++; st.lastIdx = idx; this.draw(st, idx, 0); }
    if (st.pf0 == null && presented != null) st.pf0 = { pf: presented, t: now };
    if (now - st.sec >= 1000) {
      this.stats.overlayFps = Math.round(st.n * 1000 / (now - st.sec));
      if (presented != null && st.pf0) { this.stats.videoFps = Math.round((presented - st.pf0.pf) * 1000 / (now - st.pf0.t)); st.pf0 = { pf: presented, t: now }; }
      else this.stats.videoFps = this.stats.overlayFps;
      try { this.stats.dropped = st.video?.getVideoPlaybackQuality?.().droppedVideoFrames || 0; } catch {}
      st.n = 0; st.sec = now;
    }
  }

  draw(st, idx, a) {
    const { cv, ov } = st;
    const W = cv.clientWidth || 160, H = cv.clientHeight || 90, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const A = ov?.lm?.[idx]; if (!A) return;
    const B = a ? ov.lm[idx + 1] : null;
    const ar = ov.aspect || 16 / 9, boxAr = W / H; // the video is letterboxed inside the 16:9 box (object-fit: contain)
    let vw = W, vh = H, ox = 0, oy = 0;
    if (ar > boxAr) { vh = W / ar; oy = (H - vh) / 2; } else { vw = H * ar; ox = (W - vw) / 2; }
    const P = [];
    for (let k = 0; k < 33; k++) {
      const x = B ? A[k * 3] + (B[k * 3] - A[k * 3]) * a : A[k * 3], y = B ? A[k * 3 + 1] + (B[k * 3 + 1] - A[k * 3 + 1]) * a : A[k * 3 + 1];
      P.push([ox + x / 1000 * vw, oy + y / 1000 * vh, A[k * 3 + 2]]);
    }
    g.lineCap = 'round'; g.lineWidth = 1.6; g.strokeStyle = 'rgba(255,120,220,.95)'; g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 2;
    g.beginPath();
    for (const [p, q] of BONES) { if (P[p][2] < 3 || P[q][2] < 3) continue; g.moveTo(P[p][0], P[p][1]); g.lineTo(P[q][0], P[q][1]); }
    g.stroke();
    g.fillStyle = '#fff';
    for (let k = 11; k < 33; k++) { if (P[k][2] < 3) continue; g.beginPath(); g.arc(P[k][0], P[k][1], 1.5, 0, 6.3); g.fill(); }
  }

  // fallback: YouTube embed (native fps), skeleton against an extrapolated player clock, interpolated between frames
  async playYouTube(st, vid, meta) {
    const YT = await ytApi().catch(() => null);
    if (!st.alive) return;
    if (!YT) { this.stats.error = 'youtube api'; this.restore(st); return; }
    this.stats.mode = 'youtube';
    const t0 = (+meta.source?.start || 0) + st.from;
    const holder = document.createElement('div'); holder.className = 'watch-video'; st.box.prepend(holder);
    st.vt = t0; st.at = performance.now(); st.lastRep = -1; st.endAt = performance.now() + st.len * 1000;
    st.player = new YT.Player(holder, {
      videoId: vid, width: 160, height: 90,
      playerVars: { autoplay: 1, mute: 1, controls: 0, playsinline: 1, modestbranding: 1, rel: 0, disablekb: 1, fs: 0, iv_load_policy: 3, start: Math.floor(t0), origin: location.origin },
      events: {
        onReady: (e) => { try { e.target.mute(); e.target.seekTo(t0, true); e.target.playVideo(); } catch {} },
        onStateChange: (e) => { this.stats.playing = e.data === 1; if (e.data === 1) { st.vt = e.target.getCurrentTime(); st.at = performance.now(); } },
        onError: (e) => { this.stats.error = 'youtube ' + e.data; this.restore(st); },
      },
    });
    const loop = () => {
      if (!st.alive) return;
      const now = performance.now();
      if (now > st.endAt) { try { st.player?.pauseVideo?.(); } catch {} return; }
      let rep = null, state = -1;
      try { rep = st.player?.getCurrentTime?.(); state = st.player?.getPlayerState?.(); } catch {}
      const pred = st.vt + (state === 1 ? (now - st.at) / 1000 : 0);
      let t = pred;
      if (rep != null && rep !== st.lastRep) { st.lastRep = rep; t = Math.abs(rep - pred) > 0.25 || state !== 1 ? rep : pred + (rep - pred) * 0.15; st.vt = t; st.at = now; }
      if (st.ov) { const f = (t - (+st.ov.start || 0)) * st.ov.fps, i = Math.floor(f); this.draw(st, i, f - i); }
      st.raf = requestAnimationFrame(loop);
    };
    st.raf = requestAnimationFrame(loop);
  }

  restore(st) {
    st.alive = false; cancelAnimationFrame(st.raf);
    try { st.video?.pause(); } catch {}
    if (st.img && st.anchor.isConnected) st.anchor.replaceChildren(st.img);
  }

  // a new video replaces the old one; the old card goes back to its thumbnail
  stop() {
    const st = this.active; if (!st) return;
    try { st.player?.destroy?.(); } catch {}
    this.restore(st); this.active = null;
  }
}
