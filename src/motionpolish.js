// Motion polish for Jena's 3D body (avatar-3d-v37): the last pass on her pose before three-vrm draws it.
// 1. Joint limits: elbows and knees only bend the way a real joint bends, wrists stay within ~30 deg of straight
//    (soft limit, so a fast move eases into the stop instead of hitting a wall), finger joints only curl in the
//    palm plane (no sideways "claw" bends), neck/head stay inside a human range.
// 2. One-Euro filtering on every humanoid bone (Casiez et al. 2012): heavy smoothing when a bone moves slowly
//    (kills mocap/tracking jitter and noise flutter), almost none when it moves fast (no lag on waves, dances,
//    head turns). The filtered pose is what gets drawn; her procedural/learned pose code keeps its own unfiltered
//    values (restored right after the draw), so nothing upstream ever reads back a smoothed value and drifts.
import * as THREE from 'three';

export class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.x = null; this.dx = 0; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(x, dt) {
    if (this.x === null || !(dt > 0)) { this.x = x; this.dx = 0; return x; }
    const dx = (x - this.x) / dt;
    this.dx += (dx - this.dx) * OneEuro.alpha(this.dCutoff, dt);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += (x - this.x) * OneEuro.alpha(cutoff, dt);
    return this.x;
  }
  reset() { this.x = null; this.dx = 0; }
}

// One-Euro on a rotation: the speed term is the angular speed (rad/s), the blend is a slerp
export class QuatEuro {
  constructor(minCutoff = 1.5, beta = 0.6, dCutoff = 1.2) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.q = null; this.prevRaw = new THREE.Quaternion(); this.speed = 0; }
  filter(raw, dt, out) {
    if (!this.q || !(dt > 0)) { this.q = raw.clone(); this.prevRaw.copy(raw); return out.copy(raw); }
    const w = Math.min(1, Math.abs(this.prevRaw.dot(raw)));
    const sp = 2 * Math.acos(w) / dt;
    this.speed += (sp - this.speed) * OneEuro.alpha(this.dCutoff, dt);
    this.prevRaw.copy(raw);
    const cutoff = this.minCutoff + this.beta * this.speed;
    this.q.slerp(raw, OneEuro.alpha(cutoff, dt));
    return out.copy(this.q);
  }
}

