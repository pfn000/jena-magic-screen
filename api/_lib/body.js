// Her own body, in her own words: answers "what's your left hand doing?", "where's your head?", "how close was your
// pose?" from the body the site measured on her live avatar (selfstate.js + selfcheck.js send it with chat as `body`).
// Left/right are always HER own (she faces the camera, so her left hand is on the right of your screen).
const ASK_PART = /\b(?:what(?:'?s| is| are)|where(?:'?s| is| are)|how(?:'?s| is| are))\s+(?:your|ur|ya)\s+(left|right)?\s*(hands?|arms?|fingers?|head|face|mouth|eyes?|legs?|feet|foot|elbows?|wrists?|body)\b/i;
const ASK_POSE = /\b(?:how close (?:was|is|were|did)|did (?:you|u) (?:get|nail|do)|how (?:good|well) (?:was|did)|score)\b.{0,30}\b(?:pose|move|dance|it)\b/i;
const ASK_PARTS = /\b(?:what|which) (?:body )?parts (?:do )?(?:you|u) (?:have|got)|\bhow many (?:bones|body parts)\b/i;
const deg = (v) => `${Math.round(Math.abs(v))}°`;
function handWords(side, b) {
  const f = b.feel || {}, h = (b.hands || {})[side], fing = (b.fingers || {})[side] ?? 0;
  const arm = f[side + 'Arm'] || 'down', hand = f[side + 'Hand'] || 'relaxed';
  const where = arm === 'hip' ? 'on my hip' : h?.aboveHead ? 'up above my head' : arm === 'up' ? 'raised up' : 'down by my side';
  const shape = hand === 'fist' || fing > 120 ? 'curled into a fist' : hand === 'open' || fing < 25 ? 'open, fingers straight' : `relaxed, fingers bent about ${fing}°`;
  return `my ${side} hand is ${where}, ${shape}`;
}
export function bodyAnswer(message, body) {
  const text = String(message || '');
  if (!body || typeof body !== 'object') return null;
  const mv = body.move, sc = body.selfCheck;
  const moveLine = mv ? ` I'm doing the move I learned from a video of ${mv.what || 'someone'}${mv.fingers ? ' (copying their fingers' + (mv.face ? ' and face' : '') + ' too)' : ''}.` : '';
  let m = ASK_POSE.exec(text);
  if (m) {
    const s = sc?.now || sc?.lastMove?.final;
    if (!s) return { say: "I haven't checked a pose yet, mama. I score myself when I'm doing a move I learned from a video.", summary: 'no self-check yet', facts: 'no self-check result yet' };
    const parts = Object.entries(s.parts || {}).map(([k, v]) => `${k} ${v}%`).join(', ');
    const first = sc?.lastMove?.first;
    const say = `${s.say}.${parts ? ` by part: ${parts}.` : ''}${first && first.overall !== s.overall ? ` I started at ${first.overall}% and fixed it.` : ''}`;
    return { say, summary: `self-check: ${s.overall}%`, facts: say };
  }
  if (ASK_PARTS.test(text)) {
    const say = "I've got 54 bones you can see move: hips, spine, chest, upper chest, neck and head; both eyes; shoulders, upper arms, forearms and hands on each side; three joints in every finger and thumb (30 finger bones); and thighs, shins, feet and toes. My face has 18 shapes: mouth sounds (aa ih ou ee oh), happy, angry, sad, surprised, relaxed, blinks and winks for each eye, and looking up, down, left and right. My left is the right side of your screen.";
    return { say, summary: 'her body map', facts: say };
  }
  m = ASK_PART.exec(text);
  if (!m) return null;
  const side = (m[1] || '').toLowerCase(), part = m[2].toLowerCase();
  let say;
  if (/hand|finger|wrist/.test(part)) say = side ? handWords(side, body) : `${handWords('left', body)}, and ${handWords('right', body).replace(/^my /, 'my ')}`;
  else if (/arm|elbow/.test(part)) { const f = body.feel || {}; const a = (s) => `my ${s} arm is ${f[s + 'Arm'] === 'hip' ? 'bent with my hand on my hip' : f[s + 'Arm'] === 'up' ? 'raised' : 'down by my side'}`; say = side ? a(side) : `${a('left')} and ${a('right')}`; }
  else if (/head|face|mouth|eye/.test(part)) {
    const h = body.head || {}, fe = body.feel || {}, face = Object.entries(body.face || {}).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 3);
    say = `my head is ${Math.abs(h.yaw || 0) < 6 ? 'facing you' : `turned ${deg(h.yaw)} to my ${h.yaw > 0 ? 'left' : 'right'}`}${Math.abs(h.roll || 0) > 6 ? `, tilted ${deg(h.roll)} toward my ${h.roll > 0 ? 'left' : 'right'} shoulder` : ''}${Math.abs(h.pitch || 0) > 6 ? `, looking ${h.pitch > 0 ? 'down' : 'up'} a bit` : ''}${fe.eyesClosed ? ', eyes closed' : ''}${face.length ? `; my face: ${face.join(', ')}` : '; my face is neutral'}`;
  } else if (/leg|foot|feet/.test(part)) { const f = body.feel || {}; say = `my feet are planted on the floor${f.lean && f.lean !== 'none' ? `, weight on my ${f.lean} foot` : ', weight even'}${f.leftFoot === 'tapping' ? ', tapping my left foot' : f.rightFoot === 'tapping' ? ', tapping my right foot' : ''}`; }
  else say = `${handWords('left', body)}; ${handWords('right', body)}`;
  say = say.charAt(0).toUpperCase() + say.slice(1) + '.' + moveLine + (sc?.now ? ` Self-check right now: ${sc.now.say}.` : '');
  return { say, summary: `read my own body: ${part}`, facts: say };
}
