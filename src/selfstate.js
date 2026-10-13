const THREE_DEG = 180 / Math.PI;
import { Matrix4, Vector3, Quaternion } from 'three';
// Jena's self-sense (proprioception): every frame she reads her REAL body off the live VRM — every
// humanoid bone the model has (hips, spine, chest, neck, head, eyes, jaw, shoulders, arms, hands, all
// finger joints, legs, feet, toes) and every expression / blend shape (VRM presets like blink, aa/ih/ou/ee/oh,
// happy/angry/sad/relaxed/surprised, lookUp/Down/Left/Right, plus any custom ones on the model) and where
// her eyes point (lookAt yaw/pitch). That lives in window.jena.selfState. She turns the numbers into what
// she feels ("my head's tilted left", "I'm smiling") and says notable changes in the thought chain.
// Left/right are always HER sides: she faces the camera, so her left is the right of the screen.
const DEG = 180 / Math.PI;
const r1 = (v) => Math.round(v * 10) / 10;
const MOODS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];
const MOUTH = ['aa', 'ih', 'ou', 'ee', 'oh'];
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'];
const _inv = new Matrix4(), _p = new Vector3(), _q = new Quaternion(), _rq = new Quaternion(), _f = new Vector3(), _u = new Vector3();
const ang = (a, b, c) => { // angle at b between a and c, degrees
  const ux = a.x - b.x, uy = a.y - b.y, uz = a.z - b.z, vx = c.x - b.x, vy = c.y - b.y, vz = c.z - b.z;
  const d = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / d))) * DEG;
};

// hysteresis: a state switches on past `on` and only switches back once under `off`
function hyst(prev, v, on, off, pos, neg, none = 'none') {
  if (prev === pos) return v > off ? pos : v < -on ? neg : none;
  if (prev === neg) return v < -off ? neg : v > on ? pos : none;
  return v > on ? pos : v < -on ? neg : none;
}

const SAY = {
  leftArm: {}, rightArm: {},
  headTurn: { left: "my head's turned to my left", right: "my head's turned to my right", none: "I'm facing front again" },
  headTilt: { left: "my head's tilted left", right: "my head's tilted right", none: "my head's straight again" },
  headPitch: { down: "I'm looking down", up: "my chin's up", none: 'head level again' },
  lean: { left: "my weight's on my left leg", right: "my weight's on my right leg", none: "I'm standing even again" },
  face: {
    happy: "I'm smiling", angry: "I'm making my grumpy face", sad: "I'm pouting", relaxed: 'my face is all chill',
    surprised: "my eyebrows shot up, I'm surprised", neutral: 'my face is back to neutral',
  },
  eyes: { left: 'my eyes are on my left', right: 'my eyes are on my right', none: 'eyes back to the front' },
};
const handSay = (side, v) => v === 'fist' ? `my ${side} hand's in a fist` : v === 'open' ? `my ${side} hand's wide open` : `my ${side} hand's relaxed again`;
const footSay = (side, v) => v === 'tapping' ? `I'm tapping my ${side} foot` : `my ${side} foot's still`;

export class SelfSense {
  constructor(avatar, { log, readout, faceReadout, hz = 5 } = {}) {
    this.avatar = avatar;
    this.log = log || (() => {});
    this.readout = readout; // element for the compact live body readout
    this.faceReadout = faceReadout; // element for the live face values
    this.state = { t: 0, frame: 0, model: null, bones: {}, expressions: {}, lookAt: { yaw: 0, pitch: 0 }, head: { yaw: 0, pitch: 0, roll: 0 }, feel: {}, counts: { bones: 0, expressions: 0 } };
    this.smooth = {}; // readout values, eased so the numbers don't jitter
    this.feel = { headTurn: 'none', headTilt: 'none', headPitch: 'none', lean: 'none', face: 'neutral', eyes: 'none', leftHand: 'relaxed', rightHand: 'relaxed', leftFoot: 'still', rightFoot: 'still', leftArm: 'down', rightArm: 'down', eyesClosed: false, talking: false };
    this.pending = {}; // key -> {value, since}
    this.queue = [];
    this.lastSaid = 0;
    this.footSeen = { left: 0, right: 0 };
    this.toeRest = null; // toe height when she's standing still, learned after load
    this.perKey = {}; // when each body part was last talked about
    this.boneNames = null;
    avatar.frameHooks.push((vrm) => this.sample(vrm));
    this.timer = setInterval(() => this.think(), 1000 / hz);
  }

