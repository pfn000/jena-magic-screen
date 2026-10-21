// Jena's room (Q-WORLD v1, the baked Cycles room in public/world-v2/) as the main page's live background.
// Never holds the page: it starts after first paint once the browser is idle and her avatar has had its turn,
// renders the room in the browser with the baked lightmaps (no realtime lights, no post), and hands each frame to
// the N•OS glass wallpaper (window.__nos.setWallpaper) or, without N•OS, to a canvas inside #bg.
// Phones and weak laptops (iPhone, Intel N200 4 GB) render ONE frame at a capped size, then free the GPU entirely
// (scene, textures and the WebGL context are disposed); only strong desktops keep a slow drifting camera.
// Renderer: WebGPU (three/webgpu, loaded only for the live room on strong desktops whose browser returns a WebGPU adapter),
// else WebGL2 (OpenGL ES 3.0 in the browser). A WebGPU start or frame that fails falls back to WebGL2 on the spot.
// No GPU at all, a load error or a slow network leaves the plain dark gradient (#bg); the old bg-room.jpg is gone.
// URL: ?gpu=webgl forces WebGL2, ?gpu=webgpu skips the adapter pre-check.
// URL: ?room=0 off · ?room=still|live force a mode · ?look=day|night (default: her local clock, or night in dark glass).
// FLOOR LOCK (Saidie, Oct 21 12:50 PM: "the room should be floor level with where she is standing and how she is standing"):
// the room is no longer shot from its own high 'wide' camera. It is rendered through HER camera (same lens, same height,
// same tilt, same framing on the screen), with her standing spot on the room's rug, so her soles sit exactly on the
// room's floor and the room's perspective/horizon is the one her body is drawn with. The near wall (behind the camera)
// is clipped away. Her camera moves (follow, framing, a card opening) slide the picture with it; a bigger move re-renders.
// ?roomcam=wide brings back the old high camera.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

const BASE = '/world-v2/';
const Q = new URLSearchParams(location.search);
const state = { state: 'idle', mode: null, look: null, ms: {}, error: null };
window.__roomBg = state;
const log = (...a) => console.info('[room]', ...a);

// Baked lighting: diffuse light comes only from the lightmap; the panorama adds reflections, not a second fill.
// Patched per material (onBeforeCompile), so her avatar's materials are never touched.
const NO_IBL_DIFFUSE = THREE.ShaderChunk.lights_fragment_maps.replace('iblIrradiance += getIBLIrradiance( geometryNormal );', '');
// duvet: its quilt creases baked black in blocky patches (lightmap texels inside the puffs). Fill the dark holes from the
// lit neighbourhood: average the lit samples on 3 rings (4/10/18 texels, dark ones ignored); the duvet takes mostly that
// smooth average (80%), so neither the black holes nor the blocky low-res texels show.
const DUVET_LM = THREE.ShaderChunk.lights_fragment_maps.replace('vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;', `
  vec2 lmPx = 1.0 / vec2( textureSize( lightMap, 0 ) );
  vec3 lmS[ 24 ]; float lmPeak = dot( lightMapTexel.rgb, vec3( 0.333 ) );
  for ( int i = 0; i < 8; i ++ ) {
    float a = float( i ) * 0.7853982;
    lmS[ i ] = texture2D( lightMap, vLightMapUv + vec2( cos( a ), sin( a ) ) * lmPx * 4.0 ).rgb;
    lmS[ i + 8 ] = texture2D( lightMap, vLightMapUv + vec2( cos( a + 0.39 ), sin( a + 0.39 ) ) * lmPx * 10.0 ).rgb;
    lmS[ i + 16 ] = texture2D( lightMap, vLightMapUv + vec2( cos( a + 0.2 ), sin( a + 0.2 ) ) * lmPx * 18.0 ).rgb;
  }
  for ( int i = 0; i < 24; i ++ ) lmPeak = max( lmPeak, dot( lmS[ i ], vec3( 0.333 ) ) );
  vec3 lmSum = vec3( 0.0 ); float lmN = 0.0;
  for ( int i = 0; i < 24; i ++ ) { float w = step( lmPeak * 0.35, dot( lmS[ i ], vec3( 0.333 ) ) ); lmSum += lmS[ i ] * w; lmN += w; }
  vec3 lmFill = lmN > 0.0 ? lmSum / lmN : lightMapTexel.rgb;
  vec3 lightMapIrradiance = mix( lmFill, max( lightMapTexel.rgb, lmFill * 0.85 ), 0.2 ) * lightMapIntensity;`).replace('iblIrradiance += getIBLIrradiance( geometryNormal );', '');
const LOOKS = {
  night: { lmFile: 'lightmap.webp', envFile: 'env.hdr', ext: 'exterior_night.jpg', lms: 4.0, bg: 0x05040a, emis: 1.0, exp: 1.5, sky: 1.3 },
  day: { lmFile: 'lightmap_day.webp', envFile: 'env_day.hdr', ext: 'exterior_day.jpg', lms: 8.0, bg: 0xbcd3f0, emis: 0.13, exp: 1.1, sky: 1.0 },
};

