// Her body's own shape as a collider: fitted at load time from her REAL skinned mesh (body + clothes +
// skirt), not hand-typed numbers. Every vertex whose strongest bone is in her torso/hips/thighs/skirt is
// put into 2 cm height slices, in two frames (around her hips, and around her chest so it bends with
// her spine). Each slice becomes an ellipse. Every frame her elbows, wrists and fingertips are tested
// against it; a joint inside is pushed back out to the surface by swinging the upper arm (the whole arm
// moves, like a real arm sliding off a hip). Stats are live in avatar.collision (dev panel reads them).
import * as THREE from 'three';

const SLICE = 0.02;
const _p = new THREE.Vector3(), _l = new THREE.Vector3(), _m = new THREE.Matrix4(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _s = new THREE.Vector3();

function descendants(node) { const s = new Set(); node?.traverse((o) => s.add(o)); return s; }

export function fitBodyCollider(vrm) {
  const H = vrm.humanoid;
  const raw = (n) => H.getRawBoneNode(n);
  const hipsRaw = raw('hips'), chestRaw = raw('upperChest') || raw('chest');
  if (!hipsRaw) return null;
  vrm.scene.updateMatrixWorld(true);
  const torso = descendants(hipsRaw);
  for (const n of ['leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'neck', 'head', 'leftLowerLeg', 'rightLowerLeg']) for (const o of descendants(raw(n))) torso.delete(o);
  const upper = new Set([raw('spine'), raw('chest'), raw('upperChest')].filter(Boolean));
  for (const n of ['chest', 'upperChest']) for (const o of descendants(raw(n))) if (torso.has(o)) upper.add(o);
  const hipW = hipsRaw.getWorldPosition(new THREE.Vector3()), chestW = chestRaw.getWorldPosition(new THREE.Vector3());
  const lower = new Map(), up = new Map();
  let used = 0, total = 0;
  const v = new THREE.Vector3();
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const pos = o.geometry.attributes.position, si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight;
    if (!pos || !si || !sw) return;
    const bones = o.skeleton.bones;
    const step = pos.count > 60000 ? 2 : 1;
    for (let i = 0; i < pos.count; i += step) {
      total++;
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
      const bone = bones[best];
      if (!torso.has(bone)) continue;
      o.getVertexPosition(i, v);
      o.applyBoneTransform(i, v);
      v.applyMatrix4(o.matrixWorld);
      const isUp = upper.has(bone);
      const ref = isUp ? chestW : hipW, map = isUp ? up : lower;
      const x = v.x - ref.x, y = v.y - ref.y, z = v.z - ref.z;
      const k = Math.round(y / SLICE);
      const s = map.get(k) || { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, n: 0 };
      if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x; if (z < s.z0) s.z0 = z; if (z > s.z1) s.z1 = z; s.n++;
      map.set(k, s); used++;
    }
  });
  const pack = (map) => {
    const out = new Map();
    for (const [k, s] of map) if (s.n >= 6) out.set(k, { cx: (s.x0 + s.x1) / 2, rx: (s.x1 - s.x0) / 2, cz: (s.z0 + s.z1) / 2, rz: (s.z1 - s.z0) / 2 });
    return out;
  };
  const L = pack(lower), U = pack(up);
  const range = (m) => { const ks = [...m.keys()]; return ks.length ? [Math.min(...ks) * SLICE, Math.max(...ks) * SLICE] : null; };
  return { lower: L, upper: U, vertices: used, scanned: total, lowerRange: range(L), upperRange: range(U), chestOffsetY: chestW.y - hipW.y };
}

export class BodyCollision {
  constructor(avatar, collider) {
    this.avatar = avatar; this.c = collider;
    this.stats = { checks: 0, corrections: 0, maxPushCm: 0, lastAt: 0, perSec: 0, slices: collider.lower.size + collider.upper.size, vertices: collider.vertices };
    this._win = { t: performance.now(), n: 0 };
  }
  // ellipse test in a bone's frame; returns {inside, push: Vector3 world target} or null
  test(world, node, map, margin) {
    _m.copy(node.matrixWorld).invert();
    _l.copy(world).applyMatrix4(_m);
    const s = map.get(Math.round(_l.y / SLICE));
    if (!s) return null;
    const dx = _l.x - s.cx, dz = _l.z - s.cz, rx = s.rx + margin, rz = s.rz + margin;
    const e = (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz);
    if (e >= 1) return { inside: false, clear: (Math.sqrt(e) - 1) * Math.min(rx, rz) };
    let f = 1 / Math.sqrt(Math.max(e, 1e-4));
    if (!Number.isFinite(f) || e < 1e-3) { f = 1; _l.x = s.cx + Math.sign(dx || 1) * rx; }
    else { _l.x = s.cx + dx * f * 1.01; _l.z = s.cz + dz * f * 1.01; }
    return { inside: true, target: _l.applyMatrix4(node.matrixWorld).clone(), depth: (1 - Math.sqrt(e)) * Math.min(rx, rz) };
  }
  // where is this point relative to her body volume? (hips frame below her chest, chest frame above)
  check(world, margin) {
    const H = this.avatar.vrm.humanoid;
    const hips = H.getNormalizedBoneNode('hips'), chest = H.getNormalizedBoneNode('upperChest') || H.getNormalizedBoneNode('chest');
    _m.copy(hips.matrixWorld).invert(); const yh = _p.copy(world).applyMatrix4(_m).y;
    const useUpper = this.c.upperRange && yh > this.c.chestOffsetY + this.c.upperRange[0];
    return useUpper ? this.test(world, chest, this.c.upper, margin) : this.test(world, hips, this.c.lower, margin);
  }
  // swing the upper arm (about the shoulder) so `joint` moves to `target`
  swing(upperArm, jointWorld, target) {
    const sh = upperArm.getWorldPosition(_s);
    const q = _q1.setFromUnitVectors(_a.subVectors(jointWorld, sh).normalize(), _b.subVectors(target, sh).normalize());
    const wq = upperArm.getWorldQuaternion(_q2).premultiply(q);
    upperArm.quaternion.copy(upperArm.parent.getWorldQuaternion(_q1).invert().multiply(wq));
    upperArm.updateMatrixWorld(true);
  }
  apply() {
    const H = this.avatar.vrm.humanoid;
    H.normalizedHumanBonesRoot.updateMatrixWorld(true);
    let pushes = 0, maxD = 0, minClear = Infinity;
    for (const s of ['left', 'right']) {
      const U = H.getNormalizedBoneNode(s + 'UpperArm'), E = H.getNormalizedBoneNode(s + 'LowerArm'), W = H.getNormalizedBoneNode(s + 'Hand');
      const tip = H.getNormalizedBoneNode(s + 'MiddleIntermediate') || H.getNormalizedBoneNode(s + 'MiddleProximal');
      if (!U || !E || !W) continue;
      for (let iter = 0; iter < 3; iter++) {
        let moved = false;
        for (const [node, margin] of [[E, 0.045], [W, 0.035], [tip, 0.022]]) {
          if (!node) continue;
          const p = node.getWorldPosition(new THREE.Vector3());
          const r = this.check(p, margin);
          this.stats.checks++;
          if (!r) continue;
          if (!r.inside) { minClear = Math.min(minClear, r.clear); continue; }
          this.swing(U, p, r.target); pushes++; maxD = Math.max(maxD, r.depth); moved = true;
        }
        if (!moved) break;
      }
    }
    const now = performance.now();
    this.stats.corrections += pushes; this._win.n += pushes;
    if (pushes) { this.stats.lastAt = Date.now(); this.stats.maxPushCm = Math.max(this.stats.maxPushCm * 0.995, maxD * 100); }
    if (Number.isFinite(minClear)) this.stats.minClearCm = Math.round(minClear * 1000) / 10;
    if (now - this._win.t > 1000) { this.stats.perSec = this._win.n; this._win = { t: now, n: 0 }; }
  }
  // a point on her real hip surface (her side), for hand-on-hip: outside her clothes by `out` metres
  hipSurface(side, out = 0.03) {
    const H = this.avatar.vrm.humanoid, hips = H.getNormalizedBoneNode('hips');
    const sg = side === 'left' ? 1 : -1;
    let best = null;
    for (const y of [0.06, 0.08, 0.04, 0.1]) { const s = this.c.lower.get(Math.round(y / SLICE)); if (s) { best = { s, y }; break; } }
    if (!best) return null;
    const { s, y } = best;
    return new THREE.Vector3(s.cx + sg * (s.rx + out), y, s.cz - s.rz * 0.15).applyMatrix4(hips.matrixWorld);
  }
}
