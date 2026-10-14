#!/usr/bin/env python3
# Jena's facial expressions, learned from real faces on video.
# Input: MediaPipe FaceLandmarker tracks (52 ARKit blendshapes + head yaw/pitch/roll at ~15 fps) of public, kid-safe
# acting / expression-reference clips (ANIMATIONS/expressions/README.md credits them; the video itself is deleted after
# tracking, only these numbers are kept). Output: ANIMATIONS/expressions/expressions.json, every expression with several
# real variants (one per detected occurrence), each with onset / hold / release timing measured from the clip, its
# left/right asymmetry, its head pose, and the weights for Jena's own VRoid face morphs (Fcl_*).
# usage: expressions_learn.py <tracks dir> <out json> [<sources json>]
import sys, os, json, glob
import numpy as np

TR, OUT = sys.argv[1], sys.argv[2]
SRC = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else {}

def L(d, n): return d[n + 'Left'] if n + 'Left' in d else 0
def R(d, n): return d[n + 'Right'] if n + 'Right' in d else 0
def M(d, n): return (L(d, n) + R(d, n)) / 2
def g(d, n): return d.get(n, 0)
pos = lambda x: np.maximum(x, 0)

# what each expression looks like on a real face (ARKit blendshape deltas from that person's neutral)
SIG = {
  'surprised':   lambda d: g(d,'browInnerUp')*0.6 + M(d,'browOuterUp')*0.8 + M(d,'eyeWide')*1.2 + np.clip(g(d,'jawOpen'),0,0.35) - M(d,'mouthSmile')*0.6 - M(d,'browDown'),
  'shocked':     lambda d: (M(d,'eyeWide')*1.0 + M(d,'browOuterUp')*0.6 + g(d,'browInnerUp')*0.4) * np.clip(g(d,'jawOpen')*2.5,0,1.4) + M(d,'mouthStretch')*0.4 - M(d,'mouthSmile')*0.8,
  'cringe':      lambda d: M(d,'eyeSquint')*0.8 + M(d,'mouthStretch')*1.2 + M(d,'browDown')*0.6 + M(d,'mouthLowerDown')*0.4 + M(d,'noseSneer')*0.5 + M(d,'eyeBlink')*0.3 - M(d,'mouthSmile')*0.3 - g(d,'jawOpen')*0.4,
  'side_eye':    lambda d: np.maximum(L(d,'eyeLookOut')+R(d,'eyeLookIn'), R(d,'eyeLookOut')+L(d,'eyeLookIn'))*0.7 + M(d,'eyeSquint')*0.3 + M(d,'browDown')*0.3 - g(d,'jawOpen')*0.8 - M(d,'mouthSmile')*0.3,
  'pout':        lambda d: g(d,'mouthPucker')*1.0 + g(d,'mouthShrugLower')*0.6 + g(d,'mouthShrugUpper')*0.3 + g(d,'browInnerUp')*0.3 - g(d,'jawOpen')*1.2 - M(d,'mouthSmile')*0.8,
  'laugh_cry':   lambda d: M(d,'mouthSmile')*0.9 * (M(d,'eyeSquint') + M(d,'eyeBlink')*0.8 + M(d,'cheekSquint')) + g(d,'jawOpen')*0.5 + g(d,'browInnerUp')*0.4,
  'thinking':    lambda d: M(d,'eyeLookUp')*1.0 + g(d,'mouthPressLeft')*0.25 + g(d,'mouthPressRight')*0.25 + np.maximum(g(d,'mouthLeft'), g(d,'mouthRight'))*0.6 + g(d,'mouthRollLower')*0.3 + M(d,'browDown')*0.2 - g(d,'jawOpen')*0.8 - M(d,'mouthSmile')*0.4,
  'angry':       lambda d: M(d,'browDown')*1.3 + M(d,'eyeSquint')*0.5 + M(d,'noseSneer')*0.5 + M(d,'mouthPress')*0.3 + M(d,'mouthFrown')*0.4 - M(d,'mouthSmile')*1.0 - g(d,'browInnerUp')*0.4,
  # sleepy: heavy half-closed lids, or a yawn (jaw wide open with the eyes squeezed / closing)
  'sleepy':      lambda d: np.maximum(np.clip(M(d,'eyeBlink'),0,0.85) * (1 - np.clip(M(d,'eyeSquint')*1.5,0,1)) - M(d,'eyeLookDown')*0.8 - M(d,'mouthSmile')*0.6 - M(d,'browDown')*0.6,
                                      g(d,'jawOpen')*1.3*np.clip((M(d,'eyeBlink') + M(d,'eyeSquint'))*1.5,0,1) - M(d,'mouthSmile')*1.0 - M(d,'eyeWide')*0.8),
  'smug':        lambda d: np.abs(L(d,'mouthSmile')-R(d,'mouthSmile'))*1.4 + np.minimum(L(d,'mouthSmile'),R(d,'mouthSmile'))*0.2 + M(d,'eyeSquint')*0.3 + np.abs(L(d,'mouthDimple')-R(d,'mouthDimple'))*0.6 - g(d,'jawOpen')*1.0 - M(d,'eyeWide')*0.5,
  'disgusted':   lambda d: M(d,'noseSneer')*1.3 + M(d,'mouthUpperUp')*0.8 + M(d,'browDown')*0.4 + M(d,'mouthFrown')*0.4 - M(d,'mouthSmile')*0.8,
  'embarrassed': lambda d: np.clip(M(d,'mouthSmile'),0,0.6)*0.8 + M(d,'eyeLookDown')*0.4 + g(d,'browInnerUp')*0.5 + M(d,'mouthPress')*0.4 - g(d,'jawOpen')*0.8 - M(d,'eyeWide')*0.5,
  'excited':     lambda d: M(d,'mouthSmile')*0.9 * (0.4 + np.clip(g(d,'jawOpen')*2,0,1)) + M(d,'eyeWide')*0.8 + M(d,'browOuterUp')*0.6 - M(d,'eyeBlink')*0.6 - M(d,'browDown')*0.5,
  'sad':         lambda d: g(d,'browInnerUp')*0.9 + M(d,'mouthFrown')*1.2 + g(d,'mouthShrugLower')*0.3 + M(d,'eyeLookDown')*0.2 - M(d,'mouthSmile')*1.2 - M(d,'browOuterUp')*0.5 - g(d,'jawOpen')*0.5,
  'confused':    lambda d: np.abs(L(d,'browOuterUp')-R(d,'browOuterUp'))*1.2 + np.abs(L(d,'browDown')-R(d,'browDown'))*1.0 + g(d,'browInnerUp')*0.3 + np.abs(g(d,'mouthLeft')-g(d,'mouthRight'))*0.6 - M(d,'mouthSmile')*0.6 - g(d,'jawOpen')*0.5,
  'determined':  lambda d: M(d,'browDown')*0.8 + M(d,'mouthPress')*0.9 + g(d,'mouthRollLower')*0.3 + M(d,'eyeSquint')*0.3 - M(d,'mouthSmile')*0.8 - g(d,'jawOpen')*1.0 - M(d,'noseSneer')*0.6 - M(d,'mouthFrown')*0.4,
}
# chapter labels from the clips themselves (YouTube chapters / the performer's own titles): a scored peak inside a
# labelled stretch whose label names the expression counts double
HINT = {
  ('B0ouAnmsO1Y', 47, 74): ['disgusted'], ('B0ouAnmsO1Y', 74, 112): ['angry', 'determined'], ('B0ouAnmsO1Y', 112, 155): ['sad', 'pout'],
  ('B0ouAnmsO1Y', 182, 216): ['shocked', 'cringe'], ('B0ouAnmsO1Y', 47, 74, ): ['disgusted', 'cringe'], ('B0ouAnmsO1Y', 216, 259): ['surprised', 'shocked'], ('B0ouAnmsO1Y', 259, 320): ['smug', 'side_eye'],
  ('pJMgNLWgHBs', 0, 62): ['angry', 'determined'], ('P_vJoXXgtmY', 216, 290): ['confused', 'angry', 'thinking'],
  ('h-Gcl58WbGQ', 215, 270): ['surprised', 'shocked'], ('h-Gcl58WbGQ', 315, 375): ['angry', 'shocked'], ('h-Gcl58WbGQ', 490, 530): ['excited', 'surprised'],
  ('h-Gcl58WbGQ', 530, 570): ['disgusted', 'sad'], ('h-Gcl58WbGQ', 570, 610): ['sad', 'surprised'], ('h-Gcl58WbGQ', 610, 640): ['sad', 'shocked'],
  ('V6TwOE-TIaQ', 0, 300): ['laugh_cry', 'excited'],
  ('M3QYDtSbhrA', 0, 60): ['sleepy'], ('J19avsu84pU', 0, 240): ['sleepy'],
}
PAIRS = ['browDown', 'browOuterUp', 'eyeBlink', 'eyeSquint', 'eyeWide', 'mouthSmile', 'mouthFrown', 'noseSneer', 'cheekSquint', 'mouthUpperUp', 'mouthStretch', 'mouthPress', 'eyeLookOut', 'eyeLookIn', 'eyeLookUp', 'eyeLookDown']