function pickMode() {
  const q = Q.get('room');
  if (q === 'still' || q === 'live') return q;
  const nav = navigator, mem = nav.deviceMemory || 0, cores = nav.hardwareConcurrency || 0;
  const coarse = matchMedia('(pointer: coarse)').matches, save = nav.connection && nav.connection.saveData;
  const strong = !coarse && !save && mem >= 8 && cores >= 8 && innerWidth >= 1000 && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  return strong ? 'live' : 'still';
}
function pickLook() {
  const q = Q.get('look'); if (q === 'day' || q === 'night') return q;
  if (document.body.classList.contains('nos-dark')) return 'night';
  const h = new Date().getHours();
  return h >= 7 && h < 19 ? 'day' : 'night';
}
function webgl2OK() {
  try { const c = document.createElement('canvas'); const g = c.getContext('webgl2'); if (!g) return false; g.getExtension('WEBGL_lose_context')?.loseContext(); return true; } catch { return false; }
}
// presets are framed for 16:9; on a tall screen keep the horizontal view (pulled back) instead of a cropped sliver
function fitFov(f, aspect) {
  if (aspect >= 16 / 9) return f;
  const h = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(f) / 2) * 16 / 9);
  return Math.min(84, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(h / 2) / aspect)) * 0.82);
}
// render size: the viewport, capped (pixel ratio <= 1.25 and the long side <= 2048; phones <= 1.0 and 1400)
function frameSize(mode) {
  const vw = Math.max(320, innerWidth), vh = Math.max(320, innerHeight);
  // still mode is ONE frame, so it renders at the screen's real pixel ratio (a 3x iPhone gets ~1170x2532, long side
  // <= 2600; desktops <= 2x and 3200) instead of the old 1x/1400 px picture that looked soft on phones (Saidie, Oct 21)
  const dpr = devicePixelRatio || 1;
  const cap = mode === 'live' ? 2048 : (matchMedia('(pointer: coarse)').matches ? 2600 : 3200);
  const s = Math.min(mode === 'live' ? Math.min(1.25, dpr) : Math.min(matchMedia('(pointer: coarse)').matches ? 3 : 2, dpr), cap / Math.max(vw, vh));
  return [Math.round(vw * s), Math.round(vh * s)];
}

// ---- FLOOR LOCK helpers ----
const MARGIN = [1.6, 1.25];   // the follow picture is rendered this much wider / taller than the screen, so a camera move or a
                              // card opening (her stage shifts sideways) can slide it without a new render
let stageFn = null;           // () => her Avatar (camera + canvas), from main.js
let spot = null;              // her standing spot in the room: { x, y, z } (y = the rug's top surface under her soles)
let clipZ = null;             // the near wall's inner face: everything nearer the camera than this is not drawn
function stageView() {
  if (Q.get('roomcam') === 'wide') return null;
  const A = stageFn && stageFn();
  if (!A || !A.vrm || !A.camera || !A.canvas || A.noGL) return null;
  const r = A.canvas.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return null;
  const vw = Math.max(1, innerWidth), vh = Math.max(1, innerHeight);
  A.camera.updateMatrixWorld();
  // her projection maps the world onto HER canvas rect; the room fills the whole window: remap her NDC to the window's
  const M = new THREE.Matrix4().set(r.width / vw, 0, 0, (2 * r.left + r.width) / vw - 1, 0, r.height / vh, 0, 1 - (2 * r.top + r.height) / vh, 0, 0, 1, 0, 0, 0, 0, 1);
  return { pose: A.camera.matrixWorld.clone(), proj: M.multiply(A.camera.projectionMatrix), vw, vh, A };
}
function worldVisible(o) { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; }
// where she stands: on the rug, at its centre depth, slid sideways so the room's back wall fills her view evenly;
// y = the rug's real top surface (a ray straight down), so her soles (y = 0 in her own scene) land ON it
function findSpot(root, view) {
  root.updateMatrixWorld(true);
  const meshes = []; root.traverse((o) => { if (o.isMesh && worldVisible(o) && !/^sky/i.test(o.name || '')) meshes.push(o); });
  const ray = new THREE.Raycaster();
  const hit = (o, d) => { ray.set(o, d.normalize()); ray.far = 30; return ray.intersectObjects(meshes, false)[0] || null; };
  let rug = null; root.traverse((o) => { if (!rug && /^Rug$/i.test(o.name || '')) rug = o; });
  const rb = rug ? new THREE.Box3().setFromObject(rug) : null;
  const rc = rb ? rb.getCenter(new THREE.Vector3()) : new THREE.Vector3(0.15, 0, 0.35), rr = rb ? Math.min(rb.max.x - rb.min.x, rb.max.z - rb.min.z) / 2 : 1;
  const zS = rc.z, at = new THREE.Vector3(rc.x, 2.2, zS);
  const wx = (dx, dz, dflt) => { const h = hit(at.clone(), new THREE.Vector3(dx, 0, dz)); return h ? h.point : dflt; };
  const back = wx(0, -1, null), front = wx(0, 1, null), left = wx(-1, 0, null), right = wx(1, 0, null);
  const zBack = back ? back.z : -2.2, xMin = left ? left.x : -2.5, xMax = right ? right.x : 2.5;
  // the near wall's inner face, at several heights (it is thicker low down: a skirting/ledge read as a pale band once)
  let zf = front ? front.z : 2.1;
  for (const hy of [0.08, 0.2, 0.4, 0.7, 1.1, 1.6]) for (const dx of [-0.8, 0, 0.8]) {
    const h = hit(new THREE.Vector3(rc.x + dx, hy, zS), new THREE.Vector3(0, 0, 1));
    if (h && h.point.z > zS + 1.2 && h.point.z < zf) zf = h.point.z;
  }
  clipZ = zf - 0.03;
  // her view at the back wall if she stood at x = 0: centre that span between the side walls (kept on the rug)
  let xs = rc.x;
  if (view) {
    const pose = new THREE.Matrix4().makeTranslation(0, 0, zS).multiply(view.pose), inv = view.proj.clone().invert();
    const cam = new THREE.Vector3().setFromMatrixPosition(pose);
    const xAt = (nx) => { const p = new THREE.Vector3(nx, 0, 0.5).applyMatrix4(inv).applyMatrix4(pose), d = p.sub(cam); const t = (zBack - cam.z) / (d.z || -1e-6); return cam.x + d.x * t; };
    const want = (xMin + xMax) / 2 - (xAt(-1) + xAt(1)) / 2;
    xs = THREE.MathUtils.clamp(want, rc.x - rr + 0.42, rc.x + rr - 0.42);
  }
  const down = hit(new THREE.Vector3(xs, 1.5, zS), new THREE.Vector3(0, -1, 0));
  const y = down && down.point.y < 0.25 ? down.point.y : (rb ? rb.max.y : 0);
  return { x: xs, y, z: zS, walls: { zBack, xMin, xMax, front: clipZ + 0.03 } };
}
// affine map (canvas setTransform order a b c d e f) taking 3 source points onto 3 target points
function affine3(s, t) {
  const m = new THREE.Matrix3().set(s[0][0], s[0][1], 1, s[1][0], s[1][1], 1, s[2][0], s[2][1], 1);
  if (Math.abs(m.determinant()) < 1e-9) return null;
  m.invert();
  const col = (k) => new THREE.Vector3(t[0][k], t[1][k], t[2][k]).applyMatrix3(m);
  const X = col(0), Y = col(1);
  return [X.x, Y.x, X.y, Y.y, X.z, Y.z];   // x' = a x + c y + e ; y' = b x + d y + f
}

