// Jena checks her own pose against the move she's copying, and fixes it.
// While a learned move plays, a few times a second she reads HER OWN body straight off her VRM bones (exact and cheap,
// no camera needed), measures it the same way the video was measured (arm raise, elbow / knee / hip angles,
// wrist-to-head and wrist-to-hip distances over shoulder width, torso lean, head tilt, symmetry), compares it with
// the performer's numbers at that moment of the clip, and scores each body part. Then she says what she sees in plain
// words ("nailed it, 92%", "close: left arm 15° too low", "not it: wrists should be above my head"). A part that's
// off past its threshold gets corrected toward the target (that bone is turned a little more each try, up to 3 tries),
// and she checks again. Left/right are always HER own.
import * as THREE from 'three';

const DEG = 180 / Math.PI;
const PARTS = {
  'left arm': [['leftShoulder', 20], ['leftElbow', 28], ['leftHandUp', 0.25]],
  'right arm': [['rightShoulder', 20], ['rightElbow', 28], ['rightHandUp', 0.25]],
  torso: [['torsoLean', 12], ['torsoLeanSide', 10]],
  head: [['headTilt', 12]],
};
const LEGS = ['leftHip', 'rightHip', 'leftKnee', 'rightKnee']; // measured and reported, not scored: her feet stay planted by her own leg IK
const MAX_TRIES = 4;
const _v = Array.from({ length: 12 }, () => new THREE.Vector3());
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const angv = (a, b) => a.angleTo(b) * DEG;
const ang3 = (a, b, c, t1, t2) => angv(t1.subVectors(a, b), t2.subVectors(c, b));

export class SelfCheck {
  constructor(moves, { log = () => {}, every = 0.6 } = {}) {
    this.moves = moves; this.log = log; this.every = every;
    this.t = 0; this.history = []; this.last = null; this.clipId = null; this.tries = 0;
    this.gain = {}; // body part -> correction strength 0..1, grows on each failed try
    this.offtest = typeof location !== 'undefined' && new URLSearchParams(location.search).get('selfcheck') === 'offtest';
    (moves.avatar.poseHooks ||= []).push((vrm, dt) => this.hook(vrm, dt));
    if (typeof window !== 'undefined') window.jenaSelfCheck = this;
  }

