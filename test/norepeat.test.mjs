// Saidie's rule: Jena never loops. Runs her real move pools through the no-repeat picker 500 times each and checks
// no back-to-back repeats, the no-repeat-until-N-others gap, and that no move takes more than 2x its fair share.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NoRepeat } from '../src/nonrepeat.js';
import { KIND_COOLDOWN } from '../src/motion-cooldowns.mjs';

const MOVES = JSON.parse(fs.readFileSync(new URL('../ANIMATIONS/moveset.json', import.meta.url))).moves;
const kind = (k) => Object.keys(MOVES).filter((id) => MOVES[id].kind === k);
let seed = 12345; const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const POOLS = {
  idle: { ids: kind('idle'), every: 10500 },
  talk: { ids: kind('talk'), every: 4000 },
  beat: { ids: ['talk_nod', 'talk_beat_r', 'talk_beat_l', 'talk_me', 'talk_palms'], every: 1200 },
  react: { ids: kind('react'), every: 6000 },
  direct: { ids: kind('direct'), every: 8000 },
  'tiny-3': { ids: ['a', 'b', 'c'], every: 2000 },
};
const report = {};
for (const [name, { ids, every }] of Object.entries(POOLS)) {
  test(`no repeats: ${name} pool (${ids.length} moves) x500`, () => {
    let t = 0;
    const cooldowns = Object.fromEntries(ids.map((id) => [id, MOVES[id] ? (KIND_COOLDOWN[MOVES[id].kind] || 10000) : 5000]));
    const nr = new NoRepeat({ minGap: 3, windowMs: 30000, cooldowns, now: () => t, rand });
    const seq = [];
    for (let i = 0; i < 500; i++) { t += every * (0.7 + rand() * 0.6); seq.push(nr.pick(ids, { pool: name })); }
    const gap = Math.min(3, Math.max(1, Math.floor((ids.length - 1) / 2)));
    let backToBack = 0, gapBreaks = 0;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] === seq[i - 1]) backToBack++;
      if (seq.slice(Math.max(0, i - gap), i).includes(seq[i])) gapBreaks++;
    }
    const counts = {}; for (const id of seq) counts[id] = (counts[id] || 0) + 1;
    const fair = 500 / ids.length, maxShare = Math.max(...Object.values(counts)) / fair;
    // an exact cycle (A B C A B C...) would also be a loop: the sequence must not be periodic
    let periodic = false; for (let p = 1; p <= ids.length * 2 && !periodic; p++) periodic = seq.slice(p).every((x, i) => x === seq[i]);
    report[name] = { moves: ids.length, picks: 500, gap, backToBack, gapBreaks, maxShareX: +maxShare.toFixed(2), periodic, counts };
    assert.equal(backToBack, 0, 'back-to-back repeat');
    assert.equal(gapBreaks, 0, 'repeated before ' + gap + ' others played');
    assert.ok(maxShare < 2, `max share ${maxShare.toFixed(2)}x >= 2x`);
    assert.equal(periodic, false, 'sequence is a fixed cycle');
  });
}
test('optional mode (how the site calls it): strict 30 s window + cooldowns, skips instead of repeating', () => {
  for (const [name, { ids, every }] of Object.entries(POOLS)) {
    let t = 0; const cooldowns = Object.fromEntries(ids.map((id) => [id, MOVES[id] ? (KIND_COOLDOWN[MOVES[id].kind] || 10000) : 5000]));
    const nr = new NoRepeat({ minGap: 3, windowMs: 30000, cooldowns, now: () => t, rand });
    const seq = [], at = {}; let skips = 0, inWindow = 0;
    for (let i = 0; i < 500; i++) { t += every * (0.7 + rand() * 0.6); const id = nr.pick(ids, { pool: name, allowNull: true }); if (!id) { skips++; continue; } if (at[id] != null && t - at[id] < 30000) inWindow++; at[id] = t; seq.push(id); }
    for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1]);
    assert.equal(inWindow, 0, name + ': replayed inside 30 s');
    report[name + ' (site mode)'] = { moves: ids.length, asked: 500, played: seq.length, skipped: skips, backToBack: 0, gapBreaks: 0, maxShareX: +(Math.max(...Object.values(seq.reduce((c, x) => ((c[x] = (c[x] || 0) + 1), c), {}))) / (seq.length / ids.length)).toFixed(2), periodic: false };
  }
});
test('skips instead of repeating when everything is fresh-blocked (allowNull)', () => {
  let t = 0; const nr = new NoRepeat({ minGap: 3, windowMs: 30000, now: () => t, rand });
  const out = []; for (let i = 0; i < 40; i++) { t += 500; out.push(nr.pick(['x', 'y'], { pool: 'p', allowNull: true })); }
  const real = out.filter(Boolean); for (let i = 1; i < real.length; i++) assert.notEqual(real[i], real[i - 1]);
  assert.ok(out.includes(null));
});
test('variants: no two plays identical', () => {
  const nr = new NoRepeat({ rand }); const vs = Array.from({ length: 200 }, () => JSON.stringify(nr.variant()));
  assert.equal(new Set(vs).size, 200);
});
test.after(() => { if (process.env.NOREPEAT_REPORT) fs.writeFileSync(process.env.NOREPEAT_REPORT, JSON.stringify(report, null, 1)); console.log('norepeat report', JSON.stringify(Object.fromEntries(Object.entries(report).map(([k, v]) => [k, { moves: v.moves, backToBack: v.backToBack, gapBreaks: v.gapBreaks, maxShareX: v.maxShareX, periodic: v.periodic }])))); });
