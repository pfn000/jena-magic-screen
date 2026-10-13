// Tab Live (mama only): what Tab's builders are doing right now, read from her box (/box/tab-live, written every 3 s
// by the tab-live service on the box). The passcode is checked here and again on the box.
import { json, cors, checkKey } from './_lib/http.js';
import { boxLink, boxAuth } from './_lib/boxlink.js';

async function handle(req) {
  if (req.method === 'OPTIONS') return cors();
  const k = checkKey(req);
  if (!k.ok) return json({ error: 'mama only: ' + k.why }, 401);
  const box = await boxLink();
  if (!box) return json({ error: 'her box is offline (no tunnel announced)', offline: true }, 503);
  try {
    const r = await fetch(box.url + '/box/tab-live', { headers: { ...boxAuth(), 'X-Jena-Key': req.headers.get('x-jena-key') || '' }, signal: AbortSignal.timeout(7000) });
    const t = await r.text();
    return new Response(t, { status: r.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (e) { return json({ error: `her box did not answer: ${e.message}`, offline: true }, 502); }
}
export const GET = handle;
export const OPTIONS = handle;
export const maxDuration = 10;
