import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Baked lighting: diffuse light comes only from the Cycles lightmap; the panorama gives reflections, not a second diffuse fill.
THREE.ShaderChunk.lights_fragment_maps = THREE.ShaderChunk.lights_fragment_maps.replace('iblIrradiance += getIBLIrradiance( geometryNormal );', '');

const Q = new URLSearchParams(location.search);
const LM_SCALE = 4.0;                       // lightmap.webp stores srgb(L / 4)
const ROOM = { x: 2.45, zf: 2.15, zb: 2.15, y0: 0.15, y1: 2.7 };   // three.js Y-up bounds to keep the camera inside
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: Q.has('shot') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.AgXToneMapping; renderer.toneMappingExposure = parseFloat(Q.get('exp') || '1.5');
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x05040a);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.03, 60);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.maxDistance = 4.5; controls.minDistance = 0.05; controls.rotateSpeed = 0.6;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.5, 0.92);
composer.addPass(bloom); composer.addPass(new OutputPass());

const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
const gltfLoader = new GLTFLoader().setDRACOLoader(draco);
const pmrem = new THREE.PMREMGenerator(renderer);
let CAMS = {};

// Any asset may be stored as numbered parts (<name>.parts.json) when the commit path limits file size; reassemble it.
async function fetchURL(name, type) {
  const r = await fetch('./' + name);
  if (r.ok) return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type }));
  const pj = await fetch('./' + name + '.parts.json');
  if (!pj.ok) throw new Error('missing ' + name);
  const m = await pj.json();
  const bufs = await Promise.all(m.parts.map(p => fetch('./' + p).then(x => { if (!x.ok) throw new Error('missing ' + p); return x.arrayBuffer(); })));
  return URL.createObjectURL(new Blob(bufs, { type }));
}
async function loadGLB() { return gltfLoader.loadAsync(await fetchURL('room.glb', 'model/gltf-binary')); }
const tex = name => fetchURL(name, 'image/webp').then(u => new THREE.TextureLoader().loadAsync(u));
const hdr = name => fetchURL(name, 'application/octet-stream').then(u => new RGBELoader().loadAsync(u));
const [gltf, lmN, envN, lmD, envD, cams] = await Promise.all([
  loadGLB(),
  tex('lightmap.webp'),
  hdr('env.hdr'),
  tex('lightmap_day.webp').catch(() => null),
  hdr('env_day.hdr').catch(() => null),
  fetch('./cameras.json').then(r => r.json()),
]);
// window exterior photos (trees + sky in day, dark navy + stars at night), rendered from a CC0 HDRI next to the bake
const extTex = name => new THREE.TextureLoader().loadAsync('./' + name).then(t => { t.colorSpace = THREE.SRGBColorSpace; t.flipY = false; return t; }).catch(() => null);
const [extD, extN] = await Promise.all([extTex('exterior_day.jpg'), extTex('exterior_night.jpg')]);
CAMS = cams;
for (const t of [lmN, lmD]) if (t) { t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.channel = 1; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 8; }
for (const e of [envN, envD]) if (e) e.mapping = THREE.EquirectangularReflectionMapping;
const LOOKS = {
  night: { lm: lmN, lms: 4.0, env: pmrem.fromEquirectangular(envN).texture, bg: 0x05040a, emis: 1.0, exp: 1.5, bloom: 0.55 },
  day: lmD ? { lm: lmD, lms: 8.0, env: pmrem.fromEquirectangular(envD || envN).texture, bg: 0xbcd3f0, emis: 0.13, exp: 1.1, bloom: 0.15 } : null,
};
const lm = lmN;

