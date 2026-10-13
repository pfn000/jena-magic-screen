#!/usr/bin/env python3
"""jena_censor - the ONLY source of Jena's public desktop picture.

The public stream is never raw VNC. This module grabs her X display (:99), reads it with tesseract,
blacks out anything that looks private (emails, IP addresses, 6-8 digit codes, API-key-like strings,
phone numbers) and serves that sanitized JPEG. It fails CLOSED: a sign-in page, an inbox, a password
field, a terminal showing env/keys, mama driving the desktop, a crash, or a frame older than 2 s all
turn the whole picture into a "private moment" card. Raw pixels live only in memory (piped to
tesseract on stdin); nothing raw is written to disk. Logs carry the censor TYPE and counts, never values.

Honest limits: OCR is not perfect. Tiny, stylized, rotated, low-contrast or partly covered text can be
missed, and text drawn inside images/videos may not be read. The page-level rules (login/inbox/env ->
whole card) are the main safety net; per-word blackouts are the second one.

Use from jena_desk.py (same user, DISPLAY=:99):
    import jena_censor
    CENSOR = jena_censor.Censor(display=':99'); CENSOR.start()
    CENSOR.set_private('mama_takeover', True)      # any named reason -> card until cleared
    body, headers = CENSOR.jpeg()                   # always safe to send publicly
    CENSOR.status_json()                            # state/reason/age/fps/redaction counts, no text

Standalone (testing / OBS without jena_desk):  python3 jena_censor.py --serve 6083   (binds 127.0.0.1)
One-shot proof on a still image:                python3 jena_censor.py --image in.png --out out.jpg
"""
import hashlib, io, json, os, re, subprocess, sys, threading, time

from PIL import Image, ImageDraw, ImageFont

MAX_AGE_S = 2.0          # a sanitized frame older than this is never served; the card is
TARGET_FPS = float(os.environ.get('JENA_CENSOR_FPS', '2'))
OCR_TIMEOUT_S = 6.0      # hard ceiling on one tesseract run (crash/hang guard). Freshness is separate: see MAX_AGE_S
OUT_W = int(os.environ.get('JENA_CENSOR_WIDTH', '1280'))
JPEG_Q = 62
PAD = 5
OCR_SCALE = float(os.environ.get('JENA_CENSOR_OCR_SCALE', '1.5'))
LOG = os.path.expanduser(os.environ.get('JENA_CENSOR_LOG', '~/.jena/censor.log'))

# ------------------------------------------------------------------ what counts as private
# word/line level -> black box over just those words
EMAIL = re.compile(r'[A-Za-z0-9._%+\-]+\s?[@©®]\s?[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')
IPV4 = re.compile(r'(?<![\d.])(?:\d{1,3}[.,]){3}\d{1,3}(?![\d])')
IPV6 = re.compile(r'(?i)(?<![0-9a-f:])(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}(?![0-9a-f:])')
CODE = re.compile(r'(?<![\dA-Za-z])(?:\d[ \-]?){5,7}\d(?![\dA-Za-z])')      # 6-8 digits, maybe spaced "123 456"
PHONE = re.compile(r'(?<![\d])(?:\+?\d{1,3}[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?![\d])')
KEY = re.compile(
    r'(?:sk|pk|rk)[-_](?:live[-_]|test[-_]|proj[-_]|ant[-_])?[A-Za-z0-9_\-]{8,}'
    r'|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[abprs]-[A-Za-z0-9\-]{8,}'
    r'|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_\-]{20,}|hf_[A-Za-z0-9]{10,}|glpat-[A-Za-z0-9_\-]{10,}'
    r'|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}'                          # JWT
    r'|(?<![A-Za-z0-9])(?=[A-Za-z0-9+/_\-]*\d)(?=[A-Za-z0-9+/_\-]*[A-Za-z])[A-Za-z0-9+/_\-]{24,}={0,2}(?![A-Za-z0-9])'  # long mixed token
)
WORD_RULES = (('email', EMAIL), ('key', KEY), ('ip', IPV4), ('ip', IPV6), ('phone', PHONE), ('code', CODE))
# a single OCR word that LOOKS like part of a secret even if the line regex missed it (fail closed per word)
WORD_FALLBACK = (('email', re.compile(r'[@©]\S*\.')), ('code', re.compile(r'(?:\D*\d){6,}')),
                 ('key', re.compile(r'^(?:sk|gh[pousr]|xox|AKIA|hf)[-_]')))

