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
// Arms hang relaxed: a little forward of the body, elbows softly bent, wrists loose.
// Upper arms a little out from her sides, elbows bowed out and bent (~25°) so the forearms come back
// in toward her thighs, wrists loose. Visible from the front, not a mannequin's straight arms.
const REST = {
  leftUpperArm: [-0.06, 0, -1.12], rightUpperArm: [-0.06, 0, 1.12],
  leftLowerArm: [0, -0.42, -0.3], rightLowerArm: [0, 0.42, 0.3],
  leftHand: [0, -0.15, -0.18], rightHand: [0, 0.15, 0.18],
};
// smooth 1D value noise: never-repeating, organic drift (each channel gets its own random table)
function noise() {
  const p = Float32Array.from({ length: 256 }, () => Math.random() * 2 - 1);
  const n = (x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return p[i & 255] * (1 - u) + p[(i + 1) & 255] * u; };
  return (x) => n(x) * 0.7 + n(x * 2.3 + 17) * 0.3;
}
const _v = [0, 1, 2, 3, 4].map(() => new THREE.Vector3());
const _q = [0, 1, 2].map(() => new THREE.Quaternion());
const _tgt = new THREE.Vector3(), _hip = new THREE.Vector3();
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
    // her own extra body language (all chosen by her autonomy controller; values eased each frame)
    // tilt: + = head tilted toward HER left · lean: + = weight on HER left leg · curl: 0 open hand … 1 fist
    this.act = {
      tilt: { v: 0, t: 0, until: 0 }, lean: { v: 0, t: 0, until: 0 },
      curl: { left: { v: 0.3, t: 0.3, until: 0 }, right: { v: 0.3, t: 0.3, until: 0 } },
      nod: null, shake: null, tap: null,
    };
    this.frameHooks = []; // (vrm, dt) => void, run after each rendered frame (self-sense reads the drawn pose here)
    this.N = Object.fromEntries(['hx', 'hy', 'hz', 'nx', 'ny', 'sx', 'sy', 'sz', 'cy', 'px', 'py', 'br', 'al', 'ar', 'el', 'er', 'fl', 'fr', 'sw'].map((k) => [k, noise()]));
    this.breath = 0;
    this.feet = null; // planted foot anchors (world), set once she's on the floor
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
    this.ground(vrm);
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

  // Stand her on the floor: the lowest point of her skinned mesh (her soles) goes exactly to y = 0, then
  // remember where her feet are so they stay planted while she sways (two-bone leg IK, every frame).
  ground(vrm) {
    vrm.scene.position.y = 0;
    vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3(), b = new THREE.Box3();
    vrm.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (o.isSkinnedMesh) o.computeBoundingBox(); else if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.isSkinnedMesh ? o.boundingBox : o.geometry.boundingBox;
      if (bb && !bb.isEmpty()) box.union(b.copy(bb).applyMatrix4(o.matrixWorld));
    });
    const H = vrm.humanoid;
    const toe = (s) => (H.getNormalizedBoneNode(s + 'Toes') || H.getNormalizedBoneNode(s + 'Foot'));
    let minY = box.isEmpty() ? Infinity : box.min.y;
    if (!Number.isFinite(minY)) minY = Math.min(toe('left').getWorldPosition(_v[0]).y, toe('right').getWorldPosition(_v[1]).y) - 0.04;
    vrm.scene.position.y -= minY;
    vrm.scene.updateMatrixWorld(true);
    const hips = H.getNormalizedBoneNode('hips');
    this.hipsRest = hips.position.clone();
    this.feet = {};
    for (const s of ['left', 'right']) {
      const f = H.getNormalizedBoneNode(s + 'Foot');
      this.feet[s] = f.getWorldPosition(new THREE.Vector3());
    }
    this.floorY = 0;
    this.addFloor();
  }

  // a faint floor disc plus soft contact shadows, so she reads as standing ON something
  addFloor() {
    if (this.floor) this.scene.remove(this.floor);
    const tex = (inner, outer, rgb) => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, `rgba(${rgb},${inner})`); gr.addColorStop(0.55, `rgba(${rgb},${inner * 0.45})`); gr.addColorStop(1, `rgba(${rgb},${outer})`);
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    };
    const disc = (w, d, map, y) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.position.y = y; m.renderOrder = -1; return m;
    };
    const g = new THREE.Group();
    // the rug she stands on: a soft lavender oval with a lighter rim, clearly a floor at any size
    const rug = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const g2 = c.getContext('2d');
      const gr = g2.createRadialGradient(128, 128, 20, 128, 128, 128);
      gr.addColorStop(0, 'rgba(196,170,230,0.85)'); gr.addColorStop(0.78, 'rgba(214,190,240,0.8)');
      gr.addColorStop(0.86, 'rgba(255,240,252,0.85)'); gr.addColorStop(0.93, 'rgba(214,190,240,0.55)'); gr.addColorStop(1, 'rgba(214,190,240,0)');
      g2.fillStyle = gr; g2.fillRect(0, 0, 256, 256);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    g.add(disc(1.25, 0.95, rug, 0.0005));
    g.add(disc(0.7, 0.45, tex(0.45, 0, '60,30,85'), 0.001)); // soft shadow under her
    this.footShadows = {};
    for (const s of ['left', 'right']) {
      const m = disc(0.2, 0.3, tex(0.8, 0, '40,18,60'), 0.0015);
      m.position.x = this.feet[s].x; m.position.z = this.feet[s].z + 0.03;
      this.footShadows[s] = m; g.add(m);
    }
    this.floor = g;
    this.scene.add(g);
  }

  // Two-bone IK: keep the foot planted on its anchor whatever her hips do. Works in the normalized rig,
  // where +x on a lower leg bends the knee backwards. Afterwards the foot is turned flat to the floor.
  plantFoot(side, lift = 0, free = 0) {
    const H = this.vrm.humanoid;
    const U = H.getNormalizedBoneNode(side + 'UpperLeg'), K = H.getNormalizedBoneNode(side + 'LowerLeg'), F = H.getNormalizedBoneNode(side + 'Foot');
    if (!U || !K || !F || !this.feet) return;
    const target = _tgt.copy(this.feet[side]);
    if (free) { target.y += 0.05 * free; target.z -= 0.015 * free; } // heel up: the ankle rises a little
    U.updateMatrixWorld(true);
    const pu = U.getWorldPosition(_v[0]), pk = K.getWorldPosition(_v[1]), pf = F.getWorldPosition(_v[2]);
    const a = pk.distanceTo(pu), b = pf.distanceTo(pk);
    const d = THREE.MathUtils.clamp(target.distanceTo(pu), 0.05, a + b - 1e-4);
    const cur = _v[3].subVectors(pu, pk).angleTo(_v[4].subVectors(pf, pk));
    const want = Math.acos(THREE.MathUtils.clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1));
    K.rotation.x = Math.max(0, K.rotation.x + (cur - want));
    K.updateMatrixWorld(true);
    F.getWorldPosition(pf);
    const from = _v[3].subVectors(pf, pu).normalize(), to = _v[4].subVectors(target, pu).normalize();
    const swing = _q[0].setFromUnitVectors(from, to);
    const wq = U.getWorldQuaternion(_q[1]).premultiply(swing);
    if (free) {
      // relaxed free leg: the bent knee rolls in toward her middle (the foot stays where it is)
      const axis = _v[3].subVectors(target, pu).normalize();
      wq.premultiply(_q[0].setFromAxisAngle(axis, (side === 'left' ? 1 : -1) * 0.7 * free));
    }
    U.quaternion.copy(U.parent.getWorldQuaternion(_q[2]).invert().multiply(wq));
    U.updateMatrixWorld(true);
    // flat foot: in the normalized rig every bone's rest world rotation equals the rig root's
    const root = H.normalizedHumanBonesRoot.getWorldQuaternion(_q[1]);
    F.quaternion.copy(F.parent.getWorldQuaternion(_q[2]).invert().multiply(root));
    if (lift) F.rotateX(-lift); // toes up (heel stays down) for a foot tap
    if (free) F.rotateX(0.45 * free); // toes stay on the floor while the heel is up
    F.updateMatrixWorld(true);
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
      if (this.handOnHip?.side === s) this.handOnHip = null; // a new arm move replaces hand-on-hip
      Object.assign(this.target, structuredClone(RAISED[s]));
      clearTimeout(this.armTimers[s]);
      if (holdMs) this.armTimers[s] = setTimeout(() => this.lowerArm(s), holdMs);
    }
    return sides;
  }

  lowerArm(side = 'both') {
    const sides = side === 'both' ? ['left', 'right'] : [side];
    for (const s of sides) {
      if (this.handOnHip?.side === s && !this.handOnHip.release) this.handOnHip.release = true;
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

  // Tilt her head toward HER left/right (or 'center') for ms.
  tiltHead(side = 'left', ms = 2500, amount = 0.2) {
    const a = this.act.tilt;
    a.t = side === 'left' ? amount : side === 'right' ? -amount : 0;
    a.until = side === 'center' ? 0 : performance.now() + ms;
    return side;
  }
  // Shift her weight onto HER left/right leg (the other knee softens), for ms.
  shiftWeight(side = 'left', ms = 6000) {
    const a = this.act.lean;
    a.t = side === 'left' ? 1 : side === 'right' ? -1 : 0;
    a.until = side === 'center' ? 0 : performance.now() + ms;
    return side;
  }
  // Curl the fingers of HER left/right/both hands: 0 open … 1 fist. ms = 0 keeps it.
  curlHand(side = 'right', amount = 1, ms = 2000) {
    for (const s of side === 'both' ? ['left', 'right'] : [side]) {
      const c = this.act.curl[s];
      if (!c) throw new Error(`curlHand: side must be 'left', 'right' or 'both' (got ${side})`);
      c.t = Math.max(0, Math.min(1, amount));
      c.until = ms ? performance.now() + ms : 0;
    }
  }
  // Hand on her hip (HER left/right), for ms: the arm is solved onto her hip with the elbow out.
  handOnHipPose(side = 'left', ms = 5000) {
    if (side !== 'left' && side !== 'right') throw new Error(`handOnHip: side must be 'left' or 'right' (got ${side})`);
    clearTimeout(this.armTimers[side]);
    if (this.handOnHip && this.handOnHip.side !== side) this.lowerArm(this.handOnHip.side);
    const sg = side === 'left' ? 1 : -1;
    // a starting shape that bends the right way (upper arm out and back, elbow flexed); IK finishes it
    Object.assign(this.target, { [side + 'UpperArm']: [0.35, 0, -sg * 0.75], [side + 'LowerArm']: [0, -sg * 1.7, 0], [side + 'Hand']: [0, 0, 0] });
    this.handOnHip = { side, until: performance.now() + ms, w: 0 };
    const mine = this.handOnHip;
    this.armTimers[side] = setTimeout(() => { if (this.handOnHip === mine) this.lowerArm(side); }, ms);
  }
  placeHandOnHip(h, now) {
    const H = this.vrm.humanoid;
    if (h.release) { h.w = damp(h.w, 0, 6, 0.016); if (h.w < 0.02) { this.handOnHip = null; return; } } else h.w = Math.min(1, h.w + 0.05);
    const U = H.getNormalizedBoneNode(h.side + 'UpperArm'), K = H.getNormalizedBoneNode(h.side + 'LowerArm'), W = H.getNormalizedBoneNode(h.side + 'Hand');
    const hips = H.getNormalizedBoneNode('hips');
    if (!U || !K || !W || !hips) return;
    hips.updateMatrixWorld(true);
    const sg = h.side === 'left' ? 1 : -1;
    // her hip: a bit out to her side, just above the hip joint, slightly behind the front
    _hip.set(sg * 0.15, 0.06, -0.01).applyMatrix4(hips.matrixWorld);
    U.updateMatrixWorld(true);
    const pu = U.getWorldPosition(_v[0]), pk = K.getWorldPosition(_v[1]), pw = W.getWorldPosition(_v[2]);
    const a = pk.distanceTo(pu), b = pw.distanceTo(pk);
    const d = THREE.MathUtils.clamp(_hip.distanceTo(pu), 0.05, a + b - 1e-4);
    const cur = _v[3].subVectors(pu, pk).angleTo(_v[4].subVectors(pw, pk));
    const want = Math.acos(THREE.MathUtils.clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1));
    K.rotation.y += -sg * (cur - want) * h.w; // elbow flex axis (her left flexes with -y)
    K.updateMatrixWorld(true);
    W.getWorldPosition(pw);
    const swing = _q[0].setFromUnitVectors(_v[3].subVectors(pw, pu).normalize(), _v[4].subVectors(_hip, pu).normalize());
    _q[1].identity().slerp(swing, h.w);
    const wq = U.getWorldQuaternion(_q[2]).premultiply(_q[1]);
    U.quaternion.copy(U.parent.getWorldQuaternion(_q[1]).invert().multiply(wq));
  }
  nod(ms = 1200) { this.act.nod = { until: performance.now() + ms, start: performance.now() }; }
  shakeHead(ms = 1200) { this.act.shake = { until: performance.now() + ms, start: performance.now() }; }
  tapFoot(side = 'right', ms = 3000) { this.act.tap = { side, until: performance.now() + ms, start: performance.now() }; }

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
      // idle life: procedural, never-repeating drift (value noise, random per session), breathing with a
      // wandering rate, plus the body language she chose (tilt, weight shift, nod, head shake, foot tap)
      const A = this.act, N = this.N;
      for (const k of ['tilt', 'lean']) {
        if (A[k].until && now > A[k].until) { A[k].t = 0; A[k].until = 0; }
        A[k].v = damp(A[k].v, A[k].t, 2.2, dt);
      }
      const osc = (o, freq, amp) => {
        if (!o) return 0;
        if (now > o.until) return null;
        const p = (now - o.start) / (o.until - o.start);
        return Math.sin((now - o.start) / 1000 * freq) * amp * Math.sin(Math.PI * p); // eases in and out
      };
      let nodX = osc(A.nod, 11, 0.12); if (nodX === null) { A.nod = null; nodX = 0; }
      let shakeY = osc(A.shake, 12, 0.18); if (shakeY === null) { A.shake = null; shakeY = 0; }
      let tap = 0;
      if (A.tap) { if (now > A.tap.until) A.tap = null; else tap = Math.max(0, Math.sin((now - A.tap.start) / 1000 * 9)) * 0.32; }
      this.breath += dt * (1.45 + 0.35 * N.br(t * 0.07));
      const breathe = Math.sin(this.breath), inhale = 0.5 + 0.5 * breathe;
      const L = A.lean.v; // + = weight on HER left leg (her left is +x)
      const set = (b, x, y, z) => { const n = H.getNormalizedBoneNode(b); if (n) n.rotation.set(x, y, z); };
      const add = (b, x, y, z) => { const n = H.getNormalizedBoneNode(b); if (n) { n.rotation.x += x; n.rotation.y += y; n.rotation.z += z; } };
      // hips carry the weight shift: they slide over the standing leg and that hip rises (contrapposto);
      // the feet stay planted (IK below), so the free knee softens on its own
      const hips = H.getNormalizedBoneNode('hips');
      const sway = N.sw(t * 0.16);
      if (hips && this.hipsRest) {
        hips.position.set(this.hipsRest.x + L * 0.075 + sway * 0.022, this.hipsRest.y - 0.022 - Math.abs(L) * 0.022 + breathe * 0.003, this.hipsRest.z + N.py(t * 0.11) * 0.012);
      }
      // contrapposto: the standing leg's hip rises (+z lifts her left side), the spine and shoulders answer it
      set('hips', 0, N.px(t * 0.1) * 0.07 + L * 0.06, L * 0.11 + sway * 0.02);
      set('spine', 0.03 + breathe * 0.02 + N.sx(t * 0.13) * 0.03, N.sy(t * 0.12) * 0.06, -L * 0.13 + N.sz(t * 0.15) * 0.03);
      set('chest', breathe * 0.035, N.cy(t * 0.14) * 0.035, -L * 0.03);
      set('upperChest', breathe * 0.02, 0, 0);
      set('neck', N.nx(t * 0.2) * 0.05, N.ny(t * 0.17) * 0.08, L * 0.04);
      if (this.look.until && now > this.look.until) { this.look.ty = 0; this.look.tx = 0; this.look.until = 0; }
      this.look.y = damp(this.look.y, this.look.ty, 4, dt);
      this.look.x = damp(this.look.x, this.look.tx, 4, dt);
      // +z on the head rolls it toward HER right, so her chosen tilt (+ = her left) goes in negated
      set('head', N.hx(t * 0.27) * 0.06 + this.look.x + nodX, N.hy(t * 0.21) * 0.14 + this.look.y + shakeY, N.hz(t * 0.24) * 0.05 - A.tilt.v - L * 0.06);
      // shoulders lift a touch on each breath in
      set('leftShoulder', 0, 0, -0.05 + inhale * 0.045); set('rightShoulder', 0, 0, 0.05 - inhale * 0.045); // shoulders down, lifting on each breath
      // relaxed arms drift a little (only while they're down; a raised arm stays where she put it)
      const restL = this.target.leftUpperArm[2] < 0 ? 1 : 0, restR = this.target.rightUpperArm[2] > 0 ? 1 : 0;
      add('leftUpperArm', N.al(t * 0.19) * 0.09 * restL, 0, (N.al(t * 0.13 + 40) * 0.06 + inhale * 0.02) * restL);
      add('rightUpperArm', N.ar(t * 0.19) * 0.09 * restR, 0, -(N.ar(t * 0.13 + 40) * 0.06 + inhale * 0.02) * restR);
      add('leftLowerArm', 0, -(0.5 + 0.5 * N.el(t * 0.15)) * 0.2 * restL, 0);
      add('rightLowerArm', 0, (0.5 + 0.5 * N.er(t * 0.15)) * 0.2 * restR, 0);
      // legs: start straight-ish (knees a hair forward of locked), then IK plants each foot
      for (const s of ['left', 'right']) { set(s + 'UpperLeg', 0, 0, 0); set(s + 'LowerLeg', 0.03, 0, 0); set(s + 'Foot', 0, 0, 0); }
      H.normalizedHumanBonesRoot.updateMatrixWorld(true);
      // the free leg (weight on the other one) rests on the ball of its foot: heel up, knee bent
      this.plantFoot('left', A.tap?.side === 'left' ? tap : 0, Math.max(0, -L));
      this.plantFoot('right', A.tap?.side === 'right' ? tap : 0, Math.max(0, L));
      if (this.handOnHip) this.placeHandOnHip(this.handOnHip, now);
      // fingers: relaxed cascade at rest (little finger curls most), drifting a bit; fist / open when she chooses
      for (const s of ['left', 'right']) {
        const c = A.curl[s];
        if (c.until && now > c.until) { c.t = 0.3; c.until = 0; }
        c.v = damp(c.v, c.t, 8, dt);
        const v = c.v + (c.t > 0.2 && c.t < 0.5 ? (s === 'left' ? N.fl : N.fr)(t * 0.2) * 0.07 : 0);
        const sg = s === 'left' ? -1 : 1; // her left fingers point +x in bone space, so they curl with -z
        const k = { Index: 0.85, Middle: 1, Ring: 1.08, Little: 1.18 };
        for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
          const w = v * (v > 0.7 ? 1 : k[f]);
          set(`${s}${f}Proximal`, 0, 0, sg * w * 1.25);
          set(`${s}${f}Intermediate`, 0, 0, sg * w * 1.4);
          set(`${s}${f}Distal`, 0, 0, sg * w * 0.9);
        }
        set(`${s}ThumbProximal`, 0, -sg * v * 0.55, sg * v * 0.25);
        set(`${s}ThumbDistal`, 0, -sg * v * 0.6, 0);
      }
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
    if (vrm) for (const f of this.frameHooks) { try { f(vrm, dt); } catch (e) { console.warn('frame hook', e); } }
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
