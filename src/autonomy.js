// Jena's own body: a small behaviour controller that decides her gestures, gaze and expressions
// from what is actually happening around her (chat activity, messages to her, file drops, her mood,
// idle time) and from what her brain (JenaXI) asks for via action tags. Nobody else drives her body:
// there are no movement buttons or commands. Every move she makes is logged in the thought chain in
// her own words ("I'm raising my left arm"). "Left" and "right" are always HER left and right.
const pick = (a) => a[Math.floor(Math.random() * a.length)];   // only for left/right sides; actions + captions use NoRepeat
import { NoRepeat } from './nonrepeat.js';
// Saidie: no loops. Her idle actions and their captions never come back until several others have played, nothing
// repeats inside 30 s, and her weight shifts don't tick left-right-left-right like a metronome.
const IDLE = new NoRepeat({ minGap: 4, windowMs: 45000 });
const SAY = new NoRepeat({ minGap: 2, windowMs: 120000 });
const say = (pool, kind) => SAY.pick(pool, { pool: kind });
const SIDE = { left: 'left', right: 'right', both: 'both arms' };

export class Autonomy {
  constructor(avatar, { log }) {
    this.avatar = avatar;
    this.log = log; // (text) => void
    this.lastMove = 0;
    this.lastIdle = Date.now();
    this.nextIdleIn = 8000 + Math.random() * 8000;
    this.chatTimes = [];
    this.lastChatGlance = 0;
    this.mood = 'neutral';
    this.timer = setInterval(() => this.tick(), 1000);
    this.postureTimer = setTimeout(() => this.posture(), 600);
  }

  get ready() { return !!this.avatar.ready; }

  // ---- primitives (each one is logged) ----
  raise(side = 'left', ms = 2600, why = '') {
    this.avatar.raiseArm(side, ms);
    this.lastMove = Date.now();
    this.log(`I'm raising my ${side === 'both' ? 'arms' : SIDE[side] + ' arm'}${why ? ` (${why})` : ''}`);
  }
  lower(why = '') {
    this.avatar.lowerArm('both');
    this.lastMove = Date.now();
    this.log(`I'm lowering my arms${why ? ` (${why})` : ''}`);
  }
  wave(side = 'right', why = '') {
    this.avatar.waveHand(side);
    this.lastMove = Date.now();
    this.log(`I'm waving with my ${side} hand${why ? ` (${why})` : ''}`);
  }
  look(dir, ms = 2500, why = '') {
    this.avatar.lookToward(dir, ms);
    this.lastMove = Date.now();
    this.log(`I'm looking ${dir === 'left' || dir === 'right' ? `to my ${dir}` : dir}${why ? ` (${why})` : ''}`);
  }
  tilt(side = 'left', ms = 2600, why = '') {
    this.avatar.tiltHead(side, ms);
    this.lastMove = Date.now();
    this.log(`I'm tilting my head to my ${side}${why ? ` (${why})` : ''}`);
  }
  shift(side = 'left', ms = 7000, why = '') {
    this.avatar.shiftWeight(side, ms);
    this.lastMove = Date.now();
    this.log(`I'm putting my weight on my ${side} leg${why ? ` (${why})` : ''}`);
  }
  fist(side = 'right', ms = 1800, why = '') {
    this.avatar.curlHand(side, 1, ms);
    this.lastMove = Date.now();
    this.log(`I'm making a fist with my ${side === 'both' ? 'hands' : side + ' hand'}${why ? ` (${why})` : ''}`);
  }
  stretchFingers(side = 'both', ms = 1500, why = '') {
    this.avatar.curlHand(side, 0, ms);
    this.lastMove = Date.now();
    this.log(`I'm stretching my fingers out${why ? ` (${why})` : ''}`);
  }
  hip(side = 'left', ms = 6000, why = '') {
    if (this.avatar.handOnHipPose(side, ms) === false) return;   // not mid-dance / seated
    this.lastMove = Date.now();
    this.log(`I'm putting my ${side} hand on my hip${why ? ` (${why})` : ''}`);
  }
  lookAround(why = '') {
    const first = pick(['left', 'right']), second = first === 'left' ? 'right' : 'left';
    this.avatar.lookToward(first, 1600);
    setTimeout(() => this.avatar.lookToward(second, 1600), 1700);
    setTimeout(() => this.avatar.lookToward(pick(['up', 'center']), 1200), 3400);
    this.lastMove = Date.now();
    this.log(`I'm looking around my room${why ? ` (${why})` : ''}`);
  }
  nod(why = '', quiet = false) {
    this.avatar.nod(1200);
    this.lastMove = Date.now();
    if (!quiet) this.log(`I'm nodding${why ? ` (${why})` : ''}`);
  }
  shake(why = '', quiet = false) {
    this.avatar.shakeHead(1200);
    this.lastMove = Date.now();
    if (!quiet) this.log(`I'm shaking my head${why ? ` (${why})` : ''}`);
  }
  tap(side = 'right', ms = 3200, why = '') {
    this.avatar.tapFoot(side, ms);
    this.lastMove = Date.now();
    this.log(`I'm tapping my ${side} foot${why ? ` (${why})` : ''}`);
  }
  face(mood, ms = 5000, why = '', quiet = false) {
    const m = this.avatar.setExpression(mood, 1, ms);
    this.mood = m;
    if (!quiet) this.log(`I'm making a ${m} face${why ? ` (${why})` : ''}`);
  }

