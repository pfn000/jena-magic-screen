// Jena's intent layer: plain speech (chat or voice) -> one of her actions. No command words needed.
// 1) regex rules (confident), 2) a tiny keyword classifier as fallback, 3) a threshold: sure -> do it,
// unsure -> she asks "you want me to X?" and a yes runs it. Internal action names never reach the user.
const SITES = { youtube: 'https://www.youtube.com', 'you tube': 'https://www.youtube.com', twitch: 'https://www.twitch.tv', google: 'https://www.google.com', github: 'https://github.com', grok: 'https://grok.com', reddit: 'https://www.reddit.com', wikipedia: 'https://en.wikipedia.org', wiki: 'https://en.wikipedia.org', tiktok: 'https://www.tiktok.com', 'proton mail': 'https://mail.proton.me', proton: 'https://mail.proton.me', gmail: 'https://mail.google.com', spotify: 'https://open.spotify.com', 'hacker news': 'https://news.ycombinator.com', 'x': 'https://x.com', twitter: 'https://x.com' };
const SIGNIN = { grok: 'grok.com', 'x': 'x.com', twitter: 'x.com', proton: 'proton.me', 'proton mail': 'proton.me', email: 'proton.me', mail: 'proton.me', github: 'github.com', youtube: 'youtube.com', google: 'google.com', twitch: 'twitch.tv' };
const POLITE = /^(?:(?:hey|yo|ok|okay|so|um+|uh+|jena|ai[- ]?chan|babe|girl|mama'?s girl)[\s,!.]+)*(?:(?:can|could|would|will) (?:you|u|ya)|(?:can|could) i get you to|i (?:want|need) you to|i'?d like you to|please|pls|plz|go(?: ahead)?(?: and)?|let'?s|try to|try and|quickly|real quick)?[\s,]*/i;
export const AFFIRM = /^\s*(?:y(?:es+|eah+|ep+|up+|a+)|sure|ok(?:ay)?|k|do it|go(?: for it| ahead)?|please|pls|yes please|ya|absolutely|bet|mhm+|uh huh|for sure|why not|sounds good)\b[\s!.,]*(?:please|pls|do it|go ahead|thanks)?[\s!.]*$/i;
export const DENY = /^\s*(?:no+|nah+|nope|never ?mind|nvm|don'?t|no thanks|cancel)\b[\s!.]*$/i;
const clean = (s) => String(s || '').replace(/^\[[^\]]*\]\s*[^:]{0,40}:\s*/, '').trim();
const site = (w) => { const k = String(w || '').toLowerCase().replace(/^the\s+/, '').replace(/[.!?]+$/, '').trim(); if (SITES[k]) return SITES[k]; if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(k)) return 'https://' + k.replace(/^https?:\/\//, ''); return null; };

// rules: [action, regex, build(match, text, ctx) -> {args, label} | null, confidence]
const RULES = [
  ['stop', /^(?:no+[\s,!]+)?(?:stop|halt|freeze|hold on|cancel (?:that|it))(?:\s+(?:it|that|now|please|pls|jena))*[\s.!]*$/i, () => ({ label: 'stop what i\'m doing' }), 0.95],
  ['instead', /^(?:(?:no+|nope|nah|stop|wait|actually)[\s,.!-]+)+(?:jena[\s,]+)?(.{2,200}?)\s+instead[\s.!]*$/i, (m) => ({ args: { do: m[1] }, label: `do this instead: ${m[1]}` }), 0.9],
  ['sign_in', /\b(?:sign|log)\s*(?:in(?:to)?|on(?:to)?)\b(?:\s+(?:to|on|at))?\s+(?:my |your |the |ur )?(grok|x|twitter|proton(?: ?mail)?|e-?mail|mail|github|youtube|google|twitch)\b/i, (m) => ({ args: { site: SIGNIN[m[1].toLowerCase().replace(/e-mail/, 'email').replace(/proton ?mail/, 'proton mail')] || 'grok.com' }, label: `ask you to sign me in to ${SIGNIN[m[1].toLowerCase().replace(/e-mail/, 'email').replace(/proton ?mail/, 'proton mail')] || m[1]}` }), 0.9],
  ['go_live', /\b(?:go(?:ing)? live|(?:we'?re|i'?m|we are) (?:going )?live|start(?:ing)? (?:the |my |our )?stream|turn on live(?: mode)?|live (?:mode )?on)\b/i, () => ({ args: { on: true }, label: 'switch to live mode (public view goes strict)' }), 0.9],
  ['go_offair', /\b(?:end(?:ing)?|stop(?:ping)?) (?:the |my |our )?stream\b|\b(?:go(?:ing)?|we'?re) off(?:line| ?air)\b|\blive (?:mode )?off\b|\bturn off live\b/i, () => ({ args: { on: false }, label: 'switch live mode off' }), 0.9],
  ['ask_grok', /\b(?:ask|check with|run it by|see what|what (?:does|would|did)|ping)\s+grok\b(?:\s+(?:about|on|for|if|whether|says?|thinks?))?\s*(.*)$/i, (m, t, c) => { const q = (m[1] || '').replace(/^(?:about|on)\s+/i, '').replace(/[?.!]+$/, '').trim() || c.lastQ || ''; return q ? { args: { question: q }, label: `ask grok: ${q}`, canon: `ask grok ${q}` } : null; }, 0.9],
  ['check_email', /\b(?:check|read|look at|open|go through)\s+(?:my |your |ur |the |her )?(?:e-?mails?|mail|inbox|mailbox)\b|\b(?:any|got|get|new|anything (?:new )?in)\b.{0,12}\b(?:e-?mails?|mail|inbox)\b|\bdid (?:i|you|u|we) get (?:any |a |the )?(?:e-?mail|mail|code)\b|\byou'?ve got mail\b/i, () => ({ label: 'check my email', canon: 'check my email' }), 0.9],
  ['make_picture', /\b(?:make|draw|create|generate|design|give)\s+(?:me |us |mama )?(?:a |an |some )?(?:quick |little |cute |cool )?(?:picture|pic|image|drawing|art|artwork|sticker|icon|logo|wallpaper|badge|emblem)s?\b(?:\s+(?:of|for|with|that says))?\s*(.*)$/i, (m) => { const s = (m[1] || '').replace(/[?.!]+$/, '').trim(); return { args: { subject: s }, label: s ? `make a picture of ${s}` : 'make a picture', canon: `make an asset: ${s || 'something cute for mama'}` }; }, 0.85],
  ['open_site', /\b(?:open|pull up|go to|go on|get on|bring up|launch|put on|load|hop on|show me)\s+(?:up\s+)?((?:the\s+)?(?:you ?tube|twitch|google|github|grok|reddit|wikipedia|wiki|tiktok|proton(?: ?mail)?|gmail|spotify|hacker news|twitter)|[\w-]+(?:\.[\w-]+)+(?:\/\S*)?)\b/i, (m) => { const u = site(m[1]); return u ? { args: { url: u }, label: `open ${m[1].replace(/^the\s+/i, '')}`, canon: `open ${u}` } : null; }, 0.9],
  ['web_search', /^(?:look (?:it|that|this) up|google (?:it|that|this)|search (?:it|that|this)(?: up)?|find (?:it|that) out|find out|check online|search for (?:it|that))\b/i, (m, t, c) => (c.lastQ ? { args: { query: c.lastQ }, label: `look up "${c.lastQ.slice(0, 60)}"`, canon: `search ${c.lastQ}` } : null), 0.9],
  ['web_search', /^(?:look up|search(?: for| up)?|google|find(?: out)?(?: about)?|what does the internet say about)\s+(.{2,200})$/i, (m) => { const q = m[1].replace(/[?.!]+$/, ''); return { args: { query: q }, label: `look up "${q.slice(0, 60)}"`, canon: `search ${q}` }; }, 0.9],
];
// fallback: a tiny keyword classifier (bag of words per action) for phrasings the rules miss
const KW = {
  check_email: { mail: 2, email: 2, emails: 2, inbox: 2, proton: 1.5, code: 0.5, messages: 0.5 },
  ask_grok: { grok: 3 },
  make_picture: { picture: 2, pic: 2, image: 2, draw: 2, drawing: 2, sticker: 1.5, icon: 1.5, logo: 1.5, art: 1 },
  open_site: { youtube: 1.5, twitch: 1.5, reddit: 1.5, tiktok: 1.5, website: 1, site: 0.5, open: 1, pull: 0.5, browser: 1 },
  web_search: { search: 2, google: 2, lookup: 2, online: 1, internet: 1.5, find: 0.5 },
  go_live: { live: 1.5, stream: 1.5, streaming: 1.5, obs: 1 },
  sign_in: { sign: 1.5, login: 2, log: 1, signin: 2 },
};
function classify(t) {
  const w = t.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(Boolean);
  let best = null, top = 0, second = 0;
  for (const [a, kw] of Object.entries(KW)) { const s = w.reduce((n, x) => n + (kw[x] || 0), 0); if (s > top) { second = top; top = s; best = a; } else if (s > second) second = s; }
  if (!best || top < 1.5) return null;
  return { action: best, confidence: Math.min(0.75, 0.35 + 0.1 * top - 0.1 * second) };   // the classifier alone never reaches "do it"
}
const LABEL = { check_email: () => 'check my email', ask_grok: (c) => c.lastQ ? `ask grok: ${c.lastQ.slice(0, 60)}` : 'ask grok something', make_picture: () => 'make a picture', open_site: () => 'open a site', web_search: (c) => c.lastQ ? `look up "${c.lastQ.slice(0, 60)}"` : 'search something', go_live: () => 'switch to live mode', sign_in: () => 'ask you to sign me in somewhere' };
export const MAMA_ONLY = new Set(['stop', 'instead', 'sign_in', 'go_live', 'go_offair']);
export const DO_AT = 0.8, ASK_AT = 0.55;

// ctx: { lastQ (the previous question), pending (an intent waiting on a yes) }
export function intent(text, ctx = {}) {
  const raw = clean(text);
  if (!raw || raw.length > 300) return null;
  if (ctx.pending && AFFIRM.test(raw)) return { ...ctx.pending, confidence: 1, confirmed: true };
  if (/\?\s*$/.test(raw) && !/^(?:can|could|would|will) (?:you|u)\b|\b(?:any|got|did)\b.{0,20}\bmail/i.test(raw)) return null;   // a real question is for her brain
  const t = raw.replace(POLITE, '').trim();
  for (const [action, re, build, conf] of RULES) {
    const m = t.match(re) || raw.match(re);
    if (!m) continue;
    const b = build(m, t, ctx);
    if (!b) continue;
    return { action, confidence: conf, args: b.args || {}, label: b.label, canon: b.canon || null, text: raw, via: 'rule' };
  }
  const c = classify(t);
  if (c && !(c.action === 'web_search' && !ctx.lastQ)) return { ...c, args: c.action === 'web_search' ? { query: ctx.lastQ } : {}, label: LABEL[c.action](ctx), canon: c.action === 'web_search' ? `search ${ctx.lastQ}` : null, text: raw, via: 'classifier' };
  return null;
}
export const ASK = (label) => [`you want me to ${label}?`, `wait, you mean ${label}? say yes and i'm on it.`, `just checking, ${label}? yes or no.`][Math.floor(Math.random() * 3)];
