// Her BODY panel from other angles: back, side, top, below (front is her self-vision view, which also
// runs the pose model on her rendered body). Rendered from her real scene with a second camera a few
// times a second, with her real skeleton (from her bones) drawn over it. She picks angles herself too.
import * as THREE from 'three';
const BONES = [['hips', 'spine'], ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ...['left', 'right'].flatMap((s) => [['chest', `${s}UpperArm`], [`${s}UpperArm`, `${s}LowerArm`], [`${s}LowerArm`, `${s}Hand`], [`${s}Hand`, `${s}MiddleProximal`], [`${s}Hand`, `${s}ThumbDistal`],
    ['hips', `${s}UpperLeg`], [`${s}UpperLeg`, `${s}LowerLeg`], [`${s}LowerLeg`, `${s}Foot`], [`${s}Foot`, `${s}Toes`]])];
export const VIEWS = ['front', 'back', 'side', 'top', 'below'];

export class BodyViews {
  constructor(avatar, canvas, label, { hz = 6 } = {}) {
    this.avatar = avatar; this.canvas = canvas; this.label = label;
    this.w = 120; this.h = 240;
    this.cam = new THREE.PerspectiveCamera(30, this.w / this.h, 0.05, 20);
    this.rt = new THREE.WebGLRenderTarget(this.w, this.h); this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    this.px = new Uint8Array(this.w * this.h * 4);
    this.tmp = document.createElement('canvas'); this.tmp.width = this.w; this.tmp.height = this.h;
    this.img = this.tmp.getContext('2d').createImageData(this.w, this.h);
    this.every = 1000 / hz; this.last = 0;
    this.view = 'front';
    avatar.frameHooks.push(() => this.frame());
  }
  set(view, who = 'mama') {
    if (!VIEWS.includes(view)) return;
    this.view = view; window.__jenaBodyView = view; this.by = who;
    document.querySelectorAll('#body-views button').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
  }
  frame() {
    const now = performance.now();
    if (this.view === 'front' || now - this.last < this.every || document.hidden || !this.canvas.isConnected || !this.avatar.vrm) return;
    this.last = now;
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
    r.setRenderTarget(this.rt); r.clear(); r.render(a.scene, this.cam); r.readRenderTargetPixels(this.rt, 0, 0, this.w, this.h, this.px); r.setRenderTarget(prev);
    a.scene.background = bg; if (floor) floor.visible = true;
    // flip rows (GL is bottom-up)
    const W = this.w, Hh = this.h, src = this.px, dst = this.img.data;
    for (let y = 0; y < Hh; y++) dst.set(src.subarray((Hh - 1 - y) * W * 4, (Hh - y) * W * 4), y * W * 4);
    const c = this.canvas; if (c.width !== W || c.height !== Hh) { c.width = W; c.height = Hh; }
    const g = c.getContext('2d'); this.tmp.getContext('2d').putImageData(this.img, 0, 0); g.drawImage(this.tmp, 0, 0);
    // her real skeleton, projected through the same camera
    const P = (n) => { const b = H.getNormalizedBoneNode(n); if (!b) return null; const p = b.getWorldPosition(new THREE.Vector3()).project(this.cam); return [(p.x + 1) / 2 * W, (1 - p.y) / 2 * Hh]; };
    g.lineWidth = 2;
    for (const [x, y] of BONES) {
      const p = P(x), q = P(y); if (!p || !q) continue;
      g.strokeStyle = /left/.test(y) ? '#1fb37a' : /right/.test(y) ? '#e0288f' : '#7a4fd6';
      g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke();
    }
    // her center of mass over her feet (balance), from her bones
    const com = this.avatar.balance?.(); if (com) { const p = new THREE.Vector3(com.x, 0.002, com.z).project(this.cam); g.fillStyle = com.ok ? '#3ddc84' : '#ff5d6c'; g.beginPath(); g.arc((p.x + 1) / 2 * W, (1 - p.y) / 2 * Hh, 3.5, 0, 7); g.fill(); }
    if (this.label) this.label.textContent = `body · ${this.view}${this.by === 'jena' ? ' (her pick)' : ''}`;
  }
}
