// 🎤 talk to Jena with your voice. Tap to start, tap again to send (or hold and let go). Max 30 s.
// The clip goes (signed by her site) to her own box, where free local speech-to-text turns it into text;
// the audio is deleted right after. The text then goes into the chat like a typed message and she answers out loud.
const MAX_MS = 30000;
const pickType = () => {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported?.(t)) return t;
  return '';
};

export class Mic {
  // button: the 🎤 button; status: element for "listening 0:03" / errors; params(): {user, learn, private, key}
  // onText(text, info): called with the transcript
  constructor({ button, status, params, onText, onStart, gate }) {
    this.gate = gate;
    this.btn = button; this.status = status; this.params = params; this.onText = onText; this.onStart = onStart;
    this.state = 'idle';
    if (!navigator.mediaDevices?.getUserMedia || pickType() === null) {
      button.disabled = true; button.title = "this browser can't record audio";
      return;
    }
    let downAt = 0;
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      downAt = Date.now();
      if (this.state === 'idle') { if (!this.gate || this.gate()) this.start(); }
      else if (this.state === 'rec') this.stop(true);
      else if (this.state === 'asking') this.pendingStop = true;   // tapped again before the mic opened: send as soon as it's recording
    });
    button.addEventListener('pointerup', () => {
      // held for a while = push-to-talk: letting go sends it
      if (this.state === 'rec' && Date.now() - downAt > 450 && Date.now() - this.startedAt > 450) this.stop(true);
    });
    button.addEventListener('click', (e) => e.preventDefault());
    button.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.state === 'idle' ? (!this.gate || this.gate()) && this.start() : this.state === 'rec' && this.stop(true); } });
  }

  show(text, cls = '') {
    if (!this.status) return;
    this.status.hidden = !text; this.status.textContent = text || ''; this.status.className = 'mic-status ' + cls;
  }

  async start() {
    this.state = 'asking'; this.pendingStop = false;
    this.onStart?.();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    } catch (e) {
      this.state = 'idle';
      return this.show(e.name === 'NotAllowedError' ? 'mic blocked: allow the microphone for this site to talk to her' : `no microphone (${e.message})`, 'err');
    }
    const type = pickType();
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, type ? { mimeType: type, audioBitsPerSecond: 48000 } : undefined);
    this.rec.ondataavailable = (e) => e.data?.size && this.chunks.push(e.data);
    this.rec.onstop = () => this.finish();
    this.rec.start(250);
    this.startedAt = Date.now();
    this.state = 'rec';
    this.btn.classList.add('is-rec'); this.btn.setAttribute('aria-pressed', 'true'); this.btn.setAttribute('aria-label', 'stop and send');
    const tick = () => {
      if (this.state !== 'rec') return;
      const s = Math.floor((Date.now() - this.startedAt) / 1000);
      this.show(`● listening 0:${String(s).padStart(2, '0')} · tap 🎤 to send`, 'rec');
      if (Date.now() - this.startedAt >= MAX_MS) return this.stop(true);
      this.timer = setTimeout(tick, 250);
    };
    tick();
    if (this.pendingStop) { this.pendingStop = false; setTimeout(() => this.stop(true), 1200); }
  }

  stop(send) {
    if (this.state !== 'rec') return;
    this.sendIt = send;
    this.state = 'stopping';
    clearTimeout(this.timer);
    try { this.rec.stop(); } catch { this.finish(); }
  }

  cancel() { this.stop(false); }

  async finish() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.btn.classList.remove('is-rec'); this.btn.setAttribute('aria-pressed', 'false'); this.btn.setAttribute('aria-label', 'talk to Jena with your voice');
    const blob = new Blob(this.chunks, { type: (this.rec?.mimeType || 'audio/webm').split(';')[0] });
    const ms = Date.now() - this.startedAt;
    if (!this.sendIt) { this.state = 'idle'; return this.show(''); }
    if (ms < 500 || blob.size < 1200) { this.state = 'idle'; return this.show('too short, hold on a bit longer', 'err'); }
    this.state = 'sending';
    this.btn.classList.add('is-busy');
    this.show('she\'s listening to it…', 'busy');
    const p = this.params();
    const q = new URLSearchParams({ user: p.user || 'guest', learn: p.learn ? '1' : '0', private: p.private ? '1' : '0' });
    const r = await fetch('/api/hear?' + q, { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm', ...(p.key ? { 'X-Jena-Key': p.key } : {}) }, body: blob }).catch((e) => ({ ok: false, statusText: e.message, json: async () => ({}) }));
    const d = await r.json().catch(() => ({}));
    this.btn.classList.remove('is-busy');
    this.state = 'idle';
    if (!r.ok) return this.show(d.error || `couldn't send it (${r.status || r.statusText})`, 'err');
    if (!d.text) return this.show("she didn't catch any words, try again closer to the mic", 'err');
    this.show('');
    this.onText(d.text, { ...d, seconds: ms / 1000, bytes: blob.size, type: blob.type });
  }
}
