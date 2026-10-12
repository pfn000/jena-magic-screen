// Jena's body: a VRM rendered live with three.js + @pixiv/three-vrm on a transparent canvas.
// Idle life (breathing, sway, head drift, eye saccades), natural blinking, mood expressions,
// lip flap while talking, and target-based arm control. Left/right always mean JENA'S left/right.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const MOODS = ['happy', 'angry', 'sad', 'surprised', 'relaxed', 'neutral'];
const ALIASES = { joy: 'happy', fun: 'relaxed', sorrow: 'sad', mad: 'angry', shock: 'surprised', calm: 'relaxed', smug: 'relaxed' };
const damp = (cur, target, lambda, dt) => THREE.MathUtils.damp(cur, target, lambda, dt);

// Rest pose and poses, in normalized bone space (VRM 1.0 conventions, model faces the camera).
// For her LEFT upper arm, +z lifts the arm up toward her head; for her RIGHT arm it's -z.
const REST = {
  leftUpperArm: [0.05, 0, -1.22], rightUpperArm: [0.05, 0, 1.22],
  leftLowerArm: [0, -0.25, -0.08], rightLowerArm: [0, 0.25, 0.08],
  leftHand: [0, 0, -0.1], rightHand: [0, 0, 0.1],
};
// Raised ("hand up, like in class"): upper arm lifted out to the side and up, forearm turned so the
// palm faces forward (x twist), elbow softly bent so the hand leans in toward her head (y flex).
// Right side mirrors the left: x stays, y and z flip.
const RAISED = {
  left: { leftUpperArm: [0, 0, 1.2], leftLowerArm: [-1.5, -0.45, 0], leftHand: [0, 0, 0] },
  right: { rightUpperArm: [0, 0, -1.2], rightLowerArm: [-1.5, 0.45, 0], rightHand: [0, 0, 0] },
};

export class Avatar {
  constructor(canvas, { onStatus } = {}) {
    this.canvas = canvas;
    this.onStatus = onStatus || (() => {});
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(22, 1, 0.1, 50);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(0.6, 1.6, 2.2);
    const rim = new THREE.DirectionalLight(0xffd6f0, 1.2);
    rim.position.set(-1.5, 2, -1.5);
    this.scene.add(key, rim, new THREE.AmbientLight(0xffffff, 0.9));
    this.clock = new THREE.Timer();
    this.vrm = null;
    this.pose = {}; // bone -> current [x,y,z]
    this.target = structuredClone(REST);
    this.mood = { name: 'neutral', weights: Object.fromEntries(MOODS.map((m) => [m, 0])), until: 0 };
    this.blink = { next: 2, t: -1, double: false };
    this.talk = { until: 0, shape: 'aa', next: 0 };
    this.wave = null;
    this.armTimers = {};
    this.look = { y: 0, x: 0, ty: 0, tx: 0, until: 0 }; // head/eye turn she chooses (radians; +y = toward HER left)
    this.gaze = new THREE.Object3D();
    this.gazeOffset = new THREE.Vector3();
    this.nextSaccade = 0;
    this.height = 1.5;
    this.ready = false;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  async load(url) {
    this.onStatus('loading', 0);
    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    const gltf = await loader.loadAsync(url, (e) => e.total && this.onStatus('loading', e.loaded / e.total));
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('not a VRM file');
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((o) => (o.frustumCulled = false));
    if (this.vrm) { this.scene.remove(this.vrm.scene); VRMUtils.deepDispose(this.vrm.scene); }
    this.vrm = vrm;
    this.scene.add(vrm.scene);
    this.scene.add(this.gaze);
    if (vrm.lookAt) vrm.lookAt.target = this.gaze;
    this.pose = {};
    vrm.update(0);
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    const hp = new THREE.Vector3();
    head.getWorldPosition(hp);
    this.height = hp.y + 0.13;
    this.headY = hp.y;
    this.frameCamera();
    this.ready = true;
    this.onStatus('ready', 1);
    return vrm;
  }

  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.frameCamera();
  }

