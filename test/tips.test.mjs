import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitCents, tipLedger, money, SPLIT, TIP_LINK } from '../src/tipsplit.mjs';

const sum = (s) => s.taxes + s.compute + s.saidie;

test('split rule is 30/30/40 (taxes / compute / Saidie)', () => {
  assert.deepEqual(SPLIT.map((s) => [s.key, s.pct]), [['taxes', 30], ['compute', 30], ['saidie', 40]]);
  assert.equal(SPLIT.reduce((a, s) => a + s.pct, 0), 100);
});

test('exact splits', () => {
  assert.deepEqual(splitCents(1000), { taxes: 300, compute: 300, saidie: 400 });
  assert.deepEqual(splitCents(500), { taxes: 150, compute: 150, saidie: 200 });
  assert.deepEqual(splitCents(0), { taxes: 0, compute: 0, saidie: 0 });
});

test('rounding to whole cents: leftovers go to the biggest remainder, ties taxes first', () => {
  assert.deepEqual(splitCents(1), { taxes: 0, compute: 0, saidie: 1 });      // 0.3 / 0.3 / 0.4
  assert.deepEqual(splitCents(3), { taxes: 1, compute: 1, saidie: 1 });      // 0.9 / 0.9 / 1.2
  assert.deepEqual(splitCents(333), { taxes: 100, compute: 100, saidie: 133 }); // 99.9 / 99.9 / 133.2
  assert.deepEqual(splitCents(101), { taxes: 30, compute: 30, saidie: 41 }); // 30.3 / 30.3 / 40.4
  assert.deepEqual(splitCents(105), { taxes: 32, compute: 31, saidie: 42 }); // 31.5 / 31.5 / 42
});

test('every split adds up to the tip exactly and stays within a cent of the true share', () => {
  for (let c = 0; c <= 20000; c++) {
    const s = splitCents(c);
    assert.equal(sum(s), c, `cents ${c}`);
    for (const p of SPLIT) assert.ok(Math.abs(s[p.key] - (c * p.pct) / 100) < 1, `cents ${c} ${p.key}`);
    for (const v of Object.values(s)) assert.ok(Number.isInteger(v) && v >= 0);
  }
});

test('rejects non-cent amounts', () => {
  for (const bad of [1.5, -1, NaN, '500', null]) assert.throws(() => splitCents(bad), RangeError);
});

test('ledger totals add up exactly, rows newest first', () => {
  const tips = [
    { at: '2026-10-14T20:00:00Z', amountCents: 500 },
    { at: '2026-10-15T01:00:00Z', amountCents: 333 },
    { at: Date.parse('2026-10-14T22:00:00Z'), amountCents: 101, currency: 'USD' },
  ];
  const l = tipLedger(tips);
  assert.equal(l.count, 3);
  assert.deepEqual(l.rows.map((r) => r.amountCents), [333, 101, 500]);
  assert.equal(l.totals.amount, 934);
  assert.equal(l.totals.taxes + l.totals.compute + l.totals.saidie, l.totals.amount);
  assert.deepEqual(l.totals, { amount: 934, taxes: 280, compute: 280, saidie: 374 });
  for (const r of l.rows) assert.equal(sum(r.split), r.amountCents);
  assert.equal(l.rows[1].currency, 'usd');
});

test('empty ledger is all zeros (no fake numbers)', () => {
  assert.deepEqual(tipLedger([]), { count: 0, rows: [], totals: { amount: 0, taxes: 0, compute: 0, saidie: 0 } });
});

test('money formats cents', () => {
  assert.equal(money(0), '$0.00');
  assert.equal(money(123456), '$1,234.56');
});

test('tip button uses the exact Stripe link and stays wholesome', () => {
  assert.equal(TIP_LINK, 'https://buy.stripe.com/3cI8wRenugKRbt3bdw8k800');
  const btn = readFileSync(new URL('../src/tip.js', import.meta.url), 'utf8');
  assert.match(btn, /target = '_blank'/);
  assert.match(btn, /Tip Jena/);
  assert.ok(!/Jenna/.test(btn));
  assert.match(btn, /if \(obs/);
});

test('tip ledger API is mama-only and never writes to Stripe', () => {
  const api = readFileSync(new URL('../api/jena.js', import.meta.url), 'utf8');
  const fn = api.slice(api.indexOf('async function tipsRoute'), api.indexOf('async function handle('));
  assert.match(fn, /mama-only/);
  assert.match(fn, /401/);
  assert.ok(!/method:\s*'(POST|DELETE)'/.test(fn), 'GET only');
  assert.ok(!/refund|payout|charges/i.test(fn.replace(/Checkout Sessions: read/, '')));
});
