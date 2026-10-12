// Storage for the Jena API. Picks the best backend the Vercel project has:
//   files:  Vercel Blob (BLOB_READ_WRITE_TOKEN)              -> else in-memory (temporary)
//   lists:  Upstash Redis / Vercel KV (KV_REST_API_URL+TOKEN or UPSTASH_REDIS_REST_URL+TOKEN)
//           -> else a JSON file in Vercel Blob                -> else in-memory (temporary)
// "In-memory" lives inside one warm function instance: good enough for a demo,
// gone on a cold start. Adding a Blob store (and optionally Redis) in the Vercel
// dashboard makes everything durable with no code change.

const mem = globalThis.__jenaMem || (globalThis.__jenaMem = { lists: {}, files: {} });

const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const hasBlob = !!process.env.BLOB_READ_WRITE_TOKEN;

export function backends() {
  return {
    files: hasBlob ? 'vercel-blob' : 'memory (temporary)',
    lists: redisUrl && redisToken ? 'redis' : hasBlob ? 'vercel-blob-json' : 'memory (temporary)',
  };
}

async function redis(cmd) {
  const r = await fetch(redisUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return (await r.json()).result;
}

async function blobLib() {
  return await import('@vercel/blob');
}

const blobCache = {};
async function blobReadList(name) {
  if (blobCache[name]) return blobCache[name];
  const { list } = await blobLib();
  const res = await list({ prefix: `state/${name}.json`, limit: 1 });
  let items = [];
  if (res.blobs[0]) {
    try { items = await (await fetch(res.blobs[0].url + `?t=${Date.now()}`, { cache: 'no-store' })).json(); } catch { items = []; }
  }
  blobCache[name] = items;
  return items;
}

export async function pushItem(name, item, max = 200) {
  const rec = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: Date.now(), ...item };
  if (redisUrl && redisToken) {
    await redis(['LPUSH', `jena:${name}`, JSON.stringify(rec)]);
    await redis(['LTRIM', `jena:${name}`, '0', String(max - 1)]);
  } else if (hasBlob) {
    const items = await blobReadList(name);
    items.push(rec);
    while (items.length > max) items.shift();
    const { put } = await blobLib();
    await put(`state/${name}.json`, JSON.stringify(items), {
      access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60,
    });
  } else {
    const l = (mem.lists[name] ||= []);
    l.push(rec);
    while (l.length > max) l.shift();
  }
  return rec;
}

export async function listItems(name, { since = 0, limit = 100 } = {}) {
  let items;
  if (redisUrl && redisToken) {
    const raw = (await redis(['LRANGE', `jena:${name}`, '0', String(limit - 1)])) || [];
    items = raw.map((s) => JSON.parse(s)).reverse();
  } else if (hasBlob) {
    items = (await blobReadList(name)).slice(-limit);
  } else {
    items = (mem.lists[name] || []).slice(-limit);
  }
  return items.filter((i) => i.ts > since);
}

export async function saveFile(name, type, buf) {
  const safe = String(name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);
  if (hasBlob) {
    const { put } = await blobLib();
    const b = await put(`uploads/${Date.now()}-${safe}`, buf, { access: 'public', contentType: type || 'application/octet-stream', addRandomSuffix: true });
    return { url: b.url, store: 'vercel-blob' };
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mem.files[id] = { name: safe, type, buf };
  const keys = Object.keys(mem.files);
  while (keys.length > 20) delete mem.files[keys.shift()];
  return { url: `/api/upload?id=${id}`, store: 'memory (temporary)' };
}

export function memFile(id) {
  return mem.files[id];
}
