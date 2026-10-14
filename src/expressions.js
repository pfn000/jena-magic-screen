// Jena's learned facial expressions (16): surprised, shocked, cringe, side-eye, pout, laugh-cry, thinking, angry,
// sleepy, smug, disgusted, embarrassed, excited, sad, confused, determined. Learned from real faces on video:
// public, kid-safe expression-reference clips tracked with MediaPipe FaceLandmarker (52 blendshapes + head pose),
// see ANIMATIONS/expressions/README.md and moves-pipeline/expressions_learn.py. Each expression has several real
// variants (one per occurrence found in the clips) with the onset / hold / release timing measured there, its
// left/right asymmetry and head pose, mapped onto her own VRoid face morphs (Fcl_BRW_*, Fcl_EYE_*, Fcl_MTH_*), which
// get registered as extra VRM expressions ('fcl.BRW_Angry', ...) so the expression manager blends them properly.
// No repeats: the variant, the expression for a trigger, and the idle faces all go through NoRepeat, and each play
// gets a fresh variant (size, speed, mirrored, timing jitter). Plus brows/nods from her voice's pitch + energy.
// She is a kid: nothing here is flirty (no wink, kiss, blush, lip bite). "embarrassed" is a sheepish/awkward face.
import { VRMExpression, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm';
import EXPR from '../ANIMATIONS/expressions/expressions.json';
import { NoRepeat, Wander } from './nonrepeat.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// what each face is for: the emotions/moods it fits and the line triggers (src/motion.js readLine) that call it
export const EXPRESSION_TAGS = {
  surprised:   { emotions: ['surprised', 'curious'], triggers: ['shock', 'realize', 'greeting'] },
  shocked:     { emotions: ['shock', 'scared'], triggers: ['shock'] },
  cringe:      { emotions: ['cringe', 'embarrassed'], triggers: ['gross', 'bruh'] },
  side_eye:    { emotions: ['suspicious', 'annoyed'], triggers: ['bruh', 'roast'] },
  pout:        { emotions: ['sad', 'annoyed'], triggers: ['lose', 'no'] },
  laugh_cry:   { emotions: ['funny', 'laugh', 'happy'], triggers: ['laugh'] },
  thinking:    { emotions: ['curious', 'thinking'], triggers: ['question', 'think'] },
  angry:       { emotions: ['angry'], triggers: ['angry', 'lose'] },
  sleepy:      { emotions: ['sleepy', 'bored', 'relaxed'], triggers: ['tired'] },
  smug:        { emotions: ['smug', 'proud'], triggers: ['roast', 'win'] },
  disgusted:   { emotions: ['gross'], triggers: ['gross'] },
  embarrassed: { emotions: ['embarrassed', 'shy'], triggers: ['oops', 'thanks'] },
  excited:     { emotions: ['hype', 'happy'], triggers: ['win', 'greeting', 'you!', 'chat', 'username'] },
  sad:         { emotions: ['sad'], triggers: ['sad', 'lose'] },
  confused:    { emotions: ['confused', 'curious'], triggers: ['question', 'realize'] },
  determined:  { emotions: ['determined', 'focus'], triggers: ['focus', 'win'] },
};
const MOOD_FACES = { happy: ['excited', 'laugh_cry', 'smug'], sad: ['sad', 'pout'], angry: ['angry', 'determined', 'side_eye'], relaxed: ['sleepy', 'thinking', 'smug'],
  surprised: ['surprised', 'shocked'], neutral: ['thinking', 'side_eye', 'confused', 'determined', 'embarrassed', 'smug'] };
const PRESET_MOODS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];
// retarget tuning for her anime (VRoid) face, applied on top of the learned weights: a few human shapes read
// differently on anime morphs (VRoid's "U" mouth is wide open, so a human pout needs it small and closed).
// scale: multiply a channel · min: at least this much (times the learned peak) · max: cap.
const TUNE = {
  pout: { scale: { MTH_U: 0.35, MTH_A: 0, MTH_O: 0.3 }, min: { MTH_Small: 0.55, BRW_Sorrow: 0.35, MTH_Sorrow: 0.25 } },
  thinking: { scale: { MTH_U: 0.35, MTH_A: 0.3 }, min: { MTH_Small: 0.4 } },
  determined: { scale: { MTH_A: 0.2 }, min: { MTH_Small: 0.35, BRW_Angry: 0.45 } },
  side_eye: { scale: { MTH_A: 0.2 }, min: { EYE_Angry: 0.25 } },
  smug: { scale: { MTH_A: 0.2, BRW_Surprised: 0.4 }, min: { MTH_Fun: 0.45, EYE_Joy_L: 0.15 } },
  embarrassed: { scale: { MTH_A: 0.3 }, min: { MTH_Fun: 0.3, BRW_Sorrow: 0.35 } },
  sad: { scale: { MTH_A: 0.4 }, min: { MTH_Sorrow: 0.45, BRW_Sorrow: 0.5 } },
  angry: { min: { BRW_Angry: 0.6, EYE_Angry: 0.35 } },
  disgusted: { min: { MTH_Angry: 0.35, BRW_Angry: 0.35 } },
  confused: { min: { BRW_Sorrow: 0.25 } },
  surprised: { min: { BRW_Surprised: 0.6, EYE_Surprised: 0.4 } },
  shocked: { min: { BRW_Surprised: 0.7, EYE_Surprised: 0.6, MTH_Surprised: 0.4 } },
  excited: { min: { MTH_Joy: 0.5, BRW_Surprised: 0.3 } },
  laugh_cry: { min: { MTH_Joy: 0.6, EYE_Fun: 0 } },
  sleepy: { min: { EYE_Close_L: 0.45, EYE_Close_R: 0.45 } },
  cringe: { scale: { MTH_A: 0.5 }, min: { MTH_I: 0.4, EYE_Angry: 0.3 } },
};
function tuned(name, vrm) {
  const T = TUNE[name]; if (!T) return vrm;
  const o = { ...vrm };
  for (const [k, s] of Object.entries(T.scale || {})) if (o[k] != null) o[k] *= s;
  for (const [k, m] of Object.entries(T.min || {})) o[k] = Math.max(o[k] || 0, m);
  return o;
}
const SWAP = { EYE_Close_L: 'EYE_Close_R', EYE_Close_R: 'EYE_Close_L', EYE_Joy_L: 'EYE_Joy_R', EYE_Joy_R: 'EYE_Joy_L', lookLeft: 'lookRight', lookRight: 'lookLeft' };