let n = 0; const LMMATS = [], EMATS = [], SKYMATS = [];
gltf.scene.traverse(o => {
  if (!o.isMesh) return;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  const hasLM = !!o.geometry.attributes.uv1;
  for (const m of mats) {
    if (m.aoMap) { m.aoMap = null; }
    if (hasLM) { m.lightMap = lm; m.lightMapIntensity = LM_SCALE * Math.PI; n++; LMMATS.push(m); }
    if (/^sky/i.test(m.name)) { SKYMATS.push(m); continue; }
    if (m.emissive && (m.emissiveIntensity > 0) && m.emissive.getHex() !== 0) EMATS.push([m, m.emissiveIntensity]);
    m.envMapIntensity = hasLM ? 0.9 : 1.0;
    if (m.map) m.map.anisotropy = 8;
    if (m.normalMap) m.normalMap.anisotropy = 8;
    if (/glass/i.test(m.name)) { m.transparent = true; m.opacity = 0.12; m.depthWrite = false; m.roughness = 0.03; m.metalness = 0; m.transmission = 0; m.envMapIntensity = 1.5; }
    m.needsUpdate = true;
  }
});
scene.add(gltf.scene);
console.log('lightmapped materials', n);
let LOOK = 'night';
function setLook(name) {
  const L = LOOKS[name]; if (!L) return; LOOK = name;
  for (const m of LMMATS) { m.lightMap = L.lm; m.lightMapIntensity = L.lms * Math.PI; m.needsUpdate = true; }
  for (const [m, base] of EMATS) m.emissiveIntensity = base * L.emis;
  for (const m of SKYMATS) {
    const t = name === 'day' ? extD : extN;
    if (t) { if (m.emissiveMap) t.flipY = m.emissiveMap.flipY; m.emissiveMap = t; m.map = null; m.color.setRGB(0, 0, 0); m.emissive.setRGB(1, 1, 1); }
    m.emissiveIntensity = name === 'day' ? 1.0 : 1.3; m.toneMapped = true; m.needsUpdate = true;
  }
  scene.environment = L.env; scene.background = new THREE.Color(L.bg);
  renderer.toneMappingExposure = parseFloat(Q.get('exp') || L.exp); bloom.strength = L.bloom;
  const b = document.getElementById('look'); if (b) b.textContent = name === 'night' ? '☀︎ Day' : '☾ Night';
}
const lb = document.getElementById('look');
if (lb) { if (!LOOKS.day) lb.style.display = 'none'; lb.onclick = () => setLook(LOOK === 'night' ? 'day' : 'night'); }
setLook(Q.get('look') === 'day' ? 'day' : 'night');

const tmp = new THREE.Vector3();
// presets are framed for 16:9; on a tall phone screen keep the same horizontal view instead of cropping to a sliver
function fitFov(f) {
  const a = innerWidth / innerHeight; if (a >= 16 / 9) return f;
  const h = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(f) / 2) * 16 / 9);
  return Math.min(90, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(h / 2) / a)) * 0.82);
}
let CUR = 'wide';
function goto(name, instant) {
  const c = CAMS[name]; if (!c) return; CUR = name;
  document.querySelectorAll('#bar button[data-cam]').forEach(b => b.classList.toggle('on', b.dataset.cam === name));
  const p0 = camera.position.clone(), t0 = controls.target.clone(), f0 = camera.fov;
  const p1 = new THREE.Vector3(...c.position), t1 = new THREE.Vector3(...c.target);
  if (name === 'chair' && innerWidth < innerHeight) {   // tall phone: lean back in the seat so the desk + both monitors fit (was a zoomed sliver)
    const back = p1.clone().sub(t1).setY(0).normalize();
    p1.addScaledVector(back, 0.38); p1.y += 0.06;
  }
  if (name === 'chair') t1.sub(p1).normalize().multiplyScalar(0.02).add(p1);   // seated: orbit around the eyes = look around from the chair
  const dur = instant ? 0 : 900, start = performance.now();
  function step(now) {
    const k = dur ? Math.min(1, (now - start) / dur) : 1, e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    camera.position.lerpVectors(p0, p1, e); controls.target.lerpVectors(t0, t1, e);
    camera.fov = f0 + (fitFov(c.fov) - f0) * e; camera.updateProjectionMatrix();
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
  if (name === 'chair') { controls.minDistance = 0.01; } else { controls.minDistance = 0.05; }
}
document.querySelectorAll('#bar button[data-cam]').forEach(b => b.onclick = () => goto(b.dataset.cam));
goto(Q.get('cam') || 'wide', true);
if (Q.has('nobar')) document.getElementById('bar').style.display = 'none';

function clampInside() {
  const p = camera.position;
  p.x = THREE.MathUtils.clamp(p.x, -ROOM.x, ROOM.x); p.z = THREE.MathUtils.clamp(p.z, -ROOM.zb, ROOM.zf); p.y = THREE.MathUtils.clamp(p.y, ROOM.y0, ROOM.y1);
}
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; const cc = CAMS[CUR]; if (cc) camera.fov = fitFov(cc.fov); camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
});
let frames = 0;
renderer.setAnimationLoop(() => {
  controls.update(); clampInside(); composer.render();
  if (++frames === 8) { document.getElementById('load').classList.add('done'); window.__ready = true; }
});
// rev 1792172263662491511