let out = null;          // the 2D frame handed to the wallpaper
let shownIn = null;      // 'nos' | 'bg'
function show(frame) {
  const nos = window.__nos;
  if (nos && nos.gl && nos.setWallpaper && document.body.classList.contains('nos-gl')) {
    nos.setWallpaper(frame); shownIn = 'nos';
  } else {
    const bg = document.getElementById('bg'); if (!bg) return;
    if (frame.parentNode !== bg) {
      frame.id = 'room-bg'; frame.setAttribute('aria-hidden', 'true');
      Object.assign(frame.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover', opacity: '0', transition: 'opacity .9s ease' });
      bg.prepend(frame); requestAnimationFrame(() => { frame.style.opacity = '1'; });
    }
    shownIn = 'bg';
  }
  document.body.classList.add('room-3d');
}
function refresh() { if (shownIn === 'nos') window.__nos?.refreshWallpaper?.(); }

async function webgpuOK(mode) {
  if (Q.get('gpu') === 'webgl' || !navigator.gpu) return false;
  if (Q.get('gpu') === 'webgpu') return true;
  // a still (phones, weak laptops) is ONE frame and then the GPU is freed: WebGPU buys nothing there, so stills keep the
  // proven WebGL2 look; the live drifting room on strong desktops gets WebGPU
  if (mode !== 'live') return false;
  try { return !!(await Promise.race([navigator.gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 3000))])); } catch { return false; }
}
async function makeRenderer(canvas, mode, kind) {
  const opts = { canvas, antialias: true, alpha: false, powerPreference: mode === 'live' ? 'high-performance' : 'low-power' };
  if (kind === 'webgpu') {
    const WG = await import('three/webgpu');
    const r = new WG.WebGPURenderer(opts);
    await r.init();
    if (!r.backend || !r.backend.isWebGPUBackend) { r.dispose(); throw new Error('WebGPU backend did not start'); }
    return { r, WG, TSL: await import('three/tsl') };
  }
  return { r: new THREE.WebGLRenderer({ ...opts, preserveDrawingBuffer: true }) };
}
// The duvet's lightmap fill (DUVET_LM above) as a TSL node graph for the WebGPU renderer (onBeforeCompile is WebGL only).
function duvetNodeMaterial(m, lm, lms, WG, TSL) {
  const { texture, uv, vec2, vec3, float, max, dot, step, mix } = TSL;
  const px = [1 / (lm.image?.width || 2048), 1 / (lm.image?.height || 2048)];
  const luv = uv(1), lum = (c) => dot(c, vec3(0.333));
  const base = texture(lm, luv).rgb, S = [];
  for (let i = 0; i < 8; i++) {
    const a = i * 0.7853982;
    for (const [rad, da] of [[4, 0], [10, 0.39], [18, 0.2]]) S.push(texture(lm, luv.add(vec2(Math.cos(a + da) * rad * px[0], Math.sin(a + da) * rad * px[1]))).rgb);
  }
  let peak = lum(base); for (const x of S) peak = max(peak, lum(x));
  let sum = vec3(0), n = float(0);
  for (const x of S) { const w = step(peak.mul(0.35), lum(x)); sum = sum.add(x.mul(w)); n = n.add(w); }
  const fill = mix(base, sum.div(max(n, 0.0001)), step(0.5, n));
  const irr = mix(fill, max(base, fill.mul(0.85)), 0.2).mul(lms);
  const tint = vec3(m.color.r, m.color.g, m.color.b), albedo = m.map ? texture(m.map, uv()).rgb.mul(tint) : tint;
  const nm = new WG.MeshBasicNodeMaterial(); nm.name = 'duvet'; nm.colorNode = albedo.mul(irr);
  return nm;
}
// a frame that came out empty (all black / transparent) means the renderer silently failed
function blankFrame(c) {
  try {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let lit = 0;
    for (let i = 0, step = Math.max(4, ((d.length / 4 / 400) | 0) * 4); i < d.length; i += step) if (d[i] + d[i + 1] + d[i + 2] > 24) lit++;
    return lit < 8;
  } catch { return false; }
}

