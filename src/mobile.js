// Phone layout (≤480 px): an app shell. Top bar, Jena's stage, one panel at a time, bottom tab bar.
// It only rearranges existing elements (no second copy of anything) and puts them all back when the screen
// gets wider, so the desktop layout and OBS (?obs=1) stay exactly as they were.
const MQ = matchMedia('(max-width: 480px)');
const TABS = [
  { id: 'chat', label: 'Chat', icon: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z"/>' },
  { id: 'thoughts', label: 'Thoughts', icon: '<path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V17h5.2v-1.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/><path d="M9.6 20h4.8"/>' },
  { id: 'desktop', label: 'Desktop', icon: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>' },
  { id: 'body', label: 'Body', icon: '<circle cx="12" cy="4.8" r="2"/><path d="M5 9.5l7-1 7 1M12 8.5v6.5M12 15l-3.5 6M12 15l3.5 6"/>' },
];
const svg = (p) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const $ = (s) => document.querySelector(s);

export function mobileShell({ obs = false, send } = {}) {
  if (obs) return;
  let on = false, top, bar, bodyPanel, homes = [], badgeObs, listObs, feedObs, feedT;
  let tab = sessionStorage.getItem('jena.tab') || 'chat';

  function move(el, into, where = 'append') {
    if (!el || !into) return;
    const mark = document.createComment('home:' + (el.id || el.className));
    el.before(mark); homes.push([el, mark]);
    where === 'prepend' ? into.prepend(el) : into.append(el);
  }

  function setTab(t, user) {
    tab = t; sessionStorage.setItem('jena.tab', t);
    document.body.dataset.tab = t;
    bar?.querySelectorAll('button').forEach((b) => { const a = b.dataset.tab === t; b.classList.toggle('on', a); b.setAttribute('aria-selected', String(a)); if (a) b.classList.remove('has-new'); });
    if (t === 'chat') { const l = $('#chat-list'); if (l) l.scrollTop = l.scrollHeight; }
    if (t === 'thoughts') { const l = $('#thoughts .thought-list'); if (l) l.scrollTop = l.scrollHeight; }
    if (user) window.dispatchEvent(new Event('resize'));   // the desktop canvas re-fits to its now-visible panel
  }

  function enable() {
    if (on) return; on = true;
    document.body.classList.add('m-app');
    // top bar: who she is + whether her brain is answering, voice + private buttons on the right
    top = document.createElement('header');
    top.id = 'm-top';
    top.innerHTML = `<div class="m-id"><span class="m-disc" aria-hidden="true">J</span><div class="m-name"><b>Jena</b><span class="m-status"><i></i><span>checking…</span></span></div></div><div class="m-actions"></div>`;
    document.body.prepend(top);
    move($('#voice-btn'), top.querySelector('.m-actions'));
    move($('#dm-toggle'), top.querySelector('.m-actions'));
    // her BODY / FACE self-views get their own tab instead of covering the stage
    bodyPanel = document.createElement('section');
    bodyPanel.id = 'body-panel'; bodyPanel.className = 'panel';
    bodyPanel.setAttribute('aria-label', 'What Jena senses of her body');
    bodyPanel.innerHTML = '<header class="panel-head"><h2>Her body</h2><span class="chip">live self-view</span></header><div class="m-body-wrap"></div><p class="m-cap">What Jena sees and feels of herself right now: her skeleton from the angle she picks, her face, and the raw numbers her body reports.</p>';
    $('#stage').append(bodyPanel);
    move($('#self-eye'), bodyPanel.querySelector('.m-body-wrap'));
    // 📎 joins the composer, the way chat apps do it
    move($('#gift'), $('#talk'), 'prepend');
    // tab bar
    bar = document.createElement('nav');
    bar.id = 'm-tabs'; bar.setAttribute('role', 'tablist'); bar.setAttribute('aria-label', 'Sections');
    bar.innerHTML = TABS.map((t) => `<button type="button" role="tab" data-tab="${t.id}">${svg(t.icon)}<span>${t.label}</span></button>`).join('');
    bar.onclick = (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab, true); };
    document.body.append(bar);
    // desktop caption
    const dk = $('#desktop .desk-body');
    if (dk && !$('#desktop .m-cap')) { const p = document.createElement('p'); p.className = 'm-cap'; p.textContent = "Jena's own computer, live. She browses, codes and writes her thoughts.txt here by herself. View only."; dk.after(p); }
    // under her screen: the latest things her desktop did + her thoughts.txt lines (the same ones in the thought chain)
    const feedH = document.createElement('h3'); feedH.className = 'm-feed-h'; feedH.textContent = 'Latest from her desktop';
    const feed = document.createElement('ol'); feed.className = 'm-feed';
    $('#desktop').append(feedH, feed);
    const fill = () => {
      const steps = [...document.querySelectorAll('#thoughts .run.desk .step, #thoughts .run.note .step')].slice(-6).reverse();
      feed.innerHTML = '';
      for (const s of steps) { const li = document.createElement('li'); li.className = s.classList.contains('k-note') ? 'note' : ''; li.innerHTML = s.innerHTML; feed.append(li); }
    };
    fill(); feedObs = new MutationObserver(() => { clearTimeout(feedT); feedT = setTimeout(fill, 300); });
    feedObs.observe($('#thoughts .thought-list'), { childList: true, subtree: true });
    // suggestion chips in the empty chat
    addChips();
    // brain status mirrors the thought chain's badge
    const badge = $('#thoughts .brain-badge');
    const paint = () => { const s = top.querySelector('.m-status'); const live = badge.classList.contains('is-live'); s.classList.toggle('live', live); s.querySelector('span').textContent = live ? `online · ${badge.textContent.replace(/ online$/, '')}` : badge.textContent; };
    if (badge) { paint(); badgeObs = new MutationObserver(paint); badgeObs.observe(badge, { childList: true, characterData: true, subtree: true, attributes: true }); }
    // a dot on Chat / Thoughts when something new lands there while you're elsewhere
    listObs = new MutationObserver((muts) => {
      for (const m of muts) {
        const id = m.target.closest('#chat') ? 'chat' : m.target.closest('#thoughts') ? 'thoughts' : null;
        if (id && id !== tab && m.addedNodes.length) bar.querySelector(`[data-tab="${id}"]`)?.classList.add('has-new');
      }
    });
    [$('#chat-list'), $('#thoughts .thought-list')].forEach((l) => l && listObs.observe(l, { childList: true, subtree: true }));
    setTab(tab);
  }

  function addChips() {
    const empty = $('#chat-list .chat-empty');
    if (!empty || empty.querySelector('.m-chips')) return;
    const box = document.createElement('div'); box.className = 'm-chips';
    for (const q of ['what are you doing rn?', 'show me your desktop', 'learn the cha cha slide']) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = q;
      b.onclick = () => { const i = $('#talk-input'); i.value = q; $('#talk').requestSubmit(); };
      box.append(b);
    }
    empty.append(box);
  }

  function disable() {
    if (!on) return; on = false;
    for (const [el, mark] of homes.reverse()) { mark.replaceWith(el); }
    homes = [];
    top?.remove(); bar?.remove(); bodyPanel?.remove(); $('#desktop .m-cap')?.remove(); $('#desktop .m-feed-h')?.remove(); $('#desktop .m-feed')?.remove(); feedObs?.disconnect(); $('#chat-list .m-chips')?.remove();
    badgeObs?.disconnect(); listObs?.disconnect();
    document.body.classList.remove('m-app'); delete document.body.dataset.tab;
  }

  const apply = () => (MQ.matches ? enable() : disable());
  MQ.addEventListener?.('change', apply);
  apply();
  return { setTab: (t) => setTab(t, true) };
}
