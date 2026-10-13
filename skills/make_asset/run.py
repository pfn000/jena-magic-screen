# make_asset: Jena makes real assets: SVG icons (from the open Lucide (ISC) / Tabler (MIT) sets, restyled), buttons,
# badges, her own drawn logo/sigil, and procedural backgrounds. Every asset is a real .svg file plus a .png rendered
# locally (rsvg-convert), saved in ~/assets and listed in her dev-panel gallery. Button text color is chosen by real
# WCAG contrast math (her own critic rules apply to her own work).
import os, sys, re, json, time, math, random, subprocess, hashlib, html
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '_lib'))
from jenaskill import inp, done
HOME = os.path.expanduser('~')
LIB = os.path.join(HOME, 'library', 'src')
OUT = os.path.join(HOME, 'assets'); os.makedirs(OUT, exist_ok=True)
FONT = "Nunito, 'DejaVu Sans', system-ui, sans-serif"

NAMED = {'pink': '#ff7ac6', 'hot pink': '#ff3fa4', 'jena pink': '#ff7ac6', 'lavender': '#b9a6f5', 'purple': '#8b5cf6', 'violet': '#7c3aed', 'blue': '#3b82f6', 'navy': '#1e3a8a',
         'sky': '#38bdf8', 'cyan': '#06b6d4', 'teal': '#14b8a6', 'green': '#22c55e', 'mint': '#6ee7b7', 'lime': '#a3e635', 'neon green': '#39ff14', 'yellow': '#facc15',
         'gold': '#f59e0b', 'orange': '#f97316', 'red': '#ef4444', 'crimson': '#be123c', 'brown': '#92400e', 'black': '#111111', 'white': '#ffffff', 'gray': '#6b7280',
         'grey': '#6b7280', 'silver': '#cbd5e1', 'peach': '#fdba74', 'coral': '#fb7185', 'magenta': '#d946ef', 'indigo': '#6366f1'}
WORDS = {'like': 'heart', 'love': 'heart', 'fav': 'star', 'favorite': 'star', 'follow': 'user-plus', 'subscribe': 'bell', 'notification': 'bell', 'settings': 'settings', 'gear': 'settings',
         'home': 'house', 'house': 'house', 'search': 'search', 'chat': 'message-circle', 'message': 'message-circle', 'mic': 'mic', 'microphone': 'mic', 'sound': 'volume-2', 'volume': 'volume-2',
         'music': 'music', 'game': 'gamepad-2', 'gaming': 'gamepad-2', 'controller': 'gamepad-2', 'code': 'code', 'terminal': 'terminal', 'bug': 'bug', 'cat': 'cat', 'dog': 'dog', 'bunny': 'rabbit',
         'rabbit': 'rabbit', 'moon': 'moon', 'sun': 'sun', 'star': 'star', 'heart': 'heart', 'rocket': 'rocket', 'fire': 'flame', 'flame': 'flame', 'crown': 'crown', 'skull': 'skull', 'ghost': 'ghost',
         'camera': 'camera', 'video': 'video', 'live': 'radio', 'stream': 'radio', 'download': 'download', 'upload': 'upload', 'share': 'share-2', 'trash': 'trash-2', 'delete': 'trash-2',
         'edit': 'pencil', 'pencil': 'pencil', 'brain': 'brain', 'robot': 'bot', 'bot': 'bot', 'sparkle': 'sparkles', 'sparkles': 'sparkles', 'magic': 'wand-sparkles', 'lock': 'lock', 'key': 'key',
         'play': 'play', 'pause': 'pause', 'check': 'check', 'close': 'x', 'menu': 'menu', 'user': 'user', 'profile': 'user', 'calendar': 'calendar', 'clock': 'clock', 'cloud': 'cloud',
         'coffee': 'coffee', 'gift': 'gift', 'trophy': 'trophy', 'shield': 'shield', 'zap': 'zap', 'lightning': 'zap', 'flower': 'flower', 'paint': 'palette', 'palette': 'palette', 'book': 'book-open'}