# page level -> whole private card. Title = active window title (Firefox puts the page title there).
TITLE_PRIVATE = re.compile(
    r'(?i)proton|sign[\s-]?in|log[\s-]?in|signin|login|sign[\s-]?up|password|passwort|passkey|'
    r'2fa|two[\s-]?factor|verif(?:y|ication)|one[\s-]?time|authenticat|inbox|\bmail\b|gmail|outlook|'
    r'accounts?\.|account settings|about:logins|keyring|seahorse|secret|credential|token|\.env\b|api[\s_-]?key')
TEXT_SECRETS = re.compile(
    r'BEGIN\s+[A-Z ]*PRIVATE\s+KEY|\bprintenv\b|\bexport\s+[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASS)|'
    r'[A-Z0-9_]*(?:API_KEY|_TOKEN|_SECRET|PASSWORD|SECRET_KEY)\s*=|(?<![\w/])\.env\b|ssh-(?:rsa|ed25519)\s')
TEXT_LOGIN = re.compile(
    r'(?i)/log[-_]?in\b|/sign[-_]?in\b|\bsign\s?in\s+to\b|\blog\s?in\s+to\b|\bpassword\b|passwort|verification\s+code|'
    r'one[-\s]?time\s+(?:pass)?code|security\s+code|\b2fa\b|two[-\s]factor|authenticator|recovery\s+(?:phrase|code|kit)|seed\s+phrase')
TEXT_PRIVATE = re.compile(r'(?i)proton\s*\.?\s*me|proton\s*mail|account\.proton|accounts\.[a-z0-9-]+\.[a-z]|\binbox\b')
# a terminal whose screen is an env dump: many NAME=value lines
ENV_LINE = re.compile(r'^[A-Z][A-Z0-9_]{2,}=\S')
TERMINAL_TITLE = re.compile(r'(?i)terminal|xterm|bash|zsh|\bsh\b|tmux|console|konsole|kitty|alacritty|@')

REASON_WORDS = {
    'mama_takeover': 'mama is driving (private)',
    'signin': 'Jena is getting signed in',
    'login_page': 'sign-in page',
    'private_page': 'private page',
    'secrets_terminal': 'keys on screen',
    'censor_error': 'privacy filter hiccup',
    'censor_lag': 'privacy filter catching up',
    'starting': 'privacy filter starting',
}


def _log(event):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, 'a') as f:
            f.write(json.dumps({'ts': round(time.time(), 1), **event}) + '\n')
    except Exception:
        pass


def _font(size):
    for p in ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass
    return ImageFont.load_default()


