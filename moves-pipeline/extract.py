
import os, sys, json, subprocess, time
os.environ['MPLBACKEND']='Agg'
os.environ.setdefault('GLOG_minloglevel','2')
import numpy as np, cv2
import mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
# usage: extract.py ID URL [start end] [model]
cid, url = sys.argv[1], sys.argv[2]
start = float(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] != '-' else None
end = float(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] != '-' else None
model = sys.argv[5] if len(sys.argv) > 5 else 'heavy'
FPS = 15.0
D = os.environ.get('MOVES_DIR', os.path.dirname(os.path.abspath(__file__))); os.makedirs(D + '/tmp', exist_ok=True); os.makedirs(D + '/raw', exist_ok=True)
vid = f'{D}/tmp/{cid}.mp4'
if not os.path.exists(vid):
    cmd = ['yt-dlp', '-q', '--no-warnings', '-f', 'bv*[height<=480][ext=mp4]/bv*[height<=480]/b[height<=480]/b', '--merge-output-format', 'mp4', '-o', vid, '--write-info-json', '--no-playlist']
    if start is not None: cmd += ['--download-sections', f'*{start}-{end}', '--force-keyframes-at-cuts']
    subprocess.run(cmd + [url], check=True, timeout=300)
info = {}
ij = vid[:-4] + '.info.json'
if os.path.exists(ij):
    j = json.load(open(ij)); info = {k: j.get(k) for k in ['id', 'title', 'uploader', 'channel', 'webpage_url', 'duration', 'license']}
    os.remove(ij)
cap = cv2.VideoCapture(vid)
src_fps = cap.get(cv2.CAP_PROP_FPS) or 30
opts = vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=f'{D}/pose_{model}.task'), running_mode=vision.RunningMode.VIDEO, num_poses=1,
                                    min_pose_detection_confidence=0.5, min_tracking_confidence=0.5)
lm = vision.PoseLandmarker.create_from_options(opts)
W, Wv, N2, T = [], [], [], []
i = 0; nxt = 0.0; t0 = time.time()
while True:
    ok, fr = cap.read()
    if not ok: break
    ts = i / src_fps; i += 1
    if ts + 1e-6 < nxt: continue
    nxt += 1 / FPS
    h, w = fr.shape[:2]
    if h > 480: fr = cv2.resize(fr, (int(w * 480 / h), 480))
    img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(fr, cv2.COLOR_BGR2RGB))
    r = lm.detect_for_video(img, int(ts * 1000))
    T.append(ts)
    if r.pose_world_landmarks:
        W.append([[p.x, p.y, p.z] for p in r.pose_world_landmarks[0]])
        Wv.append([p.visibility for p in r.pose_landmarks[0]])
        N2.append([[p.x, p.y] for p in r.pose_landmarks[0]])
    else:
        W.append([[np.nan] * 3] * 33); Wv.append([0] * 33); N2.append([[np.nan] * 2] * 33)
lm.close(); cap.release()
np.savez_compressed(f'{D}/raw/{cid}.npz', world=np.array(W, np.float32), vis=np.array(Wv, np.float32), norm=np.array(N2, np.float32), t=np.array(T), info=json.dumps({**info, 'url': url, 'start': start, 'end': end, 'aspect': w / h}))
os.remove(vid)
print(json.dumps({'id': cid, 'frames': len(T), 'detected': int(sum(1 for v in Wv if max(v) > 0)), 'secs': round(time.time() - t0, 1), 'title': info.get('title')}))
