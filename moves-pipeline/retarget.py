
import sys, json, numpy as np
from scipy.spatial.transform import Rotation as R, Slerp
from scipy.signal import butter, filtfilt
FPS = 15.0
def nrm(v): return v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-9)
def basis_rot(x, yhint):
    x = nrm(x); z = nrm(np.cross(x, yhint)); y = np.cross(z, x)
    return R.from_matrix(np.stack([x, y, z], axis=-1))
def frame_rot(a, b, a0, b0):
    # rotation taking rest frame (a0,b0) to tracked (a,b); a,b orthonormalised
    a = nrm(a); b = nrm(b - (b * a).sum(-1, keepdims=True) * a); c = np.cross(a, b)
    a0 = np.asarray(a0, float); b0 = np.asarray(b0, float); c0 = np.cross(a0, b0)
    M = np.stack([a, b, c], -1); M0 = np.stack([a0, b0, c0], -1)
    return R.from_matrix(M @ M0.T)
def swing(u, v):
    u = nrm(u); v = nrm(v); ax = np.cross(u, v); s = np.linalg.norm(ax, axis=-1); c = (u * v).sum(-1)
    ang = np.arctan2(s, c); ax = ax / (s[:, None] + 1e-9)
    return R.from_rotvec(ax * ang[:, None])
def frac(r, f): return R.from_rotvec(r.as_rotvec() * f)
def clamp_rot(r, maxang):
    rv = r.as_rotvec(); a = np.linalg.norm(rv, axis=-1, keepdims=True)
    return R.from_rotvec(np.where(a > maxang, rv / (a + 1e-9) * maxang, rv))
def lowpass(x, cut, order=2):
    b, a = butter(order, cut / (FPS / 2)); return filtfilt(b, a, x, axis=0, padlen=min(3 * max(len(a), len(b)), len(x) - 1))
def fill_nan(X):
    X = X.copy(); n = len(X); idx = np.arange(n)
    flat = X.reshape(n, -1)
    for j in range(flat.shape[1]):
        m = np.isfinite(flat[:, j])
        if m.sum() == 0: continue
        flat[:, j] = np.interp(idx, idx[m], flat[m, j])
    return flat.reshape(X.shape)
def smooth_quats(r, cut):
    q = r.as_quat()
    for i in range(1, len(q)):
        if (q[i] * q[i - 1]).sum() < 0: q[i] = -q[i]
    q = lowpass(q, cut); return R.from_quat(nrm(q))

