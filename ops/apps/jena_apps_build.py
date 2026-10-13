#!/usr/bin/env python3
"""Build, download or run one app from ops/apps/apps.json on a GitHub runner and write out/:
   <name>-<version>-<platform>.tar.gz (the package) and <name>.manifest.json
   (name, version, sha256, size, source URL, run URL, request id). Used by .github/workflows/jena-apps.yml.
   Never prints secrets; it needs none (GH_TOKEN is only used to read public release metadata)."""
import hashlib, json, os, re, shutil, subprocess, sys, tarfile, time, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
name = sys.argv[1]
app = json.load(open(os.path.join(HERE, 'apps.json')))['apps'][name]
assert app.get('enabled'), f'{name} is disabled'
OUT = os.path.abspath('out'); WORK = os.path.abspath('work')
shutil.rmtree(OUT, True); shutil.rmtree(WORK, True); os.makedirs(OUT); os.makedirs(WORK)
STAGE = os.path.join(WORK, 'stage', name); os.makedirs(STAGE)
RUN_URL = os.environ.get('RUN_URL', ''); REQ = os.environ.get('REQ', 'manual')

def sh(cmd, cwd=None, env=None, timeout=3000):
    print('+', cmd if isinstance(cmd, str) else ' '.join(cmd), flush=True)
    subprocess.run(cmd, shell=isinstance(cmd, str), cwd=cwd, env={**os.environ, **(env or {})}, check=True, timeout=timeout)

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()

def fetch(url, dest):
    req = urllib.request.Request(url, headers={'User-Agent': 'jena-apps/1'})
    with urllib.request.urlopen(req, timeout=300) as r, open(dest, 'wb') as f: shutil.copyfileobj(r, f)
    return dest

def gh_latest(repo, rx):
    hdr = {'User-Agent': 'jena-apps/1', 'Accept': 'application/vnd.github+json'}
    if os.environ.get('GH_TOKEN'): hdr['Authorization'] = 'Bearer ' + os.environ['GH_TOKEN']
    rel = json.load(urllib.request.urlopen(urllib.request.Request(f'https://api.github.com/repos/{repo}/releases/latest', headers=hdr), timeout=60))
    for a in rel['assets']:
        if re.search(rx, a['name']): return rel['tag_name'].lstrip('v'), a['browser_download_url']
    raise SystemExit(f'no asset matching {rx} in {repo} {rel["tag_name"]}')

def unpack(src, dest):
    os.makedirs(dest, exist_ok=True)
    if zipfile.is_zipfile(src):
        zipfile.ZipFile(src).extractall(dest)
    else:
        tarfile.open(src).extractall(dest)
    # a single top-level folder is flattened
    items = os.listdir(dest)
    if len(items) == 1 and os.path.isdir(os.path.join(dest, items[0])): return os.path.join(dest, items[0])
    return dest

version = app.get('version', '')
source = app.get('source_url', '')
t0 = time.time()
result = {}
if app['mode'] in ('build', 'download') and app['platform'] == 'linux':
    if app.get('github_release'):
        version, source = gh_latest(app['github_release'], app['asset_regex'])
    src = fetch(source, os.path.join(WORK, os.path.basename(source.split('?')[0]) or 'src'))
    src_sha = sha(src)
    if app.get('source_sha256') and app['source_sha256'] != src_sha:
        raise SystemExit(f'source sha256 mismatch: {src_sha} != {app["source_sha256"]}')
    print('source', source, 'sha256', src_sha, 'bytes', os.path.getsize(src), flush=True)
    if app['mode'] == 'build':
        if app.get('build_deps'):
            sh('apt-get install -y -qq --no-install-recommends ' + ' '.join(app['build_deps']) + ' >/dev/null')
        tree = unpack(src, os.path.join(WORK, 'src'))
        for c in app['build']: sh(c, cwd=tree, env={'STAGE': STAGE})
    elif app.get('package') == 'deb' or src.endswith('.deb'):
        shutil.copy(src, os.path.join(STAGE, os.path.basename(src)))
    elif src.endswith('.AppImage'):
        dst = os.path.join(STAGE, name + '.AppImage'); shutil.copy(src, dst); os.chmod(dst, 0o755)
    else:
        tree = unpack(src, os.path.join(WORK, 'src'))
        shutil.rmtree(STAGE); shutil.copytree(tree, STAGE, symlinks=True)
    chk = os.path.join(STAGE, app.get('check') or app.get('exec') or '')
    if app.get('check') or app.get('exec'):
        assert os.path.exists(chk), f'{chk} missing after build'
        print(subprocess.run(['file', chk], capture_output=True, text=True).stdout.strip())
    kind = 'install'
elif app['platform'] == 'windows' and app['mode'] == 'run':
    src = fetch(source, os.path.join(WORK, os.path.basename(source)))
    src_sha = sha(src)
    tree = unpack(src, os.path.join(WORK, 'prog'))
    exe = app['run'][0]
    t1 = time.time()
    r = subprocess.run([os.path.join(tree, exe)] + app['run'][1:], capture_output=True, timeout=600, cwd=tree)
    out = r.stdout.decode('utf-8', 'replace'); err = r.stderr.decode('utf-8', 'replace')
    print(out[-4000:]); print(err[-2000:], file=sys.stderr)
    open(os.path.join(STAGE, 'output.txt'), 'w', encoding='utf-8').write(out)
    open(os.path.join(STAGE, 'stderr.txt'), 'w', encoding='utf-8').write(err)
    result = {'exit_code': r.returncode, 'seconds': round(time.time() - t1, 2), 'command': ' '.join(app['run']),
              'windows': subprocess.run(['cmd', '/c', 'ver'], capture_output=True, text=True).stdout.strip(),
              'program_sha256': sha(os.path.join(tree, exe)), 'stdout_preview': out[:1500]}
    json.dump(result, open(os.path.join(STAGE, 'result.json'), 'w'), indent=1)
    if r.returncode != 0: raise SystemExit(f'{exe} exited {r.returncode}')
    kind = 'output'
else:
    raise SystemExit(f'unsupported {app["platform"]}/{app["mode"]}')

pkg = os.path.join(OUT, f'{name}-{version or "0"}-{app["platform"]}-x86_64.tar.gz')
with tarfile.open(pkg, 'w:gz') as t: t.add(STAGE, arcname=name)
stage_bytes = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(STAGE) for f in fs if not os.path.islink(os.path.join(d, f)))
manifest = {
    'name': name, 'title': app.get('title', name), 'version': version, 'platform': app['platform'], 'mode': app['mode'], 'kind': kind,
    'package': {'file': os.path.basename(pkg), 'format': 'tar.gz', 'sha256': sha(pkg), 'size': os.path.getsize(pkg), 'unpacked_size': stage_bytes},
    'source_url': source, 'source_sha256': src_sha, 'exec': app.get('exec'), 'check': app.get('check'), 'terminal': bool(app.get('terminal')),
    'desktop': app.get('desktop'), 'needs_root': bool(app.get('needs_root')), 'result': result,
    'request_id': REQ, 'run_id': os.environ.get('GITHUB_RUN_ID'), 'run_url': RUN_URL, 'commit': os.environ.get('GITHUB_SHA'),
    'built_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'build_seconds': round(time.time() - t0, 1),
}
json.dump(manifest, open(os.path.join(OUT, f'{name}.manifest.json'), 'w'), indent=1)
print(json.dumps(manifest, indent=1))
