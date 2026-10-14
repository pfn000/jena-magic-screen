// Stream layout helpers (/stream?layout=wide|phone). The page is already the OBS page (index.html's first script
// forces ?obs=1 before any module reads it), so the censor, the fail-closed desktop and "no private controls" all hold.
export function streamLayout(cfg) {
  if (!cfg.stream) return;
  const b = document.body;
  b.classList.add('stream', `stream-${cfg.layout}`, 'obs', 'bg-none', 'no-controls');
  if (cfg.part) b.classList.add(`part-${cfg.part}`);
  // a landscape desktop picture behind the phone layout is shown whole (top-aligned) instead of cropped to a sliver;
  // the compositor puts her desktop into N•OS phone mode for TikTok, so normally the picture is already portrait
  const fit = () => {
    const im = [...document.querySelectorAll('#desktop .desk-screen img')].find((x) => x.naturalWidth && x.style.opacity !== '0');
    if (!im) return;
    b.classList.toggle('desk-fit', cfg.layout === 'phone' && im.naturalWidth > im.naturalHeight * 1.05);
  };
  setInterval(fit, 1500);
}

// STREAM CAMERA DIRECTOR. Studied from Saidie's example 3D VTuber clips: smooth push-ins and pull-outs, low angles on
// hype, slow sideways drift; and her ask (6:52 PM) for "more human live reaction and emotion, especially with
// aggressive controlled camera zooms". It only picks a shot; src/avatar.js streamGoal() frames her with it (the
// shot's k is the ease speed), so it costs nothing per frame. Shots: mid (default), wide, close, low, high, punch.
//   reaction beat (shock, laugh, rage, a punchline word, a soundboard hit, talking to chat)
//                         -> HARD punch-in: ~200 ms ease-out with a slight overshoot, settle, hold ~1.4 s, smooth return;
//                            big reactions add a light ~300 ms shake. At most one hard zoom per 5 s.
//   emotional moment (sad, sorry, love, thank you) or her mood turning sad/relaxed -> slow push-in
//   hype sound / happy mood spike -> low angle
//   talking starts -> gentle push-in;  idle -> every 14-24 s a slow drift between mid / wide / low / high
// Soft changes wait at least 6 s. ?director=0 turns it off.
const SHOTS = {
  mid: { zoom: 1, tilt: 0, pan: 0, k: 1.1 },
  wide: { zoom: 0.8, tilt: 0, pan: -0.04, k: 0.9 },
  close: { zoom: 1.3, tilt: 0, pan: 0.02, k: 1.3 },
  push: { zoom: 1.4, tilt: 0.01, pan: 0, k: 0.45 },   // slow emotional push-in
  low: { zoom: 1.05, tilt: 0.12, pan: 0.03, k: 1.0 },
  high: { zoom: 0.95, tilt: -0.08, pan: -0.02, k: 1.0 },
  punch: { zoom: 1.62, tilt: 0.02, pan: 0, k: 14 },   // the overshoot frame (k 14 = ~70 ms time constant: ~200 ms ease-out)
  punchSettle: { zoom: 1.5, tilt: 0.02, pan: 0, k: 9 },
};
const HYPE = /airhorn|yay|wow|lets-go|victory|win|clutch|anime-wow/;
export function streamDirector(cfg, avatar) {
  if (!cfg.stream || new URLSearchParams(location.search).get('director') === '0') return;
  const cam = (window.jenaCam = { name: 'mid', shot: SHOTS.mid, at: 0, log: [] });
  let lastPunch = -1e9, back = 0, nextIdle = performance.now() + 14000, wasTalking = false, lastMood = 'neutral', shakeUntil = 0;
  const set = (name, holdMs = 0, force = false, why = '') => {
    const now = performance.now();
    if (!force && now - cam.at < 6000) return false;
    cam.name = name; cam.shot = { ...SHOTS[name] }; cam.at = now; back = holdMs ? now + holdMs : 0;
    cam.log.push({ t: Math.round(now), name, why }); if (cam.log.length > 40) cam.log.shift();
    return true;
  };
  // the hard zoom: overshoot -> settle -> hold -> smooth return; capped at one per 5 s
  const punch = (why, big = false) => {
    const now = performance.now();
    if (now - lastPunch < 5000) return false;
    lastPunch = now; set('punch', 1600, true, why);
    const tight = why === 'scream'; cam.shot.tight = tight;   // only the scream zoom may crop into her hair
    setTimeout(() => { if (cam.name === 'punch') { cam.name = 'punchSettle'; cam.shot = { ...SHOTS.punchSettle, tight }; } }, 190);
    if (big) shakeUntil = now + 320;
    return true;
  };
  cam.punch = punch;
  window.addEventListener('jena-cam', (e) => { const d = e.detail || {}; if (d.shot === 'punch') punch(d.why || 'beat', !!d.big); else if (SHOTS[d.shot]) set(d.shot, d.hold || 4000, !!d.force, d.why || ''); });
  window.addEventListener('jena-sfx', (e) => {
    const id = e.detail?.id || '';
    if (e.detail?.hidden) return;   // a hidden attention sound moves nothing
    if (e.detail?.scream) { lastPunch = -1e9; punch('scream', true); return; }
    if (HYPE.test(id)) { if (!punch('hype sound', true)) set('low', 4000, false, 'hype sound'); } else punch('sound hit');
  });
  setInterval(() => {
    const now = performance.now();
    // light shake on big reactions: a few frames of small pan/tilt jitter (no extra rendering cost)
    if (now < shakeUntil) { cam.shot.pan = (Math.random() - 0.5) * 0.02; cam.shot.tilt = 0.02 + (Math.random() - 0.5) * 0.015; cam.shot.k = 18; }
    else if (cam.name === 'punchSettle' && cam.shot.k === 18) { cam.shot = { ...SHOTS.punchSettle, tight: cam.shot.tight }; }
    const talking = avatar && now < (avatar.talk?.until || 0);
    const mood = avatar?.mood?.name || 'neutral';
    if (mood !== lastMood) {
      if (/sad|relaxed/.test(mood)) set('push', 5000, true, 'mood ' + mood);
      else if (/surprised|angry/.test(mood)) punch('mood ' + mood, true);
      else if (mood === 'happy' && (avatar.mood.peak ?? 0) > 0.8) set('low', 3500, false, 'mood happy');
      lastMood = mood;
    }
    if (back && now > back) { back = 0; set(talking ? 'close' : 'mid', 0, true, 'return'); cam.shot.k = 1.6; cam.at = now - 3000; return; }
    if (talking && !wasTalking && !back) set('close', 4500, false, 'talking');
    wasTalking = talking;
    if (!talking && !back && now > nextIdle) {
      // long, irregular dwell (log-normal ~20-90 s) and a no-repeat pick, so the framing never settles into a cycle
      const opts = ['mid', 'wide', 'low', 'high'].filter((n) => n !== cam.name && n !== cam.prevIdle);
      const pickN = opts[Math.floor(Math.random() * opts.length)];
      const was = cam.name;
      if (set(pickN, 0, false, 'idle drift')) {
        cam.prevIdle = was;
        nextIdle = now + Math.min(90000, Math.max(20000, 38000 * Math.exp((Math.random() + Math.random() + Math.random() - 1.5) * 1.0)));
        try { const L = (window.jenaLog ||= []); L.push({ t: Math.round(now), kind: 'cam', what: pickN, why: 'idle drift' }); if (L.length > 400) L.shift(); } catch {}
      }
    }
  }, 50);
}

