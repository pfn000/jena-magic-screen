#!/usr/bin/env python3
"""Compact digest of Jena's last N hours for Tab to review: watchdog incidents + behavior highlights + anomalies.
usage: python3 digest.py [--hours 6] [--json]
Reads /home/jena/.jena/{incidents,behavior}.jsonl (re-runs itself with sudo if they are not readable)."""
import json, os, re, sys, time
from collections import Counter, defaultdict
J = '/home/jena/.jena'
args = sys.argv[1:]
HOURS = float(args[args.index('--hours') + 1]) if '--hours' in args else 6.0
if not os.access(os.path.join(J, 'incidents.jsonl'), os.R_OK) and os.geteuid() != 0:
    os.execvp('sudo', ['sudo', '-n', sys.executable, os.path.abspath(__file__), *args])
since = (time.time() - HOURS * 3600) * 1000

def rows(name):
    out = []
    for f in (name + '.1', name):
        p = os.path.join(J, f)
        if not os.path.exists(p): continue
        for l in open(p, errors='replace'):
            try:
                r = json.loads(l)
                if r.get('ts', 0) >= since: out.append(r)
            except Exception: pass
    return sorted(out, key=lambda r: r['ts'])
inc, beh = rows('incidents.jsonl'), rows('behavior.jsonl')
hm = lambda ts: time.strftime('%H:%M', time.localtime(ts / 1000))
cut = lambda s, n=110: (s[:n] + '…') if len(s or '') > n else (s or '')
P = print
P(f'JENA DIGEST · last {HOURS:g} h · {time.strftime("%Y-%m-%d %H:%M %Z")}')
try:
    st = json.load(open('/var/lib/jena-watchdog/status.json'))
    bad = st.get('problems') or []
    P(f"now: {st['status'].upper()}" + (f" · problems: {', '.join(bad)}" if bad else '') + (' · watchdog PAUSED' if st.get('paused') else '')
      + f" · tunnel {'ok' if (st.get('tunnel') or {}).get('ok') else 'DOWN'} · frame {'fresh' if (st.get('frame') or {}).get('fresh') else 'STALE'} · firefox {'up' if st.get('firefox_alive') else 'DOWN'} · chat probe {(st.get('chat_probe') or {}).get('ms')} ms")
    deg = [n for n, u in st['units'].items() if u.get('degraded') or u.get('ladder')]
    if deg: P('  ladder/degraded: ' + ', '.join(f"{n} L{st['units'][n]['ladder']}{' DEGRADED' if st['units'][n].get('degraded') else ''}" for n in deg))
except Exception as e: P('now: watchdog status unreadable (' + str(e) + ')')

P('\n== INCIDENTS')
routine = {'known_good_recorded', 'started'}
c = Counter((r['unit'], r['what']) for r in inc)
P('  ' + (', '.join(f'{u}:{w}×{n}' for (u, w), n in c.most_common(12)) or 'none'))
for r in [r for r in inc if r['what'] not in routine][-12:]:
    P(f"  {hm(r['ts'])} {r['unit']} {r['what']} · {cut(r.get('action', ''), 40)}{' → ' + cut(r.get('result', ''), 140) if r.get('result') else ''}")

P('\n== BEHAVIOR')
bt = Counter(r['t'] for r in beh)
P('  ' + (', '.join(f'{k}×{v}' for k, v in bt.most_common()) or 'nothing recorded'))
replies = [r for r in beh if r['t'] == 'reply']
if replies:
    ms = sorted(r.get('ms') or 0 for r in replies)
    P(f"  replies: {len(replies)} · median {ms[len(ms) // 2]} ms · slowest {ms[-1]} ms · routed: {dict(Counter(r.get('routed') or 'chat' for r in replies).most_common(5))}")
