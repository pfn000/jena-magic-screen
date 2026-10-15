// Jena's tip ledger API (mama only). Tips are read ONLY server-side and live, never committed to this
// (public) repo: when the site has a READ-ONLY restricted Stripe key in STRIPE_TIPS_READ_KEY
// (Checkout Sessions: read), it lists the PAID checkout sessions of the tip payment link. Without that key
// it answers an empty list with source "not_connected". GET requests to Stripe only; never writes to Stripe.
import { json } from './http.js';
import { tipLedger, TIP_LINK, TIP_PAYMENT_LINK_ID } from '../../src/tipsplit.mjs';

export const NOT_CONNECTED_NOTE = 'Live tips need a read-only Stripe key added in Vercel (STRIPE_TIPS_READ_KEY). No tips shown yet.';

// isMama: async () => boolean (the same passcode/device gate the rest of the mama routes use)
export async function tipsRoute(req, { isMama, env = process.env, fetchImpl = fetch } = {}) {
  const ok = !!(isMama && (await isMama(req)));
  if (!ok) return json({ locked: true, error: 'the tip ledger is mama-only: unlock with your passcode on this device first' }, 401);
  const key = String(env.STRIPE_TIPS_READ_KEY || '').trim();
  if (!key) return json({ source: 'not_connected', link: TIP_LINK, note: NOT_CONNECTED_NOTE, ...tipLedger([]) });
  try {
    const tips = []; let after = '', pages = 0, more = true;
    while (more && pages < 10) {
      const u = new URL('https://api.stripe.com/v1/checkout/sessions');
      u.searchParams.set('payment_link', TIP_PAYMENT_LINK_ID); u.searchParams.set('limit', '100');
      if (after) u.searchParams.set('starting_after', after);
      const r = await fetchImpl(u, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || `Stripe answered ${r.status}`);
      for (const s of d.data || []) if (s.payment_status === 'paid' && Number.isInteger(s.amount_total)) tips.push({ at: s.created * 1000, amountCents: s.amount_total, currency: s.currency });
      more = !!d.has_more && !!d.data?.length; after = d.data?.at(-1)?.id || ''; pages++;
    }
    return json({ source: 'stripe-live', readAt: new Date().toISOString(), link: TIP_LINK, ...tipLedger(tips) });
  } catch (e) {
    return json({ source: 'stripe-error', link: TIP_LINK, liveError: `live Stripe read failed: ${e.message}`, ...tipLedger([]) });
  }
}
