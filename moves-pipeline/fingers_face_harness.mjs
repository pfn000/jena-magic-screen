
// fingers + face proof harness: her REAL src/avatar.js face/finger code + src/moves.js on her REAL VRM, in Node.
import fs from 'node:fs';
const OUT = process.env.OUT || '/tmp/ff-proof.json';
globalThis.window = globalThis; globalThis.self = globalThis;
globalThis.location = new URL('http://jena.local/');
const store = {}; globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
let NOW = 0; globalThis.performance = { now: () => NOW };
const realNow = Date.now; let DNOW = realNow(); Date.now = () => DNOW;
globalThis.ResizeObserver = class { observe() {} };
const MOVES = process.env.MOVES || 'public/moves';
globalThis.fetch = async (u) => { const f = MOVES + '/' + String(u).split('/').pop(); const txt = fs.readFileSync(f, 'utf8'); return { ok: true, json: async () => JSON.parse(txt), text: async () => txt }; };
const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
const buf = fs.readFileSync(process.env.VRM || '/home/user/tab/files/jena-learn/track/vrm/notex.vrm');
const gltf = await new Promise((res, rej) => { const l = new GLTFLoader(); l.register((p) => new VRMLoaderPlugin(p)); l.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej); });
const vrm = gltf.userData.vrm, H = vrm.humanoid;
const { Avatar } = await import('../src/avatar.js');
const { Moves } = await import('../src/moves.js');
// her avatar without a GPU: the real class, real methods, real per-frame finger + face code (no renderer)
const av = Object.create(Avatar.prototype);
Object.assign(av, { vrm, mood: { name: 'neutral', weights: { neutral: 0, happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0 }, until: 0 },
  blink: { next: 0.5, t: -1, double: false }, talk: { until: 0, shape: 'aa', next: 0, text: '', t0: 0, ms: 0 },
  gesture: { left: { v: [0,0,0,0,0], t: [0,0,0,0,0], next: 0 }, right: { v: [0,0,0,0,0], t: [0,0,0,0,0], next: 0 } },
  micro: { name: null, w: 0, peak: 0, until: 0, next: 4 }, poseHooks: [], handHooks: [], faceHooks: [] });
