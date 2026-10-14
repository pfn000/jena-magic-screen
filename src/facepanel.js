// Jena's FACE view: a small front camera on her face only (forehead to chin), rendered a few times a second
// into an offscreen target, with her eyes and where they look marked from her real eye bones / lookAt.
// Live expression, blink, mouth and gaze values sit underneath (filled by her self-sense).
import * as THREE from 'three';
import { canReadAsync, shown, flipInto, panelPx } from './snapshot.js';

export class FacePanel {
  constructor(avatar, canvas, { hz = 24, size = 144 } = {}) {
    this.avatar = avatar;
    this.canvas = canvas;
    this.cam = new THREE.PerspectiveCamera(20, 1, 0.05, 10);
    this.setSize(size);
    this.last = 0;
    this.every = 1000 / hz;
    this.v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    avatar.frameHooks.push((vrm) => this.frame(vrm));
  }
  // the render size follows the panel's CSS size x the stage's current pixel ratio (crisp on a 3x iPhone,
  // stepped down with the stage by the quality governor); the GPU target is rebuilt only when it changes
  setSize(S) {
    if (S === this.size && this.rt) return;
    this.size = S;
    this.rt?.dispose();
    this.rt = new THREE.WebGLRenderTarget(S, S, { samples: 0 });
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    this.rt.texture.minFilter = this.rt.texture.magFilter = THREE.LinearFilter;
    this.pixels = new Uint8Array(S * S * 4);
    this.tmp = document.createElement('canvas');
    this.tmp.width = this.tmp.height = S;
    this.img = this.tmp.getContext('2d').createImageData(S, S);
  }

  frame(vrm) {
    const now = performance.now();
    if (this.reading || !shown(this.canvas)) return;
    // async GPU read: smooth ~24 Hz without stalling the stage; old browsers: blocking read, 5 Hz like before
    const async = canReadAsync(this.avatar.renderer);
    if (now - this.last < (async ? Math.max(1000 / (this.avatar.panelHz?.() || 24), 16) : 200)) return;   // up to 60 Hz when the device keeps up (avatar.adaptPixels)
    this.last = now;
    const px = panelPx(this.canvas, this.avatar, 1);
    if (px && !this.reading) this.setSize(px.w);
    const H = vrm.humanoid, head = H.getNormalizedBoneNode('head');
    if (!head) return;
    const [hp, el, er] = this.v;
    head.getWorldPosition(hp);
    const le = H.getNormalizedBoneNode('leftEye'), re = H.getNormalizedBoneNode('rightEye');
    // WHOLE HEAD in frame (hair top to chin, ears, a little margin), framed on her head bone so it follows her.
    // The head joint sits at the base of the skull; an anime head with its hair is about 0.19 of her height
    // tall, centred a bit above that joint. Measured once per model from her real head mesh when it can be.
    const ht = this.avatar.height || 1.5;
    const f = (this._fit && this._fitVrm === vrm) ? this._fit : (this._fitVrm = vrm, this._fit = this.fitHead(vrm, head, ht));
    const fc = hp.clone().add(new THREE.Vector3(0, f.up, 0));
    // straight in front of her body (not her head), so a head turn shows as a turn
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(H.normalizedHumanBonesRoot.getWorldQuaternion(new THREE.Quaternion()));
    const dist = f.half / Math.tan(THREE.MathUtils.degToRad(this.cam.fov / 2));
    this.cam.near = Math.max(0.02, dist * 0.3);
    this.cam.position.copy(fc).addScaledVector(fwd, dist);
    this.cam.lookAt(fc);
    this.cam.updateProjectionMatrix();
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

  // how tall her head is (hair included) above/below the head joint, from the skinned vertices her head bone
  // (and its children: hair, ears) mostly drive; falls back to proportions of her height
  fitHead(vrm, head, ht) {
    let lo = Infinity, hi = -Infinity;
    try {
      const raw = vrm.humanoid.getRawBoneNode('head'), under = new Set(); raw.traverse((o) => under.add(o));
      const hy = raw.getWorldPosition(new THREE.Vector3()).y, v = new THREE.Vector3();
      vrm.scene.updateMatrixWorld(true);
      vrm.scene.traverse((o) => {
        if (!o.isSkinnedMesh) return;
        const sk = o.skeleton, pos = o.geometry.attributes.position, si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight;
        if (!pos || !si || !sw) return;
        const hb = sk.bones.map((b) => under.has(b));
        const step = Math.max(1, Math.floor(pos.count / 20000));
        for (let i = 0; i < pos.count; i += step) {
          let w = 0; for (let k = 0; k < 4; k++) if (hb[si.getComponent(i, k)]) w += sw.getComponent(i, k);
          if (w < 0.6) continue;
          o.getVertexPosition(i, v); o.localToWorld(v); // getVertexPosition applies skinning (three r150+)
          const dy = v.y - hy; if (dy < -0.25 || dy > 0.5) continue;
          if (dy < lo) lo = dy; if (dy > hi) hi = dy;
        }
      });
    } catch (e) { console.warn('face fit', e); }
    if (!(hi > lo) || hi - lo < 0.08) { lo = -ht * 0.03; hi = ht * 0.165; }
    const m = (hi - lo) * 0.09; // margin
    return { up: (hi + lo) / 2, half: (hi - lo) / 2 + m, lo, hi };
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
      const k = S / 144; // overlay drawn in the same proportions at any resolution
      g.lineWidth = 1.2 * k; g.lineCap = 'round';
      for (const { x, y, yaw, pitch, col } of eyes) {
        g.strokeStyle = col; g.beginPath(); g.arc(x, y, 4 * k, 0, 7); g.stroke();
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + yaw * 0.4 * k, y + pitch * 0.4 * k); g.stroke();
        g.fillStyle = col; g.beginPath(); g.arc(x + yaw * 0.4 * k, y + pitch * 0.4 * k, 1.4 * k, 0, 7); g.fill();
      }
      g.font = `700 ${Math.round(10 * k)}px system-ui, sans-serif`;
      g.fillStyle = '#0f766e'; g.fillText('L', S - 12 * k, 14 * k);
      g.fillStyle = '#be185d'; g.fillText('R', 5 * k, 14 * k);
    }
  }
}
