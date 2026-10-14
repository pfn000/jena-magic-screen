// DEV PANEL: Jena's face up close + what her face and eyes are doing, live (Saidie, Oct 13 10:43 PM).
// - a second camera on her face, rendered into a small render target ~12 times a second and drawn on a canvas
// - live bars: her learned-expression channels (fcl.*) and the preset expressions (blink, happy, aa...) as they are set
// - rig points on the face (eyes, head, neck), eye bone yaw/pitch, blink, and the name of her current gaze target
// - GAZE RAY: a line in the 3D scene from between her eyes to the real lookAt target that drives her eyes, a hit
//   marker on it, and the hit projected onto the page with a crosshair + "looking at: <element under it>"
// Off by default; the dev panel's "Face + gaze" tab toggles it, ?faceview=1 opens it. Never on stream/viewer layouts.
import * as THREE from 'three';

export class FaceView {
  constructor(avatar, cfg = {}) {
    this.avatar = avatar; this.cfg = cfg; this.on = false; this.last = 0;
    if (cfg.stream) return;
    if (new URLSearchParams(location.search).get('faceview') === '1') setTimeout(() => this.toggle(true), 500);
  }
  build() {
    if (this.el) return;
    const el = (this.el = document.createElement('div'));
    el.id = 'jena-faceview';
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;width:min(300px,46vw);background:rgba(16,10,28,.92);color:#eee;font:11px/1.25 system-ui,sans-serif;border:1px solid #6b3fa0;border-radius:10px;padding:6px;box-shadow:0 4px 18px #0008;pointer-events:auto';
    el.innerHTML = '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><b>👀 face + gaze</b><span class="fv-gz" style="margin-left:auto;color:#ffd84d"></span><button class="fv-x" style="background:none;border:0;color:#ccc;cursor:pointer">✕</button></div>'
      + '<div style="position:relative"><canvas class="fv-c" width="256" height="256" style="width:100%;aspect-ratio:1;display:block;border-radius:6px;background:#000"></canvas></div>'
      + '<div class="fv-eyes" style="margin:4px 0;color:#bdf"></div><div class="fv-track" style="margin:4px 0"></div><div class="fv-bars" style="max-height:120px;overflow:auto"></div>';
    document.body.appendChild(el);
    el.querySelector('.fv-x').onclick = () => this.toggle(false);
    this.canvas = el.querySelector('.fv-c'); this.ctx = this.canvas.getContext('2d');
    this.rt = new THREE.WebGLRenderTarget(256, 256);
    this.cam = new THREE.PerspectiveCamera(24, 1, 0.05, 20);
    this.px = new Uint8Array(256 * 256 * 4); this.img = this.ctx.createImageData(256, 256);
    // the 3D gaze ray + hit marker, and the page crosshair
    this.ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xffd84d, depthTest: false, transparent: true }));
    this.ray.renderOrder = 999; this.ray.frustumCulled = false;
    this.hit = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff4fa3, depthTest: false }));
    this.hit.renderOrder = 999;
    const ch = (this.cross = document.createElement('div'));
    ch.id = 'jena-gaze-cross';
    ch.style.cssText = 'position:fixed;z-index:2147483001;pointer-events:none;width:26px;height:26px;margin:-13px 0 0 -13px;border:2px solid #ffd84d;border-radius:50%;box-shadow:0 0 0 2px #0008, 0 0 14px #ffd84d;display:none';
    ch.innerHTML = '<span style="position:absolute;left:30px;top:2px;white-space:nowrap;background:#000c;color:#ffd84d;font:600 12px system-ui;padding:1px 6px;border-radius:6px"></span>';
    document.body.appendChild(ch);
  }
  toggle(v = !this.on) {
    if (this.cfg.stream) return false;
    this.on = v; this.build();
    this.el.style.display = v ? '' : 'none'; this.cross.style.display = 'none';
    const sc = this.avatar.scene;
    if (v) { sc.add(this.ray); sc.add(this.hit); if (!this._hooked) { this._hooked = true; (this.avatar.frameHooks ||= []).push(() => this.frame()); } }
    else { sc.remove(this.ray); sc.remove(this.hit); }
    return v;
  }
  // what is under a page point, in words
  nameAt(x, y) {
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return 'off-screen';
    this.cross.style.display = 'none';
    let e = document.elementFromPoint(x, y);
    const said = (n) => n?.getAttribute?.('aria-label') || n?.id || (typeof n?.className === 'string' && n.className.split(' ')[0]) || n?.tagName?.toLowerCase();
    for (let k = 0; e && k < 6; k++, e = e.parentElement) {
      const id = (e.id || '') + ' ' + (typeof e.className === 'string' ? e.className : '');
      if (/chat/i.test(id)) return 'chat box';
      if (/desktop|vnc|screen/i.test(id)) return 'her desktop';
      if (/devpanel/i.test(id)) return 'dev panel';
      if (/notes?|panel|card/i.test(id)) return said(e);
      if (e.tagName === 'CANVAS') return 'her own scene';
    }
    return said(document.elementFromPoint(x, y)) || 'page';
  }
  frame() {
    if (!this.on) return;
    const now = performance.now(); if (now - this.last < 80) return; this.last = now;
    const A = this.avatar, vrm = A.vrm; if (!vrm) return;
    const H = vrm.humanoid, V = (n) => H.getRawBoneNode(n)?.getWorldPosition(new THREE.Vector3());
    const head = V('head'), le = V('leftEye'), re = V('rightEye');
    const mid = le && re ? le.clone().add(re).multiplyScalar(0.5) : head.clone().add(new THREE.Vector3(0, 0.06, 0.05));
    const tgt = A.gaze ? A.gaze.getWorldPosition(new THREE.Vector3()) : A.camera.position.clone();
    // ray in the scene (to the real eye target; capped so a far target stays readable)
    const dir = tgt.clone().sub(mid), len = dir.length(), end = len > 3 ? mid.clone().add(dir.multiplyScalar(3 / len)) : tgt;
    this.ray.geometry.setFromPoints([mid, end]); this.hit.position.copy(end);
    // the face camera: in front of her face, wherever she turned (her head's own forward from the eye line)
    const lr = le && re ? le.clone().sub(re) : new THREE.Vector3(1, 0, 0);
    const fwd = new THREE.Vector3(-lr.z, 0, lr.x).normalize();
    this.cam.position.copy(mid).addScaledVector(fwd, 0.55).add(new THREE.Vector3(0, 0.02, 0));
    this.cam.lookAt(mid.x, mid.y - 0.02, mid.z);
    const R = A.renderer, keep = R.getRenderTarget(), vis = [this.ray.visible, this.hit.visible];
    this.ray.visible = this.hit.visible = true;
    R.setRenderTarget(this.rt); R.clear(); R.render(A.scene, this.cam); R.readRenderTargetPixels(this.rt, 0, 0, 256, 256, this.px); R.setRenderTarget(keep);
    [this.ray.visible, this.hit.visible] = vis;
    const d = this.img.data;
    for (let y = 0; y < 256; y++) d.set(this.px.subarray((255 - y) * 1024, (256 - y) * 1024), y * 1024);   // GL rows are bottom-up
    this.ctx.putImageData(this.img, 0, 0);
    // rig points on the face (projected through the face camera)
    const g = this.ctx, P = (v) => { const p = v.clone().project(this.cam); return [(p.x + 1) * 128, (1 - p.y) * 128]; };
    g.fillStyle = '#3ddc84';
    for (const n of ['leftEye', 'rightEye', 'head', 'neck']) { const v = V(n); if (!v) continue; const [x, y] = P(v); g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill(); g.fillText(n.replace('Eye', ' eye'), x + 4, y - 3); }
    g.strokeStyle = '#ffd84d'; g.lineWidth = 2; { const [x0, y0] = P(mid), [x1, y1] = P(end); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); }
    // eyes: bone yaw/pitch, blink, target
    const eb = H.getNormalizedBoneNode('leftEye'), em = vrm.expressionManager;
    const deg = (r) => (r * 57.3).toFixed(0) + '°';
    const blink = em ? Math.max(em.getValue('blink') || 0, em.getValue('blinkLeft') || 0) : 0;
    const what = A.gazeNow || A.gazeGoal?.what || 'camera';
    // the target on the page
    const sp = tgt.clone().project(A.camera), rect = R.domElement.getBoundingClientRect();
    let label = what;
    if (sp.z < 1) {
      const x = rect.left + (sp.x + 1) / 2 * rect.width, y = rect.top + (1 - sp.y) / 2 * rect.height;
      const onPage = this.nameAt(x, y);
      label = what === 'camera' ? 'you (the viewer camera)' : `${what} · ${onPage}`;
      Object.assign(this.cross.style, { display: '', left: Math.max(0, Math.min(innerWidth, x)) + 'px', top: Math.max(0, Math.min(innerHeight, y)) + 'px' });
    } else { label = what === 'camera' ? 'you (the viewer camera)' : what + ' (behind the camera)'; this.cross.style.display = 'none'; }
    // a named target that lives on the page (her desktop, the chat): mark that element itself when the 3D point
    // falls off the visible page
    const SEL = { desktop: '#desktop', chat: '#chat, #chat-box, [id*="chat"]', notes: '#notes, [id*="note"]' };
    if (what !== 'camera' && (sp.z >= 1 || /off-screen/.test(label)) && SEL[what]) {
      const elx = [...document.querySelectorAll(SEL[what])].find((e) => { const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 20 && getComputedStyle(e).visibility !== 'hidden'; });
      if (elx) { const r = elx.getBoundingClientRect(), x = Math.max(4, Math.min(innerWidth - 4, r.left + r.width / 2)), y = Math.max(4, Math.min(innerHeight - 4, r.top + r.height / 2)); label = `${what} · ${this.nameAt(x, y)}`; Object.assign(this.cross.style, { display: '', left: x + 'px', top: y + 'px' }); }
    }
    this.cross.firstChild.textContent = 'looking at: ' + label;
    this.el.querySelector('.fv-gz').textContent = 'looking at: ' + label;
    this.el.querySelector('.fv-eyes').textContent = `eyes yaw ${deg(eb?.rotation.y || 0)} pitch ${deg(eb?.rotation.x || 0)} · blink ${(blink * 100).toFixed(0)}% · gaze ${what}`;
    // per-channel face tracking (arkitface.js): each lid, cheek, brow part and the jaw, her LEFT and RIGHT apart
    const AS = A.arkface?.state?.();
    if (AS) {
      const m = (lab, v) => `<div style="display:flex;gap:3px;align-items:center;font-size:10px"><span style="width:58px;white-space:nowrap">${lab}</span><span style="flex:1;height:6px;background:#2a2040;border-radius:3px"><span style="display:block;height:6px;width:${Math.round(v * 100)}%;background:#ffd84d;border-radius:3px"></span></span><span style="width:20px;text-align:right">${Math.round(v * 100)}</span></div>`;
      const col = (t, S) => `<div style="flex:1;min-width:0"><b style="font-size:10px">${t}</b>${m('upper lid', S.upperLid)}${m('lower lid', S.lowerLid)}${m('blink', S.blink)}${m('cheek', S.cheek)}${m('brow down', S.browDown)}${m('brow up', S.browOuter)}${m('smile', S.smile)}</div>`;
      this.el.querySelector('.fv-track').innerHTML = `<div style="font-size:10px;color:#bbb">tracking → ${AS.targets}${AS.sources.length ? ' · from ' + AS.sources.join(', ') : ' · idle'}</div>`
        + `<div style="display:flex;gap:8px">${col('her RIGHT', AS.right)}${col('her LEFT', AS.left)}</div>`
        + `<div style="display:flex;gap:8px"><div style="flex:1">${m('jaw open', AS.jawOpen)}${m('cheek puff', AS.cheekPuff)}</div><div style="flex:1">${m('brow inner', AS.browInnerUp)}${m('pucker', AS.pucker)}</div></div>`;
    }
    // bars: every expression channel above zero, biggest first
    const vals = [];
    if (em) for (const ex of em.expressions || []) { const v = em.getValue(ex.expressionName) || 0; if (v > 0.01) vals.push([ex.expressionName.replace(/^fcl\./, ''), v]); }
    vals.sort((a, b) => b[1] - a[1]);
    this.el.querySelector('.fv-bars').innerHTML = vals.slice(0, 14).map(([n, v]) => `<div style="display:flex;gap:4px;align-items:center"><span style="width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${n}</span><span style="flex:1;height:7px;background:#2a2040;border-radius:4px"><span style="display:block;height:7px;width:${(v * 100).toFixed(0)}%;background:linear-gradient(90deg,#a46bff,#ff4fa3);border-radius:4px"></span></span><span style="width:28px;text-align:right">${(v * 100).toFixed(0)}</span></div>`).join('') || '<i>neutral face</i>';
    this.state = { label, what, blink: +blink.toFixed(2), eyeYaw: +(eb?.rotation.y || 0).toFixed(3), bars: vals.length };
  }
}
