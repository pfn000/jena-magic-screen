// Jena's self-vision: a few times a second she looks at her own rendered body (the avatar canvas)
// with a real pose-detection model (MediaPipe Pose Landmarker, running in the browser on CPU/WASM)
// and says in the thought chain what she perceives, e.g. "I see my LEFT arm is up".
// Left/right are HER sides: she faces the camera, so her left side is on the right of the image.
const WASM = '/mediapipe/wasm';
const q = new URLSearchParams(location.search);
// phones get the lite pose model (about 3x cheaper on CPU); ?vision=full|lite overrides
const VARIANT = q.get('vision') === 'full' ? 'full' : q.get('vision') === 'lite' || matchMedia('(pointer: coarse)').matches ? 'lite' : 'full';
const MODELS = [`/mediapipe/pose_landmarker_${VARIANT}.task`, `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${VARIANT}/float16/1/pose_landmarker_${VARIANT}.task`];
import { Vector3, Color, PerspectiveCamera, WebGLRenderTarget, SRGBColorSpace } from 'three';
import { canReadAsync, shown, flipInto, OneEuro, panelPx } from './snapshot.js';
// her real skeleton, drawn from her own bones (so it always lines up): [from, to] humanoid bone names
const SKELETON = [
  ['hips', 'spine'], ['spine', 'chest'], ['chest', 'upperChest'], ['upperChest', 'neck'], ['chest', 'neck'], ['neck', 'head'],
  ...['left', 'right'].flatMap((s) => [
    ['neck', `${s}Shoulder`], [`${s}Shoulder`, `${s}UpperArm`], [`${s}UpperArm`, `${s}LowerArm`], [`${s}LowerArm`, `${s}Hand`],
    [`${s}Hand`, `${s}IndexProximal`], [`${s}Hand`, `${s}LittleProximal`], [`${s}Hand`, `${s}ThumbProximal`],
    ['hips', `${s}UpperLeg`], [`${s}UpperLeg`, `${s}LowerLeg`], [`${s}LowerLeg`, `${s}Foot`], [`${s}Foot`, `${s}Toes`],
  ]),
];
const JOINTS = ['head', 'neck', 'chest', 'hips', ...['left', 'right'].flatMap((s) => ['UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes'].map((b) => s + b))];
const _p = new Vector3();
const SNAP = [...new Set([...SKELETON.flat(), ...JOINTS])];

export class SelfVision {
  constructor(sourceCanvas, { log, view, label, intent, felt, avatar, fps = 3, viewHz = 24 }) {
    this.avatar = avatar; // for her real joint positions (the skeleton overlay)
    this.felt = felt; // () => {left:'up'|'down', right} from her own body sense, to check her eyes against
    this.src = sourceCanvas;
    this.log = log;
    this.view = view; // optional <canvas> to show what she sees
    this.label = label;
    this.intent = intent; // () => {left, right} from her own skeleton, to compare with what she sees
    this.fps = fps; // pose-model looks per second (backs off on slow devices, see lookEvery)
    this.viewHz = viewHz; // her BODY view redraws (render + async read, no stall)
    this.frameSeq = 0; this.lookedSeq = -1; this.lmF = [];
    this.work = document.createElement('canvas');
    this.state = null;
    this.pending = null;
    this.pendingCount = 0;
    this.lostSince = 0;
    this.saidLost = false;
    this.last = null;
  }

  async start() {
    this.loop(); // her body view draws from her own bones right away; her eyes join once the pose model loads
    try {
      const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
      const files = await FilesetResolver.forVisionTasks(WASM);
      let err;
      for (const modelAssetPath of MODELS) {
        try {
          this.pose = await PoseLandmarker.createFromOptions(files, {
            baseOptions: { modelAssetPath, delegate: 'CPU' },
            runningMode: 'IMAGE', numPoses: 1,
            minPoseDetectionConfidence: 0.3, minPosePresenceConfidence: 0.3, minTrackingConfidence: 0.3,
          });
          break;
        } catch (e) { err = e; }
      }
      if (!this.pose) throw err || new Error('no pose model');
      this.log('see', 'my eyes are on: I can see my own body now');
    } catch (e) {
      console.warn('self-vision off', e);
      this.log('status', `my self-vision didn't start (${String(e.message || e).slice(0, 80)})`);
    }
  }

