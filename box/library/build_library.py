#!/usr/bin/env python3
# Jena's design/dev library: open-licensed sources only, indexed with SQLite FTS5 (bm25) so a 4-CPU box can
# search it in milliseconds. build:  python3 build_library.py <src_dir> <library_dir>
# Each passage keeps its source, license and link, so every lookup can cite where it came from.
import json, os, re, sqlite3, sys, html, time

SOURCES = {
 'mdn':      dict(title='MDN Web Docs (CSS, HTML, Accessibility, JS Guide, Learn web development)', license='CC-BY-SA 2.5 (prose); code samples CC0', by='Mozilla Contributors', home='https://developer.mozilla.org', repo='https://github.com/mdn/content', topic='front-end'),
 'webdev':   dict(title='web.dev Learn courses (CSS, Design, Accessibility, Forms, HTML, Images, PWA, Privacy)', license='CC-BY 3.0 (content); code Apache-2.0', by='Google Chrome team', home='https://web.dev/learn', repo='https://github.com/GoogleChrome/web.dev', topic='front-end / design'),
 'wcag':     dict(title='WCAG 2.2 guidelines + Understanding WCAG', license='W3C Document License', by='W3C', home='https://www.w3.org/WAI/standards-guidelines/wcag/', repo='https://github.com/w3c/wcag', topic='accessibility'),
 'eloquent': dict(title='Eloquent JavaScript, 4th ed. (Marijn Haverbeke)', license='CC-BY-NC 3.0', by='Marijn Haverbeke', home='https://eloquentjavascript.net', repo='https://github.com/marijnh/Eloquent-JavaScript', topic='coding'),
 'ydkjs':    dict(title="You Don't Know JS Yet, 2nd ed. (Kyle Simpson)", license='CC-BY-NC-ND 4.0 (read-only: quoted with credit, never modified)', by='Kyle Simpson', home='https://github.com/getify/You-Dont-Know-JS', repo='https://github.com/getify/You-Dont-Know-JS', topic='coding'),
 'odin':     dict(title='The Odin Project curriculum (Foundations, HTML/CSS, JavaScript, React, Node, Databases, Git)', license='CC-BY-NC-SA 4.0', by='The Odin Project', home='https://www.theodinproject.com', repo='https://github.com/TheOdinProject/curriculum', topic='full-stack'),
 'fso':      dict(title='Full Stack Open (Univ. of Helsinki): React, Node/Express, MongoDB, testing, GraphQL, TypeScript', license='CC-BY-NC-SA 3.0', by='University of Helsinki', home='https://fullstackopen.com/en/', repo='https://github.com/fullstack-hy2020/fullstack-hy2020.github.io', topic='full-stack'),
 'react':    dict(title='react.dev Learn (official React docs)', license='CC-BY 4.0', by='Meta Open Source', home='https://react.dev/learn', repo='https://github.com/reactjs/react.dev', topic='front-end'),
 'progit':   dict(title='Pro Git, 2nd ed. (Scott Chacon, Ben Straub)', license='CC-BY-NC-SA 3.0', by='Scott Chacon, Ben Straub', home='https://git-scm.com/book', repo='https://github.com/progit/progit2', topic='dev tools'),
 'mweb':     dict(title='Material Web components docs (Material Design 3 for the web)', license='Apache-2.0', by='Google', home='https://material-web.dev', repo='https://github.com/material-components/material-web', topic='design system'),
 'wikipedia':dict(title='Wikipedia: graphic design, typography, color, UX laws, usability, code quality (~135 articles)', license='CC-BY-SA 4.0', by='Wikipedia contributors', home='https://en.wikipedia.org', repo=None, topic='design theory'),
 'opencolor':dict(title='Open Color palette', license='MIT', by='heeyeun', home='https://yeun.github.io/open-color/', repo='https://github.com/yeun/open-color', topic='color'),
}
ASSET_SETS = {
 'lucide': dict(title='Lucide icons (SVG)', license='ISC', home='https://lucide.dev', repo='https://github.com/lucide-icons/lucide'),
 'tabler': dict(title='Tabler icons, outline (SVG)', license='MIT', home='https://tabler.io/icons', repo='https://github.com/tabler/tabler-icons'),
}

def front(t):
    meta = {}
    m = re.match(r'^---\s*\n(.*?)\n---\s*\n', t, re.S)
    if m:
        for line in m.group(1).splitlines():
            if ':' in line and not line.startswith(' '):
                k, v = line.split(':', 1); meta[k.strip()] = v.strip().strip('"\'')
        t = t[m.end():]
    return meta, t

