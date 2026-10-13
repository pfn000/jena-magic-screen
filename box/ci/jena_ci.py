#!/usr/bin/env python3
# Jena's site-edit checker ("CI") on her box. Runs as its own user (jenaci), separate from Jena's user, and is the
# ONLY thing on the box that holds a key able to push to her GitHub repo (a deploy key in /home/jenaci/.ssh, which
# Jena's user cannot read). Rules it enforces in code:
#   * Jena (edit_my_site skill, localhost) may PROPOSE a change: it goes on its own branch jena/<id> in a sandbox clone,
#     never on main. Only small edits to the page itself are allowed (src/*.js|css, index.html, public assets).
#   * Checks before anything leaves the box: scope, parse + lint, full build, and a headless smoke test compared with
#     main (page loads, no new console/page errors, key parts present + visible, 390 px phone has no sideways scroll,
#     OBS ?obs=1 view intact). Only a branch that passes is pushed, which makes Vercel build a PREVIEW of it.
#   * Merge to main, discard, and rollback (revert Jena's last change on main) need mama's passcode, checked here
#     against the same hash her desktop agent uses. No auto-merge, ever. Nothing is force-pushed.
#   * Every step lands in mama's activity log (~jena/.jena/activity.jsonl, dev panel only) and in this checker's log.
import json, os, re, subprocess, threading, time, hashlib, secrets, urllib.request, shutil, queue, difflib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = '/home/jenaci'
SITE = HOME + '/site'            # sandbox clone (branches are made here)
BASE = HOME + '/base'            # worktree of main, built for the baseline smoke test
STATE = HOME + '/ci/state.json'
SMOKE = HOME + '/ci/smoke.cjs'
ACT = '/home/jena/.jena/activity.jsonl'
MAMA_HASH = '/home/jena/.jena/mama.sha256'
REPO = 'pfn000/jena-magic-screen'
PORT = 6085
ALLOWED = re.compile(r'^(src/[\w-]+\.(js|css)|index\.html|public/[\w./-]+\.(svg|png|webmanifest|json))$')
MAX_FILES, MAX_BYTES, MAX_DIFF_LINES, MAX_PER_DAY = 5, 200_000, 400, 12
KEEP = ['-e', 'node_modules', '-e', 'public/mediapipe', '-e', 'public/bg-room.jpg']

lock = threading.Lock()
jobs = queue.Queue()

def now(): return int(time.time())
def load():
    try: return json.load(open(STATE))
    except Exception: return {'proposals': [], 'log': [], 'baseline': None}
S = load()
def save():
    tmp = STATE + '.tmp'; json.dump(S, open(tmp, 'w'), indent=1); os.replace(tmp, STATE)

def log(text, kind='site_edit', why='', mama=True):
    line = time.strftime('%H:%M:%S ') + text
    with lock:
        S['log'] = (S.get('log', []) + [line])[-300:]; save()
    print(line, flush=True)
    if mama:
        try:
            with open(ACT, 'a') as f: f.write(json.dumps({'ts': int(time.time() * 1000), 'kind': kind, 'what': text[:300], 'why': why[:200]}) + '\n')
        except Exception as e: print('activity log write failed', e, flush=True)

def run(cmd, cwd=SITE, timeout=240, env=None):
    e = dict(os.environ, HOME=HOME, GIT_TERMINAL_PROMPT='0'); e.update(env or {})
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=e, shell=isinstance(cmd, str))
    return r.returncode, (r.stdout + r.stderr)

def git(*a, cwd=SITE, timeout=120):
    return run(['git', *a], cwd=cwd, timeout=timeout)

def is_mama(key):
    try: want = open(MAMA_HASH).read().strip()
    except Exception: return False
    got = hashlib.sha256((key or '').encode()).hexdigest()
    return bool(want) and secrets.compare_digest(want, got)

def find(pid):
    return next((p for p in S['proposals'] if p['id'] == pid), None)

