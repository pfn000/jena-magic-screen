// Jena's brain socket. Her brain is JenaXI, her own model: a .gguf served by llama.cpp's
// llama-server (OpenAI-compatible). No outside AI, no hosted APIs, no keys.
//   JENA_LLM_BASE_URL  default http://127.0.0.1:8088/v1 (llama-server on her machine; a tunnel URL on Vercel)
//   JENA_LLM_MODEL     model name to send (llama-server ignores it; default "JenaXI")
//   JENA_LLM_API_KEY   optional, only if llama-server runs with --api-key
//   JENA_LLM_FORMAT    "jenaxi" (default): raw /v1/completions with her own chat tags <|mama|> … <|jena|>
//                      "chat": /v1/chat/completions with the persona prompt (for a bigger JenaXI later)
// Health: the endpoint is checked every 15 s (server.mjs runs the loop; on Vercel it's checked on demand,
// cached 15 s). The page badge reads /api/health and flips to "JenaXI online" by itself.
//
// Event stream (NDJSON, one JSON object per line):
//   {type:"meta", brain, model, online}       which brain answered
//   {type:"step", kind, text}                 a real step: notice, think (model reasoning), tool, feel
//   {type:"mood", value}                      happy|angry|sad|surprised|relaxed|neutral -> avatar expression
//   {type:"action", name, args}               a movement SHE chose, e.g. raiseArm ["left"]
//   {type:"say", text}                        her reply
//   {type:"status", text}                     brain state, e.g. offline
//   {type:"done"}
import { PERSONA } from './persona.js';

const env = (k) => (process.env[k] || '').trim();
export const DEFAULT_BASE = 'http://127.0.0.1:8088/v1';
export const OFFLINE = 'JenaXI-0 is training — brain offline';

export function endpoint() {
  return {
    base: (env('JENA_LLM_BASE_URL') || DEFAULT_BASE).replace(/\/+$/, ''),
    key: env('JENA_LLM_API_KEY'),
    model: env('JENA_LLM_MODEL') || 'JenaXI',
    format: env('JENA_LLM_FORMAT') || 'jenaxi',
  };
}

const headers = (p) => ({ 'Content-Type': 'application/json', ...(p.key ? { Authorization: `Bearer ${p.key}` } : {}) });

// ---------------- health ----------------
let health = { online: false, checkedAt: 0, detail: 'not checked yet', model: null };
let inflight = null;

export async function checkHealth() {
  if (inflight) return inflight;
  inflight = (async () => {
    const p = endpoint();
    const root = p.base.replace(/\/v1$/, '');
    let online = false, detail = '', model = null;
    try {
      // llama-server: /health is 200 once the model is loaded, 503 while loading
      const h = await fetch(`${root}/health`, { headers: headers(p), signal: AbortSignal.timeout(4000) });
      if (h.status === 200) online = true;
      else if (h.status === 503) detail = 'JenaXI is loading';
      else if (h.status === 404) {
        const m = await fetch(`${p.base}/models`, { headers: headers(p), signal: AbortSignal.timeout(4000) });
        online = m.ok;
        if (!m.ok) detail = `answered ${m.status}`;
      } else detail = `answered ${h.status}`;
      if (online) {
        try {
          const m = await fetch(`${p.base}/models`, { headers: headers(p), signal: AbortSignal.timeout(4000) });
          const d = await m.json();
          model = d?.data?.[0]?.id || d?.models?.[0]?.name || null;
        } catch {}
      }
    } catch (e) {
      detail = 'unreachable';
    }
    health = { online, checkedAt: Date.now(), detail: online ? 'answering' : detail || 'offline', model };
    return health;
  })().finally(() => { inflight = null; });
  return inflight;
}

export async function brainHealth(maxAgeMs = 15000) {
  if (Date.now() - health.checkedAt > maxAgeMs) await checkHealth();
  return health;
}

export function startHealthLoop(ms = 15000) {
  checkHealth();
  const t = setInterval(checkHealth, ms);
  t.unref?.();
  return t;
}

export function brainName() {
  return 'jenaxi';
}

export function brainChain() {
  return ['JenaXI'];
}

// ---------------- her own action tags ----------------
// JenaXI can move her own body by writing tags in her reply: [raise_left_arm] [raise_right_arm]
// [raise_both_arms] [lower_arms] [wave] [wave_left] [mood:happy] … They're stripped from what she says.
const TAGS = {
  raise_left_arm: { type: 'action', name: 'raiseArm', args: ['left'] },
  raise_right_arm: { type: 'action', name: 'raiseArm', args: ['right'] },
  raise_both_arms: { type: 'action', name: 'raiseArm', args: ['both'] },
  raise_arms: { type: 'action', name: 'raiseArm', args: ['both'] },
  lower_arms: { type: 'action', name: 'lowerArm', args: ['both'] },
  wave: { type: 'action', name: 'wave', args: ['right'] },
  wave_right: { type: 'action', name: 'wave', args: ['right'] },
  wave_left: { type: 'action', name: 'wave', args: ['left'] },
  look_left: { type: 'action', name: 'look', args: ['left'] },
  look_right: { type: 'action', name: 'look', args: ['right'] },
  tilt_left: { type: 'action', name: 'tilt', args: ['left'] },
  tilt_right: { type: 'action', name: 'tilt', args: ['right'] },
  nod: { type: 'action', name: 'nod', args: [] },
  shake_head: { type: 'action', name: 'shake', args: [] },
  fist: { type: 'action', name: 'fist', args: ['right'] },
};
const MOODS = ['happy', 'angry', 'sad', 'surprised', 'relaxed', 'neutral'];

