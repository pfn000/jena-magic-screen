
#!/usr/bin/env python3
"""Download CC0 PBR textures (Poly Haven + ambientCG), tint variants, and make the sky / monitor images. Writes tex/ and credits.json."""
import json, os, sys, io, zipfile, urllib.request, math, random
from PIL import Image, ImageDraw, ImageFilter, ImageOps
import numpy as np
T = sys.argv[1] if len(sys.argv) > 1 else 'tex'
os.makedirs(T, exist_ok=True)
UA = {'User-Agent': 'tab-render-qworld/1.0'}
def get(url):
    for k in range(4):
        try: return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120).read()
        except Exception as e: print('retry', url, e, flush=True)
    raise SystemExit('download failed ' + url)
# name: (source, id, res, tint rgb or None, tint amount)
MATS = {
 'floor':   ('ph', 'wood_floor', '2k', None, 0),
 'wall':    ('ph', 'painted_plaster_wall', '2k', (0.80, 0.76, 0.92), 0.85),
 'desk':    ('ph', 'natural_walnut_veneer', '2k', None, 0),
 'shelf':   ('ph', 'oak_veneer_01', '1k', None, 0),
 'bedframe':('ph', 'poly_wool_herringbone', '2k', (0.55, 0.50, 0.78), 0.9),
 'duvet':   ('ph', 'waffle_pique_cotton', '2k', (0.56, 0.44, 0.80), 0.9),
 'mattress':('ph', 'quatrefoil_jacquard_fabric', '2k', (0.80, 0.78, 0.86), 0.85),
 'piping':  ('ph', 'cotton_jersey', '1k', (0.45, 0.36, 0.70), 0.9),
 'plush':   ('ph', 'velour_velvet', '2k', (0.98, 0.62, 0.82), 0.9),
 'plush2':  ('ph', 'velour_velvet', '2k', (0.58, 0.82, 0.98), 0.9),
 'leather': ('ph', 'fabric_leather_02', '2k', (0.16, 0.15, 0.20), 0.95),
 'leather2':('ph', 'fabric_leather_02', '2k', (0.70, 0.45, 0.98), 0.9),
 'rug':     ('ph', 'curly_teddy_natural', '2k', (0.56, 0.40, 0.76), 0.85),
 'rugedge': ('ph', 'ribbed_corduroy', '1k', (0.38, 0.27, 0.62), 0.9),
 'ceramic': ('acg', 'Plastic010', '1K', (0.96, 0.90, 0.95), 1.0),
 'pages':   ('ph', 'cotton_jersey', '1k', (0.93, 0.89, 0.80), 0.95),
 'deskmat': ('acg', 'Fabric026', '1K', (0.12, 0.10, 0.18), 0.95),
 'plastic': ('acg', 'Plastic010', '1K', (0.93, 0.93, 0.95), 1.0),
 'plasticdk':('acg','Plastic010', '1K', (0.07, 0.07, 0.09), 1.0),
 'curtain': ('ph', 'denim_fabric_03', '2k', (0.42, 0.40, 0.66), 0.9),
}
credits = []
cache = {}
def fetch_set(src, aid, res):
    key = (src, aid, res)
    if key in cache: return cache[key]
    out = {}
    if src == 'ph':
        info = json.loads(get('https://api.polyhaven.com/files/' + aid))
        for k, names in (('diff', ['Diffuse', 'diff']), ('nor', ['nor_gl']), ('rough', ['Rough', 'rough'])):
            for n in names:
                if n in info and res in info[n]:
                    out[k] = get(info[n][res]['jpg']['url']); break
        meta = json.loads(get('https://api.polyhaven.com/info/' + aid))
        credits.append({'asset': aid, 'source': 'Poly Haven', 'url': 'https://polyhaven.com/a/' + aid, 'license': 'CC0 1.0',
                        'authors': list((meta.get('authors') or {}).keys()), 'resolution': res})
    else:
        z = zipfile.ZipFile(io.BytesIO(get(f'https://ambientcg.com/get?file={aid}_{res}-JPG.zip')))
        for n in z.namelist():
            l = n.lower()
            if l.endswith('_color.jpg'): out['diff'] = z.read(n)
            elif l.endswith('_normalgl.jpg'): out['nor'] = z.read(n)
            elif l.endswith('_roughness.jpg'): out['rough'] = z.read(n)
        credits.append({'asset': aid, 'source': 'ambientCG', 'url': 'https://ambientcg.com/view?id=' + aid, 'license': 'CC0 1.0',
                        'authors': ['Lennart Demes (ambientCG)'], 'resolution': res})
    cache[key] = out
    print('fetched', src, aid, res, sorted(out), flush=True)
    return out
