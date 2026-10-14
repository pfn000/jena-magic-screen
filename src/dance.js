// K-pop dance (Saidie, Oct 13 10:34 PM): Jena dances clean choreography she learned from dance-practice videos.
// The clips are keypoint JSON only (ANIMATIONS/dance/kpop/*.json, tracked on GitHub Actions by jena-track.yml;
// sources + credits in ANIMATIONS/dance/kpop/README.md). Each clip carries the performer's bones with the turn taken
// OUT (moves-pipeline/dance_facing.py) and the turn itself as its own track (facing.yaw, from the hip/shoulder line
// every frame, incl. torso twist in the spine bones). Here:
//  * bones blend onto her body (her feet stay on her own floor: the leg IK + 6 cm cross cap in avatar.updateFeet)
//  * facing: when the dancer turns, Jena turns by the same amount relative to HER start facing; her feet pivot under
//    her (avatar.danceYaw feeds the same pivot as a spin). Performer's left = Jena's left (no runtime mirror;
//    mirrored practice videos were un-mirrored before tracking).
//  * kid-safe: hips tilt from the clip is damped (no hip-focused motion) and the build step trims any body-roll window.
//  * no loops: clips and their start points come from NoRepeat; one dance = 1-3 slices crossfaded, random speed.
import * as THREE from 'three';
import { NoRepeat } from './nonrepeat.js';

const URLS = import.meta.glob('../ANIMATIONS/dance/kpop/*.json', { query: '?url', import: 'default', eager: true });
const BODY = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];
const ARMS = ['leftShoulder', 'rightShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand'];
// shoulders take only half the dancer's shrug (Saidie, Oct 14: "relax" — shoulders down, not hiked up)
const WEIGHT = { hips: 0.45, spine: 0.8, chest: 0.85, upperChest: 0.85, neck: 0.6, head: 0.55, leftShoulder: 0.45, rightShoulder: 0.45 };
const HIPS_TILT_MAX = 0.12;   // rad: the clip's hip pitch/roll is clamped here (no hip-focused moves)
const PICK = new NoRepeat({ minGap: 2, windowMs: 10 * 60000 });
const SEG = new NoRepeat({ minGap: 3, windowMs: 20 * 60000 });
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(), _y = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0);
const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