// ON-SCREEN TEXT (Saidie's example clips): TikTok-style captions of what she says, bold and outlined, words popping in
// time with her voice (the same clock her lip-sync uses: avatar.talk t0/ms), plus a big punchline pop on a bit
// (an ALL-CAPS word, a short exclamation, a soundboard hit). Kept inside the vertical safe area (clear of TikTok's
// right-edge buttons and bottom caption) and clear of the chat panel. ?captions=0 turns it off.
export function streamCaptions(cfg, avatar) {
  if (!cfg.stream || !avatar || new URLSearchParams(location.search).get('captions') === '0') return;
  const box = document.createElement('div'); box.id = 'stream-caption'; box.setAttribute('aria-live', 'polite');
  const pop = document.createElement('div'); pop.id = 'stream-pop';
  document.body.append(box, pop);
  let shown = '', words = [], spans = [], popUntil = 0, emph = -1, bitText = '', bigBeat = false, fired = false;
  const popText = (txt, ms = 1800) => {
    pop.textContent = txt; pop.classList.remove('on'); void pop.offsetWidth; pop.classList.add('on'); popUntil = performance.now() + ms;
  };
  window.jenaPop = popText;
  window.addEventListener('jena-sfx', (e) => { if (e.detail?.hidden) return; const id = String(e.detail?.id || ''); if (performance.now() > popUntil) popText(e.detail?.scream ? 'AAAAAAAA' : id.replace(/-/g, ' ').toUpperCase(), 1400); });
  setInterval(() => {
    const T = avatar.talk || {}, now = performance.now();
    const txt = String(T.text || '').replace(/\[[^\]]*\]|[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    if (txt && txt !== shown && now < (T.until || 0)) {
      shown = txt; words = txt.split(' ').slice(0, 60);
      box.innerHTML = ''; spans = words.map((w) => { const s = document.createElement('span'); s.textContent = w; box.appendChild(s); return s; });
      box.classList.add('on');
      // a bit: an ALL-CAPS word, or a short exclamation -> the big pop and a hard zoom, timed to land ON that word
      const capsI = words.findIndex((w) => /^[A-Z][A-Z']{2,}[!?.,]*$/.test(w));
      const sents = txt.split(/(?<=[.!?])\s+/), excl = sents.find((s) => /!$/.test(s) && s.split(' ').length <= 6);
      const joined = words.join(' '), at = excl ? joined.indexOf(excl.split(' ')[0]) : -1;
      emph = capsI >= 0 ? capsI : at >= 0 ? Math.min(words.length - 1, joined.slice(0, at).split(' ').filter(Boolean).length + excl.split(' ').length - 1) : -1;
      bitText = capsI >= 0 ? words.slice(capsI).join(' ').match(/^([A-Z][A-Z' ]+[A-Z])/)?.[1] || words[capsI] : excl || '';
      // reaction beats: shock / laugh / rage get the hard zoom (and a shake) on their word; emotional lines a slow push-in
      const beat = txt.match(/\b(what\?!|no way|oh my god|omg|wait what|bro what|haha+|lol|lmao|are you kidding|why would|stop it|nooo+)\b/i);
      if (emph < 0 && beat) { emph = words.findIndex((w) => w.toLowerCase().startsWith(beat[1].toLowerCase().split(' ')[0])); bitText = ''; bigBeat = true; } else bigBeat = /!{1,}$/.test(txt) && /[A-Z]{3,}/.test(txt);
      if (/\b(i'?m sorry|i miss|thank you|love you|that's sad|i'?m sad)\b/i.test(txt)) window.dispatchEvent(new CustomEvent('jena-cam', { detail: { shot: 'push', hold: 5000, force: true, why: 'emotional line' } }));
      // talking to viewers ("chat", "you guys", "y'all") -> a quick punch-in as she turns to them
      if (/\b(chat|you guys|y'?all|everyone|viewers)\b/i.test(txt)) window.dispatchEvent(new CustomEvent('jena-cam', { detail: { shot: 'punch', why: 'talking to chat' } }));
      fired = false;
    }
    if (shown && words.length) {
      const k = Math.min(1, Math.max(0, (now - (T.t0 || now)) / Math.max(400, T.ms || 1))), cur = Math.min(words.length - 1, Math.floor(k * words.length));
      // a caption shows ~8 words at a time, the word being said highlighted
      const start = Math.max(0, Math.floor(cur / 8) * 8);
      spans.forEach((s, i) => { s.hidden = i < start || i >= start + 8; s.className = i === cur ? 'now' : i < cur ? 'said' : ''; });
      if (!fired && emph >= 0 && cur >= emph) {   // the word is being said now: zoom + pop land on it
        fired = true;
        window.dispatchEvent(new CustomEvent('jena-cam', { detail: { shot: 'punch', big: bigBeat, why: 'emphasis: ' + (words[emph] || '') } }));
        if (bitText) popText(bitText.replace(/[.!?,]+$/, '').toUpperCase() + '!');
      }
      if (now > (T.until || 0) + 1200) { box.classList.remove('on'); shown = ''; words = []; }
    }
    if (now > popUntil) pop.classList.remove('on');
  }, 90);
}

// RETENTION HOOKS (Saidie 7:01 PM; stream only, all PG-13: chaotic and dumb, never sexual or body-crude):
//  - a hidden attention sound (a quiet key jingle, -23 dBFS) at a random moment every 2-5 minutes, never over her voice
//  - a random-scream moment (cartoon scream / screaming goat, limited to -6 dBFS peak) at most once per 5 minutes,
//    with a hard punch-in zoom
//  - absurd out-of-pocket caption pops every 3-6 minutes
// ?hooks=0 turns them off. Clocks are randomised so it never feels like a timer.
const OOP = ['I HAVE NEVER SEEN A PIGEON SIT DOWN', 'MY CHAIR KNOWS WHAT I DID', 'WHO TAUGHT THE GOOSE TO DRIVE', 'I AM 4 RACCOONS IN A HOODIE',
  'THE MICROWAVE IS JUDGING ME', 'CHAT IS 80% CRUMBS', 'I COULD FIGHT A CLOUD', 'MY BRAIN HAS 3 TABS OPEN AND ONE IS MUSIC',
  'BANANAS ARE JUST SPICY POTATOES', 'IS THIS LEGAL IN OHIO', 'I SPEAK FLUENT BEEP BOOP', 'MAMA SAID NO MORE GREMLIN HOURS'];
export function streamHooks(cfg, avatar) {
  if (!cfg.stream || new URLSearchParams(location.search).get('hooks') === '0') return;
  const rnd = (a, b) => (a + Math.random() * (b - a)) * 1000;
  const quiet = () => !avatar || performance.now() > (avatar.talk?.until || 0) + 1500;
  let nextKeys = performance.now() + rnd(120, 300), nextScream = performance.now() + rnd(300, 600), nextPop = performance.now() + rnd(180, 360);
  window.jenaHooks = { get next() { return { keys: nextKeys, scream: nextScream, pop: nextPop }; } };
  setInterval(async () => {
    const now = performance.now(), sb = window.jenaSfx;
    if (!sb) return;
    if (now > nextKeys && quiet()) { const r = await sb.play('keys-jingle', 'attention hook'); nextKeys = now + (r.played ? rnd(120, 300) : rnd(15, 40)); }
    if (now > nextScream && quiet()) { const r = await sb.play(Math.random() < 0.5 ? 'tom-scream' : 'goat-scream', 'random scream'); nextScream = now + (r.played ? rnd(300, 720) : rnd(30, 90)); }
    if (now > nextPop && quiet() && window.jenaPop) { window.jenaPop(OOP[Math.floor(Math.random() * OOP.length)], 2200); nextPop = now + rnd(180, 360); }
  }, 2000);
}