def tint(img, rgb, amt):
    a = np.asarray(img.convert('RGB')).astype(np.float32) / 255.0
    lin = a ** 2.2
    lum = (lin * [0.2126, 0.7152, 0.0722]).sum(-1, keepdims=True)
    mean = max(float(lum.mean()), 1e-3)
    t = np.array(rgb, np.float32) ** 2.2
    tinted = (lum / mean) * t                       # keep the texture's detail, move its average to the tint
    out = lin * (1 - amt) + tinted * amt
    return Image.fromarray((np.clip(out, 0, 1) ** (1 / 2.2) * 255 + 0.5).astype(np.uint8))
for name, (src, aid, res, rgb, amt) in MATS.items():
    s = fetch_set(src, aid, res)
    d = os.path.join(T, name); os.makedirs(d, exist_ok=True)
    img = Image.open(io.BytesIO(s['diff']))
    if rgb: img = tint(img, rgb, amt)
    img.convert('RGB').save(os.path.join(d, 'diff.jpg'), quality=93)
    open(os.path.join(d, 'nor.jpg'), 'wb').write(s['nor'])
    if 'rough' in s: open(os.path.join(d, 'rough.jpg'), 'wb').write(s['rough'])
    else: Image.new('L', img.size, 160).save(os.path.join(d, 'rough.jpg'))
# --- night sky behind the window (generated) ---
W, H = 2048, 1024
y = np.linspace(0, 1, H)[:, None]
top = np.array([0.02, 0.025, 0.08]); mid = np.array([0.10, 0.08, 0.28]); hor = np.array([0.45, 0.28, 0.55])
c = np.where(y < 0.6, top + (mid - top) * (y / 0.6), mid + (hor - mid) * ((y - 0.6) / 0.4))
col = np.repeat(c[:, None, :], W, axis=1).copy()
rng = np.random.default_rng(7)
for _ in range(900):
    sx, sy = rng.integers(0, W), rng.integers(0, int(H * 0.7)); b = rng.uniform(0.3, 1.0)
    col[sy, sx] = np.maximum(col[sy, sx], b)
