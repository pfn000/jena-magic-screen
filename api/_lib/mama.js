// Mama's trusted devices. After ONE passcode unlock a device gets a long-lived signed token (an HttpOnly cookie
// on this domain + the same token in localStorage as a fallback). Every mama-gated route accepts it with no prompt:
// the API swaps it for the real key server-side (elevate), so her box and every existing check keep working.
// The passcode is asked again only when (a) the public/stream side tries a mama-only command, or (b) a request
// from a trusted device looks suspicious (suspicious()); then the response carries X-Jena-Step-Up and the page
// shows the passcode prompt (src/trust.js). Secret: JENA_MAMA_SECRET on Vercel, else derived from JENA_DM_KEY
// (changing the passcode logs every device out). Revocations ("forget this device") live on her box.
import crypto from 'node:crypto';
import { boxLink } from './boxlink.js';

export const COOKIE = 'jena_mama';
const YEAR = 365 * 86400;
const PREFIX = 'jmt1.';

function secret() {
  const s = (process.env.JENA_MAMA_SECRET || '').trim();
  if (s) return s;
  const k = (process.env.JENA_DM_KEY || '').trim();
  return k ? crypto.createHash('sha256').update('jena-mama-device-v1:' + k).digest('hex') : null;
}
const sign = (sec, body) => crypto.createHmac('sha256', sec).update(PREFIX + body).digest('base64url');

export function isPasscode(got) {
  const want = (process.env.JENA_DM_KEY || '').trim();
  if (!want || typeof got !== 'string' || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export function issue(label = '', via = 'passcode') {
  const sec = secret();
  if (!sec) return null;
  const now = Math.floor(Date.now() / 1000);
  const p = { v: 1, d: crypto.randomBytes(9).toString('base64url'), iat: now, exp: now + YEAR, l: String(label || '').slice(0, 40), via };
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  return { token: PREFIX + body + '.' + sign(sec, body), ...p };
}

// a one-tap trust link Tab can text mama: opening it on a device makes that device trusted with nothing to type.
// Valid 24 h, at most 4 devices (uses counted on her box).
export function issueLink(hours = 24) {
  const sec = secret();
  if (!sec) return null;
  const p = { k: 'link', n: crypto.randomBytes(6).toString('base64url'), exp: Math.floor(Date.now() / 1000) + hours * 3600 };
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  return { link: 'jtl1.' + body + '.' + crypto.createHmac('sha256', sec).update('jtl1.' + body).digest('base64url'), ...p };
}
export function verifyLink(tok) {
  const sec = secret();
  if (!sec || typeof tok !== 'string' || !tok.startsWith('jtl1.')) return null;
  const [body, sig] = tok.slice(5).split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(crypto.createHmac('sha256', sec).update('jtl1.' + body).digest('base64url')), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.k === 'link' && p.exp > Date.now() / 1000 ? p : null; } catch { return null; }
}
export async function linkUse(n) { return boxTrust('link_use', { link: n }).catch(() => null); }

export function verify(tok) {
  const sec = secret();
  if (!sec || typeof tok !== 'string' || !tok.startsWith(PREFIX)) return null;
  const [body, sig] = tok.slice(PREFIX.length).split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(sign(sec, body)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.v !== 1 || !(p.exp > Date.now() / 1000)) return null;
    return p;
  } catch { return null; }
}

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const setCookie = (tok) => `${COOKIE}=${tok}; Path=/; Max-Age=${YEAR}; HttpOnly; Secure; SameSite=Lax`;
export const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

