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
    r'one[-\s]?time\s+(?:pass)?code|security\s+code|\b2fa\b|two[-\s]factor|authenticator|recovery\s+(?:phrase|code|kit)|seed\s+phrase|'
    r'email\s+or\s+(?:user\s?name|phone)|(?:user\s?name|phone)\s+or\s+email|phone,\s*email|forgot\s+(?:your\s+)?password|'
    r'enter\s+(?:your\s+)?(?:password|code)')
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
_TLS = threading.local()
try:
    os.environ.setdefault('OMP_THREAD_LIMIT', os.environ.get('JENA_CENSOR_THREADS', '1'))
    import tesserocr   # apt python3-tesserocr: same engine in-process, saves ~0.3 s of start-up per read
except Exception:
    tesserocr = None


def _tsv(g, timeout):
    if tesserocr is not None and os.environ.get('JENA_CENSOR_CLI') != '1':
        api = getattr(_TLS, 'api', None)
        if api is None:
            api = _TLS.api = tesserocr.PyTessBaseAPI(psm=tesserocr.PSM.AUTO, lang='eng')
        api.SetImage(g)
        return api.GetTSVText(0)
    buf = io.BytesIO(); g.save(buf, 'PNG', compress_level=1)
    env = dict(os.environ, OMP_THREAD_LIMIT=os.environ.get('JENA_CENSOR_THREADS', '1'))  # 1: 0.7 s at load 9; 2-4 threads thrash (2.5 s to >20 s)
    p = subprocess.run(['tesseract', 'stdin', 'stdout', '--psm', '3', '-l', 'eng', 'tsv'], input=buf.getvalue(),
                       capture_output=True, timeout=timeout, env=env)
    if p.returncode != 0:
        raise RuntimeError('tesseract exit %d' % p.returncode)
    return p.stdout.decode('utf-8', 'replace')