  // her own numbers, read off the live bones
  measure(vrm) {
    const H = vrm.humanoid, P = (n, v) => { const b = H.getNormalizedBoneNode(n); return b ? b.getWorldPosition(v) : null; };
    H.normalizedHumanBonesRoot.updateMatrixWorld(true);
    const sh = { left: P('leftUpperArm', _v[0]), right: P('rightUpperArm', _v[1]) }, el = { left: P('leftLowerArm', _v[2]), right: P('rightLowerArm', _v[3]) };
    const wr = { left: P('leftHand', _v[4]), right: P('rightHand', _v[5]) };
    const hp = { left: P('leftUpperLeg', _v[6]), right: P('rightUpperLeg', _v[7]) }, kn = { left: P('leftLowerLeg', _v[8]), right: P('rightLowerLeg', _v[9]) };
    const an = { left: P('leftFoot', _v[10]), right: P('rightFoot', _v[11]) };
    if (!sh.left || !sh.right || !hp.left || !hp.right) return null;
    const msh = sh.left.clone().add(sh.right).multiplyScalar(0.5), mhp = hp.left.clone().add(hp.right).multiplyScalar(0.5);
    const up = msh.clone().sub(mhp), upn = up.clone().normalize(), down = upn.clone().negate();
    const sw = sh.left.distanceTo(sh.right) || 1e-6;
    const head = P('head', new THREE.Vector3()).addScaledVector(upn, 0.07); // ear level sits a little above her head bone
    const lat = sh.left.clone().sub(sh.right).normalize();
    const t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), m = {};
    for (const s of ['left', 'right']) {
      m[s + 'Shoulder'] = angv(t1.subVectors(el[s], sh[s]), down);
      m[s + 'Elbow'] = ang3(sh[s], el[s], wr[s], t1, t2);
      m[s + 'Hip'] = kn[s] ? angv(t1.subVectors(kn[s], hp[s]), down) : 0;
      m[s + 'Knee'] = kn[s] && an[s] ? ang3(hp[s], kn[s], an[s], t1, t2) : 180;
      m[s + 'WristHead'] = wr[s].distanceTo(head) / sw;
      m[s + 'WristHip'] = wr[s].distanceTo(hp[s]) / sw;
      m[s + 'WristUp'] = t1.subVectors(wr[s], head).dot(upn) / sw;
      // hand height above HER shoulder over HER arm length: free of body proportions (her head and shoulders are not the performer's)
      m[s + 'HandUp'] = t1.subVectors(wr[s], sh[s]).dot(upn) / ((el[s].distanceTo(sh[s]) + wr[s].distanceTo(el[s])) || 1e-6);
    }
    m.torsoLean = angv(up, t1.set(0, 1, 0));
    m.torsoLeanSide = Math.asin(Math.max(-1, Math.min(1, upn.dot(t1.set(1, 0, 0))))) * DEG; // her rig faces the camera: +x = HER left
    const eL = P('leftEye', t1), eR = P('rightEye', t2);
    m.headTilt = eL && eR ? Math.atan2(t1.clone().sub(t2).dot(upn), t1.clone().sub(t2).dot(lat)) * DEG : 0;
    m.armSymmetry = 1 - Math.min(1, (Math.abs(m.leftShoulder - m.rightShoulder) + Math.abs(m.leftElbow - m.rightElbow)) / 120);
    m._vec = { down, sh, el, wr }; // for corrections (this frame only)
    return m;
  }

  // the performer's numbers at this moment of the clip
  target(p) {
    const M = p.c.metrics; if (!M) return null;
    const f = Math.max(0, Math.min((p.c.srcFrames || 1) - 1, Math.round((p.start + p.t) * (p.c.srcFps || 15))));
    const o = {}; M.names.forEach((n, j) => { o[n] = M.data[j][f] / M.scale[j]; }); return o;
  }

  score(mine, tgt) {
    const parts = {}; let worst = null, sum = 0, n = 0;
    for (const [part, list] of Object.entries(PARTS)) {
      let s = 0;
      let cnt = 0;
      for (const [k, tol] of list) {
        if (!Number.isFinite(tgt[k]) || !Number.isFinite(mine[k])) continue;   // an older clip without this measurement
        cnt++;
        const err = tgt[k] - mine[k], e = Math.abs(err) / tol;
        s += Math.exp(-0.5 * e * e);
        if (!worst || e > worst.e) worst = { part, k, err, e };
      }
      parts[part] = Math.round((s / Math.max(1, cnt)) * 100);
      sum += parts[part]; n++;
    }
    return { parts, overall: Math.round(sum / n), worst };
  }

  words(sc, mine, tgt) {
    const w = sc.worst; if (!w) return 'no target to check against';
    const side = w.k.startsWith('left') ? 'left' : w.k.startsWith('right') ? 'right' : '';
    const d = Math.abs(Math.round(w.err));
    let what;
    if (/Shoulder$/.test(w.k)) what = `${side} arm ${d}° too ${w.err > 0 ? 'low' : 'high'}`;
    else if (/Elbow$/.test(w.k)) what = `${side} elbow ${d}° too ${w.err > 0 ? 'bent' : 'straight'}`;
    else if (/HandUp$/.test(w.k)) what = tgt[w.k] > 0.75 && mine[w.k] < 0.5 ? `${side} hand should be up above my head` : `${side} hand ${Math.abs(Math.round(w.err * 90))}° too ${w.err > 0 ? 'low' : 'high'}`;
    else if (/WristUp$/.test(w.k)) what = tgt[w.k] > 0 && mine[w.k] < 0 ? (tgt.leftWristUp > 0 && tgt.rightWristUp > 0 ? 'wrists should be above my head' : `${side} wrist should be above my head`) : `${side} hand too ${w.err > 0 ? 'low' : 'high'}`;
    else if (w.k === 'torsoLean') what = `${w.err > 0 ? 'lean more' : 'stand up straighter'} (${d}°)`;
    else if (w.k === 'torsoLeanSide') what = `lean ${d}° more to my ${w.err > 0 ? 'left' : 'right'}`;
    else if (w.k === 'headTilt') what = `tilt my head ${d}° more to my ${w.err > 0 ? 'left' : 'right'}`;
    else what = w.k;
    if (sc.overall >= 85) return `nailed it, ${sc.overall}%`;
    if (sc.overall >= 60) return `close (${sc.overall}%): ${what}`;
    return `not it (${sc.overall}%): ${what}`;
  }

  // every frame while a move plays: corrections for the parts that were off, then a check every ~0.6 s
  hook(vrm, dt) {
    const p = this.moves.playing;
    if (!p || !p.c.metrics || !(p.w > 0.5)) { if (!p && this.clipId) this.finish(); return; }
    if (this.clipId !== p.c.id) { this.finish(); this.clipId = p.c.id; this.tries = 0; this.gain = {}; this.first = null; this.passed = null; }
    const H = vrm.humanoid;
    if (this.offtest) { // induced off pose for testing (?selfcheck=offtest): a steady pull of her left arm ~45° down toward her side, which the correction has to beat
      const up = H.getNormalizedBoneNode('leftUpperArm'); if (up) up.rotateZ(-0.8);
    }
    const tgt = this.target(p);
    if (tgt && Object.values(this.gain).some((g) => g > 0)) {
      const m = this.measure(vrm);
      if (m) for (const side of ['left', 'right']) {
        const g = this.gain[side + ' arm'] || 0; if (!g) continue;
        const A = this.moves.avatar; if (A.wave?.side === side || A.handOnHip?.side === side) continue; // her own gesture wins
        const up = H.getNormalizedBoneNode(side + 'UpperArm'), lo = H.getNormalizedBoneNode(side + 'LowerArm');
        const V = m._vec;
        // arm raise: turn the upper arm in the plane of (down, arm) by the missing angle
        const arm = _v[0].subVectors(V.el[side], V.sh[side]).normalize();
        const axisW = _v[1].crossVectors(V.down, arm).normalize();
        const errS = (tgt[side + 'Shoulder'] - m[side + 'Shoulder']) / DEG;
        if (up && axisW.lengthSq() > 0.5) this.turn(up, axisW, errS * g);
        // elbow: open/close the forearm around the elbow's bend axis
        const fore = _v[2].subVectors(V.wr[side], V.el[side]).normalize();
        const bend = _v[3].crossVectors(arm, fore);
        const errE = (tgt[side + 'Elbow'] - m[side + 'Elbow']) / DEG;
        if (lo && bend.lengthSq() > 1e-4) this.turn(lo, bend.normalize(), -errE * g);
      }
      if (this.gain.torso) { const sp = H.getNormalizedBoneNode('spine'); const m2 = m; if (sp && m2) sp.rotateZ(-((tgt.torsoLeanSide - m2.torsoLeanSide) / DEG) * this.gain.torso * 0.5); }
      if (this.gain.head) { const hd = H.getNormalizedBoneNode('head'); if (hd && m) hd.rotateZ(((tgt.headTilt - m.headTilt) / DEG) * this.gain.head * 0.6); }
    }
    this.t += dt;
    if (this.t < this.every || !(p.w > 0.9)) return;   // score only while the move is fully on (not while it fades in/out)
    this.t = 0;
    const mine = this.measure(vrm); if (!mine || !tgt) return;
    const sc = this.score(mine, tgt), say = this.words(sc, mine, tgt);
    const legs = Object.fromEntries(LEGS.map((k) => [k, { mine: Math.round(mine[k]), target: Math.round(tgt[k]) }]));
    const row = { at: Date.now(), clip: p.c.id, t: +(p.start + p.t).toFixed(2), try: this.tries, overall: sc.overall, parts: sc.parts, say, worst: sc.worst && { part: sc.worst.part, metric: sc.worst.k, err: +sc.worst.err.toFixed(2) }, legs, corr: { ...this.gain } };
    this.history.push(row); if (this.history.length > 200) this.history.shift();
    this.last = row; this.first ||= row;
    if (sc.overall < 85 && this.tries < MAX_TRIES) {
      // fix what's off: each part under 70% gets a stronger pull toward the target, then she checks again
      const fix = Object.entries(sc.parts).filter(([, v]) => v < 70).map(([k]) => k);
      for (const k of fix) this.gain[k] = Math.min(1, (this.gain[k] || 0) + 0.5);
      if (fix.length) { this.tries++; this.passed = null; this.log(`self-check: ${say} → correcting my ${fix.join(' + ')} (try ${this.tries}/${MAX_TRIES})`); }
    } else if (this.tries > 0 && !this.passed && sc.overall >= 85) {
      this.passed = row;   // report the pass once per move
      this.log(`self-check: ${say} after ${this.tries} correction${this.tries > 1 ? 's' : ''} (was ${this.first.overall}%)`);
    }
  }

  turn(node, axisWorld, angle) {
    if (!node.parent || !Number.isFinite(angle) || Math.abs(angle) < 1e-4) return;
    node.parent.getWorldQuaternion(_q).invert();
    const ax = axisWorld.clone().applyQuaternion(_q).normalize();
    node.quaternion.premultiply(_q2.setFromAxisAngle(ax, Math.max(-0.8, Math.min(0.8, angle))));
  }

  finish() {
    if (!this.clipId || !this.last) { this.clipId = null; return; }
    const f = this.first, l = this.last;
    this.summary = { clip: this.clipId, first: f && { overall: f.overall, say: f.say }, final: { overall: l.overall, say: l.say, parts: l.parts }, tries: Math.min(this.tries, MAX_TRIES), at: Date.now() };
    if (f && f !== l) this.log(`self-check done: ${l.say}${this.summary.tries ? ` (started at ${f.overall}%, ${this.summary.tries} correction${this.summary.tries > 1 ? 's' : ''})` : ''}`);
    this.clipId = null;
  }

  brief() {
    const l = this.last, s = this.summary;
    return l ? { now: Date.now() - l.at < 3000 ? { clip: l.clip, overall: l.overall, parts: l.parts, say: l.say } : null, lastMove: s || { clip: l.clip, final: { overall: l.overall, say: l.say, parts: l.parts } } } : null;
  }
}

