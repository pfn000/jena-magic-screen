// "Tip Jena" button: a small, optional pill beside her name tag (phone: top-right of her stage).
// It only opens Saidie's Stripe payment link in a new tab; no amounts, no nagging, never shown in OBS/stream mode.
import { TIP_LINK } from './tipsplit.mjs';

export function mountTip({ obs = false } = {}) {
  if (obs || document.getElementById('tip-btn')) return null;
  const panel = document.getElementById('avatar-panel');
  if (!panel) return null;
  const a = document.createElement('a');
  a.id = 'tip-btn';
  a.href = TIP_LINK;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = 'Optional tip. Opens a secure Stripe page in a new tab. Tips support Jena and her creator.';
  a.setAttribute('aria-label', 'Tip Jena (opens a secure Stripe page in a new tab)');
  a.innerHTML = '<span class="tip-ic" aria-hidden="true">☕</span><span class="tip-tx">Tip Jena</span>';
  panel.append(a);
  return a;
}
