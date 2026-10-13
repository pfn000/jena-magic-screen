import os, sys, json, re, urllib.request, urllib.parse
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_lib'))
from jenaskill import inp, done, mcp

i = inp(); url = i.get('url') or (re.search(r"https?://\S+", i.get('text', '')) or [None])[0]
if not url: done(False, 'no URL to read')
r = mcp('fetch', 'fetch', {'url': url, 'max_length': 4000})
txt = r['text']
done(not r['error'], (f'read {url[:60]}: ' + re.sub(r'\s+', ' ', txt)[:140]) if not r['error'] else f'fetch failed: {txt[:120]}', url=url, text=txt[:4000], via='mcp:fetch')
