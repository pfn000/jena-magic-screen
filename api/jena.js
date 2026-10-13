// One Vercel function serves the whole Jena API (vercel.json rewrites /api/* here),
// so the temporary in-memory store is shared by every route.
//   POST /api/desktop           (passcode) {url} her machine announces its live desktop stream URL
//   GET  /api/config            page config (desktop stream URL, twitch channel, VRM, which brain, which stores)
//   POST /api/think             stream a thought chain as NDJSON  {message, source, user, attachment, origin}
//   POST /api/chat              same brain, one JSON answer       {reply, mood, actions, steps}
//   GET  /api/events?since=ts   stage events for other screens (OBS) to replay
//   POST /api/upload            (passcode) raw file body, X-File-Name header -> stored, logged, announced
//   GET  /api/upload?id=        a file from the temporary store
//   GET  /api/dm                (passcode) the private mama <-> Jena log
//   POST /api/hear?user=&learn=0|1&private=0|1  raw audio clip -> {text} (local speech-to-text on her box)
//   POST /api/dm                (passcode) {text} -> Jena answers privately; never shown on stream
import { json, cors, checkKey, body } from './_lib/http.js';
import { pushItem, listItems, saveFile, memFile, backends } from './_lib/store.js';
import { thinkEvents, thinkAll, brainName, brainChain, brainHealth, checkHealth } from './_lib/brain.js';
import { boxLink, boxAuth, ttsToken, accept as acceptBox } from './_lib/boxlink.js';
import { multiSearch, hotUrls } from './_lib/search.js';

function routeOf(req) {
  const u = new URL(req.url);
  const r = u.searchParams.get('route') || u.pathname.replace(/^\/api\/?/, '');
  return r.replace(/^jena\/?/, '').split('/')[0] || 'config';
}

async function config() {
  let announced = null;
  try { announced = (await listItems('desktop', { limit: 1 })).pop() || null; } catch {}
  const box = await boxLink();
  return {
    desktopUrl: box ? box.url.replace(/^https:/, 'wss:') + '/websockify' : announced?.url || process.env.JENA_DESKTOP_URL || null,
    desktopAnnouncedAt: box?.ts || announced?.ts || null,
    box: box ? { url: box.url, announcedAt: box.ts, via: box.via } : null,
    build: buildInfo(),
    twitch: process.env.TWITCH_CHANNEL || process.env.JENA_TWITCH_CHANNEL || null,
    vrmUrl: process.env.JENA_VRM_URL || null,
    brain: brainName(),
    brainChain: brainChain(),
    brainHealth: await brainHealth(),
    stores: backends(),
    dmEnabled: !!process.env.JENA_DM_KEY,
    runtime: process.env.VERCEL ? 'vercel' : 'local',
  };
}

const clip = (s, n = 500) => String(s || '').slice(0, n);

function buildInfo() {
  const e = process.env;
  return { commit: e.VERCEL_GIT_COMMIT_SHA || null, message: clip(e.VERCEL_GIT_COMMIT_MESSAGE, 160) || null, env: e.VERCEL_ENV || null, region: e.VERCEL_REGION || null, deploymentUrl: e.VERCEL_URL || null };
}

// Live deploy progress for the dev panel: Vercel's own status on each commit of the public repo (GitHub API).
let deploysCache = { at: 0, data: null };
async function deploys() {
  if (Date.now() - deploysCache.at < 20000 && deploysCache.data) return json(deploysCache.data);
  const repo = process.env.JENA_REPO || 'pfn000/jena-magic-screen';
  const gh = (p) => fetch(`https://api.github.com/repos/${repo}${p}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'jena-magic-screen' }, signal: AbortSignal.timeout(6000) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GitHub answered ${r.status}`))));
  try {
    const commits = await gh('/commits?per_page=6');
    const rows = await Promise.all(commits.map(async (c) => {
      let st = null; try { st = await gh(`/commits/${c.sha}/status`); } catch {}
      const v = st?.statuses?.find((s) => /vercel/i.test(s.context));
      return { sha: c.sha, message: clip(c.commit.message.split('\n')[0], 140), author: c.commit.author.name, date: c.commit.author.date, deploy: v ? { state: v.state, description: v.description, updatedAt: v.updated_at } : null };
    }));
    deploysCache = { at: Date.now(), data: { now: Date.now(), live: buildInfo(), commits: rows } };
    return json(deploysCache.data);
  } catch (e) {
    return json({ now: Date.now(), live: buildInfo(), error: e.message, commits: deploysCache.data?.commits || [] }, 200);
  }
}

