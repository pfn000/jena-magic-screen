// Jena's multi-search: several real sources at once, not just Wikipedia.
//   wiki   Wikipedia search API          ddg    DuckDuckGo (html endpoint)
//   github GitHub repository search API  hot    her own hot-URL list in the repo ("Hot URLS/URLS.md")
// Every result names its source; a source that fails says so in `errors` (nothing is made up).
const UA = { 'User-Agent': 'Mozilla/5.0 (jena-magic-screen; +https://github.com/pfn000/jena-magic-screen)' };
const t = (ms) => AbortSignal.timeout(ms);
const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

async function wiki(q) {
  const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=4&srsearch=${encodeURIComponent(q)}`, { headers: UA, signal: t(5000) });
  const d = await r.json();
  return (d.query?.search || []).map((s) => ({ source: 'wikipedia', title: s.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`, snippet: strip(s.snippet) }));
}
async function ddg(q) {
  const r = await fetch('https://html.duckduckgo.com/html/', { method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `q=${encodeURIComponent(q)}`, signal: t(6000) });
  const h = await r.text();
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(h)) && out.length < 5) {
    let url = m[1];
    const u = url.match(/uddg=([^&]+)/); if (u) url = decodeURIComponent(u[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    out.push({ source: 'duckduckgo', title: strip(m[2]), url, snippet: strip(m[3]) });
  }
  if (out.length) return out;
  // html endpoint refused (captcha) or empty: DuckDuckGo's instant-answer API instead
  const a = await (await fetch(`https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=${encodeURIComponent(q)}`, { headers: UA, signal: t(5000) })).json();
  if (a.AbstractURL) out.push({ source: 'duckduckgo', title: a.Heading || q, url: a.AbstractURL, snippet: a.AbstractText || '' });
  for (const x of (a.RelatedTopics || []).flatMap((x) => x.Topics || [x])) {
    if (out.length >= 5) break;
    if (x.FirstURL) out.push({ source: 'duckduckgo', title: strip(x.Text).split(' - ')[0].slice(0, 80), url: x.FirstURL, snippet: strip(x.Text) });
  }
  if (!out.length) throw new Error(/anomaly|captcha/i.test(h) ? 'DuckDuckGo asked for a captcha and its instant answers had nothing' : 'DuckDuckGo had no results');
  return out;
}
async function github(q) {
  const r = await fetch(`https://api.github.com/search/repositories?per_page=4&q=${encodeURIComponent(q)}`, { headers: { ...UA, Accept: 'application/vnd.github+json' }, signal: t(6000) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const d = await r.json();
  return (d.items || []).map((x) => ({ source: 'github', title: x.full_name, url: x.html_url, snippet: `${x.description || ''} ★${x.stargazers_count}`.trim() }));
}
let hotCache = { at: 0, list: [] };
export async function hotUrls() {
  if (Date.now() - hotCache.at < 300000 && hotCache.list.length) return hotCache.list;
  const r = await fetch('https://raw.githubusercontent.com/pfn000/jena-magic-screen/main/Hot%20URLS/URLS.md', { headers: UA, signal: t(5000) });
  const txt = await r.text();
  const list = [];
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*-\s*(\S+)\s*(?:\[([^\]]*)\])?/);
    if (!m) continue;
    let url = m[1]; if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    list.push({ url: url.replace(/^https:\/\/GitHub\.com/i, 'https://github.com'), note: (m[2] || '').trim() });
  }
  hotCache = { at: Date.now(), list };
  return list;
}
async function hot(q) {
  const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  return (await hotUrls()).filter((h) => words.some((w) => (h.url + ' ' + h.note).toLowerCase().includes(w)))
    .map((h) => ({ source: 'hot list', title: h.url.replace(/^https?:\/\//, ''), url: h.url, snippet: h.note || 'from her hot URL list' }));
}

const SOURCES = { wiki, ddg, github, hot };
export async function multiSearch(q, src) {
  q = String(q || '').trim();
  if (!q) return { q, results: [], errors: { query: 'empty' } };
  const want = (src ? src.split(',') : Object.keys(SOURCES)).filter((s) => SOURCES[s]);
  const t0 = Date.now();
  const settled = await Promise.allSettled(want.map((s) => SOURCES[s](q)));
  const results = [], errors = {};
  settled.forEach((s, i) => (s.status === 'fulfilled' ? results.push(...s.value) : (errors[want[i]] = s.reason?.message || String(s.reason))));
  return { q, sources: want, ms: Date.now() - t0, results, errors };
}
