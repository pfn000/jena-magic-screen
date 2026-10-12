// Self-vision assets: MediaPipe's WASM runtime (from node_modules) and the pose model, served from this site.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
const dst = new URL('../public/mediapipe/', import.meta.url);
mkdirSync(new URL('wasm/', dst), { recursive: true });
cpSync(new URL('../node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url), new URL('wasm/', dst), { recursive: true });
const model = new URL('pose_landmarker_lite.task', dst);
if (!existsSync(model)) {
  try {
    const r = await fetch('https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task');
    if (!r.ok) throw new Error(String(r.status));
    writeFileSync(model, Buffer.from(await r.arrayBuffer()));
    console.log('pose model saved');
  } catch (e) { console.warn('pose model download failed, the page will load it from Google storage instead', e.message); }
}
