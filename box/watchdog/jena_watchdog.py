#!/usr/bin/env python3
"""Jena watchdog: keeps an eye on every Jena service on her box, heals what it can, and logs everything.

Runs as root (it must be able to `systemctl restart`), niced, stdlib + PIL only, NO browser.
  * every ~20 s: systemd state of each jena-* unit (crash restarts via NRestarts, pid changes) + an HTTP probe
  * flap = >=3 crash-restarts / watchdog-restarts / down->up cycles of one unit inside 10 min
  * ladder per unit: restart the unit -> if it keeps flapping and its deployed files changed in the last 2 h
    (and differ from the known-good snapshot), put the known-good files back (or log what it WOULD do in
    dry-run) -> still bad: mark degraded and stop touching it
  * known-good = the files a unit ran with after >=30 min healthy (snapshot + the git commit they match)
  * never reads passwords/cookies; never stops a unit (only `systemctl restart`); a unit someone stopped on
    purpose (inactive) is left alone; the tunnel is watched only (jena-tunnel-watchdog.timer owns its restarts)
  * behavior recorder: her replies, actions, skills, thoughts, self-catches, errors -> behavior.jsonl,
    one censored frame thumbnail every ~2 min; logs + frames capped at 200 MB
  * tiny HTTP door on 127.0.0.1:6087 (the gateway passes /box/incident and /box/watch/* here):
      POST /box/incident        site reporter (no PII, rate-limited)
      GET  /box/watch/health    public: {status} only; with mama's passcode (X-Jena-Key): everything
CLI: jena_watchdog.py [run|status|pause MIN|resume|clear UNIT|selftest]
"""
import hashlib, http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time, urllib.request
from collections import deque

J = '/home/jena/.jena'
STATE = '/var/lib/jena-watchdog'
CONF = '/etc/jena-watchdog.json'
INCIDENTS = os.path.join(J, 'incidents.jsonl')
BEHAVIOR = os.path.join(J, 'behavior.jsonl')
FRAMES = os.path.join(J, 'behavior_frames')
MAMA_HASH = os.path.join(J, 'mama.sha256')
PAUSE = '/run/jena-watchdog.pause'
REPO = '/home/user/tab/files/jena-magic-screen/repo'
CF_LOG = '/home/user/tab/state/jena-box/cloudflared.log'
PORT = 6087
TICK = 20
FLAP_N, FLAP_WIN = 3, 600
GOOD_AFTER = 1800
RECENT_DEPLOY = 7200
CAP_BYTES = 200 * 1024 * 1024
DESK = 'http://127.0.0.1:6081'

# unit -> probe url (None = systemd state only), deployed files -> repo path (for the commit they match)
UNITS = {
    'jena-gateway': {'probe': 'http://127.0.0.1:8088/health', 'files': {REPO + '/box/jena-gateway.mjs': 'box/jena-gateway.mjs', REPO + '/box/jena-truth.mjs': 'box/jena-truth.mjs'}},
    'jena-llm-chat': {'probe': 'http://127.0.0.1:8091/health', 'files': {}},
    'jena-llm-jx0': {'probe': 'http://127.0.0.1:8089/health', 'files': {}},
    'jena-tts': {'probe': 'http://127.0.0.1:8095/voices', 'files': {'/home/user/tab/files/jena-voice/tts_server.py': None}},
    'jena-stt': {'probe': 'http://127.0.0.1:8096/health', 'files': {'/home/jena/.jena_stt.py': None}},
    'jena-desk': {'probe': DESK + '/box/screen.json', 'files': {'/home/jena/.jena_desk.py': 'box/desktop/jena_desk.py', '/home/jena/jena_censor.py': 'box/desktop/jena_censor.py', '/home/jena/jena_skills.py': 'box/desktop/jena_skills.py'}},
    'jena-tunnel': {'probe': None, 'files': {}, 'watch_only': True},
    'jena-xvfb': {'probe': None, 'files': {}}, 'jena-wm': {'probe': None, 'files': {}}, 'jena-panel': {'probe': None, 'files': {}},
    'jena-vnc': {'probe': None, 'files': {}}, 'jena-novnc': {'probe': None, 'files': {}},
    'jena-vnc-mama': {'probe': None, 'files': {}}, 'jena-novnc-mama': {'probe': None, 'files': {}},
    'jena-learn': {'probe': None, 'files': {}}, 'jena-ci': {'probe': None, 'files': {}},
}

def now(): return time.time()
def iso(t=None): return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t or now()))
def conf():
    try: return json.load(open(CONF))
    except Exception: return {}
def rollback_mode(unit):
    c = conf().get('rollback', {})
    return c.get(unit, c.get('default', 'live'))

SECRETISH = [(re.compile(r'[\w.+-]+@[\w-]+\.[\w.-]+'), '[email]'), (re.compile(r'\b\d{1,3}(?:\.\d{1,3}){3}\b'), '[ip]'),
             (re.compile(r'\b(?:sk|pk|ghp|gho|hf|xox[bp])[-_][A-Za-z0-9_-]{8,}'), '[key]'), (re.compile(r'\b\d{6,}\b'), '[num]'),
             (re.compile(r'(https?://[^\s?#]+)[?#]\S*'), r'\1'), (re.compile(r'\+?\d[\d\s().-]{8,}\d'), '[phone]')]
