// Snapshot of Jena's tips, read by Tab from Saidie's connected Stripe account (read-only) and committed here.
// Used by /api/tips only when the site has no live Stripe read key (STRIPE_TIPS_READ_KEY) set on Vercel.
// Only PAID checkout sessions of the tip payment link count as tips; open/unpaid/expired sessions never do.
export const TIPS_SNAPSHOT = {
  syncedAt: '2026-10-15T01:43:09Z',
  paymentLink: 'plink_1UQTnJQpErPBNMzr6qq5xPpg',
  checkoutSessionsSeen: 3,
  tips: [],
};
