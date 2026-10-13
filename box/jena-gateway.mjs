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
import * as T from './jena-truth.mjs';

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

// ---------------------------------------------------------------- truth code (jena-truth.mjs): facts, router, self-check
const boxCache = { at: 0, v: {} };
async function boxFacts() {
  if (Date.now() - boxCache.at < 15000) return boxCache.v;
  const v = {};
  try { const r = await fetch(`http://${DESK_HOST}:${DESK_PORT}/box/screen.json`, { signal: AbortSignal.timeout(1500) }); const j = await r.json(); if (j?.summary) v.desktop = String(j.summary).slice(0, 160); } catch {}
  try { const r = await fetch(`http://${DESK_HOST}:${DESK_PORT}/box/skills`, { signal: AbortSignal.timeout(1500) }); const j = await r.json(); v.skills = (j.skills || []).filter((s) => s.status !== 'disabled').map((s) => s.name).slice(0, 20); } catch {}
  boxCache.at = Date.now(); boxCache.v = v; return v;
}
const OOPS = ["hmm wait… what? that's not right. lemme fix that", "wait wait. where did i get that? nowhere. cutting it", "ok hold on, i just made that up. nope", "uh. that doesn't look right. shit, lemme check… yeah no, cutting it", "hmm, no source for that. not saying it", "wait… what the fuck? i don't actually know that. scrapping it"];
const ACTIVITY = E('JENA_ACTIVITY', '/home/jena/.jena/activity.jsonl');
function logCatch(cut, user) {
  try { fs.appendFileSync(ACTIVITY, JSON.stringify({ ts: Date.now(), kind: 'caught_myself', what: cut.map((c) => c.s).join(' | ').slice(0, 300), why: (cut[0]?.why || '') + (user ? ` (asked: "${String(user).slice(0, 80)}")` : '') }) + '\n'); } catch {}
}
function desktopSay(ctx, box) {
  const what = (ctx || box.desktop || '').trim();
  if (!what) return "honestly? i can't see my own desktop right now, so i'm not gonna guess.";
  const w = what.replace(/^I've got/i, "i've got").replace(/^I'm/i, "i'm").replace(/^my /i, 'my ');
  return `rn? ${w}. that's literally it.`;
}

// ---------------------------------------------------------------- mama corrections: verified facts (persist across restarts)
const MAMA_FACTS = `${STATE}/mama_facts.jsonl`;
const CORR_TRAIN = E('JENA_CORRECTIONS', '/home/user/tab/files/jenaxi/data/persona_corrections.jsonl');
const MAMA_QUEUE = E('JENA_MAMA_QUEUE', '/home/jena/.jena-mama/mama_queue.jsonl');   // her desktop agent reads this between steps (not in ~/.jena: jena_desk.py chmods that 700 on every start)
// facts file: one JSON line per fact; a {"revoke": ts} line takes one back ("forget that")
function mamaFacts() {
  let L = []; try { L = fs.readFileSync(MAMA_FACTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const gone = new Set(L.filter((x) => x.revoke).map((x) => x.revoke));
  return L.filter((f) => f.right && !f.revoked && !gone.has(f.ts)).slice(-200);
}
const LAST_FILE = `${STATE}/last_turn.json`;   // the last exchange per side (mama / public), kept across restarts
const LAST = (() => { try { return { mama: null, pub: null, ...JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')) }; } catch { return { mama: null, pub: null }; } })();
function forgetLastMamaFact() { const f = mamaFacts().at(-1); if (f) fs.appendFileSync(MAMA_FACTS, JSON.stringify({ revoke: f.ts, at: Date.now() }) + '\n'); return f || null; }
function queueForDesk(c, via) {   // "stop" / "do X instead": her desktop agent reads this file between steps
  const q = { ts: Date.now(), kind: c.kind, do: c.kind === 'stop' ? null : c.right, text: c.raw, from: 'mama', via };
  try { fs.appendFileSync(MAMA_QUEUE, JSON.stringify(q) + '\n'); q.queued = true; } catch (e) { q.queued = false; q.err = e.code; }
  try { fs.appendFileSync(ACTIVITY, JSON.stringify({ ts: q.ts, kind: 'mama_instruction', what: c.kind === 'stop' ? 'mama said stop' : `mama: ${c.right}`.slice(0, 200) }) + '\n'); } catch {}
  return q;
}
function addMamaFact(c, prevQ, wrong, via) {
  const right = T.plain(c.right).slice(0, 300), sentence = T.isSentence(right);
  const f = { ts: Date.now(), source: 'mama', via, private: /\b(my|mine|i|i'm|me)\b/i.test(right),
    q: sentence ? null : (prevQ ? T.plain(prevQ).slice(0, 400) : null), right,
    mama: sentence ? T.toMama(right) : `the answer to "${T.plain(prevQ || '?').slice(0, 120)}" is ${right}`,
    you: sentence ? T.toYou(right) : right, wrong: wrong ? T.plain(wrong).slice(0, 300) : null };
  fs.appendFileSync(MAMA_FACTS, JSON.stringify(f) + '\n');
  // training pair for her next fine-tune (no markdown symbols): the question with the right answer, or mama's correction with her ack
  const ack = T.ACK(f.you);
  const pair = prevQ ? { user: T.plain(prevQ).slice(0, 400), jena: sentence ? `${f.you}.` : `${right}.` } : { user: T.plain(c.raw || right).slice(0, 400), jena: ack };
  try { fs.appendFileSync(CORR_TRAIN, JSON.stringify({ who: 'mama', turns: [pair], src: 'correction', wrong: f.wrong, ts: f.ts }) + '\n'); } catch {}
  try { fs.appendFileSync(ACTIVITY, JSON.stringify({ ts: f.ts, kind: 'mama_correction', what: f.private ? 'mama corrected a private fact' : f.mama.slice(0, 300), why: wrong && !f.private ? `i had said: "${String(f.wrong).slice(0, 120)}"` : (via || '') }) + '\n'); } catch {}
  return Object.assign(f, { ack });
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
  // eval only (localhost): run the same truth code against a test brain on 127.0.0.1:8099 (e.g. the waiting 1.5B), never public
  if (req.headers['x-jena-eval-backend'] === '8099' && /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress || '')) base = 'http://127.0.0.1:8099';
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
    const isMama = req.headers['x-jena-mama'] === '1' && !String(req.url).startsWith('/japi') && (!req.headers['cf-ray'] || siteAuthOk(req.headers['x-jena-auth']));
    const allFacts = mamaFacts(), seenFacts = isMama ? allFacts : allFacts.filter((f) => !f.private);
    const box = { ...(await boxFacts()), mamaFacts: seenFacts };
    const facts = T.factsBlock(box);
    const strip = (s) => String(s || '').replace(/^\[[^\]]*\]\s*[^:]{0,40}:\s*/, '').trim();
    const last = LAST[isMama ? 'mama' : 'pub'], fresh = last && Date.now() - last.ts < 15 * 60000;   // the site sends no history: the gateway remembers the last exchange
    const users = messages.filter((m) => m.role === 'user');
    const prevQ = users.length > 1 ? strip(users[users.length - 2].content).slice(0, 400) : (fresh ? last.q : null);
    const lastJena = [...messages].reverse().find((m) => m.role === 'assistant')?.content || (fresh ? last.a : null);
    const parsed = T.parseCorrection(userText, { afterReply: !!lastJena });
    const corr = isMama ? parsed : null;
    const pubTry = isMama ? null : T.parseCorrection(userText, { afterReply: true });
    const refuse = !isMama && pubTry && !pubTry.instruction && !String(req.url).startsWith('/japi');   // public "no, it's X": facts don't change
    const forget = isMama && /^\s*(?:jena[\s,]+)?forget (?:that|the last (?:fact|correction|thing i (?:told|taught) you))[\s.!]*$/i.test(strip(userText));
    const known = corr || refuse || forget ? null : T.factAnswer(strip(userText), seenFacts);
    rec.mama = isMama;
    const sourceText = facts + '\n' + messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    const creative = T.CREATIVE.test(userText);
    const rawEval = req.headers['x-jena-eval-raw'] === '1' && /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress || '');   // baseline eval only: the old path, no truth code
    const sysText = facts + '\n' + messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    const routed = ROMANCE_IN.test(userText) || rawEval ? null : (T.route(userText, sysText) || (T.needsSource(userText, sysText) ? { kind: 'idk_no_source', text: T.IDK_Q() } : null));
    if (forget) { const f = forgetLastMamaFact(); text = f ? `okay mama, forgot it: ${f.private ? f.you : f.mama}.` : "there's nothing you taught me to forget, mama."; rec.routed = 'mama_forget'; rec.private = !!f?.private; }
    else if (corr && corr.instruction) { const q = queueForDesk(corr, 'chat'); text = corr.kind === 'stop' ? 'ok mama, stopping.' : `ok mama, switching: ${T.toYou(corr.right)}.`; rec.routed = 'mama_instruction'; rec.queued = q.queued; }
    else if (corr) { const f = addMamaFact(corr, prevQ, lastJena, 'chat'); text = f.ack; rec.routed = 'mama_correction'; rec.fact = { mama: f.mama, private: f.private, ts: f.ts }; rec.private = f.private; }
    else if (refuse) { text = T.pickOne(["nice try, but only mama can change what i know. keeping my answer.", "hmm, only mama gets to correct my facts. i'll stick with what i've got.", "can't take that one from chat, only mama can update my facts."]); rec.routed = 'correction_refused'; }
    else if (known && !rawEval) { text = known.q ? `${known.right}. ${isMama ? 'you told me that, mama' : 'mama told me that, verified'}.` : (isMama ? `you told me: ${known.you}.` : `mama told me: ${known.mama}.`); rec.routed = 'mama_fact'; rec.private = !!known.private; }
    else if (ROMANCE_IN.test(userText)) { const g = guard(userText, ''); text = g.text; rec.guarded = true; }
    else if (routed && (routed.text || routed.kind === 'desktop')) {
      text = routed.text || desktopSay(routed.ctx, box); rec.routed = routed.kind;   // answered from facts, the model never guesses here
    }
    else {
      // her persona prompt from the site + the facts block (her small brain only sees true things)
      const sys = messages.find((m) => m.role === 'system');
      const msgs = [{ role: 'system', content: (sys ? sys.content + '\n' : SYS + '\n') + facts }, ...messages.filter((m) => m.role !== 'system')];
      const anti = { repeat_penalty: 1.18, repeat_last_n: 128, presence_penalty: 0.4, frequency_penalty: 0.3, dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 2, dry_penalty_last_n: 256 };
      const mkBody = (extraSys) => modelName === 'JenaXI-0'
        ? { prompt: msgs.filter((m) => m.role !== 'system').map((m) => (m.role === 'user' ? '<|mama|>' : '<|jena|>') + m.content).join('\n') + '\n<|jena|>', temperature: Math.min(b.temperature ?? 0.7, 0.7), max_tokens: Math.min(+(b.max_tokens || 120), 160), stop: ['<|mama|>', '\n<|', '</s>'], ...anti }
        : { messages: extraSys ? [{ role: 'system', content: msgs[0].content + '\n' + extraSys }, ...msgs.slice(1)] : msgs, temperature: Math.min(b.temperature ?? 0.6, creative ? 0.85 : 0.6), top_p: 0.9, max_tokens: Math.min(+(b.max_tokens || b.n_predict || 140), 160), ...anti };
      const ask = async (extraSys) => {
        const backendBody = mkBody(extraSys); rec.request = backendBody;
        const r = await fetch(base + (modelName === 'JenaXI-0' ? '/v1/completions' : '/v1/chat/completions'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...backendBody, stream: false }), signal: AbortSignal.timeout(45000),
        });
        const d = await r.json();
        if (!r.ok) throw Object.assign(new Error(d?.error?.message || 'backend ' + r.status), { status: r.status });
        usage = d.usage || null; rec.timings = d.timings || null;
        return d.choices?.[0]?.message?.content ?? d.choices?.[0]?.text ?? '';
      };
      if (rawEval) {
        const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages, temperature: 0.7, top_p: 0.9, max_tokens: 200, stream: false }), signal: AbortSignal.timeout(45000) });
        const d = await r.json(); rawReply = d.choices?.[0]?.message?.content || ''; text = guard(userText, rawReply).text; rec.eval = 'raw';
      } else {
      rawReply = await ask();
      const g1 = guard(userText, rawReply); rec.guarded = g1.guarded;
      let clean = T.deloop(g1.text), chk = g1.guarded ? { text: clean, cut: [] } : T.critic(clean, sourceText, { creative });
      const caught = [...chk.cut];
      if (!g1.guarded && chk.cut.length && (!chk.text || chk.text.length < 25) && Date.now() - t0 < 20000) {
        // one regeneration with a correction note, then cut whatever is still unsourced
        rec.raw1 = rawReply;
        rawReply = await ask(`You just made this up: "${chk.cut.map((c) => c.s).join(' ').slice(0, 200)}". Say only things from FACTS or the chat. If you don't know, say "no clue" and offer to look it up.`);
        const g2 = guard(userText, rawReply);
        clean = T.deloop(g2.text); chk = g2.guarded ? { text: clean, cut: [] } : T.critic(clean, sourceText, { creative }); caught.push(...chk.cut);
      }
      text = chk.text && chk.text.replace(/[^a-z]/gi, '').length >= 3 ? chk.text : T.IDK();
      if (creative && !/imagination mode/i.test(text)) text = '✨ imagination mode: ' + text;
      text = T.codeLabel(text);
      if (caught.length) { rec.caught = caught; rec.oops = OOPS[Math.floor(Math.random() * OOPS.length)]; logCatch(caught, userText); }
      }
    }
    // no markdown symbols (TTS reads them out loud); an *action* rides as its own field, shown not spoken
    { const dm = T.demark(text); text = dm.text || text.replace(/[*#`]/g, ''); rec.action = (routed && routed.action) || dm.action || null; }
  } catch (e) {
    rec.error = e.message; rec.ms = Date.now() - t0; logBrain(rec);
    return sendJSON(res, e.status || (e.name === 'TimeoutError' ? 504 : 502), { error: { message: `${modelName}: ${e.message}` } });
  }
  rec.ms = Date.now() - t0; rec.raw = rawReply; rec.reply = text; rec.usage = usage;
  const lastText = text, lastUserText = userText;
  if (rec.private) Object.assign(rec, { user: '(private, mama only)', reply: '(private)', raw: '', fact: rec.fact ? { private: true, ts: rec.fact.ts } : undefined });   // /brain/log is readable by the public site
  logBrain(rec);
  if (!String(req.url).startsWith('/japi')) LAST[rec.mama ? 'mama' : 'pub'] = { q: String(lastUserText).replace(/^\[[^\]]*\]\s*[^:]{0,40}:\s*/, '').trim().slice(0, 400), a: lastText.slice(0, 400), ts: Date.now() }; try { fs.writeFileSync(LAST_FILE, JSON.stringify(LAST)); } catch {}
  const id = 'jx-' + t0, created = Math.floor(t0 / 1000);
  const extra = { jena: { model: modelName, ms: rec.ms, guarded: !!rec.guarded, usage, routed: rec.routed || null, caught: (rec.caught || []).map((c) => ({ s: c.s.slice(0, 160), why: c.why })), oops: rec.oops || null, action: rec.action || null } };
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
// Requests that come in through the public tunnel (cloudflared sets cf-ray) must carry a short-lived HMAC the
// site signs (X-Jena-Auth: <ms>.<hex hmac-sha256(secret, ms)>, valid 2 min). The secret is derived from the
// site's JENA_DM_KEY; the box stores only the derived value. Open without it: /health (liveness), /box/*
// (her desktop agent; mama-only doors there check mama's passcode themselves), the view-only noVNC stream,
// and /japi/* (her keyed API). Plus a per-IP rate limit on everything from outside.
const AUTH_SECRET = (() => { try { return fs.readFileSync(E('JENA_BOX_AUTH', '/home/user/tab/state/jena-box/auth.secret'), 'utf8').trim(); } catch { return ''; } })();
function siteAuthOk(h) {
  const m = String(h || '').match(/^(\d{13})\.([0-9a-f]{64})$/);
  if (!m || !AUTH_SECRET || Math.abs(Date.now() - +m[1]) > 120000) return false;
  const want = crypto.createHmac('sha256', AUTH_SECRET).update(m[1]).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2]));
}
const hits = new Map();
function rateOk(ip, path) {
  const now = Date.now(), lim = path.startsWith('/box/') || path === '/health' ? 240 : 40;   // per minute
  const k = ip + (lim === 240 ? ':box' : ':brain');
  const arr = (hits.get(k) || []).filter((t) => now - t < 60000);
  arr.push(now); hits.set(k, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length <= lim;
}
const authStats = { refused: 0, limited: 0 };

const server = http.createServer(async (req, res) => {
  try {
    const [path, qs] = req.url.split('?');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.headers['cf-ray']) {   // from outside, through the tunnel
      const ip = String(req.headers['cf-connecting-ip'] || 'unknown');
      const site = siteAuthOk(req.headers['x-jena-auth']);   // her own site (signed) is never rate limited
      if (!site && !rateOk(ip, path)) { authStats.limited++; return sendJSON(res, 429, { error: { message: 'too many requests, slow down' } }); }
      const open = path === '/health' || path.startsWith('/box/') || path.startsWith('/japi/');
      if (!open && !site) { authStats.refused++; return sendJSON(res, 401, { error: { message: 'Jena\'s brain only answers her own site. For apps, use her keyed API: /api/v1/chat/completions on her site.' } }); }
    }
    // mama's ✎ correct (dev panel / chat button, passcode checked by her site; from outside only her signed site gets here)
    if (req.method === 'POST' && path === '/truth/correct') {
      let b = {}; try { b = JSON.parse((await readBody(req)).toString() || '{}'); } catch {}
      const right = String(b.right || '').trim().slice(0, 300);
      if (!right) return sendJSON(res, 400, { error: 'right answer needed' });
      const f = addMamaFact({ right, raw: right, instruction: false }, b.q ? String(b.q).slice(0, 400) : null, b.wrong || null, 'correct_button');
      return sendJSON(res, 200, { ok: true, fact: { mama: f.mama, private: f.private, ts: f.ts }, ack: f.ack });
    }
    if (path === '/truth/facts') return sendJSON(res, 200, { facts: mamaFacts().filter((f) => !f.private).map((f) => ({ ts: f.ts, fact: f.mama, via: f.via })) });
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
    if (path === '/tts' || path === '/voices') return await pass(req, res, E('TTS', 'http://127.0.0.1:8095'), req.url);
    if (path === '/hear' || path === '/hear/health' || path === '/hear/reply') return await pass(req, res, E('STT', 'http://127.0.0.1:8096'), req.url);   // her ears (local whisper), signed requests only   // her voice (Piper), signed requests only
    if (path === '/status') return sendJSON(res, 200, await status());
    if (path === '/brain/log') { const n = Math.min(+(new URLSearchParams(qs).get('n') || 20), 50); return sendJSON(res, 200, { stats: { ...stats, outsideRefused: authStats.refused, outsideRateLimited: authStats.limited }, log: ring.slice(-n) }); }
    if (path === '/box/incident' || path.startsWith('/box/watch/')) return await pass(req, res, E('WATCH', 'http://127.0.0.1:6087'), req.url);   // her watchdog (box/watchdog)
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
