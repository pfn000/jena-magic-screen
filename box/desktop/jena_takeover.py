# jena_takeover.py: mama's takeover sessions on Jena's desktop (:99), loaded by her desk agent (.jena_desk.py).
#  * PHONE MODE: when mama takes over from a phone-size screen, :99 turns portrait (W x 704, W from her phone's
#    shape) so windows fit her phone and nothing needs mousing around; it goes back to 1600x704 when she's done.
#    Xvfb can't grow past the size it started at (1600x704) and can't add RandR modes, so the switch is:
#    output off -> --fb Wx704 (and back: --fb 1600x704 -> output on at 1600x704). x11vnc runs with -xrandr.
#    The public / OBS view holds the last censored frame meanwhile (censor.set_hold), so the stream never glitches.
#    JenaOS (another builder) adapts through /home/jena/jenaos/mode.sh phone|desktop when that script exists.
#  * INFINITE HOLD (Saidie, Oct 16 2026 9:02 PM: "set desktop takeover to be infinite"): once mama takes over, Jena's own
#    hands stay paused until MAMA ends it (✓ Done -> POST /box/mama/takeover op:end -> done()). No timer, no minutes cap, a
#    dropped connection or closed tab does NOT end it, and it survives a jena-desk restart (boot() re-arms it from the flag).
#    'minutes' from the site is kept only as information; 'extend' is a harmless no-op. A sign-in hand-off (source signin*)
#    is a tool flow with its own Done and still ends when its window closes. The flag is ~/.jena/mama_takeover.json
#    ({"active": true, "infinite": true, "until": 0, ...}); her desk agent's hands_blocked() and autonomy read it.
#  * HER CHANGES STAY: windows mama opened or worked in during a takeover are remembered (~/.jena/mama_windows.json);
#    Jena's autonomy never closes or retypes into them (protected()). Only phone mode's display size goes back to 1600x704.
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
PAUSE_GRACE_S = 60      # (old timed sessions only; unused since the infinite hold — kept so nothing importing it breaks)
KEEP = os.path.join(STATE, 'mama_windows.json')   # window ids mama opened / worked in: Jena's autonomy leaves them alone
ENV = {**os.environ, 'DISPLAY': DISPLAY}

_lock = threading.RLock()
S = {'sessions': 0, 'mode': 'desktop', 'phone': None, 'since': 0, 'until': 0, 'source': None, 'before': None,
     'drop_at': 0, 'saved_geo': None, 'marker': None, 'log': [], 'hold': False, 'minutes': 0, 'touched': set()}
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

def _wa_top():
    rc, out = _run('xprop', '-root', '_NET_WORKAREA')
    try: return int(out.split('=', 1)[1].split(',')[1])
    except Exception: return 26

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
                _run('wmctrl', '-i', '-r', w['id'], '-e', f"0,{o['x']},{max(_wa_top(), o['y'] - 28)},{o['w']},{o['h']}")   # never under the N•OS menu bar
        was = S['mode']
        S['mode'], S['phone'], S['saved_geo'] = 'desktop', None, None
        _hold(False)
        _log('phone mode off', reason, 'display', screen_size())
        if was == 'phone': _mode_sh('desktop')
        return ok

# ------------------------------------------------------------------ pause flag + what changed
def _write_flag():
    os.makedirs(STATE, exist_ok=True)
    d = {'active': paused(), 'infinite': bool(S['hold']), 'since': S['since'], 'until': S['until'], 'minutes': S['minutes'],
         'source': S['source'], 'phone': S['mode'] == 'phone', 'connected': S['sessions'] > 0, 'updated': time.time(),
         'note': 'mama has the desktop: Jena\'s own hands/autonomy pause until mama presses Done (active goes false); no timer'}
    tmp = FLAG + '.tmp'
    with open(tmp, 'w') as f: json.dump(d, f)
    os.replace(tmp, FLAG)

def paused():
    # infinite: a held takeover never times out; only done() (mama's ✓ Done / op:end) clears S['hold']
    return S['sessions'] > 0 or bool(S['hold'] and S['since'])

# ---- windows mama opened or worked in: kept as she left them (Jena's autonomy must not close / retype into them)
def _wid(w):
    try: return int(str(w), 16) if str(w).lower().startswith('0x') else int(w)
    except Exception: return None

def _load_keep():
    try: return set(int(x) for x in json.load(open(KEEP)).get('ids', []))
    except Exception: return set()

