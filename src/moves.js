// Jena's learned moves. She "watches" short videos of real people moving (idle standing, talking with
// their hands, weight shifts, stretching, little dances), tracks their bodies with a pose model, and turns
// each one into her OWN animation clip: quaternion tracks for her humanoid bones plus a small hip offset
// (her feet stay planted; the leg IK keeps them on her floor). The clips live in /moves/ (index.json).
// Nobody picks these for her: she chooses a clip from her mood and what's going on, plays a different
// slice of it each time (start, length, speed, sometimes mirrored), and blends it over her procedural
// idle so her breathing and drift never stop. Left/right always mean HER left/right.
import * as THREE from 'three';
import { WatchVideo } from './watchvideo.js';
import { SelfCheck } from './selfcheck.js';

// Her clips were tracked from video at 15 fps, and a pose tracker shakes a little on every frame. Played
// back with plain frame-to-frame slerp, that shows as tiny kinks 15 times a second. On load each clip is
// (1) smoothed with a zero-phase Gaussian (forward and backward, so no lag; sigma ~1 source frame) to take
// out tracker jitter, then (2) resampled to 60 fps with Catmull-Rom curves (continuous velocity), so her
// motion is as smooth as the screen. Quaternions are kept in one hemisphere first so nothing flips.
export function resampleClip({ fps, frames, tracks, hips }, { outFps = 60, sigma = 1.0 } = {}) {
  if (!(fps > 0) || frames < 3 || fps >= outFps) return { fps, frames, tracks, hips };
  const R = Math.max(1, Math.ceil(sigma * 2.5)), K = [];
  for (let i = -R; i <= R; i++) K.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const smooth = (src, dim) => {
    const out = new Float32Array(src.length);
    for (let f = 0; f < frames; f++) {
      for (let d = 0; d < dim; d++) {
        let s = 0, ws = 0;
        for (let k = -R; k <= R; k++) { const g = Math.min(frames - 1, Math.max(0, f + k)); const w = K[k + R]; s += src[g * dim + d] * w; ws += w; }
        out[f * dim + d] = s / ws;
      }
    }
    return out;
  };
  const n = Math.max(2, Math.round((frames - 1) * outFps / fps) + 1);
  const cr = (src, dim, norm) => {
    const out = new Float32Array(n * dim);
    for (let o = 0; o < n; o++) {
      const f = o * (frames - 1) / (n - 1), i1 = Math.min(frames - 2, Math.floor(f)), t = f - i1;
      const i0 = Math.max(0, i1 - 1), i2 = i1 + 1, i3 = Math.min(frames - 1, i1 + 2);
      const t2 = t * t, t3 = t2 * t;
      let len = 0;
      for (let d = 0; d < dim; d++) {
        const p0 = src[i0 * dim + d], p1 = src[i1 * dim + d], p2 = src[i2 * dim + d], p3 = src[i3 * dim + d];
        const v = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
        out[o * dim + d] = v; len += v * v;
      }
      if (norm) { len = Math.sqrt(len) || 1; for (let d = 0; d < dim; d++) out[o * dim + d] /= len; }
    }
    return out;
  };
  const outTracks = {};
  for (const [b, tr] of Object.entries(tracks)) {
    const q = Float32Array.from(tr);
    for (let f = 1; f < frames; f++) { // same hemisphere as the previous frame
      let dot = 0; for (let d = 0; d < 4; d++) dot += q[f * 4 + d] * q[(f - 1) * 4 + d];
      if (dot < 0) for (let d = 0; d < 4; d++) q[f * 4 + d] = -q[f * 4 + d];
    }
    const s = smooth(q, 4);
    for (let f = 0; f < frames; f++) { let l = 0; for (let d = 0; d < 4; d++) l += s[f * 4 + d] ** 2; l = Math.sqrt(l) || 1; for (let d = 0; d < 4; d++) s[f * 4 + d] /= l; }
    outTracks[b] = cr(s, 4, true);
  }
  return { fps: (n - 1) * fps / (frames - 1), frames: n, tracks: outTracks, hips: hips ? cr(smooth(hips, 3), 3, false) : null, sourceFps: fps, sourceFrames: frames };
}