def hex2rgb(h):
    h = h.lstrip('#'); h = ''.join(c * 2 for c in h) if len(h) == 3 else h
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
def rgb2hex(c): return '#%02x%02x%02x' % tuple(max(0, min(255, int(round(x)))) for x in c)
def lum(h):
    def f(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = hex2rgb(h); return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
def contrast(a, b):
    la, lb = lum(a), lum(b); return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
def shade(h, k):
    r, g, b = hex2rgb(h)
    return rgb2hex((r * k, g * k, b * k)) if k < 1 else rgb2hex((r + (255 - r) * (k - 1), g + (255 - g) * (k - 1), b + (255 - b) * (k - 1)))
def ink(bg):
    dark, light = '#1f0a1a', '#ffffff'
    return (dark, contrast(dark, bg)) if contrast(dark, bg) >= contrast(light, bg) else (light, contrast(light, bg))

def colors_in(t):
    out = re.findall(r'#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b', t)
    low = t.lower()
    for name in sorted(NAMED, key=len, reverse=True):
        if re.search(r'\b' + re.escape(name) + r'\b', low): out.append(NAMED[name]); low = low.replace(name, ' ')
    return out

def find_icon(q):
    q = q.lower().strip()
    lu = os.path.join(LIB, 'lucide', 'icons'); ta = os.path.join(LIB, 'tabler', 'icons', 'outline')
    stop = ('a', 'an', 'the', 'icon', 'of', 'for', 'with', 'my', 'me', 'make', 'cute', 'little', 'simple', 'jena', 'app', 'in', 'and', 'draw', 'please')
    words = [w for w in re.findall(r'[a-z0-9]+', q) if w not in stop and w not in NAMED]
    for w in list(words):
        if w in WORDS: words.insert(0, WORDS[w]); break
    for w in words:
        if os.path.exists(os.path.join(lu, w + '.svg')): return 'lucide', w, os.path.join(lu, w + '.svg')
    for w in words:
        if os.path.exists(os.path.join(ta, w + '.svg')): return 'tabler', w, os.path.join(ta, w + '.svg')
    best = None
    for f in os.listdir(lu):
        if not f.endswith('.json'): continue
        try: meta = json.load(open(os.path.join(lu, f)))
        except Exception: continue
        name = f[:-5]; tags = set(meta.get('tags', [])) | set(name.split('-'))
        score = sum(2 if w in name.split('-') else 1 for w in words if w in tags)
        if score and (best is None or score > best[0] or (score == best[0] and len(name) < len(best[1]))): best = (score, name)
    if best: return 'lucide', best[1], os.path.join(lu, best[1] + '.svg')
    return None

def inner(svgtext):
    m = re.search(r'<svg[^>]*>(.*)</svg>', svgtext, re.S)
    return m.group(1).strip() if m else ''

def save(slug, svg, kind, title, base=None, license=None, extra=None, px=512):
    ts = int(time.time()); name = (time.strftime('%Y%m%d-%H%M%S') + '-' + slug)[:60]
    sp = os.path.join(OUT, name + '.svg'); open(sp, 'w').write(svg)
    pp = os.path.join(OUT, name + '.png')
    w_ = re.search(r'width="(\d+)"', svg); h_ = re.search(r'height="(\d+)"', svg)
    w0, h0 = (int(w_.group(1)), int(h_.group(1))) if w_ and h_ else (24, 24)
    sc = px / max(w0, h0)
    r = subprocess.run(['rsvg-convert', '-w', str(round(w0 * sc)), '-h', str(round(h0 * sc)), '-o', pp, sp], capture_output=True, text=True, timeout=30)
    png = os.path.basename(pp) if r.returncode == 0 and os.path.exists(pp) else None
    rec = {'ts': ts, 'title': title, 'kind': kind, 'svg': os.path.basename(sp), 'png': png, 'png_px': ('%dx%d' % (round(w0 * sc), round(h0 * sc))) if png else None,
           'base': base, 'license': license, 'bytes': len(svg)}
    rec.update(extra or {})
    if not png: rec['png_error'] = (r.stderr or 'rsvg-convert failed')[-200:]
    with open(os.path.join(OUT, 'index.jsonl'), 'a') as f: f.write(json.dumps(rec) + '\n')
    return rec

def make_icon(t, cols):
    hit = find_icon(re.sub(r'^.*?\b(icon|emoji|symbol)\b\s*(of|for)?', '', t, flags=re.I) or t) or find_icon(t)
    if not hit: return None, 'no icon in Lucide (1,890) or Tabler (5,184) matches that, so I did not fake one'
    src, name, path = hit
    body = inner(open(path).read())
    fg = cols[0] if cols else '#ff7ac6'
    app = bool(re.search(r'\b(app icon|app-icon|tile|squircle|with background|filled)\b', t, re.I))
    sw = '1.75' if 'thin' in t.lower() else '2.5' if re.search(r'\b(bold|thick|chunky)\b', t, re.I) else '2'
    lab = html.escape(name)
    if app:
        bg = fg; fg2, cr = ink(bg)
        if len(cols) > 1: fg2 = cols[1]
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="%s icon">\n'
               '  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="%s"/><stop offset="1" stop-color="%s"/></linearGradient></defs>\n'
               '  <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#g)"/>\n  <rect x="8" y="8" width="240" height="120" rx="58" fill="#fff" opacity=".12"/>\n'
               '  <g transform="translate(56 56) scale(6)" fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round">%s</g>\n</svg>') % (lab, shade(bg, 1.25), shade(bg, .82), fg2, sw, body)
        note = '%s app-icon tile, glyph %s on %s (contrast %.1f:1)' % (name, fg2, bg, contrast(fg2, bg))
    else:
        svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="%s icon">%s</svg>' % (fg, sw, lab, body)
        note = '%s line icon, stroke %s, width %s' % (name, fg, sw)
    lic = 'ISC (Lucide)' if src == 'lucide' else 'MIT (Tabler)'
    return save('icon-' + name, svg, 'icon', name + ' icon', base=src + ':' + name, license=lic), note

