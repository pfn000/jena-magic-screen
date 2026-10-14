// Jena's FACE view: a small front camera on her face only (forehead to chin), rendered a few times a second
// into an offscreen target, with her eyes and where they look marked from her real eye bones / lookAt.
// Live expression, blink, mouth and gaze values sit underneath (filled by her self-sense).
import * as THREE from 'three';
import { canReadAsync, shown, flipInto } from './snapshot.js';

export class FacePanel {
  constructor(avatar, canvas, { hz = 24, size = 144 } = {}) {
    this.avatar = avatar;
    this.canvas = canvas;
    this.size = size;
    this.cam = new THREE.PerspectiveCamera(20, 1, 0.05, 10);
    this.rt = new THREE.WebGLRenderTarget(size, size);
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    this.pixels = new Uint8Array(size * size * 4);
    this.tmp = document.createElement('canvas');
    this.tmp.width = this.tmp.height = size;
    this.img = this.tmp.getContext('2d').createImageData(size, size);
    this.last = 0;
    this.every = 1000 / hz;
    this.v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    avatar.frameHooks.push((vrm) => this.frame(vrm));
  }

  frame(vrm) {
    const now = performance.now();
    if (this.reading || !shown(this.canvas)) return;
    // async GPU read: smooth ~24 Hz without stalling the stage; old browsers: blocking read, 5 Hz like before
    const async = canReadAsync(this.avatar.renderer);
    if (now - this.last < (async ? Math.max(1000 / (this.avatar.panelHz?.() || 24), 16) : 200)) return;   // up to 60 Hz when the device keeps up (avatar.adaptPixels)
    this.last = now;
    const H = vrm.humanoid, head = H.getNormalizedBoneNode('head');
    if (!head) return;
    const [hp, el, er] = this.v;
    head.getWorldPosition(hp);
    const le = H.getNormalizedBoneNode('leftEye'), re = H.getNormalizedBoneNode('rightEye');
    // face centre: between the eyes if she has eye bones, a little above the head joint otherwise
    const fc = le && re ? el.setFromMatrixPosition(le.matrixWorld).add(er.setFromMatrixPosition(re.matrixWorld)).multiplyScalar(0.5).clone() : hp.clone().add(new THREE.Vector3(0, 0.06, 0));
    fc.y -= 0.025; // eyes sit above the middle of the face
    // straight in front of her body (not her head), so a head turn shows as a turn
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(H.normalizedHumanBonesRoot.getWorldQuaternion(new THREE.Quaternion()));
    const dist = 0.115 / Math.tan(THREE.MathUtils.degToRad(this.cam.fov / 2)); // ~23 cm of face, forehead to chin
    this.cam.position.copy(fc).addScaledVector(fwd, dist);
    this.cam.lookAt(fc);
    this.cam.updateMatrixWorld();
    const r = this.avatar.renderer, floor = this.avatar.floor;
    if (floor) floor.visible = false;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.rt);
    r.setClearColor(0xece6f6, 1);
    r.clear();
    r.render(this.avatar.scene, this.cam);
    r.setRenderTarget(prev);
    r.setClearColor(0x000000, 0);
    if (floor) floor.visible = true;
    // where her eyes are and where they look, as of THIS render (painted when the pixels arrive)
    const eyes = [];
    if (le && re) {
      const yaw = vrm.lookAt?.yaw || 0, pitch = vrm.lookAt?.pitch || 0; // degrees; +yaw = her left (screen right), +pitch = down
      const S = this.size;
      for (const [node, col] of [[le, '#14b8a6'], [re, '#ec4899']]) {
        const q = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld).project(this.cam);
        eyes.push({ x: (q.x + 1) / 2 * S, y: (1 - q.y) / 2 * S, yaw, pitch, col });
      }
    }
    if (async) {
      this.reading = true;
      r.readRenderTargetPixelsAsync(this.rt, 0, 0, this.size, this.size, this.pixels)
        .then(() => this.paint(eyes)).catch(() => {}).finally(() => { this.reading = false; });
    } else {
      r.readRenderTargetPixels(this.rt, 0, 0, this.size, this.size, this.pixels);
      this.paint(eyes);
    }
  }

  paint(eyes) {
    const S = this.size;
    flipInto(this.pixels, this.img, S, S, true); // GL rows are bottom-up
    const c = this.canvas;
    if (c.width !== S) { c.width = c.height = S; }
    const g = c.getContext('2d');
    g.putImageData(this.img, 0, 0);
    // her eyes + where they're looking (from her real eye bones and lookAt)
    if (eyes.length) {
      g.lineWidth = 1.2; g.lineCap = 'round';
      for (const { x, y, yaw, pitch, col } of eyes) {
        g.strokeStyle = col; g.beginPath(); g.arc(x, y, 6, 0, 7); g.stroke();
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + yaw * 0.6, y + pitch * 0.6); g.stroke();
        g.fillStyle = col; g.beginPath(); g.arc(x + yaw * 0.6, y + pitch * 0.6, 1.6, 0, 7); g.fill();
      }
      g.font = '700 10px system-ui, sans-serif';
      g.fillStyle = '#0f766e'; g.fillText('L', S - 12, 14);
      g.fillStyle = '#be185d'; g.fillText('R', 5, 14);
    }
  }
}