  loop() {
    // her BODY view: re-rendered from her real scene ~24x a second, read back async (no stall on the stage)
    this.avatar?.frameHooks?.push(() => { try { this.tick(); } catch (e) { console.warn('self-vision view', e); } });
    // her EYES (the pose model): a few looks a second at the latest frame, run when the page is idle
    const run = () => {
      const go = () => { try { this.frame(); } catch (e) { console.warn('self-vision frame', e); } setTimeout(run, this.lookEvery()); };
      if (window.requestIdleCallback && canReadAsync(this.avatar?.renderer)) requestIdleCallback(go, { timeout: 300 }); else go();
    };
    run();
  }

  // the pose model blocks the page while it looks, so it never takes more than ~8% of the time
  lookEvery() { return Math.min(2000, Math.max(1000 / this.fps, (this.detectMs || 0) / 0.08)); }

  tick() {
    const m = this.intent?.();
    if (m) { const k = `${m.left ? 'up' : 'down'}|${m.right ? 'up' : 'down'}`; if (k !== this.intentKey) { this.intentKey = k; this.intentSince = performance.now(); } }
    const A = this.avatar, r = A?.renderer;
    if (this.reading || document.hidden || !this.src.width || !canReadAsync(r)) return;
    const now = performance.now();
    if (now - (this.lastView || 0) < 1000 / Math.max(this.viewHz, A?.panelHz?.() || 0)) return;   // up to 60 Hz when the device keeps up
    // nobody sees the panel (collapsed on phones): only render when her eyes are due a look
    if (!shown(this.view) && !(this.pose && now - (this.lastCapture || 0) > this.lookEvery() * 0.8)) return;
    const box = this.bodyBox();
    if (!box) return;
    this.lastView = now;
    // crisp: the panel's CSS size x the stage's current pixel ratio (native on a 3x phone, stepped down with the
    // stage by the quality governor); her eyes (MediaPipe) still look at a small 160x320 copy of it
    const px = shown(this.view) ? panelPx(this.view, A, 2, { min: 160 }) : null;
    const w = px ? px.w : 160, h = px ? px.h : 320;
    if (!this.rt || this.rtW !== w || this.rtH !== h) {
      this.rt?.dispose();
      this.rt = new WebGLRenderTarget(w, h); this.rt.texture.colorSpace = SRGBColorSpace; this.rtW = w; this.rtH = h;
      this.px = new Uint8Array(w * h * 4); this.img = new ImageData(w, h);
      this.cam ||= new PerspectiveCamera(); this.wall ||= new Color(0xece6f6);
    }
    // the same view as her stage camera, cropped to her body box (what the old canvas crop showed)
    const cam = this.cam;
    cam.copy(A.camera);
    cam.setViewOffset(this.src.width, this.src.height, box.x0, box.y0, box.cw, box.ch);
    cam.updateProjectionMatrix();
    const prev = r.getRenderTarget(), bg = A.scene.background;
    A.scene.background = this.wall; // her canvas is transparent; give her eyes a plain wall behind her
    r.setRenderTarget(this.rt); r.clear(); r.render(A.scene, cam); r.setRenderTarget(prev);
    A.scene.background = bg;
    // her joints as of THIS render, so the skeleton lines up with the pixels when they arrive
    const snap = {};
    for (const n of SNAP) snap[n] = this.project(n);
    this.reading = true;
    r.readRenderTargetPixelsAsync(this.rt, 0, 0, w, h, this.px).then(() => {
      if (this.work.width !== w) { this.work.width = w; this.work.height = h; }
      flipInto(this.px, this.img, w, h, true);
      this.work.getContext('2d', { willReadFrequently: true }).putImageData(this.img, 0, 0);
      this.crop = box; this.snap = snap; this.frameSeq++; this.lastCapture = now;
      const dt = this.lastPaint ? (now - this.lastPaint) / 1000 : 0; this.lastPaint = now;
      this.draw(null, { carry: true }); // a new frame: the last yellow read rides along with her body until the next read
    }).catch(() => {}).finally(() => { this.reading = false; });
  }

  // her eyes look a few times a second; in between, the yellow (video) skeleton glides to each new look
  // through a one-euro filter instead of jumping, so the overlay moves at the view's frame rate
  smoothLm(dt) {
    const lm = this.lm;
    if (!lm) { this.lmF = []; return null; }
    return lm.map((p, i) => {
      const f = (this.lmF[i] ||= [new OneEuro(2.0, 0.5), new OneEuro(2.0, 0.5)]);
      return { x: f[0].f(p.x, dt), y: f[1].f(p.y, dt), visibility: p.visibility };
    });
  }