def vroid(d, head):
    """ARKit deltas at the peak -> Jena's own VRoid face morphs (Fcl_*) + VRM look presets. Left/right = HER left/right."""
    c = lambda x: float(np.clip(x, 0, 1))
    smile = M(d, 'mouthSmile'); jaw = g(d, 'jawOpen'); sq = M(d, 'eyeSquint'); cheek = M(d, 'cheekSquint')
    w = {
      'BRW_Angry': c(M(d, 'browDown') * 1.6),
      'BRW_Sorrow': c(g(d, 'browInnerUp') * 1.5 * (1 - c(M(d, 'browOuterUp') * 0.8))),
      'BRW_Surprised': c(M(d, 'browOuterUp') * 1.4 + g(d, 'browInnerUp') * c(M(d, 'browOuterUp') * 2) * 0.4),
      'BRW_Fun': c(smile * 0.5 * (1 - c(M(d, 'browDown') * 3))),
      'EYE_Surprised': c(M(d, 'eyeWide') * 2.2),
      'EYE_Angry': c(sq * 1.5 * (1 - c(smile * 1.5))),
      'EYE_Joy_L': c((L(d, 'eyeSquint') + L(d, 'cheekSquint')) * 0.9 * c(smile * 2.5)),
      'EYE_Joy_R': c((R(d, 'eyeSquint') + R(d, 'cheekSquint')) * 0.9 * c(smile * 2.5)),
      'EYE_Sorrow': c(g(d, 'browInnerUp') * M(d, 'mouthFrown') * 4 + g(d, 'browInnerUp') * 0.3),
      'EYE_Close_L': c((L(d, 'eyeBlink') - 0.12) * 1.25),
      'EYE_Close_R': c((R(d, 'eyeBlink') - 0.12) * 1.25),
      'MTH_A': c(jaw * 1.6 * (1 - c(g(d, 'mouthPucker')))),
      'MTH_I': c(M(d, 'mouthStretch') * 1.4),
      'MTH_E': c((M(d, 'mouthUpperUp') + M(d, 'mouthLowerDown')) * 0.6 * (1 - c(smile * 1.2))),
      'MTH_U': c(g(d, 'mouthPucker') * 1.1),
      'MTH_O': c(g(d, 'mouthFunnel') * 1.4),
      'MTH_Joy': c(smile * 1.3 * c(jaw * 3)),
      'MTH_Fun': c(smile * 1.3 * (1 - c(jaw * 3))),
      'MTH_Angry': c(M(d, 'noseSneer') * 1.2 + M(d, 'mouthUpperUp') * 0.5 + M(d, 'mouthPress') * 0.5 + M(d, 'mouthFrown') * 0.4),
      'MTH_Sorrow': c(M(d, 'mouthFrown') * 1.8 + g(d, 'mouthShrugLower') * 0.4),
      'MTH_Surprised': c(jaw * 1.2 * c(M(d, 'eyeWide') * 3 + M(d, 'browOuterUp') * 2) * (1 - c(smile * 2))),
      'MTH_Small': c(M(d, 'mouthPress') * 1.2 + g(d, 'mouthRollLower') * 0.6 + g(d, 'mouthPucker') * 0.3),
      'MTH_Large': c(jaw * M(d, 'mouthStretch') * 3),
      'lookLeft': c(L(d, 'eyeLookOut') * 0.5 + R(d, 'eyeLookIn') * 0.5 - 0.15) * 1.3,
      'lookRight': c(R(d, 'eyeLookOut') * 0.5 + L(d, 'eyeLookIn') * 0.5 - 0.15) * 1.3,
      'lookUp': c(M(d, 'eyeLookUp') - 0.1) * 1.3,
      'lookDown': c(M(d, 'eyeLookDown') - 0.25) * 1.2,
    }
    return {k: round(v, 3) for k, v in w.items() if v >= 0.04}

