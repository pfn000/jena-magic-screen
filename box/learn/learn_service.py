# Jena learns new moves from online videos by herself: she queues a request (her learn_move skill writes
# ~/learned/move_requests.jsonl), this service (one video at a time, low priority, waits for free RAM)
# downloads a short slice (<=480p), tracks the person with MediaPipe Pose, retargets it onto her VRM bones
# with the same pipeline that built her first moves (moves-pipeline/), checks the quality honestly and
# saves the clip to ~jena/learned/moves/ where her site picks it up. Rejected videos are reported with why.
import json, os, re, subprocess, sys, time
REPO = os.environ.get('JENA_REPO', '/home/user/tab/files/jena-magic-screen/repo')
PIPE = os.path.join(REPO, 'moves-pipeline')
WORK = os.environ.get('MOVES_DIR', '/home/user/tab/files/jena-learn')
PY = os.environ.get('MOVES_PY', '/home/user/moves-venv/bin/python')
LEARNED = '/home/jena/learned/moves'
REQ = '/home/jena/learned/move_requests.jsonl'
STATUS = os.path.join(LEARNED, 'status.json')
sys.path.insert(0, PIPE)
os.environ['MPLBACKEND'] = 'Agg'

def status(**k):
    s = {'at': int(time.time() * 1000), **k}
    json.dump(s, open(STATUS, 'w')); os.chmod(STATUS, 0o664)

def index():
    p = os.path.join(LEARNED, 'index.json')
    try: return json.load(open(p))
    except Exception: return {'version': 1, 'note': 'Moves Jena learned by herself on her box from online videos (same pipeline as her first moves).', 'clips': [], 'rejected': []}