def clean_md(t):
    t = re.sub(r'\{\{\s*[\w-]+\(?\s*"?([^"}),]*)"?[^}]*\}\}', lambda m: m.group(1) or '', t)   # MDN macros -> their first arg
    t = re.sub(r'\{%.*?%\}', '', t, flags=re.S)                                             # liquid/nunjucks
    t = re.sub(r'<!--.*?-->', '', t, flags=re.S)
    t = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', t)                                              # images
    t = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', t)                                          # links -> text
    t = re.sub(r'</?(div|span|section|figure|figcaption|img|br|p|aside|details|summary|a|picture|source|iframe|video)[^>]*>', '', t)
    t = re.sub(r'\n{3,}', '\n\n', t)
    return t

def clean_html(t):
    t = re.sub(r'<(script|style)[^>]*>.*?</\1>', '', t, flags=re.S)
    t = re.sub(r'<h([1-6])[^>]*>(.*?)</h\1>', lambda m: '\n' + '#' * int(m.group(1)) + ' ' + re.sub('<[^>]+>', '', m.group(2)) + '\n', t, flags=re.S)
    t = re.sub(r'<(li)[^>]*>', '\n- ', t)
    t = re.sub(r'<(p|div|section|dd|dt|tr)[^>]*>', '\n', t)
    t = re.sub(r'<[^>]+>', '', t)
    t = html.unescape(t)
    return re.sub(r'\n\s*\n+', '\n\n', t)

def sections(t, asc=False, wiki=False):
    pat = r'^(=+)\s+(.+?)\s*=*\s*$' if (asc or wiki) else r'^(#{1,4})\s+(.+?)\s*#*\s*$'
    cur, buf, out = '', [], []
    in_code = False
    for line in t.splitlines():
        if line.strip().startswith('```'): in_code = not in_code
        m = None if in_code else re.match(pat, line)
        if m:
            if ''.join(buf).strip(): out.append((cur, '\n'.join(buf).strip()))
            cur, buf = m.group(2).strip(), []
        else: buf.append(line)
    if ''.join(buf).strip(): out.append((cur, '\n'.join(buf).strip()))
    return out

def chunks(text, size=1200):
    paras, cur = re.split(r'\n\s*\n', text), ''
    for p in paras:
        p = p.strip()
        if not p: continue
        while len(p) > size * 1.5:
            cut = p.rfind('. ', 0, size); cut = cut + 1 if cut > size // 2 else size
            if cur: yield cur; cur = ''
            yield p[:cut]; p = p[cut:].strip()
        if len(cur) + len(p) > size and cur: yield cur; cur = p
        else: cur = (cur + '\n\n' + p) if cur else p
    if cur: yield cur

def docs(src):
    """yield (source, doc_title, url, path, text, fmt)"""
    for root, _, files in os.walk(src):
        for f in files:
            p = os.path.join(root, f); rel = os.path.relpath(p, src); s = rel.split('/')[0]
            if s not in SOURCES: continue
            ext = f.rsplit('.', 1)[-1].lower()
            if ext not in ('md', 'asc', 'html', 'json') or f.upper().startswith('LICENSE') or f == 'README.md' and s not in ('ydkjs',): continue
            if s == 'opencolor':
                d = json.load(open(p)); txt = '\n'.join(f'{k}: ' + (', '.join(f'{k}-{i} {c}' for i, c in enumerate(v)) if isinstance(v, list) else str(v)) for k, v in d.items())
                yield s, 'Open Color palette (hex values)', SOURCES[s]['home'], rel, txt, 'md'; continue
            if s == 'wikipedia':
                d = json.load(open(p)); yield s, d['title'], d['url'], rel, d['text'], 'wiki'; continue
            raw = open(p, encoding='utf-8', errors='ignore').read()
            if ext == 'html':
                if s != 'wcag': continue
                m = re.search(r'<title>(.*?)</title>', raw, re.S) or re.search(r'<h1[^>]*>(.*?)</h1>', raw, re.S) or re.search(r'<h[23][^>]*>(.*?)</h[23]>', raw, re.S)
                title = re.sub('<[^>]+>', '', m.group(1)).strip() if m else f
                name = f[:-5]
                url = f'https://www.w3.org/WAI/WCAG22/Understanding/{name}' if rel.startswith('wcag/understanding') else f'https://www.w3.org/TR/WCAG22/#{name}'
                if rel.startswith('wcag/guidelines'): title = 'WCAG 2.2: ' + (title if not title.endswith('.html') else name.replace('-', ' '))
                yield s, title, url, rel, clean_html(raw), 'md'; continue
            if ext == 'json': continue
            meta, body = front(raw)
            title = meta.get('title') or (re.search(r'^#\s+(.+)$', body, re.M) or re.search(r'^=+\s+(.+)$', body, re.M) or [None, f])[1]
            title = re.sub(r'\{\{.*?\}\}', '', str(title)).strip()
            if s == 'mdn': url = 'https://developer.mozilla.org/en-US/docs/' + meta.get('slug', '')
            elif s == 'webdev': url = 'https://web.dev/' + re.sub(r'^webdev/src/site/content/en/|/index\.md$|\.md$', '', rel)
            elif s == 'react': url = 'https://react.dev/' + re.sub(r'^react/src/content/|\.md$', '', rel).replace('/index', '')
            elif s == 'eloquent': url = 'https://eloquentjavascript.net/' + f[:-3] + '.html'
            elif s == 'fso': url = SOURCES[s]['repo'] + '/blob/source/' + rel.split('/', 1)[1]
            else: url = (SOURCES[s]['repo'] or '') + '/blob/main/' + rel.split('/', 1)[1]
            if s == 'eloquent': title = 'Eloquent JavaScript: ' + title
            if s == 'ydkjs': title = "YDKJS " + rel.split('/')[1] + ': ' + title
            if s == 'progit': title = 'Pro Git: ' + title
            if s == 'fso': title = 'Full Stack Open: ' + title
            if s == 'odin': title = 'Odin Project: ' + (title if not title.endswith('.md') else f[:-3].replace('_', ' ').capitalize())
            if s == 'mweb': title = 'Material Web: ' + title
            if s == 'webdev': title = 'web.dev Learn: ' + title
            if s == 'react': title = 'react.dev: ' + title
            yield s, title, url, rel, clean_md(body), 'asc' if ext == 'asc' else 'md'