# ------------------------------------------------------------------ checks
def lint_file(path, text):
    probs = []
    if path.endswith('.js'):
        if re.search(r'\bdebugger\b', text): probs.append('debugger statement')
        if re.search(r'(?<![\w.])eval\s*\(|new Function\s*\(', text): probs.append('eval / new Function')
        if re.search(r'document\.write\s*\(', text): probs.append('document.write')
    if path.endswith('.html'):
        if re.search(r'\son(click|load|error|mouseover)\s*=', text, re.I): probs.append('inline event handler attribute')
    if re.search(r'["\'(]http://(?!localhost|127\.0\.0\.1)', text): probs.append('insecure http:// URL')
    return probs

def check_parse(paths, root):
    out = []
    for p in paths:
        fp = os.path.join(root, p)
        if p.endswith('.js'):
            c, o = run(['node', '--check', fp], cwd=root, timeout=30)
            out.append((p, c == 0, '' if c == 0 else o.strip().splitlines()[-1][:200] if o.strip() else 'syntax error'))
        elif p.endswith('.css'):
            js = "const postcss=require('postcss');try{postcss.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log('ok')}catch(e){console.log('CSS: '+e.reason+' at line '+e.line);process.exit(1)}"
            c, o = run(['node', '-e', js, fp], cwd=root, timeout=30)
            out.append((p, c == 0, '' if c == 0 else o.strip()[-200:]))
        elif p.endswith('.html'):
            js = ("const {parse}=require('parse5');const t=require('fs').readFileSync(process.argv[1],'utf8');const errs=[];"
                  "parse(t,{onParseError:(e)=>{if(!/missing-doctype/.test(e.code))errs.push(e.code+' line '+e.startLine)}});"
                  "if(errs.length){console.log('HTML: '+errs.slice(0,3).join(', '));process.exit(1)}console.log('ok')")
            c, o = run(['node', '-e', js, fp], cwd=root, timeout=30)
            if 'Cannot find module' in o: c, o = 0, ''   # parse5 not installed: the build still parses the page
            out.append((p, c == 0, '' if c == 0 else o.strip()[-200:]))
        elif p.endswith('.json') or p.endswith('.webmanifest'):
            try: json.load(open(fp)); out.append((p, True, ''))
            except Exception as e: out.append((p, False, f'JSON: {e}'[:200]))
        elif p.endswith('.svg'):
            c, o = run(['rsvg-convert', '-o', '/dev/null', fp], cwd=root, timeout=30)
            out.append((p, c == 0, '' if c == 0 else o.strip()[-200:]))
    return out

def build(root):
    c, o = run('npm run build --silent', cwd=root, timeout=300)
    tail = '\n'.join([l for l in o.splitlines() if l.strip() and 'npm notice' not in l][-6:])
    return c == 0, tail

def smoke(root, port):
    srv = subprocess.Popen(['node', 'server.mjs'], cwd=root, env=dict(os.environ, HOME=HOME, PORT=str(port)), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(40):
            try: urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=2); break
            except Exception: time.sleep(0.5)
        c, o = run(['node', SMOKE, f'http://127.0.0.1:{port}'], cwd=root, timeout=420)
        try: return json.loads(o.strip().splitlines()[-1])
        except Exception: return {'error': 'smoke test crashed: ' + o[-300:]}
    finally:
        srv.terminate()
        try: srv.wait(5)
        except Exception: srv.kill()

def norm(m): return re.sub(r'\d+', '#', re.sub(r'https?://[^\s)]+', 'URL', m))[:160]

