
// Her self-tracking check on every whole-body move: her real moves.js (incl. keepClear) on her VRM.
// Counts frames where a hand / forearm sits inside her torso, and fingers bent backwards, with and without
// her own body guard. usage: node moves-pipeline/selftrack_check.mjs
import fs from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis; globalThis.location = new URL('http://jena.local/');
const store = {}; globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
globalThis.fetch = async (u) => { const t = fs.readFileSync('public/moves/' + String(u).split('/').pop(), 'utf8'); return { ok: true, json: async () => JSON.parse(t) }; };
const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
const buf = fs.readFileSync('/home/user/tab/files/jena-learn/track/vrm/notex.vrm');
const gltf = await new Promise((res, rej) => { const l = new GLTFLoader(); l.register((p) => new VRMLoaderPlugin(p)); l.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej); });
const vrm = gltf.userData.vrm, H = vrm.humanoid;
const { Moves } = await import('../src/moves.js');
const av = { vrm, poseHooks: [], handHooks: [], faceHooks: [], talk: { until: 0 } };
const moves = new Moves(av, { log: () => {} }); await moves.ready;
const V = () => new THREE.Vector3();
const inside = () => {
  H.normalizedHumanBonesRoot.updateMatrixWorld(true);
  const P = (b) => H.getNormalizedBoneNode(b).getWorldPosition(V());
  const hips = H.getNormalizedBoneNode('hips'), chest = H.getNormalizedBoneNode('upperChest') || H.getNormalizedBoneNode('chest');
  const sw = P('leftUpperArm').distanceTo(P('rightUpperArm')), a = sw * 0.36, b = a * 0.75, hipY = P('hips').y, neckY = P('neck').y;
  const inv = chest.matrixWorld.clone().invert();
  let n = 0;
  for (const s of ['left', 'right']) {
    const hp = P(s + 'Hand'), lp = P(s + 'LowerArm');
    for (const p of [hp, hp.clone().lerp(lp, 0.5)]) { const c = p.clone().applyMatrix4(inv); if (p.y > hipY - 0.1 && p.y < neckY && (c.x / a) ** 2 + (c.z / b) ** 2 < 1) { n++; break; } }
  }
  return n;
};
const backwards = () => { let n = 0; for (const s of ['left', 'right']) for (const f of ['Index', 'Middle', 'Ring', 'Little']) for (const j of ['Proximal', 'Intermediate', 'Distal']) { const r = H.getNormalizedBoneNode(s + f + j).rotation.z * (s === 'left' ? -1 : 1); if (r < -0.1) n++; } return n; };
const out = {};
const ids = moves.library.filter((c) => c.has?.fingers || process.env.ALL).map((c) => c.id);
for (const guard of [false, true]) {
  const orig = Moves.prototype.keepClear;
  moves.keepClear = guard ? orig.bind(moves) : () => {};
  for (const id of ids) {
    moves.playing = null; moves.choose = () => moves.library.find((c) => c.id === id);
    await moves.play('dance', 'happy', 'check');
    const p = moves.playing; p.start = 0; p.len = Math.min(12, p.c.frames / p.c.fps); p.rate = 1;
    let frames = 0, handIn = 0, back = 0;
    while (moves.playing) {
      for (const n of Object.keys(H.normalizedHumanBones)) H.getNormalizedBoneNode(n)?.quaternion.identity();
      H.getNormalizedBoneNode('leftUpperArm').rotation.set(0, 0, -1.25); H.getNormalizedBoneNode('rightUpperArm').rotation.set(0, 0, 1.25);
      for (const f of av.poseHooks) f(vrm, 1 / 30);
      for (const f of av.handHooks) f(vrm, 1 / 30);
      if (moves.playing && moves.playing.w > 0.5) { frames++; handIn += inside() ? 1 : 0; back += backwards() ? 1 : 0; }
    }
    (out[id] ||= {})[guard ? 'with_guard' : 'no_guard'] = { frames, handInTorsoPct: +(100 * handIn / frames).toFixed(1), fingerBackwardsPct: +(100 * back / frames).toFixed(1) };
  }
}
console.log('RESULT ' + JSON.stringify(out));
process.exit(0);
