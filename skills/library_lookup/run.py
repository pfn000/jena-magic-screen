import os, sys, re
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_lib'))
from jenaskill import inp, done
from jenalib import lookup, cite, LIB

_i = inp()
q = _i.get('query') or _i.get('text') or ''
q = re.sub(r"^(jena[, ]+)?(please |can you |could you )?", '', q, flags=re.I)
q = re.sub(r"\b(look (it |this )?up|search|check|find|what does|what do|say|says|about|in|your|the|her|my|library|textbooks?|books?|docs)\b", ' ', q, flags=re.I).strip(' ?.,!') or q
if not os.path.exists(os.path.join(LIB, 'library.db')): done(False, 'my library is not on this box yet (no ~/library/library.db)')
hits = lookup(q, n=int(_i.get('n') or 3))
if not hits: done(False, f'nothing in my library matches "{q[:60]}"', query=q)
done(True, f'{len(hits)} passages from my library for "{q[:60]}": ' + '; '.join(cite(h) for h in hits),
     query=q, hits=[{'title': cite(h), 'url': h['url'], 'snippet': h['passage'][:300], 'license': h['license'], 'book': h['book']} for h in hits],
     passages=hits)
