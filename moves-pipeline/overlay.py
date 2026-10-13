# Tracking overlay for the videos Jena learns moves from. Runs MediaPipe Pose in VIDEO mode (temporal
# tracking) on EVERY frame of the clip at the video's own frame rate (capped at 30), once, offline, and caches
# the per-frame 2D landmarks (33 points: body, hands = wrist/thumb/index/pinky, face = nose/eyes/ears/mouth)
# as a small JSON next to the clip. The site plays the real video (YouTube embed, native fps) and draws these
# landmarks over it in sync with the video's clock, so viewers see exactly what she tracked.
# usage: overlay.py ID URL START|- END|- OUT_DIR [model]
import os, sys, json, subprocess, time
os.environ.setdefault('GLOG_minloglevel', '2')
os.environ['MPLBACKEND'] = 'Agg'


# ---- smoothing (zero-phase, adaptive): a tracker shakes a pixel or two on every frame; on a 30 fps video that
# shows as a buzzing skeleton. Each joint track is filled across short dropouts (<= 5 frames, linear) and then
# smoothed with a centred Gaussian whose width follows the joint's speed (wide when it's still, narrow when it
# moves fast, so real motion isn't smeared or delayed). Centred = no lag: the overlay stays on the video's body.
def smooth_frames(frames, fps):
    import numpy as np
    n = len(frames)
    if n < 3: return frames
    have = np.array([f is not None for f in frames])
    A = np.full((n, 33, 3), np.nan)
    for i, f in enumerate(frames):
        if f is not None: A[i] = np.array(f, float).reshape(33, 3)
    # fill short gaps
    idx = np.arange(n); filled = have.copy()
    i = 0
    while i < n:
        if not have[i]:
            j = i
            while j < n and not have[j]: j += 1
            if i > 0 and j < n and j - i <= 5:
                for k in range(i, j):
                    a = (k - i + 1) / (j - i + 1); A[k] = A[i - 1] * (1 - a) + A[j] * a
                filled[i:j] = True
            i = j
        else: i += 1
    k30 = fps / 30.0
    out = A.copy()
    R = 6
    for jn in range(33):
        xy = A[:, jn, :2]
        sp = np.zeros(n)
        d = np.linalg.norm(np.diff(xy, axis=0), axis=1)  # thousandths of frame per frame
        sp[1:] = np.nan_to_num(d); sp[:-1] = np.maximum(sp[:-1], np.nan_to_num(d))
        for t in range(n):
            if not filled[t]: continue
            sig = np.interp(sp[t] / k30 if k30 else sp[t], [2, 25], [2.2, 0.6]) * k30  # still: 2.2 frames, fast: 0.6
            lo, hi = max(0, t - R), min(n, t + R + 1)
            seg = xy[lo:hi]; ok = filled[lo:hi] & ~np.isnan(seg[:, 0])
            # stay inside this run of tracked frames (don't blend across a lost stretch)
            run = np.ones(hi - lo, bool)
            for q in range(t - lo - 1, -1, -1):
                if not ok[q]: run[:q + 1] = False; break
            for q in range(t - lo + 1, hi - lo):
                if not ok[q]: run[q:] = False; break
            w = np.exp(-0.5 * ((np.arange(lo, hi) - t) / sig) ** 2) * run * (0.3 + A[lo:hi, jn, 2].clip(0, 9) / 9)
            w = np.nan_to_num(w)
            if w.sum() > 0: out[t, jn, :2] = (np.nan_to_num(seg) * w[:, None]).sum(0) / w.sum()
    res = []
    for t in range(n):
        if not filled[t]: res.append(None); continue
        res.append([int(round(v)) for v in out[t].reshape(-1)])
    return res


def jitter(frames):
    """RMS second difference (thousandths of the frame) over well-seen joints: the buzz you see."""
    import numpy as np
    acc = []
    for a, b, c in zip(frames, frames[1:], frames[2:]):
        if a is None or b is None or c is None: continue
        A, B, C = (np.array(x, float).reshape(33, 3) for x in (a, b, c))
        m = (A[:, 2] >= 6) & (B[:, 2] >= 6) & (C[:, 2] >= 6)
        if m.any(): acc.append(np.linalg.norm((A[m, :2] - 2 * B[m, :2] + C[m, :2]), axis=1))
    return float(np.sqrt(np.mean(np.concatenate(acc) ** 2))) if acc else 0.0