async function build(mode, look) {
  // the floor-locked room needs the near-wall clip plane (WebGL2 path); the old drifting WebGPU room only without it
  const order = !stageView() && (await webgpuOK(mode)) ? ['webgpu', 'webgl'] : ['webgl'];
  let err = null;
  for (const kind of order) {
    try { const R2 = await buildWith(mode, look, kind); state.renderer = kind; return R2; }
    catch (e) { err = e; console.warn('[room]', kind, 'failed:', String(e && e.message || e)); state.gpuError = kind === 'webgpu' ? String(e && e.message || e) : state.gpuError; }
  }
  throw err;
}
async function buildWith(mode, look, kind) {
  const t0 = performance.now();
  const [W, H] = frameSize(mode);
  const gl = document.createElement('canvas');
  const { r: renderer, WG, TSL } = await makeRenderer(gl, mode, kind);
  const gpu = kind === 'webgpu';
  renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  renderer.toneMapping = THREE.AgXToneMapping;
  const L = LOOKS[look];
  renderer.toneMappingExposure = L.exp;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(L.bg);
  bgCss = '#' + new THREE.Color(L.bg).getHexString();
  const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const texL = new THREE.TextureLoader();
  const [gltf, lm, env, ext, cams] = await Promise.all([
    loader.loadAsync(BASE + 'room.glb'),
    texL.loadAsync(BASE + L.lmFile),
    new HDRLoader().loadAsync(BASE + L.envFile).catch(() => null),
    texL.loadAsync(BASE + L.ext).catch(() => null),
    fetch(BASE + 'cameras.json').then((r) => r.json()),
  ]);
  state.ms.loaded = Math.round(performance.now() - t0);
  draco.dispose();
  lm.flipY = false; lm.colorSpace = THREE.SRGBColorSpace; lm.channel = 1;
  if (ext) { ext.colorSpace = THREE.SRGBColorSpace; ext.flipY = false; }
  if (gpu) { if (env) { env.mapping = THREE.EquirectangularReflectionMapping; scene.environment = env; } }   // WebGPU prefilters it itself
  else {
    const pmrem = new THREE.PMREMGenerator(renderer);
    if (env) { env.mapping = THREE.EquirectangularReflectionMapping; scene.environment = pmrem.fromEquirectangular(env).texture; env.dispose(); }
    pmrem.dispose();
  }
  const maxAniso = 8;
  // Saidie, Oct 21 ("no box"): the wooden display shelves (a box/crate behind her head on laptops) are never drawn
  // ...and the beanbag with its pink cushion (the 'lavender blobs' in her laptop photo; no pink cushion) is never drawn either
  gltf.scene.traverse((o) => { if (/wooden_display_shelves|^Beanbag/i.test(o.name || '')) o.visible = false; });
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const hasLM = !!o.geometry.attributes.uv1;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m.aoMap) m.aoMap = null;
      if (/^sky/i.test(m.name)) {   // window exterior photo (trees + sky by day, navy + stars at night)
        if (ext) { if (m.emissiveMap) ext.flipY = m.emissiveMap.flipY; m.emissiveMap = ext; m.map = null; m.color.setRGB(0, 0, 0); m.emissive.setRGB(1, 1, 1); }
        m.emissiveIntensity = L.sky; m.needsUpdate = true; continue;
      }
      if (hasLM && gpu && m.name === 'duvet') { const nm = duvetNodeMaterial(m, lm, L.lms, WG, TSL); if (Array.isArray(o.material)) o.material[o.material.indexOf(m)] = nm; else o.material = nm; m.dispose(); continue; }
      if (hasLM) {
        m.lightMap = lm; m.lightMapIntensity = L.lms * Math.PI;
        const duvet = m.name === 'duvet', chunk = duvet ? DUVET_LM : NO_IBL_DIFFUSE;
        m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_maps>', chunk); };
        m.customProgramCacheKey = () => (duvet ? 'room-duvet' : 'room-baked');
      }
      if (m.emissive && m.emissiveIntensity > 0 && m.emissive.getHex() !== 0) m.emissiveIntensity *= L.emis;
      m.envMapIntensity = hasLM ? (gpu ? 0.3 : 0.9) : 1.0;   // WebGPU can't drop the panorama's diffuse fill per material: keep it faint
      if (m.map) m.map.anisotropy = maxAniso;
      if (/glass/i.test(m.name)) { m.transparent = true; m.opacity = 0.12; m.depthWrite = false; m.roughness = 0.03; m.metalness = 0; m.transmission = 0; m.envMapIntensity = 1.5; }
      m.needsUpdate = true;
    }
  });
  scene.add(gltf.scene);
  const c = cams.wide;
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.03, 60);
  const P = new THREE.Vector3(...c.position), T = new THREE.Vector3(...c.target);
  const aim = () => { camera.aspect = W / H; camera.fov = fitFov(c.fov, W / H); camera.updateProjectionMatrix(); };
  aim(); camera.position.copy(P); camera.lookAt(T);
  // the 2D frame the page shows (the WebGL canvas itself never enters the DOM)
  const frame = out || document.createElement('canvas');
  const g2 = frame.getContext('2d');
  // FLOOR LOCK: rendered through her camera into an oversized picture (master), then slid into the frame
  const view = stageView();
  let follow = null;
  if (view && !gpu) {
    if (!spot) spot = findSpot(gltf.scene, view);
    // the near wall (between her camera and her) is clipped away: keeps z <= its inner face, room materials only
    // the floor's raised front lip and the foot of the near wall catch the light as a bright line; when the textured floor
    // extension takes over, the clip sits just inside that lip (9 cm), so the planks run on without either
    const ext = makeFloorExt(gltf.scene, spot);
    const clip = [new THREE.Plane(new THREE.Vector3(0, 0, -1), ext.userData.textured ? Math.min(clipZ, ext.userData.edgeZ - 0.09) : clipZ)];
    renderer.localClippingEnabled = true;
    gltf.scene.traverse((o) => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) { m.clippingPlanes = clip; m.needsUpdate = true; } });
    // ...and the floor carries on past the room's front edge (a phone's tall view looks down past the clipped wall):
    // the room's own wood texture, laid with the floor's own texture mapping so the planks run on unbroken, tinted to the
    // lit floor right at the room's front edge (sampled from the first picture), so no seam shows where it takes over
    ext.visible = false; scene.add(ext);
    const cap = mode === 'live' ? 2048 * 1.6 : (matchMedia('(pointer: coarse)').matches ? 3600 : 4400);
    const k = Math.min(1, cap / Math.max(W * MARGIN[0], H * MARGIN[1]));
    const MW = Math.round(W * MARGIN[0] * k), MH = Math.round(H * MARGIN[1] * k);
    renderer.setSize(MW, MH, false);
    const master = document.createElement('canvas'); master.width = MW; master.height = MH;
    const mg = master.getContext('2d');
    const camF = new THREE.PerspectiveCamera(); camF.matrixAutoUpdate = false; camF.matrixWorldAutoUpdate = false;
    const S = new THREE.Matrix4().makeScale(1 / MARGIN[0], 1 / MARGIN[1], 1);
    follow = { master, MW, MH, ref: null, spot: { ...spot },
      render(v) {
        camF.matrixWorld.makeTranslation(spot.x, spot.y, spot.z).multiply(v.pose);
        camF.matrixWorldInverse.copy(camF.matrixWorld).invert();
        camF.matrixWorld.decompose(camF.position, camF.quaternion, camF.scale);
        camF.projectionMatrix.copy(S).multiply(v.proj); camF.projectionMatrixInverse.copy(camF.projectionMatrix).invert();
        renderer.render(scene, camF);
        mg.drawImage(gl, 0, 0, MW, MH);
        // the picture's own top / bottom colours: what shows for a moment where a slid picture no longer reaches
        try { const t = document.createElement('canvas'); t.width = 1; t.height = 8; const tg = t.getContext('2d'); tg.drawImage(master, 0, 0, MW, MH, 0, 0, 1, 8); const d = tg.getImageData(0, 0, 1, 8).data; this.edge = [`rgb(${d[0]},${d[1]},${d[2]})`, `rgb(${d[28]},${d[29]},${d[30]})`]; } catch { this.edge = null; }
        this.ref = { view: camF.matrixWorldInverse.clone(), pose: camF.matrixWorld.clone(), proj: camF.projectionMatrix.clone() };
      } };
    follow.render(view);
    try {   // tint the extension to the lit wood right where it takes over: the visible wood patches in the strip just inside
      // the clip (rug-free spots; on a phone her narrow lens shows only the middle), matched against the texture's own
      // colour under each patch, so the planks hand over at the same brightness; patches further back only as a fallback
      const zc = clip[0].constant - 0.15, zf = ext.userData.edgeZ - 0.35, acc = [0, 0, 0], und = [0, 0, 0]; let got = 0, gotU = 0;
      const tries = [[[0, zc], [0.18, zc], [-0.18, zc], [0.8, zc], [-0.8, zc], [1.5, zc], [-1.5, zc]], [[0, zf], [0.8, zf], [-0.8, zf], [1.5, zf], [-1.5, zf], [1.55, spot.z + 0.6], [-1.55, spot.z + 0.6], [1.55, spot.z], [-1.55, spot.z]]];
      for (const list of tries) { if (got >= 1) break; acc.fill(0); und.fill(0); got = gotU = 0; for (const [dx, z] of list) {
        const pw = new THREE.Vector3(spot.x + dx, 0.002, z).applyMatrix4(follow.ref.view).applyMatrix4(follow.ref.proj);
        const px = Math.round((pw.x + 1) / 2 * MW), py = Math.round((1 - pw.y) / 2 * MH);
        if (!(pw.z < 1 && px >= 6 && py >= 6 && px < MW - 6 && py < MH - 6)) continue;
        const d = mg.getImageData(px - 3, py - 3, 7, 7).data; let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4; acc[0] += r / n; acc[1] += g / n; acc[2] += b / n; got++;
        const t = ext.userData.texAt(spot.x + dx, z); if (t) { und[0] += t[0]; und[1] += t[1]; und[2] += t[2]; gotU++; }
      } }
      if (got) ext.userData.tint(acc[0] / got / 255, acc[1] / got / 255, acc[2] / got / 255, gotU === got ? und.map((q) => q / gotU) : null);
      state.extTint = got; state.extSample = got ? acc.map((q) => Math.round(q / got)) : null;
      ext.visible = true; follow.render(view);
      // one check against the picture as this device actually draws it (texture filtering differs per GPU): the extension just
      // past the floor's end vs the floor just before it, each over the texture's own colour there; if the planks would step
      // in brightness, the tint is corrected once and the picture re-rendered
      if (got && ext.userData.texAt) {
        const lin = (x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
        const patch = (x, z) => {
          const pw = new THREE.Vector3(x, 0.002, z).applyMatrix4(follow.ref.view).applyMatrix4(follow.ref.proj);
          const px = Math.round((pw.x + 1) / 2 * MW), py = Math.round((1 - pw.y) / 2 * MH);
          if (!(pw.z < 1 && px >= 6 && py >= 6 && px < MW - 6 && py < MH - 6)) return null;
          const d = mg.getImageData(px - 3, py - 3, 7, 7).data, s = [0, 0, 0];
          for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) s[c] += lin(d[i + c]);
          return s.map((q) => q / (d.length / 4));
        };
        const ze = clip[0].constant + 0.08, rat = [0, 0, 0]; let nr = 0;
        for (const [dx] of tries[0]) {
          const x = spot.x + dx, F = patch(x, zc), E = patch(x, ze), tF = ext.userData.texAt(x, zc), tE = ext.userData.texAt(x, ze);
          if (!F || !E || !tF || !tE) continue;
          for (let c = 0; c < 3; c++) rat[c] += (F[c] / tF[c]) / Math.max(1e-4, E[c] / tE[c]);
          nr++;
        }
        if (nr) {
          const k = rat.map((q) => THREE.MathUtils.clamp(q / nr, 0.8, 1.25));
          state.extFix = k.map((q) => +q.toFixed(3));
          if (k.some((q) => Math.abs(q - 1) > 0.015)) { ext.material.color.setRGB(ext.material.color.r * k[0], ext.material.color.g * k[1], ext.material.color.b * k[2], THREE.LinearSRGBColorSpace); follow.render(view); }
        }
      }
    } catch (e) { ext.visible = true; }
    frame.width = W; frame.height = H;
    composite(follow, view, frame, true);
  } else {
    frame.width = W; frame.height = H;
  }
  const draw = () => { if (follow) return; renderer.render(scene, camera); g2.drawImage(gl, 0, 0, W, H); };
  if (gpu) await renderer.renderAsync(scene, camera).catch(() => {});   // compiles the WebGPU pipelines before the first copied frame
  draw();
  if (gpu && blankFrame(frame)) { try { renderer.dispose(); } catch {} throw new Error(kind + ' frame came out blank'); }
  state.ms.firstFrame = Math.round(performance.now() - t0);
  const dispose = () => {
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      for (const m of o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []) {
        for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose();
        m.dispose();
      }
    });
    lm.dispose(); ext?.dispose(); scene.environment?.dispose();
    renderer.dispose(); renderer.forceContextLoss?.();
  };
  return { frame, draw, dispose, camera, P, T, W, H, follow, bg: L.bg };
}

