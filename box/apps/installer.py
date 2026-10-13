#!/usr/bin/env python3
"""Jena's app installer (runs as her own unix user, nice 19).

  installer.py install <app>     queue -> GitHub builds it -> download -> sha256 check -> install -> ready
  installer.py status [app]      what is installing / installed (JSON)
  installer.py list              apps she can install (from ops/apps/apps.json)
  installer.py remove <app>

How it reaches GitHub: Jena never holds a GitHub token. The request goes into ~/jena-apps/spool/<id>.json; Tab sends it
to the jena-apps workflow through Saidie's connected GitHub app (`jena-apps-gh drain`) and writes the run URL back.
The finished package and its manifest come from the public release jena-app-<name> (no token needed).

Status for N•OS and her chat: ~/.jena/apps_status.json
  {"<app>": {"status": "queued|building|downloading|installing|ready|failed", "progress": 0-100, "error": null|"...",
             "title", "version", "run_url", "path", "exec", "desktop_file", "updated"}}
"""
import fcntl, hashlib, json, os, re, shutil, subprocess, sys, tarfile, time, urllib.request, uuid

HOME = os.path.expanduser('~')
BASE = os.path.join(HOME, 'jena-apps')
SPOOL = os.path.join(BASE, 'spool')
CACHE = os.path.join(BASE, 'cache')
APPS_DIR = os.path.join(HOME, 'Apps')
DESKTOP_DIR = os.path.join(HOME, '.local', 'share', 'applications')
STATUS = os.path.join(HOME, '.jena', 'apps_status.json')
LOG = os.path.join(BASE, 'installer.log')
REPO = 'pfn000/jena-magic-screen'
MIN_FREE = 1 << 30            # never leave less than 1 GB free
POLL = 15
TIMEOUT = 2 * 3600

def log(*a):
    line = time.strftime('%Y-%m-%dT%H:%M:%S ') + ' '.join(str(x) for x in a)
    print(line, flush=True)
    try: open(LOG, 'a').write(line + '\n')
    except Exception: pass

def apps_list():
    for p in (os.path.join(HOME, 'jena-repo', 'ops', 'apps', 'apps.json'), os.path.join(BASE, 'apps.json')):
        try: return json.load(open(p))['apps']
        except Exception: continue
    return {}

def _locked(fn):
    os.makedirs(os.path.dirname(STATUS), exist_ok=True)
    with open(STATUS + '.lock', 'a') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        try: cur = json.load(open(STATUS))
        except Exception: cur = {}
        new = fn(cur)
        if new is not None:
            tmp = STATUS + '.tmp'; json.dump(new, open(tmp, 'w'), indent=1); os.replace(tmp, STATUS)
        return cur if new is None else new

def set_status(name, **kw):
    def f(cur):
        e = cur.get(name) or {}
        e.update(kw); e['updated'] = int(time.time())
        if kw.get('status') and kw['status'] != 'failed': e.setdefault('error', None)
        if kw.get('status') in ('queued', 'building', 'downloading', 'installing', 'ready'): e['error'] = kw.get('error')
        cur[name] = e; return cur
    _locked(f); log(name, kw)

def read_status(): return _locked(lambda cur: None)

def free_bytes(): return shutil.disk_usage(HOME).free

def gb(b): return f'{b / (1 << 30):.2f} GB'

def disk_ok(name, need_bytes, what):
    free = free_bytes()
    if free - need_bytes < MIN_FREE:
        set_status(name, status='failed', progress=0,
                   error=f'not enough disk: {gb(free)} free, {what} needs about {gb(need_bytes)}, which would leave under 1 GB. Waiting for a bigger disk.')
        return False
    return True

