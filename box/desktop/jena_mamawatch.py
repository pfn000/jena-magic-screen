# jena_mamawatch.py: Jena watches how mama does things when mama takes over her desktop, and writes it down.
# While a takeover is on (mama's VNC session on :5901 is connected, or ~/.jena/mama_takeover.json is active) it keeps
# a low-rate log: the active window's title, every click (x, y, button, which window), what mama types (flushed
# as text on Enter/click/window change), and RECORDS THE SESSION AS VIDEO (x11grab of :99 at 3 fps, high CRF, one
# encoder, nice 19) into ~/.jena/mama_sessions/<ts>.mp4 with a sidecar <ts>.actions.jsonl (same clock as the video).
# Always on: no button, no toggle. A session starts when mama's input path to :99 opens (her VNC on :5901 behind websockify
# 6082, or the 60-min pause flag ~/.jena/mama_takeover.json) and ends 20 s after it closes. Windows that look like a
# sign-in / password page (the censor's own test + a title check) are blacked out in the saved video. Privacy: text typed into anything that looks like
# a sign-in / password / payment page, or that looks like a secret, is NEVER written (only "[typed N characters,
# hidden]"); key presses are never written raw. At the end of the takeover she turns the log into steps
# ("how mama did X") in ~/.jena/memory/learned_from_mama.md (private: mama only), adds one plain line to her activity
# memory without the details, saves the session as a training example in ~/.jena/training/mama_demos/<ts>/ (video,
# actions, summary) and updates ~/.jena-mama/mamawatch.json for mama's Tab Live page. Disk: keeps the newest 20
# sessions / 2 GB, oldest removed first.
# Runs as Jena's own user, nice 19. Recorder: X RECORD extension on :99 (no hooks in anyone's takeover code).
import json, os, re, subprocess, sys, threading, time, urllib.request
DISPLAY = os.environ.get('DISPLAY', ':99')
HOME = os.path.expanduser('~')
MEM = os.path.join(HOME, '.jena', 'memory')
FLAG = os.path.join(HOME, '.jena', 'mama_takeover.json')
SESS_DIR = os.path.join(HOME, '.jena', 'mama_sessions')
LEARNED = os.path.join(MEM, 'learned_from_mama.md')
DEMOS = os.path.join(HOME, '.jena', 'training', 'mama_demos')
KEEP_N = int(os.environ.get('MW_KEEP_N', '20')); KEEP_BYTES = int(float(os.environ.get('MW_KEEP_GB', '2')) * 2**30)
VIDEO_FPS = os.environ.get('MW_FPS', '3')
MIN_FREE_DISK = int(float(os.environ.get('MW_MIN_FREE_GB', '0.6')) * 2**30)   # never film the disk full
STATUS = os.path.join(HOME, '.jena-mama', 'mamawatch.json')
FRAME_EVERY = float(os.environ.get('MW_FRAME_S', '2'))
GRACE = float(os.environ.get('MW_GRACE_S', '20'))
VNC_PORT = int(os.environ.get('MW_VNC_PORT', '5901'))
BRAIN = os.environ.get('MW_BRAIN', 'http://127.0.0.1:8091/v1/chat/completions')
ENV = {**os.environ, 'DISPLAY': DISPLAY}
PRIVATE_WIN = re.compile(r'(log ?in|sign ?in|sign ?up|password|passcode|pass ?key|verify|verification|2fa|two.factor|one.time|otp|auth|account|bank|checkout|payment|card|wallet|vault|keychain|security)', re.I)
URLISH = re.compile(r'^(https?://)?([\w-]+\.)+[a-z]{2,}(:\d+)?(/[\w./%~+-]*)?(\?[\w=&%.+-]*)?(#\S*)?$', re.I)
SECRET_WORD = re.compile(r'(pass(word|wd)?|token|secret|api[_-]?key|mama000|plexcode|auth|session|sig=|key=)', re.I)
def looks_secret(text):
    t = text.strip()
    if URLISH.match(t) and not SECRET_WORD.search(t): return False   # a web address mama typed is how-to, not a secret
    return bool(SECRET.search(t))
SECRET = re.compile(r'^(?=.*[A-Za-z])(?=.*\d)\S{8,}$|^\S{20,}$|(pass(word)?|token|secret|api[_-]?key|mama000|plexcode)', re.I)
sys.path.insert(0, HOME)

