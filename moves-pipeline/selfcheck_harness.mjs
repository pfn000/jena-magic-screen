// Self-check harness: runs Jena's REAL site code (src/moves.js + src/selfcheck.js) on her REAL VRM, in Node, no browser.
// usage (from the repo): node moves-pipeline/selfcheck_harness.mjs <clipdir> <clipId> [offtest] [seconds]
import fs from 'node:fs';
const [clipDir, clipId, mode = 'normal', secs = '8'] = process.argv.slice(2);
globalThis.window = globalThis;
globalThis.location = new URL('http://jena.local/' + (mode === 'offtest' ? '?selfcheck=offtest' : ''));
const store = {}; globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
globalThis.self = globalThis;
globalThis.fetch = async (u) => {
  const p = String(u);
  if (p.endsWith('/moves/index.json')) return { ok: true, json: async () => ({ clips: [{ id: clipId, file: clipId + '.clip.json', kind: 'dance', sides: 'performer', what: clipId }] }) };
  const f = clipDir + '/' + p.split('/').pop();
  const txt = fs.readFileSync(f, 'utf8');
  return { ok: true, json: async () => JSON.parse(txt), text: async () => txt };
};
const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
const buf = fs.readFileSync(process.env.VRM || '/home/user/tab/files/jena-learn/track/vrm/notex.vrm');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const loader = new GLTFLoader(); loader.register((p) => new VRMLoaderPlugin(p));
const gltf = await new Promise((res, rej) => loader.parse(ab, '', res, rej));
const vrm = gltf.userData.vrm;
const H = vrm.humanoid;
const { Moves } = await import(process.env.SRC ? process.env.SRC + '/moves.js' : new URL('../src/moves.js', import.meta.url).href);
const log = [];
const avatar = { vrm, poseHooks: [], handHooks: [], faceHooks: [] };
const moves = new Moves(avatar, { remember: () => {}, log: (t) => { log.push(t); console.log('[jena]', t); } });
await moves.ready;
const DETAIL = []; { const sc0 = moves.selfCheck, orig = sc0.score.bind(sc0); sc0.score = (mine, tgt) => { const r = orig(mine, tgt); if (process.env.DETAIL) { const keys = ['leftShoulder','leftElbow','leftWristUp','rightShoulder','rightElbow','rightWristUp','torsoLean','torsoLeanSide','headTilt']; DETAIL.push(Object.fromEntries(keys.map((k) => [k, [+mine[k].toFixed(2), +tgt[k].toFixed(2)]]))); } return r; }; }
Math.random = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();   // repeatable
const ok = await moves.play('dance', 'neutral', 'self-check harness');
if (!ok) { console.log(JSON.stringify({ error: 'move did not start', lib: moves.library.length })); process.exit(1); }
const p = moves.playing; p.start = 0; p.len = Math.min(+secs, p.c.frames / p.c.fps); p.rate = 1;
// her procedural base each frame (the site's avatar sets this before the hooks): rest pose with arms down at her sides
const base = {}; for (const b of ['leftUpperArm', 'rightUpperArm']) base[b] = H.getNormalizedBoneNode(b);
const resetBase = () => {
  for (const n of Object.values(H.humanBones || {})) {}
  for (const name of Object.keys(H.normalizedHumanBones || {})) { const n = H.getNormalizedBoneNode(name); if (n) n.quaternion.identity(); }
  base.leftUpperArm?.rotation.set(0, 0, -1.25); base.rightUpperArm?.rotation.set(0, 0, 1.25);
};
const dt = 1 / 30; let t = 0, rows = [];
while (moves.playing && t < p.len + 3) {
  resetBase();
  for (const h of avatar.poseHooks) h(vrm, dt);
  t += dt;
  const L = moves.selfCheck.last;
  if (L && (!rows.length || rows[rows.length - 1].at !== L.at)) rows.push({ t: +t.toFixed(2), overall: L.overall, parts: L.parts, say: L.say, at: L.at });
}
moves.selfCheck.finish?.();
const sc = moves.selfCheck;
console.log('RESULT ' + JSON.stringify({ detail: DETAIL, clip: clipId, mode, checks: rows.map(({ at, ...r }) => r), summary: sc.summary || null, log }));