def fetch(url, dest=None, limit=None):
    req = urllib.request.Request(url, headers={'User-Agent': 'jena-apps/1', 'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(req, timeout=120) as r:
        if dest is None: return r.read(limit or 1 << 20)
        n = 0
        with open(dest, 'wb') as f:
            while True:
                b = r.read(1 << 16)
                if not b: break
                n += len(b)
                if limit and n > limit: raise RuntimeError('download is bigger than its manifest says')
                f.write(b)
        return dest

def rel_url(name, file): return f'https://github.com/{REPO}/releases/download/jena-app-{name}/{file}'

def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()

def write_desktop(name, app, man, root):
    os.makedirs(DESKTOP_DIR, exist_ok=True)
    d = dict(man.get('desktop') or app.get('desktop') or {})
    if man['kind'] == 'output':
        ex = f'mousepad {root}/output.txt'
        d.setdefault('Name', (man.get('title') or name) + ' (result)')
        d.setdefault('Icon', 'text-x-generic')
    else:
        ex = os.path.join(root, man['exec'])
        if man.get('terminal'):
            st = os.path.join(APPS_DIR, 'st', 'bin', 'st-launch')
            ex = f'{st} -e {ex}' if os.path.exists(st) else ex
            if not os.path.exists(st): d['Terminal'] = 'true'
    lines = ['[Desktop Entry]', 'Type=Application', f'Name={d.get("Name", name)}', f'Exec={ex}', f'Icon={d.get("Icon", "application-x-executable")}',
             f'Comment={d.get("Comment", man.get("title", name))}', f'Categories={d.get("Categories", "Utility;")}', f'Terminal={d.get("Terminal", "false")}',
             f'X-Jena-App={name}', f'X-Jena-Version={man.get("version", "")}', f'X-Jena-Run={man.get("run_url", "")}']
    p = os.path.join(DESKTOP_DIR, f'jena-app-{name}.desktop')
    open(p, 'w').write('\n'.join(lines) + '\n'); os.chmod(p, 0o755)
    return p, ex

def install(name):
    apps = apps_list()
    app = apps.get(name)
    if not app:
        set_status(name, status='failed', progress=0, error=f'"{name}" is not in my app list'); return 2
    if not app.get('enabled'):
        set_status(name, status='failed', progress=0, title=app.get('title', name), error=app.get('disabled_reason') or 'this app is switched off'); return 2
    est = int(app.get('est_install_mb', 50)) << 20
    if not disk_ok(name, est * 2, app.get('title', name)): return 3
    os.makedirs(SPOOL, exist_ok=True); os.makedirs(CACHE, exist_ok=True)
    set_status(name, status='queued', progress=2, title=app.get('title', name), run_url=None, error=None)
    lk = open(os.path.join(BASE, '.install.lock'), 'a')
    fcntl.flock(lk, fcntl.LOCK_EX)          # one install at a time; the others stay "queued"
    rid = f'{re.sub(r"[^a-z0-9]", "", name)[:16]}-{time.strftime("%m%d%H%M%S")}-{uuid.uuid4().hex[:4]}'
    sp = os.path.join(SPOOL, rid + '.json')
    spool = {'request_id': rid, 'app': name, 'workflow': 'jena-apps.yml', 'inputs': {'app': name, 'request_id': rid},
             'state': 'pending', 'asked_at': time.time(), 'asked_by': 'jena'}
    json.dump(spool, open(sp + '.tmp', 'w'), indent=1); os.replace(sp + '.tmp', sp)
    try: os.chmod(sp, 0o660)
    except Exception: pass
    set_status(name, status='queued', progress=5, request_id=rid, note='asked Tab to send it to GitHub')
    t0 = time.time(); man = None; last_state = None
    while time.time() - t0 < TIMEOUT:
        try: s = json.load(open(sp))
        except Exception: s = spool
        st = s.get('state')
        if st == 'dispatch_failed':
            set_status(name, status='failed', progress=0, error='GitHub would not start the build: ' + str((s.get('dispatch') or {}).get('error'))[:160]); return 4
        if st in ('dispatched', 'running', 'completed'):
            run = s.get('run') or {}
            jobs = run.get('jobs') or []
            donej = sum(1 for j in jobs if j.get('status') == 'completed')
            prog = 15 + int(45 * donej / max(1, len(jobs))) if jobs else 15
            if (st, prog) != last_state:
                set_status(name, status='building', progress=prog, run_url=s.get('run_url'))
                last_state = (st, prog)
            if st == 'completed' and run.get('conclusion') not in (None, 'success'):
                set_status(name, status='failed', progress=0, run_url=s.get('run_url'), error=f'the GitHub build ended: {run.get("conclusion")}'); return 4
        try:
            m = json.loads(fetch(rel_url(name, f'{name}.manifest.json') + f'?t={int(time.time())}'))
            if m.get('request_id') == rid: man = m; break
        except Exception:
            pass
        time.sleep(POLL)
    if not man:
        set_status(name, status='failed', progress=0, error='no build came back from GitHub within 2 hours'); return 5
    pkg = man['package']
    set_status(name, status='downloading', progress=65, version=man.get('version'), run_url=man.get('run_url'))
    need = pkg['size'] + pkg.get('unpacked_size', pkg['size'] * 3)
    if not disk_ok(name, need, f'{name} ({gb(pkg["size"])} download)'): return 3
    dest = os.path.join(CACHE, pkg['file'])
    fetch(rel_url(name, pkg['file']), dest, limit=pkg['size'] + 1)
    got = sha256(dest)
    if got != pkg['sha256'] or os.path.getsize(dest) != pkg['size']:
        os.remove(dest)
        set_status(name, status='failed', progress=0, error=f'download check failed (sha256 {got[:12]}… is not {pkg["sha256"][:12]}…)'); return 6
    set_status(name, status='installing', progress=85, sha256=got, size=pkg['size'])
    tmp = os.path.join(APPS_DIR, f'.{name}.new'); root = os.path.join(APPS_DIR, name)
    shutil.rmtree(tmp, True); os.makedirs(tmp)
    with tarfile.open(dest) as t:
        for mem in t.getmembers():
            if mem.name.startswith('/') or '..' in mem.name.split('/'): raise RuntimeError('unsafe path in package')
        t.extractall(tmp)
    inner = os.path.join(tmp, name)
    if man['kind'] == 'install':
        chk = os.path.join(inner, man.get('check') or man['exec'])
        if not os.path.exists(chk):
            set_status(name, status='failed', progress=0, error=f'{man.get("check") or man["exec"]} is missing from the package'); return 7
        ld = subprocess.run(['ldd', chk], capture_output=True, text=True)
        missing = [l.split()[0] for l in ld.stdout.splitlines() if 'not found' in l]
        if missing:
            set_status(name, status='failed', progress=0, error='missing libraries on my box: ' + ', '.join(missing[:6])); return 7
    json.dump(man, open(os.path.join(inner, '.jena-manifest.json'), 'w'), indent=1)
    old = os.path.join(APPS_DIR, f'.{name}.old'); shutil.rmtree(old, True)
    if os.path.exists(root): os.replace(root, old)
    os.replace(inner, root); shutil.rmtree(tmp, True); shutil.rmtree(old, True)
    os.remove(dest)
    desk, ex = write_desktop(name, app, man, root)
    extra = {}
    if man['kind'] == 'output':
        extra = {'result': {k: man['result'].get(k) for k in ('exit_code', 'command', 'windows', 'seconds')}, 'output': os.path.join(root, 'output.txt')}
    set_status(name, status='ready', progress=100, path=root, exec=ex, desktop_file=desk, kind=man['kind'], version=man.get('version'),
               run_url=man.get('run_url'), installed_at=int(time.time()), **extra)
    try: os.remove(sp)
    except Exception: pass
    return 0

def remove(name):
    root = os.path.join(APPS_DIR, name)
    shutil.rmtree(root, True)
    try: os.remove(os.path.join(DESKTOP_DIR, f'jena-app-{name}.desktop'))
    except FileNotFoundError: pass
    _locked(lambda cur: {k: v for k, v in cur.items() if k != name})
    return 0

def main(a):
    try: os.nice(19 - os.nice(0))
    except Exception: pass
    for d in (BASE, SPOOL, CACHE, APPS_DIR): os.makedirs(d, exist_ok=True)
    op = a[0] if a else 'status'
    if op == 'install' and len(a) > 1:
        try: return install(a[1].lower())
        except Exception as e:
            set_status(a[1].lower(), status='failed', progress=0, error=f'{type(e).__name__}: {str(e)[:200]}'); return 9
    if op == 'remove' and len(a) > 1: return remove(a[1].lower())
    if op == 'list':
        print(json.dumps({k: {'title': v.get('title', k), 'about': v.get('about'), 'enabled': v.get('enabled'), 'platform': v.get('platform'),
                              'why_off': v.get('disabled_reason')} for k, v in apps_list().items()}, indent=1)); return 0
    s = read_status()
    print(json.dumps(s.get(a[1]) if len(a) > 1 else s, indent=1)); return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
