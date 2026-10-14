#!/usr/bin/env python3
"""Motion stats + style for Jena's tracked clips (keypoint JSON from jena-track / public/moves).
  motion_stats.py <clip.json>... --out ANIMATIONS
One Euro smoothing of every bone's quaternion track, per-joint angular velocity (rad/s) and acceleration (rad/s^2),
gesture onsets (arm/hand speed rising out of rest), overshoot (how far a movement goes past where it settles),
gestures per minute, head amplitude (deg), sway period (s, dominant period of the hips' side-to-side), and a soft
style classification (smooth / bouncy / snappy / chibi). Same rule as src/motion.js classifyStyle().
Writes <out>/stats/<id>.json, <out>/styles.json and <out>/training/motion.jsonl. Numbers only; no video."""
import json, math, os, sys
import numpy as np

class OneEuro:  # Casiez et al. 2012: low lag when moving fast, smooth when still
    def __init__(self, fps, mincutoff=1.2, beta=0.3, dcutoff=1.0):
        self.f, self.mc, self.b, self.dc, self.x, self.dx = fps, mincutoff, beta, dcutoff, None, None
    @staticmethod
    def a(cut, f): t = 1.0 / f; r = 1.0 / (2 * math.pi * cut); return 1.0 / (1.0 + r / t)
    def __call__(self, x):
        if self.x is None: self.x, self.dx = x.copy(), np.zeros_like(x); return x
        dx = (x - self.x) * self.f
        ad = self.a(self.dc, self.f); self.dx = ad * dx + (1 - ad) * self.dx
        cut = self.mc + self.b * np.linalg.norm(self.dx)
        al = self.a(cut, self.f); self.x = al * x + (1 - al) * self.x
        return self.x

def quats(flat, scale):
    q = np.asarray(flat, dtype=float).reshape(-1, 4) / scale
    for i in range(1, len(q)):
        if np.dot(q[i], q[i - 1]) < 0: q[i] = -q[i]
    return q / np.maximum(1e-9, np.linalg.norm(q, axis=1, keepdims=True))

def smooth(q, fps):
    f = OneEuro(fps); out = np.array([f(x) for x in q])
    return out / np.maximum(1e-9, np.linalg.norm(out, axis=1, keepdims=True))

def ang(a, b): return 2 * np.arccos(np.clip(np.abs(np.sum(a * b, axis=-1)), -1, 1))

def euler_yxz(q):  # yaw (y), pitch (x) of a head quaternion, radians
    x, y, z, w = q.T
    yaw = np.arctan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y))
    pitch = np.arcsin(np.clip(2 * (w * x - y * z), -1, 1))
    return yaw, pitch

def classify(speed, accel, overshoot, amp):
    c = lambda v: max(0.0, min(1.0, v))
    s = {'smooth': max(0, 1 - speed / 2.2) * max(0, 1 - overshoot * 3),
         'bouncy': c(overshoot * 3) * c(speed / 1.6),
         'snappy': c(accel / 40) * max(0, 1 - overshoot * 2),
         'chibi': c(amp / 0.9) * c(overshoot * 2.5) * c(speed / 2)}
    t = sum(s.values()) or 1
    return {k: round(v / t, 3) for k, v in s.items()}

ARMS = ['leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand']
UPPER = ARMS + ['spine', 'chest', 'neck', 'head']