skills = Counter(re.sub(r'^using skill: ', '', r['text']) for r in beh if r['t'] == 'skill' and r.get('text', '').startswith('using skill'))
if skills: P('  skills used: ' + ', '.join(f'{k}×{v}' for k, v in skills.most_common(8)))
for r in [r for r in beh if r['t'] == 'skill_fail'][-4:]: P(f"  skill FAIL {hm(r['ts'])} {r.get('skill')}: {cut(r.get('summary', ''))}")
for r in [r for r in beh if r['t'] == 'selfcatch'][-5:]: P(f"  self-catch {hm(r['ts'])}: {cut(r.get('text', ''))}")
errs = Counter(cut(re.sub(r'\d+', '#', r.get('text', '')), 120) for r in beh if r['t'] == 'error')
for e, n in errs.most_common(5): P(f'  error ×{n}: {e}')
acts = [r for r in beh if r['t'] in ('action', 'skill')]
for r in acts[-6:]: P(f"  did {hm(r['ts'])}: {cut(r.get('text', ''), 100)}")
fr = [r for r in beh if r['t'] == 'frame']
if fr: P(f"  frames: {len(fr)} censored thumbnails, newest {J}/behavior_frames/{fr[-1]['file']} ({fr[-1].get('censor')})")

P('\n== ANOMALIES')
an = []
norm = lambda s: re.sub(r'[^a-z0-9 ]', '', (s or '').lower()).strip()
rc = Counter(norm(r.get('reply')) for r in replies if norm(r.get('reply')))
for t, n in rc.most_common(5):
    if n >= 3: an.append(f'LOOP: same reply {n}× — "{cut(t, 90)}"')
for r in replies:
    sents = [norm(s) for s in re.split(r'[.!?…]+', r.get('reply') or '') if len(norm(s)) > 6]
    d = [s for s, n in Counter(sents).items() if n >= 2]
    if d: an.append(f"LOOP inside one reply {hm(r['ts'])}: \"{cut(d[0], 70)}\" repeated")
grams = Counter()
for r in replies:
    w = norm(r.get('reply')).split(); grams.update({' '.join(w[i:i + 4]) for i in range(len(w) - 3)})
for g, n in grams.most_common(4):
    if len(replies) >= 6 and n >= max(4, len(replies) * 0.3): an.append(f'REPEATED PHRASE in {n}/{len(replies)} replies: "{g}"')
acts_c = Counter(norm(r.get('text')) for r in acts)
for t, n in acts_c.most_common(3):
    if n >= 5: an.append(f'REPEATED ACTION {n}×: "{cut(t, 80)}"')
ts = [r['ts'] for r in beh if r['t'] in ('reply', 'action', 'skill', 'thought')]
for a, b in zip(ts, ts[1:]):
    if b - a > 20 * 60000: an.append(f'LONG SILENCE {hm(a)}→{hm(b)} ({(b - a) / 60000:.0f} min with no reply/action/thought)')
if ts and time.time() * 1000 - ts[-1] > 20 * 60000: an.append(f'SILENT NOW: nothing from her since {hm(ts[-1])}')
CLAIM = re.compile(r"\b(1[89]\d\d|20\d\d)\b|\b\d+\s?%|\$\s?\d|\b\d+-\d+\b(?! ?min)|\byou (told|said)\b|\bi remember\b|\byour \w+'?s name is\b|\bborn in\b|\b(won|beat|scored)\b", re.I)
HEDGE = re.compile(r"idk|not sure|search|look it up|don.?t know|no clue|can.?t know|mama (made|built) me in october 2026", re.I)
for r in replies:
    t = r.get('reply') or ''
    if CLAIM.search(t) and not HEDGE.search(t) and (r.get('routed') not in ('search', 'web', 'grok')):
        an.append(f"CHECK CLAIM {hm(r['ts'])} (no source in reach): \"{cut(t, 110)}\" ← \"{cut(r.get('user', ''), 50)}\"")
odd = [r for r in replies if (r.get('user') or '').lower().startswith(('no,', 'no ', 'wrong')) ]
for r in odd[-3:]: an.append(f"CORRECTION from someone {hm(r['ts'])}: \"{cut(r.get('user', ''), 60)}\" → she said \"{cut(r.get('reply', ''), 80)}\"")
site = [r for r in inc if r['unit'] == 'site']
if site: an.append(f"SITE REPORTS: {len(site)} ({', '.join(f'{k}×{v}' for k, v in Counter(r['what'] for r in site).items())})")
flaps = [r for r in inc if r['what'] in ('flap_detected', 'still_flapping', 'degraded', 'rolled_back')]
if flaps: an.append(f"FLAPS: {len(flaps)} ladder steps — " + ', '.join(f"{r['unit']} {r['what']} {hm(r['ts'])}" for r in flaps[-5:]))
P('\n'.join('  ' + a for a in an[:25]) if an else '  none spotted')
