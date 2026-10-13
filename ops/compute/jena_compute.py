#!/usr/bin/env python3
"""One compute-offload job for Jena on a GitHub runner (jena-compute.yml). Writes out/<request_id>.tar.gz and
out/<request_id>.manifest.json. Jobs:
  move_extract  input: a video URL or blob:<sha> (a clip Tab uploaded); params: start,end,model (e.g. "0,15,full")
                -> raw/<id>.npz (whole body: pose + 21 points per hand + face blendshapes, moves-pipeline/holistic.py),
                   <id>.json (her VRM move WITH fingers + face, retarget_full.py, true performer left/right), <id>.gif
  mama_session  input: blob:<sha> or URL of a watch-mama session video; params: actions blob sha (optional)
                -> 320p clips of 10 s + train.jsonl (one row per clip, with the actions that fall inside it)
  model_job     input: URL of a small .onnx; params: "onnx_quantize" -> dynamic int8 .onnx + size/latency check
  ux_test       input: https URL on the allowlist; params: "1600,390" -> headless Chrome screenshots
Never prints secrets (GH_TOKEN only reads a blob of this repo)."""
import base64, hashlib, json, os, re, shutil, subprocess, sys, tarfile, time, urllib.request

JOB, INP, PARAMS, REQ = (os.environ.get(k, '') for k in ('JOB', 'INPUT', 'PARAMS', 'REQ'))
REPO = os.environ.get('GITHUB_REPOSITORY', 'pfn000/jena-magic-screen')
ROOT = os.path.abspath('.'); OUT = os.path.join(ROOT, 'out'); WORK = os.path.join(ROOT, 'work')
ALLOW_UX = ('jena-magic-screen.vercel.app', 'tab.bot')
for d in (OUT, WORK): shutil.rmtree(d, True); os.makedirs(d)
STAGE = os.path.join(WORK, 'result'); os.makedirs(STAGE)
assert re.fullmatch(r'[A-Za-z0-9._-]{3,80}', REQ), 'bad request_id'

def sh(cmd, **kw):
    print('+', cmd if isinstance(cmd, str) else ' '.join(cmd), flush=True)
    return subprocess.run(cmd, shell=isinstance(cmd, str), check=True, **kw)

def sha(p):
    h = hashlib.sha256(); h.update(open(p, 'rb').read()); return h.hexdigest()

