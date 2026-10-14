// Jena's World: her own 3D room in the browser (three.js + WebXR), lazy-loaded by src/world-entry.js on /world.
// - Her body is the SAME Avatar + Motion + spring bones the main page uses (src/avatar.js, src/motion.js); this file
//   only builds the room around her, drives the camera (WASD + mouse look, touch, or a VR headset), and adds
//   her virtual headset "NCOM Focals PRO" + two controllers, posed by her real head/hand bones every frame.
// - Multiplayer-lite: ?room=<id> joins a peer-to-peer room (WebRTC data channels; signaling through public Nostr
//   relays via trystero, no accounts, no server of ours). Each visitor is a capsule + name tag. See WORLD.md.
// - Kid-safe: Jena is a kid. Her lines here are cozy-gamer small talk; visitor names are sanitized and filtered.
import * as THREE from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { loadConfig } from './config.js';
import { Avatar } from './avatar.js';
import { Motion, setupSprings } from './motion.js';

const $ = (s) => document.querySelector(s);
const q = new URLSearchParams(location.search);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const R2D = 180 / Math.PI;
const ROOM = { x0: -3.5, x1: 3.5, z0: -2.2, z1: 4.2, h: 2.8 };
const EYE = 1.55;

// ---------------- names: short, plain, kid-safe ----------------
const BAD = /(fuck|shit|bitch|cunt|dick|cock|pussy|sex|porn|nude|naked|boob|tit|slut|whore|rape|nazi|hitler|kkk|n[i1!]gg|f[a@]g|retard|kys|horny|daddy|onlyfans|18\+|xxx)/i;
export function cleanName(raw) {
  let s = String(raw ?? '').normalize('NFKC').replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!s || BAD.test(s.replace(/[\s_.\-]/g, ''))) return null;
  return s;
}
const randName = () => 'visitor-' + Math.random().toString(36).slice(2, 6);

// ---------------- little canvas helpers ----------------
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); draw(g, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 2;
  t.userData = { c, g }; return t;
}
function labelSprite(text, { size = 0.16, color = '#fff', bg = 'rgba(30,12,56,0.82)', border = '#a77bff' } = {}) {
  const tex = canvasTex(512, 96, () => {});
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.userData.set = (t) => {
    const { c, g } = tex.userData; g.clearRect(0, 0, c.width, c.height);
    g.font = '600 46px system-ui, sans-serif'; const w = Math.min(500, g.measureText(t).width + 44);
    g.fillStyle = bg; g.strokeStyle = border; g.lineWidth = 4;
    g.beginPath(); g.roundRect((512 - w) / 2, 10, w, 76, 38); g.fill(); g.stroke();
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, 256, 50, 470);
    tex.needsUpdate = true;
  };
  sp.userData.set(text); sp.scale.set(size * 512 / 96, size, 1); sp.renderOrder = 30;
  return sp;
}

