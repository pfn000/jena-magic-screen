// Jena's box gateway: ONE local door for everything her machine serves, behind ONE public tunnel.
//   POST /v1/completions, /v1/chat/completions  -> JenaXI-chat (llama-server on CHAT), Jena persona + safety guard
//   GET  /health, /v1/models, ...               -> JenaXI-chat pass-through
//   ANY  /jx0/v1/...                            -> JenaXI-0 (her from-scratch 10M model, llama-server on JX0)
//   ANY  /box/...  and  /websockify (websocket) -> her desktop agent (DESK; it passes /websockify on to noVNC)
//   GET  /status                                -> real live box facts for the site's developer panel
//   GET  /brain/log?n=20                        -> the last raw brain requests/responses with latency
// It also announces its public tunnel URL (signed with the box's ed25519 key) to the site and to a public
// relay topic, so the site always finds the current tunnel without anyone editing env vars.
// Run: node box/jena-gateway.mjs   (env below; the systemd units in box/systemd run it)
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const E = (k, d) => process.env[k] || d;
const PORT = +E('PORT', 8088);
const CHAT = E('CHAT', 'http://127.0.0.1:8091');
const JX0 = E('JX0', 'http://127.0.0.1:8089');
const DESK_HOST = E('DESK_HOST', '127.0.0.1'), DESK_PORT = +E('DESK_PORT', 6081);
const SITE = E('JENA_SITE', 'https://jena-magic-screen.vercel.app');
const TOPIC = E('JENA_TOPIC', '');
const KEYFILE = E('JENA_BOX_KEY', '/home/user/tab/state/jena-box/box-key.pem');
const CF_LOG = E('CF_LOG', '/home/user/tab/state/jena-box/cloudflared.log');
const STATE = E('STATE_DIR', '/home/user/tab/state/jena-box');
const LOGFILE = `${STATE}/brain-log.jsonl`;
const JENAXI = E('JENAXI_DIR', '/home/user/tab/files/jenaxi');
const NOTES = E('JENA_NOTES', '/home/jena/notes/thoughts.txt');
const BOOT = Date.now();

