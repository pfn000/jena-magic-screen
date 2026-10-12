// Jena's own body: a small behaviour controller that decides her gestures, gaze and expressions
// from what is actually happening around her (chat activity, messages to her, file drops, her mood,
// idle time) and from what her brain (JenaXI) asks for via action tags. Nobody else drives her body:
// there are no movement buttons or commands. Every move she makes is logged in the thought chain in
// her own words ("I'm raising my left arm"). "Left" and "right" are always HER left and right.
const pick = (a) => a[Math.floor(Math.random() * a.length)];
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
    this.avatar.handOnHipPose(side, ms);
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
  onMessage(user, text = '') {
    if (!this.ready) return;
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
    } catch (err) { this.log(`tried to move but couldn't (${err.message})`); }
  }

  // ---- idle life: she does her own thing when nothing is happening ----
  tick() {
    if (!this.ready || document.hidden) return;
    const now = Date.now();
    if (now - this.lastIdle < this.nextIdleIn || now - this.lastMove < 6000 || this.moves?.busy) return;
    this.lastIdle = now;
    this.nextIdleIn = 12000 + Math.random() * 18000;
    const quietFor = now - Math.max(...this.chatTimes, 0);
    // moves she learned herself from watching videos of real people (src/moves.js): often her first pick
    if (this.moves?.library.length && Math.random() < 0.55) {
      this.lastMove = now;
      this.moves.play(quietFor > 90000 ? 'bored' : 'idle', this.mood);
      return;
    }
    const options = [
      () => this.raise('both', 2200, 'stretching, been standing here a while'),
      () => this.tilt(pick(['left', 'right']), 2800, 'thinking about something'),
      () => this.shift(pick(['left', 'right']), 9000, 'my legs are tired'),
      () => this.fist(pick(['left', 'right']), 1600, 'squeezing my hand, just fidgeting'),
      () => this.stretchFingers('both', 1500, 'cracking my knuckles, kinda'),
      () => this.tap(pick(['left', 'right']), 3200, quietFor > 60000 ? "it's quiet in here" : 'bopping to nothing'),
      () => this.nod('agreeing with my own thoughts'),
      () => this.raise('left', 2400, 'checking my own arm works'),
      () => this.raise('right', 2400, 'just because I can'),
      () => this.lookAround('just seeing what\'s up'),
      () => this.hip(pick(['left', 'right']), 5000 + Math.random() * 4000, 'just standing here, being iconic'),
      () => this.look('up', 2000, 'thinking'),
      () => this.face(pick(['relaxed', 'happy']), 4000, 'vibing'),
      () => this.wave(pick(['left', 'right']), 'saying hi to whoever is watching'),
    ];
    // never the same thing twice in a row
    let i; do { i = Math.floor(Math.random() * options.length); } while (options.length > 2 && (i === this.lastIdlePick || i === this.prevIdlePick));
    this.prevIdlePick = this.lastIdlePick; this.lastIdlePick = i;
    options[i]();
  }

  // small posture changes she makes without thinking about them (not logged as decisions; her self-sense
  // still notices them): shifting weight between her feet every so often, like anyone standing a while
  posture() {
    if (!this.ready || document.hidden) { clearTimeout(this.postureTimer); this.postureTimer = setTimeout(() => this.posture(), 1000); return; }
    // nobody stands evenly on both feet for long: she swaps which leg holds her weight
    this.weightSide = this.weightSide === 'left' ? 'right' : this.weightSide === 'right' ? 'left' : pick(['left', 'right']);
    const hold = 7000 + Math.random() * 11000;
    this.avatar.shiftWeight(this.weightSide, hold + 3000);
    clearTimeout(this.postureTimer);
    this.postureTimer = setTimeout(() => this.posture(), hold);
  }
}
