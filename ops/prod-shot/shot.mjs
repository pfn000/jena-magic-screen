// Prod proof shots (GitHub runner, headless Chromium + SwiftShader). node shot.mjs <base> <outdir>
import { chromium } from 'playwright';
import fs from 'node:fs';
const [base, out] = process.argv.slice(2);
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const SIZES = [
  { name: '1600', w: 1600, h: 900, dsf: 1, mobile: false },
  { name: '390', w: 390, h: 844, dsf: 2, mobile: true },
  { name: '402', w: 402, h: 874, dsf: 2, mobile: true },
];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const report = [];
async function shot(sz, path, file, waitFn, settle) {
  const ctx = await browser.newContext({ viewport: { width: sz.w, height: sz.h }, deviceScaleFactor: sz.dsf, isMobile: sz.mobile, hasTouch: sz.mobile, userAgent: sz.mobile ? IPHONE_UA : undefined, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => { const t = m.text(); if (/room|nos|error|warn/i.test(t)) logs.push(m.type() + ': ' + t.slice(0, 300)); });
  page.on('pageerror', (e) => logs.push('pageerror: ' + String(e).slice(0, 300)));
  const t0 = Date.now(); let ok = true, st = null;
  try {
    await page.goto(base + path, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(waitFn, null, { timeout: 240000, polling: 1000 });
  } catch (e) { ok = false; logs.push('wait: ' + String(e).slice(0, 200)); }
  await page.waitForTimeout(settle);
  try { st = await page.evaluate(() => window.__roomBg ? JSON.parse(JSON.stringify(window.__roomBg)) : null); } catch {}
  await page.screenshot({ path: `${out}/${file}`, timeout: 120000 }).catch((e) => logs.push('shot: ' + e));
  const r = { file, path, size: `${sz.w}x${sz.h}@${sz.dsf}`, ok, secs: Math.round((Date.now() - t0) / 1000), room: st, logs };
  console.log(JSON.stringify(r)); report.push(r);
  await ctx.close();
}
const roomDone = () => window.__roomBg && ['shown', 'fallback', 'off'].includes(window.__roomBg.state);
const viewerReady = () => window.__ready === true;
const SET = process.env.SET || 'all';
if (SET === 'all' || SET === 'main') {
  for (const sz of SIZES) await shot(sz, '/', `main-${sz.name}.png`, roomDone, 4000);
  await shot(SIZES[0], '/?look=day', 'main-1600-day.png', roomDone, 4000);
  await shot(SIZES[2], '/?look=day', 'main-402-day.png', roomDone, 4000);
}
if (SET === 'all' || SET === 'world') {
  for (const sz of SIZES) await shot(sz, '/world-v2/?cam=chair&shot=1', `world-chair-${sz.name}.png`, viewerReady, 3000);
  for (const look of ['night', 'day']) {
    await shot(SIZES[0], `/world-v2/?cam=bed&look=${look}&shot=1&nobar`, `world-bed-1600-${look}.png`, viewerReady, 3000);
    await shot(SIZES[1], `/world-v2/?cam=bed&look=${look}&shot=1`, `world-bed-390-${look}.png`, viewerReady, 3000);
  }
}
if (SET === 'chairtry') {   // phone chair framing variants (viewer ?lean= ?rise= ?vmax=)
  for (const [k, q] of [['base90', 'lean=0&rise=0&vmax=90'], ['v104', 'lean=0&rise=0&vmax=104'], ['v112', 'lean=0&rise=0&vmax=112'], ['l12v104', 'lean=0.12&rise=0.04&vmax=104']])
    await shot(SIZES[2], `/world-v2/?cam=chair&shot=1&${q}`, `chairtry-402-${k}.png`, viewerReady, 2500);
  await shot(SIZES[0], '/world-v2/?cam=bed&look=night&shot=1&nobar&rawlm=1', 'world-bed-1600-night-rawlm.png', viewerReady, 3000);
}
fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
await browser.close();
