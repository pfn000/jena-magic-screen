// Jena's per-channel face tracking. Every ARKit-style face score (MediaPipe FaceLandmarker's 52 blendshapes:
// the learned moves' tracked faces, the expression clips, a test hold) drives its OWN target - never one shared
// value: upper lid (eyeWide), lower lid (eyeSquint) and blink per eye, each cheek (cheekSquint) and cheekPuff,
// the jaw (jawOpen through the humanoid jaw bone) and every mouth shape, each brow part.
// - A model with perfect-sync / ARKit shape keys gets each score on its matching shape key (registered as VRM
//   expressions 'ark.<name>' so three-vrm blends them).
// - Without them (her current VRoid body), each channel falls back to the nearest per-side VRM expression or
//   VRoid morph: blinks -> blinkLeft/blinkRight, lower lid + cheek -> Fcl_EYE_Joy_L/R, upper lid -> eyelid
//   bones when the model has them else Fcl_EYE_Surprised, brows/mouth -> the matching Fcl_BRW_* / Fcl_MTH_* /
//   vowel presets. A shape the model can't show at all is listed as unmapped (dev panel).
// - Light per-channel smoothing: blinks close fast and open fast (crisp), everything else a touch softer.
// - Mirror-correct: 'Left' is HER left. A mirrored playback swaps every Left/Right pair before it gets here.
import { VRMExpression, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm';
import { OneEuro } from './motionpolish.js';

export const ARKIT = ['browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight',
  'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight', 'jawForward', 'jawLeft', 'jawOpen', 'jawRight', 'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight',
  'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight', 'noseSneerLeft', 'noseSneerRight', 'tongueOut'];
// swap every Left/Right pair (a mirrored playback)
export function mirrorScores(sc) {
  const o = {};
  for (const [k, v] of Object.entries(sc)) o[k.endsWith('Left') ? k.slice(0, -4) + 'Right' : k.endsWith('Right') ? k.slice(0, -5) + 'Left' : k] = v;
  return o;
}
// 'eyeBlink_L', 'EyeBlinkLeft', 'blendShape1.eyeBlinkLeft', 'eye_blink_left' -> 'eyeblinkl'
const norm = (n) => String(n).split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '').replace(/left$/, 'l').replace(/right$/, 'r');
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const BLINKS = new Set(['eyeBlinkLeft', 'eyeBlinkRight']);
const KID_SAFE_OFF = new Set(['tongueOut']); // nothing silly/suggestive from a performer's face

export class ArkitFace {
  constructor(avatar) {
    this.avatar = avatar; this.sources = new Map(); this.sm = {}; this.out = {}; this.unmapped = [];
    (avatar.faceHooks ||= []).push((vrm, dt) => this.apply(vrm, dt));
  }
  // a source (moves / expressions / test) hands in this frame's scores (0..1 per ARKit name) and a weight
  feed(src, scores, w = 1) { this.sources.set(src, { scores, w, at: performance.now() }); }
  // hold a set of scores for ms (proof clips, the dev panel): e.g. hold({ eyeBlinkLeft: 1 }, 3000)
  hold(scores, ms = 3000) { this.held = { scores, until: performance.now() + ms }; return this.held; }

