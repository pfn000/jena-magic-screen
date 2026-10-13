// Jena's meme knowledge + soundboard, on the brain path (api/_lib/brain.js).
// memeNote(): the 1-2 memes a message is actually about (from public/memes.json, sourced from Know Your Meme /
// Wikipedia), put where her small brain reads them, plus the sound cues she may use. pickSound(): a careful picker
// for the moment (only clear matches, else nothing). playCommand(): "jena play the vine boom" plays it for real.
import DATA from './memes-data.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
const STOP = new Set('what why you always lying road work ahead look all those chickens hello there welcome back again with white free real estate two big man not hot this woman yelling cat chungus sad violin continued error crickets minute who are wait very chill guy only time hmm notification prank nope think about safe damage shake boomer'.split(' '));
const SOUNDS = new Map(DATA.sounds.map((s) => [s.id, s]));
export const soundIds = () => [...SOUNDS.keys()];

export function findMemes(text, max = 2) {
  const t = ` ${norm(text)} `;
  const scored = [];
  for (const m of DATA.memes) {
    const name = norm(m.n).trim();
    let sc = t.includes(` ${name} `) ? 10 : 0;
    const hits = m.k.filter((k) => !STOP.has(k) && t.includes(` ${k} `)).length;
    if (hits) sc += hits / m.k.length * 6 + hits;
    if (sc >= 4) scored.push([sc, m]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, max).map((x) => x[1]);
}

export function memeNote(text) {
  const found = findMemes(text);
  const asksMeme = /\b(meme|memes|vine|brainrot|tiktok trend|shitpost)/i.test(text || '');
  if (!found.length && !asksMeme) return '';
  let s = '';
  if (found.length) s += `\n\nMeme facts you really know (from your meme file: Know Your Meme / Wikipedia): ${found.map((m) => `${m.n} (${m.y}): ${m.m} How people use it: ${m.u}.`).join(' | ')} Use these facts only; keep it kid-safe.`;
  else s += `\n\nIf it's a meme you don't know, say "idk that one" instead of guessing. Never explain sexual or hateful memes.`;
  const cues = [...new Set(found.map((m) => m.s).filter(Boolean))];
  if (cues.length) s += ` You may add ONE sound cue at the very end if it truly fits: ${cues.map((c) => `[sfx:${c}]`).join(' or ')}.`;
  return s;
}

// a sound cue she wrote in her reply: [sfx:vine-boom]
export function takeSfx(text) {
  let id = null;
  const t = String(text || '').replace(/\[\s*sfx\s*:\s*([a-z0-9-]+)\s*\]/gi, (all, x) => { if (!id && SOUNDS.has(x.toLowerCase())) id = x.toLowerCase(); return ''; }).replace(/\s{2,}/g, ' ').trim();
  return { text: t, id };
}

// the picker: a sound only when the moment clearly calls for it (her reply + what was said to her). Rate limits live
// on the page that plays it (src/soundboard.js), so a busy chat can never make it spammy.
const RULES = [
  [/\b(bruh|bro what)\b/i, 'bruh', 'a bruh moment'],
  [/\b(sus|suspicious|impostor|imposter)\b/i, 'among-us-sus', 'something sus'],
  [/\b(emotional damage)\b/i, 'emotional-damage', 'that roast'],
  [/\b(oof|ouch|rip)\b/i, 'roblox-oof', 'oof'],
  [/\b(plot twist|dun dun)\b/i, 'dun-dun-dun', 'plot twist'],
  [/\b(crashed|error|bluescreen|it broke|not responding)\b/i, 'windows-error', 'something crashed'],
  [/\b(we won|i won|let'?s go+|gg|clutch|victory)\b/i, 'mlg-airhorn', 'a win'],
  [/\b(huh\??|what\?{2,})$/i, 'huh-cat', 'confused'],
  [/\b(pun|ba dum)\b/i, 'ba-dum-tss', 'a pun'],
  [/\b(yay|we did it|good news)\b/i, 'yay', 'good news'],
  [/\bnope\b/i, 'nope', 'nope'],
  // rizz = a smug BRAG sound only (a W, a clutch, a flex, roasting chat); never flirting: a romantic line gets nothing
  [/\b(too easy|ez clap|built different|skill issue|get rekt|flex(?:ing)?|i'?m (?:just )?that good|big w)\b/i, 'rizz', 'a brag'],
  [/\b(hmm+)\b/i, 'minecraft-villager', 'hmm'],
  [/\b(wow+)\b/i, 'wow-owen-wilson', 'wow'],
];
export function pickSound(heard, said) {
  if (/\b(date|kiss|crush|cute|babe|marry|girlfriend|boyfriend|love you)\b/i.test(`${heard || ''} ${said || ''}`)) return null;   // never a sound on anything romantic
  for (const src of [said, heard]) {
    for (const [re, id, why] of RULES) if (re.test(String(src || ''))) return { id, why };
  }
  // a meme named outright ("skibidi toilet", "vine boom") gets its matching clip
  const t = ` ${norm(`${heard || ''} ${said || ''}`)} `;
  const m = DATA.memes.find((x) => x.s && t.includes(` ${norm(x.n).trim()} `));
  return m ? { id: m.s, why: m.n } : null;
}

// "jena play the vine boom" / "play bruh sound" / "!sfx bruh"
export function playCommand(text) {
  const m = String(text || '').match(/^\s*(?:jena[\s,]+)?(?:!sfx\s+|play\s+(?:the\s+|a\s+|that\s+)?)([a-z0-9 -]{2,40}?)(?:\s+(?:sound|sfx|sound effect|noise))?\s*[.!?]*\s*$/i);
  if (!m) return null;
  const want = norm(m[1]).trim().replace(/\s+/g, '-');
  if (SOUNDS.has(want)) return want;
  for (const s of SOUNDS.values()) if (s.id.startsWith(want) || s.id.replace(/-/g, ' ').includes(want.replace(/-/g, ' ')) || s.t.includes(want.replace(/-/g, ' '))) return s.id;
  return null;
}
