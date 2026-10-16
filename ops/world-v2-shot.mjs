// node shot.mjs <url> <outdir> : screenshots of the web viewer presets (proof the baked GLB renders on the web)
import { chromium } from 'playwright';
const [url, out, W0, H0] = process.argv.slice(2);
// shots on a GitHub Actions runner: headless Chromium, SwiftShader WebGL (slow, so long timeouts)
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: +(W0 || 1600), height: +(H0 || 900) }, deviceScaleFactor: 1 });
page.on('console', m => console.log('console:', m.text()));
page.on('pageerror', e => console.log('pageerror:', e.message));
const tag = `${W0 || 1600}`;
const LIST = [];
for (const look of ['day', 'night']) for (const cam of ['wide', 'desk', 'bed', 'window', 'chair']) LIST.push([cam, look]);
for (const [cam, look] of LIST) {
  const t = Date.now();
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}cam=${cam}&look=${look}&shot=1&nobar=1`, { waitUntil: 'load', timeout: 120000 });
  try { await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 }); }
  catch (e) { console.log('not ready', cam, e.message); }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/web-${tag}-${look}-${cam}.jpg`, type: 'jpeg', quality: 88, timeout: 150000 });
  console.log('shot', cam, (Date.now() - t) + 'ms');
}
await page.goto(`${url}${url.includes('?') ? '&' : '?'}cam=wide&shot=1`, { waitUntil: 'load' });
try { await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 }); } catch (e) {}
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/web-${tag}-ui.jpg`, type: 'jpeg', quality: 88, timeout: 150000 });
await browser.close();