// ---------------- the room (low poly: ~2.5k triangles) ----------------
function buildRoom(scene) {
  const g = new THREE.Group(); g.name = 'room';
  const lam = (c, o = {}) => new THREE.MeshLambertMaterial({ color: c, ...o });
  const box = (w, h, d, m, x, y, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); g.add(b); return b; };
  const W = ROOM.x1 - ROOM.x0, D = ROOM.z1 - ROOM.z0, cx = (ROOM.x0 + ROOM.x1) / 2, cz = (ROOM.z0 + ROOM.z1) / 2;
  // floor: warm wood planks
  const planks = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#6b4a5e'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) { c.fillStyle = i % 2 ? '#74506a' : '#664459'; c.fillRect(0, i * 32, w, 31); c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect((i * 97) % w, i * 32, 2, 31); }
  });
  planks.wrapS = planks.wrapT = THREE.RepeatWrapping; planks.repeat.set(W / 1.6, D / 1.6);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), lam(0xffffff, { map: planks }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(cx, 0, cz); floor.renderOrder = -2; floor.name = 'floor'; g.add(floor);
  // walls + ceiling (inside faces only)
  const wallM = lam(0x4a2c78), sideM = lam(0x3f2569), ceilM = lam(0x2b1a47);
  const plane = (w, h, m, x, y, z, ry) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m); p.position.set(x, y, z); p.rotation.y = ry; g.add(p); return p; };
  plane(W, ROOM.h, wallM, cx, ROOM.h / 2, ROOM.z0, 0);
  plane(W, ROOM.h, wallM, cx, ROOM.h / 2, ROOM.z1, Math.PI);
  plane(D, ROOM.h, sideM, ROOM.x0, ROOM.h / 2, cz, Math.PI / 2);
  plane(D, ROOM.h, sideM, ROOM.x1, ROOM.h / 2, cz, -Math.PI / 2);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), ceilM); ceil.rotation.x = Math.PI / 2; ceil.position.set(cx, ROOM.h, cz); g.add(ceil);
  // NCOM purple LED strips along the top of the walls + baseboards
  const led = new THREE.MeshBasicMaterial({ color: 0xb06bff }), led2 = new THREE.MeshBasicMaterial({ color: 0xff7ad9 });
  box(W, 0.03, 0.03, led, cx, ROOM.h - 0.06, ROOM.z0 + 0.02);
  box(0.03, 0.03, D, led, ROOM.x0 + 0.02, ROOM.h - 0.06, cz);
  box(0.03, 0.03, D, led, ROOM.x1 - 0.02, ROOM.h - 0.06, cz);
  box(W, 0.02, 0.02, led2, cx, 0.05, ROOM.z0 + 0.02);
  // the stream screen on the back wall (canvas: live status, what she just said, who's here)
  const screenTex = canvasTex(512, 288, () => {});
  const frame = box(2.06, 1.2, 0.06, lam(0x140a24), 1.55, 1.62, ROOM.z0 + 0.04);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.96, 1.1), new THREE.MeshBasicMaterial({ map: screenTex }));
  screen.position.set(1.55, 1.62, ROOM.z0 + 0.075); g.add(screen);
  // neon sign
  const neon = canvasTex(512, 160, (c, w, h) => {
    c.fillStyle = 'rgba(0,0,0,0)'; c.fillRect(0, 0, w, h);
    c.font = '900 108px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.shadowColor = '#d58cff'; c.shadowBlur = 26; c.fillStyle = '#f3dcff'; c.fillText('JENA', w / 2, h / 2 + 4); c.shadowBlur = 12; c.fillText('JENA', w / 2, h / 2 + 4);
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.47), new THREE.MeshBasicMaterial({ map: neon, transparent: true, depthWrite: false }));
  sign.position.set(-1.45, 2.05, ROOM.z0 + 0.03); g.add(sign);
  // posters
  const poster = (txt, sub, bg, x, y, z, ry) => {
    const t = canvasTex(256, 360, (c, w, h) => {
      const gr = c.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, bg[0]); gr.addColorStop(1, bg[1]); c.fillStyle = gr; c.fillRect(0, 0, w, h);
      c.fillStyle = '#fff'; c.textAlign = 'center'; c.font = '900 70px system-ui, sans-serif'; c.fillText(txt, w / 2, h / 2);
      c.font = '600 24px system-ui, sans-serif'; c.fillText(sub, w / 2, h / 2 + 48);
    });
    plane(0.6, 0.84, new THREE.MeshLambertMaterial({ map: t }), x, y, z, ry);
  };
  poster('NCOM', 'focals pro', ['#8a4dff', '#2a1060'], ROOM.x0 + 0.01, 1.6, -0.6, Math.PI / 2);
  poster('GG', 'good game', ['#ff7ad9', '#6a1a7a'], ROOM.x0 + 0.01, 1.6, 0.6, Math.PI / 2);
  poster('W', 'only W\'s', ['#5fd7ff', '#2a2a8a'], ROOM.x1 - 0.01, 1.6, 2.4, -Math.PI / 2);
  // gaming desk + monitor + glowing keyboard (her left, viewer's right... desk sits against the left wall)
  const deskM = lam(0x241638), legM = lam(0x120a1e);
  box(1.5, 0.05, 0.7, deskM, ROOM.x0 + 0.4, 0.74, -1.0).rotation.y = 0;
  box(0.05, 0.72, 0.6, legM, ROOM.x0 + 0.4 - 0.7, 0.36, -1.0); box(0.05, 0.72, 0.6, legM, ROOM.x0 + 0.4 + 0.7, 0.36, -1.0);
  const mon = box(0.9, 0.52, 0.04, lam(0x0d0718), ROOM.x0 + 0.4, 1.12, -1.25);
  const monGlow = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.46), new THREE.MeshBasicMaterial({ color: 0x6d48c9 })); monGlow.position.set(ROOM.x0 + 0.4, 1.12, -1.228); g.add(monGlow);
  box(0.06, 0.3, 0.06, legM, ROOM.x0 + 0.4, 0.9, -1.27);
  box(0.55, 0.025, 0.18, new THREE.MeshBasicMaterial({ color: 0xc58cff }), ROOM.x0 + 0.4, 0.775, -0.85);
  // gaming chair
  const chairM = lam(0x7b3fe4), chairD = lam(0x1d1030);
  box(0.55, 0.1, 0.55, chairM, ROOM.x0 + 0.5, 0.48, -0.25); box(0.55, 0.75, 0.1, chairM, ROOM.x0 + 0.5, 0.9, 0.02);
  box(0.06, 0.42, 0.06, chairD, ROOM.x0 + 0.5, 0.22, -0.25);
  // bean bag (front right) + bookshelf of game boxes (right wall) + plant
  const bean = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), lam(0xff86c8)); bean.scale.set(1, 0.6, 1); bean.position.set(1.9, 0.28, 1.6); g.add(bean);
  box(0.36, 1.7, 1.2, lam(0x2a1a44), ROOM.x1 - 0.2, 0.85, 0.3);
  const cols = [0xff7ad9, 0x8a4dff, 0x5fd7ff, 0xffd166, 0x7dffb3, 0xff9f6b];
  for (let sh = 0; sh < 3; sh++) {
    box(0.34, 0.02, 1.16, lam(0x1a1030), ROOM.x1 - 0.2, 0.3 + sh * 0.5, 0.3);
    for (let i = 0; i < 6; i++) box(0.2, 0.26 + (i % 3) * 0.04, 0.07, lam(cols[(i + sh * 2) % cols.length]), ROOM.x1 - 0.24, 0.45 + sh * 0.5, -0.12 + i * 0.16);
  }
  box(0.26, 0.3, 0.26, lam(0xe9d8ff), ROOM.x1 - 0.4, 0.15, 3.6);
  const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 0), lam(0x4fbf7f, { flatShading: true })); leaves.position.set(ROOM.x1 - 0.4, 0.6, 3.6); g.add(leaves);
  scene.add(g);
  return { group: g, screen, screenTex };
}

