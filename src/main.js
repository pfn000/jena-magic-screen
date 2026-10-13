import './style.css';
import { loadConfig } from './config.js';
import { Avatar } from './avatar.js';
import { Desktop } from './desktop.js';
import { TwitchChat, clean } from './chat.js';
import { ThoughtChain } from './thoughts.js';
import { think } from './brain.js';
import { Autonomy } from './autonomy.js';
import { Moves, rememberMove } from './moves.js';
import { SelfVision } from './selfvision.js';
import { SelfSense } from './selfstate.js';
import { FacePanel } from './facepanel.js';
import { DevPanel, deployBar } from './devpanel.js';
import { BodyViews, VIEWS } from './bodyviews.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// her replies: no stray leading/trailing spaces (her tokenizer starts words with a space) or invisible chars
const tidy = (s) => String(s ?? '').replace(/^[\s\u2581\u200b\u200c\u200d\ufeff]+|[\s\u2581\u200b\u200c\u200d\ufeff]+$/g, '');
const ORIGIN = Math.random().toString(36).slice(2, 10);
const KEY_STORE = 'jena.dmKey';

const cfg = await loadConfig();
document.body.classList.toggle('obs', cfg.obs);
document.body.classList.toggle('bg-none', cfg.bgNone);
document.body.classList.toggle('no-controls', !cfg.controls || cfg.obs);

// ---------------- avatar ----------------
const status = $('#avatar-status');
const avatar = new Avatar($('#avatar-canvas'), {
  onStatus: (s, p) => {
    status.textContent = s === 'ready' ? '' : `waking Jena up… ${Math.round(p * 100)}%`;
    status.hidden = s === 'ready';
  },
});
(async () => {
  try { await avatar.load(cfg.vrmUrl); }
  catch (e) {
    try { await avatar.load(cfg.vrmFallbackUrl); }
    catch (e2) { status.textContent = `couldn't load her body (${e2.message})`; }
  }
  document.body.classList.add('avatar-ready');
})();

// speech bubble
const bubble = $('#speech');
let bubbleTimer;
function say(text) {
  text = tidy(text);
  if (!text) return;
  const ms = avatar.talkFor(text);
  bubble.textContent = text;
  bubble.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms + 2600);
  if (!twitchLive) addChat({ user: 'Jena', text, cls: 'from-jena' }); // with Twitch on, her own talk lives in the thought chain
}
let twitchLive = false;

// ---------------- thought chain ----------------
const chain = new ThoughtChain($('#thoughts'), { obs: cfg.obs });
chain.setHealth(cfg.apiInfo?.brainHealth || { online: false });
// her brain's health, checked every 15 s; the badge flips to "JenaXI online" by itself
async function pollHealth() {
  if (!cfg.api) return chain.setHealth({ online: false });
  const d = await fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  if (d?.brain) { chain.setHealth(d.brain); window.dispatchEvent(new CustomEvent('jena-health', { detail: d.brain })); }
}
pollHealth();
setInterval(pollHealth, 15000);