def scrub(s, n=240):
    s = re.sub(r'\s+', ' ', str(s or ''))[:n * 2]
    for rx, rep in SECRETISH: s = rx.sub(rep, s)
    return s[:n]

def jappend(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    new = not os.path.exists(path)
    with open(path, 'a') as f: f.write(json.dumps(obj, ensure_ascii=False) + '\n')
    if new:
        try: shutil.chown(path, 'jena', 'jena'); os.chmod(path, 0o640)
        except Exception: pass

def http_get(url, timeout=4, data=None, headers=None):
    t = now()
    try:
        req = urllib.request.Request(url, data=data, headers=headers or {})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(2_000_000)
            return {'ok': 200 <= r.status < 300, 'status': r.status, 'ms': int((now() - t) * 1000), 'body': body, 'headers': dict(r.headers)}
    except Exception as e:
        return {'ok': False, 'status': getattr(e, 'code', 0), 'ms': int((now() - t) * 1000), 'error': scrub(str(e), 120), 'body': b'', 'headers': {}}

def sh(*cmd, timeout=15):
    try: return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except Exception as e: return ''

def sysd(unit):
    out = sh('systemctl', 'show', unit + '.service', '-p', 'ActiveState,SubState,NRestarts,MainPID,ActiveEnterTimestampMonotonic')
    d = dict(l.split('=', 1) for l in out.splitlines() if '=' in l)
    up_s = None
    try:
        mono = int(d.get('ActiveEnterTimestampMonotonic', '0'))
        if mono: up_s = time.clock_gettime(time.CLOCK_MONOTONIC) - mono / 1e6
    except Exception: pass
    return {'active': d.get('ActiveState', '?'), 'sub': d.get('SubState', '?'), 'nrestarts': int(d.get('NRestarts', '0') or 0), 'pid': int(d.get('MainPID', '0') or 0), 'up_s': up_s}

def sha_file(p):
    try: return hashlib.sha256(open(p, 'rb').read()).hexdigest()
    except Exception: return None

def git(*a): return sh('git', '-c', 'safe.directory=*', '-C', REPO, *a, timeout=20).strip()

def commit_for(path, repo_path):
    """the newest repo commit whose copy of repo_path is byte-identical to the deployed file (or None)"""
    if not repo_path or not os.path.exists(path): return None
    blob = sh('git', 'hash-object', path).strip()
    for c in git('log', '--format=%H', '-n', '60', 'origin/main', '--', repo_path).split():
        if git('rev-parse', f'{c}:{repo_path}') == blob: return c[:7]
    return None

# ------------------------------------------------------------------ state
class Unit:
    def __init__(self, name, spec):
        self.name, self.spec = name, spec
        self.events = deque(maxlen=200)       # (ts, kind)
        self.last = None                      # last sysd()
        self.probe_ok = None; self.fail_streak = 0; self.last_probe = None
        self.healthy_since = None
        self.level = 0; self.level_at = 0; self.last_wd_restart = 0
        self.degraded = False; self.degraded_why = ''; self.settled_at = 0; self.bootstrap = False; self.manual_at = 0
    def flaps(self, win=FLAP_WIN, after=0):
        """restart / down->up events in the window; a 'wake' within 60 s of another counted event is the same blip"""
        t = now(); out = []
        for e in sorted(self.events):
            if t - e[0] > win or e[0] <= after or e[1] not in ('crash_restart', 'wd_restart', 'wake'): continue
            if e[1] == 'wake' and out and e[0] - out[-1][0] < 60: continue
            out.append(e)
        return out

UNITS_STATE = {n: Unit(n, s) for n, s in UNITS.items()}
GOOD = {}       # unit -> {at, files:{path:{sha, commit}}, dir}
EXTRA = {'tunnel': {}, 'frame': {}, 'chat': {}, 'firefox': {}, 'site_reports': deque(maxlen=50), 'started': now()}
LOCK = threading.Lock()

def load_good():
    global GOOD
    try: GOOD = json.load(open(os.path.join(STATE, 'known_good.json')))
    except Exception: GOOD = {}
def save_good():
    os.makedirs(STATE, exist_ok=True)
    tmp = os.path.join(STATE, 'known_good.json.tmp'); json.dump(GOOD, open(tmp, 'w'), indent=1); os.replace(tmp, os.path.join(STATE, 'known_good.json'))

def incident(unit, what, detail='', action='none', result='', **extra):
    g = GOOD.get(unit) or {}
    rec = {'ts': int(now() * 1000), 'iso': iso(), 'unit': unit, 'what': what, 'detail': scrub(detail, 400), 'action': action, 'result': scrub(result, 400),
           'last_good': ({'at': iso(g['at']), 'commits': {os.path.basename(p): v.get('commit') or ('sha256:' + (v.get('sha') or '')[:12]) for p, v in g.get('files', {}).items()}} if g else None)}
    rec.update(extra)
    with LOCK: jappend(INCIDENTS, rec)
    print('INCIDENT', json.dumps(rec, ensure_ascii=False), flush=True)
    return rec

def paused():
    try: return float(open(PAUSE).read().strip() or 0) > now()
    except Exception: return False

def restart(u, why):
    if paused(): incident(u.name, 'would_restart', why, 'none', 'watchdog is paused (maintenance)'); return False
    if u.name == 'jena-desk' and EXTRA['frame'].get('private'):
        incident(u.name, 'would_restart', why, 'none', 'held: mama is driving / a private sign-in window is open'); return False
    t0 = now(); sh('systemctl', 'restart', u.name + '.service', timeout=60)
    u.last_wd_restart = now(); u.events.append((now(), 'wd_restart'))
    time.sleep(3); s = sysd(u.name)
    ok = s['active'] == 'active'
    if u.spec.get('probe'):
        for _ in range(10):
            if http_get(u.spec['probe'], 4)['ok']: break
            time.sleep(3)
        else: ok = False
    u.last = s; u.settled_at = now()
    if ok: u.probe_ok = True; u.fail_streak = 0
    incident(u.name, 'restarted', why, 'systemctl restart', ('back up' if ok else 'still not answering') + f' after {now() - t0:.0f}s')
    return ok

# ------------------------------------------------------------------ known-good + rollback
def file_state(u):
    return {p: {'sha': sha_file(p), 'mtime': (os.path.getmtime(p) if os.path.exists(p) else None)} for p in u.spec['files']}

def maybe_mark_good(u):
    if not u.spec['files'] or u.healthy_since is None or now() - u.healthy_since < GOOD_AFTER or u.flaps(GOOD_AFTER): return
    fs = file_state(u)
    g = GOOD.get(u.name)
    if g and all(g['files'].get(p, {}).get('sha') == v['sha'] for p, v in fs.items()): return
    if any(v['sha'] is None for v in fs.values()): return
    snap = os.path.join(STATE, 'good', u.name, hashlib.sha256(''.join(v['sha'] for v in fs.values()).encode()).hexdigest()[:12])
    os.makedirs(snap, exist_ok=True)
    files = {}
    for p, rp in u.spec['files'].items():
        dst = os.path.join(snap, p.strip('/').replace('/', '__')); shutil.copy2(p, dst)
        files[p] = {'sha': fs[p]['sha'], 'commit': commit_for(p, rp), 'snap': dst}
    GOOD[u.name] = {'at': now(), 'healthy_for_s': int(now() - u.healthy_since), 'files': files, 'dir': snap}
    save_good()
    incident(u.name, 'known_good_recorded', f'ran healthy {int((now() - u.healthy_since) / 60)} min' + (' (systemd uptime when the watchdog started; no restarts seen since)' if u.bootstrap else ''), 'snapshot', snap)

def rollback_decision(u, mode=None):
    """returns (do_it, plan dict). Never touches anything itself."""
    mode = mode or rollback_mode(u.name)
    plan = {'mode': mode, 'steps': []}
    if not u.spec['files']:
        plan['steps'].append('no deployable files for this unit (model/binary service): rollback not applicable'); return False, plan
    g = GOOD.get(u.name)
    fs = file_state(u)
    changed = []
    for p, v in fs.items():
        gv = (g or {}).get('files', {}).get(p, {})
        recent = v['mtime'] and now() - v['mtime'] <= RECENT_DEPLOY
        plan['steps'].append(f"{os.path.basename(p)}: now sha {(v['sha'] or '?')[:12]} commit {commit_for(p, u.spec['files'][p]) or 'uncommitted'}; changed {int((now() - (v['mtime'] or 0)) / 60)} min ago; known-good sha {(gv.get('sha') or 'none')[:12]} commit {gv.get('commit') or '-'}")
        if gv and gv.get('sha') != v['sha'] and recent: changed.append(p)
    if not g: plan['steps'].append('no known-good snapshot yet (needs 30 min healthy): cannot roll back'); return False, plan
    if not changed: plan['steps'].append('nothing deployed in the last 2 h differs from known-good: the flap is not from a recent deploy, rollback would not help'); return False, plan
    plan['steps'].append('roll back: ' + ', '.join(f"{os.path.basename(p)} -> {g['files'][p].get('commit') or 'sha256:' + g['files'][p]['sha'][:12]}" for p in changed))
    plan['changed'] = changed
    if mode != 'live': plan['steps'].append(f'DRY-RUN: would save the current files to {STATE}/rejected/ and copy the known-good ones back, then restart'); return False, plan
    return True, plan

def do_rollback(u, plan):
    g = GOOD[u.name]; stamp = time.strftime('%Y%m%d-%H%M%S')
    rej = os.path.join(STATE, 'rejected', u.name, stamp); os.makedirs(rej, exist_ok=True)
    for p in plan['changed']:
        shutil.copy2(p, os.path.join(rej, p.strip('/').replace('/', '__')))
        st = os.stat(p); shutil.copy2(g['files'][p]['snap'], p); os.chown(p, st.st_uid, st.st_gid)
    plan['steps'].append(f'rolled back; the rejected files are kept in {rej}')
    return restart(u, 'after rollback to known-good')

# ------------------------------------------------------------------ probes
def tunnel_url():
    try:
        m = re.findall(r'https://[a-z0-9-]+\.trycloudflare\.com', open(CF_LOG).read()[-200000:])
        return m[-1] if m else None
    except Exception: return None

def check_unit(u):
    s = sysd(u.name); prev = u.last
    if prev:
        if s['nrestarts'] > prev['nrestarts']:
            for _ in range(min(5, s['nrestarts'] - prev['nrestarts'])): u.events.append((now(), 'crash_restart'))
            incident(u.name, 'crash_restart', f"systemd restarted it on its own (NRestarts {prev['nrestarts']}->{s['nrestarts']})", 'none (systemd Restart=always)', s['active'])
        elif s['pid'] and prev['pid'] and s['pid'] != prev['pid'] and now() - u.last_wd_restart > 30:
            u.events.append((now(), 'manual_restart')); u.manual_at = now()   # someone deployed/restarted it on purpose: not a flap
    u.last = s
    if u.spec.get('probe') and s['active'] == 'active':
        r = http_get(u.spec['probe'], 5); u.last_probe = {'ok': r['ok'], 'ms': r['ms'], 'status': r['status'], 'at': now(), 'error': r.get('error')}
        if u.probe_ok is True and not r['ok']: u.events.append((now(), 'sleep'))
        if u.probe_ok is False and r['ok'] and now() - u.manual_at > 120 and now() - u.last_wd_restart > 120: u.events.append((now(), 'wake'))
        u.probe_ok = r['ok']; u.fail_streak = 0 if r['ok'] else u.fail_streak + 1
    healthy = s['active'] == 'active' and (u.probe_ok is not False if u.spec.get('probe') else True)
    if healthy and u.healthy_since is None:
        u.bootstrap = not u.events and bool(s['up_s'])
        u.healthy_since = now() - min(s['up_s'] or 0, 3600 * 6) if u.bootstrap else now()
    if not healthy: u.healthy_since = None
    return s, healthy

def ladder(u, s, healthy):
    if u.spec.get('watch_only') or u.degraded: return
    flaps = u.flaps()
    # recovery: healthy and quiet for 30 min resets the ladder
    if healthy and u.level and now() - u.level_at > GOOD_AFTER and not flaps:
        incident(u.name, 'recovered', f'healthy {int((now() - u.level_at) / 60)} min after level {u.level}', 'ladder reset'); u.level = 0
    if s['active'] == 'inactive' and s['sub'] == 'dead':
        return  # stopped on purpose by someone: leave it alone (logged once in status)
    stuck = (s['active'] == 'failed') or (s['active'] == 'active' and u.fail_streak >= 3)
    if len(flaps) >= FLAP_N and now() - u.level_at > 60:
        kinds = ', '.join(sorted({k for _, k in flaps}))
        if u.level == 0:
            u.level, u.level_at = 1, now()
            incident(u.name, 'flap_detected', f'{len(flaps)} restarts/sleep-wake cycles in 10 min ({kinds})', 'ladder 1: clean restart')
            restart(u, 'flapping: clean restart')
        elif u.level == 1 and [e for e in u.flaps(after=u.settled_at) if e[1] != 'wd_restart']:
            u.level, u.level_at = 2, now(); u.settled_at = now()
            do, plan = rollback_decision(u)
            rec = incident(u.name, 'still_flapping', f'{len(flaps)} events in 10 min, again after the clean restart', 'ladder 2: rollback decision', ' | '.join(plan['steps']), mode=plan['mode'])
            if do:
                ok = do_rollback(u, plan)
                incident(u.name, 'rolled_back', ' | '.join(plan['steps']), 'rollback to known-good', 'healthy after rollback' if ok else 'still bad after rollback')
        elif u.level == 2 and [e for e in u.flaps(after=max(u.settled_at, u.level_at)) if e[1] != 'wd_restart']:
            u.level, u.level_at = 3, now(); u.degraded = True; u.degraded_why = f'kept flapping after restart + rollback decision ({kinds})'
            incident(u.name, 'degraded', u.degraded_why, 'ladder 3: marked degraded, watchdog stops touching it', 'needs Tab/mama: run digest.py')
        return
    if stuck and now() - u.last_wd_restart > 180:
        why = 'systemd gave up (failed)' if s['active'] == 'failed' else f'not answering {u.fail_streak} probes in a row ({(u.last_probe or {}).get("error") or (u.last_probe or {}).get("status")})'
        restart(u, 'stuck: ' + why)

def check_extras():
    x = EXTRA
    # tunnel: public URL reachability (every ~60 s). Watch-only.
    tn = x['tunnel']
    if now() - tn.get('at', 0) > 60:
        url = tunnel_url(); r = http_get(url + '/health', 10) if url else {'ok': False, 'ms': 0, 'error': 'no url in log'}
        was = tn.get('ok'); tn.update({'url': url, 'ok': r['ok'], 'ms': r['ms'], 'at': now(), 'error': r.get('error')})
        tn['fails'] = 0 if r['ok'] else tn.get('fails', 0) + 1
        if was and not r['ok'] and tn['fails'] == 1: pass
        if tn['fails'] == 3: incident('jena-tunnel', 'public_url_down', f'{url} not answering 3 checks in a row ({r.get("error") or r["status"]})', 'none (jena-tunnel-watchdog.timer restarts it)', '')
        if was is False and r['ok'] and tn.get('fails_before', 0) >= 3: incident('jena-tunnel', 'public_url_back', url or '', 'none', 'answering')
        tn['fails_before'] = tn['fails'] if not r['ok'] else 0
    # desktop frame freshness (censored frame age + screen.json age), firefox alive
    fr = x['frame']
    r = http_get(DESK + '/box/screen.json', 4)
    try: sj = json.loads(r['body'] or b'{}')
    except Exception: sj = {}
    h = http_get(DESK + '/box/shot.jpg', 4)
    age = None
    try: age = int(h['headers'].get('X-Censor-Age-Ms'))
    except Exception: pass
    private = bool(sj.get('private') or sj.get('mama_driving'))
    sj_age = (now() * 1000 - sj['ts']) / 1000 if sj.get('ts') else None
    fresh = h['ok'] and (age is None or age < 15000) and (sj_age is None or sj_age < 180)
    was = fr.get('fresh')
    fr.update({'fresh': fresh, 'censor_state': h['headers'].get('X-Censor-State'), 'censor_age_ms': age, 'screen_age_s': round(sj_age, 1) if sj_age is not None else None, 'private': private, 'at': now()})
    d = UNITS_STATE['jena-desk']
    if was is True and not fresh:
        fr['stale_since'] = now(); fr['why'] = f"http {h['status'] or h.get('error')}, censor {fr['censor_state']} age {age} ms, screen.json {fr['screen_age_s']} s"
    if was is False and fresh:
        fr['stale_since'] = None
        if now() - max(d.manual_at, d.last_wd_restart) > 120:   # a deploy restart is not her desktop napping
            fl = fr.setdefault('flips', []); fl.append(now()); fl[:] = [x for x in fl if now() - x < FLAP_WIN]
            if len(fl) >= FLAP_N and now() - fr.get('flap_reported', 0) > 1800:
                fr['flap_reported'] = now(); fl.clear()
                incident('jena-desk', 'desktop_frame_flapping', f"her public desktop frame went stale and came back {FLAP_N}x in 10 min; last stale: {fr.get('why')}; desk API {'answering' if d.probe_ok else 'NOT answering'}",
                         'none: frame-only flap (a restart would not fix a slow censor/CPU); desk-API flaps are restarted by the ladder', 'reported for Tab review')
    if not fresh and fr.get('stale_since') and now() - fr['stale_since'] > 180 and not private and not fr.get('reported'):
        fr['reported'] = True; incident('jena-desk', 'desktop_frame_stale', f"frame not fresh for 3 min (censor {fr['censor_state']} age {age} ms, screen.json {fr['screen_age_s']} s)", 'none yet (desk API still answers)', '')
    if fresh: fr['reported'] = False
    ff = x['firefox']
    alive = bool(sh('pgrep', '-u', 'jena', '-f', 'firefox').strip())
    if ff.get('alive') and not alive: ff['down_since'] = now()
    ff['alive'] = alive
    if alive: ff['down_since'] = None; ff['reported'] = False
    elif ff.get('down_since') and now() - ff['down_since'] > 300 and not private and not ff.get('reported'):
        ff['reported'] = True; incident('jena-desk', 'firefox_down', 'her Firefox has not been running for 5 min', 'none (she or the sign-in window may relaunch it)', '')
    # chat latency: a tiny probe, at most every 5 min, straight to the chat model (does not touch her logs)
    ch = x['chat']
    if now() - ch.get('at', 0) > 300 and UNITS_STATE['jena-llm-chat'].probe_ok:
        body = json.dumps({'messages': [{'role': 'user', 'content': 'hi'}], 'max_tokens': 4, 'temperature': 0}).encode()
        r = http_get('http://127.0.0.1:8091/v1/chat/completions', 60, data=body, headers={'Content-Type': 'application/json'})
        ch.update({'at': now(), 'ok': r['ok'], 'ms': r['ms'], 'error': r.get('error')})
        ch['slow_streak'] = 0 if (r['ok'] and r['ms'] < 30000) else ch.get('slow_streak', 0) + 1
        hist = ch.setdefault('hist', []); hist.append([int(now()), r['ms'], r['ok']]); del hist[:-24]
        if ch['slow_streak'] == 2: incident('jena-llm-chat', 'chat_slow', f"tiny reply probe {'failed' if not r['ok'] else 'took'} {r['ms']} ms twice in a row", 'none (busy brain is not restarted)', r.get('error') or '')
        if ch['slow_streak'] >= 3 and now() - UNITS_STATE['jena-llm-chat'].last_wd_restart > 1800 and not paused():
            restart(UNITS_STATE['jena-llm-chat'], 'chat reply probe failed 3x (15 min) while /health said ok'); ch['slow_streak'] = 0

# ------------------------------------------------------------------ behavior recorder
B = {'brain_ts': 0, 'action_ts': 0, 'thought_n': 0, 'act_pos': None, 'skills': {}, 'frame_at': 0, 'err_at': now(), 'gw_errors': None}
SELF_CATCH = re.compile(r"wait\W+(wtf|no)|scrapp|i don.?t actually know|my bad|not sure that.?s (true|real)|made that up|correct(ing)? myself", re.I)
def brec(kind, **kw):
    kw = {k: (scrub(v, 300) if isinstance(v, str) else v) for k, v in kw.items()}
    jappend(BEHAVIOR, {'ts': int(now() * 1000), 'iso': iso(), 't': kind, **kw})

def record_behavior():
    r = http_get('http://127.0.0.1:8088/brain/log?n=50', 4)
    try:
        d = json.loads(r['body'])
        if not B['brain_ts']: B['brain_ts'] = max([e.get('ts', 0) for e in d.get('log', [])] or [1])
        for e in d.get('log', []):
            if e.get('ts', 0) > B['brain_ts']:
                if B['brain_ts']: brec('reply', at=e['ts'], user=e.get('user', ''), reply=e.get('reply', ''), routed=e.get('routed'), action=e.get('action'), ms=e.get('ms'), origin=e.get('origin'))
                B['brain_ts'] = e['ts']
        st = d.get('stats', {})
        if B['gw_errors'] is not None and st.get('errors', 0) > B['gw_errors']: brec('error', src='gateway', text=f"brain errors {B['gw_errors']} -> {st['errors']}")
        B['gw_errors'] = st.get('errors', 0)
    except Exception: pass
    r = http_get(DESK + '/box/screen.json', 4)
    try:
        acts = json.loads(r['body']).get('actions', [])
        if not B['action_ts']: B['action_ts'] = max([a.get('ts', 0) for a in acts] or [1])
        for a in acts:
            if a.get('ts', 0) > B['action_ts']:
                if B['action_ts']: brec('skill' if a.get('kind') == 'skill' else 'action', at=a['ts'], kind=a.get('kind'), text=a.get('text', ''))
                B['action_ts'] = a['ts']
    except Exception: pass
    r = http_get(DESK + '/box/thoughts?since=0&last=20', 4)
    try:
        lines = json.loads(r['body']).get('lines', [])
        if not B['thought_n']: B['thought_n'] = max([l.get('n', 0) for l in lines] or [1])
        for l in lines:
            if l.get('n', 0) > B['thought_n']:
                if B['thought_n']:
                    txt = l.get('text', ''); brec('selfcatch' if SELF_CATCH.search(txt) else 'thought', text=txt)
                B['thought_n'] = l['n']
            elif l.get('n', 0) < B['thought_n'] - 50: B['thought_n'] = 0
    except Exception: pass
    try:   # skill outcomes (ok/fail counts) from her skills stats
        ss = json.load(open(os.path.join(J, 'skills_stats.json')))
        for name, v in ss.items():
            o = B['skills'].get(name)
            if o and v.get('fail', 0) > o.get('fail', 0): brec('skill_fail', skill=name, summary=v.get('last_summary', ''))
            if o and v.get('ok', 0) > o.get('ok', 0): brec('skill_ok', skill=name, summary=v.get('last_summary', ''))
            B['skills'][name] = {'ok': v.get('ok', 0), 'fail': v.get('fail', 0)}
    except Exception: pass
    if now() - B['err_at'] > 60:   # errors her services logged
        since = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(B['err_at'])); B['err_at'] = now()
        out = sh('journalctl', '--no-pager', '-q', '-o', 'cat', '-p', 'err', '--since', since, '-u', 'jena-desk', '-u', 'jena-gateway', '-u', 'jena-tts', '-u', 'jena-stt', '-u', 'jena-llm-chat')
        for line in out.splitlines()[-10:]:
            if line.strip(): brec('error', src='journal', text=line)
        out = sh('journalctl', '--no-pager', '-q', '-o', 'cat', '--since', since, '-u', 'jena-desk', '-u', 'jena-gateway')
        for line in [l for l in out.splitlines() if re.search(r'Traceback|Error|Exception', l)][-5:]:
            brec('error', src='log', text=line)
    if now() - B['frame_at'] >= 120:
        B['frame_at'] = now(); h = http_get(DESK + '/box/shot.jpg', 6)
        if h['ok'] and h['body']:
            try:
                from PIL import Image; import io
                im = Image.open(io.BytesIO(h['body'])); im.thumbnail((320, 320))
                os.makedirs(FRAMES, exist_ok=True)
                p = os.path.join(FRAMES, time.strftime('%Y%m%d-%H%M%S') + '.jpg'); im.convert('RGB').save(p, quality=60)
                brec('frame', file=os.path.basename(p), censor=h['headers'].get('X-Censor-State'))
            except Exception as e: brec('error', src='watchdog', text='thumbnail: ' + str(e))
    cap_disk()

