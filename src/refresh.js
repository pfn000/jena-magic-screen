// Seamless auto-refresh: when a newer version of the site is live, wait for a quiet moment (nobody typing,
// private drawer + dev panel closed, nothing queued, Jena not mid-sentence), save what's on screen (chat,
// thought chain, scroll), reload, and put it all back. No interruption, no lost messages.
const KEY = 'jena.softReload';
export function softRefresh({ obs = false } = {}) {
  restore(obs);
  if (typeof __COMMIT__ === 'undefined' || !__COMMIT__) return; // local builds don't know their commit
  let newer = null;
  const quiet = () => {
    const a = document.activeElement;
    if (a && /INPUT|TEXTAREA/.test(a.tagName) && a.value) return false;
    if ([...document.querySelectorAll('input')].some((i) => i.type !== 'file' && i.type !== 'password' && i.value)) return false;
    if (document.querySelector('#dm-drawer.open, .drawer.open')) return false;
    if (document.getElementById('devpanel') && !document.getElementById('devpanel').hidden) return false;
    if (document.getElementById('takeover')) return false;
    try { if (JSON.parse(localStorage.getItem('jena.queue') || '[]').length) return false; } catch {}
    const bubble = document.querySelector('.speech, #speech, .bubble.show');
    if (bubble && bubble.offsetParent && bubble.textContent.trim()) return false;
    if (document.querySelector('#thoughts .run:not(.is-done):not(.self):not(.desk)')) return false; // she's mid-thought
    return true;
  };
  const check = async () => {
    const c = await fetch('/api/config', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
    const live = c?.build?.commit;
    if (live && live !== __COMMIT__) newer = live;
  };
  setInterval(check, 60000);
  setTimeout(check, 20000);
  let calm = 0;
  setInterval(() => {
    if (!newer) return;
    calm = quiet() ? calm + 1 : 0;
    if (calm >= (document.hidden ? 1 : 8)) save(newer); // ~8 s of calm while watched, right away if the tab is hidden
  }, 1000);
  window.__jenaRefresh = { get pending() { return newer; }, quiet };
}

function save(to) {
  const g = (s) => document.querySelector(s);
  const snap = { at: Date.now(), to, chat: g('#chat-list')?.innerHTML, thoughts: g('#thoughts .thought-list')?.innerHTML,
    chatScroll: g('#chat-list')?.scrollTop, y: window.scrollY };
  try { sessionStorage.setItem(KEY, JSON.stringify(snap)); } catch {}
  location.reload();
}

function restore(obs) {
  let s = null;
  try { s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); sessionStorage.removeItem(KEY); } catch {}
  if (!s || Date.now() - s.at > 120000) return;
  const put = () => {
    const chat = document.querySelector('#chat-list'), th = document.querySelector('#thoughts .thought-list');
    if (chat && s.chat) { chat.innerHTML = s.chat; chat.scrollTop = s.chatScroll || chat.scrollHeight; }
    if (th && s.thoughts && !th.querySelector('.run')) th.innerHTML = s.thoughts;
    window.scrollTo(0, s.y || 0);
    if (!obs) {
      const t = document.createElement('div');
      t.id = 'soft-toast'; t.textContent = `updated to the newest version (${String(s.to).slice(0, 7)}) · nothing lost`;
      document.body.appendChild(t); setTimeout(() => t.remove(), 4000);
    }
  };
  setTimeout(put, 300);
}