  frame() {
    const async = canReadAsync(this.avatar?.renderer);
    if (!async) { // old browsers (no WebGL2): blocking crop of the stage canvas, like before
      const m = this.intent?.();
      if (m) { const k = `${m.left ? 'up' : 'down'}|${m.right ? 'up' : 'down'}`; if (k !== this.intentKey) { this.intentKey = k; this.intentSince = performance.now(); } }
    }
    if (document.hidden || !this.src.width) return;
    if (async) {
      if (!this.pose || this.frameSeq === this.lookedSeq) return; // nothing new to look at yet
      this.lookedSeq = this.frameSeq;
    } else {
      // look at ALL of her, head to feet, from the front (the box comes from where her joints really are)
      const box = this.bodyBox();
      if (!box) return;
      const { x0, y0, cw, ch } = box;
      const w = 160, h = 320;
      if (this.work.width !== w) { this.work.width = w; this.work.height = h; }
      this.crop = box; this.snap = null;
      const ctx = this.work.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ece6f6'; // her canvas is transparent; give her eyes a plain wall behind her
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(this.src, x0, y0, cw, ch, 0, 0, w, h);
      if (!this.pose) return this.draw(null);
    }
    // her eyes look at a small copy of this exact frame (detection cost doesn't grow with the panel's resolution)
    const det = (this.det ||= document.createElement('canvas'));
    if (det.width !== 160) { det.width = 160; det.height = 320; }
    const dctx = det.getContext('2d', { willReadFrequently: true });
    dctx.imageSmoothingEnabled = true; dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(this.work, 0, 0, 160, 320);
    const t0 = performance.now();
    const res = this.pose.detect(det); // each look is fresh: no tracking carried over from the last one
    const ms = performance.now() - t0;
    this.detectMs = this.detectMs == null ? ms : this.detectMs * 0.8 + ms * 0.2;
    const lm = res?.landmarks?.[0];
    // the YELLOW skeleton is MediaPipe's read of the rendered video. It used to be drawn on LATER frames (one
    // look behind, one-euro smoothed), so it trailed and detached from her legs while her rig lines (pink/teal,
    // projected from the same frame's bones) stayed on. Now it belongs to exactly the frame it was read from
    // (this.lmSeq) and is only drawn on that frame; a weak read (low landmark visibility) isn't drawn at all.
    const vis = lm ? [11, 12, 23, 24, 25, 26, 27, 28].reduce((a, i) => a + (lm[i]?.visibility ?? 0), 0) / 8 : 0;
    this.lm = lm && vis > 0.45 ? lm : null; this.lmSeq = this.frameSeq; this.lmVis = +vis.toFixed(2);
    this.lmFrame = { snap: this.snap, crop: this.crop, at: performance.now() };
    this.draw(this.lm, { fresh: true, paint: true }); // repaint this same frame with its own yellow read
    if (!lm) return this.lost();
    this.lostSince = 0;
    if (this.saidLost) { this.saidLost = false; this.log('see', 'I can see myself again'); }
    const arms = this.read(lm);
    if (!arms) return;
    this.last = arms;
    const key = `${arms.left}|${arms.right}`;
    if (key === this.state) { this.pending = null; return; }
    if (key !== this.pending) { this.pending = key; this.pendingCount = 1; return; }
    if (++this.pendingCount < 2) return; // must hold for two looks before she believes it
    const prev = this.state;
    this.state = key;
    this.pending = null;
    this.say(arms, prev);
  }

  // Which arm is up, from the landmarks, sided from HER point of view.
  read(lm) {
    const A = lm[11], B = lm[12];
    if (!A || !B) return null;
    // the shoulder on the right of the image is her LEFT (she faces the camera)
    const chainA = { sh: lm[11], el: lm[13], wr: lm[15] }, chainB = { sh: lm[12], el: lm[14], wr: lm[16] };
    const [herLeft, herRight] = A.x > B.x ? [chainA, chainB] : [chainB, chainA];
    const up = (c) => {
      const tip = (c.wr?.visibility ?? 1) > 0.2 ? c.wr : c.el;
      return !!tip && tip.y < c.sh.y - 0.02;
    };
    return { left: up(herLeft) ? 'up' : 'down', right: up(herRight) ? 'up' : 'down' };
  }