  // every frame: copy the real values off the live model (cheap: ~55 bones + the model's expressions)
  sample(vrm) {
    const S = this.state;
    if (S.model !== vrm) this.bind(vrm);
    const H = vrm.humanoid;
    // her body frame: the rig root, which faces the camera, so +x = HER left, +y = up, +z = forward
    const root = H.normalizedHumanBonesRoot;
    _inv.copy(root.matrixWorld).invert();
    root.getWorldQuaternion(_rq).invert();
    for (const name of this.boneNames) {
      const n = H.getNormalizedBoneNode(name);
      const b = S.bones[name];
      if (!n || !b) continue;
      b.x = n.rotation.x; b.y = n.rotation.y; b.z = n.rotation.z; // local, normalized (T-pose = 0)
      _p.setFromMatrixPosition(n.matrixWorld).applyMatrix4(_inv);
      b.px = _p.x; b.py = _p.y; b.pz = _p.z; // where the joint really is (meters, in her body frame)
    }
    // where her head really points (all of spine + neck + head together), in her body frame
    const head = H.getNormalizedBoneNode('head');
    if (head) {
      head.getWorldQuaternion(_q).premultiply(_rq);
      _f.set(0, 0, 1).applyQuaternion(_q); _u.set(0, 1, 0).applyQuaternion(_q);
      S.head.yaw = Math.atan2(_f.x, _f.z) * DEG; // + = turned to HER left
      S.head.pitch = -Math.asin(Math.max(-1, Math.min(1, _f.y))) * DEG; // + = looking down
      S.head.roll = Math.atan2(_u.x, _u.y) * DEG; // + = top of her head toward HER left
    }
    const em = vrm.expressionManager;
    if (em) for (const e of em.expressions) S.expressions[e.expressionName] = e.outputWeight;
    if (vrm.lookAt) { S.lookAt.yaw = vrm.lookAt.yaw; S.lookAt.pitch = vrm.lookAt.pitch; } // degrees; +yaw = her left, +pitch = down
    S.t = performance.now();
    S.frame++;
  }

  bind(vrm) {
    const S = this.state;
    S.model = vrm;
    this.boneNames = Object.keys(vrm.humanoid.humanBones).filter((n) => vrm.humanoid.getNormalizedBoneNode(n));
    S.bones = Object.fromEntries(this.boneNames.map((n) => [n, { x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0 }]));
    S.expressions = {};
    for (const e of vrm.expressionManager?.expressions || []) S.expressions[e.expressionName] = 0;
    S.presets = Object.keys(vrm.expressionManager?.presetExpressionMap || {});
    S.custom = Object.keys(vrm.expressionManager?.customExpressionMap || {});
    S.counts = { bones: this.boneNames.length, expressions: Object.keys(S.expressions).length };
    S.feel = this.feel;
    setTimeout(() => { this.toeRest = {}; }, 1500); // first quiet second: learn where her toes rest
  }