LABEL_RE = r'(?:says?|saying|text|labell?ed|reads?)\s*[:"\u201c\']?\s*([^"\u201d\'\n]{1,28})'
QUOTE_RE = r'["\u201c]([^"\u201d]{1,28})["\u201d]'

def make_button(t, cols):
    m = re.search(QUOTE_RE, t) or re.search(LABEL_RE, t, re.I)
    label = (m.group(1).strip(' .!?') if m else 'Click me')
    label = re.split(r'\s+(?:with|in)\s+(?:a |an )?\S+ (?:icon|color|background)\b|\s+in\s+(?:#|' + '|'.join(NAMED) + r')\b', label, flags=re.I)[0][:28].strip() or 'Click me'
    bg = cols[0] if cols else '#ff7ac6'
    fg, cr = ink(bg)
    ic = None
    im = re.search(r'\bwith (?:a |an )?([a-z-]+) icon\b', t, re.I)
    if im: ic = find_icon(im.group(1))
    pad, fs = 28, 20
    tw = int(len(label) * fs * 0.6) + 2
    iw = 30 if ic else 0
    w, h = pad * 2 + tw + iw, 56
    ghost = bool(re.search(r'\b(outline|ghost|secondary)\b', t, re.I))
    if ghost:
        tcol = bg; cr = contrast(bg, '#ffffff')
        if cr < 4.5: tcol = shade(bg, .55); cr = contrast(tcol, '#ffffff')
        fill = '<rect x="1.5" y="1.5" width="%d" height="%d" rx="%.1f" fill="#fff" stroke="%s" stroke-width="3"/>' % (w - 3, h - 3, (h - 3) / 2, tcol)
    else:
        tcol = fg
        fill = ('<defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="%s"/><stop offset="1" stop-color="%s"/></linearGradient></defs>\n'
                '  <rect x="0" y="3" width="%d" height="%d" rx="%.1f" fill="%s"/>\n  <rect x="0" y="0" width="%d" height="%d" rx="%.1f" fill="url(#b)"/>') % (shade(bg, 1.12), shade(bg, .9), w, h - 3, (h - 3) / 2, shade(bg, .7), w, h - 3, (h - 3) / 2)
        cr = min(contrast(tcol, shade(bg, 1.12)), contrast(tcol, shade(bg, .9)))
    icon_svg = ''
    if ic:
        icon_svg = '<g transform="translate(%d %.1f) scale(%.4f)" fill="none" stroke="%s" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">%s</g>' % (pad, (h - 3 - 22) / 2, 22 / 24, tcol, inner(open(ic[2]).read()))
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" role="img" aria-label="%s">\n  %s\n  %s\n'
           '  <text x="%.1f" y="%.1f" text-anchor="middle" font-family="%s" font-size="%d" font-weight="800" fill="%s">%s</text>\n</svg>') % (
        w, h, w, h, html.escape(label), fill, icon_svg, pad + iw + tw / 2, (h - 3) / 2 + 7, FONT, fs, tcol, html.escape(label))
    css = ('.jena-btn { display:inline-flex; align-items:center; gap:8px; min-height:48px; padding:0 %dpx; border-radius:999px; border:%s;\n'
           '  background:%s; color:%s; font:800 1.25rem/1 %s; box-shadow:%s; cursor:pointer; }\n'
           '.jena-btn:hover { filter:brightness(1.05); }\n.jena-btn:active { transform:translateY(2px); box-shadow:none; }\n'
           '.jena-btn:focus-visible { outline:3px solid %s; outline-offset:3px; }\n'
           '/* <button class="jena-btn">%s</button>  text contrast %.1f:1 (WCAG AA needs 4.5:1); 48px min height (WCAG 2.5.8 needs 24px) */\n') % (
        pad, ('3px solid ' + tcol) if ghost else '0', '#fff' if ghost else 'linear-gradient(%s, %s)' % (shade(bg, 1.12), shade(bg, .9)), tcol, FONT,
        'none' if ghost else '0 3px 0 ' + shade(bg, .7), shade(bg, .55), html.escape(label), cr)
    slug = 'button-' + re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-')[:20]
    rec = save(slug, svg, 'button', '"%s" button' % label, base=('%s:%s icon' % (ic[0], ic[1])) if ic else 'drawn by her',
               license=('ISC (Lucide)' if ic[0] == 'lucide' else 'MIT (Tabler)') if ic else None, extra={'contrast': round(cr, 2), 'css': rec_css_name(slug)})
    open(os.path.join(OUT, rec['svg'][:-4] + '.css'), 'w').write(css)
    rec['css'] = rec['svg'][:-4] + '.css'
    return rec, '"%s" button, %s with %s text (contrast %.1f:1, %s AA), 48px tall, CSS + focus style included' % (label, bg, tcol, cr, 'passes' if cr >= 4.5 else 'FAILS')

