// WebAuthn passkeys for mama, with no dependency: registration (attestation "none") and login, ES256 / RS256 / EdDSA.
// RP ID = this site's host (jena-magic-screen.vercel.app). Challenges are stateless (HMAC-signed, 3 min).
// Credentials (public keys only) live on her box: ~/.jena-mama/passkeys.json via /box/mama/sec/passkeys.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// ---- minimal CBOR decoder (what attestation objects + COSE keys use)
function cbor(buf, pos = 0) {
  const ib = buf[pos++], mt = ib >> 5, ai = ib & 31;
  let len = ai;
  if (ai === 24) { len = buf[pos]; pos += 1; } else if (ai === 25) { len = buf.readUInt16BE(pos); pos += 2; } else if (ai === 26) { len = buf.readUInt32BE(pos); pos += 4; } else if (ai === 27) { len = Number(buf.readBigUInt64BE(pos)); pos += 8; } else if (ai > 27) throw new Error('cbor: indefinite lengths not supported');
  switch (mt) {
    case 0: return [len, pos];
    case 1: return [-1 - len, pos];
    case 2: return [buf.subarray(pos, pos + len), pos + len];
    case 3: return [buf.subarray(pos, pos + len).toString('utf8'), pos + len];
    case 4: { const a = []; for (let i = 0; i < len; i++) { const [v, p] = cbor(buf, pos); a.push(v); pos = p; } return [a, pos]; }
    case 5: { const m = new Map(); for (let i = 0; i < len; i++) { const [k, p1] = cbor(buf, pos); const [v, p2] = cbor(buf, p1); m.set(k, v); pos = p2; } return [m, pos]; }
    case 7: return [ai === 20 ? false : ai === 21 ? true : null, pos];
    default: throw new Error('cbor: unsupported type ' + mt);
  }
}

function parseAuthData(ad) {
  const out = { rpIdHash: ad.subarray(0, 32), flags: ad[32], counter: ad.readUInt32BE(33) };
  out.up = !!(out.flags & 0x01); out.uv = !!(out.flags & 0x04); out.at = !!(out.flags & 0x40);
  if (out.at) {
    let p = 37 + 16;
    const n = ad.readUInt16BE(p); p += 2;
    out.credId = ad.subarray(p, p + n); p += n;
    const [, end] = cbor(ad, p);
    out.cose = ad.subarray(p, end);
  }
  return out;
}

function coseToKey(coseBytes) {
  const [m] = cbor(Buffer.from(coseBytes));
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2) return { alg: alg || -7, key: crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(m.get(-2)), y: b64u(m.get(-3)) }, format: 'jwk' }) };
  if (kty === 3) return { alg: alg || -257, key: crypto.createPublicKey({ key: { kty: 'RSA', n: b64u(m.get(-1)), e: b64u(m.get(-2)) }, format: 'jwk' }) };
  if (kty === 1) return { alg: -8, key: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(m.get(-2)) }, format: 'jwk' }) };
  throw new Error('unsupported key type');
}

// ---- stateless challenges
const secret = () => crypto.createHash('sha256').update('jena-passkey-challenge:' + (process.env.JENA_MAMA_SECRET || process.env.JENA_DM_KEY || '')).digest();
export function challenge(kind) {
  const c = b64u(crypto.randomBytes(32));
  const body = b64u(JSON.stringify({ c, k: kind, exp: Date.now() + 180000 }));
  return { challenge: c, token: body + '.' + b64u(crypto.createHmac('sha256', secret()).update(body).digest()) };
}
function checkChallenge(token, kind) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) throw new Error('missing challenge');
  const want = crypto.createHmac('sha256', secret()).update(body).digest();
  const got = unb64u(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new Error('bad challenge');
  const p = JSON.parse(unb64u(body).toString());
  if (p.k !== kind || p.exp < Date.now()) throw new Error('challenge expired, try again');
  return p.c;
}