def _save_keep(ids):
    try:
        os.makedirs(STATE, exist_ok=True)
        tmp = KEEP + '.tmp'
        with open(tmp, 'w') as f: json.dump({'ids': sorted(ids), 'updated': time.time()}, f)
        os.replace(tmp, KEEP)
    except Exception as e: _log('keep write', e)

def _remember_windows():
    """windows opened since the takeover began + windows mama focused, added to the keep list (closed ones pruned)"""
    live = {_wid(w['id']) for w in _windows()}
    before = set((S.get('before') or {}).get('ids') or [])
    keep = (_load_keep() | {i for i in live if i not in before} | set(S['touched'])) & live
    keep.discard(None)
    _save_keep(keep)
    return keep

def protected(wid):
    """True if mama opened or worked in this window during a takeover (or one is on right now): leave it as she left it"""
    i = _wid(wid)
    if i is None: return False
    if paused(): return True
    return i in _load_keep()

def _snapshot():
    marker = os.path.join(STATE, '.takeover-marker')
    try:
        with open(marker, 'w') as f: f.write(str(time.time()))
    except Exception: marker = None
    ws = _windows()
    return {'windows': [w['title'] for w in ws], 'ids': [_wid(w['id']) for w in ws], 'ts': time.time()}, marker

SKIP = ('.cache', '.mozilla', '.ffprofile', '.jena', '.jena-mama', '__pycache__', '.local/share', 'learned', 'library', '.npm', 'Videos', 'jena-repo/.git')
def _changed_files(marker, limit=25):
    if not marker or not os.path.exists(marker): return []
    rc, out = _run('find', HOME, '-maxdepth', '5', '-type', 'f', '-newer', marker, '-not', '-name', '*.pyc', timeout=20)
    files = []
    for l in out.splitlines():
        rel = os.path.relpath(l, HOME)
        if rel.startswith(SKIP) or rel.startswith('.') or '/.' in rel or rel.startswith(('jenaos/', 'jena_', 'jena-', 'snap/')):
            continue   # hidden dirs (browser profiles, caches), her own programs: not "what mama changed"
        files.append(rel)
    return sorted(files)[:limit]

SHELL_TITLES = ('N•OS', 'tint2', 'xfce4-panel', 'Desktop', 'plank')
def _mine(t):   # her own shell / panel windows come and go with phone mode: not something mama opened or closed
    return bool(t) and not str(t).startswith(SHELL_TITLES)

def _summarize():
    before = S.get('before') or {'windows': [], 'ts': S['since'] or time.time()}
    now_titles = [w['title'] for w in _windows()]
    opened = [t for t in now_titles if t not in before['windows'] and _mine(t)]
    closed = [t for t in before['windows'] if t not in now_titles and _mine(t)]
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
        if S['since']:
            try: _remember_windows()
            except Exception as e: _log('remember windows', e)
        text = _summarize() if S['since'] else ''
        S.update(since=0, until=0, source=None, before=None, marker=None, drop_at=0, hold=False, minutes=0)
        S['touched'] = set()
        _write_flag()
        return text

# ------------------------------------------------------------------ the desk agent's hooks
def params(b):
    b = b or {}
    out = {'source': str(b.get('source') or 'takeover')[:30]}
    try: out['minutes'] = max(0, int(b.get('minutes') or 0))   # information only: the hold has no timer (no 1..120 cap)
    except Exception: out['minutes'] = 0
    ph = b.get('phone')
    if isinstance(ph, dict):
        sz = phone_size(ph)
        if sz: out['phone'] = sz
    # a sign-in takeover brings the site up in her own browser, so mama lands on the login page, not on whatever was on top
    u = str(b.get('url') or '')
    if out['source'].startswith('signin') and u.startswith('https://') and len(u) < 400 and not any(c in u for c in ' \n\r\t"\'<>'):
        out['url'] = u
    return out