// Mama-only actions on her box (passcode): run a skill, draft a new skill.
async function boxDo(req) {
  const k = checkKey(req);
  if (!k.ok) return json({ error: k.why }, 401);
  const box = await boxLink();
  if (!box) return json({ error: 'her box is offline' }, 503);
  const b = await body(req);
  const path = b.action === 'create' ? '/box/skills/create' : '/box/skills/run';
  try {
    const r = await fetch(box.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': req.headers.get('x-jena-key') || '' }, body: JSON.stringify(b), signal: AbortSignal.timeout(25000) });
    return json(await r.json(), r.status);
  } catch (e) { return json({ ok: false, summary: `box did not answer: ${e.message}` }, 502); }
}

// Mama-only: pop a message up on her desktop, get a one-time token to take over her desktop, see her API key.
async function mamaDo(req) {
  const k = checkKey(req);
  if (!k.ok) return json({ error: k.why }, 401);
  const box = await boxLink();
  if (!box) return json({ error: 'her box is offline' }, 503);
  const b = await body(req);
  const action = { notify: 'notify', takeover: 'takeover', apikey: 'apikey', merge: 'merge', rollback: 'rollback', discard: 'discard', correct: 'correct' }[b.action];
  if (!action) return json({ error: 'unknown action' }, 400);
  if (action === 'correct') {   // mama's ✎ correct on a reply -> verified fact + corrections training chat (her gateway)
    try {
      const r = await fetch(`${box.url}/truth/correct`, { method: 'POST', headers: { ...boxAuth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ q: clip(b.q, 400), wrong: clip(b.wrong, 600), right: clip(b.right, 300) }), signal: AbortSignal.timeout(10000) });
      return json(await r.json().catch(() => ({ error: `her box answered ${r.status}` })), r.status);
    } catch (e) { return json({ ok: false, error: `her box did not answer: ${e.message}` }, 502); }
  }
  try {
    // site edits (merge a checked Jena branch / roll back her last change) go to her studio's site-edit checker
    const studio = ['merge', 'rollback', 'discard'].includes(action);
    const r = await fetch(studio ? `${box.url}/box/studio/mama/${action}` : `${box.url}/box/mama/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': req.headers.get('x-jena-key') || '' }, body: JSON.stringify(b), signal: AbortSignal.timeout(studio ? 28000 : 10000) });
    const d = await r.json();
    if (action === 'takeover' && d.ok) d.ws = box.url.replace(/^http/, 'ws') + d.path;
    return json(d, r.status);
  } catch (e) { return json({ ok: false, error: `her box did not answer: ${e.message}` }, 502); }
}

// Jena's own OpenAI-compatible API: https://<site>/api/v1/chat/completions with "Authorization: Bearer jena-…".
// The key is checked on her box (only its sha256 is stored there); this just passes the request through.
async function jenaApi(req) {
  const sub = new URL(req.url).pathname.replace(/^\/api\/v1\/?/, '') || (new URL(req.url).searchParams.get('route') || '').replace(/^v1\/?/, '');
  const box = await boxLink();
  if (!box) return json({ error: { message: 'Jena is offline (her box is not reachable right now)' } }, 503);
  try {
    const r = await fetch(`${box.url}/japi/v1/${sub}`, { method: req.method, headers: { 'Content-Type': 'application/json', Authorization: req.headers.get('authorization') || '' }, body: req.method === 'POST' ? await req.text() : undefined, signal: AbortSignal.timeout(25000) });
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
  } catch (e) { return json({ error: { message: `her box did not answer: ${e.message}` } }, 502); }
}

// Her ears: 🎤 talk button. The browser records a short clip, this forwards it (signed, like every box call) to her box,
// where free local speech-to-text (whisper "small", CPU) turns it into text. The audio is never stored anywhere.
// Limits: 2 MB / 30 s per clip, 6 clips a minute per visitor here, one at a time on her box.
const hearHits = new Map();
async function hear(req) {
  const u0 = new URL(req.url);
  if (u0.searchParams.get('reply') === '1') {
    // her answer to an opted-in voice note (so the next training run sees what people said AND what she said back).
    // Only a line she really said is accepted: the same signed token her voice uses.
    const b = await body(req);
    const reply = String(b.reply || '').slice(0, 600), id = String(b.id || '').slice(0, 40);
    if (!id || !reply || ttsToken(reply) !== b.tok) return json({ error: 'only her own answer can be attached' }, 403);
    const box = await boxLink();
    if (!box) return json({ error: 'her box is offline' }, 503);
    try {
      const r = await fetch(`${box.url}/hear/reply`, { method: 'POST', headers: { ...boxAuth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id, reply }), signal: AbortSignal.timeout(8000) });
      return json(await r.json().catch(() => ({})), r.status);
    } catch (e) { return json({ error: `her box did not answer: ${e.message}` }, 502); }
  }
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const hits = (hearHits.get(ip) || []).filter((t) => now - t < 60000);
  if (hits.length >= 6) return json({ error: "that's a lot of voice messages, give her a minute" }, 429);
  hits.push(now); hearHits.set(ip, hits);
  if (hearHits.size > 2000) hearHits.clear();
  const ctype = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^audio\/(webm|ogg|mp4|mpeg|wav|x-wav|aac|x-m4a|flac)$|^video\/(webm|mp4)$/.test(ctype)) return json({ error: `not an audio clip (${ctype || 'no type'})` }, 415);
  const n = +(req.headers.get('content-length') || 0);
  if (n > 2 * 1024 * 1024) return json({ error: 'that recording is too big (2 MB max, about 30 s)' }, 413);
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) return json({ error: 'no audio arrived' }, 400);
  if (buf.length > 2 * 1024 * 1024) return json({ error: 'that recording is too big (2 MB max, about 30 s)' }, 413);
  const u = new URL(req.url);
  const isPrivate = u.searchParams.get('private') === '1';
  if (isPrivate && !checkKey(req).ok) return json({ error: "private voice messages are mama-only (unlock the private drawer first)" }, 401);
  const learn = !isPrivate && u.searchParams.get('learn') === '1';
  const user = clip(u.searchParams.get('user') || 'guest', 40);
  const box = await boxLink();
  if (!box) return json({ error: "her box is offline, so she can't hear right now" }, 503);
  try {
    const r = await fetch(`${box.url}/hear?user=${encodeURIComponent(user)}&learn=${learn ? 1 : 0}&private=${isPrivate ? 1 : 0}`, { method: 'POST', headers: { ...boxAuth(), 'Content-Type': ctype }, body: buf, signal: AbortSignal.timeout(25000) });
    const d = await r.json().catch(() => ({ error: `her ears answered ${r.status}` }));
    return json({ ...d, bytes: buf.length, learn, private: isPrivate }, r.status);
  } catch (e) { return json({ error: `her ears did not answer: ${e.message}` }, 502); }
}

// Her voice (Piper TTS on her box). Only for lines she really said (token signed by thinkEvents).
async function tts(req) {
  const u = new URL(req.url);
  const text = (u.searchParams.get('text') || '').slice(0, 600), tok = u.searchParams.get('t') || '';
  const want = ttsToken(text);
  if (!text || !want || tok !== want) return json({ error: 'her voice only says what she actually said' }, 403);
  const box = await boxLink();
  if (!box) return json({ error: 'her box is offline, so her voice is too' }, 503);
  try {
    const r = await fetch(`${box.url}/tts?text=${encodeURIComponent(text.slice(0, 400))}&voice=${encodeURIComponent(u.searchParams.get('voice') || '')}`, { headers: boxAuth(), signal: AbortSignal.timeout(20000) });
    if (!r.ok) return json({ error: `her voice answered ${r.status}` }, 502);
    return new Response(r.body, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400', 'X-Jena-Voice': r.headers.get('x-jena-voice') || 'piper' } });
  } catch (e) { return json({ error: `her voice did not answer: ${e.message}` }, 502); }
}

// Public, read-only list of the skills she has (names, what they do, how often they worked). No inputs/outputs.
async function publicSkills() {
  const box = await boxLink();
  if (!box) return json({ online: false, error: 'her box is offline, so her skills list cannot be read right now' }, 503);
  try {
    const r = await fetch(box.url + '/box/skills', { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    return json({ online: true, skills: d.skills.map((s) => ({ name: s.name, description: s.description, source: s.source, status: s.status, runs: s.runs, ok: s.ok, fail: s.fail, last_used: s.last_used || null })), mcp: Object.keys(d.mcp || {}) });
  } catch (e) { return json({ online: false, error: `her box did not answer: ${e.message}` }, 502); }
}

// Her box's own live facts (models, last raw request/response, desktop, training) through the tunnel.
async function boxProxy(req) {
  const box = await boxLink();
  if (!box) return json({ online: false, error: 'her box has not announced itself in the last 30 min (box or tunnel down)' }, 503);
  const what = new URL(req.url).searchParams.get('what') || 'status';
  if (what === 'watch' && !checkKey(req).ok) return json({ online: true, locked: true, error: 'watchdog details are mama-only' }, 401);
  if (what === 'activity' && !checkKey(req).ok) return json({ online: true, locked: true, error: "her activity log is mama-only: unlock the private DM drawer with your passcode on this device first" }, 401);
  const q = new URL(req.url).searchParams;
  const th = `/box/thoughts?since=${Math.max(0, parseInt(q.get('since') || '0', 10) || 0)}&last=${Math.min(40, Math.max(1, parseInt(q.get('last') || '8', 10) || 8))}`;
  const path = { status: '/status', log: '/brain/log?n=20', screen: '/box/screen.json', skills: '/box/skills', activity: '/box/activity', memory: '/box/memory', thoughts: th, library: '/box/studio/library' + (q.get('q') ? '?q=' + encodeURIComponent(q.get('q').slice(0, 200)) : ''), assets: '/box/studio/assets', edits: '/box/studio/edits', watch: '/box/watch/health' }[what] || '/status';
  try {
    const r = await fetch(box.url + path, { headers: { ...boxAuth(), ...(what === 'activity' || what === 'watch' ? { 'X-Jena-Key': req.headers.get('x-jena-key') || '' } : {}) }, signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    return json({ online: true, box: { url: box.url, announcedAt: box.ts, via: box.via }, data: d });
  } catch (e) {
    return json({ online: false, box: { url: box.url, announcedAt: box.ts }, error: `box announced but did not answer: ${e.message}` }, 502);
  }
}

// the page's watchdog reporter (src/watch.js): a tiny no-PII report to her box's watchdog (box/watchdog)
async function incident(req) {
  const box = await boxLink();
  if (!box) return json({ ok: false, error: 'her box has not announced itself (box or tunnel down)' }, 503);
  const b = await body(req), s = (v, n) => String(v ?? '').slice(0, n);
  const pick = { kind: s(b.kind, 20), panel: s(b.panel, 20), count: +b.count || 0, window_s: +b.window_s || 0, msg: s(b.msg, 200), build: s(b.build, 12), view: s(b.view, 8), device: s(b.device, 8), rid: s(b.rid, 10) };
  try {
    const r = await fetch(box.url + '/box/incident', { method: 'POST', headers: { 'Content-Type': 'application/json', ...boxAuth() }, body: JSON.stringify(pick), signal: AbortSignal.timeout(6000) });
    return json(await r.json(), r.status);
  } catch (e) { return json({ ok: false, error: `box did not answer: ${e.message}` }, 502); }
}

// an asset she made on her box (svg/png), passed through so the dev panel gallery can show it
async function assetFile(req) {
  const name = new URL(req.url).searchParams.get('name') || '';
  if (!/^[\w.-]+\.(svg|png)$/.test(name)) return json({ error: 'bad name' }, 400);
  const box = await boxLink();
  if (!box) return json({ error: 'her box is offline' }, 503);
  try {
    const r = await fetch(`${box.url}/box/studio/asset/${name}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return json({ error: `box answered ${r.status}` }, r.status);
    return new Response(await r.arrayBuffer(), { headers: { 'Content-Type': name.endsWith('.svg') ? 'image/svg+xml' : 'image/png', 'Cache-Control': 'public, max-age=300', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Access-Control-Allow-Origin': '*' } });
  } catch (e) { return json({ error: e.message }, 502); }
}

// her memory service on her box: recall before she answers, save what's worth remembering after
const recall = (bx, q, user) => fetch(`${bx.url}/box/memory/recall?q=${encodeURIComponent(q.slice(0, 300))}&user=${encodeURIComponent(user || '')}`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).then((d) => d.memories || []).catch(() => []);
const observe = (bx, text, user, source) => fetch(`${bx.url}/box/memory/observe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, user, source }), signal: AbortSignal.timeout(5000) }).then((r) => r.json()).then((d) => d.saved || []).catch(() => []);

async function think(req) {
  const b = await body(req);
  const keyed = checkKey(req).ok;
  const input = {
    message: clip(b.message, 2000),
    source: b.source === 'dm' ? 'stage' : clip(b.source, 20) || 'stage',
    user: clip(b.user, 40) || 'someone',
    attachment: b.attachment ? { name: clip(b.attachment.name, 120), type: clip(b.attachment.type, 80), size: +b.attachment.size || 0 } : undefined,
  };
  input.mama = keyed && input.source !== 'twitch' && input.user === 'mama';   // mama (passcode, her own words, never relayed chat): her corrections become verified facts on her box
  const broadcast = keyed && b.broadcast !== false && input.source !== 'twitch';
  // her desktop hears public messages too (a typed URL opens exactly that URL, searches, videos)
  // a message that matches one of her skills runs that skill on her box FIRST, and her brain answers from what it found
  let toDesk = null, memSave = null;
  if (input.message) {
    const bx = await boxLink().catch(() => null);
    if (bx) {
      const [sk, mem] = await Promise.all([
        fetch(bx.url + '/box/skills/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: input.message, user: input.user, source: input.source }), signal: AbortSignal.timeout(12000) }).then((r) => r.json()).catch(() => null),
        recall(bx, input.message, input.user),
      ]);
      if (mem?.length) input.memories = mem;
      memSave = () => observe(bx, input.message, input.user, input.source);
      if (sk?.name) input.skill = sk;
      else toDesk = fetch(bx.url + '/box/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: input.message, user: input.user, source: input.source }), signal: AbortSignal.timeout(5000) }).catch(() => null);
    }
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const run = [];
      try {
        for await (const e of thinkEvents(input)) {
          run.push(e);
          ctrl.enqueue(enc.encode(JSON.stringify(e) + '\n'));
        }
      } catch (e) {
        ctrl.enqueue(enc.encode(JSON.stringify({ type: 'step', kind: 'feel', text: `brain hiccup: ${e.message}` }) + '\n'));
        ctrl.enqueue(enc.encode(JSON.stringify({ type: 'done' }) + '\n'));
      }
      if (toDesk) await toDesk;
      if (memSave) {
        const saved = await memSave();
        if (saved?.length) { const e = { type: 'step', kind: 'think', text: `saved to my memory: ${saved[0]}` }; run.push(e); ctrl.enqueue(enc.encode(JSON.stringify(e) + '\n')); }
      }
      if (broadcast) {
        try {
          await pushItem('events', { type: 'thought_run', origin: clip(b.origin, 40), trigger: { source: input.source, user: input.user, text: clip(input.message, 200), attachment: input.attachment }, events: run }, 50);
        } catch {}
      }
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Jena-Brain': brainName() } });
}

async function chat(req) {
  const b = await body(req);
  const ev = await thinkAll({ message: clip(b.message, 2000), source: 'api', user: clip(b.user, 40) || 'api' });
  return json({
    brain: brainName(),
    reply: ev.filter((e) => e.type === 'say').map((e) => e.text).join(' ').trim(),
    mood: [...ev].reverse().find((e) => e.type === 'mood')?.value || 'neutral',
    actions: ev.filter((e) => e.type === 'action'),
    steps: ev.filter((e) => e.type === 'step'),
  });
}

async function events(req) {
  const since = +new URL(req.url).searchParams.get('since') || 0;
  return json({ now: Date.now(), events: await listItems('events', { since, limit: 30 }) });
}

async function upload(req) {
  const u = new URL(req.url);
  if (req.method === 'GET') {
    const f = memFile(u.searchParams.get('id'));
    if (!f) return json({ error: 'not found (temporary store forgets files on a cold start)' }, 404);
    return new Response(f.buf, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'Content-Disposition': `inline; filename="${f.name}"` } });
  }
  const k = checkKey(req);
  if (!k.ok) return json({ error: k.why }, 401);
  const name = decodeURIComponent(req.headers.get('x-file-name') || 'file');
  const type = req.headers.get('content-type') || 'application/octet-stream';
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) return json({ error: 'file too big for v1 (4 MB max through a function)' }, 413);
  const saved = await saveFile(name, type, buf);
  const rec = { from: 'mama', kind: 'file', name, type, size: buf.length, url: saved.url, store: saved.store };
  await pushItem('dm', rec);
  return json({ ok: true, ...rec });
}

async function dm(req) {
  const k = checkKey(req);
  if (!k.ok) return json({ error: k.why }, 401);
  if (req.method === 'GET') return json({ log: await listItems('dm', { limit: 100 }), stores: backends() });
  const b = await body(req);
  const text = clip(b.text, 2000).trim();
  if (!text) return json({ error: 'empty message' }, 400);
  const mine = await pushItem('dm', { from: 'mama', kind: 'text', text });
  // mama's message also pops up on Jena's own desktop (the site covers the desktop panel for everyone else meanwhile)
  boxLink().then((bx) => bx && fetch(`${bx.url}/box/mama/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': req.headers.get('x-jena-key') || '' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(5000) })).catch(() => null);
  const bxm = await boxLink().catch(() => null);
  const memories = bxm ? await recall(bxm, text, 'mama') : [];
  const ev = await thinkAll({ message: text, source: 'dm', user: 'mama', memories });
  if (bxm) { const saved = await observe(bxm, text, 'mama', 'dm'); if (saved.length) ev.push({ type: 'step', kind: 'think', text: `saved to my memory: ${saved[0]}` }); }
  // other screens (the OBS page) only learn THAT mama sent something private, never the words
  try {
    await pushItem('events', { type: 'thought_run', origin: clip(b.origin, 40), trigger: { source: 'private', user: 'mama', private: true }, events: ev.filter((e) => ['meta', 'status', 'done', 'say'].includes(e.type)).map((e) => (e.type === 'say' ? { type: 'say', text: '' } : e)) }, 50);
  } catch {}
  const reply = ev.filter((e) => e.type === 'say').map((e) => e.text).join(' ').trim();
  const mood = [...ev].reverse().find((e) => e.type === 'mood')?.value || 'neutral';
  const status = ev.filter((e) => e.type === 'status').map((e) => e.text).join(' ');
  const theirs = reply
    ? await pushItem('dm', { from: 'jena', kind: 'text', text: reply, mood, brain: brainName(), steps: ev.filter((e) => e.type === 'step').map((e) => e.text) })
    : await pushItem('dm', { from: 'system', kind: 'text', text: `saved. ${status || 'no reply from her brain'}` });
  return json({ ok: true, sent: mine, reply: theirs, events: ev });
}

// Her machine announces its current desktop stream URL (tunnel URLs change on every restart).
async function announceDesktop(req) {
  const k = checkKey(req);
  if (!k.ok) return json({ error: k.why }, 401);
  const b = await body(req);
  const url = clip(b.url, 300);
  if (!/^(wss?|https?):\/\//.test(url)) return json({ error: 'url must be ws(s):// or http(s)://' }, 400);
  await pushItem('desktop', { url }, 5);
  return json({ ok: true, url, stores: backends() });
}

async function handle(req) {
  if (req.method === 'OPTIONS') return cors();
  const route = routeOf(req);
  try {
    if (route === 'config') return json(await config());
    if (route === 'box' && req.method === 'POST') { const p = acceptBox(await body(req)); if (p) checkHealth(); return p ? json({ ok: true, url: p.url }) : json({ error: 'bad signature' }, 401); }
    if (route === 'box') return await boxProxy(req);
    if (route === 'deploys') return await deploys();
    if (route === 'incident' && req.method === 'POST') return await incident(req);
    if (route === 'skills') return await publicSkills();
    if (route === 'mama' && req.method === 'POST') return await mamaDo(req);
    if (route === 'tts') return await tts(req);
    if (route === 'hear' && req.method === 'POST') return await hear(req);
    if (route === 'v1') return await jenaApi(req);
    if (route === 'asset') return await assetFile(req);
    if (route === 'hot') { try { return json({ list: await hotUrls(), source: 'Hot URLS/URLS.md in her repo (read live)' }); } catch (e) { return json({ error: e.message }, 502); } }
    if (route === 'boxdo' && req.method === 'POST') return await boxDo(req);
    if (route === 'search') { const u = new URL(req.url); return json(await multiSearch(clip(u.searchParams.get('q'), 200), clip(u.searchParams.get('src'), 60))); }
    if (route === 'desktop' && req.method === 'POST') return await announceDesktop(req);
    if (route === 'think' && req.method === 'POST') return await think(req);
    if (route === 'chat' && req.method === 'POST') return await chat(req);
    if (route === 'events') return await events(req);
    if (route === 'upload') return await upload(req);
    if (route === 'dm') return await dm(req);
    if (route === 'health') { const h = await brainHealth(); return json({ ok: true, brain: { name: h.model || 'JenaXI', online: h.online, detail: h.detail, checkedAt: h.checkedAt, box: h.box }, stores: backends(), build: buildInfo() }); }
    return json({ error: `no route ${route}` }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
export const maxDuration = 30;