// FLOOR LOCK compositor: maps the master picture (rendered with camera 'ref') onto the frame for her camera NOW. Three points
// on the upright plane through her standing spot (her soles, 1 m above them, 1 m to the camera's right) are projected both
// ways; the affine through them is exact for that plane (so the floor under her feet never slides) and for any change of
// her framing on the screen (card open/close, resize: same camera, new projection). Returns what still needs a real render.
const _p = new THREE.Vector3();
let bgCss = '#05040a';
function composite(F, v, frame, force) {
  const ref = F.ref; if (!ref) return { need: true };
  const pose = new THREE.Matrix4().makeTranslation(F.spot.x, F.spot.y, F.spot.z).multiply(v.pose), viewM = pose.clone().invert();
  const right = new THREE.Vector3().setFromMatrixColumn(pose, 0).setY(0).normalize();
  const base = new THREE.Vector3(F.spot.x, F.spot.y, F.spot.z);
  const pts = [base, base.clone().add(new THREE.Vector3(0, 1, 0)), base.clone().add(right)];
  const px = (p, V, Pm, w, h) => { _p.copy(p).applyMatrix4(V).applyMatrix4(Pm); return [(_p.x + 1) / 2 * w, (1 - _p.y) / 2 * h]; };
  const W = frame.width, H = frame.height;
  const s = pts.map((p) => px(p, ref.view, ref.proj, F.MW, F.MH)), t = pts.map((p) => px(p, viewM, v.proj, W, H));
  const A = affine3(s, t); if (!A) return { need: true };
  const g = frame.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (F.edge) { const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, F.edge[0]); gr.addColorStop(1, F.edge[1]); g.fillStyle = gr; } else g.fillStyle = bgCss;
  g.fillRect(0, 0, W, H);
  g.setTransform(A[0], A[1], A[2], A[3], A[4], A[5]); g.imageSmoothingQuality = 'high';
  g.drawImage(F.master, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  // does the master still cover the whole frame? (inverse-map the frame corners)
  const det = A[0] * A[3] - A[1] * A[2];
  const inv = (x, y) => { const X = x - A[4], Y = y - A[5]; return [(A[3] * X - A[2] * Y) / det, (-A[1] * X + A[0] * Y) / det]; };
  let cover = true; for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H]]) { const [u, w] = inv(x, y); if (u < -2 || w < -2 || u > F.MW + 2 || w > F.MH + 2) cover = false; }
  // how far her camera moved since the master was rendered (parallax the affine cannot fake)
  const pRef = new THREE.Vector3().setFromMatrixPosition(ref.pose), pNow = new THREE.Vector3().setFromMatrixPosition(pose);
  const qa = new THREE.Quaternion().setFromRotationMatrix(ref.pose), qb = new THREE.Quaternion().setFromRotationMatrix(pose);
  const moved = pRef.distanceTo(pNow), turned = THREE.MathUtils.radToDeg(qa.angleTo(qb));
  // where the bottom edge of the screen meets the floor (room z): past the room's floor it is the extension plane
  const ip = v.proj.clone().invert(), cpos = new THREE.Vector3().setFromMatrixPosition(pose);
  const bp = new THREE.Vector3(0, -1, 0.5).applyMatrix4(ip).applyMatrix4(pose).sub(cpos);
  const fz = bp.y < 0 ? cpos.z + bp.z * ((F.spot.y - cpos.y) / bp.y) : null;
  state.follow = { moved: +moved.toFixed(3), turned: +turned.toFixed(2), cover, cam: [+cpos.x.toFixed(2), +cpos.y.toFixed(2), +cpos.z.toFixed(2)], floorAtBottom: fz === null ? null : +fz.toFixed(2) };
  return { need: !cover || moved > 0.1 || turned > 1.5, moved, turned, cover };   // under ~10 cm the slide is within a few px of a real render
}
let followTimer = 0;
function startFollow() {
  // live (strong desktops): a real render whenever her camera moved (<= ~12 fps). still (phones, weak laptops): the GPU is
  // freed after each picture; small moves slide it, a bigger one (or a card opening past the margin) re-renders once
  // her camera has settled
  let last = 0, lastKey = '', needSince = 0, needFirst = 0, lastBuild = performance.now() - 3800, slow = 0, anchor = null;   // the first re-render may come ~1.2 s in
  // "settled" = her camera stayed within ~6 cm (and the framing within ~2 %) for 700 ms: idle breathing/sway (the
  // camera follows her head) does not count as moving, so a picture that needs a re-render gets one
  const far = (v) => !anchor || Math.hypot(v.pose.elements[12] - anchor[0], v.pose.elements[13] - anchor[1], v.pose.elements[14] - anchor[2]) > 0.06 || Math.abs(v.proj.elements[0] / anchor[3] - 1) > 0.02 || Math.abs(v.proj.elements[5] / anchor[4] - 1) > 0.02 || Math.abs(v.proj.elements[8] - anchor[5]) > 0.03 || Math.abs(v.proj.elements[9] - anchor[6]) > 0.03;
  const tick = (now) => {
    followTimer = requestAnimationFrame(tick);
    if (document.hidden || now - last < 33 || !R?.follow || building) return;
    const v = stageView(); if (!v) return;
    if (v.A.floorRug && v.A.floorRug.visible) v.A.floorRug.visible = false;   // a re-added floor (new body) keeps it off
    const e = v.pose.elements, p = v.proj.elements;
    const [fw, fh] = frameSize(state.mode);
    const key = [e[12], e[13], e[14], e[8], e[9], e[10], p[0], p[5], p[8], p[9]].map((x) => x.toFixed(4)).join(',') + ':' + fw + 'x' + fh;
    if (key === lastKey && !needSince) return;
    const live = state.mode === 'live' && R.alive;
    if (key !== lastKey) {
      last = now; lastKey = key;
      if (out.width !== fw || out.height !== fh) { out.width = fw; out.height = fh; anchor = null; }
      let r = composite(R.follow, v, out);
      if (live && (r.need || r.moved > 0.002 || r.turned > 0.05)) {
        const t = performance.now(); R.follow.render(v); r = composite(R.follow, v, out);
        slow = performance.now() - t > 70 ? slow + 1 : 0;
        if (slow >= 6) { log('slow frames: still picture'); R.dispose(); R.alive = false; state.mode = 'still'; }
      }
      refresh();
      if (!r.need || live) { needSince = 0; needFirst = 0; anchor = null; return; }
      if (!needFirst) needFirst = now;
      if (far(v)) { anchor = [e[12], e[13], e[14], p[0], p[5], p[8], p[9]]; needSince = now; }   // a real move: start the settle clock again
      else if (!needSince) needSince = now;
    }
    state.settle = needSince ? Math.round(now - needSince) : 0;
    // settled for 700 ms and the picture needs a real render (still mode): re-render, at most every 3 s
    // (or, if her camera keeps drifting, once the picture has been off for 2.5 s)
    if (needSince && (now - needSince > 700 || now - needFirst > 2500) && now - lastBuild > 3000) { needSince = 0; needFirst = 0; anchor = null; lastBuild = now; state.rebuilds = (state.rebuilds || 0) + 1; run('follow'); }
  };
  followTimer = requestAnimationFrame(tick);
}
function stopFollow() { cancelAnimationFrame(followTimer); followTimer = 0; }