def compare(base, br):
    checks = []
    if br.get('error'): return [('smoke test ran', False, br['error'])]
    for view in ('desktop', 'phone390', 'obs'):
        v, b0 = br['views'].get(view, {}), (base or {}).get('views', {}).get(view, {})
        if v.get('loadError') or v.get('status') != 200:
            checks.append((f'{view}: page loads', False, v.get('loadError') or f"HTTP {v.get('status')}")); continue
        checks.append((f'{view}: page loads', True, f"HTTP 200, title “{v.get('title', '')}”"))
        old = {norm(x) for x in b0.get('errors', []) + b0.get('pageErrors', [])}
        new = [x for x in v.get('pageErrors', []) + v.get('errors', []) if norm(x) not in old]
        checks.append((f'{view}: no new console/page errors', not new, ('NEW: ' + ' | '.join(new[:3])) if new else f"{len(v.get('errors', [])) + len(v.get('pageErrors', []))} errors, same as main"))
        miss = [k for k, ok in v.get('present', {}).items() if not ok]
        lost = [k for k, ok in v.get('visible', {}).items() if b0.get('visible', {}).get(k) and not ok]
        checks.append((f'{view}: key parts present + visible', not miss and not lost, ('missing ' + ', '.join(miss) if miss else '') + (' hidden now: ' + ', '.join(lost) if lost else '') or 'stage, avatar, desktop, chat, talk box, thought chain'))
        if view == 'phone390':
            over = v.get('scrollWidth', 0) > v.get('innerWidth', 390) + 1 or v.get('pastRightEdge')
            checks.append(('phone 390 px: no sideways scroll', not over, f"page {v.get('scrollWidth')} px wide" + (f", past the edge: {', '.join(v.get('pastRightEdge'))}" if v.get('pastRightEdge') else '')))
        if view == 'obs':
            moved = []
            for k, bx in (v.get('boxes') or {}).items():
                ob = (b0.get('boxes') or {}).get(k)
                if ob and bx and max(abs(a - c) for a, c in zip(ob, bx)) > 4: moved.append(f'{k} {ob}→{bx}')
            checks.append(('OBS ?obs=1 view intact', not moved, ('moved: ' + '; '.join(moved)) if moved else 'panels where they were on main (±4 px)'))
    return checks

def baseline(main_sha):
    b = S.get('baseline')
    if b and b.get('sha') == main_sha: return b['smoke']
    log(f'building main {main_sha[:7]} for the baseline smoke test', mama=False)
    if not os.path.isdir(BASE): git('worktree', 'add', '--detach', BASE, main_sha)
    git('checkout', '-q', '--detach', main_sha, cwd=BASE); git('clean', '-fdq', *KEEP, cwd=BASE)
    if not os.path.exists(BASE + '/node_modules'): os.symlink(SITE + '/node_modules', BASE + '/node_modules')
    ok, tail = build(BASE)
    if not ok: return {'error': 'main itself does not build: ' + tail}
    sm = smoke(BASE, 4181)
    with lock: S['baseline'] = {'sha': main_sha, 'smoke': sm, 'at': now()}; save()
    return sm

# ------------------------------------------------------------------ jobs
def set_p(p, **kw):
    with lock: p.update(kw); save()

