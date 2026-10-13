// Where everything points. Order: query param > /api/config (Vercel env / box) > /jena-config.json > defaults.
//   ?twitch=channel     her Twitch channel for the chat panel (or TWITCH_CHANNEL on the server). No default.
//   ?desktop=URL        live desktop stream: wss://host/websockify (https://host also works)
//   ?vrm=URL            which VRM body to load
//   ?brain=URL          an external brain endpoint (same NDJSON contract as /api/think)
//   ?obs=1              OBS browser-source mode: 1920x1080, no scrollbars, no private controls
//   ?bg=none            transparent background (for OBS scenes with their own backdrop)
//   ?controls=0         hide the test buttons
//   /stream?layout=wide|phone  STREAM LAYOUT (VTuber): her censored desktop full-screen behind her, her waist-up body in
//                       front on a transparent background, live chat on the right (wide 16:9) or along the side (phone 9:16).
//                       Always OBS-safe (implies ?obs=1). ?part=avatar|chat|desktop shows one layer alone for OBS scenes.
const q = new URLSearchParams(location.search);
// the stream layout is always the public, censored, OBS-safe page (never mama's raw view)
const STREAM = /^\/stream\/?$/.test(location.pathname) || q.has('layout');

const DEFAULTS = {
  twitch: null,
  desktopUrl: null,
  vrmUrl: 'https://cdn.jsdelivr.net/gh/pfn000/JenaAI@main/avatars/sample-vrm1.vrm',
  vrmFallbackUrl: 'https://raw.githubusercontent.com/pfn000/JenaAI/main/avatars/sample-vrm1.vrm',
  brainUrl: '/api/think',
};

async function getJSON(url) {
  try {
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) }); // a stalled server never holds the page
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// the last /api/config that named her box: used when the server is down, slow or answers something unexpected,
// so a page (above all the OBS stream view) always comes up whole (STREAM_SAFETY.md)
const LAST_CFG = 'jena.lastConfig';
function lastGood(api) {
  try {
    if (api && typeof api === 'object' && api.box?.url) { localStorage.setItem(LAST_CFG, JSON.stringify({ ...api, savedAt: Date.now() })); return api; }
    const old = JSON.parse(localStorage.getItem(LAST_CFG) || 'null');
    if (old && old.box?.url) return api && typeof api === 'object' ? { ...old, ...api, box: old.box, desktopUrl: api.desktopUrl || old.desktopUrl, fromCache: true } : { ...old, fromCache: true };
  } catch {}
  return api && typeof api === 'object' ? api : null;
}

export async function loadConfig() {
  const [api0, file] = await Promise.all([getJSON('/api/config'), getJSON('/jena-config.json')]);
  const api = lastGood(api0);
  const pickv = (k, apiKey = k) => q.get(k) || api?.[apiKey] || file?.[apiKey] || null;
  const cfg = {
    ...DEFAULTS,
    ...(file || {}),
    api: !!api,
    apiInfo: api,
    stream: STREAM,
    layout: STREAM ? (q.get('layout') === 'phone' || q.get('layout') === 'tiktok' ? 'phone' : 'wide') : null,
    part: STREAM && ['avatar', 'chat', 'desktop'].includes(q.get('part')) ? q.get('part') : null,
    obs: STREAM || q.get('obs') === '1' || q.get('obs') === 'true',
    bgNone: STREAM || q.get('bg') === 'none' || q.get('bg') === 'transparent',
    controls: q.get('controls') !== '0',
  };
  cfg.twitch = q.get('twitch') || api?.twitch || null; // never a default channel
  cfg.desktopUrl = normalizeDesktop(pickv('desktop', 'desktopUrl'));
  cfg.vrmUrl = q.get('vrm') || api?.vrmUrl || file?.vrmUrl || DEFAULTS.vrmUrl;
  cfg.brainUrl = q.get('brain') || (api ? '/api/think' : null);
  return cfg;
}

export function normalizeDesktop(u) {
  if (!u) return null;
  u = String(u).trim();
  if (/^https?:\/\//.test(u)) {
    const url = new URL(u);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (url.pathname === '/' || url.pathname.endsWith('.html')) url.pathname = '/websockify';
    return url.toString();
  }
  return u;
}
