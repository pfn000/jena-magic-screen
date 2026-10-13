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
    c.frame = (b'live', __import__('time').time() - 3, {}); body, hdr = c.jpeg(); assert hdr['X-Censor-Reason'] == 'censor_lag', hdr
    c.frame = (b'live', __import__('time').time(), {}); c.set_private('mama_takeover', True); body, hdr = c.jpeg()
    assert hdr['X-Censor-Reason'] == 'mama_takeover' and body != b'live', hdr
    print('all censor tests passed')
