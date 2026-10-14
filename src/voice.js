// Her voice: real speech from Piper (free, local neural TTS) running on her own box, and lip-sync driven by
// the actual audio (loudness -> mouth open, low vs high energy -> "oh" vs "aa"). Browsers only allow sound
// after you interact with the page, so for visitors it starts muted with a 🔊 button; OBS pages play it.
export class Voice {
  constructor(avatar, { obs = false, button = null } = {}) {
    this.avatar = avatar;
    this.btn = button;
    const saved = localStorage.getItem('jena.voice');
    this.on = saved === null ? obs : saved === '1';
    this.queue = Promise.resolve();
    this.ctx = null;
    this.voiceName = new URLSearchParams(location.search).get('voice') || localStorage.getItem('jena.voiceName') || '';
    this.status = 'idle';
    if (this.btn) {
      this.paint();
      this.btn.addEventListener('click', () => { this.on = !this.on; localStorage.setItem('jena.voice', this.on ? '1' : '0'); this.unlock(); this.paint(); });
    }
    window.__jenaVoice = this;
  }
  paint() { if (this.btn) { this.btn.dataset.on = this.on ? '1' : '0'; this.btn.textContent = this.on ? '🔊' : '🔇'; this.btn.title = this.on ? 'her voice is on (tap to mute)' : 'tap to hear her voice'; } }
  unlock() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  speak(text, token) {
    if (!this.on || !text || !token) return;
    this.queue = this.queue.then(() => this.play(text, token)).catch((e) => { this.status = 'error: ' + e.message; });
  }
  async play(text, token) {
    this.unlock();
    const t0 = performance.now();
    const r = await fetch(`/api/tts?text=${encodeURIComponent(text)}&t=${token}${this.voiceName ? '&voice=' + encodeURIComponent(this.voiceName) : ''}`);
    if (!r.ok) { this.status = `voice unavailable (${r.status})`; return; }
    const buf = await this.ctx.decodeAudioData(await r.arrayBuffer());
    this.last = { text: text.slice(0, 80), fetchMs: Math.round(performance.now() - t0), seconds: +buf.duration.toFixed(2), voice: r.headers.get('x-jena-voice') };
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const an = this.ctx.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0.5;   // 1024: ~21 ms window, long enough for her pitch (120-700 Hz)
    src.connect(an); an.connect(this.ctx.destination);
    const td = new Float32Array(an.fftSize), fd = new Uint8Array(an.frequencyBinCount);
    const binHz = this.ctx.sampleRate / an.fftSize;
    let live = true;
    const trace = [];
    const tick = () => {
      if (!live) return;
      an.getFloatTimeDomainData(td); an.getByteFrequencyData(fd);
      let s = 0; for (const v of td) s += v * v;
      const rms = Math.sqrt(s / td.length);
      let lo = 0, hi = 0, f1 = 0, f2lo = 0, f2hi = 0;
      for (let i = 0; i < fd.length; i++) {
        const f = i * binHz, v = fd[i];
        if (f > 200 && f < 900) lo += v; else if (f >= 900 && f < 3500) hi += v;
        if (f > 250 && f < 850) f1 += v; else if (f >= 850 && f < 1500) f2lo += v; else if (f >= 1500 && f < 3300) f2hi += v;
      }
      // audio-driven lip sync: formant-band energy -> a blend of the five mouth shapes (F1 high = open 'aa',
      // energy held low = rounded 'oh'/'ou', F2 high with a low F1 = spread 'ee'/'ih'); mixed with the text visemes
      const tot = f1 + f2lo + f2hi + 1, a = f1 / tot, b = f2lo / tot, c = f2hi / tot;
      const sc = { aa: a * 1.15, oh: b * 0.95, ou: b * 0.55 + Math.max(0, 0.35 - c) * 0.6, ee: c * 1.1, ih: c * 0.55 + a * 0.35 };
      let sum = 0; for (const k in sc) { sc[k] = sc[k] ** 3; sum += sc[k]; } for (const k in sc) sc[k] /= sum || 1;
      const level = Math.min(1, rms * 5.5), prev = this.avatar.voice?.level || 0;
      // an energy onset (a stressed syllable) is a beat her head and hands can hit (src/motion.js)
      if (level > prev * 1.6 + 0.12 && level > 0.3) this.avatar.voiceBeat = { at: performance.now(), level };
      // pitch (autocorrelation, 120-700 Hz) -> brows + chin follow her intonation (src/expressions.js prosody)
      let pitch = 0, conf = 0;
      if (rms > 0.02) {
        const sr = this.ctx.sampleRate, lo2 = Math.floor(sr / 700), hi2 = Math.min(td.length >> 1, Math.ceil(sr / 120));
        let e0 = 0; for (let i = 0; i < td.length - hi2; i++) e0 += td[i] * td[i];
        let best = 0, bl = 0;
        for (let lag = lo2; lag <= hi2; lag++) { let c = 0; for (let i = 0; i < td.length - hi2; i++) c += td[i] * td[i + lag]; if (c > best) { best = c; bl = lag; } }
        if (bl && e0 > 0) { conf = best / e0; if (conf > 0.45) pitch = sr / bl; }
      }
      this.avatar.voice = { level, round: lo / (lo + hi + 1), mix: sc, pitch: Math.round(pitch), pitchConf: +conf.toFixed(2) };
      trace.push(this.avatar.voice.level);
      requestAnimationFrame(tick);
    };
    this.status = 'speaking';
    this.avatar.talk.until = performance.now() + buf.duration * 1000;
    // the words she's saying, time-aligned to this audio, pick her mouth shapes (avatar.viseme)
    Object.assign(this.avatar.talk, { text: String(text), t0: performance.now(), ms: buf.duration * 1000 });
    await new Promise((res) => { src.onended = res; src.start(); tick(); });
    live = false; this.avatar.voice = null; this.status = 'idle';
    // what the lip-sync actually did (dev panel + tests read this): mouth-open level per frame from the audio
    const open = trace.filter((x) => x > 0.08).length;
    this.last.lipsync = { frames: trace.length, mouthOpenFrames: open, peak: +Math.max(0, ...trace).toFixed(2), mean: +(trace.reduce((a, b) => a + b, 0) / (trace.length || 1)).toFixed(2), sample: trace.filter((_, i) => i % Math.max(1, Math.floor(trace.length / 24)) === 0).map((x) => +x.toFixed(2)) };
  }
}
