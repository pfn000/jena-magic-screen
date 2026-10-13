#!/usr/bin/env python3
"""Jena's compute offload: send heavy work to GitHub's free runners instead of pinning her box's CPU.

  offload.py submit <job> <input> [params]   job: move_extract | mama_session | model_job | ux_test
                                             input: an https URL, or a local file (a clip, a session video; <= 25 MB)
  offload.py wait <request_id>               (submit starts this itself, detached, at nice 19)
  offload.py status [request_id]

Status: ~/.jena/offload_status.json  {"<request_id>": {"job", "status": queued|running|downloading|done|failed,
         "progress", "run_url", "result_dir", "result", "error", "updated"}}
Results unpack to ~/jena-apps/offload/<request_id>/. Like the app installer, Jena holds no GitHub token: Tab sends the
request to the jena-compute workflow through the connected GitHub app (`jena-apps-gh drain`, which also uploads a local
input as a git blob), and the result comes back from the public release jena-compute-<job>."""
import fcntl, json, os, re, shutil, subprocess, sys, tarfile, time, uuid
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import installer as I
HOME = I.HOME; SPOOL = I.SPOOL
OUTDIR = os.path.join(I.BASE, 'offload')
STATUS = os.path.join(HOME, '.jena', 'offload_status.json')
JOBS = {'move_extract', 'mama_session', 'model_job', 'ux_test'}
MAX_UPLOAD = 25 << 20

def _upd(rid, **kw):
    os.makedirs(os.path.dirname(STATUS), exist_ok=True)
    with open(STATUS + '.lock', 'a') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        try: cur = json.load(open(STATUS))
        except Exception: cur = {}
        e = cur.get(rid) or {}; e.update(kw); e['updated'] = int(time.time()); cur[rid] = e
        # keep the 40 newest
        if len(cur) > 40: cur = dict(sorted(cur.items(), key=lambda kv: kv[1].get('updated', 0))[-40:])
        tmp = STATUS + '.tmp'; json.dump(cur, open(tmp, 'w'), indent=1); os.replace(tmp, STATUS)
    I.log('offload', rid, kw)