let R = null, liveTimer = 0, building = false;
function startLive() {
  // slow drift: about +-3 degrees around the room's centre over ~26 s, at most ~12 frames a second; paused when hidden;
  // if frames get slow (over ~70 ms each) the room settles into a still picture and frees the GPU
  const off = new THREE.Vector3(); let slow = 0, last = 0;
  const tick = (now) => {
    liveTimer = requestAnimationFrame(tick);
    if (document.hidden || now - last < 80) return;
    last = now;
    const a = Math.sin(now / 26000 * Math.PI * 2) * 0.05, b = Math.sin(now / 37000 * Math.PI * 2) * 0.02;
    off.copy(R.P).sub(R.T).applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
    R.camera.position.copy(R.T).add(off); R.camera.position.y += b; R.camera.lookAt(R.T);
    const t = performance.now(); R.draw(); refresh();
    slow = performance.now() - t > 70 ? slow + 1 : 0;
    if (slow >= 6) { log('slow frames: still picture'); stopLive(); R.dispose(); R = null; state.mode = 'still'; }
  };
  liveTimer = requestAnimationFrame(tick);
}
function stopLive() { cancelAnimationFrame(liveTimer); liveTimer = 0; }

async function run(reason) {
  if (building) return; building = true;
  const mode = state.mode || pickMode(), look = pickLook();
  state.state = 'loading'; state.mode = mode; state.look = look; state.reason = reason;
  const t0 = performance.now();
  let timer;
  try {
    const R2 = await Promise.race([build(mode, look), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('room took over 60 s')), 60000); })]);
    clearTimeout(timer);
    stopLive(); if (R && R.alive) R.dispose(); R = null;
    out = R2.frame; show(out);
    R = R2; R.alive = true;
    if (R2.follow) {   // FLOOR LOCK: she stands on the room's own rug now, so her separate lavender floor oval steps aside
      const A = stageFn && stageFn(); if (A && A.floorRug) A.floorRug.visible = false;
      state.spot = { x: +spot.x.toFixed(3), y: +spot.y.toFixed(4), z: +spot.z.toFixed(3), clipZ: +clipZ.toFixed(3) };
      if (mode !== 'live') { R2.dispose(); R2.alive = false; }   // still: the picture stays, the GPU is freed
      if (!followTimer) startFollow();
    } else if (mode === 'live') startLive();
    else { R2.dispose(); R2.alive = false; }   // still: one picture, then the GPU is freed
    state.state = 'shown'; state.shownIn = shownIn; state.size = [R2.W, R2.H]; state.ms.total = Math.round(performance.now() - t0);
    log('shown', mode, look, state.size.join('x'), state.ms);
  } catch (e) {
    clearTimeout(timer);
    state.state = out ? 'shown' : 'fallback'; state.error = String(e && e.message || e);
    console.warn('[room] keeping the plain gradient background:', state.error);
  } finally { building = false; }
}

