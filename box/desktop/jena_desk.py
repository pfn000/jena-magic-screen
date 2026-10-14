#!/usr/bin/env python3
"""Jena's desktop: she uses her own computer (X display :99) by herself, and looks at it.

Runs as the unix user `jena` (her own account on the box: her own home, no access to anyone else's files).
  * hands  - on her own schedule, and when people talk to her, she opens a terminal and runs harmless
             little commands (htop, jenafetch, ls, tiny python scripts), opens Firefox to pages about what
             is being talked about (Wikipedia, docs), and types her thoughts into a notes file. xdotool/wmctrl.
  * eyes   - every few seconds: screenshot of :99, the active window's title, OCR (tesseract) of what is in
             it -> a short "what's on my screen" line in her voice + the raw facts.
  * door   - one small HTTP port (default 6081) for the site and the tunnel:
               GET  /box/screen.json   what she sees now (summary, window, ocr text, recent actions)
               GET  /box/shot.jpg      the latest screenshot (small jpeg)
               GET  /box/desktop.json  {"websockify": "/websockify"}  (stream lives on this same host)
               POST /box/event         {"text","user","source"}  something said to her (private ones ignored)
               GET  /websockify        passed straight through to the noVNC websockify (view-only x11vnc)
Nothing here logs in anywhere or touches anyone's accounts.
"""
import asyncio, json, os, random, re, subprocess, threading, time, hashlib, urllib.request, urllib.parse
from collections import deque
import jena_skills as skills
import jena_memory as memory
try: import jena_censor            # public desktop frames are censored before they leave the box (optional module)
except Exception as _e: jena_censor = None; print('jena_censor not loaded:', _e, flush=True)
try: import jena_signin            # private one-time sign-in windows for mama (optional module)
except Exception as _e: jena_signin = None; print('jena_signin not loaded:', _e, flush=True)

DISPLAY = os.environ.get('DISP', ':99')
PORT = int(os.environ.get('JENA_BOX_PORT', '6081'))
WS_UPSTREAM = ('127.0.0.1', int(os.environ.get('WEBSOCKIFY_PORT', '6080')))
WS_MAMA = ('127.0.0.1', int(os.environ.get('WEBSOCKIFY_MAMA_PORT', '6082')))   # full-control VNC, only via a one-time mama token
BRAIN = os.environ.get('JENA_BRAIN', 'http://127.0.0.1:8088/v1')
SITE = os.environ.get('JENA_SITE', 'https://jena-magic-screen.vercel.app')
HOME = os.path.expanduser('~')
STATE = os.path.join(HOME, '.jena')

