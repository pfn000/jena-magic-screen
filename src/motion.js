// Jena's motion layer: idle sway, talk gestures, big human reactions, direct-to-camera gestures (eye contact
// locked), a smug face for brag moments, audio beats, and motion styles (bouncy / smooth / snappy anime / chibi).
// The moves live in ANIMATIONS/moveset.json (patterns learned from 3D VTuber clips + real people, see
// ANIMATIONS/README.md); this file plays them on top of her idle body through avatar.js's hooks:
//   poseHooks: head / neck / spine / hips offsets  ·  handHooks: two-bone arm IK + finger shapes  ·  faceHooks: faces
// Public: window.jena.react(type, intensity) · window.jena.onReaction(cb) · window.jena.motion (state, play, setStyle)
// She is a kid: nothing here is ever flirty (no winks, kisses, blush, body emphasis).
import * as THREE from 'three';
import MOVESET from '../ANIMATIONS/moveset.json';
import STYLES from '../ANIMATIONS/styles.json';
import { NoRepeat, Wander } from './nonrepeat.js';
import { KIND_COOLDOWN } from './motion-cooldowns.mjs';
export { KIND_COOLDOWN };

const MOVES = MOVESET.moves;
// (no bare random picks here: every choice goes through NoRepeat, see src/nonrepeat.js; Saidie: no loops)
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const _v = Array.from({ length: 12 }, () => new THREE.Vector3());
const _q = Array.from({ length: 6 }, () => new THREE.Quaternion());

// style knobs: tempo (speed), overshoot (past-the-target then settle), amp (size), attack (how front-loaded)
export const STYLE_KNOBS = {
  smooth: { tempo: 0.85, overshoot: 0.0, amp: 0.9, attack: 0.0 },
  bouncy: { tempo: 1.1, overshoot: 0.22, amp: 1.1, attack: 0.3 },
  snappy: { tempo: 1.3, overshoot: 0.1, amp: 1.05, attack: 1.0 },
  chibi: { tempo: 1.2, overshoot: 0.3, amp: 1.3, attack: 0.5 },
};
// same rule as moves-pipeline/motion_stats.py classify(): from mean speed, acceleration and overshoot
export function classifyStyle({ speed = 0, accel = 0, overshoot = 0, amp = 0 }) {
  const s = {
    smooth: Math.max(0, 1 - speed / 2.2) * Math.max(0, 1 - overshoot * 3),
    bouncy: clamp(overshoot * 3, 0, 1) * clamp(speed / 1.6, 0, 1),
    snappy: clamp(accel / 40, 0, 1) * Math.max(0, 1 - overshoot * 2),
    chibi: clamp(amp / 0.9, 0, 1) * clamp(overshoot * 2.5, 0, 1) * clamp(speed / 2, 0, 1),
  };
  const sum = Object.values(s).reduce((a, b) => a + b, 0) || 1;
  for (const k in s) s[k] = +(s[k] / sum).toFixed(3);
  return s;
}

const easeBack = (u, s) => { const c = 1.70158 * s; const x = u - 1; return 1 + (c + 1) * x * x * x + c * x * x; };
function ease(u, k) {
  const smooth = u * u * (3 - 2 * u);
  const fast = 1 - (1 - u) ** 3;
  const base = smooth + (fast - smooth) * clamp(k.attack, 0, 1);
  return k.overshoot > 0.01 ? base + (easeBack(u, k.overshoot * 4) - u) * 0.5 : base;
}
// value of a keyframe track [[t, ...vals]] at u (0..1), eased per segment with the style knobs
function track(keys, u, k, n) {
  if (!keys || !keys.length) return null;
  if (u <= keys[0][0]) return keys[0].slice(1, 1 + n);
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (u <= b[0]) { const e = ease((u - a[0]) / Math.max(1e-6, b[0] - a[0]), k); return a.slice(1, 1 + n).map((x, j) => x + (b[1 + j] - x) * e); }
  }
  return keys[keys.length - 1].slice(1, 1 + n);
}