const BODY = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];
const ARMS = ['leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand'];
// how much of each bone the learned motion takes over (the rest stays her own procedural idle)
const WEIGHT = { hips: 0.75, spine: 0.85, chest: 0.85, upperChest: 0.85, neck: 0.55, head: 0.5,
  leftUpperArm: 0.92, leftLowerArm: 0.9, leftHand: 0.6, rightUpperArm: 0.92, rightLowerArm: 0.9, rightHand: 0.6 };
const MIRROR = (b) => b.startsWith('left') ? 'right' + b.slice(4) : b.startsWith('right') ? 'left' + b.slice(5) : b;
import { NoRepeat } from './nonrepeat.js';
// no bare random picks (Saidie: no loops): the final clip choice and her source captions go through NoRepeat
const CLIPS = new NoRepeat({ minGap: 4, windowMs: 120000 });
const LINES = new NoRepeat({ minGap: 2, windowMs: 60000 });
const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const [_v1, _v2, _v3, _v4, _v5, _v6, _v7, _v8] = Array.from({ length: 8 }, () => new THREE.Vector3());

export class Moves {
  constructor(avatar, { log = () => {}, base = '/moves/', boxBase = null, remember = null, card = null } = {}) {
    this.avatar = avatar;
    this.boxBase = boxBase; // moves she learned by herself on her box (served from ~/learned/moves)
    this.log = log;
    this.base = base;
    this.remember = remember; // optional (event) => void: her memory, when there is one
    this.card = card; // optional (trigger) => {step, done}: a thought-chain card (shows the video she learned from)
    this.shown = new Map(); // clip id -> when its source video was last shown
    this.watch = new WatchVideo(); // the real source video + her tracking on it, while she does the move
    this.guard = { left: 1, right: 1 };
    this._hipInv = new THREE.Matrix4(); this._chestInv = new THREE.Matrix4();
    this.library = [];
    this.cache = new Map();
    this.recent = [];
    this.playing = null;
    this.learnedLogged = false;
    (avatar.poseHooks ||= []).push((vrm, dt) => this.apply(vrm, dt));
    // fingers + face from clips tracked with hands and face (they run after her own finger/face life, so they win while the move plays)
    (avatar.handHooks ||= []).push((vrm) => this.applyHands(vrm));
    (avatar.faceHooks ||= []).push((vrm) => this.applyFace(vrm));
    this.ready = this.load();
    this.selfCheck = new SelfCheck(this, { log }); // she checks her own pose against the move and corrects it
  }