if len(sys.argv) > 2 and sys.argv[1] == '--resmooth':  # overlay.py --resmooth FILE... : re-smooth cached raw tracks, no re-tracking
    for f in sys.argv[2:]:
        d = json.load(open(f))
        if d.get('smoothed'): print(json.dumps({'file': os.path.basename(f), 'skip': 'already smoothed'})); continue
        raw = d['lm']; d['lm'] = smooth_frames(raw, d['fps']); d['smoothed'] = 'adaptive centred Gaussian, zero lag, gaps <= 5 frames filled'
        d['jitter'] = {'raw': round(jitter(raw), 2), 'smoothed': round(jitter(d['lm']), 2)}
        json.dump(d, open(f, 'w'), separators=(',', ':')); print(json.dumps({'file': os.path.basename(f), **d['jitter']}))
    sys.exit(0)
import cv2
import mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
cid, url = sys.argv[1], sys.argv[2]
start = float(sys.argv[3]) if sys.argv[3] != '-' else None
end = float(sys.argv[4]) if sys.argv[4] != '-' else None
out_dir = sys.argv[5]
model = sys.argv[6] if len(sys.argv) > 6 else os.environ.get('POSE_TASK', '/home/user/tab/files/jena-learn/pose_full.task')
MAX_FPS = 30.0
tmp = f'/tmp/jena-overlay-{cid}.mp4'
if not os.path.exists(tmp):
    cmd = ['yt-dlp', '-q', '--no-warnings', '-f', 'bv*[height<=480][ext=mp4]/bv*[height<=480]/b[height<=480]/b', '--merge-output-format', 'mp4', '-o', tmp, '--no-playlist']
    if start is not None: cmd += ['--download-sections', f'*{start}-{end}', '--force-keyframes-at-cuts']
    subprocess.run(cmd + [url], check=True, timeout=300)
cap = cv2.VideoCapture(tmp)
src_fps = cap.get(cv2.CAP_PROP_FPS) or 30
step = max(1, round(src_fps / MAX_FPS))  # 60 fps sources -> every 2nd frame (30 Hz); 24-30 fps -> every frame
opts = vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=model), running_mode=vision.RunningMode.VIDEO, num_poses=1,
                                    min_pose_detection_confidence=0.5, min_pose_presence_confidence=0.5, min_tracking_confidence=0.5)
lm = vision.PoseLandmarker.create_from_options(opts)
frames, i, t0, w, h, found = [], 0, time.time(), 0, 0, 0
while True:
    ok, fr = cap.read()
    if not ok: break
    ts = i / src_fps; keep = i % step == 0; i += 1
    if not keep: continue
    h, w = fr.shape[:2]
    if h > 480: fr = cv2.resize(fr, (int(w * 480 / h), 480))
    r = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(fr, cv2.COLOR_BGR2RGB)), int(ts * 1000))
    if r.pose_landmarks:
        found += 1
        # x,y in thousandths of the frame, visibility in tenths
        frames.append([v for p in r.pose_landmarks[0] for v in (round(p.x * 1000), round(p.y * 1000), round((p.visibility or 0) * 9))])
    else:
        frames.append(None)
lm.close(); cap.release()
os.remove(tmp)
fps = src_fps / step
os.makedirs(out_dir, exist_ok=True)
raw = frames; frames = smooth_frames(raw, fps)
res = {'id': cid, 'url': url, 'start': start or 0, 'fps': round(fps, 3), 'source_fps': round(src_fps, 3), 'frames': len(frames), 'aspect': round(w / h, 4) if h else 1.7778,
       'mode': 'MediaPipe Pose (VIDEO mode, temporal tracking)', 'model': os.path.basename(model), 'detected': round(found / max(1, len(frames)), 3),
       'clip_offset': 0.4, 'note': 'clip time 0 = video time start + clip_offset (the clip pipeline trims 0.4 s at each end)', 'lm': frames, 'smoothed': 'adaptive centred Gaussian, zero lag, gaps <= 5 frames filled', 'jitter': {'raw': round(jitter(raw), 2), 'smoothed': round(jitter(frames), 2)}}
json.dump(res, open(os.path.join(out_dir, cid + '-overlay.json'), 'w'), separators=(',', ':'))
print(json.dumps({'id': cid, 'fps': res['fps'], 'source_fps': res['source_fps'], 'frames': len(frames), 'detected': res['detected'], 'secs': round(time.time() - t0, 1)}))
