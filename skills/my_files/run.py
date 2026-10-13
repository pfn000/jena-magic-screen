import os, sys, json, re, urllib.request, urllib.parse
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_lib'))
from jenaskill import inp, done, mcp

i = inp(); path = os.path.expanduser(i.get('path') or '~/notes')
r = mcp('filesystem', 'list_directory', {'path': path})
out = r['text']
if not r['error'] and i.get('read'):
    rr = mcp('filesystem', 'read_text_file', {'path': os.path.join(path, i['read'])}); out += '\n---\n' + rr['text'][:3000]
done(not r['error'], f'{path.replace(os.path.expanduser("~"), "~")}: ' + ', '.join(l.replace('[FILE] ', '').replace('[DIR] ', '') for l in out.splitlines()[:8]), path=path, text=out[:4000], via='mcp:filesystem')
