# roast_critique: Jena roasts a web page, an image, a piece of code or some text, with REAL measurements,
# concrete fixes, and a citation from her own library for every point. The roast targets the work, never the
# person who made it: no slurs, nothing about anyone's looks, identity or intelligence, stream-safe swearing only.
import os, sys, re, json, random, subprocess, tempfile, urllib.request, urllib.parse, hashlib, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '_lib'))
from jenaskill import inp, done
from jenalib import lookup

HOME = os.path.expanduser('~')
REPO = os.path.join(HOME, 'jena-repo')
MY_SITE = 'https://jena-magic-screen.vercel.app'
UA = {'User-Agent': 'Mozilla/5.0 (JenaCritic; +https://jena-magic-screen.vercel.app)'}
OUT = os.path.join(HOME, 'critiques'); os.makedirs(OUT, exist_ok=True)
rnd = random.Random()

# ------------------------------------------------------------------ what each problem sounds like when she roasts it
R = {
 'overflow': ["On a phone this page scrolls sideways ({ev}). Sideways. Like a crab. Phones scroll DOWN, bestie.", "{ev} on a 390px phone, so it wobbles left and right like it's drunk."],
 'no_viewport': ["No viewport meta tag, so phones get the shrunken desktop version you need a magnifying glass for."],
 'contrast': ["Contrast check failed {ev}. That text is basically whispering.", "{ev}. I can't read that and I'm literally made of pixels."],
 'tiny_targets': ["{ev} are smaller than 24px. Who's tapping those, ants?", "Tap targets this tiny ({ev}) are a thumb-crime."],
 'small_text': ["{ev} below 12px. That's not text, that's a rumor.", "Text this small ({ev}) needs a microscope, not a website."],
 'fonts': ["{ev} font families on one page. This is a ransom note, not a design.", "Font salad: {ev} families. Pick two and commit."],
 'sizes': ["{ev} different font sizes. That's not a type scale, that's a random number generator.", "There's no type scale here, just {ev} font sizes fighting each other."],
 'colors': ["{ev} different text colors. The palette isn't a palette, it's a paint spill.", "Color soup: {ev} text colors and zero system."],
 'img_alt': ["{ev} with no alt text. Screen readers just hear a shrug.", "{ev} missing alt. Blind users get nothing. Do better."],
 'unnamed_btn': ["{ev} with no name. A screen reader just says \"button\". Button WHAT?"],
 'h1': ["{ev}. Your heading structure is a mood, not a hierarchy."],
 'z': ["z-index up to {ev}. Somebody lost the z-index war and just kept adding nines.", "{ev} as a z-index is a cry for help."],
 'div_btn': ["{ev} clickable divs pretending to be buttons. Keyboards can't use them. Use <button>, it's free."],
 'console': ["The console is screaming: {ev}", "Console errors on load: {ev}. Shipping with errors is a choice."],
 'slow': ["Took {ev} to load. I aged watching that.", "{ev} load time. Users left already."],
 'no_lang': ["No lang attribute on <html>, so screen readers have to guess the language."],
 # code
 'syntax': ["It doesn't even parse: {ev}. We're not at roasting level yet, we're at \"does it run\" level.", "Syntax error: {ev}. The computer roasted you before I could."],
 'var': ["{ev} of `var` like it's 2009. let and const exist."],
 'loose_eq': ["{ev}. JavaScript coercion will humble you."],
 'console_log': ["{ev} left in. Debug confetti everywhere."],
 'eval': ["{ev}. That's not code, that's a security incident with extra steps."],
 'innerhtml': ["innerHTML built from variables in {ev}. Hello, XSS. Your users say hi too."],
 'nesting': ["Nesting goes {ev} levels deep. That's not code, that's a pyramid scheme.", "{ev} levels of indentation. I needed a map and a snack to get out."],
 'long_fn': ["{ev}. One function doing the job of a whole team.", "A function this long ({ev}) is a novel, not a function."],
 'long_lines': ["{ev} lines longer than 120 characters. My eyes need a horizontal scroll wheel."],
 'magic': ["Magic numbers everywhere ({ev}). What does 37 mean? Nobody knows. Not even you in two weeks."],
 'dead_code': ["{ev} lines of commented-out code. That's a graveyard, not a codebase. Git remembers, delete it."],
 'empty_catch': ["{ev}. Errors go in and never come out. Bermuda Triangle handling."],
 'dupes': ["The same line copy-pasted {ev}. DRY called, it's crying."],
 'bare_except': ["{ev} bare `except:` blocks. You're catching Ctrl+C too, genius."],
 'star_import': ["`import *` ({ev}). Namespace soup, nobody knows where anything comes from."],
 'mutable_default': ["Mutable default argument ({ev}). That list is shared between every call. Surprise!"],
 'none_eq': ["{ev} `== None`. It's `is None`, the linter is crying."],
 'todo': ["{ev} TODO/FIXME comments. A to-do list hiding in your code isn't a plan."],
 'short_names': ["{ev} one-letter variable names. Reading this is like decoding a ransom note."],
 'important': ["{ev} `!important`s. Specificity war, and everyone lost.", "!important used {ev}. That's not CSS, that's yelling."],
 'outline_none': ["`outline: none` with no focus style ({ev}). Keyboard users are now playing hide and seek."],
 'px_fonts': ["{ev} font sizes in px. Users who zoom their text say hello. Use rem."],
 'fixed_width': ["Fixed widths like {ev}. Phones exist, by the way."],
 'color_literals': ["{ev} different hard-coded colors and zero variables. Design tokens? Never heard of her."],
 'deep_selectors': ["Selectors like `{ev}`. That's a selector with a family tree."],
 'float_layout': ["{ev} floats for layout. Flexbox and grid were released over 10 years ago."],
 # images
 'ai_meta': ["The file's own metadata says it's AI-generated ({ev}). Didn't even hide the receipt.", "Metadata snitched: {ev}. AI slop confirmed by its own paperwork."],
 'oversat': ["Saturation averages {ev}. It's so saturated it's practically radioactive.", "Saturation at {ev}. My retinas filed a complaint."],
 'chaos_palette': ["{ev}. No palette, just vibes and chaos."],
 'flat_contrast': ["Brightness range is tiny ({ev}). Everything is the same mushy gray-ish middle. Mud."],
 'plastic': ["Super smooth surfaces plus loud saturation ({ev}): that airbrushed plastic look AI images love. (That's a look, not proof.)"],
 'purple_teal': ["The purple-to-teal \"futuristic\" gradient ({ev}). Every AI thumbnail in existence called, they want their palette back."],
 'blurry': ["It's blurry ({ev}). Did you upscale a thumbnail and pray?"],
 'tiny_img': ["{ev}. That's a postage stamp."],
 # text
 'slop_words': ["AI-slop vocabulary detected: {ev}. Nobody talks like that. Nobody.", "{ev}. That's not writing, that's a LinkedIn post having a fever dream."],
 'em_dash': ["{ev} em-dashes. The em-dash per word ratio is screaming chatbot."],
 'not_just': ["\"Not just X, but Y\" ({ev}). Classic AI sentence template, retire it."],
 'emoji_bullets': ["Emoji bullet points ({ev}). 🚀✨ is not a personality."],
}
FIX = {
 'overflow': "find the element wider than the screen and give it max-width:100%, let flex rows wrap (flex-wrap: wrap) and break long words (overflow-wrap: anywhere).",
 'no_viewport': 'add <meta name="viewport" content="width=device-width, initial-scale=1">.',
 'contrast': "body text needs at least 4.5:1 contrast (3:1 for large text); darken the text or lighten the background until it passes.",
 'tiny_targets': "make every tappable thing at least 24x24 CSS px (WCAG 2.2 2.5.8), ideally 44x44, using padding instead of bigger icons.",
 'small_text': "use at least 16px for body text on phones and 12px for the tiniest labels; size it in rem so zoom works.",
 'fonts': "use 1 to 2 font families: one for headings, one for body, and fall back to system fonts.",
 'sizes': "pick a type scale (e.g. 12/14/16/20/24/32) and use only those sizes, as CSS variables.",
 'colors': "define a small palette as CSS variables (text, muted text, accent, danger) and use only those.",
 'img_alt': 'give every informative image a short alt describing it; decorative ones get alt="".',
 'unnamed_btn': "give icon buttons an accessible name with aria-label or visually hidden text.",
 'h1': "one <h1> per page, then h2/h3 in order without skipping levels.",
 'z': "use a small z-index scale (1, 10, 100) and fix the stacking context instead of escalating numbers.",
 'div_btn': "use real <button> elements: they get focus, Enter/Space and a role for free.",
 'console': "fix or handle the errors in the console before shipping; an uncaught error can stop the rest of the page.",
 'slow': "measure what is heavy (images, scripts), lazy-load below-the-fold images and split large bundles.",
 'no_lang': 'lang attribute html',
 'syntax': "fix the syntax error first; run it through the parser (node --check / python -m py_compile) before anything else.",
 'var': "replace var with const (or let when it really changes); block scope avoids hoisting bugs.",
 'loose_eq': "use === and !== so values are compared without type coercion.",
 'console_log': "remove debug console.log calls or put them behind a debug flag.",
 'eval': "never eval strings; parse data with JSON.parse or map names to functions.",
 'innerhtml': "use textContent for text, or build elements with createElement; escape anything user-supplied.",
 'nesting': "return early, pull nested blocks into small named functions, and flatten callbacks with async/await.",
 'long_fn': "split it into small functions that each do one thing, with names that say what they do.",
 'long_lines': "wrap lines around 80 to 100 characters; let a formatter (Prettier/Black) do it.",
 'magic': "give the numbers names (const MAX_RETRIES = 3) so the code explains itself.",
 'dead_code': "delete commented-out code; version control keeps the history.",
 'empty_catch': "at least log the error, or handle it; never swallow it silently.",
 'dupes': "pull the repeated code into one function or a loop.",
 'bare_except': "catch the specific exception you expect (except ValueError:).",
 'star_import': "import the names you use explicitly.",
 'mutable_default': "default to None and create the list/dict inside the function.",
 'none_eq': "compare with `is None` / `is not None`.",
 'todo': "turn TODOs into tracked issues, or just do them.",
 'short_names': "use descriptive names (user, index, total) except for tiny loop counters.",
 'important': "lower the specificity instead: simpler selectors, cascade layers (@layer), no !important.",
 'outline_none': "keep a visible focus style: :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
 'px_fonts': "size text in rem (1rem = 16px by default) so it respects the user's settings.",
 'fixed_width': "use max-width plus percentages, or flex/grid with minmax(), instead of fixed px widths.",
 'color_literals': "move colors into CSS custom properties (--text, --accent…) and reuse them.",
 'deep_selectors': "use one class per component instead of long descendant chains.",
 'float_layout': "lay it out with flexbox or grid; floats are for wrapping text around images.",
 'ai_meta': "if it's AI-made, say so; if it's going in a product, redraw it or at least fix the details by hand.",
 'oversat': "pull saturation down and keep the loud color for one accent.",
 'chaos_palette': "limit the palette to 3 to 5 main colors (60/30/10 is a good start).",
 'flat_contrast': "add real darks and lights; increase the value contrast between subject and background.",
 'plastic': "add real texture and lighting variation, and fix the details AI smears (hands, text, edges).",
 'purple_teal': "pick a palette that fits the brand, not the default sci-fi gradient.",
 'blurry': "export at the size it is shown (2x for retina), from the original, not an upscale.",
 'tiny_img': "use a bigger source image; at least the displayed size times 2 for sharp screens.",
 'slop_words': "write like a person: concrete nouns, short sentences, say the actual thing.",
 'em_dash': "use commas, periods and parentheses; one em-dash per page is plenty.",
 'not_just': "just say the point directly.",
 'emoji_bullets': "use plain bullets; save emoji for tone, not structure.",
}
Q = {
 'overflow': 'responsive design overflow viewport width', 'no_viewport': 'viewport meta tag mobile', 'contrast': 'contrast ratio minimum text',
 'tiny_targets': 'target size minimum touch', 'small_text': 'font size minimum legible', 'fonts': 'typeface font pairing families',
 'sizes': 'modular scale typography', 'colors': 'color scheme harmony', 'img_alt': 'alt text images', 'unnamed_btn': 'button accessible name aria-label',
 'h1': 'skipped heading levels', 'z': 'z-index stacking context', 'div_btn': 'button element keyboard accessible', 'console': 'javascript errors exceptions',
 'slow': 'page load performance', 'no_lang': 'lang attribute html language', 'syntax': 'syntax error parse', 'var': 'var let const block scope',
 'loose_eq': 'loose equality coercion', 'console_log': 'console log debugging remove', 'eval': 'eval dangerous never use', 'innerhtml': 'innerHTML security cross-site scripting',
 'nesting': 'nested callbacks async await', 'long_fn': 'function length single responsibility', 'long_lines': 'line length code',
 'magic': 'magic number constant', 'dead_code': 'code smell', 'empty_catch': 'empty catch error handling', 'dupes': "don't repeat yourself",
 'bare_except': 'exception handling', 'star_import': 'modules import', 'mutable_default': 'default parameters', 'none_eq': 'equality identity comparison',
 'todo': 'technical debt', 'short_names': 'naming variables readability', 'important': 'important specificity cascade', 'outline_none': 'outline focus visible keyboard',
 'px_fonts': 'rem font size accessibility zoom', 'fixed_width': 'responsive layout fixed width', 'color_literals': 'css custom properties variables',
 'deep_selectors': 'css selectors specificity', 'float_layout': 'float layout flexbox', 'ai_meta': 'generative artificial intelligence images',
 'oversat': 'color scheme harmony', 'chaos_palette': 'palette limited colors design', 'flat_contrast': 'contrast value design', 'plastic': 'AI slop', 'purple_teal': 'color scheme complementary',
 'blurry': 'images responsive layout resolution', 'tiny_img': 'responsive images resolution', 'slop_words': 'AI slop', 'em_dash': 'AI slop', 'not_just': 'AI slop', 'emoji_bullets': 'readability',
}

