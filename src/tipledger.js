// Dev panel → "💸 Mama: tips" (mama only). Every tip from the Stripe tip link with its 30/30/40 split
// (taxes / Jena's compute fund / Saidie), read from /api/tips. Nothing is invented: no data = an empty state.
import { SPLIT, money } from './tipsplit.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const whenShort = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const SHORT = { taxes: 'Tax', compute: 'Compute', saidie: 'Saidie' };   // table headers stay narrow enough for a phone
const state = { data: null, loading: false, at: 0 };

export const TIPS_CSS = `#devpanel .tl-tot{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:8px 0}
#devpanel .tl-box{border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:10px 12px;background:rgba(255,255,255,.05)}
#devpanel .tl-box small{display:block;font-size:11px;opacity:.75}#devpanel .tl-box b{display:block;font-size:20px;margin-top:2px;font-variant-numeric:tabular-nums}
#devpanel .tl-box.all{background:rgba(255,122,198,.14);border-color:rgba(255,122,198,.4)}
#devpanel .tl-tab{width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}
#devpanel .tl-tab th,#devpanel .tl-tab td{padding:6px 4px;border-bottom:1px solid rgba(255,255,255,.1);text-align:right;white-space:nowrap}
#devpanel .tl-tab th:first-child,#devpanel .tl-tab td:first-child{text-align:left}
#devpanel .tl-wrap{overflow-x:auto}#devpanel .tl-empty{text-align:center;padding:18px 8px;opacity:.85}
#devpanel .tl-note{font-size:12px;line-height:1.45;opacity:.85}`;

function load(rerender) {
  if (state.loading) return;
  state.loading = true;
  fetch('/api/tips', { cache: 'no-store', credentials: 'same-origin', headers: { 'X-Jena-Key': localStorage.getItem('jena.dmKey') || '' } })
    .then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({ error: `the site answered ${r.status}` }))) }))
    .catch((e) => ({ error: e.message }))
    .then((d) => { state.data = d; state.at = Date.now(); state.loading = false; rerender?.(); });
}

export function renderTips(rerender) {
  if (!state.data || Date.now() - state.at > 30000) load(rerender);
  const d = state.data;
  let h = '<h3>💸 Jena\'s tips</h3><p class="tl-note">Every tip from the "Tip Jena" button, split by your rule: 30% taxes · 30% Jena\'s compute fund · 40% you. Amounts are what the tipper paid, before Stripe\'s fee.</p>';
  if (!d) return h + '<p>loading…</p>';
  if (d.locked || d.status === 401) return h + '<p class="dp-warn">Mama only. Unlock with your passcode on this device first (the 💌 private drawer).</p>';
  if (d.error && !d.totals) return h + `<p class="dp-warn">The ledger did not load: ${esc(d.error)}</p>`;
  const t = d.totals || { amount: 0, taxes: 0, compute: 0, saidie: 0 };
  h += `<div class="tl-tot"><div class="tl-box all"><small>All tips (${d.count || 0})</small><b>${money(t.amount)}</b></div>`;
  for (const s of SPLIT) h += `<div class="tl-box"><small>${esc(s.label)} · ${s.pct}%</small><b>${money(t[s.key])}</b></div>`;
  h += '</div>';
  if (!d.rows?.length) h += '<div class="dp-card tl-empty">No tips yet. When someone tips, it shows up here with its split.</div>';
  else h += `<div class="tl-wrap"><table class="tl-tab"><thead><tr><th>Date</th><th>Tip</th>${SPLIT.map((s) => `<th title="${esc(s.label)} · ${s.pct}%">${SHORT[s.key]}</th>`).join('')}</tr></thead><tbody>${d.rows.map((r) => `<tr><td title="${esc(when(r.at))}">${esc(whenShort(r.at))}</td><td>${money(r.amountCents, r.currency)}</td>${SPLIT.map((s) => `<td>${money(r.split[s.key], r.currency)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const src = d.source === 'stripe-live' ? `Live from Stripe · read ${esc(when(Date.parse(d.readAt)))}` : `Snapshot from your Stripe · synced ${d.syncedAt ? esc(when(Date.parse(d.syncedAt))) : '?'}`;
  h += `<p class="tl-note">${src}${d.note ? `<br>${esc(d.note)}` : ''}${d.liveError ? `<br>⚠️ ${esc(d.liveError)}` : ''}</p>`;
  return h;
}