export function mountRoomBg({ obs = false, waitFor = null, stage = null } = {}) {
  stageFn = stage;
  if (obs || Q.get('room') === '0' || document.body.classList.contains('bg-none') || document.body.classList.contains('stream')) { state.state = 'off'; return state; }
  if (!webgl2OK() && !navigator.gpu) { state.state = 'fallback'; state.error = 'no WebGL2 / WebGPU'; return state; }
  const t0 = performance.now();
  const go = () => {
    // let her avatar load first (up to 12 s) so the two never fight over a weak GPU or a slow phone connection
    const wait = () => (!waitFor || waitFor() || performance.now() - t0 > 12000) ? run('start') : setTimeout(wait, 500);
    wait();
  };
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1));
  const later = () => setTimeout(() => idle(go, { timeout: 3000 }), 1200);
  if (document.readyState === 'complete') later(); else addEventListener('load', later, { once: true });
  // a new orientation (or a big resize) frames a new picture; same orientation just re-fits the one we have
  let lastAspect = innerWidth / innerHeight, rt = 0;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const a = innerWidth / innerHeight;
      if (state.state === 'shown' && (a > 1) !== (lastAspect > 1)) { lastAspect = a; spot = null; run('orientation'); }
    }, 700);
  });
  // day <-> night follows her clock (checked every 10 min) unless the URL pins a look
  if (!Q.get('look')) setInterval(() => { if (state.state === 'shown' && pickLook() !== state.look) run('look'); }, 600000);
  return state;
}

