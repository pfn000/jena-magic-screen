# Jena's skills: real, runnable abilities. Skill folders live in her GitHub repo (skills/<name>/skill.json +
# run.py), pulled onto her box every 10 minutes, plus ones she drafted herself (~/skills-local, enabled only
# after they pass validation on the box). Script skills run as her own unix user with a timeout; their last
# printed JSON line is the result. Some skills call MCP servers (fetch, filesystem sandboxed to her home,
# git read-only). Every run is counted: last used, ok/fail, last result. Nothing is listed that doesn't run.
import json, os, re, shutil, subprocess, sys, threading, time, py_compile, tempfile, urllib.request

HOME = os.path.expanduser('~')
REPO = os.path.join(HOME, 'jena-repo')
DIRS = [(os.path.join(REPO, 'skills'), 'repo'), (os.path.join(HOME, 'skills-local'), 'self-made')]
STATS = os.path.join(HOME, '.jena', 'skills_stats.json')
# skills run on the python that has her MCP client installed (pip --user under /usr/local/bin/python3)
PY = '/usr/local/bin/python3' if os.path.exists('/usr/local/bin/python3') else sys.executable
ORDER = ['ask_grok', 'explore_my_box', 'fetch_page', 'github_repos', 'web_search', 'repo_history', 'env_probe', 'my_files']
lock = threading.Lock()
desktop_skills = {}   # name -> python function(input) -> result (skills that use her screen)
mcp_cache = {'at': 0, 'servers': {}}

def _stats():
    try: return json.load(open(STATS))
    except Exception: return {}

def _save_stats(s):
    os.makedirs(os.path.dirname(STATS), exist_ok=True)
    json.dump(s, open(STATS, 'w'))

def load():
    out = {}
    for d, src in DIRS:
        if not os.path.isdir(d): continue
        for name in sorted(os.listdir(d)):
            p = os.path.join(d, name, 'skill.json')
            if name.startswith('_') or not os.path.exists(p): continue
            try: spec = json.load(open(p))
            except Exception as e:
                out[name] = {'name': name, 'source': src, 'status': 'broken skill.json: ' + str(e)[:80]}; continue
            spec.update(dir=os.path.join(d, name), source=src)
            spec.setdefault('status', 'enabled')
            if spec.get('kind') == 'desktop' and name not in desktop_skills: spec['status'] = 'no desktop handler on this box'
            if spec.get('kind', 'script') == 'script' and not os.path.exists(os.path.join(spec['dir'], spec.get('entry') or 'run.py')): spec['status'] = 'missing run.py'
            out[name] = spec
    return out

def match(text):
    skills = load()
    names = [n for n in ORDER if n in skills] + [n for n in skills if n not in ORDER]
    for n in names:
        s = skills[n]
        if s.get('status') != 'enabled': continue
        for t in s.get('triggers', []):
            try:
                if re.search(t, text or '', re.I): return n
            except re.error: pass
    return None

def run(name, inp, timeout=None):
    skills = load()
    s = skills.get(name)
    t0 = time.time()
    if not s: res = {'ok': False, 'summary': f'no skill named {name}'}
    elif s.get('status') != 'enabled': res = {'ok': False, 'summary': f'{name} is not enabled ({s.get("status")})'}
    elif s.get('kind') == 'desktop':
        try: res = desktop_skills[name](inp) or {'ok': False, 'summary': 'no result'}
        except Exception as e: res = {'ok': False, 'summary': f'{name} crashed: {e}'}
    else:
        try:
            r = subprocess.run([PY, os.path.join(s['dir'], s.get('entry') or 'run.py')], input=json.dumps(inp), capture_output=True, text=True,
                               timeout=timeout or s.get('timeout', 60), cwd=s['dir'])
            last = (r.stdout.strip().splitlines() or [''])[-1]
            try: res = json.loads(last)
            except Exception: res = {'ok': False, 'summary': f'{name} printed no JSON result', 'stderr': r.stderr[-400:]}
        except subprocess.TimeoutExpired:
            res = {'ok': False, 'summary': f'{name} timed out'}
    res['ms'] = int((time.time() - t0) * 1000)
    with lock:
        st = _stats(); e = st.get(name, {'runs': 0, 'ok': 0, 'fail': 0})
        e['runs'] += 1; e['ok' if res.get('ok') else 'fail'] += 1
        e['last_used'] = int(time.time() * 1000); e['last_summary'] = str(res.get('summary', ''))[:300]; e['last_ms'] = res['ms']
        st[name] = e; _save_stats(st)
    return res

def mcp_status(refresh=False):
    if not refresh and time.time() - mcp_cache['at'] < 600 and mcp_cache['servers']: return mcp_cache['servers']
    lib = os.path.join(REPO, 'skills', '_lib')
    out = {}
    try:
        conf = json.load(open(os.path.join(REPO, 'skills', '_mcp.json')))
    except Exception as e:
        return {'error': f'no MCP config: {e}'}
    for name, c in conf.items():
        code = f"import sys,json; sys.path.insert(0,{lib!r}); from jenaskill import mcp; print(json.dumps(mcp({name!r})))"
        try:
            r = subprocess.run([PY, '-c', code], capture_output=True, text=True, timeout=45, cwd=HOME)
            tools = json.loads((r.stdout.strip().splitlines() or ['null'])[-1])
            if not isinstance(tools, list): raise RuntimeError((r.stderr.strip().splitlines() or ['no answer'])[-1])
            allow = c.get('allow')
            for t in tools: t['allowed'] = (allow is None) or (t['name'] in allow)
            out[name] = {'what': c.get('what'), 'connected': True, 'tools': tools, 'allow': allow}
        except Exception as e:
            out[name] = {'what': c.get('what'), 'connected': False, 'error': str(e)[:160]}
    mcp_cache.update(at=time.time(), servers=out)
    return out

