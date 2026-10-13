// "what did you learn from mama today?" She always watches when mama uses her desktop (box/desktop/jena_mamawatch.py:
// video + action log + her written steps). Mama hears the steps; anyone else only hears THAT she watched.
import { boxAuth } from './boxlink.js';
export const ASK_MAMA_LEARN = /\b(?:what|anything|stuff|things?)\b.{0,20}\b(?:you|u|ya)\b.{0,12}\blearn(?:ed|t|ing)?\b.{0,12}\bfrom (?:mama|mom|mommy|me|watching (?:me|mama))\b|\bwhat did (?:you|u) (?:see|watch) (?:mama|me|mom) do\b|\blearned from mama\b/i;
export async function mamaLearned(bx, message, mama, key, onStream) {
  if (!ASK_MAMA_LEARN.test(String(message || ''))) return null;
  if (!mama) return null;   // public side: the box skill's public-safe line stands
  try {
    const r = await fetch(bx.url + '/box/tab-live/learned', { headers: { ...boxAuth(), 'X-Jena-Key': key || '' }, signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    const today = new Date().toISOString().slice(0, 10);
    const rows = (d.recent || []).filter((x) => String(x.when || '').startsWith(today));
    if (!rows.length) {
      const say = d.watching ? "I'm watching you right now, mama! I'll write down how you did it when you're done." : "nothing new from you today yet, mama. Whenever you use my desktop I watch, record it, and write down how you did it.";
      return { name: 'learned_from_mama', ok: true, summary: 'no mama sessions today', say, facts: say };
    }
    // on stream: just what she learned; the steps (window titles, what mama typed) stay off stream
    const lines = rows.slice(0, 3).map((x) => onStream ? x.title : `${x.title} (${x.when.slice(11)}): ${(x.steps || []).slice(0, 6).map((s) => s.replace(/^\[\d+:\d+\]\s*/, '')).join(' → ')}`);
    const say = `today I watched you ${rows.length} time${rows.length > 1 ? 's' : ''}, mama. ${lines.join(' | ')}. I saved the video and my notes so I can do it myself next time.`;
    return { name: 'learned_from_mama', ok: true, summary: `learned from mama: ${rows.length} session(s) today`, say, facts: say, private: true };
  } catch { return null; }
}
