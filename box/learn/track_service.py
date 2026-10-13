
# jena-track: gives every move Jena learned her fingers and face, with true left/right, and keeps ANIMATIONS/ on
# GitHub in step. One clip at a time, nice 19, 2 cores, only while jena-learn is idle and the box has room, so her
# chat brain stays quick.
#  1. picks moves without whole-body tracking yet: ones she learned on her box (~jena/learned/moves) first, then the
#     site's library clips (public/moves);
#  2. re-downloads the exact slice, runs moves-pipeline/holistic.py (body + 21 points per hand + face blendshapes,
#     low-light retry, mirror check + un-mirror), retarget_full.py (bones + finger bends + face expressions),
#     preview_gif.py (small GIF);
#  3. box-learned clips are upgraded in place (her site loads them from her box), with the tracking overlay video;
#  4. every clip (JSON + GIF) is staged for ANIMATIONS/ and committed in batches through the connected GitHub app
#     (one commit per batch, fast-forward only, never forced);
#  5. writes ~/.jena-mama/tracking.json + tracking-latest.mp4/.jpg for Tab Live (mama only).
import json, os, re, subprocess, sys, time, hashlib, shutil, traceback
HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get('TRACK_WORK', HERE)
PIPE = os.environ.get('TRACK_PIPE', HERE)
PY = os.environ.get('MOVES_PY', '/home/user/moves-venv/bin/python')
REPO = os.environ.get('JENA_REPO', '/home/user/tab/files/jena-magic-screen/repo')
LEARNED = '/home/jena/learned/moves'
MAMA = '/home/jena/.jena-mama'
STAGE = os.path.join(WORK, 'animations'); os.makedirs(STAGE, exist_ok=True)
STATE_P = os.path.join(WORK, 'state.json')
MIN_FREE = int(os.environ.get('TRACK_MIN_FREE_MB', '1300'))   # a whole-body pass peaks around 600 MB
MAX_LOAD = float(os.environ.get('TRACK_MAX_LOAD', '6'))
SYNC_EVERY = float(os.environ.get('TRACK_SYNC_MIN', '20')) * 60
sys.path.insert(0, PIPE); sys.path.insert(0, HERE)
os.environ['MPLBACKEND'] = 'Agg'
NICE = ['nice', '-n', '19', 'taskset', '-c', os.environ.get('TRACK_CPUS', '2,3')]

def load_state():
    try: return json.load(open(STATE_P))
    except Exception: return {'done': {}, 'synced': {}, 'last_sync': None, 'history': []}
def save_state(s):
    json.dump(s, open(STATE_P + '.tmp', 'w'), indent=1); os.replace(STATE_P + '.tmp', STATE_P)
def write_status(**k):
    s = {'at': int(time.time() * 1000), **k}
    try:
        p = os.path.join(MAMA, 'tracking.json'); json.dump(s, open(p + '.tmp', 'w')); os.replace(p + '.tmp', p)
    except Exception: json.dump(s, open(os.path.join(WORK, 'status.json'), 'w'))
def mem_free():
    return int(next(l.split()[1] for l in open('/proc/meminfo') if l.startswith('MemAvailable'))) // 1024
def learn_busy():
    try: return json.load(open(os.path.join(LEARNED, 'status.json'))).get('state') == 'learning'
    except Exception: return False
def jload(p, d=None):
    try: return json.load(open(p))
    except Exception: return d

def candidates(state):
    out = []
    box = jload(os.path.join(LEARNED, 'index.json'), {}) or {}
    for c in sorted(box.get('clips', []), key=lambda c: -(c.get('learned_at') or 0)):
        out.append(('box', c))
    lib = jload(os.path.join(REPO, 'public/moves/index.json'), {}) or {}
    for c in sorted(lib.get('clips', []), key=lambda c: c.get('kind') != 'talk'): out.append(('library', c))   # talking-with-hands clips show fingers + face best
    extra = jload(os.path.join(WORK, 'extra.json'), []) or []   # moves added by hand (proof clips etc.)
    for c in extra: out.append(('extra', c))
    return [(k, c) for k, c in out if c.get('id') and (c.get('source') or {}).get('url') and c['id'] not in state['done']]

def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)

