
# Jena's whole-body tracker (body + fingers + face), the step after extract.py for every move she learns.
#   holistic.py ID SRC [start end] [pose_model]     SRC = a video URL (yt-dlp) or a local file
# Writes raw/ID.npz with everything extract.py writes (so retarget.py still works) plus 21 points per hand,
# 478 face points + 52 face blendshapes, and a `meta` record of HOW it was tracked:
#  * lighting: mean luma; if the picture is dark or the body confidence is low it retries a sample of frames
#    with CLAHE + gamma, then with inverted colours, and keeps whichever pass the body tracker trusted most.
#  * mirror: a mirrored (selfie / "MIRRORED" tutorial) video shows the dancer's right hand on the right of
#    the screen. A body alone can't prove that (a mirrored person is still a valid person), so it reads
#    the frames' text both ways round (reversed writing = mirrored) and the title ("mirrored"), and if the
#    video is mirrored it un-mirrors every frame BEFORE tracking. Left/right are then always the PERFORMER's
#    own left/right, which map onto Jena's left/right (never mirrored).
# Also writes tmp/ID-track.mp4: the frames the tracker saw with body, hand and face points drawn on (Tab Live).
# CPU: run under nice 19 with at most 2 threads (taskset); one job at a time.
import os, sys, json, subprocess, time, re, shutil
os.environ['MPLBACKEND'] = 'Agg'
os.environ.setdefault('GLOG_minloglevel', '2')
import numpy as np, cv2
cv2.setNumThreads(1)
import mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions

cid, src = sys.argv[1], sys.argv[2]
start = float(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] != '-' else None
end = float(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] != '-' else None
model = sys.argv[5] if len(sys.argv) > 5 else 'full'
FPS = float(os.environ.get('TRACK_FPS', '15'))
D = os.environ.get('MOVES_DIR', os.path.dirname(os.path.abspath(__file__)))
MODELS = os.environ.get('TRACK_MODELS', D)
os.makedirs(D + '/tmp', exist_ok=True); os.makedirs(D + '/raw', exist_ok=True)
DARK_LUMA = float(os.environ.get('TRACK_DARK_LUMA', '70'))
LOW_CONF = float(os.environ.get('TRACK_LOW_CONF', '0.6'))
t_start = time.time()

def task(name):
    for p in (f'{MODELS}/{name}', f'{D}/{name}', f'/home/user/tab/files/jena-learn/{name}'):
        if os.path.exists(p): return p
    raise SystemExit(f'missing model {name}')

# ---------- source ----------
info = {}
if os.path.exists(src):
    vid = src; own = False
    if src.endswith('.mp4') and os.path.exists(src[:-4] + '.info.json'):
        j = json.load(open(src[:-4] + '.info.json')); info = {k: j.get(k) for k in ['id', 'title', 'uploader', 'channel', 'webpage_url', 'duration', 'license', 'description']}
else:
    own = True
    vid = f'{D}/tmp/{cid}.mp4'
    if not os.path.exists(vid):
        cmd = ['yt-dlp', '-q', '--no-warnings', '-f', 'bv*[height<=480][ext=mp4]/bv*[height<=480]/b[height<=480]/b', '--merge-output-format', 'mp4', '-o', vid, '--write-info-json', '--no-playlist']
        if start is not None: cmd += ['--download-sections', f'*{start}-{end}', '--force-keyframes-at-cuts']
        subprocess.run(cmd + [src], check=True, timeout=300)
    ij = vid[:-4] + '.info.json'
    if os.path.exists(ij):
        j = json.load(open(ij)); info = {k: j.get(k) for k in ['id', 'title', 'uploader', 'channel', 'webpage_url', 'duration', 'license', 'description']}
        os.remove(ij)
local_cut = (start, end) if (not own and start is not None) else (None, None)

