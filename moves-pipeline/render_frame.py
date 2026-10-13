# A legible proof/still of what Jena's tracker sees at one moment: colour-coded, labelled body-part boxes, skeleton,
# both hands' 21 points (her left = green), face points, and the normalised body measurements her self-check scores.
# usage: render_frame.py <id> <seconds> <out.jpg>   (reads raw/<id>.npz, raw/<id>.clip.json, tmp/<id>.mp4)
import json, os, sys, ast, re
import numpy as np, cv2
D = os.path.dirname(os.path.abspath(__file__))
cid, t, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
src = open(os.path.join(D, 'holistic.py')).read()
grab = lambda name: ast.literal_eval(re.search(name + r' = (\{.*?\})\n', src, re.S).group(1))
SEGMENTS, SEG_SHORT = grab('SEGMENTS'), grab('SEG_SHORT')
BONES = ast.literal_eval(re.search(r'BONES = (\[.*?\])\n', src).group(1)); HB = ast.literal_eval(re.search(r'HB = (\[.*?\])\n', src).group(1))
z = np.load(os.path.join(D, 'raw', cid + '.npz'), allow_pickle=True)
clip = json.load(open(os.path.join(D, 'raw', cid + '.clip.json')))
meta = json.loads(str(z['meta'])) if z['meta'].shape == () else {}
T = z['t']; i = int(np.argmin(np.abs(T - t)))
start = float(meta.get('start') or 0) if isinstance(meta, dict) else 0.0
cap = cv2.VideoCapture(os.path.join(D, 'tmp', cid + '.mp4')); cap.set(cv2.CAP_PROP_POS_MSEC, (T[i] + start) * 1000); ok, fr = cap.read(); cap.release()
if not ok: raise SystemExit('no frame')
if (clip.get('tracking') or {}).get('mirror', {}).get('mirrored'): fr = cv2.flip(fr, 1)
H = 720; sc = H / fr.shape[0]; Wd = int(fr.shape[1] * sc) // 2 * 2; im = cv2.resize(fr, (Wd, H))
P = z['norm'][i] * [Wd, H]; V = z['vis'][i]
F = cv2.FONT_HERSHEY_SIMPLEX
for name, (ids, col) in SEGMENTS.items():
    ok_ = [k for k in ids if V[k] > 0.4]
    if len(ok_) < max(1, len(ids) // 2): continue
    pts = P[ok_]; pad = 14 if name == 'head' else 10
    x0, y0 = pts.min(0) - pad; x1, y1 = pts.max(0) + pad
    ov = im.copy(); cv2.rectangle(ov, (int(x0), int(y0)), (int(x1), int(y1)), col, -1); cv2.addWeighted(ov, 0.14, im, 0.86, 0, im)
    cv2.rectangle(im, (int(x0), int(y0)), (int(x1), int(y1)), col, 2)
    lab = SEG_SHORT[name]; (tw, th), _ = cv2.getTextSize(lab, F, 0.5, 1)
    lx, ly = int(max(0, x0)), int(max(th + 4, y0))
    cv2.rectangle(im, (lx, ly - th - 5), (lx + tw + 6, ly), (20, 20, 20), -1); cv2.putText(im, lab, (lx + 3, ly - 3), F, 0.5, col, 1, cv2.LINE_AA)
for a, b in BONES:
    if V[a] > 0.3 and V[b] > 0.3: cv2.line(im, tuple(P[a].astype(int)), tuple(P[b].astype(int)), (0, 220, 255), 3, cv2.LINE_AA)
for k, col in ((0, (80, 255, 120)), (1, (255, 140, 60))):
    q = z['hands_norm'][i][k]
    if np.isfinite(q[0, 0]):
        Q = q * [Wd, H]
        for a, b in HB: cv2.line(im, tuple(Q[a].astype(int)), tuple(Q[b].astype(int)), col, 2, cv2.LINE_AA)
        for p in Q.astype(int): cv2.circle(im, tuple(p), 3, col, -1)
fn = z['face_norm'][i]
if np.isfinite(fn[0, 0]):
    for p in (fn[::3] * [Wd, H]).astype(int): cv2.circle(im, tuple(p), 1, (255, 255, 255), -1)
# metrics panel
M = clip.get('metrics') or {}; fi = min(int(round(T[i] * clip.get('fps', 15))), len(M.get('data', [[0]])[0]) - 1)
rows = []
for n, s, d in zip(M.get('names', []), M.get('scale', []), M.get('data', [])):
    v = d[fi] / s; unit = '°' if not any(x in n for x in ('Wrist', 'HandUp', 'Symmetry')) else ''
    rows.append(f'{n}: {v:.2f}' if not unit else f'{n}: {v:.0f}deg')
panel = np.full((H, 330, 3), 24, np.uint8)
cv2.putText(panel, 'normalised body measurements', (10, 26), F, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
cv2.putText(panel, f'frame {fi}  t={T[i]:.1f}s  (her self-check targets)', (10, 48), F, 0.45, (180, 180, 180), 1, cv2.LINE_AA)
for j, r in enumerate(rows): cv2.putText(panel, r, (10, 80 + j * 28), F, 0.52, (120, 255, 160) if r.startswith('left') else (120, 180, 255) if r.startswith('right') else (230, 230, 230), 1, cv2.LINE_AA)
tr = clip.get('tracking') or {}
cv2.putText(panel, f"light: {(tr.get('lighting') or {}).get('used', '?')}  mirrored: {(tr.get('mirror') or {}).get('mirrored', '?')}", (10, H - 40), F, 0.48, (255, 255, 255), 1, cv2.LINE_AA)
cv2.putText(panel, 'green = HER left, orange = her right', (10, H - 16), F, 0.48, (255, 255, 255), 1, cv2.LINE_AA)
cv2.imwrite(out, np.hstack([im, panel]), [cv2.IMWRITE_JPEG_QUALITY, 88])
print(json.dumps({'ok': True, 'out': out, 'frame': fi}))
