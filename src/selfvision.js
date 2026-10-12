// Jena's self-vision: a few times a second she looks at her own rendered body (the avatar canvas)
// with a real pose-detection model (MediaPipe Pose Landmarker, running in the browser on CPU/WASM)
// and says in the thought chain what she perceives, e.g. "I see my LEFT arm is up".
// Left/right are HER sides: she faces the camera, so her left side is on the right of the image.
const WASM = '/mediapipe/wasm';
const q = new URLSearchParams(location.search);
const VARIANT = q.get('vision') === 'lite' ? 'lite' : 'full';
const MODELS = [`/mediapipe/pose_landmarker_${VARIANT}.task`, `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${VARIANT}/float16/1/pose_landmarker_${VARIANT}.task`];
import { Vector3 } from 'three';
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

export class SelfVision {
  constructor(sourceCanvas, { log, view, label, intent, felt, avatar, fps = 3 }) {
    this.avatar = avatar; // for her real joint positions (the skeleton overlay)
    this.felt = felt; // () => {left:'up'|'down', right} from her own body sense, to check her eyes against
    this.src = sourceCanvas;
    this.log = log;
    this.view = view; // optional <canvas> to show what she sees
    this.label = label;
    this.intent = intent; // () => {left, right} from her own skeleton, to compare with what she sees
    this.fps = fps;
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
    const run = () => {
      try { this.frame(); } catch (e) { console.warn('self-vision frame', e); }
      setTimeout(run, 1000 / this.fps);
    };
    run();
  }

  frame() {
    const m = this.intent?.();
    if (m) { const k = `${m.left ? 'up' : 'down'}|${m.right ? 'up' : 'down'}`; if (k !== this.intentKey) { this.intentKey = k; this.intentSince = performance.now(); } }
    if (document.hidden || !this.src.width) return;
    // look at ALL of her, head to feet, from the front (the box comes from where her joints really are)
    const box = this.bodyBox();
    if (!box) return;
    const { x0, y0, cw, ch } = box;
    const w = 160, h = 320;
    if (this.work.width !== w) { this.work.width = w; this.work.height = h; }
    this.crop = box;
    const ctx = this.work.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ece6f6'; // her canvas is transparent; give her eyes a plain wall behind her
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(this.src, x0, y0, cw, ch, 0, 0, w, h);
    if (!this.pose) return this.draw(null);
    const res = this.pose.detect(this.work); // each look is fresh: no tracking carried over from the last one
    const lm = res?.landmarks?.[0];
    this.lm = lm;
    this.draw(lm);
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

  draw(lm) {
    const v = this.view;
    if (!v) return;
    const w = this.work.width, h = this.work.height;
    if (v.width !== w || v.height !== h) { v.width = w; v.height = h; }
    const c = v.getContext('2d');
    c.drawImage(this.work, 0, 0);
    const b = this.crop;
    if (b) {
      const P = {};
      const at = (n) => (P[n] ??= (() => { const p = this.project(n); return p && { x: (p.x - b.x0) / b.cw * w, y: (p.y - b.y0) / b.ch * h }; })());
      c.lineWidth = 1.5; c.lineCap = 'round';
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
        c.fillStyle = '#fff'; c.beginPath(); c.arc(p.x, p.y, 2.2, 0, 7); c.fill();
        c.fillStyle = /^left/.test(n) ? '#0f766e' : /^right/.test(n) ? '#be185d' : '#6d28d9'; c.beginPath(); c.arc(p.x, p.y, 1.3, 0, 7); c.fill();
      }
      // which side is which, from HER point of view
      c.font = '700 10px system-ui, sans-serif';
      const lh = at('leftHand'), rh = at('rightHand');
      if (lh) { c.fillStyle = '#0f766e'; c.fillText('L', Math.min(w - 9, lh.x + 5), lh.y + 4); }
      if (rh) { c.fillStyle = '#be185d'; c.fillText('R', Math.max(2, rh.x - 12), rh.y + 4); }
    }
    if (this.label && this.last) {
      // a side her eyes get wrong (checked against what she feels) shows as '?' instead of a false claim
      const f = this.felt?.();
      const side = (s) => (f && f[s] !== this.last[s] ? '?' : this.last[s]);
      const ar = (x) => (x === 'up' ? '↑' : x === 'down' ? '↓' : '?');
      this.label.textContent = `body · eyes L${ar(side('left'))} R${ar(side('right'))}`;
    }
  }
}