def get_input(dest):
    """blob:<sha> (uploaded by Tab through the connected app) or an https URL; returns (path, source)"""
    if INP.startswith('blob:'):
        s = INP[5:]; assert re.fullmatch(r'[0-9a-f]{40}', s)
        r = urllib.request.Request(f'https://api.github.com/repos/{REPO}/git/blobs/{s}', headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github.raw+json', 'User-Agent': 'jena-compute'})
        open(dest, 'wb').write(urllib.request.urlopen(r, timeout=300).read()); return dest, INP
    assert INP.startswith('https://'), 'input must be https:// or blob:'
    return None, INP

t0 = time.time(); result = {}
if JOB == 'move_extract':
    p = (PARAMS or '-,-,full').split(',') + ['-', '-', 'full']
    start, end, model = p[0] or '-', p[1] or '-', (p[2] or 'full')
    assert model in ('lite', 'full', 'heavy')
    mp_dir = os.path.join(WORK, 'moves'); os.makedirs(mp_dir + '/tmp'); os.makedirs(mp_dir + '/raw')
    cid = REQ
    G = 'https://storage.googleapis.com/mediapipe-models'
    urllib.request.urlretrieve(f'{G}/pose_landmarker/pose_landmarker_{model}/float16/latest/pose_landmarker_{model}.task', f'{mp_dir}/pose_{model}.task')
    # fingers + face: every move she learns carries them (extract.py was body only, so moves came out with no hands/face)
    urllib.request.urlretrieve(f'{G}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task', f'{mp_dir}/hand_landmarker.task')
    urllib.request.urlretrieve(f'{G}/face_landmarker/face_landmarker/float16/latest/face_landmarker.task', f'{mp_dir}/face_landmarker.task')
    path, src = get_input(f'{mp_dir}/tmp/{cid}.mp4')
    url = src if path is None else 'file:' + src
    if path and start != '-':   # the clip is already cut on the box: start/end are informational
        start = end = '-'
    t1 = time.time()
    vid_arg = path if path else url
    r = sh([sys.executable, 'moves-pipeline/holistic.py', cid, vid_arg, start, end, model], env={**os.environ, 'MOVES_DIR': mp_dir, 'TRACK_MODELS': mp_dir}, capture_output=True, text=True)
    print(r.stdout[-2000:]); stat = json.loads([l for l in r.stdout.splitlines() if l.startswith('{')][-1])
    extract_s = round(time.time() - t1, 1)
    sys.path.insert(0, os.path.join(ROOT, 'moves-pipeline')); import retarget, retarget_full, numpy as np
    npz = f'{mp_dir}/raw/{cid}.npz'
    n = len(np.load(npz)['t']); a, b = 0.4, n / retarget.FPS - 0.4
    mv, q, info, meta = retarget_full.build(npz, a, b)
    json.dump(mv, open(os.path.join(STAGE, cid + '.json'), 'w'), separators=(',', ':'))
    shutil.copy(npz, os.path.join(STAGE, cid + '.npz'))
    try: sh([sys.executable, 'moves-pipeline/preview_gif.py', npz, os.path.join(STAGE, cid + '.gif')], capture_output=True)
    except Exception as e: print('gif failed', e)
    q.pop('ok', None)
    result = {'extract': stat, 'fingers': sorted((mv.get('fingers') or {}).keys()), 'face': bool(mv.get('face')), 'quality': q, 'title': info.get('title'), 'move_file': cid + '.json', 'frames': mv['frames'], 'duration': mv['duration'],
              'extract_cpu_seconds': extract_s, 'runner_cpus': os.cpu_count()}
elif JOB == 'mama_session':
    vid = os.path.join(WORK, 'session.mp4')
    path, src = get_input(vid)
    if path is None: urllib.request.urlretrieve(src, vid)
    actions = []
    if re.fullmatch(r'[0-9a-f]{40}', PARAMS or ''):
        r = urllib.request.Request(f'https://api.github.com/repos/{REPO}/git/blobs/{PARAMS}', headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github.raw+json', 'User-Agent': 'jena-compute'})
        actions = [json.loads(l) for l in urllib.request.urlopen(r, timeout=120).read().decode().splitlines() if l.strip()]
    os.makedirs(os.path.join(STAGE, 'clips'))
    sh(['ffmpeg', '-loglevel', 'error', '-i', vid, '-vf', 'scale=-2:320', '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast', '-an', '-f', 'segment', '-segment_time', '10', '-reset_timestamps', '1', os.path.join(STAGE, 'clips', 'clip_%03d.mp4')])
    t_start = actions[0].get('t', 0) if actions else 0
    rows = []
    for k, c in enumerate(sorted(os.listdir(os.path.join(STAGE, 'clips')))):
        a0, a1 = k * 10, (k + 1) * 10
        acts = [x for x in actions if a0 <= (x.get('t', 0) - t_start) < a1]
        rows.append({'clip': 'clips/' + c, 'start_s': a0, 'end_s': a1, 'actions': acts, 'task': 'how mama used the desktop'})
    open(os.path.join(STAGE, 'train.jsonl'), 'w').write('\n'.join(json.dumps(r) for r in rows) + '\n')
    result = {'clips': len(rows), 'actions': len(actions)}
elif JOB == 'model_job':
    assert PARAMS == 'onnx_quantize' and INP.startswith('https://')
    m = os.path.join(WORK, 'model.onnx'); urllib.request.urlretrieve(INP, m)
    assert os.path.getsize(m) < 300 << 20, 'model too big for a small job'
    from onnxruntime.quantization import quantize_dynamic, QuantType
    q8 = os.path.join(STAGE, 'model.int8.onnx'); quantize_dynamic(m, q8, weight_type=QuantType.QInt8)
    result = {'fp32_bytes': os.path.getsize(m), 'int8_bytes': os.path.getsize(q8), 'source_sha256': sha(m)}
elif JOB == 'ux_test':
    from urllib.parse import urlparse
    host = urlparse(INP).hostname or ''
    assert INP.startswith('https://') and any(host == d or host.endswith('.' + d) for d in ALLOW_UX), 'ux_test only opens Jena/Tab pages'
    widths = [int(x) for x in (PARAMS or '1600,390').split(',') if x.strip().isdigit()][:4]
    js = """const { chromium } = require('playwright'); (async () => { const b = await chromium.launch(); const out = [];
      for (const w of %s) { const p = await b.newPage({ viewport: { width: w, height: w > 600 ? 900 : 844 }, deviceScaleFactor: 1 });
        const t = Date.now(); await p.goto(%s, { waitUntil: 'load', timeout: 60000 }); await p.waitForTimeout(4000);
        await p.screenshot({ path: 'work/result/ux-' + w + '.png' }); out.push({ width: w, load_ms: Date.now() - t, title: await p.title() }); await p.close(); }
      await b.close(); require('fs').writeFileSync('work/result/ux.json', JSON.stringify(out, null, 1)); })();""" % (json.dumps(widths), json.dumps(INP))
    open(os.path.join(WORK, 'ux.cjs'), 'w').write(js); sh(['node', os.path.join(WORK, 'ux.cjs')])
    result = json.load(open(os.path.join(STAGE, 'ux.json')))
else:
    raise SystemExit(f'unknown job {JOB}')

pkg = os.path.join(OUT, f'{REQ}.tar.gz')
with tarfile.open(pkg, 'w:gz') as t: t.add(STAGE, arcname=REQ)
man = {'request_id': REQ, 'job': JOB, 'input': INP if not INP.startswith('blob:') else INP[:17] + '…', 'params': PARAMS,
       'package': {'file': os.path.basename(pkg), 'sha256': sha(pkg), 'size': os.path.getsize(pkg)}, 'result': result,
       'seconds': round(time.time() - t0, 1), 'run_id': os.environ.get('GITHUB_RUN_ID'),
       'run_url': f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{REPO}/actions/runs/{os.environ.get('GITHUB_RUN_ID')}",
       'built_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
json.dump(man, open(os.path.join(OUT, f'{REQ}.manifest.json'), 'w'), indent=1); print(json.dumps(man, indent=1))
