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
  paint() { if (this.btn) { this.btn.textContent = this.on ? '🔊' : '🔇'; this.btn.title = this.on ? 'her voice is on (tap to mute)' : 'tap to hear her voice'; } }
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
    const an = this.ctx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0.5;
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
      let lo = 0, hi = 0;
      for (let i = 0; i < fd.length; i++) { const f = i * binHz; if (f > 200 && f < 900) lo += fd[i]; else if (f >= 900 && f < 3500) hi += fd[i]; }
      this.avatar.voice = { level: Math.min(1, rms * 5.5), round: lo / (lo + hi + 1) };
      trace.push(this.avatar.voice.level);
      requestAnimationFrame(tick);
    };
    this.status = 'speaking';
    this.avatar.talk.until = performance.now() + buf.duration * 1000;
    await new Promise((res) => { src.onended = res; src.start(); tick(); });
    live = false; this.avatar.voice = null; this.status = 'idle';
    // what the lip-sync actually did (dev panel + tests read this): mouth-open level per frame from the audio
    const open = trace.filter((x) => x > 0.08).length;
    this.last.lipsync = { frames: trace.length, mouthOpenFrames: open, peak: +Math.max(0, ...trace).toFixed(2), mean: +(trace.reduce((a, b) => a + b, 0) / (trace.length || 1)).toFixed(2), sample: trace.filter((_, i) => i % Math.max(1, Math.floor(trace.length / 24)) === 0).map((x) => +x.toFixed(2)) };
  }
}