def do_propose(p):
    br = p['branch']; checks = []
    def add(name, ok, detail=''):
        checks.append({'name': name, 'ok': bool(ok), 'detail': str(detail)[:300]}); set_p(p, checks=list(checks))
        log(f"[{p['id']}] {'✅' if ok else '❌'} {name}{' — ' + str(detail)[:160] if detail else ''}", mama=False)
        return ok
    try:
        set_p(p, state='checking')
        git('fetch', '-q', 'origin', 'main')
        main_sha = git('rev-parse', 'origin/main')[1].strip()
        git('checkout', '-q', '-f', '-B', br, 'origin/main'); git('clean', '-fdq', *KEEP)
        # apply her edits
        changed = []
        for ed in p['edits']:
            path = ed['path']; fp = os.path.join(SITE, path)
            if 'content' in ed:
                os.makedirs(os.path.dirname(fp), exist_ok=True); open(fp, 'w').write(ed['content'])
            else:
                if not os.path.exists(fp): raise ValueError(f'{path} does not exist on main')
                t = open(fp).read(); n = t.count(ed['find'])
                if n != 1: raise ValueError(f'“{ed["find"][:60]}” is in {path} {n} times; it has to match exactly once')
                open(fp, 'w').write(t.replace(ed['find'], ed['replace'], 1))
            if path not in changed: changed.append(path)
        diff = git('diff', '--stat', 'HEAD')[1] + '\n' + git('diff', 'HEAD')[1]
        nlines = sum(1 for l in diff.splitlines() if l[:1] in '+-' and not l.startswith(('+++', '---')))
        set_p(p, diff=diff[:6000], files=changed, main=main_sha)
        bad = [c for c in changed if not ALLOWED.match(c)]
        size = sum(os.path.getsize(os.path.join(SITE, c)) for c in changed if os.path.exists(os.path.join(SITE, c)))
        if not add('scope: only page files, small change', not bad and len(changed) <= MAX_FILES and nlines <= MAX_DIFF_LINES and nlines > 0,
                   (f'not allowed: {", ".join(bad)}' if bad else f'{len(changed)} file(s), {nlines} changed lines' if nlines else 'nothing changed')): return finish(p, 'failed')
        parse = check_parse(changed, SITE)
        perr = [f'{f}: {d}' for f, ok, d in parse if not ok]
        if not add('parse (node --check / CSS / HTML / SVG)', not perr, '; '.join(perr) or ', '.join(f for f, _, _ in parse) + ' parse'): return finish(p, 'failed')
        lint = []
        for c in changed:
            fp = os.path.join(SITE, c)
            if c.endswith(('.js', '.css', '.html')):
                before = git('show', f'origin/main:{c}')[1] if git('cat-file', '-e', f'origin/main:{c}')[0] == 0 else ''
                now_t = open(fp).read()
                lint += [f'{c}: {x}' for x in lint_file(c, now_t) if x not in lint_file(c, before)]
        if not add('lint (no debugger/eval/document.write/inline handlers/http://)', not lint, '; '.join(lint) or 'clean'): return finish(p, 'failed')
        ok, tail = build(SITE)
        if not add('build (npm run build, same as Vercel)', ok, 'built dist/' if ok else tail): return finish(p, 'failed')
        base = baseline(main_sha)
        git('checkout', '-q', br)   # (baseline uses its own worktree)
        sm = smoke(SITE, 4180)
        for name, ok, detail in compare(base, sm): add('smoke · ' + name, ok, detail)
        if not all(c['ok'] for c in checks): return finish(p, 'failed')
        # all green: commit on her branch and push it (never main) -> Vercel builds a preview
        git('add', '-A', '--', *changed)
        msg = f"[jena] {p['title']}\n\nwhy: {p.get('why', '')}\n\nProposed by Jena with edit_my_site. Checks passed on her box: " + ', '.join(c['name'] for c in checks) + ".\nNOT merged: only mama can merge this from the dev panel."
        c, o = git('commit', '-q', '-m', msg)
        if c: add('commit', False, o[-200:]); return finish(p, 'failed')
        sha = git('rev-parse', 'HEAD')[1].strip()
        c, o = git('push', '-q', 'origin', f'{br}:refs/heads/{br}', timeout=120)
        if not add(f'pushed branch {br} (not main)', c == 0, sha[:7] if c == 0 else o[-200:]): return finish(p, 'failed')
        set_p(p, sha=sha, pushed=now())
        finish(p, 'ready', note=f'branch {br} pushed; waiting for the Vercel preview')
        threading.Thread(target=find_preview, args=(p,), daemon=True).start()
    except Exception as e:
        add('run', False, f'{type(e).__name__}: {e}'); finish(p, 'failed')

def finish(p, state, note=''):
    set_p(p, state=state, done_at=now())
    bad = [c['name'] + (' — ' + c['detail'] if c['detail'] else '') for c in p.get('checks', []) if not c['ok']]
    if state == 'failed': log(f"Jena's change “{p['title']}” FAILED the checks and was NOT pushed: {'; '.join(bad)[:220]}", why=p.get('why', ''))
    elif state == 'ready': log(f"Jena's change “{p['title']}” passed {len(p.get('checks', []))} checks; {note}. Waiting for mama to merge.", why=p.get('why', ''))

def gh_public(path):
    req = urllib.request.Request('https://api.github.com/repos/' + REPO + path, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'jena-ci'})
    with urllib.request.urlopen(req, timeout=15) as r: return json.loads(r.read())