  // a few times a second: what do those numbers feel like, from HER side?
  think() {
    const S = this.state;
    if (!S.model) return;
    const B = (n) => S.bones[n] || { x: 0, y: 0, z: 0 };
    const E = (n) => S.expressions[n] || 0;
    const F = this.feel, now = performance.now();
    const hd = S.head;
    const next = {};
    // head, from where it really points (world-space), with hysteresis so idle drift isn't news
    next.headTurn = hyst(F.headTurn, hd.yaw, 13, 8, 'left', 'right');
    next.headTilt = hyst(F.headTilt, hd.roll, 9.5, 6, 'left', 'right');
    next.headPitch = hyst(F.headPitch, hd.pitch, 9, 5, 'down', 'up');
    // weight: where her hips sit over her feet (+x = her left)
    const hips = B('hips'), lf = B('leftFoot'), rf = B('rightFoot');
    next.lean = hyst(F.lean, hips.px - (lf.px + rf.px) / 2, 0.022, 0.014, 'left', 'right');
    // arms: is the hand really above the shoulder?
    for (const s of ['left', 'right']) {
      const sh = B(s + 'UpperArm'), hand = B(s + 'Hand');
      const prev = F[s + 'Arm'];
      const sg = s === 'left' ? 1 : -1;
      const hipD = Math.hypot(hand.px - (hips.px + sg * 0.15), hand.py - (hips.py + 0.06), hand.pz - hips.pz);
      next[s + 'Arm'] = hand.py > sh.py + (prev === 'up' ? 0.0 : 0.05) ? 'up' : hipD < (prev === 'hip' ? 0.14 : 0.1) ? 'hip' : 'down';
    }
    for (const s of ['left', 'right']) {
      let c = 0, k = 0;
      for (const f of FINGERS) for (const j of ['Proximal', 'Intermediate']) { const b = S.bones[`${s}${f}${j}`]; if (b) { c += Math.abs(b.z); k++; } }
      const curl = k ? c / k / 1.3 : 0.3; // ~0 open … ~1 fist
      const prev = F[s + 'Hand'];
      next[s + 'Hand'] = k === 0 ? 'relaxed' : curl > (prev === 'fist' ? 0.6 : 0.75) ? 'fist' : curl < (prev === 'open' ? 0.18 : 0.1) ? 'open' : 'relaxed';
      // a foot tap lifts her toes (or the front of the foot) off the floor
      const toe = S.bones[s + 'Toes'];
      const lifted = toe ? toe.py - (this.toeRest?.[s] ?? toe.py) > 0.012 : Math.abs(B(s + 'Foot').x) > 0.15;
      if (toe && this.toeRest && this.toeRest[s] === undefined) this.toeRest[s] = toe.py;
      if (lifted) this.footSeen[s] = now;
      next[s + 'Foot'] = now - this.footSeen[s] < 1200 ? 'tapping' : 'still';
    }
    // face: the strongest mood expression, if it's really showing
    let mood = 'neutral', best = 0;
    for (const m of MOODS) if (E(m) > best) { best = E(m); mood = m; }
    const prevFace = F.face;
    next.face = best > (prevFace === mood ? 0.22 : 0.38) ? mood : 'neutral';
    next.eyesClosed = Math.max(E('blink'), (E('blinkLeft') + E('blinkRight')) / 2) > 0.6;
    if (Math.max(...MOUTH.map(E)) > 0.12) this.mouthSeen = now;
    next.talking = now - (this.mouthSeen || -1e9) < 700;
    // eyes on their own (only worth saying when the head isn't already turned that way)
    next.eyes = hyst(F.eyes, S.lookAt.yaw, 14, 8, 'left', 'right');

    for (const [k, v] of Object.entries(next)) {
      if (v === F[k]) { delete this.pending[k]; continue; }
      const p = this.pending[k];
      if (!p || p.value !== v) { this.pending[k] = { value: v, since: now }; continue; }
      if (now - p.since < 450) continue; // must hold a moment before she believes it
      const was = F[k];
      F[k] = v;
      delete this.pending[k];
      this.notice(k, v, was);
    }
    this.speak(now);
    this.render();
  }

