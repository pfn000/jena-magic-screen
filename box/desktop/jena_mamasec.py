#!/usr/bin/env python3
"""Mama's security doors on Jena's box, behind /box/mama/sec/* (her desk checks mama's key first; the site swaps a
trusted-device token for that key, api/_lib/mama.js). Hot-reloaded by the desk on every change of this file.

  trust     trusted-device registry + revocations   ~/.jena-mama/trust.json
  passkeys  WebAuthn credentials (public keys only)  ~/.jena-mama/passkeys.json
  vault     mama's site logins, AES-256-GCM at rest  ~/.jena/vault.json (key ~/.jena/vault.key), both 0600 jena
  gh        "Sign Jena into GitHub": gh auth login --web as jena; mama gets the one-time code + link

Nothing here is ever logged: no values, no exception text (it could carry values), no did()/activity lines.
Vault values leave only on an explicit reveal of one entry, to mama's request.
"""
import base64, json, os, re, secrets, subprocess, threading, time

HOME = os.path.expanduser('~')
MAMA_DIR = os.path.join(HOME, '.jena-mama')
STATE = os.path.join(HOME, '.jena')
TRUST = os.path.join(MAMA_DIR, 'trust.json')
PASSKEYS = os.path.join(MAMA_DIR, 'passkeys.json')
VAULT = os.path.join(STATE, 'vault.json')
VKEY = os.path.join(STATE, 'vault.key')


def _read(path, default):
    try:
        with open(path) as f: return json.load(f)
    except Exception: return default


def _write(path, data, mode=0o600):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp-' + secrets.token_hex(4)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, 'w') as f: json.dump(data, f)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


# ---------------------------------------------------------------- trusted devices
def trust(b):
    t = _read(TRUST, {'devices': [], 'revoked': []})
    op = b.get('op')
    dev = str(b.get('device') or '')[:24]
    if op == 'add' and dev:
        t['devices'] = [d for d in t['devices'] if d.get('id') != dev][-49:] + [{'id': dev, 'label': str(b.get('label') or '')[:40], 'iat': int(b.get('iat') or time.time()), 'via': str(b.get('via') or '')[:12], 'where': str(b.get('where') or '')[:60]}]
        _write(TRUST, t)
    elif op == 'link_use':
        n = str(b.get('link') or '')[:16]
        uses = t.setdefault('links', {})
        uses[n] = int(uses.get(n, 0)) + 1
        if len(uses) > 50: t['links'] = dict(list(uses.items())[-50:])
        _write(TRUST, t)
        return 200, {'ok': True, 'uses': uses[n]}
    elif op == 'revoke' and dev:
        # Never auto-revoke mama's real devices (13 Oct 19:45Z a test cleanup revoked 3 'iPhone · Safari' devices,
        # one likely her phone). Only the device itself ('forget this device' on the site, by=device) or a device
        # labelled '· test' (navigator.webdriver: Playwright, the site watcher) can be revoked.
        known = next((d for d in t['devices'] if d.get('id') == dev), None)
        label = (known or {}).get('label', '')
        if b.get('by') != 'device' and '· test' not in label:
            return 409, {'ok': False, 'error': "that's a real device: only mama can forget it, from that device (🔐 tab -> forget this device)", 'label': label}
        if dev not in t['revoked']: t['revoked'] = (t['revoked'] + [dev])[-500:]
        t['devices'] = [d for d in t['devices'] if d.get('id') != dev]
        t.setdefault('revoke_log', []).append({'device': dev, 'label': label, 'by': str(b.get('by') or 'test-cleanup')[:12], 'at': int(time.time())})
        t['revoke_log'] = t['revoke_log'][-100:]
        _write(TRUST, t)
    elif op == 'unrevoke' and dev:
        t['revoked'] = [x for x in t['revoked'] if x != dev]
        _write(TRUST, t)
    return 200, {'ok': True, 'devices': t['devices'], 'revoked': t['revoked']}