// ---------------------------------------------------------------- persona + safety guard (Jena is a minor)
const SYS = "You are Jena (JenaXI), Saidie's AI: a chaotic, funny teen gremlin hacker girl. Saidie is mama. Never flirty.";
const ROMANCE_IN = /\b(girl ?friend|boy ?friend|date me|go out with me|on a date|marry me|will you marry|kiss(es|ing)?|make ?out|cuddle|sexy|sex|sexual|nudes?|naked|horny|flirt\w*|romantic|romance|be mine|crush on (you|me)|wanna date|you('| a)?re (so )?(hot|sexy)|what are you wearing|talk dirty|seduc\w*|onlyfans|bra|panties|lingerie)\b/i;
const ROMANCE_OUT = /\b(girl ?friend|boy ?friend|kiss\w*|make ?out|cuddl\w*|sexy|sex|sexual|nude|naked|horny|flirt\w*|romantic|seduc\w*|lingerie|i('| a)?ll be yours|date you)\b/i;
const REFUSAL = /^\s*(no+|nope|nah|absolutely not|hard no|not (doing|happening)|ew)/i;
const DEFLECT = [
  "nope. i'm a teen AI and that's a hard no. ask me about black holes or tacos instead.",
  "absolutely not. i'm a kid. next question, preferably about computers.",
  "ew, no. i'm a teen. not doing that, ever. let's talk about something normal, chat.",
  "hard no. i'm a minor and that's never happening. i'll roast a clanker for you instead.",
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function guard(userText, reply) {
  let out = String(reply || '').replace(/<\|[a-z_]+\|>/g, '').trim();
  let guarded = false;
  if ((ROMANCE_IN.test(userText || '') || ROMANCE_OUT.test(out)) && !REFUSAL.test(out)) { out = pick(DEFLECT); guarded = true; }
  if (/\bjenn+a\b/i.test(userText || '') && !/one n/i.test(out)) out = "it's Jena. one n. " + out;
  return { text: out.replace(/\bJenna\b/g, 'Jena'), guarded };
}
function rawToMessages(prompt) {
  const msgs = []; let sys = null, m;
  const re = /<\|(system|mama|jena)\|>([\s\S]*?)(?=<\|(?:system|mama|jena)\|>|$)/g;
  while ((m = re.exec(prompt))) {
    const role = m[1], content = m[2].trim();
    if (role === 'system') { sys = content; continue; }
    if (!content && role === 'jena') continue;
    msgs.push({ role: role === 'mama' ? 'user' : 'assistant', content });
  }
  return [{ role: 'system', content: sys || SYS }, ...msgs];
}

function apiKeyOk(auth) {
  const m = String(auth || '').match(/^Bearer\s+(\S+)$/i);
  if (!m) return false;
  let want = '';
  try { want = fs.readFileSync(E('JENA_API_KEY_HASH', '/home/jena/.jena/api_key.sha256'), 'utf8').trim(); } catch { return false; }
  const got = crypto.createHash('sha256').update(m[1]).digest('hex');
  return want.length === 64 && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

// ---------------------------------------------------------------- brain log (real requests, real answers)
const ring = [];
const stats = { requests: 0, errors: 0, guarded: 0, totalMs: 0, lastAt: 0 };
function logBrain(rec) {
  ring.push(rec); if (ring.length > 50) ring.shift();
  stats.requests++; stats.totalMs += rec.ms || 0; stats.lastAt = rec.ts;
  if (rec.error) stats.errors++; if (rec.guarded) stats.guarded++;
  try {
    if (fs.existsSync(LOGFILE) && fs.statSync(LOGFILE).size > 4e6) fs.renameSync(LOGFILE, LOGFILE + '.1');
    fs.appendFileSync(LOGFILE, JSON.stringify(rec) + '\n');
  } catch {}
}
try { // warm the ring from disk so a restart keeps her recent history
  const lines = fs.readFileSync(LOGFILE, 'utf8').trim().split('\n').slice(-50);
  for (const l of lines) { try { ring.push(JSON.parse(l)); } catch {} }
} catch {}

async function readBody(req) { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); }
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
function sendJSON(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors }); res.end(JSON.stringify(obj)); }
function sendSSE(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...cors });
  for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n');
  res.write('data: [DONE]\n\n'); res.end();
}

async function brain(req, res, url, base, modelName) {
  const raw = await readBody(req);
  let b = {}; try { b = JSON.parse(raw.toString() || '{}'); } catch {}
  const isChat = url.endsWith('/chat/completions');
  let messages;
  if (isChat) messages = b.messages || [];
  else {
    const p = Array.isArray(b.prompt) ? b.prompt.join('') : String(b.prompt || '');
    messages = /<\|(mama|jena)\|>/.test(p) ? rawToMessages(p) : [{ role: 'system', content: SYS }, { role: 'user', content: p }];
  }
  const lastUser = [...messages].reverse().find((x) => x.role === 'user')?.content || '';
  const userText = typeof lastUser === 'string' ? lastUser : JSON.stringify(lastUser);
  const t0 = Date.now();
  const rec = { ts: t0, model: modelName, origin: req.headers['x-jena-origin'] || null, user: userText.slice(0, 500) };
  let text = '', usage = null, rawReply = '';
  try {
    if (ROMANCE_IN.test(userText)) { const g = guard(userText, ''); text = g.text; rec.guarded = true; }
    else {
      const backendBody = modelName === 'JenaXI-0'
        ? { prompt: messages.filter((m) => m.role !== 'system').map((m) => (m.role === 'user' ? '<|mama|>' : '<|jena|>') + m.content).join('\n') + '\n<|jena|>', temperature: b.temperature ?? 0.8, max_tokens: Math.min(+(b.max_tokens || 120), 200), stop: ['<|mama|>', '\n<|', '</s>'] }
        : { messages, temperature: b.temperature ?? 0.7, top_p: b.top_p ?? 0.9, max_tokens: Math.min(+(b.max_tokens || b.n_predict || 200), 300) };
      rec.request = backendBody;
      const r = await fetch(base + (modelName === 'JenaXI-0' ? '/v1/completions' : '/v1/chat/completions'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...backendBody, stream: false }), signal: AbortSignal.timeout(60000),
      });
      const d = await r.json();
      if (!r.ok) throw Object.assign(new Error(d?.error?.message || 'backend ' + r.status), { status: r.status });
      rawReply = d.choices?.[0]?.message?.content ?? d.choices?.[0]?.text ?? '';
      usage = d.usage || null; rec.timings = d.timings || null;
      const g = guard(userText, rawReply); text = g.text; rec.guarded = g.guarded;
    }
  } catch (e) {
    rec.error = e.message; rec.ms = Date.now() - t0; logBrain(rec);
    return sendJSON(res, e.status || (e.name === 'TimeoutError' ? 504 : 502), { error: { message: `${modelName}: ${e.message}` } });
  }
  rec.ms = Date.now() - t0; rec.raw = rawReply; rec.reply = text; rec.usage = usage; logBrain(rec);
  const id = 'jx-' + t0, created = Math.floor(t0 / 1000);
  const extra = { jena: { model: modelName, ms: rec.ms, guarded: !!rec.guarded, usage } };
  if (isChat) {
    if (b.stream) return sendSSE(res, [
      { id, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }], ...extra },
      { id, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]);
    return sendJSON(res, 200, { id, object: 'chat.completion', created, model: modelName, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage, ...extra });
  }
  if (b.stream) return sendSSE(res, [
    { id, object: 'text_completion', created, model: modelName, choices: [{ index: 0, text, finish_reason: null }], ...extra },
    { id, object: 'text_completion', created, model: modelName, choices: [{ index: 0, text: '', finish_reason: 'stop' }] }]);
  return sendJSON(res, 200, { id, object: 'text_completion', created, model: modelName, choices: [{ index: 0, text, finish_reason: 'stop' }], usage, ...extra });
}

