# jena_takeover.py: mama's takeover sessions on Jena's desktop (:99), loaded by her desk agent (.jena_desk.py).
#  * PHONE MODE: when mama takes over from a phone-size screen, :99 turns portrait (W x 704, W from her phone's
#    shape) so windows fit her phone and nothing needs mousing around; it goes back to 1600x704 when she's done.
#    Xvfb can't grow past the size it started at (1600x704) and can't add RandR modes, so the switch is:
#    output off -> --fb Wx704 (and back: --fb 1600x704 -> output on at 1600x704). x11vnc runs with -xrandr.
#    The public / OBS view holds the last censored frame meanwhile (censor.set_hold), so the stream never glitches.
#    JenaOS (another builder) adapts through /home/jena/jenaos/mode.sh phone|desktop when that script exists.
#  * 60-MIN PAUSE: a takeover with minutes=N (double-click on the desktop panel) pauses Jena's own hands until
#    mama says done or N minutes pass, even across a dropped connection. The flag is ~/.jena/mama_takeover.json
#    ({"active": true, "until": <epoch s>, ...}); her desk agent's hands_blocked() and autonomy read it.
#  * WHAT CHANGED: when the pause ends, Jena gets a plain summary of what mama changed (windows opened/closed,
#    files touched in her home), in her activity memory + ~/.jena/memory/mama_takeover_last.md. Nothing is reset.
import json, os, subprocess, threading, time

DISPLAY = os.environ.get('DISPLAY', ':99')
DESK_W, DESK_H = 1600, 704
HOME = os.path.expanduser('~')
STATE = os.path.join(HOME, '.jena')
FLAG = os.path.join(STATE, 'mama_takeover.json')
MEMDIR = os.path.join(STATE, 'memory')
MODE_SH = os.path.join(HOME, 'jenaos', 'mode.sh')
GRACE_S = 20            # a dropped phone connection keeps portrait this long, so a quick reconnect doesn't flip twice
PAUSE_GRACE_S = 60      # ...and a dropped timed takeover keeps Jena paused this long; after that the flag clears by itself
ENV = {**os.environ, 'DISPLAY': DISPLAY}

_lock = threading.RLock()
S = {'sessions': 0, 'mode': 'desktop', 'phone': None, 'since': 0, 'until': 0, 'source': None, 'before': None,
     'drop_at': 0, 'saved_geo': None, 'marker': None, 'log': []}
_hooks = {'censor': None, 'did': None, 'memory': None}

def _log(*a):
    print(time.strftime('%H:%M:%S'), 'takeover', *a, flush=True)
    S['log'] = (S['log'] + [time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a)])[-40:]

def _run(*args, timeout=8):
    try:
        r = subprocess.run(list(args), env=ENV, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or '') + (r.stderr or '')
    except Exception as e:
        return -1, str(e)

def configure(censor=None, did=None, memory=None):
    if censor is not None: _hooks['censor'] = censor
    if did is not None: _hooks['did'] = did
    if memory is not None: _hooks['memory'] = memory

def screen_size():
    rc, out = _run('xdpyinfo')
    for l in out.splitlines():
        if 'dimensions:' in l:
            try:
                w, h = l.split()[1].split('x'); return int(w), int(h)
            except Exception: pass
    return None

def _windows():
    rc, out = _run('wmctrl', '-l', '-G')
    wins = []
    for l in out.splitlines():
        p = l.split(None, 7)
        if len(p) >= 7:
            try: wins.append({'id': p[0], 'desk': p[1], 'x': int(p[2]), 'y': int(p[3]), 'w': int(p[4]), 'h': int(p[5]), 'title': p[7] if len(p) > 7 else ''})
            except Exception: pass
    return wins

def _maximized(wid):
    rc, out = _run('xprop', '-id', wid, '_NET_WM_STATE')
    return 'MAXIMIZED_HORZ' in out and 'MAXIMIZED_VERT' in out