  notice(k, v, was) {
    let text = null;
    if (SAY[k]) text = SAY[k][v];
    else if (k.endsWith('Hand')) text = handSay(k.slice(0, -4), v);
    else if (k.endsWith('Foot')) text = footSay(k.slice(0, -4), v);
    if (k === 'eyes' && v !== 'none' && this.feel.headTurn === v) text = null;
    if (k === 'eyes' && v === 'none' && was !== 'none' && this.feel.headTurn !== 'none') text = null;
    if (k.endsWith('Foot') && v === 'still') text = null; // stopping isn't news
    if (!text) return;
    // the same body part going back and forth isn't news every time: once per ~20 s each
    const quiet = k === 'lean' ? 45000 : 20000; // weight shifts are constant; only mention them now and then
    if (performance.now() - (this.perKey[k] || -1e9) < quiet && (k === 'lean' || v === 'none' || v === 'neutral' || v === 'relaxed')) return;
    if (k === 'leftArm' || k === 'rightArm') { if (v === 'hip') text = `my ${k.slice(0, -3)} hand's on my hip`; else return; }
    this.queue = this.queue.filter((q) => q.k !== k); // only the latest per body part
    this.queue.push({ k, text });
  }

  // say what changed, at most one thought every ~2.5 s (two changes can share a line)
  speak(now) {
    if (!this.queue.length || now - this.lastSaid < 3500 || document.hidden) return;
    const a = this.queue.shift(), b = this.queue.shift();
    this.lastSaid = now;
    this.perKey[a.k] = now; if (b) this.perKey[b.k] = now;
    this.log(b ? `${a.text}, and ${b.text}` : a.text);
    if (this.queue.length > 4) this.queue = this.queue.slice(-4);
  }