def cap_disk():
    try:
        if os.path.exists(BEHAVIOR) and os.path.getsize(BEHAVIOR) > 20 * 1024 * 1024:
            for i in (3, 2, 1):
                if os.path.exists(f'{BEHAVIOR}.{i}'): os.replace(f'{BEHAVIOR}.{i}', f'{BEHAVIOR}.{i + 1}' if i < 3 else f'{BEHAVIOR}.4.del')
            if os.path.exists(f'{BEHAVIOR}.4.del'): os.remove(f'{BEHAVIOR}.4.del')
            os.replace(BEHAVIOR, BEHAVIOR + '.1')
        if os.path.exists(INCIDENTS) and os.path.getsize(INCIDENTS) > 10 * 1024 * 1024: os.replace(INCIDENTS, INCIDENTS + '.1')
        files = [os.path.join(FRAMES, f) for f in sorted(os.listdir(FRAMES))] if os.path.isdir(FRAMES) else []
        total = sum(os.path.getsize(f) for f in files) + sum(os.path.getsize(p) for p in [BEHAVIOR, BEHAVIOR + '.1', BEHAVIOR + '.2', BEHAVIOR + '.3', INCIDENTS, INCIDENTS + '.1'] if os.path.exists(p))
        while files and total > CAP_BYTES:
            f = files.pop(0); total -= os.path.getsize(f); os.remove(f)
    except Exception as e: print('cap_disk', e, flush=True)