def frames(step_fps=FPS, limit=None):
    """yields (ts, bgr<=480p) sampled at step_fps (relative to the clip)"""
    cap = cv2.VideoCapture(vid); sf = cap.get(cv2.CAP_PROP_FPS) or 30
    i = 0; nxt = 0.0; n = 0
    a, b = local_cut
    if a is not None: cap.set(cv2.CAP_PROP_POS_MSEC, a * 1000); i = int(a * sf)
    while True:
        ok, fr = cap.read()
        if not ok: break
        ts = i / sf - (a or 0); i += 1
        if b is not None and ts + (a or 0) > b: break
        if ts + 1e-6 < nxt: continue
        nxt += 1 / step_fps
        h, w = fr.shape[:2]
        if h > 480: fr = cv2.resize(fr, (int(w * 480 / h), 480), interpolation=cv2.INTER_AREA)
        yield ts, fr
        n += 1
        if limit and n >= limit: break
    cap.release()

allf = [(t, f) for t, f in frames(2.0)]          # ~2 fps sample for lighting + mirror checks
dur = allf[-1][0] if allf else 0
sample = allf[:: max(1, len(allf) // 10)][:10]

# ---------- lighting ----------
def luma(f): return float(cv2.cvtColor(f, cv2.COLOR_BGR2YCrCb)[..., 0].mean())
_clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
def clahe_gamma(f):
    lab = cv2.cvtColor(f, cv2.COLOR_BGR2LAB); l = _clahe.apply(lab[..., 0])
    m = max(1.0, float(l.mean())); g = float(np.clip(np.log(0.5) / np.log(m / 255.0), 0.35, 1.0))  # brighten toward mid-grey
    lut = np.clip(((np.arange(256) / 255.0) ** g) * 255, 0, 255).astype(np.uint8)
    lab[..., 0] = cv2.LUT(l, lut); return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
def invert(f): return 255 - f
VARIANTS = {'normal': lambda f: f, 'clahe_gamma': clahe_gamma, 'inverted': invert}

pose_img = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
    base_options=BaseOptions(model_asset_path=task(f'pose_{model}.task')), running_mode=vision.RunningMode.IMAGE, num_poses=1,
    min_pose_detection_confidence=0.3, min_pose_presence_confidence=0.3))
def mpimg(f): return mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(cv2.cvtColor(f, cv2.COLOR_BGR2RGB)))
def pose_conf(fs, fn):
    sc = []
    for _, f in fs:
        r = pose_img.detect(mpimg(fn(f)))
        sc.append(float(np.mean([p.visibility for p in r.pose_landmarks[0]])) if r.pose_landmarks else 0.0)
    return round(float(np.mean(sc)) if sc else 0.0, 3)
L0 = round(float(np.mean([luma(f) for _, f in sample])) if sample else 0, 1)
tried = {'normal': pose_conf(sample, VARIANTS['normal'])}
reason = None
if L0 < DARK_LUMA or tried['normal'] < LOW_CONF or os.environ.get('TRACK_FORCE_LOWLIGHT'):
    reason = f'mean luma {L0} < {DARK_LUMA}' if L0 < DARK_LUMA else f'body confidence {tried["normal"]} < {LOW_CONF}' if tried['normal'] < LOW_CONF else 'forced'
    tried['clahe_gamma'] = pose_conf(sample, VARIANTS['clahe_gamma'])
    tried['inverted'] = pose_conf(sample, VARIANTS['inverted'])
used = max(tried, key=lambda k: (tried[k], k == 'normal'))
xf = VARIANTS[used]
lighting = {'luma': L0, 'dark_threshold': DARK_LUMA, 'retry_reason': reason, 'tried': tried, 'used': used}

