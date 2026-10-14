// No-repeat picking for everything Jena chooses on her own: moves, reactions, expressions, lines, soundboard clips.
// Saidie's rule: she must never look (or sound) like she's on a loop. A plain Math.random() pick over a pool of
// 3-9 items repeats constantly (1 in 3 back to back for the beat pool), so every pick goes through a NoRepeat:
//   · shuffle bag per pool: every item comes up once before any comes up twice (even spread, no streaks)
//   · recency gap: nothing repeats until at least `minGap` OTHER items have played (shared across pools, so a
//     react move picked from the shock pool also counts when the cringe pool picks next)
//   · recency window: nothing that played in the last `windowMs` (~30 s) while anything else is free
//   · per-item cooldowns (ms), e.g. a big facepalm can't come back for 25 s
//   · when everything is blocked it takes the least-recently-used item that still keeps the gap, or returns
//     null (callers then skip the gesture: doing nothing beats repeating)
// Plus variant(): a fresh random variant per play (amplitude, speed, mirror, timing jitter, time warp) so even
// an item that does come back never plays identically.
export class NoRepeat {
  constructor({ minGap = 3, windowMs = 30000, cooldowns = {}, defaultCooldownMs = 0, now, rand, keep = 200, store = null } = {}) {
    this.minGap = minGap; this.windowMs = windowMs; this.cooldowns = cooldowns; this.defaultCooldownMs = defaultCooldownMs;
    this.now = now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.rand = rand || Math.random;
    this.keep = keep; this.store = store;
    this.hist = [];            // newest first: { id, at, pool }
    this.bags = new Map();     // pool -> remaining ids (shuffled)
    this.until = new Map();    // id -> cooldown end (ms, this.now clock)
    if (store) { try { const h = JSON.parse(store.getItem('jena.norepeat') || '[]'); if (Array.isArray(h)) { const t0 = this.now(); this.hist = h.filter((x) => x && x.id).slice(0, keep).map((x) => ({ ...x, at: t0 + (x.at || 0) })); } } catch {} }
  }
  shuffle(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  lastAt(id) { const h = this.hist.find((x) => x.id === id); return h ? h.at : -Infinity; }
  // ids among `cands` played in the last k plays (of any pool)
  recentIds(cands, k) { const s = new Set(), c = new Set(cands); for (const x of this.hist) { if (s.size >= k) break; if (c.has(x.id)) s.add(x.id); } return s; }
  blocked(id, t, gapSet, { window = true, cooldown = true } = {}) {
    if (gapSet.has(id)) return true;
    if (cooldown && (this.until.get(id) || -Infinity) > t) return true;
    if (window && t - this.lastAt(id) < this.windowMs) return true;
    return false;
  }
  // pick one id from `ids` for `pool`. opts: { cooldownMs, allowNull (default false), minGap }
  pick(ids, opts = {}) {
    const cands = [...new Set((ids || []).filter((x) => x != null))];
    if (!cands.length) return null;
    const pool = opts.pool || 'default', t = this.now();
    if (cands.length === 1) {
      const only = cands[0];
      // a pool of one may repeat, but never back to back and never inside its cooldown, unless the caller insists
      if (this.hist[0]?.id === only || (this.until.get(only) || -Infinity) > t) { if (opts.allowNull) return null; }
      return this.commit(only, pool, t, opts);
    }
    // the gap shrinks for tiny pools: with 3 items a gap of 2 would force one fixed cycle (A B C A B C), itself a
    // loop, so a pool keeps at least half of its other items free to choose from
    const gap = Math.min(opts.minGap ?? this.minGap, Math.max(1, Math.floor((cands.length - 1) / 2)));
    const gapSet = this.recentIds(cands, gap);
    // the bag: refill with a fresh shuffle when it has nothing usable left
    let bag = (this.bags.get(pool) || []).filter((id) => cands.includes(id));
    // a preferred item (the best fit for what she just said) wins when nothing blocks it
    if (opts.prefer != null && cands.includes(opts.prefer) && !this.blocked(opts.prefer, t, gapSet)) {
      this.bags.set(pool, bag.filter((x) => x !== opts.prefer));
      return this.commit(opts.prefer, pool, t, opts);
    }
    const fromBag = (rules) => bag.find((id) => !this.blocked(id, t, gapSet, rules));
    let id = fromBag({});
    if (id == null) { bag = this.shuffle(cands); id = fromBag({}); }
    // optional picks (idle/talk/beat gestures, reactions) keep every rule strictly: skip instead
    if (id == null && opts.allowNull) { this.bags.set(pool, bag); return null; }
    // forced picks relax: window first, then cooldowns; the gap (no repeat until N others) always holds
    if (id == null) id = fromBag({ window: false });
    if (id == null) id = fromBag({ window: false, cooldown: false });
    if (id == null) {
      if (opts.allowNull) { this.bags.set(pool, bag); return null; }
      // least recently used of all (gap can't be kept: only happens when cands.length <= gap)
      id = [...cands].sort((a, b) => this.lastAt(a) - this.lastAt(b))[0];
    }
    this.bags.set(pool, bag.filter((x) => x !== id));
    return this.commit(id, pool, t, opts);
  }
  commit(id, pool, t, opts = {}) {
    this.hist.unshift({ id, at: t, pool });
    if (this.hist.length > this.keep) this.hist.length = this.keep;
    const cd = opts.cooldownMs ?? this.cooldowns[id] ?? this.defaultCooldownMs;
    if (cd > 0) this.until.set(id, t + cd);
    if (this.store) { try { this.store.setItem('jena.norepeat', JSON.stringify(this.hist.slice(0, 60).map((x) => ({ id: x.id, at: x.at - t, pool: x.pool })))); } catch {} }
    return id;
  }
  // tell it about something chosen elsewhere (a forced move), so the gap/window/cooldown still count it
  note(id, pool = 'manual', cooldownMs) { return this.commit(id, pool, this.now(), { cooldownMs }); }
  stats(last = 100) {
    const h = this.hist.slice(0, last).reverse(); let backToBack = 0; const counts = {};
    for (let i = 0; i < h.length; i++) { counts[h[i].id] = (counts[h[i].id] || 0) + 1; if (i && h[i].id === h[i - 1].id) backToBack++; }
    return { plays: h.length, distinct: Object.keys(counts).length, backToBack, counts };
  }
  // a fresh variant for one play: nothing plays the same way twice
  variant({ mirror = true } = {}) {
    const r = this.rand, j = (a, b) => a + (b - a) * r();
    return {
      amp: +j(0.8, 1.18).toFixed(3),        // size
      speed: +j(0.86, 1.16).toFixed(3),     // tempo
      mirror: mirror && r() < 0.5,          // left/right swapped
      delayMs: Math.round(j(0, 140)),       // onset jitter
      warp: +j(0.82, 1.2).toFixed(3),       // time warp (u^warp): front- or back-loaded
      bias: [+j(-0.04, 0.04).toFixed(3), +j(-0.06, 0.06).toFixed(3), +j(-0.03, 0.03).toFixed(3)], // head x/y/z offset (rad)
      seed: Math.floor(r() * 1e9),
    };
  }
}

// a slowly wandering random value (Ornstein-Uhlenbeck): micro-motion that never cycles
export class Wander {
  constructor(sigma = 1, tau = 1.6, rand = Math.random) { this.v = 0; this.sigma = sigma; this.tau = tau; this.rand = rand; }
  step(dt) {
    const g = Math.sqrt(-2 * Math.log(Math.max(1e-9, this.rand()))) * Math.cos(2 * Math.PI * this.rand());
    this.v += (-this.v / this.tau) * dt + this.sigma * Math.sqrt(2 * dt / this.tau) * g;
    return this.v;
  }
}
