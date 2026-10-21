// Standalone LOCAL /motion-log stub + static server for a built dist/ (node scripts/motion-log-server.mjs [port]).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { writeBatch } from './motion-log.mjs';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), dist = path.join(root, 'dist'), port = +(process.argv[2] || 5200);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.vrm': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.webp': 'image/webp' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/motion-log' && req.method === 'POST') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { res.end(JSON.stringify({ ok: true, file: writeBatch(root, b) })); } catch (e) { res.statusCode = 400; res.end(String(e.message)); } }); return; }
  if (u.pathname.startsWith('/api/')) { res.statusCode = 502; return res.end('{}'); }
  let f = path.join(dist, decodeURIComponent(u.pathname)); if (!f.startsWith(dist)) { res.statusCode = 403; return res.end(); }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) f = path.join(dist, 'index.html');
  res.setHeader('content-type', types[path.extname(f)] || 'application/octet-stream'); res.setHeader('cache-control', 'no-store');
  fs.createReadStream(f).pipe(res);
}).listen(port, '127.0.0.1', () => console.log('motion-log + dist on', port));