def _mode_sh(mode):
    if os.path.exists(MODE_SH) and os.access(MODE_SH, os.X_OK):
        def go():
            rc, out = _run(MODE_SH, mode, timeout=20)
            _log('mode.sh', mode, 'rc', rc, out.strip()[-160:])
        threading.Thread(target=go, daemon=True).start()

def _hold(on):
    c = _hooks['censor']
    try:
        if c is not None and hasattr(c, 'set_hold'): c.set_hold('phone_mode', bool(on))
        elif c is not None: c.set_private('phone_mode', bool(on))   # older censor: card instead of a held frame
    except Exception as e: _log('hold', e)

# ------------------------------------------------------------------ phone mode (portrait :99)
def phone_size(p):
    try:
        w, h = float(p.get('w') or 0), float(p.get('h') or 0)
    except Exception:
        return None
    if not (150 <= w <= 1000 and 300 <= h <= 2000 and h > w * 1.15):
        return None
    W = int(round(DESK_H * w / h / 2) * 2)        # same shape as her phone's screen, 704 tall
    return max(280, min(560, W)), DESK_H

def enter_phone(size):
    with _lock:
        if S['mode'] == 'phone' and S['phone'] == size: return True
        W, H = size
        _hold(True)
        if S['mode'] != 'phone':
            S['saved_geo'] = [dict(w, max=_maximized(w['id'])) for w in _windows()]
        _run('xrandr', '--output', 'screen', '--off')
        rc, out = _run('xrandr', '--fb', f'{W}x{H}')
        got = screen_size()
        if got != (W, H):
            _log('phone mode failed', rc, out.strip()[-200:], got)
            _restore_display(); _hold(False)
            return False
        S['mode'], S['phone'] = 'phone', size
        time.sleep(0.4)
        for w in _windows():   # every normal window fills the phone screen (the panel / desktop are not listed by wmctrl -l)
            _run('wmctrl', '-i', '-r', w['id'], '-b', 'add,maximized_vert,maximized_horz')
        _log('phone mode on', f'{W}x{H}')
        _mode_sh('phone')
        return True

def _restore_display():
    _run('xrandr', '--fb', f'{DESK_W}x{DESK_H}')
    _run('xrandr', '--output', 'screen', '--mode', f'{DESK_W}x{DESK_H}')
    return screen_size() == (DESK_W, DESK_H)

def exit_phone(reason=''):
    with _lock:
        ok = _restore_display()
        if not ok:
            time.sleep(0.5); ok = _restore_display()
        time.sleep(0.4)
        saved = {w['id']: w for w in (S.get('saved_geo') or [])}
        for w in _windows():   # windows that were there before go back to their old size; new ones stay as mama left them
            o = saved.get(w['id'])
            if not o: continue
            if not o.get('max'):
                _run('wmctrl', '-i', '-r', w['id'], '-b', 'remove,maximized_vert,maximized_horz')
                _run('wmctrl', '-i', '-r', w['id'], '-e', f"0,{o['x']},{max(0, o['y'] - 28)},{o['w']},{o['h']}")
        was = S['mode']
        S['mode'], S['phone'], S['saved_geo'] = 'desktop', None, None
        _hold(False)
        _log('phone mode off', reason, 'display', screen_size())
        if was == 'phone': _mode_sh('desktop')
        return ok

# ------------------------------------------------------------------ pause flag + what changed
def _write_flag():
    os.makedirs(STATE, exist_ok=True)
    d = {'active': paused(), 'since': S['since'], 'until': S['until'], 'source': S['source'], 'phone': S['mode'] == 'phone',
         'connected': S['sessions'] > 0, 'updated': time.time(),
         'note': 'mama has the desktop: Jena\'s own hands/autonomy pause until "until" (epoch s) or until active is false'}
    tmp = FLAG + '.tmp'
    with open(tmp, 'w') as f: json.dump(d, f)
    os.replace(tmp, FLAG)

def paused():
    return S['sessions'] > 0 or time.time() < S['until']