# ---------- mirror ----------
def ocr_words(img):
    try:
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY); g = cv2.resize(g, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        p = subprocess.run(['tesseract', 'stdin', 'stdout', '--psm', '11', '-l', 'eng', 'tsv'], input=cv2.imencode('.png', g)[1].tobytes(), capture_output=True, timeout=40)
        words = []
        for line in p.stdout.decode('utf8', 'ignore').splitlines()[1:]:
            c = line.split('\t')
            if len(c) >= 12 and c[11].strip() and float(c[10]) >= 75 and re.fullmatch(r'[A-Za-z]{3,}', c[11].strip()) and re.search(r'[aeiouAEIOU]', c[11]): words.append(c[11].strip())
        return words
    except Exception: return []
title = ' '.join(str(info.get(k) or '') for k in ('title', 'description'))[:3000]
fwd, bwd = [], []
if shutil.which('tesseract'):
    for _, f in allf[:: max(1, len(allf) // 4)][:4]:
        fwd += ocr_words(f); bwd += ocr_words(cv2.flip(f, 1))
mirrored, why = False, 'no reversed writing seen and the title does not say mirrored'
if len(bwd) >= 3 and len(bwd) >= 2 * max(1, len(fwd)):
    mirrored, why = True, f'writing in the video reads correctly only when flipped ({len(bwd)} words flipped vs {len(fwd)} as-is, e.g. {", ".join(bwd[:4])})'
elif re.search(r'\bmirror(ed)?\b', title, re.I) and not re.search(r'\b(non|not|un)[- ]?mirror', title, re.I) and len(fwd) < 3:
    mirrored, why = True, 'the video says it is mirrored (title/description) and no forward writing contradicts it'
elif len(fwd) >= 3:
    why = f'writing reads correctly as-is ({len(fwd)} words, e.g. {", ".join(fwd[:4])}), so not mirrored'
mirror = {'mirrored': mirrored, 'why': why, 'ocr_words_as_is': len(fwd), 'ocr_words_flipped': len(bwd), 'corrected': mirrored,
          'sides': "performer's own left/right (MediaPipe labels; Jena applies left->left)"}
del allf

# ---------- main pass: body (VIDEO mode) + hands + face on crops ----------
pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
    base_options=BaseOptions(model_asset_path=task(f'pose_{model}.task')), running_mode=vision.RunningMode.VIDEO, num_poses=1,
    min_pose_detection_confidence=0.4, min_tracking_confidence=0.4))
hands = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
    base_options=BaseOptions(model_asset_path=task('hand_landmarker.task')), running_mode=vision.RunningMode.IMAGE, num_hands=1,
    min_hand_detection_confidence=0.35, min_hand_presence_confidence=0.35))
face = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
    base_options=BaseOptions(model_asset_path=task('face_landmarker.task')), running_mode=vision.RunningMode.IMAGE, num_faces=1,
    output_face_blendshapes=True, min_face_detection_confidence=0.35, min_face_presence_confidence=0.35))
BS_NAMES = None
# named body segments (performer's own sides) -> the tracked points that make them up, and a colour each (BGR)
SEGMENTS = {
    'head': ([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], (255, 255, 255)), 'neck': ([9, 10, 11, 12], (200, 200, 200)),
    'shoulders': ([11, 12], (0, 215, 255)), 'chest': ([11, 12, 23, 24], (60, 180, 255)), 'hips': ([23, 24], (255, 120, 200)),
    'left upper arm': ([11, 13], (60, 220, 60)), 'left lower arm': ([13, 15], (120, 255, 120)), 'left hand': ([15, 17, 19, 21], (180, 255, 180)),
    'right upper arm': ([12, 14], (40, 120, 255)), 'right lower arm': ([14, 16], (80, 160, 255)), 'right hand': ([16, 18, 20, 22], (140, 200, 255)),
    'left upper leg': ([23, 25], (0, 160, 0)), 'left lower leg': ([25, 27], (60, 200, 60)), 'left foot': ([27, 29, 31], (140, 240, 140)),
    'right upper leg': ([24, 26], (0, 80, 220)), 'right lower leg': ([26, 28], (40, 120, 240)), 'right foot': ([28, 30, 32], (110, 170, 255)),
}
SEG_SHORT = {'head': 'head', 'neck': 'neck', 'shoulders': 'shldr', 'chest': 'chest', 'hips': 'hips', 'left upper arm': 'L up arm', 'left lower arm': 'L forearm',
             'left hand': 'L hand', 'right upper arm': 'R up arm', 'right lower arm': 'R forearm', 'right hand': 'R hand', 'left upper leg': 'L thigh',
             'left lower leg': 'L shin', 'left foot': 'L foot', 'right upper leg': 'R thigh', 'right lower leg': 'R shin', 'right foot': 'R foot'}
