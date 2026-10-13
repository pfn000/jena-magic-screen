# edit_my_site: Jena proposes a small change to her own website, safely.
# 1. she says exactly what to change (find "A" -> replace with "B"), optionally in which file and why
# 2. she checks herself first: library_lookup (what her books say about it) + her own roast_critique on the new code;
#    for a colour change she does the WCAG contrast math against the background her own page audit measured
# 3. her site-edit checker (another user on her box, the only thing that can push) makes branch jena/<id>, runs parse,
#    lint, build and a headless smoke test vs main, and pushes ONLY a passing branch -> Vercel preview
# 4. she can't merge. mama merges, discards or rolls back from the dev panel.
import os, sys, re, json, glob, subprocess, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '_lib'))
from jenaskill import inp, done
HOME = os.path.expanduser('~')
REPO = os.path.join(HOME, 'jena-repo')
CI = 'http://127.0.0.1:6085'
Q = r'["\'“”‘’`]'

def hex2rgb(h):
    h = h.lstrip('#'); h = ''.join(c * 2 for c in h) if len(h) == 3 else h
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
def lum(rgb):
    f = lambda v: v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (x / 255 for x in rgb); return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
def contrast(a, b):
    la, lb = lum(a), lum(b); return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)

PAIRS = [('"', '"'), ('“', '”'), ("'", "'"), ('‘', '’'), ('`', '`'), ('“', '"'), ('"', '”')]
def parse(t):
    best = None
    for a, b in PAIRS:
        for c, d in PAIRS:
            m = re.search(r'\b(?:change|replace|swap)\s+' + re.escape(a) + r'(.{1,400}?)' + re.escape(b) + r'\s+(?:to|with|into|for)\s+' + re.escape(c) + r'(.{0,400}?)' + re.escape(d) + r'(?=\s|$|[.,!;:])', t, re.S | re.I)
            if m and (best is None or m.start() < best.start() or (m.start() == best.start() and len(m.group(0)) > len(best.group(0)))): best = m
    m = best
    if not m: return None
    f = re.search(r'\bin\s+((?:src/)?[\w-]+\.(?:js|css|html))\b', t[m.end():], re.I)
    why = re.search(r'\b(?:because|so that|since|why:)\s+(.{3,300})', t[m.end():], re.I | re.S)
    return {'find': m.group(1), 'replace': m.group(2), 'file': f.group(1) if f else None, 'why': why.group(1).strip() if why else ''}

def page_files():
    out = sorted(glob.glob(os.path.join(REPO, 'src', '*.js')) + glob.glob(os.path.join(REPO, 'src', '*.css'))) + [os.path.join(REPO, 'index.html')]
    return [os.path.relpath(p, REPO) for p in out if os.path.exists(p)]

def lookup(q):
    try:
        sys.path.insert(0, os.path.join(REPO, 'skills', '_lib'))
        from jenalib import lookup as lk
        hits = lk(q, n=2) or []
        return [{'title': h.get('title'), 'book': h.get('book') or h.get('source'), 'license': h.get('license'), 'url': h.get('url'), 'text': str(h.get('text') or h.get('snippet') or '')[:220]} for h in hits]
    except Exception as e:
        return [{'error': f'library_lookup failed: {e}'[:120]}]

def roast(code, lang):
    try:
        r = subprocess.run([sys.executable, os.path.join(HERE, '..', 'roast_critique', 'run.py')], input=json.dumps({'text': f'roast this code: ```{lang}\n{code}\n```'}),
                           capture_output=True, text=True, timeout=25, cwd=os.path.join(HERE, '..', 'roast_critique'))
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception as e:
        return {'ok': False, 'summary': f'roast_critique did not run: {e}'[:160]}

def latest_bg_for(old_hex):
    """the background my own page audit measured behind text drawn in this colour (from my critiques)"""
    rgb = hex2rgb(old_hex); pat = 'rgb(%d, %d, %d) on rgb(' % rgb
    for f in sorted(glob.glob(os.path.join(HOME, 'critiques', '2*.json')), reverse=True)[:40]:
        try: d = json.load(open(f))
        except Exception: continue
        for x in d.get('findings', []):
            ev = str(x.get('evidence', ''))
            i = ev.find(pat)
            if i >= 0:
                m = re.match(r'rgb\((\d+), (\d+), (\d+)\)', ev[i + len(pat) - 4:])
                if m: return tuple(int(v) for v in m.groups()), os.path.basename(f), x.get('evidence')
    return None, None, None