  say(arms, prev) {
    const desc = (a) => (a.left === 'up' && a.right === 'up' ? 'BOTH my arms are up' : a.left === 'up' ? 'my LEFT arm is up' : a.right === 'up' ? 'my RIGHT arm is up' : 'both my arms are down');
    // her eyes are checked against what she can feel; she never claims what her body says isn't true
    const felt = this.felt?.();
    if (felt && (felt.left !== arms.left || felt.right !== arms.right)) {
      const now = performance.now();
      if (now - (this.lastDoubt || -1e9) > 60000) {
        this.lastDoubt = now;
        this.log('see', `my eyes say ${desc(arms)}, but I can feel ${desc(felt)}, so I'm trusting my body`);
      }
      return;
    }
    let text;
    if (arms.left === 'down' && arms.right === 'down') text = prev ? 'I see both my arms are down again' : 'I see myself standing, arms down';
    else text = `I see ${desc(arms)}`;
    this.log('see', text);
  }

  lost() {
    if (!this.lostSince) this.lostSince = Date.now();
    if (!this.saidLost && Date.now() - this.lostSince > 8000) {
      this.saidLost = true;
      this.state = null;
      this.log('see', "I can't make out my own body right now");
    }
  }

  // her joints on the main canvas, in canvas pixels
  project(name) {
    const a = this.avatar, n = a?.vrm?.humanoid?.getNormalizedBoneNode(name);
    if (!n) return null;
    _p.setFromMatrixPosition(n.matrixWorld).project(a.camera);
    return { x: (_p.x + 1) / 2 * this.src.width, y: (1 - _p.y) / 2 * this.src.height };
  }

  // a 1:2 portrait box around her whole body (top of her head to below her feet), in canvas pixels
  bodyBox() {
    const head = this.project('head'), lf = this.project('leftToes') || this.project('leftFoot'), rf = this.project('rightToes') || this.project('rightFoot'), hips = this.project('hips');
    if (!head || !lf || !rf || !hips) return null;
    const feetY = Math.max(lf.y, rf.y), bodyH = feetY - head.y;
    const top = head.y - bodyH * 0.16, bottom = feetY + bodyH * 0.05;
    const ch = bottom - top, cw = ch / 2;
    return { x0: hips.x - cw / 2, y0: top, cw, ch };
  }

