
# Tab Live "Tracking" view, drawn big enough to read on a phone (Saidie, Oct 13: "the dancer is tiny, the lines are thin,
# the hand and face points are invisible"). Re-draws what her tracker saw from its own saved landmarks (raw/ID.npz from
# holistic.py: body 33, both hands 21 each, face 478) over the source frames:
#   * auto-crop + zoom to the tracked person (union of her body/hands/face over the clip, robust percentiles, padded)
#   * drawn at the output resolution (not 360p), thick skeleton with a dark outline, labelled body-part boxes
#   * both hands' 21 points + finger bones, big (green = her left, orange = her right), fingertips ringed
#   * face mesh points + eye/brow/lip contours
#   * a header (what, when, detection rates) and a legend strip readable at 390 px
# usage: track_overlay.py ID VIDEO OUT.mp4 [--start S] [--label TEXT] [--height 960]
import os, sys, json, subprocess, time, argparse
import numpy as np, cv2
cv2.setNumThreads(1)
ap = argparse.ArgumentParser(); ap.add_argument('cid'); ap.add_argument('video'); ap.add_argument('out')
ap.add_argument('--npz'); ap.add_argument('--start', type=float); ap.add_argument('--label', default=''); ap.add_argument('--height', type=int, default=960)
ap.add_argument('--tracked-at', type=float); ap.add_argument('--jpg')
A = ap.parse_args()
D = os.environ.get('MOVES_DIR', os.path.dirname(os.path.abspath(__file__)))
z = np.load(A.npz or f'{D}/raw/{A.cid}.npz', allow_pickle=True)
T = z['t']; N2 = z['norm']; VIS = z['vis']; HN = z['hands_norm']; FN = z['face_norm'].astype(np.float32); FS = z['face_score']
meta = json.loads(str(z['meta'])) if 'meta' in z.files else {}
mirrored = bool((meta.get('mirror') or {}).get('mirrored'))
n = len(T)
# a hand the hand-model found away from the body's own wrist is someone/something else (a shoe, a shadow): not drawn
for i in range(n):
    sh_ = np.linalg.norm((N2[i, 11] - N2[i, 12]) * [16, 9]) if np.isfinite(N2[i, [11, 12]]).all() else np.nan
    for k, wj in ((0, 15), (1, 16)):
        if not np.isfinite(HN[i, k, 0, 0]): continue
        if not np.isfinite(N2[i, wj]).all() or VIS[i, wj] < 0.3 or not np.isfinite(sh_) or np.linalg.norm((HN[i, k, 0] - N2[i, wj]) * [16, 9]) > 0.45 * sh_:
            HN[i, k] = np.nan
BONES = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24), (23, 25), (25, 27), (24, 26), (26, 28), (27, 31), (28, 32), (27, 29), (28, 30)]
HB = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11), (11, 12), (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (0, 17), (17, 18), (18, 19), (19, 20)]
TIPS = [4, 8, 12, 16, 20]
# BGR colours
SEGMENTS = {
    'head': ([0, 2, 5, 7, 8, 9, 10], (255, 255, 255)), 'chest': ([11, 12, 23, 24], (255, 180, 60)),
    'L up arm': ([11, 13], (60, 220, 60)), 'L forearm': ([13, 15], (120, 255, 120)),
    'R up arm': ([12, 14], (40, 140, 255)), 'R forearm': ([14, 16], (90, 180, 255)),
    'L thigh': ([23, 25], (0, 170, 0)), 'L shin': ([25, 27], (60, 210, 60)), 'L foot': ([27, 29, 31], (140, 240, 140)),
    'R thigh': ([24, 26], (0, 90, 230)), 'R shin': ([26, 28], (40, 130, 245)), 'R foot': ([28, 30, 32], (110, 170, 255)),
}
LH, RH = (80, 255, 110), (40, 150, 255)   # her left = green, her right = orange
FACE_C = (255, 240, 120)                   # face = light cyan-blue
# face contours (MediaPipe 478 mesh): face oval, eyes, brows, lips
OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10]
LEYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466, 263]
REYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 33]
LBROW = [276, 283, 282, 295, 285, 300, 293, 334, 296, 336]; RBROW = [46, 53, 52, 65, 55, 70, 63, 105, 66, 107]
LIPS_O = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185, 61]
LIPS_I = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191, 78]

