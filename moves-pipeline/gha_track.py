#!/usr/bin/env python3
# Whole-body re-track of one library move on a GitHub runner (free minutes; spares Jena's 8 GB box).
#   gha_track.py <clip id> [blob sha]     -> out/<id>.json (her VRM clip: body + 21-point fingers per hand + face)
# The video slice comes from a git blob Tab uploaded (YouTube often blocks runners), else yt-dlp on the source URL.
# Same pipeline as her box: moves-pipeline/holistic.py + retarget_full.py, true performer left/right.
import json, os, sys, subprocess, base64, urllib.request, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cid, blob = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else '')
idx = json.load(open(os.path.join(ROOT, 'public/moves/index.json')))
c = next(x for x in idx['clips'] if x['id'] == cid)
W = os.path.join(ROOT, 'work'); os.makedirs(W + '/tmp', exist_ok=True); os.makedirs(W + '/raw', exist_ok=True)
os.makedirs(os.path.join(ROOT, 'out'), exist_ok=True)
vid = f'{W}/tmp/{cid}.mp4'
src = c.get('source') or {}
if blob:
    req = urllib.request.Request(f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}/git/blobs/{blob}",
                                 headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github.raw+json', 'User-Agent': 'jena-track'})
    open(vid, 'wb').write(urllib.request.urlopen(req, timeout=120).read())
if not os.path.exists(vid) or os.path.getsize(vid) < 1000:
    a, b = src.get('start'), src.get('end')
    if a is None and b is None: a, b = 0.0, float(c.get('duration') or 15) + 1.0
    subprocess.run(['yt-dlp', '-q', '--no-warnings', '-f', 'bv*[height<=480][ext=mp4]/bv*[height<=480]/b[height<=480]/b', '--merge-output-format', 'mp4',
                    '-o', vid, '--no-playlist', '--download-sections', f'*{a}-{b}', '--force-keyframes-at-cuts', src['url']], check=True, timeout=600)
M = os.path.join(W, 'models'); os.makedirs(M, exist_ok=True)
G = 'https://storage.googleapis.com/mediapipe-models'
for name, url in [('pose_full.task', f'{G}/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task'),
                  ('hand_landmarker.task', f'{G}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task'),
                  ('face_landmarker.task', f'{G}/face_landmarker/face_landmarker/float16/latest/face_landmarker.task')]:
    if not os.path.exists(f'{M}/{name}'): urllib.request.urlretrieve(url, f'{M}/{name}')
t0 = time.time()
r = subprocess.run([sys.executable, os.path.join(ROOT, 'moves-pipeline/holistic.py'), cid, vid], env={**os.environ, 'MOVES_DIR': W, 'TRACK_MODELS': M, 'MPLBACKEND': 'Agg'},
                   capture_output=True, text=True, timeout=2400)
line = (r.stdout.strip().splitlines() or [''])[-1]
if r.returncode != 0 or not line.startswith('{'):
    print(r.stdout[-4000:]); print(r.stderr[-6000:]); raise SystemExit('tracking failed')
res = json.loads(line)
sys.path.insert(0, os.path.join(ROOT, 'moves-pipeline'))
import numpy as np, retarget_full
npz = f'{W}/raw/{cid}.npz'
n = len(np.load(npz)['t'])
clip, q, info, meta = retarget_full.build(npz, 0.4, max(1.0, n / 15.0 - 0.4))
clip['learned_from'] = {'url': src.get('url'), 'title': src.get('title'), 'channel': src.get('channel'), 'start': src.get('start'), 'end': src.get('end')}
clip['tracked_on'] = {'where': 'GitHub Actions (jena-track.yml)', 'run': f"{os.environ.get('GITHUB_SERVER_URL')}/{os.environ.get('GITHUB_REPOSITORY')}/actions/runs/{os.environ.get('GITHUB_RUN_ID')}",
                      'secs': round(time.time() - t0, 1), 'detected': res.get('detected'), 'lighting': res.get('lighting'), 'mirrored': res.get('mirrored')}
json.dump(clip, open(os.path.join(ROOT, 'out', cid + '.json'), 'w'), separators=(',', ':'))
F = clip.get('fingers') or {}
print(json.dumps({'id': cid, 'frames': clip['frames'], 'fingers': sorted(F), 'face': bool(clip.get('face')), 'detected': res.get('detected'), 'secs': round(time.time() - t0, 1)}))
