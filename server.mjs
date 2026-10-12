// Local / own-server runner: serves the built page from dist/ and the same Jena API
// that runs on Vercel (api/jena.js), so the box (or her own server) behaves like the deployment.
//   npm run build && JENA_DESKTOP_URL=wss://.../websockify node server.mjs
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from './api/jena.js';
import { startHealthLoop } from './api/_lib/brain.js';

startHealthLoop(15000); // JenaXI endpoint health, every 15 s

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');
const port = +process.env.PORT || 4173;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.vrm': 'model/gltf-binary', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const handler = api[req.method] || api.GET;
    const r = await handler(request);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) for await (const c of r.body) res.write(c);
    return res.end();
  }
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, p);
  try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); } catch { file = join(root, 'index.html'); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store, max-age=0' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(port, () => console.log(`jena magic screen on http://localhost:${port}`));