def pl(n, w, s='s'): return f'{n} {w}' + ('' if n == 1 else s)
def F(key, ev, sev=2): return {'key': key, 'evidence': str(ev), 'sev': sev}

# ------------------------------------------------------------------ pages: rendered for real in headless Chromium
def audit_page(url):
    shot = os.path.join(OUT, 'page-' + hashlib.md5(url.encode()).hexdigest()[:8])
    env = {**os.environ, 'NODE_PATH': '/opt/jena-node/node_modules'}
    r = subprocess.run(['node', os.path.join(HERE, '..', '_lib', 'page_audit.cjs'), json.dumps({'url': url, 'widths': [390, 1280], 'shot': shot, 'wait_ms': 3000})], capture_output=True, text=True, timeout=170, env=env)
    try: return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception: return {'ok': False, 'error': (r.stderr or 'no output')[-200:]}

def page_findings(a):
    f = []
    m, d = a['widths'].get('390') or {}, a['widths'].get('1280') or {}
    if m.get('overflowX'): f.append(F('overflow', f"page is {m['scrollWidth']}px wide", 3))
    if m and not m.get('viewport'): f.append(F('no_viewport', '', 3))
    for v in (m, d):
        lc = v.get('lowContrast') or {}
        if lc.get('count'):
            ex = lc['examples'][0]; f.append(F('contrast', f"on {lc['count']} text bits, worst \"{ex['text'][:24]}\" at {ex['ratio']}:1 ({ex['fg']} on {ex['bg']})", 3 if ex['ratio'] < 3 else 2)); break
    tt = (m.get('tinyTargets') or {})
    if tt.get('count'): f.append(F('tiny_targets', f"{tt['count']} of {m.get('targets')} tap targets (e.g. \"{tt['examples'][0]['what']}\" {tt['examples'][0]['w']}x{tt['examples'][0]['h']}px)", 2))
    st = (m.get('smallText') or {})
    if st.get('count', 0) >= 3: f.append(F('small_text', f"{st['count']} text bits", 2))
    fam = d.get('fontFamilies') or m.get('fontFamilies') or []
    if len(fam) > 3: f.append(F('fonts', f"{len(fam)} ({', '.join(x[0] for x in fam[:4])})", 2))
    sz = d.get('fontSizes') or []
    if len(sz) > 9: f.append(F('sizes', len(sz), 1))
    if (d.get('textColors') or 0) > 12: f.append(F('colors', d['textColors'], 1))
    if d.get('imgNoAlt'): f.append(F('img_alt', f"{d['imgNoAlt']} of {d['images']} images", 2))
    if d.get('unnamedButtons'): f.append(F('unnamed_btn', f"{d['unnamedButtons']} buttons", 2))
    if d and d.get('h1') != 1: f.append(F('h1', f"{d.get('h1')} <h1> tags" + (f" and {d['headingSkips']} skipped heading levels" if d.get('headingSkips') else ''), 1))
    elif d.get('headingSkips', 0) > 1: f.append(F('h1', f"{d['headingSkips']} skipped heading levels", 1))
    if (d.get('maxZ') or 0) >= 9999: f.append(F('z', d['maxZ'], 1))
    if d.get('divButtons'): f.append(F('div_btn', d['divButtons'], 2))
    errs = (d.get('consoleErrors') or []) + (m.get('consoleErrors') or [])
    if errs: f.append(F('console', f"{len(errs)} errors, first: {errs[0][:90]}", 2))
    if (d.get('loadMs') or 0) > 6000: f.append(F('slow', f"{d['loadMs'] / 1000:.1f} s", 2))
    if d and not d.get('lang'): f.append(F('no_lang', '', 1))
    f += text_findings(d.get('text') or '')
    return f