def _open_site(url):
    """bring the sign-in page up in her own Firefox (~/.ffprofile): reuse the running window (address bar), else start it"""
    try:
        def ff():
            rc, out = _run('xdotool', 'search', '--class', '^firefox-esr$')   # her browser only (the N•OS shell is class NOS)
            return [w for w in out.split() if w.isdigit()]
        wids = ff()
        if wids:
            w = wids[-1]
            _run('xdotool', 'windowactivate', '--sync', w)
            time.sleep(0.3)
            _run('xdotool', 'key', '--window', w, '--clearmodifiers', 'ctrl+l')
            time.sleep(0.2)
            _run('xdotool', 'type', '--delay', '15', '--', url)
            _run('xdotool', 'key', '--clearmodifiers', 'Return')
        else:
            subprocess.Popen(['firefox-esr', '--new-instance', '--profile', os.path.join(HOME, '.ffprofile'), url], env=ENV,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            for _ in range(30):
                time.sleep(0.5)
                wids = ff()
                if wids: break
        if wids:
            if S['mode'] == 'phone': _run('wmctrl', '-i', '-r', hex(int(wids[-1])), '-b', 'add,maximized_vert,maximized_horz')
            _run('xdotool', 'windowactivate', wids[-1])
        _log('signin site', url, 'window', wids[-1] if wids else None)
    except Exception as e: _log('signin site', e)

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
        if not str(p.get('source') or 'takeover').startswith('signin'):
            S['hold'] = True            # infinite: holds until mama's Done, whatever the minutes said
        if p.get('minutes'): S['minutes'] = int(p['minutes'])
        S['until'] = 0
        phone = False
        if p.get('phone'):
            phone = enter_phone(p['phone'])
        elif S['mode'] == 'phone' and S['sessions'] == 1:
            exit_phone('desktop-size takeover')
        _write_flag()
        if p.get('url') and S['sessions'] == 1: threading.Thread(target=_open_site, args=(p['url'],), daemon=True).start()
        _log('begin', p, 'sessions', S['sessions'], 'mode', S['mode'])
        return {'phone': S['mode'] == 'phone'}

def end():
    """a takeover websocket closed (Done, tab closed, or a dropped connection)"""
    with _lock:
        S['sessions'] = max(0, S['sessions'] - 1)
        if S['sessions'] == 0:
            S['drop_at'] = time.time()
        _write_flag()
        _log('end', 'sessions', S['sessions'], 'hold', S['hold'])
        # a dropped connection / closed tab does NOT end a held takeover: only mama's Done does (done()).
        # The watchdog only flips phone mode back after GRACE_S (and ends an un-held sign-in hand-off).

def done(extra=None):
    """mama pressed Done / Give it back: end the pause now"""
    with _lock:
        S['until'] = 0
        S['hold'] = False
        if S['sessions'] == 0: return _finish('mama done')
        _write_flag()
        return ''

def extend(minutes):
    """no timer any more (infinite hold): extending just (re)confirms the hold; returns 0 = no expiry"""
    with _lock:
        if S['since']: S['hold'] = True
        _write_flag()
        return 0

def status():
    return {'paused': paused(), 'sessions': S['sessions'], 'mode': S['mode'], 'phone': S['phone'], 'since': S['since'],
            'until': 0, 'left_s': None, 'infinite': bool(S['hold']), 'source': S['source'],
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
                if not idle and S['since']:
                    a = _wid(_run('xdotool', 'getactivewindow', timeout=3)[1].strip() or 'x')
                    if a: S['touched'].add(a)          # a window mama works in: kept as she leaves it
                if idle and S['drop_at'] and time.time() - S['drop_at'] > GRACE_S:
                    if S['mode'] == 'phone': exit_phone('connection closed')   # only the display size goes back
                    # INFINITE HOLD: a dropped connection never ends mama's takeover; only an un-held sign-in hand-off ends here
                    if S['since'] and not S['hold']:
                        _finish('closed')
                    S['drop_at'] = 0
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
        if d.get('active') and d.get('infinite') and d.get('since'):
            # mama's infinite takeover survives a desk restart: still hers until she presses Done
            with _lock:
                S.update(since=float(d['since']), until=0, source=d.get('source') or 'takeover', hold=True,
                         minutes=int(d.get('minutes') or 0), drop_at=0, sessions=0)
                S['before'] = {'windows': [], 'ids': [], 'ts': S['since']}
                _write_flag()
            _log('boot: mama\'s takeover is still on (infinite) since', int(S['since']))
        elif d.get('active'):
            d['active'] = False; d['note'] = 'cleared at desk restart'
            tmp = FLAG + '.tmp'
            with open(tmp, 'w') as f: json.dump(d, f)
            os.replace(tmp, FLAG)
    except Exception: pass
    threading.Thread(target=_watch, daemon=True, name='takeover-watch').start()