  // ---- what happens around her ----
  onChat() {
    // chat panel sits to HER left (screen right) on the stage
    const now = Date.now();
    this.chatTimes = this.chatTimes.filter((t) => now - t < 12000);
    this.chatTimes.push(now);
    if (this.ready && this.chatTimes.length >= 6 && now - this.lastChatGlance > 45000 && now - this.lastMove > 4000) {
      this.lastChatGlance = now;
      this.look('left', 2200, 'chat is busy, checking it out');
    }
  }
  onMention(user) {
    if (!this.ready) return;
    this.wave('right', `${user} said my name`);
    this.face('happy', 4000, '', true);
    if (this.moves && !this.moves.busy && Math.random() < 0.35) setTimeout(() => this.moves.play('happy', 'happy', `${user} hyped me up`), 2600);
  }
  // plain-word body commands from chat ("sit", "stand up", "dance", "spin", "stop dancing"): short imperative
  // messages only, so "I can't stand this" never makes her stand up
  bodyWord(text = '') {
    const m = String(text).toLowerCase().replace(/[’']/g, '').match(/^\s*(?:(?:hey|yo|ok|okay|jena|please|pls|can you|could you|now|go)[\s,!]*)*(sit down|sit|take a seat|have a seat|stand up|stand|get up|do a dance|dance for us|dance|do a kpop dance|kpop dance|kpop|stop dancing|spin the chair|spin around|spin)(?:[\s,!.?]*(?:please|pls|jena|again|now|for me|for us))*[\s!.?]*$/);
    if (!m) return null;
    const w = m[1];
    return /sit|seat/.test(w) ? 'sit' : /stand|get up/.test(w) ? 'stand' : /stop/.test(w) ? 'stopdance' : /dance|kpop/.test(w) ? 'dance' : 'spin';
  }
  command(cmd, why = 'asked') {
    const A = this.avatar;
    if (cmd === 'dance') { if (this.seat?.seated) this.seat.stand('getting up to dance'); setTimeout(() => this.dance?.start({ why }).then((r) => r && this.log(`dancing ${r.song} (${r.artist}) because ${why}`)), this.seat?.seated ? 1600 : 0); return true; }
    if (cmd === 'stopdance') { this.dance?.stop(); return true; }
    if (cmd === 'sit') { this.dance?.stop(); this.seat?.sit(why); return true; }
    if (cmd === 'stand') { this.seat?.stand(why); return true; }
    if (cmd === 'spin') { if (this.seat?.seated) this.seat.spin(); else if (!this.dance?.active) A.spin?.(); return true; }
    return false;
  }
  onMessage(user, text = '') {
    this.motion?.seenUser(user);   // a username in what she says next -> a direct-to-camera gesture at them
    if (!this.ready) return;
    { const c = this.bodyWord(text); if (c) { this.command(c, `${user} asked`); this.lastIdle = Date.now(); this.lastMove = Date.now(); return; } }
    this.lastIdle = Date.now();
    if (Date.now() - this.lastMove > 3000) {
      this.avatar.lookToward('center');
      this.face('happy', 3500, `${user} is talking to me`);
      if (/\?\s*$/.test(text)) this.avatar.tiltHead(Math.random() < 0.5 ? 'left' : 'right', 2400, 0.18); // a question: curious tilt
      else this.avatar.nod(1000);
    }
  }
  // what she just said out loud: body language that goes with her own words
  onSay(text = '') {
    if (!this.ready) return;
    const t = String(text).toLowerCase();
    if (/^(lmao |lol |nah|nope|no\b)/.test(t)) this.shake('', true);
    else if (/^(yes|yeah|yep|ok|okay|sure|bet)\b/.test(t)) this.nod('', true);
    else if (/\?\s*$/.test(t)) this.avatar.tiltHead(Math.random() < 0.5 ? 'left' : 'right', 2200, 0.15);
    if (/!{1,}|\b(lets go|let's go|yay|hype)\b/.test(t) && Math.random() < 0.5) this.avatar.curlHand('right', 1, 1400);
    // a longer thing to say: she talks with her hands the way she learned from people on video
    else if (t.length > 50 && this.moves && !this.moves.busy && Math.random() < 0.6) this.moves.play('talk', this.mood);
  }
  onPrivateMessage() {
    if (!this.ready) return;
    this.lastIdle = Date.now();
    this.face('relaxed', 3500, 'mama sent me something private');
  }
  onFileDrop(name) {
    if (!this.ready) return;
    this.lastIdle = Date.now();
    this.face('surprised', 2500, '', true);
    this.raise('right', 1800, `catching ${name}`);
  }
  // from her brain's reply: {type:'action'|'mood', …}
  fromBrain(e) {
    if (!this.ready) return;
    try {
      if (e.type === 'mood') return this.face(e.value, 6000, 'my brain picked it');
      if (e.name === 'raiseArm') return this.raise(e.args?.[0] || 'left', 2600, 'my brain decided');
      if (e.name === 'lowerArm') return this.lower('my brain decided');
      if (e.name === 'wave') return this.wave(e.args?.[0] || 'right', 'my brain decided');
      if (e.name === 'look') return this.look(e.args?.[0] || 'left', 2500, 'my brain decided');
      if (e.name === 'tilt') return this.tilt(e.args?.[0] || 'left', 2600, 'my brain decided');
      if (e.name === 'nod') return this.nod('my brain decided');
      if (e.name === 'shake') return this.shake('my brain decided');
      if (e.name === 'hip') return this.hip(e.args?.[0] || 'left', 5000, 'my brain decided');
      if (e.name === 'fist') return this.fist(e.args?.[0] || 'right', 1800, 'my brain decided');
      if (['dance', 'sit', 'stand', 'spin'].includes(e.name)) return this.command(e.name, 'my brain decided');
    } catch (err) { this.log(`tried to move but couldn't (${err.message})`); }
  }

  // ---- idle life: she does her own thing when nothing is happening ----
  tick() {
    if (!this.ready || document.hidden) return;
    const now = Date.now();
    if (now - this.lastIdle < this.nextIdleIn || now - this.lastMove < 6000 || this.moves?.busy || this.dance?.active || this.seat?.busy) return;
    this.lastIdle = now;
    this.nextIdleIn = Math.min(55000, Math.max(10000, 20000 * Math.exp((Math.random() + Math.random() + Math.random() - 1.5) * 1.0)));   // irregular, never a steady beat
    const quietFor = now - Math.max(...this.chatTimes, 0);
    // long quiet stretches: now and then she sits down in her chair, or gets up and dances (irregular, never on a beat)
    if (this.seat && this.seat.idleTick(now, quietFor)) return;
    if (this.dance && !this.seat?.seated && quietFor > 90000 && now - (this.lastDance || 0) > 240000 + Math.random() * 360000 && Math.random() < 0.12) {
      this.lastDance = now; this.lastMove = now;
      this.dance.start({ why: 'bored, so I put on some k-pop' }).then((r) => r && this.log(`practising ${r.song} (${r.artist}), it's quiet in here`));
      return;
    }
    // moves she learned herself from watching videos of real people (src/moves.js): often her first pick
    if (this.moves?.library.length && Math.random() < 0.55) {
      this.lastMove = now;
      this.moves.play(quietFor > 90000 ? 'bored' : 'idle', this.mood);
      return;
    }
    const options = [
      () => this.raise('both', 1800 + Math.random() * 900, say(['stretching, been standing here a while', 'big stretch', 'ok stretching real quick', 'shoulder stretch'], 'stretch')),
      () => this.tilt(pick(['left', 'right']), 2200 + Math.random() * 1400, say(['thinking about something', 'hmm', 'wait what was I doing', 'pondering'], 'tilt')),
      () => this.shift(pick(['left', 'right']), 7000 + Math.random() * 5000, say(['my legs are tired', 'shifting my weight', 'new stance who dis', 'standing is a sport honestly'], 'shift')),
      () => this.fist(pick(['left', 'right']), 1200 + Math.random() * 900, say(['squeezing my hand, just fidgeting', 'fidgeting', 'little hand squeeze'], 'fist')),
      () => this.stretchFingers('both', 1200 + Math.random() * 700, say(['cracking my knuckles, kinda', 'finger stretch', 'wiggling my fingers'], 'fingers')),
      () => this.tap(pick(['left', 'right']), 2600 + Math.random() * 1600, quietFor > 60000 ? say(["it's quiet in here", 'so quiet rn', 'chat where are you'], 'quiet') : say(['bopping to nothing', 'tapping along to the song in my head', 'tap tap'], 'tap')),
      () => this.nod(say(['agreeing with my own thoughts', 'yeah. yeah.', 'nodding at nothing'], 'nod')),
      () => this.raise(pick(['left', 'right']), 2000 + Math.random() * 900, say(['checking my own arm works', 'just because I can', 'arm check', 'testing my shoulder'], 'raise1')),
      () => this.lookAround(say(["just seeing what's up", 'looking around', 'what is going on over there'], 'look')),
      () => this.hip(pick(['left', 'right']), 4500 + Math.random() * 4500, say(['just standing here, being iconic', 'hand on hip, very cool', 'posing a little'], 'hip')),
      () => this.look(pick(['up', 'up', 'down']), 1600 + Math.random() * 1000, say(['thinking', 'daydreaming', 'lost in thought'], 'lookup')),
      () => { this.avatar.spin?.(); this.lastMove = Date.now(); this.log(say(['spinning around real quick', 'full spin, why not', 'doing a little twirl', 'turning around to check behind me'], 'spin')); },
      () => this.face(pick(['relaxed', 'happy']), 3000 + Math.random() * 2500, say(['vibing', 'chilling', 'good mood'], 'face')),
      () => this.wave(pick(['left', 'right']), say(['saying hi to whoever is watching', 'hi!!', 'waving at chat'], 'wave')),
    ];
    // no repeats: an action comes back only after 4 others and never inside 45 s (src/nonrepeat.js)
    const i = IDLE.pick(options.map((_, k) => k), { pool: 'autonomy-idle' });
    this.prevIdlePick = this.lastIdlePick; this.lastIdlePick = i;
    try { const L = (window.jenaLog ||= []); L.push({ t: Math.round(performance.now()), kind: 'act', what: 'idle#' + i, why: 'autonomy' }); if (L.length > 400) L.shift(); } catch {}
    options[i]();
  }

  // small posture changes she makes without thinking about them (not logged as decisions; her self-sense
  // still notices them): shifting weight between her feet every so often, like anyone standing a while
  posture() {
    if (!this.ready || document.hidden) { clearTimeout(this.postureTimer); this.postureTimer = setTimeout(() => this.posture(), 1000); return; }
    // nobody stands evenly on both feet for long: she swaps which leg holds her weight
    // not a metronome: usually the other leg, sometimes the same one again, hold times log-normal (median ~10 s)
    this.weightSide = !this.weightSide ? pick(['left', 'right']) : Math.random() < 0.7 ? (this.weightSide === 'left' ? 'right' : 'left') : this.weightSide;
    const hold = Math.min(26000, Math.max(5000, Math.exp(Math.log(10000) + 0.45 * Math.sqrt(-2 * Math.log(Math.max(1e-9, Math.random()))) * Math.cos(2 * Math.PI * Math.random()))));
    this.avatar.shiftWeight(this.weightSide, hold + 3000);
    clearTimeout(this.postureTimer);
    this.postureTimer = setTimeout(() => this.posture(), hold);
  }
}
