# "what did you learn from mama today?" Her watch-mama notes (box/desktop/jena_mamawatch.py writes one summary per
# session in ~/.jena/mama_sessions/<id>/summary.json). This box-side answer is public-safe: it says THAT she watched
# and how many things she saved; the step-by-step notes are mama's alone (the site answers mama in full from the
# mama-only /box/tab-live/learned door, and her chat never reads the steps out on stream).
import os, sys, json, time, glob
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_lib'))
from jenaskill import inp, done
i = inp(); text = (i.get('text') or '').lower()
today = time.strftime('%Y-%m-%d')
rows = []
for p in sorted(glob.glob(os.path.expanduser('~/.jena/mama_sessions/*/summary.json')), reverse=True)[:40]:
    try: j = json.load(open(p))
    except Exception: continue
    if 'yesterday' in text or str(j.get('when', '')).startswith(today): rows.append(j)
if not rows:
    done(True, "nothing new from mama today yet. whenever she uses my desktop i watch, record it and write down how she did it", count=0)
n = len(rows); mins = sum(len(r.get('steps') or []) for r in rows)
done(True, f"today i watched mama {n} time{'s' if n != 1 else ''} on my desktop and saved {mins} steps (video + notes) so i can do it myself next time. the details are just for mama 🤫",
     count=n, private=True)