export class Expressions {
  constructor(avatar, { noRepeat, data = EXPR } = {}) {
    this.avatar = avatar; this.data = data;
    this.names = Object.keys(data.expressions || {}).filter((n) => data.expressions[n].variants?.length);
    this.nr = noRepeat || new NoRepeat({ minGap: 3, windowMs: 30000, defaultCooldownMs: 12000 });
    this.vnr = new NoRepeat({ minGap: 2, windowMs: 60000 });     // which real variant of an expression
    this.active = null; this.held = null; this.channels = new Set(); this.listeners = new Set();
    this.nextIdle = performance.now() + 15000 + Math.random() * 20000;
    this.drift = new Wander(1, 0.9);
    this.pros = { mean: 0, n: 0, brow: 0, nod: 0, nodV: 0, lastBeat: 0 };
    this.log = [];
    (avatar.faceHooks ||= []).push((vrm, dt) => this.face(vrm, dt));
    avatar.poseHooks.push((vrm, dt) => this.head(vrm, dt));
    if (avatar.vrm) this.install(avatar.vrm);
  }

  // register her VRoid regional morphs (Fcl_BRW_*, Fcl_EYE_*, Fcl_MTH_*) as VRM expressions 'fcl.<name>'
  install(vrm) {
    const em = vrm?.expressionManager; if (!em || this.installed === vrm) return this.channels.size;
    this.installed = vrm;
    const want = new Set();
    for (const e of Object.values(this.data.expressions)) for (const v of e.variants || []) for (const k of Object.keys(v.vrm || {})) if (!/^look/.test(k)) want.add(k);
    for (const T of Object.values(TUNE)) for (const k of Object.keys(T.min || {})) want.add(k);
    const meshes = [];
    vrm.scene.traverse((o) => { if (o.isMesh && o.morphTargetDictionary) meshes.push(o); });
    for (const k of want) {
      const prims = [], idx = new Map();
      for (const m of meshes) {
        const key = Object.keys(m.morphTargetDictionary).find((n) => n === 'Fcl_' + k || n.endsWith('.Fcl_' + k) || n.endsWith('Fcl_' + k));
        if (key != null) { prims.push(m); idx.set(m, m.morphTargetDictionary[key]); }
      }
      if (!prims.length) continue;
      const name = 'fcl.' + k;
      if (em.getExpression(name)) { this.channels.add(k); continue; }
      const ex = new VRMExpression(name);
      // one bind per mesh (the morph index can differ per primitive)
      for (const m of prims) ex.addBind(new VRMExpressionMorphTargetBind({ primitives: [m], index: idx.get(m), weight: 1 }));
      vrm.scene.add(ex);
      em.registerExpression(ex);
      this.channels.add(k);
    }
    return this.channels.size;
  }

