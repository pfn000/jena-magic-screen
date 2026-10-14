// Her gaming chair (Saidie, Oct 13 10:35 PM): a procedural purple gaming chair slides in when Jena sits and slides out
// when she stands; she sits in casual, modest poses (legs crossed, ankles crossed, angled to the side, criss-cross,
// one knee up, elbows on knees, slouched gamer), switches between them now and then (NoRepeat, irregular), swivels a
// little, and can spin the chair all the way around. Commands: chat "sit" / "stand up" / "spin", jena.sit(pose),
// jena.stand(), jena.chairSpin(). Long idles: she sits down on her own at irregular times (autonomy -> idleTick).
// Poses are applied AFTER her leg IK (avatar.postIKHooks) and blended by one weight, so sit/stand is one smooth motion.
import * as THREE from 'three';
import { NoRepeat } from './nonrepeat.js';

const PURPLE = 0x6a3fd0, PURPLE_HI = 0x8d6bff, TRIM = 0x2a1d45, BLACK = 0x17151f, METAL = 0x9a96a8;
// pose = bone -> [x, y, z] (Euler 'YXZ', radians, VRM normalized space: +x her left, +z forward; thigh pitch -1.57 = level)
// plus hips {dy (m), dz (m), x (pitch, - = lean back), y (yaw)}. All modest: knees together or crossed, nothing splayed.
const P = {
  legs_crossed: { turn: 0.3, hips: { dz: 0.0, x: -0.05 }, rightUpperLeg: [-1.72, 0.32, 0.1], rightLowerLeg: [1.35, 0, 0], rightFoot: [0.25, 0, 0],
    leftUpperLeg: [-1.5, 0.02, 0], leftLowerLeg: [1.5, 0, 0], leftFoot: [0.05, 0, 0], arms: 'lap' },
  ankles_crossed: { hips: { dz: 0.0, x: -0.08 }, leftUpperLeg: [-1.45, -0.06, 0], leftLowerLeg: [1.05, 0, 0.12], leftFoot: [0.2, 0, 0],
    rightUpperLeg: [-1.45, 0.06, 0], rightLowerLeg: [1.05, 0, -0.12], rightFoot: [0.2, 0, 0], arms: 'armrests' },
  side_angled: { turn: 0.25, hips: { dz: 0.0, y: -0.3, x: -0.04 }, leftUpperLeg: [-1.5, 0.5, 0], leftLowerLeg: [1.65, 0, 0], leftFoot: [0.1, 0, 0],
    rightUpperLeg: [-1.45, 0.42, 0], rightLowerLeg: [1.7, 0, 0], rightFoot: [0.1, 0, 0], spine: [0, 0.12, 0], chest: [0, 0.1, 0], arms: 'lap' },
  criss_cross: { turn: 1.25, hips: { dy: 0.05, dz: -0.02, x: 0.0 }, leftUpperLeg: [-1.35, 0.5, -0.35], leftLowerLeg: [2.35, 0, 0], leftFoot: [0, 0, 0],
    rightUpperLeg: [-1.35, -0.5, 0.35], rightLowerLeg: [2.35, 0, 0], rightFoot: [0, 0, 0], arms: 'knees' },   // modest: the chair swivels so she sits side-on to the camera
  one_knee_up: { turn: 0.9, hips: { dz: 0.0, x: -0.06 }, leftUpperLeg: [-2.1, -0.1, 0], leftLowerLeg: [2.2, 0, 0], leftFoot: [0.3, 0, 0],
    rightUpperLeg: [-1.5, 0.04, 0], rightLowerLeg: [1.45, 0, 0], rightFoot: [0.05, 0, 0], arms: 'hug_left' },
  elbows_on_knees: { turn: 0.5, hips: { dz: 0.02, x: 0.08 }, leftUpperLeg: [-1.5, -0.1, 0], leftLowerLeg: [1.6, 0, 0], rightUpperLeg: [-1.5, 0.1, 0], rightLowerLeg: [1.6, 0, 0],
    spine: [0.25, 0, 0], chest: [0.2, 0, 0], upperChest: [0.1, 0, 0], neck: [-0.25, 0, 0], head: [-0.2, 0, 0], arms: 'elbows' },
  slouched_gamer: { turn: 0.35, hips: { dy: -0.03, dz: 0.1, x: -0.32 }, leftUpperLeg: [-1.25, -0.04, 0], leftLowerLeg: [0.75, 0, 0], leftFoot: [-0.1, 0, 0],
    rightUpperLeg: [-1.25, 0.04, 0], rightLowerLeg: [0.8, 0, 0], rightFoot: [-0.1, 0, 0],
    spine: [0.12, 0, 0], chest: [0.12, 0, 0], neck: [0.12, 0, 0], head: [0.05, 0, 0], arms: 'controller' },
  // "diva energy" (Saidie, Oct 14 11:57 AM / 12:03 PM: the POSE from her refs only, normal outfit): upright and leaned
  // back owning the chair, legs crossed at the knee (right over left), chin up, her both forearms on the armrests (right one
  // laid along it, left hand draped over the front end; hands stay out at the chair's sides, nowhere near her lap), a cocky little grin (expression 'smug'). Seen 3/4 from the camera.
  diva: { turn: 0.38, hips: { dz: -0.03, x: -0.13 }, rightUpperLeg: [-1.78, 0.4, 0.1], rightLowerLeg: [1.45, 0, 0], rightFoot: [0.35, 0, 0],
    leftUpperLeg: [-1.25, -0.07, 0], leftLowerLeg: [1.3, 0, 0], leftFoot: [0.05, 0, 0],
    spine: [0.03, 0, 0], chest: [0.02, 0, 0], neck: [-0.04, 0, 0], head: [-0.05, 0.06, 0.04],
    arms: 'armrests', hands: { left: 'armrest_front', right: 'armrest' }, face: 'smug', faceVariant: [3, 2] },
};
// arm sets (left side; right is mirrored: y and z flip sign)
const ARMS = {
  lap: { UpperArm: [0.1, -0.38, -1.25], LowerArm: [0, -0.95, 0], Hand: [0, -0.1, -0.15] },   // hands rest on her thighs
  armrests: { UpperArm: [0.05, -0.15, -1.15], LowerArm: [0, -1.35, 0], Hand: [0, 0, -0.25] },
  knees: { UpperArm: [0.1, -0.7, -1.15], LowerArm: [0, -0.75, 0], Hand: [0, 0, -0.2] },
  elbows: { UpperArm: [0.2, -0.85, -1.15], LowerArm: [0, -2.1, 0], Hand: [0, -0.2, 0.2] },
  controller: { UpperArm: [0.15, -0.6, -1.25], LowerArm: [0, -1.5, 0], Hand: [0, -0.3, 0] },
  hug_left: { UpperArm: [0.1, -0.9, -1.0], LowerArm: [0, -1.6, 0], Hand: [0, -0.3, 0] },
};
const POSES = Object.keys(P);
export const SEAT_POSES = P, SEAT_ARMS = ARMS;   // tests / the dev panel can read (and tune) the poses
const PICK = new NoRepeat({ minGap: 3, windowMs: 15 * 60000 });
const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const _e = new THREE.Euler(0, 0, 0, 'YXZ'), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0);