yy, xx = np.mgrid[0:H, 0:W]
d = np.sqrt((xx - W * 0.72) ** 2 + (yy - H * 0.22) ** 2)
col += (np.clip(1 - d / 70, 0, 1) ** 0.5)[..., None] * np.array([1.0, 0.97, 0.9]) * 1.2      # moon
col += (np.exp(-d / 260))[..., None] * np.array([0.25, 0.28, 0.45])                       # moon halo
# soft distant hills
hill = H * 0.86 - 40 * np.sin(np.linspace(0, 7, W)) - 25 * np.sin(np.linspace(0, 19, W) + 1)
col[yy > hill[None, :]] = col[yy > hill[None, :]] * 0.18 + np.array([0.02, 0.02, 0.05])
Image.fromarray((np.clip(col, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6)).save(os.path.join(T, 'sky.jpg'), quality=92)
# --- monitor screens (generated, cozy game + chat look) ---
def screen(path, hue):
    w, h = 1280, 720
    im = Image.new('RGB', (w, h)); dr = ImageDraw.Draw(im)
    for i in range(h):
        t = i / h
        c = tuple(int(255 * v) for v in ((0.10 + 0.25 * t) * hue[0], (0.06 + 0.2 * t) * hue[1], (0.25 + 0.3 * t) * hue[2]))
        dr.line([(0, i), (w, i)], fill=c)
    for k in range(5):  # rounded glass panels
        x0 = 60 + k * 240; dr.rounded_rectangle([x0, 470, x0 + 200, 650], 24, fill=(40, 30, 80), outline=(180, 140, 255), width=3)
        dr.rounded_rectangle([x0 + 20, 500, x0 + 180, 560], 14, fill=(255, 120, 200) if k % 2 else (90, 200, 255))
    dr.rounded_rectangle([60, 60, w - 60, 420], 32, outline=(200, 170, 255), width=4)
    for k in range(9):
        dr.ellipse([120 + k * 120, 200 + 40 * math.sin(k), 180 + k * 120, 260 + 40 * math.sin(k)], fill=(255, 210, 120) if k % 3 == 0 else (120, 230, 255))
    im.filter(ImageFilter.GaussianBlur(1)).save(path, quality=92)
screen(os.path.join(T, 'screen1.jpg'), (1.0, 1.0, 1.0))
screen(os.path.join(T, 'screen2.jpg'), (0.8, 1.1, 1.2))
Image.new('RGB', (8, 8), (255, 255, 255)).save(os.path.join(T, 'white.png'))

# --- ready-made CC0 models from Poly Haven (glTF, 1k textures) + a daytime HDRI for the window view ---
MODELS = ['throw_pillows_01', 'desk_lamp_arm_01', 'potted_plant_04', 'wooden_display_shelves_01', 'alarm_clock_01', 'rubber_duck_toy',
          'potted_plant_02', 'book_encyclopedia_set_01']
for mid in MODELS:
    try:
        info = json.loads(get('https://api.polyhaven.com/files/' + mid))['gltf']
        res = '1k' if '1k' in info else sorted(info)[0]
        g = info[res]['gltf']; d = os.path.join(T, 'models', mid); os.makedirs(d, exist_ok=True)
        open(os.path.join(d, os.path.basename(g['url'].split('?')[0])), 'wb').write(get(g['url']))
        for rel, v in (g.get('include') or {}).items():
            dst = os.path.join(d, rel); os.makedirs(os.path.dirname(dst), exist_ok=True); open(dst, 'wb').write(get(v['url']))
        meta = json.loads(get('https://api.polyhaven.com/info/' + mid))
        credits.append({'asset': mid, 'kind': 'model', 'source': 'Poly Haven', 'url': 'https://polyhaven.com/a/' + mid, 'license': 'CC0 1.0',
                        'authors': list((meta.get('authors') or {}).keys()), 'resolution': res, 'polycount': meta.get('polycount')})
        print('model', mid, res, flush=True)
    except BaseException as e:
        print('MODEL FAILED', mid, repr(e)[:200], flush=True)
try:
    hid = 'kloofendal_48d_partly_cloudy_puresky'
    h = json.loads(get('https://api.polyhaven.com/files/' + hid))['hdri']['2k']['hdr']['url']
    open(os.path.join(T, 'day.hdr'), 'wb').write(get(h))
    meta = json.loads(get('https://api.polyhaven.com/info/' + hid))
    credits.append({'asset': hid, 'kind': 'hdri', 'source': 'Poly Haven', 'url': 'https://polyhaven.com/a/' + hid, 'license': 'CC0 1.0',
                    'authors': list((meta.get('authors') or {}).keys()), 'resolution': '2k'})
except BaseException as e:
    print('HDRI FAILED', repr(e)[:200], flush=True)
try:
    hid = 'meadow_2'      # window view: trees + soft sky (used only for the exterior backdrop image, not to light the room)
    h = json.loads(get('https://api.polyhaven.com/files/' + hid))['hdri']['2k']['hdr']['url']
    open(os.path.join(T, 'ext.hdr'), 'wb').write(get(h))
    meta = json.loads(get('https://api.polyhaven.com/info/' + hid))
    credits.append({'asset': hid, 'kind': 'hdri', 'source': 'Poly Haven', 'url': 'https://polyhaven.com/a/' + hid, 'license': 'CC0 1.0',
                    'authors': list((meta.get('authors') or {}).keys()), 'resolution': '2k', 'use': 'window exterior'})
except BaseException as e:
    print('EXT HDRI FAILED', repr(e)[:200], flush=True)
json.dump(credits, open(os.path.join(T, 'credits.json'), 'w'), indent=1)
print('ok', len(credits), 'texture sets')
