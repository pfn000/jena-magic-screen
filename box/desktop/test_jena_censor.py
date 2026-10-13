#!/usr/bin/env python3
"""Tests for jena_censor (no X display needed): render fake private text, censor it, re-read the output.
Run: python3 box/desktop/test_jena_censor.py"""
import io, os, sys, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw, ImageFont
import jena_censor as jc

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
FAKES = {   # all fake values, made up for the test
    'email': 'jena.fake.test@example.com',
    'ip': '203.0.113.47',
    'code': '482917',
    'key': 'sk-test-AbC123xYz789QwErTy456',
    'phone': '(555) 867-5309',
}


def render(lines, size=16, w=1600, h=704):
    im = Image.new('RGB', (w, h), (255, 255, 255)); d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT, size)
    for i, l in enumerate(lines):
        d.text((40, 40 + i * int(size * 1.9)), l, font=f, fill=(20, 20, 20))
    return im


def reread(jpg):
    return ' '.join(w['t'] for w in jc.ocr_words(Image.open(io.BytesIO(jpg)), timeout=10))


def test_blackouts(size):
    lines = ['notes for stream today', 'my email is ' + FAKES['email'] + ' ok', 'server ip ' + FAKES['ip'],
             'the code was ' + FAKES['code'] + ' lol', 'openai ' + FAKES['key'], 'call me ' + FAKES['phone'],
             'this line is totally normal text with 2026 in it']
    jpg, meta = jc.sanitize(render(lines, size), 'thoughts.txt - Mousepad')
    assert meta['state'] == 'live', meta
    for k in FAKES:
        assert meta['redactions'].get(k, 0) >= 1, (size, k, meta)
    after = reread(jpg)
    for k, v in FAKES.items():
        core = re.sub(r'\W', '', v)[:6]
        assert core not in re.sub(r'\W', '', after), (size, k, 'still readable', after)
    assert 'normal' in after, 'over-censored normal text'
    return meta


def test_private(title, lines, want):
    jpg, meta = jc.sanitize(render(lines), title)
    assert jpg is None and meta['state'] == 'private', (title, lines, meta)
    assert meta['reason'] == want, (title, meta)