# objects in the scene: a tiny COCO detector (EfficientDet-Lite0 int8, 4.6 MB), 1 frame per second. ON DEMAND only
# (TRACK_OBJECTS=1, or ask her: tag_objects.py tags one frame); off by default so a tracking pass stays light
objdet = None
try:
    if os.environ.get('TRACK_OBJECTS') != '1': raise SystemExit
    objdet = vision.ObjectDetector.create_from_options(vision.ObjectDetectorOptions(
        base_options=BaseOptions(model_asset_path=task('efficientdet_lite0.tflite')), running_mode=vision.RunningMode.IMAGE, max_results=6, score_threshold=0.35))
except SystemExit: objdet = None
OBJ = []; obj_seen = {}; last_obj_t = -9
W, Wv, N2, T = [], [], [], []
HW = []; HN = []; HS = []; FB = []; FN = []; FS = []
PREV = (480, 854)
def crop(fr, cx, cy, size, out):
    h, w = fr.shape[:2]; s = max(24, int(size)); x0, y0 = int(cx - s / 2), int(cy - s / 2)
    pad = cv2.copyMakeBorder(fr, s, s, s, s, cv2.BORDER_CONSTANT, value=0)
    c = pad[y0 + s:y0 + 2 * s, x0 + s:x0 + 2 * s]
    if c.size == 0: return None, None
    c = cv2.resize(c, (out, out), interpolation=cv2.INTER_LINEAR)
    if luma(c) < 90: c = clahe_gamma(c)   # dark hands/faces get the low-light fix on their own crop too
    return c, (x0, y0, s)
# overlay video (what the tracker saw, with its points), 360p, written through ffmpeg
ov_path = f'{D}/tmp/{cid}-track.mp4'; ov = None
BONES = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24), (23, 25), (25, 27), (24, 26), (26, 28), (27, 31), (28, 32), (27, 29), (28, 30), (0, 2), (0, 5), (2, 7), (5, 8)]
HB = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11), (11, 12), (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (0, 17), (17, 18), (18, 19), (19, 20)]
FACE_DRAW = list(range(0, 478, 3))
def _avail():
    return int(next(l.split()[1] for l in open('/proc/meminfo') if l.startswith('MemAvailable'))) // 1024
