
# A small preview GIF of a learned move (her tracking only: body, both hands, face points; no video frames),
# for ANIMATIONS/ on GitHub. Green = performer's/HER left, orange = right. Kept under 1 MB.
#   preview_gif.py raw/ID.npz out.gif [a b]
import sys, json, numpy as np
from PIL import Image, ImageDraw
z = np.load(sys.argv[1]); out = sys.argv[2]
a = float(sys.argv[3]) if len(sys.argv) > 3 else None; b = float(sys.argv[4]) if len(sys.argv) > 4 else None
N = z['norm']; V = z['vis']; HN = z['hands_norm'] if 'hands_norm' in z.files else None; FN = z['face_norm'].astype(np.float32) if 'face_norm' in z.files else None
info = json.loads(str(z['info'])); asp = info.get('aspect') or 16 / 9
fps = 15; i0, i1 = (int(a * fps), int(b * fps)) if a is not None else (0, len(N))
BONES = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24), (23, 25), (25, 27), (24, 26), (26, 28), (27, 31), (28, 32), (27, 29), (28, 30)]
HB = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11), (11, 12), (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (0, 17), (17, 18), (18, 19), (19, 20)]
LEFT = {11, 13, 15, 23, 25, 27, 29, 31}
# crop to where the person is
pts = N[i0:i1].reshape(-1, 2); pts = pts[np.isfinite(pts).all(1)]
x0, y0 = np.percentile(pts, 1, 0) - 0.06; x1, y1 = np.percentile(pts, 99, 0) + 0.06
H = 260; Wd = int(H * (x1 - x0) * asp / max(1e-3, (y1 - y0))) // 2 * 2; Wd = int(np.clip(Wd, 140, 300))
def P(p): return ((p[0] - x0) / (x1 - x0) * Wd, (p[1] - y0) / (y1 - y0) * H)
frames = []
for f in range(i0, i1, 2):   # 7.5 fps
    im = Image.new('RGB', (Wd, H), (18, 16, 30)); d = ImageDraw.Draw(im)
    for s, e in BONES:
        if V[f, s] > 0.3 and V[f, e] > 0.3 and np.isfinite(N[f, s, 0]):
            col = (90, 230, 130) if s in LEFT and e in LEFT else (255, 150, 70) if s not in LEFT and e not in LEFT else (230, 220, 255)
            d.line([P(N[f, s]), P(N[f, e])], fill=col, width=3)
    if np.isfinite(N[f, 0, 0]): c = P(N[f, 0]); d.ellipse([c[0] - 9, c[1] - 11, c[0] + 9, c[1] + 11], outline=(230, 220, 255), width=2)
    if HN is not None:
        for k, col in ((0, (120, 255, 160)), (1, (255, 180, 110))):
            if np.isfinite(HN[f, k, 0, 0]):
                for s, e in HB: d.line([P(HN[f, k, s]), P(HN[f, k, e])], fill=col, width=1)
    if FN is not None and np.isfinite(FN[f, 0, 0]):
        for q in FN[f, ::6]: c = P(q); d.point(c, fill=(255, 255, 255))
    d.text((4, H - 12), 'Jena · L=green R=orange', fill=(160, 150, 200))
    frames.append(im.quantize(colors=16, method=Image.Quantize.MEDIANCUT))
frames[0].save(out, save_all=True, append_images=frames[1:], duration=133, loop=0, optimize=True, disposal=1)
import os; sz = os.path.getsize(out)
if sz > 1_000_000:  # too big: half the frames
    frames[0].save(out, save_all=True, append_images=frames[2::2], duration=266, loop=0, optimize=True); sz = os.path.getsize(out)
print(json.dumps({'gif': out, 'bytes': sz, 'frames': len(frames), 'size': [Wd, H]}))
