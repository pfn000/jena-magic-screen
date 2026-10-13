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

DISPLAY = os.environ.get('DISP', ':99')
PORT = int(os.environ.get('JENA_BOX_PORT', '6081'))
WS_UPSTREAM = ('127.0.0.1', int(os.environ.get('WEBSOCKIFY_PORT', '6080')))
WS_MAMA = ('127.0.0.1', int(os.environ.get('WEBSOCKIFY_MAMA_PORT', '6082')))   # full-control VNC, only via a one-time mama token
BRAIN = os.environ.get('JENA_BRAIN', 'http://127.0.0.1:8088/v1')
SITE = os.environ.get('JENA_SITE', 'https://jena-magic-screen.vercel.app')
HOME = os.path.expanduser('~')
STATE = os.path.join(HOME, '.jena')
os.makedirs(STATE, exist_ok=True)
ENV = dict(os.environ, DISPLAY=DISPLAY, HOME=HOME)

BAD = re.compile(r"\b(sex\w*|porn\w*|nude\w*|naked|nsfw|onlyfans|fetish\w*|erotic\w*|hentai|xxx|boob\w*|horny|kiss\w*|"
                 r"strip\w*|lingerie|bikini|hook ?up|date me|marry me|bae|babe|daddy|nazi\w*|suicide|self.?harm|kill\w*|gore|"
                 r"drug\w*|cocaine|meth|weed|vape|gun\w*|bomb\w*|hack (into|someone)|password\w*|login|log in|sign in|"
                 r"credit card|ssn)\b", re.I)

def safe(s):
    return not BAD.search(s or '')