  render() {
    const el = this.readout, S = this.state, F = this.feel;
    if (!el) return;
    const sm = (k, v) => (this.smooth[k] = this.smooth[k] === undefined ? v : this.smooth[k] + (v - this.smooth[k]) * 0.45);
    const lr = (v) => (Math.round(v) === 0 ? '0°' : (v > 0 ? 'L' : 'R') + Math.abs(Math.round(v)) + '°');
    const ud = (v) => (Math.round(v) === 0 ? '0°' : (v > 0 ? 'dn' : 'up') + Math.abs(Math.round(v)) + '°');
    const B = (n) => S.bones[n];
    const knee = (s) => (B(s + 'UpperLeg') && B(s + 'Foot') ? 180 - ang(B(s + 'UpperLeg') && { x: B(s + 'UpperLeg').px, y: B(s + 'UpperLeg').py, z: B(s + 'UpperLeg').pz }, { x: B(s + 'LowerLeg').px, y: B(s + 'LowerLeg').py, z: B(s + 'LowerLeg').pz }, { x: B(s + 'Foot').px, y: B(s + 'Foot').py, z: B(s + 'Foot').pz }) : 0);
    const elbow = (s) => (B(s + 'UpperArm') && B(s + 'Hand') ? 180 - ang({ x: B(s + 'UpperArm').px, y: B(s + 'UpperArm').py, z: B(s + 'UpperArm').pz }, { x: B(s + 'LowerArm').px, y: B(s + 'LowerArm').py, z: B(s + 'LowerArm').pz }, { x: B(s + 'Hand').px, y: B(s + 'Hand').py, z: B(s + 'Hand').pz }) : 0);
    const hand = (v) => (v === 'fist' ? 'fist' : v === 'open' ? 'open' : 'soft');
    const arm = (v) => (v === 'hip' ? 'on hip' : v);
    const lines = [
      `head ${lr(sm('hy', S.head.yaw))} ${ud(sm('hp', S.head.pitch))}`,
      `tilt ${lr(sm('hr', S.head.roll))}`,
      `arm L ${arm(F.leftArm)}`, `arm R ${arm(F.rightArm)}`,
      `elbow L${Math.round(sm('el', elbow('left')))} R${Math.round(sm('er', elbow('right')))}`,
      `hand L ${hand(F.leftHand)} R ${hand(F.rightHand)}`,
      `weight ${F.lean === 'none' ? 'even' : F.lean === 'left' ? 'L' : 'R'}${F.leftFoot === 'tapping' ? ' · tap L' : F.rightFoot === 'tapping' ? ' · tap R' : ''}`,
      `knee L${Math.round(sm('kl', knee('left')))} R${Math.round(sm('kr', knee('right')))}`,
      ...(() => { const b = this.avatar.balance?.(); return b ? [`balance ${b.ok ? 'ok' : 'OFF'} · over ${b.over === 'left' ? 'L' : 'R'} foot (${b.marginCm}cm)`, `facing ${b.facing >= 0 ? '+' : ''}${b.facing}° (0 = you)`] : []; })(),
      ...(this.avatar.collision ? [`arms clear of body ${this.avatar.collision.stats.minClearCm ?? '?'}cm · pushes ${this.avatar.collision.stats.corrections}`] : []),
      `looking at ${this.avatar.gazeNow || 'you'}`,
      `${S.counts.bones} bones`,
    ];
    const E = (n) => Math.round((S.expressions[n] || 0) * 100);
    const moods = MOODS.filter((m) => E(m) > 8).sort((a, b) => E(b) - E(a)).map((m) => `${m} ${E(m)}`).join(' ') || 'neutral';
    const extra = (S.custom || []).filter((n) => E(n) > 8).map((n) => `${n} ${E(n)}`).join(' ');
    const Hm = this.avatar.vrm?.humanoid, exprs = new Set(this.avatar.expressions?.() || []);
    const jaw = Hm?.getNormalizedBoneNode('jaw');
    const has = (re) => [...exprs].find((n) => re.test(n));
    const cheek = has(/cheek/i), tongue = has(/tongue/i);
    const face = [
      `head tilt ${lr(sm('hr', S.head.roll))} turn ${lr(sm('hy', S.head.yaw))} nod ${ud(sm('hp', S.head.pitch))}`,
      jaw ? `jaw ${Math.round(THREE_DEG * jaw.rotation.x)}°` : `jaw (mouth) aa${E('aa')} · no jaw bone on this body`,
      cheek ? `cheek ${E(cheek)}` : 'cheek: no cheek shape on this body',
      tongue ? `tongue ${E(tongue)}` : 'tongue: no tongue shape on this body',
      `gaze ${lr(sm('ey', S.lookAt.yaw))} ${ud(sm('ep', S.lookAt.pitch))}`,
      `blink L${E('blinkLeft') || E('blink')} R${E('blinkRight') || E('blink')}${F.eyesClosed ? ' shut' : ''}`,
      `aa${E('aa')} ih${E('ih')} ou${E('ou')}`,
      `ee${E('ee')} oh${E('oh')}`,
      `${moods}${F.talking ? ' · talking' : ''}`,
      ...(extra ? [extra] : []),
      `${S.counts.expressions} expressions`,
    ];
    const ft = face.join('\n');
    if (this.faceReadout && ft !== this._lastFace) { this.faceReadout.textContent = ft; this._lastFace = ft; }
    const txt = lines.join('\n');
    if (txt !== this._last) { el.textContent = txt; this._last = txt; }
  }

  // a plain, rounded copy (degrees) for anyone who wants to read her body from the console
  snapshot() {
    const S = this.state;
    return {
      t: Math.round(S.t), frame: S.frame,
      // rot: local rotation in the normalized rig (degrees, T-pose = 0); pos: where the joint is, meters in
      // her body frame (+x = HER left, +y up, +z toward the camera)
      bones: Object.fromEntries(Object.entries(S.bones).map(([n, b]) => [n, { rot: { x: r1(b.x * DEG), y: r1(b.y * DEG), z: r1(b.z * DEG) }, pos: { x: Math.round(b.px * 1000) / 1000, y: Math.round(b.py * 1000) / 1000, z: Math.round(b.pz * 1000) / 1000 } }])),
      head: { yaw: r1(S.head.yaw), pitch: r1(S.head.pitch), roll: r1(S.head.roll) },
      expressions: Object.fromEntries(Object.entries(S.expressions).map(([n, w]) => [n, Math.round(w * 100) / 100])),
      lookAt: { yaw: r1(S.lookAt.yaw), pitch: r1(S.lookAt.pitch) },
      feel: { ...this.feel },
      presets: S.presets, custom: S.custom, counts: S.counts,
    };
  }
}
