#!/usr/bin/env python3
"""Private sign-in windows for Jena (mama signs in herself; Jena keeps the session).

Jena hits a sign-in wall -> signin.request('grok', why) -> a card in mama's dev panel.
Mama taps Open (passcode re-checked by the desk's is_mama on every start) -> a PRIVATE screen:
  * Xvfb :100 at 390x844 (phone shaped), X auth cookie readable only by jena, never captured by
    her eyes, the censor, OBS or the public stream (those all read :99).
  * Firefox on :100 with the SAME persistent profile (~/.ffprofile). A profile cannot run twice, so the
    :99 Firefox is closed gracefully first (SIGTERM = Firefox's normal quit, cookies flushed).
  * x11vnc listens on a unix socket inside a 0700 dir (no TCP port at all); this module itself speaks
    the websocket on /websockify-signin and bridges it to that socket.
  * the websocket token rides Sec-WebSocket-Protocol ('jsi.<token>'), never the URL, so it is not in any
    log or referrer. Single use, 60 s to connect; each Open mints a new one (passcode again).
Done / Cancel / 10 minutes -> Firefox quits gracefully (cookies flush), :100 is torn down, the profile is
checked by COUNTING cookies for the site (no names, no values), on_end() hands the desktop back.
No login, account creation or CAPTCHA is ever automated here: mama types everything herself.
"""
import asyncio, base64, hashlib, json, os, secrets, signal, sqlite3, shutil, struct, subprocess, tempfile, threading, time, urllib.parse

SITES = {
    'grok':   {'label': 'grok.com',  'url': 'https://grok.com/',                 'hosts': ['grok.com', 'x.ai']},
    'proton': {'label': 'proton.me', 'url': 'https://account.proton.me/login',   'hosts': ['proton.me']},
}
DISPLAY_N = int(os.environ.get('JENA_SIGNIN_DISPLAY', '100'))
W, H = 480, 1040          # phone-shaped; Firefox will not go narrower than ~450 px, noVNC scales it to the phone
SESSION_S = 600          # private window lives at most 10 minutes
PENDING_S = 600          # an unanswered sign-in ask expires after 10 minutes
TOKEN_S = 60             # a websocket token must be used within 60 s, once
WS_GUID = b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


def _now(): return time.time()


def site_of(site):
    """('grok' | 'proton' | https url) -> dict(key,label,url,hosts) or None"""
    s = str(site or '').strip()
    if s.lower() in SITES:
        d = dict(SITES[s.lower()]); d['key'] = s.lower(); return d
    u = urllib.parse.urlparse(s if '://' in s else 'https://' + s)
    if u.scheme != 'https' or not u.hostname or '.' not in u.hostname: return None
    host = u.hostname.lower()
    for k, d in SITES.items():
        if any(host == h or host.endswith('.' + h) for h in d['hosts']):
            d = dict(d); d['key'] = k; return d
    base = '.'.join(host.split('.')[-2:])
    return {'key': host, 'label': host, 'url': urllib.parse.urlunparse(('https', host, u.path or '/', '', '', '')), 'hosts': [base]}