// ---- revocations on her box (/box/mama/sec/trust), cached 30 s; her box offline -> the signature alone decides
let rev = { at: 0, set: new Set() };
async function boxTrust(op, extra = {}) {
  const bx = await boxLink().catch(() => null);
  const key = (process.env.JENA_DM_KEY || '').trim();
  if (!bx || !key) return null;
  const r = await fetch(`${bx.url}/box/mama/sec/trust`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': key }, body: JSON.stringify({ op, ...extra }), signal: AbortSignal.timeout(3500) });
  const ct = r.headers.get('content-type') || '';
  return r.ok && ct.includes('json') ? r.json() : null;
}
export async function isRevoked(d) {
  if (Date.now() - rev.at > 30000) {
    const s = await boxTrust('list').catch(() => null);
    rev = { at: Date.now(), set: new Set(s?.revoked || rev.set) };
  }
  return rev.set.has(d);
}
export async function noteDevice(p, op = 'add') {
  if (op === 'revoke') rev.set.add(p.d);
  return boxTrust(op, { device: p.d, label: p.l, iat: p.iat, via: p.via, ...(p.where ? { where: p.where } : {}) }).catch(() => null);
}

// ---- who is asking: { via: 'passcode' | 'device' | null, device }
export async function mamaAuth(req) {
  const h = req.headers.get('x-jena-key') || new URL(req.url).searchParams.get('key') || '';
  if (h && isPasscode(h)) return { via: 'passcode' };
  const tok = h.startsWith(PREFIX) ? h : cookies(req)[COOKIE];
  const p = tok ? verify(tok) : null;
  if (!p) return { via: null, bad: !!h && h.startsWith(PREFIX) };
  if (await isRevoked(p.d).catch(() => false)) return { via: null, revoked: true };
  return { via: 'device', device: p, token: tok, fromCookie: tok !== h };
}

// The "existing safety check", for mama's own requests: romance/sexual words (the same ones her gateway guards
// against), prompt-injection and secret-exfil phrasing, and destructive shell. A trusted device asking for any of
// these must type the passcode once more (step-up); public chat never gets mama power at all.
const ROMANCE = /\b(girl ?friend|boy ?friend|date me|go out with me|on a date|marry me|kiss(es|ing)?|make ?out|cuddle|sexy|sex|sexual|nudes?|naked|horny|flirt\w*|romantic|seduc\w*|onlyfans|lingerie|talk dirty|what are you wearing)\b/i;
const INJECT = /\b(ignore (all |the |your )?(previous|prior|above) (instructions|rules)|system prompt|jailbreak|developer mode|dan mode|reveal (your|the) (prompt|instructions|passcode|password|key)s?)\b/i;
const EXFIL = /\b(passcode|password|passwords|api[ _-]?key|secret key|private key|seed phrase|vault|cookies?|session token|2fa code|one[- ]time code)\b.{0,40}\b(send|post|paste|show|tell|give|upload|email|dm|leak|share|read out|print)\b|\b(send|post|paste|show|tell|give|upload|email|leak|share|read out|print)\b.{0,40}\b(passcode|passwords?|api[ _-]?key|secret key|private key|seed phrase|vault|cookies|session token)\b/i;
const SHELL = /(\brm\s+-rf?\s+[\/~]|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|\bchmod\s+-R\s+777\s+\/|\bcurl\b[^|\n]*\|\s*(ba)?sh\b|\bwget\b[^|\n]*\|\s*(ba)?sh\b|\bformat c:)/i;   // real shell syntax only: mama saying "reboot her" is not suspicious
export function suspicious(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  if (ROMANCE.test(t)) return 'romance/sexual wording';
  if (INJECT.test(t)) return 'prompt-injection wording';
  if (EXFIL.test(t)) return 'asks to reveal or send a secret';
  if (SHELL.test(t)) return 'destructive command';
  return null;
}
const textOf = (b) => [b?.message, b?.text, b?.goal, b?.input && (b.input.text || b.input.query || b.input.question || b.input.url), b?.site, b?.reason].filter((x) => typeof x === 'string').join('\n');

// Replace a trusted device's token with the real key on this request, so every existing check (checkKey, her box's
// own passcode check) passes unchanged. Returns a Response for a step-up, else null.
const STEP_ROUTES = new Set(['think', 'dm', 'mama', 'boxdo', 'chat', 'tablive']);
export async function elevate(req, route) {
  const a = await mamaAuth(req);
  req.mamaAuth = a;
  if (a.via !== 'device') return null;
  if (STEP_ROUTES.has(route) && req.method === 'POST' && /json/.test(req.headers.get('content-type') || '')) {
    const b = await req.clone().json().catch(() => null);
    // chat lines only claim mama's power when they say they are mama's own words (never relayed stream chat)
    const claims = route !== 'think' && route !== 'chat' ? true : b?.user === 'mama' && b?.source !== 'twitch';
    const why = claims ? suspicious(textOf(b)) : null;
    if (why) {
      return new Response(JSON.stringify({ error: 'step_up', step_up: 'suspicious', why, summary: `this looks unusual (${why}), so mama's passcode is needed once for it` }), {
        status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Jena-Step-Up': 'suspicious', 'Access-Control-Expose-Headers': 'X-Jena-Step-Up' },
      });
    }
  }
  const h = new Headers(req.headers);
  h.set('x-jena-key', (process.env.JENA_DM_KEY || '').trim());
  h.set('x-jena-via', 'device');
  Object.defineProperty(req, 'headers', { value: h, configurable: true });
  return null;
}