  frameCamera() {
    // feet a little above the bottom (room for the name tag), headroom for a raised arm + speech bubble
    const bottom = -0.16, top = this.height + 0.36;
    const h = top - bottom;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distH = (h / 2) / Math.tan(fov / 2);
    const wantW = 0.95; // meters of width to keep in view
    const distW = (wantW / 2) / (Math.tan(fov / 2) * this.camera.aspect);
    const d = Math.max(distH, distW);
    const cy = (top + bottom) / 2;
    this.camera.position.set(0, cy, d);
    this.camera.lookAt(0, cy, 0);
  }

  // ---------- public API ----------
  setExpression(name, weight = 1, holdMs = 0) {
    name = ALIASES[name] || name;
    if (!MOODS.includes(name)) {
      // any other preset or custom expression on the model, e.g. 'blink', 'aa', 'lookUp'
      this.vrm?.expressionManager?.setValue(name, weight);
      return name;
    }
    this.mood.name = name;
    this.mood.peak = Math.max(0, Math.min(1, weight));
    this.mood.until = holdMs ? performance.now() + holdMs : 0;
    return name;
  }

  raiseArm(side = 'left', holdMs = 2600) {
    const sides = side === 'both' ? ['left', 'right'] : [side];
    for (const s of sides) {
      if (!RAISED[s]) throw new Error(`raiseArm: side must be 'left', 'right' or 'both' (got ${side})`);
      Object.assign(this.target, structuredClone(RAISED[s]));
      clearTimeout(this.armTimers[s]);
      if (holdMs) this.armTimers[s] = setTimeout(() => this.lowerArm(s), holdMs);
    }
    return sides;
  }

  lowerArm(side = 'both') {
    const sides = side === 'both' ? ['left', 'right'] : [side];
    for (const s of sides) {
      for (const b of ['UpperArm', 'LowerArm', 'Hand']) this.target[s + b] = [...REST[s + b]];
      if (this.wave?.side === s) this.wave = null;
    }
  }

  waveHand(side = 'right', ms = 2400) {
    this.raiseArm(side, ms);
    this.wave = { side, until: performance.now() + ms };
  }

  // Lip flap for roughly the time it takes to say `text`.
  talkFor(text) {
    const ms = Math.min(9000, 600 + String(text || '').length * 55);
    this.talk.until = performance.now() + ms;
    return ms;
  }

  // Turn head and eyes toward HER left/right (or up/down), for ms, then back to the camera.
  lookToward(dir = 'center', ms = 2500) {
    const m = { left: [0.38, 0], right: [-0.38, 0], up: [0, -0.18], down: [0, 0.2], center: [0, 0] }[dir] || [0, 0];
    this.look.ty = m[0]; this.look.tx = m[1];
    this.look.until = dir === 'center' ? 0 : performance.now() + ms;
    return dir;
  }

  // Ground truth from her own skeleton: which arms are raised right now (target pose, her sides).
  armState() {
    return { left: this.target.leftUpperArm?.[2] > 0.5, right: this.target.rightUpperArm?.[2] < -0.5 };
  }

  // Raw bone access for experiments: setBone('leftUpperLeg', {x: -0.6})
  setBone(name, rot = {}) {
    const cur = this.target[name] || [0, 0, 0];
    this.target[name] = [rot.x ?? cur[0], rot.y ?? cur[1], rot.z ?? cur[2]];
  }
  bones() {
    return this.vrm ? Object.keys(this.vrm.humanoid.humanBones) : [];
  }
  expressions() {
    return this.vrm?.expressionManager ? this.vrm.expressionManager.expressions.map((e) => e.expressionName) : [];
  }

