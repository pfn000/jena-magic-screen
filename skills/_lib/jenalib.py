# Jena's library: search the open-licensed design/dev books on her box (/home/jena/library/library.db, SQLite FTS5).
# Every passage comes back with its source title, section, license and link, so she can cite it.
import json, os, re, sqlite3
LIB = os.environ.get('JENA_LIBRARY', os.path.expanduser('~/library'))
STOP = set('the a an and or of to in on for with is are be it this that what how why does do my your me you can i jena please about from by as at'.split())
_cat = None
SHORT = {'mdn': 'MDN', 'webdev': 'web.dev', 'wcag': 'W3C WCAG 2.2', 'eloquent': 'Eloquent JavaScript', 'ydkjs': "You Don't Know JS", 'odin': 'The Odin Project', 'fso': 'Full Stack Open', 'react': 'react.dev', 'progit': 'Pro Git', 'mweb': 'Material Web', 'wikipedia': 'Wikipedia', 'opencolor': 'Open Color'}

def catalog():
    global _cat
    if _cat is None:
        try: _cat = {s['id']: s for s in json.load(open(os.path.join(LIB, 'catalog.json')))['sources']}
        except Exception: _cat = {}
    return _cat

def _terms(q):
    return [w for w in re.findall(r"[a-z0-9][a-z0-9-]{1,}", q.lower()) if w not in STOP][:12]

def lookup(q, n=3, sources=None):
    p = os.path.join(LIB, 'library.db')
    if not os.path.exists(p): return []
    t = _terms(q)
    if not t: return []
    db = sqlite3.connect(f'file:{p}?mode=ro', uri=True)
    where = ' AND source IN (%s)' % ','.join('?' * len(sources)) if sources else ''
    rows = []
    q_all = ' AND '.join('"%s"' % w for w in t)
    q_any = ' OR '.join('"%s"' % w for w in t)
    for fq in ([q_all, q_any] if len(t) > 1 else [q_any]):
        try:
            rows = db.execute('SELECT title, section, body, source, url, bm25(p, 8.0, 3.0, 1.0) FROM p WHERE p MATCH ?' + where + ' ORDER BY bm25(p, 8.0, 3.0, 1.0) LIMIT ?', [fq, *(sources or []), n * 4]).fetchall()
        except sqlite3.Error: rows = []
        if len(rows) >= n: break
    db.close()
    out, seen = [], {}
    for title, sec, body, src, url, score in rows:
        if seen.get(title, 0) >= 1: continue   # one passage per document, so answers cite different books
        seen[title] = seen.get(title, 0) + 1
        c = catalog().get(src, {})
        out.append({'title': title, 'section': sec, 'book': c.get('title', src), 'short': SHORT.get(src, src), 'license_short': c.get('license', '?').split(' (')[0].split(';')[0], 'license': c.get('license', '?'), 'url': url,
                    'passage': re.sub(r'\s+', ' ', body).strip()[:700], 'score': round(-score, 2)})
        if len(out) >= n: break
    return out

def cite(h):
    return f'{h["title"]}{" › " + h["section"] if h.get("section") else ""} ({h["license"]})'