const PARTS = {
  core: ['hips', 'spine', 'chest', 'upperChest'],
  head: ['neck', 'head'],
  arms: ['leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand'],
  legs: ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot', 'leftToes', 'rightToes'],
  fingers: ['left', 'right'].flatMap((s) => ['Thumb', 'Index', 'Middle', 'Ring', 'Little'].flatMap((f) =>
    (f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal']).map((j) => s + f + j))),
};
// minCutoff (Hz), beta, per body part: tuned on her idle + talk + wave at 60 fps (lower = smoother, higher beta = less lag when fast)
const TUNE = { core: [1.4, 0.5], head: [1.6, 0.8], arms: [2.0, 0.9], legs: [2.2, 0.8], fingers: [2.6, 0.5] };

const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _tw = new THREE.Quaternion(), _sw = new THREE.Quaternion(), _ax = new THREE.Vector3();
const clamp = THREE.MathUtils.clamp;
// soft stop: free up to `knee`, then eases toward `max` (never past it)
const soft = (v, knee, max) => { const a = Math.abs(v); if (a <= knee) return v; const r = max - knee; return Math.sign(v) * (knee + r * Math.tanh((a - knee) / r)); };
const softRange = (v, lo, hi, give = 0.15) => {
  if (v > hi - give) return hi - give + give * Math.tanh((v - (hi - give)) / give);
  if (v < lo + give) return lo + give - give * Math.tanh(((lo + give) - v) / give);
  return v;
};

export class MotionPolish {
  constructor(avatar, opts = {}) {
    this.avatar = avatar; this.filters = new Map(); this.saved = new Map();
    const q = new URLSearchParams(location.search);
    this.on = q.get('polish') !== '0';
    this.limits = q.get('limits') !== '0' && opts.limits !== false;
    this.smooth = q.get('smooth') !== '0' && opts.smooth !== false;
    this.wristMax = opts.wristMax ?? 0.55;   // ~31 deg swing from a straight wrist
    this.stats = { clamps: 0, frames: 0 };
    this.drawn = new Map();   // the pose as drawn this frame (telemetry samples this, not the unfiltered pose)
  }
  // motion-tuning.json (src/tuning.js): One-Euro constants per part, wrist limit, switches
  tune(p = {}) {
    for (const k of Object.keys(TUNE)) if (Array.isArray(p[k]) && p[k].length === 2) TUNE[k] = p[k];
    if (Number.isFinite(p.wristMaxDeg)) this.wristMax = p.wristMaxDeg * Math.PI / 180;
    if (typeof p.limits === 'boolean' && new URLSearchParams(location.search).get('limits') !== '0') this.limits = p.limits;
    if (typeof p.smooth === 'boolean' && new URLSearchParams(location.search).get('smooth') !== '0') this.smooth = p.smooth;
    for (const [b, f] of this.filters) { const t = TUNE[this.part(b)]; if (t) { f.minCutoff = t[0]; f.beta = t[1]; } }
  }
  part(b) { for (const [k, list] of Object.entries(PARTS)) if (list.includes(b)) return k; return null; }
  // joint limits in VRM 1.0 normalized space (T-pose rest, world-aligned axes; Euler XYZ like the rest of avatar.js)
  limit(name, node) {
    const r = node.rotation; let hit = false;
    const side = name.startsWith('left') ? 1 : name.startsWith('right') ? -1 : 0;   // her left = +1
    const set = (x, y, z) => { if (Math.abs(x - r.x) + Math.abs(y - r.y) + Math.abs(z - r.z) > 1e-4) { hit = true; r.set(x, y, z); } };
    if (/LowerArm$/.test(name)) {
      // elbow: flex only one way (left flexes -y, right +y), forearm twist (x) inside pronation/supination range
      const flex = -side * r.y;   // + = bent
      const f = softRange(flex, -0.03, 2.55, 0.2);
      set(softRange(r.x, -1.75, 0.65, 0.2), -side * f, soft(r.z, 0.35, 0.55));
    } else if (/Hand$/.test(name)) {
      // wrist: swing (bend) at most ~30 deg (soft), twist about the forearm axis limited (the twist bones carry it)
      node.quaternion.normalize();
      _tw.set(node.quaternion.x, 0, 0, node.quaternion.w).normalize();       // twist about x (along the arm)
      _sw.copy(node.quaternion).multiply(_q.copy(_tw).invert());             // swing = q * twist^-1
      let sAng = 2 * Math.acos(clamp(Math.abs(_sw.w), 0, 1)), tAng = 2 * Math.atan2(_tw.x, _tw.w);
      if (tAng > Math.PI) tAng -= 2 * Math.PI; if (tAng < -Math.PI) tAng += 2 * Math.PI;
      const sNew = soft(sAng, this.wristMax * 0.7, this.wristMax), tNew = soft(tAng, 0.6, 0.85);
      if (Math.abs(sNew - sAng) > 1e-4 || Math.abs(tNew - tAng) > 1e-4) {
        hit = true;
        if (sAng > 1e-5) { _ax.set(_sw.x, _sw.y, _sw.z).normalize(); if (_sw.w < 0) _ax.negate(); _sw.setFromAxisAngle(_ax, sNew); }
        _tw.setFromAxisAngle(_ax.set(1, 0, 0), tNew);
        node.quaternion.copy(_sw).multiply(_tw);
      }
    } else if (/LowerLeg$/.test(name)) {
      // knee: a hinge that bends backward only, tiny side play
      set(softRange(r.x, -0.02, 2.5, 0.15), soft(r.y, 0.15, 0.3), soft(r.z, 0.1, 0.2));
    } else if (name === 'neck' || name === 'head') {
      set(soft(r.x, 0.45, 0.7), soft(r.y, 0.8, 1.15), soft(r.z, 0.35, 0.55));
    } else if (/(Index|Middle|Ring|Little)(Intermediate|Distal)$/.test(name)) {
      // middle/end finger joints: curl in the palm plane only (left curls -z, right +z), slight hyperextension max
      const curl = -side * r.z;
      set(soft(r.x, 0.03, 0.06), soft(r.y, 0.03, 0.06), -side * softRange(curl, -0.08, 1.75, 0.15));
    } else if (/(Index|Middle|Ring|Little)Proximal$/.test(name)) {
      const curl = -side * r.z;
      set(soft(r.x, 0.12, 0.2), soft(r.y, 0.3, 0.42), -side * softRange(curl, -0.25, 1.65, 0.15));
    }
    if (hit) this.stats.clamps++;
    return hit;
  }
  // before vrm.update: limit + filter the normalized pose, remember the unfiltered pose
  before(vrm, dt) {
    if (!this.on) return;
    const H = vrm.humanoid; this.stats.frames++;
    for (const [part, list] of Object.entries(PARTS)) for (const b of list) {
      const n = H.getNormalizedBoneNode(b); if (!n) continue;
      this.saved.set(b, n.quaternion.clone());
      if (this.limits) this.limit(b, n);
      if (this.smooth && dt > 0) {
        let f = this.filters.get(b);
        if (!f) { const [mc, be] = TUNE[part]; f = new QuatEuro(mc, be); this.filters.set(b, f); }
        f.filter(n.quaternion, dt, n.quaternion);
      }
      let d = this.drawn.get(b); if (!d) this.drawn.set(b, (d = new THREE.Quaternion())); d.copy(n.quaternion);
    }
  }
  // after vrm.update (raw bones already carry the polished pose): give the procedural code back its own values
  after(vrm) {
    if (!this.on) return;
    const H = vrm.humanoid;
    for (const [b, q] of this.saved) { const n = H.getNormalizedBoneNode(b); if (n) n.quaternion.copy(q); }
    this.saved.clear();
  }
  reset() { this.filters.clear(); }
}

// critically damped spring (no overshoot, no jitter): x'' = w^2 (target - x) - 2 w x'
export class Spring {
  constructor(x = 0, omega = 3) { this.x = x; this.v = 0; this.omega = omega; }
  step(target, dt) {
    const w = this.omega, k = Math.min(dt, 0.05);
    // exact solution for a critically damped spring over k seconds
    const d = this.x - target, e = Math.exp(-w * k);
    const nx = target + (d + (this.v + w * d) * k) * e;
    this.v = (this.v - w * (this.v + w * d) * k) * e;
    this.x = nx; return nx;
  }
}