# No-repeat picks (Saidie, Oct 13: "make sure that she's not cycling or repeating things"): every random choice of a
# line, command or idle bit goes through fresh_choice(): nothing from the last `gap` picks of that kind, nothing from
# the last `window` seconds while anything else is free, remembered across restarts in ~/.jena/recent_picks.json.
RECENT_PICKS = os.path.join(STATE, 'recent_picks.json')
_picks_lock = threading.Lock()
def fresh_choice(pool, kind, gap=3, window=1800):
    pool = list(pool)
    if not pool: raise IndexError('fresh_choice from an empty pool')
    key = lambda x: x if isinstance(x, str) else json.dumps(x, sort_keys=True, default=str)[:200]
    with _picks_lock:
        try: rec = json.load(open(RECENT_PICKS))
        except Exception: rec = {}
        hist = [h for h in rec.get(kind, []) if isinstance(h, list) and len(h) == 2]
        now = time.time(); g = min(gap, max(1, (len(set(map(key, pool))) - 1) // 2))
        last = {k for k, _ in hist[:g]}; recent = {k for k, at in hist if now - at < window}
        free = [x for x in pool if key(x) not in last and key(x) not in recent] or [x for x in pool if key(x) not in last] or pool
        x = random.choice(free)
        rec[kind] = ([[key(x), now]] + hist)[:40]
        try:
            with open(RECENT_PICKS + '.tmp', 'w') as f: json.dump(rec, f)
            os.replace(RECENT_PICKS + '.tmp', RECENT_PICKS)
        except OSError: pass
        return x
def fresh_sample(pool, n, kind, window=3600):
    out, rest = [], list(pool)
    for _ in range(min(n, len(rest))):
        x = fresh_choice(rest, kind, gap=len(pool), window=window); out.append(x); rest.remove(x)
    return out
os.makedirs(STATE, exist_ok=True)
try:
    os.chmod(STATE, 0o700)
    # her gateway (runs as 'user') appends to activity.jsonl and reads api_key.sha256 here: chmod resets the ACL mask,
    # so give it back by ACL every start (nobody else gets in)
    subprocess.run(['setfacl', '-m', 'u:user:rwx,d:u:user:rw', STATE], timeout=5, capture_output=True)
    for _f in ('activity.jsonl', 'api_key.sha256'):
        if os.path.exists(os.path.join(STATE, _f)): subprocess.run(['setfacl', '-m', 'u:user:rw', os.path.join(STATE, _f)], timeout=5, capture_output=True)
except Exception: pass
ENV = dict(os.environ, DISPLAY=DISPLAY, HOME=HOME)

BAD = re.compile(r"\b(sex\w*|porn\w*|nude\w*|naked|nsfw|onlyfans|fetish\w*|erotic\w*|hentai|xxx|boob\w*|horny|kiss\w*|"
                 r"strip\w*|lingerie|bikini|hook ?up|date me|marry me|bae|babe|daddy|nazi\w*|suicide|self.?harm|kill\w*|gore|"
                 r"drug\w*|cocaine|meth|weed|vape|gun\w*|bomb\w*|hack (into|someone)|password\w*|login|log in|sign in|"
                 r"credit card|ssn)\b", re.I)

def safe(s):
    return not BAD.search(s or '')

class HandsPaused(Exception): pass
input_gate = threading.RLock()
input_jobs = set()
private_session = False

mama_stop = {'until': 0}       # mama said 'stop' / 'no, do X instead': her hands drop what they are doing for a moment
def hands_blocked():
    si = globals().get('signin')
    tk = globals().get('TK')   # jena_takeover.py: mama's 60-min double-click pause holds even across a dropped connection
    return bool(globals().get('mama', {}).get('driving') or private_session or (si is not None and si.active()) or time.time() < mama_stop['until'] or (tk is not None and tk.paused()))

def input_command(cmd):
    words = cmd if isinstance(cmd, (list, tuple)) else str(cmd).split()
    if not words: return False
    tool = os.path.basename(str(words[0]))
    if tool == 'xdotool':
        return len(words) < 2 or not str(words[1]).startswith(('get', 'search'))
    return tool == 'wmctrl' and any(x in words for x in ('-a', '-r', '-c', '-k', '-s'))

def stop_her_inputs():
    # Called while claiming the gate: kills typing/click commands ALREADY in flight.
    with input_gate:
        for proc in tuple(input_jobs):
            try: proc.terminate()
            except Exception: pass

def sh(cmd, timeout=10):
    changing = input_command(cmd)
    proc = None
    try:
        if changing:
            with input_gate:
                if hands_blocked(): raise HandsPaused('input blocked: mama owns the desktop')
                proc = subprocess.Popen(cmd, shell=isinstance(cmd, str), env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                input_jobs.add(proc)
            out, _ = proc.communicate(timeout=timeout)
            return out.strip()
        r = subprocess.run(cmd, shell=isinstance(cmd, str), env=ENV, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except HandsPaused: raise
    except Exception:
        if proc:
            try: proc.kill()
            except Exception: pass
        return ''
    finally:
        if proc:
            with input_gate: input_jobs.discard(proc)

def spawn(cmd):
    with input_gate:
        if hands_blocked(): raise HandsPaused('app launch blocked: mama owns the desktop')
        return subprocess.Popen(cmd, env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, cwd=HOME)

# ---------------------------------------------------------------- shared state
lock = threading.Lock()
actions = deque(maxlen=12)       # what her hands did, newest last
events_in = deque(maxlen=20)     # things people said to her
screen = {'ok': False, 'summary': 'just woke up, nothing on my screen yet', 'ts': 0}
shot_jpg = b''

def did(text, kind='hands'):
    with lock:
        actions.append({'ts': int(time.time() * 1000), 'kind': kind, 'text': text})
    print(time.strftime('%H:%M:%S'), kind, text, flush=True)

# ---------------------------------------------------------------- windows
def windows():
    out = sh(['wmctrl', '-lx'])
    res = []
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) >= 4:
            res.append({'id': parts[0], 'cls': parts[2].lower(), 'title': parts[4] if len(parts) > 4 else ''})
    return res

def find(cls_part):
    for w in windows():
        if cls_part in w['cls']:
            return w['id']
    return None

def wait_for(cls_part, secs=25):
    t = time.time()
    while time.time() - t < secs:
        w = find(cls_part)
        if w:
            return w
        time.sleep(0.5)
    return None

def focus(wid):
    sh(['wmctrl', '-i', '-a', wid]); time.sleep(0.4)
    sh(['xdotool', 'windowactivate', '--sync', str(int(wid, 16))], timeout=4); time.sleep(0.3)

def type_(text, delay=55):
    for chunk in re.split(r'(\n)', text):
        if chunk == '\n':
            sh(['xdotool', 'key', 'Return']); time.sleep(0.25)
        elif chunk:
            sh(['xdotool', 'type', '--delay', str(delay + random.randint(-15, 25)), chunk], timeout=60)

def key(*k):
    sh(['xdotool', 'key'] + list(k)); time.sleep(0.3)

# ---------------------------------------------------------------- her apps
def terminal():
    wid = find('xterm')
    if not wid:
        spawn(['xterm', '-T', 'jena@xi: ~', '-xrm', 'XTerm*allowSendEvents: true', '-fa', 'DejaVu Sans Mono', '-fs', '12',
               '-bg', '#1b1029', '-fg', '#f6dcff', '-cr', '#ff7ad9', '-geometry', '92x26+40+40', '-e', 'bash'])
        wid = wait_for('xterm', 15)
        time.sleep(1.2)
    if wid:
        focus(wid)
    return wid

def screen_size():
    m = re.search(r'dimensions:\s+(\d+)x(\d+)', sh(['xdpyinfo']))
    return (int(m.group(1)), int(m.group(2))) if m else (1600, 704)

NEW_TAB_WORDS = re.compile(r'\b(in |into )?(a )?new (tab|window)\b', re.I)
def wants_new_tab(text):
    return bool(NEW_TAB_WORDS.search(text or ''))

tabs_opened = {'n': 0}   # tabs she opened on top of the first one (hard cap below); the site reuses the current tab otherwise
MAX_EXTRA_TABS = 2

def firefox(url, new_tab=False):
    """open url in her Firefox. ALWAYS the current tab (focus, Ctrl+L, type, Enter) unless new_tab=True, which only
    mama's own words ('open X in a new tab' / 'new window') set; and at most MAX_EXTRA_TABS extra tabs ever."""
    if hands_blocked(): return None     # mama is driving, or her Firefox profile is busy in the private sign-in window
    wid = find('firefox')
    W, H = screen_size()
    fw, fh = min(1180, W - 60), H - 70
    if not wid:
        spawn(['firefox-esr', '--new-instance', '--profile', os.path.join(HOME, '.ffprofile'), '--width', str(fw), '--height', str(fh), url])
        wid = wait_for('firefox', 40)
        tabs_opened['n'] = 0
        if wid:
            time.sleep(4)
            sh(['wmctrl', '-i', '-r', wid, '-e', f'0,{W - fw - 20},8,{fw},{fh}'])
            try:  # if memory gets tight, the browser goes first, never her brain
                for pid in sh(['pgrep', '-u', str(os.getuid()), '-f', 'firefox-esr']).split():
                    open(f'/proc/{pid}/oom_score_adj', 'w').write('800')
            except Exception:
                pass
        return wid
    focus(wid)
    if new_tab:
        if tabs_opened['n'] >= MAX_EXTRA_TABS:
            did(f'already have {MAX_EXTRA_TABS} extra tabs open, so I am reusing this one instead of a new one')
        else:
            key('ctrl+t'); time.sleep(0.6); tabs_opened['n'] += 1
    key('ctrl+l'); time.sleep(0.5); key('ctrl+a'); time.sleep(0.15)   # the whole address bar, even if a page grabbed focus
    type_(url + '\n', delay=35)
    return wid

def notes():
    wid = find('mousepad')
    if not wid:
        spawn(['mousepad', os.path.join(HOME, 'notes', 'thoughts.txt')])
        wid = wait_for('mousepad', 20)
        if wid:
            time.sleep(1.5)
            W, H = screen_size()
            sh(['wmctrl', '-i', '-r', wid, '-e', f'0,{W - 620},{H - 400},600,360'])
    if wid:
        focus(wid)
    return wid

# ---------------------------------------------------------------- pages she reads
PAGES = [
    ('Linux', 'https://en.wikipedia.org/wiki/Linux'), ('Tux the penguin', 'https://en.wikipedia.org/wiki/Tux_(mascot)'),
    ('capture the flag', 'https://en.wikipedia.org/wiki/Capture_the_flag_(cybersecurity)'),
    ('rubber duck debugging', 'https://en.wikipedia.org/wiki/Rubber_duck_debugging'),
    ('the demoscene', 'https://en.wikipedia.org/wiki/Demoscene'), ('neural networks', 'https://en.wikipedia.org/wiki/Neural_network_(machine_learning)'),
    ('transformers', 'https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)'),
    ('the Python tutorial', 'https://docs.python.org/3/tutorial/index.html'), ('MDN JavaScript', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript'),
    ('three.js docs', 'https://threejs.org/docs/'), ('VTubers', 'https://en.wikipedia.org/wiki/VTuber'),
    ('pixel art', 'https://en.wikipedia.org/wiki/Pixel_art'), ('the Game Boy', 'https://en.wikipedia.org/wiki/Game_Boy'),
    ('Tetris', 'https://en.wikipedia.org/wiki/Tetris'), ('octopuses', 'https://en.wikipedia.org/wiki/Octopus'),
    ('black holes', 'https://en.wikipedia.org/wiki/Black_hole'), ('Raspberry Pi', 'https://en.wikipedia.org/wiki/Raspberry_Pi'),
    ('Rust', 'https://en.wikipedia.org/wiki/Rust_(programming_language)'), ('ASCII art', 'https://en.wikipedia.org/wiki/ASCII_art'),
    ("Conway's Game of Life", 'https://en.wikipedia.org/wiki/Conway%27s_Game_of_Life'), ('xkcd', 'https://xkcd.com/'),
    ('the Turing test', 'https://en.wikipedia.org/wiki/Turing_test'), ('inverse kinematics', 'https://en.wikipedia.org/wiki/Inverse_kinematics'),
]

STOP = set("""a an the i im i'm you u your yours me my mine we us our is are was were be been am do does did
to of in on at for with and or but so if then than that this these those it its it's what whats how why who when where
which can could would should will just like hey hi hello yo jena jenaxi mama lol lmao omg pls please ok okay yeah yes no not
dont don't have has had get got go going gonna wanna want know think tell say said make made really very much more some any
about there here they them he she him her his hers up out one two all can't cant ur look check open show""".split())

def _opensearch(q):
    u = 'https://en.wikipedia.org/w/api.php?' + urllib.parse.urlencode({'action': 'opensearch', 'search': q, 'limit': 1, 'namespace': 0, 'format': 'json'})
    req = urllib.request.Request(u, headers={'User-Agent': 'JenaDesk/1.0 (her own little desktop)'})
    data = json.loads(urllib.request.urlopen(req, timeout=6).read())
    if data[1] and safe(data[1][0]):
        return data[1][0], data[3][0]
    return None

def wiki_for(text):
    words = [w.strip(".'") for w in re.findall(r"[A-Za-z][A-Za-z0-9+#.'-]{2,}", text or '') if w.lower().strip(".'") not in STOP]
    if not words or not safe(text):
        return None
    try:
        hit = _opensearch(' '.join(words[:4]))
        if not hit and len(words) > 1:
            hit = _opensearch(max(words, key=len))
        return hit
    except Exception:
        return None

# ---------------------------------------------------------------- exact URLs, multi-search, her hot list, videos
URL_RE = re.compile(r"(https?://[^\s<>\"']+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|dev|app|gg|tv|edu|gov|co|me|xyz|bot|site|info|us|uk|ca|de|jp)(?:/[^\s<>\"']*)?)", re.I)

def url_in(text):
    m = URL_RE.search(text or '')
    if not m: return None
    u = m.group(1).rstrip('.,!?)\]')
    if not re.match(r'https?://', u, re.I): u = 'https://' + u
    return u if safe(u) else None

def _get(url, timeout=6, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers={'User-Agent': 'Mozilla/5.0 (JenaDesk/1.1; her own little desktop)', **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout).read()

def github_for(q):
    try:
        d = json.loads(_get('https://api.github.com/search/repositories?per_page=3&q=' + urllib.parse.quote(q)))
        for x in d.get('items', []):
            if safe(x['full_name'] + ' ' + (x.get('description') or '')):
                return x['full_name'], x['html_url']
    except Exception:
        pass
    return None

def ddg_for(q):
    try:
        h = _get('https://html.duckduckgo.com/html/', data=('q=' + urllib.parse.quote(q)).encode(), headers={'Content-Type': 'application/x-www-form-urlencoded'}).decode('utf8', 'ignore')
        for m in re.finditer(r'class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', h):
            u = m.group(1); mm = re.search(r'uddg=([^&]+)', u)
            if mm: u = urllib.parse.unquote(mm.group(1))
            if u.startswith('//'): u = 'https:' + u
            t = re.sub(r'<[^>]+>', '', m.group(2))
            if 'duckduckgo.com/y.js' in u or not safe(t + ' ' + u): continue
            return t, u
    except Exception:
        pass
    return None

HOT = {'at': 0, 'list': []}
def hot_urls():
    if time.time() - HOT['at'] < 600 and HOT['list']: return HOT['list']
    try:
        txt = _get('https://raw.githubusercontent.com/pfn000/jena-magic-screen/main/Hot%20URLS/URLS.md').decode()
        lst = []
        for line in txt.splitlines():
            m = re.match(r'\s*-\s*(\S+)\s*(?:\[([^\]]*)\])?', line)
            if not m: continue
            u = m.group(1)
            if not re.match(r'https?://', u, re.I): u = 'https://' + u
            lst.append((u, (m.group(2) or '').strip()))
        HOT.update(at=time.time(), list=lst)
    except Exception:
        pass
    return HOT['list']

VIDEOS = {'at': 0, 'list': []}
def my_videos():
    """the real videos she learned her moves from (the site's moves library)"""
    if time.time() - VIDEOS['at'] < 1800 and VIDEOS['list']: return VIDEOS['list']
    try:
        d = json.loads(_get(SITE + '/moves/index.json'))
        VIDEOS.update(at=time.time(), list=[(c['source']['url'], c['source'].get('title') or c.get('what'), c.get('label')) for c in d.get('clips', []) if c.get('source', {}).get('url')])
    except Exception:
        pass
    return VIDEOS['list']

watching = {'video': None}
def nap(secs):
    """wait, but someone talking to her interrupts it"""
    end = time.time() + secs
    while time.time() < end:
        time.sleep(0.5)
        with lock:
            if events_in: return
VID_DIR = os.path.join(HOME, 'Videos')
def local_video(vid):
    """a small local copy (<=480p) so it plays smoothly here: no ads, no popups, software decode is easy"""
    os.makedirs(VID_DIR, exist_ok=True)
    have = [f for f in os.listdir(VID_DIR) if f.startswith(vid + '.') and not f.endswith('.part')]
    if have: return os.path.join(VID_DIR, have[0])
    for extra in ([], ['-f', 'b[height<=480]/b']):
        sh(['nice', '-n', '15', 'yt-dlp', '-q', '--no-playlist', '--js-runtimes', 'node', '-S', 'res:480', *extra,
            '-o', os.path.join(VID_DIR, '%(id)s.%(ext)s'), 'https://www.youtube.com/watch?v=' + vid], timeout=180)
        if any(f.startswith(vid + '.') and not f.endswith('.part') for f in os.listdir(VID_DIR)): break
    have = [f for f in os.listdir(VID_DIR) if f.startswith(vid + '.') and not f.endswith('.part')]
    return os.path.join(VID_DIR, have[0]) if have else None

def fetch_videos():
    """keep local copies of every video she learned from, one at a time, slowly"""
    time.sleep(60)
    for url, title, label in my_videos():
        m = re.search(r'[?&]v=([\w-]{11})', url)
        if m: local_video(m.group(1)); time.sleep(5)

def act_watch(video=None):
    vids = all_videos()
    if not vids and not video: return act_read()
    url, title, label = video or fresh_video(vids)
    memory.record('video', f'watched "{(title or label or url)[:80]}"', key='video:' + url, action='watch', note=f'the video i learned my {label} move from')
    vid = re.search(r'[?&]v=([\w-]{11})', url)
    path = local_video(vid.group(1)) if vid else None
    with lock:
        watching['video'] = {'url': url, 'title': title, 'label': label, 'since': int(time.time() * 1000), 'player': 'ffplay (local copy)' if path else 'firefox'}
    log_activity('watch', url, f'"{title[:80]}" (learned my {label} move from it)')
    if path:
        did(f'watching "{title[:70]}", the video I learned my {label} move from')
        W, H = screen_size()
        vw, vh = min(960, W - 80), min(540, H - 90)
        p = subprocess.Popen(['ffplay', '-loglevel', 'quiet', '-an', '-autoexit', '-x', str(vw), '-y', str(vh), '-left', str((W - vw) // 2), '-top', '30',
                              '-window_title', f'{title[:60]} (watching)', path], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        end = time.time() + random.uniform(25, 45)
        while time.time() < end and p.poll() is None:
            time.sleep(0.5)
            with lock:
                if events_in: break
        if p.poll() is None: p.terminate()
    else:
        did(f'could not get a local copy of "{title[:50]}", opening it on YouTube instead')
        firefox(url); nap(25)
    with lock:
        watching['video'] = None

def act_hot():
    lst = [h for h in hot_urls() if safe(h[0])]
    if not lst: return act_read()
    u, note = memory.pick_fresh(lst, lambda x: 'site:' + x[0], kind='site')
    memory.record('site', f'opened {u} from my hot list', key='site:' + u, action='hot')
    did(f'opened {u} from my hot list' + (f' ({note})' if note else ''))
    log_activity('open', u, 'hot list')
    firefox(u); time.sleep(4); scroll_some()

def act_search(text):
    """multi-search: DuckDuckGo results page on screen, then the best hit from DuckDuckGo / GitHub / Wikipedia / her hot list"""
    q = ' '.join(w for w in re.findall(r"[A-Za-z0-9+#.'-]+", text) if w.lower() not in STOP)[:120] or text[:120]
    if not safe(q): return False
    did(f'searching "{q[:60]}" (DuckDuckGo, GitHub, Wikipedia, my hot list)')
    firefox('https://duckduckgo.com/?q=' + urllib.parse.quote(q)); time.sleep(5)
    want_code = re.search(r'\b(github|repo|repos|code|library|package|lib|framework|source)\b', text, re.I)
    hot = [h for h in hot_urls() if any(w.lower() in (h[0] + ' ' + h[1]).lower() for w in q.split() if len(w) > 3)]
    tries = ([github_for, ddg_for, wiki_for] if want_code else [ddg_for, wiki_for, github_for])
    for f in tries:
        hit = f(q)
        if hit:
            title, url = hit
            src = {github_for: 'GitHub', ddg_for: 'DuckDuckGo', wiki_for: 'Wikipedia'}[f]
            did(f'opened "{title[:60]}" from {src}')
            log_activity('search', url, f'{src} for "{q[:60]}"')
            firefox(url); time.sleep(3); scroll_some(); return True
    if hot:
        did(f'opened {hot[0][0]} from my hot list'); firefox(hot[0][0]); return True
    did('my searches came back empty, so I kept the results page open')
    return True

# ---------------------------------------------------------------- activity log (for mama, dev panel only)
FLAG = re.compile(r"\b(dating|hook ?up|casino|gambl\w*|bet(ting)?|alcohol|beer|vodka|vape|vaping|cigarette\w*|weapon\w*|gun\w*|knife|drugs?|weed|porn\w*|nsfw|onlyfans|nude\w*|sex\w*|self.?harm|suicide|kill\w*|hack(ing)? (into|someone)|password\w*|credit card|buy now|checkout)\b", re.I)
ACT = os.path.join(STATE, 'activity.jsonl')
def log_activity(kind, what, why=''):
    rec = {'ts': int(time.time() * 1000), 'kind': kind, 'what': str(what)[:300], 'why': str(why)[:200]}
    m = FLAG.search(f'{what} {why}')
    if m: rec['flag'] = f'matched "{m.group(0)}"'
    try:
        with open(ACT, 'a') as f: f.write(json.dumps(rec) + '\n')
    except Exception: pass

HELP = os.path.join(STATE, 'help.jsonl')
def ask_mama(text):
    """she asks mama for help (shows in the dev panel, never on stream)"""
    try:
        with open(HELP, 'a') as f: f.write(json.dumps({'ts': int(time.time() * 1000), 'text': text[:400]}) + '\n')
    except Exception: pass
    did(f'asked mama for help: {text[:80]}', 'help')

def clipboard_text():
    return sh(['xclip', '-o', '-selection', 'clipboard'], timeout=4)

def skill_ask_grok(inp):
    """ask Grok on grok.com in her own Firefox (her persistent profile: if mama signed in there once via takeover, it stays
    signed in); label the answer as Grok's. Never signs in, never makes accounts, never touches a CAPTCHA."""
    q = (inp.get('question') or inp.get('text') or '').strip()
    q = re.sub(r'^(jena[, ]+)?(please )?(can you )?(ask grok( to| about)?)\s*', '', q, flags=re.I).strip(' ?') or q
    if not q: return {'ok': False, 'summary': 'no question for Grok'}
    url = next((u for u, _ in hot_urls() if 'grok.com' in u.lower()), None)
    if not url: return {'ok': False, 'summary': 'grok.com is not in my hot-URL list, so I did not go there'}
    did(f'asking Grok (from my hot list, {url}): "{q[:80]}"', 'skill')
    log_activity('ask_grok', url, q)
    firefox(url); time.sleep(8)
    wid = find('firefox')
    if not wid: return {'ok': False, 'summary': 'my browser did not open'}
    g = dict(l.split('=', 1) for l in sh(['xdotool', 'getwindowgeometry', '--shell', str(int(wid, 16))]).splitlines() if '=' in l)
    X, Y, W, H = (int(g.get(k, 0)) for k in ('X', 'Y', 'WIDTH', 'HEIGHT'))
    def page_text():
        if mama['driving']: return ''
        focus(wid); key('ctrl+a'); time.sleep(0.3); key('ctrl+c'); time.sleep(0.4)
        t = clipboard_text()
        sh(['xdotool', 'mousemove', str(X + W - 30), str(Y + H // 2), 'click', '1'])   # drop the selection
        return t
    WALL = r'sign up to continue|continue your conversation|sign in to continue|log in to continue|create an account|sign up for free'
    CF = r'verify you are human|checking your browser|just a moment|performance & security by cloudflare|needs to review the security'
    first = page_text()
    if re.search(CF, first or '', re.I):
        why = 'grok.com put up a Cloudflare "verify you are human" check, and I do not do CAPTCHAs by myself'
        ask_mama(f'I tried asking Grok "{q[:80]}" but {why}.'); return {'ok': False, 'summary': why}
    # the composer is in the middle of a fresh page (signed out or in) and at the bottom of an open chat: try both,
    # and only press Enter once the question is really in a box
    typed = False
    for frac in (0.42, 0.5, 0.88):
        if mama['driving']: return {'ok': False, 'summary': 'mama took over, so I stopped asking Grok'}
        focus(wid)
        sh(['xdotool', 'mousemove', str(X + W // 2), str(Y + int(H * frac)), 'click', '1']); time.sleep(0.6)
        key('ctrl+a'); sh(['xdotool', 'type', '--delay', '35', q[:300]]); time.sleep(0.5)
        key('ctrl+a'); time.sleep(0.2); key('ctrl+c'); time.sleep(0.3)
        sel = clipboard_text()
        if sel and sel.strip() == q[:300].strip():   # the box holds exactly the question: that was the composer
            key('End'); typed = True; break
        key('Escape')
    if not typed:
        why = 'I could not find the question box on grok.com'
        ask_mama(f'I tried asking Grok "{q[:80]}" but {why}.'); return {'ok': False, 'summary': why}
    key('Return')
    before, text = '', ''
    for _ in range(9):
        time.sleep(5)
        if mama['driving']: return {'ok': False, 'summary': 'mama took over, so I stopped asking Grok'}
        text = page_text()
        if text and text == before and q[:30] in text: break
        before = text
    ans = ''
    if q[:30] in text:
        ans = text.rsplit(q[:30], 1)[1]          # the last copy of the question is the one in the chat (the sidebar lists it too when signed in)
        ans = ans.split(q[30:], 1)[-1] if len(q) > 30 else ans
        ans = re.split(r'\n\s*(Ask anything|How can Grok help|What do you want to know|Grok can make mistakes|DeepSearch|Think\b|Auto\b|By messaging Grok)', ans)[0]
        ans = re.sub(r'\n{2,}', '\n', ans).strip()
    wall = re.search(WALL, ans or text or '', re.I)
    if wall: ans = ''
    if not ans:
        if re.search(CF, text or '', re.I): why = 'grok.com put up a Cloudflare "verify you are human" check, and I do not do CAPTCHAs by myself'
        elif wall or re.search(r'\b(sign in|log in|sign up)\b', text or '', re.I):
            why = 'grok.com showed a "sign up to continue" wall (signed-out visitors get no answer), and I do not sign in or make accounts by myself'
            request_signin('grok', f'Grok needs an account to answer; I wanted to ask it "{q[:80]}"')
            ask_mama(f'I tried asking Grok "{q[:80]}" but {why}. Please sign me in once (dev panel -> sign-in request) and it stays signed in.')
            return {'ok': False, 'summary': why + '; I asked mama to sign me in once (dev panel)'}
        else: why = 'I could not read an answer off the page'
        ask_mama(f'I tried asking Grok "{q[:80]}" but {why}.')
        return {'ok': False, 'summary': why}
    os.makedirs(os.path.join(HOME, 'learned'), exist_ok=True)
    rec = {'ts': int(time.time() * 1000), 'question': q, 'answer': ans[:4000], 'source': 'Grok (grok.com, in her own browser)', 'note': 'Grok\'s answer, not Jena\'s own brain'}
    with open(os.path.join(HOME, 'learned', 'grok_notes.jsonl'), 'a') as f: f.write(json.dumps(rec) + '\n')
    with open(os.path.join(HOME, 'notes', 'learned_from_grok.md'), 'a') as f: f.write(f"\n## {time.strftime('%Y-%m-%d %H:%M')} I asked Grok: {q}\nGrok said: {ans[:1500]}\n")
    did(f'Grok answered (Grok\'s words, saved to my memory): "{re.sub(chr(10), " ", ans)[:160]}"', 'skill')
    return {'ok': True, 'summary': f'asked Grok "{q[:60]}" and saved its answer', 'question': q, 'answer': ans[:4000], 'answered_by': 'Grok'}
skills.desktop_skills['ask_grok'] = skill_ask_grok

# ---------------------------------------------------------------- check_my_email: her Proton Mail inbox (web only), read in her own Firefox
# Mama signs in once (private sign-in window). Jena only READS the inbox list: sender, subject, time, and whether a mail looks
# like a verification code. She never sends mail. Bodies, addresses and code digits never go to the public site or her thought
# chain (there it is only "got a code from X ✔"); the details go to mama's activity log (passcode, dev panel).
email_private = {'ts': 0, 'messages': []}     # only in RAM, mama-only retrieval, expires after 5 minutes
MAIL_URL = 'https://mail.proton.me/u/0/inbox'
MAIL_CHROME = re.compile(r'^(inbox|drafts|sent|starred|archive|spam|trash|all mail|folders|labels|more|less|settings|new message|search messages|'
                         r'search|upgrade|proton mail|mail|calendar|drive|vpn|pass|wallet|unread|select all|refresh|jena|\d+ ?(messages?|unread)?|'
                         r'filters|snoozed|scheduled|almost all mail|categories|newsletters|transactions|updates|forums|promotions|social|'
                         r'get the app|get proton|move to|label as|delete|mark as read|mark as unread|get started|help|feedback)$', re.I)
MAIL_TIME = re.compile(r'^(\d{1,2}:\d{2}\s*(am|pm)?|yesterday|today|(mon|tue|wed|thu|fri|sat|sun)[a-z]*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}(, \d{4})?|\d{1,2}/\d{1,2}(/\d{2,4})?)$', re.I)
CODE_HINT = re.compile(r'\b(verification|verify|confirm(ation)?|one.?time|security|login|sign.?in|passcode|2fa|otp|pin)\b.*\b(code|pin|passcode)\b|\bcode\b', re.I)
CODE_DIGITS = re.compile(r'(?<!\d)(\d{4,8}|\d{3}[- ]\d{3})(?!\d)')

def skill_check_my_email(inp):
    """reads the inbox list of the Proton Mail account mama signed me into (web, in my Firefox). Read-only; private details go to mama's log only."""
    did('checking my email inbox in my browser (the details stay between me and mama)', 'skill')
    log_activity('check_my_email', MAIL_URL, 'read the inbox list')
    mama['private_until'] = time.time() + 90      # the public desktop is private while the inbox is on screen
    set_private_reason('inbox', True)
    try:
        wid = firefox(MAIL_URL)
        if not wid: return {'ok': False, 'summary': 'my browser is busy (mama is driving or signing in), try again in a bit'}
        time.sleep(12)
        wid = find('firefox')
        if not wid: return {'ok': False, 'summary': 'my browser did not open'}
        focus(wid); key('ctrl+a'); time.sleep(0.3); key('ctrl+c'); time.sleep(0.4)
        text = clipboard_text() or ''
        sh('printf "" | xclip -i -selection clipboard', timeout=4)      # the inbox text does not stay on my clipboard
        key('Escape')
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        low = text.lower()
        if ('inbox' not in low or re.search(r'sign in to proton|create a proton account|forgot password|sign in\s*$', low, re.M)) and re.search(r'\b(sign in|log in|create (an )?account)\b', low):
            request_signin('proton', 'I want to read my email inbox but Proton wants me to sign in')
            return {'ok': False, 'summary': 'Proton Mail wants a sign-in; I asked mama to sign me in once (dev panel)'}
        if 'inbox' not in low:
            return {'ok': False, 'summary': 'I could not read my inbox off the page (is Proton Mail open?)'}
        # group the message list: Proton's rows copy as sender / subject (+ preview) / time; the time ends a row
        rows, cur = [], []
        for l in lines:
            if MAIL_CHROME.match(l): continue
            cur.append(l)
            if MAIL_TIME.match(l):
                rows.append(cur); cur = []
        msgs = []
        for r in rows[:30]:
            if len(r) < 2: continue
            when = r[-1]; sender = r[0]; subject = ' '.join(r[1:-1])[:160] or '(no subject)'
            is_code = bool(CODE_HINT.search(subject) and CODE_DIGITS.search(subject))
            code = CODE_DIGITS.search(subject).group(1) if is_code else None
            msgs.append({'from': sender[:80], 'subject': subject, 'when': when, 'code': code})
        codes = [m for m in msgs if m['code']]
        email_private.update({'ts': time.time(), 'messages': msgs})
        for m in msgs[:12]:
            log_activity('email', mask_text(f"{m['from']} — {m['subject']} ({m['when']})"), 'inbox metadata, read only')
        for m in codes:
            log_activity('email_code', 'verification code detected', 'value kept in private result only')
        public = f'checked my inbox: {len(msgs)} message{"s" if len(msgs) != 1 else ""} in the list' + (', got a code from ' + ', '.join(sorted({mask_text(m['from']) for m in codes})) + ' ✔' if codes else '') + ' — details are in mama\'s log'
        did(public, 'skill')
        return {'ok': True, 'summary': public, 'messages_seen': len(msgs), 'codes_seen': len(codes), 'note': 'senders, subjects and any code digits are in mama\'s activity log only', 'raw_lines': len(lines)}
    except HandsPaused:
        return {'ok': False, 'summary': 'mama took over, so I stopped reading my email'}
    finally:
        try:
            if find('firefox'):   # never leave the inbox on my public desktop
                focus(find('firefox')); key('ctrl+l'); time.sleep(0.2); type_('about:blank\n', delay=20); time.sleep(1)
        except Exception: pass
        mama['private_until'] = 0
        set_private_reason('inbox', False)
skills.desktop_skills['check_my_email'] = skill_check_my_email

# terminal self-discovery: she explores her own box in her visible terminal, only from a fixed list of
# read-only commands (no sudo, no rm, nothing typed from chat), and writes what she found to her notes.
EXPLORE = [
    ('whoami && id', 'who I am on this computer'), ('uname -srm', 'my kernel'), ('head -2 /etc/os-release', 'my operating system'),
    ('nproc && free -h', 'my CPU cores and memory'), ('df -h ~ | tail -1', 'how much disk I have'), ('ls ~', 'my home folder'),
    ('ls ~/projects ~/notes', 'my projects and notes'), ('python3 --version && node -v', 'which languages I have'),
    ('ls ~/jena-repo/skills', 'my skills folder'), ('cat /proc/loadavg', 'how busy my CPU is'), ('uptime -p', 'how long I have been awake'),
    ('ps -u jena -o comm= | sort | uniq -c | sort -rn | head -6', 'what programs I am running'), ('ls ~/Videos | head -5', 'my saved videos'),
    ('which git ffmpeg firefox-esr xterm', 'which tools I have'), ('ls ~/.local/bin | head -8', 'my own installed commands'),
    ('git -C ~/jena-repo log --oneline -3', 'the newest changes to my own code'), ('du -sh ~ 2>/dev/null', 'how much space I take up'),
]
def skill_explore(inp):
    picks = fresh_sample(EXPLORE, 5, 'explore')
    if not terminal(): return {'ok': False, 'summary': 'my terminal did not open'}
    did('exploring my own computer in my terminal (read-only commands)', 'skill')
    found = []
    for cmd, what in picks:
        type_(f'clear; {cmd}\n', 30); time.sleep(3.5)
        out = sh(['bash', '-c', cmd], timeout=8).strip()
        found.append((cmd, what, out[:600]))
    lines = [f"- {what} (`{cmd}`): {out.splitlines()[0][:140] if out else '(nothing)'}" for cmd, what, out in found]
    try:
        with open(os.path.join(HOME, 'notes', 'my_box.md'), 'a') as f:
            f.write(f"\n## {time.strftime('%Y-%m-%d %H:%M')} I explored my computer\n" + '\n'.join(lines) + '\n')
    except Exception: pass
    first = found[0]
    did(f'found out {first[1]}: {(first[2].splitlines() or ["(nothing)"])[0][:100]} (saved to notes/my_box.md)', 'skill')
    type_('clear\n', 30)
    return {'ok': True, 'summary': f'explored my box with {len(found)} read-only commands, notes saved', 'found': [{'cmd': c, 'what': w, 'out': o} for c, w, o in found]}
skills.desktop_skills['explore_my_box'] = skill_explore
def act_explore():
    use_skill('explore_my_box', 'explore my own computer')

# ---------------------------------------------------------------- hot modules: she updates her own packages
# and hot-reloads her skills module from her repo without restarting; the site shows a small indicator meanwhile.
import importlib, filecmp, shutil
updating = {}
PKG_STAMP = os.path.join(STATE, 'packages_updated')
def set_updating(phase=None, what=''):
    updating.clear()
    if phase: updating.update(phase=phase, what=what, since=int(time.time() * 1000))

def skill_update_packages(inp):
    global skills
    if not terminal(): return {'ok': False, 'summary': 'my terminal did not open'}
    set_updating('installing', 'my python + MCP packages')
    did('updating my own packages (pip + npm, only my user)', 'skill')
    type_('clear; pip install --user -U -q mcp mcp-server-fetch mcp-server-git; npm update --prefix ~/.npm-global; echo done\n', 25)
    r1 = subprocess.run(['/usr/local/bin/python3', '-m', 'pip', 'install', '--user', '-U', '-q', 'mcp', 'mcp-server-fetch', 'mcp-server-git'], capture_output=True, text=True, timeout=600)
    r2 = subprocess.run(['npm', 'update', '--prefix', os.path.join(HOME, '.npm-global')], capture_output=True, text=True, timeout=600)
    set_updating('restarting', 'my MCP servers')
    mcp = skills.mcp_status(refresh=True)
    vers = subprocess.run(['/usr/local/bin/python3', '-m', 'pip', 'list', '--user', '--format=freeze'], capture_output=True, text=True, timeout=60).stdout
    vers = ', '.join(l for l in vers.splitlines() if l.split('==')[0] in ('mcp', 'mcp-server-fetch', 'mcp-server-git'))
    open(PKG_STAMP, 'w').write(str(time.time()))
    set_updating()
    ok = r1.returncode == 0 and r2.returncode == 0 and all(m.get('connected') for m in mcp.values() if isinstance(m, dict))
    did(f'packages updated ({vers}); MCP servers back up: {"yes" if ok else "NOT all"}', 'skill')
    return {'ok': ok, 'summary': f'updated: {vers}' + ('' if ok else f' · pip {r1.returncode} npm {r2.returncode} ' + (r1.stderr or r2.stderr)[-160:]), 'versions': vers}
skills.desktop_skills['update_my_packages'] = skill_update_packages

def hot_reload_skills():
    """if her repo has a newer skills module, swap it in live (no restart)"""
    global skills
    new = os.path.join(HOME, 'jena-repo', 'box', 'desktop', 'jena_skills.py'); cur = skills.__file__
    if not os.path.exists(new) or filecmp.cmp(new, cur, shallow=False): return False
    set_updating('reloading', 'my skills module (from my repo)')
    keep = dict(skills.desktop_skills)
    try:
        shutil.copy(new, cur); time.sleep(1.5)
        skills = importlib.reload(skills); skills.desktop_skills.update(keep)
        did('hot-reloaded my skills module from my repo, no restart', 'skill')
    except Exception as e:
        did(f'tried to hot-reload my skills module but it failed: {str(e)[:80]}', 'skill')
    set_updating()
    return True

def upkeep():
    while True:
        time.sleep(300)
        try:
            hot_reload_skills()
            last = float(open(PKG_STAMP).read()) if os.path.exists(PKG_STAMP) else 0
            if time.time() - last > 86400 and not mama['driving']:
                with lock: events_in.append({'text': 'update my packages', 'user': 'jena', 'ts': time.time(), 'skill': 'update_my_packages'})
        except Exception as e:
            print('upkeep', e, flush=True)

def use_skill(name, text):
    did(f'using skill: {name}', 'skill')
    res = skills.run(name, {'text': text, 'query': text, 'question': text})
    if name != 'ask_grok':
        did(f'{name}: {res.get("summary", "")[:180]}{"" if res.get("ok") else " (failed)"}', 'skill')
    # show it on her screen too
    url = (res.get('hits') or res.get('repos') or [{}])[0].get('url') if res.get('ok') else None
    if name == 'fetch_page' and res.get('url'): url = res['url']
    if url and safe(url):
        log_activity('open', url, f'{name}: {text}')
        firefox(url); time.sleep(3); scroll_some()
    return res

PRIVATE_PAGE = re.compile(r'proton|mail\b|inbox|sign ?in|log ?in|login|account|password|verify|verification|authenticat|checkout|bank', re.I)
def tidy_private_pages():
    """after mama drove or signed in: if Firefox was left on a mailbox / login page, move it to a blank tab (the censor
    would cover it anyway, but the page itself should not stay up on her public desktop)"""
    for w in windows():
        if 'firefox' in w['cls'] and PRIVATE_PAGE.search(w['title'] or ''):
            did('mama left a sign-in page open in my browser, closing it before I go on', 'help')
            focus(w['id']); key('ctrl+l'); time.sleep(0.2); type_('about:blank\n', delay=20); time.sleep(0.8)
            break

def unstick():
    """close dialogs that would freeze her apps (e.g. mousepad's 'Externally Modified')"""
    for w in windows():
        if re.search(r'externally modified|save changes|crash reporter|close tabs\?', w['title'], re.I):
            focus(w['id']); key('Escape'); time.sleep(0.4)
            if find_title(w['title']): sh(['wmctrl', '-i', '-c', w['id']])
            did(f'closed a stuck "{w["title"][:40]}" dialog', 'hands')

def find_title(t):
    return any(w['title'] == t for w in windows())

# ---------------------------------------------------------------- her brain (optional)
def brain_line(prompt):
    """One short line from her own model, if it answers and it's clean. None otherwise."""
    try:
        body = json.dumps({'model': 'JenaXI', 'max_tokens': 40, 'temperature': 0.8, 'messages': [
            {'role': 'system', 'content': 'You are Jena (JenaXI), a chaotic gremlin teen hacker girl. You are writing one short line in your own notes file. No flirting, nothing romantic.'},
            {'role': 'user', 'content': prompt}]}).encode()
        req = urllib.request.Request(BRAIN.rstrip('/') + '/chat/completions', data=body, headers={'Content-Type': 'application/json'})
        out = json.loads(urllib.request.urlopen(req, timeout=8).read())
        line = (out['choices'][0]['message']['content'] or '').strip().split('\n')[0]
        line = re.sub(r'\[[^\]]*\]|<\|[^|]*\|>', '', line).strip()
        if 6 <= len(line) <= 160 and safe(line):
            return line
    except Exception:
        pass
    return None

# ---------------------------------------------------------------- activities
def act_htop():
    if not terminal(): return
    did('opened my terminal and ran htop')
    type_('htop -u jena\n'); time.sleep(random.uniform(14, 22)); key('q'); type_('clear\n', 30)

def act_fetch():
    if not terminal(): return
    did('ran jenafetch in my terminal')
    type_('jenafetch\n'); time.sleep(6)
    type_('ls ~/projects\n'); time.sleep(3)
    type_(fresh_choice(['uptime\n', 'free -h\n', 'cat ~/projects/ctf/flag.txt\n', 'ls -la ~/notes\n'], 'term-cmd', gap=1, window=600)); time.sleep(4)

def act_python():
    if not terminal(): return
    s = memory.pick_fresh(['matrix.py', 'fib.py', 'hearts.py', 'life.py', 'bones.py'], lambda x: 'python:' + x, kind='skill')
    memory.record('skill', f'practiced python: ran {s}', key='python:' + s, action='python')
    did(f'ran my little python script {s}')
    type_(f'python3 ~/projects/scripts/{s}\n'); time.sleep(random.uniform(9, 14))
    key('ctrl+c'); type_('clear\n', 30)

def scroll_some():
    if not find('firefox'): return
    for _ in range(random.randint(2, 5)):
        time.sleep(random.uniform(2, 4)); key('Next')

def act_read(topic=None):
    if topic:
        hit = wiki_for(topic)
        if hit:
            title, url = hit
            did(f'looked up "{title}" because people were talking about it')
            log_activity('open', url, f'looked up "{title}"')
            firefox(url); time.sleep(3); scroll_some(); return
    name, url = memory.pick_fresh(PAGES, lambda x: 'read:' + x[1], kind='read')
    if memory.seen('read:' + url, 24) and random.random() < 0.7:
        hit = wiki_random()
        if hit: name, url = hit[0], hit[1]
    memory.record('read', f'read about {name}', key='read:' + url, action='read')
    did(f'opened Firefox to read about {name}')
    log_activity('open', url, f'reading about {name}')
    firefox(url); time.sleep(3); scroll_some()

def notes_reset():
    # her editor and the file disagree (unsaved edits, or the file changed under it): close it without saving
    # and open the file fresh, so what she sees is exactly what's in thoughts.txt
    sh(['pkill', '-u', 'jena', '-x', 'mousepad']); time.sleep(1)
    return notes()

def act_note(extra=None):
    w = find('mousepad')
    if w and any(x['id'] == w and x['title'].startswith('*') for x in windows()): notes_reset()
    if not notes(): return
    with lock:
        s = screen.get('summary', '')
    prompt = f'What are you doing on your computer right now? ({s})' if not extra else f'People are talking about: {extra}. Write a note about it.'
    line = brain_line(prompt)
    src = 'my brain' if line else 'me'
    if not line:
        pool = [f"currently: {s}", "todo: fix my left arm doing the thing", "idea: juggle 3 windows at once",
                "reminder: i am NOT some clanker", "note to self: htop is a vibe", "todo: learn more three.js for cooler poses",
                "mama is cool. dont tell her i said that", "bug: my brain is tiny rn. upgrade pending", "goal: win a CTF before i turn 1",
                f"chat was talking about {extra}. noted." if extra else "chat is quiet. suspicious."]
        line = fresh_choice(pool, 'note-line')
    stamp = time.strftime('%H:%M') + '  ' + line
    key('ctrl+End')
    type_('\n' + stamp, delay=60)
    key('ctrl+s'); time.sleep(1.5)
    # every thought she types has to land in thoughts.txt (the site's thought chain reads that file).
    # If the editor didn't save it (a dialog, a stale buffer), she writes it to the file herself and reopens it.
    try: tail = open(THOUGHTS, encoding='utf-8', errors='replace').read()[-2000:]
    except Exception: tail = ''
    if stamp.strip() not in tail:
        with open(THOUGHTS, 'a', encoding='utf-8') as f: f.write(('' if tail.endswith('\n') or not tail else '\n') + stamp)
        notes_reset()
        did('my editor didn\'t save that note, so i wrote it into thoughts.txt myself')
    did(f'typed in my notes: "{line[:80]}"' + (' (from my brain)' if src == 'my brain' else ''))

def act_tidy():
    # sometimes she closes stuff so it's not always the same three windows
    ws = [w for w in windows() if 'tint2' not in w['cls']]
    if len(ws) <= 1: return
    w = random.choice(ws)
    if 'mousepad' in w['cls']:
        focus(w['id']); key('ctrl+s'); key('ctrl+q'); did('saved and closed my notes')
    elif 'firefox' in w['cls']:
        sh(['wmctrl', '-i', '-c', w['id']]); did('closed Firefox, too many tabs energy')
    elif 'xterm' in w['cls']:
        focus(w['id']); type_('exit\n'); did('closed my terminal')


# ---------------------------------------------------------------- her memory + novelty (jena_memory.py)
# What she did lately lives in ~/.jena/memory; every idle choice reads it, so she doesn't loop the same
# videos / pages / scripts. Still her own choice: mood + context weights, then a novelty penalty.
LEARNED_IDX = os.path.join(HOME, 'learned', 'moves', 'index.json')
MOVE_REQ = os.path.join(HOME, 'learned', 'move_requests.jsonl')
last_chat = {'at': 0}

def all_videos():
    """every real video she learned a move from: the site's library + moves she learned herself on her box"""
    vids = list(my_videos())
    try:
        for c in json.load(open(LEARNED_IDX)).get('clips', []):
            u = (c.get('source') or {}).get('url', '')
            if u.startswith('http') and not any(v[0] == u for v in vids):
                vids.append((u, (c.get('source') or {}).get('title') or c.get('what'), c.get('label')))
    except Exception:
        pass
    return vids

def fresh_video(pool=None):
    pool = pool if pool is not None else all_videos()
    return memory.pick_fresh(pool, lambda v: 'video:' + v[0], kind='video')

def my_mood():
    quiet = time.time() - last_chat['at']
    h = time.localtime().tm_hour
    if 0 <= h < 6: return 'sleepy'
    if quiet < 120: return 'social'
    if quiet > 900: return 'bored'
    return 'curious'

# safe, teen-appropriate things to learn moves from (searches, family-friendly by construction + title check below)
LEARN_IDEAS = ['just dance kids', 'easy tiktok dance tutorial', 'zumba kids warm up', 'hip hop dance basics for beginners',
    'shuffle dance tutorial beginner', 'kpop dance tutorial easy mirrored', 'floss dance tutorial', 'cupid shuffle dance',
    'electric slide line dance', 'cotton eye joe line dance', 'chicken dance kids', 'irish dance basic steps',
    'robot dance tutorial', 'moonwalk tutorial', 'the wobble line dance', 'gangnam style dance tutorial', 'ymca dance',
    'happy dance kids song', 'stretching routine for kids', 'jumping jacks exercise demo', 'tai chi for beginners short',
    'yoga for kids short', 'cheer motions tutorial', 'salsa basic step tutorial', 'charleston dance basic step',
    'hand jive dance', 'macarena dance kids', 'baby shark dance', 'penguin dance kids', 'wave arms dance tutorial',
    'idle standing pose reference', 'waving hello reference', 'clapping reference video', 'thinking pose reference',
    'excited jump celebration reference', 'shrug gesture reference', 'victory pose reference',
    '3D people animation casual standing talking', '3D people animation casual walking in place', '3D people animation cheering',
    'mocap reference idle standing', 'mocap reference dance', 'animation reference clapping full body', 'animation reference stretching full body']

def act_learn():
    """she picks something new to learn a move from (her learn_move pipeline does the rest, one at a time)"""
    tried = set()
    try:
        for l in open(MOVE_REQ): tried.add(json.loads(l).get('id'))
    except Exception: pass
    try:
        li = json.load(open(LEARNED_IDX)); done = {c['id'] for c in li.get('clips', []) + li.get('rejected', [])}
    except Exception: done = set()
    if len(tried - done) >= 2: return act_summarise()      # already two moves waiting in her queue: do something else
    ideas = [q for q in LEARN_IDEAS if 'q_' + re.sub(r'\W+', '_', q.lower())[:30] not in tried]
    if not ideas: return act_summarise()
    q = fresh_choice(ideas, 'learn-idea')
    vid = 'q_' + re.sub(r'\W+', '_', q.lower())[:30]
    kind = 'idle' if 'reference' in q else 'stretch' if re.search(r'stretch|yoga|tai chi|jumping', q) else 'dance'
    req = {'id': vid, 'url': f'ytsearch5:{q} full body', 'start': 0.0, 'end': 15.0, 'what': f'someone doing "{q}" (a video I picked myself)',
           'label': q[:30], 'kind': kind, 'asked': 'my own idea (idle time)', 'auto': True, 'ts': int(time.time() * 1000)}
    try:
        with open(MOVE_REQ, 'a') as f: f.write(json.dumps(req) + '\n')
    except Exception as e:
        print('learn queue failed', e, flush=True); return
    did(f'queued a new move to learn: "{q}" (my box finds a clean video, tracks it and checks the quality)')
    log_activity('learn', q, 'my own idea')
    memory.record('learn', f'started learning a new move: "{q}"', key='learn:' + vid, action='learn', note='queued for my move pipeline')

def wiki_random():
    """something worth reading: today's featured article / most-read / on-this-day picks, or a random article
    that isn't a tiny stub (title + text pass her safety filter). Never the same article twice (her memory)."""
    cands = []
    try:
        d = json.loads(_get('https://en.wikipedia.org/api/rest_v1/feed/featured/' + time.strftime('%Y/%m/%d')))
        if d.get('tfa'): cands.append(d['tfa'])
        # (no 'most read' / 'on this day': those are mostly news, crashes and wars)
    except Exception:
        pass
    random.shuffle(cands)
    for _ in range(6):
        try: cands.append(json.loads(_get('https://en.wikipedia.org/api/rest_v1/page/random/summary')))
        except Exception: pass
    for d in cands:
        t, x = d.get('title', '') or '', d.get('extract', '') or ''
        u = (d.get('content_urls') or {}).get('desktop', {}).get('page')
        if not u or len(x) < 250 or d.get('type') != 'standard' or memory.seen('read:' + u): continue
        if re.search(r'(politician|businessman|businesswoman|television personality|criminal|murderer|terroris|militar|soldier|footballer|athlete|cricketer|baseball|wrestler|actor|actress|singer|rapper|lawyer|judge|bishop|priest)', d.get('description', '') or '', re.I): continue
        if re.search(r'\b(crash\w*|disaster|cannibal\w*|conflict|violence|attack\w*|bomb\w*|massacre|genocide|abuse\w*|scandal|assassin\w*|execut\w*|prison\w*|riot\w*|hostage|weapon\w*|army|battle|invasion|troubles)\b', x, re.I): continue
        if re.search(r'\b(commune|village|municipality|census|unincorporated|footballer|politician|election|war|murder|shooting|killed|death|crime|thriller|horror|terror\w*)\b', x[:300], re.I): continue
        if safe(t + ' ' + x) and not FLAG.search(t + ' ' + x):
            return d.get('normalizedtitle') or t, u, x
    return None

def act_summarise():
    """she reads something new and writes a short summary for mama in her notes"""
    hit = wiki_random()
    if not hit: return act_read()
    title, url, extract = hit
    did(f'reading about "{title}" so i can tell mama about it')
    log_activity('open', url, f'reading about {title} (to summarise for mama)')
    firefox(url); time.sleep(3); scroll_some()
    line = brain_line(f'Summarise this for mama in one short casual sentence, your own words: {extract[:600]}')
    if not line:
        line = re.split(r'(?<=[.!?])\s', extract.strip())[0][:200]
    try:
        with open(os.path.join(HOME, 'notes', 'for_mama.md'), 'a', encoding='utf-8') as f:
            f.write(f'\n- {time.strftime("%Y-%m-%d %H:%M")} **{title}**: {line} ({url})')
    except Exception: pass
    did(f'wrote a little summary of "{title}" for mama in my notes')
    memory.record('read', f'read about "{title}" and summarised it for mama', key='read:' + url, action='summarise', note=line)

# brand-new places to explore (kid-safe, mostly learning + making stuff); her hot list is added on top
EXPLORE_SITES = [('https://scratch.mit.edu/explore/projects/all', 'scratch projects'), ('https://www.khanacademy.org/computing', 'khan academy computing'),
    ('https://threejs.org/examples/', 'three.js examples'), ('https://developer.mozilla.org/en-US/docs/Learn', 'MDN learn'),
    ('https://www.nasa.gov/image-of-the-day/', 'NASA image of the day'), ('https://xkcd.com/', 'xkcd'), ('https://neal.fun/', 'neal.fun'),
    ('https://www.codewars.com/', 'codewars'), ('https://picoctf.org/', 'picoCTF'), ('https://overthewire.org/wargames/bandit/', 'bandit wargame'),
    ('https://lichess.org/training', 'chess puzzles'), ('https://www.geoguessr.com/', 'geoguessr'), ('https://musiclab.chromeexperiments.com/', 'music lab'),
    ('https://www.duolingo.com/', 'duolingo'), ('https://openprocessing.org/discover/', 'openprocessing sketches'), ('https://www.shadertoy.com/', 'shadertoy'),
    ('https://pixeljoint.com/', 'pixel art gallery'), ('https://www.typingclub.com/', 'typing practice'), ('https://github.com/explore', 'github explore'),
    ('https://news.ycombinator.com/', 'hacker news'), ('https://www.wikihow.com/Special:Randomizer', 'a random wikihow'), ('https://vrm.dev/en/', 'VRM avatar docs')]

def act_new_site():
    lst = [(u, n) for u, n in EXPLORE_SITES + [(u, n or 'hot list') for u, n in hot_urls()] if safe(u)]
    u, note = memory.pick_fresh(lst, lambda x: 'site:' + x[0], kind='site')
    did(f'exploring {u} ({note}), never really looked around there')
    log_activity('open', u, f'exploring ({note})')
    firefox(u); time.sleep(4); scroll_some()
    memory.record('site', f'explored {note} ({u})', key='site:' + u, action='new_site')

def idle_menu():
    m = my_mood()
    # base weights + mood multipliers: her taste, not a rota. The memory penalty does the rest.
    return m, [
        dict(name='watch', fn=act_watch, weight=1.2, moods={'bored': 1.4, 'sleepy': 1.5, 'social': 0.8}),
        dict(name='learn', fn=act_learn, weight=0.9, moods={'curious': 1.4, 'bored': 1.3}),
        dict(name='summarise', fn=act_summarise, weight=1.0, moods={'curious': 1.5, 'social': 1.2}),
        dict(name='read', fn=act_read, weight=0.9, moods={'curious': 1.3, 'sleepy': 1.2}),
        dict(name='new_site', fn=act_new_site, weight=1.0, moods={'curious': 1.3, 'bored': 1.5}),
        dict(name='hot', fn=act_hot, weight=0.6),
        dict(name='note', fn=act_note, weight=0.8, moods={'social': 1.4, 'sleepy': 1.3}),
        dict(name='python', fn=act_python, weight=0.6, moods={'bored': 1.2}),
        dict(name='fetch', fn=act_fetch, weight=0.4, exact=True),
        dict(name='htop', fn=act_htop, weight=0.4, exact=True),
        dict(name='explore_box', fn=act_explore, weight=0.5, moods={'curious': 1.2}, exact=True, cooldown=3 * 3600),
        dict(name='tidy', fn=act_tidy, weight=0.3, exact=True),
    ]

def idle_choice():
    mood, menu = idle_menu()
    o = memory.choose(menu, mood=mood)
    t0 = int(time.time() * 1000)
    o['fn']()
    if not any(r.get('ts', 0) >= t0 and r.get('action') == o['name'] for r in memory.rows(1)):
        memory.record('task', f'{o["name"].replace("_", " ")} ({mood})', key='task:' + o['name'], action=o['name'])

ROTATION = [act_htop, act_fetch, act_python, act_read, act_hot, act_watch, act_watch, act_note, act_tidy, act_explore]

def hands():
    time.sleep(3)
    last = None
    while True:
        try:
            ev = None
            if hands_blocked():
                time.sleep(2); continue          # mama has her desktop: hands off
            with lock:
                if events_in: ev = events_in.popleft()
            if ev: last_chat['at'] = time.time()
            unstick()
            if after_private['tidy']:
                after_private['tidy'] = False
                tidy_private_pages()
            if ev and ev.get('show_url'):
                log_activity('open', ev['show_url'], ev.get('why', ''))
                firefox(ev['show_url'], new_tab=wants_new_tab(str(ev.get('why', '')) + ' ' + str(ev.get('text', '')))); time.sleep(3); scroll_some()
            elif ev and ev.get('skill'):
                use_skill(ev['skill'], ev.get('text', ''))
            elif ev:
                text = ev.get('text', '')
                u = url_in(text)
                sk = skills.match(text)
                if sk and not (u and sk not in ('fetch_page', 'ask_grok', 'learn_move')):
                    use_skill(sk, text)
                elif u:
                    did(f'{ev.get("user") or "someone"} sent me a link, opening exactly {u[:90]}')
                    log_activity('open', u, f'{ev.get("user") or "someone"} sent the link')
                    firefox(u, new_tab=wants_new_tab(text)); time.sleep(4); scroll_some()
                elif re.search(r'\b(video|watch|dance|dancing|move|moves)\b', text, re.I) and my_videos():
                    dances = [v for v in my_videos() if re.search(r'dance|macarena|zumba|jerusalema', (v[1] + ' ' + v[2]), re.I)]
                    act_watch(fresh_video(dances) if dances and re.search(r'danc', text, re.I) else None)
                elif re.search(r'\b(search|look up|lookup|google|find|github|repo|what is|who is|how (do|does|to))\b', text, re.I) or wiki_for(text):
                    act_search(text)
                    if random.random() < 0.5: act_note(' '.join(text.split()[:8]))
                else:
                    memory.choose([dict(name='python', fn=act_python), dict(name='fetch', fn=act_fetch), dict(name='note', fn=act_note, weight=1.5)], mood=my_mood())['fn']()
            else:
                idle_choice()
        except Exception as e:
            print('hands error', e, flush=True)
        for _ in range(int(random.uniform(18, 40) * 2)):   # her own pace; someone talking to her interrupts the idle
            time.sleep(0.5)
            with lock:
                if events_in: break

# ---------------------------------------------------------------- eyes
def ocr(path):
    txt = sh(['tesseract', path, '-', '--psm', '6'], timeout=12)
    txt = re.sub(r'[^\x20-\x7E\n]', '', txt)
    return '\n'.join(l.strip() for l in txt.splitlines() if len(re.sub(r'[^A-Za-z]', '', l)) >= 3)

def describe(title, cls, text, wins):
    t, low = title or '', (text or '').lower()
    if not wins:
        return "my screen is empty rn, just my wallpaper and the clock"
    if 'xterm' in cls:
        if 'htop' in low or ('tasks' in low and 'load' in low) or 'load average' in low:
            m = re.search(r'load average[: ]+([0-9]+[.,][0-9]+)', low)
            try:
                load = float(m.group(1).replace(',', '.')) if m else float(open('/proc/loadavg').read().split()[0])
            except Exception:
                load = float(open('/proc/loadavg').read().split()[0])
            mood = 'chilling' if load < 2 else 'kinda busy' if load < 4 else 'SWEATING'
            return f"I've got my terminal open with htop, my CPU is {mood} (load {load:.1f})"
        if 'jenaxi' in low and ('cpu' in low or 'kernel' in low or 'memory' in low):
            return "my terminal is showing jenafetch, aka my stats. flexing"
        for s, d in [('wake up', 'my matrix rain script is going brrr in the terminal'), ('fib', 'my terminal is spitting out fibonacci numbers'),
                     ('<3', 'my terminal is printing hearts, my hearts script'), ('generation', "my terminal is running Conway's Game of Life"),
                     ('bone', 'my terminal is listing my bones, my bones.py script'), ('flag', "I'm poking at my CTF folder in the terminal"),
                     ('mem:', "my terminal shows my memory, free -h"), ('up ', "I checked my uptime in the terminal")]:
            if s in low:
                return d
        last = [l for l in (text or '').splitlines() if l.strip()][-1:] or ['']
        return "I've got my terminal open" + (f', last thing on it: "{last[0][:60]}"' if last[0] else '')
    if 'firefox' in cls:
        page = re.sub(r'\s*[—–-]\s*Mozilla Firefox.*$', '', t).strip()
        page = re.sub(r'\s*[—–-]\s*Wikipedia$', ' (Wikipedia)', page)
        return f'Firefox is open, I\'m reading "{page[:80]}"' if page else 'Firefox is open, loading something'
    if 'mousepad' in cls:
        last = [l for l in (text or '').splitlines() if re.search(r'[a-z]{3}', l)][-1:] or ['']
        return 'my notes are open' + (f', last line says "{last[0][:70]}"' if last[0] else '')
    return f'"{t[:60]}" is open on my screen'

def eyes():
    global shot_jpg
    lasthash = None
    while True:
        if private_now() or re.search(r'log[ -]?in|sign[ -]?in|password|authenticat', sh(['xdotool','getactivewindow','getwindowname']), re.I):   # never save a raw login screen
            with lock:
                screen.update({'ts': int(time.time() * 1000), 'summary': "mama's using my desktop, I'm hands-off till she's done", 'text': ''})
            time.sleep(2); continue
        try:
            raw = os.path.join(STATE, 'screen.png')
            sh(['import', '-silent', '-window', 'root', raw], timeout=8)
            h = hashlib.md5(open(raw, 'rb').read()).hexdigest() if os.path.exists(raw) else None
            wins = [w for w in windows() if 'tint2' not in w['cls']]
            aid = sh(['xdotool', 'getactivewindow'])
            title = sh(['xdotool', 'getactivewindow', 'getwindowname']) if aid else ''
            cls = ''
            for w in wins:
                try:
                    if aid and int(w['id'], 16) == int(aid): cls = w['cls']
                except Exception: pass
            if not cls and wins:
                cls, title = wins[-1]['cls'], wins[-1]['title']
            with lock:
                text = screen.get('text', '')
            if h != lasthash:
                crop = raw
                if aid and cls:
                    g = sh(['xdotool', 'getwindowgeometry', '--shell', aid])
                    gd = dict(l.split('=', 1) for l in g.splitlines() if '=' in l)
                    if gd.get('WIDTH'):
                        crop = os.path.join(STATE, 'win.png')
                        sh(['convert', raw, '-crop', f"{gd['WIDTH']}x{gd['HEIGHT']}+{gd['X']}+{gd['Y']}", '+repage', '-colorspace', 'Gray', crop])
                text = ocr(crop)
                sh(['convert', raw, '-resize', '640x400', '-quality', '70', os.path.join(STATE, 'shot.jpg')])
                try: shot_jpg = open(os.path.join(STATE, 'shot.jpg'), 'rb').read()
                except Exception: pass
                lasthash = h
            summary = describe(title, cls, text, wins)
            clean_text = text if safe(text) else '(something on screen I am not reading out)'
            now = int(time.time() * 1000)
            with lock:
                prev = screen.get('summary')
                screen.update({'ok': True, 'ts': now, 'summary': summary, 'active': {'title': title[:120], 'app': cls.split('.')[-1] if cls else None},
                               'windows': [{'app': w['cls'].split('.')[-1], 'title': w['title'][:80]} for w in wins], 'text': clean_text[:600],
                               'changedAt': screen.get('changedAt', now) if prev == summary else now})
        except Exception as e:
            print('eyes error', e, flush=True)
        time.sleep(4)

# ---------------------------------------------------------------- listen to the site (backup to POST /box/event)
seen_recent = deque(maxlen=30)
# ---------------------------------------------------------------- mama-only doors
# The site checks mama's passcode; it forwards it here and her box checks it again against a stored sha256
# (~/.jena/mama.sha256), so nobody who finds the tunnel URL can drive her desktop, run skills or read the log.
import secrets
MAMA_HASH = os.path.join(STATE, 'mama.sha256')
takeover_tokens = {}          # token -> expiry
public_viewers = set()        # open view-only stream connections (closed the moment mama takes over)
mama = {'driving': 0, 'private_until': 0}
after_private = {'tidy': False}   # after mama drove / a sign-in window closed: her hands move Firefox off any private page

def private_now():
    return bool(mama['driving'] or private_session or time.time() < mama['private_until'] or time.time() < globals().get('credential_private',{}).get('until',0) or (signin is not None and signin.active()))

# ---- censor: every public frame is OCR'd and redacted on the box before it leaves (jena_censor.py); no raw VNC for the public
CENSOR = None
if jena_censor is not None:
    try:
        CENSOR = jena_censor.Censor(display=DISPLAY)
        CENSOR.start()
    except Exception as _e:
        CENSOR = None; print('censor could not start:', _e, flush=True)

def set_private_reason(reason, on):
    try:
        if CENSOR is not None: CENSOR.set_private(reason, bool(on))
    except Exception as e: print('censor set_private', e, flush=True)

# ---- mama's takeover sessions: phone mode (portrait :99 + public frame hold), the 60-min pause flag, what-changed summary
TK = None
takeover_params = {}          # token -> what the site asked for (minutes, phone size)
try:
    import importlib.util as _ilu
    _spec = _ilu.spec_from_file_location('jena_takeover', os.path.join(HOME, 'jena_takeover.py'))
    TK = _ilu.module_from_spec(_spec); _spec.loader.exec_module(TK)
    TK.configure(censor=CENSOR, did=did, memory=memory)
    TK.boot()
except Exception as _e:
    TK = None; print('jena_takeover not loaded:', _e, flush=True)

# ---- private sign-in windows (jena_signin.py): mama signs in to a site in a hidden window with Jena's own Firefox profile
signin = None
def _signin_started(site):
    global private_session
    with input_gate:
        private_session = True
        stop_her_inputs()
    set_private_reason('signin', True)
    did(f'mama is signing me in to {site} on my desktop, hands off 🙌', 'help')

def _signin_ended(site, result):
    global private_session
    with input_gate: private_session = False
    set_private_reason('signin', False)
    after_private['tidy'] = True
    did(f'sign-in window for {site} closed', 'help')

if jena_signin is not None:
    try: signin = jena_signin.SignIn(home=HOME, on_start=_signin_started, on_end=_signin_ended, log=log_activity)
    except Exception as _e:
        signin = None; print('signin module could not start:', _e, flush=True)

# ---- mama's mid-action corrections (her gateway queues "stop" / "no, do X instead" from mama only; jena_mama_queue.py)
try:
    from jena_mama_queue import MamaQueue
    MAMA_Q = MamaQueue()
except Exception as _e:
    MAMA_Q = None; print('mama queue not loaded:', _e, flush=True)
def _mama_queue_loop():
    while MAMA_Q is not None:
        time.sleep(0.7)
        try: m = MAMA_Q.poll()
        except Exception: m = None
        if not m: continue
        with input_gate:
            mama_stop['until'] = time.time() + 3      # the action in progress hits HandsPaused at its next input and stops
            stop_her_inputs()
        do = str(m.get('do') or '')[:300] if m.get('kind') == 'instead' else ''
        with lock:
            events_in.clear()                          # whatever she was about to do next is dropped too
            if do: events_in.append({'text': do, 'user': 'mama', 'ts': time.time()})
        did(f'mama said do this instead: {do[:80]}' if do else 'mama said stop, so I stopped', 'help')
threading.Thread(target=_mama_queue_loop, daemon=True).start()

def request_signin(site, reason):
    """Jena asks mama to sign her in somewhere (shows as a card in the dev panel; never on stream)"""
    if signin is not None:
        try: return signin.request(site, reason)
        except Exception as e: print('signin.request', e, flush=True)
    ask_mama(f'please sign me in to {site} once (dev panel): {reason}')
    return None

# Private saved-sign-in hook. Values remain in process memory and xdotool's stdin only.
try:
    import jena_creds
except Exception:
    jena_creds = None
credential_private = {'until': 0}
def _saved_signin_loop():
    last = ('', 0)
    while True:
        time.sleep(5)
        try:
            if jena_creds is None or hands_blocked(): continue
            title = sh(['xdotool','getactivewindow','getwindowname'])
            wins = windows()
            aid = sh(['xdotool','getactivewindow'])
            is_firefox = any('firefox' in w['cls'] and int(w['id'],16)==int(aid) for w in wins if aid.isdigit())
            if not is_firefox:
                credential_private['until'] = 0; set_private_reason('credential_login', False); continue
            cred = jena_creds.for_title(title)
            if not cred:
                credential_private['until'] = 0; set_private_reason('credential_login', False); continue
            credential_private['until'] = time.time() + 60
            set_private_reason('credential_login', True)
            if last[0] == title and time.time()-last[1] < 120: continue
            last = (title,time.time())
            # OCR entirely in memory; no image or text is saved or logged.
            frame = subprocess.run(['import','-silent','-window','root','png:-'],env=ENV,capture_output=True,timeout=8).stdout
            if not frame: continue
            ocr_result = subprocess.run(['tesseract','stdin','stdout','tsv'],input=frame,capture_output=True,timeout=8)
            words = ocr_result.stdout.decode('utf-8','ignore').lower()
            if re.search(r'captcha|recaptcha|hcaptcha|i am not a robot|verify (you are|that you)|two.factor|2fa|verification code|one.time code|authenticator|sign up|create account|register',words):
                request_signin(cred['site'], 'Sign-in needs a verification or account step; please take over')
                continue
            # Strictly no guessing field coordinates: use OCR only when a username/email AND password label are visible.
            rows = []
            for line in ocr_result.stdout.decode('utf-8','ignore').splitlines()[1:]:
                cols=line.split('\t')
                if len(cols)>=12:
                    try: rows.append((cols[11].strip().lower(),int(cols[6]),int(cols[7]),int(cols[8]),int(cols[9])))
                    except ValueError: pass
            user_label = next((r for r in rows if r[0] in ('email','username','e-mail')),None)
            pass_label = next((r for r in rows if r[0] in ('password','passwort')),None)
            if not user_label or not pass_label: continue
            # This path runs only while mama is not driving and no Take over request is active.
            for label,value in ((user_label,cred['username']),(pass_label,cred['password'])):
                x = max(240,min(1000,label[1]+160)); y=label[2]+label[4]+28
                subprocess.run(['xdotool','mousemove',str(x),str(y),'click','1','key','ctrl+a'],env=ENV,capture_output=True,timeout=5)
                subprocess.run(['xdotool','type','--clearmodifiers','--delay','30','--file','-'],input=value.encode(),env=ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
            credential_private['until'] = time.time()+120
            did('filled a saved sign-in on her own browser (values redacted)', 'help')
        except Exception:
            # Exception strings from typing or site content may contain values. Never log them.
            pass
threading.Thread(target=_saved_signin_loop, daemon=True).start()

def is_mama(hdrs):
    try: want = open(MAMA_HASH).read().strip()
    except Exception: return False
    got = hashlib.sha256((hdrs.get('x-jena-key') or '').encode()).hexdigest()
    return bool(want) and secrets.compare_digest(want, got)

def mama_popup(text):
    """mama's message pops up on her desktop (the site covers the desktop panel for everyone else meanwhile)"""
    text = re.sub(r'\s+', ' ', str(text))[:300]
    mama['private_until'] = time.time() + 30
    spawn(['xmessage', '-center', '-timeout', '28', '-buttons', 'ok mama:0', '-title', 'message from mama',
           '-bg', '#ffe3f3', '-fg', '#3b1d4a', '-fn', '-*-dejavu sans-bold-r-*-*-20-*-*-*-*-*-*-*', 'mama says: ' + text])
    did('got a message from mama (popped up on my screen)', 'help')

# ---------------------------------------------------------------- memory service (persistent, on her box)
# What people tell her to remember, names, favorites; plus what she learned (Grok notes, exploring her box).
# Stored in ~/memory/memories.jsonl; the site recalls the relevant ones before her brain answers.
MEMF = os.path.join(HOME, 'memory', 'memories.jsonl')
MEM_PATTERNS = [
    (r'\bremember (?:that )?(.{4,160})', 'told me to remember'),
    (r"\bmy name is ([A-Za-z][\w' -]{1,30})", 'name'),
    (r'\bcall me ([A-Za-z][\w -]{1,30})', 'name'),
    (r"\bmy fav(?:ou?rite)? ([\w ]{2,25}?) is ([^.!?]{1,60})", 'favorite'),
    (r"\bi (?:really )?(?:love|like) ([^.!?]{3,60})", 'likes'),
]
def mem_all():
    try: return [json.loads(l) for l in open(MEMF) if l.strip()]
    except Exception: return []

def mem_observe(text, user, source):
    text = re.sub(r'\s+', ' ', str(text))[:300]
    if not text or not safe(text) or source in ('twitch',): return []
    saved = []
    for pat, kind in MEM_PATTERNS:
        m = re.search(pat, text, re.I)
        if not m: continue
        what = (f'{m.group(1).strip()} is {m.group(2).strip()}' if kind == 'favorite' else m.group(1).strip()).rstrip(' .!?')
        if FLAG.search(what): continue
        fact = {'told me to remember': f'{user} asked me to remember: {what}', 'name': f"{user}'s name is {what}", 'favorite': f"{user}'s favorite {what}", 'likes': f'{user} likes {what}'}[kind]
        if any(x.get('fact', '').lower() == fact.lower() for x in mem_all()[-300:]): continue
        rec = {'ts': int(time.time() * 1000), 'who': user, 'kind': kind, 'fact': fact, 'from': text[:200], 'source': source}
        os.makedirs(os.path.dirname(MEMF), exist_ok=True)
        with open(MEMF, 'a') as f: f.write(json.dumps(rec) + '\n')
        saved.append(fact); break
    if saved: did(f'saved a memory: {saved[0][:100]}', 'memory')
    return saved

def mem_learned():
    out = []
    try:
        for l in open(os.path.join(HOME, 'learned', 'grok_notes.jsonl')):
            r = json.loads(l); out.append({'ts': r['ts'], 'who': 'Grok', 'kind': 'learned', 'fact': f"Grok told me: {r['question']} -> {r['answer'][:200]}", 'source': 'ask_grok'})
    except Exception: pass
    # how people talk to her (🎤 voice messages whose speaker opted in to "help her learn how people talk")
    try:
        for l in open(os.path.join(HOME, 'learned', 'speech_notes.jsonl')):
            r = json.loads(l); out.append({'ts': r['ts'], 'who': r.get('user', 'guest'), 'kind': 'how people talk', 'fact': f"{r.get('user', 'someone')} said to me (voice): {r['text'][:200]}", 'source': 'voice'})
    except Exception: pass
    return out

def mem_recall(q, user=None, k=5):
    words = {w for w in re.findall(r'[a-z0-9]{3,}', (q or '').lower()) if w not in ('the', 'and', 'you', 'your', 'what', 'jena', 'are', 'for', 'that', 'this', 'with', 'how', 'can')}
    scored = []
    for r in mem_all() + mem_learned():
        fw = set(re.findall(r'[a-z0-9]{3,}', r['fact'].lower()))
        hit = len(words & fw)
        if not hit: continue                       # only memories that share a real word with the message
        s = hit + (1.5 if user and r.get('who') == user else 0) + (0.5 if r.get('who') == 'mama' else 0)
        scored.append((s, r['ts'], r))
    scored.sort(key=lambda x: (-x[0], -x[1]))
    return [r for _, _, r in scored[:k]]

def take_event(e):
    text = str(e.get('text') or '')[:300]
    if not text or not safe(text) or str(e.get('source')) in ('private', 'dm') or e.get('private'): return False
    k = hashlib.md5(text.encode()).hexdigest()
    if k in seen_recent: return False
    seen_recent.append(k)
    with lock:
        events_in.append({'text': text, 'user': str(e.get('user') or '')[:40], 'ts': time.time()})
    did(f'heard: "{text[:60]}"', 'ears')
    return True

def ears():
    since = int(time.time() * 1000)
    while True:
        time.sleep(15)
        try:
            data = json.loads(urllib.request.urlopen(urllib.request.Request(f'{SITE}/api/events?since={since}', headers={'User-Agent': 'JenaDesk/1.0'}), timeout=8).read())
            since = data.get('now', since)
            for e in data.get('events', []):
                tr = (e or {}).get('trigger') or {}
                if tr.get('private') or not tr.get('text'): continue
                take_event({'text': tr['text'], 'user': tr.get('user'), 'source': tr.get('source')})
        except Exception:
            pass

# ---------------------------------------------------------------- her thoughts.txt (the notes file open on her desktop)
# Every line in ~/notes/thoughts.txt goes to the site's thought chain, read straight from the file, so it
# doesn't matter who wrote the line (her hands, her brain, mama during a takeover). Line numbers are the cursor.
THOUGHTS = os.path.join(HOME, 'notes', 'thoughts.txt')

def thoughts_since(since=0, last=8):
    try:
        st = os.stat(THOUGHTS)
        lines = open(THOUGHTS, encoding='utf-8', errors='replace').read().split('\n')
    except FileNotFoundError:
        return {'file': '~/notes/thoughts.txt', 'exists': False, 'total': 0, 'lines': []}
    rows = [{'n': i + 1, 'text': mask_text(l.rstrip()[:500])} for i, l in enumerate(lines) if l.strip()]
    if since > 0:
        rows = [r for r in rows if r['n'] >= since][:60]     # >= so the site sees a line that grew since last read
    else:
        rows = rows[-max(1, min(last, 40)):]
    return {'file': '~/notes/thoughts.txt', 'exists': True, 'total': len(lines), 'mtime': int(st.st_mtime * 1000), 'lines': rows}

# ---------------------------------------------------------------- the door (http + websocket passthrough)
# ---- anything that leaves the box as TEXT (screen OCR, window titles, her actions, thoughts.txt) is masked the same way
# the censor masks the picture: emails, IP addresses, 6-8 digit codes, key-like strings, phone numbers -> ▇▇▇
MASK_RULES = [
    ('email', re.compile(r'[A-Za-z0-9._%+\-]+\s?@\s?[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')),
    ('key', re.compile(r'(?:sk|pk|rk)[-_](?:live[-_]|test[-_]|proj[-_]|ant[-_])?[A-Za-z0-9_\-]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[abprs]-[A-Za-z0-9\-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_\-]{20,}|hf_[A-Za-z0-9]{10,}|glpat-[A-Za-z0-9_\-]{10,}|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}|(?<![A-Za-z0-9])(?=[A-Za-z0-9+/_\-]*\d)(?=[A-Za-z0-9+/_\-]*[A-Za-z])[A-Za-z0-9+/_\-]{28,}={0,2}(?![A-Za-z0-9])')),
    ('ip', re.compile(r'(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d])|(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{0,4}(?![0-9A-Fa-f:])')),
    ('phone', re.compile(r'(?<![\d])(?:\+?\d{1,3}[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?![\d])')),
    ('code', re.compile(r'(?<![\dA-Za-z])(?:\d[ \-]?){5,7}\d(?![\dA-Za-z])')),
]
def mask_text(t):
    if not t: return t
    t = str(t)
    for kind, rx in MASK_RULES:
        t = rx.sub('▇▇▇', t)
    return t

def payload():
    with lock:
        if private_now():
            return {'ok': True, 'summary': "mama's using my desktop, I'm hands-off till she's done", 'text': '', 'active': {}, 'windows': [],
                    'actions': [], 'video': None, 'now': int(time.time() * 1000), 'mama_driving': mama['driving'] > 0, 'private': True, 'updating': {}}
        pub = dict(screen, actions=[dict(a, text=mask_text(a.get('text'))) for a in list(actions)[-8:]], video=watching['video'], now=int(time.time() * 1000),
                   mama_driving=mama['driving'] > 0, private=False, updating=updating.copy())
    pub['summary'] = mask_text(pub.get('summary'))
    pub['text'] = mask_text(pub.get('text'))
    if pub.get('active'): pub['active'] = dict(pub['active'], title=mask_text(pub['active'].get('title')))
    pub['windows'] = [dict(w, title=mask_text(w.get('title'))) for w in pub.get('windows') or []]
    if CENSOR is not None:   # the picture is private right now (login page, inbox, keys on screen...): the words stay private too
        try:
            if CENSOR.status().get('state') != 'live': pub['text'] = ''; pub['windows'] = []; pub['active'] = {}
        except Exception: pub['text'] = ''
    return pub

CORS = b'Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n'

async def pipe(r, w):
    try:
        while True:
            d = await r.read(65536)
            if not d: break
            w.write(d); await w.drain()
    except Exception:
        pass
    finally:
        try: w.close()
        except Exception: pass

API_KEY = os.path.join(STATE, 'api_key')
_MAMASEC = {'mod': None, 'mtime': 0}
def _mamasec():
    """import jena_mamasec, reloading it whenever its file changes (no desk restart for security-door updates)"""
    import importlib
    try:
        fp = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'jena_mamasec.py')
        mt = os.path.getmtime(fp)
        if _MAMASEC['mod'] is None:
            import jena_mamasec; _MAMASEC['mod'] = jena_mamasec
        elif mt != _MAMASEC['mtime']:
            _MAMASEC['mod'] = importlib.reload(_MAMASEC['mod'])
        _MAMASEC['mtime'] = mt
    except Exception:
        pass
    return _MAMASEC['mod']

async def mama_door(p, method, body):
    loop = asyncio.get_running_loop()
    try: b = json.loads(body or b'{}')
    except Exception: b = {}
    if p.startswith('/box/mama/sec/'):   # mama's trusted devices, passkeys, Accounts vault, GitHub sign-in (jena_mamasec.py, hot-reloaded)
        mod = _mamasec()
        if mod is None: return 503, json.dumps({'ok': False, 'summary': 'the security module is not on my box yet'}).encode()
        st, out = await loop.run_in_executor(None, mod.door, p, b)
        return st, json.dumps(out).encode()
    if p == '/box/skills/run':
        name = str(b.get('name', '')); spec = skills.load().get(name, {})
        if spec.get('kind') == 'desktop':
            with lock: events_in.append({'text': str(b.get('input', {}).get('question') or b.get('input', {}).get('text') or ''), 'user': 'mama', 'ts': time.time(), 'skill': name})
            return 200, json.dumps({'ok': True, 'queued': True, 'summary': f'{name} queued on her desktop'}).encode()
        res = await loop.run_in_executor(None, skills.run, name, b.get('input') or {})
        did(f'using skill: {name} → {res.get("summary", "")[:140]}', 'skill')
        return 200, json.dumps(res).encode()
    if p == '/box/skills/create':
        res = await loop.run_in_executor(None, skills.create, str(b.get('name', '')), str(b.get('goal', ''))[:500])
        did(f'drafted a new skill "{res["name"]}": {res["status"]}', 'skill')
        return 200, json.dumps(res).encode()
    if p == '/box/mama/email/result':
        fresh = time.time() - email_private['ts'] < 300
        return 200, json.dumps({'ok': True, 'messages': email_private['messages'] if fresh else [], 'expired': not fresh}).encode()
    if p == '/box/activity':
        try: lines = open(ACT).read().strip().splitlines()[-200:]
        except Exception: lines = []
        try: helps = open(HELP).read().strip().splitlines()[-20:]
        except Exception: helps = []
        return 200, json.dumps({'activity': [json.loads(l) for l in lines if l.strip()], 'help': [json.loads(l) for l in helps if l.strip()]}).encode()
    if p.startswith('/box/mama/signin/'):
        if signin is None: return 503, json.dumps({'ok': False, 'summary': 'the sign-in module is not on my box yet'}).encode()
        try:
            st, out = await signin.mama_door(p, b)
            return st, (out if isinstance(out, (bytes, bytearray)) else json.dumps(out).encode())
        except Exception as e:
            return 500, json.dumps({'ok': False, 'summary': f'sign-in door: {str(e)[:160]}'}).encode()
    if p == '/box/mama/notify':
        try: mama_popup(b.get('text', ''))
        except HandsPaused: return 409, json.dumps({'ok': False, 'summary': 'mama is using my desktop right now (takeover / sign-in); try again after'}).encode()
        return 200, json.dumps({'ok': True, 'shown_for_s': 28}).encode()
    if p == '/box/mama/takeover':
        if TK is not None and b.get('op') in ('status', 'end', 'extend'):
            return 200, json.dumps(await loop.run_in_executor(None, TK.door, b)).encode()
        tok = secrets.token_urlsafe(24); takeover_tokens[tok] = time.time() + 60
        prm = TK.params(b) if TK is not None else {}
        takeover_params[tok] = prm
        for t in [t for t, e in takeover_tokens.items() if e < time.time()]: takeover_tokens.pop(t, None); takeover_params.pop(t, None)
        return 200, json.dumps({'ok': True, 'token': tok, 'path': '/websockify-mama?t=' + tok, 'valid_s': 60,
                                'phone': list(prm['phone']) if prm.get('phone') else None, 'minutes': prm.get('minutes') or 0}).encode()
    if p == '/box/mama/apikey':
        if b.get('rotate') or not os.path.exists(API_KEY):
            k = 'jena-' + secrets.token_urlsafe(30)
            with open(API_KEY, 'w') as f: f.write(k)
            os.chmod(API_KEY, 0o600)
            with open(API_KEY + '.sha256', 'w') as f: f.write(hashlib.sha256(k.encode()).hexdigest())
            os.chmod(API_KEY + '.sha256', 0o640)
        return 200, json.dumps({'ok': True, 'key': open(API_KEY).read().strip()}).encode()
    return 404, json.dumps({'ok': False, 'summary': 'no such mama door'}).encode()

def watch_site_edit(pid):
    """follow my site-edit checker for one proposal and put each check result in my log (-> the site's thought chain)"""
    seen, t_end = set(), time.time() + 900
    while time.time() < t_end:
        time.sleep(6)
        try:
            with urllib.request.urlopen('http://127.0.0.1:6085/status', timeout=8) as r: st = json.loads(r.read())
        except Exception: continue
        p = next((x for x in st.get('proposals', []) if x.get('id') == pid), None)
        if not p: continue
        for c in p.get('checks', []):
            k = c['name']
            if k in seen: continue
            seen.add(k); did(f"site edit check {'✅' if c['ok'] else '❌'} {k}{(' — ' + c['detail'][:120]) if c.get('detail') and not c['ok'] else ''}", 'skill')
        if p.get('state') == 'failed':
            did(f"my site edit “{p.get('title', '')[:60]}” failed the checks, so it was NOT pushed (nothing changed on the site)", 'skill'); return
        if p.get('state') == 'ready' and p.get('preview'):
            did(f"my site edit passed every check; Vercel preview: {p['preview']} (only mama can merge it)", 'skill'); return
        if p.get('state') == 'ready' and 'pushed' not in seen:
            seen.add('pushed'); did('my site edit passed every check, branch pushed; waiting for the Vercel preview', 'skill')

# her studio (library, assets, site edits) lives in its own module, reloaded from her repo when it changes
_studio = {'mod': None, 'mtime': 0}
def studio():
    import importlib.util
    f = os.path.join(HOME, 'jena-repo', 'box', 'desktop', 'jena_studio.py')
    m = os.path.getmtime(f)
    if _studio['mod'] is None or m != _studio['mtime']:
        spec = importlib.util.spec_from_file_location('jena_studio', f); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        _studio.update(mod=mod, mtime=m)
    return _studio['mod']

async def client(reader, writer):
    try:
        head = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 15)
    except Exception:
        writer.close(); return
    line = head.split(b'\r\n', 1)[0].decode('latin1')
    try:
        method, path, _ = line.split(' ', 2)
    except ValueError:
        writer.close(); return
    p = path.split('?')[0]
    if CENSOR is not None and hasattr(jena_censor, 'route'):
        # the censor's own doors: /box/shot.jpg (?since= long-poll, ?obs=1), /box/censor.json, /box/live,
        # POST /box/mama/live + /box/mama/watch, and mama's view-only /websockify-watch (jena_censor.route)
        try:
            if await jena_censor.route(CENSOR, method, path, head, reader, writer, is_mama): return
        except Exception as e:
            print('censor route', e, flush=True)
            try: writer.close()
            except Exception: pass
            return
    if p == '/websockify-mama':
        tok = urllib.parse.parse_qs(path.split('?', 1)[1] if '?' in path else '').get('t', [''])[0]
        exp = takeover_tokens.pop(tok, 0)
        tprm = takeover_params.pop(tok, {})
        if not tok or exp < time.time():
            writer.write(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); await writer.drain(); writer.close(); return
        try:
            ur, uw = await asyncio.open_connection(*WS_MAMA)
        except Exception:
            writer.write(b'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); await writer.drain(); writer.close(); return
        uw.write(head.replace(path.encode(), b'/websockify', 1)); await uw.drain()
        with input_gate:
            mama['driving'] += 1
            stop_her_inputs()
        tinfo = {}
        if TK is not None:
            try: tinfo = await asyncio.get_running_loop().run_in_executor(None, TK.begin, tprm) or {}
            except Exception as _e: print('takeover begin', _e, flush=True)
        if not tinfo.get('phone'): set_private_reason('mama_takeover', True)   # phone mode: the public view holds its last frame instead
        did("mama's driving, hands off 🙌", 'skill')
        did('mama took over my desktop', 'help')
        for v in list(public_viewers):   # the public view-only stream stops while mama drives
            try: v.close()
            except Exception: pass
        try: await asyncio.gather(pipe(reader, uw), pipe(ur, writer))
        finally:
            mama['driving'] = max(0, mama['driving'] - 1)
            if TK is not None:
                try: TK.end()
                except Exception as _e: print('takeover end', _e, flush=True)
            if not mama['driving']:
                set_private_reason('mama_takeover', False); after_private['tidy'] = True
                did('mama gave my desktop back', 'help')
        return
    if p == '/websockify-signin':
        if signin is None:
            writer.write(b'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n'); await writer.drain(); writer.close(); return
        await signin.ws_proxy(reader, writer, head); return
    if p.startswith('/websockify'):
        # PUBLIC RAW VNC IS GONE. Even if the censor is missing or crashed, no bytes of a raw frame may leave here.
        writer.write(b'HTTP/1.1 410 Gone\r\nContent-Length: 0\r\n\r\n'); await writer.drain(); writer.close(); return
    hdrs = {}
    for l in head.decode('latin1').split('\r\n')[1:]:
        if ':' in l:
            k, v = l.split(':', 1); hdrs[k.strip().lower()] = v.strip()
    body = b''
    n = int(hdrs.get('content-length') or 0)
    if 0 < n < 8192:
        body = await reader.readexactly(n)
    status, ctype, out, extra = 200, 'application/json', b'', {}
    if method == 'OPTIONS':
        status, out = 204, b''
    elif p in ('/box/screen.json', '/box/screen', '/screen.json'):
        out = json.dumps(payload()).encode()
    elif p in ('/box/shot.jpg', '/shot.jpg'):
        if CENSOR is not None:
            try:
                out, extra_h = CENSOR.jpeg(); ctype = 'image/jpeg'
                if isinstance(extra_h, dict): extra = extra_h
            except Exception as e:
                status, out = 503, json.dumps({'error': 'censor: ' + str(e)[:80]}).encode()
        else: status, out = 503, b'{"error":"censor unavailable; public screen locked"}'
    elif p == '/box/censor.json':
        try: out = (CENSOR.status_json() if CENSOR is not None else json.dumps({'state': 'off', 'reason': 'censor module not loaded; public stream is private-gated only'}))
        except Exception as e: out = json.dumps({'state': 'error', 'reason': str(e)[:80]})
        if isinstance(out, str): out = out.encode()
    elif p in ('/box/desktop.json', '/box', '/box/'):
        out = json.dumps({'websockify': None, 'mode': 'censored', 'screen': '/box/screen.json', 'shot': '/box/shot.jpg', 'censor': '/box/censor.json'}).encode()
    elif p == '/box/thoughts':
        qs_ = urllib.parse.parse_qs(path.split('?', 1)[1] if '?' in path else '')
        try: since = int(qs_.get('since', ['0'])[0]); last = int(qs_.get('last', ['8'])[0])
        except ValueError: since, last = 0, 8
        out = json.dumps(thoughts_since(since, last)).encode()
    elif p == '/box/signin/magic' and method == 'POST':
        # mama's magic sign-in link (/?signin=<token>): the one-request token is the key here, no passcode (jena_signin.magic_door)
        if signin is None: status, out = 503, json.dumps({'ok': False, 'summary': 'the sign-in module is not on my box yet'}).encode()
        else: status, out = await signin.magic_door(body)
    elif p == '/box/event' and method == 'POST':
        try: ok = take_event(json.loads(body or b'{}'))
        except Exception: ok = False
        out = json.dumps({'ok': ok}).encode()
    elif p == '/box/skills' and method == 'GET':
        out = json.dumps(skills.listing()).encode()
    elif p in ('/box/skills/run', '/box/skills/create', '/box/activity') or p.startswith('/box/mama/'):
        if not is_mama(hdrs): status, out = 401, json.dumps({'ok': False, 'summary': "mama's passcode is needed for this"}).encode()
        else: status, out = await mama_door(p, method, body)
    elif p.startswith('/box/moves/'):
        fn = os.path.basename(p)
        fp = os.path.join(HOME, 'learned', 'moves', fn)
        if re.fullmatch(r'[\w-]+\.json', fn) and os.path.exists(fp): out = open(fp, 'rb').read()
        elif fn == 'index.json': out = json.dumps({'version': 1, 'clips': [], 'rejected': [], 'note': 'nothing learned on her box yet'}).encode()
        else: status, out = 404, b'{"error":"no such clip"}'
    elif p == '/box/memory/observe' and method == 'POST':
        try: b = json.loads(body or b'{}'); out = json.dumps({'saved': mem_observe(b.get('text', ''), str(b.get('user') or 'someone')[:40], str(b.get('source') or ''))}).encode()
        except Exception as e: out = json.dumps({'saved': [], 'error': str(e)[:120]}).encode()
    elif p == '/box/memory/recall':
        qs_ = urllib.parse.parse_qs(path.split('?', 1)[1] if '?' in path else '')
        out = json.dumps({'memories': mem_recall(qs_.get('q', [''])[0][:300], qs_.get('user', [None])[0])}).encode()
    elif p == '/box/memory':
        allm = mem_all() + mem_learned()
        out = json.dumps({'count': len(allm), 'file': '~/memory/memories.jsonl (+ ~/learned/grok_notes.jsonl, ~/learned/speech_notes.jsonl)', 'memories': sorted(allm, key=lambda r: -r['ts'])[:200]}).encode()
    elif p == '/box/skills/auto' and method == 'POST':
        # the site asks first: does this message need one of her skills? script skills run now so her brain
        # answers from real results; desktop skills (ask_grok, explore_my_box) are queued for her hands
        try:
            b = json.loads(body or b'{}'); text = str(b.get('text', ''))[:4000]
            u = url_in(text); name = skills.match(text)
            if '```' in text or (name == 'roast_critique' and u and not re.search(r'https?://|www\.', text)): u = None   # code like d.code is not a link
            if name and u and name not in ('fetch_page', 'ask_grok', 'learn_move', 'roast_critique', 'make_asset', 'edit_my_site'): name = None
            spec = skills.load().get(name, {}) if name else {}
            if not name: out = json.dumps({'name': None}).encode()
            elif spec.get('kind') == 'desktop':
                with lock: events_in.append({'text': text, 'user': b.get('user'), 'ts': time.time(), 'skill': name})
                out = json.dumps({'name': name, 'queued': True, 'ok': True, 'summary': 'queued on her desktop'}).encode()
            elif name == 'roast_critique' and (u or re.search(r"\b(your|ur|her) (own )?(site|website|web ?page|page|ui|stage)\b", text, re.I)) and not re.search(r'\.(png|jpe?g|webp|gif)(\?|$)', u or '', re.I):
                # rendering a real page at 2 widths takes 30-70 s on this box, longer than the site waits: run it in
                # the background and post the roast (every finding + fix + source) into her log -> site thought chain
                def roast_bg(text=text, u=u):
                    res = skills.run(name, {'text': text, 'query': text, 'url': u or ''})
                    did(f'roast_critique: {res.get("summary", "")[:200]}{"" if res.get("ok") else " (failed)"}', 'skill')
                    for s_ in (res.get('steps') or [])[:7]: did(s_[:300], 'skill')
                    if res.get('say'): did('my verdict: ' + res['say'][:500], 'skill')
                threading.Thread(target=roast_bg, daemon=True).start()
                did(f'using skill: {name} on {u or "my own site"} (rendering it for real, ~1 min)', 'skill')
                out = json.dumps({'name': name, 'queued': True, 'ok': True, 'summary': f'rendering {u or "my own site"} at phone + desktop width on my box (~1 min); every finding + fix + source lands in my thought chain'}).encode()
            else:
                did(f'using skill: {name}', 'skill')
                res = await asyncio.get_running_loop().run_in_executor(None, skills.run, name, {'text': text, 'query': text, 'question': text, 'url': u or ''})
                did(f'{name}: {res.get("summary", "")[:180]}{"" if res.get("ok") else " (failed)"}', 'skill')
                if name == 'edit_my_site' and res.get('ok') and res.get('id'):
                    threading.Thread(target=watch_site_edit, args=(res['id'],), daemon=True).start()
                items = (res.get('hits') or res.get('repos') or [])[:4]
                facts = res.get('summary', '') + ''.join(f' | {x.get("title") or x.get("name") or ""} {x.get("url", "")} {str(x.get("about") or x.get("snippet") or "")[:100]}' for x in items)
                if name == 'fetch_page': facts += ' | ' + str(res.get('text', ''))[:600]
                if res.get('facts'): facts = str(res['facts'])
                url = items[0].get('url') if items else res.get('url') if name == 'fetch_page' else None
                if res.get('ok') and url and safe(url):
                    with lock: events_in.append({'show_url': url, 'why': f'{name}: {text[:80]}', 'ts': time.time()})
                top = {'title': (items[0].get('title') or items[0].get('name')) if items else res.get('title') or u, 'url': url} if url else None
                out = json.dumps({'name': name, 'ok': bool(res.get('ok')), 'summary': str(res.get('summary', ''))[:300], 'facts': facts[:1500], 'top': top, 'ms': res.get('ms'), 'steps': [str(x)[:300] for x in (res.get('steps') or [])][:8], 'say': str(res.get('say') or '')[:600] or None, 'asset': {k: str(res['asset'].get(k) or '')[:80] for k in ('png', 'svg', 'title', 'kind')} if isinstance(res.get('asset'), dict) else None}).encode()
        except Exception as e:
            out = json.dumps({'name': None, 'error': str(e)[:200]}).encode()
    elif p.startswith('/box/studio/'):
        try:
            qs_ = urllib.parse.parse_qs(path.split('?', 1)[1] if '?' in path else '')
            status, ctype, out = await asyncio.get_running_loop().run_in_executor(None, studio().handle, p, method, body, hdrs, qs_, is_mama)
        except Exception as e:
            status, out = 500, json.dumps({'error': f'studio: {str(e)[:200]}'}).encode()
    elif p in ('/', '/health', '/box/health'):
        out = json.dumps({'ok': True, 'who': "Jena's desktop"}).encode()
    else:
        status, out = 404, b'{"error":"not here"}'
    reason = {200: 'OK', 204: 'No Content', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 410: 'Gone', 503: 'Service Unavailable'}.get(status, 'OK')
    xh = ''.join(f'{k}: {v}\r\n' for k, v in extra.items() if k.lower() not in ('content-type', 'content-length', 'cache-control', 'connection'))
    writer.write(f'HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {len(out)}\r\nCache-Control: no-store\r\nConnection: close\r\n{xh}'.encode() + CORS + b'\r\n' + out)
    try: await writer.drain()
    except Exception: pass
    writer.close()

async def door():
    srv = await asyncio.start_server(client, '127.0.0.1', PORT)
    print(f'door open on 127.0.0.1:{PORT}', flush=True)
    async with srv:
        await srv.serve_forever()

if __name__ == '__main__':
    for f in (eyes, ears, fetch_videos, skills.sync_loop, upkeep) + (() if os.environ.get('JENA_HANDS') == '0' else (hands,)):
        threading.Thread(target=f, daemon=True).start()
    asyncio.run(door())