def sh(*a, timeout=5):
    try: return subprocess.run(list(a), env=ENV, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except Exception: return ''

try:
    import jena_censor as _censor   # the censor's own test for private pages, when it loads
except Exception: _censor = None
def is_private(title):
    if PRIVATE_WIN.search(title or ''): return True
    try: return bool(_censor and _censor.text_is_private('', title or ''))
    except Exception: return False

def ocr_check(s, w):
    """The censor's own eyes on a window mama just switched to (one OCR pass, ~2.5 s after the switch so the page has
    drawn): a page the censor calls a sign-in / private page is blacked out whole and typing into it is hidden; on any
    other page, the fields the censor would redact (emails, keys, card-like numbers, ...) are blacked out in the video."""
    if not _censor: return
    try:
        time.sleep(2.5)
        if S.get('sess') is not s or (s.win or {}).get('id') != w.get('id'): return
        r = win_rect(w['id']) or (0, 0, 1600, 704)
        img = _censor.grab(DISPLAY)
        x, y, ww, hh = r; x = max(0, x); y = max(0, y)
        crop = img.crop((x, y, min(img.width, x + ww), min(img.height, y + hh)))
        words = _censor.ocr_words(crop, offset=(x, y))
        verdict = _censor.page_verdict(w.get('title', ''), words)
        t = time.time() - s.t0
        if verdict:
            w['ocr_private'] = True
            if not getattr(s, 'priv_open', None): s.priv_open = (t - 2.5, r)
            s.add('censor', verdict=verdict, window=w.get('title', ''))
        else:
            boxes = [(a, b, c - a, d - b) for _k, (a, b, c, d) in _censor.find_redactions(words)]
            if boxes:
                w['ocr_boxes'] = [(t - 2.5, bx) for bx in boxes]
                s.add('censor', fields=len(boxes), window=w.get('title', ''))
    except Exception as e: print('ocr_check', repr(e)[:160], flush=True)

def close_window(s, now):
    """the active window changed: close its blackout intervals"""
    if getattr(s, 'priv_open', None): s.private.append([s.priv_open[0], now - s.t0, s.priv_open[1]]); s.priv_open = None
    for t0, bx in (s.win or {}).get('ocr_boxes') or []: s.private.append([t0, now - s.t0, bx])

def win_rect(wid):
    out = sh('xdotool', 'getwindowgeometry', '--shell', wid) if wid else ''
    g = dict(re.findall(r'(\w+)=(\d+)', out))
    try: return (int(g['X']), int(g['Y']), int(g['WIDTH']), int(g['HEIGHT']))
    except Exception: return None

def vnc_connected():
    try:
        for f in ('/proc/net/tcp', '/proc/net/tcp6'):
            for line in open(f).read().splitlines()[1:]:
                c = line.split()
                if c[3] == '01' and int(c[1].split(':')[1], 16) == VNC_PORT: return True
    except Exception: pass
    return False

def flag_active():
    try:
        j = json.load(open(FLAG)); return bool(j.get('active')) and (not j.get('until') or j['until'] > time.time())
    except Exception: return False

def active_window():
    wid = sh('xdotool', 'getactivewindow')
    if not wid: return {'id': None, 'title': '', 'app': ''}
    title = sh('xdotool', 'getwindowname', wid)
    cls = sh('xprop', '-id', wid, 'WM_CLASS')
    app = (re.findall(r'"([^"]*)"', cls) or [''])[-1]
    return {'id': wid, 'title': title[:160], 'app': app[:40]}

def window_at(x, y):
    out = sh('xdotool', 'mousemove', '--sync', str(x), str(y), 'getmouselocation', '--shell') if False else sh('xdotool', 'getmouselocation', '--shell')
    m = re.search(r'WINDOW=(\d+)', out)
    if not m: return ''
    return sh('xdotool', 'getwindowname', m.group(1))[:120]

class Session:
    def __init__(self):
        self.t0 = time.time(); self.id = time.strftime('%Y%m%d-%H%M%S')
        self.dir = os.path.join(SESS_DIR, self.id); os.makedirs(self.dir, exist_ok=True)
        self.actions = os.path.join(SESS_DIR, self.id + '.actions.jsonl'); self.video = os.path.join(SESS_DIR, self.id + '.mp4')
        self.private = []   # [t0, t1, (x, y, w, h)] windows to black out in the saved video
        self.enc = None; self.segs = []; self.dims = None
        try: os.chmod(SESS_DIR, 0o700); os.chmod(self.dir, 0o700)
        except Exception: pass
        self.events = []; self.frames = 0; self.buf = ''; self.buf_win = None; self.mods = set(); self.win = None; self.lock = threading.Lock()
    def add(self, kind, **k):
        e = {'t': round(time.time() - self.t0, 1), 'kind': kind, **k}
        with self.lock: self.events.append(e)
        with open(self.actions, 'a') as f: f.write(json.dumps(e) + '\n')
    def flush_typed(self, why=''):
        if not self.buf: return
        win = self.buf_win or {}
        text = self.buf; self.buf = ''
        hidden = is_private(win.get('title', '')) or bool(self.win and self.win.get('id') == win.get('id') and self.win.get('ocr_private')) or looks_secret(text)
        if hidden: self.add('typed', hidden=True, chars=len(text), window=win.get('title', ''), app=win.get('app', ''), why='sign-in/password-looking page or secret-looking text: not recorded')
        else: self.add('typed', text=text[:300], window=win.get('title', ''), app=win.get('app', ''))

S = {'sess': None, 'last_seen': 0, 'recent': []}

# ---- X RECORD: clicks + keys on :99 (runs in its own thread for the life of the service) ----
def recorder():
    from Xlib import X, XK, display
    from Xlib.ext import record
    from Xlib.protocol import rq
    d_ctl = display.Display(DISPLAY); d_rec = display.Display(DISPLAY)
    ctx = d_rec.record_create_context(0, [record.AllClients], [{
        'core_requests': (0, 0), 'core_replies': (0, 0), 'ext_requests': (0, 0, 0, 0), 'ext_replies': (0, 0, 0, 0),
        'delivered_events': (0, 0), 'device_events': (X.KeyPress, X.ButtonPress), 'errors': (0, 0), 'client_started': False, 'client_died': False}])
    def keyname(code, shift):
        ks = d_ctl.keycode_to_keysym(code, 1 if shift else 0)
        return XK.keysym_to_string(ks) or '', ks
    def cb(reply):
        s = S['sess']
        if reply.category != record.FromServer or reply.client_swapped or not reply.data or not s: return
        data = reply.data
        while len(data):
            ev, data = rq.EventField(None).parse_binary_value(data, d_rec.display, None, None)
            try:
                if ev.type == X.ButtonPress and ev.detail in (1, 2, 3):
                    s.flush_typed('click')
                    w = active_window()
                    s.add('click', x=ev.root_x, y=ev.root_y, button={1: 'left', 2: 'middle', 3: 'right'}[ev.detail], window=w['title'], app=w['app'])
                elif ev.type == X.KeyPress:
                    shift = bool(ev.state & X.ShiftMask); ctrl = bool(ev.state & X.ControlMask); alt = bool(ev.state & X.Mod1Mask)
                    ch, ks = keyname(ev.detail, shift)
                    name = XK.keysym_to_string(ks) if False else None
                    kname = {XK.XK_Return: 'Enter', XK.XK_KP_Enter: 'Enter', XK.XK_Tab: 'Tab', XK.XK_Escape: 'Esc', XK.XK_BackSpace: 'Backspace'}.get(ks)
                    if ctrl or alt:
                        if ch and len(ch) == 1:
                            s.flush_typed('combo'); s.add('keys', combo=('ctrl+' if ctrl else '') + ('alt+' if alt else '') + ch.lower(), window=active_window()['title'])
                        continue
                    if kname == 'Backspace': s.buf = s.buf[:-1]; continue
                    if kname in ('Enter', 'Tab', 'Esc'):
                        s.flush_typed(kname); s.add('keys', combo=kname, window=active_window()['title']); continue
                    if ch and len(ch) == 1:
                        if not s.buf: s.buf_win = active_window()
                        s.buf += ch
                    elif ks == XK.XK_space:
                        if not s.buf: s.buf_win = active_window()
                        s.buf += ' '
            except Exception as e:
                print('rec event', e, flush=True)
    d_rec.record_enable_context(ctx, cb)   # blocks, calling cb for every key/click
    d_rec.record_free_context(ctx)

def screen_dims():
    return (re.search(r'dimensions:\s+(\d+x\d+)', sh('xdpyinfo')) or [None, '1600x704'])[1]

def start_video(s):
    s.dims = screen_dims(); seg = os.path.join(s.dir, f'seg{len(s.segs):02d}.mp4'); s.segs.append(seg)
    latest = os.path.join(HOME, '.jena-mama', 'mamawatch-latest.jpg')
    s.enc = subprocess.Popen(['nice', '-n', '19', 'ffmpeg', '-loglevel', 'error', '-y', '-f', 'x11grab', '-framerate', VIDEO_FPS, '-video_size', s.dims, '-i', DISPLAY,
                              '-map', '0:v', '-vf', 'scale=960:-2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '36', '-pix_fmt', 'yuv420p', '-threads', '1', seg,
                              '-map', '0:v', '-vf', 'fps=0.5,scale=640:-2', '-update', '1', '-q:v', '8', latest],
                             env=ENV, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not hasattr(s, 'v0'): s.v0 = time.time() - s.t0   # video clock offset vs the actions clock

def stop_video(s):
    if s.enc and s.enc.poll() is None:
        try: s.enc.stdin.write(b'q'); s.enc.stdin.flush(); s.enc.wait(timeout=15)
        except Exception:
            try: s.enc.kill()
            except Exception: pass
    s.enc = None

def finish_video(s):
    """join segments, black out private windows, keep it small"""
    segs = [x for x in s.segs if os.path.exists(x) and os.path.getsize(x) > 1000]
    if not segs: return None
    src = segs[0]
    if len(segs) > 1:
        lst = os.path.join(s.dir, 'segs.txt'); open(lst, 'w').write(''.join(f"file '{x}'\n" for x in segs))
        src = os.path.join(s.dir, 'joined.mp4')
        subprocess.run(['nice', '-n', '19', 'ffmpeg', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', src], timeout=300)
    if s.private:
        W = int((s.dims or '1600x704').split('x')[0]); k = 960 / W; v0 = getattr(s, 'v0', 0)
        boxes = ','.join(f"drawbox=x={int(x * k)}:y={int(y * k)}:w={int(w * k)}:h={int(h * k)}:color=black@1:t=fill:enable='between(t,{max(0, a - v0 - 0.5):.1f},{b - v0 + 0.5:.1f})'" for a, b, (x, y, w, h) in s.private)
        subprocess.run(['nice', '-n', '19', 'ffmpeg', '-loglevel', 'error', '-y', '-i', src, '-vf', boxes, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '36', '-threads', '1', s.video], timeout=900)
    else:
        os.replace(src, s.video)
    for x in segs + [os.path.join(s.dir, 'joined.mp4')]:
        try: os.remove(x)
        except Exception: pass
    return s.video if os.path.exists(s.video) else None

def rotate():
    try:
        vids = sorted([f for f in os.listdir(SESS_DIR) if f.endswith('.mp4')])
        total = sum(os.path.getsize(os.path.join(SESS_DIR, f)) for f in vids)
        while vids and (len(vids) > KEEP_N or total > KEEP_BYTES):
            f = vids.pop(0); p = os.path.join(SESS_DIR, f); total -= os.path.getsize(p); os.remove(p)
            demo = os.path.join(DEMOS, f[:-4], 'video.mp4')
            if os.path.exists(demo): os.remove(demo)
    except Exception as e: print('rotate', e, flush=True)

# ---- turn a session into steps ----
def steps_of(events, v0=0):
    out, last_win = [], None
    for e in events:
        w = e.get('window') or ''
        ts = max(0, e['t'] - v0); stamp = f'[{int(ts // 60)}:{int(ts % 60):02d}] '
        if e['kind'] == 'window':
            if e['title'] and e['title'] != last_win: out.append(stamp + f"switched to {e.get('app') or 'a window'}: “{e['title']}”"); last_win = e['title']
        elif e['kind'] == 'click':
            where = f" in “{w}”" if w and w != last_win else ''
            out.append(stamp + f"{e['button']}-clicked at ({e['x']}, {e['y']}){where}")
        elif e['kind'] == 'typed':
            out.append(stamp + (f"typed [{e['chars']} characters, hidden: private page]" if e.get('hidden') else f"typed “{e['text']}”"))
        elif e['kind'] == 'keys':
            out.append(stamp + {'Enter': 'pressed Enter', 'Tab': 'pressed Tab', 'Esc': 'pressed Esc'}.get(e['combo'], f"pressed {e['combo']}"))
    # merge runs of clicks at the same place
    merged = []
    for s_ in out:
        if merged and s_.split('] ', 1)[-1] == merged[-1].split('] ', 1)[-1].split(' ×')[0] and 'clicked' in s_:
            n = int(merged[-1].split(' ×')[1]) + 1 if ' ×' in merged[-1] else 2; merged[-1] = merged[-1].split(' ×')[0] + f' ×{n}'
        else: merged.append(s_)
    return merged

def title_of(steps, events):
    typed = [e['text'] for e in events if e['kind'] == 'typed' and not e.get('hidden')]
    wins = [e['title'] for e in events if e['kind'] == 'window' and e.get('title')]
    guess = None
    url = next((t for t in typed if re.search(r'\w+\.(com|org|net|io|dev|app|gg|tv)\b', t)), None)
    if url: guess = f'how mama went to {url.strip()[:40]}' + (f' and typed “{typed[-1][:30]}”' if typed and typed[-1] != url else '')
    elif wins: guess = f'how mama used {wins[-1][:50]}'
    else: guess = 'how mama did something on my desktop'
    try:   # ask her own brain for a short name (one small call, falls back to the rule-based one)
        body = json.dumps({'messages': [{'role': 'system', 'content': 'You name what someone did on a computer in at most 8 plain words, starting with "how mama". No quotes.'},
                                        {'role': 'user', 'content': '\n'.join(steps[:25])}], 'max_tokens': 24, 'temperature': 0.2}).encode()
        r = urllib.request.urlopen(urllib.request.Request(BRAIN, body, {'Content-Type': 'application/json'}), timeout=25)
        t = json.loads(r.read())['choices'][0]['message']['content'].strip().splitlines()[0].strip(' ."“”')
        if t.lower().startswith('how mama') and 8 < len(t) < 90 and not SECRET.search(t): return t, 'my brain named it'
    except Exception: pass
    return guess, 'named from the window titles and what she typed'

def summarise(s):
    s.flush_typed('end')
    ev = s.events
    if not [e for e in ev if e['kind'] in ('click', 'typed', 'keys')]:   # connected but did nothing: nothing to learn, keep nothing
        stop_video(s)
        for x in s.segs + [s.actions]:
            try: os.remove(x)
            except Exception: pass
        try: os.rmdir(s.dir)
        except Exception: pass
        return None
    v0 = getattr(s, 'v0', 0)
    steps = steps_of(ev, v0)
    title, how = title_of([x.split('] ', 1)[-1] for x in steps], ev)
    stop_video(s); video = finish_video(s)
    dur = int(time.time() - s.t0)
    when = time.strftime('%Y-%m-%d %H:%M', time.localtime(s.t0))
    entry = (f"\n## {title}\n_{when} · {dur // 60} min {dur % 60} s · {len([e for e in ev if e['kind'] == 'click'])} clicks · video ~/.jena/mama_sessions/{s.id}.mp4 (times in [m:ss] point into it) · {how}_\n\n"
             + '\n'.join(f'{i + 1}. {x}' for i, x in enumerate(steps[:60])) + '\n\nTo do it again myself: follow these steps in order; anything marked hidden is a sign-in or password I must never type: I ask mama to take over for that part.\n')
    os.makedirs(MEM, exist_ok=True)
    new = not os.path.exists(LEARNED)
    with open(LEARNED, 'a') as f:
        if new: f.write('# Learned from mama\nHow mama did things on my desktop while she took over, so I can repeat the steps later. Private: only mama sees this. Passwords and sign-ins are never written here.\n')
        f.write(entry)
    try: os.chmod(LEARNED, 0o600)
    except Exception: pass
    summ = {'id': s.id, 'title': title, 'when': when, 'steps': steps, 'events': len(ev), 'video': video, 'actions': s.actions, 'video_offset_s': round(v0, 2), 'private_blacked_out': len(s.private), 'named_by': how}
    json.dump(summ, open(os.path.join(s.dir, 'summary.json'), 'w'), indent=1)
    try:   # a training example for future fine-tunes: the video, the actions, the summary
        d = os.path.join(DEMOS, s.id); os.makedirs(d, exist_ok=True)
        if video:
            try: os.link(video, os.path.join(d, 'video.mp4'))
            except Exception: subprocess.run(['cp', video, os.path.join(d, 'video.mp4')], timeout=120)
        subprocess.run(['cp', s.actions, os.path.join(d, 'actions.jsonl')], timeout=30)
        json.dump(summ, open(os.path.join(d, 'summary.json'), 'w'), indent=1)
    except Exception as e: print('demo', e, flush=True)
    rotate()
    try:   # her activity memory: one plain line, no details (her public chat reads recent.md)
        import jena_memory
        jena_memory.record('learned', 'watched mama do something on my desktop and wrote down how (private notes for mama)', key='mama:' + s.id, outcome='steps saved', action='watch_mama')
    except Exception as e: print('memory', e, flush=True)
    rec = {'title': title, 'when': when, 'steps': steps[:20], 'id': s.id, 'video': bool(video)}
    S['recent'] = [rec] + S['recent'][:9]
    return rec

def status(**k):
    s = S['sess']
    st = {'at': int(time.time() * 1000), 'watching': bool(s), 'events': len(s.events) if s else 0, 'recording': bool(s and s.enc and s.enc.poll() is None), 'since': int(s.t0 * 1000) if s else None,
          'recent': S['recent'], 'last_at': S.get('last_at'), **k}
    try:
        json.dump(st, open(STATUS + '.tmp', 'w')); os.replace(STATUS + '.tmp', STATUS)
    except Exception as e: print('status', e, flush=True)

def load_recent():
    try:
        for d in sorted(os.listdir(SESS_DIR), reverse=True)[:10]:
            p = os.path.join(SESS_DIR, d, 'summary.json')
            if os.path.exists(p):
                j = json.load(open(p)); S['recent'].append({k: j[k] for k in ('title', 'when', 'id')} | {'steps': j['steps'][:20]})
    except Exception: pass

def main():
    os.makedirs(SESS_DIR, exist_ok=True)
    load_recent()
    def rec_forever():
        while True:
            try: recorder()
            except Exception as e: print('recorder', repr(e)[:200], flush=True)
            time.sleep(5)
    threading.Thread(target=rec_forever, daemon=True).start()
    while True:
        on = vnc_connected() or flag_active()   # always on: any mama session on the control port, or her pause flag
        now = time.time()
        if on: S['last_seen'] = now
        s = S['sess']
        if on and not s:
            S['sess'] = s = Session(); s.add('start', via='vnc' if vnc_connected() else 'pause-flag'); print('watching mama', s.id, flush=True); start_video(s)
        if s:
            w = active_window()
            if w['title'] != (s.win or {}).get('title'):
                s.flush_typed('window')
                close_window(s, now)
                if is_private(w['title']):
                    r = win_rect(w['id']); s.priv_open = (now - s.t0, r or (0, 0, 1600, 704))
                s.win = w; s.add('window', title=w['title'], app=w['app'], private=is_private(w['title']))
                if not is_private(w['title']) and w['id']: threading.Thread(target=ocr_check, args=(s, w), daemon=True).start()
            st = os.statvfs(SESS_DIR); low_disk = st.f_bavail * st.f_frsize < MIN_FREE_DISK
            if low_disk and s.enc is not None and s.enc.poll() is None:   # the disk is nearly full: stop filming, keep logging
                stop_video(s); s.add('note', text='video paused: disk nearly full'); print('low disk: video paused', flush=True)
            if low_disk: pass
            elif s.enc is None or s.enc.poll() is not None or screen_dims() != s.dims:   # phone mode changes the screen size: new segment
                if s.enc is not None and s.enc.poll() is None and screen_dims() != s.dims: stop_video(s)
                if len(s.segs) < 30: start_video(s)
            if not on and now - S['last_seen'] > GRACE:
                S['sess'] = None
                close_window(s, now)
                rec = summarise(s); S['last_at'] = int(now * 1000)
                print('takeover ended', s.id, rec and rec['title'], flush=True)
        status()
        time.sleep(1)

if __name__ == '__main__':
    main()