def analyse(path):
    c = json.load(open(path)); fps = float(c.get('fps') or 15); sc = float(c.get('scale') or 1000)
    B = {k: smooth(quats(v, sc), fps) for k, v in c['bones'].items() if len(v) >= 8}
    n = min(len(q) for q in B.values()); dur = n / fps
    vel = {k: ang(q[1:n], q[:n - 1]) * fps for k, q in B.items()}
    acc = {k: np.abs(np.diff(v)) * fps for k, v in vel.items()}
    speed = float(np.mean([vel[k].mean() for k in UPPER if k in vel]))
    accel = float(np.mean([acc[k].mean() for k in UPPER if k in acc]))
    # gesture onsets: an arm bone's speed rising past 1.2 rad/s after >= 0.2 s under 0.5 rad/s
    onsets = []
    for side in ['left', 'right']:
        v = np.max([vel[side + b] for b in ['UpperArm', 'LowerArm', 'Hand'] if side + b in vel], axis=0)
        rest = 0; armed = True
        for i, x in enumerate(v):
            if x < 0.5: rest += 1
            if x > 1.2 and rest >= int(0.2 * fps) and armed: onsets.append({'t': round(i / fps, 2), 'side': side, 'peak': round(float(v[i:i + int(fps)].max()), 2)}); rest = 0
            if x >= 0.5: rest = 0 if x > 1.2 else rest
    onsets.sort(key=lambda o: o['t'])
    merged = []
    for o in onsets:
        if merged and o['t'] - merged[-1]['t'] < 0.3: continue
        merged.append(o)
    # overshoot: per onset, peak displacement from the start pose vs where it settles 1 s later
    ovs, amps = [], []
    for o in merged:
        i0 = int(o['t'] * fps); i1 = min(n - 1, i0 + int(1.2 * fps))
        for b in ['UpperArm', 'LowerArm']:
            q = B.get(o['side'] + b)
            if q is None or i1 - i0 < 4: continue
            d = ang(q[i0:i1], q[i0][None, :]); pk = float(d.max()); fin = float(d[-1])
            if pk > 0.15: ovs.append(max(0.0, (pk - fin) / pk)); amps.append(pk)
    overshoot = float(np.mean(ovs)) if ovs else 0.0
    amp = float(np.mean(amps)) if amps else 0.0
    yaw, pitch = euler_yxz(B['head'][:n]) if 'head' in B else (np.zeros(n), np.zeros(n))
    head_amp = float(np.degrees(np.sqrt(np.std(yaw) ** 2 + np.std(pitch) ** 2)))
    sway = None
    ho = np.asarray(c.get('hips_offset') or [], dtype=float)
    if ho.size >= 3 * 16:
        x = ho.reshape(-1, 3)[:, 0]; x = x - x.mean()
        f = np.fft.rfftfreq(len(x), 1 / fps); p = np.abs(np.fft.rfft(x))
        m = (f > 0.1) & (f < 1.0)
        if m.any() and p[m].max() > 0: sway = round(float(1 / f[m][np.argmax(p[m])]), 2)
    lf = c.get('learned_from') or {}
    face = c.get('face') or {}
    lips = None
    if face.get('w') and face.get('names') and 'aa' in face['names']:
        # lip-sync timing from the tracked mouth: open/close cycles per second, how fast it opens and closes
        w = np.asarray(face['w'], dtype=float); a = w[face['names'].index('aa')] if w.shape[0] == len(face['names']) else w[:, face['names'].index('aa')]
        a = a / max(1.0, a.max()); fa = OneEuro(fps, 2.0, 0.5); a = np.array([fa(np.array([x]))[0] for x in a])
        up = np.where((a[1:] >= 0.5) & (a[:-1] < 0.5))[0]
        d = np.diff(a) * fps
        lips = {'mouth_cycles_per_s': round(len(up) / max(dur, 1e-6), 2), 'open_mean': round(float(a.mean()), 3),
                'open_speed_per_s': round(float(np.percentile(d[d > 0], 90)) if (d > 0).any() else 0, 2), 'close_speed_per_s': round(float(-np.percentile(d[d < 0], 10)) if (d < 0).any() else 0, 2)}
    return {'id': c.get('id') or os.path.basename(path)[:-5], 'source': lf.get('url'), 'channel': lf.get('channel'), 'seconds': round(dur, 1), 'fps': fps,
            'has': {'fingers': sorted((c.get('fingers') or {}).keys()), 'face': bool(face)},
            'speed_rad_s': round(speed, 3), 'accel_rad_s2': round(accel, 2), 'overshoot': round(overshoot, 3), 'gesture_amp_rad': round(amp, 3),
            'gestures_per_min': round(len(merged) / max(dur, 1e-6) * 60, 1), 'head_amp_deg': round(head_amp, 1), 'sway_period_s': sway,
            'per_joint': {k: {'vel_mean': round(float(vel[k].mean()), 3), 'vel_p95': round(float(np.percentile(vel[k], 95)), 3), 'acc_mean': round(float(acc[k].mean()), 2)} for k in UPPER if k in vel},
            'lipsync': lips, 'onsets': merged, 'style': classify(speed, accel, overshoot, amp)}

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else 'ANIMATIONS'
    meta = {}
    sp = os.path.join(out, 'sources.json')
    if os.path.exists(sp): meta = {x['id']: x for x in json.load(open(sp))['clips']}
    os.makedirs(os.path.join(out, 'stats'), exist_ok=True); os.makedirs(os.path.join(out, 'training'), exist_ok=True)
    res = []
    for p in args:
        if os.path.basename(p) == out + '/sources.json': continue
        try: r = analyse(p)
        except Exception as e: print('skip', p, e, file=sys.stderr); continue
        if r['id'] not in meta and os.path.basename(p)[:-5] in meta: r['id'] = os.path.basename(p)[:-5]
        res.append(r); json.dump(r, open(os.path.join(out, 'stats', r['id'] + '.json'), 'w'), indent=1)
    print(json.dumps([{k: r[k] for k in ('id', 'gestures_per_min', 'head_amp_deg', 'sway_period_s', 'speed_rad_s', 'overshoot')} | {'style': max(r['style'], key=r['style'].get)} for r in res]))
