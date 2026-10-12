// Binary assets ride in assets-b64/ as base64 text (so the app can be deployed as plain text files);
// this unpacks them into public/ before the build. Real files already in public/ are left alone.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
const src = new URL('../assets-b64/', import.meta.url);
const dst = new URL('../public/', import.meta.url);
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src).filter((f) => f.endsWith('.b64'))) {
  const out = new URL(f.replace(/\.b64$/, ''), dst);
  if (existsSync(out)) continue;
  writeFileSync(out, Buffer.from(readFileSync(new URL(f, src), 'utf8'), 'base64'));
  console.log('unpacked', f);
}