def ocr_words(img, timeout=OCR_TIMEOUT_S, scale=None, offset=(0, 0)):
    """tesseract TSV on an in-memory image. Returns [{'t','x','y','w','h','line'}] in screen coords. Raises on error."""
    k = scale or OCR_SCALE
    g = img.convert('L')
    if sum(g.resize((32, 32)).tobytes()) / 1024 < 110:   # dark theme / terminal: tesseract reads dark-on-light best
        from PIL import ImageOps
        g = ImageOps.invert(g)
    if k != 1:   # desktop UI text is ~12-13 px; tesseract misses most of it at 1x, reads it at 1.5x
        g = g.resize((int(g.width * k), int(g.height * k)), Image.BILINEAR)
    words = []
    for row in _tsv(g, timeout).splitlines():
        c = row.split('\t')
        if len(c) < 12 or c[0] != '5' or not c[11].strip():
            continue
        words.append({'t': c[11], 'x': int(int(c[6]) / k) + offset[0], 'y': int(int(c[7]) / k) + offset[1],
                      'w': int(int(c[8]) / k) + 1, 'h': int(int(c[9]) / k) + 1,
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


STRIP_MARGIN = 26          # px above/below a change that are re-read too (whole text lines)
FULL_EVERY_S = 8.0         # a full re-read at least this often, whatever changed
BAND_MAX_FRAC = 0.5        # more than this much of the screen changed -> just read it all


def changed_bands(prev_img, img):
    """-> 'all' | [] (nothing changed) | [(y0, y1, cy0, cy1), ...]: full-width bands to re-read (changed rows +
    margin) and, inside each, the rows whose pixels actually changed. Words of the previous read that do not
    touch a changed row sit on identical pixels, so their reading (and their blackouts) still hold."""
    import numpy as np
    from PIL import ImageChops
    if prev_img is None or prev_img.size != img.size:
        return 'all'
    d = np.asarray(ImageChops.difference(prev_img.convert('L'), img.convert('L')))
    rows = np.flatnonzero(d.max(axis=1) > 0)
    if rows.size == 0:
        return []
    H = img.height
    runs, a, b = [], int(rows[0]), int(rows[0])
    for y in rows[1:]:
        y = int(y)
        if y - b > 2 * STRIP_MARGIN:
            runs.append((a, b)); a = y
        b = y
    runs.append((a, b))
    bands = []
    for a, b in runs:
        y0, y1 = max(0, a - STRIP_MARGIN), min(H, b + 1 + STRIP_MARGIN)
        if bands and y0 <= bands[-1][1]:
            p = bands.pop(); bands.append((p[0], y1, p[2], b)); continue
        bands.append((y0, y1, a, b))
    if sum(y1 - y0 for y0, y1, _, _ in bands) > H * BAND_MAX_FRAC:
        return 'all'
    return bands


def changed_strip(prev_img, img):
    """Back-compat: one band covering every change, None if nothing changed, or 'all'."""
    b = changed_bands(prev_img, img)
    if b == 'all':
        return 'all'
    if not b:
        return None
    return (0, b[0][0], img.width, b[-1][1])


def read_screen(img, display=None, rects=None, cache=None, prev=None):
    """Full-frame OCR, or (when little changed since the last read) OCR of only the changed bands, plus a bigger
    OCR pass on each terminal window, in parallel. Terminal crops are cached by their exact pixels.
    Kept words + band words are a SUPERSET of a full read (a line at a band edge may appear twice; that only
    doubles a blackout). Returns (all_words, full_pass_words)."""
    import concurrent.futures as cf
    rects = terminal_rects(display) if rects is None else rects
    W, H = img.size
    jobs = {}
    bands = 'all'
    if prev and prev.get('img') is not None and time.time() - prev.get('full_at', 0) < FULL_EVERY_S:
        bands = changed_bands(prev['img'], img)
    with cf.ThreadPoolExecutor(max_workers=1 + len(rects)) as ex:
        if bands == 'all':
            futs = [ex.submit(ocr_words, img)]
        else:
            futs = [ex.submit(ocr_words, img.crop((0, y0, W, y1)), OCR_TIMEOUT_S, None, (0, y0)) for y0, y1, _, _ in bands]
        term_prev = (prev or {}).get('term', {}) if bands != 'all' else {}
        term_now = {}
        for r in rects:
            r = (max(0, r[0]), max(0, r[1]), min(W, r[2]), min(H, r[3]))
            if r[2] - r[0] < 20 or r[3] - r[1] < 10:
                continue
            crop = img.crop(r)
            key = hashlib.blake2b(crop.tobytes(), digest_size=12).hexdigest()
            if cache is not None and key in cache:
                jobs[key] = cache[key]
            elif r in term_prev and bands != 'all':
                # same terminal window, a few lines changed: re-read only those lines (2.2x OCR of a whole
                # terminal is the slowest part of a read); untouched lines keep their last reading
                kept = [w for w in term_prev[r] if all(w['y'] + w['h'] < cy0 - 2 or w['y'] > cy1 + 2 for _, _, cy0, cy1 in bands)]
                subs = [ex.submit(ocr_words, img.crop((r[0], max(r[1], y0), r[2], min(r[3], y1))), OCR_TIMEOUT_S, TERM_SCALE, (r[0], max(r[1], y0)))
                        for y0, y1, _, _ in bands if min(r[3], y1) - max(r[1], y0) >= 8]
                jobs[key] = ('sub', kept, subs)
            else:
                jobs[key] = ex.submit(ocr_words, crop, OCR_TIMEOUT_S, TERM_SCALE, (r[0], r[1]))
            term_now[key] = r
        if bands == 'all':
            fw = list(futs[0].result())
        else:
            def untouched(w):
                return all(w['y'] + w['h'] < cy0 - 2 or w['y'] > cy1 + 2 for _, _, cy0, cy1 in bands)
            fw = [w for w in prev['words'] if untouched(w)]
            for f in futs:
                fw += f.result()
        words = list(fw)
        term_words = {}
        for key, j in jobs.items():
            if isinstance(j, tuple):
                ws = list(j[1])
                for f in j[2]:
                    ws += f.result()
            else:
                ws = j if isinstance(j, list) else j.result()
            if key in term_now:
                term_words[term_now[key]] = ws
            if cache is not None:
                cache[key] = ws
                while len(cache) > 8:
                    cache.pop(next(iter(cache)))
            words += ws
    if prev is not None:
        prev['img'] = img
        prev['words'] = fw
        prev['term'] = term_words
        if bands == 'all':
            prev['full_at'] = time.time()
        prev['strip'] = 'all' if bands == 'all' else ('band' if bands else None)
        prev['read_rows'] = H if bands == 'all' else sum(y1 - y0 for y0, y1, _, _ in bands)
    return words, fw


def pointer_xy(display):
    try:
        p = subprocess.run(['timeout', '0.4', 'xdotool', 'getmouselocation', '--shell'], capture_output=True, timeout=0.6,
                           env=dict(os.environ, DISPLAY=display))
        g = dict(l.split('=', 1) for l in p.stdout.decode().split() if '=' in l)
        return int(g['X']), int(g['Y'])
    except Exception:
        return None


# ------------------------------------------------------------------ the loop
# Public picture rules (2026-10-13, after mama saw the card flash on every slow read):
#  * a frame that is merely LATE never becomes a card: the last good censored frame stays up until the next one
#    is ready (it was censored when it was taken, so holding it leaks nothing).
#  * the whole-screen card is only for real private states: sign-in page, inbox, keys/env terminal, mama's
#    takeover, a private sign-in window, or the censor itself dead for a long time. It comes on at once, stays
#    at least CARD_MIN_S, and leaves only after CARD_CLEAN_N clean reads in a row (no strobing).
#  * LIVE (OBS open, her Twitch live, or mama's "Live now" switch) = strict: longer card hold, more clean reads.
CARD_MIN_S, CARD_CLEAN_N = 3.0, 2
CARD_MIN_S_LIVE, CARD_CLEAN_N_LIVE = 5.0, 3
DEAD_CARD_S, DEAD_CARD_S_LIVE = 45.0, 15.0     # no fresh read at all for this long -> card (censor stuck/crashed)
OBS_SEEN_S = 20.0                               # an OBS (?obs=1) viewer polled within this -> live
LIVE_FILE = os.path.expanduser(os.environ.get('JENA_LIVE_FILE', '~/.jena/live.json'))
NICE = int(os.environ.get('JENA_CENSOR_NICE', '10'))


class Censor:
    def __init__(self, display=':99', fps=TARGET_FPS):
        self.display, self.period = display, 1.0 / max(0.2, fps)
        self.lock = threading.Lock()
        self.private = {}                 # reason -> True (forced: takeover, private sign-in, ...)
        self.frame = None                 # (jpeg, captured_at, meta) = the last GOOD censored frame
        self.seq = 0                      # bumps whenever what /box/shot.jpg serves changes
        self.meta = {'state': 'private', 'reason': 'starting', 'redactions': {}}
        self.card_reason, self.card_since, self.clean_run = None, 0.0, 0   # page-level card + hysteresis
        self.last_ok = 0.0                # last successful read (any verdict)
        self.cards = {}
        self.term_cache = {}
        self.prev = {}                    # last read frame + its words (memory only) for band re-reads
        self.cache = {}                   # pixel hash -> (img|None, meta)  (exact-same pixels only, last 4)
        self.times = []                   # publish times of NEW public frames, for the honest public fps
        self.reads = []                   # (t, ms, rows_read) of recent reads
        self.ocr_ms = None
        self.errors = 0
        self.thread = None
        self._last_logged = None
        self.stop = False
        self.obs_seen = 0.0
        self.live_cfg = self._load_live()
        self.twitch_live = None           # None = unknown / not configured
        self._tw_thread = None

    # -- live flag
    def _load_live(self):
        try:
            return json.load(open(LIVE_FILE))
        except Exception:
            return {'mama_live': False, 'twitch': None}

    def set_live(self, on=None, twitch=None):
        cfg = dict(self.live_cfg)
        if on is not None:
            cfg['mama_live'] = bool(on); cfg['mama_live_at'] = time.time()
        if twitch is not None:
            cfg['twitch'] = (re.sub(r'[^A-Za-z0-9_]', '', str(twitch))[:25] or None)
            self.twitch_live = None
        self.live_cfg = cfg
        try:
            os.makedirs(os.path.dirname(LIVE_FILE), exist_ok=True)
            tmp = LIVE_FILE + '.tmp'; json.dump(cfg, open(tmp, 'w')); os.replace(tmp, LIVE_FILE)
        except Exception:
            pass
        _log({'event': 'live_cfg', 'mama_live': cfg.get('mama_live'), 'twitch': bool(cfg.get('twitch'))})
        return self.live()

    def saw_obs(self):
        self.obs_seen = time.time()

    def live(self):
        why = []
        if time.time() - self.obs_seen < OBS_SEEN_S:
            why.append('obs')
        if self.twitch_live:
            why.append('twitch')
        if self.live_cfg.get('mama_live'):
            why.append('mama')
        return {'live': bool(why), 'why': why, 'mama_live': bool(self.live_cfg.get('mama_live')),
                'twitch': self.live_cfg.get('twitch'), 'twitch_live': self.twitch_live}

    def _twitch_loop(self):
        import urllib.request
        while not self.stop:
            ch = self.live_cfg.get('twitch')
            if ch:
                try:   # public, no key: "<ch> is offline" or an uptime like "1 hour, 2 minutes"
                    t = urllib.request.urlopen('https://decapi.me/twitch/uptime/' + ch, timeout=8).read().decode()[:200]
                    self.twitch_live = not re.search(r'(?i)offline|not found|error', t)
                except Exception:
                    pass
            else:
                self.twitch_live = None
            time.sleep(60)

    # -- control
    def start(self):
        if self.thread and self.thread.is_alive():
            return self
        self.thread = threading.Thread(target=self._run, name='jena-censor', daemon=True)
        self.thread.start()
        if self._tw_thread is None:
            self._tw_thread = threading.Thread(target=self._twitch_loop, name='jena-censor-twitch', daemon=True)
            self._tw_thread.start()
        return self

    def set_hold(self, reason, on=True):
        """Phone mode (jena_takeover.py): the public / OBS view HOLDS the last censored frame instead of a card,
        and nothing new is grabbed (her display is portrait for mama meanwhile). The held frame was censored when it
        was taken, so holding it leaks nothing. Real private reasons (set_private) still win over a hold."""
        with self.lock:
            holds = getattr(self, 'holds', None)
            if holds is None: holds = self.holds = set()
            if on: holds.add(reason)
            else: holds.discard(reason)
        _log({'event': 'hold_on' if on else 'hold_off', 'reason': reason})

    def set_private(self, reason, on=True):
        with self.lock:
            if on:
                self.private[reason] = True
                self.frame = None             # drop the last live frame at once: nothing from before is shown again
            else:
                self.private.pop(reason, None)
            self.seq += 1
        _log({'event': 'private_on' if on else 'private_off', 'reason': reason})

    def card(self, reason):
        if reason not in self.cards:
            self.cards[reason] = make_card(reason)
        return self.cards[reason]

    def _verdict(self, now=None):
        """-> (state, reason, frame). The single place that decides what the public sees."""
        now = now or time.time()
        with self.lock:
            forced = next(iter(self.private), None)
            fr, card = self.frame, self.card_reason
        live = self.live()['live']
        if forced:
            return 'private', forced, None
        if card:
            return 'private', card, None
        if fr is None:
            return 'private', (self.meta.get('reason') or 'starting'), None
        if getattr(self, 'holds', None):      # phone mode: the last good censored frame stays up, however old
            return 'live', None, fr
        if now - max(fr[1], self.last_ok) > (DEAD_CARD_S_LIVE if live else DEAD_CARD_S):
            return 'private', 'censor_lag', None
        return 'live', None, fr

    # -- public outputs (never raw)
    def jpeg(self):
        hdr = {'Cache-Control': 'no-store, max-age=0', 'Content-Type': 'image/jpeg'}
        try:
            if self.thread is None or not self.thread.is_alive():
                self.start()
            now = time.time()
            state, reason, fr = self._verdict(now)
            hdr['X-Censor-Seq'] = str(self.seq)
            if state != 'live':
                return self.card(reason), {**hdr, 'X-Censor-State': 'private', 'X-Censor-Reason': reason}
            return fr[0], {**hdr, 'X-Censor-State': 'live', 'X-Censor-Age-Ms': str(int((now - fr[1]) * 1000))}
        except Exception:
            return make_card('censor_error'), {**hdr, 'X-Censor-State': 'private', 'X-Censor-Reason': 'censor_error'}

    def status(self):
        now = time.time()
        state, reason, fr = self._verdict(now)
        ts = [t for t in self.times if now - t < 10]
        rd = [r for r in self.reads if now - r[0] < 30]
        lv = self.live()
        return {'state': state, 'reason': reason, 'reason_text': REASON_WORDS.get(reason) if reason else None,
                'age_ms': int((now - fr[1]) * 1000) if fr else None,
                'fps': round(len(ts) / 10, 2),                       # NEW public frames per second (honest)
                'ocr_ms': self.ocr_ms,
                'ocr_ms_avg': int(sum(r[1] for r in rd) / len(rd)) if rd else None,
                'read_frac': round(sum(r[2] for r in rd) / (len(rd) * 704), 2) if rd else None,
                'redactions': (fr[2].get('redactions') if fr and state == 'live' else {}),
                'seq': self.seq, 'live': lv['live'], 'live_why': lv['why'], 'strict': lv['live'],
                'hold': 'last_good_frame', 'mode': 'censored'}

    def status_json(self):
        return json.dumps(self.status()).encode()

    # -- worker
    def _run(self):
        try:   # this thread only: OCR must never starve her brain / voice
            os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), NICE)
        except Exception:
            pass
        while not self.stop:
            t0 = time.time()
            try:
                self._tick()
                self.errors = 0
            except Exception as e:
                # a failed or slow read is NOT a private moment: the last good frame stays up (DEAD_CARD_S guards a stuck censor)
                self.errors += 1
                self._log_state({'state': 'error', 'reason': 'censor_error'}, err=type(e).__name__)
                time.sleep(min(5, 0.5 * self.errors))
            dt = time.time() - t0
            time.sleep(max(0.02, self.period - dt))

    def _tick(self):
        with self.lock:
            forced = bool(self.private)
        if getattr(self, 'holds', None) and not forced:   # phone mode: grab nothing, keep the held frame
            return
        if forced:
            with self.lock:
                self.frame = None
            self.prev.clear()
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
            words, _ = read_screen(img, self.display, cache=self.term_cache, prev=self.prev)
            self.ocr_ms = int((time.time() - t) * 1000)
            self.reads = [r for r in self.reads[-60:] if time.time() - r[0] < 30] + [(time.time(), self.ocr_ms, self.prev.get('read_rows', img.height))]
            hit = sanitize_image(img, title, words)
            self.cache[key] = hit
            while len(self.cache) > 4:
                self.cache.pop(next(iter(self.cache)))
            fresh = True
        else:
            fresh = False
        W = img.width
        del img
        im, meta = hit
        now = time.time()
        self.last_ok = now
        lv = self.live()['live']
        min_s, clean_n = (CARD_MIN_S_LIVE, CARD_CLEAN_N_LIVE) if lv else (CARD_MIN_S, CARD_CLEAN_N)
        ptr = pointer_xy(self.display)
        jpg = encode(im, (ptr[0], ptr[1], W) if ptr else None) if im is not None else None
        with self.lock:
            if self.private:          # mama grabbed the wheel while we were reading: drop it
                self.frame = None
                return
            if jpg is None:           # a real private page: card on at once, clock restarts
                if self.card_reason != meta.get('reason'):
                    self.seq += 1
                self.card_reason, self.card_since, self.clean_run = meta.get('reason') or 'private_page', now, 0
                self.frame = None     # nothing from before the private page is shown again
            else:
                if self.card_reason:
                    self.clean_run += 1
                    if now - self.card_since >= min_s and self.clean_run >= clean_n:
                        self.card_reason = None
                if not self.card_reason:
                    same = self.frame is not None and self.frame[0] == jpg
                    self.frame = (jpg, captured_at, meta)
                    if not same:
                        self.seq += 1
                        self.times = [t for t in self.times[-60:] if now - t < 10] + [now]
        self.meta = meta
        self._log_state(meta)

    def _log_state(self, meta, err=None):
        sig = (meta.get('state'), meta.get('reason'), tuple(sorted((meta.get('redactions') or {}).items())), err)
        if sig != self._last_logged:      # log changes only; types + counts, never values
            self._last_logged = sig
            _log({'event': 'state', 'state': meta.get('state'), 'reason': meta.get('reason'),
                  'redactions': meta.get('redactions') or {}, **({'error': err} if err else {})})