# ------------------------------------------------------------------ code
def code_findings(code, lang):
    f = []
    lines = code.splitlines()
    with tempfile.NamedTemporaryFile('w', suffix={'js': '.js', 'py': '.py', 'css': '.css', 'html': '.html'}.get(lang, '.txt'), delete=False) as t: t.write(code); tp = t.name
    try:
        if lang == 'js':
            r = subprocess.run(['node', '--check', tp], capture_output=True, text=True, timeout=20)
            if r.returncode: f.append(F('syntax', (re.findall(r'SyntaxError: .*', r.stderr) or [r.stderr.strip().splitlines()[-1] if r.stderr.strip() else 'unknown'])[0][:100], 3))
        if lang == 'py':
            r = subprocess.run([sys.executable, '-m', 'py_compile', tp], capture_output=True, text=True, timeout=20)
            if r.returncode: f.append(F('syntax', (r.stderr.strip().splitlines() or ['?'])[-1][:100], 3))
    finally: os.unlink(tp)
    nocom = [l for l in lines if not l.strip().startswith(('//', '#', '/*', '*'))]
    body = '\n'.join(nocom)
    if lang in ('js', 'html'):
        n = len(re.findall(r'\bvar\s+\w', body));                     n and f.append(F('var', pl(n, 'use'), 1))
        n = len(re.findall(r'[^=!<>]==[^=]|!=[^=]', body));            n and f.append(F('loose_eq', pl(n, 'loose == comparison'), 1))
        n = len(re.findall(r'console\.log\(', body));                  n >= 2 and f.append(F('console_log', pl(n, 'console.log'), 1))
        n = len(re.findall(r'\beval\(|new Function\(', body));         n and f.append(F('eval', pl(n, 'eval()/new Function call'), 3))
        n = len(re.findall(r'\.innerHTML\s*\+?=\s*[^;\n]*(\+|\$\{)', body)); n and f.append(F('innerhtml', pl(n, 'spot'), 3))
        n = len(re.findall(r'catch\s*(\(\w*\))?\s*\{\s*\}', body));    n and f.append(F('empty_catch', pl(n, 'empty catch block'), 2))
    if lang == 'py':
        n = len(re.findall(r'^\s*except\s*:', body, re.M));            n and f.append(F('bare_except', n, 2))
        n = len(re.findall(r'except[^:\n]*:\s*\n\s*pass\b', body));    n and f.append(F('empty_catch', n, 2))
        n = len(re.findall(r'^\s*from\s+\S+\s+import\s+\*', body, re.M)); n and f.append(F('star_import', n, 1))
        m = re.search(r'def\s+(\w+)\([^)]*=\s*(\[\]|\{\})', body);     m and f.append(F('mutable_default', m.group(1) + '(…=' + m.group(2) + ')', 2))
        n = len(re.findall(r'[=!]=\s*None\b', body));                  n and f.append(F('none_eq', n, 1))
        n = len(re.findall(r'^\s*print\(', body, re.M));               n >= 4 and f.append(F('console_log', f'{n} debug print() calls', 1))
        n = len(re.findall(r'\beval\(|\bexec\(', body));               n and f.append(F('eval', pl(n, 'eval()/exec() call'), 3))
    if lang in ('js', 'py'):
        ind = [len(l) - len(l.lstrip()) for l in nocom if l.strip()]
        unit = 4 if lang == 'py' else (2 if any(i == 2 for i in ind) else 4)
        depth = max([i // unit for i in ind] or [0])
        if depth >= 6: f.append(F('nesting', depth, 2))
        # longest function, by indentation block
        starts = [i for i, l in enumerate(lines) if re.match(r'\s*(async\s+)?(def |function\b|\w+\s*\([^)]*\)\s*\{|const \w+ = (async )?\([^)]*\) =>)', l)]
        longest = 0
        for s in starts:
            base = len(lines[s]) - len(lines[s].lstrip()); n = 1
            for l in lines[s + 1:]:
                if l.strip() and len(l) - len(l.lstrip()) <= base and not l.strip().startswith(('}', ')', ']')): break
                n += 1
            longest = max(longest, n)
        if longest > 60: f.append(F('long_fn', f'a {longest}-line function', 2))
        names = re.findall(r'\b(?:let|const|var)\s+([a-zA-Z])\b|^\s*([a-zA-Z])\s*=[^=]', body, re.M)
        n = len([x for x in names if (x[0] or x[1]) not in 'ijkxyn_']); n >= 4 and f.append(F('short_names', n, 1))
        nums = [x for x in re.findall(r'(?<![\w.#$-])(\d+\.?\d*)(?![\w.])', re.sub(r'(["\'`]).*?\1', '', body)) if x not in ('0', '1', '2', '100', '10', '0.5', '1000')]
        if len(set(nums)) >= 5: f.append(F('magic', ', '.join(sorted(set(nums), key=nums.index)[:5]), 1))
    if lang == 'css' or lang == 'html':
        n = body.count('!important');                                 n >= 3 and f.append(F('important', n, 2))
        zs = [int(z) for z in re.findall(r'z-index\s*:\s*(\d+)', body)]; zs and max(zs) >= 999 and f.append(F('z', max(zs), 1))
        if re.search(r'outline\s*:\s*(none|0)\b', body) and ':focus-visible' not in body: f.append(F('outline_none', 'no :focus-visible anywhere', 2))
        n = len(re.findall(r'font-size\s*:\s*\d+px', body));            n >= 6 and f.append(F('px_fonts', n, 1))
        fw = re.findall(r'(?<!max-)(?<!min-)width\s*:\s*(\d{3,4})px', body); fw = [w for w in fw if int(w) >= 500]; fw and f.append(F('fixed_width', ', '.join(w + 'px' for w in fw[:3]), 2))
        cols = set(c.lower() for c in re.findall(r'#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)', body))
        if len(cols) > 15 and 'var(--' not in body: f.append(F('color_literals', len(cols), 1))
        deep = [s.strip() for s in re.findall(r'(?:^|\})\s*([^{}@]+)\{', body) if len(s.split()) >= 5]
        deep and f.append(F('deep_selectors', deep[0][:50], 1))
        n = len(re.findall(r'float\s*:\s*(left|right)', body));        n >= 3 and f.append(F('float_layout', n, 1))
    if lang == 'html':
        n = len(re.findall(r'<img(?![^>]*\balt=)[^>]*>', body, re.I));  n and f.append(F('img_alt', f'{n} <img>', 2))
        if re.search(r'<html(?![^>]*\blang=)', body, re.I): f.append(F('no_lang', '', 1))
        n = len(re.findall(r'<(div|span)[^>]*onclick', body, re.I));    n and f.append(F('div_btn', n, 2))
    n = len([l for l in lines if len(l) > 120]);                       n >= 3 and f.append(F('long_lines', n, 1))
    com = [l.strip().lstrip('/#* ') for l in lines if l.strip().startswith(('//', '#'))]
    n = len([c for c in com if re.search(r'[;{}()=]\s*$|^(if|for|return|const|let|var|def|print)\b', c)]); n >= 3 and f.append(F('dead_code', n, 1))
    n = len(re.findall(r'\b(TODO|FIXME|HACK|XXX)\b', code));            n >= 2 and f.append(F('todo', n, 1))
    cnt = {}
    for l in lines:
        s = l.strip()
        if len(s) > 25: cnt[s] = cnt.get(s, 0) + 1
    rep = [c for c in cnt.values() if c >= 3]; rep and f.append(F('dupes', f'{max(rep)} times', 1))
    return f

def lang_of(code, name=''):
    ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
    if ext in ('js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'): return 'js'
    if ext in ('py',): return 'py'
    if ext in ('css', 'scss'): return 'css'
    if ext in ('html', 'htm', 'vue', 'svelte'): return 'html'
    if re.search(r'<(div|html|body|span|img|button)\b', code): return 'html'
    if re.search(r'^\s*(def |import \w|from \w+ import|class \w+.*:$)', code, re.M): return 'py'
    if re.search(r'[.#]?[\w-]+\s*\{[^}]*:[^}]*;', code) and not re.search(r'\bfunction\b|=>|\bconst\b', code): return 'css'
    return 'js'

# ------------------------------------------------------------------ images
def image_findings(raw, name=''):
    from PIL import Image, ImageFilter, ImageStat
    import io
    f, meta_hits = [], []
    head = raw[:400000]
    for pat, label in [(rb'trainedAlgorithmicMedia', 'IPTC: trainedAlgorithmicMedia'), (rb'c2pa', 'a C2PA content-credentials manifest'), (rb'Midjourney', 'Midjourney'), (rb'DALL[\xc2\xb7\-. ]?E', 'DALL-E'),
                       (rb'Stable Diffusion|stable-diffusion|sd_xl|SDXL', 'Stable Diffusion'), (rb'ComfyUI|"class_type"', 'ComfyUI workflow'), (rb'Adobe Firefly', 'Adobe Firefly'), (rb'Imagen|SynthID', 'Google Imagen/SynthID'), (rb'NovelAI', 'NovelAI'), (rb'Negative prompt:', 'an SD prompt block')]:
        if re.search(pat, head): meta_hits.append(label)
    im = Image.open(io.BytesIO(raw))
    info = {k: str(v)[:80] for k, v in (im.info or {}).items() if isinstance(v, (str, bytes)) and k.lower() in ('parameters', 'prompt', 'workflow', 'software', 'comment', 'description')}
    for k, v in info.items():
        if k.lower() in ('parameters', 'prompt', 'workflow'): meta_hits.append(f'a "{k}" text chunk')
        elif re.search(r'diffusion|midjourney|dall|firefly|comfy|novelai', v, re.I): meta_hits.append(f'{k}: {v[:40]}')
    if meta_hits: f.append(F('ai_meta', ', '.join(dict.fromkeys(meta_hits)), 3))
    w, h = im.size
    rgb = im.convert('RGB'); sm = rgb.copy(); sm.thumbnail((256, 256))
    if max(w, h) < 300: f.append(F('tiny_img', f'{w}x{h}px', 2))
    hsv = sm.convert('HSV'); hs, ss, vs = [list(c.getdata()) for c in hsv.split()]
    sat = sum(ss) / len(ss) / 255
    if sat > 0.62: f.append(F('oversat', f'{sat:.0%}', 2))
    satpx = [(H, S) for H, S, V in zip(hs, ss, vs) if S > 80 and V > 60]
    fam = {}
    for H, S in satpx: fam[H * 12 // 256] = fam.get(H * 12 // 256, 0) + 1
    n90 = len([k for k, v in fam.items() if v >= 0.03 * len(hs)])   # hue families that each cover 3%+ of the image
    if n90 >= 6: f.append(F('chaos_palette', f'{n90} different hue families each covering 3%+ of it', 1))
    lum = sm.convert('L'); st = ImageStat.Stat(lum)
    lo, hi = sorted(lum.getdata())[int(0.05 * len(vs))], sorted(lum.getdata())[int(0.95 * len(vs)) - 1]
    if hi - lo < 90: f.append(F('flat_contrast', f'5-95% brightness only {lo}-{hi} of 255', 2))
    edges = lum.filter(ImageFilter.FIND_EDGES); ed = ImageStat.Stat(edges).mean[0]
    if ed < 6 and max(w, h) >= 300 and sat > 0.45: f.append(F('plastic', f'edge energy {ed:.1f}, saturation {sat:.0%}', 1))
    elif ed < 3.5 and max(w, h) >= 300: f.append(F('blurry', f'edge energy only {ed:.1f}', 2))
    purp = sum(1 for H, S in zip(hs, ss) if 185 <= H <= 215 and S > 90) / len(hs); teal = sum(1 for H, S in zip(hs, ss) if 115 <= H <= 140 and S > 90) / len(hs)
    if purp > 0.12 and teal > 0.08: f.append(F('purple_teal', f'{purp:.0%} purple, {teal:.0%} teal', 1))
    return f, {'size': f'{w}x{h}', 'saturation': round(sat, 2), 'hue_families': n90, 'brightness_5_95': [lo, hi], 'edge_energy': round(ed, 1), 'metadata': meta_hits}

# ------------------------------------------------------------------ text (AI slop copy)
SLOP = ['delve', 'tapestry', 'elevate your', 'unlock the', 'unleash', 'seamless', 'game-changer', 'game changer', 'revolutioniz', "in today's fast-paced", 'in the ever-evolving', 'ever-changing landscape',
        "it's important to note", 'it is important to note', 'embark on', 'navigate the complexities', 'a testament to', 'cutting-edge', 'harness the power', 'synergy', 'leverage', 'robust', 'empower',
        'next-level', 'look no further', 'whether you\'re a', 'dive into', 'dive deep', 'in conclusion', 'furthermore,', 'moreover,', 'boasts', 'nestled', 'vibrant', 'bustling', 'realm of', 'treasure trove']
def text_findings(t):
    f = []
    low = t.lower(); words = max(1, len(t.split()))
    hits = [s for s in SLOP if s in low]
    if len(hits) >= 2: f.append(F('slop_words', ', '.join(f'"{h}"' for h in hits[:5]) + (f' (+{len(hits) - 5} more)' if len(hits) > 5 else ''), 3 if len(hits) >= 5 else 2 if len(hits) >= 3 else 1))
    dashes = t.count('—')
    if dashes >= 3 and dashes / words > 0.008: f.append(F('em_dash', f'{dashes} in {words} words', 1))
    nj = re.findall(r"\bnot (just|only|merely) [^.,;]{2,40}[,;]? but\b", low)
    if nj: f.append(F('not_just', f'{len(nj)}x', 1))
    eb = len(re.findall(r'^\s*[\U0001F300-\U0001FAFF\u2728\u2705]\s', t, re.M))
    if eb >= 3: f.append(F('emoji_bullets', eb, 1))
    return f

# ------------------------------------------------------------------ what was she asked to roast?
def fetch(url, limit=6_000_000):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r: return r.headers.get('Content-Type', ''), r.read(limit)

def target(i):
    text = str(i.get('text') or i.get('query') or '')
    url = i.get('url') or (re.findall(r'https?://[^\s<>"\')\]]+', text) or [None])[0]
    fence = re.search(r'```(\w+)?\n(.*?)```', text, re.S)
    if fence: return 'code', fence.group(2), lang_of(fence.group(2), '.' + (fence.group(1) or ''))
    path = re.search(r'\b((?:src|api|box|skills|scripts|public|test)/[\w./-]+\.(?:js|mjs|cjs|py|css|html|json)|index\.html|server\.mjs|vite\.config\.js)\b', text)
    if path:
        p = os.path.join(REPO, path.group(1))
        if os.path.exists(p) and os.path.realpath(p).startswith(REPO): return 'file', open(p, errors='ignore').read()[:200000], path.group(1)
        return 'missing', path.group(1), None
    if url: return 'url', url, None
    if re.search(r"\b(your|ur|her) (own )?(desktop|screen)\b", text, re.I): return 'desktop', 'http://127.0.0.1:6081/box/shot.jpg', None
    if re.search(r"\b(your|ur|her) (own )?(site|website|web ?page|page|ui|stage)\b", text, re.I): return 'url', MY_SITE, None
    body = re.sub(r'^(jena[, ]+)?(please )?(roast|critique|rate|review|judge|tear apart|drag)\b( (this|that|my|the|it))?( (code|text|copy|post|caption|paragraph|ui|design))?\s*:?\s*', '', text, flags=re.I).strip()
    if '\n' in body and re.search(r'[;{}=()]', body): return 'code', body, lang_of(body)
    if len(body.split()) >= 12: return 'text', body, None
    return None, text, None

def cite(key):
    hits = lookup(Q.get(key, key), n=1)
    return hits[0] if hits else None

def main():
    i = inp()
    kind, what, extra = target(i)
    t0 = time.time(); meta = {}; label = ''
    if kind is None:
        done(False, 'tell me WHAT to roast: a link, an image link, code (paste it in ``` or name a repo file like src/chat.js), some text, or "your site" / "your desktop"')
    if kind == 'missing': done(False, f'there is no {what} in my repo, so there is nothing to roast')
    if kind == 'url':
        try: ctype, raw = fetch(what, 200000) if not re.search(r'\.(png|jpe?g|webp|gif)(\?|$)', what, re.I) else ('image/', b'')
        except Exception as e: ctype, raw = '', b''; meta['fetch_error'] = str(e)[:120]
        if ctype.startswith('image/'):
            kind = 'image'
        else:
            a = audit_page(what)
            if not a.get('ok'):
                if raw:   # no browser right now: honest fallback to the HTML itself
                    html = raw.decode('utf-8', 'ignore'); label = f'{what} (HTML only, {a.get("error", "browser unavailable")})'
                    fs = code_findings(html, 'html') + text_findings(re.sub(r'<[^>]+>', ' ', html))
                else: done(False, f'could not open {what}: {a.get("error") or meta.get("fetch_error")}')
            else:
                fs = page_findings(a); label = f'{what} (rendered at 390px and 1280px)'
                meta = {'audit': {w: {k: v for k, v in x.items() if k not in ('text',)} for w, x in a['widths'].items()}}
                meta['shots'] = [x.get('shot') for x in a['widths'].values() if x.get('shot')]
    if kind in ('image', 'desktop'):
        try: ctype, raw = fetch(what)
        except Exception as e: done(False, f'could not download that image: {e}')
        try: fs, m = image_findings(raw, what); meta['image'] = m
        except Exception as e: done(False, f'that does not open as an image: {str(e)[:100]}')
        label = 'my own desktop screenshot' if kind == 'desktop' else what
    if kind in ('code', 'file'):
        lang = lang_of(what, extra or '') if kind == 'file' else extra
        fs = code_findings(what, lang); label = f'{extra} from my repo' if kind == 'file' else f'your {lang} snippet ({len(what.splitlines())} lines)'
        if lang == 'html': fs += text_findings(re.sub(r'<[^>]+>', ' ', what))
    if kind == 'text':
        fs = text_findings(what); label = f'your text ({len(what.split())} words)'
    fs.sort(key=lambda x: -x['sev'])
    seen, findings = set(), []
    for x in fs:
        if x['key'] in seen: continue
        seen.add(x['key']); c = cite(x['key'])
        findings.append({**x, 'roast': rnd.choice(R[x['key']]).format(ev=x['evidence']), 'fix': FIX[x['key']],
                         'cite': {'title': c['title'] + (' › ' + c['section'] if c.get('section') else ''), 'book': c['short'], 'license': c['license_short'], 'url': c['url']} if c else None})
    score = max(0, 10 - sum(x['sev'] for x in findings))
    if not findings:
        say = rnd.choice(["Okay, I looked for real and... I've got nothing. Annoyingly decent. Fine. Respect.", "I ran every check I have on this and it passed. I'm almost disappointed. Clean work."])
    else:
        intro = rnd.choice(["Oh, we're doing this? Okay.", "Buckle up.", "I looked. I regret it.", "Alright, roast time."]) if score < 7 else rnd.choice(["Not bad, but I'm still roasting it.", "It's fine-ish. Fine-ish is not a compliment."])
        top = findings[:3]
        say = intro + ' ' + ' '.join(x['roast'] for x in top) + f" Score: {score}/10. Fixes + sources are in my thought chain."
    steps = [f"🔥 {x['roast']} → fix: {x['fix']}" + (f" 📚 {x['cite']['title'] if re.match(r'^[^:]{2,26}: ', x['cite']['title']) else x['cite']['book'] + ': ' + x['cite']['title']} ({x['cite']['license']})" if x['cite'] else '') for x in findings[:7]]
    rec = {'ts': int(time.time()), 'target': label, 'kind': kind, 'score': score, 'findings': findings, 'say': say, **meta}
    fn = os.path.join(OUT, time.strftime('%Y%m%d-%H%M%S') + '.json'); json.dump(rec, open(fn, 'w'), indent=1)
    facts = f'roasted {label}, score {score}/10: ' + ' | '.join(f"{x['key']}: {x['evidence']} → {x['fix']}" for x in findings[:6])
    done(True, f'roasted {label}: {pl(len(findings), "real issue")}, score {score}/10' + (f' (worst: {findings[0]["key"].replace("_", " ")})' if findings else ' (clean)'),
         facts=facts, steps=steps, say=say, findings=findings, score=score, target=label, saved=fn, ms=int((time.time() - t0) * 1000),
         hits=[{'title': x['cite']['title'], 'url': x['cite']['url'], 'snippet': x['fix']} for x in findings if x['cite']][:4])

main()
