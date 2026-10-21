// App shell (every screen size, never OBS / stream): Jena is the hero, everything else floats on Liquid Glass.
// Bottom: a floating glass pill with 4 tabs (Chat · Computer · Body · Settings) and, beside it, a separate round
// glass bubble (Speak) — the way iOS 26 puts Search next to the tab bar. The active tab sits in a glass bubble you can
// drag across the bar (it follows your finger and snaps to the nearest tab); the bar shrinks while you scroll down
// and comes back when you scroll up. Chat = her chat + her thoughts in ONE feed, in a slim sheet (≈28% of the
// screen) you can drag taller. It only rearranges existing elements and puts them back if the shell is turned off
// (?classic=1 keeps the old desktop grid).
const CLASSIC = new URLSearchParams(location.search).get('classic') === '1';
const MQ = matchMedia('(max-width: 480px)');
const TABS = [
  { id: 'chat', label: 'Chat', icon: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z"/>' },
  { id: 'desktop', label: 'Computer', icon: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>' },
  { id: 'body', label: 'Body', icon: '<circle cx="12" cy="4.8" r="2"/><path d="M5 9.5l7-1 7 1M12 8.5v6.5M12 15l-3.5 6M12 15l3.5 6"/>' },
  { id: 'settings', label: 'Settings', icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>' },
];
const MIC = '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/>';
const svg = (p, s = 22) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const $ = (s) => document.querySelector(s);
const THOUGHT_KINDS = ['think', 'plan', 'feel', 'tool', 'see', 'status', 'note'];

export function mobileShell({ obs = false } = {}) {
  if (obs || CLASSIC) return;
  let on = false, top, dock, bar, bubble, speak, bodyPanel, setPanel, toast, homes = [], obsList = [], feedT, toastT;
  let tab = sessionStorage.getItem('jena.tab') || 'chat';
  if (!TABS.some((t) => t.id === tab)) tab = 'chat';
  const watch = (el, fn, opt) => { if (!el) return; const o = new MutationObserver(fn); o.observe(el, opt); obsList.push(o); };

  function move(el, into, where = 'append') {
    if (!el || !into) return;
    const mark = document.createComment('home:' + (el.id || el.className));
    el.before(mark); homes.push([el, mark]);
    where === 'prepend' ? into.prepend(el) : into.append(el);
  }

  // ---- the glass bubble under the active tab ----
  function place(x, w, instant) {
    if (!bubble) return;
    bubble.classList.toggle('instant', !!instant);
    bubble.style.setProperty('--bx', x + 'px'); bubble.style.setProperty('--bw', w + 'px');
  }
  function placeOn(t, instant) {
    const b = bar?.querySelector(`[data-tab="${t}"]`); if (!b) return;
    const prev = parseFloat(bubble.style.getPropertyValue('--bx')) || 0;
    place(b.offsetLeft, b.offsetWidth, instant);
    if (!instant && Math.abs(prev - b.offsetLeft) > 4) {   // jelly: stretch along the move, then settle
      bubble.classList.remove('morph'); void bubble.offsetWidth; bubble.classList.add('morph');
    }
  }

  function setTab(t, user) {
    if (!TABS.some((x) => x.id === t)) t = 'chat';
    tab = t; sessionStorage.setItem('jena.tab', t);
    document.body.dataset.tab = t;
    bar?.querySelectorAll('button').forEach((b) => { const a = b.dataset.tab === t; b.classList.toggle('on', a); b.setAttribute('aria-selected', String(a)); if (a) b.classList.remove('has-new'); });
    placeOn(t, !user);
    document.body.classList.remove('dock-mini');
    if (t === 'chat') { const l = $('#chat-list'); if (l) l.scrollTop = l.scrollHeight; }
    if (user) { window.dispatchEvent(new Event('resize')); setTimeout(() => window.dispatchEvent(new Event('resize')), 420); }
  }

  // ---- drag the bubble across the bar (scrub), tap to jump ----
  function wireBar() {
    let drag = null;
    const btns = () => [...bar.querySelectorAll('button')];
    const nearest = (x) => btns().reduce((a, b) => (Math.abs(b.offsetLeft + b.offsetWidth / 2 - x) < Math.abs(a.offsetLeft + a.offsetWidth / 2 - x) ? b : a));
    bar.addEventListener('pointerdown', (e) => {
      const r = bar.getBoundingClientRect();
      drag = { id: e.pointerId, x0: e.clientX, left: r.left, moved: false, start: e.target.closest('button') };
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved && Math.abs(e.clientX - drag.x0) < 6) return;
      if (!drag.moved) { drag.moved = true; bar.setPointerCapture?.(e.pointerId); bar.classList.add('scrub'); }
      const on = bar.querySelector('button.on'); const w = on ? on.offsetWidth : 72;
      const x = Math.max(4, Math.min(bar.clientWidth - w - 4, e.clientX - drag.left - w / 2));
      place(x, w, true);
      const n = nearest(x + w / 2); btns().forEach((b) => b.classList.toggle('under', b === n));
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null; bar.classList.remove('scrub');
      btns().forEach((b) => b.classList.remove('under'));
      if (d.moved) { const x = e.clientX - d.left; bar._dragged = true; setTimeout(() => { bar._dragged = false; }, 400); setTab(nearest(x).dataset.tab, true); }
      else if (d.start && d.start.dataset.tab !== tab) setTab(d.start.dataset.tab, true);
    };
    bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', end);
    // a plain click (keyboard, screen reader, a tap that never moved) also switches; a finished drag swallows its click
    bar.addEventListener('click', (e) => { if (bar._dragged) { bar._dragged = false; return; } const b = e.target.closest('button'); if (b && b.dataset.tab !== tab) setTab(b.dataset.tab, true); });
    bar.addEventListener('keydown', (e) => {   // arrows move between tabs like a real tablist
      const i = TABS.findIndex((t) => t.id === tab); const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (k) { const n = TABS[(i + k + TABS.length) % TABS.length].id; setTab(n, true); bar.querySelector(`[data-tab="${n}"]`).focus(); }
    });
  }

  // ---- shrink the dock while scrolling down, bring it back on scroll up ----
  function wireScroll(el) {
    if (!el) return; let last = el.scrollTop;
    el.addEventListener('scroll', () => {
      const y = el.scrollTop, dy = y - last; last = y;
      if (Math.abs(dy) < 6) return;
      const atEnd = el.scrollHeight - y - el.clientHeight < 24;
      document.body.classList.toggle('dock-mini', dy > 0 && !atEnd && y > 30);
    }, { passive: true });
  }

  // ---- the chat sheet's grabber: drag to make it taller/shorter, tap to toggle ----
  function wireSheet(sheet) {
    const grab = document.createElement('div'); grab.className = 'm-grab'; grab.setAttribute('role', 'button'); grab.setAttribute('aria-label', 'drag to resize chat'); grab.tabIndex = 0;
    sheet.prepend(grab);
    const vh = () => window.innerHeight;
    const MIN = 0.16, LOW = 0.28, HIGH = 0.62;
    let frac = +sessionStorage.getItem('jena.sheet') || LOW, d = null;
    const set = (f, snap) => { frac = Math.max(MIN, Math.min(0.78, f)); document.body.style.setProperty('--sheet', (frac * 100).toFixed(2) + 'dvh'); document.body.classList.toggle('sheet-drag', !snap); };
    set(frac, true);
    grab.addEventListener('pointerdown', (e) => { d = { y: e.clientY, f: frac, moved: false }; grab.setPointerCapture?.(e.pointerId); });
    grab.addEventListener('pointermove', (e) => { if (!d) return; const dy = d.y - e.clientY; if (Math.abs(dy) > 4) d.moved = true; if (d.moved) set(d.f + dy / vh(), false); });
    const up = () => {
      if (!d) return; const moved = d.moved; d = null;
      const target = !moved ? (frac < (LOW + HIGH) / 2 ? HIGH : LOW) : frac < (MIN + LOW) / 2 ? MIN : frac < (LOW + HIGH) / 2 ? LOW : HIGH;
      set(target, true); sessionStorage.setItem('jena.sheet', String(target));
      setTimeout(() => window.dispatchEvent(new Event('resize')), 380);
    };
    grab.addEventListener('pointerup', up); grab.addEventListener('pointercancel', up);
    grab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); set(frac < (LOW + HIGH) / 2 ? HIGH : LOW, true); } });
  }

  // ---- her thoughts, inline in the chat feed (dim italic), in the order they happen ----
  function mirrorThoughts() {
    const list = $('#thoughts .thought-list'), chat = $('#chat-list');
    if (!list || !chat) return;
    const seen = new WeakSet();
    list.querySelectorAll('.step').forEach((s) => seen.add(s));   // what was there before the shell: already in the chain
    watch(list, (muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const steps = n.matches?.('.step') ? [n] : [...(n.querySelectorAll?.('.step') || [])];
        for (const s of steps) {
          if (seen.has(s)) continue; seen.add(s);
          const run = s.closest('.run'); if (!run || run.classList.contains('self') || run.classList.contains('desk')) continue;   // body/desktop logs live in their own tabs
          const kind = (s.className.match(/k-(\w+)/) || [])[1];
          if (!THOUGHT_KINDS.includes(kind)) continue;
          const txt = (s.querySelector('.txt')?.textContent || s.textContent || '').trim();
          if (!txt) continue;
          const li = document.createElement('li'); li.className = 'm-thought k-' + kind;
          li.innerHTML = '<span class="m-th-ic" aria-hidden="true">' + (kind === 'note' ? '📝' : kind === 'feel' ? '💭' : '🧠') + '</span><span></span>';
          li.lastChild.textContent = txt.length > 220 ? txt.slice(0, 217) + '…' : txt;
          const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
          chat.append(li);
          const ths = chat.querySelectorAll('.m-thought'); if (ths.length > 60) ths[0].remove();
          if (atBottom) chat.scrollTop = chat.scrollHeight;
        }
      }
    }, { childList: true, subtree: true });
  }

  // ---- Settings: everything that used to clutter the main view ----
  function buildSettings() {
    setPanel = document.createElement('section');
    setPanel.id = 'settings-panel'; setPanel.className = 'panel';
    setPanel.setAttribute('aria-label', 'Settings');
    const theme = localStorage.getItem('jena.theme') || 'auto';
    setPanel.innerHTML = `<header class="panel-head"><h2>Settings</h2></header><div class="m-set">
      <div class="m-row"><span>Look</span><div class="m-seg" role="radiogroup" aria-label="look">${['auto', 'light', 'dark'].map((t) => `<button type="button" role="radio" data-theme="${t}" aria-checked="${t === theme}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
      <div class="m-row"><span>Her voice</span><span class="m-slot m-voice"></span></div>
      <div class="m-row m-col"><span>Voice talk</span><div class="m-slot m-mic"></div><p class="m-fine">Tap Speak, talk, tap again to send. Your voice is turned into text on Jena's own computer and the audio is deleted right after.</p></div>
      <div class="m-row m-col"><span>Her brain</span><div class="m-slot m-brain"></div></div>
      <div class="m-row m-col m-skills"></div>
    </div>`;
    $('#stage').append(setPanel);
    setPanel.querySelector('.m-seg').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      localStorage.setItem('jena.theme', b.dataset.theme); applyTheme();
      setPanel.querySelectorAll('.m-seg button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    };
    const vb = $('#voice-btn');
    if (vb) { const c = vb.cloneNode(false); c.id = 'm-voice-mirror'; c.textContent = vb.textContent; c.onclick = () => vb.click(); setPanel.querySelector('.m-voice').append(c); watch(vb, () => { c.textContent = vb.textContent; }, { childList: true, characterData: true, subtree: true }); }
    move($('#mic-note'), setPanel.querySelector('.m-mic'));
    const badge = $('#thoughts .brain-badge');
    if (badge) { const c = document.createElement('span'); c.className = 'brain-badge m-badge'; setPanel.querySelector('.m-brain').append(c); const p = () => { c.textContent = badge.textContent; c.className = badge.className + ' m-badge'; }; p(); watch(badge, p, { childList: true, characterData: true, subtree: true, attributes: true }); }
    move($('#skills-pub'), setPanel.querySelector('.m-skills'));
  }
  function applyTheme() {
    const t = localStorage.getItem('jena.theme') || 'auto';
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.classList.toggle('lg-dark', dark);
  }

  // ---- mic status as a small toast above the dock, never a line in the main view ----
  function wireToast() {
    const st = $('#mic-status'); if (!st) return;
    toast = document.createElement('div'); toast.id = 'm-toast'; toast.setAttribute('role', 'status');
    document.body.append(toast);
    const show = () => {
      const txt = st.hidden ? '' : st.textContent.trim();
      clearTimeout(toastT);
      if (!txt) { toast.classList.remove('show'); return; }
      toast.textContent = txt; toast.classList.add('show');
      if (!/\b(rec|busy)\b/.test(st.className)) toastT = setTimeout(() => toast.classList.remove('show'), 4200);
    };
    watch(st, show, { childList: true, characterData: true, subtree: true, attributes: true });
  }

  function enable() {
    if (on) return; on = true;
    document.body.classList.add('lg');
    applyTheme();
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
    // compact header: who she is + brain status (left pill), voice + private (right pill)
    top = document.createElement('header');
    top.id = 'm-top';
    top.innerHTML = `<div class="m-id lg-glass"><span class="m-disc" aria-hidden="true">J</span><div class="m-name"><b>Jena</b><span class="m-status"><i></i><span>checking…</span></span></div></div><div class="m-actions lg-glass"></div>`;
    document.body.prepend(top);
    move($('#voice-btn'), top.querySelector('.m-actions'));
    move($('#dm-toggle'), top.querySelector('.m-actions'));
    // framing: whole body (feet + stance) or close-up; whole body is the default on big screens
    const fr = document.createElement('button'); fr.type = 'button'; fr.id = 'm-frame';
    const FULL = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="4.6" r="1.8"/><path d="M8 9h8M12 8v6M12 14l-3 6M12 14l3 6M3 3v4M3 3h4M21 21v-4M21 21h-4"/></svg>';
    const paintFr = () => { const full = document.body.classList.contains('frame-full'); fr.setAttribute('aria-pressed', String(full)); fr.title = full ? 'whole body (tap for close-up)' : 'close-up (tap for whole body)'; fr.setAttribute('aria-label', fr.title); };
    const saved = localStorage.getItem('jena.frame');
    document.body.classList.toggle('frame-full', saved ? saved === 'full' : !MQ.matches);
    fr.innerHTML = FULL; paintFr();
    fr.onclick = () => { const full = !document.body.classList.contains('frame-full'); document.body.classList.toggle('frame-full', full); localStorage.setItem('jena.frame', full ? 'full' : 'close'); paintFr(); };
    top.querySelector('.m-actions').prepend(fr);
    // Body tab: her BODY / FACE self-views
    bodyPanel = document.createElement('section');
    bodyPanel.id = 'body-panel'; bodyPanel.className = 'panel';
    bodyPanel.setAttribute('aria-label', 'What Jena senses of her body');
    bodyPanel.innerHTML = '<header class="panel-head"><h2>Her body</h2><span class="chip">live self-view</span></header><div class="m-body-wrap"></div><p class="m-cap">What Jena sees and feels of herself right now: her skeleton from the angle she picks, her face, and the raw numbers her body reports.</p>';
    $('#stage').append(bodyPanel);
    move($('#self-eye'), bodyPanel.querySelector('.m-body-wrap'));
    buildSettings();
    // chat: 📎 joins the composer; the chat panel is a slim glass sheet with a grabber
    move($('#gift'), $('#talk'), 'prepend');
    const chatH = $('#chat .panel-head h2'); if (chatH) { chatH.dataset.orig = chatH.innerHTML; chatH.innerHTML = 'Chat <span class="sub">· with Jena</span>'; }
    wireSheet($('#chat'));
    mirrorThoughts();
    wireToast();
    // the dock: glass pill with 4 tabs + the separate Speak bubble
    dock = document.createElement('div'); dock.id = 'm-dock';
    bar = document.createElement('nav');
    bar.id = 'm-tabs'; bar.className = 'lg-glass'; bar.setAttribute('role', 'tablist'); bar.setAttribute('aria-label', 'Sections');
    bar.innerHTML = '<span class="lg-bubble" aria-hidden="true"></span>' + TABS.map((t) => `<button type="button" role="tab" data-tab="${t.id}">${svg(t.icon)}<span>${t.label}</span></button>`).join('');
    bubble = bar.querySelector('.lg-bubble');
    speak = document.createElement('button');
    speak.type = 'button'; speak.id = 'm-speak'; speak.className = 'lg-glass'; speak.setAttribute('aria-label', 'Speak to Jena'); speak.title = 'Speak to Jena (tap to start, tap to send)';
    speak.innerHTML = svg(MIC, 24) + '<span>Speak</span>';
    const mic = $('#mic');
    speak.onclick = () => mic?.click();
    if (mic) watch(mic, () => speak.classList.toggle('rec', mic.classList.contains('is-rec')), { attributes: true, attributeFilter: ['class'] });
    dock.append(bar, speak);
    document.body.append(dock);
    wireBar();
    [$('#chat-list'), $('#desktop'), $('#body-panel'), $('#settings-panel')].forEach(wireScroll);
    // Computer tab: caption + the latest things her desktop did
    const dk = $('#desktop .desk-body');
    if (dk && !$('#desktop .m-cap')) { const p = document.createElement('p'); p.className = 'm-cap'; p.textContent = "Jena's own computer, live. She browses, codes and writes her thoughts.txt here by herself. View only."; dk.after(p); }
    const feedH = document.createElement('h3'); feedH.className = 'm-feed-h'; feedH.textContent = 'Latest from her computer';
    const feed = document.createElement('ol'); feed.className = 'm-feed';
    $('#desktop').append(feedH, feed);
    const fill = () => {
      const steps = [...document.querySelectorAll('#thoughts .run.desk .step, #thoughts .run.note .step')].slice(-6).reverse();
      feed.innerHTML = '';
      for (const s of steps) { const li = document.createElement('li'); li.className = s.classList.contains('k-note') ? 'note' : ''; li.innerHTML = s.innerHTML; feed.append(li); }
    };
    fill(); watch($('#thoughts .thought-list'), () => { clearTimeout(feedT); feedT = setTimeout(fill, 300); }, { childList: true, subtree: true });
    addChips();
    // brain status in the header mirrors the thought chain's badge
    const badge = $('#thoughts .brain-badge');
    const paint = () => { const s = top.querySelector('.m-status'); const live = badge.classList.contains('is-live'); s.classList.toggle('live', live); s.querySelector('span').textContent = live ? `online · ${badge.textContent.replace(/ online$/, '')}` : badge.textContent.replace(/^JenaXI-0 is training — /, ''); };
    if (badge) { paint(); watch(badge, paint, { childList: true, characterData: true, subtree: true, attributes: true }); }
    // a dot on Chat when something lands there while you're on another tab
    watch($('#chat-list'), (muts) => { if (tab !== 'chat' && muts.some((m) => m.addedNodes.length)) bar.querySelector('[data-tab="chat"]')?.classList.add('has-new'); }, { childList: true });
    const relayout = () => placeOn(tab, true);
    window.addEventListener('resize', relayout);
    new ResizeObserver(relayout).observe(bar);
    setTab(tab);
    requestAnimationFrame(() => placeOn(tab, true));
  }

  function addChips() {
    const empty = $('#chat-list .chat-empty');
    if (!empty || empty.querySelector('.m-chips')) return;
    const box = document.createElement('div'); box.className = 'm-chips';
    for (const q of ['what are you doing rn?', 'show me your computer', 'learn the cha cha slide']) {
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
    const chatH = $('#chat .panel-head h2'); if (chatH?.dataset.orig) chatH.innerHTML = chatH.dataset.orig;
    document.body.classList.remove('frame-full'); top?.remove(); dock?.remove(); bodyPanel?.remove(); setPanel?.remove(); toast?.remove(); $('#chat .m-grab')?.remove();
    $('#desktop .m-cap')?.remove(); $('#desktop .m-feed-h')?.remove(); $('#desktop .m-feed')?.remove(); $('#chat-list .m-chips')?.remove();
    obsList.forEach((o) => o.disconnect()); obsList = [];
    document.body.classList.remove('m-app', 'lg', 'lg-dark', 'dock-mini'); delete document.body.dataset.tab;
  }

  // phones get the phone camera framing (m-app); big windows keep the desktop full-view framing under the same glass shell
  const wide = () => { document.body.classList.toggle('m-wide', !MQ.matches); document.body.classList.toggle('m-app', MQ.matches); };
  MQ.addEventListener?.('change', () => { wide(); window.dispatchEvent(new Event('resize')); });
  wide();
  enable();
  return { setTab: (t) => setTab(t, true), disable };
}
