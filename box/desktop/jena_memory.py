# Jena's activity memory: what she did, when, and what she got out of it. Her idle choices read it so she
# doesn't keep doing the exact same thing (a novelty penalty, never a fixed rota), and her chat can read
# memory/recent.md ("what did you do today?"). Files: ~/.jena/memory/activity.jsonl (one line per action)
# and ~/.jena/memory/recent.md (the last 24 h in plain words). Never write secrets or mama's private chats here.
import json, math, os, random, re, threading, time

MEM_DIR = os.environ.get('JENA_MEMORY_DIR', os.path.expanduser('~jena/.jena/memory'))
LOG = os.path.join(MEM_DIR, 'activity.jsonl')
RECENT = os.path.join(MEM_DIR, 'recent.md')
HOUR = 3600
_lock = threading.Lock()
_cache = {'at': 0, 'rows': []}
SECRETISH = re.compile(r'(pass(word)?|passwd|token|secret|api[_-]?key|cookie|auth|otp|2fa|plexcode|mama000)', re.I)

def _clean(s, n=200):
    s = re.sub(r'\s+', ' ', str(s or '')).strip()
    return '[redacted]' if SECRETISH.search(s) else s[:n]

def rows(hours=24):
    """her own actions in the last `hours` (newest last). cached for a few seconds"""
    now = time.time()
    with _lock:
        if now - _cache['at'] > 5:
            out = []
            try:
                with open(LOG, encoding='utf-8', errors='replace') as f:
                    for line in f.readlines()[-3000:]:
                        try: out.append(json.loads(line))
                        except Exception: pass
            except FileNotFoundError: pass
            _cache.update(at=now, rows=out)
        rs = _cache['rows']
    cut = (now - hours * HOUR) * 1000
    return [r for r in rs if r.get('ts', 0) >= cut]

def record(kind, what, key=None, outcome='', note='', action=None):
    """one action she did. kind: video|task|site|skill|learn|note|read. key: the exact thing (for 'no exact repeat')"""
    os.makedirs(MEM_DIR, exist_ok=True)
    r = {'ts': int(time.time() * 1000), 'kind': kind, 'action': action or kind, 'key': _clean(key or what, 300),
         'what': _clean(what), 'outcome': _clean(outcome, 120), 'note': _clean(note, 240)}
    with _lock:
        with open(LOG, 'a', encoding='utf-8') as f: f.write(json.dumps(r) + '\n')
        _cache['rows'].append(r)
    try: write_recent()
    except Exception: pass
    return r

def seen(key, hours=24 * 365):
    return any(r.get('key') == key for r in rows(hours))

def last_time(key=None, action=None):
    t = 0
    for r in rows(24 * 30):
        if (key is not None and r.get('key') == key) or (action is not None and r.get('action') == action): t = max(t, r['ts'])
    return t / 1000

def pick_fresh(items, keyf, coverage=0.8, kind=None):
    """pick an item she hasn't done lately: never-done first; nothing repeats until `coverage` of the pool
    has been done since its last time; among equals, the one done longest ago. A little randomness on top."""
    if not items: return None
    hist = rows(24 * 30)
    last = {}
    for r in hist:
        if kind and r.get('kind') != kind: continue
        last[r.get('key')] = r['ts']
    keys = [keyf(x) for x in items]
    never = [x for x, k in zip(items, keys) if k not in last]
    if never: return random.choice(never)
    # everything has been done at least once: block the most recent (1 - coverage) share of the pool
    order = sorted(zip(items, keys), key=lambda xk: last.get(xk[1], 0))   # done longest ago first
    hour_ago = (time.time() - HOUR) * 1000
    order = [xk for xk in order if last.get(xk[1], 0) < hour_ago] or order[:1]   # no exact repeat within the hour
    n = max(1, len(items) - math.ceil(len(items) * coverage) + 1)
    return random.choice(order[:n])[0]

def choose(options, mood='neutral', context=None, now=None):
    """her own choice of what to do next. options: list of dicts {name, fn, weight, moods:{mood:mult}, key?}.
    weight comes from her mood/context; a novelty penalty for what she did lately; the exact same action
    is never repeated within an hour (unless mama asked, which doesn't go through here)."""
    now = now or time.time()
    hist = rows(6)
    scored = []
    for o in options:
        w = float(o.get('weight', 1)) * float((o.get('moods') or {}).get(mood, 1)) * float((o.get('context') or {}).get(context, 1))
        mine = [r for r in hist if r.get('action') == o['name']]
        last = max([r['ts'] / 1000 for r in mine], default=0)
        age = now - last if last else 1e9
        if age < 3 * 60: w *= 0.02                      # just did it
        n1 = sum(1 for r in mine if now - r['ts'] / 1000 < HOUR)
        w *= 1 / (1 + 1.2 * n1)                          # did it a lot this hour
        w *= 1 / (1 + 0.25 * len(mine))                  # ... and today
        if not mine: w *= 1.6                            # haven't done it at all lately: curious about it
        scored.append((max(w, 1e-4), o))
    tot = sum(w for w, _ in scored)
    x = random.uniform(0, tot)
    for w, o in scored:
        x -= w
        if x <= 0: return o
    return scored[-1][1]

def recent_exact(key, minutes=60):
    return any(r.get('key') == key for r in rows(minutes / 60))

def write_recent():
    rs = rows(24)
    by = {}
    for r in rs: by.setdefault(r.get('kind', 'task'), []).append(r)
    lines = ['# What I did in the last 24 hours', '', f'_updated {time.strftime("%Y-%m-%d %H:%M %Z")} · {len(rs)} things_', '']
    names = {'video': 'Videos I watched', 'learn': 'Moves I learned (or tried to)', 'read': 'Things I read',
             'site': 'Sites I explored', 'note': 'Notes I wrote', 'skill': 'Skills I practiced', 'task': 'Other stuff'}
    for k in ['learn', 'video', 'read', 'site', 'note', 'skill', 'task'] + [k for k in by if k not in names]:
        if k not in by: continue
        lines.append(f'## {names.get(k, k)}')
        cnt = {}
        for r in by[k]: cnt[r.get('what')] = cnt.get(r.get('what'), 0) + 1
        seen_ = set()
        for r in reversed(by[k][-40:]):
            if r.get('what') in seen_: continue
            seen_.add(r.get('what'))
            extra = f' ({cnt[r["what"]]}x)' if cnt[r['what']] > 1 else ''
            nt = f' — {r["note"]}' if r.get('note') else (f' — {r["outcome"]}' if r.get('outcome') else '')
            lines.append(f'- {time.strftime("%H:%M", time.localtime(r["ts"] / 1000))} {r.get("what")}{extra}{nt}')
        lines.append('')
    tmp = RECENT + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f: f.write('\n'.join(lines))
    os.replace(tmp, RECENT)

def summary_text(hours=24, n=12):
    rs = rows(hours)
    if not rs: return "honestly nothing yet today, i just woke up"
    parts = []
    seen_ = set()
    for r in reversed(rs):
        w = r.get('what')
        if w in seen_: continue
        seen_.add(w); parts.append(w)
        if len(parts) >= n: break
    return 'today i: ' + '; '.join(parts)
