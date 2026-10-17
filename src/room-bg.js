// Jena's room (Q-WORLD v1, the baked Cycles room in public/world-v2/) as the main page's live background.
// Never holds the page: it starts after first paint once the browser is idle and her avatar has had its turn,
// renders the room in the browser with the baked lightmaps (no realtime lights, no post), and hands each frame to
// the N•OS glass wallpaper (window.__nos.setWallpaper) or, without N•OS, to a canvas inside #bg.
// Phones and weak laptops (iPhone, Intel N200 4 GB) render ONE frame at a capped size, then free the GPU entirely
// (scene, textures and the WebGL context are disposed); only strong desktops keep a slow drifting camera.
// No WebGL2, a load error or a slow network leaves /bg-room.jpg exactly as before.
// URL: ?room=0 off · ?room=still|live force a mode · ?look=day|night (default: her local clock, or night in dark glass).
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
  const cap = mode === 'live' ? 2048 : (matchMedia('(pointer: coarse)').matches ? 1400 : 1920);
  const s = Math.min(mode === 'live' ? 1.25 : Math.min(1.25, devicePixelRatio || 1), cap / Math.max(vw, vh));
  return [Math.round(vw * s), Math.round(vh * s)];
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

async function build(mode, look) {
  const t0 = performance.now();
  const [W, H] = frameSize(mode);
  const gl = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: mode === 'live' ? 'high-performance' : 'low-power' });
  renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  renderer.toneMapping = THREE.AgXToneMapping;
  const L = LOOKS[look];
  renderer.toneMappingExposure = L.exp;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(L.bg);
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
  const pmrem = new THREE.PMREMGenerator(renderer);
  if (env) { env.mapping = THREE.EquirectangularReflectionMapping; scene.environment = pmrem.fromEquirectangular(env).texture; env.dispose(); }
  pmrem.dispose();
  const maxAniso = mode === 'live' ? 8 : 4;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const hasLM = !!o.geometry.attributes.uv1;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m.aoMap) m.aoMap = null;
      if (/^sky/i.test(m.name)) {   // window exterior photo (trees + sky by day, navy + stars at night)
        if (ext) { if (m.emissiveMap) ext.flipY = m.emissiveMap.flipY; m.emissiveMap = ext; m.map = null; m.color.setRGB(0, 0, 0); m.emissive.setRGB(1, 1, 1); }
        m.emissiveIntensity = L.sky; m.needsUpdate = true; continue;
      }
      if (hasLM) {
        m.lightMap = lm; m.lightMapIntensity = L.lms * Math.PI;
        const duvet = m.name === 'duvet', chunk = duvet ? DUVET_LM : NO_IBL_DIFFUSE;
        m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_maps>', chunk); };
        m.customProgramCacheKey = () => (duvet ? 'room-duvet' : 'room-baked');
      }
      if (m.emissive && m.emissiveIntensity > 0 && m.emissive.getHex() !== 0) m.emissiveIntensity *= L.emis;
      m.envMapIntensity = hasLM ? 0.9 : 1.0;
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
  frame.width = W; frame.height = H;
  const g2 = frame.getContext('2d');
  const draw = () => { renderer.render(scene, camera); g2.drawImage(gl, 0, 0, W, H); };
  draw();
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
    renderer.dispose(); renderer.forceContextLoss();
  };
  return { frame, draw, dispose, camera, P, T, W, H };
}

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
    stopLive(); if (R) { R.dispose(); R = null; }
    out = R2.frame; show(out);
    if (mode === 'live') { R = R2; startLive(); } else R2.dispose();   // still: one picture, then the GPU is freed
    state.state = 'shown'; state.shownIn = shownIn; state.size = [R2.W, R2.H]; state.ms.total = Math.round(performance.now() - t0);
    log('shown', mode, look, state.size.join('x'), state.ms);
  } catch (e) {
    clearTimeout(timer);
    state.state = out ? 'shown' : 'fallback'; state.error = String(e && e.message || e);
    console.warn('[room] keeping the picture background:', state.error);
  } finally { building = false; }
}

export function mountRoomBg({ obs = false, waitFor = null } = {}) {
  if (obs || Q.get('room') === '0' || document.body.classList.contains('bg-none') || document.body.classList.contains('stream')) { state.state = 'off'; return state; }
  if (!webgl2OK()) { state.state = 'fallback'; state.error = 'no WebGL2'; return state; }
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
      if (state.state === 'shown' && (a > 1) !== (lastAspect > 1)) { lastAspect = a; run('orientation'); }
    }, 700);
  });
  // day <-> night follows her clock (checked every 10 min) unless the URL pins a look
  if (!Q.get('look')) setInterval(() => { if (state.state === 'shown' && pickLook() !== state.look) run('look'); }, 600000);
  return state;
}
