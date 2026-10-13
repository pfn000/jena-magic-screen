// Jena's self-view (dev panel "🪞 Her body" tab; Saidie, Oct 13: "what about HER in the dev view because she's gonna
// need to understand herself"). Drawn live from her real body: window.jena.selfState (every bone off the live VRM,
// every expression), the move playing, and her own self-tracking checks, measured here every 100 ms:
//   hands inside her torso (clipping), fingers bent backwards, feet floating off the floor, and her pose score vs
//   the move she's copying (src/selfcheck.js). The same numbers ride every brain request (bodyBrief().selfTrack), so
//   she can talk about her own body.
const SK = [['hips', 'spine'], ['spine', 'chest'], ['chest', 'upperChest'], ['upperChest', 'neck'], ['chest', 'neck'], ['neck', 'head'],
  ['upperChest', 'leftShoulder'], ['leftShoulder', 'leftUpperArm'], ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'],
  ['upperChest', 'rightShoulder'], ['rightShoulder', 'rightUpperArm'], ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
  ['hips', 'leftUpperLeg'], ['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'], ['leftFoot', 'leftToes'],
  ['hips', 'rightUpperLeg'], ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot'], ['rightFoot', 'rightToes']];
const FING = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const JOINTS = { Thumb: ['Metacarpal', 'Proximal', 'Distal'], Index: ['Proximal', 'Intermediate', 'Distal'], Middle: ['Proximal', 'Intermediate', 'Distal'], Ring: ['Proximal', 'Intermediate', 'Distal'], Little: ['Proximal', 'Intermediate', 'Distal'] };
const FCOL = { Thumb: '#ff6b6b', Index: '#ffd93d', Middle: '#6bcB77', Ring: '#4d96ff', Little: '#c77dff' };
const PARTS = { head: ['head', 'neck'], chest: ['upperChest', 'chest', 'spine'], hips: ['hips'],
  'L arm': ['leftUpperArm', 'leftLowerArm'], 'R arm': ['rightUpperArm', 'rightLowerArm'], 'L hand': ['leftHand'], 'R hand': ['rightHand'],
  'L leg': ['leftUpperLeg', 'leftLowerLeg'], 'R leg': ['rightUpperLeg', 'rightLowerLeg'], 'L foot': ['leftFoot', 'leftToes'], 'R foot': ['rightFoot', 'rightToes'] };
const PCOL = { head: '#ffffff', chest: '#3cb4ff', hips: '#ff78c8', 'L arm': '#3ddc84', 'R arm': '#ff9628', 'L hand': '#6eff50', 'R hand': '#ffb050', 'L leg': '#27a85a', 'R leg': '#e0702a', 'L foot': '#8cf08c', 'R foot': '#ffaa6e' };

// ---- live self-tracking checks (cheap: positions she already reads every frame) ----
export class SelfTrack {
  constructor() { this.win = []; this.now = null; this.timer = setInterval(() => this.tick(), 100); }
  tick() {
    const S = window.jena?.selfState; if (!S || !S.bones) return;
    const B = S.bones, P = (n) => B[n]?.pos;
    const ls = P('leftUpperArm'), rs = P('rightUpperArm'), hip = P('hips'), neck = P('neck'), ch = P('upperChest') || P('chest');
    if (!ls || !rs || !hip || !neck || !ch) return;
    const sw = Math.hypot(ls.x - rs.x, ls.z - rs.z) || 0.3, a = sw * 0.36, b = a * 0.75;
    let clip = []; for (const s of ['left', 'right']) {
      const h = P(s + 'Hand'), l = P(s + 'LowerArm'); if (!h || !l) continue;
      for (const p of [h, { x: (h.x + l.x) / 2, y: (h.y + l.y) / 2, z: (h.z + l.z) / 2 }])
        if (p.y > hip.y - 0.1 && p.y < neck.y && ((p.x - ch.x) / a) ** 2 + ((p.z - ch.z) / b) ** 2 < 1) { clip.push(s); break; }
    }
    let back = []; for (const s of ['left', 'right']) for (const f of ['Index', 'Middle', 'Ring', 'Little']) for (const j of ['Proximal', 'Intermediate', 'Distal']) {
      const r = B[s + f + j]?.rot?.z; if (r == null) continue; if (r * (s === 'left' ? -1 : 1) < -5.7) back.push(`${s} ${f.toLowerCase()}`);
    }
    back = [...new Set(back)];
    const feet = ['left', 'right'].map((s) => Math.min(...['Foot', 'Toes'].map((k) => P(s + k)?.y ?? 9)));
    const mv = window.jenaMoves?.playing, jumpy = mv && ['dance', 'happy'].includes(mv.c?.kind);
    const floaty = Math.min(...feet) > 0.07 && !jumpy;   // both feet off the floor while not dancing
    this.now = { at: Date.now(), clipping: clip, fingersBackwards: back, feetLowest: +Math.min(...feet).toFixed(3), floaty };
    this.win.push({ t: Date.now(), c: clip.length > 0, b: back.length > 0, f: floaty }); while (this.win.length && this.win[0].t < Date.now() - 60000) this.win.shift();
  }
  summary() {
    const n = this.win.length || 1, pc = (k) => Math.round(1000 * this.win.filter((x) => x[k]).length / n) / 10;
    const sc = window.jenaMoves?.selfCheck, last = sc?.last;
    return { window_s: 60, samples: this.win.length, clippingPct: pc('c'), fingersBackwardsPct: pc('b'), floatyFeetPct: pc('f'), now: this.now,
      poseScore: last ? { overall: last.overall ?? last.score?.overall ?? null, say: last.say || null } : null };
  }
}

const proj = (p, cx, cy, s) => [cx + p.x * s, cy - p.y * s];   // her left (+x) is the screen's right: she faces you
function drawHand(g, B, side, x, y, w, h) {
  const pts = []; const wr = B[side + 'Hand']?.pos; if (!wr) return;
  const all = [wr]; for (const f of FING) for (const j of JOINTS[f]) { const p = B[side + f + j]?.pos; if (p) all.push(p); }
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y), mx = (Math.min(...xs) + Math.max(...xs)) / 2, my = (Math.min(...ys) + Math.max(...ys)) / 2;
  const ext = Math.max(0.09, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.25, s = Math.min(w, h) / ext;
  const P = (p) => [x + w / 2 + (p.x - mx) * s, y + h / 2 - (p.y - my) * s];
  g.fillStyle = '#10141c'; g.fillRect(x, y, w, h); g.strokeStyle = side === 'left' ? '#6eff50' : '#ffb050'; g.lineWidth = 3; g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  for (const f of FING) {
    let prev = P(wr); g.strokeStyle = FCOL[f]; g.lineWidth = Math.max(3, w / 45); g.lineCap = 'round';
    for (const j of JOINTS[f]) { const p = B[side + f + j]?.pos; if (!p) continue; const q = P(p); g.beginPath(); g.moveTo(...prev); g.lineTo(...q); g.stroke(); prev = q;
      g.fillStyle = '#000'; g.beginPath(); g.arc(...q, Math.max(5, w / 28), 0, 7); g.fill(); g.fillStyle = FCOL[f]; g.beginPath(); g.arc(...q, Math.max(3.5, w / 36), 0, 7); g.fill(); }
  }
  g.fillStyle = '#fff'; g.beginPath(); g.arc(...P(wr), Math.max(6, w / 24), 0, 7); g.fill();
  g.font = `600 ${Math.max(13, w / 13)}px system-ui`; g.fillStyle = side === 'left' ? '#6eff50' : '#ffb050'; g.fillText(side === 'left' ? 'her LEFT hand' : 'her RIGHT hand', x + 8, y + Math.max(18, w / 10));
}
export function mountSelfView(host, track) {
  host.innerHTML = `<style>
    .sv-wrap{display:flex;flex-wrap:wrap;gap:10px}.sv-c{flex:1 1 300px;max-width:520px}.sv-c canvas{width:100%;display:block;border-radius:8px;background:#0b0e14}
    .sv-n{flex:1 1 260px;font-size:14px;line-height:1.45}.sv-n b{color:#fff}.sv-bar{display:flex;align-items:center;gap:6px;margin:2px 0}.sv-bar i{display:block;height:10px;background:#3cb4ff;border-radius:3px}
    .sv-big{font-size:17px;font-weight:700;margin:6px 0}.sv-ok{color:#3ddc84}.sv-bad{color:#ff5a5a}.sv-leg{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:13px;margin-top:6px}</style>
    <div class="sv-wrap"><div class="sv-c"><canvas class="sv-body"></canvas><canvas class="sv-hands" style="margin-top:8px"></canvas>
    <div class="sv-leg">${Object.entries(PCOL).map(([k, c]) => `<span><b style="color:${c}">■</b> ${k}</span>`).join('')}${FING.map((f) => `<span><b style="color:${FCOL[f]}">●</b> ${f.toLowerCase()}</span>`).join('')}</div></div>
    <div class="sv-n"></div></div>`;
  const cb = host.querySelector('.sv-body'), chd = host.querySelector('.sv-hands'), num = host.querySelector('.sv-n');
  let tick = 0;
  const draw = () => {
    if (!host.isConnected) { clearInterval(timer); return; }
    const S = window.jena?.selfState; if (!S?.bones) { num.innerHTML = '<p>her body has not loaded on this page yet</p>'; return; }
    const B = S.bones, dpr = Math.min(2, devicePixelRatio || 1), W = cb.clientWidth || 320, H = Math.round(W * 1.15);
    if (cb.width !== Math.round(W * dpr)) { cb.width = Math.round(W * dpr); cb.height = Math.round(H * dpr); cb.style.height = H + 'px'; }
    const g = cb.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); g.fillStyle = '#0b0e14'; g.fillRect(0, 0, W, H);
    const ys = Object.values(B).map((b) => b.pos.y), top = Math.max(...ys) + 0.15, bot = Math.min(...ys, 0) - 0.05, s = (H - 30) / (top - bot);
    const cx = W / 2, cy = 15 + top * s, Pp = (n) => B[n]?.pos && proj(B[n].pos, cx, cy, s);
    g.strokeStyle = '#2a3140'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, cy); g.lineTo(W, cy); g.stroke(); g.fillStyle = '#556'; g.font = '12px system-ui'; g.fillText('floor', 6, cy - 4);
    const tr = track?.now || {};
    // body-part boxes, labelled
    for (const [k, bones] of Object.entries(PARTS)) {
      const pts = bones.map(Pp).filter(Boolean); if (!pts.length) continue;
      const pad = k === 'head' ? 26 : 12; let x0 = Math.min(...pts.map((p) => p[0])) - pad, x1 = Math.max(...pts.map((p) => p[0])) + pad, y0 = Math.min(...pts.map((p) => p[1])) - pad, y1 = Math.max(...pts.map((p) => p[1])) + pad;
      if (k === 'head') y0 -= 20;
      const bad = (k.endsWith('hand') && tr.clipping?.includes(k[0] === 'L' ? 'left' : 'right')) || (k.endsWith('foot') && tr.floaty);
      g.fillStyle = PCOL[k] + '22'; g.fillRect(x0, y0, x1 - x0, y1 - y0); g.strokeStyle = bad ? '#ff3b3b' : PCOL[k]; g.lineWidth = bad ? 4 : 2; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      g.font = '600 13px system-ui'; const tw = g.measureText(k).width; g.fillStyle = '#000c'; g.fillRect(x0, y0 - 17, tw + 8, 17); g.fillStyle = bad ? '#ff5a5a' : PCOL[k]; g.fillText(k, x0 + 4, y0 - 4);
    }
    // skeleton
    g.lineCap = 'round';
    for (const [a, b] of SK) { const p = Pp(a), q = Pp(b); if (!p || !q) continue; g.strokeStyle = '#000'; g.lineWidth = 9; g.beginPath(); g.moveTo(...p); g.lineTo(...q); g.stroke(); g.strokeStyle = '#ffdc00'; g.lineWidth = 5; g.beginPath(); g.moveTo(...p); g.lineTo(...q); g.stroke(); }
    for (const n of Object.keys(B)) { if (/Thumb|Index|Middle|Ring|Little|Eye|Jaw/.test(n)) continue; const p = Pp(n); if (!p) continue; g.fillStyle = '#000'; g.beginPath(); g.arc(...p, 6, 0, 7); g.fill(); g.fillStyle = '#ffdc00'; g.beginPath(); g.arc(...p, 4, 0, 7); g.fill(); }
    // fingers on the body view too
    for (const sd of ['left', 'right']) for (const f of FING) { let prev = Pp(sd + 'Hand'); for (const j of JOINTS[f]) { const q = Pp(sd + f + j); if (!q || !prev) continue; g.strokeStyle = FCOL[f]; g.lineWidth = 2.5; g.beginPath(); g.moveTo(...prev); g.lineTo(...q); g.stroke(); prev = q; } }
    // face: where she looks + mouth open
    const hd = Pp('head'); if (hd) { const E = S.expressions || {}, mo = Math.max(E.aa || 0, E.oh || 0, E.ou || 0, E.ih || 0, E.ee || 0), bl = E.blink || Math.max(E.blinkLeft || 0, E.blinkRight || 0);
      const fx = hd[0] + (S.head?.yaw || 0) * 0.6, fy = hd[1] - s * 0.07; g.fillStyle = '#fff'; for (const dx of [-1, 1]) { g.beginPath(); g.ellipse(fx + dx * s * 0.032, fy, s * 0.012, Math.max(1, s * 0.012 * (1 - bl)), 0, 0, 7); g.fill(); }
      g.strokeStyle = '#ff78c8'; g.lineWidth = 3; g.beginPath(); g.ellipse(fx, fy + s * 0.05, s * 0.022, Math.max(1.5, s * 0.022 * mo), 0, 0, 7); g.stroke(); }
    // hands close-up
    const HW = cb.clientWidth || 320, HH = Math.round(HW / 2);
    if (chd.width !== Math.round(HW * dpr)) { chd.width = Math.round(HW * dpr); chd.height = Math.round(HH * dpr); chd.style.height = HH + 'px'; }
    const h2 = chd.getContext('2d'); h2.setTransform(dpr, 0, 0, dpr, 0, 0); h2.clearRect(0, 0, HW, HH);
    drawHand(h2, B, 'right', 0, 0, HW / 2 - 4, HH); drawHand(h2, B, 'left', HW / 2 + 4, 0, HW / 2 - 4, HH);   // screen left = her right
    if (tick++ % 3) return;   // numbers ~3x a second
    const E = S.expressions || {}, sum = track?.summary?.() || {}, mv = window.jenaMoves?.playing, F = S.feel || {};
    const fc = (side) => Math.round(['Index', 'Middle', 'Ring', 'Little'].map((f) => Math.abs(B[`${side}${f}Proximal`]?.rot?.z || 0) + Math.abs(B[`${side}${f}Intermediate`]?.rot?.z || 0)).reduce((a, b) => a + b, 0) / 4);
    const ex = Object.entries(E).filter(([k]) => !/^look/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const okv = (v, lim) => `<span class="${v > lim ? 'sv-bad' : 'sv-ok'}">${v}%</span>`;
    num.innerHTML = `<div class="sv-big">${mv ? `🎵 doing: ${esc(mv.c?.label || mv.c?.what || mv.c?.id)} <small>(${mv.c?.fingers ? 'fingers' : 'no fingers'} + ${mv.c?.face ? 'face' : 'no face'} tracked${mv.mirror ? ', mirrored' : ''})</small>` : '🧍 no move playing: idle'}</div>
      <p><b>what I feel:</b> ${esc(Object.entries(F).filter(([, v]) => v && v !== 'none' && v !== 'still' && v !== 'relaxed' && v !== 'neutral').map(([k, v]) => v === true ? k : `${k}: ${v}`).join(' · ') || 'standing easy')}</p>
      <p><b>head</b> yaw ${S.head?.yaw}° · pitch ${S.head?.pitch}° · roll ${S.head?.roll}° · <b>eyes</b> ${S.lookAt?.yaw}°/${S.lookAt?.pitch}°</p>
      <p><b>fingers</b> bend: left ${fc('left')}° · right ${fc('right')}° (${S.counts?.bones || 0} bones read)</p>
      <div class="sv-big">self-check (last 60 s)</div>
      <p>hands inside my body: ${okv(sum.clippingPct ?? 0, 2)} · fingers bent backwards: ${okv(sum.fingersBackwardsPct ?? 0, 0)} · floaty feet: ${okv(sum.floatyFeetPct ?? 0, 2)}<br>
      <small>right now: ${tr.clipping?.length ? `<span class="sv-bad">${tr.clipping.join(' + ')} hand in torso</span>` : 'no clipping'} · ${tr.fingersBackwards?.length ? `<span class="sv-bad">${esc(tr.fingersBackwards.join(', '))} bent back</span>` : 'fingers ok'} · lowest foot ${tr.feetLowest ?? '–'} m${tr.floaty ? ' <span class="sv-bad">(floating)</span>' : ''}</small></p>
      ${sum.poseScore ? `<p><b>pose vs the move:</b> ${sum.poseScore.overall ?? '–'}%${sum.poseScore.say ? ` · “${esc(sum.poseScore.say)}”` : ''}</p>` : ''}
      <div class="sv-big">face shapes</div>${ex.map(([k, v]) => `<div class="sv-bar"><span style="width:84px">${esc(k)}</span><i style="width:${Math.round(v * 150)}px;${v > 0.4 ? 'background:#ff78c8' : ''}"></i><span>${v.toFixed(2)}</span></div>`).join('')}
      <p><small>${S.counts?.expressions || 0} face shapes · this same self-state rides every message to her brain, so she can talk about her own body</small></p>`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const timer = setInterval(draw, 100); draw();
}