export class Dance {
  constructor(avatar, { log = () => {} } = {}) {
    this.avatar = avatar; this.log = log; this.cache = new Map(); this.players = []; this.trace = [];
    this.list = Object.entries(URLS).map(([p, url]) => ({ id: p.split('/').pop().replace(/\.json$/, ''), url }));
    (avatar.poseHooks ||= []).push((vrm, dt) => this.apply(vrm, dt));
    if (typeof window !== 'undefined') window.jenaDance = this;
  }
  get active() { return this.players.length > 0; }
  get ids() { return this.list.map((x) => x.id); }
  async clip(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const m = this.list.find((x) => x.id === id); if (!m) throw new Error('no dance ' + id);
    const j = await fetch(m.url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    const s = 1 / (j.scale || 1000), tracks = {};
    for (const [b, arr] of Object.entries(j.bones)) tracks[b] = Float32Array.from(arr, (v) => v * s);
    const fy = j.facing?.yaw ? Float32Array.from(j.facing.yaw, (v) => THREE.MathUtils.degToRad(v / (j.facing.scale || 10))) : null;
    const hips = j.hips_offset ? Float32Array.from(j.hips_offset, (v) => v * s) : null;
    const c = { id, fps: j.fps, frames: j.frames, tracks, yaw: fy, hips, meta: j.learned_from || {}, dance: j.dance || {}, cuts: j.kid_safe?.keep || null };
    this.cache.set(id, c); return c;
  }
  // start a dance: 1-3 slices from the library (or a named clip), crossfaded; resolves to what she is dancing
  async start({ id = null, slices = 1 + Math.floor(Math.random() * 3), why = 'asked', at = null, len = null, rate = null } = {}) {
    if (!this.list.length) return null;
    if (this.active) this.stop();
    const A = this.avatar; if (A.spinState) A.spinState = null; A.handOnHip = null; A.wave = null;   // the dance owns her arms
    this.queue = [];
    for (let k = 0; k < slices; k++) this.queue.push(id && k === 0 ? id : PICK.pick(this.ids, { pool: 'dance' }));
    this.why = why; this.t0 = performance.now(); this.trace = []; this.yawNow = 0; this.startFacing = null;
    this.pin = at != null ? { at, len, rate } : null;   // a test can pin the first slice to a clip time
    this.handStats = { frames: 0, frontFrames: 0, minSide: { left: Infinity, right: Infinity }, worst: null };
    await this.next(true);
    this.pin = null;
    const p = this.players[this.players.length - 1];
    try { const L = (window.jenaLog ||= []); L.push({ t: Math.round(performance.now()), kind: 'dance', what: this.queue.join('+') || p?.c.id, why }); } catch {}
    return p ? { id: p.c.id, song: p.c.dance.song, artist: p.c.dance.artist, slices: 1 + this.queue.length } : null;
  }
  async next(first = false) {
    const id = this.queue.shift(); if (!id) return null;
    let c; try { c = await this.clip(id); } catch (e) { console.warn('dance clip', e); return null; }
    // only the kid-safe stretches of the clip (the build step dropped body-roll / hip-focused windows)
    const segs = (c.cuts && c.cuts.length ? c.cuts : [[0, c.frames / c.fps]]).filter((g) => g[1] - g[0] >= 3);
    const seg = segs[Math.floor(Math.random() * segs.length)] || [0, c.frames / c.fps];
    const dur = seg[1] - seg[0];
    const len = Math.min(dur, 5 + Math.random() * Math.max(0, dur - 5));
    // start point: one of ~6 bins, never the same bin twice in a row for this clip
    const bins = 6, bin = SEG.pick([...Array(bins).keys()].map((b) => id + ':' + b), { pool: 'dance-seg:' + id });
    const start = seg[0] + (Number(String(bin).split(':')[1]) / bins) * Math.max(0, dur - len);
    let rate = 0.92 + Math.random() * 0.14;
    if (first && this.pin) {   // pinned (tests only): start right at that clip time, clamped inside a kid-safe stretch
      const g = segs.find((q) => this.pin.at >= q[0] && this.pin.at < q[1]) || seg;
      const st = Math.max(g[0], Math.min(this.pin.at, g[1] - 1));
      const ln = Math.min(this.pin.len || 8, g[1] - st);
      if (this.pin.rate) rate = this.pin.rate;
      return this._push(c, id, st, ln, rate, first);
    }
    return this._push(c, id, start, len, rate, first);
  }
  _push(c, id, start, len, rate, first) {
    const yaw0 = c.yaw ? c.yaw[Math.min(c.frames - 1, Math.floor(start * c.fps))] : 0;
    const p = { c, t: 0, start, len, rate, yaw0, base: this.yawNow || 0, fadeIn: first ? 0.7 : 0.55, fadeOut: 0.55, w: 0 };
    this.players.push(p);
    this.log(`dancing ${c.dance.song || id}${c.dance.artist ? ' (' + c.dance.artist + ')' : ''}`);
    return p;
  }
  stop() { for (const p of this.players) p.stopAt = Math.min(p.len, p.t + p.fadeOut); this.queue = []; }
  sample(tr, f) { const i0 = Math.floor(f), a = f - i0, i1 = i0 + 1; _q.set(tr[i0 * 4], tr[i0 * 4 + 1], tr[i0 * 4 + 2], tr[i0 * 4 + 3]); _q2.set(tr[i1 * 4], tr[i1 * 4 + 1], tr[i1 * 4 + 2], tr[i1 * 4 + 3]); return _q.slerp(_q2, a).normalize(); }
  // per-frame hand log for proofs: how far each hand stays out to her side, and any frame a hand sat in front of her hips
  measure(H, MV) {
    const z = MV.handZone?.(H); if (!z) return;
    const S = (this.handStats ||= { frames: 0, frontFrames: 0, minSide: { left: Infinity, right: Infinity }, worst: null });
    S.frames++;
    for (const side of ['left', 'right']) {
      const h = z[side]; if (!h) continue;
      // only a hand at hip height counts for the side gap (a raised hand is nowhere near her hips)
      if (h.palm.y < 0.16 && h.palm.y > -0.32) S.minSide[side] = Math.min(S.minSide[side], h.palm.x - h.hipHalf);
      (S.minClear ||= { left: Infinity, right: Infinity })[side] = Math.min(S.minClear[side], h.hipClear ?? Infinity);
      if (h.seat) S.seatFrames = (S.seatFrames || 0) + 1;
      if (h.frontCenter) { S.frontFrames++; S.worst = { side, t: Math.round(performance.now() - this.t0), ...h }; }
    }
    this.lastZone = z;
  }
  // Whole-clip audit (tests): poses her at every frame of a clip at full weight, with and without the keep-clear guard,
  // and reports where each hand lands against her hips. Synchronous, so the render loop never sees the test poses.
  scan(id) {
    const c = this.cache.get(id); const A = this.avatar, vrm = A.vrm, H = vrm.humanoid, MV = window.jenaMoves;
    if (!c || !MV) return null;
    const vrm0 = vrm.meta?.metaVersion === '0';
    const names = [...BODY, ...ARMS].filter((b) => H.getNormalizedBoneNode(b));
    const save = Object.fromEntries(names.map((b) => [b, H.getNormalizedBoneNode(b).quaternion.clone()]));
    const keep = (c.cuts && c.cuts.length ? c.cuts : [[0, c.frames / c.fps]]);
    const res = { id, frames: 0, raw: { front: 0, worst: null }, guarded: { front: 0, worst: null, minSide: { left: Infinity, right: Infinity } } };
    const guardSave = MV.guard ? { ...MV.guard } : null;
    for (let i = 0; i < c.frames - 1; i++) {
      const t = i / c.fps; if (!keep.some((g) => t >= g[0] && t < g[1])) continue;
      res.frames++;
      for (const pass of ['raw', 'guarded']) {
        for (const b of names) H.getNormalizedBoneNode(b).quaternion.copy(save[b]);
        MV._proc ||= {}; MV._clip ||= {}; MV.guard = { left: 1, right: 1 };
        for (const b of ARMS) { const n = H.getNormalizedBoneNode(b); if (n) (MV._proc[b] ||= new THREE.Quaternion()).copy(n.quaternion); }
        for (const bone of [...BODY, ...ARMS]) {
          const tr = c.tracks[bone]; if (!tr) continue;
          let node = H.getNormalizedBoneNode(bone);
          const tq = this.sample(tr, i);
          if (vrm0) tq.set(-tq.x, tq.y, -tq.z, tq.w);
          if (bone === 'hips') { _e.setFromQuaternion(tq, 'YXZ'); _e.x = THREE.MathUtils.clamp(_e.x, -HIPS_TILT_MAX, HIPS_TILT_MAX); _e.z = THREE.MathUtils.clamp(_e.z, -HIPS_TILT_MAX, HIPS_TILT_MAX); _e.y *= 0.5; tq.setFromEuler(_e); }
          if (!node && bone === 'upperChest') { node = H.getNormalizedBoneNode('chest'); if (node) node.quaternion.multiply(_q2.identity().slerp(tq, 0.5)); continue; }
          if (!node) continue;
          if (ARMS.includes(bone)) (MV._clip[bone] ||= new THREE.Quaternion()).copy(tq);
          node.quaternion.slerp(tq, WEIGHT[bone] ?? 0.85);
        }
        if (pass === 'guarded') { MV.keepClear(H, 1, { left: false, right: false }); MV.keepClear(H, 1, { left: false, right: false }); }
        const z = MV.handZone(H); if (!z) continue;
        const R = res[pass];
        for (const side of ['left', 'right']) {
          const h = z[side]; if (!h) continue;
          if (h.seat) R.seat = (R.seat || 0) + 1;
          if (pass === 'guarded') { (R.minClear ||= { left: Infinity, right: Infinity })[side] = Math.min(R.minClear[side], h.hipClear ?? Infinity); if (h.hipClear < 0.03) R.near = (R.near || 0) + 1; }
          if (pass === 'guarded' && h.palm.y < 0.16 && h.palm.y > -0.32) { const g = h.palm.x - h.hipHalf; if (g < R.minSide[side]) { R.minSide[side] = g; (R.nearest ||= {})[side] = { t: +t.toFixed(2), palm: h.palm, wrist: h.wrist }; } }
          if (h.frontCenter) { R.front++; const sc = -h.palm.x + h.palm.z; if (!R.worst || sc > R.worst.score) R.worst = { t: +t.toFixed(2), side, score: sc, palm: h.palm, wrist: h.wrist, hipHalf: h.hipHalf }; }
        }
      }
    }
    for (const b of names) H.getNormalizedBoneNode(b).quaternion.copy(save[b]);
    if (guardSave) MV.guard = guardSave;
    H.normalizedHumanBonesRoot.updateMatrixWorld(true);
    return res;
  }
  apply(vrm, dt) {
    const A = this.avatar;
    if (!this.players.length) { if (A.danceYaw) { A.danceYaw = 0; A.dancing = false; } return; }
    const H = vrm.humanoid, vrm0 = vrm.meta?.metaVersion === '0';
    A.dancing = true;
    let yaw = 0, wsum = 0;
    for (const p of [...this.players]) {
      p.t += dt * p.rate;
      const end = p.stopAt != null ? p.stopAt : p.len;
      if (p.t >= end) { this.players.splice(this.players.indexOf(p), 1); continue; }
      // crossfade: the next slice starts while this one fades out
      if (!p.handed && p.stopAt == null && p.t > p.len - p.fadeOut && this.queue.length) { p.handed = true; this.next(); }
      const w = ease(p.t / p.fadeIn) * ease((end - p.t) / p.fadeOut); p.w = w;
      const c = p.c, f = Math.min(c.frames - 1.001, (p.start + p.t) * c.fps);
      // her own arm pose before the dance blends in: the keep-clear guard (src/moves.js) eases a hand back toward it
      // whenever the dance would put it through her body, on her chest or in front of her hips
      const MV = window.jenaMoves;
      if (MV) { MV._proc ||= {}; MV._clip ||= {}; MV.guard ||= { left: 1, right: 1 }; for (const b of ARMS) { const n = H.getNormalizedBoneNode(b); if (n) (MV._proc[b] ||= new THREE.Quaternion()).copy(n.quaternion); } }
      for (const bone of [...BODY, ...ARMS]) {
        const tr = c.tracks[bone]; if (!tr) continue;
        let node = H.getNormalizedBoneNode(bone);
        const tq = this.sample(tr, f);
        if (vrm0) tq.set(-tq.x, tq.y, -tq.z, tq.w);
        if (bone === 'hips') {   // kid-safe: keep only a little of the clip's hip pitch/roll
          _e.setFromQuaternion(tq, 'YXZ'); _e.x = THREE.MathUtils.clamp(_e.x, -HIPS_TILT_MAX, HIPS_TILT_MAX); _e.z = THREE.MathUtils.clamp(_e.z, -HIPS_TILT_MAX, HIPS_TILT_MAX); _e.y *= 0.5; tq.setFromEuler(_e);
        }
        if (!node && bone === 'upperChest') { node = H.getNormalizedBoneNode('chest'); if (node) node.quaternion.multiply(_q2.identity().slerp(tq, 0.5 * w)); continue; }
        if (!node) continue;
        if (MV && ARMS.includes(bone)) (MV._clip[bone] ||= new THREE.Quaternion()).copy(tq);
        const side = bone.startsWith('left') ? 'left' : bone.startsWith('right') ? 'right' : null;
        node.quaternion.slerp(tq, w * (WEIGHT[bone] ?? 0.85) * (side && MV ? MV.guard[side] : 1));
      }
      // hips travel: the dancer's bounce (down only: knees bend, feet stay planted) and a little side shift
      const hips = H.getNormalizedBoneNode('hips');
      if (c.hips && hips && A.hipsRest) {
        const o = c.hips, i0 = Math.floor(f), a = f - i0, i1 = i0 + 1;
        const k = A.legLen?.left || 0.75;
        const x = (o[i0 * 3] * (1 - a) + o[i1 * 3] * a) * k, y = (o[i0 * 3 + 1] * (1 - a) + o[i1 * 3 + 1] * a) * k;
        const tx = A.hipsRest.x + THREE.MathUtils.clamp(vrm0 ? -x : x, -0.06, 0.06), ty = A.hipsRest.y - 0.03 + THREE.MathUtils.clamp(y, -0.12, 0);
        hips.position.x += (tx - hips.position.x) * w * 0.8; hips.position.y += (ty - hips.position.y) * w * 0.8;
      }
      if (c.yaw) {
        const fi = Math.min(c.frames - 1, Math.floor(f)), fa = f - fi, fj = Math.min(c.frames - 1, fi + 1);
        const vy = c.yaw[fi] * (1 - fa) + c.yaw[fj] * fa - p.yaw0;   // how far the dancer has turned since this slice began
        p.vy = vy; yaw += (p.base + vy) * w; wsum += w;
      }
    }
    // final word on her hands (Saidie, Oct 14: Jena is a minor; no hand ever rests on the front of her hips, crotch or
    // chest in a dance): after every slice has blended, one more keep-clear pass on the finished pose, then measure
    const MVf = window.jenaMoves;
    if (this.players.length) {
      // relaxed: shoulders settle a touch lower and the elbows keep a soft bend, so the arms hang loose and swing
      const wl = Math.min(1, this.players.reduce((m, p) => Math.max(m, p.w || 0), 0));
      for (const [bn, sg] of [['leftShoulder', -1], ['rightShoulder', 1]]) { const n = H.getNormalizedBoneNode(bn); if (n) n.rotateZ(sg * 0.06 * wl); }
      for (const [bn, sg] of [['leftLowerArm', -1], ['rightLowerArm', 1]]) {
        const n = H.getNormalizedBoneNode(bn); if (!n) continue;
        _e.setFromQuaternion(n.quaternion, 'YXZ'); const bend = Math.abs(_e.y);
        if (bend < 0.3) n.rotateY(sg * (0.3 - bend) * wl);   // a locked-straight elbow gets a little bend
      }
    }
    if (MVf?.keepClear && this.players.length) {
      try { MVf.keepClear(H, 1, { left: false, right: false }); } catch {}
      try { this.measure(H, MVf); } catch {}
    }
    // facing: Jena turns by the dancer's turn from her start facing; when the dance ends she settles to the nearest
    // full turn (a 350° turn finishes at 360, not back through 350°)
    const target = wsum > 1e-3 ? yaw / wsum : 0;
    const settle = Math.round(target / (Math.PI * 2)) * Math.PI * 2;
    const live = Math.min(1, wsum);
    this.yawNow = target;
    let dy = target * live + settle * (1 - live);
    if (!this.players.length) { this.yawNow = 0; dy = 0; }
    A.danceYaw = dy;
    const hips = H.getNormalizedBoneNode('hips');
    if (hips && dy) { _y.setFromAxisAngle(_Y, dy); hips.quaternion.premultiply(_y); }
    if (this.players.length && performance.now() - (this._tr || 0) > 100) {
      this._tr = performance.now();
      let jy = null; try { const fc = window.jena?.facing?.(); jy = fc?.hips?.yaw ?? null; } catch {}
      if (this.startFacing == null && jy != null) this.startFacing = jy;
      const vid = Math.round(THREE.MathUtils.radToDeg(target)), jr = jy == null ? null : Math.round(((jy - this.startFacing + 540) % 360) - 180);
      this.trace.push({ t: Math.round(performance.now() - this.t0), clip: this.players[0]?.c.id, video: vid, jena: jr });
      if (this.trace.length > 2000) this.trace.shift();
    }
  }
}
