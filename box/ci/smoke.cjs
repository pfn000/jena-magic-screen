// Jena's site-edit smoke test: loads a built copy of her site in headless Chromium the way visitors and OBS see it
// and measures it. Run once on main (baseline) and once on her branch; jena_ci.py compares the two.
// usage: node smoke.cjs http://127.0.0.1:4180  -> prints one JSON line
const { chromium } = require('/opt/jena-node/node_modules/playwright-core');
const fs = require('fs');
const LOCK = '/tmp/jena-chrome.lock';   // one headless Chrome at a time on her box (shared with the other tools)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = ['#stage', '#avatar-canvas', '#desktop', '#chat', '#talk-input', '#thoughts'];
const BOXES = ['#stage', '#desktop', '#chat', '#thoughts', '#avatar-panel'];
(async () => {
  const base = process.argv[2];
  let locked = false;
  for (let i = 0; i < 240 && !locked; i++) { try { fs.mkdirSync(LOCK); locked = true; } catch { await sleep(1000); } }
  const out = { base, views: {} };
  const b = await chromium.launch({ executablePath: '/opt/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  try {
    for (const [name, vp, q, mobile] of [['desktop', { width: 1600, height: 1000 }, '', false], ['phone390', { width: 390, height: 844 }, '', true], ['obs', { width: 1920, height: 1080 }, '?obs=1', false]]) {
      const p = await b.newPage({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
      const errors = [], pageErrors = [];
      p.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
      p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
      const v = { errors, pageErrors };
      try {
        const r = await p.goto(base + '/' + q, { waitUntil: 'load', timeout: 60000 });
        v.status = r ? r.status() : 0;
        await p.waitForTimeout(7000);
        Object.assign(v, await p.evaluate(([KEY, BOXES]) => {
          const vis = (el) => { if (!el) return false; const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
          const present = Object.fromEntries(KEY.map((k) => [k, !!document.querySelector(k)]));
          const visible = Object.fromEntries(KEY.map((k) => [k, vis(document.querySelector(k))]));
          const boxes = Object.fromEntries(BOXES.map((k) => { const e = document.querySelector(k); if (!e) return [k, null]; const r = e.getBoundingClientRect(); return [k, [r.x, r.y, r.width, r.height].map(Math.round)]; }));
          const W = innerWidth, sw = document.scrollingElement.scrollWidth;
          const past = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.right > W + 1 && s.position !== 'fixed' && vis(e) && !e.closest('[hidden]'); }).slice(0, 5).map((e) => (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + [...e.classList].join('.')).slice(0, 60));
          return { title: document.title, present, visible, boxes, innerWidth: W, scrollWidth: sw, pastRightEdge: past, bodyText: document.body.innerText.length };
        }, [KEY, BOXES]));
      } catch (e) { v.loadError = String(e.message).slice(0, 200); }
      out.views[name] = v;
      await p.close();
    }
  } catch (e) { out.error = String(e.message).slice(0, 300); }
  await b.close();
  if (locked) fs.rmSync(LOCK, { recursive: true, force: true });
  console.log(JSON.stringify(out));
})();
