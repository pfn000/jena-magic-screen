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
    this.nextIdleIn = 22000 + Math.random() * 18000;
    this.chatTimes = [];
    this.lastChatGlance = 0;
    this.mood = 'neutral';
    this.timer = setInterval(() => this.tick(), 1000);
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
  }
  onMessage(user) {
    if (!this.ready) return;
    this.lastIdle = Date.now();
    if (Date.now() - this.lastMove > 3000) { this.avatar.lookToward('center'); this.face('happy', 3500, `${user} is talking to me`); }
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
    } catch (err) { this.log(`tried to move but couldn't (${err.message})`); }
  }

  // ---- idle life: she does her own thing when nothing is happening ----
  tick() {
    if (!this.ready || document.hidden) return;
    const now = Date.now();
    if (now - this.lastIdle < this.nextIdleIn || now - this.lastMove < 8000) return;
    this.lastIdle = now;
    this.nextIdleIn = 25000 + Math.random() * 35000;
    const options = [
      () => this.raise('both', 2200, 'stretching, been standing here a while'),
      () => this.raise('left', 2400, 'checking my own arm works'),
      () => this.raise('right', 2400, 'just because I can'),
      () => this.look(pick(['left', 'right']), 2600, 'looking around my room'),
      () => this.look('up', 2000, 'thinking'),
      () => this.face(pick(['relaxed', 'happy']), 4000, 'vibing'),
      () => this.wave(pick(['left', 'right']), 'saying hi to whoever is watching'),
    ];
    pick(options)();
  }
}