cap = cv2.VideoCapture(A.video); sf = cap.get(cv2.CAP_PROP_FPS) or 30
W0 = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H0 = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
# ---- crop: a virtual camera that follows the person. Size: the 90th percentile of her per-frame extent (padded),
# so it doesn't pump in and out; centre: her per-frame centre, smoothed over ~0.7 s, clamped inside the video.
ASP = 4 / 5   # portrait crop: fills a phone
cen = np.full((n, 2), np.nan); ext = np.full((n, 2), np.nan)
for i in range(n):
    p = N2[i][(VIS[i] > 0.5)]; p = p[np.isfinite(p).all(1)]
    hs = [HN[i, k] for k in (0, 1) if np.isfinite(HN[i, k]).all()]
    if len(p) < 6: continue
    q = np.concatenate([p] + hs) * [W0, H0]
    lo, hi = q.min(0), q.max(0); cen[i] = (lo + hi) / 2; ext[i] = hi - lo
ok = np.isfinite(cen[:, 0])
if ok.sum() < 3: cen[:] = [W0 / 2, H0 / 2]; ext[:] = [W0, H0]; ok[:] = True
idx_ = np.arange(n)
for d_ in (0, 1): cen[:, d_] = np.interp(idx_, idx_[ok], cen[ok, d_])
ew, eh = np.percentile(ext[ok, 0], 90) * 1.3, np.percentile(ext[ok, 1], 90) * 1.18
ch = max(eh, ew / ASP); cw = ch * ASP
if cw > W0: cw = W0; ch = cw / ASP
if ch > H0: ch = H0; cw = min(W0, ch * ASP)
k_ = np.exp(-0.5 * (np.arange(-10, 11) / 5.0) ** 2); k_ /= k_.sum()
pad_ = np.pad(cen, ((10, 10), (0, 0)), mode='edge'); cen = np.stack([np.convolve(pad_[:, d_], k_, 'valid') for d_ in (0, 1)], 1)
cen[:, 1] -= ch * 0.02   # a little headroom
X0 = np.clip(cen[:, 0] - cw / 2, 0, W0 - cw); Y0 = np.clip(cen[:, 1] - ch / 2, 0, H0 - ch)
x0, y0 = float(X0[0]), float(Y0[0])
OH = A.height // 2 * 2; OW = int(OH * cw / ch) // 2 * 2; S = OH / ch
HEAD, LEG = 96, 150
PAN = OW // 3
FW, FH = OW, OH + HEAD + PAN + LEG
zoom = (H0 / ch)
def to_px(q): return np.stack([(q[..., 0] * W0 - x0) * S, (q[..., 1] * H0 - y0) * S + HEAD], -1)   # uses the current frame's x0, y0
font = cv2.FONT_HERSHEY_DUPLEX
def text(im, s, org, sc, col, th=2):
    cv2.putText(im, s, org, font, sc, (0, 0, 0), th + 4, cv2.LINE_AA); cv2.putText(im, s, org, font, sc, col, th, cv2.LINE_AA)
def chip(im, s, x, y, col, sc=0.75):
    (tw, tht), _ = cv2.getTextSize(s, font, sc, 2); x = int(min(max(0, x), FW - tw - 12)); y = int(max(HEAD + tht + 10, y))
    cv2.rectangle(im, (x, y - tht - 10), (x + tw + 12, y + 4), (25, 25, 25), -1); cv2.rectangle(im, (x, y - tht - 10), (x + tw + 12, y + 4), col, 2)
    cv2.putText(im, s, (x + 6, y - 3), font, sc, col, 2, cv2.LINE_AA)
def line(im, a, b, col, th):
    a = tuple(int(v) for v in a); b = tuple(int(v) for v in b)
    cv2.line(im, a, b, (0, 0, 0), th + 4, cv2.LINE_AA); cv2.line(im, a, b, col, th, cv2.LINE_AA)
