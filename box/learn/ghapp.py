
# GitHub through the user's connected GitHub app (connected-apps CLI), git data API: blobs -> tree -> commit ->
# fast-forward the branch (force: false). A non-fast-forward means someone pushed meanwhile: re-read the head and
# rebuild the tree on top of it (the "pull --rebase" of the data API). Never forces.
import json, os, subprocess, base64, time, uuid
CLI = '/home/user/tab/connected-apps-cli.mjs'
REPO = 'pfn000/jena-magic-screen'
TASK = os.environ.get('TAB_TASK_ID') or '674daac5-8657-4a93-a0b7-17232c67c598'
def req(method, url, body=None, tries=4):
    d = f'/home/user/tab/tasks/{TASK}'; os.makedirs(d, exist_ok=True)
    p = f'{d}/gh-{uuid.uuid4().hex[:8]}.json'
    r = {'toolkit': 'github', 'method': method, 'url': url, 'headers': {'Accept': 'application/vnd.github+json'}}
    if body is not None: r['body'] = body
    json.dump(r, open(p, 'w'))
    last = None
    for k in range(tries):
        out = subprocess.run(['/usr/bin/node', CLI, 'connected_apps.request', p], capture_output=True, text=True, timeout=180, env={**os.environ, 'TAB_TASK_ID': TASK})
        try: j = json.loads(out.stdout)
        except Exception: j = {'ok': False, 'error': (out.stdout + out.stderr)[-400:]}
        last = j
        st = status(j)
        if j.get('ok') is not False and (st is None or int(st) < 500) and st not in (403, 429): break
        if st in (422, 404, 409): break
        time.sleep(20 * (k + 1))
    try: os.remove(p)
    except Exception: pass
    return last
def data(j):
    if isinstance(j, dict) and isinstance(j.get('result'), dict) and 'body' in j['result']: return j['result']['body']
    for k in ('data', 'body', 'response_data', 'json'):
        if isinstance(j, dict) and k in j and j[k] is not None:
            v = j[k]
            if isinstance(v, dict) and 'body' in v and isinstance(v['body'], (dict, list)): return v['body']
            return v
    return j
def status(j):
    if isinstance(j, dict) and isinstance(j.get('result'), dict) and j['result'].get('status'): return j['result']['status']
    return j.get('status') or (j.get('response') or {}).get('status') or j.get('http_status')
def commit_files(files, message, branch='main', delete=()):
    """files: {path: bytes}. Returns new commit sha. One commit for the whole batch."""
    blobs = {}
    for path, b in files.items():
        r = data(req('POST', f'/repos/{REPO}/git/blobs', {'content': base64.b64encode(b).decode(), 'encoding': 'base64'}))
        if not isinstance(r, dict) or not r.get('sha'): raise RuntimeError(f'blob failed for {path}: {str(r)[:300]}')
        blobs[path] = r['sha']
    for attempt in range(5):
        ref = data(req('GET', f'/repos/{REPO}/git/ref/heads/{branch}'))
        head = ref['object']['sha']
        c = data(req('GET', f'/repos/{REPO}/git/commits/{head}'))
        tree = [{'path': p, 'mode': '100644', 'type': 'blob', 'sha': s} for p, s in blobs.items()] + [{'path': p, 'mode': '100644', 'type': 'blob', 'sha': None} for p in delete]
        t = data(req('POST', f'/repos/{REPO}/git/trees', {'base_tree': c['tree']['sha'], 'tree': tree}))
        nc = data(req('POST', f'/repos/{REPO}/git/commits', {'message': message, 'tree': t['sha'], 'parents': [head]}))
        u = req('PATCH', f'/repos/{REPO}/git/refs/heads/{branch}', {'sha': nc['sha'], 'force': False})
        ud = data(u)
        if isinstance(ud, dict) and (ud.get('object') or {}).get('sha') == nc['sha']: return nc['sha']
        # unknown outcome or not a fast-forward: look before retrying
        ref2 = data(req('GET', f'/repos/{REPO}/git/ref/heads/{branch}'))
        if ref2['object']['sha'] == nc['sha']: return nc['sha']
        time.sleep(5 + attempt * 10)
    raise RuntimeError('could not fast-forward ' + branch + ' after 5 tries')
def get_file(path, ref='main'):
    r = req('GET', f'/repos/{REPO}/contents/{path}', None) if '?' in path else req('GET', f'/repos/{REPO}/contents/{path}?ref={ref}')
    d = data(r)
    if isinstance(d, dict) and d.get('content'): return base64.b64decode(d['content'])
    return None
def list_dir(path, ref='main'):
    d = data(req('GET', f'/repos/{REPO}/contents/{path}?ref={ref}'))
    return d if isinstance(d, list) else []