// where each arm pose puts her wrist (scene frame: +x HER left, +y up, +z toward the camera) and how the fingers sit
// fingers: [thumb, index, middle, ring, little] curl 0 open … 1 closed (a little negative = straight back)
const F = { open: [0.05, -0.05, 0, 0.05, 0.1], soft: [0.35, 0.3, 0.4, 0.45, 0.5], point: [0.75, -0.05, 1, 1, 1], gun: [0, -0.05, 1, 1, 1], fist: [0.9, 1, 1, 1, 1], cup: [0.25, 0.1, 0.12, 0.18, 0.25], chin: [0.5, 0.45, 0.9, 1, 1] };
const POSES = {
  point_viewer: { at: 'camera', reach: 0.93, drop: -0.04, fingers: F.point, pole: [0.8, -1, -0.3], wrist: 'straight' },
  gun: { at: 'camera', reach: 0.78, drop: -0.12, fingers: F.gun, pole: [1, -1, -0.2], wrist: 'straight' },
  open_palm: { from: 'chest', off: [0.22, -0.1, 0.28], fingers: F.open, pole: [1, -1, -0.5] },
  beat: { from: 'chest', off: [0.18, -0.12, 0.27], beat: 0.035, fingers: F.soft, pole: [1, -1, -0.5] },
  shrug: { from: 'chest', off: [0.33, -0.12, 0.17], fingers: F.open, pole: [1, -1, 0] },
  chest_tap: { from: 'chest', off: [0.06, 0.0, 0.17], fingers: F.cup, pole: [1, -1, 0] },
  guard: { from: 'chest', off: [0.17, 0.12, 0.26], fingers: F.open, pole: [1, -1, -0.2] },
  cheek: { from: 'head', off: [0.1, -0.06, 0.07], fingers: F.cup, pole: [0.6, -1, 0.1] },
  mouth: { from: 'head', off: [0.03, -0.1, 0.12], fingers: F.cup, pole: [0.8, -1, 0] },
  facepalm: { from: 'head', off: [0.02, 0.0, 0.14], fingers: F.cup, pole: [0.8, -1, 0] },
  chin: { from: 'head', off: [0.02, -0.12, 0.11], fingers: F.chin, pole: [0.7, -1, 0.3] },
  fist_pump: { from: 'shoulder', off: [0.08, 0.3, 0.12], fingers: F.fist, pole: [1, -0.5, -0.2] },
  wave: { from: 'shoulder', off: [0.2, 0.32, 0.1], wave: 0.07, fingers: F.open, pole: [1, -1, 0] },
  hip: { from: 'hips', off: [0.19, 0.03, 0.0], fingers: F.soft, pole: [1, 0, -0.6] },
};

export class Motion {
  constructor(avatar, opts = {}) {
    this.avatar = avatar;
    this.moves = opts.moves || null;           // learned-move player (src/moves.js): body offsets ease off while it plays
    this.active = [];                          // { id, m, t0, dur, k, intensity, trigger }
    this.listeners = new Set();
    this.users = new Set();
    this.style = { ...(STYLES?.default_mix || { smooth: 0.35, bouncy: 0.25, snappy: 0.3, chibi: 0.1 }) };
    this.camAuto = true;                       // with no onReaction subscriber, big beats still ask the stream camera to punch in
    this.lastTalkT0 = 0; this.nextTalk = 0; this.nextIdle = performance.now() + 5000; this.lastReact = 0;
    this.log = [];
    this.smugW = 0;
    // her no-repeat memory: no move repeats until 3 others have played (fewer for tiny pools), nothing from the
    // last 30 s while anything else is free, per-move cooldowns (moveset `cooldown` s, else by kind)
    const cooldowns = {}; for (const [id, mv] of Object.entries(MOVES)) cooldowns[id] = mv.cooldown ? mv.cooldown * 1000 : (KIND_COOLDOWN[mv.kind] || 10000);
    this.nr = opts.noRepeat || new NoRepeat({ minGap: 3, windowMs: 30000, cooldowns });
    // procedural micro-motion on top of everything (never cycles): head drift, torso sway, weight shifts
    this.wander = { hx: new Wander(1, 1.3), hy: new Wander(1, 2.1), hz: new Wander(1, 1.7), sz: new Wander(1, 3.2), sx: new Wander(1, 2.6) };
    this.nextShift = performance.now() + 6000 + Math.random() * 10000;
    avatar.poseHooks.push((vrm, dt) => this.body(vrm, dt));
    (avatar.handHooks ||= []).push((vrm, dt) => this.arms(vrm, dt));
    (avatar.faceHooks ||= []).push((vrm, dt) => this.face(vrm, dt));
  }

