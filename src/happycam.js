// src/happycam.js — Jena's avatar on the magic screen: the approved HAPPY Jena 2.5D camera rig (camfix20).
// Ported from her Discord camera player (ops/jena-discord-voice/jcam.js, camfix20) with two site changes: frames load
// per file on demand, and speech comes from the site's own voice (tap) or the words she is saying.
// ===== Jena live camera — camfix20 (2026-10-26; camfix19 rig + logic, plus: speech-start hurry capped at 60 ms then a cut, no flow morph while hurrying, blink 250 ms). HONEST LABEL: this is 2.5D, not a 3D model. Every picture is a
// pre-rendered 2D frame; head turns are real frames of one generated head-turn video (pre-rendered angles), plus a tiny
// whole-picture drift/tilt (a 2D transform) so she is never frozen.
// camfix19 changes (review CAMFIX-REVIEW6 FAIL):
//  - rig rebuilt: only frames with both eyes open and a happy look are left. Rest = frames 0-7, the big open happy smile
//    (the IMG_3647 look). All head-tilted sly / half-lidded / head-down look-up frames and every old talking frame are gone.
//  - blink = a cut to the both-eyes-shut composite of the exact rest frame she is on (no 55% in-between = no wink look).
//  - speech = a cut to a mouth/jaw composite on the rest frame she is on: her eyes stay the rest frame's calm happy eyes.
//    15 open-mouth shapes in 4 loudness levels, smoothed envelope + hysteresis, a fresh shape every ~0.1-0.19 s, never the
//    same shape twice in a row; short pauses show her rest smile (also open-mouthed), never a closed grin.
//  - she faces the camera while someone else is talking (listening), so a reply starts from the front: the mouth starts
//    on the first voiced tick (or the moment the reply audio is scheduled), not after a walk through the frame graph.
const jcam = (() => {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const spring = (s, target, k, c, dt) => { const n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n; for (let i = 0; i < n; i++) { const a = k * (target - s.x) - c * s.v; s.v += a * h; s.x += s.v * h; } if (!isFinite(s.x)) { s.x = target; s.v = 0; } return s.x; };
  const b64u8 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };

  window.__jcamMake = async (rig, jv) => {
    const W = rig.W, H = rig.H, FR = rig.frames, N = FR.length, CL = rig.clips, GX = rig.flow.gx, GY = rig.flow.gy, FU = rig.flow.unit;
    const urlOf = (f) => rig.base + 'f' + String(f).padStart(3, '0') + '.jpg';   // site: one real rig frame per file, fetched when needed
    const flows = new Int8Array(b64u8(rig.flow.data).buffer);
    const adj = Array.from({ length: N }, () => []);
    for (let k = 0; k < rig.pairs.length; k += 4) { const a = rig.pairs[k], b = rig.pairs[k + 1], d = rig.pairs[k + 2] / 100, fo = rig.pairs[k + 3];
      adj[a].push({ b, d, fo, sg: 1 }); adj[b].push({ b: a, d, fo, sg: -1 }); }
    const kindOf = (f) => CL[FR[f].c].kind;
    // ---------- decoded-frame cache (LRU of ImageBitmaps; frames decode a few ticks ahead of need)
    const cache = new Map(), pend = new Set(); const CAP = rig.cacheCap || 64; let useTick = 0;
    const ensure = (f) => { if (f < 0 || cache.has(f) || pend.has(f)) { if (cache.has(f)) cache.get(f).u = useTick; return; }
      pend.add(f); fetch(urlOf(f)).then((r) => { if (!r.ok) throw new Error('frame ' + f + ' ' + r.status); return r.blob(); }).then((b) => createImageBitmap(b)).then((bm) => { pend.delete(f); cache.set(f, { bm, u: useTick });
        if (cache.size > CAP) { let lo = null, lu = 1e18; for (const [k, v] of cache) if (v.u < lu && k !== shownA && k !== shownB) { lu = v.u; lo = k; } if (lo != null) { cache.get(lo).bm.close(); cache.delete(lo); } } })
        .catch(() => pend.delete(f)); };
    const bmOf = (f) => { const e = cache.get(f); if (e) { e.u = useTick; return e.bm; } return null; };
    // ---------- output
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const st = { frames: 0, drawn: [], mode: 'gl', vis: 'rest', visHist: {}, blinks: 0, saccades: 0, rms: 0, t0: performance.now(), errs: 0, ver: 'camfix20',
      pose: [0, 0, 0], poseLog: [], turns: 0, jumps: 0, morphs: 0, misses: 0, revs: 0, force: null, forceAmp: null, cur: 0 };
    let gl = null; try { gl = out.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false }); } catch (e) {}
    let o2 = null, tA, tB, tF, uT, uOn, uX; const xf = [0, 0, 1.035, 0];
    if (gl) { try {
      const vs = 'attribute vec2 p; varying vec2 v; uniform vec4 X; uniform float AR; void main(){ v=vec2(p.x*0.5+0.5, 0.5-p.y*0.5); vec2 q=p*X.z; float c=cos(X.w), s=sin(X.w); gl_Position=vec4(q.x*c-q.y*s*AR+X.x, q.x*s/AR+q.y*c+X.y, 0.0, 1.0); }';   // camfix19: tiny 2D drift/tilt (X: dx, dy, scale, angle)
      // flow-aligned morph: A is warped forward along the A->B flow by t, B backward by (1-t), then mixed by t
      const fs = 'precision mediump float; varying vec2 v; uniform sampler2D A; uniform sampler2D B; uniform sampler2D F; uniform float t; uniform float on; uniform vec2 U;'
        + 'void main(){ vec2 f = (texture2D(F, v).rg * 255.0 - 128.0) * U * on; vec4 a = texture2D(A, v - t * f); vec4 b = texture2D(B, v + (1.0 - t) * f); gl_FragColor = mix(a, b, t * on); }';
      const sh = (ty, s) => { const x = gl.createShader(ty); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
      const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link'); gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const lp = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 0, 0);
      const mkT = (unit) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 12, 30, 255])); return t; };
      tA = mkT(0); tB = mkT(1); tF = mkT(2);
      gl.uniform1i(gl.getUniformLocation(prog, 'A'), 0); gl.uniform1i(gl.getUniformLocation(prog, 'B'), 1); gl.uniform1i(gl.getUniformLocation(prog, 'F'), 2);
      uT = gl.getUniformLocation(prog, 't'); uOn = gl.getUniformLocation(prog, 'on'); uX = gl.getUniformLocation(prog, 'X'); gl.uniform1f(gl.getUniformLocation(prog, 'AR'), H / W); gl.uniform4f(uX, 0, 0, 1.035, 0);
      gl.uniform2f(gl.getUniformLocation(prog, 'U'), FU / W, FU / H); gl.viewport(0, 0, W, H);
    } catch (e) { st.glErr = String(e).slice(0, 200); gl = null; } }
    if (!gl) { st.mode = '2d'; o2 = out.getContext('2d', { alpha: false }); }
    const fbuf = new Uint8Array(GX * GY * 4);
    const upFlow = (fo, sg) => { for (let i = 0; i < GX * GY; i++) { fbuf[i * 4] = 128 + sg * flows[fo + i * 2]; fbuf[i * 4 + 1] = 128 + sg * flows[fo + i * 2 + 1]; fbuf[i * 4 + 2] = 0; fbuf[i * 4 + 3] = 255; }
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, tF); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, GX, GY, 0, gl.RGBA, gl.UNSIGNED_BYTE, fbuf); };
    let shownA = -1, shownB = -1, shownFo = -1;
    const draw = (a, b, t, e) => {   // returns false if a frame is not decoded yet
      const A = bmOf(a), B = b >= 0 ? bmOf(b) : null; if (!A || (b >= 0 && !B)) return false;
      if (gl) {
        if (shownA !== a) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tA); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, A); shownA = a; }
        if (b >= 0) { if (shownB !== b) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tB); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, B); shownB = b; }
          const key = e.fo * e.sg; if (shownFo !== key) { upFlow(e.fo, e.sg); shownFo = key; } }
        gl.uniform4f(uX, xf[0], xf[1], xf[2], xf[3]); gl.uniform1f(uT, b >= 0 ? t : 0); gl.uniform1f(uOn, b >= 0 ? 1 : 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      } else { o2.setTransform(1, 0, 0, 1, 0, 0); o2.translate(W / 2 + xf[0] * W / 2, H / 2 - xf[1] * H / 2); o2.rotate(-xf[3]); o2.scale(xf[2], xf[2]);
        o2.globalAlpha = 1; o2.drawImage(A, -W / 2, -H / 2, W, H); if (b >= 0) { o2.globalAlpha = t; o2.drawImage(B, -W / 2, -H / 2, W, H); o2.globalAlpha = 1; } }
      return true; };

    // ---------- audio -> speech state (same analyser rules as r3/r4: her own outgoing voice, approximate, not phonemes)
    let an = null, td = null, fd = null, binHz = 0;
    const ensureAn = () => { if (an || !jv || !jv.analyser) return; try { an = jv.analyser(); if (!an) return; td = new Float32Array(an.fftSize); fd = new Float32Array(an.frequencyBinCount); binHz = an.context.sampleRate / an.fftSize; } catch (e) { an = null; st.anErr = String(e); } };   // site: a tap on her real voice audio (src/voice.js)
    const vs = { voicedAt: -1e9, silentAt: 0, was: false, amp: 0, cur: 'rest' }; let peak = 0.05;
    const classify = (now) => {
      if (st.force) return { v: st.force, amp: st.forceAmp == null ? 0.8 : st.forceAmp, voiced: true };
      if (jv && jv.textDrive) { const x = jv.textDrive(now); if (x) return x; }   // site: voice muted -> her mouth follows the words of the bubble she is saying
      ensureAn(); if (!an) return { v: 'rest', amp: 0, voiced: false };
      an.getFloatTimeDomainData(td); let s = 0; for (const x of td) s += x * x; const rms = Math.sqrt(s / td.length); st.rms = rms;
      peak = Math.max(rms, peak * 0.9985, 0.03);
      const voiced = rms > Math.max(0.009, 0.1 * peak);
      if (!voiced) { if (vs.was) { vs.silentAt = now; vs.was = false; } return { v: now - vs.silentAt < 170 && now - vs.voicedAt < 1500 ? 'M' : 'rest', amp: 0, voiced: false }; }
      vs.was = true;
      an.getFloatFrequencyData(fd); let hs = 0, nhs = 0, md = 0, nmd = 0, l1 = 0, nl1 = 0, h1 = 0, nh1 = 0;
      for (let i = 1; i < fd.length; i++) { const m = Math.pow(10, fd[i] / 20), f = i * binHz;
        if (f >= 250 && f < 550) { l1 += m; nl1++; } else if (f >= 550 && f < 1000) { h1 += m; nh1++; }
        if (f >= 250 && f < 4000) { md += m; nmd++; } else if (f >= 4000 && f < 8000) { hs += m; nhs++; } }
      const f1r = (h1 / nh1) / (l1 / nl1 + 1e-12), hiss = (hs / nhs) / (md / nmd + 1e-12);
      const amp = clamp((rms - 0.1 * peak) / (0.55 * peak), 0, 1);
      if (hiss > 1.2) return { v: 'E', amp: amp * 0.5, voiced: true };
      if (f1r > 0.6) return { v: 'A', amp, voiced: true };
      if (f1r < 0.3) return { v: 'O', amp: amp * 0.7, voiced: true };
      return { v: 'Asm', amp: amp * 0.85, voiced: true };
    };

    // ---------- camfix19 walker (see header). Idle frames walk along their clip (a head turn played back is a head turn) or
    // across a precomputed pair (flow morph, 2 ticks). Blink and talk frames are never walked to: they are cuts drawn on the
    // rest frame she is standing on.
    const S = rig.start || 0, REST_F = [], TURN_F = [], BLINK_OF = {}, TALK_BY = {}, TALK_LV = {};
    for (let f = 0; f < N; f++) { const fr = FR[f], k = CL[fr.c].kind;
      if (k === 'idle') { if (fr.rs) REST_F.push(f); else TURN_F.push(f); }
      else if (k === 'blink') BLINK_OF[fr.base] = f;
      else if (k === 'talk') { (TALK_BY[fr.base] || (TALK_BY[fr.base] = {}))[fr.src] = f; (TALK_LV[fr.lv] || (TALK_LV[fr.lv] = [])).includes(fr.src) || TALK_LV[fr.lv].push(fr.src); } }
    const isRest = (f) => !!FR[f].rs, isIdle = (f) => CL[FR[f].c].kind === 'idle';
    const nb = Array.from({ length: N }, (_, f) => { const L = []; if (!isIdle(f)) return L; if (FR[f].nx >= 0) L.push({ b: FR[f].nx, w: 1, e: null }); if (FR[f].pv >= 0) L.push({ b: FR[f].pv, w: 1.25, e: null });
      for (const e of adj[f]) if (isIdle(e.b)) L.push({ b: e.b, w: 2.5 + 3 * e.d, e }); return L; });
    const plan = (src, dst) => {   // Dijkstra over idle frames: array of steps [{b, e, from}] or null
      const dist = new Float32Array(N).fill(1e9), prev = new Int32Array(N).fill(-1), pe = new Array(N), done = new Uint8Array(N); dist[src] = 0;
      for (let it = 0; it < N; it++) { let u = -1, bd = 1e9; for (let i = 0; i < N; i++) if (!done[i] && dist[i] < bd) { bd = dist[i]; u = i; }
        if (u < 0 || u === dst) break; done[u] = 1;
        for (const s of nb[u]) if (dist[u] + s.w < dist[s.b]) { dist[s.b] = dist[u] + s.w; prev[s.b] = u; pe[s.b] = s.e; } }
      if (prev[dst] < 0 && dst !== src) return null; const p = []; for (let v = dst; v !== src; v = prev[v]) p.push({ b: v, e: pe[v], from: prev[v] }); p.reverse(); return p; };
    const t00 = performance.now();
    const m = { cur: S, path: [], morph: null, acc: 0, spd: { x: 0.35, v: 0 }, mode: 'rest', nextT: t00 + rnd(3000, 5500), holdUntil: 0,
      blinkDue: t00 + rnd(1500, 3500), blinkUntil: 0, talkOn: false, mouth: -1, lvl: 0, mouthT: 0, holdMs: 140, env: 0, lastVoicedAt: -1e9,
      recent: [], onsetAt: -1, latPending: false };
    const pose = { x: { x: 0, v: 0 }, y: { x: 0, v: 0 }, r: { x: 0, v: 0 } };
    st.lat = []; st.talkHist = {}; st.shapesUsed = 0; st.shownLog = []; st.listen = 0;
    const dwell = () => {   // natural drift: a few real frames along her clip and back
      const f = m.cur, steps = Math.floor(rnd(2, 6)), dir = Math.random() < 0.5 ? 1 : -1; const p = []; let a = f;
      for (let i = 0; i < steps; i++) { const n = dir > 0 ? FR[a].nx : FR[a].pv; if (n < 0 || !isIdle(n)) break; p.push({ b: n, e: null }); a = n; }
      for (let i = p.length - 2; i >= -1; i--) p.push({ b: i >= 0 ? p[i].b : f, e: null }); m.path = p; m.dwelling = true; };
    const nearestRest = (f) => { if (isRest(f)) return f; let best = REST_F[REST_F.length - 1], bd = 1e9; for (const r of REST_F) { const p = plan(f, r); if (p && p.length < bd) { bd = p.length; best = r; } } return best; };
    const listening = (now) => { try { return !!(jv && jv.heardAt && now - jv.heardAt < 4000); } catch (e) { return false; } };
    const scheduled = () => { try { if (jv && jv.ctx && jv.sched && jv.sched.length && jv.playEnd) { const t = jv.ctx.currentTime; return jv.playEnd > t && jv.sched.some((s) => s <= t + 0.04); } } catch (e) {} return false; };
    const idlePlan = (now) => {
      m.dwelling = false;
      if (m.talkOn || m.mode === 'hurry') { if (m.talkOn) dwell(); return; }   // while talking: only the small real drift on her rest frames
      const lis = listening(now); if (lis) st.listen++;
      if (m.mode === 'rest') {
        if (lis || now < m.nextT) { dwell(); return; }
        const cand = TURN_F.filter((f) => FR[f].yaw < -0.15); const dst = cand[Math.floor(Math.random() * cand.length)];
        const p = dst != null ? plan(m.cur, dst) : null; if (p && p.length) { m.path = p; m.mode = 'turn'; m.holdUntil = 0; st.turns++; } else { dwell(); m.nextT = now + 2000; } return; }
      if (m.mode === 'turn') {   // arrived: hold the turn a moment (small drift), then turn back to a rest frame
        if (!m.holdUntil) m.holdUntil = now + (lis ? 0 : rnd(700, 2200));
        if (now < m.holdUntil && !lis) { dwell(); return; }
        const p = plan(m.cur, REST_F[Math.floor(Math.random() * REST_F.length)]); if (p) { m.path = p; m.mode = 'back'; return; } }
      if (m.mode === 'back') { if (isRest(m.cur)) { m.mode = 'rest'; m.nextT = now + rnd(3500, 8000); dwell(); return; }
        const p = plan(m.cur, nearestRest(m.cur)); if (p && p.length) { m.path = p; return; } m.cur = REST_F[0]; m.mode = 'rest'; } };
    const stepIdle = (now) => {
      if (!m.path.length) idlePlan(now);
      if (!m.path.length) return; const s = m.path.shift(); const prev = m.cur;
      if (s.e && m.mode !== 'hurry') { st.jumps++; st.morphs++; m.morph = { a: s.from, b: s.b, e: s.e, k: 0, K: 2 }; }   // camfix19: 2-tick morph, no long ghost
      m.cur = s.b; void prev; };
    const startTalk = (now) => { m.talkOn = true; m.path = []; m.morph = null; m.cur = nearestRest(m.cur); m.mode = 'rest'; m.mouth = -1; m.lvl = 0; m.env = 0; m.latPending = true; };
    const pickMouth = (lv) => { const L = TALK_LV[lv] || TALK_LV[2]; const c = L.filter((j) => !m.recent.includes(j)); const pool = c.length ? c : L;
      const j = pool[Math.floor(Math.random() * pool.length)]; m.recent.push(j); if (m.recent.length > 2) m.recent.shift(); return j; };
    const talkTick = (now, r) => {
      const amp = r.voiced ? vs.amp : 0;
      m.env = amp > m.env ? m.env * 0.35 + amp * 0.65 : m.env * 0.72 + amp * 0.28;
      if (r.voiced) m.lastVoicedAt = now;
      if (now - m.lastVoicedAt > 90) { if (m.mouth !== -1 && now - m.mouthT > 60) { m.mouth = -1; m.lvl = 0; m.mouthT = now; } return; }   // a pause: her rest smile (open)
      const TH = [0.18, 0.42, 0.7]; let lv = m.env < TH[0] ? 1 : m.env < TH[1] ? 2 : m.env < TH[2] ? 3 : 4;
      if (m.lvl && Math.abs(lv - m.lvl) === 1 && Math.abs(m.env - TH[Math.min(lv, m.lvl) - 1]) < 0.04) lv = m.lvl;   // hysteresis
      if (r.v === 'E' && lv > 1) lv--;
      if (m.mouth === -1 || (lv !== m.lvl && now - m.mouthT >= 70) || now - m.mouthT >= m.holdMs) {
        m.mouth = pickMouth(lv); m.lvl = lv; m.mouthT = now; m.holdMs = rnd(100, 190);
        st.talkHist[m.mouth] = (st.talkHist[m.mouth] || 0) + 1; st.shapesUsed = Object.keys(st.talkHist).length;
        if (m.latPending) { m.latPending = false; st.lat.push(Math.round(now - (m.onsetAt > 0 ? m.onsetAt : now))); if (st.lat.length > 20) st.lat.shift(); } } };
    // wiggle-free 2.5D life: tiny whole-picture drift and tilt, a small nod on loud syllables
    const lifeXf = (now, dt) => { const tt = (now - t00) / 1000;
      let tx = 0.0022 * Math.sin(tt * 2 * Math.PI / 7.7), ty = 0.0035 * Math.sin(tt * 2 * Math.PI / 4.3), rot = 0.0018 * Math.sin(tt * 2 * Math.PI / 6.1 + 1);
      if (m.talkOn) { ty -= 0.006 * m.env; rot += 0.0016 * Math.sin(tt * 2.3); }
      spring(pose.x, tx, 30, 11, dt); spring(pose.y, ty, 60, 14, dt); spring(pose.r, rot, 30, 11, dt);
      xf[0] = clamp(pose.x.x, -0.012, 0.012); xf[1] = clamp(pose.y.x, -0.012, 0.012); xf[2] = 1.035; xf[3] = clamp(pose.r.x, -0.005, 0.005); };
    let last = performance.now();
    const frame = () => {
      const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now; useTick++;
      const r = classify(now);
      if (r.voiced) { if (now - vs.voicedAt > 500) m.onsetAt = now; vs.voicedAt = now; }
      vs.amp = vs.amp * 0.45 + r.amp * 0.55;
      if (r.v !== vs.cur) { vs.cur = r.v; st.visHist[r.v] = (st.visHist[r.v] || 0) + 1; } st.vis = vs.cur;
      const sch = scheduled(); if (sch && m.onsetAt < 0) m.onsetAt = now;
      const talking = sch || now - vs.voicedAt < 420;
      if (talking && !m.talkOn) {
        if (isRest(m.cur) || Math.abs(FR[m.cur].yaw) < 0.12) startTalk(now);
        else if (m.mode !== 'hurry') { const p = plan(m.cur, nearestRest(m.cur)); m.path = p || []; m.mode = 'hurry'; m.hurryAt = now; if (!p) startTalk(now); } }
      // camfix20: mouth must open within ~0.2 s of speech start, so the hurry back to the front is capped at 60 ms, then a cut
      if (m.mode === 'hurry' && !m.talkOn && now - (m.hurryAt || now) > 60) { m.path = []; m.morph = null; m.cur = nearestRest(m.cur); st.hurryCuts = (st.hurryCuts || 0) + 1; startTalk(now); }
      if (!talking && m.talkOn) { m.talkOn = false; m.mouth = -1; m.mode = 'rest'; m.path = []; m.nextT = now + rnd(4500, 8000); m.blinkDue = Math.min(m.blinkDue, now + rnd(700, 1800)); m.onsetAt = -1; }
      if (m.mode === 'hurry' && !m.path.length && !m.morph) startTalk(now);
      if (m.talkOn) talkTick(now, r);
      // speed: idle drift slow, a head turn at real-time speed, hurrying to the front when speech starts
      const sp = m.mode === 'hurry' ? 6 : (m.dwelling ? 0.38 : 0.95); spring(m.spd, sp, 40, 12, dt);
      const blinking = now < m.blinkUntil;
      if (!m.talkOn && !blinking && !m.morph && m.mode === 'rest' && isRest(m.cur) && now > m.blinkDue && BLINK_OF[m.cur] != null) {
        m.blinkUntil = now + 250; m.blinkDue = now + rnd(2600, 6200); st.blinks++; }
      if (m.morph) { m.morph.k++; if (m.morph.k > m.morph.K) m.morph = null; }
      else if (!(now < m.blinkUntil)) { m.acc += dt * (rig.fps || 24) * clamp(m.mode === 'hurry' ? 6 : m.spd.x, 0.15, 6); let guard = 0; while (m.acc >= 1 && guard++ < 8 && !m.morph) { m.acc -= 1; stepIdle(now); }
        if (m.talkOn && !isRest(m.cur)) { m.path = []; m.cur = nearestRest(m.cur); } }
      lifeXf(now, dt);
      // what is shown
      let shown = m.cur, ok;
      if (m.morph) { const M = m.morph; ok = draw(M.a, M.b, M.k / (M.K + 1), M.e); shown = M.b; }
      else if (now < m.blinkUntil && BLINK_OF[m.cur] != null) { shown = BLINK_OF[m.cur]; ok = draw(shown, -1, 0); if (!ok) { shown = m.cur; ok = draw(m.cur, -1, 0); } }
      else if (m.talkOn && m.mouth >= 0 && TALK_BY[m.cur] && TALK_BY[m.cur][m.mouth] != null) { shown = TALK_BY[m.cur][m.mouth]; ok = draw(shown, -1, 0); if (!ok) { st.misses++; shown = m.cur; ok = draw(m.cur, -1, 0); } }
      else ok = draw(m.cur, -1, 0);
      if (!ok) st.misses++;
      // prefetch: path, rest frames, her blink and talk frames for this base and its neighbours
      ensure(m.cur); for (let i = 0; i < Math.min(8, m.path.length); i++) ensure(m.path[i].b); if (m.morph) { ensure(m.morph.a); ensure(m.morph.b); }
      if (isRest(m.cur)) { for (const f of REST_F) ensure(f); for (const b of [m.cur, FR[m.cur].nx, FR[m.cur].pv]) if (b >= 0) { if (BLINK_OF[b] != null) ensure(BLINK_OF[b]); const T = TALK_BY[b]; if (T) for (const k in T) ensure(T[k]); } }
      const fr = FR[m.cur]; st.cur = m.cur; st.pose = [fr.yaw, xf[1], xf[3]];
      st.poseLog.push([Math.round(now - st.t0), m.cur, fr.c, Math.round(fr.yaw * 100), Math.round(FR[shown].mo * 1000), m.talkOn ? 1 : 0, m.morph ? 1 : 0, m.talkOn ? m.lvl * 1000 : 0, shown]); if (st.poseLog.length > 1200) st.poseLog.shift();
      st.shownLog.push([Math.round(now - st.t0), shown]); if (st.shownLog.length > 2400) st.shownLog.shift();
      (st.visLog || (st.visLog = [])).push([Math.round(now - st.t0), vs.cur, Math.round(1000 * (st.rms || 0)), m.cur, Math.round(FR[shown].mo * 1000)]); if (st.visLog.length > 900) st.visLog.shift();
      st.frames++; st.drawn.push(now); if (st.drawn.length > 90) st.drawn.shift();
    };
    // warm the cache before the first draw: rest, blink and talk frames of the start base
    for (const f of REST_F) ensure(f); if (BLINK_OF[S] != null) ensure(BLINK_OF[S]); if (TALK_BY[S]) for (const k in TALK_BY[S]) ensure(TALK_BY[S][k]);
    await new Promise((ok) => { const t0 = performance.now(); const w = () => (cache.has(S) || performance.now() - t0 > 4000) ? ok() : setTimeout(w, 20); w(); });
    const tick = () => { try { frame(); if (st.onFrame) st.onFrame(); } catch (e) { st.errs++; st.lastErr = String(e).slice(0, 200); } };
    st.timer = setInterval(tick, 1000 / 30); tick();
    return { canvas: out, st, frameNow: tick };
  };
  return window.__jcamMake;
})();