nf = 0
for ts, fr in frames():
    nf += 1
    if nf % 15 == 0:   # the box is tight on memory: if it runs low mid-clip, wait (her chat brain comes first)
        waited = 0
        while _avail() < 350 and waited < 600: time.sleep(5); waited += 5
    if mirrored: fr = cv2.flip(fr, 1)
    fr = xf(fr)
    h, w = fr.shape[:2]
    r = pose.detect_for_video(mpimg(fr), int(ts * 1000))
    T.append(ts)
    if objdet is not None and ts - last_obj_t >= 1.0:
        last_obj_t = ts
        det = objdet.detect(mpimg(fr)); cur = []
        for dd in det.detections:
            cat = dd.categories[0]; bb = dd.bounding_box
            cur.append({'label': cat.category_name, 'score': round(cat.score, 2), 'box': [round(bb.origin_x / w, 3), round(bb.origin_y / h, 3), round(bb.width / w, 3), round(bb.height / h, 3)]})
            obj_seen[cat.category_name] = obj_seen.get(cat.category_name, 0) + 1
        OBJ.append({'t': round(ts, 2), 'objects': cur})
    hw = np.full((2, 21, 3), np.nan, np.float32); hn = np.full((2, 21, 2), np.nan, np.float32); hs = np.zeros(2, np.float32)
    fb = np.full(52, np.nan, np.float32); fn = np.full((478, 2), np.nan, np.float32); fsc = 0.0
    if r.pose_world_landmarks:
        lm = r.pose_landmarks[0]
        W.append([[p.x, p.y, p.z] for p in r.pose_world_landmarks[0]]); Wv.append([p.visibility for p in lm]); N2.append([[p.x, p.y] for p in lm])
        P = np.array([[p.x * w, p.y * h] for p in lm]); V = np.array([p.visibility for p in lm])
        # hands: a crop around each wrist, pointed along the forearm (side comes from the body, not a guess)
        for k, (E, Wr, I, Pk) in enumerate([(13, 15, 19, 17), (14, 16, 20, 18)]):   # 0 = performer's left, 1 = right
            if V[Wr] < 0.25: continue
            fore = np.linalg.norm(P[Wr] - P[E]); d = (P[I] + P[Pk]) / 2 - P[Wr]
            size = max(40.0, 1.15 * fore, 3.2 * np.linalg.norm(d)); c = P[Wr] + d * 0.9
            img, box = crop(fr, c[0], c[1], size, 224)
            if img is None: continue
            hr = hands.detect(mpimg(img))
            if hr.hand_landmarks:
                x0, y0, s = box
                pts = np.array([[q.x * s + x0, q.y * s + y0] for q in hr.hand_landmarks[0]])
                if np.linalg.norm(pts[0] - P[Wr]) > 0.6 * size: continue   # that hand belongs to someone/something else
                hw[k] = [[q.x, q.y, q.z] for q in hr.hand_world_landmarks[0]]; hn[k] = pts / [w, h]
                hs[k] = hr.handedness[0][0].score if hr.handedness else 0.5
        # face: a crop around the head (ears + nose from the body)
        ew = np.linalg.norm(P[7] - P[8]); fsz = max(48.0, 2.4 * ew, 3.0 * np.linalg.norm(P[2] - P[5]))
        if V[0] > 0.4:
            c = (P[0] * 2 + (P[7] + P[8]) / 2) / 3
            img, box = crop(fr, c[0], c[1], fsz, 256)
            if img is not None:
                fr_ = face.detect(mpimg(img))
                if fr_.face_landmarks:
                    x0, y0, s = box
                    fn = (np.array([[q.x * s + x0, q.y * s + y0] for q in fr_.face_landmarks[0]]) / [w, h]).astype(np.float32)
                    if fr_.face_blendshapes:
                        BS_NAMES = BS_NAMES or [b.category_name for b in fr_.face_blendshapes[0]]
                        fb = np.array([b.score for b in fr_.face_blendshapes[0]], np.float32)
                    fsc = 1.0
    else:
        W.append([[np.nan] * 3] * 33); Wv.append([0] * 33); N2.append([[np.nan] * 2] * 33)
    HW.append(hw); HN.append(hn); HS.append(hs); FB.append(fb); FN.append(fn); FS.append(fsc)
    # overlay frame
    sc = 360 / h; vw = int(w * sc) // 2 * 2
    im = cv2.resize(fr, (vw, 360))
    if OBJ:
        for o in OBJ[-1]['objects']:
            if o['label'] == 'person': continue
            x, y, bw, bh = o['box']; p0 = (int(x * vw), int(y * 360)); p1 = (int((x + bw) * vw), int((y + bh) * 360))
            cv2.rectangle(im, p0, p1, (0, 0, 255), 1); cv2.putText(im, f"{o['label']} {int(o['score'] * 100)}%", (p0[0] + 2, max(10, p0[1] - 3)), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 0, 255), 1, cv2.LINE_AA)
    if r.pose_landmarks:
        Pp = np.array(N2[-1]) * [vw, 360]
        for name, (ids, col) in SEGMENTS.items():   # a colour-coded box per body part, labelled
            ok_ = [i for i in ids if Wv[-1][i] > 0.4]
            if len(ok_) < max(1, len(ids) // 2): continue
            pts_ = Pp[ok_]; pad = 6 if name not in ('head',) else 8
            x0, y0 = pts_.min(0) - pad; x1, y1 = pts_.max(0) + pad
            ov_ = im.copy(); cv2.rectangle(ov_, (int(x0), int(y0)), (int(x1), int(y1)), col, -1); cv2.addWeighted(ov_, 0.12, im, 0.88, 0, im)
            cv2.rectangle(im, (int(x0), int(y0)), (int(x1), int(y1)), col, 1)
            lab = SEG_SHORT[name]; (tw, th), _ = cv2.getTextSize(lab, cv2.FONT_HERSHEY_SIMPLEX, 0.36, 1)
            lx, ly = int(max(0, x0)), int(max(th + 3, y0))
            cv2.rectangle(im, (lx, ly - th - 3), (lx + tw + 4, ly), (20, 20, 20), -1)
            cv2.putText(im, lab, (lx + 2, ly - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.36, col, 1, cv2.LINE_AA)
        for a, b in BONES:
            if Wv[-1][a] > 0.3 and Wv[-1][b] > 0.3: cv2.line(im, tuple(Pp[a].astype(int)), tuple(Pp[b].astype(int)), (0, 220, 255), 2, cv2.LINE_AA)
        for k, col in ((0, (80, 255, 120)), (1, (255, 140, 60))):
            if np.isfinite(hn[k][0, 0]):
                Q = hn[k] * [vw, 360]
                for a, b in HB: cv2.line(im, tuple(Q[a].astype(int)), tuple(Q[b].astype(int)), col, 1, cv2.LINE_AA)
        if fsc:
            for q in (fn[FACE_DRAW] * [vw, 360]).astype(int): cv2.circle(im, tuple(q), 1, (255, 255, 255), -1)
    cv2.putText(im, f'light: {used}{" (mirror fixed)" if mirrored else ""}', (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(im, f'light: {used}{" (mirror fixed)" if mirrored else ""}', (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.putText(im, 'L = her left (green hand)   R (orange)', (8, 352), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1, cv2.LINE_AA)
    if ov is None:
        ov = subprocess.Popen(['nice', '-n', '19', 'ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{vw}x360', '-r', str(FPS), '-i', '-',
                               '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-threads', '1', '-movflags', '+faststart', ov_path], stdin=subprocess.PIPE)
    ov.stdin.write(im.tobytes())
pose.close(); hands.close(); face.close(); pose_img.close()
if objdet is not None: objdet.close()
if ov: ov.stdin.close(); ov.wait()
HS = np.array(HS); FS = np.array(FS)
meta = {'lighting': lighting, 'mirror': mirror, 'fps': FPS, 'frames': len(T),
        'detected': {'body': round(float(np.mean([max(v) > 0 for v in Wv])) if Wv else 0, 3),
                     'left_hand': round(float(np.mean(np.isfinite(np.array(HW)[:, 0, 0, 0]))), 3), 'right_hand': round(float(np.mean(np.isfinite(np.array(HW)[:, 1, 0, 0]))), 3),
                     'face': round(float(FS.mean()) if len(FS) else 0, 3)},
        'objects': {'seen': dict(sorted(obj_seen.items(), key=lambda kv: -kv[1])), 'per_second': OBJ, 'model': 'EfficientDet-Lite0 int8 (COCO 80 classes)'},
        'segments': {k: v[0] for k, v in SEGMENTS.items()},
        'blendshape_names': BS_NAMES, 'tracker': 'MediaPipe Pose (VIDEO) + HandLandmarker + FaceLandmarker (blendshapes) on body-guided crops, CPU'}
np.savez_compressed(f'{D}/raw/{cid}.npz', world=np.array(W, np.float32), vis=np.array(Wv, np.float32), norm=np.array(N2, np.float32), t=np.array(T),
                    hands_world=np.array(HW, np.float32), hands_norm=np.array(HN, np.float32), hands_score=HS.astype(np.float32),
                    face_bs=np.array(FB, np.float32), face_norm=np.array(FN, np.float16), face_score=FS.astype(np.float32),
                    info=json.dumps({**{k: v for k, v in info.items() if k != 'description'}, 'url': src if own else (info.get('webpage_url') or src), 'start': start, 'end': end, 'aspect': w / h}),
                    meta=json.dumps(meta))
if own and os.path.exists(vid): os.remove(vid)
print(json.dumps({'id': cid, 'frames': len(T), 'secs': round(time.time() - t_start, 1), 'title': info.get('title'), 'lighting': used, 'luma': L0, 'mirrored': mirrored, 'detected': meta['detected'], 'overlay': ov_path if ov else None}))