def rec_css_name(slug): return None

def make_badge(t, cols):
    m = re.search(QUOTE_RE, t) or re.search(LABEL_RE, t, re.I)
    label = (m.group(1).strip(' .!?') if m else 'LIVE')
    label = re.split(r'\s+in\s+', label)[0][:22] or 'LIVE'
    bg = cols[0] if cols else '#e11d48'; fg, cr = ink(bg)
    w = int(len(label) * 13 * 0.72) + 44
    live = bool(re.search(r'\blive\b', label, re.I))
    dot = '<circle cx="17" cy="16" r="5" fill="%s"/>' % fg if live else ''
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="32" viewBox="0 0 %d 32" role="img" aria-label="%s">\n  <rect width="%d" height="32" rx="16" fill="%s"/>%s\n'
           '  <text x="%.1f" y="21" text-anchor="middle" font-family="%s" font-size="13" font-weight="800" letter-spacing="1" fill="%s">%s</text>\n</svg>') % (
        w, w, html.escape(label), w, bg, dot, (w + (14 if live else 0)) / 2, FONT, fg, html.escape(label.upper()))
    return save('badge-' + re.sub(r'[^a-z0-9]+', '-', label.lower())[:16], svg, 'badge', '"%s" badge' % label, base='drawn by her', extra={'contrast': round(cr, 2)}, px=256), '"%s" pill badge, %s on %s (%.1f:1)' % (label, fg, bg, cr)