// her desktop's own log (the same lines her desktop agent writes on her box) flows into this chain,
// so desktop thoughts = site thoughts. Skills show as "using skill: X". Help requests to mama stay in the dev panel.
let deskSeen = 0;
async function pollDesk() {
  if (!cfg.api || document.hidden) return;
  const d = await fetch('/api/box?what=screen', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  const acts = d?.data?.actions || [];
  if (!deskSeen) { deskSeen = acts.length ? acts[acts.length - 1].ts - 1 : 1; acts.splice(0, Math.max(0, acts.length - 2)); }
  for (const a of acts) {
    if (a.ts <= deskSeen) continue;
    deskSeen = a.ts;
    if (a.kind === 'help') continue;
    chain.desk(a.kind === 'skill' ? 'tool' : 'see', a.text, a.ts);
  }
}
pollDesk();
setInterval(pollDesk, 8000);

// public list of her skills, read live from her box when opened (nothing listed that doesn't run there)
const skillsPub = $('#skills-pub');
if (skillsPub) {
  if (cfg.obs) skillsPub.remove();
  else skillsPub.addEventListener('toggle', async () => {
    if (!skillsPub.open) return;
    const body = skillsPub.querySelector('.skills-pub-body');
    const d = await fetch('/api/skills', { cache: 'no-store' }).then((r) => r.json()).catch((e) => ({ error: e.message }));
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    if (!d.online) { body.textContent = d.error || 'her box is not answering, so her skills cannot be listed right now'; return; }
    body.innerHTML = `<ul>${d.skills.map((s) => `<li><b>${esc(s.name)}</b>${s.status !== 'enabled' ? ` <i>(${esc(s.status)})</i>` : ''} — ${esc(s.description)} <small>${s.runs ? `used ${s.runs}× · ${s.ok} worked` : 'not used yet'}${s.source === 'self-made' ? ' · she made this one' : ''}</small></li>`).join('')}</ul><small>MCP servers on her box: ${esc(d.mcp.join(', ') || 'none')}</small>`;
  });
}

// ---------------- her own body: autonomy + self-vision ----------------
const autonomy = new Autonomy(avatar, { log: (text) => chain.self('body', text) });
// moves she learned by watching videos of real people move (pose-tracked into her own clips, /moves/)
autonomy.moves = new Moves(avatar, { log: (text) => chain.self('body', text), remember: rememberMove, card: (trigger) => chain.start(trigger) });
const params = new URLSearchParams(location.search);
// her self-sense: every bone + every expression read off the live model each frame (window.jena.selfState)
const selfSense = new SelfSense(avatar, {
  log: (text) => chain.self('sense', text),
  readout: params.get('selfview') !== '0' ? $('#self-readout') : null,
  faceReadout: params.get('selfview') !== '0' ? $('#face-readout') : null,
});
if (params.get('selfview') !== '0') new FacePanel(avatar, $('#self-face'));
if (params.get('selfview') !== '0') {
  const view = $('#self-view'), label = $('#self-view-label');
  const startVision = () => (window.__jenaVision = new SelfVision($('#avatar-canvas'), {
    log: (kind, text) => chain.self(kind, text),
    view, label,
    intent: () => avatar.armState(),
    avatar,
    felt: () => ({ left: selfSense.feel.leftArm === 'up' ? 'up' : 'down', right: selfSense.feel.rightArm === 'up' ? 'up' : 'down' }),
  })).start();
  const wait = setInterval(() => { if (avatar.ready) { clearInterval(wait); startVision(); } }, 500);
  // BODY panel angles: front (her self-vision) / back / side / top / below; mama can pick, and so can she
  const bodyViews = new BodyViews(avatar, $('#self-view'), $('#self-view-label'));
  const bar = document.createElement('div'); bar.id = 'body-views';
  bar.innerHTML = VIEWS.map((v) => `<button type="button" data-v="${v}" class="${v === 'front' ? 'on' : ''}">${v}</button>`).join('');
  bar.onclick = (e) => { const v = e.target.dataset?.v; if (v) bodyViews.set(v, 'mama'); };
  $('#self-view')?.after(bar);
  setInterval(() => {
    if (document.hidden || Math.random() > 0.25) return;
    const v = bodyViews.view === 'front' ? VIEWS[1 + Math.floor(Math.random() * 4)] : 'front';
    bodyViews.set(v, 'jena');
    if (v !== 'front') chain.self('sense', `checking myself from the ${v}`);
  }, 20000);
  window.__jenaBodyViews = bodyViews;
  // collapse her POV panels so they don't clutter the page (she keeps seeing herself either way)
  const eye = $('#self-eye');
  if (eye) {
    const btn = document.createElement('button');
    btn.id = 'self-toggle'; btn.type = 'button';
    const KEY = 'jena.selfCollapsed';
    const set = (c) => { document.body.classList.toggle('self-collapsed', c); btn.textContent = c ? '👁 her views' : '✕ hide views'; btn.title = c ? 'show her BODY and FACE self-views' : 'hide her self-views (she still sees herself)'; localStorage.setItem(KEY, c ? '1' : '0'); };
    btn.onclick = () => set(!document.body.classList.contains('self-collapsed'));
    eye.parentElement.appendChild(btn);
    const saved = localStorage.getItem(KEY);
    set(saved == null ? matchMedia('(max-width: 900px)').matches : saved === '1');
  }
} else $('#self-eye')?.remove();

// every brain run on this page, as it really happened (the dev panel reads these)
const runs = [];
function runEvent(e, run, { privateRun = false } = {}) {
  if (run?._dev) run._dev.events.push(e);
  if (e.type === 'meta') { if (typeof e.online === 'boolean') chain.setHealth({ online: e.online }); }
  else if (e.type === 'status') run.step('status', e.text);
  else if (e.type === 'step') run.step(e.kind, e.text);
  else if (e.type === 'mood' || e.type === 'action') autonomy.fromBrain(e);
  else if (e.type === 'say') {
    e = { ...e, text: tidy(e.text) };
    if (!privateRun) autonomy.onSay(e.text);
    if (privateRun) run.step('private', cfg.obs || !e.text ? 'replied privately' : `replied privately: “${e.text}”`);
    else { run.step('say', e.text); say(e.text); }
  }
  else if (e.type === 'done') run.done();
}

let busy = Promise.resolve();
function thinkAbout(input, { broadcast = true, thumb } = {}) {
  const run = chain.start({ ...input, thumb }); // the event itself shows up right away, e.g. "mama: hello"
  run._dev = { at: Date.now(), trigger: { ...input }, events: [] };
  runs.push(run._dev); if (runs.length > 30) runs.shift();
  busy = busy.then(async () => {
    const key = localStorage.getItem(KEY_STORE);
    const src = think(cfg.brainUrl, { ...input, origin: ORIGIN, broadcast }, broadcast ? key : null);
    for await (const e of src) runEvent(e, run);
    run.done();
  }).catch((e) => console.warn('think failed', e));
  return busy.then(() => run._dev);
}

// replay runs that happened on other screens (e.g. mama's phone -> the OBS page)
let since = Date.now();
async function pollEvents() {
  if (!cfg.api) return;
  try {
    const r = await fetch(`/api/events?since=${since}`, { cache: 'no-store' });
    const d = await r.json();
    for (const ev of d.events || []) {
      since = Math.max(since, ev.ts);
      if (ev.origin === ORIGIN || ev.type !== 'thought_run') continue;
      busy = busy.then(async () => {
        const t = ev.trigger || {};
        const run = chain.start(t.private ? { user: t.user || 'mama', private: true, source: 'private' } : t);
        for (const e of ev.events || []) {
          if (e.type === 'step') await new Promise((res) => setTimeout(res, 450));
          runEvent(e, run, { privateRun: !!t.private });
        }
        run.done();
      });
    }
  } catch {}
}
if (cfg.api) setInterval(pollEvents, 4000);

let lastActivity = Date.now();

// ---------------- chat ----------------
const chatList = $('#chat-list');
function addChat({ user, text, color, parts, cls = '', tag = '' }) {
  chatList.querySelector('.chat-empty')?.remove();
  const li = document.createElement('li');
  li.className = `msg ${cls}`;
  li.dataset.time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const body = parts
    ? parts.map((p) => (p.emote ? `<img class="emote" alt="${esc(p.alt)}" src="https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(p.emote)}/default/dark/1.0">` : esc(p.text))).join('')
    : esc(text);
  li.innerHTML = `<b style="${color ? `color:${esc(color)}` : ''}">${esc(user)}</b><span>${body}</span><em class="tag">${esc(tag)}</em>`;
  const atBottom = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 80;
  chatList.appendChild(li);
  while (chatList.children.length > 120) chatList.firstElementChild.remove();
  if (atBottom || cls === 'from-you') chatList.scrollTop = chatList.scrollHeight;
  return li;
}
const chatLabel = $('#chat-channel');
let lastMention = 0;
if (!cfg.twitch) {
  chatLabel.textContent = 'Twitch off';
  chatLabel.dataset.state = 'off';
  $('#chat')?.classList.add('mode-chat');
  if ($('#chat .sub')) $('#chat .sub').textContent = '· with Jena';
  chatList.innerHTML = '<li class="chat-empty"><b>Say hi to Jena 👋</b><span>Twitch is off, so this is a normal chat with her. When a Twitch channel is set (<code>?twitch=name</code> or <code>TWITCH_CHANNEL</code>) this panel switches to Twitch chat and her own talk moves to the thought chain.</span></li>';
} else new TwitchChat({
  channel: cfg.twitch,
  onStatus: (s) => {
    chatLabel.textContent = `#${s.channel}${s.state === 'joined' ? '' : ' · ' + s.state}`;
    chatLabel.dataset.state = s.state;
    twitchLive = s.state === 'joined';
    $('#chat')?.classList.toggle('mode-twitch', twitchLive);
    $('#chat')?.classList.toggle('mode-chat', !twitchLive);
    const sub = $('#chat .sub'); if (sub) sub.textContent = twitchLive ? '· Twitch' : '· with Jena';
  },
  onMessage: (m) => {
    addChat({ user: m.user, text: m.text, color: m.color, parts: m.parts });
    autonomy.onChat();
    if (/\bjenn?a\b/i.test(m.text) && Date.now() - lastMention > 15000) {
      lastMention = Date.now(); lastActivity = Date.now();
      autonomy.onMention(m.user);
      thinkAbout({ message: m.text, source: 'twitch', user: m.user, channel: m.channel }, { broadcast: false });
    }
  },
});

// ---------------- queued messages: sent while her brain is offline, answered when she's back ----------------
const QUEUE = 'jena.queue';
const loadQ = () => { try { return JSON.parse(localStorage.getItem(QUEUE) || '[]'); } catch { return []; } };
const saveQ = (q) => localStorage.setItem(QUEUE, JSON.stringify(q.slice(-30)));
let brainOnline = !!cfg.apiInfo?.brainHealth?.online;
const queuedEls = new Map();
for (const q of loadQ()) queuedEls.set(q.id, addChat({ user: q.user, text: clean(q.text), cls: 'from-you queued', tag: 'Queued' }));
function send(text, who, el) {
  lastActivity = Date.now();
  if (!brainOnline) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    saveQ([...loadQ(), { id, text, user: who, at: Date.now() }]);
    el.classList.add('queued'); el.querySelector('.tag').textContent = 'Queued';
    queuedEls.set(id, el);
    chain.self('status', `brain offline, so I saved ${who}'s message as Queued. I'll answer it when I'm back`);
    return;
  }
  el.querySelector('.tag').textContent = '';
  autonomy.onMessage(who, text);
  thinkAbout({ message: text, source: 'stage', user: who }).then((r) => {
    // her brain dropped out mid-message: keep it as Queued instead of losing it
    if (r && !r.events.some((x) => x.type === 'say') && r.events.some((x) => x.type === 'status' && /offline|not reachable|unreachable/i.test(x.text))) {
      brainOnline = false; send(text, who, el);
    }
  });
}
async function flushQueue() {
  const q = loadQ();
  if (!q.length || !brainOnline) return;
  saveQ([]);
  for (const m of q) {
    const el = queuedEls.get(m.id);
    if (el) { el.classList.remove('queued'); el.querySelector('.tag').textContent = `answered later (sent ${new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})`; }
    await thinkAbout({ message: m.text, source: 'stage', user: m.user });
  }
}
window.addEventListener('jena-health', (e) => { const was = brainOnline; brainOnline = !!e.detail.online; if (brainOnline && !was) flushQueue(); });
setTimeout(flushQueue, 3000);