export function extractTags(text) {
  const events = [];
  const clean = String(text).replace(/\[\s*([a-z_]+)(?:\s*:\s*([a-z]+))?\s*\]/gi, (all, tag, arg) => {
    tag = tag.toLowerCase();
    if (TAGS[tag]) { events.push(TAGS[tag]); return ''; }
    if ((tag === 'mood' || tag === 'face') && arg && MOODS.includes(arg.toLowerCase())) { events.push({ type: 'mood', value: arg.toLowerCase() }); return ''; }
    if (MOODS.includes(tag)) { events.push({ type: 'mood', value: tag }); return ''; }
    return all;
  }).replace(/[\u2581\u200b\u200c\u200d\ufeff]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return { text: clean, events };
}

function describe(input) {
  if (input.attachment) {
    const a = input.attachment;
    return `${input.user || 'mama'} dropped a file on you: "${a.name}" (${a.type || 'unknown type'}, ${Math.round((a.size || 0) / 1024)} KB).${input.message ? ' Note: ' + input.message : ''}`;
  }
  const where = input.source === 'twitch' ? `Twitch chat (#${input.channel || '?'})` : input.source === 'dm' ? 'a PRIVATE message (not on stream)' : 'the stage chat box';
  return `[${where}] ${input.user || 'someone'}: ${input.message}`;
}

// What JenaXI-0 was trained on: "<|mama|>hi jena\n<|jena|>HEY MAMA…"
function jenaxiPrompt(input) {
  const turns = [];
  for (const h of (Array.isArray(input.history) ? input.history.slice(-6) : [])) {
    if (!h?.content) continue;
    turns.push(h.role === 'assistant' ? `<|jena|>${h.content}` : `<|mama|>${h.content}`);
  }
  const msg = input.attachment ? describe(input) : input.message;
  turns.push(`<|mama|>${msg}`);
  return turns.join('\n') + '\n<|jena|>';
}

async function* sse(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!raw.startsWith('data:')) continue;
      const data = raw.slice(5).trim();
      if (data === '[DONE]') continue;
      try { yield JSON.parse(data); } catch {}
    }
  }
}

export async function* thinkEvents(input) {
  const p = endpoint();
  let h = await brainHealth();
  if (!h.online) h = await checkHealth(); // fresh look before saying she's offline
  if (!h.online) {
    yield { type: 'meta', brain: 'jenaxi', model: 'JenaXI', online: false };
    yield { type: 'status', text: h.detail === 'JenaXI is loading' ? 'JenaXI is waking up (model loading) — brain offline for a moment' : OFFLINE };
    yield { type: 'done' };
    return;
  }
  yield { type: 'meta', brain: 'jenaxi', model: 'JenaXI', online: true };

  const chatMode = p.format === 'chat';
  let r;
  try {
    r = await fetch(`${p.base}/${chatMode ? 'chat/completions' : 'completions'}`, {
      method: 'POST',
      headers: headers(p),
      body: JSON.stringify(chatMode
        ? { model: p.model, stream: true, temperature: 0.8, max_tokens: 300, messages: [{ role: 'system', content: PERSONA }, ...(input.history || []).slice(-10), { role: 'user', content: describe(input) }] }
        : { model: p.model, stream: true, temperature: 0.8, top_p: 0.95, max_tokens: 120, prompt: jenaxiPrompt(input), stop: ['<|mama|>', '<|system|>', '\n<|', '</s>'] }),
      signal: AbortSignal.timeout(process.env.VERCEL ? 25000 : 45000), // Vercel function limit is 30 s
    });
  } catch (e) {
    r = null;
  }
  if (!r || !r.ok || !r.body) {
    checkHealth();
    yield { type: 'status', text: r ? `JenaXI answered ${r.status} — no reply this time` : OFFLINE };
    yield { type: 'done' };
    return;
  }

  let content = '', reasoning = '';
  for await (const j of sse(r.body)) {
    const c = j.choices?.[0] || {};
    const d = c.delta || {};
    const rc = d.reasoning_content || d.reasoning;
    if (rc) {
      reasoning += rc;
      let k;
      while ((k = reasoning.search(/[.!?\n]\s/)) >= 0 && k > 30) {
        yield { type: 'step', kind: 'think', text: reasoning.slice(0, k + 1).trim() };
        reasoning = reasoning.slice(k + 1);
      }
    }
    content += d.content ?? c.text ?? '';
  }
  if (reasoning.trim()) yield { type: 'step', kind: 'think', text: reasoning.trim().slice(0, 400) };

  // Bigger JenaXI (chat format) may write THINK:/MOOD:/ACTION:/SAY: lines; JenaXI-0 just talks.
  const said = [];
  for (let line of content.replace(/<\|[a-z]+\|>/g, '').split('\n')) {
    line = line.trim();
    if (!line) continue;
    const m = line.match(/^(THINK|MOOD|ACTION|SAY)\s*:\s*(.*)$/i);
    if (!m) { said.push(line); continue; }
    const tag = m[1].toUpperCase(), v = m[2].trim();
    if (tag === 'THINK') yield { type: 'step', kind: 'think', text: v };
    else if (tag === 'MOOD') yield { type: 'mood', value: v.toLowerCase().replace(/[^a-z]/g, '') };
    else if (tag === 'ACTION') {
      const a = v.match(/^(\w+)\s*\(?\s*["']?(\w+)?["']?\s*\)?/);
      if (a) yield { type: 'action', name: a[1], args: a[2] ? [a[2]] : [] };
    } else said.push(v);
  }
  const { text, events } = extractTags(said.join(' '));
  for (const e of events) yield e;
  if (text) yield { type: 'say', text: text.slice(0, 600) };
  else yield { type: 'status', text: 'JenaXI answered with nothing this time' };
  yield { type: 'done' };
}

export async function thinkAll(input) {
  const out = [];
  for await (const e of thinkEvents(input)) out.push(e);
  return out;
}
