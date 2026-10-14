// Her BODY panel from other angles: back, side, top, below (front is her self-vision view, which also
// runs the pose model on her rendered body). Rendered from her real scene with a second camera a few
// times a second, with her real skeleton (from her bones) drawn over it. She picks angles herself too.
import * as THREE from 'three';
import { canReadAsync, shown, flipInto, panelPx } from './snapshot.js';
const BONES = [['hips', 'spine'], ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ...['left', 'right'].flatMap((s) => [['chest', `${s}UpperArm`], [`${s}UpperArm`, `${s}LowerArm`], [`${s}LowerArm`, `${s}Hand`], [`${s}Hand`, `${s}MiddleProximal`], [`${s}Hand`, `${s}ThumbDistal`],
    ['hips', `${s}UpperLeg`], [`${s}UpperLeg`, `${s}LowerLeg`], [`${s}LowerLeg`, `${s}Foot`], [`${s}Foot`, `${s}Toes`]])];
export const VIEWS = ['front', 'back', 'side', 'top', 'below'];

export class BodyViews {
  constructor(avatar, canvas, label, { hz = 24 } = {}) {
    this.avatar = avatar; this.canvas = canvas; this.label = label;
    this.cam = new THREE.PerspectiveCamera(30, 0.5, 0.05, 20);
    this.setSize(120, 240);
    this.every = 1000 / hz; this.last = 0;
    this.view = 'front';
    avatar.frameHooks.push(() => this.frame());
  }
  // crisp at the panel's CSS size x the stage's current pixel ratio (the quality governor steps both together)
  setSize(w, h) {
    if (w === this.w && h === this.h && this.rt) return;
    this.w = w; this.h = h;
    this.rt?.dispose();
    this.rt = new THREE.WebGLRenderTarget(w, h); this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    this.px = new Uint8Array(w * h * 4);
    this.tmp = document.createElement('canvas'); this.tmp.width = w; this.tmp.height = h;
    this.img = this.tmp.getContext('2d').createImageData(w, h);
  }
  set(view, who = 'mama') {
    if (!VIEWS.includes(view)) return;
    this.view = view; window.__jenaBodyView = view; this.by = who;
    document.querySelectorAll('#body-views button').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
  }
  frame() {
    const now = performance.now();
    if (this.view === 'front' || this.reading || !shown(this.canvas) || !this.avatar.vrm) return;
    // async GPU read: smooth ~24 Hz without stalling the stage; old browsers: blocking read, 6 Hz like before
    const async = canReadAsync(this.avatar.renderer);
    if (now - this.last < (async ? Math.max(1000 / (this.avatar.panelHz?.() || 24), 16) : 166)) return;   // up to 60 Hz when the device keeps up
    this.last = now;
    const px = panelPx(this.canvas, this.avatar, 2, { min: 120 }); if (px) this.setSize(px.w, px.h);
    const a = this.avatar, H = a.vrm.humanoid, hips = H.getNormalizedBoneNode('hips').getWorldPosition(new THREE.Vector3());
    const ht = a.height || 1.5, mid = new THREE.Vector3(hips.x, ht * 0.5, hips.z);
    const d = ht * 1.9;
    const pos = { back: [0, 0, -d], side: [d, 0, 0], top: [0.001, d * 0.9, 0], below: [0.001, -d * 0.9, 0.001] }[this.view];
    this.cam.position.set(mid.x + pos[0], mid.y + pos[1], mid.z + pos[2]);
    this.cam.up.set(0, 1, 0); if (this.view === 'top' || this.view === 'below') this.cam.up.set(0, 0, -1);
    this.cam.lookAt(mid);
    this.cam.aspect = this.w / this.h;
    this.cam.updateProjectionMatrix();
    const r = a.renderer, prev = r.getRenderTarget(), floor = a.floor;
    if (this.view === 'below' && floor) floor.visible = false; // see her from under the floor
    const bg = a.scene.background; a.scene.background = new THREE.Color(0xece6f6);
    r.setRenderTarget(this.rt); r.clear(); r.render(a.scene, this.cam); r.setRenderTarget(prev);
    a.scene.background = bg; if (floor) floor.visible = true;
    const W = this.w, Hh = this.h;
    // her real skeleton + balance, projected through the same camera at THIS render (painted when pixels arrive)
    const P = (n) => { const b = H.getNormalizedBoneNode(n); if (!b) return null; const p = b.getWorldPosition(new THREE.Vector3()).project(this.cam); return [(p.x + 1) / 2 * W, (1 - p.y) / 2 * Hh]; };
    const lines = [];
    for (const [x, y] of BONES) { const p = P(x), q = P(y); if (p && q) lines.push([p, q, /left/.test(y) ? '#1fb37a' : /right/.test(y) ? '#e0288f' : '#7a4fd6']); }
    const com = this.avatar.balance?.();
    const dot = com ? (() => { const p = new THREE.Vector3(com.x, 0.002, com.z).project(this.cam); return [(p.x + 1) / 2 * W, (1 - p.y) / 2 * Hh, com.ok]; })() : null;
    if (async) {
      this.reading = true;
      r.readRenderTargetPixelsAsync(this.rt, 0, 0, W, Hh, this.px).then(() => this.paint(lines, dot)).catch(() => {}).finally(() => { this.reading = false; });
    } else { r.readRenderTargetPixels(this.rt, 0, 0, W, Hh, this.px); this.paint(lines, dot); }
  }
  paint(lines, dot) {
    if (this.view === 'front') return; // switched back while the pixels were on their way
    const W = this.w, Hh = this.h;
    flipInto(this.px, this.img, W, Hh); // GL is bottom-up
    const c = this.canvas; if (c.width !== W || c.height !== Hh) { c.width = W; c.height = Hh; }
    const g = c.getContext('2d'); this.tmp.getContext('2d').putImageData(this.img, 0, 0); g.drawImage(this.tmp, 0, 0);
    const k = W / 120; g.lineWidth = 2 * k;
    for (const [p, q, col] of lines) { g.strokeStyle = col; g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); }
    // her center of mass over her feet (balance), from her bones
    if (dot) { g.fillStyle = dot[2] ? '#3ddc84' : '#ff5d6c'; g.beginPath(); g.arc(dot[0], dot[1], 3.5 * k, 0, 7); g.fill(); }
    if (this.label) this.label.textContent = `body · ${this.view}${this.by === 'jena' ? ' (her pick)' : ''}`;
  }
}