def load(p):
    j = json.load(open(p)); F = np.array(j['frames'], float)
    return j['cols'], F, j.get('sample_fps', 15)

clips = {}
for p in sorted(glob.glob(os.path.join(TR, '*.json'))):
    cid = os.path.basename(p)[:-5]
    cols, F, fps = load(p)
    if len(F) < 30: continue
    names = cols[2:-3]; B = F[:, 2:-3]; t = F[:, 0]; head = F[:, -3:]
    base = np.percentile(B, 15, axis=0)          # this person's neutral (15th percentile per channel)
    D = pos(B - base)
    hb = np.median(head, axis=0)
    d = {n: D[:, i] for i, n in enumerate(names)}
    S = {e: np.convolve(np.asarray(f(d), float) * np.ones(len(t)), np.ones(3) / 3, 'same') for e, f in SIG.items()}
    clips[cid] = dict(t=t, D=D, names=names, head=head - hb, S=S, fps=fps)

# normalise every expression's score by its 99th percentile over all clips, so they compete fairly
norm = {e: max(1e-6, np.percentile(np.concatenate([c['S'][e] for c in clips.values()]), 99)) for e in SIG}
events = {e: [] for e in SIG}
for cid, c in clips.items():
    t, D, names = c['t'], c['D'], c['names']
    Z = {e: c['S'][e] / norm[e] for e in SIG}
    stack = np.stack([Z[e] for e in SIG]); order = list(SIG)
    for ei, e in enumerate(order):
        z = Z[e]; win = int(c['fps'] * 1.0)
        for i in range(win, len(z) - win):
            if z[i] < 0.75 or z[i] != z[i - win:i + win + 1].max(): continue
            hint = any(cid == k[0] and k[1] <= t[i] < k[2] and e in v for k, v in HINT.items())
            others = np.delete(stack[:, i], ei).max()
            if z[i] < others * (0.9 if hint else (1.0 if e in ('cringe', 'confused', 'determined') else 1.1)): continue          # it has to be THIS expression, not another
            if t[i + win] - t[i - win] > 3.5: continue                      # a gap in tracking (face lost)
            pk = z[i]; lo = 0.15 * pk
            a = i
            while a > 0 and z[a - 1] > lo and t[i] - t[a - 1] < 3: a -= 1
            b = i
            while b < len(z) - 1 and z[b + 1] > lo and t[b + 1] - t[i] < 6: b += 1
            seg = z[a:b + 1]; ts = t[a:b + 1]; k = i - a
            def cross(level, rising):
                idx = range(k, -1, -1) if rising else range(k, len(seg))
                for j in idx:
                    if seg[j] < level * pk: return ts[j]
                return ts[0] if rising else ts[-1]
            r10, r90 = cross(0.25, True), cross(0.9, True); f90, f10 = cross(0.9, False), cross(0.25, False)
            above = ts[seg >= 0.75 * pk]
            hold_raw = float(above[-1] - above[0]) if len(above) else 0
            # a real expression is held: a one-frame spike is a blink or a tracking glitch, not an expression
            if hold_raw < (0.6 if e == 'sleepy' else 0.25): continue
            onset = float(np.clip(r90 - r10, 0.08, 1.5)); hold = float(np.clip(hold_raw, 0.25, 3.0))
            release = float(np.clip(f10 - f90, 0.15, 2.5))
            sel = (seg >= 0.75 * pk)
            pv = D[a:b + 1][sel].mean(axis=0)
            dd = {n: float(pv[j]) for j, n in enumerate(names)}
            hp = c['head'][a:b + 1][sel].mean(axis=0)
            asym = {}
            for n in PAIRS:
                l, r = dd.get(n + 'Left', 0), dd.get(n + 'Right', 0)
                if l + r > 0.15: asym[n] = round((l - r) / (l + r), 2)
            score = float(pk) * (1.3 if hint else 1.0)
            events[e].append(dict(clip=cid, t=round(float(t[i]), 2), score=round(score, 2), hint=hint, onset=round(onset, 2), hold=round(hold, 2), release=round(release, 2),
                                  head=[round(float(x), 1) for x in hp], asym=asym, arkit={n: round(v, 3) for n, v in dd.items() if v >= 0.06}, vrm=vroid(dd, hp)))

