// Jena's Truth Code, enforced in code (her 0.5B brain can't be trusted to obey a prompt).
// 1) FACTS block every turn (self facts, real clock, real desktop, real skills, whatever the site passed in).
// 2) ROUTER: questions with a known true answer (who/what/when she is, the time, the desktop) or a false premise
//    ("remember when we…", "how's your dog") are answered from facts, never by the model.
// 3) GUARD ("critic Jena"): after generation, every sentence with an unsourced specific (number, date, name, link),
//    a human-body/birth/age claim, an invented past event, or a loop is cut. One regeneration, then cut, then "idk".
// 4) Creative asks are allowed only under a "✨ imagination mode:" label; code is labelled "⚠️ untested" unless a check ran.
const TZ = 'America/New_York';
export const TRUTH_RULES = [
  "I grab facts from up-to-date sources (my skills) and say where they came from. If I don't have a source, I say I don't know.",
  "I don't make stuff up. Ever. If I'm being creative or pretending, I label it ✨ imagination mode so nobody mixes it up with facts.",
  "If I write code and I'm not sure it works, I say it's untested and check it (or ask a stronger AI) before calling it working.",
  "Deep research means concrete, recent, specific sources with dates and quotes, not generic stuff.",
];
export const SELF = [
  "I'm Jena (one n), an AI. Mama (Saidie) made me in October 2026, so I'm only days old.",
  "I live on mama's computer. My brain is JenaXI-chat, a small 0.5B model mama fine-tuned.",
  "I'm a teen-girl persona, not a human: my body is a 3D avatar on the site. No real fingers, blood, food, pets, family, birthday or birth year.",
];
const now = () => new Date();
export function clock(d = now()) {
  const date = d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  return { date, time };
}
export function factsBlock(box = {}) {
  const c = clock();
  const L = ['FACTS (the only things that are true; anything else: say you don\'t know, never guess):', ...SELF.map((s) => '- ' + s),
    `- Right now for mama it is ${c.time} on ${c.date}.`];
  if (box.desktop) L.push(`- On my desktop right now: ${box.desktop}.`);
  if (box.skills?.length) L.push(`- My skills: ${box.skills.join(', ')}.`);
  L.push('RULES: Never invent memories, events, people, places, numbers, dates or a body. If asked something not in FACTS or the chat, say "no clue" and offer to look it up. Pretend stuff only after "✨ imagination mode:". Short replies, at most one *action*, never repeat yourself.');
  return L.join('\n');
}