$('#talk').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#talk-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const who = localStorage.getItem(KEY_STORE) ? 'mama' : 'guest';
  const el = twitchLive ? null : addChat({ user: who, text: clean(text), cls: 'from-you' });
  if (twitchLive) { chain.self('status', `${who} (off-Twitch): ${text.slice(0, 120)}`); thinkAbout({ message: text, source: 'stage', user: who }); return; }
  send(text, who, el);
});

// ---------------- private DM drawer (never on stream) ----------------
const drawer = $('#dm');
const dmLog = $('#dm-log');
let pendingFile = null;
function openDM(open = true) {
  drawer.classList.toggle('open', open);
  drawer.setAttribute('aria-hidden', String(!open));
  if (open) refreshDM();
}
$('#dm-toggle').addEventListener('click', () => openDM(!drawer.classList.contains('open')));
$('#dm-close').addEventListener('click', () => openDM(false));
function renderLock() {
  const has = !!localStorage.getItem(KEY_STORE);
  drawer.classList.toggle('locked', !has);
}
$('#dm-unlock').addEventListener('submit', async (e) => {
  e.preventDefault();
  const k = $('#dm-key').value.trim();
  if (!k) return;
  const r = await fetch('/api/dm', { headers: { 'X-Jena-Key': k } }).catch(() => null);
  if (!r || !r.ok) {
    const d = r ? await r.json().catch(() => ({})) : {};
    $('#dm-err').textContent = d.error || "couldn't reach Jena's API";
    return;
  }
  localStorage.setItem(KEY_STORE, k);
  $('#dm-err').textContent = '';
  renderLock();
  refreshDM();
  if (pendingFile) { const f = pendingFile; pendingFile = null; uploadFile(f); }
});
$('#dm-lock').addEventListener('click', () => { localStorage.removeItem(KEY_STORE); renderLock(); dmLog.innerHTML = ''; });

