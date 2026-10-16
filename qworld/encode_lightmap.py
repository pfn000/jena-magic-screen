
import sys, os, json, numpy as np
from PIL import Image
out = sys.argv[1]; SUF = sys.argv[2] if len(sys.argv) > 2 else ''
def readpfm(p):
    with open(p, 'rb') as f:
        assert f.readline().strip() == b'PF'; w, h = map(int, f.readline().split()); s = float(f.readline())
        a = np.frombuffer(f.read(), '<f4' if s < 0 else '>f4').reshape(h, w, 3)
    return a
src = os.path.join(out, 'lightmap%s_dn.pfm' % SUF); den = os.path.exists(src)
a = readpfm(src if den else os.path.join(out, 'lightmap%s.pfm' % SUF))
SCALE = 8.0 if SUF == '_day' else 4.0
enc = (np.clip(a / SCALE, 0, 1) ** (1 / 2.2) * 255 + 0.5).astype(np.uint8)[::-1]
im = Image.fromarray(enc, 'RGB'); im.save(os.path.join(out, 'lightmap%s.webp' % SUF), quality=92, method=6)
im.resize((1024, 1024)).save(os.path.join(out, 'lightmap%s-preview.jpg' % SUF), quality=85)
info = {'denoised': den, 'scale': SCALE, 'encoding': 'srgb(L/scale)', 'bytes': os.path.getsize(os.path.join(out, 'lightmap%s.webp' % SUF)),
        'p50': float(np.median(a)), 'p99': float(np.percentile(a, 99)), 'clipped_frac': float((a > SCALE).mean())}
json.dump(info, open(os.path.join(out, 'lightmap%s.json' % SUF), 'w'), indent=1); print(info)
# rev 1792172262931215024