  install(vrm) {
    if (this.vrm === vrm) return;
    this.vrm = vrm; this.ps = {}; this.fb = {}; this.lids = null; this.sm = {};
    const em = vrm.expressionManager; if (!em) return;
    const meshes = []; vrm.scene.traverse((o) => { if (o.isMesh && o.morphTargetDictionary) meshes.push(o); });
    const want = new Map(ARKIT.map((a) => [norm(a), a]));
    const found = new Map(); // ark name -> [[mesh, index]]
    for (const m of meshes) for (const [key, idx] of Object.entries(m.morphTargetDictionary)) {
      const a = want.get(norm(key)); if (!a) continue;
      if (!found.has(a)) found.set(a, []);
      if (!found.get(a).some(([mm]) => mm === m)) found.get(a).push([m, idx]);
    }
    const reg = (name, binds) => {
      if (em.getExpression(name)) return name;
      const ex = new VRMExpression(name);
      for (const [m, idx] of binds) ex.addBind(new VRMExpressionMorphTargetBind({ primitives: [m], index: idx, weight: 1 }));
      vrm.scene.add(ex); em.registerExpression(ex); return name;
    };
    for (const [a, binds] of found) this.ps[a] = reg('ark.' + a, binds);
    this.perfect = Object.keys(this.ps).length >= 20;
    // fallback targets: VRoid regional morphs (Fcl_*) registered as fcl.* when present, plus the VRM presets
    const fcl = (k) => {
      if (em.getExpression('fcl.' + k)) return 'fcl.' + k;
      const binds = []; for (const m of meshes) { const key = Object.keys(m.morphTargetDictionary).find((n) => n === 'Fcl_' + k || n.endsWith('Fcl_' + k)); if (key != null) binds.push([m, m.morphTargetDictionary[key]]); }
      return binds.length ? reg('fcl.' + k, binds) : null;
    };
    const preset = (n) => (em.getExpression(n) ? n : null);
    this.fb = {
      blinkL: preset('blinkLeft') || fcl('EYE_Close_L'), blinkR: preset('blinkRight') || fcl('EYE_Close_R'),
      lowerL: fcl('EYE_Joy_L'), lowerR: fcl('EYE_Joy_R'), wide: fcl('EYE_Surprised'),
      browUp: fcl('BRW_Surprised'), browSad: fcl('BRW_Sorrow'), browDown: fcl('BRW_Angry'),
      smile: fcl('MTH_Fun'), frown: fcl('MTH_Sorrow'), small: fcl('MTH_Small'), aa: preset('aa'), ou: preset('ou'), oh: preset('oh'), ee: preset('ee'), ih: preset('ih'),
    };
    // eyelid bones (some VRChat models): per-eye upper/lower lid offsets instead of shared shapes
    const lid = {}; vrm.scene.traverse((o) => {
      if (!o.isBone) return; const n = o.name.toLowerCase();
      if (!/lid|まぶた|瞼/.test(n)) return;
      const side = /(_|\.|\b)l(\b|_|$)|left|左/.test(n) ? 'L' : /(_|\.|\b)r(\b|_|$)|right|右/.test(n) ? 'R' : null; if (!side) return;
      const part = /low|下|bottom/.test(n) ? 'lower' : 'upper';
      lid[side + part] = { bone: o, rest: o.rotation.x };
    });
    this.lids = Object.keys(lid).length ? lid : null;
    const fbCan = new Set(['eyeBlinkLeft', 'eyeBlinkRight', 'eyeSquintLeft', 'eyeSquintRight', 'cheekSquintLeft', 'cheekSquintRight', 'eyeWideLeft', 'eyeWideRight', 'jawOpen',
      'browInnerUp', 'browDownLeft', 'browDownRight', 'browOuterUpLeft', 'browOuterUpRight', 'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel', 'mouthPucker', 'mouthStretchLeft', 'mouthStretchRight']);
    this.unmapped = ARKIT.filter((a) => !this.ps[a] && !(fbCan.has(a)) && !/^eyeLook/.test(a));
  }

