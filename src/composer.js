// The chat composer (frosted card): ⊕ sends Jena a file (the same picker as the 🎁 button), 🌐 asks her to look
// the message up on the web, 🎤 is the voice button (mic.js), ↑ sends. No suggestion chips. Hidden in ?obs=1.
const $ = (s) => document.querySelector(s);
const form = $('#talk'), web = $('#cmp-web');
$('#cmp-attach')?.addEventListener('click', () => { const g = $('#gift'); if (g) g.click(); else $('#file-input')?.click(); });
web?.addEventListener('click', () => { const on = web.getAttribute('aria-pressed') !== 'true'; web.setAttribute('aria-pressed', String(on)); web.classList.toggle('on', on); $('#talk-input')?.focus(); });
// runs before the chat's own submit handler (capture on the document): 🌐 on = "look this up on the web: …"
document.addEventListener('submit', (e) => {
  if (e.target !== form || web?.getAttribute('aria-pressed') !== 'true') return;
  const i = $('#talk-input'); const v = (i?.value || '').trim();
  if (v && !/^look (this|it) up/i.test(v)) i.value = `look this up on the web: ${v}`.slice(0, 300);
  web.setAttribute('aria-pressed', 'false'); web.classList.remove('on');
}, true);