// FLOOR EXTENSION: a big plane at the wood's height carrying the floor's own texture with the floor's own UV mapping
// (fitted from the floor mesh: uv = a*x + b*z + c), so the planks continue past the room's front edge without a seam.
function makeFloorExt(root, spot) {
  root.updateMatrixWorld(true);
  let floor = null;
  root.traverse((o) => { if (!floor && o.isMesh && (o.material?.name === 'floor' || /floor/i.test(o.material?.name || ''))) floor = o; });
  const S = 40, x0 = spot.x - S, x1 = spot.x + S, z0 = spot.z - S, z1 = spot.z + S;
  let y = -0.004, fit = null, edgeZ = 2.0, tex = null, avg = [0.5, 0.4, 0.4], lin128 = null;
  if (floor) {
    const p = floor.geometry.attributes.position, uv = floor.geometry.attributes.uv, v = new THREE.Vector3();
    const pts = []; let ymax = -1e9, zmax = -1e9;
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(floor.matrixWorld); if (v.y > ymax) ymax = v.y; pts.push([v.x, v.y, v.z, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0]); }
    const top = pts.filter((q) => q[1] > ymax - 0.012);
    for (const q of top) if (q[2] > zmax) zmax = q[2];
    if (top.length >= 3) edgeZ = zmax;
    // the walkable wood's own height (rays straight down onto the floor mesh only, beside and in front of the rug);
    // the plane sits just under it, so it never covers the rug or the floor and only shows past the room's edge
    const rc = new THREE.Raycaster(); let hy = Infinity;
    for (const [dx, dz] of [[1.6, 0], [-1.6, 0], [1.6, 1.2], [-1.6, 1.2], [0, 1.55], [0.9, 1.6], [-0.9, 1.6]]) {
      rc.set(new THREE.Vector3(spot.x + dx, 3, spot.z + dz), new THREE.Vector3(0, -1, 0));
      const h = rc.intersectObject(floor, false)[0]; if (h && h.point.y < hy) hy = h.point.y;
    }
    y = (Number.isFinite(hy) ? Math.min(hy, spot.y) : spot.y) - 0.012;
    if (uv && top.length >= 3) {   // least squares, 3x3 normal equations, for u and for v
      const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bu = [0, 0, 0], bv = [0, 0, 0];
      for (const q of top) { const r = [q[0], q[2], 1]; for (let a = 0; a < 3; a++) { bu[a] += r[a] * q[3]; bv[a] += r[a] * q[4]; for (let b = 0; b < 3; b++) M[a][b] += r[a] * r[b]; } }
      const solve = (A, bb) => { const m = A.map((row, i) => [...row, bb[i]]); for (let c = 0; c < 3; c++) { let piv = c; for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r; [m[c], m[piv]] = [m[piv], m[c]]; if (Math.abs(m[c][c]) < 1e-12) return null; for (let r = 0; r < 3; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k]; } } return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]]; };
      const fu = solve(M, bu), fv = solve(M, bv);
      if (fu && fv && fu.every(Number.isFinite) && fv.every(Number.isFinite) && (Math.abs(fu[0]) + Math.abs(fu[1])) > 1e-4) fit = [fu, fv];
    }
    const map = floor.material?.map;
    if (fit && map && map.image) {
      // the floor's own wrap (repeat), so past the room's edge the plank rows carry on exactly as the floor's own would
      // (a mirrored wrap flipped the planks at v = 2, just inside the room's front: a visible step in tone and pattern)
      tex = map.clone(); tex.wrapS = map.wrapS; tex.wrapT = map.wrapT; tex.needsUpdate = true;
      try {   // the texture's mean colour (linear), so the tint can match the lit floor exactly
        const c = document.createElement('canvas'); c.width = c.height = 16; const cg = c.getContext('2d'); cg.drawImage(map.image, 0, 0, 16, 16);
        const d = cg.getImageData(0, 0, 16, 16).data; const s = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) { const x = d[i + k] / 255; s[k] += x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
        avg = s.map((x) => Math.max(0.02, x / 256));
        // ...and a small linear copy, so the tint can be matched to the exact planks under each sampled floor patch
        const N = 128, c2 = document.createElement('canvas'); c2.width = c2.height = N; const g2 = c2.getContext('2d'); g2.drawImage(map.image, 0, 0, N, N);
        const d2 = g2.getImageData(0, 0, N, N).data; lin128 = new Float32Array(N * N * 3);
        for (let i = 0, j = 0; i < d2.length; i += 4, j += 3) for (let k = 0; k < 3; k++) { const x = d2[i + k] / 255; lin128[j + k] = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
      } catch {}
    }
  }
  const g = new THREE.BufferGeometry();
  const P = [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1];
  const U = []; for (let i = 0; i < 4; i++) { const x = P[i * 3], z = P[i * 3 + 2]; U.push(fit ? fit[0][0] * x + fit[0][1] * z + fit[0][2] : 0, fit ? fit[1][0] * x + fit[1][1] * z + fit[1][2] : 0); }
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex([0, 2, 1, 0, 3, 2]); g.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({ color: 0x8a6f73, map: tex, toneMapped: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, mat);
  // textured = the planks carry on: the room is then clipped just inside its raised front lip (see the clip in render).
  // (r3d: this flag was never set, so the clip stayed at the near wall's face and the foot of that wall (a bevel 2-3 cm
  // inside the clip) caught the light as the bright line across the phone's whole-body floor)
  mesh.userData.edgeZ = edgeZ; mesh.userData.y = y; mesh.userData.textured = !!tex;
  state.ext = { y: +y.toFixed(4), edgeZ: +edgeZ.toFixed(3), textured: !!tex, fit: fit ? fit.map((f) => f.map((x) => +x.toFixed(4))) : null };
  mesh.userData.tint = (r, gg, b, under) => {   // sRGB sample of the lit floor -> colour multiplier for the texture
    const lin = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
    const t = under || avg;   // the texture's own colour under the sampled patches (else its overall mean)
    if (tex) mat.color.setRGB(lin(r) / t[0], lin(gg) / t[1], lin(b) / t[2], THREE.LinearSRGBColorSpace);
    else mat.color.setRGB(r, gg, b, THREE.SRGBColorSpace);
  };
  // the texture's mean (linear) over a world-space square of half-size h at (x, z), with the floor's own mapping and wrap:
  // what the extension would show there with a white tint
  mesh.userData.texAt = (x, z, h = 0.05) => {
    if (!lin128 || !fit) return null;
    const N = 128, s = [0, 0, 0]; let n = 0;
    const m = (t) => (tex && tex.wrapS === THREE.MirroredRepeatWrapping ? ((t = ((t % 2) + 2) % 2) > 1 ? 2 - t : t) : t - Math.floor(t));
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
      const X = x + h * i / 3, Z = z + h * j / 3;
      const u = m(fit[0][0] * X + fit[0][1] * Z + fit[0][2]), v = m(fit[1][0] * X + fit[1][1] * Z + fit[1][2]);
      const k = (Math.min(N - 1, Math.floor(v * N)) * N + Math.min(N - 1, Math.floor(u * N))) * 3;
      s[0] += lin128[k]; s[1] += lin128[k + 1]; s[2] += lin128[k + 2]; n++;
    }
    return s.map((q) => Math.max(0.01, q / n));
  };
  return mesh;
}
