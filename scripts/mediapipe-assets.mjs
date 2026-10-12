// Self-vision assets: MediaPipe's WASM runtime (from node_modules) and the pose model, served from this site.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
const dst = new URL('../public/mediapipe/', import.meta.url);
mkdirSync(new URL('wasm/', dst), { recursive: true });
cpSync(new URL('../node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url), new URL('wasm/', dst), { recursive: true });
for (const v of ['lite', 'full']) {
  const model = new URL(`pose_landmarker_${v}.task`, dst);
  if (existsSync(model)) continue;
  try {
    const r = await fetch(`https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${v}/float16/1/pose_landmarker_${v}.task`);
    if (!r.ok) throw new Error(String(r.status));
    writeFileSync(model, Buffer.from(await r.arrayBuffer()));
    console.log(`pose model (${v}) saved`);
  } catch (e) { console.warn(`pose model (${v}) download failed, the page will load it from Google storage instead`, e.message); }
}