function renderDM(log) {
  dmLog.innerHTML = log.map((m) => {
    const who = m.from === 'jena' ? 'jena' : m.from === 'system' ? 'system' : 'mama';
    const time = new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    let body = esc(m.from === 'jena' ? tidy(m.text) : m.text || '');
    if (m.kind === 'file') {
      const img = /^image\//.test(m.type || '') ? `<img src="${esc(m.url)}" alt="">` : '';
      body = `${img}<a href="${esc(m.url)}" target="_blank" rel="noopener">📎 ${esc(m.name)}</a><small>${Math.round((m.size || 0) / 1024)} KB · ${esc(m.store || '')}</small>`;
    }
    return `<li class="dm-${who}"><div class="b">${body}</div><time>${time}</time></li>`;
  }).join('');
  dmLog.scrollTop = dmLog.scrollHeight;
}
async function refreshDM() {
  const k = localStorage.getItem(KEY_STORE);
  if (!k) return renderLock();
  const r = await fetch('/api/dm', { headers: { 'X-Jena-Key': k }, cache: 'no-store' }).catch(() => null);
  if (!r) return;
  if (r.status === 401) { localStorage.removeItem(KEY_STORE); return renderLock(); }
  const d = await r.json();
  $('#dm-store').textContent = `stored in: ${d.stores?.lists || '?'} · files: ${d.stores?.files || '?'}`;
  renderDM(d.log || []);
}
setInterval(() => drawer.classList.contains('open') && refreshDM(), 6000);
$('#dm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#dm-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const k = localStorage.getItem(KEY_STORE);
  dmLog.insertAdjacentHTML('beforeend', `<li class="dm-mama pending"><div class="b">${esc(text)}</div></li>`);
  dmLog.scrollTop = dmLog.scrollHeight;
  // a real event in the thought chain (text shown only on this screen, never in OBS mode)
  const run = chain.start({ user: 'mama', source: 'private', private: true, text });
  setTimeout(() => autonomy.onPrivateMessage(), 50);
  const r = await fetch('/api/dm', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': k }, body: JSON.stringify({ text, origin: ORIGIN }) }).catch(() => null);
  const d = r ? await r.json().catch(() => ({})) : {};
  if (!r) run.step('status', "couldn't reach Jena's API");
  else if (!r.ok) run.step('status', d.error || `DM failed (${r.status})`);
  for (const ev of d.events || []) runEvent(ev, run, { privateRun: true });
  run.done();
  refreshDM();
});
renderLock();

