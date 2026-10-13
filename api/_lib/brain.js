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
import { boxLink, boxAuth, ttsToken } from './boxlink.js';

const env = (k) => (process.env[k] || '').trim();
export const DEFAULT_BASE = 'http://127.0.0.1:8088/v1';
export const OFFLINE = 'brain offline: her box is not reachable right now';

// The announced box (signed, fresh) wins; JENA_LLM_BASE_URL is only a fallback for other setups.
export async function endpoint() {
  const box = process.env.VERCEL || process.env.JENA_USE_BOX ? await boxLink() : null;
  return {
    box,
    base: (box ? box.url + '/v1' : env('JENA_LLM_BASE_URL') || DEFAULT_BASE).replace(/\/+$/, ''),
    key: env('JENA_LLM_API_KEY'),
    model: env('JENA_LLM_MODEL') || 'JenaXI',
    format: env('JENA_LLM_FORMAT') || 'jenaxi',
  };
}

const headers = (p) => ({ 'Content-Type': 'application/json', ...(p.key ? { Authorization: `Bearer ${p.key}` } : {}), ...(p.box ? boxAuth() : {}) });

// ---------------- health ----------------
let health = { online: false, checkedAt: 0, detail: 'not checked yet', model: null };
let inflight = null;

export async function checkHealth() {
  if (inflight) return inflight;
  inflight = (async () => {
    const p = await endpoint();
    const root = p.base.replace(/\/v1$/, '');
    if (process.env.VERCEL && !p.box && !env('JENA_LLM_BASE_URL')) {
      health = { online: false, checkedAt: Date.now(), detail: 'her box has not announced itself (box offline or tunnel down)', model: null, box: null };
      return health;
    }
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
      detail = p.box ? 'box announced but not answering' : 'unreachable';
    }
    health = { online, checkedAt: Date.now(), detail: online ? 'answering' : detail || 'offline', model, box: p.box ? { url: p.box.url, announcedAt: p.box.ts, via: p.box.via } : null };
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
  return ['JenaXI-chat', 'JenaXI-0'];
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

// what one of her skills really did for this message, put where her small brain actually follows it
function skillNote(s) {
  if (!s) return '';
  if (s.queued) return `\n\nRIGHT NOW your ${s.name} skill is running on your desktop for this message${s.name === 'ask_grok' ? ' (you are asking Grok on grok.com; the answer is Grok\'s and shows on your screen)' : ''}. Say you are on it. Do not make up the result.`;
  if (!s.ok) return `\n\nRIGHT NOW your ${s.name} skill tried and failed: ${s.summary}. Say so honestly. Do not make up a result.`;
  return `\n\nRIGHT NOW your ${s.name} skill just ran for real and found: ${s.facts}. Answer using ONLY these real results by their exact names and links. Say you found them with your skill. Never invent other names or links.`;
}

// memories her box recalled for this message (real saved notes, newest/most relevant first)
function memNote(m) {
  if (!m?.length) return '';
  return `\n\nThings you really remember (from your memory file): ${m.map((x) => x.fact).join(' | ')}. Use them only if they fit.`;
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
  // a skill result rides as the system turn (her box's gateway uses it in place of its short default persona)
  const note = skillNote(input.skill) + memNote(input.memories);
  if (note) turns.unshift(`<|system|>You are Jena (JenaXI), Saidie's AI: a chaotic, funny teen gremlin hacker girl. Saidie is mama. Never flirty.${note.replace(/\s+/g, ' ')}`);
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
  const p = await endpoint();
  let h = await brainHealth();
  if (!h.online) h = await checkHealth(); // fresh look before saying she's offline
  if (!h.online) {
    yield { type: 'meta', brain: 'jenaxi', model: null, online: false };
    yield { type: 'status', text: h.detail === 'JenaXI is loading' ? 'JenaXI is waking up (model loading) — brain offline for a moment' : `brain offline: ${h.detail}` };
    yield { type: 'done' };
    return;
  }
  // multi-model routing, as it actually happened for this message (run side by side where they can)
  const routes = [input.skill ? `${input.skill.name} skill (${input.skill.queued ? 'on her desktop' : 'ran on her box'})` : null, input.memories ? `memory (${input.memories.length} recalled)` : null].filter(Boolean);
  yield { type: 'step', kind: 'plan', text: `routing: ${routes.length ? routes.join(' + ') + ' in parallel → ' : ''}${input.skill?.ok && input.skill.say ? input.skill.name + ' writes the answer' : 'JenaXI-chat answers (JenaXI-0 is the backup)'}${input.skill?.name === 'ask_grok' ? ' · Grok is asked on her desktop, labelled as Grok' : ''}` };
  if (input.memories?.length) yield { type: 'step', kind: 'think', text: `remembered: ${input.memories.map((x) => x.fact).join(' · ').slice(0, 220)}` };
  if (input.skill) yield { type: 'step', kind: 'tool', text: input.skill.queued ? `using skill: ${input.skill.name} (${input.skill.summary && input.skill.summary !== 'queued on her desktop' ? input.skill.summary : 'on her desktop, results show there'})` : `using skill: ${input.skill.name} → ${input.skill.ok ? input.skill.summary : 'failed: ' + input.skill.summary}` };
  // critic / library skills write her answer themselves from real measurements and real passages (her 0.5B brain
  // garbles citations and numbers), so the chain shows every finding + fix + source and she says the skill's words
  if (input.skill?.ok && input.skill.say) {
    for (const s of input.skill.steps || []) yield { type: 'step', kind: 'think', text: s };
    const a = input.skill.asset;   // make_asset: show the real file she just made (served from her box)
    if (a && /^[\w.-]+\.(png|svg)$/.test(a.png || a.svg || '')) yield { type: 'step', kind: 'tool', text: `made ${a.title || a.kind || 'an asset'} (in her assets gallery)`, img: `/api/asset?name=${encodeURIComponent(a.png || a.svg)}` };
    yield { type: 'step', kind: 'status', text: `${input.skill.name} wrote this answer from ${input.skill.name === 'library_lookup' ? 'real passages in her library' : input.skill.name === 'roast_critique' ? 'real measurements + her library' : 'what it really did on her box'} (her small brain is not trusted with numbers and citations yet)` };
    yield { type: 'meta', brain: 'jenaxi', model: `skill:${input.skill.name}`, online: true };
    yield { type: 'mood', value: input.skill.name === 'roast_critique' ? (/Score: (10|9|8)\//.test(input.skill.say) ? 'surprised' : 'angry') : 'happy' };
    const t = String(input.skill.say).slice(0, 600);
    yield { type: 'say', text: t, voice: ttsToken(t) };
    yield { type: 'done' };
    return;
  }
  const chatMode = p.format === 'chat';
  const ask = (base, model) => fetch(`${base}/${chatMode ? 'chat/completions' : 'completions'}`, {
    method: 'POST',
    headers: { ...headers(p), 'X-Jena-Origin': String(input.source || 'stage').slice(0, 20), 'X-Jena-Mama': input.mama ? '1' : '0' },
    body: JSON.stringify(chatMode
      ? { model, stream: true, temperature: 0.8, max_tokens: 300, messages: [{ role: 'system', content: PERSONA + skillNote(input.skill) + memNote(input.memories) }, ...(input.history || []).slice(-10), { role: 'user', content: describe(input) }] }
      : { model, stream: true, temperature: 0.8, top_p: 0.95, max_tokens: 160, prompt: jenaxiPrompt(input), stop: ['<|mama|>', '<|system|>', '\n<|', '</s>'] }),
    signal: AbortSignal.timeout(process.env.VERCEL ? 22000 : 45000), // Vercel function limit is 30 s
  });
  const t0 = Date.now();
  let model = h.model || 'JenaXI-chat', r = null, why = '';
  try { r = await ask(p.base, model); } catch (e) { why = e.name === 'TimeoutError' ? 'timed out' : e.message; }
  if ((!r || !r.ok || !r.body) && p.box) {
    // JenaXI-chat failed: her small from-scratch JenaXI-0 answers instead (honestly labelled)
    yield { type: 'step', kind: 'feel', text: `JenaXI-chat ${r ? 'answered ' + r.status : why}; asking JenaXI-0 instead` };
    model = 'JenaXI-0';
    try { r = await ask(p.box.url + '/jx0/v1', model); } catch (e) { r = null; }
  }
  yield { type: 'meta', brain: 'jenaxi', model, online: true };
  if (!r || !r.ok || !r.body) {
    checkHealth();
    yield { type: 'status', text: r ? `${model} answered ${r.status} — no reply this time` : OFFLINE };
    yield { type: 'done' };
    return;
  }
  let content = '', reasoning = '', info = null;
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
    if (j.jena) info = j.jena;
  }
  yield { type: 'step', kind: 'tool', text: info?.routed ? `answered from her facts on her box (truth code, the model didn't guess)` : `${info?.model || model} answered on her box in ${((info?.ms ?? Date.now() - t0) / 1000).toFixed(1)} s${info?.usage ? ` · ${info.usage.completion_tokens} tokens` : ''}${info?.guarded ? ' · safety guard replaced the reply' : ''}` };
  if (reasoning.trim()) yield { type: 'step', kind: 'think', text: reasoning.trim().slice(0, 400) };
  if (info?.action) yield { type: 'step', kind: 'feel', text: `*${String(info.action).slice(0, 40)}*` };   // her gesture: shown, never spoken
  // her truth code (box/jena-truth.mjs): answered from facts, or caught herself making something up and cut it
  if (info?.routed) yield { type: 'step', kind: 'think', text: `answered from what i actually know (${String(info.routed).replace(/_/g, ' ')}), not a guess` };
  for (const c of (info?.caught || []).slice(0, 3)) yield { type: 'step', kind: 'feel', text: `${info.oops || 'wait… that\'s not right'}: "${String(c.s).slice(0, 120)}" (${c.why})` };

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
  // nothing fake: a link she "remembers" that no real source gave her is removed, and the chain says so
  const real = `${input.message || ''} ${input.skill?.facts || ''} ${input.skill?.top?.url || ''}`;
  let invented = 0;
  const cleaned = said.join(' ').replace(/<?(https?:\/\/[^\s<>)\]]+)>?/g, (m, u) => {
    const bare = u.replace(/[.,!?;:]+$/, '');
    if (real.includes(bare) || real.includes(bare.replace(/\/$/, ''))) return bare;
    invented++; return '[link removed]';
  });
  if (invented) yield { type: 'step', kind: 'status', text: `removed ${invented} link${invented > 1 ? 's' : ''} she made up (not from her search or your message)` };
  let { text, events } = extractTags(cleaned);
  // if her words skipped what her skill really found, the real top result rides along, labelled as the skill's
  const top = input.skill?.ok && input.skill.top;
  if (text && top?.url && !text.includes(top.url) && !(top.title && text.toLowerCase().includes(String(top.title).toLowerCase()))) text = `${text} (what my ${input.skill.name} skill really found: ${top.title ? top.title + ' ' : ''}${top.url})`;
  for (const e of events) yield e;
  if (text) { const t = text.slice(0, 600); yield { type: 'say', text: t, voice: ttsToken(t) }; }
  else yield { type: 'status', text: 'JenaXI answered with nothing this time' };
  yield { type: 'done' };
}

export async function thinkAll(input) {
  const out = [];
  for await (const e of thinkEvents(input)) out.push(e);
  return out;
}
