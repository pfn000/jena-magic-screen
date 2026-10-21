// Jena's body: a VRM rendered live with three.js + @pixiv/three-vrm on a transparent canvas.
// Idle life (breathing, sway, head drift, eye saccades), natural blinking, mood expressions,
// lip flap while talking, and target-based arm control. Left/right always mean JENA'S left/right.
import { NoRepeat } from './nonrepeat.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMExpression, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm';
import { fitBodyCollider, BodyCollision, RoomCollision } from './body.js';
import { MotionPolish, Spring } from './motionpolish.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

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
const talking0 = (A, now) => now < (A.talk?.until || 0);
function noise() {
  const p = Float32Array.from({ length: 256 }, () => Math.random() * 2 - 1);
  const n = (x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return p[i & 255] * (1 - u) + p[(i + 1) & 255] * u; };
  return (x) => n(x) * 0.7 + n(x * 2.3 + 17) * 0.3;
}
const _v = Array.from({ length: 12 }, () => new THREE.Vector3());
const _q = Array.from({ length: 6 }, () => new THREE.Quaternion());
const TOE_PRESS = 0.08;   // toes curl down this much (rad) on the floor so their pads press, not hover
const _tgt = new THREE.Vector3(), _hip = new THREE.Vector3(), _m4 = new THREE.Matrix4(), _eW = new THREE.Euler();
// Raised ("hand up, like in class"): upper arm lifted out to the side and up, forearm turned so the
// palm faces forward (x twist), elbow softly bent so the hand leans in toward her head (y flex).
// Right side mirrors the left: x stays, y and z flip.
const RAISED = {
  left: { leftUpperArm: [0, 0, 1.2], leftLowerArm: [-1.5, -0.45, 0], leftHand: [0, 0, 0] },
  right: { rightUpperArm: [0, 0, -1.2], rightLowerArm: [-1.5, 0.45, 0], rightHand: [0, 0, 0] },
};
// Waving (Saidie's notes 40/44 on the 3D avatar: no stiff stick arm, no claw hand, wrist never bent wrong): the upper
// arm out to the side a little above shoulder height and a touch forward, the elbow clearly bent (~95 deg, forearm up),
// palm forward, wrist almost straight; the wave itself swings the forearm from the elbow with a soft follow-through
// in the wrist (well inside 30 deg) and the hand open and relaxed.
// (r11: the static WAVE target pose is gone; see waveHand / applyWave). While she waves, the follow camera slides this
// far (m) toward the waving hand so the whole hand stays in view; her face height is untouched.
const WAVE_REFRAME = 0.075;
const IDLE_YAW_CAP = THREE.MathUtils.degToRad(15);   // r12c: idle head + neck yaw limit (soft)

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
    // sharpness: FULL native device resolution (no clamp: a 3x iPhone renders at 3x), automatically, no toggle.
    // The adaptive governor (adaptPixels) only steps resolution down on real frame drops against the screen's own refresh
    // rate (60 / 120 Hz), and back up with headroom. ?dpr=<n> pins it.
    const q = new URLSearchParams(location.search), pin = parseFloat(q.get('dpr'));
    const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 900;
    this.dprPinned = pin > 0;
    const native = window.devicePixelRatio || 1;
    this.nativeRatio = native;
    this.renderer.setPixelRatio(pin > 0 ? pin : native);
    this.minPixelRatio = Math.min(native, 1.5);
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
    // progress: the host serves the file compressed, so e.total (Content-Length) can be the compressed size while e.loaded
    // counts decoded bytes, which read past 100% ("149%"). Pass a clamped fraction while it is honest, else bytes so far.
    const gltf = await loader.loadAsync(url, (e) => {
      const ok = e.lengthComputable !== false && e.total > 0 && e.loaded <= e.total;
      this.onStatus('loading', ok ? Math.min(0.99, e.loaded / e.total) : null, e.loaded);
    });
    this.onStatus('loading', 1, 0);   // downloaded: parsing her body + first GPU upload
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
    // cut-out hair/face layers of a glTF body: alpha-to-coverage (MSAA) instead of a hard alpha test, so hair strands
    // read as soft strands instead of a speckled, pixel-stepped edge
    vrm.scene.traverse((o) => { if (!o.isMesh) return; for (const m of [].concat(o.material)) if (m?.isMeshStandardMaterial && m.alphaTest > 0) { m.alphaToCoverage = true; m.needsUpdate = true; } });
    // crisp textures at grazing angles (her dress, hair cards, shoes): full anisotropic filtering, capped at 8
    { const an = Math.min(8, this.renderer.capabilities?.getMaxAnisotropy?.() || 1); if (an > 1) vrm.scene.traverse((o) => { if (!o.isMesh) return; for (const m of [].concat(o.material)) for (const k of ['map', 'normalMap', 'emissiveMap', 'shadeMultiplyTexture']) { const t = m?.[k]; if (t?.isTexture && t.anisotropy < an) { t.anisotropy = an; t.needsUpdate = true; } } }); }
    if (new URLSearchParams(location.search).get('outline') !== '1') vrm.scene.traverse((o) => { if (!o.isMesh) return; for (const m of [].concat(o.material)) if (m?.isOutline && m.visible !== false) { m.visible = false; this.outlinesOff++; } });
    if (this.vrm) { this.scene.remove(this.vrm.scene); VRMUtils.deepDispose(this.vrm.scene); }
    this.vrm = vrm;
    this.polish = new MotionPolish(this);   // joint limits + One-Euro smoothing on her final pose (motionpolish.js)
    this.camSpring = null;                  // a new body re-frames from scratch
    // a glTF/PBR body (her v37r10 VRM: standard materials, not MToon) needs a soft room reflection to read as skin and
    // fabric instead of flat plastic; MToon bodies ignore it
    try {
      let pbr = false; vrm.scene.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if (m?.isMeshStandardMaterial) pbr = true; });
      if (pbr && !this.envTex && this.renderer?.capabilities) {
        const pm = new THREE.PMREMGenerator(this.renderer); this.envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose();
        this.scene.environment = this.envTex; this.scene.environmentIntensity = 0.5;
      }
    } catch (e) { console.warn('env', e); }
    try { this.checkRig(vrm); } catch (e) { console.warn('rig check', e); }
    this.scene.add(vrm.scene);
    this.scene.add(this.gaze);
    if (vrm.lookAt) vrm.lookAt.target = this.gaze;
    try { this.installEyesOpen(vrm); } catch (e) { console.warn('eyes-open', e); }
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
    // grounding: world up is +y, the floor is y = 0 (or whatever groundAt(x, z) / groundObjects say, e.g. /world's
    // floor). Each foot's ankle sits at its rest height above the ground; feet can step (updateFeet).
    this.up = new THREE.Vector3(0, 1, 0);
    this.ankleH = { left: this.feet.left.y, right: this.feet.right.y };
    const mid = this.feet.left.clone().add(this.feet.right).multiplyScalar(0.5);
    this.feetRest = { left: this.feet.left.clone().sub(mid), right: this.feet.right.clone().sub(mid) };
    // BALLS OF HER FEET (Saidie, Oct 19 + Oct 21 8:10 AM: "she on the balls of her feet? NOT FLAT"): her avatar has
    // high-heel toes, so she stands with her heels up and her weight on the balls of her feet. The heel lift pivots the
    // foot about its toe joint (the ball), so per foot we keep the ankle's offset from the ball at rest: b = how far the
    // ankle sits behind the ball, h = how high above it, and the ball->toe direction in the rig root's frame.
    this.ball = {};
    const rootQi = H.normalizedHumanBonesRoot.getWorldQuaternion(new THREE.Quaternion()).invert();
    for (const s of ['left', 'right']) {
      const T = H.getNormalizedBoneNode(s + 'Toes'); if (!T) continue;
      const tp = T.getWorldPosition(new THREE.Vector3()), ap = this.feet[s];
      const dir = new THREE.Vector3(tp.x - ap.x, 0, tp.z - ap.z), b = dir.length();
      if (b < 0.02) continue;
      this.ball[s] = { b, h: ap.y - tp.y, dir: dir.normalize().applyQuaternion(rootQi), jy: tp.y, dirW: dir.clone(), tp: tp.clone(), toe: 0, bp: 0, dp: tp.y };
    }
    // the rendered pads, not the bones: the lowest skinned vertex of each foot's toes, and of its ball (the sole just
    // behind the toe joint), measured once in the rest pose. Standing on the ball, whichever pad is lower is put
    // exactly on the floor (a reviewer saw the toes hover ~7 mm when only the toe JOINT was grounded).
    try {
      const raw = {}, v = new THREE.Vector3(), rel = new THREE.Vector3();
      for (const s of Object.keys(this.ball)) raw[s] = { T: H.getRawBoneNode(s + 'Toes'), F: H.getRawBoneNode(s + 'Foot'), toe: Infinity, ball: Infinity };
      vrm.scene.traverse((o) => {
        if (!o.isSkinnedMesh || !o.geometry?.attributes?.skinIndex) return;
        const g = o.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, n = g.attributes.position.count, bones = o.skeleton.bones;
        const ids = Object.entries(raw).map(([s, r]) => [s, bones.indexOf(r.T), bones.indexOf(r.F)]).filter((x) => x[1] >= 0 || x[2] >= 0);
        if (!ids.length) return;
        for (let i = 0; i < n; i++) {
          let best = -1, bw = 0; for (let c = 0; c < 4; c++) { const w = sw.getComponent(i, c); if (w > bw) { bw = w; best = si.getComponent(i, c); } }
          const hit = ids.find((x) => x[1] === best || x[2] === best); if (!hit) continue;
          o.getVertexPosition(i, v); v.applyMatrix4(o.matrixWorld);
          const s = hit[0], B = this.ball[s], r = raw[s];
          if (best === hit[1]) r.toe = Math.min(r.toe, v.y);
          else { const along = rel.subVectors(v, B.tp).dot(B.dirW); if (along > -0.035 && along < 0.006 && v.y < r.ball) { r.ball = v.y; B.bp = Math.max(0, -along); B.dp = B.jy - v.y; } }
        }
      });
      for (const s of Object.keys(raw)) { if (Number.isFinite(raw[s].toe)) this.ball[s].toe = raw[s].toe; }
      this.padDbg = Object.fromEntries(Object.entries(this.ball).map(([s, B]) => [s, { toe: +B.toe.toFixed(4), ballBack: +B.bp.toFixed(4), ballDown: +B.dp.toFixed(4), joint: +B.jy.toFixed(4) }]));
    } catch (e) { console.warn('foot pads', e); }
    this.heel = { left: 0.5, right: 0.5, vl: 0, vr: 0 }; this.heelLift = 0; this.heelOff = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    this.stepState = null; this.hipDrop = 0; this.nextIdleStep = performance.now() + 20000 + Math.random() * 25000;
    this.addFloor();
  }

  // the ground height under (x, z): a groundAt(x, z) hook, a raycast down onto groundObjects, else the floor (y = 0)
  groundY(x, z) {
    if (this.groundAt) { const y = this.groundAt(x, z); if (Number.isFinite(y)) return y; }
    if (this.groundObjects?.length) {
      this._ray ||= new THREE.Raycaster(); this._ray.set(_v[11].set(x, 3, z), _v[10].set(0, -1, 0)); this._ray.far = 6;
      const hit = this._ray.intersectObjects(this.groundObjects, true)[0];
      if (hit) return hit.point.y;
    }
    return this.floorY || 0;
  }
  // ask for a step (a big reaction, a turn): she re-plants a foot under her hips
  // shoulders: shrug ('both' | 'L' | 'R'), drop (relaxed down) or roll (forward-up-back)
  shrug(side = 'both', amt = 0.18 + Math.random() * 0.12, ms = 650 + Math.random() * 500, kind = 'shrug') {
    if (!this.sh) return null;
    const asym = side === 'both' ? Math.random() * 0.3 : 0;
    this.sh.ev = { t0: performance.now(), ms, side, amt, kind, aL: 1 - (Math.random() < 0.5 ? asym : 0), aR: 1 - (Math.random() < 0.5 ? asym : 0) };
    try { const Lg = (window.jenaLog ||= []); Lg.push({ t: Math.round(performance.now()), kind: 'shoulders', what: kind + ':' + side, why: 'shoulders' }); } catch {}
    return this.sh.ev;
  }
  // spin all the way around (or more): dir 1/-1, turns 1 = 360 degrees
  spin(dir = Math.random() < 0.5 ? 1 : -1, ms = 1500 + Math.random() * 700, turns = 1) { this.spinState = { t0: performance.now(), dur: ms, dir, turns }; try { const L = (window.jenaLog ||= []); L.push({ t: Math.round(performance.now()), kind: 'spin', what: (dir > 0 ? 'ccw' : 'cw') + ' ' + turns, why: 'spin' }); } catch {} return this.spinState; }
  requestStep(why = 'asked') { this.stepAsk = { why, at: performance.now() }; }
  // FEET: planted feet stay exactly on the ground (no float, no sink, no skating); she steps when her hips drift too
  // far from the base between her feet (> 9 cm), when her body turns away from her feet (> 20°), when a big reaction
  // asks for it, and now and then on her own while idle. A step lifts the lighter foot, arcs it (4-8 cm high) and
  // re-plants it under her hips at her rest stance, with a non-repeating variant (wider/narrower/forward/back/turn).
  updateFeet(dt, now) {
    if (!this.feet || !this.feetRest) return;
    const H = this.vrm.humanoid, hips = H.getNormalizedBoneNode('hips');
    const hp = hips.getWorldPosition(_v[9]);
    // spinning: she pivots on her feet (both feet turn around her hips with her, staying on the floor) instead of
    // stepping or twisting her legs around each other
    {
      // the same pivot carries a dance turn (src/dance.js sets danceYaw: the dancer's turn, relative to her start facing)
      const turn = (this._spinY || 0) + (this.danceYaw || 0);
      const d = turn - (this._spinPrev || 0);
      this._spinPrev = (this.spinState || this.dancing) ? turn : 0;
      if (Math.abs(d) > 1e-5) for (const s of ['left', 'right']) { const FY = (this.footYaw ||= { left: 0, right: 0 }); FY[s] = Math.atan2(Math.sin(FY[s] + d), Math.cos(FY[s] + d)); const f = this.feet[s], dx = f.x - hp.x, dz = f.z - hp.z, c = Math.cos(d), sn = Math.sin(d); f.x = hp.x + dx * c + dz * sn; f.z = hp.z - dx * sn + dz * c; }
    }
    if (this.seatW > 0.02) return;   // sitting in her chair: feet stay where they are, no steps
    // r11 LATERAL MOVE: while she side-steps (travel), her feet carry the move with her hips: the leading foot steps
    // out first, the trailing foot follows and closes the stance (each with a small lift), so her legs never stretch
    // after hips that left them behind (that sank her ~5-7 cm and twisted her in the first try)
    let trav = false;
    if (this.travelState && (!this._trav || this._trav.T !== this.travelState)) {
      const T = this.travelState, dx = T.to - T.from;
      this._trav = { T, from: { left: this.feet.left.clone(), right: this.feet.right.clone() }, lead: dx * Math.sign((this.feetRest.left.x - this.feetRest.right.x) || 1) > 0 ? 'left' : 'right' };
      this.stepState = null;
    }
    if (this._trav) {
      const R = this._trav, T = R.T, u = Math.min(1, Math.max(0, (now - T.t0) / T.dur)), dx = T.to - T.from;
      for (const s of ['left', 'right']) {
        const a = Math.min(1, Math.max(0, s === R.lead ? u * 1.6 : u * 1.6 - 0.6)), e = a * a * (3 - 2 * a), f = this.feet[s];
        f.x = R.from[s].x + dx * e; f.z = R.from[s].z;
        f.y = this.groundY(f.x, f.z) + this.ankleH[s] + Math.sin(Math.PI * a) * 0.035;
      }
      trav = true;
      if (u >= 1) { this._trav = null; this.lastStep = now; this._noopAt = now; }
    }
    const S = this.stepState;
    if (trav || (this.spinState && !S)) { /* no steps mid-spin / mid side-step */ }
    else if (S) {
      const u = Math.min(1, (now - S.t0) / S.dur), e = u * u * (3 - 2 * u);
      const f = this.feet[S.side];
      f.lerpVectors(S.from, S.to, e);
      f.y = S.from.y + (S.to.y - S.from.y) * e + Math.sin(Math.PI * u) * S.lift;
      if (S.yawTo !== undefined) { const FY = (this.footYaw ||= { left: 0, right: 0 }); FY[S.side] = S.yawFrom + (S.yawTo - S.yawFrom) * e; }
      if (u >= 1) { f.copy(S.to); this.stepState = null; this.lastStep = now; this.steps = (this.steps || 0) + 1; }
    } else {
      const mid = _v[8].copy(this.feet.left).add(this.feet.right).multiplyScalar(0.5);
      const drift = Math.hypot(hp.x - mid.x, hp.z - mid.z);
      const fyaw = Math.atan2(this.feet.left.z - this.feet.right.z, this.feet.left.x - this.feet.right.x);   // 0 = squared up
      const hq = hips.getWorldQuaternion(_q[3]), fwd = _v[7].set(0, 0, 1).applyQuaternion(hq);
      const byaw = Math.atan2(fwd.x, fwd.z);
      // turn is measured against her own rest relation of hips to feet (the model's forward axis differs by VRM
      // version), so a squared-up stance reads 0 whichever way the rig faces
      const rel = byaw + fyaw;
      if (this._turnRef === undefined) this._turnRef = rel;
      const turn = Math.abs(((rel - this._turnRef) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
      this.feetDbg = { drift: +drift.toFixed(3), turn: +turn.toFixed(2) };
      const busy = this.motion?.moves?.busy;
      let why = null;
      const noop = now - (this._noopAt || 0) < 4000;   // the last balance/turn step had nowhere to go: don't spin on it
      // feet crossed too far (more than 6 cm past each other along her hips' side axis): step out of it
      const latv = _v[5].set(1, 0, 0).applyQuaternion(hq); 
      const sepRaw = (this.feet.left.x - this.feet.right.x) * latv.x + (this.feet.left.z - this.feet.right.z) * latv.z;
      if (this._latSign === undefined && Math.abs(sepRaw) > 0.05) this._latSign = Math.sign(sepRaw);
      const crossed = this._latSign !== undefined && sepRaw * this._latSign < 0.06;   // standing: feet never cross (sitting poses are the only crossed legs)
      this.feetDbg.cross = +(-(sepRaw * (this._latSign || 1))).toFixed(3);
      if (crossed && !noop) why = 'uncross';
      else if (drift > (this.travelState ? 0.07 : 0.09) && !noop) why = 'balance';
      else if (turn > 0.35 && !noop) why = 'turn';
      else if (this.stepAsk && now - this.stepAsk.at < 1500) why = this.stepAsk.why;
      else if (now > this.nextIdleStep && ((!busy && now > (this.talk?.until || 0)) || now > this.nextIdleStep + 15000)) { why = 'idle'; this.nextIdleStep = now + 18000 + Math.random() * 30000; }
      if (why && now - (this.lastStep || 0) > ((why === 'balance' || why === 'turn' || why === 'uncross') ? (turn > 0.6 || why === 'uncross' || this.spinState || this.travelState ? 280 : 1600) : 700) && now - (this.lastStep || 0) > 700) {
        this.stepAsk = null;
        // the lighter foot steps: the one farther from under her hips
        const dl = Math.hypot(hp.x - this.feet.left.x, hp.z - this.feet.left.z), dr = Math.hypot(hp.x - this.feet.right.x, hp.z - this.feet.right.z);
        let side = dl > dr ? 'left' : 'right';
        if (this._lastStepSide === side && now - (this.lastStep || 0) < 3500 && Math.abs(dl - dr) < 0.06) side = side === 'left' ? 'right' : 'left';   // feet take turns, like walking
        this._lastStepSide = side;
        if (why === 'idle' && Math.random() < 0.35) {   // a fidget: the foot just pivots on its heel/ball, no step
          const FY = (this.footYaw ||= { left: 0, right: 0 }), from = FY[side], to2 = from + (Math.random() - 0.5) * 0.5;
          this.footPivot = { side, from, to: THREE.MathUtils.clamp(to2, -0.7, 0.7), t0: now, dur: 350 + Math.random() * 300 }; this.lastStep = now;
          try { const Lg = (window.jenaLog ||= []); Lg.push({ t: Math.round(now), kind: 'pivot', what: side + ' ' + (to2 - from).toFixed(2), why }); } catch {}
          why = null;
        }
        if (why) {
        this._stepNR ||= new NoRepeat({ minGap: 2, windowMs: 20000 });
        const style = this._stepNR.pick(['rest', 'wide', 'narrow', 'fwd', 'back', 'toe_out'], { pool: 'step' });
        const off = { rest: [0, 0], wide: [0.035, 0], narrow: [-0.025, 0], fwd: [0, 0.04], back: [0, -0.035], toe_out: [0.015, 0.015] }[style];
        const sx = side === 'left' ? 1 : -1;
        const rest = this.feetRest[side];
        // her stance turns with her body: the rest offset is rotated by how far her hips have turned from her feet
        const yd = ((rel - this._turnRef) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
        const o = new THREE.Vector3(rest.x + off[0] * sx, 0, rest.z + off[1]).applyAxisAngle(_v[6].set(0, 1, 0), turn > 0.2 ? yd : 0);
        const to = new THREE.Vector3(hp.x + o.x, 0, hp.z + o.z);
        // keep the other foot as the pivot: never step closer than 12 cm or farther than 45 cm from it
        const other = this.feet[side === 'left' ? 'right' : 'left'], dx = to.x - other.x, dz = to.z - other.z, dd = Math.hypot(dx, dz);
        if (dd < 0.12 || dd > 0.45) { const k = THREE.MathUtils.clamp(dd, 0.12, 0.45) / (dd || 1); to.x = other.x + dx * k; to.z = other.z + dz * k; }
        to.y = this.groundY(to.x, to.z) + this.ankleH[side];
        // standing feet never cross: each ankle stays on its own side, at least 8 cm from the other along her hips' side axis
        const ax = new THREE.Vector3(1, 0, 0).applyAxisAngle(_v[6].set(0, 1, 0), turn > 0.2 ? yd : 0);
        const sgn = Math.sign(this.feetRest.left.x - this.feetRest.right.x) || 1, want = side === 'left' ? sgn : -sgn;
        const capCross = () => { const sep = ((to.x - other.x) * ax.x + (to.z - other.z) * ax.z) * want; if (sep < 0.08) { const k = (0.08 - sep) * want; to.x += ax.x * k; to.z += ax.z * k; to.y = this.groundY(to.x, to.z) + this.ankleH[side]; } };
        capCross();
        let len = Math.hypot(to.x - this.feet[side].x, to.z - this.feet[side].z);
        if (len < 0.03 && why !== 'balance' && why !== 'turn' && why !== 'uncross') {   // an asked-for or idle step always visibly moves the foot
          const a = Math.random() * Math.PI * 2, r = 0.035 + Math.random() * 0.03;
          to.x += Math.cos(a) * r * 0.8; to.z += Math.sin(a) * r;
          const ddx = to.x - other.x, ddz = to.z - other.z, d2 = Math.hypot(ddx, ddz);
          if (d2 < 0.12 || d2 > 0.45) { const k2 = THREE.MathUtils.clamp(d2, 0.12, 0.45) / (d2 || 1); to.x = other.x + ddx * k2; to.z = other.z + ddz * k2; }
          to.y = this.groundY(to.x, to.z) + this.ankleH[side];
          capCross();
          len = Math.hypot(to.x - this.feet[side].x, to.z - this.feet[side].z);
        }
        if (len > 0.015 && why) { try { const L = (window.jenaLog ||= []); L.push({ t: Math.round(now), kind: 'step', what: side + ':' + style, why }); if (L.length > 400) L.shift(); } catch {} }
        if (len > 0.015) this.stepState = { yawFrom: (this.footYaw ||= { left: 0, right: 0 })[side], yawTo: (() => { const hy = H.getNormalizedBoneNode('hips').rotation.y; const b = Math.atan2(Math.sin(hy), Math.cos(hy)) + (side === 'left' ? 1 : -1) * (0.08 + Math.random() * 0.12); const cur = this.footYaw[side]; return cur + Math.atan2(Math.sin(b - cur), Math.cos(b - cur)); })(), side, from: this.feet[side].clone(), to, t0: now, dur: 300 + len * 900 + Math.random() * 120, lift: 0.04 + Math.min(0.04, len * 0.15) + Math.random() * 0.01, why, style };
        else { this.lastStep = now; if (why === 'balance' || why === 'turn') this._noopAt = now; if (why === 'turn') this._turnRef = rel; }
        }
      }
    }
    if (this.footPivot) { const P = this.footPivot, u = Math.min(1, (now - P.t0) / P.dur), e = u * u * (3 - 2 * u); (this.footYaw ||= { left: 0, right: 0 })[P.side] = P.from + (P.to - P.from) * e; if (u >= 1) this.footPivot = null; }
    // planted feet: snapped onto the ground every frame (whatever a pose or tracked move wanted), and (standing)
    // each ankle kept on its OWN side of her hips' midline, at least 3.5 cm out: no X-legs, no crossed feet
    const mid = this.legMidline();
    for (const s of ['left', 'right']) {
      if (this.stepState?.side === s) continue;
      const f = this.feet[s];
      if (mid) { const sg = s === 'left' ? 1 : -1, off = ((f.x - mid.c.x) * mid.lat.x + (f.z - mid.c.z) * mid.lat.z) * sg; if (off < 0.035) { const k = (0.035 - off) * sg; f.x += mid.lat.x * k; f.z += mid.lat.z * k; } }
      const gy = this.groundY(f.x, f.z) + this.ankleH[s];
      f.y = gy;
    }
    // hips follow the lower foot: if a leg can't reach its planted foot, the hips sink so the knees bend (never hover)
    let need = 0;
    for (const s of ['left', 'right']) {
      const U = H.getNormalizedBoneNode(s + 'UpperLeg'), K = H.getNormalizedBoneNode(s + 'LowerLeg'), F = H.getNormalizedBoneNode(s + 'Foot');
      if (!U || !K || !F) continue;
      const pu = U.getWorldPosition(_v[0]), len = (this.legLen ||= {})[s] ||= pu.distanceTo(K.getWorldPosition(_v[1])) + K.getWorldPosition(_v[1]).distanceTo(F.getWorldPosition(_v[2]));
      const tgt = _v[3].copy(this.feet[s]).add(this.heelOff?.[s] || _v[4].set(0, 0, 0)), d = pu.distanceTo(tgt);   // the ankle where the raised heel puts it
      if (d > len * 0.985) need = Math.max(need, Math.min(0.12, (d - len * 0.985) * (pu.y - tgt.y) / Math.max(d, 1e-3)));
    }
    this.hipDrop += (need - this.hipDrop) * Math.min(1, dt * 12);
    if (this.hipDrop > 1e-4) { hips.position.y -= this.hipDrop; hips.updateMatrixWorld(true); }
    if (this.footShadows) for (const s of ['left', 'right']) { const m = this.footShadows[s]; m.position.x = this.feet[s].x; m.position.z = this.feet[s].z + 0.03; m.position.y = this.groundY(this.feet[s].x, this.feet[s].z) + 0.0015; }
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
    this.floorRug = disc(1.25, 0.95, rug, 0.0005);   // hidden by the room (src/room-bg.js) once she stands on its real rug
    g.add(this.floorRug);
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
    // heel up, pivoting about the ball of the foot: the ankle rises and comes forward over the ball (updateHeels)
    const th = this.heelNow?.[side] || 0, B = this.ball?.[side], fy0 = (this.footYaw ||= { left: 0, right: 0 })[side] || 0;
    const off = (this.heelOff ||= { left: new THREE.Vector3(), right: new THREE.Vector3() })[side].set(0, 0, 0);
    if (B && th > 1e-4) {
      const c = Math.cos(th), s = Math.sin(th), bb = B.b * c - B.h * s, hh = B.b * s + B.h * c;
      const rq = H.normalizedHumanBonesRoot.getWorldQuaternion(_q[3]);
      if (Math.abs(fy0) > 1e-4) rq.premultiply(_q[4].setFromAxisAngle(_v[5].set(0, 1, 0), fy0));
      const dir = _v[6].copy(B.dir).applyQuaternion(rq); dir.y = 0; dir.normalize();
      // the lower of the two rendered pads goes on the floor: the ball (rotating up about the toe joint as the heel
      // rises) or the toes (kept flat, curled down a touch so their pads press into the floor)
      const ballY = B.jy - B.dp * c + B.bp * s, toeY = B.toe - TOE_PRESS * 0.03 * (1 - (this.heelAir?.[side] || 0));
      off.set(dir.x * (B.b - bb), hh - B.h - Math.min(ballY, toeY), dir.z * (B.b - bb));
      target.add(off);
    } else if (free) { off.set(0, 0.05 * free, -0.015 * free); target.add(off); }   // (no toe bone: the old free-leg lift)
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
    // knee tracks the toes: the whole leg rolls about its hip-to-ankle line by the foot's own yaw
    const fy = (this.footYaw ||= { left: 0, right: 0 })[side] || 0;
    const hy0 = H.getNormalizedBoneNode('hips')?.rotation.y || 0, fr = Math.atan2(Math.sin(fy - hy0), Math.cos(fy - hy0));   // relative to her hips' facing (no flip at +-180)
    if (Math.abs(fr) > 1e-4) wq.premultiply(_q[0].setFromAxisAngle(_v[3].subVectors(target, pu).normalize(), -THREE.MathUtils.clamp(fr, -0.9, 0.9) * 0.85));
    U.quaternion.copy(U.parent.getWorldQuaternion(_q[2]).invert().multiply(wq));
    U.updateMatrixWorld(true);
    this.keepKneeOut(side, U, K, F, target);
    // flat foot, turned by its own yaw (each foot points its own way: toe-out, pivots, following her turns)
    const root = H.normalizedHumanBonesRoot.getWorldQuaternion(_q[1]);
    if (Math.abs(fy) > 1e-4) root.premultiply(_q[3].setFromAxisAngle(_v[5].set(0, 1, 0), fy));
    F.quaternion.copy(F.parent.getWorldQuaternion(_q[2]).invert().multiply(root));
    if (lift) F.rotateX(-lift); // toes up (heel stays down) for a foot tap
    if (B) {
      if (th > 1e-4) F.rotateX(th);   // heel up about the ball
      // toes: flat on the floor while she stands on the ball (bent back by the heel angle), with a little life of their
      // own: they grip a touch as she rises and spread flat as she settles; in the air they follow the foot loosely
      const T = H.getNormalizedBoneNode(side + 'Toes');
      if (T) { const air = this.heelAir?.[side] || 0, grip = (this.toeGrip?.[side] || 0); T.rotation.set(-th * (1 - 0.65 * air) + grip + TOE_PRESS * (1 - air), 0, 0); }
    } else if (free) F.rotateX(0.45 * free); // toes stay on the floor while the heel is up
    F.updateMatrixWorld(true);
  }

  // BALLS OF HER FEET (Saidie: "she on the balls of her feet? NOT FLAT" / "if you're doing flat feet ... make sure her feet
  // and movements are SO MUCH natural"). Each heel is a small spring (slightly under-damped, so it settles instead of
  // snapping) toward a target built from: her high-heel stance (~27-32 deg, drifting slowly on its own noise, never a
  // cycle), weight (the loaded foot's heel sinks a little, the free foot rises onto its ball), steps (heel peels up
  // first = toe-off, the foot lands ball first, the heel settles), the odd rise onto her toes or a lower settle at
  // random intervals, and a foot tap (heel comes down so the toes can lift). Sitting fades it all out.
  updateHeels(dt, now, t, L, tap) {
    if (!this.ball || !this.heel) return;
    this.HN ||= { l: noise(), r: noise(), gl: noise(), gr: noise() };
    const seat = THREE.MathUtils.clamp(1 - (this.seatW || 0) * 1.5, 0, 1);
    // occasional weight moments, at random intervals (never periodic): a rise onto the toes, or a lower settle
    if (!this._heelEv || now > this._heelEv.t0 + this._heelEv.dur) {
      if (this._heelEv) this._heelNext = now + 9000 + Math.random() * 26000;
      this._heelEv = null;
      if (now > (this._heelNext ??= now + 6000 + Math.random() * 12000) && !this.stepState) {
        const kind = Math.random() < 0.45 ? 'rise' : 'settle';
        this._heelEv = { kind, t0: now, dur: kind === 'rise' ? 1100 + Math.random() * 900 : 1600 + Math.random() * 1600, amt: kind === 'rise' ? 0.22 + Math.random() * 0.14 : -(0.1 + Math.random() * 0.08), side: Math.random() < 0.5 ? 'both' : (Math.random() < 0.5 ? 'left' : 'right') };
      }
    }
    const ev = this._heelEv, evu = ev ? (now - ev.t0) / ev.dur : 0, evw = ev ? Math.sin(Math.PI * Math.min(1, Math.max(0, evu))) ** 2 : 0;
    const S = this.stepState, H = this.HN;
    this.heelNow ||= { left: 0.5, right: 0.5 }; this.heelAir ||= { left: 0, right: 0 }; this.toeGrip ||= { left: 0, right: 0 };
    let minRise = Infinity;
    for (const side of ['left', 'right']) {
      const k = side === 'left' ? 'l' : 'r';
      const free = side === 'left' ? Math.max(0, -L) : Math.max(0, L), load = side === 'left' ? Math.max(0, L) : Math.max(0, -L);
      let want = 0.52 + H[k](t * 0.045 + (k === 'l' ? 0 : 17)) * 0.05 - load * 0.07 + free * 0.32;
      if (ev && (ev.side === 'both' || ev.side === side)) want += ev.amt * evw;
      let air = 0;
      if (S && S.side === side) {
        const u = Math.min(1, (now - S.t0) / S.dur);
        // toe-off: the heel peels up first; mid-swing the foot relaxes; it reaches for the floor ball first
        want = u < 0.3 ? want + 0.45 * (u / 0.3) : u < 0.75 ? want + 0.45 - 0.3 * ((u - 0.3) / 0.45) : want + 0.15 * (1 - (u - 0.75) / 0.25);
        air = Math.sin(Math.PI * u);
      } else if (S) want += 0.04;   // the standing foot presses a little higher while the other one is in the air
      if (tap && tap.side === side) want *= 1 - Math.min(1, tap.v * 3);   // a foot tap: heel down so the toes can lift
      want = THREE.MathUtils.clamp(want * seat, 0, 1.15);
      // critically-ish damped heel spring (zeta 0.8): a soft settle, no snap
      const kk = S && S.side === side ? 140 : 55, z = 0.8, vk = side === 'left' ? 'vl' : 'vr';
      const a = kk * (want - this.heel[side]) - 2 * z * Math.sqrt(kk) * this.heel[vk];
      this.heel[vk] += a * dt; this.heel[side] += this.heel[vk] * dt;
      const th = this.heelNow[side] = THREE.MathUtils.clamp(this.heel[side], 0, 1.2);
      this.heelAir[side] = air;
      // toes grip slightly as the heel rises fast, and relax as it settles
      this.toeGrip[side] = damp(this.toeGrip[side], THREE.MathUtils.clamp(this.heel[vk] * 0.06, -0.06, 0.08) + H['g' + k](t * 0.11) * 0.03, 6, dt);
      const B = this.ball[side];
      if (B && !(S && S.side === side)) minRise = Math.min(minRise, B.b * Math.sin(th) + B.h * Math.cos(th) - B.h);
    }
    // her hips ride up with the heels of the foot carrying her (the lower one), so her knees keep their bend
    if (!Number.isFinite(minRise)) minRise = this.heelLift || 0;
    this.heelLift = damp(this.heelLift || 0, minRise * seat, 10, dt);
  }

  // her hips' midline for the legs: the point between her hip joints and the horizontal axis toward HER left.
  // Null while she sits (crossed legs are an approved sitting pose) or without leg bones.
  legMidline() {
    if (this.seatW > 0.02 || !this.vrm) return null;
    const H = this.vrm.humanoid, L = H.getNormalizedBoneNode('leftUpperLeg'), R = H.getNormalizedBoneNode('rightUpperLeg');
    if (!L || !R) return null;
    const lp = L.getWorldPosition(new THREE.Vector3()), rp = R.getWorldPosition(new THREE.Vector3());
    const lat = new THREE.Vector3(lp.x - rp.x, 0, lp.z - rp.z); if (lat.lengthSq() < 1e-6) return null; lat.normalize();
    return { c: lp.add(rp).multiplyScalar(0.5), lat };
  }
  // standing knees stay on their own side of the midline with a small gap (a slight inward knee is fine,
  // crossing is not): if the knee is closer than 3 cm to the midline, the leg rolls outward about its
  // hip-to-ankle line (the foot stays planted). Per-frame knee/ankle offsets go to legDbg for the proof.
  keepKneeOut(side, U, K, F, target) {
    const m = this.legMidline(); if (!m) { this.legDbg = null; return; }
    const sg = side === 'left' ? 1 : -1, MIN = 0.03, kp = new THREE.Vector3();
    const off = (p) => ((p.x - m.c.x) * m.lat.x + (p.z - m.c.z) * m.lat.z) * sg;
    const knee = () => off(K.getWorldPosition(kp));
    let k0 = knee(), rolled = 0;
    if (k0 < MIN) {
      const pu = U.getWorldPosition(new THREE.Vector3()), axis = new THREE.Vector3().subVectors(target, pu).normalize();
      const base = U.quaternion.clone(), parentQ = U.parent.getWorldQuaternion(new THREE.Quaternion()), w0 = parentQ.clone().multiply(base);
      const tryA = (a) => { U.quaternion.copy(parentQ.clone().invert().multiply(new THREE.Quaternion().setFromAxisAngle(axis, a).multiply(w0))); U.updateMatrixWorld(true); return knee(); };
      const dir = tryA(0.05) > k0 ? 1 : -1;
      let best = k0;
      for (let a = 0.05; a <= 1.2 + 1e-6; a += 0.05) { best = tryA(a * dir); rolled = a * dir; if (best >= MIN) break; }
      k0 = best;
    }
    const ank = off(F.getWorldPosition(kp));
    (this.legDbg ||= {})[side] = { knee: +k0.toFixed(3), ankle: +ank.toFixed(3), rolled: +rolled.toFixed(2) };
  }

  // ADAPTIVE QUALITY toward the screen's own refresh rate (60 Hz, or 120 Hz on ProMotion; the render loop is
  // never capped, it runs at whatever the display gives). The refresh period is measured from the fastest
  // frames seen. Frames averaging >12% slower than that for 2.5 s are a real drop: step down one notch -
  // pixel ratio a quarter step at a time (floor 1x on a GPU, 0.6x on a software renderer like this box's
  // SwiftShader), then the extra camera panels drop 60 -> 30 / 15 / 8 Hz. Back at the refresh rate for 8 s:
  // one notch back up, never above native resolution. Silent: no toggle.
  // ?dpr=<n> pins the pixel ratio; ?quality=low|high pins the level.
  prCeiling() { return this.nativeRatio || window.devicePixelRatio || 1; } // native device resolution, never above

  renderInfo() {
    const c = this.renderer?.domElement, Q = this.quality || {};
    return { fps: Q.fps || null, refreshHz: Q.vsync ? Math.round(1000 / Q.vsync) : null, width: c?.width || 0, height: c?.height || 0,
      pixelRatio: +(this.renderer?.getPixelRatio?.() || 1).toFixed(2), nativeRatio: this.nativeRatio || 1, level: Q.level ?? 3, panelHz: this.panelHz(), software: !!Q.soft };
  }
  adaptPixels(raw) {
    if (!(raw > 0) || raw > 0.25 || document.hidden) return;
    const now = performance.now();
    const Q = (this.quality ||= (() => {
      let soft = false;
      try { const gl = this.renderer.getContext?.(), e = gl?.getExtension('WEBGL_debug_renderer_info'); soft = /swiftshader|llvmpipe|software/i.test(e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : ''); } catch {}
      const pin = new URLSearchParams(location.search).get('quality');
      return { soft, level: pin === 'low' ? 0 : 3, pinned: !!pin, ms: 16.7, cool: now + 4000, fastSince: 0, failed: {}, steps: 0, prMax: this.prCeiling(), vsync: 16.7, hist: [] };
    })());
    const ms1 = raw * 1000;
    // the display's refresh period: the 10th-percentile frame time over the last ~2 s, snapped to 60/90/120/144 Hz
    Q.hist.push(ms1); if (Q.hist.length > 240) Q.hist.shift();
    if (Q.hist.length >= 30 && (Q.hist.length % 15 === 0)) {
      const p10 = [...Q.hist].sort((a, b) => a - b)[Math.floor(Q.hist.length * 0.1)];
      const hz = [60, 90, 120, 144].reduce((b, h) => (Math.abs(1000 / h - p10) < Math.abs(1000 / b - p10) ? h : b), 60);
      Q.vsync = 1000 / hz;
    }
    Q.ms = Q.ms * 0.95 + ms1 * 0.05;
    Q.fps = +(1000 / Q.ms).toFixed(1);
    if (Q.pinned || now < Q.cool) return;
    // SHARPNESS (Saidie, Oct 21: "step up the resolution"): she renders at the screen's real pixel ratio (3x on an iPhone).
    // The budget is 60 fps even on 90/120 Hz screens (chasing 120 Hz used to throw away resolution on every phone), the
    // extra camera panels slow down FIRST, and only a real drop below ~48 fps lowers her pixel ratio, never under 2x on a
    // GPU (0.6x only on a software renderer like this box's SwiftShader).
    const pr = this.renderer.getPixelRatio(), floor = Q.soft ? 0.6 : Math.min(this.nativeRatio || 1, 2);
    const budget = Math.max(Q.vsync, 16.7);
    if (Q.ms > budget * 1.25) {
      Q.fastSince = 0;
      if (Q.level > 0) { Q.failed[Q.level] = now; Q.level--; }
      else if (!this.dprPinned && pr > floor + 0.01) { this.renderer.setPixelRatio(Math.max(floor, Math.round((pr - 0.25) * 4) / 4)); this.resize(); this.pixelSteps = (this.pixelSteps || 0) + 1; Q.failed.pr = now; }
      else return;
      Q.steps++; Q.cool = now + 2500; Q.ms = budget;
    } else if (Q.ms < budget * 1.05) {
      Q.fastSince ||= now;
      if (now - Q.fastSince > 8000) {
        Q.fastSince = 0; Q.cool = now + 3000;
        if (!this.dprPinned && pr < Q.prMax - 0.01 && !(now - (Q.failed.pr || -1e9) < 60000)) { this.renderer.setPixelRatio(Math.min(Q.prMax, pr + 0.25)); this.resize(); }
        else if (Q.level < 3 && !(now - (Q.failed[Q.level + 1] || -1e9) < 60000)) Q.level++;
      }
    } else Q.fastSince = 0;
  }
  // how often the extra camera panels may redraw (self-view, face panel, body views), from the quality level
  panelHz() { return [8, 15, 30, 60][this.quality?.level ?? 3]; }

  resize() {
    const el = this.canvas.parentElement;
    // full view (desktop page, not the phone app, the stream layout or a page that drives its own camera)
    this.fullView = !this.cameraHeld && new URLSearchParams(location.search).get('box') !== '1' && !document.body.classList.contains('m-app') && !document.body.classList.contains('stream') && el?.id === 'avatar-panel';
    document.body.classList.toggle('jena-fullview', !!this.fullView);
    if (this.fullView) { this._fvKey = null; this.layoutFullView(); this.frameCamera(); return; }
    if (this.camera.view?.enabled) { this.camera.clearViewOffset(); const c = this.canvas.style; c.position = c.left = c.top = c.width = c.height = c.inset = ''; }
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
    const fov = THREE.MathUtils.degToRad(this.camera.fov), tan = Math.tan(fov / 2);
    // full view: her arms and hair may go past her stage area (no box), so the width limit is a little looser
    const asp = (this.camera.aspect || 1) * (this.fullView ? 1.6 : 1);
    if (this.vrm && document.body.classList.contains('stream')) { const g = this.streamGoal(tan, asp, mode); if (g) return g; }
    let top, bottom, wantW = 0.95, cx = 0;
    if (mode === 'talk' && this.vrm) {
      // HEAD-TO-WAIST (Saidie, Oct 20: the new 3D avatar, framing kept on her face and upper body): the frame bottom
      // sits at her waist, above the hem of her tee dress, never on her lap or legs; the top clears her pigtails with
      // a little headroom; a raised hand (wave) gently widens/raises the frame so her fingers stay in shot.
      const H = this.vrm.humanoid, P = (b) => H.getNormalizedBoneNode(b)?.getWorldPosition(new THREE.Vector3());
      const head = P('head'), hips = P('hips'), chest = P('chest') || head, lh = P('leftHand'), rh = P('rightHand');
      if (head && hips && lh && rh) {
        const pts = [lh, rh]; for (const s of ['left', 'right']) for (const f of ['IndexDistal', 'MiddleDistal', 'ThumbDistal']) { const v = P(s + f); if (v) pts.push(v); }
        const handHigh = Math.max(...pts.map((v) => v.y));
        // framing (motion-tuning.json camera.framing, ?frame=): 'collar' (default since Saidie's 2:05/2:07 PM notes:
        // the frame's bottom edge at her collarbones or higher) or 'waist' (head-to-waist)
        const fr = new URLSearchParams(location.search).get('frame') || this.camTune?.framing || 'collar';
        const sh = P('leftUpperArm'), sh2 = P('rightUpperArm'), collar = sh && sh2 ? (sh.y + sh2.y) / 2 - 0.035 : head.y - 0.13;   // her collarbones sit just under the shoulder joints (short neck, big head)
        const waist = fr === 'waist' ? hips.y + 0.05 : collar;   // the cut never drops below her waist (waist) / collarbones (collar)
        const raised = Math.max(0, handHigh - (chest.y - 0.05));
        top = Math.max(head.y + (fr === 'waist' ? 0.27 : 0.22), handHigh + 0.1);
        bottom = waist + (fr === 'waist' ? Math.min(0.08, raised * 0.15) : 0);
        const xs = pts.filter((v) => v.y > waist).map((v) => v.x);   // only hands inside the frame widen it
        const spread = xs.length ? Math.max(...xs) - Math.min(...xs) : 0.3;
        wantW = fr === 'waist' ? Math.max(0.62, Math.min(1.25, spread + 0.3)) : Math.max(0.4, Math.min(0.95, spread + 0.2));   // head + hair width; her shoulders may run past the stage edges (no box)
        if (fr !== 'waist') {
          // FACE LOCK (r11, reviewer: "she sinks during the wave and her face crowds the bottom UI"): in collar framing the
          // frame is built from her HEAD alone, with a span and width measured once at rest. A raised hand no longer
          // pulls the camera back (which shrank her and slid her face down onto the nametag row); the full-view canvas
          // has no box, so a hand above or beside the stage area is still drawn. The camera height follows her head.
          const restSpan = (this._collarSpan ||= Math.max(0.26, head.y + 0.22 - collar));
          top = head.y + 0.22; bottom = top - restSpan; wantW = (this._collarW ||= 0.5);
        }
        cx = head.x * 0.6 + chest.x * 0.4;
        if (fr !== 'waist' && this.wave && this._waveW) cx += (this._waveSide || 0) * (this._waveRef || WAVE_REFRAME) * this._waveW;   // r11: reframe sideways (only) toward a waving hand
        if ((this.seatW || 0) > 0.25) {   // seated in her chair: never her lap
          top = head.y + 0.27;
          bottom = fr === 'waist' ? Math.max(hips.y + 0.14, Math.min(chest.y - 0.12, head.y - 0.45)) : collar;
          wantW = fr === 'waist' ? 0.7 : 0.5; cx = head.x * 0.5;
        }
        this._frameRef = { x: cx, z: (head.z + chest.z) / 2 };
        this._cut = { y: fr === 'waist' ? bottom : collar, collar: fr === 'collar', neck: collar + 0.07 };
      }
    }
    if (top === undefined) { bottom = -0.16; top = this.height + 0.36; } // feet a little above the bottom, headroom for a raised arm
    // panels laid over the bottom of her stage (the chat card on phones) hide part of the canvas: frame her in
    // the part that is actually visible
    const cover = Math.min(0.45, Math.max(0, this.coverBottom || 0));
    const span = (top - bottom) / (1 - cover);
    const d = Math.max(span / 2 / tan, wantW / 2 / (tan * asp));
    const visH = 2 * d * tan; // world height the camera shows at her depth
    // talk: anchored on her waist (the bottom edge), any extra height becomes headroom, never more of her legs
    // full view + collar framing in a tall, narrow stage: a bust standing on the stage's bottom edge, head and hair
    // filling ~50 % of its height (the space above her is where her speech bubble lives), never zoomed onto her face
    if (mode === 'talk' && this.vrm && this.fullView && this._cut?.collar && !cover) {
      const d2 = (top - bottom) / 0.5 / 2 / tan, vis2 = 2 * d2 * tan;
      return { x: cx, y: bottom + vis2 / 2 - vis2 * 0.13, d: d2 };   // her cut line sits above the nametag row, never behind it
    }
    if (mode === 'talk' && this.vrm) return { x: cx, y: bottom - cover * visH + visH / 2 - visH * 0.015, d };
    return { x: cx, y: top - visH / 2 + (visH - span) / 2 * 0.5, d };
  }
  // STREAM LAYOUT framing (VTuber norms, jena-stream/vtuber-framing.md): head-to-waist, the waist sitting on the
  // bottom edge of the frame, her whole head (hair included) with headroom above it; never a full-body shot.
  // ?cam=<0.5-1.4> pulls the camera back (<1) or in (>1); default 0.9 keeps a little air around her head and arms.
  streamGoal(tan, asp, mode = 'talk') {
    const H = this.vrm.humanoid, P = (b) => H.getNormalizedBoneNode(b)?.getWorldPosition(new THREE.Vector3());
    const head = P('head'), hips = P('hips'), lh = P('leftHand'), rh = P('rightHand');
    if (!head || !hips || !lh || !rh) return null;
    if (this._streamCam === undefined) { const c = parseFloat(new URLSearchParams(location.search).get('cam')); this._streamCam = c >= 0.5 && c <= 1.4 ? c : 0.9; }
    // the stream camera director (src/stream.js) picks a shot: wide / mid / close / low / high, with its own ease
    const shot = window.jenaCam?.shot || {}, zoom = this._streamCam * (shot.zoom || 1);
    const handTop = Math.max(lh.y, rh.y);
    let top, bottom;
    if (mode === 'full') {   // dances: head to feet, the whole head always in, a little headroom (her examples)
      top = Math.max(head.y + 0.25, handTop + 0.1) + 0.05; bottom = -0.05;
    } else {
      top = Math.max(head.y + 0.25, handTop + 0.12) + 0.06;   // hair top + headroom (a raised hand too)
      bottom = hips.y + 0.03;                                 // her waist, above the hem of her tee dress, cut by the frame edge
      if ((this.seatW || 0) > 0.25) bottom = hips.y + 0.12;   // seated: cut above her lap (never framed on her legs)
      if ((new URLSearchParams(location.search).get('frame') || this.camTune?.framing || 'collar') === 'collar') {   // collarbones or higher (default)
        const a = P('leftUpperArm'), b = P('rightUpperArm'); if (a && b) bottom = (a.y + b.y) / 2 + 0.01;
      }
    }
    const wantW = bottom > hips.y + 0.2 ? Math.max(0.5, Math.min(0.95, Math.abs(lh.x - rh.x) * 0.6 + 0.26)) : Math.max(0.72, Math.abs(lh.x - rh.x) + 0.3);
    let d = Math.max((top - bottom) / 2 / tan, wantW / 2 / (tan * asp)) / zoom;
    const visH = 2 * d * tan;
    // bottom-anchored on the stream (her waist / feet sit on the frame edge); a close-up anchors on her head instead
    let y = bottom + visH / 2;
    const room = shot.tight ? 0 : 0.07;   // punch-ins keep a little headroom; only the scream zoom may go tight
    if (y + visH / 2 < top + room) y = top + room - visH / 2;   // zoomed in past her height: her whole head stays in, the cut moves down
    const tilt = (shot.tilt || 0) * visH;   // low angle: camera below, looking up (+); high angle: above, looking down (-)
    return { x: (lh.x + rh.x) / 4 + (shot.pan || 0) * visH, y: y - tilt, d, ly: y + tilt * 0.35, k: shot.k };
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
    if (this.cameraHeld) return;   // a page that drives the camera itself (the /world room: WASD, mouse look, a VR headset)
    if (this.cam && document.body.classList.contains('stream')) return;   // stream: panel resizes (dance <-> talk) ease through updateCamera, never snap
    const pin = new URLSearchParams(location.search).get('view');
    this.viewPin = pin === 'full' || pin === 'talk' ? pin : null;
    const g = this.frameGoal(this.viewPin || (this.vrm ? this.viewMode(performance.now()) : 'talk'));   // snaps to the CURRENT framing (a resize used to snap a whole-body view back to the close-up)
    this.cam = { ...g }; this.camSpring = null;
    this.camera.position.set(g.x, g.y, g.d);
    this.camera.lookAt(g.x, g.y, 0);
  }
  viewMode(now) {
    if (this.viewPin) return this.viewPin;
    const mv = window.jenaMoves?.playing;
    // stream layout: VTuber head-to-waist; on the phone layout a real dance goes full body (her example TikToks)
    if (document.body.classList.contains('stream')) return mv && mv.c?.kind === 'dance' && document.body.classList.contains('stream-phone') ? 'full' : 'talk';   // wide: always head-to-waist
    // head-to-waist is her default framing everywhere (Saidie, Oct 20); a real dance is the only full-body shot.
    // The glass shell's framing button (body.frame-full, default on laptops/desktops, Saidie Oct 21) shows her whole body
    // so her feet and stance are seen.
    if (mv && mv.c?.kind === 'dance') return 'full';
    if (document.body.classList.contains('frame-full')) return 'full';
    return 'talk';
  }
  updateCamera(dt, now) {
    if (!this.cam) return;
    if (!(now < this._coverAt)) { this._coverAt = now + 1000; this.measureCover(); if (this.fullView) this.layoutFullView(); }
    const mode = this.viewMode(now);
    this.viewNow = mode;
    const g = this.frameGoal(mode);
    const changed = mode !== this._lastMode; this._lastMode = mode;
    if (document.body.classList.contains('stream')) document.body.classList.toggle('stream-full', mode === 'full');
    // SMOOTH AUTO-FOLLOW: critically damped springs (no overshoot, never a cut) on the camera's x / height / distance
    // and its look-at height. A small dead zone ignores her idle sway (no jitter), a slight lead looks where she is
    // heading (velocity of the frame target), and a framing change (talk <-> dance) uses a slower spring.
    const S = (this.camSpring ||= { x: new Spring(this.cam.x, 2.6), y: new Spring(this.cam.y, 2.6), d: new Spring(this.cam.d, 2.0), ly: new Spring(this.cam.ly ?? this.cam.y, 2.6), gx: g.x, gy: g.y, vx: 0, vy: 0 });
    const CT = this.camTune || {};
    // r11: a side-step gets a tighter follow (she trails ~5-10 cm off centre, then the camera settles back on her)
    const w = changed || this._modeEase > now ? (CT.modeOmega ?? 1.4) : (g.k ? g.k * 1.4 : (this.travelState || this._trav) ? (CT.travelOmega ?? 5.2) : (CT.omega ?? 2.6));
    if (changed) this._modeEase = now + 2500;
    S.x.omega = S.y.omega = S.ly.omega = w; S.d.omega = w * 0.8;
    const dz = CT.deadZone ?? 0.012, step = (cur, tgt) => (Math.abs(tgt - cur) > dz ? tgt - Math.sign(tgt - cur) * dz : cur);
    const nx = step(S.gx, g.x), ny = step(S.gy, g.y);
    const k = dt > 0 ? Math.min(1, dt * 4) : 0;
    S.vx += ((dt > 0 ? (nx - S.gx) / dt : 0) - S.vx) * k; S.vy += ((dt > 0 ? (ny - S.gy) / dt : 0) - S.vy) * k;
    S.gx = nx; S.gy = ny;
    const lead = CT.leadSec ?? 0.18;   // seconds of look-ahead
    const tx = nx + THREE.MathUtils.clamp(S.vx * lead, -0.08, 0.08), ty = ny + THREE.MathUtils.clamp(S.vy * lead, -0.06, 0.06);
    this.cam.x = S.x.step(tx, dt); this.cam.y = S.y.step(ty, dt); this.cam.d = S.d.step(g.d, dt);
    this.cam.ly = S.ly.step((g.ly ?? ty), dt);
    // follow her body if she steps / turns away from the origin (feet IK, spins): the camera keeps facing her
    const ref = this._frameRef, bz = ref ? ref.z : 0;
    this.camera.position.set(this.cam.x, this.cam.y, bz + this.cam.d);
    this.camera.lookAt(this.cam.x, this.cam.ly, bz);
    // r11: the collar fade also runs in the boxed/mobile layout (before, only the full-view page got it; mobile showed a hard edge under the chat sheet)
    if (this.fullView || this._cut?.collar) this.layoutCut(mode);
  }
  // the soft cut under her collarbones (full view): the canvas fades out just above the cut line, so nothing below
  // her collarbones is ever drawn on the page, whatever the camera is doing (a dance goes full body: no cut then)
  layoutCut(mode) {
    let px = null, p0 = null;
    if (mode === 'talk' && this._cut?.collar) {
      this.camera.updateMatrixWorld(); const ch = this.canvas.clientHeight || 1, z = this._frameRef?.z || 0;
      const proj = (y) => Math.round((1 - new THREE.Vector3(this.cam.x, y, z).project(this.camera).y) / 2 * ch);
      px = proj(this._cut.y);                   // fully gone AT her collarbone line (framing rule: nothing below it is drawn)
      p0 = proj(this._cut.neck ?? this._cut.y + 0.07);   // starts mid-neck (below the chin), so the fade is ~3-4x longer than before
      if (px - p0 < 48) p0 = px - 48;
    }
    const key = px === null ? 'none' : Math.round(p0 / 2) * 2 + ':' + Math.round(px / 2) * 2;
    if (key === this._cutKey) return; this._cutKey = key;
    // r11 (reviewer: the 24 px collar fade looked "pasted on"): a long eased fade (S-curve, ~3-4x longer) that
    // dissolves her shoulders into the page instead of a visible horizontal edge; it still ends at her collarbones
    const stops = (a, b) => { const L = b - a, f = [[0, 1], [0.12, 0.97], [0.25, 0.9], [0.4, 0.74], [0.55, 0.52], [0.7, 0.3], [0.83, 0.13], [0.93, 0.04], [1, 0]]; return f.map(([u, o]) => `rgba(0,0,0,${o}) ${Math.round(a + u * L)}px`).join(', '); };
    const m = px === null ? 'linear-gradient(to bottom, #000 0, #000 calc(100% - 56px), transparent 100%)' : `linear-gradient(to bottom, #000 0, ${stops(Math.max(0, p0), px)}, transparent 100%)`;
    this.canvas.style.webkitMaskImage = m; this.canvas.style.maskImage = m;
  }
  // FULL VIEW (no box around her): her canvas is a frameless layer over the page background, as wide as the window
  // and down to the bottom of her stage area (soft fade there, at her waist). The camera still composes her for her
  // stage area (#avatar-panel), but the projection is widened to the whole layer, so her hair, hands and gestures
  // can go past the old panel edges instead of being clipped by a box.
  layoutFullView() {
    const el = this.canvas.parentElement; if (!el) return;
    const r = el.getBoundingClientRect(), vw = window.innerWidth || 1;
    const H = Math.max(1, Math.round(Math.min(window.innerHeight, r.bottom)));
    const key = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), vw, H].join(',');
    if (key === this._fvKey) return; this._fvKey = key;
    const c = this.canvas.style;
    c.position = 'fixed'; c.left = '0px'; c.top = '0px'; c.width = vw + 'px'; c.height = H + 'px'; c.inset = 'auto';
    this.renderer.setSize(vw, H, false);
    const pw = Math.max(1, r.width), ph = Math.max(1, r.height);
    this.camera.aspect = pw / ph;
    this.camera.setViewOffset(pw, ph, -r.left, -r.top, vw, H);
    this.camera.updateProjectionMatrix();
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
  // r12 OPEN-EYE BASELINE: her model's rest lids sit low (the heavy black upper lash line covers the top of the iris,
  // which reads half-lidded at phone size). 'jena_eyes_open' drives the model's own 'Round' eye shape alone (the
  // round-eye part of 'surprised', without its brow lift, its 'oh' mouth or its blink block), held at a low weight under
  // everything else, faded out with each blink so the closed lid stays clean.
  installEyesOpen(vrm) {
    const em = vrm.expressionManager; if (!em || em.getExpression('jena_eyes_open')) return;
    const ex = new VRMExpression('jena_eyes_open'); let n = 0;
    vrm.scene.traverse((o) => { const d = o.isMesh && o.morphTargetDictionary; if (d && d.Round != null) { ex.addBind(new VRMExpressionMorphTargetBind({ primitives: [o], index: d.Round, weight: 1 })); n++; } });
    if (!n) return;
    vrm.scene.add(ex); em.registerExpression(ex); this.eyesOpenOk = true;
  }
  gazePoint(what) {
    const c = this.camera.position, H = this.vrm.humanoid;
    if (what === 'desktop') return _v[4].set(c.x + 1.6, c.y + 0.55, c.z * 0.6);
    if (what === 'chat') return _v[4].set(c.x + 1.2, c.y - 0.35, c.z * 0.6);
    if (what === 'aside') return _v[4].set(c.x + (this._asideSide || 1) * 1.1, c.y + 0.08, c.z * 0.6);   // r12: a talk glance at eye level
    if (what === 'floor') return _v[4].set(c.x * 0.2, 0.55, 0.9);   // r12: a glance down at the room in front of her, not at her feet (eyes rolled to the lower lid read as sleepy)
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

  // r12 (reviewer: the idle "arms up, reset" stretch sent both arms straight overhead and out of frame): a raised arm
  // is now CAPPED at shoulder height with a bent elbow. It rides the same solved two-bone layer as the wave (applyWave,
  // no waving): the wrist goes out and forward to about shoulder level, the elbow stays bent (~100 deg interior) and
  // below the shoulder, eased in and out. The hands never go above her head.
  raiseArm(side = 'left', holdMs = 2600) {
    const sides = side === 'both' ? ['left', 'right'] : [side];
    for (const s of sides) {
      if (!RAISED[s]) throw new Error(`raiseArm: side must be 'left', 'right' or 'both' (got ${side})`);
      if (this.handOnHip?.side === s) this.handOnHip = null; // a new arm move replaces hand-on-hip
      for (const b of ['UpperArm', 'LowerArm', 'Hand']) this.target[s + b] = [...REST[s + b]];   // relaxed underneath
      clearTimeout(this.armTimers[s]);
      this.curlHand(s, 0.12, Math.max(1400, holdMs || 2600));
    }
    const now = performance.now(), ms = Math.max(1400, holdMs || 2600);
    this.wave = { side: sides[0], sides, start: now, until: now + ms, raise: 0.7, lower: 0.8, hz: 0, phase: 0, still: true, ux: 0.62, uy: -0.02, elbow: 104, kind: 'raise' };
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

  // WAVE (r11, reviewer FAIL on v37r10: the old wave snapped the arm out near-horizontal with the hand off-frame, then
  // held it stiffly overhead = the T-arm Saidie rejected). Now the wave is a layer solved every frame (applyWave): the
  // upper arm goes out, forward and DOWN (elbow below the shoulder, never a T), the elbow bends ~84 deg (interior ~96), the
  // hand sits around head height in front of her shoulder, just outside her cheek, palm to camera. The arm eases in (0.6 s) and out (0.7 s) with
  // smootherstep from wherever it was; the waving itself rotates the forearm around the upper-arm axis (the shoulder's
  // own rotation, like a real wave), so the elbow angle never changes and the joint limits have nothing to catch.
  waveHand(side = 'right', ms = 2400) {
    const sides = side === 'both' ? ['left', 'right'] : [side];
    ms = Math.max(1600, ms || 2400);
    for (const s of sides) {
      if (s !== 'left' && s !== 'right') throw new Error(`waveHand: side must be 'left', 'right' or 'both' (got ${side})`);
      if (this.handOnHip?.side === s) this.handOnHip = null;
      for (const b of ['UpperArm', 'LowerArm', 'Hand']) this.target[s + b] = [...REST[s + b]];   // the base pose stays relaxed underneath
      clearTimeout(this.armTimers[s]);
      this.curlHand(s, 0.08, ms);   // open, relaxed hand while waving (never a fist or a claw)
    }
    const now = performance.now();
    this.wave = { side: sides[0], sides, start: now, until: now + ms, raise: 0.6, lower: 0.7, hz: 1.6 + Math.random() * 0.3, phase: Math.random() * 0.6 };
    this.gazeGoal = { what: 'camera', until: now + ms };   // a greeting looks at you, not at her own hand
  }
  // the wave layer (see waveHand): runs after every other arm/finger layer and before collisions + polish
  applyWave(vrm, now) {
    const W = this.wave; if (!W) return;
    const t = (now - W.start) / 1000, T = (W.until - W.start) / 1000;
    if (t >= T || t < 0) { this.wave = null; this._waveW = 0; return; }
    const ss = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * x * (x * (x * 6 - 15) + 10); };   // smootherstep: zero speed + accel at both ends
    const w = Math.min(ss(t / W.raise), ss((T - t) / W.lower));
    const osc = W.still ? 0 : Math.min(ss((t - W.raise * 0.55) / 0.4), ss((T - W.lower * 0.85 - t) / 0.35));   // waving starts as the arm arrives, settles before it lowers
    const H = vrm.humanoid, ph = t * 2 * Math.PI * W.hz + W.phase;
    // the follow camera gives the waving hand room (frameGoal): a gentle sideways reframe toward that hand
    this._waveW = w; this._waveSide = W.sides.length > 1 ? 0 : (W.sides[0] === 'left' ? 1 : -1);
    for (const s of W.sides) {
      const sx = s === 'left' ? 1 : -1;
      const U = H.getNormalizedBoneNode(s + 'UpperArm'), L = H.getNormalizedBoneNode(s + 'LowerArm'), Hd = H.getNormalizedBoneNode(s + 'Hand');
      if (!U || !L || !Hd) continue;
      // body space (her shoulder's frame): +x her left, +y up, +z toward the camera. Two-bone IK with an out-and-down
      // elbow pole: the wrist goes ~10 cm above and ~25 cm in front of her shoulder, just outside her cheek (it stays
      // inside the frame next to her face, never off to the side), elbow below the shoulder, interior angle ~96 deg
      // (bend 84 deg: under 90 so the elbow stays inside the joint-limit range and Euler-stable)
      const A = (this._armLen ||= {});
      if (!A[s]) { const p = (n) => H.getNormalizedBoneNode(n).getWorldPosition(new THREE.Vector3()); A[s] = [p(s + 'UpperArm').distanceTo(p(s + 'LowerArm')), p(s + 'LowerArm').distanceTo(p(s + 'Hand'))]; }
      const [L1, L2] = A[s], cosI = Math.cos((W.elbow || 96) * Math.PI / 180), R = Math.sqrt(L1 * L1 + L2 * L2 - 2 * L1 * L2 * cosI);
      // screen-aware: on her first wave frame the hand's lateral offset is reduced until the whole hand (plus the
      // outward swing) projects inside the visible page, so the wave never leaves the frame (she stands near the left
      // edge on the desktop page and her bust is big there)
      const ux = W.ux ?? 0.3, uy = W.uy ?? 0.32;   // r12: a capped raise (raiseArm) reuses this layer with a lower wrist goal and no waving
      if ((W.k ||= {})[s] === undefined) { W.k[s] = this.waveLateral(H, s, sx, R, ux, uy); (W.nar ||= {})[s] = this._waveNar0 ?? 1; }
      const k = W.k[s];
      const u = _v[5].set(ux * sx * k, uy, 0.88).normalize();   // wrist ~10 cm above the shoulder: palm at cheek/eye height, fingertips around the top of her head
      const pole = _v[6].set(0.5 * sx, -0.85, 0.1); pole.addScaledVector(u, -pole.dot(u)).normalize();
      const al = Math.acos(THREE.MathUtils.clamp((L1 * L1 + R * R - L2 * L2) / (2 * L1 * R), -1, 1));
      const elb = _v[7].copy(u).multiplyScalar(Math.cos(al) * L1).addScaledVector(pole, Math.sin(al) * L1);
      const d1 = _v[0].copy(elb).normalize();
      const d2 = _v[1].copy(u).multiplyScalar(R).sub(elb).normalize().applyAxisAngle(d1, (Math.sin(ph) * 0.2 - 0.12) * (W.nar?.[s] ?? 1) * osc * sx);   // the wave: forearm swings around the upper-arm axis (a touch more outward than across her face)
      const X = _v[2].copy(d1).multiplyScalar(sx);                                   // bone axis: +x (left) / -x (right) in VRM normalized space
      const Z = _v[3].copy(d2).addScaledVector(d1, -d2.dot(d1)).normalize();         // the forearm bends toward local +z: elbow hinge = local y
      const Y = _v[4].crossVectors(Z, X);
      const qU = _q[0].setFromRotationMatrix(_m4.makeBasis(X, Y, Z));
      const bend = Math.min(1.5, Math.acos(THREE.MathUtils.clamp(d1.dot(d2), -1, 1)));   // ~84 deg, constant through the wave
      const qL = _q[1].setFromEuler(_eW.set(0, -sx * bend, 0));
      // wrist: a soft follow-through a beat behind the forearm (radial/ulnar about the palm normal) + slight extension, < 12 deg
      const qH = _q[2].setFromEuler(_eW.set(0, Math.sin(ph - 0.9) * 0.16 * osc, sx * 0.1 * w));
      U.quaternion.slerp(qU, w); L.quaternion.slerp(qL, w); Hd.quaternion.slerp(qH, w);
      // r12c CLOSED-LOOP PANEL GUARD: the real fingertips of the pose just set (this frame's wave, this frame's camera; the correction lands next frame) are checked against the
      // page edge and any panel beside her at that height (chat, desktop, thoughts); if they come within ~28 px the hand
      // eases in toward her cheek (k down, ~1.2/s) and the sideways reframe grows (<= 1.6x), so the hand is never drawn
      // under a panel even where the first-frame estimate was off
      try {
        const c = this.canvas.getBoundingClientRect(), W0 = Math.max(window.innerWidth || 0, 1), sh = H.getNormalizedBoneNode(s + 'UpperArm').getWorldPosition(this._wgA ||= new THREE.Vector3()).project(this.camera), shx = c.left + (sh.x + 1) / 2 * c.width;
        let worst = 1e9;
        for (const f of ['IndexDistal', 'MiddleDistal', 'LittleDistal', 'Hand']) {
          const n = H.getNormalizedBoneNode(s + f); if (!n) continue;
          const pp = n.getWorldPosition(this._wgB ||= new THREE.Vector3()).project(this.camera), x = c.left + (pp.x + 1) / 2 * c.width, y = c.top + (1 - pp.y) / 2 * c.height;
          if (y < 0 || y > (window.innerHeight || 1e9)) continue;   // a hand still below the page (rising/lowering) is not near any edge yet
          let lo = 0, hi = W0;
          for (const r of (this._wavePanels || [])) { if (y < r.top - 30 || y > r.bottom + 30) continue; if (r.left >= shx) hi = Math.min(hi, r.left); else if (r.right <= shx) lo = Math.max(lo, r.right); }
          worst = Math.min(worst, sx > 0 ? hi - x : x - lo);
        }
        const dts = Math.min(0.05, Math.max(0, (now - (W.lastNow ?? now)) / 1000)); W.lastNow = now;
        if (w > 0.85 && worst < 28) {   // r12c: only once the hand is up (the rising arm passes low, under the collar fade)

          // narrower swing first (the outward extreme is what nears the panel), then the hand comes in a little, then the
          // reframe grows; the hand never comes in past k 0.3 (take 3 at k 0.1: the inward swing read as touching her face)
          const N = (W.nar ||= {}); N[s] = Math.max(0.5, (N[s] ?? 1) - 1.4 * dts);
          if (N[s] <= 0.75) W.k[s] = Math.max(Math.min(W.k[s], 0.3), W.k[s] - 0.6 * dts);
          if (N[s] <= 0.5 || W.k[s] <= 0.3) this._waveRef = Math.min(WAVE_REFRAME * 1.6, (this._waveRef || WAVE_REFRAME) + 0.08 * dts);
          W.guard = (W.guard || 0) + 1;
        }
      } catch {}
    }
  }
  // how far out to the side the waving hand may go (1 = full, 0 = straight above-front of her shoulder) so the hand,
  // its fingers and its outward swing stay inside the visible page (and clear of the page edge by ~40 px)
  waveLateral(H, s, sx, R, ux = 0.3, uy = 0.32) {
    try {
      const up = H.getNormalizedBoneNode(s + 'UpperArm'), par = up.parent; par.updateMatrixWorld(true);
      const S = up.getWorldPosition(new THREE.Vector3()), q = par.getWorldQuaternion(new THREE.Quaternion());
      const c = this.canvas.getBoundingClientRect(), W0 = Math.max(window.innerWidth || 0, 1);
      const cx0 = this.camera.position.x;
      const done = (k) => { this.camera.position.x = cx0; this.camera.updateMatrixWorld(); return k; };
      // r12: the hand must fit with the camera where it is NOW (the sideways reframe arrives ~0.8 s late, and her weight
      // shift can carry her toward the edge meanwhile) AND where it will be mid-wave, with a wider edge margin
      const sx2 = (cam, k, m) => { this.camera.position.x = cam; this.camera.updateMatrixWorld();
        const loc = new THREE.Vector3(ux * sx * k, uy, 0.88).normalize().multiplyScalar(R);
        // r12c: measured on the 1280 page, this wrist-goal estimate already lands ~100 px OUTSIDE the real fingertips
        // (shoulder-frame offset), so the old extra 0.1 m 'fingers + swing' made every wave fail the fit; the closed-loop
        // guard in updateWave catches what the estimate misses
        const p = loc.applyQuaternion(q).add(S).project(this.camera), x = c.left + (p.x + 1) / 2 * c.width, y = c.top + (1 - p.y) / 2 * c.height;
        const sh = S.clone().project(this.camera), shx = c.left + (sh.x + 1) / 2 * c.width;
        let lo = 0, hi = W0;
        // r12c: the page panels (chat, desktop, thoughts, composer) sit OVER the full-width canvas; a hand that crosses
        // one is drawn behind it (r12 take, left wave ~25-27 s). Any visible panel beside her at the hand's height is an
        // edge too, the same as the page edge.
        for (const r of panels) {
          if (y < r.top - 40 || y > r.bottom + 40) continue;
          if (r.left >= shx) hi = Math.min(hi, r.left); else if (r.right <= shx) lo = Math.max(lo, r.right);
        }
        return x > lo + m && x < hi - m; };
      const panels = [];
      for (const el of document.querySelectorAll('#chat, #desktop, #thoughts, #composer, .composer, #mobile-bar')) {
        const r = el.getBoundingClientRect(), st = getComputedStyle(el);
        if (r.width > 4 && r.height > 4 && st.display !== 'none' && st.visibility !== 'hidden' && +st.opacity !== 0) panels.push(r);
      }
      // r12c: when even the hand straight above-front of her shoulder would cross a panel, the sideways reframe grows
      // (up to ~2.4x) so the hand is drawn clear of it instead of under it
      // r12c: a panel beside her (desktop 1280: the chat starts ~220 px from her face) leaves no room for a hand out to
      // the side. First the hand comes in toward her shoulder line (k 1 -> 0) with the reframe growing a little (<= 1.5x,
      // so her face stays near the middle of her stage); if that still crosses the panel, the swing narrows and the
      // reframe widens (the hand is never brought in across her face) instead of the hand being drawn under the panel.
      this._wavePanels = panels;
      const RF = [1, 1.25, 1.5];
      this._waveNar0 = 1;
      for (const rf of RF) {
        this._waveRef = WAVE_REFRAME * rf;
        for (const k of [1, 0.8, 0.6, 0.45, 0.3]) if (sx2(cx0, k, 55) && sx2(cx0 + sx * this._waveRef, k, 55)) return done(k);
      }
      // no room even at k 0.3: the hand stays outside her cheek (never across her face) with a narrower swing and
      // the widest reframe; the closed-loop guard trims the rest
      this._waveRef = WAVE_REFRAME * 1.5; this._waveNar0 = 0.65;
      return done(0.3);
    } catch {}
    return 0;
  }
  // LATERAL MOVE (r11): she side-steps dx metres (her +x = her left = screen right). The hips glide on a smootherstep,
  // her feet step to follow (updateFeet's balance steps, faster cadence while travelling), the torso leans a touch into
  // the move and the head stays level. The follow camera trails her and re-centres.
  travel(dx = 0.4, ms = 2300) {
    const from = this.travelX || 0;
    this.travelState = { from, to: from + dx, t0: performance.now(), dur: Math.max(600, ms) };
    this.gazeGoal = { what: 'camera', until: performance.now() + Math.max(600, ms) };   // r12: eyes on you while she steps
    try { (window.jenaLog ||= []).push({ t: Math.round(performance.now()), kind: 'travel', what: dx.toFixed(2) + ' m', why: 'move' }); } catch {}
    return this.travelState;
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
    // never mid-dance or in her chair: those own her arms, and the hand must not end up on the front of her hips
    if (this.dancing || this.seatW > 0.05) return false;
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
    if (this.dancing || this.seatW > 0.05) h.release = true;
    // her hip: on the SIDE of her hip, out past her hip line and a little behind it (Saidie, Oct 14: never on the
    // front of her hips; Jena is a minor character)
    const surf = this.collision?.hipSurface(h.side, 0.05);
    if (surf) { _hip.copy(surf).applyMatrix4(_m4.copy(hips.matrixWorld).invert()); _hip.z -= 0.035 * (window.jenaMoves?._front ?? 1); _hip.applyMatrix4(hips.matrixWorld); }
    else _hip.set(sg * 0.17, 0.06, -0.04).applyMatrix4(hips.matrixWorld);
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
    // check: if the solve still left her hand on the front of her hips, swing the arm out and let the pose go
    const z = window.jenaMoves?.handZone?.(H);
    if (z?.[h.side]?.frontCenter || z?.[h.side]?.seat) {
      for (let s = 0; s < 8 && (q => q?.frontCenter || q?.seat)(window.jenaMoves.handZone(H)?.[h.side]); s++) { U.rotateZ(sg * 0.08); U.updateMatrixWorld(true); }
      h.release = true;
    }
  }
  nod(ms = 1200) { this.act.nod = { until: performance.now() + ms, start: performance.now() }; }
  shakeHead(ms = 1200) { this.act.shake = { until: performance.now() + ms, start: performance.now() }; }
  tapFoot(side = 'right', ms = 3000) { this.act.tap = { side, until: performance.now() + ms, start: performance.now() }; }

  // Ground truth from her own skeleton: which arms are raised right now (target pose, her sides).
  armState() {
    const W = this.wave, up = (s) => !!(W && W.sides?.includes(s));   // r12: raised/waving arms ride the solved layer
    return { left: this.target.leftUpperArm?.[2] > 0.5 || up('left'), right: this.target.rightUpperArm?.[2] < -0.5 || up('right') };
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
  // ---- the loop: a FIXED-TIMESTEP simulation (60 Hz: pose, IK, face, springs) decoupled from rendering, with the
  // rendered pose interpolated between the last two simulation states. Motion stays smooth and identical whatever the
  // render fps does (a dip to 30 fps runs 2 steps per frame; a 120 Hz screen draws in-between poses). ?fixed=0 = old loop.
  frame() {
    this.clock.update();
    const raw = this.clock.getDelta(), dt = Math.min(raw, 0.1);
    this.adaptPixels(raw);
    const t = this.clock.getElapsed() + (this.timeOffset || 0);
    const now = performance.now();
    const vrm = this.vrm;
    for (const f of this.preHooks || []) { try { f(dt, raw); } catch (e) { console.warn('pre hook', e); } }   // (dt, raw) before her pose + render, body or not (the /world room moves the camera here)
    if (vrm) {
      if (this.fixedStep === undefined) this.fixedStep = new URLSearchParams(location.search).get('fixed') === '1' ? 1 / 60 : 0;   // opt-in: the fixed-step + interpolation path measured 80x shakier at 120 Hz (hips jitter 0.48 vs 0.006 deg/frame)
      const STEP = this.fixedStep;
      if (!STEP) this.simulate(vrm, dt, t, now);
      else {
        this.simAcc = (this.simAcc || 0) + dt;
        let n = 0;
        while (this.simAcc >= STEP && n < 5) {
          this.simAcc -= STEP; n++;
          this.snapBones(vrm, 'prev');
          this.simulate(vrm, STEP, t - this.simAcc, now - this.simAcc * 1000);
          this.snapBones(vrm, 'cur');
        }
        if (n >= 5) this.simAcc = 0;                       // a long stall: drop the backlog instead of spiralling
        this.simSteps = (this.simSteps || 0) + n;
        this.lerpBones(this.simAcc / STEP);                // draw between the last two sim states
      }
    }
    this.frameHooksLight?.(t);
    if (vrm && !this.cameraHeld) this.updateCamera(Math.min(raw, 0.5), now); // real time, so slow devices still settle
    this.renderer.render(this.scene, this.camera);
    if (vrm) for (const f of this.frameHooks) { try { f(vrm, dt); } catch (e) { console.warn('frame hook', e); } }
    this.unlerpBones();   // the next simulation step continues from its own state, not the drawn in-between
  }
  // one simulation step of her body (everything that used to run per rendered frame)
  simulate(vrm, dt, t, now) {
    {
      const H = vrm.humanoid;
      // arms toward targets
      for (const [bone, tgt] of Object.entries(this.target)) {
        const cur = (this.pose[bone] ||= [...(REST[bone] || [0, 0, 0])]);
        for (let i = 0; i < 3; i++) cur[i] = damp(cur[i], tgt[i], 7, dt);
        const n = H.getNormalizedBoneNode(bone);
        if (n) n.rotation.set(cur[0], cur[1], cur[2]);
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
      // lateral move (travel): eased glide of her hips, a small dip per step, lean into the move
      let tv = 0, bob = 0;
      if (this.travelState) {
        const S3 = this.travelState, u = Math.min(1, Math.max(0, (now - S3.t0) / S3.dur));
        this.travelX = S3.from + (S3.to - S3.from) * (u * u * u * (u * (u * 6 - 15) + 10));
        tv = (S3.to - S3.from) * 30 * u * u * (1 - u) * (1 - u) / (S3.dur / 1000);   // m/s
        bob = 0.005 * Math.abs(Math.sin(u * Math.PI * Math.max(2, Math.round(Math.abs(S3.to - S3.from) / 0.12)))) * Math.sin(Math.PI * u);
        if (u >= 1) this.travelState = null;
      }
      this.travelV = tv;
      if (hips && this.hipsRest) {
        hips.position.set(this.hipsRest.x + (this.travelX || 0) + L * 0.075 + sway * 0.03, this.hipsRest.y - 0.022 - Math.abs(L) * 0.022 + breathe * 0.003 - bob + (this.heelLift || 0), this.hipsRest.z + N.py(t * 0.11) * 0.012);
      }
      // contrapposto: the standing leg's hip rises (+z lifts her left side), the spine and shoulders answer it
      // a full free turn (spin): eased 360 degrees on the hips; her feet step around to follow (updateFeet)
      let spinY = 0;
      if (this.spinState) { const S2 = this.spinState, u = (now - S2.t0) / S2.dur; if (u >= 1) this.spinState = null; else { const e = u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u); spinY = e * Math.PI * 2 * S2.dir * S2.turns; } }
      set('hips', 0, N.px(t * 0.1) * 0.07 + L * 0.06 + spinY, L * 0.11 + sway * 0.03);
      this._spinY = spinY;
      // the torso curves like a real spine: one total bend/twist/roll, spread over every spine bone her rig has
      // (spine -> chest -> upperChest) with falloff, instead of all on one joint; the roll counters the hips' sway
      // so her head stays steady over her feet
      const hasUC = !!H.getNormalizedBoneNode('upperChest');
      const wS = hasUC ? 0.42 : 0.55, wC = hasUC ? 0.33 : 0.45, wU = hasUC ? 0.25 : 0;
      const bx = N.sx(t * 0.13) * 0.07, by = N.sy(t * 0.12) * 0.09 + N.cy(t * 0.14) * 0.05, bz = -L * 0.17 - sway * 0.035 + N.sz(t * 0.15) * 0.035;
      set('spine', 0.03 + breathe * 0.025 + bx * wS, by * wS, bz * wS);
      set('chest', breathe * 0.04 + bx * wC, by * wC, bz * wC);
      if (hasUC) set('upperChest', breathe * 0.025 + bx * wU, by * wU, bz * wU);
      set('neck', N.nx(t * 0.2) * 0.05, N.ny(t * 0.17) * 0.08, L * 0.04);
      if (this.look.until && now > this.look.until) { this.look.ty = 0; this.look.tx = 0; this.look.until = 0; }
      this.look.y = damp(this.look.y, this.look.ty, 4, dt);
      this.look.x = damp(this.look.x, this.look.tx, 4, dt);
      // +z on the head rolls it toward HER right, so her chosen tilt (+ = her left) goes in negated
      // r12: during a wave or a side-step her head stays engaged with the camera: no chosen look-away or tilt, the idle
      // head drift at 35 % (it still lives, it just doesn't wander down/away mid-greeting)
      const eng = (this._engW = damp(this._engW || 0, (this.wave || this.travelState) ? 1 : 0, 6, dt)), dn = 1 - 0.65 * eng;
      if (eng > 0.5) { this.look.ty = 0; this.look.tx = 0; }
      set('head', N.hx(t * 0.27) * 0.06 * dn + this.look.x + nodX, N.hy(t * 0.21) * 0.14 * dn + this.look.y + shakeY, N.hz(t * 0.24) * 0.05 * dn - A.tilt.v * (1 - eng) - L * 0.06);
      if (tv) { const ln = THREE.MathUtils.clamp(tv * 0.12, -0.06, 0.06); add('spine', 0, 0, -ln); add('head', 0, 0, ln * 0.8); }   // lean into the side-step, head stays level
      // STRESS BEATS (r11): an energy onset in her voice (a stressed syllable, voice.js voiceBeat) gives a small nod,
      // every other one a little tilt instead, and a brow lift (updateFace); at most one per ~0.38 s
      const vb = this.voiceBeat, talkingNow = now < (this.talk?.until || 0) || !!this.voice;
      if (vb && talkingNow && vb.at > (this._stressSeen || 0) && now - (this._stress?.t0 || -1e9) > 380) {
        this._stressSeen = vb.at; this._stressN = (this._stressN || 0) + 1;
        this._stress = { t0: now, level: Math.min(1, vb.level || 0.5), kind: this._stressN % 3 === 2 ? 'tilt' : 'nod', side: Math.random() < 0.5 ? 1 : -1 };
      }
      if (this._stress) {
        const St = this._stress, u = (now - St.t0) / 340;
        if (u >= 1) this._stress = null;
        else { const p = Math.sin(Math.PI * Math.min(1, u * 1.25)) * (u < 0.8 ? 1 : (1 - u) / 0.2), a = (0.45 + 0.55 * St.level) * p; if (St.kind === 'nod') add('head', 0.075 * a, 0, 0); else add('head', 0.02 * a, 0, 0.06 * a * St.side); this.stressNow = a; }
      } else this.stressNow = 0;
      // shoulders lift a touch on each breath in
      // shoulders (clavicles) move on their own: breath lifts them, each drifts up/down and forward/back on its own
      // noise (asymmetric), plus shrugs (both or one), drops and rolls she chooses or her words/reactions trigger
      {
        const SH = (this.sh ||= { L: { u: 0, f: 0 }, R: { u: 0, f: 0 }, ev: null, nL: noise(), nR: noise(), nF: noise() });
        let eu = { L: 0, R: 0 }, ef = { L: 0, R: 0 };
        if (SH.ev) {
          const E = SH.ev, u = (now - E.t0) / E.ms;
          if (u >= 1) SH.ev = null;
          else {
            const env = u < 0.25 ? Math.sin(u / 0.25 * Math.PI / 2) : u > 0.7 ? Math.cos((u - 0.7) / 0.3 * Math.PI / 2) : 1;   // quick up, hold, ease down
            const roll = E.kind === 'roll' ? Math.sin(u * Math.PI * 2) : 0;
            for (const k of ['L', 'R']) if (E.side === 'both' || E.side === k) { eu[k] = (E.kind === 'drop' ? -0.1 : E.kind === 'roll' ? 0.12 * Math.max(0, Math.cos(u * Math.PI * 2 - Math.PI / 2)) : E.amt) * env * (k === 'L' ? E.aL : E.aR); ef[k] = roll * 0.16 * env; }
          }
        }
        for (const k of ['L', 'R']) {
          const nz = (k === 'L' ? SH.nL : SH.nR)(t * 0.09 + (k === 'L' ? 0 : 50));
          const gu = THREE.MathUtils.clamp(inhale * 0.05 + nz * 0.03 + eu[k], -0.12, 0.35), gf = THREE.MathUtils.clamp(SH.nF(t * 0.07 + (k === 'L' ? 0 : 30)) * 0.05 + ef[k], -0.2, 0.2);
          SH[k].u = damp(SH[k].u, gu, 10, dt); SH[k].f = damp(SH[k].f, gf, 8, dt);
        }
        set('leftShoulder', 0, SH.L.f, -0.05 + SH.L.u); set('rightShoulder', 0, -SH.R.f, 0.05 - SH.R.u);
        // a new line she says: "idk"/a question gets a shrug now and then
        if (this.talk?.t0 && this.talk.t0 !== SH.lastT0) {
          SH.lastT0 = this.talk.t0; const tx = String(this.talk.text || '');
          if (/\b(idk|i don'?t know|dunno|whatever|maybe|i guess)\b/i.test(tx) || (/\?\s*$/.test(tx) && Math.random() < 0.45)) this.shrug(Math.random() < 0.7 ? 'both' : Math.random() < 0.5 ? 'L' : 'R');
        }
      }
      // relaxed arms drift a little (only while they're down; a raised arm stays where she put it)
      const restL = this.target.leftUpperArm[2] < 0 ? 1 : 0, restR = this.target.rightUpperArm[2] > 0 ? 1 : 0;
      add('leftUpperArm', N.al(t * 0.19) * 0.09 * restL, 0, (N.al(t * 0.13 + 40) * 0.06 + inhale * 0.02) * restL);
      add('rightUpperArm', N.ar(t * 0.19) * 0.09 * restR, 0, -(N.ar(t * 0.13 + 40) * 0.06 + inhale * 0.02) * restR);
      add('leftLowerArm', 0, -(0.5 + 0.5 * N.el(t * 0.15)) * 0.2 * restL, 0);
      add('rightLowerArm', 0, (0.5 + 0.5 * N.er(t * 0.15)) * 0.2 * restR, 0);
      // overlapping action: spine, neck, head and arms lag behind how fast her hips turn and sway (a critically
      // damped spring each), so motion flows through her body instead of moving as one stiff block
      {
        const hy = hips ? hips.rotation.y : 0, hz = hips ? hips.rotation.z : 0;
        const vy = dt > 0 ? (hy - (this._lhy ?? hy)) / dt : 0, vz = dt > 0 ? (hz - (this._lhz ?? hz)) / dt : 0;
        this._lhy = hy; this._lhz = hz;
        const sp = (this._lag ||= { y: 0, vy: 0, z: 0, vz: 0 }), k = 38, c = 2 * Math.sqrt(k);
        const ty = THREE.MathUtils.clamp(-vy * 0.12, -0.6, 0.6), tz = THREE.MathUtils.clamp(-vz * 0.1, -0.25, 0.25);
        sp.vy += (k * (ty - sp.y) - c * sp.vy) * dt; sp.y += sp.vy * dt;
        sp.vz += (k * (tz - sp.z) - c * sp.vz) * dt; sp.z += sp.vz * dt;
        add('spine', 0, sp.y * 0.35, sp.z * 0.4); add('chest', 0, sp.y * 0.25, sp.z * 0.3); add('neck', 0, sp.y * 0.2, 0); add('head', 0, sp.y * 0.3, sp.z * 0.3);
        const fling = Math.min(0.5, Math.abs(sp.y) * 0.8);
        add('leftUpperArm', 0, 0, fling * restL); add('rightUpperArm', 0, 0, -fling * restR);
      }
      // NECK: free glances (yaw up to ~70 deg, pitch, roll), split 40/60 over neck and head, eased in, held, eased back,
      // at irregular times; smaller while she talks (she mostly looks at chat then)
      {
        const G = (this.glance ||= { y: 0, p: 0, r: 0, ty: 0, tp: 0, tr: 0, next: now + 4000 + Math.random() * 8000, back: 0 });
        if (this.wave || this.travelState) { G.ty = G.tp = G.tr = 0; if (now > G.next - 1500) G.next = now + 1500 + Math.random() * 2000; }   // r11: a wave greets you and a side-step looks where she goes: no idle glance away mid-move
        if (now > G.next) {
          const big = Math.random() < 0.3, sc = talking0(this, now) ? 0.3 : 1;
          // r12c: idle glances are small head turns (<= ~12 deg); a bigger look is the eyes' job (the old 'big' glance
          // reached ~70 deg and showed the back of her head on camera)
          G.ty = (Math.random() - 0.5) * 2 * (big ? 0.21 : 0.12) * sc; G.tp = (Math.random() - 0.4) * (big ? 0.5 : 0.25) * sc; G.tr = (Math.random() - 0.5) * 0.35 * sc;
          G.back = now + 700 + Math.random() * 2200; G.next = now + Math.min(30000, Math.max(3500, 9000 * Math.exp((Math.random() + Math.random() - 1) * 1.2)));
          try { const Lg = (window.jenaLog ||= []); Lg.push({ t: Math.round(now), kind: 'glance', what: 'yaw ' + (G.ty * 57.3).toFixed(0) + ' pitch ' + (G.tp * 57.3).toFixed(0), why: 'idle' }); } catch {}
        }
        if (G.back && now > G.back) { G.ty = G.tp = G.tr = 0; G.back = 0; }
        // r12: once she starts talking, an idle glance already in progress comes back toward you (it could hold a ~70 deg
        // look-away into the first second of speech); talk glances stay small and never tip her head down
        if (talking0(this, now)) { G.ty = THREE.MathUtils.clamp(G.ty, -0.28, 0.28); G.tp = THREE.MathUtils.clamp(G.tp, -0.05, 0.05); G.tr = THREE.MathUtils.clamp(G.tr, -0.08, 0.08); }
        G.y = damp(G.y, G.ty, 3.2, dt); G.p = damp(G.p, G.tp, 3.2, dt); G.r = damp(G.r, G.tr, 2.5, dt);
        add('neck', G.p * 0.4, G.y * 0.4, G.r * 0.4); add('head', G.p * 0.6, G.y * 0.6, G.r * 0.6);
        // WRISTS: each hand drifts on 3 axes, droops a little when relaxed, more life while talking
        this.WN ||= { lx: noise(), ly: noise(), lz: noise(), rx: noise(), ry: noise(), rz: noise() };
        const W = this.WN, wa = talking0(this, now) ? 1.6 : 1;
        add('leftHand', W.lx(t * 0.21) * 0.14 * wa, W.ly(t * 0.17) * 0.12 * wa, (W.lz(t * 0.19) * 0.16 * wa + 0.08) * restL);
        add('rightHand', W.rx(t * 0.21 + 9) * 0.14 * wa, W.ry(t * 0.17 + 9) * 0.12 * wa, -(W.rz(t * 0.19 + 9) * 0.16 * wa + 0.08) * restR);
      }
      // legs: start straight-ish (knees a hair forward of locked), then IK plants each foot
      for (const s of ['left', 'right']) { set(s + 'UpperLeg', 0, 0, 0); set(s + 'LowerLeg', 0.03, 0, 0); set(s + 'Foot', 0, 0, 0); }
      for (const f of this.poseHooks) { try { f(vrm, dt); } catch (e) { console.warn('pose hook', e); } }
      H.normalizedHumanBonesRoot.updateMatrixWorld(true);
      try { this.updateFeet(dt, now); } catch (e) { console.warn('feet', e); }
      // the free leg (weight on the other one) rests on the ball of its foot: heel up, knee bent
      this.updateHeels(dt, now, t, L, A.tap?.side ? { side: A.tap.side, v: tap } : null);
      this.plantFoot('left', A.tap?.side === 'left' ? tap : 0, Math.max(0, -L));
      this.plantFoot('right', A.tap?.side === 'right' ? tap : 0, Math.max(0, L));
      // after the leg IK: her chair (src/seat.js) blends her into a seated pose
      for (const f of (this.postIKHooks || [])) { try { f(vrm, dt); } catch (e) { console.warn('post-ik hook', e); } }
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
          // no fixed shape list (Saidie: no loops): each finger takes a fresh random target, loosely coupled so the
          // hand reads as one gesture (an "openness" level plus per-finger scatter), held a log-normal random time
          const open = Math.random(), sc = () => (Math.random() - 0.5) * 0.5;
          const prev = G.t || [0, 0, 0, 0, 0];
          G.t = [open * 0.5 * Math.random(), ...[0, 1, 2, 3].map((j) => Math.max(-0.3, Math.min(0.6, prev[j + 1] * 0.25 + (open - 0.35) * 0.6 * (0.8 + j * 0.1) + sc())))];
          G.next = now + Math.min(4200, 700 * Math.exp(0.55 * (Math.random() + Math.random() + Math.random() - 1.5) * 2) + 500);
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
          // r11: a resting hand is never dead-straight: the middle/end joints keep a small natural flex (~8/6 deg). The
          // old straight 0 sat inside the joint-limit soft zone, so the limiter fired on nearly every finger, every frame
          // of a talk gesture (2,238 finger-joint clamps per 4 s of talking, measured); now the motion stays inside it
          set(`${s}${f}Proximal`, 0, sg * -spread * sp[f], sg * (0.02 + w * 1.18));
          set(`${s}${f}Intermediate`, 0, 0, sg * (0.14 + w * 1.36));
          set(`${s}${f}Distal`, 0, 0, sg * (0.1 + w * 0.88));
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
      // the wave layer goes on top of every arm layer above (idle drift, talk flex, learned moves)
      try { this.applyWave(vrm, now); } catch (e) { console.warn('wave', e); this.wave = null; }
      // her own body's shape keeps her arms and hands outside her clothes/hips/skirt (mesh-fitted collider)
      if (this.collision) { try { this.collision.apply(); } catch (e) { console.warn('collision', e); } }
      // her room (floor, wall behind her, stage edges) as colliders too
      if (!this.roomCol && this.feet) { try { this.roomCol = new RoomCollision(this); } catch (e) { console.warn('room', e); } }
      if (this.roomCol) { try { this.roomCol.apply(); } catch (e) { console.warn('room collision', e); } }
      // last check of the frame: no hand on the front of her hips / crotch (Saidie, Oct 14; Jena is a minor). The dance and
      // learned moves already keep clear; this catches anything layered on after them (talk gestures, collisions).
      try {
        const MVz = window.jenaMoves, Hz = vrm.humanoid, z = MVz?.handZone?.(Hz);
        for (const s of ['left', 'right']) {
          if (!z?.[s]?.frontCenter && !z?.[s]?.seat) continue;
          const U = Hz.getNormalizedBoneNode(s + 'UpperArm'); if (!U) continue;
          for (let k = 0; k < 8 && (q => q?.frontCenter || q?.seat)(MVz.handZone(Hz)?.[s]); k++) { U.rotateZ(s === 'left' ? 0.08 : -0.08); U.updateMatrixWorld(true); }
          this.hipGuardHits = (this.hipGuardHits || 0) + 1;
        }
      } catch {}
      // eyes: she looks at things (you, her desktop panel, chat, her own hand when it's doing something,
      // sometimes the floor), with little saccades on top and the head following big eye turns a bit
      if (this.gazeGoal && now > this.gazeGoal.until) this.gazeGoal = null;
      if (!this.gazeGoal && now > (this.nextGaze || 0)) {
        const busyHand = this.wave || this.handOnHip || this.target.leftUpperArm[2] > 0.5 || this.target.rightUpperArm[2] < -0.5;
        const r = Math.random();
        // talking (r11): she mostly looks at you while she speaks (short glances away, never the floor); the old pool
        // sent her eyes to the chat/floor ~40 % of the time, which read as half-lidded and downcast through the speech
        const talkingG = now < (this.talk?.until || 0) || !!this.voice;
        // r12 (reviewer: the eye still read heavy-lidded and looking down through the speech): while she talks she looks
        // at you ~86 % of the time; the rest are short side glances at EYE level ('aside'), never the chat/floor below.
        // During a wave or a side-step she keeps her eyes on you the whole time (engaged, not checking herself).
        const engaged = !!(this.wave || this.travelState);
        if (!talkingG && !engaged) this._asideSide = Math.random() < 0.5 ? 1 : -1;
        if (talkingG && r >= 0.86) this._asideSide = Math.random() < 0.5 ? 1 : -1;
        const what = engaged ? 'camera' : talkingG ? (r < 0.86 ? 'camera' : 'aside')
          : busyHand && r < 0.35 ? 'hand' : r < 0.6 ? 'camera' : r < 0.78 ? 'desktop' : r < 0.92 ? 'chat' : 'floor';
        this.gazeGoal = { what, until: now + (what === 'camera' ? 2500 + Math.random() * 4000 : what === 'aside' ? 500 + Math.random() * 600 : 900 + Math.random() * 1800) };
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
        this._hy = damp(this._hy || 0, THREE.MathUtils.clamp(yaw, -0.6, 0.6) * 0.2, 3, dt);   // r12c: the eyes lead a glance, the head follows only a little
        const talkingH = now < (this.talk?.until || 0) || !!this.voice;
        this._hp = damp(this._hp || 0, THREE.MathUtils.clamp(pitch, -0.4, talkingH ? 0 : 0.5) * 0.3, 3, dt);   // r12: no head drop toward a glance while she talks
      } else {
        // r12: looking at you, her head comes up to meet the lens instead of leaving the eyes rolled up under the upper
        // lids (the camera sits a little above her eye line in the bust framing: head ~7-10 deg below it, eyes ~8 deg up
        // = the heavy-lidded, looking-down read). The eyes' own pitch is the error; the head takes ~70 % of it while she
        // talks, waves or steps, ~35 % at rest. Bounded to ~9 deg.
        const ep = THREE.MathUtils.degToRad(this.vrm?.lookAt?.pitch || 0), engagedH = now < (this.talk?.until || 0) || !!this.voice || !!this.wave || !!this.travelState;
        this._hy = damp(this._hy || 0, 0, 3, dt);
        this._hp = damp(this._hp || 0, THREE.MathUtils.clamp((this._hp || 0) + ep * (engagedH ? 0.7 : 0.35), -0.16, 0.06), 2.5, dt);
      }
      add('head', this._hp, this._hy, 0);
      // r12c IDLE YAW CAP (r12 take, 0.5-2.8 s: an idle glance swung her head ~68 deg toward the chat, almost the back of
      // her head on camera): unless something CHOSE a look (a brain lookToward, a learned move, a dance), head + neck yaw
      // together stay within ~15 deg of her chest, on a soft curve (tanh) so the limit never reads as a hard stop
      if (!this.look.until && !window.jenaMoves?.playing && !this.dancing) {
        const hn = H.getNormalizedBoneNode('head'), nn = H.getNormalizedBoneNode('neck');
        if (hn && nn) {
          const tot = hn.rotation.y + nn.rotation.y;
          if (Math.abs(tot) > 1e-4) { const want = IDLE_YAW_CAP * Math.tanh(tot / IDLE_YAW_CAP), k = want / tot; hn.rotation.y *= k; nn.rotation.y *= k; }
          this.idleYaw = tot;
        }
      }
      this.updateFace(dt, t, now);
      for (const f of this.faceHooks || []) { try { f(vrm, dt); } catch (e) { console.warn('face hook', e); } }
      this.driveJaw(vrm, dt);
      try { this.springSetup?.tick?.(); } catch {}   // hair gravity follows the way her body faces (motion.js setupSprings)
      try { this.polish?.before(vrm, dt); } catch (e) { console.warn('polish', e); }   // joint limits + One-Euro smoothing (motionpolish.js)
      vrm.update(dt);
      try { this.polish?.after(vrm); } catch {}
    }
  }
  // bone snapshots for the interpolated render: every bone of her skinned meshes (humanoid + hair/clothes springs)
  snapBones(vrm, which) {
    if (!this._bones || this._bonesVrm !== vrm) {
      const set = new Set(); vrm.scene.traverse((o) => { if (o.isSkinnedMesh) for (const b of o.skeleton.bones) set.add(b); });
      this._bones = [...set]; this._bonesVrm = vrm;
      this._snap = { prev: this._bones.map(() => [new THREE.Quaternion(), new THREE.Vector3()]), cur: this._bones.map(() => [new THREE.Quaternion(), new THREE.Vector3()]) };
      this._snapN = 0;
    }
    const S = this._snap[which];
    for (let i = 0; i < this._bones.length; i++) { S[i][0].copy(this._bones[i].quaternion); S[i][1].copy(this._bones[i].position); }
    if (which === 'cur') this._snapN++;
  }
  lerpBones(alpha) {
    if (!this._bones || this._snapN < 2) return;
    const P = this._snap.prev, C = this._snap.cur, a = Math.max(0, Math.min(1, alpha));
    for (let i = 0; i < this._bones.length; i++) { const b = this._bones[i]; b.quaternion.slerpQuaternions(P[i][0], C[i][0], a); b.position.lerpVectors(P[i][1], C[i][1], a); }
    this._lerped = true;
  }
  unlerpBones() {
    if (!this._lerped) return; this._lerped = false;
    const C = this._snap.cur;
    for (let i = 0; i < this._bones.length; i++) { this._bones[i].quaternion.copy(C[i][0]); this._bones[i].position.copy(C[i][1]); }
  }
  simStats() { return { step: this.fixedStep, steps: this.simSteps || 0, bones: this._bones?.length || 0 }; }


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
        // human blink gaps are log-normal (median ~3 s, long tail), not uniform: no rhythm you can count along to
        // r11: gaps live in 2-6 s (log-normal, median 3.4 s), an occasional quick double blink
        const g = Math.exp(Math.log(3.4) + 0.35 * Math.sqrt(-2 * Math.log(Math.max(1e-9, Math.random()))) * Math.cos(2 * Math.PI * Math.random()));
        this.blink.next = this.blink.double ? 0.09 + Math.random() * 0.08 : Math.min(6, Math.max(2, g));
        if (!this.blink.double) this.blink.lastAt = now;
      }
    }
    // happy eyes already squint; keep blink from overshooting
    // eyelids follow her gaze: looking down the upper lids drop with the eyes, looking up they lift (never a stare
    // with the iris tucked under a still lid); a gaze jump (saccade) of more than ~12 deg sometimes brings a blink
    const lf = this.faceTune?.lidFollow ?? 0.6, pitch = this.vrm?.lookAt?.pitch || 0, yaw = this.vrm?.lookAt?.yaw || 0;
    // r11: OPEN-EYE BASELINE. The lids only follow a clearly downward gaze (past ~4 deg) and drop at most ~0.1, so she
    // never reads sleepy; a gaze jump may bring a blink, but never sooner than 2 s after the last one
    // r12: while she talks, waves or side-steps the lids don't follow the gaze down at all (eyes stay open on you)
    const openNow = now < (this.talk?.until || 0) || !!this.voice || !!this.wave || !!this.travelState;
    // (three-vrm's lookAt pitch is POSITIVE when she looks DOWN; r11 had the sign flipped, so her lids dropped when her
    // eyes went UP to the camera)
    const lid = openNow ? 0 : Math.max(0, Math.min(0.12, (pitch - 6) / 22 * 0.2)) * lf;
    if (this._lidGz && Math.hypot(yaw - this._lidGz[0], pitch - this._lidGz[1]) > 12 && this.blink.t < 0 && now - (this.blink.lastAt || -1e9) > 2000 && Math.random() < 0.35) this.blink.next = 0;
    this._lidGz = [yaw, pitch];
    em.setValue('blink', Math.max(0, Math.min(1, b + lid * (1 - b))) * (1 - this.mood.weights.happy * 0.3));
    this.blinkNow = b;
    // r12 open-eye baseline (installEyesOpen): a little more while she talks, none through a blink or a happy squint
    if (this.eyesOpenOk) {
      const eo = (this.faceTune?.eyeOpen ?? 0.42) * (openNow ? 1.15 : 1);
      this._eo = damp(this._eo ?? eo, eo, 4, dt);
      em.setValue('jena_eyes_open', Math.max(0, this._eo * (1 - Math.min(1, b * 1.6)) * (1 - Math.min(1, lid * 4)) * (1 - this.mood.weights.happy * 0.7)));
    }
    // per-eye blinks and gaze shapes only come from a learned move's tracked face (moves.js applyFace runs after
    // this); start them at 0 every frame so a move can never leave an eye stuck half-shut after it ends
    for (const k of ['blinkLeft', 'blinkRight', 'lookUp', 'lookDown', 'lookLeft', 'lookRight']) em.setValue(k, 0);
    // face life between moods: a soft smile, a little brow lift or a relaxed squint now and then
    const M = this.micro;
    M.next -= dt;
    if (this.mood.name === 'neutral' && !M.name && M.next <= 0) {
      const r = Math.random();
      // r11: 'relaxed' left the pool (it lowers her lids = the sleepy look); a one-sided smirk takes its place
      const hasX = (n) => { try { return !!em.getExpression(n); } catch { return false; } };
      // r12: while she talks the soft smile is a mouth-only smirk (the 'happy' preset squints her eyes = heavy-lidded look)
      const talkM = now < (this.talk?.until || 0) || !!this.voice;
      M.name = r < 0.45 && !talkM ? 'happy' : r < 0.75 || (talkM && r < 0.45) ? (hasX('jena_smirk_l') ? (Math.random() < 0.5 ? 'jena_smirk_l' : 'jena_smirk_r') : 'happy') : 'surprised';
      M.peak = M.name === 'surprised' ? 0.25 : M.name === 'happy' ? 0.35 : 0.4;
      M.until = now + (M.name === 'surprised' ? 700 : 1500 + Math.random() * 2000);
      M.next = 5 + Math.random() * 8;
    }
    const microGoal = M.name && now <= M.until && this.mood.name === 'neutral' ? M.peak : 0;
    M.w = damp(M.w, microGoal, 5, dt);
    if (M.name) { em.setValue(M.name, Math.max(em.getValue(M.name) || 0, M.w)); if (microGoal === 0 && M.w < 0.01) { M.name = null; M.w = 0; } }
    // TALK LIVELINESS (Saidie, 2:05 + 2:07 PM: a confident 19-year-old's expression set, from her lip-sync reference):
    // while she talks, a quick varied expression lands every ~0.8-2 s: wide eyes, smirk, wink, side-eye, eye roll,
    // grin, a head tilt toward the camera. Not the same one within 3 picks, fast attack / softer release
    // (motion-tuning.json face.liveliness / exprAttack / exprRelease). Sass, never sexual.
    this.lively(em, now, dt);
    // stress beat (simulate's _stress): a quick brow lift with the nod/tilt, lids open a hair
    if (this.stressNow > 0.02) em.setValue('surprised', Math.max(em.getValue('surprised') || 0, 0.16 * this.stressNow));
    // never sleepy while she speaks: lid-lowering shapes are capped (a chosen mood still shows, just not with heavy lids)
    if (now < (this.talk?.until || 0) || this.voice) { if ((em.getValue('relaxed') || 0) > 0.2) em.setValue('relaxed', 0.2); try { if (em.getExpression('jena_droopy')) em.setValue('jena_droopy', 0); } catch {} }
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
      // co-articulation: the mouth is already moving toward the next sound ~70 ms ahead (anticipation), so shapes
      // flow into each other instead of snapping letter by letter
      const nx = this.viseme(now + 70), ca = this.faceTune?.coarticulation ?? 0.35;
      if (nx && V[nx] !== undefined && nx !== shape) V[nx] = Math.max(V[nx], open * ca);
      else if (nx === 'closed') for (const k of Object.keys(V)) V[k] *= 1 - ca * 0.6;
      // her real audio's formant mix (voice.js) shapes the mouth too, so lips follow the sound, not just the letters
      const mix = this.voice?.mix;
      if (mix && vis !== 'closed') for (const k of Object.keys(V)) V[k] = V[k] * 0.5 + open * (mix[k] || 0) * 0.6;
    }
    this._vis ||= { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    // lips open quickly and relax a little slower (attack 26 / release 16): speech-like, never a flapping jaw
    for (const k of Object.keys(V)) { this._vis[k] = damp(this._vis[k], V[k], V[k] > this._vis[k] ? 26 : 16, dt); em.setValue(k, this._vis[k]); }
    this._aa = this._vis.aa; this._oh = this._vis.oh;
  }

  lively(em, now, dt) {
    const FT = this.faceTune || {}, L = FT.liveliness ?? 1, Z = (this._lv ||= { next: now + 600, cur: null, until: 0, w: 0, hist: [] });
    const speaking = (this.voice && this.voice.level > 0.05) || now < (this.talk.until || 0);
    const has = (n) => { try { return !!em.getExpression(n); } catch { return false; } };
    if (L > 0 && speaking && !Z.cur && now >= Z.next && !window.jenaMoves?.playing) {
      const pool = ['wide', 'smirk', 'wink', 'sideeye', 'eyeroll', 'grin', 'tilt', 'smirk', 'grin'].filter((k) => !Z.hist.slice(-3).includes(k));
      const k = pool[Math.floor(Math.random() * pool.length)];
      Z.hist.push(k); if (Z.hist.length > 20) Z.hist.shift();
      Z.cur = k; Z.side = Math.random() < 0.5 ? 'left' : 'right'; Z.t0 = now;
      Z.until = now + ({ wide: 520, smirk: 1100, wink: 300, sideeye: 900, eyeroll: 700, grin: 900, tilt: 1300 }[k]) * (0.85 + Math.random() * 0.3);
      if (k === 'sideeye') { this._asideSide = Z.side === 'left' ? 1 : -1; this.gazeGoal = { what: 'aside', until: Z.until }; this.nextGaze = Z.until + 200; }   // r12: the eyes do it, the head stays on you
      if (k === 'eyeroll') this.lookToward('up', 380);
      if (k === 'tilt' || k === 'smirk') this.tiltHead(Z.side, Z.until - now + 300, 0.1 + Math.random() * 0.06);
      (window.jenaLog ||= []).push({ t: Math.round(now), kind: 'face', what: k });
    }
    if (!Z.cur) return;
    const on = now < Z.until, A = FT.exprAttack ?? 14, R = FT.exprRelease ?? 7;
    Z.w = damp(Z.w, on ? 1 : 0, on ? A : R, dt);
    const w = Z.w * Math.min(1.2, L), put = (n, v) => { if (has(n)) em.setValue(n, Math.max(em.getValue(n) || 0, Math.min(1, v * w))); };
    switch (Z.cur) {
      case 'wide': put('surprised', 0.55); break;
      case 'smirk': if (has('jena_smirk_l')) put(Z.side === 'left' ? 'jena_smirk_l' : 'jena_smirk_r', 0.65); else if (has('jena_cat_smile')) put('jena_cat_smile', 0.6); else put('happy', 0.4); break;   // r11: no 'relaxed' (lids)
      case 'wink': put(Z.side === 'left' ? 'blinkLeft' : 'blinkRight', 1.0); put('happy', 0.35); break;
      case 'sideeye': if (has('jena_smirk_l')) put(Z.side === 'left' ? 'jena_smirk_l' : 'jena_smirk_r', 0.3); break;   // r11: the eyes do the side-eye, lids stay open
      case 'eyeroll': break;   // r12: the eyes roll up, the lids stay open (no 'relaxed')
      case 'grin': if (has('jena_grin')) put('jena_grin', 0.7); else put('happy', 0.75); break;
      case 'tilt': if (has('jena_smirk_l')) put(Z.side === 'left' ? 'jena_smirk_l' : 'jena_smirk_r', 0.4); else put('happy', 0.2); break;   // r12: no eye squint
    }
    if (!on && Z.w < 0.02) { Z.cur = null; Z.w = 0; Z.next = now + (800 + Math.random() * 1200) / Math.max(0.3, L); }
  }

  // her jaw bone follows her mouth: however the mouth got opened this frame (speech visemes, her voice level,
  // a tracked face's jawOpen/aa/oh from a learned move or expression clip), a model with a humanoid 'jaw' bone
  // also swings the jaw down. Runs after every face hook, so it reads the final mouth values. Models without a
  // jaw bone (or with a mis-mapped one that isn't under the head, a common VRoid/converter bug) keep the
  // blendshape-only mouth. The jaw is a child of the head, so her head nods/tilts carry it along untouched.
  jawBone(vrm) {
    if (this._jawVrm === vrm) return this._jaw;
    this._jawVrm = vrm; this._jaw = null;
    const H = vrm.humanoid, jaw = H?.getNormalizedBoneNode('jaw'), head = H?.getNormalizedBoneNode('head');
    if (jaw && head) {
      let o = jaw.parent, under = false; while (o) { if (o === head) { under = true; break; } o = o.parent; }
      const raw = H.getRawBoneNode?.('jaw'), rh = H.getRawBoneNode?.('head');
      let below = true;
      if (raw && rh) { vrm.scene.updateMatrixWorld(true); below = raw.getWorldPosition(new THREE.Vector3()).y <= rh.getWorldPosition(new THREE.Vector3()).y + 0.02; }
      if (under && below) this._jaw = jaw; else console.warn('jena jaw: the jaw bone on this model is not under her head; mouth stays blendshape-only');
    }
    this.jawInfo = { bone: !!this._jaw, mapped: !!jaw };
    return this._jaw;
  }
  driveJaw(vrm, dt) {
    const jaw = this.jawBone(vrm), em = vrm.expressionManager;
    if (!jaw || !em) return;
    const g = (n) => em.getValue(n) || 0;
    // how far open the mouth reads: aa opens most, oh/ou round with a mid jaw, ih/ee are mostly lips
    const open = Math.min(1, Math.max(g('aa'), g('oh') * 0.85, g('ou') * 0.55, g('ih') * 0.45, g('ee') * 0.35, g('surprised') * 0.4, this.arkJaw || 0)); // + a tracked face's jawOpen (arkitface.js)
    this._jawOpen = damp(this._jawOpen || 0, open, 26, dt);
    const MAX = 0.24; // ~14 degrees: a natural talking jaw; the mouth blendshapes still shape the lips on top
    jaw.rotation.set(this._jawOpen * MAX, 0, 0);
    this.jawInfo.open = +this._jawOpen.toFixed(3); this.jawInfo.deg = +(this._jawOpen * MAX * 57.2958).toFixed(1);
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
    return { expressions: ex, fingers: fing, talking: performance.now() < this.talk.until, viseme: this.viseme(performance.now()), micro: this.micro.name, rig: this.rigCheck || null, jaw: this.jawInfo || null };
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