function chairMesh(seatTop) {
  const g = new THREE.Group(); g.name = 'jena-gaming-chair';
  const M = (c, r = 0.55, m = 0.05) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
  const purple = M(PURPLE, 0.6), hi = M(PURPLE_HI, 0.5), trim = M(TRIM, 0.7), black = M(BLACK, 0.5, 0.2), metal = M(METAL, 0.3, 0.8);
  const box = (w, h, d, mat, x, y, z, r = 0.025) => { const geo = new THREE.BoxGeometry(w, h, d, 2, 2, 2); const p = geo.attributes.position; for (let i = 0; i < p.count; i++) { _v.fromBufferAttribute(p, i); const k = r * 0.6; _v.x -= Math.sign(_v.x) * k * (Math.abs(_v.y) / (h / 2)) * (Math.abs(_v.z) / (d / 2)) * 0.3; p.setXYZ(i, _v.x, _v.y, _v.z); } geo.computeVertexNormals(); const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m; };
  // star base + casters
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.06, 20), black); hub.position.y = 0.09; g.add(hub);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2, arm = box(0.05, 0.035, 0.32, black, Math.sin(a) * 0.17, 0.08, Math.cos(a) * 0.17, 0.01); arm.rotation.y = a; g.add(arm);
    const w = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), black); w.position.set(Math.sin(a) * 0.32, 0.03, Math.cos(a) * 0.32); g.add(w);
  }
  const gas = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, Math.max(0.1, seatTop - 0.2), 16), metal); gas.position.y = 0.12 + Math.max(0.1, seatTop - 0.2) / 2; g.add(gas);
  const top = new THREE.Group(); top.name = 'swivel'; g.add(top);   // everything above the gas lift swivels
  top.add(box(0.52, 0.09, 0.5, purple, 0, seatTop - 0.045, 0.01));                 // seat cushion
  top.add(box(0.08, 0.1, 0.5, trim, 0.26, seatTop - 0.035, 0.01), box(0.08, 0.1, 0.5, trim, -0.26, seatTop - 0.035, 0.01));   // seat bolsters
  top.add(box(0.12, 0.012, 0.48, hi, 0, seatTop + 0.001, 0.01));                   // racing stripe
  const back = new THREE.Group(); back.position.set(0, seatTop, -0.24); back.rotation.x = -0.16; top.add(back);
  back.add(box(0.5, 0.78, 0.09, purple, 0, 0.4, 0));
  back.add(box(0.09, 0.66, 0.12, trim, 0.25, 0.36, 0.02), box(0.09, 0.66, 0.12, trim, -0.25, 0.36, 0.02));   // side wings
  back.add(box(0.12, 0.6, 0.012, hi, 0, 0.36, 0.047));
  const pillow = box(0.26, 0.11, 0.08, trim, 0, 0.66, 0.07, 0.04); back.add(pillow);
  const lumbar = box(0.3, 0.12, 0.07, trim, 0, 0.14, 0.07, 0.04); back.add(lumbar);
  for (const s of [1, -1]) {   // armrests
    top.add(box(0.035, 0.2, 0.035, black, s * 0.3, seatTop + 0.06, -0.02, 0.008));
    top.add(box(0.08, 0.035, 0.26, black, s * 0.3, seatTop + 0.17, 0.0, 0.01));
  }
  g.userData.top = top;
  return g;
}