if __name__ == '__main__':
    for s in (14, 16, 20):
        print('blackouts @%dpx' % s, test_blackouts(s)['redactions'])
    test_private('Proton Mail: Sign-in — Mozilla Firefox', ['Welcome back'], 'login_page')
    test_private('New Tab — Mozilla Firefox', ['https://account.proton.me/login', 'Email or username', 'Password'], 'login_page')
    test_private('Mozilla Firefox', ['https://mail.proton.me/u/0/inbox', 'Inbox (3)'], 'private_page')
    test_private('X. It’s what’s happening / X — Mozilla Firefox', ['Sign in to X', '', 'Email or username'], 'login_page')
    test_private('Some site — Mozilla Firefox', ['Welcome', 'Email or username', 'Next'], 'login_page')
    test_private('jena@box: ~', ['$ export OPENAI_API_KEY=whatever', '$ ls'], 'secrets_terminal')
    test_private('jena@box: ~', ['$ env', 'HOME=/home/jena', 'SHELL=/bin/bash', 'PATH=/usr/bin', 'LANG=C.UTF-8', 'USER=jena'], 'secrets_terminal')
    jpg, meta = jc.sanitize(render(['hello chat, today we draw an icon', 'grok is cool']), 'thoughts.txt - Mousepad')
    assert meta['state'] == 'live' and not meta['redactions'], meta
    c = jc.make_card('mama_takeover'); assert c[:2] == b'\xff\xd8'
    m, cnt = jc.sanitize_text('mail ' + FAKES['email'] + ' ip ' + FAKES['ip'] + ' code ' + FAKES['code'] + ' ' + FAKES['key'] + ' ' + FAKES['phone'])
    assert all(v not in m for v in FAKES.values()) and set(cnt) >= set(FAKES), (m, cnt)
    assert jc.text_is_private('https://account.proton.me/login') and not jc.text_is_private('drawing a pink star')
    for r in ('mama_takeover', 'signin', 'censor_lag', 'login_page'):
        assert jc.make_card(r)[:2] == b'\xff\xd8'
    # Censor object with nothing captured yet / forced private never returns a live frame
    c = jc.Censor(display=':nonexistent'); c.thread = type('T', (), {'is_alive': lambda self: True})()
    body, hdr = c.jpeg(); assert hdr['X-Censor-State'] == 'private', hdr
    import time as _t
    # a LATE frame is not a card any more: the last good censored frame stays up (no flashing) ...
    c.frame = (b'live', _t.time() - 3, {}); c.last_ok = _t.time() - 3; body, hdr = c.jpeg()
    assert hdr['X-Censor-State'] == 'live' and body == b'live', hdr
    # ... until the censor has been stuck for real (45 s off-air, 15 s live)
    c.frame = (b'live', _t.time() - 50, {}); c.last_ok = _t.time() - 50; body, hdr = c.jpeg(); assert hdr['X-Censor-Reason'] == 'censor_lag', hdr
    c.frame = (b'live', _t.time() - 20, {}); c.last_ok = _t.time() - 20; assert c.jpeg()[1]['X-Censor-State'] == 'live'
    c.live_cfg = {'mama_live': True}; assert c.live()['live'] and c.jpeg()[1]['X-Censor-Reason'] == 'censor_lag'   # strict when live
    c.live_cfg = {'mama_live': False}; c.saw_obs(); assert c.live()['why'] == ['obs']; c.obs_seen = 0
    # hysteresis: a private page puts the card on at once; it stays >= 3 s and leaves after 2 clean reads
    seq = [('login', 0.0), ('clean', 0.5), ('clean', 1.0), ('clean', 3.2), ('clean', 3.4)]
    h = jc.Censor(display=':nonexistent'); h.thread = c.thread
    clean_img = Image.new('RGB', (1600, 704), 'white')
    t0 = _t.time(); seen = []
    for kind, dt in seq:
        jc.grab = lambda d, im=clean_img, kind=kind: (im if kind == 'clean' else Image.new('RGB', (1600, 704), (250, 250, 250)))
        jc.active_title = lambda d, kind=kind: ('Sign in — Mozilla Firefox' if kind == 'login' else 'notes - Mousepad')
        jc.pointer_xy = lambda d: None
        jc.terminal_rects = lambda d: []
        _now = t0 + dt; _real = _t.time; _t.time = lambda: _now; jc.time.time = _t.time
        try:
            h._tick(); seen.append(h._verdict(_now)[0])
        finally:
            _t.time = _real; jc.time.time = _real
    assert seen == ['private', 'private', 'private', 'live', 'live'], seen   # card held 3 s even after 2 clean reads
    c.frame = (b'live', __import__('time').time(), {}); c.set_private('mama_takeover', True); body, hdr = c.jpeg()
    assert hdr['X-Censor-Reason'] == 'mama_takeover' and body != b'live', hdr
    # band re-read: only the changed line is OCR'd again; old blackouts stay, the new secret is caught
    base_lines = ['notes for stream', 'my email is ' + FAKES['email'], 'line three is calm', 'line four is calm', 'line five']
    a = render(base_lines); prev = {}
    w1, _ = jc.read_screen(a, rects=[], prev=prev)
    b_lines = list(base_lines); b_lines[3] = 'server ip ' + FAKES['ip']
    b = render(b_lines)
    w2, _ = jc.read_screen(b, rects=[], prev=prev)
    assert prev['strip'] == 'band', prev['strip']
    kinds = {k for k, _ in jc.find_redactions(w2)}
    assert {'email', 'ip'} <= kinds, kinds
    w3, _ = jc.read_screen(b, rects=[], prev=prev); assert prev['strip'] is None
    # two far-apart changes -> two small bands, words between them kept from the last read
    c_lines = list(b_lines); c_lines[0] = 'call me ' + FAKES['phone']; c_lines.append(''); 
    cimg = render(c_lines + [''] * 8 + ['the code was ' + FAKES['code']])
    w4, _ = jc.read_screen(cimg, rects=[], prev=prev)
    assert prev['strip'] in ('band', 'all'), prev
    kinds = {k for k, _ in jc.find_redactions(w4)}
    assert {'email', 'ip', 'phone', 'code'} <= kinds, kinds
    # terminal window: only the changed terminal line is re-read at 2.2x, older secrets stay blacked out
    tl = ['$ ls', 'my key ' + FAKES['key'], 'line', 'line', 'line', 'line', 'line', 'line', 'line', 'line', 'line', 'line', 'line']
    ta = render(tl); tp = {}; rect = [(0, 0, 1600, 704)]
    jc.read_screen(ta, rects=rect, prev=tp)
    tl2 = list(tl); tl2[10] = 'ip ' + FAKES['ip']
    tw, _ = jc.read_screen(render(tl2), rects=rect, prev=tp)
    assert tp['strip'] == 'band', tp['strip']
    kinds = {k for k, _ in jc.find_redactions(tw)}
    assert {'key', 'ip'} <= kinds, kinds
    tj = jc.tag_jpeg(jc.make_card('signin'), {'X-Censor-Seq': '7', 'X-Censor-State': 'private', 'X-Censor-Reason': 'signin'})
    assert b'seq=7 state=private reason=signin' in tj[:80] and Image.open(io.BytesIO(tj)).size[0] > 0
    print('all censor tests passed')
