// Where her box is right now. Her machine reaches the web through a free tunnel whose URL changes when it
// restarts, so the box ANNOUNCES its URL: signed with its ed25519 key (public half below), POSTed to /api/box
// and also published to a public relay topic (ntfy.sh) that any cold Vercel instance can read back.
// Only an announcement with a valid signature is believed; nothing here is hard-coded to a tunnel.
import crypto from 'node:crypto';

export const BOX_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAU/JpOGBM0RZu/cbdJ+5fzLNuHJJY9q9T0jtdFlahJLU=
-----END PUBLIC KEY-----`;
export const BOX_TOPIC = 'jena-magic-screen-box-ad4fcbe133af';
const URL_OK = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;
const FRESH_MS = 30 * 60 * 1000; // the box re-announces every 2 min while it is reachable
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

async function poll() {
  try {
    const r = await fetch(`https://ntfy.sh/${BOX_TOPIC}/json?poll=1&since=45m`, { signal: AbortSignal.timeout(4000) });
    const txt = await r.text();
    for (const line of txt.trim().split('\n')) {
      try { const m = JSON.parse(line); if (m.event === 'message') accept({ ...JSON.parse(m.message), via: 'relay' }); } catch {}
    }
  } catch {}
  polledAt = Date.now();
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