export class Seat {
  constructor(avatar, { log = () => {}, dance = null } = {}) {
    this.avatar = avatar; this.log = log; this.dance = dance;
    this.w = 0; this.state = 'standing'; this.pose = null; this.prevPose = null; this.poseMix = 1; this.swivel = 0; this.spinA = 0;
    this.nextAutoSit = performance.now() + 120000 + Math.random() * 240000;
    (avatar.poseHooks ||= []).push((vrm, dt) => this.preIK(vrm, dt));
    (avatar.postIKHooks ||= []).push((vrm, dt) => this.apply(vrm, dt));
    this.P = P; this.ARMS = ARMS;
    if (typeof window !== 'undefined') window.jenaSeat = this;
  }
  get seated() { return this.state === 'sitting' || this.state === 'seated'; }
  get busy() { return this.state === 'sitting' || this.state === 'standing_up'; }
  stateInfo() { return { state: this.state, pose: this.pose, w: +this.w.toFixed(2), spinning: !!this.spinS, chair: !!this.chair?.visible }; }
  measure() {
    const A = this.avatar, H = A.vrm.humanoid;
    const len = (a, b) => H.getNormalizedBoneNode(a).getWorldPosition(_v).distanceTo(H.getNormalizedBoneNode(b).getWorldPosition(_v2));
    const thigh = len('leftUpperLeg', 'leftLowerLeg'), shin = len('leftLowerLeg', 'leftFoot');
    const hipW = H.getNormalizedBoneNode('hips').getWorldPosition(new THREE.Vector3());
    const ground = A.groundY ? A.groundY(hipW.x, hipW.z) : 0;
    const ank = (A.ankleH?.left ?? 0.08);
    // rest heights of each ankle and toe joint above the floor (she is standing when this runs): the planted foot's
    // sole goes back to exactly these heights while she sits (no shoe sinking into the floor, no floating)
    const toeRest = {}, ankRest = {};
    for (const s of ['left', 'right']) {
      const F = H.getNormalizedBoneNode(s + 'Foot'), T = H.getNormalizedBoneNode(s + 'Toes');
      ankRest[s] = A.ankleH?.[s] ?? 0.08;
      if (T) { T.getWorldPosition(_v); toeRest[s] = _v.y - (A.groundY ? A.groundY(_v.x, _v.z) : 0) - (F.getWorldPosition(_v2).y - (A.groundY ? A.groundY(_v2.x, _v2.z) : 0)) + ankRest[s]; }
    }
    const seatHip = ground + shin + ank + 0.02;   // hip joint over a seat at knee height
    return { thigh, shin, hipW, ground, seatHip, standHip: hipW.y, toeRest, ankRest };
  }
  facingYaw() {   // her body's facing in the world, from the left-right hip line (works for VRM 0 and 1)
    const H = this.avatar.vrm.humanoid, l = H.getNormalizedBoneNode('leftUpperLeg').getWorldPosition(_v), r = H.getNormalizedBoneNode('rightUpperLeg').getWorldPosition(_v2);
    const lx = l.x - r.x, lz = l.z - r.z; return Math.atan2(-lz, lx);   // forward = (-lz, 0, lx)
  }
  ensureChair(m) {
    const A = this.avatar, parent = A.vrm.scene.parent || A.scene;
    const seatTop = m.seatHip - m.ground - 0.07;
    if (!this.chair || Math.abs(this.chairTop - seatTop) > 0.01) {
      if (this.chair) parent.remove(this.chair);
      this.chair = chairMesh(seatTop); this.chairTop = seatTop; parent.add(this.chair);
    }
    this.chair.visible = true;
  }
  sit(why = 'tired of standing', pose = null) {
    const A = this.avatar; if (!A.vrm || this.seated) { if (pose && P[pose]) this.setPose(pose); return this.stateInfo(); }
    if (this.dance?.active) this.dance.stop();
    if (A.spinState) A.spinState = null; A.handOnHip = null; A.wave = null;
    const m = this.measure(); this.m = m;
    this.baseYaw = this.facingYaw();
    this.ensureChair(m);
    const fwd = _v.set(Math.sin(this.baseYaw), 0, Math.cos(this.baseYaw));
    this.home = new THREE.Vector3(m.hipW.x - fwd.x * 0.06, m.ground, m.hipW.z - fwd.z * 0.06);
    this.side = Math.random() < 0.5 ? 1 : -1; this.turnSide = Math.random() < 0.5 ? 1 : -1;
    this.state = 'sitting'; this.t = 0; this.t0 = performance.now(); this.spinA = 0; this.swivel = 0;
    this.pose = pose && P[pose] ? pose : PICK.pick(POSES, { pool: 'seat-pose' }); this.prevPose = null; this.poseMix = 1;
    this.nextPoseAt = performance.now() + 15000 + Math.random() * 40000;
    this.standAt = performance.now() + 45000 + Math.random() * 200000;
    try { const L = (window.jenaLog ||= []); L.push({ t: Math.round(performance.now()), kind: 'sit', what: this.pose, why }); } catch {}
    this.log(`sitting down in my gaming chair (${this.pose.replace(/_/g, ' ')})${why ? ', ' + why : ''}`);
    return this.stateInfo();
  }
  stand(why = 'stretching my legs') {
    if (!this.seated) return this.stateInfo();
    this.state = 'standing_up'; this.t = 0; this.t0 = performance.now(); this.spinS = null;
    try { const L = (window.jenaLog ||= []); L.push({ t: Math.round(performance.now()), kind: 'stand', what: this.pose, why }); } catch {}
    this.log(`getting up from my chair${why ? ', ' + why : ''}`);
    return this.stateInfo();
  }
  setPose(name) { if (!P[name] || name === this.pose) return; this.prevPose = this.pose; this.pose = name; this.poseMix = 0; this.poseT0 = performance.now(); try { (window.jenaLog ||= []).push({ t: Math.round(performance.now()), kind: 'seat-pose', what: name }); } catch {} }
  spin(dir = Math.random() < 0.5 ? 1 : -1, ms = 1700 + Math.random() * 700) {
    if (!this.seated) { this.sit('so I can spin'); setTimeout(() => this.spin(dir, ms), 1600); return this.stateInfo(); }
    this.spinS = { t0: performance.now(), dur: ms, dir, from: this.spinA };
    try { (window.jenaLog ||= []).push({ t: Math.round(performance.now()), kind: 'chair-spin', what: dir > 0 ? 'ccw' : 'cw' }); } catch {}
    this.log('spinning in my chair');
    return this.stateInfo();
  }
  // autonomy calls this on every idle tick: returns true when the chair handled it
  idleTick(now, quietFor) {
    now = performance.now();
    if (this.state === 'seated') {
      if (now > this.standAt) { this.stand('been sitting a while'); return true; }
      if (now > this.nextPoseAt) {
        this.nextPoseAt = now + 15000 + Math.random() * 45000;
        if (Math.random() < 0.22) this.spin(); else this.setPose(PICK.pick(POSES.filter((p) => p !== this.pose), { pool: 'seat-pose' }));
      }
      return true;   // her standing idles (weight shifts, steps, hand on hip) wait until she stands
    }
    if (this.state !== 'standing') return true;
    if (quietFor > 45000 && now > this.nextAutoSit && !this.dance?.active) {
      this.nextAutoSit = now + Math.min(15 * 60000, 90000 * Math.exp((Math.random() + Math.random() - 1) * 1.3) + 60000);
      if (Math.random() < 0.55) { this.sit(quietFor > 120000 ? "it's quiet, sitting down for a bit" : 'taking a seat'); return true; }
    }
    return false;
  }
  preIK(vrm, dt) {   // the feet IK must not step while she is (getting) seated
    this.avatar.seatW = this.w;
  }
  // where a seated hand goes: 'armrest' = on top of the armrest on her side, about its middle; 'armrest_front' = over
  // its front end; 'knee' = on top of her crossed (top) knee
  handTarget(H, side, what, out) {
    if (what === 'armrest') {
      const top = this.chair.userData.top; top.updateMatrixWorld(true);
      return out.set((side === 'left' ? 1 : -1) * 0.3, this.chairTop + 0.17 + 0.0175 + 0.045 + (this._lift || 0), 0.03).applyMatrix4(top.matrixWorld);   // mid-armrest: forearm along it, hand beside her
    }
    if (what === 'armrest_front') {
      const top = this.chair.userData.top; top.updateMatrixWorld(true);
      return out.set((side === 'left' ? 1 : -1) * 0.3, this.chairTop + 0.17 + 0.0175 + 0.05 + (this._lift || 0), 0.1).applyMatrix4(top.matrixWorld);
    }
    // 'knee': on top of and a little in front of her crossed knee
    const knee = H.getNormalizedBoneNode((P[this.pose]?.rightUpperLeg?.[1] ?? 0) > 0.15 ? 'rightLowerLeg' : 'leftLowerLeg'), hips = H.getNormalizedBoneNode('hips');
    knee.getWorldPosition(out);
    const f = _v2.set(0, 0, 1).applyQuaternion(hips.getWorldQuaternion(_q2)); f.y = 0; f.normalize();
    out.addScaledVector(f, 0.04); out.y += 0.06; return out;
  }
  reach(H, side, what, k) {
    const U = H.getNormalizedBoneNode(side + 'UpperArm'), K = H.getNormalizedBoneNode(side + 'LowerArm'), W = H.getNormalizedBoneNode(side + 'Hand');
    if (!U || !K || !W) return;
    H.normalizedHumanBonesRoot.updateMatrixWorld(true);
    const T = this.handTarget(H, side, what, (this._t ||= new THREE.Vector3()));
    const V = (this._iv ||= [0, 1, 2, 3, 4].map(() => new THREE.Vector3())), Q = (this._iq ||= [0, 1, 2].map(() => new THREE.Quaternion()));
    const sg = side === 'left' ? 1 : -1;
    for (let it = 0; it < 2; it++) {
      const pu = U.getWorldPosition(V[0]), pk = K.getWorldPosition(V[1]), pw = W.getWorldPosition(V[2]);
      const a = pk.distanceTo(pu), b = pw.distanceTo(pk);
      const d = THREE.MathUtils.clamp(T.distanceTo(pu), 0.05, a + b - 1e-4);
      const cur = V[3].subVectors(pu, pk).angleTo(V[4].subVectors(pw, pk));
      const want = Math.acos(THREE.MathUtils.clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1));
      K.rotation.y += -sg * (cur - want) * k;   // elbow flex axis (her left flexes with -y)
      K.updateMatrixWorld(true);
      W.getWorldPosition(pw);
      const swing = Q[0].setFromUnitVectors(V[3].subVectors(pw, pu).normalize(), V[4].subVectors(T, pu).normalize());
      Q[1].identity().slerp(swing, k);
      const wq = U.getWorldQuaternion(Q[2]).premultiply(Q[1]);
      U.quaternion.copy(U.parent.getWorldQuaternion(Q[1]).invert().multiply(wq));
      U.updateMatrixWorld(true);
    }
  }
  // ---- contact fixes (Saidie, Oct 14 3:15 PM: hand sinking into the armrest, shoe clipping the floor) ----
  // the hand's joints (wrist + fingers) that sit over the armrest pad, measured against the pad's top surface
  handJoints(H, side) {
    return ['Hand', 'IndexProximal', 'IndexDistal', 'MiddleProximal', 'MiddleDistal', 'RingDistal', 'LittleProximal', 'LittleDistal', 'ThumbDistal']
      .map((n) => H.getNormalizedBoneNode(side + n)).filter(Boolean);
  }
  armrestTopY() { return this.chair.position.y + this.chairTop + 0.17 + 0.0175; }
  // lowest hand joint over the pad minus the pad's top (m); joints are mid-hand, the palm skin is ~1.5 cm under them
  handClearance(H, side) {
    const top = this.chair.userData.top; top.updateMatrixWorld(true);
    const inv = (this._inv ||= new THREE.Matrix4()).copy(top.matrixWorld).invert(), sx = (side === 'left' ? 1 : -1) * 0.3;
    let min = Infinity;
    for (const j of this.handJoints(H, side)) {
      j.getWorldPosition(_v); _v2.copy(_v).applyMatrix4(inv);
      if (Math.abs(_v2.x - sx) < 0.075 && Math.abs(_v2.z) < 0.16) min = Math.min(min, _v.y);
    }
    return Number.isFinite(min) ? min - this.armrestTopY() : null;
  }
  // a hand resting on the armrest lies flat on it: no drooping wrist or fingers pointing down into the pad
  levelHand(H, side) {
    const W = H.getNormalizedBoneNode(side + 'Hand'), tip = H.getNormalizedBoneNode(side + 'MiddleDistal') || H.getNormalizedBoneNode(side + 'MiddleProximal');
    if (!W || !tip) return;
    const pw = W.getWorldPosition(new THREE.Vector3()), d = tip.getWorldPosition(new THREE.Vector3()).sub(pw), len = d.length();
    if (len < 1e-4 || d.y >= -0.004) return;
    const want = d.clone(); want.y = -0.004; want.setLength(len);
    const swing = _q2.setFromUnitVectors(d.normalize(), want.normalize());
    const wq = W.getWorldQuaternion(new THREE.Quaternion()).premultiply(swing);
    W.quaternion.copy(W.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(wq));
    W.updateMatrixWorld(true);
  }
  // the planted foot (any foot near the floor; a crossed or raised leg is left alone): the ankle goes to its standing
  // height above the floor (thigh pitch solves it), then the foot pitches so the toe is at its standing height too,
  // so the sole sits exactly on the floor
  plantFeet(H, vrm0, w) {
    const A = this.avatar, sg = vrm0 ? -1 : 1, m = this.m; if (!m?.ankRest) return;
    const gy = (p) => (A.groundY ? A.groundY(p.x, p.z) : 0);
    this.sole = this.sole || {};
    for (const s of ['left', 'right']) {
      const U = H.getNormalizedBoneNode(s + 'UpperLeg'), F = H.getNormalizedBoneNode(s + 'Foot'), T = H.getNormalizedBoneNode(s + 'Toes');
      if (!U || !F) continue;
      const err = () => { F.getWorldPosition(_v); return _v.y - (gy(_v) + m.ankRest[s]); };
      let e = err();
      if (e > 0.1) { this.sole[s] = null; continue; }   // a raised foot (crossed leg, knee up)
      const q0 = U.quaternion.clone(); let total = 0;
      for (let it = 0; it < 5 && Math.abs(e) > 0.0015; it++) {
        const h = 0.02; U.rotateX(sg * h); const d = (err() - e) / h; U.rotateX(-sg * h);
        if (Math.abs(d) < 0.03) break;
        const step = THREE.MathUtils.clamp(-e / d, -0.12, 0.12); if (Math.abs(total + step) > 0.45) break;
        U.rotateX(sg * step); total += step; e = err();
      }
      if (w < 1) { const q1 = U.quaternion.clone(); U.quaternion.copy(q0).slerp(q1, w); }
      if (T && m.toeRest[s] != null) {
        const terr = () => { T.getWorldPosition(_v); return _v.y - (gy(_v) + m.toeRest[s]); };
        let t = terr();
        for (let it = 0; it < 4 && Math.abs(t) > 0.0015; it++) {
          const h = 0.03; F.rotateX(sg * h); const d = (terr() - t) / h; F.rotateX(-sg * h);
          if (Math.abs(d) < 0.02) break;
          F.rotateX(sg * THREE.MathUtils.clamp(-t / d, -0.2, 0.2) * w); t = terr();
        }
      }
      F.getWorldPosition(_v); const ae = _v.y - (gy(_v) + m.ankRest[s]);
      let te = null; if (T && m.toeRest[s] != null) { T.getWorldPosition(_v2); te = _v2.y - (gy(_v2) + m.toeRest[s]); }
      this.sole[s] = { ankle: +ae.toFixed(4), toe: te == null ? null : +te.toFixed(4) };
    }
  }
  clearances() {   // for proofs / the dev panel: metres; hand = lowest hand joint above the armrest top
    const H = this.avatar.vrm?.humanoid; if (!H || !this.chair) return null;
    return { hand: { left: this.handClearance(H, 'left'), right: this.handClearance(H, 'right') }, sole: this.sole || null, pose: this.pose, state: this.state };
  }
  apply(vrm, dt) {
    const A = this.avatar; if (!A.vrm || !this.chair) return;
    const now = performance.now();
    // the sit/stand timeline: chair slides in (0-0.7 s) while she lowers (0.35-1.45 s); standing is the reverse
    let slide = 1;
    if (this.state === 'sitting') { this.t = (now - this.t0) / 1000; slide = ease(this.t / 0.7); this.w = ease((this.t - 0.35) / 1.1); if (this.t > 1.5) { this.state = 'seated'; this.w = 1; } }
    else if (this.state === 'standing_up') { this.t = (now - this.t0) / 1000; this.w = 1 - ease(this.t / 0.95); slide = 1 - ease((this.t - 0.85) / 0.7); if (this.t > 1.6) { this.state = 'standing'; this.w = 0; this.chair.visible = false; } }
    else if (this.state === 'standing') { this.w = 0; slide = 0; }
    A.seatW = this.w;
    // chair spin + idle swivel
    if (this.spinS) { const u = (now - this.spinS.t0) / this.spinS.dur; if (u >= 1) { this.spinA = this.spinS.from + Math.PI * 2 * this.spinS.dir; this.spinS = null; } else { const e = u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u); this.spinA = this.spinS.from + e * Math.PI * 2 * this.spinS.dir; } }
    this.swT = (this.swT || 0) + dt;
    const swivel = this.state === 'seated' && !this.spinS ? Math.sin(this.swT * 0.37) * 0.06 + Math.sin(this.swT * 0.11 + 2) * 0.05 : 0;
    // modesty: each pose has a swivel (P.turn) so knees-apart poses are seen side-on, never straight from the front
    const pt = (this.pose ? (P[this.pose].turn || 0) : 0), ppt = this.prevPose ? (P[this.prevPose].turn || 0) : pt;
    const pmT = this.poseT0 ? Math.min(1, (now - this.poseT0) / 900) : 1;
    const poseTurn = (ppt + (pt - ppt) * ease(pmT)) * (this.turnSide || 1) * ease(this.w);
    const turn = this.spinA + swivel + poseTurn;
    // place the chair: under her, facing her start facing (+ spin), sliding in from her side
    const yaw = this.baseYaw + turn;
    const side = _v.set(Math.cos(this.baseYaw), 0, -Math.sin(this.baseYaw)).multiplyScalar(this.side * 1.4 * (1 - slide));
    this.chair.position.set(this.home.x + side.x - Math.sin(this.baseYaw) * 0.25 * (1 - slide), this.home.y, this.home.z + side.z - Math.cos(this.baseYaw) * 0.25 * (1 - slide));
    this.chair.rotation.y = this.baseYaw;
    this.chair.userData.top.rotation.y = turn + (1 - slide) * 0.6 * this.side;
    if (this.w <= 0.001) return;
    const H = vrm.humanoid, vrm0 = vrm.meta?.metaVersion === '0', w = this.w;
    this.poseMix = Math.min(1, this.poseMix + Math.min(dt, 0.25) / 0.9); if (this.poseMix < 1 && this.poseT0) this.poseMix = Math.max(this.poseMix, Math.min(1, (now - this.poseT0) / 900));
    const pm = ease(this.poseMix), cur = P[this.pose], prev = this.prevPose ? P[this.prevPose] : null;
    const val = (o, k) => o?.[k];
    const setBone = (bone, a, b) => {
      const node = H.getNormalizedBoneNode(bone); if (!node) return;
      const r = a && b ? [0, 1, 2].map((i) => b[i] + (a[i] - b[i]) * pm) : (a || [0, 0, 0]).map((x) => x * (b ? 1 : pm));
      _q.setFromEuler(_e.set(r[0], r[1], r[2], 'YXZ'));
      if (vrm0) _q.set(-_q.x, _q.y, -_q.z, _q.w);
      const isLeg = /UpperLeg|LowerLeg|Foot/.test(bone);
      if (isLeg) node.quaternion.slerp(_q, w);
      else if (/Arm|Hand/.test(bone)) node.quaternion.slerp(_q, w * 0.85);
      else node.quaternion.multiply(_q2.identity().slerp(_q, w));   // spine/neck/head: added on top of her own life
    };
    for (const b of ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'spine', 'chest', 'upperChest', 'neck', 'head']) {
      const a = val(cur, b), c = prev ? val(prev, b) : null;
      if (a || c) setBone(b, a || [b.includes('Leg') ? -1.5 : 0, 0, 0], c);
    }
    const armOf = (pose, s) => ARMS[(s === 'left' ? P[pose]?.armsLeft : P[pose]?.armsRight) || P[pose]?.arms || 'lap'];
    for (const s of ['left', 'right']) for (const part of ['UpperArm', 'LowerArm', 'Hand']) {
      const f = (pose) => { const v = armOf(pose, s)[part]; return s === 'left' ? v : [v[0], -v[1], -v[2]]; };
      let a = f(this.pose);
      if (this.pose === 'one_knee_up' && s === 'right') a = (() => { const v = ARMS.lap[part]; return [v[0], -v[1], -v[2]]; })();
      setBone(s + part, a, prev ? f(this.prevPose) : null);
    }
    // hips: down onto the seat, back into the chair, her pose's tilt/yaw, and the chair's turn
    const hips = H.getNormalizedBoneNode('hips');
    if (hips && A.hipsRest) {
      const hp = cur.hips || {}, pp = prev?.hips || hp;
      const mix = (k, d = 0) => (pp[k] ?? d) + ((hp[k] ?? d) - (pp[k] ?? d)) * pm;
      const drop = (this.m.standHip - this.m.seatHip) + mix('dy') * -1;
      const tz = A.hipsRest.z + (vrm0 ? -1 : 1) * mix('dz');
      hips.position.y += ((A.hipsRest.y - drop) - hips.position.y) * w;
      hips.position.z += (tz - hips.position.z) * w;
      hips.position.x += (A.hipsRest.x - hips.position.x) * w;
      _q.setFromEuler(_e.set(mix('x'), mix('y'), 0, 'YXZ')); if (vrm0) _q.set(-_q.x, _q.y, -_q.z, _q.w);
      hips.quaternion.slerp(_q2.copy(_q), w * 0.9);
      if (turn) hips.quaternion.premultiply(_q.setFromAxisAngle(_Y, turn * w));
    }
    try { this.plantFeet(H, vrm0, w); } catch (e) { /* best-effort */ }
    // hands with a target (diva: forearms on the armrests): two-bone IK from the arm
    // set's starting shape, so the hand really lands there whatever her size or the chair's swivel
    for (const s of ['left', 'right']) {
      const tc = cur?.hands?.[s], tp = prev?.hands?.[s];
      const k = w * ((tc ? pm : 0) + (tp && tp !== tc ? 1 - pm : 0));
      const what = tc || tp;
      if (what && k > 0.01) {
        try {
          this._lift = 0; this.reach(H, s, what, Math.min(1, k));
          if (/^armrest/.test(what)) {   // on the pad, never in it: level the hand, then lift the wrist by any shortfall
            this.levelHand(H, s);
            const c = this.handClearance(H, s), need = 0.018;   // joint line ~1.5 cm above the palm skin + 3 mm air
            if (c != null && c < need) { this._lift = need - c; this.reach(H, s, what, Math.min(1, k)); this.levelHand(H, s); }
            this._lift = 0;
          }
        } catch (e) { this._lift = 0; /* best-effort */ }
      }
    }
    // a pose with its own face (diva -> 'smug'): she makes it once she has settled, then again now and then
    if (this.state === 'seated' && cur?.face && pm >= 1) {
      if (!this.faceAt || now > this.faceAt) {
        this.faceAt = now + 7000 + Math.random() * 9000;
        const fv = cur.faceVariant; const variant = Array.isArray(fv) ? fv[Math.floor(Math.random() * fv.length)] : fv;
        try { window.jena?.expr?.play?.(cur.face, { intensity: 0.75, trigger: 'seat-pose', variant }); } catch {}
      }
    } else if (!cur?.face) this.faceAt = 0;
    // a little life while seated: breathing in the chest, a foot bounce on the free leg
    if (this.state === 'seated') {
      const c = H.getNormalizedBoneNode('chest'); if (c) c.rotateX(Math.sin(this.swT * 1.6) * 0.012);
      const fb = H.getNormalizedBoneNode(this.pose === 'legs_crossed' || this.pose === 'diva' ? 'rightFoot' : 'leftFoot'); if (fb && Math.sin(this.swT * 0.23) > 0.6) fb.rotateX(Math.sin(this.swT * 7) * 0.08);
    }
  }
}