// ---------------- NCOM Focals PRO + controllers (stylized, few polys) ----------------
function buildGear() {
  const visorM = new THREE.MeshPhongMaterial({ color: 0x9a6bff, emissive: 0x2a0a66, specular: 0xffffff, shininess: 90, transparent: true, opacity: 0.42, depthWrite: false });
  const shellM = new THREE.MeshPhongMaterial({ color: 0xf4ecff, emissive: 0x1a1030, shininess: 40 });
  const ledM = new THREE.MeshBasicMaterial({ color: 0xff7ad9 });
  // headset: a slim visor over her eyes with side arms and a little LED bar
  const headset = new THREE.Group(); headset.name = 'NCOM Focals PRO';
  const visor = new THREE.Mesh(new THREE.BoxGeometry(1, 0.34, 0.16), visorM); headset.add(visor);
  const brow = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.08, 0.2), shellM); brow.position.y = 0.2; headset.add(brow);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.02), ledM); bar.position.set(0, 0.2, 0.105); headset.add(bar);
  for (const s of [-1, 1]) { const arm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.75), shellM); arm.position.set(s * 0.52, 0.12, -0.33); headset.add(arm); }
  // controllers: a grip with a tracking ring and a glowing button
  const controller = (side) => {
    const c = new THREE.Group(); c.name = 'NCOM controller ' + side;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.014, 0.1, 10), shellM); grip.rotation.x = Math.PI / 2; c.add(grip);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.006, 6, 18), new THREE.MeshPhongMaterial({ color: 0x8a4dff, emissive: 0x3a1080 }));
    ring.position.set(0, 0.025, 0.055); ring.rotation.x = 0.5; c.add(ring);
    const btn = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), ledM); btn.position.set(0, 0.018, 0.035); c.add(btn);
    return c;
  };
  return { headset, left: controller('left'), right: controller('right') };
}

// fit the gear to her bones (normalized rig: rest frames are world-aligned, she faces +z)
function wearGear(avatar, gear) {
  const H = avatar.vrm.humanoid, N = (b) => H.getNormalizedBoneNode(b);
  const head = N('head');
  avatar.vrm.scene.updateMatrixWorld(true);
  const le = N('leftEye'), re = N('rightEye');
  let mid = new THREE.Vector3(0, 0.065, 0.06), span = 0.064;
  if (le && re) {
    const a = head.worldToLocal(le.getWorldPosition(new THREE.Vector3())), b = head.worldToLocal(re.getWorldPosition(new THREE.Vector3()));
    mid = a.clone().add(b).multiplyScalar(0.5); span = Math.max(0.05, a.distanceTo(b));
  }
  // her face is in front of the eye bones by a few cm (anime proportions): find the surface with a ray from the
  // front at eye height, and sit the glasses just in front of whatever it hits first (face or bangs)
  const eyeW = head.localToWorld(mid.clone());
  let frontZ = eyeW.z + 0.1;
  try {
    const meshes = []; avatar.vrm.scene.traverse((o) => { if (o.isMesh && o.visible) meshes.push(o); });
    const hit = new THREE.Raycaster(new THREE.Vector3(eyeW.x, eyeW.y, eyeW.z + 0.6), new THREE.Vector3(0, 0, -1), 0, 0.6).intersectObjects(meshes, false)[0];
    if (hit && hit.point.z > eyeW.z) frontZ = hit.point.z;
  } catch (e) { console.warn('gear fit', e); }
  const w = Math.max(0.17, span * 2.55);
  gear.headset.scale.setScalar(w);
  gear.headset.position.copy(head.worldToLocal(new THREE.Vector3(eyeW.x, eyeW.y - 0.008, frontZ + 0.016 + w * 0.08)));
  gear.fit = { eye: eyeW.toArray().map((x) => +x.toFixed(3)), frontZ: +frontZ.toFixed(3), w: +w.toFixed(3) };
  head.add(gear.headset);
  for (const s of ['left', 'right']) {
    const hand = N(s + 'Hand'), c = gear[s];
    // fingers point +x (her left) / -x (her right) in the rest frame; the grip sits in the curled fingers, ring forward
    c.position.set((s === 'left' ? 1 : -1) * 0.07, -0.02, 0.012);
    hand.add(c);
  }
  return { head, left: N('leftHand'), right: N('rightHand') };
}