def _snapshot():
    marker = os.path.join(STATE, '.takeover-marker')
    try:
        with open(marker, 'w') as f: f.write(str(time.time()))
    except Exception: marker = None
    return {'windows': [w['title'] for w in _windows()], 'ts': time.time()}, marker

SKIP = ('.cache', '.mozilla', '.ffprofile', '.jena', '.jena-mama', '__pycache__', '.local/share', 'learned', 'library', '.npm', 'Videos', 'jena-repo/.git')
def _changed_files(marker, limit=25):
    if not marker or not os.path.exists(marker): return []
    rc, out = _run('find', HOME, '-maxdepth', '5', '-type', 'f', '-newer', marker, '-not', '-name', '*.pyc', timeout=20)
    files = []
    for l in out.splitlines():
        rel = os.path.relpath(l, HOME)
        if rel.startswith(SKIP) or rel.startswith('.') or '/.' in rel or rel.startswith(('jenaos/', 'jena_', 'snap/')):
            continue   # hidden dirs (browser profiles, caches), her own programs: not "what mama changed"
        files.append(rel)
    return sorted(files)[:limit]

def _summarize():
    before = S.get('before') or {'windows': [], 'ts': S['since'] or time.time()}
    now_titles = [w['title'] for w in _windows()]
    opened = [t for t in now_titles if t not in before['windows']]
    closed = [t for t in before['windows'] if t not in now_titles]
    files = _changed_files(S.get('marker'))
    mins = max(1, int(round((time.time() - (S['since'] or time.time())) / 60)))
    parts = [f'mama had my desktop for {mins} min']
    if opened: parts.append('she opened: ' + '; '.join(t[:60] for t in opened[:6]))
    if closed: parts.append('she closed: ' + '; '.join(t[:60] for t in closed[:6]))
    if files: parts.append('files she changed or made: ' + ', '.join(files[:10]) + (f' (+{len(files) - 10} more)' if len(files) > 10 else ''))
    if len(parts) == 1: parts.append('nothing I can see changed (no new windows or files)')
    text = '. '.join(parts) + '. I keep everything the way she left it.'
    md = (f"# What mama changed ({time.strftime('%Y-%m-%d %H:%M')})\n\n{text}\n\n"
          + ('## Windows now open\n' + '\n'.join('- ' + t for t in now_titles) + '\n\n' if now_titles else '')
          + ('## Files changed\n' + '\n'.join('- ' + f for f in files) + '\n' if files else ''))
    try:
        os.makedirs(MEMDIR, exist_ok=True)
        with open(os.path.join(MEMDIR, 'mama_takeover_last.md'), 'w') as f: f.write(md)
        with open(os.path.join(MEMDIR, 'mama_takeovers.jsonl'), 'a') as f:
            f.write(json.dumps({'ts': int(time.time() * 1000), 'minutes': mins, 'source': S['source'], 'opened': opened[:12], 'closed': closed[:12], 'files': files, 'summary': text}) + '\n')
    except Exception as e: _log('summary write', e)
    try:
        m = _hooks['memory']
        if m is not None: m.record('mama', text[:200], key='mama_takeover', outcome='done', note='mama took over my desktop')
    except Exception as e: _log('memory record', e)
    try:
        if _hooks['did']: _hooks['did']('📝 ' + text[:300], 'help')
    except Exception: pass
    _log('summary', text)
    return text

def _finish(reason):
    with _lock:
        if S['mode'] == 'phone': exit_phone(reason)
        text = _summarize() if S['since'] else ''
        S.update(since=0, until=0, source=None, before=None, marker=None, drop_at=0)
        _write_flag()
        return text

# ------------------------------------------------------------------ the desk agent's hooks
def params(b):
    b = b or {}
    out = {'source': str(b.get('source') or 'takeover')[:30]}
    try: out['minutes'] = max(1, min(120, int(b.get('minutes') or 0))) if b.get('minutes') else 0
    except Exception: out['minutes'] = 0
    ph = b.get('phone')
    if isinstance(ph, dict):
        sz = phone_size(ph)
        if sz: out['phone'] = sz
    return out