def make_logo(t, cols):
    m = re.search(r'\b(?:for|called|named|says?)\s+["\u201c]?([A-Za-z0-9]+(?: [A-Z][A-Za-z0-9]*)?)', t)
    name = (m.group(1).strip() if m else 'Jena')
    letters = ''.join(w[0] for w in name.split())[:2].upper() or 'J'
    a = cols[0] if cols else '#ff7ac6'; b = cols[1] if len(cols) > 1 else '#b9a6f5'
    rnd = random.Random(int(hashlib.md5(name.encode()).hexdigest()[:8], 16))
    n = 8; pts = []
    for i in range(n):
        ang = i / n * 2 * math.pi; rr = 92 + rnd.uniform(-12, 12)
        pts.append((128 + rr * math.cos(ang), 128 + rr * math.sin(ang)))
    mids = [((pts[i][0] + pts[(i + 1) % n][0]) / 2, (pts[i][1] + pts[(i + 1) % n][1]) / 2) for i in range(n)]
    path = 'M%.1f,%.1f ' % mids[-1] + ' '.join('Q%.1f,%.1f %.1f,%.1f' % (pts[i][0], pts[i][1], mids[i][0], mids[i][1]) for i in range(n)) + ' Z'
    fg, cr = ink(a)
    cr = min(cr, contrast(fg, b))
    if cr < 4.5:
        fg = '#1f0a1a' if contrast('#1f0a1a', a) + contrast('#1f0a1a', b) > contrast('#ffffff', a) + contrast('#ffffff', b) else '#ffffff'; cr = min(contrast(fg, a), contrast(fg, b))
    sparks = ''.join('<path d="M%d %dl2.5 6 6 2.5-6 2.5-2.5 6-2.5-6-6-2.5 6-2.5z" fill="#fff" opacity=".95"/>' % (x, y - 8) for x, y in [(rnd.randint(165, 200), rnd.randint(50, 75)), (rnd.randint(55, 85), rnd.randint(180, 200))])
    fs = 92 if len(letters) == 1 else 72
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="%s logo">\n'
           '  <defs><linearGradient id="l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="%s"/><stop offset="1" stop-color="%s"/></linearGradient></defs>\n'
           '  <path d="%s" fill="url(#l)"/>\n  <path d="%s" fill="none" stroke="%s" stroke-width="5" opacity=".35"/>\n  %s\n'
           '  <text x="128" y="%d" text-anchor="middle" font-family="%s" font-size="%d" font-weight="900" fill="%s">%s</text>\n</svg>') % (
        html.escape(name), a, b, path, path, shade(a, .6), sparks, 128 + fs * 0.35, FONT, fs, fg, html.escape(letters))
    return save('logo-' + re.sub(r'[^a-z0-9]+', '-', name.lower())[:16], svg, 'logo', name + ' logo', base='drawn by her (seeded blob + monogram)', extra={'contrast': round(cr, 2)}), '%s monogram "%s" on a seeded blob, %s to %s gradient, letter contrast %.1f:1' % (name, letters, a, b, cr)

