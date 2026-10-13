import os, sys, json, re
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_lib'))
from jenaskill import inp, done
HERE = os.path.dirname(os.path.abspath(__file__))
try: M = json.load(open(os.path.join(HERE, '..', '..', 'public', 'body-parts.json')))
except Exception: M = json.load(open(os.path.join(HERE, 'body-parts.json')))
t = (inp().get('text') or '').lower()
B = M['bones']
if re.search(r'\b(left|right)\b.*\b(left|right)\b|which (side|way)', t):
    done(True, 'her left and right', say=M['left_right'], facts=M['left_right'])
m = re.search(r'\b(left|right)?\s*(index|middle|ring|little|pinky|thumb)?\s*(finger|thumb|knuckle|elbow|wrist|shoulder|hip|knee|ankle|toe|head|neck|chest|spine|eye)s?\b', t)
if m and re.search(r'\bwhat (does|do)\b', t):
    side = m.group(1) or 'left'; f = (m.group(2) or '').replace('pinky', 'little'); part = m.group(3)
    key = {'elbow': 'LowerArm', 'wrist': 'Hand', 'shoulder': 'Shoulder', 'hip': 'UpperLeg', 'knee': 'LowerLeg', 'ankle': 'Foot', 'toe': 'Toes', 'eye': 'Eye'}.get(part)
    if part in ('finger', 'thumb', 'knuckle'):
        F = 'Thumb' if part == 'thumb' or f == 'thumb' else (f or 'index').capitalize()
        names = [k for k in B if k.startswith(side + F)]
        say = f"my {side} {F.lower()} has {len(names)} joints: " + '; '.join(B[k]['does'] for k in names) + '.'
    elif part in ('head', 'neck', 'chest', 'spine'):
        say = 'my ' + part + ': ' + B[part if part != 'chest' else 'chest']['does'] + '.'
    else:
        b = B.get(side + key, {}); say = f"my {side} {part}: {b.get('does', 'part of my body')}."
    done(True, f'body map: {side} {part}', say=say, facts=say)
g = M['groups']
say = (f"I have {len(B)} bones that move: " + '; '.join(f"{k}: {len(v)}" for k, v in g.items()) +
       f". My face has {len(M['face'])} shapes ({', '.join(list(M['face'])[:10])}…). " + M['left_right'].split('.')[0] + '. '
       "When I copy a video I track 33 body points, 21 per hand and 478 on the face, then check my own pose against it and fix what's off.")
done(True, 'her body map', say=say, facts=say)