class SignIn:
    def __init__(self, home=None, profile=None, on_start=None, on_end=None, log=None, state_file=None):
        self.home = home or os.path.expanduser('~')
        self.profile = profile or os.path.join(self.home, '.ffprofile')
        self.on_start, self.on_end, self.log = on_start, on_end, log
        self.state_file = state_file or os.path.join(self.home, '.jena', 'signin.json')
        self.run_dir = os.path.join(self.home, '.jena', 'signin-run')
        self.lk = threading.RLock()
        self.sess = None          # {id, site, started, until, procs:{}, phase}
        self.tokens = {}          # token -> (expires, req_id)
        self.viewers = set()
        self.reqs = self._load()
        self._cleanup_leftovers()
        threading.Thread(target=self._watchdog, daemon=True).start()

    # ---------- small state (site / reason / time / status only) ----------
    def _load(self):
        try: return json.load(open(self.state_file))[-30:]
        except Exception: return []

    def _save(self):
        try:
            os.makedirs(os.path.dirname(self.state_file), exist_ok=True)
            tmp = self.state_file + '.tmp'
            with open(tmp, 'w') as f: json.dump(self.reqs[-30:], f)
            os.chmod(tmp, 0o600); os.replace(tmp, self.state_file)
        except Exception: pass

    def _log(self, what, why=''):
        try: self.log and self.log('signin', what, why)
        except Exception: pass

    def _find(self, rid):
        return next((r for r in self.reqs if r['id'] == rid), None)

    def public_req(self, r):
        return {k: r.get(k) for k in ('id', 'site', 'label', 'url', 'reason', 'by', 'ts', 'status', 'ended', 'cookies_before', 'cookies_after', 'note')}

    # ---------- API used by jena_desk ----------
    def active(self):
        return self.sess is not None

    def public_status(self):
        s = self.sess
        return {'active': bool(s), 'id': s and s['id'], 'site': s and s['label'], 'phase': s and s.get('phase'), 'until': s and int(s['until'] * 1000)}

    def _expire(self):
        """pending asks die after 10 minutes (Jena asks again when she needs it). Caller holds self.lk."""
        ch = False
        for r in self.reqs:
            if r['status'] == 'pending' and _now() * 1000 - r['ts'] > PENDING_S * 1000:
                r['status'] = 'expired'; r['ended'] = int(_now() * 1000); ch = True
        if ch: self._save()

    def request(self, site, reason='', by='jena'):
        """ONE pending sign-in ask at a time: a new ask for another site replaces the older pending one."""
        d = site_of(site)
        if not d: return {'ok': False, 'summary': 'only https sites can ask for a sign-in'}
        with self.lk:
            self._expire()
            for r in self.reqs:
                if r['site'] == d['key'] and r['status'] in ('pending', 'open'):
                    r['reason'] = str(reason)[:200] or r['reason']
                    if r['status'] == 'pending': r['ts'] = int(_now() * 1000)   # asked again: the 10 min restart
                    self._save(); return {'ok': True, 'request': self.public_req(r), 'dedup': True}
            for r in self.reqs:
                if r['status'] == 'pending': r['status'] = 'replaced'; r['ended'] = int(_now() * 1000)
            r = {'id': secrets.token_hex(4), 'site': d['key'], 'label': d['label'], 'url': d['url'], 'hosts': d['hosts'],
                 'reason': str(reason)[:200], 'by': by, 'ts': int(_now() * 1000), 'status': 'pending'}
            self.reqs.append(r); self._save()
        self._log(f'asked mama to sign me in to {d["label"]}', r['reason'])
        return {'ok': True, 'request': self.public_req(r)}

    def list(self):
        with self.lk:
            self._expire()
            pend = next((self.public_req(r) for r in reversed(self.reqs) if r['status'] in ('pending', 'open')), None)
            return {'ok': True, 'pending': pend, 'requests': [self.public_req(r) for r in reversed(self.reqs[-12:])],
                    'active': self.public_status(), 'asks': self._asks(), 'expires_s': PENDING_S}

    # ---------- other asks (Jena's ask_mama lines in ~/.jena/help.jsonl): mama answers Approve / Deny ----------
    def _asks(self):
        try: lines = open(os.path.join(self.home, '.jena', 'help.jsonl')).read().strip().splitlines()[-15:]
        except Exception: lines = []
        ans = self._answers()
        out = []
        for l in lines:
            try: a = json.loads(l)
            except Exception: continue
            t = str(a.get('text', ''))
            if any(w in t.lower() for w in ('sign me in', 'sign-in', 'sign in', 'signed in')): continue      # those are the sign-in card above
            out.append({'ts': a.get('ts'), 'text': t[:300], 'answer': ans.get(str(a.get('ts')))})
        return list(reversed(out))[:10]

    def _answers(self):
        res = {}
        try:
            for l in open(os.path.join(self.home, '.jena', 'mama_answers.jsonl')):
                try: a = json.loads(l); res[str(a['ts'])] = a['answer']
                except Exception: pass
        except Exception: pass
        return res

    def answer(self, ts, ans):
        if ans not in ('approve', 'deny'): return {'ok': False, 'summary': 'answer is approve or deny'}
        a = next((x for x in self._asks() if str(x['ts']) == str(ts)), None)
        if not a: return {'ok': False, 'summary': 'no such ask'}
        try:
            with open(os.path.join(self.home, '.jena', 'mama_answers.jsonl'), 'a') as f:
                f.write(json.dumps({'ts': a['ts'], 'answer': ans, 'at': int(_now() * 1000)}) + '\n')
        except Exception as e: return {'ok': False, 'summary': f'could not save: {type(e).__name__}'}
        self._log(f'mama {"approved" if ans == "approve" else "said no to"}: {a["text"][:120]}')
        return {'ok': True, 'ts': a['ts'], 'answer': ans}

    def start(self, rid):
        """Mama (already passcode-checked by the caller) opens the private window. Returns a one-use token."""
        with self.lk:
            self._expire()
            r = self._find(rid)
            if not r: return {'ok': False, 'summary': 'no such sign-in request'}
            if r['status'] not in ('pending', 'open'): return {'ok': False, 'summary': f'that request is {r["status"]}; ask again'}
            if self.sess and self.sess['id'] != rid:
                return {'ok': False, 'summary': f'another private sign-in ({self.sess["label"]}) is open; finish it first'}
            tok = secrets.token_urlsafe(24)
            self.tokens = {t: v for t, v in self.tokens.items() if v[0] > _now()}
            self.tokens[tok] = (_now() + TOKEN_S, rid)
            fresh = self.sess is None
            if fresh:
                self.sess = {'id': rid, 'site': r['site'], 'label': r['label'], 'url': r['url'], 'hosts': r['hosts'],
                             'started': _now(), 'until': _now() + SESSION_S, 'procs': {}, 'phase': 'starting'}
                r['status'] = 'open'; r['opened'] = int(_now() * 1000); self._save()
        if fresh:
            try: self.on_start and self.on_start(r['label'])
            except Exception: pass
            self._log(f'mama opened a private sign-in window for {r["label"]} (my screen is private meanwhile)')
            threading.Thread(target=self._launch, daemon=True).start()
        s = self.sess
        return {'ok': True, 'protocol': 'jsi.' + tok, 'path': '/websockify-signin', 'valid_s': TOKEN_S,
                'until': int(s['until'] * 1000) if s else None, 'site': r['label'], 'size': [W, H]}

    def done(self, rid=None, why='done'):
        with self.lk:
            s = self.sess
            if not s or (rid and s['id'] != rid):
                r = self._find(rid) if rid else None
                if r and r['status'] == 'pending' and why == 'cancel':
                    r['status'] = 'cancelled'; r['ended'] = int(_now() * 1000); self._save()
                    return {'ok': True, 'request': self.public_req(r)}
                return {'ok': False, 'summary': 'no private sign-in is open'}
            if s.get('phase') == 'closing': return {'ok': True, 'closing': True}
            s['phase'] = 'closing'
            self.tokens = {}
        for v in list(self.viewers):
            try: v.close()
            except Exception: pass
        self._stop_private(s)
        after = self.cookie_counts(s['hosts'])
        with self.lk:
            r = self._find(s['id'])
            if r:
                r['status'] = {'done': 'done', 'timeout': 'timed out', 'cancel': 'cancelled'}.get(why, why)
                r['ended'] = int(_now() * 1000); r['cookies_after'] = after
                b = r.get('cookies_before') or 0
                r['note'] = (f'{after} saved cookies for {r["label"]} now (was {b}). This shows a session was stored, not that the sign-in worked: '
                             'ask Jena to use the site to know.') if after is not None else 'could not read the profile'
                self._save()
            self.sess = None
        # her Firefox comes back on :99 by her own hands (jena_desk.firefox relaunches it with the same profile on its next use;
        # launching it here too raced it into a 'Firefox is already running' dialog)
        self._log(f'private sign-in for {s["label"]} closed ({why}); browser back to my desktop', r and r.get('note', ''))
        try: self.on_end and self.on_end(s['label'], r and self.public_req(r))
        except Exception: pass
        return {'ok': True, 'request': r and self.public_req(r)}

    async def mama_door(self, p, b):
        """Call only behind is_mama. p = '/box/mama/signin/<action>'. Returns (status, bytes)."""
        if isinstance(b, (bytes, bytearray, str)):
            try: b = json.loads(b or b'{}')
            except Exception: b = {}
        b = b or {}
        act = p.rstrip('/').rsplit('/', 1)[-1]
        loop = asyncio.get_running_loop()
        if act == 'list': res = self.list()
        elif act == 'request': res = self.request(b.get('site'), b.get('reason') or 'mama asked', by='mama')
        elif act == 'start': res = await loop.run_in_executor(None, self.start, str(b.get('id', '')))
        elif act == 'done': res = await loop.run_in_executor(None, self.done, str(b.get('id', '')) or None, 'done')
        elif act == 'answer': res = self.answer(b.get('ts'), str(b.get('answer', '')))
        elif act == 'cancel': res = await loop.run_in_executor(None, self.done, str(b.get('id', '')) or None, 'cancel')
        else: return 404, json.dumps({'ok': False, 'summary': 'no such sign-in door'}).encode()
        return (200 if res.get('ok') else 409), json.dumps(res).encode()

    # ---------- profile check: counts only ----------
    def cookie_counts(self, hosts):
        src = os.path.join(self.profile, 'cookies.sqlite')
        if not os.path.exists(src): return 0
        d = tempfile.mkdtemp(prefix='jsi-'); os.chmod(d, 0o700)
        try:
            for ext in ('', '-wal'):
                if os.path.exists(src + ext): shutil.copy2(src + ext, os.path.join(d, 'c.sqlite' + ext))
            con = sqlite3.connect(os.path.join(d, 'c.sqlite'))
            n = 0
            for h in hosts:
                n += con.execute("SELECT count(*) FROM moz_cookies WHERE host = ? OR host = ? OR host LIKE ?", (h, '.' + h, '%.' + h)).fetchone()[0]
            con.close(); return n
        except Exception:
            return None
        finally:
            shutil.rmtree(d, ignore_errors=True)

    # ---------- processes ----------
    def _env(self):
        e = {k: v for k, v in os.environ.items() if k not in ('DISPLAY', 'XAUTHORITY')}
        e.update(DISPLAY=f':{DISPLAY_N}', XAUTHORITY=os.path.join(self.run_dir, 'xauth'), HOME=self.home, MOZ_USE_XINPUT2='1')
        return e

    def _profile_pids(self):
        """main Firefox processes using the profile (any display)"""
        out = []
        for pid in os.listdir('/proc'):
            if not pid.isdigit(): continue
            try:
                cmd = open(f'/proc/{pid}/cmdline', 'rb').read().split(b'\0')
                if os.stat(f'/proc/{pid}').st_uid != os.getuid(): continue
            except Exception: continue
            if cmd and cmd[0].endswith(b'firefox-esr') and b'-contentproc' not in cmd and self.profile.encode() in b' '.join(cmd):
                out.append(int(pid))
        return out

    def _quit_firefox(self, pids, secs=15):
        for pid in pids:
            try: os.kill(pid, signal.SIGTERM)   # Firefox treats SIGTERM as a normal quit: session + cookies written
            except Exception: pass
        t = _now()
        while _now() - t < secs and any(os.path.exists(f'/proc/{p}') and self._alive(p) for p in pids): time.sleep(0.25)
        hard = [p for p in pids if self._alive(p)]
        for pid in hard:
            try: os.kill(pid, signal.SIGKILL)
            except Exception: pass
        time.sleep(0.5)
        return not hard

    @staticmethod
    def _alive(pid):
        try:
            st = open(f'/proc/{pid}/stat').read().rsplit(')', 1)[1].split()[0]
            return st != 'Z'
        except Exception: return False

    def _launch(self):
        s = self.sess
        try:
            graceful = self._quit_firefox(self._profile_pids())
            with self.lk:
                r = self._find(s['id'])
                if r: r['cookies_before'] = self.cookie_counts(s['hosts']); self._save()
            os.makedirs(self.run_dir, exist_ok=True); os.chmod(self.run_dir, 0o700)
            xa = os.path.join(self.run_dir, 'xauth')
            if os.path.exists(xa): os.remove(xa)
            open(xa, 'w').close(); os.chmod(xa, 0o600)
            subprocess.run(['xauth', '-f', xa, 'add', f':{DISPLAY_N}', '.', secrets.token_hex(16)], check=True, timeout=5)
            sock = os.path.join(self.run_dir, 'vnc.sock')
            if os.path.exists(sock): os.remove(sock)
            dn = open(os.devnull, 'w')
            P = s['procs']
            P['xvfb'] = subprocess.Popen(['Xvfb', f':{DISPLAY_N}', '-screen', '0', f'{W}x{H}x24', '-nolisten', 'tcp', '-auth', xa],
                                         stdout=dn, stderr=dn, start_new_session=True)
            for _ in range(40):
                if os.path.exists(f'/tmp/.X11-unix/X{DISPLAY_N}'): break
                time.sleep(0.1)
            P['firefox'] = subprocess.Popen(['firefox-esr', '--new-instance', '--profile', self.profile, '--width', str(W), '--height', str(H), s['url']],
                                            env=self._env(), stdout=dn, stderr=dn, start_new_session=True)
            P['vnc'] = subprocess.Popen(['x11vnc', '-display', f':{DISPLAY_N}', '-auth', xa, '-unixsock', sock, '-rfbport', '0',
                                         '-forever', '-shared', '-nopw', '-noxdamage', '-quiet', '-cursor', 'arrow'],
                                        env=self._env(), stdout=dn, stderr=dn, start_new_session=True)
            for _ in range(80):
                if os.path.exists(sock): break
                time.sleep(0.1)
            try: os.chmod(sock, 0o600)
            except Exception: pass
            threading.Thread(target=self._fit_window, daemon=True).start()
            s['phase'] = 'ready' if os.path.exists(sock) else 'failed'
            s['graceful_99'] = graceful
        except Exception as e:
            s['phase'] = 'failed'; s['err'] = type(e).__name__

    def _fit_window(self):
        """no window manager on :100: keep Firefox's window at 0,0 filling the phone screen"""
        for _ in range(60):
            try:
                ids = subprocess.run(['xdotool', 'search', '--onlyvisible', '--class', 'firefox'], env=self._env(), capture_output=True, text=True, timeout=3).stdout.split()
                if ids:
                    for w in ids:
                        subprocess.run(['xdotool', 'windowmove', w, '0', '0', 'windowsize', w, str(W), str(H)], env=self._env(), timeout=3)
                    return
            except Exception: pass
            time.sleep(0.5)

    def _stop_private(self, s):
        P = s.get('procs', {})
        ff = [p for p in self._profile_pids() if self._on_private_display(p)] or ([P['firefox'].pid] if P.get('firefox') else [])
        s['graceful_close'] = self._quit_firefox(ff)
        for k in ('vnc', 'xvfb'):
            pr = P.get(k)
            if pr and pr.poll() is None:
                pr.terminate()
                try: pr.wait(5)
                except Exception: pr.kill()
        for f in ('vnc.sock', 'xauth'):
            try: os.remove(os.path.join(self.run_dir, f))
            except Exception: pass

    def _restore_99(self):
        """her Firefox comes back on her public desktop (:99) with the same profile, on a neutral page"""
        try:
            if any(not self._on_private_display(p) for p in self._profile_pids()): return
            e = {k: v for k, v in os.environ.items() if k != 'XAUTHORITY'}; e.update(DISPLAY=os.environ.get('DISP', ':99'), HOME=self.home)
            dn = open(os.devnull, 'w')
            subprocess.Popen(['firefox-esr', '--new-instance', '--profile', self.profile, '--width', '1180', '--height', '700', 'about:home'],
                             env=e, stdout=dn, stderr=dn, start_new_session=True)
        except Exception: pass

    def _on_private_display(self, pid):
        try: return f'DISPLAY=:{DISPLAY_N}'.encode() in open(f'/proc/{pid}/environ', 'rb').read().split(b'\0')
        except Exception: return False

    def _cleanup_leftovers(self):
        """desk restarted mid-session: close anything left on the private display, mark the request"""
        try:
            for pid in self._profile_pids():
                if self._on_private_display(pid): self._quit_firefox([pid])
            lock = f'/tmp/.X{DISPLAY_N}-lock'
            if os.path.exists(lock):
                pid = int(open(lock).read().strip())
                if os.stat(f'/proc/{pid}').st_uid == os.getuid(): os.kill(pid, signal.SIGTERM)
        except Exception: pass
        changed = False
        for r in self.reqs:
            if r['status'] == 'open': r['status'] = 'interrupted'; r['ended'] = int(_now() * 1000); changed = True
        if changed: self._save()

    def _watchdog(self):
        while True:
            time.sleep(2)
            s = self.sess
            if s and s.get('phase') != 'closing' and _now() > s['until']:
                try: self.done(s['id'], 'timeout')
                except Exception: pass

    # ---------- websocket -> unix socket bridge ----------
    async def ws_proxy(self, reader, writer, head):
        hdrs = {}
        for l in head.decode('latin1').split('\r\n')[1:]:
            if ':' in l:
                k, v = l.split(':', 1); hdrs[k.strip().lower()] = v.strip()
        offered = [x.strip() for x in hdrs.get('sec-websocket-protocol', '').split(',') if x.strip()]
        tok = next((x[4:] for x in offered if x.startswith('jsi.')), '')
        with self.lk:
            exp, rid = self.tokens.pop(tok, (0, None)) if tok else (0, None)
        s = self.sess
        key = hdrs.get('sec-websocket-key', '')
        if not tok or exp < _now() or not s or s['id'] != rid or not key or s.get('phase') == 'closing':
            writer.write(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); await writer.drain(); writer.close(); return
        sock = os.path.join(self.run_dir, 'vnc.sock')
        for _ in range(120):                       # the private screen may still be starting
            if s.get('phase') in ('ready', 'failed') : break
            await asyncio.sleep(0.25)
        try:
            ur, uw = await asyncio.open_unix_connection(sock)
        except Exception:
            writer.write(b'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); await writer.drain(); writer.close(); return
        accept = base64.b64encode(hashlib.sha1(key.encode() + WS_GUID).digest()).decode()
        proto = 'binary' if 'binary' in offered else None
        writer.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                      f'Sec-WebSocket-Accept: {accept}\r\n' + (f'Sec-WebSocket-Protocol: {proto}\r\n' if proto else '') + '\r\n').encode())
        await writer.drain()
        self.viewers.add(writer)

        async def up():          # browser -> vnc
            try:
                while True:
                    b0, b1 = await reader.readexactly(2)
                    op, n = b0 & 0x0F, b1 & 0x7F
                    if n == 126: n = struct.unpack('>H', await reader.readexactly(2))[0]
                    elif n == 127: n = struct.unpack('>Q', await reader.readexactly(8))[0]
                    mask = await reader.readexactly(4) if b1 & 0x80 else b'\0\0\0\0'
                    data = bytearray(await reader.readexactly(n))
                    for i in range(n): data[i] ^= mask[i & 3]
                    if op == 0x8: break
                    if op == 0x9: writer.write(b'\x8a' + bytes([len(data)]) + bytes(data)); continue
                    if op in (0x0, 0x1, 0x2):
                        uw.write(bytes(data)); await uw.drain()
            except Exception: pass
            finally:
                try: uw.close()
                except Exception: pass

        async def down():        # vnc -> browser (binary frames, server frames are unmasked)
            try:
                while True:
                    data = await ur.read(65536)
                    if not data: break
                    n = len(data)
                    hdr = b'\x82' + (bytes([n]) if n < 126 else (b'\x7e' + struct.pack('>H', n) if n < 65536 else b'\x7f' + struct.pack('>Q', n)))
                    writer.write(hdr + data); await writer.drain()
            except Exception: pass
            finally:
                try: writer.write(b'\x88\x00'); writer.close()
                except Exception: pass
        try: await asyncio.gather(up(), down())
        finally: self.viewers.discard(writer)
