// Secret developer panel: tap/click the top-left corner 5 times (within 3 s). Never in OBS mode.
// Everything here is read live from the real sources: the site's API, her box (through its tunnel),
// GitHub's deploy statuses, and this page's own state. Nothing is simulated; a source that does not
// answer is shown as not answering.
import { renderSecurity, handleSecurityClick } from './mamasec.js';
import RFB from '@novnc/novnc';
import { asks, startAsks, renderAsks, handleAskClick, pendingCount } from './signin.js';
// styles for the library / assets / site-edits tabs live here (dev panel only), so the page's own stylesheet is untouched
const STUDIO_CSS = `#devpanel .dp-card{border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:10px 12px;margin:8px 0;background:rgba(255,255,255,.04)}
#devpanel .dp-card p{margin:6px 0 0;font-size:12px;line-height:1.45}
#devpanel .dp-pre{white-space:pre-wrap;word-break:break-word;font-size:11px;max-height:260px;overflow:auto;background:rgba(0,0,0,.35);padding:8px;border-radius:8px}
#devpanel .dp-pill{font-size:11px;padding:1px 8px;border-radius:99px;background:#555}
#devpanel .dp-pill.ready{background:#1f7a3d}#devpanel .dp-pill.blocked{background:#8a1f2b}#devpanel .dp-pill.merged{background:#2b4f8a}#devpanel .dp-pill.checking{background:#7a5a1f}
#devpanel .dp-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
#devpanel .dp-asset{margin:0;padding:8px;border-radius:10px;background:repeating-conic-gradient(#2a2a2a 0 25%,#333 0 50%) 0 0/16px 16px;text-align:center}
#devpanel .dp-asset img{max-width:100%;height:96px;object-fit:contain}
#devpanel .dp-asset figcaption{font-size:11px;margin-top:6px;color:#ddd}`;
if (typeof document !== 'undefined' && !document.getElementById('dp-studio-css')) { const st = document.createElement('style'); st.id = 'dp-studio-css'; st.textContent = STUDIO_CSS; document.head.appendChild(st); }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (ts) => { if (!ts) return '—'; const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`; };
const gb = (b) => (b == null ? '?' : (b / 1e9).toFixed(1) + ' GB');
const j = (o) => esc(JSON.stringify(o, null, 1));
const okDot = (ok) => `<i class="dot ${ok ? 'ok' : 'bad'}"></i>`;

export class DevPanel {
  constructor({ getRuns, avatar, cfg }) {
    this.getRuns = getRuns; this.avatar = avatar; this.cfg = cfg;
    this.el = document.createElement('section');
    this.el.id = 'devpanel'; this.el.hidden = true;
    this.el.innerHTML = `<header><b>Jena · developer panel</b><span class="dp-sub">live data only · hidden from OBS</span><a href="/tab-live" target="_blank" rel="noopener" style="margin-left:auto;margin-right:8px;font-size:12px;color:#3ddc84;text-decoration:none;border:1px solid #1f5f3a;border-radius:999px;padding:1px 8px">🖥 Tab Live</a><button class="dp-close" aria-label="close">✕</button></header>
      <nav>${['asks', 'live', 'brain', 'sees', 'skills', 'learned', 'memory', 'mama', 'training', 'health', 'library', 'assets', 'edits', 'security'].map((t, i) => `<button data-tab="${t}" class="${i ? '' : 'on'}">${{ asks: '🙋 Ask mama', live: 'Live updates', brain: 'Brain', sees: 'What she sees', skills: 'Skills + MCP', learned: 'What she learned', memory: 'Memories & chats', mama: 'Mama: activity + help', training: 'Training', health: 'Server health', library: 'Her library', assets: 'Assets she made', edits: 'Site edits (mama approves)', security: '🔐 Mama: devices & keys' }[t]}</button>`).join('')}</nav>
      <div class="dp-body"></div>`;
    document.body.appendChild(this.el);
    this.body = this.el.querySelector('.dp-body');
    this.tab = 'asks';
    // Jena's asks (sign in somewhere / approve something): mama only, badge + toast + inline chat pills (src/signin.js)
    startAsks({ obs: cfg?.obs });
    asks.listeners.add(() => { const n = pendingCount(), b = this.el.querySelector('nav [data-tab="asks"]'); if (b) b.textContent = `🙋 Ask mama${n ? ` (${n})` : ''}`; if (!this.el.hidden && this.tab === 'asks' && !(this.body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT')) this.render(); });
    this.el.querySelector('.dp-close').onclick = () => this.close();
    this.el.querySelector('nav').onclick = (e) => { const t = e.target.dataset?.tab; if (!t) return; this.tab = t; this.el.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t)); this.render(); };
    this.data = {};
    // frame-rate meter (this page's real requestAnimationFrame rate)
    this.fps = 0; let n = 0, t0 = performance.now();
    const tick = (t) => { n++; if (t - t0 >= 1000) { this.fps = Math.round((n * 1000) / (t - t0)); n = 0; t0 = t; } requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    this.armCorner();
    this.body.addEventListener('input', (e) => { if (e.target.id === 'dp-lib-q') this.libQ = e.target.value; });
    this.body.addEventListener('keydown', (e) => { if (e.target.id === 'dp-lib-q' && e.key === 'Enter') this.body.querySelector('[data-libsearch]')?.click(); });
    this.body.addEventListener('click', async (e) => {
      if (await handleAskClick(e, () => this.render())) return;
      if (this.tab === 'security' && (await handleSecurityClick(e, () => this.render()))) return;
      const key = localStorage.getItem('jena.dmKey');
      const out = this.body.querySelector('#dp-skill-out');
      const post = async (b) => { const r = await fetch('/api/boxdo', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': key || '' }, body: JSON.stringify(b) }); return r.json(); };
      if (e.target.dataset.run) {
        if (!key) { out.textContent = 'unlock the private DM drawer with your passcode first'; return; }
        const v = this.body.querySelector('#dp-skill-in').value;
        out.textContent = `running ${e.target.dataset.run}…`;
        out.textContent = JSON.stringify(await post({ action: 'run', name: e.target.dataset.run, input: { text: v, query: v, question: v, url: v } }), null, 1).slice(0, 4000);
      }
      if (e.target.dataset.mama) {
        const mo = this.body.querySelector('#dp-mama-out');
        if (!key) { mo.textContent = 'unlock the private DM drawer with your passcode first'; return; }
        const act = e.target.dataset.mama;
        const r = await fetch('/api/mama', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': key }, body: JSON.stringify({ action: act, text: this.body.querySelector('#dp-pop')?.value || '' }) }).then((x) => x.json()).catch((er) => ({ error: er.message }));
        if (act === 'notify') mo.textContent = r.ok ? 'popped up on her desktop (covered on the public page + stream while it is up)' : JSON.stringify(r);
        if (act === 'apikey') mo.textContent = r.ok ? `Jena's API key (keep it secret; only you can see this):\n${r.key}\n\nOpenAI-compatible:\ncurl ${location.origin}/api/v1/chat/completions -H "Authorization: Bearer ${r.key}" -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"hi jena"}]}'` : JSON.stringify(r);
        if (act === 'takeover') { if (r.ok) this.takeover(r.ws); else mo.textContent = JSON.stringify(r); }
        if (act === 'live') mo.textContent = r.ok ? (r.live ? `🔴 LIVE (${r.why.join(' + ')}): her public desktop view is strict now` : '⚪ OFF-AIR: public view stays privacy-filtered, just relaxed') : JSON.stringify(r);
        this.mamaOut = mo.textContent;
        return;
      }
      if (e.target.dataset.libsearch !== undefined) {
        this.libQ = this.body.querySelector('#dp-lib-q')?.value || '';
        this.data.libRes = { loading: true };
        this.render();
        this.data.libRes = await fetch('/api/box?what=library&q=' + encodeURIComponent(this.libQ), { cache: 'no-store' }).then((r) => r.json()).catch((er) => ({ error: er.message }));
        this.render();
        return;
      }
      if (e.target.dataset.edit) {
        const act = e.target.dataset.edit;
        if (!key) { this.editOut = 'unlock the private DM drawer with your passcode first (only mama can merge or roll back)'; this.render(); return; }
        if (act === 'rollback' && !confirm('Undo Jena\'s last change on the live site (git revert, pushed to main)?')) return;
        this.editOut = `${act}… (checks + push can take a minute)`; this.render();
        const r = await fetch('/api/mama', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': key }, body: JSON.stringify({ action: act, id: e.target.dataset.id || '' }) }).then((x) => x.json()).catch((er) => ({ error: er.message }));
        this.editOut = JSON.stringify(r, null, 1).slice(0, 3000); this.data.edits = null; this.refresh();
        return;
      }
      if (e.target.dataset.create) {
        if (!key) { out.textContent = 'unlock the private DM drawer with your passcode first'; return; }
        out.textContent = 'she is drafting it…';
        out.textContent = JSON.stringify(await post({ action: 'create', name: this.body.querySelector('#dp-new-name').value, goal: this.body.querySelector('#dp-new-goal').value }), null, 1).slice(0, 4000);
      }
    });
  }
  armCorner() {
    let taps = [];
    const hit = (x, y) => x < 70 && y < 70;
    const onTap = (e) => {
      const p = e.touches?.[0] || e;
      if (!hit(p.clientX, p.clientY)) return;
      const now = Date.now();
      taps = taps.filter((t) => now - t < 3000); taps.push(now);
      if (taps.length >= 5) { taps = []; this.el.hidden ? this.open() : this.close(); }
    };
    window.addEventListener('pointerdown', onTap, true);
    if (new URLSearchParams(location.search).get('dev') === '1') setTimeout(() => this.open(), 500);
  }
  // mama drives her real desktop (full mouse + keyboard) through a one-time token; her own hands pause meanwhile
  takeover(ws) {
    document.getElementById('takeover')?.remove();
    const box = document.createElement('section');
    box.id = 'takeover';
    box.innerHTML = '<header>🖐 You are driving Jena\'s desktop (her hands are paused) <span class="to-st">connecting…</span><button style="margin-left:auto">give it back ✕</button></header><div class="to-screen"></div>';
    document.body.appendChild(box);
    const rfb = new RFB(box.querySelector('.to-screen'), ws, { shared: true });
    rfb.viewOnly = false; rfb.scaleViewport = true; rfb.focusOnClick = true; rfb.showDotCursor = true;
    const st = box.querySelector('.to-st');
    rfb.addEventListener('connect', () => (st.textContent = 'connected'));
    rfb.addEventListener('disconnect', (ev) => (st.textContent = ev.detail?.clean ? 'disconnected' : 'connection dropped (token used or expired? press take over again)'));
    box.querySelector('button').onclick = () => { try { rfb.disconnect(); } catch {} box.remove(); };
  }
  showAsks() { this.tab = 'asks'; this.el.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === 'asks')); if (this.el.hidden) this.open(); else this.render(); }
  open() { this.el.hidden = false; this.refresh(); this.timer = setInterval(() => this.refresh(), 4000); }
  close() { this.el.hidden = true; clearInterval(this.timer); }
  async refresh() {
    const get = (u, h) => fetch(u, { cache: 'no-store', headers: h || {} }).then((r) => r.json()).catch((e) => ({ error: e.message }));
    const want = [get('/api/health'), get('/api/box?what=status')];
    if (!this.data.deploysAt || Date.now() - this.data.deploysAt > 15000) want.push(get('/api/deploys')); else want.push(null);
    if (!this.data.moves) want.push(get('/moves/index.json')); else want.push(null);
    want.push(this.tab === 'skills' ? get('/api/box?what=skills') : null, this.tab === 'mama' ? get('/api/box?what=activity', { 'X-Jena-Key': localStorage.getItem('jena.dmKey') || '' }) : null, this.tab === 'learned' && !this.data.hot ? get('/api/hot') : null, this.tab === 'memory' ? get('/api/box?what=memory') : null, this.tab === 'library' && !this.data.lib ? get('/api/box?what=library') : null, this.tab === 'assets' ? get('/api/box?what=assets') : null, (this.tab === 'edits' || this.tab === 'asks') ? get('/api/box?what=edits') : null);
    const [health, box, deploys, moves, sk, act, hot, mem, lib, assets, edits] = await Promise.all(want);
    if (lib?.online) this.data.lib = lib; if (assets) this.data.assets = assets; if (edits) this.data.edits = edits;
    if (mem) this.data.mem = mem;
    if (sk) this.data.skills = sk; if (act) this.data.activity = act; if (hot) this.data.hot = hot;
    Object.assign(this.data, { health, box });
    if (deploys) { this.data.deploys = deploys; this.data.deploysAt = Date.now(); }
    if (moves && !moves.error) this.data.moves = moves;
    this.data.at = Date.now();
    if (!this.el.hidden && this.tab !== 'security' && document.activeElement?.id !== 'dp-lib-q' && !['ask-site', 'ask-key'].includes(document.activeElement?.id)) this.render();
  }
  render() {
    const d = this.data, box = d.box?.data, live = box && d.box.online;
    const notOn = `<p class="dp-warn">her box is not answering right now${d.box?.error ? `: ${esc(d.box.error)}` : ''}. Nothing below is cached or invented, so this section is empty until it answers.</p>`;
    let h = '';
    if (this.tab === 'live') {
      const dep = d.deploys || {}, commits = dep.commits || [], liveSha = dep.live?.commit || d.health?.build?.commit;
      const pending = commits.find((c) => c.deploy?.state === 'pending');
      h += `<h3>This page</h3><p>running build <code>${esc((liveSha || 'local').slice(0, 7))}</code> ${esc(dep.live?.message || '')} · env ${esc(dep.live?.env || '?')} · region ${esc(dep.live?.region || '?')} · page built ${esc(typeof __BUILD__ !== 'undefined' ? __BUILD__ : '?')}</p>`;
      if (pending) h += `<div class="dp-progress"><div class="bar"></div></div><p><b>deploying now:</b> ${esc(pending.message)} (<code>${pending.sha.slice(0, 7)}</code>, pushed ${ago(Date.parse(pending.date))}) · Vercel says “${esc(pending.deploy.description)}”</p>`;
      else if (commits[0] && liveSha && commits[0].sha !== liveSha && commits[0].deploy?.state === 'success') h += `<p class="dp-new">a newer version is live: <button onclick="location.reload()">reload</button></p>`;
      h += `<p class="dp-obs">📺 <button type="button" onclick="window.__jenaObsReload && window.__jenaObsReload(this)">reload OBS view</button> <small>the stream view never reloads on its own after an update; this switches it to the newest version now</small> <span class="dp-obs-msg"></span></p>`;
      h += `<h3>Recent pushes (GitHub → Vercel)</h3>${dep.error ? `<p class="dp-warn">GitHub: ${esc(dep.error)}</p>` : ''}<ol class="dp-commits">${commits.map((c) => `<li>${okDot(c.deploy?.state === 'success')}<code>${c.sha.slice(0, 7)}</code> ${esc(c.message)} <small>${esc(c.author)} · ${ago(Date.parse(c.date))} · ${esc(c.deploy ? c.deploy.state + ' — ' + c.deploy.description : 'no deploy status')}${c.sha === liveSha ? ' · <b>this page</b>' : ''}</small></li>`).join('')}</ol>`;
    }
    if (this.tab === 'brain') {
      const b = d.health?.brain || {};
      h += `<h3>Brain</h3><p>${okDot(b.online)} <b>${esc(b.name)}</b> — ${esc(b.detail)} · checked ${ago(b.checkedAt)}${b.box ? ` · box ${esc(b.box.url)} announced ${ago(b.box.announcedAt)} via ${esc(b.box.via)}` : ''}</p>`;
      const vo = window.__jenaVoice;
      h += `<h3>Voice</h3><p>${vo ? `${vo.on ? '🔊 on' : '🔇 off on this page'} · ${esc(vo.status)} · engine: Piper on her box${vo.last ? ` · last line \u201c${esc(vo.last.text)}\u201d ${vo.last.seconds}s audio, fetched in ${vo.last.fetchMs} ms${vo.last.lipsync ? ` · lip-sync: ${vo.last.lipsync.mouthOpenFrames}/${vo.last.lipsync.frames} frames mouth open, peak ${vo.last.lipsync.peak}` : ''}` : ' · nothing spoken on this page yet'}` : 'voice not loaded'}</p>`;
      if (live) {
        const br = box.brain, last = br.last;
        h += `<p>chain: ${esc(br.primary)} → fallback ${esc(br.fallback)} · ${br.requests} requests since the gateway started · avg ${br.avgMs} ms · errors ${br.errors} · safety-guard replaced ${br.guarded}</p>`;
        if (last) h += `<h3>Last raw request → response (${esc(last.model)}, ${last.ms} ms, ${ago(last.ts)}${last.origin ? ', from ' + esc(last.origin) : ''})</h3>
          <p><b>asked:</b> ${esc(last.user)}</p><p><b>model's raw output:</b> ${esc(last.raw ?? last.error)}</p><p><b>shown:</b> ${esc(last.reply ?? '')}</p>
          ${last.timings ? `<p>prompt ${last.timings.prompt_n} tok in ${Math.round(last.timings.prompt_ms)} ms · generated ${last.timings.predicted_n} tok at ${last.timings.predicted_per_second?.toFixed(1)} tok/s</p>` : ''}
          <details><summary>raw request JSON</summary><pre>${j(last.request)}</pre></details>`;
      } else h += notOn;
      const runs = this.getRuns().slice(-6).reverse();
      h += `<h3>Thought chain on this page (source of each run)</h3><ol class="dp-runs">${runs.map((r) => `<li><b>${esc(r.trigger.user || '')}</b> ${esc((r.trigger.message || r.trigger.text || '').slice(0, 80))} <small>${ago(r.at)} · ${esc(r.events.find((e) => e.type === 'meta')?.model || r.trigger.source || 'her own body')}</small><br>${r.events.filter((e) => e.type !== 'meta' && e.type !== 'done').map((e) => `<code>${esc(e.type)}${e.kind ? ':' + esc(e.kind) : ''}</code> ${esc(e.text || e.value || e.name || '')}`).join('<br>')}</li>`).join('') || '<li>no brain runs on this page yet</li>'}</ol>`;
    }
    if (this.tab === 'sees') {
      const dt = window.__jenaDualTracking;
      h += `<h3>Dual tracking (her 3D rig vs MediaPipe on her rendered video)</h3><p>${dt && Date.now() - dt.at < 10000 ? `${dt.joints} joints compared · median ${dt.medianPct}% of her torso length apart · worst: ${esc(dt.worst.joint)} ${dt.worst.pct}%${dt.mediapipeSwappedSides ? ' · MediaPipe swapped her left/right this time' : ''} · ${ago(dt.at)}` : 'not running on this page right now (needs the BODY panel open, front view, and MediaPipe loaded)'}</p>`;
      if (live && box.desktop) {
        const ds = box.desktop;
        h += `<h3>Her desktop right now</h3><img class="dp-shot" src="${esc(d.box.box.url)}/box/shot.jpg?t=${d.at}" alt="her live desktop screenshot"><p><b>she thinks:</b> ${esc(ds.summary)} · active: ${esc(ds.active?.app)} “${esc(ds.active?.title)}” · changed ${ago(ds.changedAt)}</p>
          <p><b>open windows:</b> ${(ds.windows || []).map((w) => esc(w.app + ': ' + w.title)).join(' · ')}</p>
          <h3>OCR of what's on screen (tesseract, on her box)</h3><pre>${esc(ds.text || '(no text read on this frame)')}</pre>
          <h3>What her hands did</h3><ol>${(ds.actions || []).slice().reverse().map((a) => `<li><small>${ago(a.ts)}</small> ${esc(a.kind)}: ${esc(a.text)}</li>`).join('')}</ol>`;
      } else h += notOn;
    }
    if (this.tab === 'skills') {
      const s = this.data.skills?.data;
      if (!s) h += notOn;
      else {
        h += `<h3>Skills she can use (${s.skills.length}) · from her repo (skills/) + ones she drafted herself</h3><table class="dp-t"><tr><th>skill</th><th>what it does</th><th>status</th><th>runs ok/fail</th><th>last used</th><th>last result</th><th></th></tr>${s.skills.map((k) => `<tr><td><b>${esc(k.name)}</b><br><small>${esc(k.source)} · ${esc(k.kind)}${k.needs?.length ? ' · ' + esc(k.needs.join(', ')) : ''}</small></td><td>${esc(k.description)}</td><td>${esc(k.status)}${k.validation && k.status !== 'enabled' ? `<br><small>${esc(k.validation)}</small>` : ''}</td><td>${k.runs} · ${k.ok}/${k.fail}</td><td>${ago(k.last_used)}</td><td><small>${esc(k.last_summary || '')}</small></td><td><button data-run="${esc(k.name)}">run</button></td></tr>`).join('')}</table>
          <p><input id="dp-skill-in" placeholder="input for run (text / question / url)" size="50"> <small>runs need mama's passcode (the DM one)</small></p><pre id="dp-skill-out"></pre>
          <h3>Teach her a new skill (she drafts it with her own brain; enabled only if it passes validation on her box)</h3><p><input id="dp-new-name" placeholder="name e.g. coin_flip" size="18"> <input id="dp-new-goal" placeholder="what should it do?" size="50"> <button data-create="1">draft it</button></p>
          <h3>MCP servers on her box ${s.mcp_checked_at ? '(checked ' + ago(s.mcp_checked_at) + ')' : '(not checked yet)'}</h3><ul>${Object.entries(s.mcp || {}).map(([n, m]) => `<li>${okDot(m.connected)}<b>${esc(n)}</b> — ${esc(m.what || '')}${m.tools ? `<br><small>tools: ${m.tools.map((t) => (t.allowed === false ? `<s title="blocked for Jena">${esc(t.name)}</s>` : esc(t.name))).join(', ')}${m.allow ? ' <i>(struck out = blocked for her)</i>' : ''}</small>` : `<br><small>${esc(m.error || '')}</small>`}</li>`).join('') || '<li>no MCP check yet</li>'}</ul>`;
      }
    }
    if (this.tab === 'security') h += renderSecurity();
    if (this.tab === 'mama') {
      const a = this.data.activity?.data;
      if (this.data.activity?.locked) h += `<p class="dp-warn">${esc(this.data.activity.error)}</p>`;
      else if (!a) h += notOn;
      else {
        const flagged = a.activity.filter((x) => x.flag);
        h += `<h3>Mama's controls</h3><p><input id="dp-pop" placeholder="message to pop up on her desktop" size="40"> <button data-mama="notify">💌 pop it up</button> <button data-mama="takeover">🖐 take over her desktop</button> <button data-mama="live" title="public desktop view goes strict while you stream">🔴 Live now on/off</button> <button data-mama="apikey">🔑 her API key</button></p><pre id="dp-mama-out"></pre>
          <h3>Jena asked for help (${a.help.length})</h3><ol>${a.help.slice().reverse().map((x) => `<li><small>${ago(x.ts)}</small> ${esc(x.text)}</li>`).join('') || '<li>nothing yet</li>'}</ol>
          <h3>Flagged (${flagged.length})</h3><ol>${flagged.slice().reverse().map((x) => `<li class="dp-warn"><small>${ago(x.ts)}</small> ${esc(x.kind)}: ${esc(x.what)} <small>${esc(x.why)} · ${esc(x.flag)}</small></li>`).join('') || '<li>nothing flagged</li>'}</ol>
          <h3>Everything she searched / opened (newest first)</h3><ol>${a.activity.slice().reverse().slice(0, 120).map((x) => `<li${x.flag ? ' class="dp-warn"' : ''}><small>${ago(x.ts)}</small> ${esc(x.kind)}: ${esc(x.what)} <small>${esc(x.why)}</small></li>`).join('') || '<li>nothing yet</li>'}</ol>`;
      }
    }
    if (this.tab === 'learned') {
      const hot = this.data.hot?.list || [];
      h += `<h3>Her hot-URL list (${hot.length}) · ${esc(this.data.hot?.source || '')}</h3><ul>${hot.map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a> <small>${esc(x.note)}</small></li>`).join('')}</ul>`;
      const did = (window.jenaMemoryLog || []).filter((x) => x.kind === 'move');
      h += `<h3>Moves she did on this page (${did.length}) · her own variations: mirrored side and speed she picks each time</h3><ol>${did.slice(-20).reverse().map((x) => `<li><small>${ago(Date.parse(x.at))}</small> ${esc(x.what)}${x.mirror ? ' · mirrored' : ''} · speed ×${x.rate}</li>`).join('') || '<li>none yet on this page</li>'}</ol>`;
      const an = this.data.anims;
      if (!an) { this.data.anims = { loading: true }; fetch('https://api.github.com/repos/pfn000/jena-magic-screen/contents/ANIMATIONS').then((r) => r.json()).then((x) => (this.data.anims = { files: Array.isArray(x) ? x : [], error: Array.isArray(x) ? null : x.message })).catch((e) => (this.data.anims = { files: [], error: e.message })); }
      h += `<h3>ANIMATIONS/ folder in her repo (files mama added)</h3>${an?.files ? `<ul>${an.files.map((f) => `<li><a href="${esc(f.html_url)}" target="_blank" rel="noopener">${esc(f.name)}</a> · ${f.size} bytes${/\.vrma$/i.test(f.name) ? (f.size < 1000 ? ' · <span class="dp-warn">empty, nothing to play (a .vrma needs a real glTF animation file; this one is ' + f.size + ' byte)</span>' : ' · VRMA file (playback on the site is not built yet)') : ''}</li>`).join('')}</ul>${an.error ? `<p class="dp-warn">${esc(an.error)}</p>` : ''}` : '<p>reading GitHub…</p>'}`;
      const bl = window.jenaMoves?.boxLearned;
      if (!this.data.learnStatusAt || Date.now() - this.data.learnStatusAt > 8000) { this.data.learnStatusAt = Date.now(); const bu = window.jenaMoves?.boxBase; if (bu) fetch(bu + 'status.json', { cache: 'no-store' }).then((r) => r.json()).then((x) => (this.data.learnStatus = x)).catch(() => {}); }
      const ls = this.data.learnStatus;
      h += `<h3>Moves she learned by herself on her box (${bl?.clips?.length || 0})</h3><p>${ls ? `learner: <b>${esc(ls.state)}</b>${ls.step ? ' · ' + esc(ls.step) : ''}${ls.what ? ' · ' + esc(ls.what) : ''}${ls.last ? ` · last: ${esc(ls.last.id)} ${ls.last.ok ? 'learned ✓' : 'rejected: ' + esc((ls.last.reasons || []).join(', '))}` : ''} · ${ago(ls.at)}` : 'learner has not run yet'} · ask her "jena learn this dance &lt;YouTube link&gt;"</p><ul>${(bl?.clips || []).map((c) => `<li><b>${esc(c.label)}</b> · ${esc(c.what)} · ${c.duration}s · <a href="${esc(c.source?.url || '#')}" target="_blank" rel="noopener">${esc(c.source?.title || 'source video')}</a> · learned ${ago(c.learned_at)}</li>`).join('')}${(bl?.rejected || []).map((c) => `<li class="dp-warn">rejected ${esc(c.title || c.id)}: ${esc((c.reasons || []).join(', '))}</li>`).join('')}</ul>`;
      const clips = d.moves?.clips || [];
      h += `<h3>Moves library: ${clips.length} clips she built from real videos</h3><p>${esc(d.moves?.note || '')}</p><div class="dp-moves">${clips.map((c) => { const v = (c.source?.url || '').match(/[?&]v=([\w-]{11})/)?.[1]; return `<a class="dp-move" href="${esc(c.source?.url || '#')}" target="_blank" rel="noopener">${v ? `<img src="https://i.ytimg.com/vi/${v}/mqdefault.jpg" alt="">` : ''}<b>${esc(c.label)}</b><small>${esc(c.what)} · ${c.duration}s · ${esc(c.kind)}</small><small>${esc(c.source?.title || '')} · ${esc(c.source?.channel || '')}</small></a>`; }).join('')}</div>`;
    }
    if (this.tab === 'memory') {
      const mm = this.data.mem?.data;
      h += mm ? `<h3>Persistent memories on her box (${mm.count}) · ${esc(mm.file)}</h3><ol>${mm.memories.map((x) => `<li><small>${ago(x.ts)} · ${esc(x.kind)} · ${esc(x.source || '')}</small> ${esc(x.fact)}</li>`).join('') || '<li>nothing saved yet: she saves when someone says "remember …", tells her their name, a favorite, or something they like</li>'}</ol>` : notOn;
      if (live) {
        h += `<h3>Her notes file (her memory on her desktop)</h3><pre>${esc(box.memories?.notesTail || '(could not read her notes)')}</pre>`;
        h += `<h3>Conversations (last brain exchanges on her box)</h3><div class="dp-log" data-src="log">loading…</div>`;
        fetch('/api/box?what=log', { cache: 'no-store' }).then((r) => r.json()).then((x) => {
          const el = this.body.querySelector('.dp-log'); if (!el) return;
          el.innerHTML = `<ol>${(x.data?.log || []).slice().reverse().map((l) => `<li><small>${ago(l.ts)} · ${esc(l.model)} · ${l.ms} ms${l.origin ? ' · ' + esc(l.origin) : ''}${l.guarded ? ' · guarded' : ''}</small><br><b>→</b> ${esc(l.user)}<br><b>←</b> ${esc(l.reply ?? l.error)}</li>`).join('')}</ol>`;
        }).catch(() => {});
      } else h += notOn;
    }
    if (this.tab === 'training') {
      if (live) {
        const t = box.training;
        const rows = (t['JenaXI-chat'].log || []).map((r) => (typeof r === 'object' ? Object.entries(r).map(([k, v]) => `${k}=${typeof v === 'number' ? +v.toFixed(4) : v}`).join(' ') : r));
        h += `<h3>JenaXI-chat</h3><p>${esc(t['JenaXI-chat'].what)}</p><p>model file: ${esc(t['JenaXI-chat'].gguf?.path)} · ${gb(t['JenaXI-chat'].gguf?.bytes)} · built ${ago(t['JenaXI-chat'].gguf?.modified)}</p><pre>${esc(rows.join('\n'))}</pre>
          <h3>JenaXI-0</h3><p>${esc(t['JenaXI-0'].what)}</p><pre>${j(t['JenaXI-0'].pretrain)}</pre>
          <h3>Training running right now</h3><pre>${esc(t.running || 'nothing is training on her box right now')}</pre>`;
      } else h += notOn;
    }
    if (this.tab === 'library') {
      const L = d.lib?.data;
      if (!L) h += d.lib ? notOn : '<p>reading her library catalog from her box…</p>';
      else {
        const kb = (b) => b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';
        h += `<h3>Her design + dev library (on her box: ~/library) · ${L.sources.reduce((a, s) => a + s.docs, 0)} documents · ${L.sources.reduce((a, s) => a + s.passages, 0).toLocaleString()} searchable passages · ${kb(L.total_bytes)} total</h3>
          <p><small>Only free, openly licensed sources. Search: ${esc(L.index)} (${kb(L.db_bytes)} index). Her skills <b>library_lookup</b> and <b>roast_critique</b> quote these passages and cite book + license + link. Built ${ago(L.built_at * 1000)}.</small></p>
          <p><input id="dp-lib-q" placeholder="search her library, e.g. touch target size" value="${esc(this.libQ || '')}" style="width:60%"> <button data-libsearch>search</button></p>`;
        const R = d.libRes;
        if (R?.loading) h += '<p>searching…</p>';
        else if (R) h += R.data?.results?.length ? R.data.results.map((x) => `<div class="dp-card"><b>${esc(x.title)}</b>${x.section ? ' › ' + esc(x.section) : ''}<br><small>${esc(x.book)} · ${esc(x.license)} · <a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">source</a></small><p>${esc(x.passage)}</p></div>`).join('') : `<p>${esc(R.error || R.data?.error || 'no passages matched')}</p>`;
        h += `<table class="dp-t"><tr><th>source</th><th>license</th><th>docs</th><th>passages</th><th>size</th><th>topic</th></tr>${L.sources.map((s) => `<tr><td><a href="${esc(s.home)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></td><td>${esc(s.license)}</td><td>${s.docs}</td><td>${s.passages.toLocaleString()}</td><td>${kb(s.bytes_on_disk)}</td><td>${esc(s.topic)}</td></tr>`).join('')}
          ${(L.asset_sets || []).map((s) => `<tr><td><a href="${esc(s.home)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></td><td>${esc(s.license)}</td><td>${s.icons} icons</td><td>—</td><td>${kb(s.bytes_on_disk)}</td><td>assets</td></tr>`).join('')}</table>
          <p><small><b>Not in her library (honest):</b> ${(L.not_included || []).map(esc).join(' · ')}</small></p>`;
      }
    }
    if (this.tab === 'assets') {
      const A = d.assets?.data;
      if (!A) h += d.assets ? notOn : '<p>reading her assets…</p>';
      else if (!A.count) h += '<p>She has not made any assets yet. Ask her in chat: "jena make an icon of a rocket" or "jena make a button that says Follow".</p>';
      else h += `<h3>Assets she made (${A.count}) · saved on her box in ~/assets · real SVG + PNG files</h3><div class="dp-gallery">${A.assets.map((a) => `<figure class="dp-asset"><img src="/api/asset?name=${encodeURIComponent(a.png || a.svg)}" alt="${esc(a.title || a.svg)}" loading="lazy"><figcaption><b>${esc(a.title || a.kind)}</b><br><small>${esc(a.kind)} · ${esc(a.base || 'drawn by her')}${a.license ? ' (' + esc(a.license) + ')' : ''} · ${ago(a.ts * 1000)}</small><br><a href="/api/asset?name=${encodeURIComponent(a.svg)}" target="_blank" rel="noopener">svg</a>${a.png ? ` · <a href="/api/asset?name=${encodeURIComponent(a.png)}" target="_blank" rel="noopener">png ${a.png_px || ''}</a>` : ''}</figcaption></figure>`).join('')}</div>`;
    }
    if (this.tab === 'asks') h += renderAsks(d.edits);
    if (this.tab === 'edits') {
      const E = d.edits?.data;
      h += `<h3>Site edits Jena proposes · branch → checks → Vercel preview → <u>only mama merges</u></h3><p><small>She never pushes to main herself. Each change gets its own branch in a sandbox copy, then build + lint + a headless smoke test (page loads, no console errors, key parts present, 390 px phone has no sideways scroll, OBS view intact). Only a passing branch is pushed for a Vercel preview. Merge and undo need your passcode. Merging its pull request on GitHub yourself counts as your approval too, and shows up here as merged.</small></p>`;
      if (!E) h += d.edits ? `<p class="dp-warn">${esc(d.edits.error || d.edits.data?.error || 'her site-edit checker is not answering')}</p>` : '<p>reading…</p>';
      else {
        h += `<p><button data-edit="rollback">↶ undo Jena's last change on the live site</button> <small>${E.last_jena_commit ? 'last Jena commit on main: ' + esc(E.last_jena_commit.sha.slice(0, 7)) + ' “' + esc(E.last_jena_commit.message) + '”' : 'no Jena commit on main yet'}</small></p>`;
        h += (E.proposals || []).map((p) => `<div class="dp-card"><b>${esc(p.title)}</b> <span class="dp-pill ${p.state}">${esc(p.state)}</span><br><small>${esc(p.why || '')} · branch ${esc(p.branch)} · ${ago(p.ts * 1000)}</small>
          <ul>${(p.checks || []).map((c) => `<li>${c.ok ? '✅' : '❌'} ${esc(c.name)}${c.detail ? ' — ' + esc(c.detail) : ''}</li>`).join('')}</ul>
          ${p.preview ? `<p>preview: <a href="${esc(p.preview)}" target="_blank" rel="noopener noreferrer">${esc(p.preview)}</a>${p.preview_note ? ' <small>(' + esc(p.preview_note) + ')</small>' : ''}</p>` : ''}
          ${p.diff ? `<pre class="dp-pre">${esc(p.diff.slice(0, 1800))}</pre>` : ''}
          ${p.state === 'ready' ? `<button data-edit="merge" data-id="${esc(p.id)}">✓ merge to live site</button> <button data-edit="discard" data-id="${esc(p.id)}">✕ discard</button>` : ''}</div>`).join('') || '<p>No proposals yet.</p>';
        h += `<h4>Log</h4><pre class="dp-pre">${esc((E.log || []).slice(-25).join('\n'))}</pre>`;
      }
      if (this.editOut) h += `<pre class="dp-pre">${esc(this.editOut)}</pre>`;
    }
    if (this.tab === 'health') {
      h += `<h3>This page</h3><p>render loop: ${this.fps} fps · avatar ${this.avatar?.ready ? 'loaded' : 'loading'} · ${esc(navigator.userAgent.slice(0, 80))}</p>`;
      if (live) {
        const x = box.host, s = box.services, tn = box.tunnel;
        h += `<h3>Services on her box</h3><ul>${Object.entries(s).map(([k, v]) => `<li>${okDot(v.ok)} <b>${esc(k)}</b> ${esc(v.detail)} · ${v.ms} ms${v.model ? ` · ${esc(v.model)}` : ''}${v.meta ? ` · ${(v.meta.n_params / 1e6).toFixed(0)}M params · ctx ${v.meta.n_ctx}` : ''}</li>`).join('')}</ul>
          <h3>Box</h3><p>load ${x.load.map((l) => l.toFixed(2)).join(' ')} on ${x.cpus} CPUs · memory free ${gb(x.memFree)} of ${gb(x.memTotal)} · disk free ${gb(x.diskFree)} of ${gb(x.diskTotal)} · up ${(x.uptimeS / 3600).toFixed(1)} h · gateway up since ${ago(box.gatewayStartedAt)}</p>
          <h3>Tunnel</h3><p>${esc(tn.url)} · since ${ago(tn.since)} · self-check ${tn.lastCheck ? (tn.lastCheck.ok ? 'ok' : 'FAILED') + ' ' + ago(tn.lastCheck.at) + ' (' + tn.lastCheck.ms + ' ms)' : '—'} · announced ${ago(tn.announced?.at)} (site ${esc(tn.announced?.site)}, relay ${esc(tn.announced?.relay)})</p>`;
      } else h += notOn;
    }
    h += `<p class="dp-foot">refreshed ${ago(this.data.at)} · auto-refresh every 4 s</p>`;
    if (this.body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // don't wipe what mama is typing
    const outKeep = this.body.querySelector('#dp-skill-out')?.textContent;
    const mamaKeep = this.body.querySelector('#dp-mama-out')?.textContent;
    const keepOpen = [...this.body.querySelectorAll('details[open]')].length;
    this.body.innerHTML = h;
    if (keepOpen) this.body.querySelectorAll('details').forEach((x) => (x.open = true));
    if (outKeep && this.body.querySelector('#dp-skill-out')) this.body.querySelector('#dp-skill-out').textContent = outKeep;
    if (mamaKeep && this.body.querySelector('#dp-mama-out')) this.body.querySelector('#dp-mama-out').textContent = mamaKeep;
  }
}

// Thin "updating" bar for everyone (not OBS) while Vercel is deploying a new push.
export function deployBar() {
  const bar = document.createElement('div');
  bar.id = 'deploy-bar'; bar.hidden = true;
  bar.innerHTML = '<div class="bar"></div><span></span>';
  document.body.appendChild(bar);
  const check = async () => {
    const d = await fetch('/api/deploys', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
    const p = d?.commits?.find((c) => c.deploy?.state === 'pending');
    const liveSha = d?.live?.commit, newest = d?.commits?.[0];
    bar.hidden = !p && !(newest && liveSha && newest.sha !== liveSha && newest.deploy?.state === 'success');
    bar.querySelector('span').innerHTML = p ? `updating Jena: ${esc(p.message.slice(0, 70))}…` : `new version ready · switching over by itself at a quiet moment (nothing you're doing gets lost) · <a href="" onclick="location.reload();return false">now</a>`;
    bar.classList.toggle('done', !p);
  };
  check(); setInterval(check, 45000);
}