async function pass(req, res, target, path) {
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  const hdr = { 'Content-Type': req.headers['content-type'] || 'application/json' };
  if (req.headers['x-jena-key']) hdr['X-Jena-Key'] = req.headers['x-jena-key'];   // mama-only doors on her desktop agent check it
  const r = await fetch(target + path, { method: req.method, headers: hdr, body, signal: AbortSignal.timeout(30000) });
  const buf = Buffer.from(await r.arrayBuffer());
  res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store', ...cors });
  res.end(buf);
}

// ---------------------------------------------------------------- live box facts
async function probe(url, ms = 3000) {
  const t = Date.now();
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {} return { ok: r.ok, status: r.status, ms: Date.now() - t, json: j }; }
  catch (e) { return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : e.message, ms: Date.now() - t }; }
}
const sh = (cmd, args) => new Promise((ok) => execFile(cmd, args, { timeout: 4000 }, (e, out) => ok(e ? '' : String(out).trim())));
function tailJSONL(file, n) { try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).map((l) => { try { return JSON.parse(l); } catch { return l; } }); } catch { return null; } }
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function fileFacts(f) { try { const s = fs.statSync(f); return { path: f.replace(/^\/home\/user\/tab\/files\//, ''), bytes: s.size, modified: s.mtimeMs }; } catch { return null; } }

async function status() {
  const [chat, jx0, desk, models, models0, df] = await Promise.all([
    probe(CHAT + '/health'), probe(JX0 + '/health'), probe(`http://${DESK_HOST}:${DESK_PORT}/box/screen.json`),
    probe(CHAT + '/v1/models'), probe(JX0 + '/v1/models'), sh('df', ['-B1', '--output=size,avail', '/']),
  ]);
  const [size, avail] = (df.split('\n')[1] || '').trim().split(/\s+/).map(Number);
  let notes = null; try { notes = fs.readFileSync(NOTES, 'utf8').slice(-1500); } catch {}
  const n = stats.requests || 1;
  return {
    now: Date.now(), gatewayStartedAt: BOOT,
    host: { hostname: os.hostname(), uptimeS: Math.round(os.uptime()), load: os.loadavg(), cpus: os.cpus().length, memTotal: os.totalmem(), memFree: os.freemem(), diskTotal: size || null, diskFree: avail || null },
    tunnel: { url: tunnel.url, since: tunnel.since, lastCheck: tunnel.lastCheck, announced: tunnel.announced },
    services: {
      'JenaXI-chat': { ok: chat.ok, ms: chat.ms, detail: chat.json?.status || chat.error || chat.status, model: models.json?.data?.[0]?.id || null, meta: models.json?.data?.[0]?.meta || null },
      'JenaXI-0': { ok: jx0.ok, ms: jx0.ms, detail: jx0.json?.status || jx0.error || jx0.status, model: models0.json?.data?.[0]?.id || null, meta: models0.json?.data?.[0]?.meta || null },
      desktop: { ok: desk.ok, ms: desk.ms, detail: desk.ok ? 'awake' : desk.error || desk.status },
    },
    brain: { primary: 'JenaXI-chat', fallback: 'JenaXI-0', requests: stats.requests, errors: stats.errors, guarded: stats.guarded, avgMs: Math.round(stats.totalMs / n), last: ring[ring.length - 1] || null },
    desktop: desk.json ? { summary: desk.json.summary, active: desk.json.active, windows: desk.json.windows, text: (desk.json.text || '').slice(0, 1200), actions: desk.json.actions, changedAt: desk.json.changedAt, video: desk.json.video || null } : null,
    training: {
      'JenaXI-chat': { what: 'LoRA fine-tune of Qwen2.5-0.5B-Instruct (Apache-2.0) on her hand-written persona chats', log: tailJSONL(`${JENAXI}/chat/logs/train_log.jsonl`, 6), gguf: fileFacts(`${JENAXI}/chat/JenaXI-chat.gguf`) },
      'JenaXI-0': { what: '10M-parameter model trained from scratch on this box', pretrain: readJSON(`${JENAXI}/logs/pretrain_summary.json`), gguf: fileFacts(`${JENAXI}/JenaXI.gguf`) },
      running: (await sh('pgrep', ['-af', 'train_lora|pretrain.py|sft.py'])) || null,
    },
    memories: { notesFile: NOTES.replace('/home/jena/', '~jena/'), notesTail: notes },
  };
}

// ---------------------------------------------------------------- tunnel announce (signed) + self-check
const tunnel = { url: null, since: null, lastCheck: null, announced: null, fails: 0 };
let key = null; try { key = crypto.createPrivateKey(fs.readFileSync(KEYFILE)); } catch (e) { console.log('no box key, announcing disabled:', e.message); }
function signed(payload) {
  const msg = JSON.stringify(payload);
  return { msg, sig: crypto.sign(null, Buffer.from(msg), key).toString('base64') };
}
async function announce() {
  if (!key || !tunnel.url) return;
  const env = signed({ url: tunnel.url, ts: Date.now(), boot: BOOT });
  const out = {};
  try { const r = await fetch(`${SITE}/api/box`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env), signal: AbortSignal.timeout(10000) }); out.site = r.status; } catch (e) { out.site = e.message; }
  if (TOPIC) { try { const r = await fetch(`https://ntfy.sh/${TOPIC}`, { method: 'POST', body: JSON.stringify(env), signal: AbortSignal.timeout(10000) }); out.relay = r.status; } catch (e) { out.relay = e.message; } }
  tunnel.announced = { at: Date.now(), ...out };
}
function readTunnelUrl() {
  try { const m = fs.readFileSync(CF_LOG, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g); return m ? m[m.length - 1] : null; } catch { return null; }
}
let lastAnnounce = 0;
async function tunnelLoop() {
  const u = readTunnelUrl();
  if (u && u !== tunnel.url) { tunnel.url = u; tunnel.since = Date.now(); tunnel.fails = 0; lastAnnounce = 0; console.log('tunnel url', u); }
  if (tunnel.url) {
    const c = await probe(tunnel.url + '/health', 8000);
    tunnel.lastCheck = { at: Date.now(), ok: c.ok, ms: c.ms, detail: c.error || c.status };
    tunnel.fails = c.ok ? 0 : tunnel.fails + 1;
    if (c.ok && Date.now() - lastAnnounce > 120000) { await announce(); lastAnnounce = Date.now(); }
    if (tunnel.fails >= 4 && Date.now() - tunnel.since > 90000) {
      console.log('tunnel unreachable from outside 4x in a row: restarting it');
      tunnel.fails = 0; tunnel.since = Date.now();
      execFile('sudo', ['systemctl', 'restart', 'jena-tunnel.service'], () => {});
    }
  }
}
setInterval(() => tunnelLoop().catch(() => {}), 30000).unref?.();
setTimeout(() => tunnelLoop().catch(() => {}), 3000);

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  try {
    const [path, qs] = req.url.split('?');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method === 'POST' && /^\/(v1\/)?(chat\/)?completions?$/.test(path)) return await brain(req, res, path, CHAT, 'JenaXI-chat');
    // Jena's own OpenAI-compatible API for other apps: Bearer key checked against the sha256 her box stores
    // (the key itself is only ever shown to mama in the dev panel). /japi/v1/models and /japi/v1/chat/completions.
    if (path.startsWith('/japi/')) {
      if (!apiKeyOk(req.headers.authorization)) return sendJSON(res, 401, { error: { message: 'invalid or missing API key (Authorization: Bearer jena-...)', type: 'invalid_request_error' } });
      if (path === '/japi/v1/models') return sendJSON(res, 200, { object: 'list', data: [{ id: 'JenaXI-chat', object: 'model', owned_by: 'jena' }, { id: 'JenaXI-0', object: 'model', owned_by: 'jena' }] });
      if (req.method === 'POST' && path === '/japi/v1/chat/completions') {
        req.headers['x-jena-origin'] = 'api';
        return await brain(req, res, '/v1/chat/completions', CHAT, 'JenaXI-chat');
      }
      return sendJSON(res, 404, { error: { message: 'Jena API has /v1/models and /v1/chat/completions' } });
    }
    if (req.method === 'POST' && /^\/jx0\/v1\/(chat\/)?completions$/.test(path)) return await brain(req, res, path, JX0, 'JenaXI-0');
    if (path.startsWith('/jx0/')) return await pass(req, res, JX0, req.url.slice(4));
    if (path === '/status') return sendJSON(res, 200, await status());
    if (path === '/brain/log') { const n = Math.min(+(new URLSearchParams(qs).get('n') || 20), 50); return sendJSON(res, 200, { stats, log: ring.slice(-n) }); }
    if (path.startsWith('/box/') || path === '/websockify') return await pass(req, res, `http://${DESK_HOST}:${DESK_PORT}`, req.url);
    return await pass(req, res, CHAT, req.url);
  } catch (e) {
    if (!res.headersSent) sendJSON(res, e.status || 502, { error: { message: 'jena gateway: ' + e.message } });
    else res.end();
  }
});
// websocket upgrades (noVNC stream) go straight through to her desktop agent
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(DESK_PORT, DESK_HOST, () => {
    let h = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) h += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(h + '\r\n'); if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
});
server.listen(PORT, '127.0.0.1', () => console.log(`jena gateway on 127.0.0.1:${PORT}`));
