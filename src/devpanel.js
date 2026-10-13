// Secret developer panel: tap/click the top-left corner 5 times (within 3 s). Never in OBS mode.
// Everything here is read live from the real sources: the site's API, her box (through its tunnel),
// GitHub's deploy statuses, and this page's own state. Nothing is simulated; a source that does not
// answer is shown as not answering.
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
    this.el.innerHTML = `<header><b>Jena · developer panel</b><span class="dp-sub">live data only · hidden from OBS</span><button class="dp-close" aria-label="close">✕</button></header>
      <nav>${['live', 'brain', 'sees', 'skills', 'learned', 'memory', 'mama', 'training', 'health'].map((t, i) => `<button data-tab="${t}" class="${i ? '' : 'on'}">${{ live: 'Live updates', brain: 'Brain', sees: 'What she sees', skills: 'Skills + MCP', learned: 'What she learned', memory: 'Memories & chats', mama: 'Mama: activity + help', training: 'Training', health: 'Server health' }[t]}</button>`).join('')}</nav>
      <div class="dp-body"></div>`;
    document.body.appendChild(this.el);
    this.body = this.el.querySelector('.dp-body');
    this.tab = 'live';
    this.el.querySelector('.dp-close').onclick = () => this.close();
    this.el.querySelector('nav').onclick = (e) => { const t = e.target.dataset?.tab; if (!t) return; this.tab = t; this.el.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t)); this.render(); };
    this.data = {};
    // frame-rate meter (this page's real requestAnimationFrame rate)
    this.fps = 0; let n = 0, t0 = performance.now();
    const tick = (t) => { n++; if (t - t0 >= 1000) { this.fps = Math.round((n * 1000) / (t - t0)); n = 0; t0 = t; } requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    this.armCorner();
    this.body.addEventListener('click', async (e) => {
      const key = localStorage.getItem('jena.dmKey');
      const out = this.body.querySelector('#dp-skill-out');
      const post = async (b) => { const r = await fetch('/api/boxdo', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jena-Key': key || '' }, body: JSON.stringify(b) }); return r.json(); };
      if (e.target.dataset.run) {
        if (!key) { out.textContent = 'unlock the private DM drawer with your passcode first'; return; }
        const v = this.body.querySelector('#dp-skill-in').value;
        out.textContent = `running ${e.target.dataset.run}…`;
        out.textContent = JSON.stringify(await post({ action: 'run', name: e.target.dataset.run, input: { text: v, query: v, question: v, url: v } }), null, 1).slice(0, 4000);
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
  open() { this.el.hidden = false; this.refresh(); this.timer = setInterval(() => this.refresh(), 4000); }
  close() { this.el.hidden = true; clearInterval(this.timer); }
  async refresh() {
    const get = (u, h) => fetch(u, { cache: 'no-store', headers: h || {} }).then((r) => r.json()).catch((e) => ({ error: e.message }));
    const want = [get('/api/health'), get('/api/box?what=status')];
    if (!this.data.deploysAt || Date.now() - this.data.deploysAt > 15000) want.push(get('/api/deploys')); else want.push(null);
    if (!this.data.moves) want.push(get('/moves/index.json')); else want.push(null);
    want.push(this.tab === 'skills' ? get('/api/box?what=skills') : null, this.tab === 'mama' ? get('/api/box?what=activity', { 'X-Jena-Key': localStorage.getItem('jena.dmKey') || '' }) : null, this.tab === 'learned' && !this.data.hot ? get('/api/hot') : null);
    const [health, box, deploys, moves, sk, act, hot] = await Promise.all(want);
    if (sk) this.data.skills = sk; if (act) this.data.activity = act; if (hot) this.data.hot = hot;
    Object.assign(this.data, { health, box });
    if (deploys) { this.data.deploys = deploys; this.data.deploysAt = Date.now(); }
    if (moves && !moves.error) this.data.moves = moves;
    this.data.at = Date.now();
    if (!this.el.hidden) this.render();
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
      h += `<h3>Recent pushes (GitHub → Vercel)</h3>${dep.error ? `<p class="dp-warn">GitHub: ${esc(dep.error)}</p>` : ''}<ol class="dp-commits">${commits.map((c) => `<li>${okDot(c.deploy?.state === 'success')}<code>${c.sha.slice(0, 7)}</code> ${esc(c.message)} <small>${esc(c.author)} · ${ago(Date.parse(c.date))} · ${esc(c.deploy ? c.deploy.state + ' — ' + c.deploy.description : 'no deploy status')}${c.sha === liveSha ? ' · <b>this page</b>' : ''}</small></li>`).join('')}</ol>`;
    }
    if (this.tab === 'brain') {
      const b = d.health?.brain || {};
      h += `<h3>Brain</h3><p>${okDot(b.online)} <b>${esc(b.name)}</b> — ${esc(b.detail)} · checked ${ago(b.checkedAt)}${b.box ? ` · box ${esc(b.box.url)} announced ${ago(b.box.announcedAt)} via ${esc(b.box.via)}` : ''}</p>`;
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
    if (this.tab === 'mama') {
      const a = this.data.activity?.data;
      if (this.data.activity?.locked) h += `<p class="dp-warn">${esc(this.data.activity.error)}</p>`;
      else if (!a) h += notOn;
      else {
        const flagged = a.activity.filter((x) => x.flag);
        h += `<h3>Jena asked for help (${a.help.length})</h3><ol>${a.help.slice().reverse().map((x) => `<li><small>${ago(x.ts)}</small> ${esc(x.text)}</li>`).join('') || '<li>nothing yet</li>'}</ol>
          <h3>Flagged (${flagged.length})</h3><ol>${flagged.slice().reverse().map((x) => `<li class="dp-warn"><small>${ago(x.ts)}</small> ${esc(x.kind)}: ${esc(x.what)} <small>${esc(x.why)} · ${esc(x.flag)}</small></li>`).join('') || '<li>nothing flagged</li>'}</ol>
          <h3>Everything she searched / opened (newest first)</h3><ol>${a.activity.slice().reverse().slice(0, 120).map((x) => `<li${x.flag ? ' class="dp-warn"' : ''}><small>${ago(x.ts)}</small> ${esc(x.kind)}: ${esc(x.what)} <small>${esc(x.why)}</small></li>`).join('') || '<li>nothing yet</li>'}</ol>`;
      }
    }
    if (this.tab === 'learned') {
      const hot = this.data.hot?.list || [];
      h += `<h3>Her hot-URL list (${hot.length}) · ${esc(this.data.hot?.source || '')}</h3><ul>${hot.map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a> <small>${esc(x.note)}</small></li>`).join('')}</ul>`;
      const clips = d.moves?.clips || [];
      h += `<h3>Moves library: ${clips.length} clips she built from real videos</h3><p>${esc(d.moves?.note || '')}</p><div class="dp-moves">${clips.map((c) => { const v = (c.source?.url || '').match(/[?&]v=([\w-]{11})/)?.[1]; return `<a class="dp-move" href="${esc(c.source?.url || '#')}" target="_blank" rel="noopener">${v ? `<img src="https://i.ytimg.com/vi/${v}/mqdefault.jpg" alt="">` : ''}<b>${esc(c.label)}</b><small>${esc(c.what)} · ${c.duration}s · ${esc(c.kind)}</small><small>${esc(c.source?.title || '')} · ${esc(c.source?.channel || '')}</small></a>`; }).join('')}</div>`;
    }
    if (this.tab === 'memory') {
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
    const keepOpen = [...this.body.querySelectorAll('details[open]')].length;
    this.body.innerHTML = h;
    if (keepOpen) this.body.querySelectorAll('details').forEach((x) => (x.open = true));
    if (outKeep && this.body.querySelector('#dp-skill-out')) this.body.querySelector('#dp-skill-out').textContent = outKeep;
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
    bar.querySelector('span').innerHTML = p ? `updating Jena: ${esc(p.message.slice(0, 70))}…` : `new version ready · <a href="" onclick="location.reload();return false">reload</a>`;
    bar.classList.toggle('done', !p);
  };
  check(); setInterval(check, 45000);
}