# ------------------------------------------------------------------ doors for jena_desk.py (one hook in its client())
# GET  /box/shot.jpg[?since=SEQ][&obs=1]  censored frame; with since= it waits up to ~1.5 s for a newer one, 204 if none
# GET  /box/censor.json                   state / reason / honest public fps / live flag (no text, no values)
# GET  /box/live                          {live, why}
# POST /box/mama/live   {on, twitch}       mama only: her "Live now" switch (+ optional Twitch channel to watch)
# POST /box/mama/watch                    mama only: one-time 60 s token for /websockify-watch
# WS   /websockify-watch?t=TOKEN          mama's smooth VIEW-ONLY stream: the view-only x11vnc (5900 via 6080),
#                                         raw and full fps, never public, does NOT pause her or lock the public view
WS_VIEW = ('127.0.0.1', int(os.environ.get('WEBSOCKIFY_VIEW_PORT', '6080')))
watch_tokens = {}
CORS = (b'Access-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: X-Censor-State, X-Censor-Reason, '
        b'X-Censor-Age-Ms, X-Censor-Seq\r\n')


async def _send(writer, status, body, ctype='application/json', extra=None):
    reason = {200: 'OK', 204: 'No Content', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 502: 'Bad Gateway'}.get(status, 'OK')
    h = 'HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-store, max-age=0\r\nConnection: close\r\n' % (status, reason, ctype, len(body))
    for k, v in (extra or {}).items():
        if k.lower() not in ('content-type', 'cache-control'):
            h += '%s: %s\r\n' % (k, v)
    writer.write(h.encode('latin1') + CORS + b'\r\n' + body)
    try:
        await writer.drain()
    finally:
        writer.close()


