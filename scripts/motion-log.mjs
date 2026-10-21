// LOCAL motion-log stub (Saidie, Oct 20): the page POSTs 2-5 s telemetry batches to /motion-log. This writes the
// summary line to data/motion-log/<day>.jsonl and the packed 120 Hz batch to jena-avatar/animations/live-telemetry/.
// Dev server only (vite) or scripts/motion-log-server.mjs; never the live gateway, never uploaded from here.
import fs from 'node:fs';
import path from 'node:path';
export function writeBatch(root, body) {
  const { meta, data } = JSON.parse(body);
  if (!meta || meta.kind !== 'jena-motion') throw new Error('not a jena-motion batch');
  const day = new Date().toISOString().slice(0, 10), stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = path.join(root, 'data', 'motion-log'), telDir = path.join(root, 'jena-avatar', 'animations', 'live-telemetry', day);
  fs.mkdirSync(logDir, { recursive: true }); fs.mkdirSync(telDir, { recursive: true });
  const file = `${stamp}-${meta.samples}s120.jtel${meta.enc === 'gzip' ? '.gz' : ''}`;
  if (data) fs.writeFileSync(path.join(telDir, file), Buffer.from(data, 'base64'));
  const { bones, expr, layout, ...summary } = meta;
  fs.appendFileSync(path.join(logDir, `${day}.jsonl`), JSON.stringify({ ...summary, file: data ? path.join('jena-avatar/animations/live-telemetry', day, file) : null }) + '\n');
  const schema = path.join(root, 'jena-avatar', 'animations', 'live-telemetry', 'schema.json');
  if (!fs.existsSync(schema)) fs.writeFileSync(schema, JSON.stringify({ hz: meta.hz, bones, expr, layout }, null, 2));
  return file;
}
export function motionLogPlugin() {
  return {
    name: 'jena-motion-log',
    configureServer(server) {
      server.middlewares.use('/motion-log', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = ''; req.on('data', (c) => { body += c; if (body.length > 8e6) req.destroy(); });
        req.on('end', () => { try { const f = writeBatch(server.config.root, body); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, file: f })); } catch (e) { res.statusCode = 400; res.end(String(e.message || e)); } });
      });
    },
  };
}