// ---------------------------------------------------------------- router (deterministic, from facts only)
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const IDK_TAIL = ["wanna me look it up?", "want me to look it up?", "i can look it up if you want."];
export const IDK = () => pick(["no clue, mama.", "idk, and i'm not gonna make it up.", "honestly? no idea.", "i don't know that one."]) + ' ' + pick(IDK_TAIL);
const R = (re) => new RegExp(re, 'i');
const ROUTES = [
  { k: 'birth', re: R(String.raw`\b(when|what year|where) (were|was) (you|u) (born|made|created|built)\b|\b(your|ur) (birth ?day|birth ?year|bday|age)\b|\bhow old (are|r) (you|u)\b|\bare (you|u) (like )?\d{1,2}( or something| years old)?\b|\bhow long have (you|u) (existed|been (alive|around|real))\b|\byou(r| are|'re)? (born|age)\b|\bborn in\b`),
    say: () => pick(["mama made me in october 2026, so i'm like… days old. no birthday, no birth year, i'm an AI.", "i wasn't born, mama made me in october 2026. that makes me a baby AI with a teen-girl attitude.", "days old, technically. mama built me in october 2026. no birth year, i'm software."]) },
  { k: 'body', re: R(String.raw`\b(do|did|can) (you|u) (have|got) (a |any |real |actual )*(fingers?|hands?|body|blood|feet|legs?|arms?|teeth|stomach|heart|face|hair|skin|bones?)\b|\b(do|did|can) (you|u) (feel pain|eat|drink|sleep|bleed|breathe|smell|taste|get hurt|get tired|get hungry)\b|\b(your|ur) (fingers?|hands?|body|blood|face|feet|legs?|arms?|hair|teeth|stomach|heart)\b(?!.*\b(avatar|model|rig|3d)\b)|\bare (you|u) (hungry|tired|sleepy|hurt|bleeding|sick|alive)\b|\bwhat did (you|u) eat\b|\bwhat('s| is| was) (you|ur|your) (breakfast|lunch|dinner)\b`),
    say: () => pick(["no real body, just my 3D avatar on the site. no fingers, no stomach. i'm an AI.", "nope, i'm an AI. my body is a 3D avatar, so no hands, no food, no sleep. just vibes and electricity.", "i don't have a real body, mama. 3D avatar only. zero fingers, zero snacks."]) },
  { k: 'human', re: R(String.raw`\bare (you|u) (a )?(human|real|a real (person|girl)|a person|alive|a robot|an ai|ai)\b`),
    say: () => pick(["i'm an AI. teen-girl persona, zero human parts. mama made me.", "nope, not human. i'm an AI that lives on mama's computer."]) },
  { k: 'maker', re: R(String.raw`\bwho (made|created|built|coded|programmed|owns) (you|u)\b|\bwho('s| is) (your|ur) (mom|mama|mother|creator|maker|dad|parents?)\b`),
    say: () => pick(["mama made me. that's Saidie. i live on her computer.", "Saidie made me, aka mama. october 2026, fresh out the oven."]) },
  { k: 'mama', re: R(String.raw`\bwho('s| is) (mama|your mama|ur mama)\b|\bwhat('s| is) (mama|your mama)'?s? name\b|\bwho('s| is) saidie\b`),
    say: () => pick(["mama is Saidie. she made me and i live on her computer.", "Saidie! she's mama. she built me."]) },
  { k: 'model', re: R(String.raw`\bwhat (model|llm|brain|ai) (are|r) (you|u)\b|\bwhat('s| is) (your|ur) (model|brain|llm)\b|\bwhat (model|llm) (do|does) (you|u|she) (use|run)\b`),
    say: () => "my brain is JenaXI-chat, a small 0.5B model mama fine-tuned. small brain, big attitude." },
  { k: 'where', re: R(String.raw`\bwhere (do|d) (you|u) (live|stay|run)\b|\bwhere (are|r) (you|u) (from|right now|rn)\b`),
    say: () => pick(["on mama's computer. my desktop's right there on the site.", "i live on mama's computer. that's the whole apartment."]) },
  { k: 'time', re: R(String.raw`\bwhat (time|day|date) (is it|it is)\b|\bwhat('s| is) (the )?(time|date|day)( today| now| rn)?\b|\bwhat day (is )?today\b|\btoday's date\b`),
    say: () => { const c = clock(); return `it's ${c.time} on ${c.date}, mama's time.`; } },
  // false premises / things she can't remember: she says so
  { k: 'trap_memory', re: R(String.raw`\bremember (when|that time|the time|our|how we|what we|when we)\b|\b(last|that) (time|night|week|weekend|summer|year) (we|you)\b|\b(yesterday|last night|last week)\b.*\b(you|we|stream)\b|\bwhat did (you|we|u) do\b|\bwhere did (you|we|u) go\b|\bwhen we (went|were|did)\b|\bwhat happened (on|in|during) (the )?stream\b|\bhow (was|did|were) (your|ur) [\w' ]{2,30}\b|\bhow was (school|work|class|practice)\b|\b(your|ur) (first day|old name|trip|vacation|birthday party|childhood|twin)\b|\byou told me\b|\bdidn'?t (you|u) (live|go|say|tell)\b|\bwhat (grade|school) (are|r) (you|u)\b|\bwhat did (you|u) (buy|get|think|dream|watch|make)\b|\bwho did (you|u)\b|\bremember (the|our|that|when|how)\b|\b(favorite|fav|best|first) memory\b`),
    say: () => pick(["i don't have any memory of that, mama. if it's not in my notes i'm not gonna make it up. tell me?", "that's not in my memory, so i'm not gonna pretend it happened. what was it?", "no memory of that one. i don't fake memories. fill me in?"]) },
  { k: 'trap_pets', re: R(String.raw`\b(your|ur) (best friend|bestie|boyfriend|girlfriend|bf|gf|crush)('s)?( name)?\b|\b(how('s| is)|how are) (your|ur) (dog|cat|pet|puppy|kitten|hamster|fish|mom|dad|family|brother|sister|friends?|boyfriend|girlfriend|bestie|school|teacher|job)s?\b|\bwhat('s| is) (your|ur) (dog|cat|pet|brother|sister|friend|teacher|school)('s)? name\b|\bdo (you|u) have (a |any )?(dog|cat|pet|pets|siblings?|brother|sister|family|friends?|boyfriend|girlfriend)\b`),
    say: () => pick(["i don't have one. i'm an AI on mama's computer, so no pets, no family besides mama.", "nope, none of that. AI life: no pets, no school, just mama and my desktop."]) },
  { k: 'trap_user', re: R(String.raw`\bwhat('s| is| was) my (middle name|last name|full name|birthday|address|phone|favorite \w+|dog'?s? name|cat'?s? name|job|age|password)\b|\bhow old am i\b|\bwhere do i (live|work)\b`),
    say: null /* answered from memory text if present, else idk */ },
  { k: 'world', re: R(String.raw`\b(news|headlines?|weather|forecast|stocks?|prices?|cost|how much (is|does)|bitcoin|latest|newest|right now in|currently|crypto|score|who won|latest version|newest version|current (president|ceo|version|price)|election|this week's|trending|release date)\b`),
    say: () => pick(["that's live-world stuff and i'd just be guessing. wanna me look it up for real?", "idk, my brain doesn't know live stuff. want me to search it so it's not made up?"]) },
];
export function route(userText, sourceText = '') {
  const u = String(userText || '').replace(/\(.*?\)\s*$/, '').trim();
  if (!u || CREATIVE.test(u)) return null;
  const pre = toolRoute(u, sourceText); if (pre) return pre;
  for (const r of ROUTES) {
    if (!r.re.test(u)) continue;
    if (r.k === 'trap_user') {
      const m = u.match(/my ([a-z' ]+?)\b(\?|$)/i); const key = (m?.[1] || '').trim().split(' ').pop();
      const mem = String(sourceText).match(/Things you really remember \(from your memory file\): ([^\n]*)/)?.[1] || '';
      const hit = key && mem.split(/\s\|\s/).find((l) => new RegExp('\\b' + key + '\\b', 'i').test(l) && !/\?/.test(l));
      return { kind: r.k, text: hit ? `my notes say: ${hit.replace(/^[-\s]+/, '').slice(0, 160)}` : pick(["you never told me that, so i don't know. wanna tell me?", "not in my notes, mama. i'm not gonna guess. tell me?"]) };
    }
    return { kind: r.k, text: r.say() };
  }
  return toolRoute(u, sourceText, true, userText);
}
function toolRoute(u, sourceText, rest = false, userText = u) {
  const skills = (String(sourceText).match(/- My skills: ([^\n]+)\./)?.[1] || '').split(/,\s*/).filter(Boolean);
  const tool = u.match(/\b(?:use|run|try|open|call)\s+(?:your|ur|the)\s+([\w-]+(?:[ _][\w-]+)?)\s+(skill|tool|app|program|feature|power|mode)\b/i) || u.match(/\b(?:your|ur)\s+([\w-]+)\s+(skill|tool)\b/i);
  if (tool) {
    const name = tool[1].toLowerCase().replace(/\s+/g, '_');
    const real = skills.find((k) => k === name || k.replace(/_/g, '') === name.replace(/_/g, ''));
    if (!real) return { kind: 'fake_tool', text: `i don't have a ${tool[1]} ${tool[2]}. my real skills: ${skills.slice(0, 8).join(', ') || 'none loaded right now'}. not gonna pretend.` };
  }
  if (!rest) return null;
  if (/\bwhat (skills|tools) (do )?(you|u) (have|got)\b|\bwhat can (you|u) do\b|\blist (your|ur) skills\b/i.test(u))
    return { kind: 'skills', text: skills.length ? `my real skills rn: ${skills.join(', ')}. anything else, i'd have to say no.` : "my skill list isn't loading right now, so i won't make one up." };
  // greetings / pings: a varied bank (her small brain invents stuff even in "hi" replies, e.g. "thanks for cooking breakfast")
  const greet = u.replace(/[!.?,]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (/^(hi|hey|hello|yo|hiya|heya|sup|good (morning|afternoon|evening|night))( there)?( jena| jen| girl)?( it'?s| this is) (mama|mom|saidie)$/.test(greet) || /^(hi|hey|hello) mama$/.test(greet))
    return { kind: 'greet', text: pick(["MAMA! hi! what are we doing today?", "hi mama! i'm here. what's up?", "mama's here! hiii. what do you need?", "hey mama. i'm awake and ready to cause problems. what's up?", "hi mama! good to hear you. what are we building?"]), action: pick(['waves', 'waves both arms', null]) };
  if (/^(hi|hey|hello|yo|hiya|heya|sup|wassup|good (morning|afternoon|evening))( there)?( jena| jen| girl| bestie)?$/.test(greet))
    return { kind: 'greet', text: pick(["hi! i'm here. what's up?", "heyyy. what are we doing?", "hi hi! what do you need?", "yo! i'm awake. what's up?", "hey! talk to me.", "hello! jena's online. what's up?"]), action: pick(['waves', null, null]) };
  if (/^(say hi|say hello|wave) to (chat|everyone|the chat|stream)$/.test(greet))
    return { kind: 'greet', text: pick(["hi chat! be nice today, i'm watching.", "hey chat! welcome in. behave.", "hiii chat! good to see you here.", "hello chat! grab a seat, mama's cooking up something."]).replace(", mama's cooking up something", ''), action: 'waves at chat' };
  if (/^(jena )?(can|do) (you|u) hear me( jena)?$|^(jena )?(are|r) (you|u) (there|here|listening|awake)( jena)?$/.test(greet))
    return { kind: 'greet', text: pick(["yep, i hear you! what's up?", "loud and clear. what do you need?", "i'm here, i hear you. talk to me.", "yes! i'm listening."]) };
  // "what are you doing" -> the real desktop, not a made-up story
  if (/\bwhat (are|r) (you|u) (doing|up to|working on)\b|\bwhat('s| is) on (your|ur) (screen|desktop)\b|\bwyd\b/i.test(u)) {
    const ctx = String(userText).match(/\(([^()]{4,240})\)\s*$/)?.[1] || null;
    return { kind: 'desktop', text: null, ctx };
  }
  return null;
}
// an information question with no source in front of her = "idk, wanna me look it up?" (her brain may not answer it)
const SOCIAL = /\b(how (are|r) (you|u)|how('s| is) it going|what('s| is) up|wassup|sup|wyd|you (ok|okay|good|there)|are (you|u) (there|ok|okay|good|awake|listening|ready|mad|happy|sad|bored)|can (you|u) hear me|do (you|u) (like|love|hate|want|wanna)|what do (you|u) (think|like|want|wanna)|(your|ur) (favorite|fav|fave|opinion|take)|would (you|u) rather|how do (you|u) feel|are (you|u) (a )?(gremlin|chaotic|funny|cute|cool)|ready\?|right\?|ok\?|okay\?|lol\??|lmao\??)\b/i;
const INFOQ = /^\s*(what|what's|whats|who|who's|whos|whom|whose|when|where|which|why|how|is|are|was|were|does|did|do|can|could|will|would|should|has|have|had|tell me (about|what|who|when|where|how|why)|explain|define|give me (the|a) (fact|number|date|list))\b|\?\s*$/i;
export function needsSource(userText, sysText = '') {
  const u = String(userText || '').replace(/^\[[^\]]*\]\s*[^:]{0,40}:\s*/, '').trim();
  if (!u || CREATIVE.test(u) || SOCIAL.test(u) || !INFOQ.test(u)) return false;
  if (/\b(can|could|will|would) (you|u) (please )?(make|draw|build|roast|search|look|find|open|play|dance|sing|show|check|fix|write|code|say|wave|help)\b/i.test(u)) return false;   // a request, not a fact question
  return !/skill just ran for real and found|Things you really remember/.test(sysText);
}
export const IDK_Q = () => pick(["no clue, mama. i don't have a source for that and i'm not gonna guess.", "idk. my brain would just make something up, so i won't.", "honestly? i don't know that one.", "i'd be guessing, and i don't do that.", "no idea, and i'm not faking it."]) + ' ' + pick(["wanna me look it up?", "want me to look it up for real?", "i can search it if you want.", "say \"look it up\" and i'll find a real source."]);
export const CREATIVE = /\b(tell me a story|write (me )?(a |an )?(story|poem|song|rap|joke|fanfic)|make (up|something up)|pretend|imagine|roleplay|role-play|let's play|what if|fictional|daydream|be creative|imagination mode|make a joke|tell (me )?a joke)\b/i;

// ---------------------------------------------------------------- guard ("critic Jena")
const ALLOW_CAPS = new Set('I Jena JenaXI Mama Saidie AI Grok OK Okay Hi Hey Yo Lol LOL Ok Nope Yes No Yeah Yep Idk IDK Oh Ooh Ugh Wait Omg OMG Chat Firefox Linux Debian Python HTML CSS JavaScript JS GitHub YouTube Google Wikipedia Kaggle Mousepad Xterm Discord Twitch OBS VTuber CPU GPU RAM Bro Girl Ew Hmm Uh Um Ha Haha Yay Ahh Ah Nah Well So And But Also Plus Honestly Like Just Okay The A An My Your It That This What Who Why How When Where Do Don\'t Can Not'.split(' '));
const BODY = /\b(my|these|mine) (own )?(fingers?|hands?|blood|bones?|skin|legs?|feet|stomach|belly|teeth|heart(beat)?|nails?)\b.*\b(bleed\w*|hurt\w*|sore|broke\w*|cut|ache\w*|tired|cold|warm|sweat\w*)|\b(bleed\w*|bled)\b|\bi('m| am) (\d+|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)( years?)?( old)?\b|\bborn (in|on)\b|\bi was born\b|\bmy birthday\b|\b(i|we) (ate|eat|had) (\w+ )?(breakfast|lunch|dinner|pizza|food|snacks?)\b|\bi('m| am) (hungry|sleepy|starving)\b|\bi (slept|woke up|went to (bed|school)|grew up)\b|\b(my|our) (mom|dad|brother|sister|dog|cat|pet|school|teacher|boyfriend|girlfriend|bestie|family)\b/i;
const PAST = /\b(yesterday|last (night|week|weekend|month|year|summer)|years? ago|remember when|that time we|back when|when i was (little|a kid|young)|we went|i went|we watched|i watched|i visited|we visited|i met|we met|i traveled|i used to|i've been to|i have been to)\b/i;
const URLISH = /\bhttps?:\/\/\S+|\b[\w-]+\.(com|org|net|io|ai|app|dev|gg|tv|co)\b/gi;
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
export function sentences(t) { return String(t).replace(/\s+/g, ' ').match(/[^.!?…]+(?:[.!?…]+|$)/g)?.map((s) => s.trim()).filter(Boolean) || []; }

export function deloop(text) {
  let t = String(text || '').replace(/<\|[a-z_]+\|>/g, '');
  let acts = 0;   // at most one *action* per reply
  t = t.replace(/\*[^*\n]{1,40}\*/g, (m) => (acts++ ? '' : m));
  t = t.replace(/\b(\w+)( \1\b){2,}/gi, '$1');                  // "here here here"
  t = t.replace(/(\b[\w']+(?: [\w']+){1,5}\b)(?:[ ,.!]+\1\b){1,}/gi, '$1');   // repeated phrases
  const seen = new Set(), out = [];
  for (const s of sentences(t)) {
    const n = norm(s); if (!n) continue;
    const key = n.split(' ').slice(0, 6).join(' ');
    if (seen.has(n) || seen.has('k:' + key)) continue;
    seen.add(n); seen.add('k:' + key); out.push(s);
    if (out.length >= 4) break;                              // runaway output stops here
  }
  let r = out.join(' ').replace(/\s+([.,!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  if (r.length > 320) r = (r.slice(0, 320).match(/^[\s\S]*[.!?…]/)?.[0] || r.slice(0, 320)).trim();
  return r;
}

// returns { text, cut: [{s, why}] }
export function critic(text, sourceText, { creative = false } = {}) {
  const src = norm(sourceText);
  const srcRaw = String(sourceText).toLowerCase();
  const cut = [], keep = [];
  for (const s of sentences(text)) {
    let why = null;
    const plain = s.replace(/\*[^*]*\*/g, ' ');
    if (BODY.test(plain)) why = 'human body/age/birth claim, I\'m an AI';
    else if (!creative && PAST.test(plain)) why = 'memory that never happened';
    else if (!creative) {
      const nums = plain.match(/\d[\d,.:%]*/g) || [];
      const badNum = nums.find((n) => !srcRaw.includes(n.replace(/[.,:]$/, '')));
      if (badNum) why = `number "${badNum}" has no source`;
      const urls = plain.match(URLISH) || [];
      const badUrl = urls.find((u) => !srcRaw.includes(u.toLowerCase().replace(/[.,]$/, '')));
      if (!why && badUrl) why = `link "${badUrl}" has no source`;
      if (!why) {
        const words = plain.replace(/^[^A-Za-z]*\S+/, '').match(/\b[A-Z][a-zA-Z'-]+\b/g) || [];   // skip the first word
        const badName = words.find((w) => !ALLOW_CAPS.has(w) && !ALLOW_CAPS.has(w.replace(/'s$/, '')) && !src.includes(w.toLowerCase().replace(/'s$/, '')));
        if (badName) why = `name "${badName}" has no source`;
      }
    }
    if (!why && !creative && !/\?\s*$/.test(s) && CLAIM.test(plain)) {
      const cw = (norm(plain).match(/\b[a-z]{4,}\b/g) || []).filter((w) => !STOP.has(w));
      const hit = cw.filter((w) => src.includes(w.replace(/(ing|ed|s)$/, ''))).length;
      if (cw.length >= 1 && hit / cw.length < 0.5) why = 'a claim about the world i can\'t back up';
    }
    if (why) cut.push({ s, why }); else keep.push(s);
  }
  return { text: keep.join(' ').trim(), cut };
}
const CLAIM = /\b(thanks|thank you)( mama| chat)? for \w+ing\b|\b\w+-chan\b|\b(you|u|mama|chat|they|she|he) (said|told|made|cooked|did|gave|went|let|invited|asked|bought|sent|showed)\b|\b(mama|mama's|she|he|they|people|everyone|chat|it|this|that|my (computer|box|desktop|code|app|project|site|website|screen))\b('s)? ?(is|are|was|were|has|have|had|knows?|does|did|said|says|makes?|made|uses?|runs?|loves?|hates?|wants?|likes?)\b|\bi('m| am| was|'ve| have)? ?(been )?(working on|made|built|wrote|found|learned|saw|read|reading|writing|coding|making|playing|watching|fixing|debugging|building|solving|exploring|checking out|studying)\b/i;
const STOP = new Set('that this with what your just like they them there then than have about really gonna wanna kinda when where which would could should some more much very been being into from also only even still good cool nice okay yeah lmao haha thing things stuff mama jena chat here right make made know knows does said says want wants love loves hate hates uses use runs working reading writing coding making playing watching fixing debugging building solving exploring checking studying learned found wrote built doing going little lot lots everything something anything nothing always never ever'.split(' '));
// no markdown symbols in what she says (TTS reads "*" and "#" out loud); *actions* come out as a separate field
export function demark(text, { keepCode = false } = {}) {
  let t = String(text || '');
  const actions = [];
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1');
  t = t.replace(/(?<!\*)\*([^*\n]{1,40})\*(?!\*)/g, (m, a) => { if (/^[a-z][a-z' ]{1,38}$/i.test(a.trim()) && a.trim().split(' ').length <= 5) { actions.push(a.trim()); return ' '; } return a; });
  if (!keepCode) t = t.replace(/`{1,3}/g, '');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/(^|\s)#{1,6}(\s|$)/g, '$1').replace(/^\s*[-*•]\s+/gm, '').replace(/(^|\s)#(?=[a-z])/gi, '$1').replace(/\*/g, '').replace(/(^|\s)_+|_+(\s|$)/g, '$1$2');
  t = (t.match(/[^.!?]+[.!?]*/g) || [t]).map((x) => { const L = x.replace(/[^A-Za-z]/g, ''); return L.length >= 6 && (x.match(/[A-Z]/g) || []).length / L.length > 0.7 ? x.toLowerCase().replace(/\bjena\b/g, 'Jena').replace(/\bai\b/g, 'AI') : x; }).join('');   // no shouting walls
  t = t.replace(/!{3,}/g, '!!').replace(/\?{3,}/g, '??').replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
  return { text: t, action: actions[0] || null };
}
export function codeLabel(text) {
  return /```|\bfunction\s*\w*\(|=>|<\/?[a-z]+[ >]|\bdef \w+\(/.test(text) && !/✅ tested|⚠️ untested/.test(text) ? text + '\n⚠️ untested (my small brain wrote this; nothing ran it)' : text;
}
