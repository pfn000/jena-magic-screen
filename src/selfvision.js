// Jena's self-vision: a few times a second she looks at her own rendered body (the avatar canvas)
// with a real pose-detection model (MediaPipe Pose Landmarker, running in the browser on CPU/WASM)
// and says in the thought chain what she perceives, e.g. "I see my LEFT arm is up".
// Left/right are HER sides: she faces the camera, so her left side is on the right of the image.
const WASM = '/mediapipe/wasm';
const MODELS = ['/mediapipe/pose_landmarker_lite.task', 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'];
const BONES = [[11, 13], [13, 15], [12, 14], [14, 16], [11, 12], [11, 23], [12, 24], [23, 24]];

export class SelfVision {
  constructor(sourceCanvas, { log, view, label, intent, fps = 3 }) {
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
            runningMode: 'VIDEO', numPoses: 1,
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
    if (document.hidden || !this.src.width) return;
    const s = Math.min(1, 320 / Math.max(this.src.width, this.src.height));
    const w = Math.round(this.src.width * s), h = Math.round(this.src.height * s);
    if (this.work.width !== w || this.work.height !== h) { this.work.width = w; this.work.height = h; }
    const ctx = this.work.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#e9e2f5'; // her canvas is transparent; give the model a plain wall behind her
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(this.src, 0, 0, w, h);
    const res = this.pose.detectForVideo(this.work, performance.now());
    const lm = res?.landmarks?.[0];
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
    let text;
    if (arms.left === 'up' && arms.right === 'up') text = 'I see BOTH my arms are up';
    else if (arms.left === 'up') text = 'I see my LEFT arm is up';
    else if (arms.right === 'up') text = 'I see my RIGHT arm is up';
    else text = prev ? 'I see both my arms are down again' : 'I see myself standing, arms down';
    const meant = this.intent?.();
    if (meant) {
      const want = `${meant.left ? 'up' : 'down'}|${meant.right ? 'up' : 'down'}`;
      if (want !== `${arms.left}|${arms.right}`) text += ' (huh, not what I meant to do)';
    }
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
    if (this.label && this.last) this.label.textContent = `what I see · L ${this.last.left} · R ${this.last.right}`;
  }
}