// a small, plain picture of her body right now, sent along with chat so "what's your left hand doing?" and
// "how close was my pose?" are answered from her real body (not guessed)
export function bodyBrief(selfSense, moves) {
  try {
    const S = selfSense?.snapshot?.(); if (!S) return null;
    const B = S.bones || {}, curl = (s) => {
      const k = ['Index', 'Middle', 'Ring', 'Little'].map((f) => Math.abs(B[`${s}${f}Proximal`]?.rot?.z || 0) + Math.abs(B[`${s}${f}Intermediate`]?.rot?.z || 0));
      return Math.round(k.reduce((a, b) => a + b, 0) / 4); // degrees of bend per finger (knuckle + middle joint)
    };
    const pos = (n) => B[n]?.pos; const lh = pos('leftHand'), rh = pos('rightHand'), hd = pos('head');
    const p = moves?.playing;
    return {
      feel: S.feel, head: S.head,
      fingers: { left: curl('left'), right: curl('right') },
      hands: { left: lh && hd ? { aboveHead: lh.y > hd.y + 0.05, x: lh.x, y: lh.y, z: lh.z } : null, right: rh && hd ? { aboveHead: rh.y > hd.y + 0.05, x: rh.x, y: rh.y, z: rh.z } : null },
      face: Object.fromEntries(Object.entries(S.expressions || {}).filter(([, v]) => v > 0.15)),
      move: p ? { id: p.c.id, what: p.c.what || p.c.label, fingers: !!p.c.fingers, face: !!p.c.face, t: +(p.start + p.t).toFixed(1) } : null,
      selfCheck: moves?.selfCheck?.brief?.() || null,
    };
  } catch { return null; }
}