def build(src, lib):
    os.makedirs(lib, exist_ok=True)
    dbp = os.path.join(lib, 'library.db.tmp')
    if os.path.exists(dbp): os.remove(dbp)
    db = sqlite3.connect(dbp)
    db.execute("CREATE VIRTUAL TABLE p USING fts5(title, section, body, source UNINDEXED, url UNINDEXED, path UNINDEXED, tokenize='porter unicode61')")
    stats = {k: {'docs': 0, 'passages': 0, 'chars': 0} for k in SOURCES}
    for s, title, url, rel, text, fmt in docs(src):
        n = 0
        for sec, body in sections(text, asc=fmt == 'asc', wiki=fmt == 'wiki'):
            if sec.lower() in ('references', 'external links', 'see also', 'further reading', 'notes', 'browser compatibility', 'specifications'): continue
            for c in chunks(body):
                if len(c) < 120: continue
                db.execute('INSERT INTO p VALUES (?,?,?,?,?,?)', (title, sec, c, s, url, rel)); n += 1
                stats[s]['chars'] += len(c)
        if n: stats[s]['docs'] += 1; stats[s]['passages'] += n
    db.commit(); db.execute("INSERT INTO p(p) VALUES('optimize')"); db.commit(); db.close()
    os.replace(dbp, os.path.join(lib, 'library.db'))
    def du(path):
        return sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(path) for f in fs) if os.path.exists(path) else 0
    cat = {'built_at': int(time.time()), 'index': 'SQLite FTS5, bm25 ranking, porter stemming, ~1200-char passages',
           'db_bytes': os.path.getsize(os.path.join(lib, 'library.db')),
           'sources': [{'id': k, **v, **stats[k], 'bytes_on_disk': du(os.path.join(src, k))} for k, v in SOURCES.items()],
           'asset_sets': [{'id': k, **v, 'icons': len([f for f in os.listdir(os.path.join(src, k, 'icons' if k == 'lucide' else 'icons/outline')) if f.endswith('.svg')]) if os.path.exists(os.path.join(src, k)) else 0, 'bytes_on_disk': du(os.path.join(src, k))} for k, v in ASSET_SETS.items()],
           'not_included': ['Apple Human Interface Guidelines (copyrighted, no open license)', 'Laws of UX site (copyrighted; the same laws are covered through Wikipedia articles)', 'Refactoring UI, Inclusive Components and other paid/copyrighted books', 'Material Design 3 guideline site m3.material.io (not openly licensed; the Apache-2.0 Material Web docs are included instead)']}
    cat['total_bytes'] = du(lib) + sum(x['bytes_on_disk'] for x in cat['sources'] + cat['asset_sets'])
    json.dump(cat, open(os.path.join(lib, 'catalog.json'), 'w'), indent=1)
    return cat

if __name__ == '__main__':
    c = build(sys.argv[1], sys.argv[2])
    print(json.dumps({k: v for k, v in c.items() if k != 'sources'} | {'sources': [(s['id'], s['docs'], s['passages']) for s in c['sources']]}))