def find_preview(p):
    for _ in range(40):          # ~10 min
        time.sleep(15)
        try:
            deps = gh_public(f"/deployments?sha={p['sha']}")
            for d in deps:
                sts = gh_public(f"/deployments/{d['id']}/statuses")
                for s in sts:
                    if s.get('state') == 'success' and (s.get('environment_url') or s.get('target_url')):
                        url = s.get('environment_url') or s.get('target_url')
                        note = ''
                        try:
                            code = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'jena-ci'}), timeout=15).status
                        except urllib.error.HTTPError as e: code = e.code
                        except Exception as e: code = str(e)[:60]
                        if code == 401: note = 'Vercel asks for a Vercel login on previews (Deployment Protection): open it while signed in to Vercel'
                        elif code != 200: note = f'preview answered {code}'
                        set_p(p, preview=url, preview_note=note, preview_status=code, preview_env=d.get('environment'))
                        log(f"Vercel preview of Jena's change “{p['title']}” is up: {url}" + (f' ({note})' if note else ''))
                        return
                    if s.get('state') in ('failure', 'error'):
                        set_p(p, preview_note=f"Vercel's preview build failed ({s.get('description', '')})"); log(f"Vercel preview build FAILED for “{p['title']}”"); return
        except Exception as e:
            print('preview poll', e, flush=True)
    set_p(p, preview_note='no Vercel preview seen within 10 min')

GH_MERGE = re.compile(r'^Merge pull request #\d+ from [\w.-]+/jena/')
def is_jena_merge(subject):
    # a Jena change that reached main: merged by this checker after mama's OK in the dev panel ("[jena] merge: ..."),
    # or merged by mama herself on GitHub (her pull request from a jena/* branch); both are mama's approval
    return subject.startswith('[jena] merge:') or bool(GH_MERGE.match(subject))

def jena_commits(limit=60):
    git('fetch', '-q', 'origin', 'main')
    c, o = git('log', f'-{limit}', '--format=%H%x1f%s%x1f%b%x1e', 'origin/main')
    out = []
    for rec in o.split('\x1e'):
        f = rec.strip().split('\x1f')
        if len(f) >= 2: out.append({'sha': f[0], 'message': f[1], 'body': f[2] if len(f) > 2 else ''})
    reverted = set(re.findall(r'This reverts commit ([0-9a-f]{40})', ' '.join(x['body'] for x in out)))
    return [x for x in out if is_jena_merge(x['message']) and x['sha'] not in reverted]

def sync_merged():
    """a ready branch that is now part of main was merged by mama (here, or on GitHub): record it once"""
    try:
        pend = [p for p in S['proposals'] if p.get('state') == 'ready' and p.get('sha')]
        if not pend: return
        git('fetch', '-q', 'origin', 'main')
        for p in pend:
            if git('merge-base', '--is-ancestor', p['sha'], 'origin/main')[0] != 0: continue
            c, o = git('log', '--merges', '--ancestry-path', '--reverse', '--format=%H%x1f%s%x1f%an', f"{p['sha']}..origin/main")
            first = (o.strip().splitlines() or [''])[0].split('\x1f')
            msha, subj, who = (first + ['', '', ''])[:3]
            how = 'on GitHub' if GH_MERGE.match(subj) else 'in the dev panel' if subj.startswith('[jena] merge:') else 'directly'
            set_p(p, state='merged', merged_sha=msha or p['sha'], merged_at=now(), merged_via=f'mama merged it {how}' + (f' ({who})' if who else ''))
            log(f"mama merged Jena's change “{p['title']}” {how} ({(msha or p['sha'])[:7]}{', ' + subj[:60] if subj else ''}); live site redeploys from main. Undo = rollback button.", kind='site_edit_mama')
    except Exception as e:
        print('sync_merged', e, flush=True)

def syncer():
    while True:
        time.sleep(60)
        if jobs.empty(): sync_merged()

def push_main(why):
    for attempt in range(2):
        c, o = git('push', '-q', 'origin', 'HEAD:refs/heads/main', timeout=120)
        if c == 0: return True, ''
        if 'rejected' in o or 'fetch first' in o or 'non-fast-forward' in o:
            return False, 'main moved while I worked (someone pushed); nothing was pushed, try again'
    return False, o[-200:]

