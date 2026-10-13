// Jena's page audit: open a real page in headless Chromium (one at a time on her box) and measure it.
// Used by her roast_critique skill (to roast UI with real numbers) and by her site-edit checker (smoke test).
// Input: one JSON argument {url, widths:[390,1280], shot:"/path/prefix", keys:["#chat"], wait_ms, query}.
// Output: one JSON line. Nothing is guessed: every number below is read from the rendered page.
const fs = require('fs'), os = require('os');
const { chromium } = require(process.env.PW || '/opt/jena-node/node_modules/playwright-core');
const CHROME = process.env.JENA_CHROME || '/opt/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
const LOCK = '/tmp/jena-chrome.lock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const memAvailMB = () => { try { return +fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)[1] / 1024; } catch { return os.freemem() / 1048576; } };
async function lock() {
  for (let i = 0; i < 150; i++) {
    // one headless browser at a time on this box: also wait while anyone else's Chromium is running
    let busy = false; try { busy = require('child_process').execSync('pgrep -f "ms-playwright/chro[m]" || true').toString().trim().length > 0; } catch {}
    if (!busy) { try { fs.mkdirSync(LOCK); fs.writeFileSync(LOCK + '/pid', String(process.pid)); return true; } catch {} }
    try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 240000) fs.rmSync(LOCK, { recursive: true, force: true }); } catch {}
    await sleep(1000);
  }
  return false;
}
const unlock = () => { try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch {} };

function measure(keys) {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (el) => { let bg = { r: 255, g: 255, b: 255, a: 1 }, hasImg = false; const stack = []; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.backgroundImage && cs.backgroundImage !== 'none') hasImg = true; const c = parse(cs.backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 0.99) break; } }
    for (let i = stack.length - 1; i >= 0; i--) { const c = stack[i]; bg = { r: c.r * c.a + bg.r * (1 - c.a), g: c.g * c.a + bg.g * (1 - c.a), b: c.b * c.a + bg.b * (1 - c.a), a: 1 }; } return { bg, hasImg }; };
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05; };
  const out = { title: document.title, lang: document.documentElement.lang || null, viewport: !!document.querySelector('meta[name=viewport]'), w: innerWidth,
    overflowX: document.documentElement.scrollWidth > innerWidth + 1, scrollWidth: document.documentElement.scrollWidth };
  const fonts = new Map(), colors = new Set(), sizes = new Map(); let small = [], contrast = [], textEls = 0;
  const all = [...document.querySelectorAll('body *')].slice(0, 4000);
  for (const el of all) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim().length > 1).map((n) => n.textContent.trim()).join(' ');
    if (!own || !vis(el)) continue;
    textEls++;
    const cs = getComputedStyle(el), fs_ = parseFloat(cs.fontSize), fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
    fonts.set(fam, (fonts.get(fam) || 0) + 1); colors.add(cs.color); sizes.set(Math.round(fs_), (sizes.get(Math.round(fs_)) || 0) + 1);
    if (fs_ < 12) small.push({ text: own.slice(0, 40), px: fs_ });
    const fg = parse(cs.color); if (!fg) continue;
    const { bg, hasImg } = bgOf(el); if (hasImg) continue;
    const L1 = lum(fg), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const large = fs_ >= 24 || (fs_ >= 18.66 && +cs.fontWeight >= 700);
    if (ratio < (large ? 3 : 4.5)) contrast.push({ text: own.slice(0, 40), ratio: +ratio.toFixed(2), fg: cs.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`, px: fs_ });
  }
  const targets = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [onclick]')].filter(vis);
  const tiny = targets.map((el) => ({ el, r: el.getBoundingClientRect() })).filter(({ r }) => r.width < 24 || r.height < 24).map(({ el, r }) => ({ what: (el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) }));
  const unnamed = targets.filter((el) => (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && !(el.innerText.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || el.querySelector('img[alt]:not([alt=""]),svg title'))).length;
  const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => +h.tagName[1]); let skips = 0; for (let i = 1; i < hs.length; i++) if (hs[i] > hs[i - 1] + 1) skips++;
  const imgs = [...document.querySelectorAll('img')];
  const zs = all.map((el) => +getComputedStyle(el).zIndex).filter((z) => z > 999);
  const divClick = [...document.querySelectorAll('div[onclick],span[onclick]')].length;
  Object.assign(out, { textEls, fontFamilies: [...fonts.entries()].sort((a, b) => b[1] - a[1]), fontSizes: [...sizes.entries()].sort((a, b) => a[0] - b[0]), textColors: colors.size,
    smallText: { count: small.length, examples: small.slice(0, 3) }, lowContrast: { count: contrast.length, examples: contrast.sort((a, b) => a.ratio - b.ratio).slice(0, 4) },
    targets: targets.length, tinyTargets: { count: tiny.length, examples: tiny.slice(0, 4) }, unnamedButtons: unnamed, h1: hs.filter((x) => x === 1).length, headingSkips: skips,
    images: imgs.length, imgNoAlt: imgs.filter((i) => !i.hasAttribute('alt')).length, zOver999: zs.length, maxZ: zs.length ? Math.max(...zs) : null, divButtons: divClick,
    words: (document.body.innerText || '').split(/\s+/).filter(Boolean).length, text: (document.body.innerText || '').slice(0, 3000),
    keys: Object.fromEntries((keys || []).map((k) => { const el = document.querySelector(k); return [k, !!el && vis(el)]; })) });
  return out;
}

(async () => {
  const a = JSON.parse(process.argv[2] || '{}');
  const res = { url: a.url, ok: false, widths: {} };
  if (memAvailMB() < (a.min_mb || 650)) { res.error = `not enough free memory on her box right now (${Math.round(memAvailMB())} MB free), skipped the browser`; console.log(JSON.stringify(res)); return; }
  if (!(await lock())) { res.error = 'another headless browser is busy on her box (one at a time); try again in a minute'; console.log(JSON.stringify(res)); return; }
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=384'] });
    for (const w of a.widths || [1280]) {
      const mobile = w < 600;
      const ctx = await browser.newContext({ viewport: { width: w, height: mobile ? 844 : 800 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 JenaAudit' : undefined, extraHTTPHeaders: a.headers || {} });
      const page = await ctx.newPage();
      const errors = [], failed = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
      page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e.message).slice(0, 200)));
      page.on('requestfailed', (r) => failed.push(r.url().slice(0, 120) + ' ' + (r.failure()?.errorText || '')));
      page.on('response', (r) => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url().slice(0, 120)); });
      const t0 = Date.now(); let status = null;
      try { const r = await page.goto(a.url, { waitUntil: 'load', timeout: a.timeout || 45000 }); status = r?.status() ?? null; } catch (e) { errors.push('LOAD ' + e.message.slice(0, 160)); }
      const loadMs = Date.now() - t0;
      await page.waitForTimeout(a.wait_ms ?? 2500);
      let m = null; try { m = await page.evaluate(measure, a.keys || []); } catch (e) { errors.push('MEASURE ' + e.message.slice(0, 160)); }
      let shot = null; if (a.shot) { shot = `${a.shot}-${w}.png`; try { await page.screenshot({ path: shot }); } catch { shot = null; } }
      res.widths[w] = { status, loadMs, consoleErrors: errors.slice(0, 12), failedRequests: failed.slice(0, 12), shot, ...m };
      await ctx.close();
    }
    res.ok = true;
  } catch (e) { res.error = e.message.slice(0, 300); }
  finally { try { await browser?.close(); } catch {} unlock(); }
  console.log(JSON.stringify(res));
})();