def track(kind, c, state):
    cid = re.sub(r'[^\w-]', '_', c['id'])[:48]
    src = c['source']; url = src['url']; a, b = src.get('start'), src.get('end')
    if a is None and b is None: a, b = 0.0, float(c.get('duration') or 15) + 1.0
    tmp = os.path.join(WORK, 'tmp'); os.makedirs(tmp, exist_ok=True)
    vid = os.path.join(tmp, cid + '.mp4')
    write_status(state='tracking', current={'id': cid, 'label': c.get('label') or c.get('what'), 'kind': kind, 'step': 'downloading the slice', 'since': int(time.time() * 1000)}, **summary(state))
    if not os.path.exists(vid):
        cmd = NICE + ['yt-dlp', '-q', '--no-warnings', '-f', 'bv*[height<=480][ext=mp4]/bv*[height<=480]/b[height<=480]/b', '--merge-output-format', 'mp4', '-o', vid, '--write-info-json', '--no-playlist',
                      '--download-sections', f'*{a}-{b}', '--force-keyframes-at-cuts', url]
        r = run(cmd, timeout=400)
        if r.returncode != 0 or not os.path.exists(vid): raise RuntimeError('download failed: ' + (r.stderr.strip().splitlines() or ['?'])[-1][:200])
    write_status(state='tracking', current={'id': cid, 'label': c.get('label') or c.get('what'), 'kind': kind, 'step': 'tracking body, fingers and face', 'since': int(time.time() * 1000)}, **summary(state))
    env = dict(os.environ, MOVES_DIR=WORK, TRACK_MODELS=os.environ.get('TRACK_MODELS', '/home/user/tab/files/jena-learn'), MPLBACKEND='Agg', OMP_NUM_THREADS='2')
    r = run(NICE + ['timeout', '1200', PY, os.path.join(PIPE, 'holistic.py'), cid, vid], env=env, timeout=1300)
    line = (r.stdout.strip().splitlines() or [''])[-1]
    if r.returncode != 0 or not line.startswith('{'): raise RuntimeError('tracking failed: ' + (r.stderr.strip().splitlines() or ['?'])[-1][:200])
    res = json.loads(line)
    npz = os.path.join(WORK, 'raw', cid + '.npz')
    import numpy as np, retarget_full
    n = len(np.load(npz)['t']); FPS = 15.0
    clip, q, info, meta = retarget_full.build(npz, 0.4, max(1.0, n / FPS - 0.4))
    clip['learned_from'] = {'url': url, 'title': src.get('title') or info.get('title'), 'channel': src.get('channel'), 'start': src.get('start'), 'end': src.get('end')}
    gif = os.path.join(STAGE, cid + '.gif')
    run(NICE + [PY, os.path.join(PIPE, 'preview_gif.py'), npz, gif, '0.4', str(max(1.0, n / FPS - 0.4))], timeout=300)
    ov = os.path.join(WORK, 'tmp', cid + '-track.mp4')
    # stage for ANIMATIONS/
    js = json.dumps(clip, separators=(',', ':'))
    open(os.path.join(STAGE, cid + '.json'), 'w').write(js)
    entry = {'id': cid, 'file': cid + '.json', 'preview': cid + '.gif' if os.path.exists(gif) else None, 'label': c.get('label') or cid, 'what': c.get('what'),
             'kind': c.get('kind'), 'moods': c.get('moods'), 'duration': clip['duration'], 'fps': clip['fps'], 'frames': clip['frames'], 'sides': 'performer',
             'fingers': sorted((clip.get('fingers') or {}).keys()), 'face': bool(clip.get('face')),
             'lighting': (meta.get('lighting') or {}).get('used'), 'luma': (meta.get('lighting') or {}).get('luma'), 'mirrored_source': (meta.get('mirror') or {}).get('mirrored'),
             'mirror_check': (meta.get('mirror') or {}).get('why'), 'detected': meta.get('detected'),
             'source': {k: src.get(k) for k in ('url', 'title', 'channel', 'start', 'end')}, 'origin': kind, 'tracked_at': int(time.time() * 1000)}
    idx = jload(os.path.join(STAGE, 'index.json'), None) or {'version': 1, 'moves': []}
    idx['moves'] = [m for m in idx['moves'] if m['id'] != cid] + [entry]
    idx['note'] = ("Every move Jena learned, as her own animation clips (quaternion tracks for her VRM bones, finger bends per hand, face "
                   "expression weights) plus a small preview GIF of the tracking. Left/right are the performer's own (mirrored videos are "
                   "un-mirrored first) and play left->left on Jena. Made on her box by moves-pipeline/holistic.py + retarget_full.py.")
    idx['updated'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()); idx['count'] = len(idx['moves'])
    json.dump(idx, open(os.path.join(STAGE, 'index.json'), 'w'), indent=1)
    # upgrade her box clip in place (her site loads box-learned moves from here)
    if kind == 'box' and os.path.isdir(LEARNED):
        dst = os.path.join(LEARNED, c.get('file') or cid + '.json')
        open(dst + '.tmp', 'w').write(js); os.replace(dst + '.tmp', dst)
        for src_, name in ((gif, cid + '.gif'), (ov, cid + '-track.mp4')):
            if os.path.exists(src_): shutil.copy(src_, os.path.join(LEARNED, name))
    # Tab Live: the newest tracking overlay
    if os.path.exists(ov):
        try:
            shutil.copy(ov, os.path.join(MAMA, 'tracking-latest.mp4.tmp')); os.replace(os.path.join(MAMA, 'tracking-latest.mp4.tmp'), os.path.join(MAMA, 'tracking-latest.mp4'))
            run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', str(min(4, n / FPS / 2)), '-i', ov, '-frames:v', '1', os.path.join(MAMA, 'tracking-latest.jpg')], timeout=60)
        except Exception: pass
    for f in (vid, vid[:-4] + '.info.json'):
        try: os.remove(f)
        except Exception: pass
    return {'id': cid, 'label': entry['label'], 'kind': kind, 'ok': True, 'at': int(time.time() * 1000), 'lighting': entry['lighting'], 'luma': entry['luma'],
            'mirrored_source': entry['mirrored_source'], 'mirror_check': entry['mirror_check'], 'detected': entry['detected'], 'fingers': entry['fingers'], 'face': entry['face'],
            'secs': res.get('secs'), 'quality': {k: q.get(k) for k in ('jitter', 'vis_legs', 'bone_cv', 'fingers_seen', 'face_seen')}}

