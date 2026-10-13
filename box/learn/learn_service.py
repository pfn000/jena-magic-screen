# Jena learns new moves from online videos by herself: she queues a request (her learn_move skill writes
# ~/learned/move_requests.jsonl), this service (one video at a time, low priority, waits for free RAM)
# downloads a short slice (<=480p), tracks the person with MediaPipe Pose, retargets it onto her VRM bones
# with the same pipeline that built her first moves (moves-pipeline/), checks the quality honestly and
# saves the clip to ~jena/learned/moves/ where her site picks it up. Rejected videos are reported with why.
import json, os, re, subprocess, sys, time
REPO = os.environ.get('JENA_REPO', '/home/user/tab/files/jena-magic-screen/repo')
PIPE = os.environ.get('JENA_PIPE', os.path.join(REPO, 'moves-pipeline'))
WORK = os.environ.get('MOVES_DIR', '/home/user/tab/files/jena-learn')
PY = os.environ.get('MOVES_PY', '/home/user/moves-venv/bin/python')
LEARNED = '/home/jena/learned/moves'
REQ = '/home/jena/learned/move_requests.jsonl'
STATUS = os.path.join(LEARNED, 'status.json')
MIN_FREE = int(os.environ.get('JENA_LEARN_MIN_FREE_MB', '1100'))  # the service itself is capped by MemoryMax
sys.path.insert(0, PIPE)
os.environ['MPLBACKEND'] = 'Agg'

def status(**k):
    s = {'at': int(time.time() * 1000), **k}
    json.dump(s, open(STATUS, 'w')); os.chmod(STATUS, 0o664)

def index():
    p = os.path.join(LEARNED, 'index.json')
    try: return json.load(open(p))
    except Exception: return {'version': 1, 'note': 'Moves Jena learned by herself on her box from online videos (same pipeline as her first moves).', 'clips': [], 'rejected': []}

# teen-appropriate only: a title blocklist + YouTube's own age gate (age_limit must be 0)
BAD = re.compile(r"\b(sex|porn|nude|naked|nsfw|onlyfans|fetish|erotic|hentai|xxx|twerk|strip|lingerie|bikini|sexy|hot girl|"
                 r"pole dance|lap dance|seductive|kiss\w*|drunk|beer|vodka|weed|vape|guns?|knife|fight\w*|gore|horror|prank\w*)\b", re.I)
def teen_safe(title): return bool(title) and not BAD.search(title)
def age_ok(vid):
    try:
        s = subprocess.run(['yt-dlp', '--no-warnings', '--skip-download', '--print', '%(age_limit)s', 'https://www.youtube.com/watch?v=' + vid], capture_output=True, text=True, timeout=60)
        return s.returncode == 0 and s.stdout.strip() in ('0', 'NA', 'None')
    except Exception: return False
def used_video_ids():
    ids = set()
    for p in (os.path.join(LEARNED, 'index.json'), os.path.join(REPO, 'public/moves/index.json')):
        try:
            d = json.load(open(p))
            for c in d.get('clips', []) + d.get('rejected', []):
                m = re.search(r'[?&]v=([\w-]{11})', (c.get('source') or {}).get('url', '') or c.get('url') or '')
                if m: ids.add(m.group(1))
        except Exception: pass
    return ids

# idle time: if nobody (mama, chat or her own idle choice) asked for a move in AUTO_MIN minutes, she picks one
# herself from safe ideas she hasn't tried, so her library keeps growing (~1 new clip per 30 min of idle).
AUTO_MIN = float(os.environ.get('JENA_LEARN_AUTO_MIN', '30'))
AUTO_IDEAS = ['just dance kids', 'easy tiktok dance tutorial', 'zumba kids warm up', 'hip hop dance basics for beginners',
    'shuffle dance tutorial beginner', 'floss dance tutorial', 'cupid shuffle dance', 'electric slide line dance',
    'cotton eye joe line dance', 'chicken dance kids', 'robot dance tutorial', 'the wobble line dance', 'ymca dance',
    'stretching routine for kids', 'jumping jacks exercise demo', 'tai chi for beginners short', 'yoga for kids short',
    'salsa basic step tutorial', 'charleston dance basic step', 'macarena dance kids', 'penguin dance kids',
    'waving hello reference', 'clapping reference video', 'thinking pose reference', 'excited jump celebration reference',
    'shrug gesture reference', 'victory pose reference', 'gangnam style dance tutorial', 'kpop dance tutorial easy mirrored', 'moonwalk tutorial',
    '3D people animation casual standing talking', '3D people animation casual walking in place', '3D people animation cheering',
    'mocap reference idle standing', 'mocap reference dance', 'animation reference clapping full body', 'animation reference stretching full body']
def auto_request(reqs):
    # aim: one NEW clip per AUTO_MIN minutes. A rejected try (bad tracking) doesn't count, so she tries another
    # idea a few minutes later; nothing is queued while something is still waiting.
    tried = {r.get('id') for r in reqs}
    last_req = max([r.get('ts', 0) for r in reqs], default=0) / 1000
    last_ok = max([c.get('learned_at', 0) for c in index().get('clips', [])], default=0) / 1000
    if time.time() - last_ok < AUTO_MIN * 60 or time.time() - last_req < 4 * 60: return None
    ideas = [q for q in AUTO_IDEAS if 'q_' + re.sub(r'\W+', '_', q.lower())[:30] not in tried]
    if not ideas: return None
    import random
    q = random.choice(ideas)
    kind = 'idle' if 'reference' in q else 'stretch' if re.search(r'stretch|yoga|tai chi|jumping', q) else 'dance'
    r = {'id': 'q_' + re.sub(r'\W+', '_', q.lower())[:30], 'url': f'ytsearch5:{q} full body', 'start': 0.0, 'end': 15.0,
         'what': f'someone doing "{q}" (a video I picked myself)', 'label': q[:30], 'kind': kind, 'asked': 'my own idea (idle time)', 'auto': True, 'ts': int(time.time() * 1000)}
    with open(REQ, 'a') as f: f.write(json.dumps(r) + '\n')
    return r

def learn(r):
    import numpy as np, retarget
    cid = re.sub(r'[^\w-]', '_', r['id'])[:40]
    start, end = float(r.get('start', 0)), float(r.get('end', 15))
    if r['url'].startswith('ytsearch'):
        # a search: find the real video first, so the clip always names the exact video it came from
        status(state='learning', id=cid, what=r.get('what'), url=r.get('url'), step='searching YouTube (clean, all-ages only)')
        s = subprocess.run(['yt-dlp', '--no-warnings', '--flat-playlist', '--print', '%(id)s\t%(title)s', r['url']], capture_output=True, text=True, timeout=90)
        line = ['']
        for cand in s.stdout.strip().splitlines():
            c = cand.split('\t')
            if len(c[0]) == 11 and c[0] not in used_video_ids() and teen_safe(c[1] if len(c) > 1 else '') and age_ok(c[0]): line = c; break
        if len(line[0]) != 11: return {'ok': False, 'id': cid, 'reasons': ['YouTube search found nothing usable (new, clean and all-ages)'], 'url': r['url']}
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
            if not todo:
                a = auto_request(reqs)
                if a: todo = [a]
            if todo:
                avail = int(next(l.split()[1] for l in open('/proc/meminfo') if l.startswith('MemAvailable'))) // 1024
                if avail < MIN_FREE: status(state='waiting for free memory', avail_mb=avail, need_mb=MIN_FREE, next=todo[0].get('label')); time.sleep(60); continue
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
