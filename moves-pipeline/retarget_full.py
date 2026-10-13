
# Turns a holistic.py track (raw/ID.npz) into one of Jena's move clips WITH fingers and face:
#   bones        - same quaternion tracks as retarget.py (body, arms, legs), performer's left -> HER left
#   fingers      - per hand, per frame: 15 finger joint bends + spread (radians*1000), with a confidence track
#   face         - per frame weights (0..1000) for her VRM expressions: aa ih ou ee oh, happy angry sad
#                  surprised relaxed, blinkLeft blinkRight, lookUp/Down/Left/Right, from MediaPipe's 52 face
#                  blendshapes (mouth, jaw, brows, cheeks, eyes, gaze), with the raw 52 kept too (arkit)
#   sides        - 'performer' : left/right are the performer's own; Jena plays them left->left (never mirrored)
# usage: retarget_full.py raw/ID.npz [a b]  -> prints the clip JSON path + quality
import sys, json, os, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import retarget
from retarget import lowpass, fill_nan

FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little']
CHAINS = {'Thumb': [1, 2, 3, 4], 'Index': [5, 6, 7, 8], 'Middle': [9, 10, 11, 12], 'Ring': [13, 14, 15, 16], 'Little': [17, 18, 19, 20]}
JOINTS = ['Proximal', 'Intermediate', 'Distal']   # thumb: Metacarpal, Proximal, Distal
# bend of a flat, relaxed-open hand (radians) that counts as zero
REST = {'Thumb': [0.45, 0.15, 0.1], 'Index': [0.12, 0.05, 0.05], 'Middle': [0.1, 0.05, 0.05], 'Ring': [0.12, 0.05, 0.05], 'Little': [0.15, 0.05, 0.05]}

def ang(u, v):
    u = u / (np.linalg.norm(u, axis=-1, keepdims=True) + 1e-9); v = v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-9)
    return np.arccos(np.clip((u * v).sum(-1), -1, 1))

def finger_track(Hw):
    """Hw: (n,21,3) hand world points (nan where not seen) -> (n,17): 5 fingers x 3 bends, spread, thumb opposition"""
    n = len(Hw); out = np.full((n, 17), np.nan)
    ok = np.isfinite(Hw[:, 0, 0])
    if ok.sum() == 0: return out, ok
    H = Hw[ok]
    cols = []
    for f in FINGERS:
        c = CHAINS[f]; pts = [H[:, 0]] + [H[:, i] for i in c]
        for j in range(3):
            a = ang(pts[j + 1] - pts[j], pts[j + 2] - pts[j + 1]) - REST[f][j]
            cols.append(np.clip(a, 0, 1.75))
    spread = np.clip(ang(H[:, 6] - H[:, 5], H[:, 18] - H[:, 17]) - 0.25, 0, 0.9)
    opp = np.clip(1.0 - np.linalg.norm(H[:, 4] - H[:, 9], axis=-1) / (np.linalg.norm(H[:, 9] - H[:, 0], axis=-1) + 1e-6), 0, 1)
    out[ok] = np.stack(cols + [spread, opp], -1)
    return out, ok

# MediaPipe face blendshape -> Jena's VRM expressions (her model has the VRM presets, no custom ARKit shapes)
def face_track(B, names):
    n = len(B); ix = {k: i for i, k in enumerate(names or [])}
    g = lambda k: B[:, ix[k]] if k in ix else np.zeros(n)
    avg = lambda a, b: (g(a) + g(b)) / 2
    smile = avg('mouthSmileLeft', 'mouthSmileRight'); frown = avg('mouthFrownLeft', 'mouthFrownRight')
    brow_dn = avg('browDownLeft', 'browDownRight'); brow_up = avg('browOuterUpLeft', 'browOuterUpRight'); inner = g('browInnerUp')
    wide = avg('eyeWideLeft', 'eyeWideRight'); cheek = avg('cheekSquintLeft', 'cheekSquintRight')
    jaw = g('jawOpen'); funnel = g('mouthFunnel'); pucker = g('mouthPucker'); stretch = avg('mouthStretchLeft', 'mouthStretchRight')
    upper = avg('mouthUpperUpLeft', 'mouthUpperUpRight')
    e = {
        'aa': np.clip(jaw * 1.3 - funnel * 0.4, 0, 1),
        'oh': np.clip(funnel * 1.2, 0, 1),
        'ou': np.clip(pucker * 1.2, 0, 1),
        'ee': np.clip(stretch * 1.5 + smile * 0.25 - jaw * 0.3, 0, 1),
        'ih': np.clip(upper * 1.2 - jaw * 0.2, 0, 1),
        'happy': np.clip(smile * 1.1 + cheek * 0.3, 0, 1),
        'angry': np.clip(brow_dn * 1.2 - smile * 0.5, 0, 1),
        'sad': np.clip(frown * 0.9 + inner * 0.5 - smile * 0.6, 0, 1),
        'surprised': np.clip((brow_up + wide) * 0.6 + jaw * 0.2 - smile * 0.3, 0, 1),
        'relaxed': np.clip(smile * 0.4 - jaw * 0.5, 0, 1) * (1 - np.clip(brow_up * 2, 0, 1)),
        # MediaPipe's eyeBlinkLeft is the PERFORMER's left eye (ARKit convention); frames are un-mirrored first
        'blinkLeft': np.clip((g('eyeBlinkLeft') - 0.15) * 1.5, 0, 1),
        'blinkRight': np.clip((g('eyeBlinkRight') - 0.15) * 1.5, 0, 1),
        'lookUp': avg('eyeLookUpLeft', 'eyeLookUpRight'), 'lookDown': avg('eyeLookDownLeft', 'eyeLookDownRight'),
        # her left = the performer's left: eyes turned to the performer's left = left eye looking out + right eye looking in
        'lookLeft': (g('eyeLookOutLeft') + g('eyeLookInRight')) / 2, 'lookRight': (g('eyeLookOutRight') + g('eyeLookInLeft')) / 2,
    }
    return e

