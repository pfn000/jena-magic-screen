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
terms = set(w for w in re.findall(r'[a-z0-9]{3,}', q.lower()))
def best(p, k=2):
    ss = [s.strip() for s in re.split(r'(?<=[.!?])\s+', re.sub(r'[`*_>#]|\[!\w+\]', '', p)) if 30 < len(s.strip()) < 260]
    sc = sorted(ss, key=lambda s: -len(terms & set(re.findall(r'[a-z0-9]{3,}', s.lower()))))
    keep = [s for s in ss if s in sc[:k]]
    return ' '.join(keep)
h0 = hits[0]
quote = best(h0['passage'])
src = h0['title'] if re.match(r'^[^:]{2,26}: ', h0['title']) else f"{h0['short']}, {h0['title']}"
say = (f'My library says ({src}): "{quote}"' if quote else f'My library has it in {src}.') + (f' Also see {hits[1]["short"]}: {hits[1]["title"].split(": ")[-1]}.' if len(hits) > 1 else '')
steps = [f"📚 {h['title'] if re.match(r'^[^:]{2,26}: ', h['title']) else h['short'] + ': ' + h['title']}{' › ' + h['section'] if h.get('section') else ''} ({h['license_short']}) — {best(h['passage'], 1)[:160]} {h['url']}" for h in hits]
done(True, f'{len(hits)} passages from my library for "{q[:60]}": ' + '; '.join(cite(h) for h in hits),
     query=q, hits=[{'title': cite(h), 'url': h['url'], 'snippet': h['passage'][:300], 'license': h['license'], 'book': h['book']} for h in hits],
     passages=hits, say=say[:600], steps=steps)