def submit(job, inp, params='', detach=True):
    assert job in JOBS, f'job must be one of {sorted(JOBS)}'
    rid = f'{job.split("_")[0]}-{time.strftime("%m%d%H%M%S")}-{uuid.uuid4().hex[:4]}'
    os.makedirs(SPOOL, exist_ok=True)
    s = {'request_id': rid, 'kind': 'compute', 'workflow': 'jena-compute.yml', 'state': 'pending', 'asked_at': time.time(), 'asked_by': 'jena',
         'inputs': {'job': job, 'input': '', 'params': params, 'request_id': rid}}
    if inp.startswith('https://'):
        s['inputs']['input'] = inp
    else:
        p = os.path.abspath(os.path.expanduser(inp))
        if not os.path.isfile(p): raise SystemExit(f'no such file: {inp}')
        if os.path.getsize(p) > MAX_UPLOAD: raise SystemExit('input is over 25 MB; cut or downscale it first')
        if not I.disk_ok('offload', os.path.getsize(p) * 3, 'the offload'): raise SystemExit('not enough disk')
        dst = os.path.join(SPOOL, rid + os.path.splitext(p)[1]); shutil.copy(p, dst); os.chmod(dst, 0o660)
        s['upload'] = os.path.basename(dst)
    if job == 'mama_session' and params and os.path.isfile(os.path.expanduser(params)):   # an actions.jsonl to align
        dst = os.path.join(SPOOL, rid + '.actions.jsonl'); shutil.copy(os.path.expanduser(params), dst); os.chmod(dst, 0o660)
        s['upload_params'] = os.path.basename(dst); s['inputs']['params'] = ''
    sp = os.path.join(SPOOL, rid + '.json'); json.dump(s, open(sp + '.tmp', 'w'), indent=1); os.replace(sp + '.tmp', sp); os.chmod(sp, 0o660)
    _upd(rid, job=job, status='queued', progress=5, input=inp if inp.startswith('https://') else os.path.basename(inp), error=None, asked_at=int(time.time()))
    if detach:
        log = open(os.path.join(I.BASE, 'offload.out'), 'a')
        subprocess.Popen(['nice', '-n', '19', sys.executable, os.path.abspath(__file__), 'wait', rid], stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
    print(json.dumps({'ok': True, 'request_id': rid})); return rid

def wait(rid, timeout=3 * 3600):
    sp = os.path.join(SPOOL, rid + '.json')
    s = json.load(open(sp)); job = s['inputs']['job']
    t0 = time.time(); man = None; last = None
    base = f'https://github.com/{I.REPO}/releases/download/jena-compute-{job}/'
    while time.time() - t0 < timeout:
        try: s = json.load(open(sp))
        except Exception: pass
        st = s.get('state')
        if st == 'dispatch_failed':
            _upd(rid, status='failed', error='GitHub would not start it: ' + str((s.get('dispatch') or {}).get('error'))[:160]); return 4
        if st in ('dispatched', 'running', 'completed') and (st, s.get('run_url')) != last:
            _upd(rid, status='running', progress=40 if st == 'running' else 20, run_url=s.get('run_url')); last = (st, s.get('run_url'))
        if st == 'completed' and (s.get('run') or {}).get('conclusion') not in (None, 'success'):
            _upd(rid, status='failed', error=f"the GitHub run ended: {s['run']['conclusion']}", run_url=s.get('run_url')); return 4
        try:
            man = json.loads(I.fetch(base + f'{rid}.manifest.json?t={int(time.time())}'))
            if man.get('request_id') == rid: break
            man = None
        except Exception: pass
        time.sleep(I.POLL)
    if not man:
        _upd(rid, status='failed', error='no result came back within 3 hours'); return 5
    _upd(rid, status='downloading', progress=80, run_url=man.get('run_url'))
    pkg = man['package']
    if not I.disk_ok('offload', pkg['size'] * 4, 'the result'): _upd(rid, status='failed', error='not enough disk for the result'); return 3
    os.makedirs(OUTDIR, exist_ok=True)
    dest = os.path.join(OUTDIR, pkg['file']); I.fetch(base + pkg['file'], dest, limit=pkg['size'] + 1)
    if I.sha256(dest) != pkg['sha256']:
        os.remove(dest); _upd(rid, status='failed', error='result failed its sha256 check'); return 6
    with tarfile.open(dest) as t:
        for m in t.getmembers():
            if m.name.startswith('/') or '..' in m.name.split('/'): raise RuntimeError('unsafe path')
        t.extractall(OUTDIR)
    os.remove(dest)
    json.dump(man, open(os.path.join(OUTDIR, rid, 'manifest.json'), 'w'), indent=1)
    for f in (sp, os.path.join(SPOOL, rid + '.mp4'), os.path.join(SPOOL, rid + '.actions.jsonl')):
        try: os.remove(f)
        except FileNotFoundError: pass
    for f in os.listdir(SPOOL):
        if f.startswith(rid + '.'):
            try: os.remove(os.path.join(SPOOL, f))
            except Exception: pass
    _upd(rid, status='done', progress=100, result_dir=os.path.join(OUTDIR, rid), result=man.get('result'), seconds_on_github=man.get('seconds'))
    return 0

def main(a):
    try: os.nice(19 - os.nice(0))
    except Exception: pass
    op = a[0] if a else 'status'
    if op == 'submit' and len(a) >= 3: submit(a[1], a[2], a[3] if len(a) > 3 else '', detach='--no-wait' not in a); return 0
    if op == 'wait' and len(a) > 1: return wait(a[1])
    try: cur = json.load(open(STATUS))
    except Exception: cur = {}
    print(json.dumps(cur.get(a[1]) if len(a) > 1 else cur, indent=1)); return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