def analyse(path, a=None, b=None):
    z = np.load(path); W = z['world'].astype(float); V = z['vis']; N = z['norm']; info = json.loads(str(z['info']))
    if a is not None:
        i0, i1 = int(a * FPS), int(b * FPS); W, V, N = W[i0:i1], V[i0:i1], N[i0:i1]
    n = len(W)
    det = np.isfinite(W[:, 0, 0])
    P = np.stack([W[..., 0], -W[..., 1], -W[..., 2]], -1)  # -> VRM space: +x her left, +y up, +z forward
    P = fill_nan(P)
    Ps = lowpass(P, 3.0)
    q = {}
    L = lambda k: Ps[:, k]
    # quality
    legs = [23, 24, 25, 26, 27, 28, 29, 30, 31, 32]
    vis_legs = float(np.mean(V[:, [25, 26, 27, 28]]))
    vis_arms = float(np.mean(V[:, [13, 14, 15, 16]]))
    leglen = np.median(np.linalg.norm(P[:, 23] - P[:, 25], axis=-1) + np.linalg.norm(P[:, 25] - P[:, 27], axis=-1))
    resid = np.linalg.norm(P - Ps, axis=-1)  # jitter
    jitter = float(np.median(resid[:, [15, 16, 27, 28, 0]].mean(0)) / leglen)
    def cv(i, j):
        d = np.linalg.norm(P[:, i] - P[:, j], axis=-1); return float(np.std(d) / np.mean(d))
    bone_cv = max(cv(13, 15), cv(14, 16), cv(25, 27), cv(26, 28), cv(23, 25), cv(24, 26))
    inframe = float(np.mean((N[:, [27, 28], 1] < 1.0) & (N[:, [27, 28], 1] > 0)))
    q = dict(frames=n, detected=float(det.mean()), vis_legs=round(vis_legs, 3), vis_arms=round(vis_arms, 3), jitter=round(jitter, 4), bone_cv=round(bone_cv, 3), feet_in_frame=round(inframe, 3), leglen=round(float(leglen), 3))
    q['ok'] = bool(q['detected'] > 0.95 and vis_legs > 0.55 and jitter < 0.03 and bone_cv < 0.2 and inframe > 0.95)
    # global correction: median torso up -> +Y, median hip line -> +X
    up = nrm(np.median(nrm((L(11) + L(12)) / 2 - (L(23) + L(24)) / 2), 0))
    G1 = R.align_vectors([[0, 1, 0]], [up])[0]
    Ps = G1.apply(Ps.reshape(-1, 3)).reshape(Ps.shape)
    hl = np.median(nrm(L(23) - L(24)), 0); yaw = np.arctan2(-hl[2], hl[0])
    G2 = R.from_euler('y', -yaw)
    Ps = G2.apply(Ps.reshape(-1, 3)).reshape(Ps.shape)
    mid_hip = (L(23) + L(24)) / 2; mid_sh = (L(11) + L(12)) / 2
    torso_up = mid_sh - mid_hip
    Y = np.tile([0, 1, 0.0], (n, 1))
    hips_w = basis_rot(L(23) - L(24), nrm(0.35 * nrm(torso_up) + 0.65 * Y))
    chest_w = basis_rot(L(11) - L(12), torso_up)
    rel = hips_w.inv() * chest_w
    spine_l, chest_l, uchest_l = frac(rel, 0.4), frac(rel, 0.3), frac(rel, 0.3)
    # head: ear line + nose forward
    ears = (L(7) + L(8)) / 2
    head_w = frame_rot(L(7) - L(8), L(0) - ears, [1, 0, 0], [0, 0, 1])
    hrel = chest_w.inv() * head_w
    # remove median pitch bias of head (nose sits below the ear line)
    hm = R.from_quat(nrm(np.median(hrel.as_quat() * np.sign(hrel.as_quat()[:, 3:4]), 0)))
    pitch_bias = hm.as_euler('YXZ')[1]
    hrel = R.from_euler('x', -pitch_bias) * hrel  # applied in chest frame
    hrel = clamp_rot(hrel, 0.75)
    neck_l, head_l = frac(hrel, 0.4), frac(hrel, 0.6)
    out = {'hips': hips_w, 'spine': spine_l, 'chest': chest_l, 'upperChest': uchest_l, 'neck': neck_l, 'head': head_l}
    torso_fwd = chest_w.apply([0, 0, 1])
    for side, s, (S, E, Wr, Pk, Ix) in [('left', 1, (11, 13, 15, 17, 19)), ('right', -1, (12, 14, 16, 18, 20))]:
        a = L(E) - L(S); f = nrm(L(Wr) - L(E)); a_n = nrm(a)
        bend = f - (f * a_n).sum(-1, keepdims=True) * a_n
        bl = np.linalg.norm(bend, axis=-1, keepdims=True); w = np.clip(bl / 0.35, 0, 1)
        fb = torso_fwd - (torso_fwd * a_n).sum(-1, keepdims=True) * a_n
        b = nrm(w * nrm(bend) + (1 - w) * nrm(fb))
        up_w = frame_rot(a, b, [s, 0, 0], [0, 0, 1])
        lo_w = swing(a_n, f) * up_w
        # hand: dir to knuckles, side index-pinky
        hd = (L(Ix) + L(Pk)) / 2 - L(Wr); sd = L(Ix) - L(Pk)
        hand_w = frame_rot(hd, sd, [s, 0, 0], [0, 0, 1])
        hl_ = lo_w.inv() * hand_w
        # split twist (about bone x) into the forearm, keep swing on the hand, softened
        rv = hl_.as_rotvec(); qh = hl_.as_quat(); ax = np.array([s, 0, 0.0])
        tw = R.from_quat(nrm(np.concatenate([(qh[:, :3] @ ax)[:, None] * ax[None], qh[:, 3:4]], 1)))
        sw = hl_ * tw.inv()
        tw = clamp_rot(frac(tw, 0.7), 1.2)
        lo_w2 = lo_w * tw
        hand_l = clamp_rot(frac(sw, 0.5), 0.6)
        out[side + 'UpperArm'] = chest_w.inv() * up_w      # parent chain: upperChest -> shoulder(identity) -> upperArm
        out[side + 'LowerArm'] = up_w.inv() * lo_w2
        out[side + 'Hand'] = hand_l
        # legs
        Hh, K, A, Hl, T = (23, 25, 27, 29, 31) if side == 'left' else (24, 26, 28, 30, 32)
        a = L(K) - L(Hh); sh = nrm(L(A) - L(K)); a_n = nrm(a)
        bend = sh - (sh * a_n).sum(-1, keepdims=True) * a_n
        bl = np.linalg.norm(bend, axis=-1, keepdims=True); w = np.clip(bl / 0.25, 0, 1)
        back = -hips_w.apply([0, 0, 1]); fb = back - (back * a_n).sum(-1, keepdims=True) * a_n
        b = nrm(w * nrm(bend) + (1 - w) * nrm(fb))
        ul_w = frame_rot(a, b, [0, -1, 0], [0, 0, -1])
        ll_w = swing(a_n, sh) * ul_w
        ft = L(T) - L(Hl)
        f_w = swing(ll_w.apply([0, 0, 1]), ft) * ll_w
        out[side + 'UpperLeg'] = hips_w.inv() * ul_w
        out[side + 'LowerLeg'] = ul_w.inv() * ll_w
        out[side + 'Foot'] = clamp_rot(ll_w.inv() * f_w, 0.6)
    # hips yaw/roll/pitch clamp
    out['hips'] = clamp_rot(out['hips'], 0.45)
    for k in list(out): out[k] = smooth_quats(out[k], 2.5)
    # root: keep the feet centre fixed (hips move over the feet); y from the lowest foot point
    footc = (L(29) + L(30) + L(31) + L(32)) / 4
    low = np.minimum(np.minimum(L(29)[:, 1], L(31)[:, 1]), np.minimum(L(30)[:, 1], L(32)[:, 1]))
    off = np.stack([-footc[:, 0], -low, -footc[:, 2]], -1)
    off = off - np.median(off, 0)
    off = lowpass(off, 2.0) / leglen
    off[:, 0] = np.clip(off[:, 0], -0.12, 0.12); off[:, 2] = np.clip(off[:, 2], -0.08, 0.08); off[:, 1] = np.clip(off[:, 1], -0.2, 0.03)
    # motion energy (how much is happening), arms vs body
    def energy(names):
        e = 0
        for k in names:
            qq = out[k].as_quat(); e += np.mean(np.abs(np.diff(qq, axis=0)).sum(-1))
        return float(e * FPS / len(names))
    q['energy_arms'] = round(energy(['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm']), 3)
    q['energy_body'] = round(energy(['hips', 'spine', 'head']), 3)
    q['root_range'] = [round(float(x), 3) for x in (off.max(0) - off.min(0))]
    return out, off, q, info

def to_json(out, off, n):
    bones = {}
    for k, r in out.items():
        qq = r.as_quat()
        for i in range(1, len(qq)):
            if (qq[i] * qq[i - 1]).sum() < 0: qq[i] = -qq[i]
        bones[k] = [int(round(v * 1000)) for v in qq.reshape(-1)]
    return {'fps': FPS, 'frames': n, 'duration': round(n / FPS, 2), 'scale': 1000, 'bones': bones,
            'hips_offset': [int(round(v * 1000)) for v in off.reshape(-1)]}
if __name__ == '__main__':
    out, off, q, info = analyse(sys.argv[1])
    print(json.dumps(q)); print(info.get('title'))