# Body measurements per frame (the targets her self-check compares HER OWN pose against while she does the move).
# All in the performer's body frame: up = hips->shoulders, left = the performer's left. Distances are divided by
# shoulder width so a small and a tall body compare. Angles in degrees.
METRICS = ['leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee',
           'leftWristHead', 'rightWristHead', 'leftWristHip', 'rightWristHip', 'leftWristUp', 'rightWristUp',
           'torsoLean', 'torsoLeanSide', 'headTilt', 'armSymmetry']
METRIC_INFO = {
    'leftShoulder': 'left arm raise: angle between upper arm and the line down her side (0 = arm hanging, 90 = straight out, 180 = straight up)',
    'rightShoulder': 'right arm raise (same scale)', 'leftElbow': 'left elbow angle (180 = straight arm, 90 = bent at a right angle)',
    'rightElbow': 'right elbow angle', 'leftHip': 'left thigh raise from hanging straight down (0 = standing, 90 = knee up level with the hip)',
    'rightHip': 'right thigh raise', 'leftKnee': 'left knee angle (180 = straight leg)', 'rightKnee': 'right knee angle',
    'leftWristHead': 'distance from left wrist to head / shoulder width', 'rightWristHead': 'distance from right wrist to head / shoulder width',
    'leftWristHip': 'distance from left wrist to left hip / shoulder width', 'rightWristHip': 'distance from right wrist to right hip / shoulder width',
    'leftWristUp': 'height of the left wrist above the head / shoulder width (+ = above the head)', 'rightWristUp': 'same for the right wrist',
    'torsoLean': 'how far the torso leans off vertical, degrees', 'torsoLeanSide': 'sideways lean, degrees (+ = toward her left)',
    'headTilt': 'head tilt vs the shoulder line, degrees (+ = toward her left shoulder)', 'armSymmetry': 'left vs right arm match, 0..1 (1 = mirror-equal)'}
def _ang(a, b, c):
    u = a - b; v = c - b
    return np.degrees(np.arccos(np.clip((u * v).sum(-1) / (np.linalg.norm(u, axis=-1) * np.linalg.norm(v, axis=-1) + 1e-9), -1, 1)))
def _angv(u, v):
    return np.degrees(np.arccos(np.clip((u * v).sum(-1) / (np.linalg.norm(u, axis=-1) * np.linalg.norm(v, axis=-1) + 1e-9), -1, 1)))
def metrics(W):
    """W: (n,33,3) MediaPipe world points (x: performer's left is +x... as given, y down, z to camera) -> (n, len(METRICS))"""
    P = fill_nan(np.stack([W[..., 0], -W[..., 1], -W[..., 2]], -1))   # y up (same flip as retarget.py)
    P = lowpass(P, 3.0)
    sh = {'left': P[:, 11], 'right': P[:, 12]}; el = {'left': P[:, 13], 'right': P[:, 14]}; wr = {'left': P[:, 15], 'right': P[:, 16]}
    hp = {'left': P[:, 23], 'right': P[:, 24]}; kn = {'left': P[:, 25], 'right': P[:, 26]}; an = {'left': P[:, 27], 'right': P[:, 28]}
    msh = (sh['left'] + sh['right']) / 2; mhp = (hp['left'] + hp['right']) / 2; up = msh - mhp
    upn = up / (np.linalg.norm(up, axis=-1, keepdims=True) + 1e-9); down = -upn
    sw = np.linalg.norm(sh['left'] - sh['right'], axis=-1) + 1e-6
    head = (P[:, 7] + P[:, 8]) / 2
    lat = sh['left'] - sh['right']; latn = lat / (np.linalg.norm(lat, axis=-1, keepdims=True) + 1e-9)
    out = {}
    for s in ('left', 'right'):
        out[s + 'Shoulder'] = _angv(el[s] - sh[s], down)
        out[s + 'Elbow'] = _ang(sh[s], el[s], wr[s])
        out[s + 'Hip'] = _angv(kn[s] - hp[s], down)
        out[s + 'Knee'] = _ang(hp[s], kn[s], an[s])
        out[s + 'WristHead'] = np.linalg.norm(wr[s] - head, axis=-1) / sw
        out[s + 'WristHip'] = np.linalg.norm(wr[s] - hp[s], axis=-1) / sw
        out[s + 'WristUp'] = ((wr[s] - head) * upn).sum(-1) / sw
    out['torsoLean'] = _angv(up, np.array([0, 1.0, 0]))
    out['torsoLeanSide'] = np.degrees(np.arcsin(np.clip((upn * np.array([1.0, 0, 0])).sum(-1), -1, 1)))
    ear = P[:, 7] - P[:, 8]
    out['headTilt'] = np.degrees(np.arctan2((ear * upn).sum(-1), (ear * latn).sum(-1)))
    out['armSymmetry'] = 1 - np.clip((np.abs(out['leftShoulder'] - out['rightShoulder']) + np.abs(out['leftElbow'] - out['rightElbow'])) / 120, 0, 1)
    return np.stack([out[k] for k in METRICS], -1)