  apply(vrm, dt) {
    const em = vrm.expressionManager; if (!em) return;
    this.install(vrm);
    const now = performance.now(), tgt = {};
    let live = 0;
    for (const [src, s] of this.sources) {
      if (now - s.at > 250) { this.sources.delete(src); continue; }
      live++;
      for (const [k, v] of Object.entries(s.scores)) { const x = v * s.w; if (x > (tgt[k] || 0)) tgt[k] = x; }
    }
    if (this.held && now < this.held.until) { live++; Object.assign(tgt, this.held.scores); } else this.held = null;
    // per-channel ONE-EURO filtering (tracker jitter gone when the face is still, no lag when it moves fast):
    // blinks get a high cutoff + strong speed term so they stay crisp; ?faceeuro=0 restores the old damped smoothing
    const sm = this.sm, FT = this.avatar.faceTune?.oneEuro || {}, useEuro = this._euroOn ??= new URLSearchParams(location.search).get('faceeuro') !== '0';
    const fe = (this.euro ||= new Map());
    for (const k of new Set([...Object.keys(tgt), ...Object.keys(sm)])) {
      const g = clamp01(tgt[k] || 0), c = sm[k] || 0;
      let v;
      if (useEuro) {
        const [mc, be] = BLINKS.has(k) ? (FT.blink || [6.0, 4.0]) : (FT.other || [2.2, 6.0]);
        let f = fe.get(k); if (!f) { f = new OneEuro(mc, be, 1.2); f.x = c; fe.set(k, f); } f.minCutoff = mc; f.beta = be;
        v = clamp01(f.filter(g, dt));
      } else {
        const lam = BLINKS.has(k) ? (g > c ? 55 : 35) : (g > c ? 28 : 18);
        v = c + (g - c) * (1 - Math.exp(-lam * dt));
      }
      if (v < 0.002 && g === 0) { delete sm[k]; fe.delete(k); } else sm[k] = v;
    }
    this.active = live > 0 || Object.keys(sm).length > 0;
    const S = (k) => (KID_SAFE_OFF.has(k) ? 0 : sm[k] || 0);
    const put = (name, v, mode = 'max') => { if (!name || !(v > 0.001)) return; const cur = em.getValue(name) || 0; em.setValue(name, clamp01(mode === 'max' ? Math.max(cur, v) : cur + v)); };
    // the jaw bone reads this (avatar.driveJaw): tracked jawOpen opens her real jaw
    this.avatar.arkJaw = S('jawOpen');
    if (this.perfect) {
      for (const a of ARKIT) if (this.ps[a]) em.setValue(this.ps[a], clamp01(S(a)));
    } else {
      const F = this.fb;
      put(F.blinkL, S('eyeBlinkLeft')); put(F.blinkR, S('eyeBlinkRight'));
      // lower lid per eye: squint plus a little of that side's cheek raise
      put(F.lowerL, Math.min(0.6, S('eyeSquintLeft') * 0.55 + S('cheekSquintLeft') * 0.3));
      put(F.lowerR, Math.min(0.6, S('eyeSquintRight') * 0.55 + S('cheekSquintRight') * 0.3));
      if (!this.lids) put(F.wide, (S('eyeWideLeft') + S('eyeWideRight')) * 0.5 * 0.8);
      put(F.browUp, Math.max((S('browOuterUpLeft') + S('browOuterUpRight')) * 0.5, S('browInnerUp') * 0.45));
      put(F.browSad, S('browInnerUp') * Math.max(0, 1 - (S('browOuterUpLeft') + S('browOuterUpRight'))) * 0.8);
      put(F.browDown, (S('browDownLeft') + S('browDownRight')) * 0.5);
      put(F.smile, (S('mouthSmileLeft') + S('mouthSmileRight')) * 0.5);
      put(F.frown, (S('mouthFrownLeft') + S('mouthFrownRight')) * 0.5);
      const talking = now < (this.avatar.talk?.until || 0);
      if (!talking) { put(F.ou, S('mouthFunnel') * 0.7); put(F.small, S('mouthPucker') * 0.6); put(F.aa, S('jawOpen') * 0.7); put(F.ee, (S('mouthStretchLeft') + S('mouthStretchRight')) * 0.25); }
    }
    // eyelid bones: per-eye upper lid (wide opens it, blink is the shape) and lower lid (squint raises it)
    if (this.lids) for (const s of ['L', 'R']) {
      const side = s === 'L' ? 'Left' : 'Right', u = this.lids[s + 'upper'], l = this.lids[s + 'lower'];
      if (u) u.bone.rotation.x = u.rest - S('eyeWide' + side) * 0.12;
      if (l) l.bone.rotation.x = l.rest - S('eyeSquint' + side) * 0.1;
    }
  }

  // what each feature is doing right now (dev panel meters, proof)
  state() {
    const S = (k) => +(this.sm[k] || 0).toFixed(2);
    return {
      targets: this.perfect ? 'perfect-sync shape keys' : 'fallback (nearest VRM/VRoid shapes' + (this.lids ? ' + eyelid bones' : '') + ')',
      perfectSyncKeys: Object.keys(this.ps || {}).length,
      left: { blink: S('eyeBlinkLeft'), upperLid: S('eyeWideLeft'), lowerLid: S('eyeSquintLeft'), cheek: S('cheekSquintLeft'), browDown: S('browDownLeft'), browOuter: S('browOuterUpLeft'), smile: S('mouthSmileLeft') },
      right: { blink: S('eyeBlinkRight'), upperLid: S('eyeWideRight'), lowerLid: S('eyeSquintRight'), cheek: S('cheekSquintRight'), browDown: S('browDownRight'), browOuter: S('browOuterUpRight'), smile: S('mouthSmileRight') },
      cheekPuff: S('cheekPuff'), jawOpen: S('jawOpen'), browInnerUp: S('browInnerUp'), funnel: S('mouthFunnel'), pucker: S('mouthPucker'),
      sources: [...this.sources.keys()].concat(this.held ? ['hold'] : []), unmapped: this.unmapped,
    };
  }
}
