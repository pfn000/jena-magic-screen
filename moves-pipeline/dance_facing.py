#!/usr/bin/env python3
# Facing for dance clips (K-pop practice videos): the performer turns, so a single "median facing" (retarget.py) would
# clamp every turn away. This reads the performer's facing EVERY frame from the hip line (shoulder line as backup),
# detects back-facing frames (no face + labels that still claim front = MediaPipe's front bias -> swap L/R, +180),
# then de-rotates each frame so the bone tracks are turn-free. The turn itself is returned as a separate track:
#   facing.yaw[i]   = degrees*10 the performer has turned (about up, + = toward her left), relative to frame 0
#   facing.chest[i] = same for the shoulder line (chest - yaw = torso twist, already inside spine/chest bones)
# Jena plays yaw through her own facing system (feet pivot) so she turns by the same amount from her start facing.
# Left/right stay the performer's own (mirrored practice videos are un-mirrored by holistic.py before tracking).
import json, sys, numpy as np
from scipy.signal import butter, filtfilt
PAIRS = [(1, 4), (2, 5), (3, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16), (17, 18), (19, 20), (21, 22), (23, 24), (25, 26), (27, 28), (29, 30), (31, 32)]
FPS = 15.0
def _fill(x):
    x = np.array(x, float); i = np.arange(len(x)); ok = np.isfinite(x)
    return np.interp(i, i[ok], x[ok]) if ok.sum() >= 2 else np.zeros_like(x)
def _lp(x, cut):
    if len(x) < 10: return x
    b, a = butter(2, cut / (FPS / 2)); return filtfilt(b, a, x, padlen=min(6, len(x) - 1))
def _yaw(P, l, r):
    h = P[:, l] - P[:, r]; return np.degrees(np.arctan2(-h[:, 2], h[:, 0]))
def derotate(src, dst):
    z = dict(np.load(src, allow_pickle=False))
    W = z['world'].astype(float); V = z['vis'].astype(float)
    n = len(W)
    P = np.stack([W[..., 0], -W[..., 1], -W[..., 2]], -1)
    hy, sy = _yaw(P, 23, 24), _yaw(P, 11, 12)
    fs = z.get('face_score'); fs = np.zeros(n) if fs is None or len(fs) != n else np.nan_to_num(np.array(fs, float))
    face = (fs > 0.3) | (np.nan_to_num(V[:, 0]) > 0.6)
    # back-facing: no face for >= 4 frames in a row while the labels still say "front" -> MediaPipe swapped sides
    noface = ~face; run = np.zeros(n, bool); k = 0
    for i in range(n):
        k = k + 1 if noface[i] else 0
        if k >= 4: run[i - k + 1:i + 1] = True
    swapped = run & (np.abs(np.nan_to_num(hy)) < 75)
    if swapped.any():
        for a, b in PAIRS:
            W[swapped, a], W[swapped, b] = W[swapped, b].copy(), W[swapped, a].copy()
            V[swapped, a], V[swapped, b] = V[swapped, b].copy(), V[swapped, a].copy()
        P = np.stack([W[..., 0], -W[..., 1], -W[..., 2]], -1)
        hy, sy = _yaw(P, 23, 24), _yaw(P, 11, 12)
    # the hip line is the body's facing; where hips are unreliable (low vis) lean on the shoulders
    hv = np.nan_to_num(V[:, [23, 24]].mean(1))
    raw = np.where(hv > 0.35, hy, sy)
    yaw = np.degrees(np.unwrap(np.radians(_fill(raw))))
    chest = np.degrees(np.unwrap(np.radians(_fill(sy))))
    # keep chest on the same turn count as the hips (no +-360 drift between the two)
    chest = chest - 360 * np.round((chest - yaw) / 360)
    yaw_s = _lp(yaw, 1.2); chest_s = _lp(chest, 1.8)
    # de-rotate every frame by its own facing so the bone tracks carry no turn
    th = np.radians(yaw_s)
    c, s = np.cos(-th)[:, None], np.sin(-th)[:, None]
    Px, Pz = P[..., 0], P[..., 2]
    P2 = P.copy(); P2[..., 0] = c * Px + s * Pz; P2[..., 2] = -s * Px + c * Pz
    z['world'] = np.stack([P2[..., 0], -P2[..., 1], -P2[..., 2]], -1).astype(np.float32)
    z['vis'] = V.astype(np.float32)
    np.savez_compressed(dst, **z)
    y0 = yaw_s[0]
    return {'yaw': [int(round((v - y0) * 10)) for v in yaw_s], 'chest': [int(round((v - y0) * 10)) for v in chest_s], 'scale': 10,
            'unit': 'degrees turned about up from the first frame (+ = toward her left); chest = shoulder line',
            'start_abs': round(float(y0), 1), 'back_frames': int(swapped.sum()), 'face_frames': int(face.sum()), 'frames': n,
            'range': [round(float((yaw_s - y0).min()), 1), round(float((yaw_s - y0).max()), 1)],
            'twist_max': round(float(np.abs(chest_s - yaw_s).max()), 1)}
if __name__ == '__main__':
    print(json.dumps(derotate(sys.argv[1], sys.argv[2]))[:2000])