def learn(r):
    import numpy as np, retarget
    cid = re.sub(r'[^\w-]', '_', r['id'])[:40]
    start, end = float(r.get('start', 0)), float(r.get('end', 15))
    if r['url'].startswith('ytsearch'):
        # a search: find the real video first, so the clip always names the exact video it came from
        status(state='learning', id=cid, what=r.get('what'), url=r.get('url'), step='searching YouTube')
        s = subprocess.run(['yt-dlp', '--no-warnings', '--flat-playlist', '--print', '%(id)s\t%(title)s', r['url']], capture_output=True, text=True, timeout=90)
        line = (s.stdout.strip().splitlines() or [''])[0].split('\t')
        if len(line[0]) != 11: return {'ok': False, 'id': cid, 'reasons': ['YouTube search found nothing usable'], 'url': r['url']}
        r = {**r, 'url': f'https://www.youtube.com/watch?v={line[0]}', 'search': r['url'], 'found_title': line[1] if len(line) > 1 else None}
    status(state='learning', id=cid, what=r.get('what'), url=r.get('url'), step='downloading + tracking')
    os.makedirs(os.path.join(WORK, 'raw'), exist_ok=True)
    task = os.path.join(WORK, 'pose_full.task')
    if not os.path.exists(task): subprocess.run(['cp', os.path.join(REPO, 'public/mediapipe/pose_landmarker_full.task'), task], check=True)
    env = dict(os.environ, MOVES_DIR=WORK, MPLBACKEND='Agg')
    p = subprocess.run(['nice', '-n', '15', 'timeout', '1500', PY, os.path.join(PIPE, 'extract.py'), cid, r['url'], str(start), str(end), 'full'], env=env, capture_output=True, text=True)
    npz = os.path.join(WORK, 'raw', cid + '.npz')
    if p.returncode != 0 or not os.path.exists(npz):
        return {'ok': False, 'id': cid, 'reasons': ['could not download or track it: ' + (p.stderr.strip().splitlines() or ['?'])[-1][:160]]}
    status(state='learning', id=cid, what=r.get('what'), url=r.get('url'), step='retargeting onto her bones')
    n = len(np.load(npz)['t'])
    out, off, q, info = retarget.analyse(npz, 0.4, n / retarget.FPS - 0.4)
    reasons = []
    if q['detected'] <= 0.95: reasons.append('lost the person')
    if q['vis_legs'] <= 0.55: reasons.append('legs not visible')
    if q['jitter'] >= 0.036: reasons.append('jittery tracking')
    if q['bone_cv'] >= 0.23: reasons.append('limb lengths jumping (bad depth)')
    if q['feet_in_frame'] <= 0.95: reasons.append('feet out of frame')
    if q['energy_arms'] + q['energy_body'] < 0.12: reasons.append('barely moves')
    if reasons: return {'ok': False, 'id': cid, 'reasons': reasons, 'title': info.get('title'), 'url': info.get('webpage_url') or r['url']}
    j = retarget.to_json(out, off, len(off))
    json.dump(j, open(os.path.join(LEARNED, cid + '.json'), 'w'), separators=(',', ':'))
    os.chmod(os.path.join(LEARNED, cid + '.json'), 0o664)
    # the tracking overlay viewers see on the real video: every frame at the video's own fps (VIDEO mode), cached once
    status(state='learning', id=cid, what=r.get('what'), url=r.get('url'), step='tracking every frame for the overlay')
    try:
        subprocess.run(['nice', '-n', '15', 'timeout', '900', PY, os.path.join(PIPE, 'overlay.py'), cid, info.get('webpage_url') or r['url'], str(start), str(end), LEARNED, task], env=env, capture_output=True, text=True)
        os.chmod(os.path.join(LEARNED, cid + '-overlay.json'), 0o664)
    except Exception: pass
    return {'ok': True, 'clip': dict(id=cid, file=cid + '.json', label=r.get('label') or cid, what=r.get('what') or 'someone moving', kind=r.get('kind') or 'dance',
            moods=r.get('moods') or ['happy', 'neutral'], duration=j['duration'], mirror=True, learned_on_box=True, learned_at=int(time.time() * 1000),
            source=dict(url=info.get('webpage_url') or r['url'], title=info.get('title') or r.get('found_title'), channel=info.get('channel') or info.get('uploader'), start=start, end=end, search=r.get('search')),
            quality=dict(jitter=q['jitter'], legs_visible=q['vis_legs'], limb_stability=round(1 - q['bone_cv'], 3)))}

def main():
    os.makedirs(LEARNED, exist_ok=True)
    done = set()
    while True:
        try:
            idx = index(); done = {c['id'] for c in idx['clips']} | {x['id'] for x in idx.get('rejected', [])}
            reqs = [json.loads(l) for l in open(REQ)] if os.path.exists(REQ) else []
            todo = [r for r in reqs if re.sub(r'[^\w-]', '_', r['id'])[:40] not in done]
            if todo:
                avail = int(next(l.split()[1] for l in open('/proc/meminfo') if l.startswith('MemAvailable'))) // 1024
                if avail < 1800: status(state='waiting for free memory', avail_mb=avail); time.sleep(60); continue
                res = learn(todo[0])
                idx = index()
                if res['ok']: idx['clips'].append(res['clip'])
                else: idx.setdefault('rejected', []).append({k: res.get(k) for k in ('id', 'reasons', 'title', 'url')} | {'at': int(time.time() * 1000)})
                json.dump(idx, open(os.path.join(LEARNED, 'index.json'), 'w'), indent=1); os.chmod(os.path.join(LEARNED, 'index.json'), 0o664)
                status(state='idle', last={'id': res.get('id') or res.get('clip', {}).get('id'), 'ok': res['ok'], 'reasons': res.get('reasons')})
                for f in os.listdir(os.path.join(WORK, 'tmp')) if os.path.isdir(os.path.join(WORK, 'tmp')) else []: os.remove(os.path.join(WORK, 'tmp', f))
            else:
                time.sleep(30)
        except Exception as e:
            status(state='error', error=str(e)[:200]); time.sleep(60)

if __name__ == '__main__':
    main()