  // play one expression (a real variant picked without repeats); returns what it's doing
  play(name, { intensity = 0.9, trigger = 'manual', variant: vi } = {}) {
    const E = this.data.expressions[name];
    if (!E?.variants?.length) throw new Error('unknown expression ' + name + ' (have: ' + this.names.join(', ') + ')');
    if (trigger === 'manual' || trigger === 'api') this.nr.note(name, 'manual');
    const ids = E.variants.map((_, i) => name + '#' + i);
    const pick = vi != null ? name + '#' + vi : this.vnr.pick(ids, { pool: 'var-' + name });
    const v = E.variants[+pick.split('#')[1]];
    const r = this.nr.variant({ mirror: true });
    const T = E.timing || {};
    // the measured timing of THIS occurrence, blended with the expression's median, jittered a little
    const j = (x) => x * (0.85 + Math.random() * 0.3) / r.speed;
    const onset = j((v.onset + (T.onset ?? v.onset)) / 2), hold = j(clamp((v.hold + (T.hold ?? v.hold)) / 2, 0.35, 2.6)), release = j((v.release + (T.release ?? v.release)) / 2);
    const now = performance.now();
    this.active = { name, v, vi: +pick.split('#')[1], t0: now + r.delayMs, onset: onset * 1000, hold: hold * 1000, release: release * 1000, amp: clamp(intensity, 0.2, 1.1) * r.amp, mirror: r.mirror, trigger };
    const ev = { type: 'expression', expression: name, variant: this.active.vi, source: v.clip, trigger, mirror: r.mirror, timestamp: Date.now(), durationMs: Math.round((onset + hold + release) * 1000) };
    this.log.push(ev); if (this.log.length > 60) this.log.shift();
    for (const cb of this.listeners) { try { cb(ev); } catch {} }
    return ev;
  }
  onExpression(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  // freeze one expression at its peak (proof shots / the dev panel); null clears
  show(name, { variant = 0, weight = 1, mirror = false } = {}) {
    if (!name) { this.held = null; return null; }
    const E = this.data.expressions[name]; if (!E?.variants?.length) throw new Error('unknown expression ' + name);
    this.held = { name, v: E.variants[Math.min(variant, E.variants.length - 1)], amp: weight, mirror };
    return this.held;
  }
  // a line trigger from her words (motion.js readLine): an expression that fits it, never the one she just made
  react(trigger, intensity = 0.8) {
    const pool = this.names.filter((n) => EXPRESSION_TAGS[n]?.triggers.includes(trigger));
    if (!pool.length) return null;
    const name = this.nr.pick(pool, { pool: 'trig-' + trigger, allowNull: true });
    return name ? this.play(name, { intensity, trigger }) : null;
  }
  forMood(mood, intensity = 0.7) {
    const pool = (MOOD_FACES[mood] || MOOD_FACES.neutral).filter((n) => this.names.includes(n));
    const name = this.nr.pick(pool, { pool: 'mood-' + mood, allowNull: true });
    return name ? this.play(name, { intensity, trigger: 'mood' }) : null;
  }
  envelope(a, now) {
    const t = now - a.t0; if (t < 0) return 0;
    if (t < a.onset) { const u = t / a.onset; return 1 - (1 - u) ** 3; }                 // fast attack, soft landing
    if (t < a.onset + a.hold) return 1;
    const u = (t - a.onset - a.hold) / a.release; if (u >= 1) return -1;
    return 1 - u * u * (3 - 2 * u);                                                       // ease out
  }
  face(vrm, dt) {
    const em = vrm.expressionManager; if (!em) return;
    if (this.installed !== vrm) this.install(vrm);
    const now = performance.now(), A = this.avatar;
    const talking = now < (A.talk?.until || 0);
    // idle faces now and then (never the same one twice in a row, never inside 30 s), only when nothing else plays
    if (!this.active && !this.held && !talking && now > this.nextIdle) {
      this.nextIdle = now + 18000 + Math.random() * 30000;
      if (!this.avatar.motion?.active?.some((x) => x.m.kind !== 'idle')) this.forMood(A.mood?.name || 'neutral', 0.55);
    }
    let a = this.held ? { ...this.held, w: 1 } : this.active, w = 0;
    if (a && !this.held) { w = this.envelope(a, now); if (w < 0) { this.active = null; a = null; w = 0; } }
    else if (a) w = 1;
    let out = {};
    if (a && w > 0.001) {
      const hold = this.held ? 0 : this.drift.step(Math.min(dt, 0.05)) * 0.05;          // a held face is never frozen
      for (const [k0, x] of Object.entries(a.tuned ||= tuned(a.name, a.v.vrm || {}))) {
        const k = a.mirror ? (SWAP[k0] || k0) : k0;
        let val = x * a.amp * w * (1 + hold);
        if (talking && /^MTH_/.test(k)) val *= 0.35;                                      // her lips keep talking
        out[k] = clamp(val, 0, 1);
      }
      // the face takes over from her plain mood presets while it plays
      for (const m of PRESET_MOODS) { try { em.setValue(m, (em.getValue(m) || 0) * (1 - w * 0.85)); } catch {} }
    }
    // voice prosody (RESEARCH.md cheap win #4): brows lift on stressed high-pitched syllables
    out.BRW_Surprised = Math.max(out.BRW_Surprised || 0, this.pros.brow);
    // fcl.* channels are hers alone and nothing else resets them, so each frame writes every one of them
    // (0 when unused): a max() against last frame's value latched them on (eyes stuck shut, mouth stuck open)
    for (const k of this.channels) { try { em.setValue('fcl.' + k, clamp(out[k] || 0, 0, 1)); } catch {} }
    for (const [k, v] of Object.entries(out)) {
      if (v <= 0.002 || !/^look/.test(k)) continue;
      try { em.setValue(k, Math.max(em.getValue(k) || 0, v)); } catch {}
    }
    this.faceNow = out; this.weight = w;
  }
  // head pose of the expression (from the tracked clip), plus voice-driven nods and chin lift
  head(vrm, dt) {
    const H = vrm.humanoid, head = H.getNormalizedBoneNode('head'); if (!head) return;
    const now = performance.now(), A = this.avatar, P = this.pros;
    const a = this.held ? this.held : this.active;
    const w = this.held ? 1 : a ? Math.max(0, this.envelope(a, now)) : 0;
    if (a && w > 0) {
      // the performer's head pose, softened: her camera framing stays on her face
      const [yaw, pitch, roll] = a.v.head || [0, 0, 0], s = a.mirror ? -1 : 1, k = Math.PI / 180 * 0.5 * a.amp * w;
      head.rotation.y += clamp(yaw, -12, 12) * k * s; head.rotation.x += clamp(pitch, -10, 10) * k; head.rotation.z += clamp(roll, -8, 8) * k * s;
    }
    // prosody from her voice: pitch above her running mean lifts brows + chin, energy onsets give a small nod
    const vc = A.voice, talking = now < (A.talk?.until || 0);
    if (talking && vc?.pitch > 60 && vc.pitch < 700 && (vc.pitchConf ?? 1) > 0.5) {
      P.n = Math.min(P.n + 1, 200); P.mean += (vc.pitch - P.mean) / P.n;
      const dev = clamp((vc.pitch - P.mean) / Math.max(P.mean, 1), -0.4, 0.4);
      P.brow += (clamp(dev * 2.2, 0, 0.45) * clamp(vc.level * 1.5, 0, 1) - P.brow) * Math.min(1, dt * 10);
      head.rotation.x -= dev * 0.06;
    } else P.brow *= Math.max(0, 1 - dt * 6);
    const beat = A.voiceBeat;
    if (talking && beat && beat.at > P.lastBeat) { P.lastBeat = beat.at; P.nodV += 0.9 * beat.level; }
    // damped spring nod
    P.nodV += (-P.nod * 60 - P.nodV * 9) * Math.min(dt, 0.05); P.nod += P.nodV * Math.min(dt, 0.05);
    head.rotation.x += P.nod * 0.12;
  }
  state() { return { playing: this.active && { name: this.active.name, variant: this.active.vi, mirror: this.active.mirror }, held: this.held?.name || null, weight: +(this.weight || 0).toFixed(2), channels: [...this.channels], recent: this.log.slice(-10), names: this.names, prosody: { brow: +this.pros.brow.toFixed(2), pitchMean: Math.round(this.pros.mean) } }; }
}