const rig = av.checkRig(vrm);
const src = fs.readFileSync(new URL('../src/avatar.js', import.meta.url), 'utf8');
// the finger block of frame(): run exactly the site's code for HER fingers (extracted, so no renderer is needed)
const a0 = src.indexOf("      this.FN ||="), a1 = src.indexOf("      // learned moves with tracked fingers take over");
const body = src.slice(a0, a1);
const { _internals: { noise, damp } } = await import('../src/avatar.js');
const fingerFrame = new Function('noise', 'damp', 'A', 'set', 'add', 't', 'now', 'dt', body.replace(/\bthis\b/g, 'av')).bind(null);
const setB = (b, x, y, z) => { const n = H.getNormalizedBoneNode(b); if (n) n.rotation.set(x, y, z); };
const addB = (b, x, y, z) => { const n = H.getNormalizedBoneNode(b); if (n) { n.rotation.x += x; n.rotation.y += y; n.rotation.z += z; } };
globalThis.av = av;
av.act = { curl: { left: { v: 0.3, t: 0.3, until: 0 }, right: { v: 0.3, t: 0.3, until: 0 } } };
const moves = new Moves(av, { log: () => {} });
await moves.ready;
const dt = 1 / 30; let t = 0;
const step = () => {
  NOW += dt * 1000; DNOW += dt * 1000; t += dt;
  for (const n of Object.keys(H.normalizedHumanBones)) H.getNormalizedBoneNode(n)?.quaternion.identity();
  H.getNormalizedBoneNode('leftUpperArm').rotation.set(0, 0, -1.25); H.getNormalizedBoneNode('rightUpperArm').rotation.set(0, 0, 1.25);
  for (const f of av.poseHooks) f(vrm, dt);
  fingerFrame(noise, damp, av.act, setB, addB, t, NOW, dt);
  for (const f of av.handHooks) f(vrm, dt);
  av.updateFace(dt, t, NOW);
  for (const f of av.faceHooks) f(vrm, dt);
};
const snap = (label) => { const s = av.faceState(); return { label, t: +t.toFixed(2), ...s, playing: moves.playing?.c?.id || null }; };
const R = { rig, snaps: [] };
// 1) idle 8 s: blinks + finger drift
let blinks = 0, wasClosed = false, fMin = {}, fMax = {};
const track = () => { const s = av.faceState(); for (const [k, v] of Object.entries(s.fingers)) { fMin[k] = Math.min(fMin[k] ?? 9, v); fMax[k] = Math.max(fMax[k] ?? -9, v); } const c = (s.expressions.blink || 0) > 0.6; if (c && !wasClosed) blinks++; wasClosed = c; return s; };
for (let i = 0; i < 240; i++) { step(); track(); if (i === 30) R.snaps.push(snap('idle')); if ((av.blinkNow || 0) > 0.9 && !R.midBlink) R.midBlink = snap('mid-blink'); }
R.idle = { seconds: 8, blinks, fingerRange: Object.fromEntries(Object.keys(fMin).map((k) => [k, +(fMax[k] - fMin[k]).toFixed(3)])) };
// 2) talking 5 s with her words: visemes
av.talkFor('hi mama! look what I learned today, a whole new dance. want to see it?');
const vis = {}, shapes = {}; fMin = {}; fMax = {};
for (let i = 0; i < 150; i++) { step(); const s = track(); vis[s.viseme] = (vis[s.viseme] || 0) + 1; for (const k of ['aa', 'ih', 'ou', 'ee', 'oh']) if (s.expressions[k] > 0.25) shapes[k] = (shapes[k] || 0) + 1; if (i === 40) R.snaps.push(snap('talking')); }
R.talking = { visemeFrames: vis, mouthShapeFramesOver25pct: shapes, fingerRange: Object.fromEntries(Object.keys(fMin).map((k) => [k, +(fMax[k] - fMin[k]).toFixed(3)])) };
// 3) a learned whole-body move: tracked fingers + face
const id = process.env.CLIP || 'macarena';
moves.choose = () => moves.library.find((c) => c.id === id);
await moves.play('dance', 'happy', 'proof'); await new Promise((r) => setTimeout(r, 50));
const p = moves.playing; if (p) { p.start = 2; p.len = 8; p.rate = 1; }
fMin = {}; fMax = {}; const exMax = {};
for (let i = 0; i < 240 && moves.playing; i++) { step(); const s = track(); for (const [k, v] of Object.entries(s.expressions)) exMax[k] = Math.max(exMax[k] || 0, v); if (i === 60 || i === 120 || i === 180) R.snaps.push(snap('move ' + id)); }
R.move = { clip: id, hasFingers: !!p?.c?.fingers, hasFace: !!p?.c?.face, fingerRange: Object.fromEntries(Object.keys(fMin).map((k) => [k, +(fMax[k] - fMin[k]).toFixed(3)])), expressionPeaks: exMax, unmapped: [...(moves._unmapped || [])] };
// 4) no-repeat: 20 minutes of her choosing (a move every ~35-50 s, contexts as her autonomy uses them)
moves.choose = Moves.prototype.choose.bind(moves);
store['jena.moves.history'] = '[]'; moves._hist = [];
const ctx = ['idle', 'talk', 'happy', 'bored', 'dance', 'stretch'];
const seq = []; let clock = 0;
while (clock < 20 * 60000) { const c = moves.choose(ctx[Math.floor(Math.random() * ctx.length)], Math.random() < 0.5 ? 'happy' : 'neutral'); moves.rememberPlay(c.id); seq.push(c.id); const gap = 35000 + Math.random() * 15000; clock += gap; DNOW += gap; }
R.variety = { ...moves.variety(21 * 60000), sequence: seq };
fs.writeFileSync(OUT, JSON.stringify(R, null, 1));
console.log(JSON.stringify({ rig: R.rig, idle: R.idle, talking: R.talking, move: { ...R.move, fingerRange: undefined }, moveFingerRange: R.move.fingerRange, variety: { ...R.variety, sequence: R.variety.sequence.length } }));
process.exit(0);