def begin(p):
    """a takeover websocket opened. -> {'phone': bool} (phone mode = the public view holds its last frame)"""
    p = p or {}
    with _lock:
        S['sessions'] += 1
        S['drop_at'] = 0
        if not S['since']:
            S['since'] = time.time()
            S['before'], S['marker'] = _snapshot()
            S['source'] = p.get('source') or 'takeover'
        if p.get('minutes'):
            S['until'] = max(S['until'], time.time() + 60 * p['minutes'])
        phone = False
        if p.get('phone'):
            phone = enter_phone(p['phone'])
        elif S['mode'] == 'phone' and S['sessions'] == 1:
            exit_phone('desktop-size takeover')
        _write_flag()
        _log('begin', p, 'sessions', S['sessions'], 'mode', S['mode'])
        return {'phone': S['mode'] == 'phone'}

def end():
    """a takeover websocket closed (Done, tab closed, or a dropped connection)"""
    with _lock:
        S['sessions'] = max(0, S['sessions'] - 1)
        if S['sessions'] == 0:
            S['drop_at'] = time.time()
        _write_flag()
        _log('end', 'sessions', S['sessions'], 'until', int(S['until'] - time.time()) if S['until'] else 0)
        if S['sessions'] == 0 and time.time() >= S['until']:
            pass   # the watchdog finishes it after GRACE_S (a reconnect within the grace keeps phone mode)

def done(extra=None):
    """mama pressed Done / Give it back: end the pause now"""
    with _lock:
        S['until'] = 0
        if S['sessions'] == 0: return _finish('mama done')
        _write_flag()
        return ''

def extend(minutes):
    with _lock:
        S['until'] = max(S['until'], time.time()) + 60 * max(1, min(60, int(minutes)))
        _write_flag()
        return S['until']

def status():
    return {'paused': paused(), 'sessions': S['sessions'], 'mode': S['mode'], 'phone': S['phone'], 'since': S['since'],
            'until': S['until'], 'left_s': max(0, int(S['until'] - time.time())) if S['until'] else None, 'source': S['source'],
            'screen': screen_size(), 'log': S['log'][-8:]}

def door(b):
    """POST /box/mama/takeover with op: status | end | extend"""
    op = (b or {}).get('op')
    if op == 'end': return {'ok': True, 'summary': done() or 'ended', 'state': status()}
    if op == 'extend': return {'ok': True, 'until': extend((b or {}).get('minutes') or 15), 'state': status()}
    return {'ok': True, 'state': status()}

def _watch():
    while True:
        time.sleep(3)
        try:
            with _lock:
                idle = S['sessions'] == 0
                if idle and S['drop_at'] and time.time() - S['drop_at'] > GRACE_S:
                    if S['mode'] == 'phone': exit_phone('connection closed')
                    # no mama connected any more: the pause ends too (a test or a closed tab never leaves her paused);
                    # a timed (double-click) session gets PAUSE_GRACE_S so a phone that slept can reconnect into it
                    if S['since'] and (time.time() >= S['until'] or time.time() - S['drop_at'] > PAUSE_GRACE_S):
                        S['until'] = 0; _finish('closed')
                    if not S['since']: S['drop_at'] = 0
                elif idle and S['since'] and S['until'] and time.time() >= S['until']:
                    _finish('time up')
                elif idle and not S['since'] and S['mode'] == 'phone':
                    exit_phone('no session')
        except Exception as e:
            _log('watch', e)

def boot():
    """on desk start: a crash mid-phone-mode must never leave :99 portrait"""
    sz = screen_size()
    if sz and sz != (DESK_W, DESK_H):
        _log('boot: display was', sz, '-> restoring')
        _restore_display()
    try:
        d = json.load(open(FLAG))
        if d.get('active'): d['active'] = False; d['note'] = 'cleared at desk restart'; json.dump(d, open(FLAG, 'w'))
    except Exception: pass
    threading.Thread(target=_watch, daemon=True, name='takeover-watch').start()