def listing():
    st = _stats()
    skills = []
    for n, s in load().items():
        skills.append({'name': n, 'description': s.get('description'), 'source': s.get('source'), 'kind': s.get('kind', 'script'), 'status': s.get('status'),
                       'needs': s.get('needs', []), 'triggers': s.get('triggers', []), 'validation': s.get('validation'), 'made_by': s.get('made_by'), **st.get(n, {'runs': 0, 'ok': 0, 'fail': 0})})
    return {'skills': skills, 'mcp': mcp_cache['servers'] or None, 'mcp_checked_at': int(mcp_cache['at'] * 1000) or None}

TEMPLATE = """import os, sys, json, re, urllib.request, urllib.parse
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'jena-repo', 'skills', '_lib'))
from jenaskill import inp, done
i = inp()
{body}
"""

def create(name, goal, brain='http://127.0.0.1:8088/v1'):
    """she drafts a new skill with her own brain; it is only enabled if it passes validation here"""
    name = re.sub(r'[^a-z0-9_]', '_', name.lower())[:40] or 'new_skill'
    d = os.path.join(HOME, 'skills-local', name)
    os.makedirs(d, exist_ok=True)
    prompt = ("Write the body of a small Python 3 script. Variable i is a dict of inputs. Use only the standard library. "
              "At the end call done(True, 'one line summary', result=...) or done(False, 'why'). No markdown, only code.\nTask: " + goal)
    status, test, err, attempts = 'failed validation', {}, '', []
    for attempt in range(3):   # she gets 3 tries; each failed check is fed back to her
        body, err = '', ''
        msg = prompt if not attempts else prompt + f"\nYour last try failed: {attempts[-1]}. Fix it. One statement per line."
        try:
            req = urllib.request.Request(brain + '/chat/completions', data=json.dumps({'messages': [{'role': 'user', 'content': msg}], 'max_tokens': 300, 'temperature': 0.3 + 0.2 * attempt}).encode(), headers={'Content-Type': 'application/json'})
            body = json.loads(urllib.request.urlopen(req, timeout=60).read())['choices'][0]['message']['content']
            body = re.sub(r'^```\w*|```$', '', body.strip(), flags=re.M).strip()
        except Exception as e:
            err = f'brain did not answer: {e}'; attempts.append(err); break
        code = TEMPLATE.format(body=body)
        open(os.path.join(d, 'run.py'), 'w').write(code)
        try:
            py_compile.compile(os.path.join(d, 'run.py'), doraise=True)
            r = subprocess.run([PY, os.path.join(d, 'run.py')], input='{"test": true}', capture_output=True, text=True, timeout=10, cwd=d)
            last = (r.stdout.strip().splitlines() or [''])[-1]
            try: test = json.loads(last)
            except Exception: raise RuntimeError('printed no JSON result' + (': ' + r.stderr.strip().splitlines()[-1][:120] if r.stderr.strip() else ''))
            if test.get('ok') is True: status = 'enabled'; break
            err = 'its own test run reported failure: ' + str(test.get('summary', ''))[:100] if 'ok' in test else 'test run printed JSON without "ok"'
        except py_compile.PyCompileError as e: err = 'does not compile: ' + str(e).strip().splitlines()[-1][:160]
        except subprocess.TimeoutExpired: err = 'test run timed out'
        except Exception as e: err = f'test run failed: {str(e)[:160]}'
        attempts.append(err)
    code = open(os.path.join(d, 'run.py')).read() if os.path.exists(os.path.join(d, 'run.py')) else ''
    spec = {'name': name, 'description': goal[:200], 'triggers': [], 'kind': 'script', 'entry': 'run.py', 'timeout': 20, 'status': status, 'made_by': 'Jena (her own brain)', 'validation': ('passed: compiled, and its test run on her box returned ok' if status == 'enabled' else err), 'attempts': attempts, 'created': int(time.time() * 1000)}
    json.dump(spec, open(os.path.join(d, 'skill.json'), 'w'), indent=1)
    return {'ok': status == 'enabled', 'name': name, 'status': status, 'validation': spec['validation'], 'attempts': attempts, 'code': code[-1500:], 'test': test}

def sync_loop():
    while True:
        try:
            if os.path.isdir(os.path.join(REPO, '.git')):
                subprocess.run(['git', '-C', REPO, 'pull', '-q', '--ff-only'], capture_output=True, timeout=60)
            else:
                subprocess.run(['git', 'clone', '-q', '--depth', '30', 'https://github.com/pfn000/jena-magic-screen', REPO], capture_output=True, timeout=120)
            mcp_status(refresh=True)
        except Exception as e:
            print('skills sync', e, flush=True)
        time.sleep(600)