def pending(state):
    out = {}
    for f in sorted(os.listdir(STAGE)):
        p = os.path.join(STAGE, f); h = hashlib.sha256(open(p, 'rb').read()).hexdigest()
        if state['synced'].get(f) != h: out[f] = h
    return out

def sync(state, force=False):
    pend = pending(state)
    moves = [f[:-5] for f in pend if f.endswith('.json') and f != 'index.json']
    if not pend: return None
    last = (state.get('last_sync') or {}).get('at', 0) / 1000
    if not force and time.time() - last < SYNC_EVERY and len(moves) < 6: return None
    import ghapp
    files = {f'ANIMATIONS/{f}': open(os.path.join(STAGE, f), 'rb').read() for f in pend}
    msg = (f"ANIMATIONS: {len(moves)} learned move{'s' if len(moves) != 1 else ''} with fingers + face ({', '.join(moves[:8])}{'…' if len(moves) > 8 else ''}). "
           "Each is her clip JSON (VRM bone quaternions, 15 finger-joint bends per hand, face expression weights from 52 blendshapes; left/right = the performer's own, "
           "un-mirrored if the video was mirrored; low-light passes logged) + a small tracking preview GIF, listed in ANIMATIONS/index.json. Batched by jena-track on her box.")
    sha = ghapp.commit_files(files, msg)
    state['synced'].update(pend)
    state['last_sync'] = {'at': int(time.time() * 1000), 'sha': sha, 'files': len(files), 'moves': moves}
    save_state(state)
    return state['last_sync']

def summary(state):
    pend = pending(state)
    return {'done': len([d for d in state['done'].values() if d.get('ok')]), 'failed': len([d for d in state['done'].values() if not d.get('ok')]),
            'pending_upload': len([f for f in pend if f.endswith('.json') and f != 'index.json']), 'last_sync': state.get('last_sync'),
            'last': (state.get('history') or [None])[-1], 'history': (state.get('history') or [])[-8:][::-1]}

def main(once=False):
    state = load_state()
    while True:
        try:
            todo = candidates(state)
            if todo:
                if learn_busy() or mem_free() < MIN_FREE or os.getloadavg()[0] > MAX_LOAD:
                    write_status(state='waiting', why='jena-learn is busy' if learn_busy() else f'only {mem_free()} MB free' if mem_free() < MIN_FREE else f'box load {os.getloadavg()[0]:.1f}', queue=len(todo), **summary(state))
                    time.sleep(30); continue
                kind, c = todo[0]
                try: res = track(kind, c, state)
                except Exception as e:
                    res = {'id': c['id'], 'kind': kind, 'ok': False, 'at': int(time.time() * 1000), 'error': str(e)[:300]}
                    traceback.print_exc()
                state['done'][c['id']] = res; state['history'] = (state.get('history') or []) + [res]
                state['history'] = state['history'][-40:]; save_state(state)
            try:
                s = sync(state, force=once)
                if s: print('synced', s, flush=True)
            except Exception as e:
                state['sync_error'] = {'at': int(time.time() * 1000), 'error': str(e)[:300]}; save_state(state); traceback.print_exc()
            write_status(state='idle' if not candidates(state) else 'queued', queue=len(candidates(state)), sync_error=state.get('sync_error'), **summary(state))
            if once and not candidates(state): return
            if not todo: time.sleep(60)
        except Exception as e:
            traceback.print_exc(); write_status(state='error', error=str(e)[:200]); time.sleep(60)

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'sync':
        print(json.dumps(sync(load_state(), force=True)))
    else: main(once=len(sys.argv) > 1 and sys.argv[1] == 'once')
