# Jena's studio on her box: her design/dev library, the assets she makes, and her site-edit proposals.
# Loaded by her desktop agent (jena_desk.py) from her repo checkout and reloaded when the file changes,
# so updates land without restarting her. Everything here reads real files on her box; nothing is cached
# from elsewhere or invented. Mama-only doors check her passcode (is_mama) like the rest of the agent.
import json, os, re, time, urllib.request, mimetypes
HOME = os.path.expanduser('~')
LIB = os.path.join(HOME, 'library')
ASSETS = os.path.join(HOME, 'assets')
CI = 'http://127.0.0.1:6085'

def _j(o, status=200): return status, 'application/json', json.dumps(o).encode()

def library(qs):
    try: cat = json.load(open(os.path.join(LIB, 'catalog.json')))
    except Exception as e: return _j({'ok': False, 'error': f'no library catalog on her box: {e}'}, 404)
    q = (qs.get('q') or [''])[0][:200]
    if q:
        import sys
        sys.path.insert(0, os.path.join(HOME, 'jena-repo', 'skills', '_lib'))
        from jenalib import lookup
        cat['results'] = lookup(q, n=5)
    return _j(cat)

def assets_index():
    out = []
    try: lines = open(os.path.join(ASSETS, 'index.jsonl')).read().splitlines()
    except Exception: lines = []
    for l in lines[-120:]:
        try: a = json.loads(l)
        except Exception: continue
        sp = os.path.join(ASSETS, a.get('svg', ''))
        if a.get('svg') and os.path.exists(sp) and os.path.getsize(sp) < 60000: a['svg_text'] = open(sp).read()
        out.append(a)
    return _j({'count': len(out), 'dir': '~/assets', 'assets': out[::-1]})

def asset_file(name):
    if not re.fullmatch(r'[\w.-]+\.(svg|png|css|html)', name or ''): return _j({'error': 'bad name'}, 400)
    p = os.path.join(ASSETS, name)
    if not os.path.exists(p): return _j({'error': 'no such asset'}, 404)
    return 200, mimetypes.guess_type(name)[0] or 'application/octet-stream', open(p, 'rb').read()

def ci(path, body=None, timeout=20):
    try:
        req = urllib.request.Request(CI + path, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=timeout) as r: return 200, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except Exception: return e.code, {'ok': False, 'error': str(e)}
    except Exception as e:
        return 503, {'ok': False, 'error': f'her site-edit checker is not answering: {e}'}

def handle(p, method, body, hdrs, qs, is_mama):
    if p == '/box/studio/library': return library(qs)
    if p == '/box/studio/assets': return assets_index()
    if p.startswith('/box/studio/asset/'): return asset_file(os.path.basename(p))
    if p == '/box/studio/edits':
        st, d = ci('/status'); return _j(d, st)
    if p.startswith('/box/studio/mama/'):
        if not is_mama(hdrs): return _j({'ok': False, 'summary': "mama's passcode is needed for this"}, 401)
        op = p.rsplit('/', 1)[-1]
        if op not in ('merge', 'rollback', 'discard'): return _j({'ok': False, 'error': 'no such door'}, 404)
        try: b = json.loads(body or b'{}')
        except Exception: b = {}
        st, d = ci('/' + op, {'id': str(b.get('id', ''))[:80], 'by': 'mama'}, timeout=240)
        return _j(d, st)
    return _j({'error': 'not here'}, 404)