export const rpOf = (req) => { const u = new URL(req.url); const host = req.headers.get('x-forwarded-host') || u.host; return { id: host.split(':')[0], origin: `https://${host}` }; };

export function registrationOptions(req, existing = []) {
  const rp = rpOf(req), ch = challenge('reg');
  return {
    token: ch.token,
    publicKey: {
      challenge: ch.challenge, rp: { name: 'Jena · mama', id: rp.id },
      user: { id: b64u(Buffer.from('jena-mama')), name: 'mama', displayName: 'Mama (Jena)' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
      timeout: 60000, attestation: 'none',
      authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false, userVerification: 'required' },
      excludeCredentials: existing.map((c) => ({ type: 'public-key', id: c.id, transports: c.transports || [] })),
    },
  };
}

export function verifyRegistration(req, body) {
  const rp = rpOf(req);
  const want = checkChallenge(body.token, 'reg');
  const r = body.credential?.response || {};
  const cd = JSON.parse(unb64u(r.clientDataJSON).toString());
  if (cd.type !== 'webauthn.create') throw new Error('wrong ceremony');
  if (cd.challenge !== want) throw new Error('challenge mismatch');
  if (cd.origin !== rp.origin) throw new Error(`origin ${cd.origin} is not ${rp.origin}`);
  const [att] = cbor(unb64u(r.attestationObject));
  const ad = parseAuthData(Buffer.from(att.get('authData')));
  if (!ad.rpIdHash.equals(sha256(rp.id))) throw new Error('passkey is for another site');
  if (!ad.up || !ad.uv) throw new Error('Face ID / device unlock was not confirmed');
  if (!ad.at || !ad.cose) throw new Error('no key in the response');
  coseToKey(ad.cose);   // throws on a key type we can't verify later
  return { id: b64u(ad.credId), publicKey: b64u(ad.cose), counter: ad.counter, transports: Array.isArray(r.transports) ? r.transports : [], fmt: att.get('fmt') };
}

export function loginOptions(req, creds = []) {
  const rp = rpOf(req), ch = challenge('auth');
  return { token: ch.token, publicKey: { challenge: ch.challenge, rpId: rp.id, timeout: 60000, userVerification: 'required', allowCredentials: creds.map((c) => ({ type: 'public-key', id: c.id, transports: c.transports || [] })) } };
}

export function verifyLogin(req, body, creds = []) {
  const rp = rpOf(req);
  const want = checkChallenge(body.token, 'auth');
  const c = body.credential || {};
  const stored = creds.find((x) => x.id === c.id || x.id === c.rawId);
  if (!stored) throw new Error('this passkey is not one of mama\'s');
  const r = c.response || {};
  const cdRaw = unb64u(r.clientDataJSON);
  const cd = JSON.parse(cdRaw.toString());
  if (cd.type !== 'webauthn.get') throw new Error('wrong ceremony');
  if (cd.challenge !== want) throw new Error('challenge mismatch');
  if (cd.origin !== rp.origin) throw new Error(`origin ${cd.origin} is not ${rp.origin}`);
  const adRaw = unb64u(r.authenticatorData);
  const ad = parseAuthData(adRaw);
  if (!ad.rpIdHash.equals(sha256(rp.id))) throw new Error('passkey is for another site');
  if (!ad.up || !ad.uv) throw new Error('Face ID / device unlock was not confirmed');
  const { alg, key } = coseToKey(unb64u(stored.publicKey));
  const data = Buffer.concat([adRaw, sha256(cdRaw)]);
  const sig = unb64u(r.signature);
  const ok = alg === -8 ? crypto.verify(null, data, key, sig) : crypto.verify('sha256', data, alg === -7 ? { key, dsaEncoding: 'der' } : key, sig);
  if (!ok) throw new Error('signature did not verify');
  if (ad.counter && stored.counter && ad.counter <= stored.counter) throw new Error('passkey counter went backwards (cloned key?)');
  return { id: stored.id, counter: ad.counter, label: stored.label };
}

export const _test = { cbor, parseAuthData, coseToKey };
