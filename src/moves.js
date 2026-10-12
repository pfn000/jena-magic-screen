// Jena's learned moves. She "watches" short videos of real people moving (idle standing, talking with
// their hands, weight shifts, stretching, little dances), tracks their bodies with a pose model, and turns
// each one into her OWN animation clip: quaternion tracks for her humanoid bones plus a small hip offset
// (her feet stay planted; the leg IK keeps them on her floor). The clips live in /moves/ (index.json).
// Nobody picks these for her: she chooses a clip from her mood and what's going on, plays a different
// slice of it each time (start, length, speed, sometimes mirrored), and blends it over her procedural
// idle so her breathing and drift never stop. Left/right always mean HER left/right.
import * as THREE from 'three';

const BODY = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];
const ARMS = ['leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand'];
// how much of each bone the learned motion takes over (the rest stays her own procedural idle)
const WEIGHT = { hips: 0.75, spine: 0.85, chest: 0.85, upperChest: 0.85, neck: 0.55, head: 0.5,
  leftUpperArm: 0.92, leftLowerArm: 0.9, leftHand: 0.6, rightUpperArm: 0.92, rightLowerArm: 0.9, rightHand: 0.6 };
const MIRROR = (b) => b.startsWith('left') ? 'right' + b.slice(4) : b.startsWith('right') ? 'left' + b.slice(5) : b;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();

export class Moves {
  constructor(avatar, { log = () => {}, base = '/moves/', remember = null } = {}) {
    this.avatar = avatar;
    this.log = log;
    this.base = base;
    this.remember = remember; // optional (event) => void: her memory, when there is one
    this.library = [];
    this.cache = new Map();
    this.recent = [];
    this.playing = null;
    this.learnedLogged = false;
    (avatar.poseHooks ||= []).push((vrm, dt) => this.apply(vrm, dt));
    this.ready = this.load();
  }

  async load() {
    try {
      const r = await fetch(this.base + 'index.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      this.library = (j.clips || []).filter((c) => c.file);
    } catch (e) { console.warn('moves: no library', e); this.library = []; }
    if (typeof window !== 'undefined') window.jenaMoves = this;
    return this.library.length;
  }

  async clip(meta) {
    if (this.cache.has(meta.id)) return this.cache.get(meta.id);
    const r = await fetch(this.base + meta.file);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const s = 1 / (j.scale || 1000);
    const tracks = {};
    for (const [b, arr] of Object.entries(j.bones)) tracks[b] = Float32Array.from(arr, (v) => v * s);
    const clip = { ...meta, fps: j.fps, frames: j.frames, tracks, hips: j.hips_offset ? Float32Array.from(j.hips_offset, (v) => v * s) : null };
    this.cache.set(meta.id, clip);
    return clip;
  }

  get busy() { return !!this.playing; }

  // her choice: which learned move fits right now. context: 'talk' | 'happy' | 'bored' | 'idle' | 'stretch'
  choose(context = 'idle', mood = 'neutral') {
    const want = {
      talk: ['talk'], happy: ['happy', 'dance', 'talk'], bored: ['stretch', 'dance', 'idle', 'weight'],
      stretch: ['stretch'], idle: ['idle', 'weight', 'talk', 'stretch'], dance: ['dance', 'happy'],
    }[context] || ['idle'];
    let pool = this.library.filter((c) => want.includes(c.kind) && !this.recent.includes(c.id));
    if (mood && mood !== 'neutral') {
      const m = pool.filter((c) => (c.moods || []).includes(mood));
      if (m.length) pool = m;
    }
    if (!pool.length) pool = this.library.filter((c) => !this.recent.includes(c.id));
    if (!pool.length) pool = this.library;
    return pool.length ? pick(pool) : null;
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
    const mirror = meta.mirror !== false && Math.random() < 0.4;
    this.playing = { c, t: 0, start, len, rate, mirror, w: 0, fadeIn: 0.9, fadeOut: 1.1, began: Date.now() };
    this.recent = [meta.id, ...this.recent].slice(0, Math.min(4, Math.max(1, this.library.length - 2)));
    const what = meta.what || 'someone moving';
    const lines = [
      `learned this from a video of ${what}, trying it`,
      `trying a move I picked up watching ${what}`,
      `copying ${what} from a video I studied, my own version`,
      `doing the thing I learned from a video of ${what}`,
    ];
    let line = pick(lines);
    if (mirror) line += ', mirrored so it starts on my other side';
    if (why) line += ` (${why})`;
    this.log(line);
    if (this.remember) { try { this.remember({ type: 'move', clip: meta.id, what, source: meta.source?.url, mirror, rate: +rate.toFixed(2) }); } catch {} }
    return true;
  }

  stop() { if (this.playing) this.playing.stopAt = this.playing.t; }

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
      node.quaternion.slerp(tq, w * (WEIGHT[bone] ?? 0.8));
    }
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