def do_merge(p):
    try:
        set_p(p, state='merging')
        git('fetch', '-q', 'origin'); git('checkout', '-q', '-f', '-B', 'merge-work', 'origin/main'); git('clean', '-fdq', *KEEP)
        c, o = git('merge', '--no-ff', '-m', f"[jena] merge: {p['title']} (approved by mama in the dev panel)\n\nwhy: {p.get('why', '')}\nbranch {p['branch']} ({p.get('sha', '')[:7]}), all checks passed before mama approved.", p.get('sha') or ('origin/' + p['branch']))
        if c:
            git('merge', '--abort'); set_p(p, state='ready'); log(f"merge of “{p['title']}” stopped: it conflicts with newer changes on main. Nothing pushed; Jena needs to redo it."); return
        ok, tail = build(SITE)
        if not ok: set_p(p, state='ready'); log(f"merge of “{p['title']}” stopped: main + her change does not build any more. Nothing pushed. {tail[-150:]}"); return
        ok, err = push_main('merge')
        if not ok: set_p(p, state='ready'); log(f"merge of “{p['title']}” not pushed: {err}"); return
        sha = git('rev-parse', 'HEAD')[1].strip()
        set_p(p, state='merged', merged_sha=sha, merged_at=now())
        log(f"mama merged Jena's change “{p['title']}” into main ({sha[:7]}); the live site redeploys in ~1 min. Undo = rollback button.", kind='site_edit_mama')
    except Exception as e:
        set_p(p, state='ready'); log(f'merge failed: {e}')

def do_rollback():
    try:
        js = jena_commits()
        if not js: log('rollback: there is no Jena commit on main to undo', kind='site_edit_mama'); return
        t = js[0]
        git('checkout', '-q', '-f', '-B', 'merge-work', 'origin/main'); git('clean', '-fdq', *KEEP)
        parents = git('rev-list', '--parents', '-n', '1', t['sha'])[1].split()
        args = ['revert', '--no-edit'] + (['-m', '1'] if len(parents) > 2 else []) + [t['sha']]
        c, o = git(*args)
        if c: git('revert', '--abort'); log(f"rollback of {t['sha'][:7]} stopped: later changes touch the same lines. Nothing pushed. {o[-120:]}", kind='site_edit_mama'); return
        git('commit', '--amend', '-q', '-m', f"Revert \"{t['message']}\" (mama pressed undo in the dev panel)\n\nThis reverts commit {t['sha']}.")
        ok, tail = build(SITE)
        if not ok: log(f'rollback stopped: the reverted site does not build. Nothing pushed. {tail[-150:]}', kind='site_edit_mama'); return
        ok, err = push_main('rollback')
        if not ok: log('rollback not pushed: ' + err, kind='site_edit_mama'); return
        sha = git('rev-parse', 'HEAD')[1].strip()
        for p in S['proposals']:
            if p.get('merged_sha') == t['sha']: set_p(p, state='rolled_back', rolled_back_sha=sha)
        log(f"mama rolled back Jena's last change “{t['message']}” ({t['sha'][:7]} reverted by {sha[:7]}); the live site redeploys in ~1 min.", kind='site_edit_mama')
    except Exception as e:
        log(f'rollback failed: {e}', kind='site_edit_mama')

def worker():
    while True:
        kind, arg = jobs.get()
        try:
            if kind == 'propose': do_propose(arg)
            elif kind == 'merge': do_merge(arg)
            elif kind == 'rollback': do_rollback()
        except Exception as e: log(f'{kind} crashed: {e}')