out = {'version': 1, 'learned_from': {cid: {'frames': int(len(c['t'])), 'sample_fps': round(float(c['fps']), 2), **SRC.get(cid, {})} for cid, c in clips.items()},
       'tracker': 'MediaPipe FaceLandmarker (52 ARKit blendshapes + facial transformation matrix), CPU, ~15 fps', 'expressions': {}}
for e, ev in events.items():
    ev.sort(key=lambda x: -x['score'])
    # several real variants: the best occurrences, at most 3 per clip, at least 2 s apart
    pick = []
    for x in ev:
        if sum(1 for y in pick if y['clip'] == x['clip']) >= 3: continue
        if any(y['clip'] == x['clip'] and abs(y['t'] - x['t']) < 2 for y in pick): continue
        if len(x['vrm']) < 2: continue
        pick.append(x)
        if len(pick) >= 6: break
    if not pick: out['expressions'][e] = {'variants': [], 'note': 'no clear occurrence in the tracked clips'}; continue
    med = lambda k: round(float(np.median([p[k] for p in pick])), 2)
    out['expressions'][e] = {'variants': pick, 'timing': {'onset': med('onset'), 'hold': med('hold'), 'release': med('release')}, 'occurrences': len(ev)}
json.dump(out, open(OUT, 'w'), indent=1)
print(json.dumps({e: (len(v['variants']), v.get('timing'), v.get('occurrences')) for e, v in out['expressions'].items()}))