  draw(lm, { fresh = false, paint = true, carry = false } = {}) {
    const v = this.view;
    if (!v || (window.__jenaBodyView && window.__jenaBodyView !== 'front')) return; // another angle is being shown

    const w = this.work.width, h = this.work.height;
    let c;
    if (paint) {
      if (v.width !== w || v.height !== h) { v.width = w; v.height = h; }
      c = v.getContext('2d');
      c.drawImage(this.work, 0, 0);
    } else c = (this.scratch ||= document.createElement('canvas').getContext('2d')); // measuring only
    const b = this.crop;
    if (b) {
      const P = {};
      const at = (n) => (P[n] ??= (() => { const p = this.snap ? this.snap[n] : this.project(n); return p && { x: (p.x - b.x0) / b.cw * w, y: (p.y - b.y0) / b.ch * h }; })());
      const k = w / 160; // overlay keeps its proportions at any resolution
      c.lineWidth = 1.5 * k; c.lineCap = 'round';
      for (const [a, z] of SKELETON) {
        const p = at(a), q = at(z);
        if (!p || !q) continue;
        // HER left side (screen right) in teal, her right in pink, spine in violet
        c.strokeStyle = /^left/.test(z) ? '#14b8a6' : /^right/.test(z) ? '#ec4899' : '#8b5cf6';
        c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(q.x, q.y); c.stroke();
      }
      for (const n of JOINTS) {
        const p = at(n);
        if (!p) continue;
        c.fillStyle = '#fff'; c.beginPath(); c.arc(p.x, p.y, 2.2 * k, 0, 7); c.fill();
        c.fillStyle = /^left/.test(n) ? '#0f766e' : /^right/.test(n) ? '#be185d' : '#6d28d9'; c.beginPath(); c.arc(p.x, p.y, 1.3 * k, 0, 7); c.fill();
      }
      // DUAL TRACKING: what MediaPipe sees in the video (yellow) on top of her real rig (colored), and how far apart
      // between reads (her eyes look ~3x a second, the panel paints up to 60x), the last read is carried along
      // by how far each of her joints moved since the frame it was read from, so it stays ON her body; a read
      // older than 1.2 s is stale and hidden
      let shift = null;
      if (!lm && carry && this.lm && this.lmFrame?.snap && this.lmFrame.crop && performance.now() - this.lmFrame.at < 1200) {
        const F = this.lmFrame, swapped = !!this.agree?.mediapipeSwappedSides;
        const MAPc = { 11: 'leftUpperArm', 12: 'rightUpperArm', 13: 'leftLowerArm', 14: 'rightLowerArm', 15: 'leftHand', 16: 'rightHand', 23: 'leftUpperLeg', 24: 'rightUpperLeg', 25: 'leftLowerLeg', 26: 'rightLowerLeg', 27: 'leftFoot', 28: 'rightFoot' };
        shift = {};
        for (const [i, bone0] of Object.entries(MAPc)) {
          const bone = swapped ? bone0.replace(/^left|^right/, (x) => (x === 'left' ? 'right' : 'left')) : bone0;
          const then = F.snap[bone], now = at(bone);
          if (!then || !now) continue;
          shift[i] = { x: now.x - (then.x - F.crop.x0) / F.crop.cw * w, y: now.y - (then.y - F.crop.y0) / F.crop.ch * h };
        }
        lm = this.lm;
      }
      if (lm) {
        const MAP = { 11: 'leftUpperArm', 12: 'rightUpperArm', 13: 'leftLowerArm', 14: 'rightLowerArm', 15: 'leftHand', 16: 'rightHand', 23: 'leftUpperLeg', 24: 'rightUpperLeg', 25: 'leftLowerLeg', 26: 'rightLowerLeg', 27: 'leftFoot', 28: 'rightFoot' };
        const MP_LINES = [[11, 13], [13, 15], [12, 14], [14, 16], [11, 12], [23, 24], [11, 23], [12, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
        c.strokeStyle = 'rgba(250, 204, 21, 0.9)'; c.lineWidth = 1.2 * k;
        const Y = (i) => { const m = lm[i]; if (!m || m.visibility < 0.3) return null; const d = shift ? shift[i] : null; if (shift && !d) return null; return { x: m.x * w + (d ? d.x : 0), y: m.y * h + (d ? d.y : 0) }; };
        for (const [a, z] of MP_LINES) { const p = Y(a), q = Y(z); if (!p || !q) continue; c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(q.x, q.y); c.stroke(); }
        const sh = at('leftUpperArm'), hp = at('leftUpperLeg');
        const torso = sh && hp ? Math.hypot(sh.x - hp.x, sh.y - hp.y) : 0;
        if (fresh && torso > 4) {
          const errs = (swap) => Object.entries(MAP).map(([i, bone]) => {
            const m = lm[+i], r = at(swap ? bone.replace(/^left|^right/, (x) => (x === 'left' ? 'right' : 'left')) : bone);
            return m && r && m.visibility > 0.3 ? { bone, e: Math.hypot(m.x * w - r.x, m.y * h - r.y) / torso } : null;
          }).filter(Boolean);
          const direct = errs(false), mirrored = errs(true);
          const med = (a) => { const s = a.map((x) => x.e).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 1; };
          const swapped = med(mirrored) < med(direct) * 0.7;
          const use = swapped ? mirrored : direct;
          if (use.length >= 4) {
            const worst = use.reduce((a, b) => (b.e > a.e ? b : a));
            this.agree = { at: Date.now(), joints: use.length, medianPct: Math.round(med(use) * 100), worst: { joint: worst.bone, pct: Math.round(worst.e * 100) }, mediapipeSwappedSides: swapped };
            window.__jenaDualTracking = this.agree;
          }
        }
      }
      // which side is which, from HER point of view
      c.font = `700 ${Math.round(10 * k)}px system-ui, sans-serif`;
      const lh = at('leftHand'), rh = at('rightHand');
      if (lh) { c.fillStyle = '#0f766e'; c.fillText('L', Math.min(w - 9 * k, lh.x + 5 * k), lh.y + 4 * k); }
      if (rh) { c.fillStyle = '#be185d'; c.fillText('R', Math.max(2 * k, rh.x - 12 * k), rh.y + 4 * k); }
    }
    if (this.label && this.last) {
      // a side her eyes get wrong (checked against what she feels) shows as '?' instead of a false claim
      const f = this.felt?.();
      const side = (s) => (f && f[s] !== this.last[s] ? '?' : this.last[s]);
      const ar = (x) => (x === 'up' ? '↑' : x === 'down' ? '↓' : '?');
      this.label.textContent = `body · eyes L${ar(side('left'))} R${ar(side('right'))}${this.agree && Date.now() - this.agree.at < 5000 ? ` · rig↔video ${this.agree.medianPct}% apart` : ''}`;
    }
  }
}