# ------------------------------------------------------------------ http (localhost only)
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def body(self):
        n = min(int(self.headers.get('Content-Length') or 0), 400_000)
        try: return json.loads(self.rfile.read(n) or b'{}')
        except Exception: return {}
    def do_GET(self):
        if self.path.startswith('/status'):
            try: last = jena_commits()[:1]
            except Exception: last = []
            with lock:
                props = [{k: v for k, v in p.items() if k != 'edits'} for p in S['proposals'][-15:]][::-1]
                return self.send(200, {'ok': True, 'checker': 'jena-ci on her box (user jenaci; only it can push)', 'queue': jobs.qsize(), 'proposals': props, 'log': S.get('log', [])[-40:], 'last_jena_commit': last[0] if last else None,
                                       'rules': 'branch jena/<id> only; checks: scope, parse, lint, build, smoke (desktop, phone 390, OBS) vs main; passing branches pushed for a Vercel preview; merge/discard/rollback need mama'})
        self.send(404, {'error': 'not here'})
    def do_POST(self):
        b = self.body()
        if self.path == '/propose':
            edits = b.get('edits') or []
            title = re.sub(r'\s+', ' ', str(b.get('title', ''))).strip()[:100]
            if not title or not isinstance(edits, list) or not edits or len(edits) > MAX_FILES * 3: return self.send(400, {'ok': False, 'error': 'need a title and 1-15 edits'})
            clean = []
            for e in edits:
                path = str(e.get('path', ''))
                if not ALLOWED.match(path) or '..' in path: return self.send(403, {'ok': False, 'error': f'{path} is not a page file Jena may edit (allowed: src/*.js|css, index.html, public/*.svg|png|json|webmanifest)'})
                if 'content' in e: clean.append({'path': path, 'content': str(e['content'])[:MAX_BYTES]})
                elif e.get('find'): clean.append({'path': path, 'find': str(e['find'])[:5000], 'replace': str(e.get('replace', ''))[:5000]})
                else: return self.send(400, {'ok': False, 'error': 'each edit needs content, or find + replace'})
            today = [p for p in S['proposals'] if p['ts'] > now() - 86400]
            if len(today) >= MAX_PER_DAY: return self.send(429, {'ok': False, 'error': f'{MAX_PER_DAY} proposals a day max'})
            pid = time.strftime('%m%d-%H%M%S') + '-' + (re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')[:28] or 'edit')
            p = {'id': pid, 'ts': now(), 'title': title, 'why': str(b.get('why', ''))[:400], 'by': 'jena', 'branch': 'jena/' + pid, 'state': 'queued', 'edits': clean, 'checks': [],
                 'consulted': b.get('consulted') or None}
            with lock: S['proposals'] = (S['proposals'] + [p])[-60:]; save()
            log(f"Jena proposed a site change: “{title}” → branch {p['branch']} (checks running, nothing goes live without mama)", why=p['why'])
            jobs.put(('propose', p))
            return self.send(200, {'ok': True, 'id': pid, 'branch': p['branch'], 'state': 'queued', 'queue': jobs.qsize()})
        if self.path in ('/merge', '/discard', '/rollback'):
            if not is_mama(self.headers.get('X-Jena-Key')): return self.send(401, {'ok': False, 'summary': "mama's passcode is needed for this (checked by the site-edit checker itself)"})
            if self.path == '/rollback':
                jobs.put(('rollback', None)); log('mama asked to roll back Jena\'s last change on main (running)', kind='site_edit_mama')
                return self.send(200, {'ok': True, 'summary': 'rolling back Jena\'s last change: revert + build + push to main (~1 min). Watch the log here.'})
            p = find(str(b.get('id', '')))
            if not p: return self.send(404, {'ok': False, 'error': 'no such proposal'})
            if self.path == '/merge':
                if p['state'] != 'ready': return self.send(409, {'ok': False, 'error': f"it is {p['state']}, only a ready (all checks passed) change can be merged"})
                set_p(p, state='merge_queued'); jobs.put(('merge', p)); log(f"mama approved Jena's change “{p['title']}”: merging (build again, then push to main)", kind='site_edit_mama')
                return self.send(200, {'ok': True, 'summary': 'merging: build check again, then push to main (~1 min). Watch the log here.'})
            if p['state'] in ('merged', 'merging', 'merge_queued'): return self.send(409, {'ok': False, 'error': 'already merged; use rollback to undo it'})
            if p.get('sha'): git('push', '-q', 'origin', '--delete', p['branch'])
            set_p(p, state='discarded'); log(f"mama discarded Jena's change “{p['title']}” (branch deleted)", kind='site_edit_mama')
            return self.send(200, {'ok': True, 'summary': 'discarded'})
        self.send(404, {'error': 'not here'})

if __name__ == '__main__':
    for p in S['proposals']:
        if p['state'] in ('queued', 'checking', 'merging', 'merge_queued'):
            p['state'] = 'failed' if p['state'] in ('queued', 'checking') else 'ready'; p.setdefault('checks', []).append({'name': 'run', 'ok': False, 'detail': 'the checker restarted mid-run'}) if p['state'] == 'failed' else None
    save()
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=syncer, daemon=True).start()
    log('site-edit checker up on 127.0.0.1:%d' % PORT, mama=False)
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