  knobs(extra) {
    const k = { tempo: 0, overshoot: 0, amp: 0, attack: 0 };
    const mix = { ...this.style, ...(extra || {}) };
    const sum = Object.values(mix).reduce((a, b) => a + b, 0) || 1;
    for (const [name, w] of Object.entries(mix)) { const s = STYLE_KNOBS[name]; if (!s) continue; for (const key in k) k[key] += s[key] * w / sum; }
    return k;
  }
  setStyle(name, amount = 1) {
    if (typeof name === 'object') { this.style = { ...name }; return this.style; }
    if (!STYLE_KNOBS[name]) throw new Error('style must be one of ' + Object.keys(STYLE_KNOBS).join(', '));
    for (const s in STYLE_KNOBS) this.style[s] = (this.style[s] || 0) * (1 - amount) + (s === name ? amount : 0);
    return this.style;
  }
  // per-emotion lean toward a style (from ANIMATIONS/styles.json, learned from the clips)
  styleFor(m) { const by = STYLES?.by_emotion || {}; for (const e of m.emotions || []) if (by[e]) return by[e]; return null; }

  // choose from a pool without repeating (null = everything fresh is used up: skip rather than repeat)
  choose(ids, pool, opts = {}) { return this.nr.pick(ids.filter((id) => MOVES[id]), { pool, ...opts }); }
  play(id, { intensity, trigger = 'manual', emotion, picked = false, variant } = {}) {
    const m = MOVES[id];
    if (!m) throw new Error('unknown move ' + id + ' (have: ' + Object.keys(MOVES).join(', ') + ')');
    if (!picked) this.nr.note(id, 'manual');
    const now = performance.now();
    const k = this.knobs(this.styleFor(m));
    // a fresh variant every play: size, speed, mirrored L/R, onset jitter, time warp, head bias
    const v = variant || this.nr.variant({ mirror: m.mirror !== false });
    const amp = clamp((intensity ?? m.intensity ?? 0.6) / (m.intensity ?? 0.6), 0.5, 1.4) * k.amp * v.amp;
    const dur = (m.dur * 1000) / k.tempo / v.speed;
    // one move per body part family: a new reaction replaces what was playing on the same parts
    const parts = (mm) => new Set([...(mm.arms ? Object.keys(mm.arms) : []), mm.head || mm.spine || mm.hips ? 'body' : '']);
    const mine = parts(m);
    this.active = this.active.filter((a) => ![...parts(a.m)].some((p) => p && mine.has(p)));
    const a = { id, m, t0: now + v.delayMs, dur, k, amp, v, intensity: +(intensity ?? m.intensity ?? 0.6).toFixed(2), trigger };
    this.active.push(a);
    if (m.gaze === 'camera') { this.avatar.lookToward?.('center'); this.avatar.gazeAt?.('camera', dur); }
    if (['react', 'direct', 'brag'].includes(m.kind)) {
      this.lastReact = now;
      const ev = { type: id.replace(/^(react|direct|brag)_/, ''), move: id, kind: m.kind, intensity: a.intensity, emotion: emotion || m.emotions?.[0] || null,
        trigger, timestamp: Date.now(), t: now, durationMs: Math.round(dur), cam: m.cam || null };
      this.emit(ev);
    }
    this.log.push({ id, at: Date.now(), trigger, intensity: a.intensity, mirror: v.mirror, speed: v.speed, amp: v.amp }); if (this.log.length > 60) this.log.shift();
    return { id, durationMs: Math.round(dur), style: k, variant: v };
  }
  emit(ev) {
    for (const cb of this.listeners) { try { cb(ev); } catch (e) { console.warn('onReaction listener', e); } }
    try { window.dispatchEvent(new CustomEvent('jena-reaction', { detail: ev })); } catch {}
    try { window.parent !== window && window.parent.postMessage({ type: 'jena-reaction', ...ev }, '*'); } catch {}
    if (this.camAuto && !this.listeners.size && ev.cam === 'punch' && ev.intensity >= 0.6) {
      try { window.dispatchEvent(new CustomEvent('jena-cam', { detail: { shot: 'punch', why: ev.type, big: ev.intensity >= 0.85 } })); } catch {}
    }
  }
  onReaction(cb) { if (typeof cb !== 'function') throw new Error('onReaction(cb): cb must be a function'); this.listeners.add(cb); return () => this.listeners.delete(cb); }