  async load() {
    try {
      const r = await fetch(this.base + 'index.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      this.library = (j.clips || []).filter((c) => c.file);
    } catch (e) { console.warn('moves: no library', e); this.library = []; }
    if (this.boxBase) {
      try {
        const b = await fetch(this.boxBase + 'index.json', { cache: 'no-cache' }).then((r) => r.json());
        this.boxLearned = b;
        for (const c of b.clips || []) if (c.file && !this.library.some((x) => x.id === c.id)) this.library.push({ ...c, base: this.boxBase });
      } catch (e) { this.boxLearned = { error: String(e.message || e) }; }
    }
    if (typeof window !== 'undefined') window.jenaMoves = this;
    return this.library.length;
  }

  async clip(meta) {
    if (this.cache.has(meta.id)) return this.cache.get(meta.id);
    const r = await fetch((meta.base || this.base) + meta.file);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const s = 1 / (j.scale || 1000);
    const tracks = {};
    for (const [b, arr] of Object.entries(j.bones)) tracks[b] = Float32Array.from(arr, (v) => v * s);
    const smooth = resampleClip({ fps: j.fps, frames: j.frames, tracks, hips: j.hips_offset ? Float32Array.from(j.hips_offset, (v) => v * s) : null });
    const clip = { ...meta, ...smooth };
    // whole-body clips (moves-pipeline/holistic.py): finger bends per hand + face expression weights, at the source fps
    if (j.fingers) clip.fingers = Object.fromEntries(Object.entries(j.fingers).map(([side, h]) => [side, { bend: Float32Array.from(h.bend, (v) => v / 1000), conf: Float32Array.from(h.conf, (v) => v / 100), dim: (j.finger_layout?.order || []).length || 17 }]));
    if (j.face) clip.face = { names: j.face.names, w: j.face.w.map((a) => Float32Array.from(a, (v) => v / 1000)), conf: Float32Array.from(j.face.conf, (v) => v / 100) };
    clip.srcFps = j.fps; clip.srcFrames = j.frames;
    if (j.sides === 'performer') clip.sides = 'performer';
    clip.tracking = j.tracking || null;
    if (j.metrics) clip.metrics = j.metrics; // the performer's body measurements per frame (her self-check targets)
    this.cache.set(meta.id, clip);
    return clip;
  }

  get busy() { return !!this.playing; }

  // her choice: which learned move fits right now. context: 'talk' | 'happy' | 'bored' | 'idle' | 'stretch'
  // Memory: what she played lately is kept in localStorage (survives reloads). A clip doesn't come back until
  // most of her library has played since; clips she has never done come first; mood/context only rank the fresh ones.
  history() {
    try { return JSON.parse(localStorage.getItem('jena.moves.history') || '[]'); } catch { return this._hist || []; }
  }
  // (named rememberPlay: the constructor's `remember` option, her memory, used to shadow a method called remember(),
  // so on the site the play history was never written and the no-repeat rule saw an empty history every time)
  rememberPlay(id) {
    const h = [{ id, at: Date.now() }, ...this.history().filter((x) => x && x.id)].slice(0, 200);
    this._hist = h;
    try { localStorage.setItem('jena.moves.history', JSON.stringify(h)); } catch {}
  }
  choose(context = 'idle', mood = 'neutral') {
    const want = {
      talk: ['talk'], happy: ['happy', 'dance', 'talk'], bored: ['stretch', 'dance', 'idle', 'weight'],
      stretch: ['stretch'], idle: ['idle', 'weight', 'talk', 'stretch'], dance: ['dance', 'happy'],
    }[context] || ['idle'];
    const lib = this.library;
    if (!lib.length) return null;
    const hist = this.history();
    const lastAt = new Map();
    for (const x of hist) if (!lastAt.has(x.id)) lastAt.set(x.id, x.at);
    // blocked: the clips played in the last ~75% of the library's worth of plays
    const block = new Set(hist.slice(0, Math.max(1, Math.ceil(lib.length * 0.75) - 1)).map((x) => x.id));
    const fresh = lib.filter((c) => !block.has(c.id));
    const fits = (c) => want.includes(c.kind);
    const moodOk = (c) => !mood || mood === 'neutral' || (c.moods || []).includes(mood);
    const tiers = [
      fresh.filter((c) => fits(c) && !lastAt.has(c.id) && moodOk(c)),
      fresh.filter((c) => fits(c) && !lastAt.has(c.id)),
      fresh.filter((c) => fits(c) && moodOk(c)),
      fresh.filter(fits),
      fresh.filter((c) => !lastAt.has(c.id)),
      fresh,
    ];
    // never the same move twice in a row (whatever tier it came from), unless she only knows one
    const prev = hist[0]?.id;
    let pool = tiers.map((t) => (lib.length > 1 ? t.filter((c) => c.id !== prev) : t)).find((t) => t.length);
    if (!pool) pool = [...lib].filter((c) => lib.length < 2 || c.id !== prev).sort((a, b) => (lastAt.get(a.id) || 0) - (lastAt.get(b.id) || 0)).slice(0, 1);
    // among the candidates, lean toward the ones done longest ago; whole-body ones (fingers + face) first on ties
    const whole = (c) => (c.has?.fingers ? 1 : 0) + (c.has?.face ? 1 : 0);
    pool = [...pool].sort((a, b) => (lastAt.get(a.id) || 0) - (lastAt.get(b.id) || 0) || whole(b) - whole(a)).slice(0, Math.max(1, Math.ceil(pool.length / 2)));
    const id = CLIPS.pick(pool.map((c) => c.id), { pool: context, prefer: undefined });
    return pool.find((c) => c.id === id) || pool[0];
  }

  // how varied her moves have been: plays in the window, distinct moves, back-to-back repeats, and how
  // much of her library she's been through (dev panel + tests read this)
  variety(windowMs = 20 * 60000) {
    const since = Date.now() - windowMs;
    const h = this.history().filter((x) => x.at >= since).reverse();
    let backToBack = 0;
    for (let i = 1; i < h.length; i++) if (h[i].id === h[i - 1].id) backToBack++;
    const counts = {};
    for (const x of h) counts[x.id] = (counts[x.id] || 0) + 1;
    const distinct = Object.keys(counts).length;
    return { windowMin: Math.round(windowMs / 60000), played: h.length, distinct, repeats: h.length - distinct, backToBack, library: this.library.length,
      coverage: this.library.length ? +(distinct / this.library.length).toFixed(2) : 0, maxPlaysOfOne: Math.max(0, ...Object.values(counts)),
      wholeBody: h.filter((x) => this.library.find((c) => c.id === x.id)?.has?.fingers).length };
  }

  // play a slice of a learned clip; never the same sequence twice (random window, speed, mirror)
  async play(context = 'idle', mood = 'neutral', why = '') {
    await this.ready;
    if (this.playing || !this.library.length) return false;
    const meta = this.choose(context, mood);
    if (!meta) return false;
    let c;
    try { c = await this.clip(meta); } catch (e) { console.warn('moves: clip failed', e); return false; }
    const dur = c.frames / c.fps;
    const len = Math.min(dur, Math.max(Math.min(6, dur), (meta.minSlice || 6) + Math.random() * 7));
    const start = Math.random() * Math.max(0, dur - len);
    const rate = 0.86 + Math.random() * 0.24;
    // a clip tracked with true sides (the performer's own left/right) plays left->left on her, never mirrored
    const mirror = c.sides !== 'performer' && meta.sides !== 'performer' && meta.mirror !== false && Math.random() < 0.4;
    this.guard = { left: 1, right: 1 };
    this.playing = { c, t: 0, start, len, rate, mirror, w: 0, fadeIn: 0.9, fadeOut: 1.1, began: Date.now() };
    this.rememberPlay(meta.id);
    this.recent = this.history().slice(0, 8).map((x) => x.id);
    if ((this.plays = (this.plays || 0) + 1) % 10 === 0) { try { console.log('jena move variety', JSON.stringify(this.variety())); } catch {} }
    const what = meta.what || 'someone moving';
    const lines = [
      `learned this from a video of ${what}, trying it`,
      `trying a move I picked up watching ${what}`,
      `copying ${what} from a video I studied, my own version`,
      `doing the thing I learned from a video of ${what}`,
    ];
    let line = LINES.pick(lines, { pool: 'move-caption' });
    if (mirror) line += ', mirrored so it starts on my other side';
    if (why) line += ` (${why})`;
    this.showSource(meta, line);
    if (this.remember) { try { this.remember({ type: 'move', clip: meta.id, what, source: meta.source?.url, mirror, rate: +rate.toFixed(2) }); } catch {} }
    return true;
  }


  // the video she learned it from, so anyone watching can see it too (thumbnail opens the video)
  showSource(meta, line) {
    const src = meta.source || {};
    const vid = /[?&]v=([\w-]{11})/.exec(src.url || '')?.[1];
    const last = this.shown.get(meta.id) || 0;
    if (!this.card || !vid || Date.now() - last < 10 * 60000) { this.log(line); return; }
    this.shown.set(meta.id, Date.now());
    try {
      const run = this.card({ user: 'Jena', source: 'a video I learned from', text: `"${(src.title || meta.what).slice(0, 90)}"${src.channel ? ` · ${src.channel}` : ''}`, thumb: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg` });
      const list = document.querySelector('.thought-list');
      const img = list?.lastElementChild?.querySelector('img.thumb');
      if (img) {
        const t = src.start != null ? `&t=${Math.floor(src.start)}s` : '';
        const a = document.createElement('a');
        a.href = `https://www.youtube.com/watch?v=${vid}${t}`; a.target = '_blank'; a.rel = 'noopener';
        a.title = 'the video Jena learned this move from';
        img.replaceWith(a); a.appendChild(img);
        // while she does it: the real video at its own frame rate, with the body she tracked drawn on it
        this.watch.play(a, meta, this.playing, (meta.base || this.base) + meta.id + '-overlay.json').catch(() => {});
      }
      run.step('body', line);
      run.done();
    } catch { this.log(line); }
  }


  // Her hands and forearms never go through her own body, and they stay away from her chest and the
  // front of her hips (a learned move that would put them there is eased back toward her own idle arm).
  keepClear(H, w, armBusy) {
    const hips = H.getNormalizedBoneNode('hips'), chest = H.getNormalizedBoneNode('upperChest') || H.getNormalizedBoneNode('chest');
    const lu = H.getNormalizedBoneNode('leftUpperArm'), ru = H.getNormalizedBoneNode('rightUpperArm'), neck = H.getNormalizedBoneNode('neck');
    if (!hips || !chest || !lu || !ru || !neck) return;
    H.normalizedHumanBonesRoot.updateMatrixWorld(true);
    const P = (n, v) => n.getWorldPosition(v);
    const sw = P(lu, _v1).distanceTo(P(ru, _v2));
    const a = sw * 0.36, b = a * 0.75; // torso half-width / half-depth
    const hipY = P(hips, _v1).y, neckY = P(neck, _v2).y;
    this._hipInv.copy(hips.matrixWorld).invert();
    this._chestInv.copy(chest.matrixWorld).invert();
    const bad = (p) => {
      const c = _v3.copy(p).applyMatrix4(this._chestInv), h = _v4.copy(p).applyMatrix4(this._hipInv);
      const y = p.y;
      // inside the torso (an elliptic column from below the hips up to the neck)
      if (y > hipY - 0.1 && y < neckY && (c.x / a) ** 2 + (c.z / b) ** 2 < 1) return true;
      // in front of her chest
      if (y > hipY + 0.55 * (neckY - hipY) && y < neckY - 0.03 && Math.abs(c.x) < a * 0.85 && c.z > b * 0.4 && c.z < b + 0.16) return true;
      // in front of her hips / lower belly
      if (h.y > -0.2 && h.y < 0.08 && Math.abs(h.x) < a * 1.2 && h.z > 0.015 && h.z < 0.24) return true;
      return false;
    };
    for (const side of ['left', 'right']) {
      if (armBusy[side]) { this.guard[side] = 1; continue; }
      const nodes = ['UpperArm', 'LowerArm', 'Hand'].map((s) => H.getNormalizedBoneNode(side + s));
      const [up, lo, hand] = nodes;
      if (!up || !lo || !hand) continue;
      const test = () => {
        hand.updateMatrixWorld(true);
        const hp = P(hand, _v5), lp = P(lo, _v6);
        const mid = _v7.copy(hp).lerp(lp, 0.5);
        const tip = _v8.copy(hp).sub(lp).multiplyScalar(0.45).add(hp);
        return bad(hp) || bad(mid) || bad(tip);
      };
      let k = this.guard[side];
      if (test()) {
        // back off toward her own arm until it's clear
        for (const f of [0.6, 0.3, 0]) {
          k = Math.min(k, f);
          ['UpperArm', 'LowerArm', 'Hand'].forEach((s, i) => {
            const bn = side + s, n = nodes[i];
            if (this._proc?.[bn] && this._clip?.[bn]) n.quaternion.copy(this._proc[bn]).slerp(this._clip[bn], w * (WEIGHT[bn] ?? 0.8) * k);
          });
          up.updateMatrixWorld(true);
          if (!test()) break;
        }
        // still in the way (her own idle arm sits close too): swing the arm out from her side until clear
        for (let s = 0; s < 4 && test(); s++) { up.rotateZ(side === 'left' ? 0.09 : -0.09); up.updateMatrixWorld(true); }
        this.guard[side] = k;
        this.guardHits = (this.guardHits || 0) + 1;
      } else {
        this.guard[side] = Math.min(1, k + 0.02); // ease back in once clear
      }
    }
  }

  stop() { if (this.playing) this.playing.stopAt = this.playing.t; }

  // source-frame sampling for the 15 fps finger/face tracks (linear between frames)
  _src(p) {
    const c = p.c, f = Math.max(0, Math.min((c.srcFrames || 1) - 1.001, (p.start + p.t) * (c.srcFps || 15)));
    const i = Math.floor(f); return { i, a: f - i };
  }

  // her fingers copy the performer's: 15 joint bends per hand (+ spread, thumb across the palm). Left = HER left.
  applyHands(vrm) {
    const p = this.playing;
    if (!p || !p.c.fingers || !(p.w > 0)) return;
    const H = vrm.humanoid, { i, a } = this._src(p);
    const A = this.avatar;
    for (const side of ['left', 'right']) {
      const h = p.c.fingers[side];
      if (!h) continue;
      if ((side === 'left' && A.wave?.side === 'left') || (side === 'right' && A.wave?.side === 'right')) continue;
      // joint limits: a finger never bends backwards past -3° or curls past 100° per joint (tracking noise on a
      // half-hidden hand otherwise flips a fingertip the wrong way)
      const d = h.dim, at = (k) => { const v = h.bend[i * d + k] * (1 - a) + h.bend[Math.min(h.bend.length / d - 1, i + 1) * d + k] * a; return k < 15 ? Math.max(-0.05, Math.min(1.75, v)) : v; };
      const conf = (h.conf[i] ?? 0) * (1 - a) + (h.conf[i + 1] ?? h.conf[i] ?? 0) * a;
      const w = Math.min(1, p.w * conf * 1.1);
      if (w < 0.02) continue;
      const sg = side === 'left' ? -1 : 1; // her left fingers point +x, so they curl with -z (same as her own finger code)
      const spread = at(15), opp = at(16);
      const sp = { Index: 1.0, Middle: 0.25, Ring: -0.45, Little: -1.0 };
      const set = (bone, x, y, z) => {
        const n = H.getNormalizedBoneNode(bone); if (!n) return;
        n.rotation.set(n.rotation.x + (x - n.rotation.x) * w, n.rotation.y + (y - n.rotation.y) * w, n.rotation.z + (z - n.rotation.z) * w);
      };
      // thumb: base swings across the palm (opposition), joints curl toward the palm
      set(`${side}ThumbMetacarpal`, 0, -sg * (at(0) * 0.55 + opp * 0.35), sg * (at(0) * 0.2 + opp * 0.15));
      set(`${side}ThumbProximal`, 0, -sg * at(1) * 0.85, sg * at(1) * 0.2);
      set(`${side}ThumbDistal`, 0, -sg * at(2) * 0.9, 0);
      let k = 3;
      for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
        set(`${side}${f}Proximal`, 0, -sg * spread * sp[f] * 0.35, sg * at(k));
        set(`${side}${f}Intermediate`, 0, 0, sg * at(k + 1));
        set(`${side}${f}Distal`, 0, 0, sg * at(k + 2));
        k += 3;
      }
    }
  }

  // her face copies the performer's: mouth shapes, brows, cheeks, winks, gaze (MediaPipe's 52 face blendshapes
  // mapped onto her VRM expressions). Her own blinking keeps going; a tracked wink adds to it.
  applyFace(vrm) {
    const p = this.playing, em = vrm.expressionManager;
    if (!p || !p.c.face || !em || !(p.w > 0)) return;
    const F = p.c.face, { i, a } = this._src(p);
    const conf = (F.conf[i] ?? 0) * (1 - a) + (F.conf[i + 1] ?? F.conf[i] ?? 0) * a;
    const w = Math.min(1, p.w * conf);
    if (w < 0.02) return;
    const talking = this.avatar.talk && performance.now() < this.avatar.talk.until;
    const have = this._exprNames ||= new Set(em.expressions.map((e) => e.expressionName));
    F.names.forEach((name, j) => {
      if (!have.has(name)) { (this._unmapped ||= new Set()).has(name) || (this._unmapped.add(name), console.warn('jena face: her model has no expression', name)); return; }
      if (talking && ['aa', 'ih', 'ou', 'ee', 'oh'].includes(name)) return; // her own voice drives her mouth while she talks
      const at = (jj) => F.w[jj][i] * (1 - a) + (F.w[jj][i + 1] ?? F.w[jj][i]) * a;
      let raw = at(j);
      // per-eye blinks: both eyes close together; only a little of one-eye-only stays (a tracked squint or camera
      // angle otherwise reads as a wink, and she doesn't wink)
      if (name === 'blinkLeft' || name === 'blinkRight') {
        const o = F.names.indexOf(name === 'blinkLeft' ? 'blinkRight' : 'blinkLeft');
        const both = o >= 0 ? Math.min(raw, at(o)) : raw;
        raw = both + (raw - both) * 0.25;
      }
      // performers' faces are subtle on camera; her anime face reads smiles, mouth and surprise a bit bigger
      // (gaze, blinks, frowns stay as tracked so she never looks cross)
      const v = /^(happy|relaxed|surprised|aa|ih|ou|ee|oh)$/.test(name) ? Math.min(1, raw * 1.6) : raw;
      const cur = em.getValue(name) || 0;
      em.setValue(name, name.startsWith('blink') ? Math.max(cur, v * w) : cur + (v - cur) * w * 0.9);
    });
  }

  // runs every frame after her procedural idle has set her bones and before the leg IK plants her feet
  apply(vrm, dt) {
    const p = this.playing;
    if (!p) return;
    p.t += dt * p.rate;
    const local = p.t;
    const end = p.stopAt != null ? Math.min(p.len, p.stopAt + p.fadeOut) : p.len;
    if (local >= end) { this.playing = null; return; }
    const w = smooth(local / p.fadeIn) * smooth((end - local) / p.fadeOut);
    p.w = w;
    const c = p.c, f = Math.min(c.frames - 1.001, (p.start + local) * c.fps);
    const i0 = Math.floor(f), a = f - i0, i1 = i0 + 1;
    const H = vrm.humanoid;
    const vrm0 = vrm.meta?.metaVersion === '0';
    const A = this.avatar;
    // when she has chosen her own arm gesture (wave, raised arm, hand on hip), her arms stay hers
    const armBusy = { left: false, right: false };
    if (A.wave) armBusy[A.wave.side] = true;
    if (A.handOnHip) armBusy[A.handOnHip.side] = true;
    if (A.target?.leftUpperArm && A.target.leftUpperArm[2] > -0.6) armBusy.left = true;
    if (A.target?.rightUpperArm && A.target.rightUpperArm[2] < 0.6) armBusy.right = true;
    for (const b of ARMS) { const n = H.getNormalizedBoneNode(b); if (n) (this._proc ||= {})[b] = (this._proc?.[b] || new THREE.Quaternion()).copy(n.quaternion); }
    for (const bone of [...BODY, ...ARMS]) {
      const src = p.mirror ? MIRROR(bone) : bone;
      const tr = c.tracks[src];
      if (!tr) continue;
      const side = bone.startsWith('left') ? 'left' : bone.startsWith('right') ? 'right' : null;
      if (side && armBusy[side]) continue;
      let node = H.getNormalizedBoneNode(bone);
      let tq = _qa.set(tr[i0 * 4], tr[i0 * 4 + 1], tr[i0 * 4 + 2], tr[i0 * 4 + 3]);
      _qb.set(tr[i1 * 4], tr[i1 * 4 + 1], tr[i1 * 4 + 2], tr[i1 * 4 + 3]);
      tq.slerp(_qb, a).normalize();
      if (p.mirror) tq.set(tq.x, -tq.y, -tq.z, tq.w); // reflect across her midline (x -> -x)
      if (vrm0) tq.set(-tq.x, tq.y, -tq.z, tq.w);
      if (!node && bone === 'upperChest') {
        node = H.getNormalizedBoneNode('chest'); // no upper chest on this body: fold it into the chest
        if (node) { _qc.copy(node.quaternion).multiply(tq); node.quaternion.copy(_qc); }
        continue;
      }
      if (!node) continue;
      if (!(this._clip ||= {})[bone]) this._clip[bone] = new THREE.Quaternion();
      this._clip[bone].copy(tq);
      node.quaternion.slerp(tq, w * (WEIGHT[bone] ?? 0.8) * (side ? this.guard[side] : 1));
    }
    this.keepClear(H, w, armBusy);
    // hips: travel over her planted feet the way the person's did (scaled to her legs, clamped)
    const hips = H.getNormalizedBoneNode('hips');
    if (c.hips && hips && A.hipsRest) {
      const o = c.hips;
      if (!this.legLen) {
        const lo = H.getNormalizedBoneNode('leftLowerLeg'), ft = H.getNormalizedBoneNode('leftFoot');
        this.legLen = lo && ft ? lo.position.length() + ft.position.length() : 0.75;
      }
      const k = this.legLen;
      let x = (o[i0 * 3] * (1 - a) + o[i1 * 3] * a) * k;
      const y = (o[i0 * 3 + 1] * (1 - a) + o[i1 * 3 + 1] * a) * k;
      let z = (o[i0 * 3 + 2] * (1 - a) + o[i1 * 3 + 2] * a) * k;
      if (p.mirror) x = -x;
      if (vrm0) { x = -x; z = -z; }
      const tx = A.hipsRest.x + THREE.MathUtils.clamp(x, -0.07, 0.07);
      const ty = A.hipsRest.y - 0.02 + THREE.MathUtils.clamp(y, -0.1, 0.0);
      const tz = A.hipsRest.z + THREE.MathUtils.clamp(z, -0.05, 0.05);
      const hw = w * 0.85;
      hips.position.set(hips.position.x + (tx - hips.position.x) * hw, hips.position.y + (ty - hips.position.y) * hw, hips.position.z + (tz - hips.position.z) * hw);
    }
  }
}

// Her memory: every learned move she performs is an event she can remember ("what were you just doing?").
// If her memory service is up (/api/memory on her site), it goes there; it's always on window.jenaMemoryLog
// and announced as a 'jena:memory' event for any other part of her that keeps memories.
let memoryUp = null;
export async function rememberMove(ev) {
  const entry = { kind: 'move', at: new Date().toISOString(), ...ev,
    text: `I did a move I learned from a video of ${ev.what}${ev.mirror ? ' (mirrored)' : ''}` };
  try { (window.jenaMemoryLog ||= []).push(entry); if (window.jenaMemoryLog.length > 200) window.jenaMemoryLog.shift(); } catch {}
  try { window.dispatchEvent(new CustomEvent('jena:memory', { detail: entry })); } catch {}
  if (memoryUp === false) return;
  try {
    const r = await fetch('/api/memory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'move', text: entry.text, data: entry }) });
    memoryUp = r.ok;
  } catch { memoryUp = false; }
}