def build(path, a=None, b=None):
    z = np.load(path, allow_pickle=False)
    meta = json.loads(str(z['meta'])) if 'meta' in z.files else {}
    out, off, q, info = retarget.analyse(path, a, b)
    clip = retarget.to_json(out, off, len(off))
    FPS = retarget.FPS
    i0, i1 = (int(a * FPS), int(b * FPS)) if a is not None else (0, len(z['t']))
    n = clip['frames']
    fingers = {}; fq = {}
    for k, side in ((0, 'left'), (1, 'right')):
        tr, ok = finger_track(z['hands_world'][i0:i1, k][:n])
        conf = ok.astype(float)
        if ok.sum() >= max(3, 0.15 * n):
            tr = fill_nan(tr)
            tr = lowpass(tr, 3.0)
            conf = lowpass(fill_nan(np.where(ok, 1.0, np.nan)) * 0 + conf, 2.0).clip(0, 1)
            fingers[side] = {'bend': [int(round(v * 1000)) for v in tr.reshape(-1)], 'conf': [int(round(v * 100)) for v in conf]}
        fq[side] = round(float(ok.mean()), 3)
    face = None
    names = meta.get('blendshape_names')
    B = z['face_bs'][i0:i1][:n]; fok = np.isfinite(B[:, 0]) if len(B) else np.zeros(0, bool)
    if names and fok.sum() >= max(3, 0.15 * n):
        Bf = lowpass(fill_nan(B), 4.0).clip(0, 1)
        e = face_track(Bf, names)
        conf = lowpass(fok.astype(float), 2.0).clip(0, 1)
        face = {'names': list(e), 'w': [[int(round(float(v) * 1000)) for v in e[k]] for k in e], 'conf': [int(round(v * 100)) for v in conf],
                'arkit_names': names, 'arkit': [[int(round(float(v) * 100)) for v in Bf[:, j]] for j in range(Bf.shape[1])]}
    clip['fingers'] = fingers or None
    clip['finger_layout'] = {'order': [f + j for f in FINGERS for j in (['Metacarpal', 'Proximal', 'Distal'] if f == 'Thumb' else JOINTS)] + ['spread', 'thumbOpposition'], 'scale': 1000, 'unit': 'radians of bend (0 = straight)'}
    clip['face'] = face
    M = metrics(z['world'][i0:i1][:n].astype(float))
    scale = {k: (100 if ('Wrist' in k or k == 'armSymmetry') else 10) for k in METRICS}
    clip['metrics'] = {'names': METRICS, 'scale': [scale[k] for k in METRICS], 'info': METRIC_INFO,
                       'data': [[int(round(float(v) * scale[k])) for v in M[:, j]] for j, k in enumerate(METRICS)]}
    clip['segments'] = meta.get('segments')
    clip['objects'] = (meta.get('objects') or {}).get('seen')
    clip['sides'] = 'performer'
    clip['tracking'] = {'lighting': meta.get('lighting'), 'mirror': meta.get('mirror'), 'detected': meta.get('detected'), 'tracker': meta.get('tracker')}
    q['fingers_seen'] = fq; q['face_seen'] = round(float(fok.mean()), 3) if len(fok) else 0
    return clip, q, info, meta

if __name__ == '__main__':
    a = float(sys.argv[2]) if len(sys.argv) > 2 else None; b = float(sys.argv[3]) if len(sys.argv) > 3 else None
    clip, q, info, meta = build(sys.argv[1], a, b)
    o = sys.argv[1].replace('.npz', '.clip.json')
    json.dump(clip, open(o, 'w'), separators=(',', ':'))
    print(json.dumps({'out': o, 'quality': q, 'bytes': os.path.getsize(o), 'title': info.get('title')}))
