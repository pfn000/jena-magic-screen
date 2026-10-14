
import fs from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
let NOW = 0; globalThis.performance = { now: () => NOW };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };
const evs = []; globalThis.dispatchEvent = (e) => evs.push(e.type + ':' + JSON.stringify(e.detail).slice(0, 80));
globalThis.parent = globalThis;
const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { VRMLoaderPlugin, VRMUtils } = await import('@pixiv/three-vrm');
const buf = fs.readFileSync('/home/user/tab/files/jena-learn/track/vrm/notex.vrm');
const gltf = await new Promise((res, rej) => { const l = new GLTFLoader(); l.register((p) => new VRMLoaderPlugin(p)); l.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej); });
const vrm = gltf.userData.vrm; VRMUtils.rotateVRM0(vrm);
const scene = new THREE.Scene(); scene.add(vrm.scene); vrm.update(0);
const H = vrm.humanoid;
// motion.js imports its JSON through Vite; inline them into a temp module for Node
{ const dir = new URL('.', import.meta.url).pathname, root = dir + '../';
  let s = fs.readFileSync(root + 'src/motion.js', 'utf8');
  s = s.replace("import MOVESET from '../ANIMATIONS/moveset.json';", 'const MOVESET = ' + fs.readFileSync(root + 'ANIMATIONS/moveset.json', 'utf8') + ';')
       .replace("import STYLES from '../ANIMATIONS/styles.json';", 'const STYLES = ' + fs.readFileSync(root + 'ANIMATIONS/styles.json', 'utf8') + ';');
  fs.writeFileSync(dir + '.motion-h.mjs', s); }
const { Motion, setupSprings } = await import('./.motion-h.mjs');
const springs = setupSprings(vrm);
const camera = new THREE.PerspectiveCamera(30, 0.5, 0.1, 100); camera.position.set(0, 1.25, 2.2); scene.add(camera); camera.updateMatrixWorld();
const av = { poseHooks: [], handHooks: [], faceHooks: [], camera, talk: { until: 0, text: '', t0: 0 }, mood: { name: 'neutral' }, lookToward() {}, gazeAt() {} };
const m = new Motion(av, {});
const got = []; m.onReaction((r) => got.push(r));
const P = (b) => H.getNormalizedBoneNode(b).getWorldPosition(new THREE.Vector3());
const hipsRest = H.getNormalizedBoneNode('hips').position.clone();
const rest = () => { H.getNormalizedBoneNode('hips').position.copy(hipsRest); for (const b of Object.keys(H.humanBones)) { const n = H.getNormalizedBoneNode(b); if (n) n.quaternion.identity(); }
  // her idle arms down (REST from avatar.js)
  H.getNormalizedBoneNode('leftUpperArm').rotation.set(-0.06, 0, -1.12); H.getNormalizedBoneNode('rightUpperArm').rotation.set(-0.06, 0, 1.12);
  H.getNormalizedBoneNode('leftLowerArm').rotation.set(0, -0.42, -0.3); H.getNormalizedBoneNode('rightLowerArm').rotation.set(0, 0.42, 0.3); };
const step = (dt) => { NOW += dt * 1000; rest(); for (const f of av.poseHooks) f(vrm, dt); H.normalizedHumanBonesRoot.updateMatrixWorld(true); for (const f of av.handHooks) f(vrm, dt);
  vrm.expressionManager && av.faceHooks.forEach((f) => f(vrm, dt)); vrm.update(dt); };
const out = { springs, tests: {} };
function run(id, at = 0.5) {
  m.active = []; m.lastReact = -1e9; NOW += 5000; m.nextIdle = 1e15; m.nextTalk = 1e15;
  const r = m.play(id, { intensity: 0.8 }); const n = Math.round(r.durationMs * at / 33);
  for (let i = 0; i < n; i++) step(1 / 30);
  const res = { arms: m.state().arms, face: m.faceNow };
  const head = P('head'), cam = camera.position;
  for (const s of ['left', 'right']) {
    const hand = P(s + 'Hand'), sh = P(s + 'UpperArm'), tip = P(s + 'IndexDistal');
    const toCam = cam.clone().sub(sh).normalize(), arm = hand.clone().sub(sh).normalize(), fing = tip.clone().sub(hand).normalize();
    res[s] = { hand: hand.toArray().map((x) => +x.toFixed(3)), handToHead_cm: +(hand.distanceTo(head) * 100).toFixed(1), armVsCamDeg: +(arm.angleTo(toCam) * 57.3).toFixed(1), indexVsCamDeg: +(fing.angleTo(cam.clone().sub(hand).normalize()) * 57.3).toFixed(1), reach: +hand.distanceTo(sh).toFixed(3) };
  }
  res.head = head.toArray().map((x) => +x.toFixed(3));
  res.joints = Object.fromEntries(['hips','spine','chest','neck','head','leftUpperArm','leftLowerArm','leftHand','leftIndexDistal','rightUpperArm','rightLowerArm','rightHand','rightIndexDistal','leftUpperLeg','leftLowerLeg','leftFoot','rightUpperLeg','rightLowerLeg','rightFoot'].map((b) => [b, P(b).toArray().map((x) => +x.toFixed(3))]));
  out.tests[id] = res;
}
for (const id of ['direct_point', 'direct_you', 'direct_finger_guns', 'react_hands_face', 'react_facepalm', 'react_laugh', 'brag_smug', 'direct_wave', 'react_recoil', 'talk_palms', 'talk_shrug', 'react_hype']) run(id);
// text triggers
m.lastReact = -1e9; NOW += 5000; av.talk = { until: NOW + 3000, text: 'chat you guys are wild lol', t0: NOW }; step(1/30);
out.readLine = m.state().playing; m.active = []; m.lastReact = -1e9; NOW += 5000; m.seenUser('pixelfan22'); av.talk = { until: NOW + 3000, text: 'thanks pixelfan22!', t0: NOW }; step(1/30); out.readLine2 = m.state().playing;
m.lastReact = -1e9; NOW += 5000; av.talk = { until: NOW + 3000, text: 'that was a W, too easy', t0: NOW }; step(1/30); out.readLine3 = m.state().playing;
out.reactions = got.map((r) => [r.type, r.intensity, r.trigger, typeof r.timestamp]); out.events = evs.slice(0, 3);
// head turn: does the hair lag (spring) ? hair tip motion vs head
const hairTip = vrm.scene.getObjectByName('J_Sec_Hair3_05');
m.active = []; NOW += 5000; m.play('react_face_swing'); const tr = [];
for (let i = 0; i < 45; i++) { step(1 / 30); tr.push(+hairTip.getWorldPosition(new THREE.Vector3()).x.toFixed(3)); }
out.hairTipX = tr;
fs.writeFileSync('/tmp/motion-harness.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out).slice(0, 200));