// ---------------------------------------------------------------------------------------------------------------
// Site glue (jena-magic-screen, 2026-10-26): the approved happy-Jena camera rig (camfix20, the IMG_3647 look) as her
// avatar on the magic screen. Same rig frames, same walker as her Discord camera; nothing here generates a face.
//  - frames: /jena-cam/f000.jpg … f175.jpg (the rig's own JPEGs, byte-for-byte), rig data /jena-cam/rig.json
//  - her voice: src/voice.js routes the real TTS audio into tap() below -> loudness picks the open-mouth shape
//  - voice muted: the words of the line she is saying (avatar.talk, set by say()) drive the same mouth shapes
// HONEST LABEL: 2.5D. Every picture is a pre-rendered 2D frame; head turns are real frames of one pre-rendered
// head-turn clip. No 3D skeleton, so her Body tab self-view only exists with ?avatar=3d.
let tapNode = null;
export function voiceTap(ctx) {   // called by src/voice.js for every line she speaks (same AudioContext every time)
  if (tapNode && tapNode.context === ctx) return tapNode;
  const an = ctx.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0.3;
  const mute = ctx.createGain(); mute.gain.value = 0; an.connect(mute); mute.connect(ctx.destination);   // keeps the analyser pulled; adds no sound
  tapNode = an; return an;
}
const TEXT_SHAPE = { aa: ['A', 0.85], oh: ['O', 0.6], ou: ['O', 0.45], ee: ['E', 0.55], ih: ['Asm', 0.5], half: ['Asm', 0.42] };
export async function mountHappyCam(host, { avatar, voice, base = '/jena-cam/' } = {}) {
  const rig = await fetch(base + 'rig.json').then((r) => { if (!r.ok) throw new Error('rig ' + r.status); return r.json(); });
  rig.base = base;
  const jv = {
    analyser: () => tapNode,
    get ctx() { return voice?.ctx || null; },
    get sched() { return voice?.camSched || null; },
    get playEnd() { return voice?.camEnd || 0; },
    heardAt: 0,
    textDrive: (now) => {
      if (!avatar || !avatar.talk) return null;
      if (voice && voice.status === 'speaking') return null;          // real audio is playing: the analyser drives her mouth
      if (voice && voice.on && voice.pending) return null;              // her audio is on its way: wait for it, don't mime ahead of it
      if (now > (avatar.talk.until || 0)) return null;
      const v = avatar.viseme ? avatar.viseme(now) : 'aa';
      const s = TEXT_SHAPE[v]; if (!s) return null;                     // rest / closed lips / space = a pause (her open rest smile)
      return { v: s[0], amp: s[1] * (0.8 + 0.4 * Math.random()), voiced: true };
    },
  };
  const cam = await jcam(rig, jv);
  cam.canvas.id = 'happycam';
  cam.canvas.setAttribute('aria-label', "Jena (2.5D: pre-rendered frames, not a 3D model)");
  cam.canvas.setAttribute('role', 'img');
  host.prepend(cam.canvas);
  const pause = () => { if (document.hidden) { clearInterval(cam.st.timer); cam.st.timer = 0; } else if (!cam.st.timer) cam.st.timer = setInterval(cam.frameNow, 1000 / 30); };
  document.addEventListener('visibilitychange', pause);
  window.__happyCam = cam;   // diagnostics: window.__happyCam.st (blinks, shapes used, mouth latency, misses)
  return cam;
}
