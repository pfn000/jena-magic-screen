// Jena's soundboard: short kid-safe meme sounds from myinstants.com (public/sounds, tags in public/sounds/index.json).
// She picks one with an [sfx:id] cue in her reply, or her brain's picker sends {type:'sfx'} when the moment fits.
// Never spammy: at least 20 s between sounds, at most 4 in 5 minutes, never the same one twice in a row within a minute.
// Never for private (mama) runs. Audible where her voice is: always on the stream/OBS page, on the site only with 🔊 on.
export class Soundboard {
  constructor({ obs = false, voice = null } = {}) {
    this.obs = obs; this.voice = voice;
    this.sounds = new Map(); this.played = []; this.last = null;
    this.rules = { min_gap_s: 20, max_per_5min: 4 };
    this.ready = fetch('/sounds/index.json', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
      for (const s of d.sounds || []) this.sounds.set(s.id, s);
      Object.assign(this.rules, d.rules || {});
    }).catch(() => {});
    window.jenaSfx = this;
  }
  // why a sound would be refused right now ('' = allowed)
  refuse(id, now = Date.now()) {
    if (!this.sounds.has(id)) return 'unknown sound';
    if (!this.obs && !this.voice?.on) return 'sound is off on this page';
    const s = this.sounds.get(id);
    // retention hooks (stream only): hidden attention sounds and random screams keep their own clocks (src/stream.js)
    // and never play over her voice; screams at most once per 5 minutes
    if (s.hidden || s.scream) {
      if (this.voice?.speaking || now < (window.__jenaDebug?.avatar?.talk?.until || window.jenaTalkUntil || 0)) return 'not over her voice';
      if (s.scream && now - (this.lastScream || 0) < (this.rules.scream_min_gap_s || 300) * 1000) return 'one scream per 5 minutes';
      return '';
    }
    if (this.clapping && now - this.lastClapback < (this.rules.clapback_min_gap_s || 90) * 1000) return 'one clapback sound per 90 s';
    const recent = this.played.filter((p) => now - p.at < 300000);
    if (recent.length && now - recent[recent.length - 1].at < this.rules.min_gap_s * 1000) return 'too soon after the last one';
    if (recent.length >= this.rules.max_per_5min) return 'enough sounds for now';
    if (this.last?.id === id && now - this.last.at < 60000) return 'same sound twice in a row';
    return '';
  }
  async play(id, why = '') {
    await this.ready;
    this.clapping = /^clapback/.test(why);   // a clapback sound (api/_lib/memes.js clapbackSound) keeps its own 90 s clock
    const no = this.refuse(id);
    this.clapping = false;
    if (no) { console.info(`[sfx] skipped ${id}: ${no}`); return { played: false, why: no }; }
    const s = this.sounds.get(id), a = new Audio(s.file);
    a.volume = s.volume ?? 0.55;   // the retention clips carry their own level (keys -23 dBFS, screams limited to -6 dBFS)
    const at = Date.now();
    if (s.scream) this.lastScream = at;
    if (/^clapback/.test(why)) this.lastClapback = at;
    if (!s.hidden && !s.scream) { this.played.push({ id, at, why }); this.played = this.played.filter((p) => at - p.at < 300000); this.last = { id, at }; }
    try { await a.play(); } catch (e) { return { played: false, why: e.message }; }
    window.dispatchEvent(new CustomEvent('jena-sfx', { detail: { id, why, hidden: !!s.hidden, scream: !!s.scream } }));
    return { played: true, id, why };
  }
}
