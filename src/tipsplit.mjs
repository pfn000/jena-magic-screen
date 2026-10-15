// Jena's tip split (Saidie's rule, Oct 14 2026): every tip is split 30% taxes / 30% Jena's compute fund / 40% Saidie.
// Pure math in integer cents, shared by the site API (api/jena.js), the dev panel ledger and the tests.
// Rounding: each part is floored, then the 0-2 leftover cents go to the parts with the biggest fractional
// remainder (ties: taxes first, then compute, then Saidie), so the three parts always add up to the tip exactly.
export const TIP_LINK = 'https://buy.stripe.com/3cI8wRenugKRbt3bdw8k800';
export const TIP_PAYMENT_LINK_ID = 'plink_1UQTnJQpErPBNMzr6qq5xPpg';
export const SPLIT = Object.freeze([
  { key: 'taxes', label: 'Taxes', pct: 30 },
  { key: 'compute', label: "Jena's compute fund", pct: 30 },
  { key: 'saidie', label: 'Saidie', pct: 40 },
]);

export function splitCents(cents) {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError(`tip must be a whole, non-negative number of cents (got ${cents})`);
  const parts = SPLIT.map((s, i) => ({ key: s.key, i, base: Math.floor((cents * s.pct) / 100), rem: (cents * s.pct) % 100 }));
  let left = cents - parts.reduce((a, p) => a + p.base, 0);
  for (const p of [...parts].sort((a, b) => b.rem - a.rem || a.i - b.i)) { if (left <= 0) break; p.base += 1; left -= 1; }
  return Object.fromEntries(parts.map((p) => [p.key, p.base]));
}

// tips: [{ at: ms or ISO, amountCents: int, currency?: 'usd', id?: string }] -> rows newest first + exact totals
export function tipLedger(tips = []) {
  const rows = tips
    .map((t) => ({ id: t.id || null, at: typeof t.at === 'number' ? t.at : Date.parse(t.at), amountCents: t.amountCents, currency: (t.currency || 'usd').toLowerCase(), split: splitCents(t.amountCents) }))
    .sort((a, b) => b.at - a.at);
  const totals = { amount: 0, taxes: 0, compute: 0, saidie: 0 };
  for (const r of rows) { totals.amount += r.amountCents; for (const s of SPLIT) totals[s.key] += r.split[s.key]; }
  return { count: rows.length, rows, totals };
}

export const money = (cents, currency = 'usd') => {
  const n = (cents || 0) / 100;
  try { return n.toLocaleString('en-US', { style: 'currency', currency: currency.toUpperCase() }); } catch { return '$' + n.toFixed(2); }
};
