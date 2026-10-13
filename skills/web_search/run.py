import os, sys, json, re, urllib.request, urllib.parse
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_lib'))
from jenaskill import inp, done, mcp

_i = inp()
q = _i.get('query') or _i.get('text') or ''
q = re.sub(r"^(jena[, ]+)?(please )?(search( for)?|look up|lookup|google)\s*", '', q, flags=re.I).strip() or q
UA = {'User-Agent': 'Mozilla/5.0 (Jena skill web_search)'}
get = lambda u, **k: urllib.request.urlopen(urllib.request.Request(u, headers=UA, **k), timeout=8).read()
hits, errs = [], {}
try:
    d = json.loads(get('https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=' + urllib.parse.quote(q)))
    if d.get('AbstractURL'): hits.append({'source': 'duckduckgo', 'title': d.get('Heading') or q, 'url': d['AbstractURL'], 'snippet': d.get('AbstractText', '')[:200]})
    for t in [x for y in d.get('RelatedTopics', []) for x in (y.get('Topics') or [y])][:3]:
        if t.get('FirstURL'): hits.append({'source': 'duckduckgo', 'title': t.get('Text', '')[:80], 'url': t['FirstURL'], 'snippet': t.get('Text', '')[:200]})
except Exception as e: errs['duckduckgo'] = str(e)[:120]
try:
    d = json.loads(get('https://api.github.com/search/repositories?per_page=3&q=' + urllib.parse.quote(q)))
    for x in d.get('items', []): hits.append({'source': 'github', 'title': x['full_name'], 'url': x['html_url'], 'snippet': (x.get('description') or '')[:200]})
except Exception as e: errs['github'] = str(e)[:120]
try:
    d = json.loads(get('https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=' + urllib.parse.quote(q)))
    for x in d['query']['search']: hits.append({'source': 'wikipedia', 'title': x['title'], 'url': 'https://en.wikipedia.org/wiki/' + urllib.parse.quote(x['title'].replace(' ', '_')), 'snippet': re.sub('<[^>]+>', '', x['snippet'])[:200]})
except Exception as e: errs['wikipedia'] = str(e)[:120]
done(bool(hits), f'{len(hits)} hits for "{q[:50]}" from ' + ', '.join(sorted({h["source"] for h in hits})) if hits else f'no hits for "{q[:50]}"', query=q, hits=hits, errors=errs)