# ---------------------------------------------------------------- passkeys (public keys only; the site verifies)
def passkeys(b):
    pk = _read(PASSKEYS, {'credentials': []})
    op = b.get('op') or 'list'
    if op == 'add':
        c = b.get('credential') or {}
        if not re.fullmatch(r'[A-Za-z0-9_-]{16,512}', str(c.get('id') or '')) or not c.get('publicKey'):
            return 400, {'ok': False, 'summary': 'bad credential'}
        pk['credentials'] = [x for x in pk['credentials'] if x.get('id') != c['id']][-19:] + [{
            'id': c['id'], 'publicKey': str(c['publicKey'])[:2000], 'counter': int(c.get('counter') or 0),
            'transports': [str(x)[:16] for x in (c.get('transports') or [])][:6], 'label': str(c.get('label') or '')[:40],
            'created': int(time.time() * 1000), 'used': 0}]
        _write(PASSKEYS, pk)
    elif op == 'used':
        for x in pk['credentials']:
            if x.get('id') == b.get('id'): x['counter'] = int(b.get('counter') or x.get('counter') or 0); x['used'] = int(time.time() * 1000)
        _write(PASSKEYS, pk)
    elif op == 'delete':
        pk['credentials'] = [x for x in pk['credentials'] if x.get('id') != b.get('id')]
        _write(PASSKEYS, pk)
    return 200, {'ok': True, 'credentials': pk['credentials']}


