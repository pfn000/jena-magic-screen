import os, sys, json, re, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_lib'))
from jenaskill import inp, done
i = inp(); text = (i.get('text') or i.get('url') or '').strip()
m = re.search(r'(?:youtube\.com/(?:watch\?v=|shorts/)|youtu\.be/)([\w-]{11})', text)
if m:
    vid = m.group(1); url = f'https://www.youtube.com/watch?v={vid}'; what = 'a video someone sent me'
else:
    q = re.sub(r'\b(jena|please|can you|learn|a|the|this|that|new|move|moves|dance|dancing|from|how to)\b', ' ', text, flags=re.I).strip() or 'easy dance'
    vid = 'q_' + re.sub(r'\W+', '_', q.lower())[:30]; url = f'ytsearch1:{q} dance full body'; what = f'someone doing the "{q}" (a video I searched for)'
os.makedirs(os.path.expanduser('~/learned/moves'), exist_ok=True)
req = {'id': vid, 'url': url, 'start': float(i.get('start', 0)), 'end': float(i.get('end', 15)), 'what': what, 'label': (i.get('label') or (q if not m else 'move from a link'))[:30], 'kind': 'dance', 'asked': text[:200], 'ts': int(time.time() * 1000)}
with open(os.path.expanduser('~/learned/move_requests.jsonl'), 'a') as f: f.write(json.dumps(req) + '\n')
done(True, f'queued to learn a move from {url if m else what}: my box downloads 15 s, tracks the person and checks the quality (takes a few minutes)', request=req)