def make_background(t, cols):
    a = cols[0] if cols else '#ffd6ef'; b = cols[1] if len(cols) > 1 else '#d9ccff'
    W, H = 1280, 720; rnd = random.Random(int(time.time()))
    kind = 'waves' if re.search(r'\bwav', t, re.I) else 'dots' if re.search(r'\b(dot|polka|grid)', t, re.I) else 'blobs'
    if kind == 'waves':
        body = ''
        for i in range(4):
            y0 = 360 + i * 70; amp = 30 + i * 8; ph = rnd.uniform(0, 6.28)
            d = 'M0 %d ' % y0 + ' '.join('L%d %.1f' % (x, y0 + amp * math.sin(x / 180 + ph)) for x in range(0, W + 40, 40)) + ' L%d %d L0 %d Z' % (W, H, H)
            body += '<path d="%s" fill="%s" opacity="%.2f"/>' % (d, shade(b, 1 - i * .08), .35 + i * .15)
    elif kind == 'dots':
        body = '<pattern id="p" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="16" cy="16" r="3" fill="%s" opacity=".6"/></pattern><rect width="%d" height="%d" fill="url(#p)"/>' % (shade(b, .8), W, H)
    else:
        body = ''.join('<circle cx="%d" cy="%d" r="%d" fill="%s" opacity=".55" filter="url(#f)"/>' % (rnd.randint(0, W), rnd.randint(0, H), rnd.randint(140, 320), rnd.choice([a, b, shade(a, .9), shade(b, 1.1)])) for _ in range(6))
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">\n'
           '  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="%s"/><stop offset="1" stop-color="%s"/></linearGradient><filter id="f"><feGaussianBlur stdDeviation="60"/></filter></defs>\n'
           '  <rect width="%d" height="%d" fill="url(#bg)"/>%s\n</svg>') % (W, H, W, H, a, b, W, H, body)
    return save('bg-' + kind, svg, 'background', kind + ' background', base='procedural (drawn by her code)', px=1280), '%s background %dx%d, %s to %s' % (kind, W, H, a, b)

def main():
    i = inp(); t = str(i.get('text') or i.get('query') or '')
    cols = colors_in(t)
    low = t.lower()
    if re.search(r'\b(photo|realistic|photoreal|painting|portrait|picture of a person|selfie|render of)\b', low) and not re.search(r'\b(icon|button|badge|logo|svg)\b', low):
        done(False, "I can't make photos or paintings here: my box has no GPU, so I make real vector assets (icons, buttons, badges, logos, backgrounds) as SVG + PNG. A tiny local image model (bk-sdm-tiny) was tested on my box: 20 s for a 256 px picture, 110 s for 512 px, 3.7 GB of RAM, and the pictures came out as mush, so it's switched off.")
    if re.search(r'\bbutton\b', low): rec, note = make_button(t, cols)
    elif re.search(r'\b(badge|pill|sticker)\b', low): rec, note = make_badge(t, cols)
    elif re.search(r'\b(logo|sigil|monogram|emblem)\b', low): rec, note = make_logo(t, cols)
    elif re.search(r'\b(background|wallpaper|pattern|backdrop|waves?|wavy|blobs?)\b', low): rec, note = make_background(t, cols)
    else:
        rec, note = make_icon(t, cols)
        if rec is None: done(False, note)
    ok = bool(rec.get('png'))
    say = "Made it: %s. Real SVG + %s PNG, it's in my assets gallery." % (note, rec.get('png_px') or 'no') + (" Base: %s (%s)." % (rec['base'], rec['license']) if rec.get('license') else '')
    steps = ['🎨 ' + note, '📁 ~/assets/' + rec['svg'] + ((' + %s (%s, rendered locally with rsvg)' % (rec['png'], rec['png_px'])) if ok else ' (PNG failed: %s)' % rec.get('png_error'))]
    if rec.get('license'): steps.append('📜 base icon %s, license %s' % (rec['base'], rec['license']))
    done(True, 'made %s (%s): %s' % (rec['title'], rec['kind'], note), say=say, steps=steps, asset=rec, facts='made %s: %s; files %s, %s' % (rec['title'], note, rec['svg'], rec.get('png')))

main()
