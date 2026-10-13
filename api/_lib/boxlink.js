// Where her box is right now. Her machine reaches the web through a free tunnel whose URL changes when it
// restarts, so the box ANNOUNCES its URL: signed with its ed25519 key (public half below), POSTed to /api/box
// and also published to a public relay topic (ntfy.sh) and the repo's `box-state` branch, which any cold Vercel
// instance can read back (the newest valid signature wins).
// Only an announcement with a valid signature is believed; nothing here is hard-coded to a tunnel.
import crypto from 'node:crypto';

export const BOX_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAU/JpOGBM0RZu/cbdJ+5fzLNuHJJY9q9T0jtdFlahJLU=
-----END PUBLIC KEY-----`;
export const BOX_TOPIC = 'jena-magic-screen-box-ad4fcbe133af';
const URL_OK = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;
const FRESH_MS = 12 * 3600 * 1000; // the box POSTs every 2 min; the relay gets it on every URL change / 20 min, and keeps 12 h
let latest = null, polledAt = 0, polling = null;
const key = crypto.createPublicKey(BOX_PUBKEY);

export function verify(env) {
  try {
    if (!env?.msg || !env?.sig) return null;
    if (!crypto.verify(null, Buffer.from(String(env.msg)), key, Buffer.from(String(env.sig), 'base64'))) return null;
    const p = JSON.parse(env.msg);
    if (!URL_OK.test(p.url) || !(p.ts > 0) || p.ts > Date.now() + 120000) return null;
    return p;
  } catch { return null; }
}

export function accept(env) {
  const p = verify(env);
  if (p && (!latest || p.ts > latest.ts)) latest = { ...p, via: env.via || 'post' };
  return p;
}

let relayNewest = null; // newest announcement the relay itself holds (what a cold instance will believe)
async function poll() {
  try {
    const r = await fetch(`https://ntfy.sh/${BOX_TOPIC}/json?poll=1&since=12h`, { signal: AbortSignal.timeout(4000) });
    const txt = await r.text();
    for (const line of txt.trim().split('\n')) {
      try {
        const m = JSON.parse(line); if (m.event !== 'message') continue;
        const p = accept({ ...JSON.parse(m.message), via: 'relay' });
        if (p && (!relayNewest || p.ts > relayNewest.ts)) relayNewest = p;
      } catch {}
    }
  } catch {}
  // second source: the box also commits the same signed envelope to the repo's `box-state` branch on every address
  // change (files/ops/sitewatch/box-state-push.sh). Read uncached; the newest valid signature by ts wins either way.
  try {
    const r = await fetch(`https://raw.githubusercontent.com/pfn000/jena-magic-screen/box-state/box.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (r.ok) accept({ ...(await r.json()), via: 'box-state' });
  } catch {}
  polledAt = Date.now();
}

// The box posts its new address here AND to the relay, but the relay refuses the box's own IP once it has
// posted too much in a day (HTTP 429; 2026-10-13 it refused from ~15:50Z on), and then every cold instance (any
// redeploy) read back a dead tunnel: brain offline, desktop asleep, chat failing. So when a signed POST brings an
// address the relay doesn't have yet (or the relay's copy is 20+ min old), this instance republishes the same
// signed envelope to the relay from Vercel's side. The signature is the box's, so nothing new is trusted.
let relayedUrl = null, relayedAt = 0;
export async function relayBox(env, p) {
  try {
    if (!p) return null;
    if (Date.now() - polledAt > 60000) await poll();
    const stale = !relayNewest || relayNewest.url !== p.url || Date.now() - relayNewest.ts > 20 * 60000;
    if (!stale || (relayedUrl === p.url && Date.now() - relayedAt < 20 * 60000)) return 'relay current';
    const r = await fetch(`https://ntfy.sh/${BOX_TOPIC}`, { method: 'POST', body: JSON.stringify({ msg: env.msg, sig: env.sig }), signal: AbortSignal.timeout(4000) });
    if (r.ok) { relayedUrl = p.url; relayedAt = Date.now(); relayNewest = p; }
    return 'relayed ' + r.status;
  } catch (e) { return 'relay error ' + (e.message || e); }
}

export async function boxLink() {
  const fresh = latest && Date.now() - latest.ts < 5 * 60 * 1000;
  if (!fresh && Date.now() - polledAt > 15000) { polling ||= poll().finally(() => (polling = null)); await polling; }
  return latest && Date.now() - latest.ts < FRESH_MS ? latest : null;
}

// Short-lived proof that a request to her box really comes from this site: HMAC of the current time with a
// secret derived from JENA_DM_KEY (her box stores only the derived secret). Her box refuses brain/status/log
// requests from the tunnel without it.
export function boxAuth() {
  const k = (process.env.JENA_DM_KEY || '').trim();
  if (!k) return {};
  const secret = crypto.createHash('sha256').update('jena-box-auth:' + k).digest('hex');
  const ts = String(Date.now());
  return { 'X-Jena-Auth': `${ts}.${crypto.createHmac('sha256', secret).update(ts).digest('hex')}` };
}

// Her voice only says what she really said: each line she speaks carries a token the site signed for exactly
// that text, and /api/tts refuses anything else (nobody can make her voice say arbitrary words).
export function ttsToken(text) {
  const k = (process.env.JENA_DM_KEY || '').trim();
  if (!k) return null;
  const secret = crypto.createHash('sha256').update('jena-box-auth:' + k).digest('hex');
  return crypto.createHmac('sha256', secret).update('tts:' + text).digest('hex').slice(0, 32);
}
