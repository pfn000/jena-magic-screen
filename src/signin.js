// "Ask mama": Jena's asks for mama only (passcode on this device). A sign-in ask opens a PRIVATE window:
// her own Firefox (same profile) on a hidden screen on her box, streamed only to this page through a one-use token.
// Mama types everything herself; nothing here automates a login, a CAPTCHA or an account. The public page, OBS
// and the public desktop never see the private window (her public desktop shows the lock card meanwhile).
// Other asks (permission for something she wants to do) get Approve / Deny, recorded on her box.
import RFB from '@novnc/novnc';
import qrcode from 'qrcode-generator';

const KEY = 'jena.dmKey';
const key = () => localStorage.getItem(KEY) || '';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (ts) => { if (!ts) return ''; const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`; };
// the same look as the ✎ Correct pill under her chat replies
const PILL = 'margin-left:6px;font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;opacity:.75';
const RECENT_MS = 30 * 60 * 1000;   // other asks show up in chat only while fresh

export const asks = { data: null, error: null, listeners: new Set() };
let seen = new Set();
try { seen = new Set(JSON.parse(localStorage.getItem('jena.asksSeen') || '[]')); } catch {}
const markSeen = (id) => { seen.add(id); localStorage.setItem('jena.asksSeen', JSON.stringify([...seen].slice(-60))); };

async function linkSignin(op, link) {
  try {
    const r = await fetch('/api/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, link }) });
    return await r.json().catch(() => ({ ok: false, summary: `answered ${r.status}` }));
  } catch (e) { return { ok: false, summary: e.message }; }
}
export async function mamaSignin(op, extra = {}, k = key()) {
  try {
    const r = await fetch('/api/mama', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': k }, body: JSON.stringify({ action: 'signin', op, ...extra }) });
    const d = await r.json().catch(() => ({ ok: false, summary: `answered ${r.status}` }));
    if (!r.ok && d.ok === undefined) d.ok = false;
    return d;
  } catch (e) { return { ok: false, summary: e.message }; }
}

export function pendingCount() {
  const d = asks.data;
  if (!d) return 0;
  return (d.pending && d.pending.status === 'pending' ? 1 : 0) + (d.asks || []).filter((a) => !a.answer && Date.now() - a.ts < RECENT_MS).length;
}

let started = false, chatShown = new Set();
export function startAsks({ obs = false } = {}) {
  if (started || obs) return; started = true;
  const tick = async () => {
    if (key()) {
      const d = await mamaSignin('list');
      if (d.ok) { asks.data = d; asks.error = null; onData(d); } else asks.error = d.summary || d.error || 'her box did not answer';
      asks.listeners.forEach((f) => { try { f(); } catch {} });
    }
    setTimeout(tick, document.hidden ? 15000 : 6000);
  };
  tick();
  // the magic link (texted to mama / QR / the card): /?signin=<token> opens the private window straight away, no passcode
  const want = new URLSearchParams(location.search).get('signin');
  if (want && want.length >= 16) setTimeout(() => openSignin({ link: want, label: 'the site' }), 300);
}

function onData(d) {
  const p = d.pending;
  const fresh = [];
  if (p && p.status === 'pending') fresh.push({ id: 'si:' + p.id, kind: 'signin', p, text: `mama can u sign me into ${p.label}? 🥺`, sub: p.reason });
  for (const a of d.asks || []) if (!a.answer && Date.now() - a.ts < RECENT_MS) fresh.push({ id: 'ask:' + a.ts, kind: 'ask', a, text: a.text });
  for (const f of fresh) {
    if (!chatShown.has(f.id)) { chatShown.add(f.id); chatBubble(f); }
    if (!seen.has(f.id)) { markSeen(f.id); toast(f.kind === 'signin' ? `🔑 Jena wants you to sign in to ${f.p.label}` : `🙋 Jena asks: ${f.text.slice(0, 90)}`, f); }
  }
  // asks answered elsewhere (dev panel, phone, timeout): their chat pills turn into the outcome
  document.querySelectorAll('#chat-list li[data-ask]').forEach((li) => {
    const id = li.dataset.ask;
    if (fresh.some((f) => f.id === id)) return;
    const pills = li.querySelector('.ask-pills');
    if (!pills || pills.dataset.done) return;
    let word = 'answered';
    if (id.startsWith('si:')) { const r = (d.requests || []).find((x) => 'si:' + x.id === id); word = r ? (r.status === 'open' ? 'signing in…' : r.status) : 'closed'; if (r && r.status === 'open') return; }
    else { const a = (d.asks || []).find((x) => 'ask:' + x.ts === id); if (a?.answer) word = a.answer === 'approve' ? 'approved ✓' : 'denied ✕'; }
    pills.dataset.done = '1'; pills.innerHTML = `<small style="opacity:.7;margin-left:6px">${esc(word)}</small>`;
  });
}

function pillsFor(f) {
  return f.kind === 'signin'
    ? [['🔑 Sign in', () => openSignin(f.p)], ['✖ Not now', async (b) => { b.textContent = '…'; await mamaSignin('cancel', { id: f.p.id }); }]]
    : [['✅ Approve', (b) => answer(f.a, 'approve', b)], ['✖ Deny', (b) => answer(f.a, 'deny', b)]];
}
async function answer(a, ans, b) {
  if (b) b.textContent = '…';
  const r = await mamaSignin('answer', { ts: a.ts, answer: ans });
  if (!r.ok && b) b.textContent = `✕ ${r.summary || r.error || 'failed'}`;
}

function chatBubble(f) {
  const list = document.getElementById('chat-list');
  if (!list) return;
  list.querySelector('.chat-empty')?.remove();
  const li = document.createElement('li');
  li.className = 'msg from-jena ask-mama';
  li.dataset.ask = f.id;
  li.dataset.time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  li.innerHTML = `<b>Jena</b><span>${esc(f.text)}${f.sub ? `<br><small style="opacity:.7">${esc(f.sub)}</small>` : ''}</span><em class="tag">only you see this</em>`;
  const box = document.createElement('span'); box.className = 'ask-pills';
  for (const [label, fn] of pillsFor(f)) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'msg-correct ask-pill'; b.textContent = label; b.style.cssText = PILL;
    b.onclick = () => fn(b); box.appendChild(b);
  }
  if (f.kind === 'signin' && f.p.link) {
    const q = document.createElement('button'); q.type = 'button'; q.className = 'msg-correct ask-pill'; q.textContent = '🔗 link / QR'; q.style.cssText = PILL;
    q.onclick = () => { if (li.querySelector('.ask-qr')) { li.querySelector('.ask-qr').remove(); return; } const d = document.createElement('div'); d.className = 'ask-qr'; d.style.cssText = 'width:100%;margin-top:6px;font-size:11px;word-break:break-all'; d.innerHTML = `<a href="${esc(f.p.link)}" target="_blank" rel="noopener">${esc(f.p.link)}</a><div style="width:130px;background:#fff;padding:5px;border-radius:8px;margin-top:4px">${qrSvg(f.p.link)}</div>`; li.appendChild(d); };
    box.appendChild(q);
  }
  li.querySelector('span').after(box);
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
}

function toast(text, f) {
  document.getElementById('ask-toast')?.remove();
  const t = document.createElement('div');
  t.id = 'ask-toast';
  t.style.cssText = 'position:fixed;left:50%;top:max(10px,env(safe-area-inset-top));transform:translateX(-50%);z-index:100000;width:min(92vw,460px);box-sizing:border-box;background:#1d1b2e;color:#fff;border:1px solid #b48cff;border-radius:14px;padding:10px 12px;font:14px/1.35 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.45);display:flex;gap:8px;align-items:center';
  t.innerHTML = `<span style="flex:1">${esc(text)}</span>`;
  const go = document.createElement('button');
  go.textContent = f.kind === 'signin' ? 'Open' : 'See';
  go.style.cssText = 'font:600 13px system-ui;padding:6px 12px;border-radius:10px;border:0;background:#b48cff;color:#1d1b2e;cursor:pointer';
  go.onclick = () => { t.remove(); if (f.kind === 'signin') openSignin(f.p); else window.__jenaDev?.showAsks?.(); };
  const x = document.createElement('button'); x.textContent = '✕'; x.style.cssText = 'background:none;border:0;color:#fff;font-size:16px;cursor:pointer';
  x.onclick = () => t.remove();
  t.append(go, x);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 15000);
}

function qrSvg(text) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

// ---------------- dev panel section ----------------
export function renderAsks(edits) {
  const d = asks.data;
  let h = '<h3>🙋 Ask mama</h3>';
  if (!key()) return h + '<p>Only mama sees Jena\'s asks. Passcode: <input id="ask-key" type="password" size="10" autocomplete="off"> <button data-ask-unlock>unlock</button></p>';
  if (!d) return h + `<p>${asks.error ? `<span class="dp-warn">${esc(asks.error)}</span>` : 'reading her asks…'}</p>`;
  const p = d.pending, act = d.active || {};
  if (act.active) h += `<div class="dp-card"><b>🔒 Private sign-in open: ${esc(act.site)}</b><p>closes by itself ${act.until ? 'in ' + Math.max(0, Math.round((act.until - Date.now()) / 60000)) + ' min' : ''}</p><button data-ask-signin="${esc(act.id)}">reopen the window</button> <button data-ask-done="${esc(act.id)}">✓ Done</button></div>`;
  if (p && p.status === 'pending') {
    const link = p.link || '';
    h += `<div class="dp-card ask-card"><b>🔑 Jena wants you to sign in to ${esc(p.label)}</b><p>${esc(p.reason || '')} · ${ago(p.ts)} · expires in ${Math.max(0, Math.round((p.ts + (d.expires_s || 600) * 1000 - Date.now()) / 60000))} min</p>
      <p><button data-ask-signin="${esc(p.id)}" style="font-weight:700">Open →</button> <button data-ask-cancel="${esc(p.id)}">Not now</button></p>
      ${link ? `<p style="word-break:break-all"><small>sign-in link (one use, no passcode): <a href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a></small></p><details><summary>open it on your phone (QR)</summary><div style="width:150px;background:#fff;padding:6px;border-radius:8px;margin-top:6px">${qrSvg(link)}</div><small>scan it: the private window opens right away</small></details>` : ''}</div>`;
  } else if (!act.active) h += '<p>No sign-in ask right now.</p>';
  const other = (d.asks || []).filter((a) => Date.now() - a.ts < 24 * 3600e3);
  const ready = (edits?.data?.proposals || []).filter((x) => x.state === 'ready');
  if (other.length || ready.length) {
    h += '<h4>Other asks</h4>';
    h += ready.map((x) => `<div class="dp-card"><b>✏️ site edit: ${esc(x.title)}</b><p>${esc(x.why || '')} · checks passed</p><button data-edit="merge" data-id="${esc(x.id)}">✅ Approve (merge)</button> <button data-edit="discard" data-id="${esc(x.id)}">✖ Deny</button></div>`).join('');
    h += other.map((a) => `<div class="dp-card"><p style="margin:0">${esc(a.text)}</p><small>${ago(a.ts)}</small><p>${a.answer ? `<b>${a.answer === 'approve' ? 'approved ✓' : 'denied ✕'}</b>` : `<button data-ask-answer="approve" data-ts="${a.ts}">✅ Approve</button> <button data-ask-answer="deny" data-ts="${a.ts}">✖ Deny</button>`}</p></div>`).join('');
  }
  h += `<h4>Ask her to get signed in somewhere</h4><p><input id="ask-site" placeholder="grok.com" size="16"> <button data-ask-new>ask</button></p>`;
  const past = (d.requests || []).filter((r) => r.status !== 'pending' && r.status !== 'open').slice(0, 5);
  if (past.length) h += `<h4>Recent sign-ins</h4><ul>${past.map((r) => `<li>${esc(r.label)} · ${esc(r.status)} · ${ago(r.ended || r.ts)}${r.note ? `<br><small>${esc(r.note)}</small>` : ''}</li>`).join('')}</ul>`;
  if (asks.out) h += `<pre class="dp-pre">${esc(asks.out)}</pre>`;
  return h;
}

export async function handleAskClick(e, rerender) {
  const t = e.target.closest('button');
  if (!t) return false;
  const ds = t.dataset;
  if (ds.askUnlock !== undefined) { const v = document.getElementById('ask-key')?.value.trim(); if (v) { localStorage.setItem(KEY, v); asks.out = 'unlocked on this device'; const d = await mamaSignin('list'); if (d.ok) asks.data = d; else asks.out = d.summary || d.error; } rerender(); return true; }
  const find = (id) => (asks.data?.pending?.id === id ? asks.data.pending : (asks.data?.requests || []).find((r) => r.id === id));
  if (ds.askSignin) { openSignin(find(ds.askSignin) || { id: ds.askSignin, label: asks.data?.active?.site || 'the site' }); return true; }
  if (ds.askCancel) { asks.out = JSON.stringify(await mamaSignin('cancel', { id: ds.askCancel })).slice(0, 300); rerender(); return true; }
  if (ds.askDone) { asks.out = 'closing her private window (Firefox saves the session)…'; rerender(); const r = await mamaSignin('done', { id: ds.askDone }); asks.out = r.ok ? (r.request?.note || 'closed') : (r.summary || r.error); rerender(); return true; }
  if (ds.askAnswer) { const a = (asks.data?.asks || []).find((x) => String(x.ts) === ds.ts); if (a) await answer(a, ds.askAnswer); const d = await mamaSignin('list'); if (d.ok) { asks.data = d; onData(d); } rerender(); return true; }
  if (ds.askNew !== undefined) { const v = document.getElementById('ask-site')?.value.trim() || 'grok.com'; const r = await mamaSignin('request', { site: v, reason: 'mama started it from the dev panel' }); asks.out = r.ok ? `ask added: ${r.request?.label}` : (r.summary || r.error); const d = await mamaSignin('list'); if (d.ok) asks.data = d; rerender(); return true; }
  return false;
}

// ---------------- the private window ----------------
export function openSignin(req) {
  if (!req) return;
  document.getElementById('signin-win')?.remove();
  const w = document.createElement('section');
  w.id = 'signin-win';
  w.style.cssText = 'position:fixed;inset:0;z-index:100001;background:#0e0d16;color:#fff;display:flex;flex-direction:column;font:14px system-ui,sans-serif;height:100dvh';
  const label = esc(req.label || 'the site');
  w.innerHTML = `<header style="display:flex;align-items:center;gap:6px;padding:8px 10px;padding-top:max(8px,env(safe-area-inset-top));background:#1d1b2e;border-bottom:1px solid #b48cff;flex-wrap:wrap">
      <b style="flex:1;min-width:150px">🔒 Sign Jena in to ${label}</b><span class="si-st" style="font-size:12px;opacity:.8">opening…</span>
      <button class="si-kb" hidden style="padding:6px 9px;border-radius:9px;border:1px solid #fff;background:none;color:#fff">⌨️</button>
      <button class="si-done" hidden style="padding:6px 12px;border-radius:9px;border:0;background:#38c172;color:#06200f;font-weight:700">✓ Done</button>
      <button class="si-x" style="padding:6px 9px;border-radius:9px;border:1px solid #fff;background:none;color:#fff">✕</button></header>
    <form class="si-pass" style="margin:auto;max-width:330px;padding:20px;text-align:center"><p>This opens Jena's own browser on a <b>private screen</b> only you can see. Her public desktop shows a lock card meanwhile. You type everything yourself; nothing is saved but her browser session.</p>
      <input type="password" autocomplete="off" placeholder="passcode" style="font-size:16px;padding:10px;border-radius:10px;border:1px solid #888;width:100%;box-sizing:border-box">
      <button style="margin-top:10px;width:100%;padding:11px;border-radius:10px;border:0;background:#b48cff;color:#1d1b2e;font:700 15px system-ui">Open ${label}</button><p class="si-err" style="color:#ff8a8a"></p></form>
    <div class="si-screen" hidden style="flex:1;min-height:0;background:#000;touch-action:none"></div>
    <input class="si-kbin" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" style="position:absolute;left:-9999px;top:0;opacity:0;width:1px;height:1px">`;
  document.body.appendChild(w);
  const st = w.querySelector('.si-st'), form = w.querySelector('.si-pass'), screen = w.querySelector('.si-screen');
  const kbBtn = w.querySelector('.si-kb'), doneBtn = w.querySelector('.si-done'), kbIn = w.querySelector('.si-kbin');
  let rfb = null, timer = null, until = 0;
  const close = () => { clearInterval(timer); try { rfb?.disconnect(); } catch {} w.remove(); };
  w.querySelector('.si-x').onclick = close;   // the window on her box keeps running until Done or 10 min; reopen from the card
  const call = (op, pass) => (req.link ? linkSignin(op, req.link) : mamaSignin(op, { id: req.id }, pass || key()));
  const go = async (pass) => {
    form.querySelector('button').disabled = true; st.textContent = 'opening…';
    const d = await call('start', pass);
    if (!d.ok) {
      form.querySelector('button').disabled = false; st.textContent = '';
      form.querySelector('.si-err').textContent = d.summary || d.error || 'could not open';
      if (req.link) { form.querySelector('input').remove(); form.querySelector('button').remove(); }
      else { form.querySelector('input').hidden = false; form.querySelector('button').hidden = false; form.querySelector('input').focus(); }
      return;
    }
    if (d.label) w.querySelector('header b').textContent = `🔒 Sign Jena in to ${d.label}`;
    form.remove(); screen.hidden = false; kbBtn.hidden = false; doneBtn.hidden = false;
    until = d.until || Date.now() + 600000;
    rfb = new RFB(screen, d.ws, { shared: true, wsProtocols: [d.protocol, 'binary'] });
    rfb.viewOnly = false; rfb.scaleViewport = true; rfb.focusOnClick = true; rfb.clipViewport = false;
    rfb.addEventListener('connect', () => { st.textContent = 'connected'; });
    rfb.addEventListener('disconnect', (ev) => { st.textContent = ev.detail?.clean ? 'closed' : 'connection dropped: tap ✕ and Open again'; });
    timer = setInterval(() => { const s = Math.max(0, Math.round((until - Date.now()) / 1000)); if (st.textContent.startsWith('connected') || st.textContent.includes('left')) st.textContent = `connected · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`; if (!s) close(); }, 1000);
  };
  form.onsubmit = (e) => { e.preventDefault(); const pass = form.querySelector('input').value.trim(); if (pass) go(pass); };
  if (req.link || key()) { form.querySelector('p').textContent = 'Opening Jena\'s browser on a private screen only you can see…'; form.querySelector('input').hidden = true; form.querySelector('button').hidden = true; go(); }
  else form.querySelector('input').focus();
  // phone keyboard: a hidden input forwards what mama types as key presses (never stored anywhere)
  kbBtn.onclick = () => { kbIn.focus(); };
  const sendChar = (ch) => { const c = ch.codePointAt(0); rfb?.sendKey(c < 256 ? c : 0x01000000 + c, null); };
  kbIn.addEventListener('beforeinput', (e) => {
    if (!rfb) return;
    e.preventDefault();
    if (e.inputType === 'deleteContentBackward') rfb.sendKey(0xff08, 'Backspace');
    else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') rfb.sendKey(0xff0d, 'Enter');
    else { const txt = e.data ?? e.dataTransfer?.getData('text/plain') ?? ''; for (const ch of txt) sendChar(ch); }
  });
  kbIn.addEventListener('keydown', (e) => { if (!rfb) return; const m = { Enter: [0xff0d, 'Enter'], Tab: [0xff09, 'Tab'], Backspace: [0xff08, 'Backspace'] }[e.key]; if (m && e.isComposing === false && e.inputType === undefined && e.key !== 'Backspace') { e.preventDefault(); rfb.sendKey(m[0], m[1]); } });
  doneBtn.onclick = async () => {
    doneBtn.disabled = true; st.textContent = 'saving her session (closing Firefox)…';
    try { rfb?.disconnect(); } catch {}
    const r = await call('done');
    st.textContent = r.ok ? 'done ✓' : (r.summary || r.error || 'failed');
    screen.innerHTML = `<p style="padding:20px;color:#fff">${r.ok ? '✓ Closed. Her browser saved the session and went back to her desktop.<br><small>' + esc(r.request?.note || '') + '</small>' : esc(r.summary || r.error || 'failed')}</p>`;
    clearInterval(timer); setTimeout(close, 6000);
  };
}