// ---------------- multiplayer-lite (peer to peer) ----------------
const MAX_PEERS = 16, SEND_HZ = 8, IN_RATE = 24;   // states/second we send; most we accept per peer per second
function makeVisitor(scene, id, name) {
  let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const color = new THREE.Color().setHSL((h % 360) / 360, 0.65, 0.62);
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.9, 4, 10), new THREE.MeshLambertMaterial({ color }));
  body.position.y = 0.65; g.add(body);
  const face = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.09, 0.08), new THREE.MeshBasicMaterial({ color: 0x1a0f2e }));
  face.position.set(0, 1.12, -0.17); g.add(face);
  const tag = labelSprite(name, { size: 0.13 }); tag.position.y = 1.55; g.add(tag);
  g.userData = { id, name, tag, target: new THREE.Vector3(), yaw: 0, tyaw: 0, last: performance.now(), bucket: IN_RATE, bucketAt: performance.now() };
  scene.add(g);
  return g;
}

async function startNet(state, onEvent) {
  const roomId = String(q.get('room') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  if (!roomId) return null;
  let mod;
  try { mod = await import('trystero/nostr'); } catch (e) { onEvent('offline', e); return null; }
  const room = mod.joinRoom({ appId: 'jena-world-ncom-v1' }, 'room-' + roomId);
  // trystero 0.26: makeAction(name, { onMessage }) -> { send(data, { target }) }; peer events are properties
  const st = room.makeAction('st', { onMessage: (d, ctx) => onEvent('state', ctx?.peerId, d) });
  const sendState = (d, target) => st.send(d, target ? { target } : undefined).catch(() => {});
  const net = { room, roomId, selfId: mod.selfId, sendState, mod };
  room.onPeerJoin = (id) => { sendState(state(), id); onEvent('join', id); };
  room.onPeerLeave = (id) => onEvent('leave', id);
  return net;
}

// ---------------- the world ----------------
export async function startWorld() {
  const cfg = await loadConfig().catch(() => ({ vrmUrl: null }));
  const canvas = $('#world-canvas');
  const avatar = new Avatar(canvas, {});
  if (avatar.noGL) throw new Error('WebGL is off in this browser');
  avatar.cameraHeld = true;
  const { renderer, scene, camera } = avatar;
  renderer.xr.enabled = true;
  renderer.setClearColor(0x1b1030, 1);
  scene.background = new THREE.Color(0x1b1030);
  camera.fov = q.has('fov') ? clamp(+q.get('fov') || 60, 30, 100) : 60; camera.near = 0.05; camera.far = 40; camera.updateProjectionMatrix();
  // her room's own light on top of her avatar lights: a purple LED wash + a soft pink corner
  const ledLight = new THREE.PointLight(0xa36bff, 1.4, 9, 1.2); ledLight.position.set(0, 2.5, 0.4); scene.add(ledLight);
  const pink = new THREE.PointLight(0xff8fd1, 0.7, 6, 1.5); pink.position.set(2.2, 1.2, 2.2); scene.add(pink);
  const room = buildRoom(scene);
  const gear = buildGear();
  let motion = null, net = null, netState = q.get('room') ? 'connecting…' : 'solo';
  const visitors = new Map();
  const netLabel = () => net ? `room ${net.roomId} · ${visitors.size + 1} here` : netState;

  // HUD
  const hud = $('#world-hud'), osc = $('#w-osc'), pill = $('#w-net'), toastEl = $('#w-toast');
  const touch = matchMedia('(pointer: coarse)').matches; document.body.classList.toggle('touch', touch);
  let toastT; const toast = (t) => { toastEl.textContent = t; toastEl.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (toastEl.hidden = true), 3200); };
  let myName = cleanName(q.get('name')) || cleanName(localStorage.getItem('jena.world.name')) || randName();
  const nameIn = $('#w-name-in'); nameIn.value = myName;
  nameIn.addEventListener('change', () => { const n = cleanName(nameIn.value); if (n) { myName = n; localStorage.setItem('jena.world.name', n); toast('you are ' + n); } else { nameIn.value = myName; toast('pick a different name'); } });

  // VR: the official three.js button; joins through any WebXR browser (Quest, Pico, Vision Pro)
  const vrBtn = VRButton.createButton(renderer, { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
  vrBtn.style.pointerEvents = 'auto'; hud.appendChild(vrBtn);

  // player: desktop/touch move the camera; in VR the headset does, and we offset the reference space to walk
  const me = { x: 0, z: 2.6, yaw: 0, pitch: -0.06 };
  const sp = (q.get('spawn') || '').split(',').map(Number);
  if (sp.length >= 2 && sp.every(Number.isFinite)) { me.x = sp[0]; me.z = sp[1]; me.yaw = (sp[2] || 0) / R2D; me.pitch = (sp[3] || 0) / R2D; }
  const camQ = (q.get('cam') || '').split(',').map(Number);   // ?cam=x,y,z,yawDeg,pitchDeg (proof shots)
  const keys = new Set(); let pad = { x: 0, y: 0 };
  addEventListener('keydown', (e) => { if (e.target === nameIn) return; keys.add(e.code); });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  canvas.addEventListener('click', () => { if (!touch && !renderer.xr.isPresenting) canvas.requestPointerLock?.(); });
  addEventListener('mousemove', (e) => { if (document.pointerLockElement !== canvas) return; me.yaw -= e.movementX * 0.0025; me.pitch = clamp(me.pitch - e.movementY * 0.0025, -1.3, 1.3); });
  // touch: drag anywhere to look; the pad (bottom left) walks
  let look = null;
  canvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') return; look = { id: e.pointerId, x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointermove', (e) => { if (!look || e.pointerId !== look.id) return; me.yaw -= (e.clientX - look.x) * 0.006; me.pitch = clamp(me.pitch - (e.clientY - look.y) * 0.006, -1.3, 1.3); look.x = e.clientX; look.y = e.clientY; });
  canvas.addEventListener('pointerup', () => (look = null)); canvas.addEventListener('pointercancel', () => (look = null));
  const padEl = $('#w-pad'), knob = padEl.querySelector('i'); let padId = null;
  const padMove = (e) => { const r = padEl.getBoundingClientRect(); let x = (e.clientX - r.left) / r.width * 2 - 1, y = (e.clientY - r.top) / r.height * 2 - 1; const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; } pad = { x, y }; knob.style.transform = `translate(${x * 33}px, ${y * 33}px)`; };
  padEl.addEventListener('pointerdown', (e) => { padId = e.pointerId; padEl.setPointerCapture(e.pointerId); padMove(e); });
  padEl.addEventListener('pointermove', (e) => { if (e.pointerId === padId) padMove(e); });
  const padEnd = () => { padId = null; pad = { x: 0, y: 0 }; knob.style.transform = ''; };
  padEl.addEventListener('pointerup', padEnd); padEl.addEventListener('pointercancel', padEnd);

  // XR controllers for the VISITOR (their own hands), from the official webxr examples
  const ctrlFactory = new XRControllerModelFactory();
  const xrHands = [0, 1].map((i) => {
    const grip = renderer.xr.getControllerGrip(i); grip.add(ctrlFactory.createControllerModel(grip)); scene.add(grip);
    const ray = renderer.xr.getController(i); scene.add(ray); return { grip, ray };
  });
  let baseSpace = null;
  renderer.xr.addEventListener('sessionstart', () => { baseSpace = renderer.xr.getReferenceSpace(); applyXrOffset(); toast('welcome to her room in VR · thumbstick to walk'); });
  renderer.xr.addEventListener('sessionend', () => { baseSpace = null; });
  function applyXrOffset() {
    if (!baseSpace || typeof XRRigidTransform === 'undefined') return;
    // world pose = T(me) R(yaw) · headset pose  =>  origin offset = R(-yaw) T(-me)
    const c = Math.cos(-me.yaw), s = Math.sin(-me.yaw), px = -me.x, pz = -me.z;
    const pos = { x: c * px + s * pz, y: 0, z: -s * px + c * pz, w: 1 };
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -me.yaw);
    renderer.xr.setReferenceSpace(baseSpace.getOffsetReferenceSpace(new XRRigidTransform(pos, { x: qy.x, y: qy.y, z: qy.z, w: qy.w })));
  }

  // walking: stay inside the room, never walk through Jena
  function walk(dt) {
    let f = 0, r = 0, turn = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
    if (keys.has('KeyD')) r += 1;
    if (keys.has('KeyA')) r -= 1;
    if (keys.has('KeyQ') || keys.has('ArrowLeft')) turn += 1;
    if (keys.has('KeyE') || keys.has('ArrowRight')) turn -= 1;
    f -= pad.y; r += pad.x;
    let xrTurn = 0;
    if (renderer.xr.isPresenting) {
      for (const src of renderer.xr.getSession()?.inputSources || []) {
        const ax = src.gamepad?.axes; if (!ax || ax.length < 4) continue;
        const dx = Math.abs(ax[2]) > 0.15 ? ax[2] : 0, dy = Math.abs(ax[3]) > 0.15 ? ax[3] : 0;
        if (src.handedness === 'right') xrTurn -= dx; else { r += dx; f -= dy; }
      }
    }
    me.yaw += (turn * 1.8 + xrTurn * 1.6) * dt;
    if (!f && !r && !turn && !xrTurn) return false;
    // walk along where you're looking (in VR: where the headset faces)
    let yaw = me.yaw;
    if (renderer.xr.isPresenting) { const e = new THREE.Euler().setFromQuaternion(renderer.xr.getCamera().getWorldQuaternion(new THREE.Quaternion()), 'YXZ'); yaw = e.y; }
    const sp = 1.6 * dt, l = Math.hypot(f, r) || 1;
    let nx = me.x + (-Math.sin(yaw) * f + Math.cos(yaw) * r) / Math.max(1, l) * sp;
    let nz = me.z + (-Math.cos(yaw) * f - Math.sin(yaw) * r) / Math.max(1, l) * sp;
    nx = clamp(nx, ROOM.x0 + 0.35, ROOM.x1 - 0.35); nz = clamp(nz, ROOM.z0 + 0.35, ROOM.z1 - 0.35);
    const dj = Math.hypot(nx, nz); if (dj < 0.55) { nx *= 0.55 / (dj || 1); nz *= 0.55 / (dj || 1); }
    me.x = nx; me.z = nz;
    return true;
  }

  // ------------ Jena: speech bubble + her small talk ------------
  const bubble = labelSprite('', { size: 0.12, color: '#2a1450', bg: 'rgba(255,255,255,0.93)', border: '#c9a2ff' });
  bubble.visible = false; scene.add(bubble);
  let lastLine = '';
  let bubbleUntil = 0;
  const say = (text) => {
    text = String(text).slice(0, 120); lastLine = text;
    const ms = avatar.talkFor ? avatar.talkFor(text) : 3000;
    bubble.userData.set(text.length > 50 ? text.slice(0, 48) + '…' : text); bubble.visible = true;
    bubbleUntil = performance.now() + Math.max(2500, ms || 0) + 1200;
    paintScreen();
    return ms;
  };
  const LINES = [
    "welcome to my room! mama and Tab built it for me",
    "chat, look at my new headset. NCOM Focals PRO!",
    "you can walk around with WASD. don't trip on my bean bag lol",
    "my controllers follow my hands. see? *waves*",
    "got a VR headset? hit Enter VR and come say hi",
    "ok who keeps moving my plant",
    "this is my world. built different, W",
    "the stream screen is right there, cozy right?",
  ];
  let lineI = 0, nextLine = performance.now() + 4000;

  // ------------ readouts: the live pose numbers (HUD + a panel in the room for VR) ------------
  const panelTex = canvasTex(512, 300, () => {});
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.56), new THREE.MeshBasicMaterial({ map: panelTex, transparent: true }));
  panel.position.set(-1.6, 1.3, 0.5); panel.rotation.y = 0.55; scene.add(panel);
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.04, 1.05, 8), new THREE.MeshLambertMaterial({ color: 0x1d1030 })); stand.position.set(-1.6, 0.5, 0.5); scene.add(stand);
  const gearLabel = labelSprite('NCOM Focals PRO + controllers', { size: 0.075 }); scene.add(gearLabel);
  let bones = null;
  const _p = new THREE.Vector3(), _qq = new THREE.Quaternion(), _e = new THREE.Euler();
  const f2 = (v) => (v >= 0 ? ' ' : '') + v.toFixed(2), f1 = (v) => { const s = v.toFixed(1); return s.padStart(6); };
  function pose(node) { node.getWorldPosition(_p); node.getWorldQuaternion(_qq); _e.setFromQuaternion(_qq, 'YXZ'); return { p: [_p.x, _p.y, _p.z], r: [_e.x * R2D, _e.y * R2D, _e.z * R2D] }; }
  const oscLines = () => {
    if (!bones) return ['NCOM Focals PRO · waiting for Jena…'];
    const H = pose(bones.head), L = pose(bones.left), Rr = pose(bones.right);
    const row = (addr, a, fmt) => addr.padEnd(22) + a.map(fmt).join(' ');
    const out = [
      'NCOM Focals PRO · OSC out · 10 Hz',
      row('/tracking/head/pos', H.p, f2), row('/tracking/head/rot', H.r, f1),
      row('/tracking/hand/L/pos', L.p, f2), row('/tracking/hand/L/rot', L.r, f1),
      row('/tracking/hand/R/pos', Rr.p, f2), row('/tracking/hand/R/rot', Rr.r, f1),
      '/avatar/move'.padEnd(22) + (motion?.active?.map((a) => a.id).join(',') || 'idle').slice(0, 24),
    ];
    if (renderer.xr.isPresenting) { const c = renderer.xr.getCamera(); c.getWorldPosition(_p); out.push('/you/head/pos'.padEnd(22) + [_p.x, _p.y, _p.z].map(f2).join(' ')); }
    out.push('/net'.padEnd(22) + netLabel());
    return out;
  };
  let oscAt = 0, panelAt = 0;
  function paintPanel(lines) {
    const { c, g } = panelTex.userData;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(14,6,28,0.9)'; g.strokeStyle = '#a77bff'; g.lineWidth = 4; g.beginPath(); g.roundRect(4, 4, c.width - 8, c.height - 8, 18); g.fill(); g.stroke();
    g.font = '600 19px ui-monospace, Menlo, Consolas, monospace'; g.textBaseline = 'top';
    lines.forEach((l, i) => { g.fillStyle = i === 0 ? '#ffffff' : '#d9c6ff'; g.fillText(l, 18, 16 + i * 29, c.width - 30); });
    panelTex.needsUpdate = true;
  }
  function paintScreen() {
    const { c, g } = room.screenTex.userData, w = c.width, h = c.height;
    const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#2a1060'); gr.addColorStop(1, '#8a4dff'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ff4d6d'; g.beginPath(); g.roundRect(20, 18, 86, 34, 8); g.fill();
    g.fillStyle = '#fff'; g.font = '800 22px system-ui, sans-serif'; g.textBaseline = 'middle'; g.fillText('LIVE', 36, 36);
    g.font = '900 64px system-ui, sans-serif'; g.fillText("JENA'S WORLD", 20, 112, w - 40);
    g.font = '600 22px system-ui, sans-serif'; g.fillStyle = '#e9d8ff'; g.fillText('NCOM Focals PRO · WebXR · ' + netLabel(), 22, 162, w - 40);
    g.fillStyle = 'rgba(255,255,255,.14)'; g.fillRect(16, 196, w - 32, 74);
    g.fillStyle = '#fff'; g.font = '600 24px system-ui, sans-serif';
    g.fillText(lastLine ? '“' + (lastLine.length > 38 ? lastLine.slice(0, 37) + '…' : lastLine) + '”' : 'say hi to Jena!', 30, 233, w - 60);
    room.screenTex.needsUpdate = true;
  }

  // ------------ network ------------
  const setPill = () => { pill.textContent = netLabel(); pill.classList.toggle('on', !!net && visitors.size > 0); };
  const myState = () => {
    let x = me.x, z = me.z, y = EYE, yaw = me.yaw;
    if (renderer.xr.isPresenting) { const c = renderer.xr.getCamera(); c.getWorldPosition(_p); x = _p.x; y = _p.y; z = _p.z; _e.setFromQuaternion(c.getWorldQuaternion(_qq), 'YXZ'); yaw = _e.y; }
    return { v: 1, n: myName, p: [+x.toFixed(3), +y.toFixed(3), +z.toFixed(3)], y: +yaw.toFixed(3), vr: renderer.xr.isPresenting ? 1 : 0 };
  };
  const onNet = (ev, id, d) => {
    if (ev === 'offline') { netState = 'solo (offline)'; console.warn('world net offline', id); window.__worldNetErr = String(id?.stack || id); setPill(); return; }
    if (ev === 'leave') { const v = visitors.get(id); if (v) { scene.remove(v); visitors.delete(id); toast(v.userData.name + ' left'); } setPill(); return; }
    if (ev === 'join') { setPill(); return; }
    if (ev !== 'state' || !d || typeof d !== 'object') return;
    let v = visitors.get(id);
    const now = performance.now();
    if (v) {   // per-peer token bucket: anything past IN_RATE states/second is dropped
      const u = v.userData; u.bucket = Math.min(IN_RATE, u.bucket + (now - u.bucketAt) / 1000 * IN_RATE); u.bucketAt = now;
      if (u.bucket < 1) return; u.bucket -= 1;
    }
    const p = Array.isArray(d.p) ? d.p.map(Number) : null;
    if (!p || p.length !== 3 || !p.every(Number.isFinite)) return;
    const x = clamp(p[0], ROOM.x0, ROOM.x1), y = clamp(p[1], 0.5, 2.4), z = clamp(p[2], ROOM.z0, ROOM.z1), yaw = Number.isFinite(+d.y) ? +d.y : 0;
    const name = cleanName(d.n) || 'visitor';
    if (!v) {
      if (visitors.size >= MAX_PEERS) return;
      v = makeVisitor(scene, id, name); visitors.set(id, v); v.position.set(x, 0, z);
      toast(name + ' joined'); setPill();
      motion?.seenUser(name);
      if (avatar.ready) setTimeout(() => say(`hi ${name}! welcome to my room`), 400);
    }
    const u = v.userData;
    if (u.name !== name) { u.name = name; u.tag.userData.set(name); }
    u.target.set(x, Math.max(0, y - EYE), z); u.tyaw = yaw; u.last = now;
  };
  startNet(myState, onNet).then((n) => {
    net = n; if (!n) { setPill(); return; }
    setPill(); toast('in room ' + n.roomId + ' · share the link to bring friends');
    // if no relay socket opens, say so honestly (still works solo)
    setTimeout(() => {
      try { const socks = Object.values(n.mod.getRelaySockets?.() || {}); if (socks.length && !socks.some((s) => s.readyState === 1)) { netState = 'solo (no relay reachable)'; net = null; setPill(); } } catch {}
    }, 9000);
  }).catch((e) => { console.warn('net', e); window.__worldNetErr = String(e?.stack || e); netState = 'solo (offline)'; setPill(); });
  $('#w-invite').addEventListener('click', async () => {
    if (!q.get('room')) { q.set('room', Math.random().toString(36).slice(2, 8)); location.search = q.toString(); return; }
    const url = location.origin + location.pathname + '?room=' + encodeURIComponent(q.get('room'));
    try { await navigator.clipboard.writeText(url); toast('link copied: send it to a friend'); } catch { prompt('send this link to a friend', url); }
  });
  let sendAt = 0, lastSent = '';

  // ------------ per frame (before her pose + render) ------------
  avatar.preHooks = [(dt, raw) => {
    const now = performance.now();
    const moved = walk(Math.min(raw, 0.1));
    if (renderer.xr.isPresenting) { if (moved) applyXrOffset(); }
    else if (camQ.length === 5 && camQ.every(Number.isFinite) && !moved && !document.pointerLockElement) {
      camera.position.set(camQ[0], camQ[1], camQ[2]); camera.rotation.set(camQ[4] / R2D, camQ[3] / R2D, 0, 'YXZ');
    } else {
      if (moved || document.pointerLockElement) camQ.length = 0;
      camera.position.set(me.x, EYE, me.z); camera.rotation.set(me.pitch, me.yaw, 0, 'YXZ');
    }
    // visitors glide toward their last state; quiet ones fade out after 12 s
    for (const [id, v] of visitors) {
      const u = v.userData; v.position.lerp(u.target, 1 - Math.exp(-raw * 10));
      let dy = u.tyaw - v.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); v.rotation.y += dy * (1 - Math.exp(-raw * 10));
      if (now - u.last > 12000) { scene.remove(v); visitors.delete(id); setPill(); }
    }
    // send my state (rate-limited; only when it changed, plus a 1 Hz heartbeat)
    if (net && now > sendAt) {
      const s = myState(), key = JSON.stringify([s.p, s.y, s.n]);
      if (key !== lastSent || now - sendAt > 1000) { try { net.sendState(s); } catch {} lastSent = key; }
      sendAt = now + 1000 / SEND_HZ;
    }
    if (avatar.ready && bones) {
      // bubble over her head, label under the gear
      bones.head.getWorldPosition(_p);
      bubble.position.set(_p.x, _p.y + 0.42, _p.z); if (bubble.visible && now > bubbleUntil) bubble.visible = false;
      gearLabel.position.set(_p.x + 0.4, _p.y + 0.16, _p.z + 0.1);
      if (now > nextLine && now > (avatar.talk?.until || 0) + 3000) {
        const line = LINES[lineI++ % LINES.length]; say(line);
        if (/waves/.test(line)) try { motion.play('direct_wave', { trigger: 'world' }); } catch {}
        nextLine = now + 13000 + Math.random() * 6000;
      }
    }
    if (now > oscAt) { oscAt = now + 100; const L = oscLines(); osc.textContent = L.join('\n'); if (now > panelAt) { panelAt = now + 250; paintPanel(L); } }
  }];

  paintScreen(); setInterval(paintScreen, 5000);
  // her body: the same VRM and motion code as the main page
  try { await avatar.load(cfg.vrmUrl); }
  catch (e) { console.warn('vrm', e); await avatar.load(cfg.vrmFallbackUrl); }
  try { avatar.springSetup = setupSprings(avatar.vrm); } catch (e) { console.warn('springs', e); }
  // grounding: her feet raycast down onto the room's floor (src/avatar.js updateFeet), so they never float or sink
  { const fl = room.getObjectByName('floor'); if (fl) avatar.groundObjects = [fl]; }
  motion = new Motion(avatar, {});
  bones = wearGear(avatar, gear);
  avatar.gazeAt('camera', 4000);
  $('#world-loading').classList.add('gone'); hud.hidden = false;
  if (q.get('say')) setTimeout(() => say(String(q.get('say')).slice(0, 100)), 600);
  window.jenaWorld = { avatar, motion, gear, visitors, me, say, get net() { return net; }, pose: () => bones && { head: pose(bones.head), left: pose(bones.left), right: pose(bones.right) }, cleanName };
  return window.jenaWorld;
}
