// Where everything points. Order: query param > /api/config (Vercel env / box) > /jena-config.json > defaults.
//   ?twitch=channel     her Twitch channel for the chat panel (or TWITCH_CHANNEL on the server). No default.
//   ?desktop=URL        live desktop stream: wss://host/websockify (https://host also works)
//   ?vrm=URL            which VRM body to load
//   ?brain=URL          an external brain endpoint (same NDJSON contract as /api/think)
//   ?obs=1              OBS browser-source mode: 1920x1080, no scrollbars, no private controls
//   ?bg=none            transparent background (for OBS scenes with their own backdrop)
//   ?controls=0         hide the test buttons
const q = new URLSearchParams(location.search);

const DEFAULTS = {
  twitch: null,
  desktopUrl: null,
  vrmUrl: 'https://cdn.jsdelivr.net/gh/pfn000/JenaAI@main/avatars/sample-vrm1.vrm',
  vrmFallbackUrl: 'https://raw.githubusercontent.com/pfn000/JenaAI/main/avatars/sample-vrm1.vrm',
  brainUrl: '/api/think',
};

async function getJSON(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function loadConfig() {
  const [api, file] = await Promise.all([getJSON('/api/config'), getJSON('/jena-config.json')]);
  const pickv = (k, apiKey = k) => q.get(k) || api?.[apiKey] || file?.[apiKey] || null;
  const cfg = {
    ...DEFAULTS,
    ...(file || {}),
    api: !!api,
    apiInfo: api,
    obs: q.get('obs') === '1' || q.get('obs') === 'true',
    bgNone: q.get('bg') === 'none' || q.get('bg') === 'transparent',
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