// ---------------- drag & drop onto Jena ----------------
const zone = $('#avatar-panel');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
zone.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; zone.classList.add('drag'); });
zone.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
zone.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; zone.classList.remove('drag'); } });
zone.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  zone.classList.remove('drag');
  const f = e.dataTransfer.files?.[0];
  if (f) uploadFile(f);
});
// also allow the hidden file input (phones can't drag)
$('#file-input').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ''; });
$('#gift').addEventListener('click', () => $('#file-input').click());

async function uploadFile(file) {
  const k = localStorage.getItem(KEY_STORE);
  if (!k) {
    pendingFile = file;
    openDM(true);
    $('#dm-err').textContent = `enter the passcode and I'll take “${file.name}”`;
    return;
  }
  lastActivity = Date.now();
  autonomy.onFileDrop(file.name);
  const thumb = /^image\//.test(file.type) ? URL.createObjectURL(file) : undefined;
  const att = { name: file.name, type: file.type, size: file.size };
  let note = '';
  try {
    const r = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Jena-Key': k }, body: file });
    const d = await r.json();
    if (!r.ok) note = d.error || `upload failed (${r.status})`;
    else att.url = d.url;
  } catch (e) { note = 'upload failed (no API here)'; }
  thinkAbout({ message: note ? `(${note})` : '', source: 'stage', user: 'mama', attachment: att }, { thumb });
  if (drawer.classList.contains('open')) refreshDM();
}

// ---------------- desktop ----------------
const desktop = new Desktop($('#desktop'), { url: cfg.desktopUrl });
// pick up a new tunnel URL announced by her machine without a reload
if (cfg.api && !new URLSearchParams(location.search).get('desktop')) {
  setInterval(async () => {
    const c = await fetch('/api/config', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
    if (c?.desktopUrl) desktop.setUrl(c.desktopUrl);
  }, 60000);
}

// ---------------- public JS API (read-only on her body: she moves herself) ----------------
window.jena = {
  think: (message, user = 'guest') => thinkAbout({ message, source: 'stage', user }),
  bones: () => avatar.bones(),
  expressions: () => avatar.expressions(),
  arms: () => avatar.armState(),
  // everything she feels of her own body right now: all bones (degrees), all expressions (0-1), eyes, and what it means
  get selfState() { return selfSense.snapshot(); },
  desktop: (url) => desktop.setUrl(url),
  config: cfg,
};
// ?debug=1 only: lets a test harness trigger her own autonomy moves to check self-vision left/right
if (params.get('debug') === '1') window.__jenaDebug = { autonomy, avatar, selfSense };

// ---------------- secret developer panel (top-left corner x5) + deploy progress ----------------
if (!cfg.obs) {
  window.__jenaDev = new DevPanel({ getRuns: () => runs, avatar, cfg });
  deployBar();
}

const stamp = document.createElement('div');
stamp.id = 'build-stamp';
stamp.textContent = `build ${__BUILD__}`;
document.body.appendChild(stamp);
