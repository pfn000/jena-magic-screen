// Motion telemetry (Saidie, Oct 20 1:38 + 1:41 PM): so Jena can learn from every move she makes.
// - 120 Hz FIXED-TIMESTEP sampling, decoupled from the render rate: each rendered frame, every 1/120 s sample time
//   that passed is filled by slerping between the previous drawn pose and this one (a 60 fps screen gives one real +
//   one interpolated sample per frame); a render gap longer than 25 ms is counted as a frame drop and its samples are
//   flagged as interpolated across a drop.
// - Per sample: every humanoid bone rotation (quaternion, as DRAWN after joint limits + smoothing), root (hips)
//   position, expression / viseme weights and gaze (lookAt yaw/pitch).
// - Packed compactly: float16 for rotations/position/gaze, uint8 for expression weights, gzip (CompressionStream);
//   batches of 2-5 s (tuning.telemetry.batchSec) with timestamps, drop count, interpolated count, fps, jerk spikes,
//   joint-limit hits, loop detections and the clips that played. POSTed to /motion-log (a LOCAL stub: vite dev
//   middleware or scripts/motion-log-server.mjs; never the live gateway).
import * as THREE from 'three';

export const BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  ...['left', 'right'].flatMap((s) => ['Thumb', 'Index', 'Middle', 'Ring', 'Little'].flatMap((f) =>
    (f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal']).map((j) => s + f + j)))];
export const EXPR = ['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
const NB = BONES.length, FLOATS = NB * 4 + 3 + 2;   // quats + root xyz + gaze yaw/pitch

// float32 -> float16 bits
const _f = new Float32Array(1), _u = new Uint32Array(_f.buffer);
export function f16(v) {
  _f[0] = v; const x = _u[0], s = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
  if (e <= 0) { if (e < -10) return s; m |= 0x800000; return s | ((m >>> (1 - e + 13)) & 0x3ff); }
  if (e >= 31) return s | 0x7c00;
  return s | (e << 10) | ((m + 0x1000) >>> 13 & 0x3ff) + (((m + 0x1000) >>> 23) << 10) - 0 & 0xffff;
}

export class MotionTelemetry {
  constructor(avatar, tuning, { moves = null } = {}) {
    this.avatar = avatar; this.tuning = tuning; this.moves = moves;
    this.cfg = tuning?.get?.().telemetry || {}; tuning?.on?.((v) => { this.cfg = v.telemetry || {}; this.hz = this.cfg.hz || 120; this.loopCfg = v.antiLoop || {}; });
    this.hz = this.cfg.hz || 120; this.dtS = 1 / this.hz;
    const host = location.hostname, q = new URLSearchParams(location.search);
    const en = q.get('telemetry') ?? String(this.cfg.enabled ?? 'local');
    this.enabled = en === '1' || en === 'true' || (en === 'local' && (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')));
    this.reset();
    this.stats = { batches: 0, posted: 0, failed: 0, bytes: 0, samples: 0, drops: 0, interpolated: 0, jerkSpikes: 0, loops: 0, limitHits: 0 };
    this.prev = null; this.nextT = null; this.lastFrame = null;
    this.jerk = new Map(); this.poseHist = []; this.lastPoseCheck = 0;
    if (this.enabled) (avatar.frameHooks ||= []).push(() => this.onFrame());
  }
  reset() { this.buf = []; this.exprBuf = []; this.tBuf = []; this.flags = []; this.t0 = null; this.clips = []; this.spikes = []; this.loopHits = []; this.drops = 0; this.interp = 0; this.frames = 0; this.limit0 = this.avatar.polish?.stats?.clamps || 0; }
  // the pose as drawn this frame
  snap() {
    const a = this.avatar, vrm = a.vrm; if (!vrm) return null;
    const H = vrm.humanoid, drawn = a.polish?.drawn, q = new Float32Array(NB * 4);
    for (let i = 0; i < NB; i++) {
      const n = H.getNormalizedBoneNode(BONES[i]); const d = drawn?.get(BONES[i]);
      const src = d || n?.quaternion; if (src) { q[i * 4] = src.x; q[i * 4 + 1] = src.y; q[i * 4 + 2] = src.z; q[i * 4 + 3] = src.w; } else q[i * 4 + 3] = 1;
    }
    const hp = H.getNormalizedBoneNode('hips')?.position || { x: 0, y: 0, z: 0 };
    const em = vrm.expressionManager, ex = EXPR.map((k) => { try { return em?.getValue(k) || 0; } catch { return 0; } });
    const la = vrm.lookAt; const gaze = [la?.yaw || 0, la?.pitch || 0];
    return { t: performance.now() / 1000, q, root: [hp.x, hp.y, hp.z], ex, gaze };
  }
  onFrame() {
    const cur = this.snap(); if (!cur) return;
    const P = this.prev; this.prev = cur; this.frames++;
    const clip = window.jenaMoves?.playing?.c?.id; if (clip && this.clips[this.clips.length - 1] !== clip) this.clips.push(clip);
    if (!P) { this.nextT = cur.t; return; }
    const gap = cur.t - P.t; if (!(gap > 0)) return;
    const dropped = gap > 0.025; if (dropped) { this.drops++; this.stats.drops++; }
    if (gap > 1) { this.nextT = cur.t; this.jerk.clear(); return; }   // tab was hidden: start over, never fake a second of motion
    const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
    while (this.nextT <= cur.t + 1e-6) {
      const u = Math.min(1, Math.max(0, (this.nextT - P.t) / gap)), exact = Math.abs(this.nextT - cur.t) < 5e-4 || Math.abs(this.nextT - P.t) < 5e-4;
      const out = new Float32Array(FLOATS);
      for (let i = 0; i < NB; i++) {
        qa.fromArray(P.q, i * 4); qb.fromArray(cur.q, i * 4); if (qa.dot(qb) < 0) qb.set(-qb.x, -qb.y, -qb.z, -qb.w);
        qa.slerp(qb, u); out[i * 4] = qa.x; out[i * 4 + 1] = qa.y; out[i * 4 + 2] = qa.z; out[i * 4 + 3] = qa.w;
      }
      for (let k = 0; k < 3; k++) out[NB * 4 + k] = P.root[k] + (cur.root[k] - P.root[k]) * u;
      out[NB * 4 + 3] = P.gaze[0] + (cur.gaze[0] - P.gaze[0]) * u; out[NB * 4 + 4] = P.gaze[1] + (cur.gaze[1] - P.gaze[1]) * u;
      const ex = cur.ex.map((v, k) => P.ex[k] + (v - P.ex[k]) * u);
      if (this.t0 === null) this.t0 = this.nextT;
      this.buf.push(out); this.exprBuf.push(ex); this.tBuf.push(this.nextT); this.flags.push((exact ? 0 : 1) | (dropped ? 2 : 0));
      if (!exact) { this.interp++; this.stats.interpolated++; }
      this.stats.samples++;
      this.nextT += 1 / this.hz;
    }
    this.jerkCheck(cur.q, cur.t, gap);   // jerk from the real rendered frames (the interpolated samples would add fake kinks)
    this.loopCheck(cur);
    if (this.tBuf.length && this.tBuf[this.tBuf.length - 1] - this.t0 >= (this.cfg.batchSec || 4)) this.flush();
  }
  // per-bone angular jerk (rad/s^3) from consecutive 120 Hz samples; spikes over the tuning threshold are logged
  jerkCheck(q, t, h) {
    const thr = this.cfg.jerkSpike || 2500;
    for (let i = 0; i < NB; i++) {
      let J = this.jerk.get(i); if (!J) { J = { q: null, w: 0, a: 0, n: 0 }; this.jerk.set(i, J); }
      const x = q[i * 4], y = q[i * 4 + 1], z = q[i * 4 + 2], w = q[i * 4 + 3];
      if (J.q && h > 0.004) {
        const d = Math.min(1, Math.abs(J.q[0] * x + J.q[1] * y + J.q[2] * z + J.q[3] * w)); const om = 2 * Math.acos(d) / h; const al = (om - J.w) / h; const je = (al - J.a) / h;
        if (J.n > 3 && h < 0.05 && Math.abs(je) > thr) { this.spikes.push([BONES[i], +t.toFixed(3), Math.round(je)]); this.stats.jerkSpikes++; }
        J.w = om; J.a = al; J.n++;
      }
      J.q = [x, y, z, w];
    }
  }
  // loop detection: a 3 s window of key bones (4 Hz) that matches an earlier window (>5 s ago) almost exactly
  loopCheck(cur) {
    const L = this.loopCfg || this.tuning?.get?.().antiLoop || {}, win = L.poseWindowSec || 3;
    if (cur.t - this.lastPoseCheck < 0.25) return; this.lastPoseCheck = cur.t;
    const key = [0, 2, 5, 9, 10, 13, 14, 17, 21].map((i) => [cur.q[i * 4], cur.q[i * 4 + 1], cur.q[i * 4 + 2]]).flat();
    this.poseHist.push({ t: cur.t, key }); while (this.poseHist.length && cur.t - this.poseHist[0].t > 90) this.poseHist.shift();
    const n = Math.round(win * 4), H = this.poseHist; if (H.length < n * 3) return;
    const recent = H.slice(-n), thr = L.poseSimilarity || 0.012;
    for (let s = 0; s + n <= H.length - n - 20; s += 2) {
      let d = 0; for (let j = 0; j < n; j++) { const a = H[s + j].key, b = recent[j].key; for (let k = 0; k < a.length; k++) d += Math.abs(a[k] - b[k]); }
      d /= n * key.length;
      if (d < thr) { this.loopHits.push([+cur.t.toFixed(2), +H[s].t.toFixed(2), +d.toFixed(4)]); this.stats.loops++; break; }
    }
  }
  async pack() {
    const ns = this.buf.length, f = new Uint16Array(ns * FLOATS), e = new Uint8Array(ns * EXPR.length), fl = new Uint8Array(this.flags);
    for (let s = 0; s < ns; s++) { const o = this.buf[s]; for (let k = 0; k < FLOATS; k++) f[s * FLOATS + k] = f16(o[k]); const ex = this.exprBuf[s]; for (let k = 0; k < EXPR.length; k++) e[s * EXPR.length + k] = Math.round(Math.max(0, Math.min(1, ex[k])) * 255); }
    const raw = new Uint8Array(f.byteLength + e.byteLength + fl.byteLength); raw.set(new Uint8Array(f.buffer), 0); raw.set(e, f.byteLength); raw.set(fl, f.byteLength + e.byteLength);
    let body = raw, enc = 'raw';
    if (typeof CompressionStream !== 'undefined') { body = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); enc = 'gzip'; }
    let s = ''; for (let i = 0; i < body.length; i += 0x8000) s += String.fromCharCode.apply(null, body.subarray(i, i + 0x8000));
    return { enc, b64: btoa(s), rawBytes: raw.byteLength, bytes: body.byteLength };
  }
  async flush() {
    if (!this.buf.length) return;
    const meta = { kind: 'jena-motion', v: 1, hz: this.hz, t0: +this.t0.toFixed(4), t1: +this.tBuf[this.tBuf.length - 1].toFixed(4), samples: this.buf.length,
      frames: this.frames, fps: +(this.frames / Math.max(1e-3, this.tBuf[this.tBuf.length - 1] - this.t0)).toFixed(1), drops: this.drops, interpolated: this.interp,
      bones: BONES, expr: EXPR, layout: { float16: ['quat x,y,z,w per bone', 'root x,y,z', 'gaze yaw,pitch'], uint8: 'expression weights x255', flags: 'bit0 interpolated, bit1 across a frame drop' },
      clips: this.clips, jerkSpikes: this.spikes.slice(0, 200), jerkSpikeCount: this.spikes.length, limitHits: (this.avatar.polish?.stats?.clamps || 0) - this.limit0,
      loops: this.loopHits, avatar: this.avatar.vrm?.meta?.name || null, page: location.pathname, at: new Date().toISOString() };
    const fresh = { buf: this.buf, exprBuf: this.exprBuf, tBuf: this.tBuf, flags: this.flags };
    const keep = { t0: this.t0 };
    let packed;
    try { packed = await this.pack(); } catch (e) { console.warn('telemetry pack', e); }
    this.reset(); void fresh; void keep;
    this.stats.batches++; this.stats.limitHits += meta.limitHits; this.last = meta;
    if (!packed) return;
    meta.enc = packed.enc; meta.rawBytes = packed.rawBytes; meta.bytes = packed.bytes; this.stats.bytes += packed.bytes;
    (window.__jenaTelemetry ||= []).push(meta); if (window.__jenaTelemetry.length > 50) window.__jenaTelemetry.shift();
    try {
      const r = await fetch(this.cfg.endpoint || '/motion-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ meta, data: packed.b64 }) });
      if (r.ok) this.stats.posted++; else this.stats.failed++;
    } catch { this.stats.failed++; }
  }
}