def make_card(reason='private_page', w=OUT_W, h=None):
    """The lock card. Carries only the reason CATEGORY, never what was on screen."""
    h = h or int(w * 704 / 1600)
    im = Image.new('RGB', (w, h), (46, 33, 66))
    d = ImageDraw.Draw(im)
    for r in range(max(w, h), 0, -24):                       # soft purple glow like the site's sleep card
        c = int(46 + 60 * (1 - r / max(w, h)))
        d.ellipse((w / 2 - r, h * 0.42 - r, w / 2 + r, h * 0.42 + r), fill=(c, int(c * 0.75), min(255, c + 30)))
    cx, cy, s = w // 2, int(h * 0.36), max(24, h // 9)       # padlock drawn with shapes (no emoji font needed)
    d.rounded_rectangle((cx - s, cy - s // 6, cx + s, cy + s * 1.2), radius=s // 4, fill=(248, 234, 255))
    d.arc((cx - s * 0.65, cy - s * 1.15, cx + s * 0.65, cy + s * 0.25), 180, 360, fill=(248, 234, 255), width=max(6, s // 5))
    d.ellipse((cx - s // 6, cy + s * 0.35, cx + s // 6, cy + s * 0.67), fill=(46, 33, 66))
    t1, t2 = 'private moment', REASON_WORDS.get(reason, 'keeping something private')
    f1, f2 = _font(max(20, h // 11)), _font(max(14, h // 22))
    for txt, f, y in ((t1, f1, cy + s * 1.6), (t2, f2, cy + s * 1.6 + h // 9)):
        tw = d.textlength(txt, font=f)
        d.text(((w - tw) / 2, y), txt, font=f, fill=(248, 234, 255))
    buf = io.BytesIO(); im.save(buf, 'JPEG', quality=80)
    return buf.getvalue()


# ------------------------------------------------------------------ OCR + decisions (pure functions, testable)
def ocr_words(img, timeout=OCR_TIMEOUT_S, scale=None, offset=(0, 0)):
    """tesseract TSV on an in-memory image (stdin). Returns [{'t','x','y','w','h','line'}]. Raises on lag/error."""
    k = scale or OCR_SCALE
    g = img.convert('L')
    if sum(g.resize((32, 32)).tobytes()) / 1024 < 110:   # dark theme / terminal: tesseract reads dark-on-light best
        from PIL import ImageOps
        g = ImageOps.invert(g)
    if k != 1:   # desktop UI text is ~12-13 px; tesseract misses most of it at 1x, reads it at 1.5x
        g = g.resize((int(g.width * k), int(g.height * k)), Image.BILINEAR)
    buf = io.BytesIO(); g.save(buf, 'PNG', compress_level=1)
    env = dict(os.environ, OMP_THREAD_LIMIT=os.environ.get('JENA_CENSOR_THREADS', '1'))  # 1: 0.7 s at load 9; 2-4 threads thrash (2.5 s to >20 s)
    p = subprocess.run(['tesseract', 'stdin', 'stdout', '--psm', '3', '-l', 'eng', 'tsv'], input=buf.getvalue(),
                       capture_output=True, timeout=timeout, env=env)
    if p.returncode != 0:
        raise RuntimeError('tesseract exit %d' % p.returncode)
    words = []
    for row in p.stdout.decode('utf-8', 'replace').splitlines()[1:]:
        c = row.split('\t')
        if len(c) < 12 or c[0] != '5' or not c[11].strip():
            continue
        words.append({'t': c[11], 'x': int(int(c[6]) / k) + offset[0], 'y': int(int(c[7]) / k) + offset[1], 'w': int(int(c[8]) / k) + 1, 'h': int(int(c[9]) / k) + 1,
                      'line': (offset, c[1], c[2], c[3], c[4])})
    return words


def lines_of(words):
    out = {}
    for wd in words:
        out.setdefault(wd['line'], []).append(wd)
    return list(out.values())


def find_redactions(words):
    """-> list of (type, (x0,y0,x1,y1)). Regexes run over each joined line, matches mapped back to word boxes."""
    hits = []
    for ln in lines_of(words):
        text, spans = '', []
        for wd in ln:
            if text:
                text += ' '
            spans.append((len(text), len(text) + len(wd['t']), wd))
            text += wd['t']
        covered = set()
        for kind, rx in WORD_RULES:
            for m in rx.finditer(text):
                idx = [i for i, (a, b, wd) in enumerate(spans) if a < m.end() and b > m.start()]
                if not idx:
                    continue
                lo, hi = min(idx), max(idx)          # OCR often splits "jena. fake@x.com": take glued neighbours too
                while lo > 0 and re.search(r'[._%+\-@]$', spans[lo - 1][2]['t']):
                    lo -= 1
                while hi < len(spans) - 1 and re.match(r'^[._\-@]', spans[hi + 1][2]['t']):
                    hi += 1
                for i in range(lo, hi + 1):
                    if i not in covered:
                        covered.add(i); hits.append((kind, spans[i][2]))
        for i, (a, b, wd) in enumerate(spans):
            if i in covered:
                continue
            for kind, rx in WORD_FALLBACK:
                if rx.search(wd['t']):
                    covered.add(i); hits.append((kind, wd)); break
    return [(k, (w['x'] - PAD, w['y'] - PAD, w['x'] + w['w'] + PAD, w['y'] + w['h'] + PAD)) for k, w in hits]


def sanitize_text(text):
    """Mask private-looking values inside a string (for screen.json summaries, thoughts, action logs).
    -> (masked_text, {type: count}). Same rules as the picture; values are replaced with [email] / [ip] / ..."""
    if not text:
        return text, {}
    counts = {}
    out = str(text)
    for kind, rx in WORD_RULES:
        def rep(m, kind=kind):
            counts[kind] = counts.get(kind, 0) + 1
            return '[' + kind + ']'
        out = rx.sub(rep, out)
    for kind, rx in (('key', TEXT_SECRETS),):
        def rep2(m, kind=kind):
            counts[kind] = counts.get(kind, 0) + 1
            return '[' + kind + ']'
        out = re.sub(r'(?:' + rx.pattern + r')\S*', rep2, out)
    return out, counts


def text_is_private(text, title=''):
    """True when a string reads like a sign-in page / inbox / env dump (the same page rules as the picture)."""
    words = [{'t': t, 'line': (i,), 'x': 0, 'y': 0, 'w': 0, 'h': 0} for i, l in enumerate((text or '').splitlines()) for t in l.split()]
    return page_verdict(title, words) is not None


def page_verdict(title, words):
    """None if the screen may go out (with blackouts), else a private reason. Fail closed."""
    title = title or ''
    if TITLE_PRIVATE.search(title):
        return 'login_page' if re.search(r'(?i)sign|log|pass|verif|auth|2fa|factor|one.?time|proton|account', title) else 'private_page'
    lines = [' '.join(w['t'] for w in ln) for ln in lines_of(words)]
    full = '\n'.join(lines)
    if TEXT_SECRETS.search(full):
        return 'secrets_terminal'
    if TEXT_LOGIN.search(full):
        return 'login_page'
    if TEXT_PRIVATE.search(full):
        return 'private_page'
    if sum(1 for l in lines if ENV_LINE.match(l.strip())) >= 4:
        return 'secrets_terminal'
    return None


def sanitize(img, title, words=None):
    """img(PIL) -> (jpeg_bytes|None, meta). None jpeg = private (caller serves the card)."""
    im, meta = sanitize_image(img, title, words)
    return (encode(im) if im is not None else None), meta


def encode(im, pointer=None):
    """Sanitized PIL image -> JPEG, with the pointer drawn on (cyan = Jena's hands)."""
    if pointer:
        im = im.copy()
        draw_pointer(im, pointer[0] * im.width / pointer[2], pointer[1] * im.width / pointer[2], POINTER_JENA)
    buf = io.BytesIO(); im.save(buf, 'JPEG', quality=JPEG_Q)
    return buf.getvalue()


POINTER_JENA, POINTER_MAMA = (0, 229, 255), (255, 92, 184)


def draw_pointer(im, x, y, color, s=22):
    d = ImageDraw.Draw(im)
    pts = [(x, y), (x, y + s), (x + s * 0.28, y + s * 0.75), (x + s * 0.5, y + s * 1.15), (x + s * 0.64, y + s * 1.08),
           (x + s * 0.45, y + s * 0.7), (x + s * 0.78, y + s * 0.7)]
    d.polygon(pts, fill=color, outline=(20, 10, 30))


def sanitize_image(img, title, words=None):
    if words is None:
        words = ocr_words(img)
    reason = page_verdict(title, words)
    if reason:
        return None, {'state': 'private', 'reason': reason, 'redactions': {}}
    reds = find_redactions(words)
    im = img.convert('RGB')
    d = ImageDraw.Draw(im)
    counts = {}
    for kind, box in reds:
        d.rectangle(box, fill=(0, 0, 0))
        counts[kind] = counts.get(kind, 0) + 1
    if im.width != OUT_W:
        im = im.resize((OUT_W, int(im.height * OUT_W / im.width)), Image.BILINEAR)
    return im, {'state': 'live', 'reason': None, 'redactions': counts}


# ------------------------------------------------------------------ capture
def grab(display):
    try:
        from PIL import ImageGrab
        return ImageGrab.grab(xdisplay=display)
    except Exception:
        out = subprocess.run(['import', '-display', display, '-window', 'root', 'png:-'], capture_output=True, timeout=2).stdout
        return Image.open(io.BytesIO(out))


def active_title(display):
    """Active window title + every visible (mapped) window title, one per line. A private page in a window
    behind the focused one still counts (fail closed)."""
    try:
        p = subprocess.run(['sh', '-c', 'timeout 0.6 xdotool getactivewindow getwindowname 2>/dev/null; '
                            'for w in $(timeout 0.6 xdotool search --onlyvisible --name . 2>/dev/null); do timeout 0.3 xdotool getwindowname $w 2>/dev/null; done'],
                           capture_output=True, timeout=0.8, env=dict(os.environ, DISPLAY=display))
        return p.stdout.decode('utf-8', 'replace').strip()
    except Exception:
        return None   # unknown titles alone are not private; OCR still decides


TERM_SCALE = float(os.environ.get('JENA_CENSOR_TERM_SCALE', '2.2'))


def terminal_rects(display):
    """Visible terminal windows -> [(x0,y0,x1,y1)]. Terminal fonts are small and light-on-dark, the place keys
    and env dumps show up, so each gets its own bigger, inverted OCR pass."""
    try:
        p = subprocess.run(['sh', '-c', 'for w in $(timeout 0.6 xdotool search --onlyvisible --name . 2>/dev/null); do '
                            'echo "$(timeout 0.3 xdotool getwindowname $w 2>/dev/null)\t$(timeout 0.3 xdotool getwindowgeometry --shell $w 2>/dev/null | tr "\n" " ")"; done'],
                           capture_output=True, timeout=0.8, env=dict(os.environ, DISPLAY=display))
    except Exception:
        return []
    out = []
    for line in p.stdout.decode('utf-8', 'replace').splitlines():
        if '\t' not in line:
            continue
        name, geo = line.split('\t', 1)
        if not TERMINAL_TITLE.search(name) or 'Mousepad' in name or 'Firefox' in name:
            continue
        g = dict(kv.split('=', 1) for kv in geo.split() if '=' in kv)
        try:
            x, y, w, h = int(g['X']), int(g['Y']), int(g['WIDTH']), int(g['HEIGHT'])
        except Exception:
            continue
        if w > 40 and h > 20:
            out.append((x, y, x + w, y + h))
    return out


def read_screen(img, display=None, rects=None, cache=None):
    """Full-frame OCR + a bigger OCR pass on each terminal window, in parallel. Terminal crops are cached by
    their exact pixels (a terminal that did not change is not re-read)."""
    import concurrent.futures as cf
    rects = terminal_rects(display) if rects is None else rects
    W, H = img.size
    jobs = {}
    with cf.ThreadPoolExecutor(max_workers=1 + len(rects)) as ex:
        full = ex.submit(ocr_words, img)
        for r in rects:
            r = (max(0, r[0]), max(0, r[1]), min(W, r[2]), min(H, r[3]))
            if r[2] - r[0] < 20 or r[3] - r[1] < 10:
                continue
            crop = img.crop(r)
            key = hashlib.blake2b(crop.tobytes(), digest_size=16).hexdigest() + str(r)
            if cache is not None and key in cache:
                jobs[key] = cache[key]
            else:
                jobs[key] = ex.submit(ocr_words, crop, OCR_TIMEOUT_S, TERM_SCALE, (r[0], r[1]))
        words = list(full.result())
        for key, j in jobs.items():
            ws = j if isinstance(j, list) else j.result()
            if cache is not None:
                cache[key] = ws
                while len(cache) > 8:
                    cache.pop(next(iter(cache)))
            words += ws
    return words


def pointer_xy(display):
    try:
        p = subprocess.run(['xdotool', 'getmouselocation', '--shell'], capture_output=True, timeout=0.5, env=dict(os.environ, DISPLAY=display))
        g = dict(l.split('=', 1) for l in p.stdout.decode().split() if '=' in l)
        return int(g['X']), int(g['Y'])
    except Exception:
        return None


# ------------------------------------------------------------------ the loop
class Censor:
    def __init__(self, display=':99', fps=TARGET_FPS):
        self.display, self.period = display, 1.0 / max(0.2, fps)
        self.lock = threading.Lock()
        self.private = {}                 # reason -> True
        self.frame = None                 # (jpeg, captured_at, meta)
        self.meta = {'state': 'private', 'reason': 'starting', 'redactions': {}}
        self.cards = {}
        self.term_cache = {}
        self.cache = {}                   # pixel hash -> (jpeg|None, meta)  (exact-same pixels only, last 4)
        self.times = []                   # recent frame completion times, for fps
        self.ocr_ms = None
        self.errors = 0
        self.thread = None
        self._last_logged = None
        self.stop = False

    # -- control
    def start(self):
        if self.thread and self.thread.is_alive():
            return self
        self.thread = threading.Thread(target=self._run, name='jena-censor', daemon=True)
        self.thread.start()
        return self

    def set_private(self, reason, on=True):
        with self.lock:
            if on:
                self.private[reason] = True
                self.frame = None             # drop the last live frame at once
            else:
                self.private.pop(reason, None)
        _log({'event': 'private_on' if on else 'private_off', 'reason': reason})

    def card(self, reason):
        if reason not in self.cards:
            self.cards[reason] = make_card(reason)
        return self.cards[reason]

    # -- public outputs (never raw)
    def jpeg(self):
        hdr = {'Cache-Control': 'no-store, max-age=0', 'Content-Type': 'image/jpeg'}
        try:
            if self.thread is None or not self.thread.is_alive():
                self.start()
            with self.lock:
                forced = next(iter(self.private), None)
                fr = self.frame
            if forced:
                return self.card(forced), {**hdr, 'X-Censor-State': 'private', 'X-Censor-Reason': forced}
            if fr is None:
                r = self.meta.get('reason') or 'starting'
                return self.card(r), {**hdr, 'X-Censor-State': 'private', 'X-Censor-Reason': r}
            jpg, at, meta = fr
            if time.time() - at > MAX_AGE_S:
                return self.card('censor_lag'), {**hdr, 'X-Censor-State': 'private', 'X-Censor-Reason': 'censor_lag'}
            return jpg, {**hdr, 'X-Censor-State': 'live', 'X-Censor-Age-Ms': str(int((time.time() - at) * 1000))}
        except Exception:
            return make_card('censor_error'), {**hdr, 'X-Censor-State': 'private', 'X-Censor-Reason': 'censor_error'}

    def status(self):
        with self.lock:
            forced = next(iter(self.private), None)
            fr = self.frame
        now = time.time()
        ts = [t for t in self.times if now - t < 10]
        age = int((now - fr[1]) * 1000) if fr else None
        state, reason = 'live', None
        if forced:
            state, reason = 'private', forced
        elif fr is None:
            state, reason = 'private', self.meta.get('reason') or 'starting'
        elif now - fr[1] > MAX_AGE_S:
            state, reason = 'private', 'censor_lag'
        return {'state': state, 'reason': reason, 'reason_text': REASON_WORDS.get(reason) if reason else None,
                'age_ms': age, 'fps': round(len(ts) / 10, 2), 'ocr_ms': self.ocr_ms,
                'redactions': (fr[2].get('redactions') if fr and state == 'live' else {}),
                'max_age_ms': int(MAX_AGE_S * 1000), 'mode': 'censored'}

    def status_json(self):
        return json.dumps(self.status()).encode()

    # -- worker
    def _run(self):
        while not self.stop:
            t0 = time.time()
            try:
                self._tick()
                self.errors = 0
            except Exception as e:
                self.errors += 1
                with self.lock:
                    self.frame = None
                self.meta = {'state': 'private', 'reason': 'censor_lag' if isinstance(e, subprocess.TimeoutExpired) else 'censor_error', 'redactions': {}}
                self._log_state(self.meta, err=type(e).__name__)
                time.sleep(min(5, 0.5 * self.errors))
            dt = time.time() - t0
            time.sleep(max(0.02, self.period - dt))

    def _tick(self):
        with self.lock:
            forced = bool(self.private)
        if forced:
            with self.lock:
                self.frame = None
            return
        captured_at = time.time()
        img = grab(self.display)
        title = active_title(self.display)
        h = hashlib.blake2b(img.tobytes(), digest_size=16)
        h.update((title or '').encode())
        key = h.hexdigest()
        hit = self.cache.get(key)
        if hit is None:
            t = time.time()
            words = read_screen(img, self.display, cache=self.term_cache)
            self.ocr_ms = int((time.time() - t) * 1000)
            hit = sanitize_image(img, title, words)
            self.cache[key] = hit
            while len(self.cache) > 4:
                self.cache.pop(next(iter(self.cache)))
        W = img.width
        del img
        im, meta = hit
        ptr = pointer_xy(self.display)
        jpg = encode(im, (ptr[0], ptr[1], W) if ptr else None) if im is not None else None
        if time.time() - captured_at > MAX_AGE_S:
            # the read took too long (box busy): this frame is stale and is NOT served. Its verdict stays cached,
            # so the next identical frame (most desktop frames are) goes out at once.
            self.meta = {'state': 'private', 'reason': 'censor_lag', 'redactions': {}}
            self._log_state(self.meta)
            return
        with self.lock:
            if self.private:          # mama grabbed the wheel while we were reading: drop it
                self.frame = None
                return
            self.frame = (jpg, captured_at, meta) if jpg else None
        self.meta = meta
        self.times = [t for t in self.times[-40:] if time.time() - t < 10] + [time.time()]
        self._log_state(meta)

    def _log_state(self, meta, err=None):
        sig = (meta.get('state'), meta.get('reason'), tuple(sorted((meta.get('redactions') or {}).items())), err)
        if sig != self._last_logged:      # log changes only; types + counts, never values
            self._last_logged = sig
            _log({'event': 'state', 'state': meta.get('state'), 'reason': meta.get('reason'),
                  'redactions': meta.get('redactions') or {}, **({'error': err} if err else {})})


# ------------------------------------------------------------------ standalone
def _serve(port, display):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    c = Censor(display=display).start()

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            p = self.path.split('?')[0]
            if p in ('/box/shot.jpg', '/shot.jpg'):
                body, hdr = c.jpeg()
            elif p in ('/box/censor.json', '/censor.json'):
                body, hdr = c.status_json(), {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}
            else:
                self.send_response(404); self.end_headers(); return
            self.send_response(200)
            for k, v in hdr.items():
                self.send_header(k, v)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Expose-Headers', 'X-Censor-State, X-Censor-Reason, X-Censor-Age-Ms')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers(); self.wfile.write(body)

    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()


if __name__ == '__main__':
    a = sys.argv[1:]
    disp = os.environ.get('DISPLAY', ':99')
    if '--display' in a:
        disp = a[a.index('--display') + 1]
    if '--serve' in a:
        _serve(int(a[a.index('--serve') + 1]), disp)
    elif '--image' in a:
        img = Image.open(a[a.index('--image') + 1])
        title = a[a.index('--title') + 1] if '--title' in a else ''
        t = time.time(); jpg, meta = sanitize(img, title); meta['ms'] = int((time.time() - t) * 1000)
        out = a[a.index('--out') + 1] if '--out' in a else None
        if out:
            open(out, 'wb').write(jpg or make_card(meta['reason']))
        print(json.dumps(meta))
    else:
        print(__doc__)
