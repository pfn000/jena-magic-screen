import os, sys, json, re, urllib.request, urllib.parse
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_lib'))
from jenaskill import inp, done, mcp

_i = inp()
q = _i.get('query') or _i.get('text') or ''
q = re.sub(r"\b(jena|please|find|search|show me|github|repos?|repositor(y|ies)|on|for|about|some)\b", ' ', q, flags=re.I).strip() or q
d = json.loads(urllib.request.urlopen(urllib.request.Request('https://api.github.com/search/repositories?per_page=5&q=' + urllib.parse.quote(q), headers={'User-Agent': 'Jena', 'Accept': 'application/vnd.github+json'}), timeout=10).read())
repos = [{'name': x['full_name'], 'url': x['html_url'], 'stars': x['stargazers_count'], 'about': (x.get('description') or '')[:160]} for x in d.get('items', [])]
done(bool(repos), (f'top repo for "{q[:40]}": {repos[0]["name"]} ★{repos[0]["stars"]}' if repos else f'no repos for "{q[:40]}"'), query=q, repos=repos)