  // ---------- per frame ----------
  frame() {
    this.clock.update();
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.getElapsed();
    const now = performance.now();
    const vrm = this.vrm;
    if (vrm) {
      const H = vrm.humanoid;
      // arms toward targets
      for (const [bone, tgt] of Object.entries(this.target)) {
        const cur = (this.pose[bone] ||= [...(REST[bone] || [0, 0, 0])]);
        for (let i = 0; i < 3; i++) cur[i] = damp(cur[i], tgt[i], 7, dt);
        const n = H.getNormalizedBoneNode(bone);
        if (n) n.rotation.set(cur[0], cur[1], cur[2]);
      }
      if (this.wave) {
        if (now > this.wave.until) this.wave = null;
        else {
          // side-to-side: the elbow flex axis, after the palm-forward twist, swings in her frontal plane
          const n = H.getNormalizedBoneNode(this.wave.side + 'LowerArm');
          if (n) n.rotation.y += Math.sin(t * 9) * 0.4;
        }
      }
      // idle life on top
      const breathe = Math.sin(t * 1.6);
      const set = (b, x, y, z) => { const n = H.getNormalizedBoneNode(b); if (n) n.rotation.set(x, y, z); };
      set('spine', 0.02 + breathe * 0.012, Math.sin(t * 0.5) * 0.03, Math.sin(t * 0.7) * 0.012);
      set('chest', breathe * 0.018, 0, 0);
      set('hips', 0, Math.sin(t * 0.45) * 0.04, Math.sin(t * 0.9) * 0.012);
      set('neck', Math.sin(t * 0.33) * 0.03, 0, 0);
      if (this.look.until && now > this.look.until) { this.look.ty = 0; this.look.tx = 0; this.look.until = 0; }
      this.look.y = damp(this.look.y, this.look.ty, 4, dt);
      this.look.x = damp(this.look.x, this.look.tx, 4, dt);
      set('head', Math.sin(t * 0.6) * 0.03 + this.look.x, Math.sin(t * 0.37) * 0.08 + this.look.y, Math.sin(t * 0.52) * 0.04);
      // legs: relaxed stance
      set('leftUpperLeg', 0, 0, 0.03); set('rightUpperLeg', 0, 0, -0.03);
      // eyes: follow camera with little saccades
      if (now > this.nextSaccade) {
        this.gazeOffset.set((Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.12, 0);
        this.nextSaccade = now + 800 + Math.random() * 2600;
      }
      this.gaze.position.copy(this.camera.position).add(this.gazeOffset);
      this.gaze.position.x += this.look.y * 2.2; this.gaze.position.y -= this.look.x * 2.2;
      this.updateFace(dt, t, now);
      vrm.update(dt);
    }
    this.renderer.render(this.scene, this.camera);
  }

  updateFace(dt, t, now) {
    const em = this.vrm.expressionManager;
    if (!em) return;
    if (this.mood.until && now > this.mood.until) { this.mood.name = 'neutral'; this.mood.until = 0; }
    for (const m of MOODS) {
      const goal = m === this.mood.name && m !== 'neutral' ? (this.mood.peak ?? 1) * (m === 'happy' ? 0.85 : 0.75) : 0;
      this.mood.weights[m] = damp(this.mood.weights[m], goal, 6, dt);
      em.setValue(m, this.mood.weights[m]);
    }
    // blink: quick close/open curve, random gaps, occasional double blink
    this.blink.next -= dt;
    if (this.blink.t < 0 && this.blink.next <= 0) this.blink.t = 0;
    let b = 0;
    if (this.blink.t >= 0) {
      this.blink.t += dt;
      const d = 0.16, x = this.blink.t / d;
      b = x < 0.5 ? x * 2 : Math.max(0, 2 - x * 2);
      if (this.blink.t > d) {
        this.blink.t = -1;
        this.blink.double = !this.blink.double && Math.random() < 0.18;
        this.blink.next = this.blink.double ? 0.12 : 1.8 + Math.random() * 4.2;
      }
    }
    // happy eyes already squint; keep blink from overshooting
    em.setValue('blink', b * (1 - this.mood.weights.happy * 0.6));
    // mouth
    let aa = 0, oh = 0;
    if (now < this.talk.until) {
      if (now > this.talk.next) { this.talk.shape = Math.random() < 0.65 ? 'aa' : 'oh'; this.talk.amp = 0.3 + Math.random() * 0.6; this.talk.next = now + 70 + Math.random() * 90; }
      const v = this.talk.amp * (0.6 + 0.4 * Math.sin(t * 30));
      if (this.talk.shape === 'aa') aa = v; else oh = v;
    }
    this._aa = damp(this._aa || 0, aa, 20, dt);
    this._oh = damp(this._oh || 0, oh, 20, dt);
    em.setValue('aa', this._aa);
    em.setValue('oh', this._oh);
  }
}
