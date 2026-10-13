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
//   POST /api/dm                (passcode) {text} -> Jena answers privately; never shown on stream
import { json, cors, checkKey, body } from './_lib/http.js';
import { pushItem, listItems, saveFile, memFile, backends } from './_lib/store.js';
import { thinkEvents, thinkAll, brainName, brainChain, brainHealth, checkHealth } from './_lib/brain.js';
import { boxLink, accept as acceptBox } from './_lib/boxlink.js';
import { multiSearch } from './_lib/search.js';

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

// Her box's own live facts (models, last raw request/response, desktop, training) through the tunnel.
async function boxProxy(req) {
  const box = await boxLink();
  if (!box) return json({ online: false, error: 'her box has not announced itself in the last 30 min (box or tunnel down)' }, 503);
  const what = new URL(req.url).searchParams.get('what') || 'status';
  const path = { status: '/status', log: '/brain/log?n=20', screen: '/box/screen.json' }[what] || '/status';
  try {
    const r = await fetch(box.url + path, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    return json({ online: true, box: { url: box.url, announcedAt: box.ts, via: box.via }, data: d });
  } catch (e) {
    return json({ online: false, box: { url: box.url, announcedAt: box.ts }, error: `box announced but did not answer: ${e.message}` }, 502);
  }
}

async function think(req) {
  const b = await body(req);
  const keyed = checkKey(req).ok;
  const input = {
    message: clip(b.message, 2000),
    source: b.source === 'dm' ? 'stage' : clip(b.source, 20) || 'stage',
    user: clip(b.user, 40) || 'someone',
    attachment: b.attachment ? { name: clip(b.attachment.name, 120), type: clip(b.attachment.type, 80), size: +b.attachment.size || 0 } : undefined,
  };
  const broadcast = keyed && b.broadcast !== false && input.source !== 'twitch';
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
  const ev = await thinkAll({ message: text, source: 'dm', user: 'mama' });
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