# ------------------------------------------------------------------ HTTP door
RATE = {'all': deque(maxlen=100), 'ip': {}}
KINDS = {'panel_flap', 'js_error', 'brain_flap', 'panel_stuck', 'other'}
def is_mama(h):
    try: want = open(MAMA_HASH).read().strip()
    except Exception: return False
    got = hashlib.sha256((h.get('x-jena-key') or '').encode()).hexdigest()
    return bool(want) and hashlib.sha256(want.encode()).digest() == hashlib.sha256(got.encode()).digest()

def overall():
    bad = [n for n, u in UNITS_STATE.items() if u.degraded or (u.last and u.last['active'] == 'failed') or (u.spec.get('probe') and u.probe_ok is False)]
    return ('degraded' if any(UNITS_STATE[n].degraded for n in bad) else 'trouble' if bad else 'healthy'), bad

def health(full):
    st, bad = overall()
    out = {'ok': True, 'status': st, 'at': int(now() * 1000)}
    if not full: return out
    tail = []
    try:
        with open(INCIDENTS) as f: tail = [json.loads(l) for l in deque(f, 40)]
    except Exception: pass
    out.update({'problems': bad, 'paused': paused(), 'watchdog_up_s': int(now() - EXTRA['started']),
                'units': {n: {'active': (u.last or {}).get('active'), 'restarts_systemd': (u.last or {}).get('nrestarts'), 'up_min': round(((u.last or {}).get('up_s') or 0) / 60, 1),
                              'probe': u.last_probe and {k: u.last_probe[k] for k in ('ok', 'ms', 'status')}, 'flaps_10min': len(u.flaps()), 'ladder': u.level, 'degraded': u.degraded_why or None,
                              'rollback_mode': rollback_mode(n) if u.spec['files'] else None,
                              'known_good': ({'at': iso(GOOD[n]['at']), 'commits': sorted({v.get('commit') or 'sha256:' + v['sha'][:12] for v in GOOD[n]['files'].values()})} if n in GOOD else None)}
                          for n, u in UNITS_STATE.items()},
                'tunnel': {k: EXTRA['tunnel'].get(k) for k in ('ok', 'ms', 'error')}, 'frame': {k: EXTRA['frame'].get(k) for k in ('fresh', 'censor_state', 'censor_age_ms', 'screen_age_s', 'private')},
                'firefox_alive': EXTRA['firefox'].get('alive'), 'chat_probe': {k: EXTRA['chat'].get(k) for k in ('ok', 'ms')}, 'incidents': tail})
    return out

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header('Content-Type', 'application/json'); self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        p = self.path.split('?')[0]
        if p == '/box/watch/ping': return self.send(200, {'ok': True})
        if p == '/box/watch/health':
            hd = {k.lower(): v for k, v in self.headers.items()}
            full = is_mama(hd)
            return self.send(200, {**health(full), 'private': full})
        self.send(404, {'error': 'no such door'})
    def do_POST(self):
        if self.path.split('?')[0] != '/box/incident': return self.send(404, {'error': 'no such door'})
        n = int(self.headers.get('Content-Length') or 0)
        if n > 4096: return self.send(413, {'error': 'too big'})
        t = now()
        try: b = json.loads(self.rfile.read(n) or b'{}')
        except Exception: return self.send(400, {'error': 'bad json'})
        if not isinstance(b, dict): return self.send(400, {'error': 'bad json'})
        ipk = hashlib.sha256(str(b.get('rid') or self.client_address[0]).encode()).hexdigest()[:10]   # per page load, nothing personal
        allq = RATE['all']; ipq = RATE['ip'].setdefault(ipk, deque(maxlen=20))
        if sum(1 for x in allq if t - x < 600) >= 30 or sum(1 for x in ipq if t - x < 600) >= 6: return self.send(429, {'error': 'rate limited'})
        if len(RATE['ip']) > 500: RATE['ip'].clear()
        allq.append(t); ipq.append(t)
        kind = b.get('kind') if b.get('kind') in KINDS else 'other'
        rep = {'kind': kind, 'panel': scrub(b.get('panel'), 30), 'count': int(b.get('count') or 0) if str(b.get('count') or '0').isdigit() else 0,
               'window_s': int(b.get('window_s') or 0) if str(b.get('window_s') or '0').isdigit() else 0, 'msg': scrub(b.get('msg'), 200),
               'build': scrub(b.get('build'), 12), 'view': scrub(b.get('view'), 12), 'device': scrub(b.get('device'), 10)}
        # cross-check with what the box itself sees right now
        f = EXTRA['frame']; d = UNITS_STATE['jena-desk']; g = UNITS_STATE['jena-gateway']
        box_view = {'desk_api': d.probe_ok, 'frame_fresh': f.get('fresh'), 'censor': f.get('censor_state'), 'gateway': g.probe_ok, 'tunnel': EXTRA['tunnel'].get('ok')}
        verdict = 'box side looks fine: likely the page/network side' if all(v is not False for v in (d.probe_ok, f.get('fresh'), g.probe_ok, EXTRA['tunnel'].get('ok'))) else 'box side also unhealthy: the watchdog ladder handles it'
        EXTRA['site_reports'].append({'at': t, **rep})
        incident('site', 'site_report:' + kind, f"{rep['panel']} x{rep['count']} in {rep['window_s']}s · {rep['msg']} · build {rep['build']} · {rep['view']}/{rep['device']}", 'cross-checked box', verdict, box=box_view)
        self.send(200, {'ok': True, 'box': box_view, 'verdict': verdict})