  // what she says picks her reactions and gestures (her words, not chat's)
  readLine(text) {
    const t = String(text || ''); if (!t.trim()) return null;
    const caps = (t.match(/[A-Z]/g) || []).length / Math.max(1, (t.match(/[a-zA-Z]/g) || []).length);
    const bangs = (t.match(/!/g) || []).length;
    const I = clamp(0.55 + bangs * 0.1 + (caps > 0.5 && t.length > 3 ? 0.25 : 0), 0.4, 1);
    const L = t.toLowerCase();
    const has = (re) => re.test(L);
    const user = [...this.users].find((u) => u && u.length > 1 && L.includes(u.toLowerCase())) || (t.match(/@(\w{2,})/) || [])[1];
    // each trigger has a best-fit move (preferred when it's free) and alternates; nothing repeats back to back,
    // inside 30 s, or inside its cooldown. When all of a trigger's moves are used up she skips the gesture.
    let pref = null, alts = null, trigger = null;
    if (/\bYOU\b|\byou!/.test(t)) { pref = 'direct_you'; alts = ['direct_point', 'direct_finger_guns']; trigger = 'you!'; }
    else if (has(/\b(lol|lmao|lmfao|haha+|hehe+|rofl)\b|😂|🤣/)) { pref = 'react_laugh'; alts = ['react_hands_face', 'react_hype']; trigger = 'laugh'; }
    else if (has(/\b(no way|omg|oh my (god|gosh)|wait what|what\?!|what!|holy)\b/)) { alts = ['react_shock', 'react_hands_face', 'react_face_swing', 'react_recoil', 'react_head_snap']; trigger = 'shock'; }
    else if (has(/\b(ew+|gross|yikes|cringe)\b/)) { alts = ['react_recoil', 'react_cringe', 'react_face_swing']; trigger = 'gross'; }
    else if (has(/\b(bruh|ugh|smh|seriously|why would)\b/)) { pref = 'react_facepalm'; alts = ['talk_shake', 'react_cringe']; trigger = 'bruh'; }
    else if (has(/\b(ez|too easy|skill issue|built different|cope|ratio|cooked|i'?m (just )?(that )?good)\b/)) { pref = 'brag_smug'; alts = ['brag_flex', 'direct_finger_guns']; trigger = 'roast'; }
    else if (/\bW\b/.test(t) || has(/\b(clutch|let'?s go+|lets go+|gg|dub|we won|i won|nailed it)\b/)) { alts = ['react_hype', 'brag_flex', 'brag_smug']; trigger = 'win'; }
    else if (has(/\b(oh wait|wait|oh!|oh no)\b/)) { pref = 'react_head_snap'; alts = ['react_shock', 'talk_tilt_q']; trigger = 'realize'; }
    else if (has(/\b(hi|hey|hello|welcome|bye|good ?night)\b/) && (has(/\b(chat|guys|everyone|y'?all)\b/) || user)) { pref = 'direct_wave'; alts = ['direct_point']; trigger = 'greeting'; }
    else if (has(/\b(chat|you guys|y'?all|everyone|everybody)\b/) || user) {
      trigger = user ? 'username' : 'chat';
      pref = /\?/.test(t) ? 'direct_lean_in' : has(/\b(thanks|thank you|ty|gotcha|appreciate)\b/) ? 'direct_finger_guns' : null;
      alts = ['direct_point', 'direct_finger_guns', 'direct_lean_in', 'direct_you'];
    }
    // her face reacts too (src/expressions.js): learned expressions for the same triggers, plus a few face-only ones
    if (!alts) {
      const face = has(/\b(tired|sleepy|yawn+|exhausted|so late)\b/) ? 'tired' : has(/\b(oops|my bad|whoops|sorry)\b/) ? 'oops'
        : has(/\b(we lost|i lost|so sad|that'?s sad|miss (you|them|it))\b/) ? 'sad' : has(/\b(focus|lock(ed)? in|let me cook|try hard)\b/) ? 'focus'
        : has(/\b(hmm+|let me think|i wonder|maybe)\b/) ? 'think' : /\?\s*$/.test(t) ? 'question' : null;
      if (face) { try { this.onLineReaction?.(face, I); } catch {} }
      return null;
    }
    // at most one big reaction every ~2.5 s, so a long line doesn't turn into a seizure
    if (performance.now() - this.lastReact < 2500) return null;
    const id = this.choose(pref ? [pref, ...alts] : alts, 'line-' + trigger, { prefer: pref, allowNull: true });
    if (!id) return null;
    this.lastLineTrigger = trigger;
    try { this.onLineReaction?.(trigger, I); } catch {}
    return this.play(id, { intensity: MOVES[id].kind === 'direct' ? Math.max(I, 0.6) : I, trigger, picked: true });
  }
  seenUser(name) { if (name) { this.users.add(String(name)); if (this.users.size > 200) this.users.delete(this.users.values().next().value); } }

  // the picker: talking -> a talk gesture now and then (by her mood), on audio beats a nod; idle -> sway / tilt / look
  picker(now) {
    const A = this.avatar, talking = now < (A.talk?.until || 0);
    if (A.talk?.t0 && A.talk.t0 !== this.lastTalkT0) { this.lastTalkT0 = A.talk.t0; try { this.readLine(A.talk.text); } catch (e) { console.warn('motion readLine', e); } }
    const busyBody = this.active.some((a) => a.m.kind !== 'idle');
    const learned = this.moves?.busy;
    const mood = A.mood?.name || 'neutral';
    const fits = (m) => (m.emotions || []).includes(mood) || (m.emotions || []).includes('neutral');
    if (talking) {
      const beat = A.voiceBeat;
      if (beat && beat.at > (this._beatSeen || 0)) { this._beatSeen = beat.at; if (!busyBody && !learned && Math.random() < 0.35) { const b = this.choose(['talk_nod', 'talk_beat_r', 'talk_beat_l', 'talk_me', 'talk_palms'], 'beat', { allowNull: true, cooldownMs: 3500 }); if (b) this.play(b, { trigger: 'beat', intensity: 0.5 + beat.level * 0.3, picked: true }); } }
      if (now > this.nextTalk && !busyBody && !learned) {
        const q = /\?\s*$/.test(A.talk.text || '');
        const pool = Object.entries(MOVES).filter(([id, m]) => m.kind === 'talk' && fits(m)).map(([id]) => id);
        const id = this.choose(pool, 'talk', { prefer: q && Math.random() < 0.5 ? 'talk_tilt_q' : null, allowNull: true });
        if (id) this.play(id, { trigger: 'talk', picked: true });
        const k = this.knobs();
        // how often: learned from tracked talkers (ANIMATIONS/styles.json), x3 because 3D VTubers act bigger than people on camera
        const gpm = clamp((STYLES?.learned?.talk_gestures_per_min || 6) * 3, 8, 24);
        this.nextTalk = now + (60000 / gpm) * (0.7 + Math.random() * 0.6) / k.tempo;
      }
    } else if (now > this.nextIdle) {
      this.nextIdle = now + 7000 + Math.random() * 7000;
      if (!busyBody && !learned) {
        const pool = Object.entries(MOVES).filter(([id, m]) => m.kind === 'idle' && fits(m)).map(([id]) => id);
        const id = pool.length ? this.choose(pool, 'idle', { allowNull: true }) : null;
        if (id) this.play(id, { trigger: 'idle', picked: true });
      }
    }
  }

  // progress 0..1 of a playing move with its variant's onset delay (t0 is already shifted) and time warp
  uOf(a, now) { const u = clamp((now - a.t0) / a.dur, 0, 1); return a.v ? u ** a.v.warp : u; }
  // procedural micro-motion, layered on everything: slow random head drift + torso sway (Ornstein-Uhlenbeck, so it
  // never cycles) and a weight shift to a random side every 6-22 s. Breathing, blink timing and eye saccades live
  // in avatar.js; together they keep idle from ever looking like a loop.
  micro(vrm, dt) {
    const H = vrm.humanoid, W = this.wander, d = Math.min(dt, 0.05), now = performance.now();
    const quiet = this.moves?.busy ? 0.4 : 1;
    const head = H.getNormalizedBoneNode('head'), spine = H.getNormalizedBoneNode('spine');
    if (head) { head.rotation.x += W.hx.step(d) * 0.018 * quiet; head.rotation.y += W.hy.step(d) * 0.03 * quiet; head.rotation.z += W.hz.step(d) * 0.016 * quiet; }
    if (spine) { spine.rotation.z += W.sz.step(d) * 0.012 * quiet; spine.rotation.x += W.sx.step(d) * 0.008 * quiet; }
    const lean = this.avatar.act?.lean;
    if (lean && now > this.nextShift) {
      this.nextShift = now + 6000 + Math.random() * 16000;
      if (!lean.until && Math.abs(lean.t) < 0.05) { lean.t = (Math.random() < 0.5 ? -1 : 1) * (0.2 + Math.random() * 0.5); lean.until = now + 2500 + Math.random() * 7000; }
    }
  }

  weightOf(a, now) { const u = (now - a.t0) / a.dur; return u >= 1 ? null : u; }

  body(vrm, dt) {
    const now = performance.now();
    this.picker(now);
    try { this.micro(vrm, dt); } catch (e) { console.warn('motion micro', e); }
    this.active = this.active.filter((a) => now - a.t0 < a.dur);
    if (!this.active.length) { this.shoulders = 0; return; }
    const H = vrm.humanoid, damp = this.moves?.busy ? 0.6 : 1;
    let sh = 0;
    for (const a of this.active) {
      const u = this.uOf(a, now), m = a.m, k = a.k, g = a.amp * damp, mir = a.v?.mirror ? -1 : 1, bias = a.v?.bias;
      const hz = m.loop_hz ? Math.sin((now - a.t0) / 1000 * Math.PI * 2 * m.loop_hz * k.tempo) : 0;
      const env = Math.sin(Math.PI * Math.min(1, u)); // osc envelope
      for (const [bone, key] of [['head', 'head'], ['neck', 'neck'], ['spine', 'spine'], ['chest', 'chest']]) {
        const v = track(m[key], u, k, 3); const o = m.osc?.[key];
        if (!v && !o) continue;
        const n = H.getNormalizedBoneNode(bone); if (!n) continue;
        // her head yaw/pitch shares with the neck so a big turn bends the whole neck, not just the skull
        let x = (v ? v[0] : 0) + (o ? o[0] * hz * env : 0), y = ((v ? v[1] : 0) + (o ? o[1] * hz * env : 0)) * mir, z = ((v ? v[2] : 0) + (o ? o[2] * hz * env : 0)) * mir;
        if (bone === 'head' && bias) { x += bias[0] * env; y += bias[1] * env; z += bias[2] * env; }
        if (bone === 'head') { const nk = H.getNormalizedBoneNode('neck'); if (nk) { nk.rotation.x += x * 0.35 * g; nk.rotation.y += y * 0.35 * g; } n.rotation.x += x * 0.65 * g; n.rotation.y += y * 0.65 * g; n.rotation.z -= z * g; }
        else { n.rotation.x += x * g; n.rotation.y += y * g; n.rotation.z += z * g; }
      }
      const hp = track(m.hips, u, k, 3), ho = m.osc?.hips;
      if (hp || ho) { const h = H.getNormalizedBoneNode('hips'); if (h) { h.position.x += ((hp ? hp[0] : 0) + (ho ? ho[0] * hz * env : 0)) * g * mir; h.position.y += ((hp ? hp[1] : 0) + (ho ? ho[1] * Math.abs(hz) * env : 0)) * g; h.position.z += ((hp ? hp[2] : 0) + (ho ? ho[2] * hz * env : 0)) * g; } }
      const s = track(m.shoulders, u, k, 1); if (s) sh = Math.max(sh, s[0] * g);
    }
    if (sh > 0) { const l = H.getNormalizedBoneNode('leftShoulder'), r = H.getNormalizedBoneNode('rightShoulder'); if (l) l.rotation.z += 0.16 * sh; if (r) r.rotation.z -= 0.16 * sh; }
    this.shoulders = sh;
  }

  target(pose, side, a, now, S, reach, H, vrm) {
    const sx = side === 'left' ? 1 : -1;
    const sq = vrm.scene.getWorldQuaternion(_q[3]);
    const off = (o) => _v[6].set(o[0] * sx, o[1], o[2]).applyQuaternion(sq);
    if (pose.at === 'camera') {
      const C = this.avatar.camera.getWorldPosition(_v[7]);
      const d = _v[8].copy(C).sub(S); d.y += pose.drop || 0; d.x += 0.05 * sx; d.normalize();
      return _v[9].copy(S).addScaledVector(d, reach * pose.reach);
    }
    const base = pose.from === 'shoulder' ? S : H.getNormalizedBoneNode(pose.from === 'head' ? 'head' : pose.from === 'hips' ? 'hips' : 'upperChest')?.getWorldPosition(_v[10]) || S;
    const T = _v[9].copy(base).add(off(pose.off));
    const tt = (now - a.t0) / 1000;
    if (pose.wave) T.addScaledVector(_v[11].set(1, 0, 0).applyQuaternion(sq), Math.sin(tt * Math.PI * 2 * (a.m.loop_hz || 3)) * pose.wave);
    if (pose.beat) T.y -= Math.abs(Math.sin(tt * Math.PI * 2 * 1.6)) * pose.beat;
    return T;
  }

  // rotate a bone so its child moves from `from` to `to` (world directions), blended by w
  aim(node, from, to, w) {
    if (from.lengthSq() < 1e-8 || to.lengthSq() < 1e-8) return;
    const qd = _q[0].setFromUnitVectors(from.normalize(), to.normalize());
    const world = node.getWorldQuaternion(_q[1]);
    const goal = qd.multiply(world);
    const parent = node.parent.getWorldQuaternion(_q[2]).invert();
    const local = parent.multiply(goal);
    node.quaternion.slerp(local, clamp(w, 0, 1));
    node.updateMatrixWorld(true);
  }

  arms(vrm, dt) {
    const now = performance.now(), H = vrm.humanoid;
    this.armState = {};
    for (const side of ['left', 'right']) {
      let best = null, bw = 0;
      for (const a of this.active) {
        const arm = a.m.arms?.[a.v?.mirror ? (side === 'left' ? 'right' : 'left') : side]; if (!arm) continue;
        const u = this.uOf(a, now); const w = (track(arm.keys, u, { ...a.k, overshoot: 0 }, 1) || [0])[0];
        if (w > bw) { bw = w; best = { a, pose: POSES[arm.pose], name: arm.pose }; }
      }
      if (!best || bw < 0.01 || !best.pose) continue;
      const Sn = H.getNormalizedBoneNode(side + 'UpperArm'), En = H.getNormalizedBoneNode(side + 'LowerArm'), Wn = H.getNormalizedBoneNode(side + 'Hand');
      if (!Sn || !En || !Wn) continue;
      Sn.parent.updateMatrixWorld(true);
      const S = Sn.getWorldPosition(_v[0]).clone(), E = En.getWorldPosition(_v[1]).clone(), Wp = Wn.getWorldPosition(_v[2]).clone();
      const l1 = S.distanceTo(E), l2 = E.distanceTo(Wp), reach = l1 + l2;
      const T = this.target(best.pose, side, best.a, now, S, reach, H, vrm).clone();
      const sx = side === 'left' ? 1 : -1;
      const sq = vrm.scene.getWorldQuaternion(_q[4]);
      const pole = _v[3].set(best.pose.pole[0] * sx, best.pose.pole[1], best.pose.pole[2]).applyQuaternion(sq).normalize();
      const dvec = T.clone().sub(S); const dist = clamp(dvec.length(), Math.abs(l1 - l2) + 0.01, reach * 0.995); dvec.normalize();
      const perp = pole.clone().addScaledVector(dvec, -pole.dot(dvec)).normalize();
      const along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
      const Et = S.clone().addScaledVector(dvec, along).addScaledVector(perp, h);
      const Wt = S.clone().addScaledVector(dvec, dist);
      this.aim(Sn, E.clone().sub(S), Et.clone().sub(S), bw);
      const E2 = En.getWorldPosition(_v[4]).clone(), W2 = Wn.getWorldPosition(_v[5]).clone();
      this.aim(En, W2.clone().sub(E2), Wt.clone().sub(E2), bw);
      if (best.pose.wrist === 'straight') Wn.quaternion.slerp(_q[5].identity(), bw * 0.8);
      this.fingers(H, side, best.pose.fingers, bw);
      this.armState[side] = { pose: best.name, w: +bw.toFixed(2), target: T.toArray().map((x) => +x.toFixed(3)), hand: Wn.getWorldPosition(new THREE.Vector3()).toArray().map((x) => +x.toFixed(3)) };
    }
  }
  fingers(H, side, curl, w) {
    const sg = side === 'left' ? -1 : 1, k = { Index: 0.8, Middle: 0.95, Ring: 1.06, Little: 1.18 };
    const lerp = (n, ax, v) => { if (n) n.rotation[ax] += (v - n.rotation[ax]) * w; };
    ['Index', 'Middle', 'Ring', 'Little'].forEach((f, i) => {
      const c = curl[i + 1] * (curl[i + 1] > 0.9 ? 1 : k[f]);
      lerp(H.getNormalizedBoneNode(`${side}${f}Proximal`), 'z', sg * c * 1.2);
      lerp(H.getNormalizedBoneNode(`${side}${f}Intermediate`), 'z', sg * Math.max(0, c) * 1.45);
      lerp(H.getNormalizedBoneNode(`${side}${f}Distal`), 'z', sg * Math.max(0, c) * 0.95);
    });
    const th = curl[0];
    lerp(H.getNormalizedBoneNode(`${side}ThumbMetacarpal`), 'y', -sg * th * 0.35);
    lerp(H.getNormalizedBoneNode(`${side}ThumbProximal`), 'y', -sg * th * 0.5);
    lerp(H.getNormalizedBoneNode(`${side}ThumbDistal`), 'y', -sg * th * 0.65);
  }

  face(vrm, dt) {
    const em = vrm.expressionManager; if (!em) return;
    const now = performance.now();
    const want = {}; let smug = 0;
    const SWAP = { lookLeft: 'lookRight', lookRight: 'lookLeft', blinkLeft: 'blinkRight', blinkRight: 'blinkLeft' };
    for (const a of this.active) {
      const u = this.uOf(a, now);
      for (const [name0, keys] of Object.entries(a.m.face || {})) { const name = a.v?.mirror ? (SWAP[name0] || name0) : name0; const v = track(keys, u, { ...a.k, overshoot: 0 }, 1)[0] * Math.min(1, a.amp); want[name] = Math.max(want[name] || 0, v); }
      if (a.m.smug) smug = Math.max(smug, track(a.m.smug, u, { ...a.k, overshoot: 0 }, 1)[0]);
    }
    if (this.forceSmug && now < this.forceSmug) smug = Math.max(smug, 1);
    this.smugW += (smug - this.smugW) * Math.min(1, dt * 10);
    if (this.smugW > 0.01) {
      // smug / cocky (brag moments: a W, a clutch play, roasting chat): heavy-lidded eyes, a closed half smile,
      // brows a touch down, eyes slid to one side. Never flirty: no wink, no kiss, no blush, no lip bite.
      const s = this.smugW;
      for (const [n, v] of Object.entries({ relaxed: 0.6, happy: 0.32, angry: 0.1, ih: 0.12, lookRight: 0.18 })) want[n] = Math.max(want[n] || 0, v * s);
    }
    for (const [n, v] of Object.entries(want)) { if (v <= 0.005) continue; try { em.setValue(n, Math.max(em.getValue(n) || 0, v)); } catch {} }
    this.faceNow = want;
  }

  state() {
    const now = performance.now();
    return { playing: this.active.map((a) => ({ id: a.id, kind: a.m.kind, progress: +((now - a.t0) / a.dur).toFixed(2), trigger: a.trigger, intensity: a.intensity })),
      style: this.style, knobs: this.knobs(), arms: this.armState || {}, smug: +this.smugW.toFixed(2), recent: this.log.slice(-12), moves: Object.keys(MOVES).length };
  }
}

// spring bones: hair, clothes and accessories only (with colliders); never chest / body jiggle
export function setupSprings(vrm) {
  const M = vrm?.springBoneManager; if (!M) return { joints: 0 };
  const groups = M.colliderGroups || [];
  const byName = (re) => groups.filter((g) => re.test(g.name || ''));
  const out = { removed: [], hair: 0, clothes: 0, other: 0, fixedColliders: 0 };
  const BODY = /bust|breast|chest|boob|oppai|butt|hip(?!s)|belly|thigh(?!.*(tops|skirt|cloth))|body/i;
  for (const j of [...M.joints]) {
    const n = j.bone?.name || '';
    if (BODY.test(n) && !/hair|tops|skirt|cloth|coat|ribbon|acc|tail|ear/i.test(n)) { M.deleteJoint(j); out.removed.push(n); continue; }
    if (/hair/i.test(n)) {
      out.hair++;
      // head, neck, upper chest and shoulders/arms keep her hair outside her face and body
      if (!j.colliderGroups?.length) j.colliderGroups = byName(/head|neck|chest|spine|arm/i);
      j.settings.dragForce = Math.max(j.settings.dragForce ?? 0.4, 0.35);
    } else if (/tops|skirt|cloth|coat|sleeve/i.test(n)) {
      out.clothes++;
      // her export pointed the skirt at RightHand + LeftUpperLeg only, and the sleeves at nothing: legs + hips for
      // the skirt, arms + chest for the sleeves
      const want = /leg/i.test(n) ? byName(/upperleg|spine/i) : /arm/i.test(n) ? byName(/arm|chest/i) : byName(/spine|chest|upperleg/i);
      if (want.length) { j.colliderGroups = want; out.fixedColliders++; }
      j.settings.stiffness = Math.max(j.settings.stiffness ?? 1, 0.8);
    } else out.other++;
  }
  try { M.setInitState(); } catch {}
  out.joints = M.joints.size; out.colliders = M.colliders?.length ?? 0;
  return out;
}