det = (meta.get('detected') or {})
pc = lambda v: '-' if v is None else f'{round(v * 100)}%'
when = time.strftime('%b %d %H:%M UTC', time.gmtime(A.tracked_at)) if A.tracked_at else time.strftime('%b %d %H:%M UTC', time.gmtime())
legend = np.zeros((LEG, FW, 3), np.uint8); legend[:] = (28, 22, 18)
items = [('skeleton', (0, 220, 255), 'line'), ('her LEFT hand', LH, 'dot'), ('her RIGHT hand', RH, 'dot'), ('face', FACE_C, 'dot'), ('body-part box', (255, 180, 60), 'box')]
col_w = FW // 2; ix = 0
for j, (lab, col, kind) in enumerate(items):
    cx_ = 16 + (j % 2) * col_w; cy_ = 36 + (j // 2) * 42
    if kind == 'line': cv2.line(legend, (cx_, cy_), (cx_ + 34, cy_), col, 6, cv2.LINE_AA)
    elif kind == 'dot': cv2.circle(legend, (cx_ + 17, cy_), 10, col, -1, cv2.LINE_AA); cv2.circle(legend, (cx_ + 17, cy_), 10, (0, 0, 0), 2, cv2.LINE_AA)
    else: cv2.rectangle(legend, (cx_ + 2, cy_ - 12), (cx_ + 32, cy_ + 12), col, 3)
    cv2.putText(legend, lab, (cx_ + 46, cy_ + 9), font, 0.8, (240, 240, 240), 2, cv2.LINE_AA)
cv2.putText(legend, f'zoomed {zoom:.1f}x onto the person' + (' - mirror fixed' if mirrored else ''), (FW - 16 - cv2.getTextSize(f'zoomed {zoom:.1f}x onto the person' + (' - mirror fixed' if mirrored else ''), font, 0.62, 1)[0][0], LEG - 14), font, 0.62, (180, 180, 180), 1, cv2.LINE_AA)
ff = subprocess.Popen(['nice', '-n', '19', 'ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{FW}x{FH}', '-r', '15', '-i', '-',
                       '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-threads', '1', '-movflags', '+faststart', A.out], stdin=subprocess.PIPE)
a0 = A.start or 0.0
best_t = 0.0
if a0: cap.set(cv2.CAP_PROP_POS_MSEC, a0 * 1000)
i = int(a0 * sf); k = 0; best = (-1, None)
while k < n:
    ok, fr = cap.read()
    if not ok: break
    ts = i / sf - a0; i += 1
    if ts + 1e-6 < T[k]: continue
    if mirrored: fr = cv2.flip(fr, 1)
    if fr.shape[1] != W0 or fr.shape[0] != H0: fr = cv2.resize(fr, (W0, H0))
    x0, y0 = float(X0[k]), float(Y0[k])
    M = np.float32([[S, 0, -x0 * S], [0, S, -y0 * S]])
    body = cv2.warpAffine(fr, M, (OW, OH), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    im = np.zeros((FH, FW, 3), np.uint8); im[HEAD:HEAD + OH] = body
    im[HEAD:HEAD + OH] = (im[HEAD:HEAD + OH] * 0.82).astype(np.uint8)   # dim the video a little so the drawing pops
    Pp = to_px(N2[k]); V = VIS[k]; boxes = []; hchips = []
    if np.isfinite(Pp).any():
        ov = im.copy()
        for name, (ids, col) in SEGMENTS.items():
            ok_ = [j for j in ids if V[j] > 0.4 and np.isfinite(Pp[j]).all()]
            if len(ok_) < max(1, len(ids) // 2): continue
            q = Pp[ok_]; pad = 22 if name == 'head' else 14
            bx0, by0 = q.min(0) - pad; bx1, by1 = q.max(0) + pad
            cv2.rectangle(ov, (int(bx0), int(by0)), (int(bx1), int(by1)), col, -1); boxes.append((name, col, bx0, by0, bx1, by1))
        cv2.addWeighted(ov, 0.16, im, 0.84, 0, im)
        for name, col, bx0, by0, bx1, by1 in boxes: cv2.rectangle(im, (int(bx0), int(by0)), (int(bx1), int(by1)), col, 3, cv2.LINE_AA)
        for a, b in BONES:
            if V[a] > 0.3 and V[b] > 0.3 and np.isfinite(Pp[[a, b]]).all(): line(im, Pp[a], Pp[b], (0, 220, 255), 6)
        for j in (11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28):
            if V[j] > 0.3 and np.isfinite(Pp[j]).all(): cv2.circle(im, tuple(Pp[j].astype(int)), 8, (0, 220, 255), -1, cv2.LINE_AA); cv2.circle(im, tuple(Pp[j].astype(int)), 8, (0, 0, 0), 2, cv2.LINE_AA)
    # face
    if FS[k] > 0 and np.isfinite(FN[k]).all():
        F = to_px(FN[k])
        for q in F[::2].astype(int): cv2.circle(im, tuple(q), 2, FACE_C, -1, cv2.LINE_AA)
        for poly, th in ((OVAL, 2), (LEYE, 3), (REYE, 3), (LBROW, 3), (RBROW, 3), (LIPS_O, 3), (LIPS_I, 2)):
            cv2.polylines(im, [F[poly].astype(np.int32)], False, FACE_C, th, cv2.LINE_AA)
    # hands (drawn last: on top)
    nh = 0
    for hk, col in ((0, LH), (1, RH)):
        Hq = HN[k, hk]
        if not np.isfinite(Hq).all(): continue
        nh += 1; Q = to_px(Hq); size = np.linalg.norm(Q[0] - Q[9]); r = int(np.clip(size * 0.07, 4, 11)); th = int(np.clip(size * 0.05, 2, 6))
        for a, b in HB: line(im, Q[a], Q[b], col, th)
        for j in range(21):
            rr = r + 3 if j in TIPS else r
            cv2.circle(im, tuple(Q[j].astype(int)), rr, (0, 0, 0), -1, cv2.LINE_AA); cv2.circle(im, tuple(Q[j].astype(int)), rr - 2, col, -1, cv2.LINE_AA)
            if j in TIPS: cv2.circle(im, tuple(Q[j].astype(int)), rr + 3, (255, 255, 255), 2, cv2.LINE_AA)
        hchips.append(('L hand' if hk == 0 else 'R hand', Q[:, 0].min(), Q[:, 1].min() - 8, col))
    clean = im.copy()   # close-ups come from the drawing without the label chips
    for name, col, bx0, by0, bx1, by1 in boxes: chip(im, name, bx0, by0 - 2, col, 0.7)
    for lab_, hx, hy, col in hchips: chip(im, lab_, hx, hy, col, 0.75)
    # header
    im[:HEAD] = (28, 22, 18)
    text(im, (A.label or A.cid)[:34], (14, 38), 0.95, (255, 255, 255), 2)
    sub = f'tracked {when}  body {pc(det.get("body"))}  L {pc(det.get("left_hand"))}  R {pc(det.get("right_hand"))}  face {pc(det.get("face"))}'
    cv2.putText(im, sub, (14, 76), font, 0.62, (200, 200, 200), 1, cv2.LINE_AA)
    # close-ups: her left hand, face, right hand, each magnified from the drawn frame so fingers + face points read on a phone
    for pi, (lab, q, col) in enumerate((('L hand close-up', HN[k, 0], LH), ('face close-up', FN[k] if FS[k] > 0 else np.full((1, 2), np.nan), FACE_C), ('R hand close-up', HN[k, 1], RH))):
        px0 = pi * PAN; pane = np.full((PAN, PAN if pi < 2 else FW - 2 * PAN, 3), 40, np.uint8)
        if np.isfinite(q).all():
            Q = to_px(q); c0 = (Q.min(0) + Q.max(0)) / 2; ext = max(110.0, float((Q.max(0) - Q.min(0)).max()) * 1.7)
            ax0, ay0 = int(c0[0] - ext / 2), int(c0[1] - ext / 2); src = np.full((int(ext), int(ext), 3), 40, np.uint8)
            sx0, sy0 = max(0, ax0), max(HEAD, ay0); sx1, sy1 = min(FW, ax0 + int(ext)), min(HEAD + OH, ay0 + int(ext))
            if sx1 > sx0 and sy1 > sy0: src[sy0 - ay0:sy1 - ay0, sx0 - ax0:sx1 - ax0] = clean[sy0:sy1, sx0:sx1]
            pane = cv2.resize(src, (pane.shape[1], PAN), interpolation=cv2.INTER_CUBIC)
        else:
            cv2.putText(pane, 'not seen', (16, PAN // 2), font, 0.8, (150, 150, 150), 2, cv2.LINE_AA); cv2.putText(pane, 'this frame', (16, PAN // 2 + 34), font, 0.8, (150, 150, 150), 2, cv2.LINE_AA)
        cv2.rectangle(pane, (0, 0), (pane.shape[1] - 1, PAN - 1), col, 4)
        (tw, tht), _ = cv2.getTextSize(lab, font, 0.62, 2); cv2.rectangle(pane, (0, 0), (tw + 14, tht + 14), (25, 25, 25), -1)
        cv2.putText(pane, lab, (7, tht + 7), font, 0.62, col, 2, cv2.LINE_AA)
        im[HEAD + OH:HEAD + OH + PAN, px0:px0 + pane.shape[1]] = pane
    im[HEAD + OH + PAN:] = legend
    ff.stdin.write(im.tobytes())
    score = nh * 2 + (1 if FS[k] > 0 else 0)
    if score > best[0] or (score == best[0] and k == n // 2): best = (score, im.copy()); best_t = k / 15
    k += 1
cap.release(); ff.stdin.close(); ff.wait()
if A.jpg and best[1] is not None: cv2.imwrite(A.jpg, best[1], [cv2.IMWRITE_JPEG_QUALITY, 90])
print(json.dumps({'id': A.cid, 'frames': k, 'size': [FW, FH], 'crop': [int(x0), int(y0), int(cw), int(ch)], 'zoom': round(float(zoom), 2), 'out': A.out, 'jpg': A.jpg, 'best_t': round(best_t, 2)}))