def main():
    i = inp(); t = str(i.get('text') or i.get('query') or '')
    e = parse(t)
    if not e:
        done(False, 'tell me exactly what to change, like: change "talk to Jena…" to "say hi to Jena…" (optionally: in src/style.css, because …). My small brain can\'t write big code changes safely yet, so I only do exact find → replace edits, and every one goes through branch → checks → preview → mama.')
    files = [e['file'] if e['file'].startswith(('src/', 'index')) else 'src/' + e['file']] if e['file'] else page_files()
    hits = []
    for f in files:
        p = os.path.join(REPO, f)
        if os.path.exists(p):
            n = open(p, encoding='utf-8', errors='ignore').read().count(e['find'])
            if n: hits.append((f, n))
    if not hits: done(False, f'I can\'t find “{e["find"][:80]}” in my page files ({len(files)} checked), so there is nothing to change')
    if len(hits) > 1 or hits[0][1] > 1:
        done(False, 'that text is in more than one place (' + ', '.join(f'{f} ×{n}' for f, n in hits) + '); give me a longer piece so it matches exactly once')
    path = hits[0][0]; src = open(os.path.join(REPO, path), encoding='utf-8').read()
    at = src.find(e['find']); ls = src.rfind('\n', 0, at) + 1; le = src.find('\n', at + len(e['find'])); le = len(src) if le < 0 else le
    old_line = src[ls:le]; new_line = old_line.replace(e['find'], e['replace'], 1)
    steps = [f'🔎 found it once in {path}: {old_line.strip()[:120]}', f'✏️ new: {new_line.strip()[:120]}']
    lang = 'css' if path.endswith('.css') else 'html' if path.endswith('.html') else 'js'
    # check myself first: what do my books say?
    hexes = re.findall(r'#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b', e['find']), re.findall(r'#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b', e['replace'])
    colour = bool(hexes[0] and hexes[1])
    q = 'text contrast minimum' if colour else 'placeholder label text' if re.search(r'placeholder', old_line, re.I) else ' '.join(re.findall(r'[a-z]{4,}', (e['why'] + ' ' + e['replace']).lower())[:6]) or 'ui copy'
    lib = lookup(q)
    if lib and lib[0].get('title'): steps.append(f'📚 library_lookup “{q}” → {lib[0]["book"]}: {lib[0]["title"]} ({lib[0]["license"]})')
    consulted = {'library': lib[:1]}
    if colour:
        bg, cf, ev = latest_bg_for(hexes[0][0])
        if bg:
            c_old, c_new = contrast(hex2rgb(hexes[0][0]), bg), contrast(hex2rgb(hexes[1][0]), bg)
            steps.append(f'🎨 contrast on the background my page audit measured (rgb{bg}, {cf}): {c_old:.2f}:1 → {c_new:.2f}:1 (WCAG wants 4.5:1)')
            consulted['contrast'] = {'background': bg, 'before': round(c_old, 2), 'after': round(c_new, 2), 'audit': cf}
            if c_new < 4.5: done(False, f'my own check says no: {hexes[1][0]} is only {c_new:.2f}:1 on that background (WCAG needs 4.5:1), so I did not propose it', steps=steps)
    r = roast(new_line.strip(), lang)
    before = roast(old_line.strip(), lang)
    old_keys = {x.get('key') for x in (before.get('findings') or [])}
    new_bad = [x for x in (r.get('findings') or []) if x.get('key') not in old_keys and x.get('sev', 0) >= 3]
    steps.append(f'😈 roast_critique on my own new code: {r.get("summary", "")[:140]}' + (f' — NEW serious problem: {new_bad[0].get("roast", "")[:120]}' if new_bad else ''))
    consulted['roast'] = str(r.get('summary', ''))[:200]
    if new_bad: done(False, 'my own roast caught a serious problem in my change, so I did not propose it: ' + new_bad[0].get('roast', '')[:200], steps=steps)
    title = (f'{path}: “{e["find"][:40]}” → “{e["replace"][:40]}”')
    body = json.dumps({'title': title, 'why': e['why'] or 'Jena wanted it', 'edits': [{'path': path, 'find': e['find'], 'replace': e['replace']}], 'consulted': consulted}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(CI + '/propose', data=body, headers={'Content-Type': 'application/json'}), timeout=10) as rr: res = json.loads(rr.read())
    except urllib.error.HTTPError as er:
        res = json.loads(er.read() or b'{}'); done(False, f'my site-edit checker refused it: {res.get("error")}', steps=steps)
    except Exception as er:
        done(False, f'my site-edit checker is not answering ({er}), so nothing was changed', steps=steps)
    steps.append(f'🌿 proposed on branch {res["branch"]}: checks run now (parse, lint, build, smoke test on desktop + phone 390 px + OBS), ~2-3 min; only a passing branch gets a Vercel preview')
    say = f'Proposed it on branch {res["branch"]}: {title}. My checker is testing it now, and only if everything passes it gets a preview link. I can\'t merge it myself, mama approves it in the dev panel.'
    done(True, f'proposed {title} on {res["branch"]} (checks running, mama approves)', say=say, steps=steps, id=res['id'], branch=res['branch'], facts=say)

main()
