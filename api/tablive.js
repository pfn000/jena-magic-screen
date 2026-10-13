// Tab Live (mama only): what Tab's builders are doing right now, read from her box (/box/tab-live, written every 3 s
// by the tab-live service on the box). The passcode is checked here and again on the box.
import { json, cors, checkKey } from './_lib/http.js';
import { boxLink, boxAuth } from './_lib/boxlink.js';

// This function runs on its own instances, which may not have heard the box's announcement (the main api function
// gets the box's direct POST). So also ask our own /api/config, and keep the last address that worked.
let lastGood = null;
const URL_OK = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;
async function viaConfig(req) {
  try {
    const r = await fetch(new URL('/api/config', req.url), { signal: AbortSignal.timeout(4000) });
    const u = (await r.json())?.box?.url;
    return URL_OK.test(u || '') ? { url: u } : null;
  } catch { return null; }
}
async function pass(req, box) {
  const post = req.method === 'POST';
  const r = await fetch(box.url + (post ? '/box/tab-live/todo' : '/box/tab-live'), {
    method: post ? 'POST' : 'GET',
    headers: { ...boxAuth(), 'X-Jena-Key': req.headers.get('x-jena-key') || '', ...(post ? { 'Content-Type': 'application/json' } : {}) },
    body: post ? JSON.stringify({ text: String((await req.json().catch(() => ({})))?.text || '').slice(0, 1000) }) : undefined,
    signal: AbortSignal.timeout(7000),
  });
  return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function handle(req) {
  if (req.method === 'OPTIONS') return cors();
  const k = checkKey(req);
  if (!k.ok) return json({ error: 'mama only: ' + k.why }, 401);
  const box = (await boxLink()) || (await viaConfig(req));
  if (box) lastGood = box;
  else if (lastGood) return pass(req, lastGood);
  if (!box) return json({ error: 'her box is offline (no tunnel announced)', offline: true }, 503);
  try { return await pass(req, box); } catch (e) { return json({ error: `her box did not answer: ${e.message}`, offline: true }, 502); }
}
export const GET = handle;
export const POST = handle;   // mama's notepad: POST {text} -> a to-do for Tab
export const OPTIONS = handle;
export const maxDuration = 10;
