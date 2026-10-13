// Jena's body: a VRM rendered live with three.js + @pixiv/three-vrm on a transparent canvas.
// Idle life (breathing, sway, head drift, eye saccades), natural blinking, mood expressions,
// lip flap while talking, and target-based arm control. Left/right always mean JENA'S left/right.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { fitBodyCollider, BodyCollision, RoomCollision } from './body.js';

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
    // preserveDrawingBuffer makes the GPU keep a copy of every frame (costly on phones); only browsers
    // without WebGL2 still need it (their self-view crops the stage canvas directly)
    const gl2 = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })();
    // No WebGL (blocked, crashed GPU process, weak device): keep a do-nothing renderer so the rest of the page
    // (chat, desktop, mama tools) still runs; main.js shows a still picture of her instead (avatar.noGL).
    try { this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: !gl2 }); }
    catch (e) {
      console.warn('avatar: no WebGL', e);
      this.noGL = true; this.glError = String(e?.message || e);
      const nop = () => {};
      this.renderer = { noGL: true, domElement: canvas, setClearColor: nop, setPixelRatio: nop, getPixelRatio: () => 1, setSize: nop, setAnimationLoop: nop, render: nop, getRenderTarget: () => null, setRenderTarget: nop, readRenderTargetPixels: nop, dispose: nop, capabilities: { isWebGL2: false } };
    }
    this.renderer.setClearColor(0x000000, 0);
    // sharpness vs speed: up to 2x pixels on phones and computers (a 3x iPhone at 1.5x looked soft and jaggy);
    // ?dpr=<n> pins it. If frames run slow, frame() steps it down, never below 1.5x on a hi-dpi screen.
    const q = new URLSearchParams(location.search), pin = parseFloat(q.get('dpr'));
    const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 900;
    this.dprPinned = pin > 0;
    this.renderer.setPixelRatio(pin > 0 ? pin : Math.min(window.devicePixelRatio || 1, 2));
    this.minPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    this.phone = phone;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(22, 1, 0.1, 50);
    // lights matched to her room (bg-room.jpg): pink-lavender room bounce, the warm bedside lamp on the
    // viewer's left, the sunset window behind her (back sunlight = warm rim on hair + shoulders), fairy
    // lights up-left that twinkle a little, and the bunny night-light low on the right. ?light=flat = old setup.
    const flat = new URLSearchParams(location.search).get('light') === 'flat';
    if (flat) {
      const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(0.6, 1.6, 2.2);
      const rim = new THREE.DirectionalLight(0xffd6f0, 1.2); rim.position.set(-1.5, 2, -1.5);
      this.scene.add(key, rim, new THREE.AmbientLight(0xffffff, 0.9));
      this.lights = { flat: true };
    } else {
      const room = new THREE.HemisphereLight(0xf1dcff, 0xffe4dc, 0.62);          // lavender ceiling, warm rug
      const front = new THREE.DirectionalLight(0xfff1f5, 0.6); front.position.set(0.2, 1.3, 2.6);   // soft room fill so her face reads
      const lamp = new THREE.DirectionalLight(0xffd9ad, 0.75); lamp.position.set(-2.2, 1.0, 1.4);    // bedside lamp, viewer's left
      const sun = new THREE.DirectionalLight(0xffc6a3, 1.7); sun.position.set(1.6, 2.2, -2.4);       // sunset window behind her
      const fairy = new THREE.PointLight(0xffe2b8, 1.0, 6, 1.5); fairy.position.set(-1.4, 2.3, -0.6); // fairy lights up-left
      const bunny = new THREE.PointLight(0xffe7c4, 0.5, 3, 2); bunny.position.set(1.1, 0.5, 1.1);     // bunny night-light, low right
      this.scene.add(room, front, lamp, sun, fairy, bunny);
      this.lights = { room, front, lamp, sun, fairy, bunny };
      this.frameHooksLight = (t) => {
        fairy.intensity = 1.0 + 0.14 * Math.sin(t * 2.3) + 0.07 * Math.sin(t * 5.1 + 1.7);   // soft twinkle
        sun.intensity = 1.7 + 0.12 * Math.sin(t * 0.05);                                     // slow sunset drift
      };
    }
    this.clock = new THREE.Timer();
    this.vrm = null;
    this.pose = {}; // bone -> current [x,y,z]
    this.target = structuredClone(REST);
    this.mood = { name: 'neutral', weights: Object.fromEntries(MOODS.map((m) => [m, 0])), until: 0 };
    this.blink = { next: 2, t: -1, double: false };
    this.talk = { until: 0, shape: 'aa', next: 0, text: '', t0: 0, ms: 0 };
    // talking hands: a hand shape per hand while she talks (point, open palm, two fingers, soft fist…), eased per finger
    this.gesture = { left: { v: [0, 0, 0, 0, 0], t: [0, 0, 0, 0, 0], next: 0 }, right: { v: [0, 0, 0, 0, 0], t: [0, 0, 0, 0, 0], next: 0 } };
    // little face life when nothing else is going on: a soft smile, a brow lift, a squint (never flirty)
    this.micro = { name: null, w: 0, peak: 0, until: 0, next: 4 };
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
    this.poseHooks = []; // (vrm, dt) => void, run after her idle pose is set and before the leg IK (learned moves blend in here)
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
    if (this.noGL) throw new Error('WebGL unavailable: ' + this.glError);
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
    // her MToon outline is 0.8 mm wide in world space: thinner than a pixel at stage distance, so it broke up into
    // a dotted, speckled edge around her body and hair. Off (her shading reads cleanly without it).
    this.outlinesOff = 0;
    // her face layers came out of the export all OPAQUE (VRoid exports brows/eyelines as cut-outs and the eye
    // highlight as see-through): give them their cut-out / blend back and draw them after the face skin, so
    // brows, eyelines and eye shine have clean edges on every GPU
    this.faceLayers = [];
    vrm.scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) {
        if (!m || m.isOutline) continue;
        const n = m.name || '';
        if (/FaceBrow|FaceEyeline|FaceEyelash/.test(n) && !m.transparent && !(m.alphaTest > 0)) { m.alphaTest = 0.5; m.needsUpdate = true; o.renderOrder = Math.max(o.renderOrder, 20); this.faceLayers.push(n + ':mask'); }
        else if (/EyeHighlight/.test(n) && !m.transparent) { m.transparent = true; m.depthWrite = false; m.needsUpdate = true; o.renderOrder = Math.max(o.renderOrder, 21); this.faceLayers.push(n + ':blend'); }
      }
    });
    if (new URLSearchParams(location.search).get('outline') !== '1') vrm.scene.traverse((o) => { if (!o.isMesh) return; for (const m of [].concat(o.material)) if (m?.isOutline && m.visible !== false) { m.visible = false; this.outlinesOff++; } });
    if (this.vrm) { this.scene.remove(this.vrm.scene); VRMUtils.deepDispose(this.vrm.scene); }
    this.vrm = vrm;
    try { this.checkRig(vrm); } catch (e) { console.warn('rig check', e); }
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
    // her real mesh (body + clothes + skirt) becomes the collider her arms and hands stay outside of
    try {
      const t0 = performance.now();
      this.collider = fitBodyCollider(vrm);
      if (this.collider) { this.collision = new BodyCollision(this, this.collider); this.collision.stats.fitMs = Math.round(performance.now() - t0); }
    } catch (e) { console.warn('body collider', e); this.colliderError = String(e.message || e); }
    this.springs = { joints: vrm.springBoneManager?.joints?.size ?? 0, colliders: vrm.springBoneManager?.colliders?.size ?? 0 };
    this.randomStart();
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

  // GPU-bound (frames averaging slower than ~42 fps for 3 s): draw fewer pixels, a quarter step at a time
  adaptPixels(raw) {
    if (this.dprPinned || !(raw > 0) || raw > 0.25 || document.hidden) return;
    const now = performance.now(), P = (this.perf ||= { ms: 16.7, cool: now + 4000 });
    P.ms = P.ms * 0.96 + raw * 1000 * 0.04;
    const pr = this.renderer.getPixelRatio();
    if (now > P.cool && P.ms > 24 && pr > (this.minPixelRatio || 1)) {
      this.renderer.setPixelRatio(Math.max(this.minPixelRatio || 1, Math.round((pr - 0.25) * 4) / 4));
      this.resize();
      P.cool = now + 3000; P.ms = 16.7;
      this.pixelSteps = (this.pixelSteps || 0) + 1;
    }
  }

  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.frameCamera();
  }

  // Framing: 'full' (head to feet: dances, stretches), 'talk' (waist-up: face, mouth and both hands big enough
  // to read on a phone; used while she talks/chats and as her resting view on phones), 'auto' picks per frame.
  // The camera eases between them (no jumps). ?view=full|talk pins one.
  frameGoal(mode) {
    const fov = THREE.MathUtils.degToRad(this.camera.fov), tan = Math.tan(fov / 2), asp = this.camera.aspect || 1;
    let top, bottom, wantW = 0.95, cx = 0;
    if (mode === 'talk' && this.vrm) {
      const H = this.vrm.humanoid, P = (b) => H.getNormalizedBoneNode(b)?.getWorldPosition(new THREE.Vector3());
      const head = P('head'), hips = P('hips'), lh = P('leftHand'), rh = P('rightHand');
      if (head && hips && lh && rh) {
        // fingertips, not wrists: a hanging hand's fingers reach ~10-12 cm below the hand bone
        const pts = [lh, rh]; for (const s of ['left', 'right']) for (const f of ['IndexDistal', 'MiddleDistal', 'LittleDistal', 'ThumbDistal']) { const v = P(s + f); if (v) pts.push(v); }
        const handLow = Math.min(...pts.map((v) => v.y)), handHigh = Math.max(...pts.map((v) => v.y));
        const xs = pts.map((v) => v.x), handL = Math.min(...xs), handR = Math.max(...xs);
        top = Math.max(head.y + 0.25, handHigh + 0.12);   // the head bone sits at the base of her skull: +0.25 clears her hair
        // face big AND both hands (with their fingers) in shot: the frame always reaches a little below the lower
        // hand (fingertips hang ~0.09 below the hand bone), never above the hips, and at most to mid-thigh
        bottom = Math.min(hips.y - 0.12, Math.max(handLow - 0.06, hips.y - 0.45));
        // a gesture (hands lifted or spread) eases the camera back a little so the fingers never touch the edge
        const gesture = Math.max(0, handHigh - (hips.y + 0.05)) + Math.max(0, handR - handL - 0.5);
        wantW = Math.max(0.66, handR - handL + 0.22) + Math.min(0.25, gesture * 0.5);
        cx = (handL + handR) / 2 * 0.5;
      }
    }
    if (top === undefined) { bottom = -0.16; top = this.height + 0.36; } // feet a little above the bottom, headroom for a raised arm
    // panels laid over the bottom of her stage (the chat card on phones) hide part of the canvas: frame her in
    // the part that is actually visible
    const cover = Math.min(0.45, Math.max(0, this.coverBottom || 0));
    const span = (top - bottom) / (1 - cover);
    const d = Math.max(span / 2 / tan, wantW / 2 / (tan * asp));
    const visH = 2 * d * tan; // world height the camera shows at her depth
    return { x: cx, y: top - visH / 2 + (visH - span) / 2 * (mode === 'talk' ? 0.35 : 0.5), d };
  }
  measureCover() {
    try {
      const c = this.canvas.getBoundingClientRect(); let cover = 0;
      for (const el of document.querySelectorAll('#chat, #composer, .composer, #mobile-bar')) {
        const r = el.getBoundingClientRect(), st = getComputedStyle(el);
        if (!r.height || st.display === 'none' || st.visibility === 'hidden') continue;
        if (r.top > c.top + c.height * 0.4 && r.top < c.bottom && r.left < c.right && r.right > c.left && (r.right - r.left) > c.width * 0.6)
          cover = Math.max(cover, (c.bottom - r.top) / c.height);
      }
      this.coverBottom = cover;
    } catch { this.coverBottom = 0; }
  }
  frameCamera() {
    const pin = new URLSearchParams(location.search).get('view');
    this.viewPin = pin === 'full' || pin === 'talk' ? pin : null;
    const g = this.frameGoal(this.viewPin || 'full');
    this.cam = { ...g };
    this.camera.position.set(g.x, g.y, g.d);
    this.camera.lookAt(g.x, g.y, 0);
  }
  viewMode(now) {
    if (this.viewPin) return this.viewPin;
    const mv = window.jenaMoves?.playing;
    if (mv && ['dance', 'stretch', 'weight', 'happy'].includes(mv.c?.kind)) return 'full';
    if (now < (this.talk.until || 0) + 4000) return 'talk';
    if (mv) return 'full';
    // resting: phones (small stage) keep her waist-up so her face and hands read; big screens show all of her
    const w = this.canvas.parentElement?.clientWidth || 0;
    return this.phone || w < 700 ? 'talk' : 'full';
  }
  updateCamera(dt, now) {
    if (!this.cam) return;
    if (!(now < this._coverAt)) { this._coverAt = now + 1000; this.measureCover(); }
    const mode = this.viewMode(now);
    this.viewNow = mode;
    const g = this.frameGoal(mode), k = mode === this._lastMode ? 1.6 : 2.2;
    this._lastMode = mode;
    this.cam.x = damp(this.cam.x, g.x, k, dt); this.cam.y = damp(this.cam.y, g.y, k, dt); this.cam.d = damp(this.cam.d, g.d, k, dt);
    this.camera.position.set(this.cam.x, this.cam.y, this.cam.d);
    this.camera.lookAt(this.cam.x, this.cam.y, 0);
  }

  // A different body every time the page loads: random seed, mid-breath, a random weight side, head
  // already somewhere, fingers at a random curl. (The idle noise tables are random per load as well.)
  randomStart() {
    const r = crypto.getRandomValues(new Uint32Array(1))[0];
    this.seed = r.toString(16);
    let x = r || 1; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    this.breath = rnd() * Math.PI * 2;
    this.timeOffset = rnd() * 1000; // starts her never-repeating drift at a random point
    this.act.lean.v = this.act.lean.t = rnd() < 0.5 ? -0.8 : 0.8;
    this.act.tilt.v = (rnd() - 0.5) * 0.15;
    for (const s of ['left', 'right']) this.act.curl[s].v = this.act.curl[s].t = 0.15 + rnd() * 0.35;
    this.look.y = (rnd() - 0.5) * 0.3;
    this.blink.next = rnd() * 3;
    this.nextGaze = 0;
  }

  // Balance + orientation from her real bones: center of mass (segment-mass weighted) projected on the
  // floor, whether it sits over her support area (between/over her feet), and which way she faces.
  balance() {
    if (!this.vrm) return null;
    const H = this.vrm.humanoid, M = { hips: 0.14, spine: 0.12, chest: 0.12, upperChest: 0.04, neck: 0.02, head: 0.08 };
    for (const s of ['left', 'right']) Object.assign(M, { [s + 'UpperArm']: 0.028, [s + 'LowerArm']: 0.016, [s + 'Hand']: 0.006, [s + 'UpperLeg']: 0.1, [s + 'LowerLeg']: 0.046, [s + 'Foot']: 0.014 });
    let x = 0, z = 0, m = 0;
    for (const [b, w] of Object.entries(M)) { const n = H.getNormalizedBoneNode(b); if (!n) continue; n.getWorldPosition(_v[3]); x += _v[3].x * w; z += _v[3].z * w; m += w; }
    x /= m; z /= m;
    const fl = H.getNormalizedBoneNode('leftFoot').getWorldPosition(_v[0]), fr = H.getNormalizedBoneNode('rightFoot').getWorldPosition(_v[1]);
    const x0 = Math.min(fl.x, fr.x) - 0.05, x1 = Math.max(fl.x, fr.x) + 0.05, z0 = Math.min(fl.z, fr.z) - 0.06, z1 = Math.max(fl.z, fr.z) + 0.14;
    const ok = x >= x0 && x <= x1 && z >= z0 && z <= z1;
    const hips = H.getNormalizedBoneNode('hips').getWorldQuaternion(_q[0]);
    const fwd = _v[2].set(0, 0, 1).applyQuaternion(hips);
    const facing = Math.round(THREE.MathUtils.radToDeg(Math.atan2(fwd.x, fwd.z)));
    const over = Math.abs(x - fl.x) < Math.abs(x - fr.x) ? 'left' : 'right';
    return { x, z, ok, facing, over, marginCm: Math.round(Math.min(x - x0, x1 - x, z - z0, z1 - z) * 100) };
  }

  // what her eyes are on: 'camera' (you), 'desktop' (her screen panel, to HER left), 'chat', 'hand', 'floor'
  gazeAt(what, ms = 2500) { this.gazeGoal = { what, until: performance.now() + ms }; }
  gazePoint(what) {
    const c = this.camera.position, H = this.vrm.humanoid;
    if (what === 'desktop') return _v[4].set(c.x + 1.6, c.y + 0.55, c.z * 0.6);
    if (what === 'chat') return _v[4].set(c.x + 1.2, c.y - 0.35, c.z * 0.6);
    if (what === 'floor') return _v[4].set(c.x * 0.2, 0, 0.9);
    if (what === 'hand') {
      const s = this.wave?.side || (this.target.leftUpperArm[2] > 0.5 ? 'left' : this.target.rightUpperArm[2] < -0.5 ? 'right' : (this.handOnHip?.side || 'right'));
      const n = H.getNormalizedBoneNode(s + 'Hand'); if (n) return n.getWorldPosition(_v[4]);
    }
    return _v[4].copy(c);
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
    this.talk.text = String(text || ''); this.talk.t0 = performance.now(); this.talk.ms = ms;
    return ms;
  }
  // the mouth shape for the sound she's on right now, read off the words she's saying (time-aligned to the
  // audio when her voice is playing): vowels -> aa / ih / ou / ee / oh, m b p close the lips, others half-open
  viseme(now) {
    const T = this.talk;
    if (!T.text || !T.ms) return null;
    const x = (now - T.t0) / T.ms;
    if (x < 0 || x > 1) return null;
    const txt = T.text.toLowerCase();
    const ch = txt[Math.min(txt.length - 1, Math.floor(x * txt.length))] || ' ';
    if ('a'.includes(ch)) return 'aa';
    if ('iy'.includes(ch)) return 'ih';
    if ('uwq'.includes(ch)) return 'ou';
    if ('e'.includes(ch)) return 'ee';
    if ('o'.includes(ch)) return 'oh';
    if ('mbp'.includes(ch)) return 'closed';
    if (' .,!?;:\n'.includes(ch)) return 'rest';
    return 'half';
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
    const surf = this.collision?.hipSurface(h.side, 0.028);
    if (surf) _hip.copy(surf); else _hip.set(sg * 0.15, 0.06, -0.01).applyMatrix4(hips.matrixWorld);
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
    const raw = this.clock.getDelta(), dt = Math.min(raw, 0.1);
    this.adaptPixels(raw);
    const t = this.clock.getElapsed() + (this.timeOffset || 0);
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
      for (const f of this.poseHooks) { try { f(vrm, dt); } catch (e) { console.warn('pose hook', e); } }
      H.normalizedHumanBonesRoot.updateMatrixWorld(true);
      // the free leg (weight on the other one) rests on the ball of its foot: heel up, knee bent
      this.plantFoot('left', A.tap?.side === 'left' ? tap : 0, Math.max(0, -L));
      this.plantFoot('right', A.tap?.side === 'right' ? tap : 0, Math.max(0, L));
      if (this.handOnHip) this.placeHandOnHip(this.handOnHip, now);
      // fingers: every finger has its own slow drift and the hand its own spread, so they never move as one
      // block; they gesture while she talks; fist / open when she chooses. Thumb opposes as the hand closes.
      this.FN ||= Object.fromEntries(['left', 'right'].flatMap((s) => ['Thumb', 'Index', 'Middle', 'Ring', 'Little', 'Spread'].map((f) => [s + f, noise()])));
      const talking = now < this.talk.until;
      for (const s of ['left', 'right']) {
        const c = A.curl[s];
        if (c.until && now > c.until) { c.t = 0.3; c.until = 0; }
        c.v = damp(c.v, c.t, 8, dt);
        const relaxed = c.t > 0.15 && c.t < 0.55;
        const g = talking && relaxed ? 0.3 : 0.15; // talking hands move more (idle fingers still drift, each its own way)
        // talking gestures: every 1-2.5 s each hand takes a shape (point, open palm, two up, soft fist, relaxed)
        const G = this.gesture[s];
        if (talking && relaxed && now > G.next) {
          const shapes = [[0, 0, 0, 0, 0], [0.5, -0.25, 0.45, 0.5, 0.55], [0.3, -0.2, -0.2, 0.5, 0.55], [0.35, 0.35, 0.4, 0.45, 0.5], [0, -0.2, 0.05, 0.15, 0.25], [0.2, 0.15, -0.15, 0.1, 0.3]];
          G.t = shapes[Math.floor(Math.random() * shapes.length)]; G.next = now + 1000 + Math.random() * 1500;
        } else if (!talking && G.next && now > G.next) { G.t = [0, 0, 0, 0, 0]; G.next = 0; }
        for (let j = 0; j < 5; j++) G.v[j] = damp(G.v[j], G.t[j], 7, dt);
        const sg = s === 'left' ? -1 : 1; // her left fingers point +x in bone space, so they curl with -z
        const k = { Index: 0.8, Middle: 0.95, Ring: 1.06, Little: 1.18 };
        const spread = relaxed ? 0.06 + this.FN[s + 'Spread'](t * 0.31) * 0.06 : c.v > 0.7 ? 0 : 0.03;
        const sp = { Index: 1.4, Middle: 0.3, Ring: -0.6, Little: -1.4 };
        let fi = 0;
        for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
          const own = relaxed ? this.FN[s + f](t * (0.23 + fi * 0.04) + fi * 13) * g : 0;
          const w = Math.max(0, Math.min(1.05, c.v * (c.v > 0.7 ? 1 : k[f]) + own + G.v[fi + 1]));
          set(`${s}${f}Proximal`, 0, sg * -spread * sp[f], sg * w * 1.2);
          set(`${s}${f}Intermediate`, 0, 0, sg * w * 1.45);
          set(`${s}${f}Distal`, 0, 0, sg * w * 0.95);
          fi++;
        }
        const th = Math.max(0, Math.min(1, c.v + (relaxed ? this.FN[s + 'Thumb'](t * 0.27) * g : 0) + G.v[0]));
        set(`${s}ThumbMetacarpal`, 0, -sg * th * 0.35, sg * th * 0.12);
        set(`${s}ThumbProximal`, 0, -sg * th * 0.5, sg * th * 0.28);
        set(`${s}ThumbDistal`, 0, -sg * th * 0.65, 0);
        // wrists stay alive too (a little flex + twist), more while talking
        add(`${s}Hand`, (this.FN[s + 'Index'](t * 0.11 + 50)) * g * 0.6, 0, sg * this.FN[s + 'Spread'](t * 0.13 + 9) * g * 0.8);
        // elbows: a softly bent elbow is never frozen; a little extra flex comes and goes, more while talking
        if (!this.handOnHip || this.handOnHip.side !== s) add(`${s}LowerArm`, 0, sg * (talking && relaxed ? (0.5 + 0.5 * this.FN[s + 'Middle'](t * 0.5 + 3)) * 0.35 : 0), 0);
      }
      // learned moves with tracked fingers take over her fingers while they play (moves.js applyHands)
      for (const f of this.handHooks || []) { try { f(vrm, dt); } catch (e) { console.warn('hand hook', e); } }
      // her own body's shape keeps her arms and hands outside her clothes/hips/skirt (mesh-fitted collider)
      if (this.collision) { try { this.collision.apply(); } catch (e) { console.warn('collision', e); } }
      // her room (floor, wall behind her, stage edges) as colliders too
      if (!this.roomCol && this.feet) { try { this.roomCol = new RoomCollision(this); } catch (e) { console.warn('room', e); } }
      if (this.roomCol) { try { this.roomCol.apply(); } catch (e) { console.warn('room collision', e); } }
      // eyes: she looks at things (you, her desktop panel, chat, her own hand when it's doing something,
      // sometimes the floor), with little saccades on top and the head following big eye turns a bit
      if (this.gazeGoal && now > this.gazeGoal.until) this.gazeGoal = null;
      if (!this.gazeGoal && now > (this.nextGaze || 0)) {
        const busyHand = this.wave || this.handOnHip || this.target.leftUpperArm[2] > 0.5 || this.target.rightUpperArm[2] < -0.5;
        const r = Math.random();
        const what = busyHand && r < 0.35 ? 'hand' : r < 0.6 ? 'camera' : r < 0.78 ? 'desktop' : r < 0.92 ? 'chat' : 'floor';
        this.gazeGoal = { what, until: now + (what === 'camera' ? 2500 + Math.random() * 4000 : 900 + Math.random() * 1800) };
        this.nextGaze = this.gazeGoal.until + 200;
      }
      this.gazeNow = this.gazeGoal?.what || 'camera';
      if (now > this.nextSaccade) {
        this.gazeOffset.set((Math.random() - 0.5) * 0.18, (Math.random() - 0.5) * 0.09, 0);
        this.nextSaccade = now + 350 + Math.random() * 1800;
      }
      this._gz ||= this.camera.position.clone();
      const goal = this.gazePoint(this.gazeNow);
      this._gz.lerp(goal, 1 - Math.exp(-dt * 14)); // eyes move fast but not instantly
      this.gaze.position.copy(this._gz).add(this.gazeOffset);
      this.gaze.position.x += this.look.y * 2.2; this.gaze.position.y -= this.look.x * 2.2;
      if (this.gazeNow !== 'camera') {
        const head = H.getNormalizedBoneNode('head');
        const hp = head.getWorldPosition(_v[3]);
        const dir = _v[2].subVectors(this._gz, hp);
        const yaw = Math.atan2(dir.x, dir.z), pitch = Math.atan2(-(dir.y), Math.hypot(dir.x, dir.z));
        this._hy = damp(this._hy || 0, THREE.MathUtils.clamp(yaw, -0.6, 0.6) * 0.35, 3, dt);
        this._hp = damp(this._hp || 0, THREE.MathUtils.clamp(pitch, -0.4, 0.5) * 0.3, 3, dt);
      } else { this._hy = damp(this._hy || 0, 0, 3, dt); this._hp = damp(this._hp || 0, 0, 3, dt); }
      add('head', this._hp, this._hy, 0);
      this.updateFace(dt, t, now);
      for (const f of this.faceHooks || []) { try { f(vrm, dt); } catch (e) { console.warn('face hook', e); } }
      vrm.update(dt);
    }
    this.frameHooksLight?.(t);
    if (vrm && !this.cameraHeld) this.updateCamera(Math.min(raw, 0.5), now); // real time, so slow devices still settle
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
    em.setValue('blink', b * (1 - this.mood.weights.happy * 0.3));
    this.blinkNow = b;
    // per-eye blinks and gaze shapes only come from a learned move's tracked face (moves.js applyFace runs after
    // this); start them at 0 every frame so a move can never leave an eye stuck half-shut after it ends
    for (const k of ['blinkLeft', 'blinkRight', 'lookUp', 'lookDown', 'lookLeft', 'lookRight']) em.setValue(k, 0);
    // face life between moods: a soft smile, a little brow lift or a relaxed squint now and then
    const M = this.micro;
    M.next -= dt;
    if (this.mood.name === 'neutral' && !M.name && M.next <= 0) {
      const r = Math.random();
      M.name = r < 0.45 ? 'happy' : r < 0.75 ? 'relaxed' : 'surprised';
      M.peak = M.name === 'surprised' ? 0.25 : M.name === 'happy' ? 0.45 : 0.4;
      M.until = now + (M.name === 'surprised' ? 700 : 1500 + Math.random() * 2000);
      M.next = 5 + Math.random() * 8;
    }
    const microGoal = M.name && now <= M.until && this.mood.name === 'neutral' ? M.peak : 0;
    M.w = damp(M.w, microGoal, 5, dt);
    if (M.name) { em.setValue(M.name, Math.max(em.getValue(M.name) || 0, M.w)); if (microGoal === 0 && M.w < 0.01) { M.name = null; M.w = 0; } }
    // mouth: five vowel shapes (aa ih ou ee oh) from the words she's saying, opened by her real voice level
    // when the audio is playing (else a speech-like rhythm), lips closed on m/b/p
    const V = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    const talking = now < this.talk.until;
    if (this.voice || talking) {
      const vis = this.viseme(now);
      let open;
      if (this.voice) open = Math.min(1, this.voice.level * 1.25);
      else { if (now > this.talk.next) { this.talk.amp = 0.45 + Math.random() * 0.5; this.talk.next = now + 70 + Math.random() * 90; } open = this.talk.amp * (0.65 + 0.35 * Math.sin(t * 30)); }
      if (vis === 'closed') open *= 0.08; else if (vis === 'rest') open *= 0.25; else if (vis === 'half') open *= 0.55;
      const shape = vis && V[vis] !== undefined ? vis : this.voice ? (this.voice.round > 0.62 ? 'oh' : 'aa') : (this.talk.shape = now > (this.talk.shapeNext || 0) ? (this.talk.shapeNext = now + 120, ['aa', 'ih', 'ou', 'ee', 'oh'][Math.floor(Math.random() * 5)]) : this.talk.shape);
      V[shape] = open; if (shape !== 'aa') V.aa = open * 0.2;
    }
    this._vis ||= { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    for (const k of Object.keys(V)) { this._vis[k] = damp(this._vis[k], V[k], 22, dt); em.setValue(k, this._vis[k]); }
    this._aa = this._vis.aa; this._oh = this._vis.oh;
  }

  // what her face and fingers are doing right now (dev panel, proof, tests)
  faceState() {
    const em = this.vrm?.expressionManager, H = this.vrm?.humanoid;
    if (!em || !H) return null;
    const ex = {};
    for (const e of em.expressions) ex[e.expressionName] = +(em.getValue(e.expressionName) || 0).toFixed(3);
    const fing = {};
    for (const s of ['left', 'right']) for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
      const n = H.getNormalizedBoneNode(s + f + (f === 'Thumb' ? 'Proximal' : 'Intermediate'));
      if (n) fing[s + f] = +((f === 'Thumb' ? n.rotation.y : n.rotation.z) * (s === 'left' ? -1 : 1)).toFixed(3);
    }
    return { expressions: ex, fingers: fing, talking: performance.now() < this.talk.until, viseme: this.viseme(performance.now()), micro: this.micro.name, rig: this.rigCheck || null };
  }

  // does her model have every bone and expression her face/finger code drives? logged once per model
  checkRig(vrm) {
    const want = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'].flatMap((f) => ['left', 'right'].flatMap((s) => (f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal']).map((j) => s + f + j)));
    const missingBones = want.filter((b) => !vrm.humanoid?.getNormalizedBoneNode(b));
    const have = new Set((vrm.expressionManager?.expressions || []).map((e) => e.expressionName));
    const missingExpressions = ['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'].filter((n) => !have.has(n));
    this.rigCheck = { fingerBones: want.length - missingBones.length, of: want.length, missingBones, expressions: have.size, missingExpressions };
    (missingBones.length || missingExpressions.length ? console.warn : console.log)('jena rig check', JSON.stringify(this.rigCheck));
    return this.rigCheck;
  }
}

// for the Node harnesses (moves-pipeline/fingers_face_harness.mjs): her finger/face code without a GPU
export const _internals = { damp, noise };