class TS(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True; allow_reuse_address = True

# ------------------------------------------------------------------ main loop
def run():
    os.makedirs(STATE, exist_ok=True); load_good()
    srv = TS(('127.0.0.1', PORT), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    incident('watchdog', 'started', f'pid {os.getpid()}, watching {len(UNITS)} units every {TICK}s', 'none', f'rollback default {rollback_mode("x")}')
    # bootstrap known-good: a unit systemd says has been up >=30 min and answers now counts as healthy that long
    while True:
        t0 = now()
        for u in UNITS_STATE.values():
            try:
                s, healthy = check_unit(u)
                if healthy and u.healthy_since is not None: maybe_mark_good(u)
                ladder(u, s, healthy)
            except Exception as e: print('unit', u.name, repr(e), flush=True)
        for f in [f for f in os.listdir(STATE) if f.startswith('clear.')]:
            u = UNITS_STATE.get(f[6:]); os.remove(os.path.join(STATE, f))
            if u: incident(u.name, 'cleared', f'ladder {u.level}, degraded={u.degraded}', 'manual clear', 'watching normally again'); u.level = 0; u.degraded = False; u.degraded_why = ''; u.events.clear()
        try: check_extras()
        except Exception as e: print('extras', repr(e), flush=True)
        try: record_behavior()
        except Exception as e: print('behavior', repr(e), flush=True)
        try:
            json.dump(health(True), open(os.path.join(STATE, 'status.json.tmp'), 'w'), indent=1, default=str); os.replace(os.path.join(STATE, 'status.json.tmp'), os.path.join(STATE, 'status.json'))
        except Exception as e: print('status', repr(e), flush=True)
        time.sleep(max(2, TICK - (now() - t0)))

def cli():
    a = sys.argv[1:] or ['run']
    if a[0] == 'run': return run()
    if a[0] == 'status': print(open(os.path.join(STATE, 'status.json')).read()); return
    if a[0] == 'pause':
        m = float(a[1]) if len(a) > 1 else 30; open(PAUSE, 'w').write(str(now() + m * 60)); print(f'paused {m} min'); return
    if a[0] == 'resume':
        try: os.remove(PAUSE)
        except FileNotFoundError: pass
        print('resumed'); return
    if a[0] == 'clear':   # ask the running daemon to clear a degraded/ladder state
        open(os.path.join(STATE, 'clear.' + a[1]), 'w').write(iso()); print('clear requested for', a[1]); return
    print(__doc__)

if __name__ == '__main__': cli()