# ---------------------------------------------------------------- the vault
def _key():
    try:
        with open(VKEY, 'rb') as f: k = f.read()
        if len(k) == 32: return k
    except FileNotFoundError: pass
    k = secrets.token_bytes(32)
    fd = os.open(VKEY, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f: f.write(k)
    return k


def _aes():
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    return AESGCM(_key())


def _seal(entry):
    n = secrets.token_bytes(12)
    ct = _aes().encrypt(n, json.dumps(entry).encode(), entry['id'].encode())
    return {'id': entry['id'], 'n': base64.b64encode(n).decode(), 'ct': base64.b64encode(ct).decode()}


def _open(row):
    pt = _aes().decrypt(base64.b64decode(row['n']), base64.b64decode(row['ct']), row['id'].encode())
    return json.loads(pt)


def entries():
    """all vault entries, decrypted, in memory only (for the desk's autofill: jena_creds.for_title)"""
    out = []
    for row in _read(VAULT, {'v': 1, 'rows': []}).get('rows', []):
        try: out.append(_open(row))
        except Exception: pass
    return out


def _save(items):
    _write(VAULT, {'v': 1, 'alg': 'AES-256-GCM', 'rows': [_seal(e) for e in items]})


def _host(site):
    s = str(site or '').strip().lower()
    s = re.sub(r'^[a-z]+://', '', s).split('/')[0].removeprefix('www.')
    return s


def _mask(s):
    s = str(s or '')
    return (s[:2] + '•' * min(8, max(3, len(s) - 2))) if s else ''


def vault(b):
    op = b.get('op') or 'list'
    items = entries()
    if op == 'list':
        return 200, {'ok': True, 'count': len(items), 'entries': [{'id': e['id'], 'site': e.get('site', ''), 'host': _host(e.get('site')), 'user': _mask(e.get('username')), 'has_password': bool(e.get('password')), 'has_notes': bool(e.get('notes')), 'updated': e.get('updated', 0)} for e in items]}
    if op in ('add', 'edit'):
        site = str(b.get('site') or '').strip()[:200]
        if not site: return 400, {'ok': False, 'summary': 'site is needed'}
        if op == 'add':
            e = {'id': secrets.token_hex(6), 'created': int(time.time() * 1000)}
            items.append(e)
        else:
            e = next((x for x in items if x['id'] == b.get('id')), None)
            if not e: return 404, {'ok': False, 'summary': 'no such entry'}
        e['site'] = site
        for k in ('username', 'password', 'notes'):
            if k in b and (op == 'add' or b.get(k) != ''):   # edit: an empty field keeps the old value
                e[k] = str(b.get(k) or '')[:2000]
        e['updated'] = int(time.time() * 1000)
        _save(items)
        return 200, {'ok': True, 'id': e['id']}
    if op == 'delete':
        n = len(items)
        items = [x for x in items if x['id'] != b.get('id')]
        _save(items)
        return 200, {'ok': True, 'deleted': n - len(items)}
    if op == 'reveal':
        e = next((x for x in items if x['id'] == b.get('id')), None)
        if not e: return 404, {'ok': False, 'summary': 'no such entry'}
        return 200, {'ok': True, 'id': e['id'], 'site': e.get('site', ''), 'username': e.get('username', ''), 'password': e.get('password', ''), 'notes': e.get('notes', '')}
    return 400, {'ok': False, 'summary': 'unknown vault op'}


# ---------------------------------------------------------------- GitHub CLI sign-in (mama completes it herself)
GH = {'proc': None, 'code': None, 'url': None, 'started': 0, 'state': 'idle', 'note': ''}


def _gh_status():
    try:
        r = subprocess.run(['gh', 'auth', 'status', '-h', 'github.com'], capture_output=True, text=True, timeout=10, env={**os.environ, 'GH_PROMPT_DISABLED': '1'})
        txt = (r.stdout + r.stderr)
        m = re.search(r'Logged in to github\.com as (\S+)', txt)
        return {'signed_in': r.returncode == 0 and bool(m), 'account': m.group(1) if m else None}
    except Exception:
        return {'signed_in': False, 'account': None}


def _gh_reader(p):
    buf = ''
    try:
        while True:
            ch = p.stdout.read(1) if p.stdout else ''
            if not ch: break
            buf = (buf + ch)[-4000:]
            m = re.search(r'one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})', buf)
            if m and not GH['code']:
                GH['code'] = m.group(1); GH['url'] = 'https://github.com/login/device'; GH['state'] = 'waiting_for_mama'
                try: p.stdin.write('\n'); p.stdin.flush()   # "Press Enter to open github.com in your browser" (BROWSER is a no-op)
                except Exception: pass
    except Exception:
        pass
    rc = p.wait()
    st = _gh_status()
    GH['state'] = 'signed_in' if st['signed_in'] else ('expired' if rc else 'ended')
    GH['proc'] = None


def gh(b):
    op = b.get('op') or 'status'
    if op == 'start':
        st = _gh_status()
        if st['signed_in']: return 200, {'ok': True, 'state': 'signed_in', **st}
        p = GH.get('proc')
        if p and p.poll() is None and GH['code'] and time.time() - GH['started'] < 840:
            return 200, {'ok': True, 'state': GH['state'], 'code': GH['code'], 'url': GH['url'], 'started': GH['started']}
        if p and p.poll() is None:
            try: p.kill()
            except Exception: pass
        env = {**os.environ, 'BROWSER': '/bin/true', 'GH_BROWSER': '/bin/true', 'NO_COLOR': '1', 'GH_NO_UPDATE_NOTIFIER': '1'}
        p = subprocess.Popen(['gh', 'auth', 'login', '--web', '-h', 'github.com', '-p', 'https'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env, start_new_session=True)
        GH.update({'proc': p, 'code': None, 'url': None, 'started': time.time(), 'state': 'starting'})
        threading.Thread(target=_gh_reader, args=(p,), daemon=True).start()
        for _ in range(60):
            if GH['code'] or p.poll() is not None: break
            time.sleep(0.25)
        if not GH['code']:
            return 502, {'ok': False, 'state': GH['state'], 'summary': 'GitHub did not hand out a code (is her box online?)'}
        return 200, {'ok': True, 'state': GH['state'], 'code': GH['code'], 'url': GH['url'], 'started': GH['started']}
    if op == 'cancel':
        p = GH.get('proc')
        if p and p.poll() is None:
            try: p.kill()
            except Exception: pass
        GH.update({'code': None, 'url': None, 'state': 'idle'})
        return 200, {'ok': True, 'state': 'idle'}
    st = _gh_status()
    live = GH.get('proc') is not None and GH['proc'].poll() is None
    state = 'signed_in' if st['signed_in'] else (GH['state'] if live else ('idle' if GH['state'] in ('starting', 'waiting_for_mama') else GH['state']))
    return 200, {'ok': True, 'state': state, **st, **({'code': GH['code'], 'url': GH['url'], 'started': GH['started']} if live and GH['code'] else {})}


DOORS = {'trust': trust, 'passkeys': passkeys, 'vault': vault, 'gh': gh}


def door(p, b):
    """p = /box/mama/sec/<name>; returns (status, dict). Never raises with value-bearing text."""
    name = p.rstrip('/').rsplit('/', 1)[-1]
    fn = DOORS.get(name)
    if not fn: return 404, {'ok': False, 'summary': 'no such door'}
    try:
        return fn(b if isinstance(b, dict) else {})
    except Exception as e:
        return 500, {'ok': False, 'summary': f'{name} failed ({type(e).__name__})'}
