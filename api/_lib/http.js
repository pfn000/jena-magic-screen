export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...headers },
  });

export const cors = () =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Jena-Key, X-File-Name',
    },
  });

// The private channel's key: JENA_DM_KEY on the Vercel project.
export function checkKey(req) {
  const want = process.env.JENA_DM_KEY;
  if (!want) return { ok: false, why: 'JENA_DM_KEY is not set on this deployment, so the private channel is off' };
  const got = req.headers.get('x-jena-key') || new URL(req.url).searchParams.get('key') || '';
  if (got.length !== want.length) return { ok: false, why: 'wrong passcode' };
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, why: 'wrong passcode' };
}

export async function body(req) {
  try { return await req.json(); } catch { return {}; }
}
