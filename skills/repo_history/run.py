import os, sys, json, re, urllib.request, urllib.parse
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_lib'))
from jenaskill import inp, done, mcp

repo = os.path.expanduser('~/jena-repo')
r = mcp('git', 'git_log', {'repo_path': repo, 'max_count': 8})
lines = [l for l in r['text'].splitlines() if l.startswith('Message:') or l.startswith('Commit')][:8]
done(not r['error'], 'my repo, latest: ' + (next((l[8:].strip() for l in r['text'].splitlines() if l.startswith('Message:')), '?'))[:120], text=r['text'][:4000], via='mcp:git')