async def _pipe(r, w):
    try:
        while True:
            b = await r.read(65536)
            if not b:
                break
            w.write(b); await w.drain()
    except Exception:
        pass
    finally:
        try: w.close()
        except Exception: pass


async def route(c, method, path, head, reader, writer, is_mama):
    """Handle the censor's own doors. Returns True when it answered (jena_desk.py then returns)."""
    import asyncio, secrets, urllib.parse
    p = path.split('?')[0]
    if p not in ('/box/shot.jpg', '/shot.jpg', '/box/censor.json', '/box/live', '/box/mama/live', '/box/mama/watch', '/websockify-watch'):
        return False
    if method == 'OPTIONS':
        return False                  # jena_desk answers preflights
    q = urllib.parse.parse_qs(path.split('?', 1)[1] if '?' in path else '')
    hdrs = {}
    for l in head.decode('latin1').split('\r\n')[1:]:
        if ':' in l:
            k, v = l.split(':', 1); hdrs[k.strip().lower()] = v.strip()
    if p == '/websockify-watch':
        tok = q.get('t', [''])[0]
        exp = watch_tokens.pop(tok, 0)
        if not tok or exp < time.time():
            writer.write(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); await writer.drain(); writer.close(); return True
        try:
            ur, uw = await asyncio.open_connection(*WS_VIEW)
        except Exception:
            writer.write(b'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); await writer.drain(); writer.close(); return True
        uw.write(head.replace(path.encode('latin1'), b'/websockify', 1)); await uw.drain()
        _log({'event': 'mama_watch_on'})
        try:
            await asyncio.gather(_pipe(reader, uw), _pipe(ur, writer))
        finally:
            _log({'event': 'mama_watch_off'})
        return True
    if p in ('/box/mama/live', '/box/mama/watch'):
        body = b''
        n = int(hdrs.get('content-length') or 0)
        if 0 < n < 8192:
            body = await reader.readexactly(n)
        if not is_mama(hdrs):
            await _send(writer, 401, json.dumps({'ok': False, 'summary': "mama's passcode is needed for this"}).encode()); return True
        if p == '/box/mama/watch':
            for t_, e_ in list(watch_tokens.items()):
                if e_ < time.time(): watch_tokens.pop(t_, None)
            tok = secrets.token_urlsafe(24); watch_tokens[tok] = time.time() + 60
            await _send(writer, 200, json.dumps({'ok': True, 'token': tok, 'path': '/websockify-watch?t=' + tok, 'valid_s': 60,
                                                 'private': bool(c.private.get('signin'))}).encode())
            return True
        try:
            b = json.loads(body or b'{}')
        except Exception:
            b = {}
        on = b.get('on') if 'on' in b else (None if 'twitch' in b else not c.live_cfg.get('mama_live'))   # bare call = toggle
        lv = c.set_live(on, b.get('twitch'))
        await _send(writer, 200, json.dumps({'ok': True, **lv}).encode()); return True
    if p == '/box/live':
        await _send(writer, 200, json.dumps(c.live()).encode()); return True
    if p == '/box/censor.json':
        await _send(writer, 200, c.status_json()); return True
    # the picture
    if q.get('obs', [''])[0] == '1':
        c.saw_obs()
    since = q.get('since', [None])[0]
    if since is not None:
        try:
            since = int(since)
        except ValueError:
            since = None
    if since is not None:
        t_end = time.time() + 1.5
        while c.seq == since and time.time() < t_end:
            await asyncio.sleep(0.04)
        if c.seq == since:
            await _send(writer, 204, b'', extra={'X-Censor-Seq': str(c.seq)}); return True
    body, hdr = c.jpeg()
    await _send(writer, 200, tag_jpeg(body, hdr), 'image/jpeg', hdr)
    return True


def tag_jpeg(body, hdr):
    """Put seq/state/reason in a JPEG comment right after SOI: proxies on the way (her gateway, the tunnel) drop
    custom headers, the bytes always arrive. The site reads it to long-poll (?since=seq). No screen content."""
    if not body or body[:2] != b'\xff\xd8':
        return body
    txt = ('jena-censor seq=%s state=%s reason=%s' % (hdr.get('X-Censor-Seq', ''), hdr.get('X-Censor-State', ''),
                                                      hdr.get('X-Censor-Reason', ''))).encode('ascii', 'replace')
    return body[:2] + b'\xff\xfe' + (len(txt) + 2).to_bytes(2, 'big') + txt + body[2:]


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
