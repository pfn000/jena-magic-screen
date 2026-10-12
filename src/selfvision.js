// Jena's self-vision: a few times a second she looks at her own rendered body (the avatar canvas)
// with a real pose-detection model (MediaPipe Pose Landmarker, running in the browser on CPU/WASM)
// and says in the thought chain what she perceives, e.g. "I see my LEFT arm is up".
// Left/right are HER sides: she faces the camera, so her left side is on the right of the image.
const WASM = '/mediapipe/wasm';
const q = new URLSearchParams(location.search);
const VARIANT = q.get('vision') === 'lite' ? 'lite' : 'full';
const MODELS = [`/mediapipe/pose_landmarker_${VARIANT}.task`, `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${VARIANT}/float16/1/pose_landmarker_${VARIANT}.task`];
const BONES = [[11, 13], [13, 15], [12, 14], [14, 16], [11, 12], [11, 23], [12, 24], [23, 24]];

export class SelfVision {
  constructor(sourceCanvas, { log, view, label, intent, felt, fps = 3 }) {
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
      this.loop();
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
    // look at her upper body (head to hips, room above for raised hands): a square crop, centred on her
    const W = this.src.width, H = this.src.height;
    const S = Math.min(W, H * (+q.get('crop') || 0.5)), x0 = (W - S) / 2, y0 = 0;
    const w = 384, h = 384;
    if (this.work.width !== w) { this.work.width = w; this.work.height = h; }
    const ctx = this.work.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#e9e2f5'; // her canvas is transparent; give the model a plain wall behind her
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(this.src, x0, y0, S, S, 0, 0, w, h);
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

  draw(lm) {
    const v = this.view;
    if (!v) return;
    const w = this.work.width, h = this.work.height;
    if (v.width !== w || v.height !== h) { v.width = w; v.height = h; }
    const c = v.getContext('2d');
    c.drawImage(this.work, 0, 0);
    if (!lm) return;
    c.lineWidth = 3;
    c.strokeStyle = '#ff4fb4';
    for (const [a, b] of BONES) {
      if (!lm[a] || !lm[b]) continue;
      c.beginPath(); c.moveTo(lm[a].x * w, lm[a].y * h); c.lineTo(lm[b].x * w, lm[b].y * h); c.stroke();
    }
    c.fillStyle = '#2bd1a0';
    for (const i of [0, 11, 12, 13, 14, 15, 16]) if (lm[i]) { c.beginPath(); c.arc(lm[i].x * w, lm[i].y * h, 3.5, 0, 7); c.fill(); }
    if (this.label && this.last) {
      // a side her eyes get wrong (checked against what she feels) shows as '?' instead of a false claim
      const f = this.felt?.();
      const side = (s) => (f && f[s] !== this.last[s] ? '?' : this.last[s]);
      this.label.textContent = `I see: L ${side('left')} · R ${side('right')}`;
    }
  }
}
