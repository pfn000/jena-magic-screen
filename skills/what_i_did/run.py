import os, sys, json, time, re
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_lib'))
from jenaskill import inp, done
i = inp(); text = (i.get('text') or '').lower()
hours = 3 if re.search(r'\b(lately|earlier|this morning|this afternoon)\b', text) else 24
rows = []
try:
    with open(os.path.expanduser('~/.jena/memory/activity.jsonl'), encoding='utf-8', errors='replace') as f:
        for l in f.readlines()[-2000:]:
            try: rows.append(json.loads(l))
            except Exception: pass
except FileNotFoundError: pass
cut = (time.time() - hours * 3600) * 1000
rows = [r for r in rows if r.get('ts', 0) >= cut and 'old activity log' not in (r.get('note') or '')]
if not rows: done(True, "not much yet honestly, i just started keeping track of what i do")
pick = {}
for r in reversed(rows):
    pick.setdefault(r.get('kind', 'task'), [])
    if r.get('what') not in pick[r['kind']] and len(pick[r['kind']]) < 3: pick[r['kind']].append(r.get('what'))
order = ['learn', 'read', 'video', 'site', 'note', 'skill', 'task']
bits = [w for k in order for w in pick.get(k, [])][:7]
fm = [r for r in rows if r.get('action') == 'summarise' and r.get('note')]
extra = f" oh and for you mama: {fm[-1]['note']}" if fm else ''
done(True, f"{'today' if hours == 24 else 'lately'} i " + '; '.join(bits) + '.' + extra, count=len(rows), hours=hours)