def sh(cmd, timeout=10):
    try:
        r = subprocess.run(cmd, shell=isinstance(cmd, str), env=ENV, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ''

def spawn(cmd):
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

def firefox(url):
    wid = find('firefox')
    W, H = screen_size()
    fw, fh = min(1180, W - 60), H - 70
    if not wid:
        spawn(['firefox-esr', '--new-instance', '--profile', os.path.join(HOME, '.ffprofile'), '--width', str(fw), '--height', str(fh), url])
        wid = wait_for('firefox', 40)
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
    key('ctrl+l'); time.sleep(0.3)
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
    vids = my_videos()
    if not vids and not video: return act_read()
    url, title, label = video or random.choice(vids)
    vid = re.search(r'[?&]v=([\w-]{11})', url)
    path = local_video(vid.group(1)) if vid else None
    with lock:
        watching['video'] = {'url': url, 'title': title, 'label': label, 'since': int(time.time() * 1000), 'player': 'ffplay (local copy)' if path else 'firefox'}
    if path:
        did(f'watching "{title[:70]}" again, the video I learned my {label} move from')
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
    u, note = random.choice(lst)
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
    """ask Grok on grok.com in her own Firefox, signed out like any visitor; label the answer as Grok's"""
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
    focus(wid)
    sh(['xdotool', 'mousemove', str(X + W // 2), str(Y + int(H * 0.42)), 'click', '1']); time.sleep(0.6)
    sh(['xdotool', 'type', '--delay', '35', q[:300]]); time.sleep(0.4); key('Return')
    before = ''
    text = ''
    for _ in range(9):
        time.sleep(5)
        focus(wid); key('ctrl+a'); time.sleep(0.3); key('ctrl+c'); time.sleep(0.4)
        text = clipboard_text()
        sh(['xdotool', 'mousemove', str(X + W - 30), str(Y + H // 2), 'click', '1'])
        if text and text == before and q[:30] in text: break
        before = text
    ans = ''
    if q[:30] in text:
        ans = text.split(q[:30], 1)[1]
        ans = ans.split(q[30:], 1)[-1] if len(q) > 30 else ans
        ans = re.split(r'\n\s*(Ask anything|How can Grok help|Grok can make mistakes|DeepSearch|Think\b|Auto\b|By messaging Grok)', ans)[0]
        ans = re.sub(r'\n{2,}', '\n', ans).strip()
    wall = re.search(r'sign up to continue|continue your conversation|sign in to continue|log in to continue|create an account', ans or text or '', re.I)
    if wall: ans = ''
    if not ans:
        signed = wall or re.search(r'\b(sign in|log in|sign up)\b', text or '', re.I)
        why = 'grok.com showed a "sign up to continue" wall, and I do not sign in or make accounts by myself' if signed else 'I could not read an answer off the page'
        ask_mama(f'I tried asking Grok "{q[:80]}" but {why}.')
        return {'ok': False, 'summary': why}
    os.makedirs(os.path.join(HOME, 'learned'), exist_ok=True)
    rec = {'ts': int(time.time() * 1000), 'question': q, 'answer': ans[:4000], 'source': 'Grok (grok.com, signed out, in her browser)', 'note': 'Grok\'s answer, not Jena\'s own brain'}
    with open(os.path.join(HOME, 'learned', 'grok_notes.jsonl'), 'a') as f: f.write(json.dumps(rec) + '\n')
    with open(os.path.join(HOME, 'notes', 'learned_from_grok.md'), 'a') as f: f.write(f"\n## {time.strftime('%Y-%m-%d %H:%M')} I asked Grok: {q}\nGrok said: {ans[:1500]}\n")
    did(f'Grok answered (Grok\'s words, saved to my memory): "{re.sub(chr(10), " ", ans)[:160]}"', 'skill')
    return {'ok': True, 'summary': f'asked Grok "{q[:60]}" and saved its answer', 'question': q, 'answer': ans[:4000], 'answered_by': 'Grok'}
skills.desktop_skills['ask_grok'] = skill_ask_grok

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
    picks = random.sample(EXPLORE, 5)
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
    type_(random.choice(['uptime\n', 'free -h\n', 'cat ~/projects/ctf/flag.txt\n', 'ls -la ~/notes\n'])); time.sleep(4)

def act_python():
    if not terminal(): return
    s = random.choice(['matrix.py', 'fib.py', 'hearts.py', 'life.py', 'bones.py'])
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
            firefox(url); time.sleep(3); scroll_some(); return
    name, url = random.choice(PAGES)
    did(f'opened Firefox to read about {name}')
    firefox(url); time.sleep(3); scroll_some()

def act_note(extra=None):
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
        line = random.choice(pool)
    key('ctrl+End')
    type_('\n' + time.strftime('%H:%M') + '  ' + line, delay=60)
    key('ctrl+s')
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

ROTATION = [act_htop, act_fetch, act_python, act_read, act_hot, act_watch, act_watch, act_note, act_tidy, act_explore]

def hands():
    time.sleep(3)
    last = None
    while True:
        try:
            ev = None
            if mama['driving']:
                time.sleep(2); continue          # mama has her desktop: hands off
            with lock:
                if events_in: ev = events_in.popleft()
            unstick()
            if ev and ev.get('show_url'):
                log_activity('open', ev['show_url'], ev.get('why', ''))
                firefox(ev['show_url']); time.sleep(3); scroll_some()
            elif ev and ev.get('skill'):
                use_skill(ev['skill'], ev.get('text', ''))
            elif ev:
                text = ev.get('text', '')
                u = url_in(text)
                sk = skills.match(text)
                if sk and not (u and sk not in ('fetch_page', 'ask_grok')):
                    use_skill(sk, text)
                elif u:
                    did(f'{ev.get("user") or "someone"} sent me a link, opening exactly {u[:90]}')
                    log_activity('open', u, f'{ev.get("user") or "someone"} sent the link')
                    firefox(u); time.sleep(4); scroll_some()
                elif re.search(r'\b(video|watch|dance|dancing|move|moves)\b', text, re.I) and my_videos():
                    dances = [v for v in my_videos() if re.search(r'dance|macarena|zumba|jerusalema', (v[1] + ' ' + v[2]), re.I)]
                    act_watch(random.choice(dances) if dances and re.search(r'danc', text, re.I) else None)
                elif re.search(r'\b(search|look up|lookup|google|find|github|repo|what is|who is|how (do|does|to))\b', text, re.I) or wiki_for(text):
                    act_search(text)
                    if random.random() < 0.5: act_note(' '.join(text.split()[:8]))
                else:
                    random.choice([act_python, act_fetch, act_note])()
            else:
                a = random.choice([a for a in ROTATION if a is not last]); last = a
                a()
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
mama = {'driving': 0, 'private_until': 0}
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
    did('got a private message from mama (popped up on my screen)', 'help')

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

# ---------------------------------------------------------------- the door (http + websocket passthrough)
def payload():
    with lock:
        return dict(screen, actions=list(actions)[-8:], video=watching['video'], now=int(time.time() * 1000),
                    mama_driving=mama['driving'] > 0, private=time.time() < mama['private_until'], updating=updating.copy())

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
async def mama_door(p, method, body):
    loop = asyncio.get_running_loop()
    try: b = json.loads(body or b'{}')
    except Exception: b = {}
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
    if p == '/box/activity':
        try: lines = open(ACT).read().strip().splitlines()[-200:]
        except Exception: lines = []
        try: helps = open(HELP).read().strip().splitlines()[-20:]
        except Exception: helps = []
        return 200, json.dumps({'activity': [json.loads(l) for l in lines if l.strip()], 'help': [json.loads(l) for l in helps if l.strip()]}).encode()
    if p == '/box/mama/notify':
        mama_popup(b.get('text', '')); return 200, json.dumps({'ok': True, 'shown_for_s': 28}).encode()
    if p == '/box/mama/takeover':
        tok = secrets.token_urlsafe(24); takeover_tokens[tok] = time.time() + 60
        return 200, json.dumps({'ok': True, 'token': tok, 'path': '/websockify-mama?t=' + tok, 'valid_s': 60}).encode()
    if p == '/box/mama/apikey':
        if b.get('rotate') or not os.path.exists(API_KEY):
            k = 'jena-' + secrets.token_urlsafe(30)
            with open(API_KEY, 'w') as f: f.write(k)
            os.chmod(API_KEY, 0o600)
            with open(API_KEY + '.sha256', 'w') as f: f.write(hashlib.sha256(k.encode()).hexdigest())
            os.chmod(API_KEY + '.sha256', 0o640)
        return 200, json.dumps({'ok': True, 'key': open(API_KEY).read().strip()}).encode()
    return 404, json.dumps({'ok': False, 'summary': 'no such mama door'}).encode()

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
    if p == '/websockify-mama':
        tok = urllib.parse.parse_qs(path.split('?', 1)[1] if '?' in path else '').get('t', [''])[0]
        exp = takeover_tokens.pop(tok, 0)
        if not tok or exp < time.time():
            writer.write(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); await writer.drain(); writer.close(); return
        try:
            ur, uw = await asyncio.open_connection(*WS_MAMA)
        except Exception:
            writer.write(b'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); await writer.drain(); writer.close(); return
        uw.write(head.replace(path.encode(), b'/websockify', 1)); await uw.drain()
        mama['driving'] += 1; did('mama took over my desktop, my hands are off', 'help')
        try: await asyncio.gather(pipe(reader, uw), pipe(ur, writer))
        finally:
            mama['driving'] = max(0, mama['driving'] - 1)
            if not mama['driving']: did('mama gave my desktop back', 'help')
        return
    if p.startswith('/websockify'):
        try:
            ur, uw = await asyncio.open_connection(*WS_UPSTREAM)
        except Exception:
            writer.write(b'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); await writer.drain(); writer.close(); return
        uw.write(head.replace(path.encode(), b'/websockify', 1)); await uw.drain()
        await asyncio.gather(pipe(reader, uw), pipe(ur, writer)); return
    hdrs = {}
    for l in head.decode('latin1').split('\r\n')[1:]:
        if ':' in l:
            k, v = l.split(':', 1); hdrs[k.strip().lower()] = v.strip()
    body = b''
    n = int(hdrs.get('content-length') or 0)
    if 0 < n < 8192:
        body = await reader.readexactly(n)
    status, ctype, out = 200, 'application/json', b''
    if method == 'OPTIONS':
        status, out = 204, b''
    elif p in ('/box/screen.json', '/box/screen', '/screen.json'):
        out = json.dumps(payload()).encode()
    elif p in ('/box/shot.jpg', '/shot.jpg'):
        ctype, out = 'image/jpeg', shot_jpg
    elif p in ('/box/desktop.json', '/box', '/box/'):
        out = json.dumps({'websockify': '/websockify', 'screen': '/box/screen.json', 'shot': '/box/shot.jpg'}).encode()
    elif p == '/box/event' and method == 'POST':
        try: ok = take_event(json.loads(body or b'{}'))
        except Exception: ok = False
        out = json.dumps({'ok': ok}).encode()
    elif p == '/box/skills' and method == 'GET':
        out = json.dumps(skills.listing()).encode()
    elif p in ('/box/skills/run', '/box/skills/create', '/box/activity') or p.startswith('/box/mama/'):
        if not is_mama(hdrs): status, out = 401, json.dumps({'ok': False, 'summary': "mama's passcode is needed for this"}).encode()
        else: status, out = await mama_door(p, method, body)
    elif p == '/box/skills/auto' and method == 'POST':
        # the site asks first: does this message need one of her skills? script skills run now so her brain
        # answers from real results; desktop skills (ask_grok, explore_my_box) are queued for her hands
        try:
            b = json.loads(body or b'{}'); text = str(b.get('text', ''))[:500]
            u = url_in(text); name = skills.match(text)
            if name and u and name not in ('fetch_page', 'ask_grok'): name = None
            spec = skills.load().get(name, {}) if name else {}
            if not name: out = json.dumps({'name': None}).encode()
            elif spec.get('kind') == 'desktop':
                with lock: events_in.append({'text': text, 'user': b.get('user'), 'ts': time.time(), 'skill': name})
                out = json.dumps({'name': name, 'queued': True, 'ok': True, 'summary': 'queued on her desktop'}).encode()
            else:
                did(f'using skill: {name}', 'skill')
                res = await asyncio.get_running_loop().run_in_executor(None, skills.run, name, {'text': text, 'query': text, 'question': text, 'url': u or ''})
                did(f'{name}: {res.get("summary", "")[:180]}{"" if res.get("ok") else " (failed)"}', 'skill')
                items = (res.get('hits') or res.get('repos') or [])[:4]
                facts = res.get('summary', '') + ''.join(f' | {x.get("title") or x.get("name") or ""} {x.get("url", "")} {str(x.get("about") or x.get("snippet") or "")[:100]}' for x in items)
                if name == 'fetch_page': facts += ' | ' + str(res.get('text', ''))[:600]
                url = items[0].get('url') if items else res.get('url') if name == 'fetch_page' else None
                if res.get('ok') and url and safe(url):
                    with lock: events_in.append({'show_url': url, 'why': f'{name}: {text[:80]}', 'ts': time.time()})
                top = {'title': (items[0].get('title') or items[0].get('name')) if items else res.get('title') or u, 'url': url} if url else None
                out = json.dumps({'name': name, 'ok': bool(res.get('ok')), 'summary': str(res.get('summary', ''))[:300], 'facts': facts[:1500], 'top': top, 'ms': res.get('ms')}).encode()
        except Exception as e:
            out = json.dumps({'name': None, 'error': str(e)[:200]}).encode()
    elif p in ('/', '/health', '/box/health'):
        out = json.dumps({'ok': True, 'who': "Jena's desktop"}).encode()
    else:
        status, out = 404, b'{"error":"not here"}'
    reason = {200: 'OK', 204: 'No Content', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found'}.get(status, 'OK')
    writer.write(f'HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {len(out)}\r\nCache-Control: no-store\r\nConnection: close\r\n'.encode() + CORS + b'\r\n' + out)
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
