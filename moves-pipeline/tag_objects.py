# On-demand object tags for Jena: one frame of a picture or a video -> what's in it (EfficientDet-Lite0 int8, COCO 80
# classes, ~5 MB, CPU, well under a second). usage: tag_objects.py <image|video> [seconds] [out.jpg]
# prints JSON {objects:[{label, score, box:[x,y,w,h] 0..1}]}; with out.jpg also draws the tagged boxes.
import json, os, sys
os.environ['MPLBACKEND'] = 'Agg'
import cv2
from mediapipe.tasks.python import BaseOptions, vision
import mediapipe as mp
D = os.environ.get('TRACK_MODELS', '/home/user/tab/files/jena-learn')
src = sys.argv[1]; t = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0; out = sys.argv[3] if len(sys.argv) > 3 else None
if src.lower().endswith(('.jpg', '.jpeg', '.png', '.webp')): fr = cv2.imread(src)
else:
    cap = cv2.VideoCapture(src); cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000); ok, fr = cap.read(); cap.release()
    if not ok: print(json.dumps({'ok': False, 'error': 'no frame at that time'})); sys.exit(1)
h, w = fr.shape[:2]
det = vision.ObjectDetector.create_from_options(vision.ObjectDetectorOptions(base_options=BaseOptions(model_asset_path=os.path.join(D, 'efficientdet_lite0.tflite')),
      running_mode=vision.RunningMode.IMAGE, max_results=8, score_threshold=0.3))
res = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(fr, cv2.COLOR_BGR2RGB)))
objs = []
for d in res.detections:
    c = d.categories[0]; b = d.bounding_box
    objs.append({'label': c.category_name, 'score': round(c.score, 2), 'box': [round(b.origin_x / w, 3), round(b.origin_y / h, 3), round(b.width / w, 3), round(b.height / h, 3)]})
    if out:
        cv2.rectangle(fr, (b.origin_x, b.origin_y), (b.origin_x + b.width, b.origin_y + b.height), (0, 0, 255), 2)
        cv2.putText(fr, f'{c.category_name} {int(c.score * 100)}%', (b.origin_x + 3, max(14, b.origin_y - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 255), 2, cv2.LINE_AA)
if out: cv2.imwrite(out, fr)
det.close()
print(json.dumps({'ok': True, 'objects': objs, 'model': 'EfficientDet-Lite0 int8 (COCO)'}))
