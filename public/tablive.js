// TAB LIVE: Saidie's window into what Tab is building. Polls /api/tablive every 3 s (mama passcode).
// Bars are done/total from each builder's steps file: they move only when a real step finishes. No fake animation.
(() => {
  const app = document.getElementById('app');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const KEY = 'jena.dmKey';
  let skew = 0, last = null, lastOk = 0, fails = 0, timer = null;
  const age = (iso) => { if (!iso) return null; return Math.max(0, (Date.now() - skew - Date.parse(iso)) / 1000); };
  const dur = (s) => { if (s == null) return '–'; s = Math.round(s); if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : ''); return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'; };
  const ago = (iso) => { const a = age(iso); return a == null ? '–' : dur(a) + ' ago'; };
  const tone = (s) => (s == null ? '' : s < 120 ? 'g' : s < 300 ? 'y' : 'r');
  const hhmm = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
  const ST = { running: ['g', '● running'], 'stalled?': ['r', '◌ stalled?'], queued: ['y', '… queued'], done: ['b', '✓ done'], failed: ['r', '✕ failed'], cancelled: ['', '⊘ cancelled'], 'ended?': ['y', '? ended'] };

  function lock(msg) {
    clearTimeout(timer);
    app.innerHTML = `<div class="lock"><b style="letter-spacing:.14em;color:var(--g)">TAB LIVE</b><p class="sub">what Tab is building for you, live. mama only.</p>
      <input id="pc" type="password" autocomplete="current-password" placeholder="dev passcode"><button class="btn" id="go">unlock</button><p class="sub" id="lm">${esc(msg || '')}</p></div>`;
    const go = () => { const v = app.querySelector('#pc').value.trim(); if (!v) return; localStorage.setItem(KEY, v); poll(); };
    app.querySelector('#go').onclick = go; app.querySelector('#pc').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }

  function card(b) {
    const [tn, tl] = ST[b.status] || ['', b.status];
    const live = b.status === 'running' || b.status === 'stalled?';
    const idle = live ? age(b.last_active) : null;
    const p = b.progress;
    const pct = p && p.total ? Math.round((100 * p.done) / p.total) : null;
    const runS = live && b.started ? age(b.started) : b.run_s;
    let steps = '';
    if (p && p.total) {
      const firstOpen = p.steps.findIndex((s) => !s.done);
      steps = `<div class="prog" title="${p.done} of ${p.total} steps done"><i style="width:${pct}%"></i></div>
        <div class="row sub mono"><span>${p.done}/${p.total} steps · ${pct}%</span></div>
        <ul class="steps">${p.steps.map((s, i) => `<li class="${s.done ? 'd' : i === firstOpen ? 'c' : ''}">${s.done ? '✓' : i === firstOpen ? '▸' : '·'} ${esc(s.name)}</li>`).join('')}</ul>`;
    } else steps = `<div class="row sub">${live ? 'no step list from this builder yet' : ''}${b.steps_taken != null ? `${live ? ' · ' : ''}${b.steps_taken} actions` : ''}</div>`;
    const cur = p && p.current ? p.current : '';
    return `<div class="card ${b.status === 'stalled?' ? 'stall' : live ? 'run' : 'old'}">
      <div class="t">${esc(b.title)}</div>
      <div class="row"><span class="pill ${tn}">${tl}</span>
        ${live ? `<span class="pill ${tone(idle)}"><span class="dot ${tone(idle)}"></span> active ${idle == null ? '–' : dur(idle) + ' ago'}</span>` : `<span class="sub">ended ${b.ended ? ago(b.ended) : b.last_active ? ago(b.last_active) : ''}</span>`}
        <span class="sub mono">⏱ ${dur(runS)}</span><span class="sub">#${esc(b.id)}</span></div>
      ${steps}${cur && cur !== 'done' ? `<div class="cur">${esc(cur)}</div>` : ''}
      ${b.error ? `<div class="row" style="color:var(--r)">${esc(b.error)}</div>` : ''}
      ${b.commits && b.commits.length ? `<div class="row sub">commits: ${b.commits.map((c) => `<span class="sha">${esc(c)}</span>`).join(' ')}</div>` : ''}
    </div>`;
  }

  function spark(hist, idx, color) {
    const pts = hist.filter((h) => h[idx] != null); if (pts.length < 2) return '<svg></svg>';
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
    const xy = pts.map((h) => `${(((h[0] - t0) / (t1 - t0 || 1)) * 300).toFixed(1)},${(58 - (Math.min(100, h[idx]) / 100) * 56).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 300 60" preserveAspectRatio="none"><polyline points="${xy}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function render(d) {
    const live = d.builders.filter((b) => b.status === 'running' || b.status === 'stalled?' || b.status === 'queued');
    const old = d.builders.filter((b) => !live.includes(b));
    const fresh = age(d.now);
    const head = d.git.commits[0];
    const dep = head && head.deploy;
    const box = d.box;
    const ncomRecent = (d.ncom || []).filter((m) => age(m.at) < 6 * 3600).slice(-6);
    app.innerHTML = `
    <div class="bar"><span class="dot ${fresh < 10 ? 'g' : fresh < 30 ? 'y' : 'r'}"></span><b>TAB LIVE</b>
      <span class="sub">${live.filter((b) => b.status !== 'queued').length} building · updated ${dur(fresh)} ago</span>
      ${d.tab_replying ? '<span class="pill m">💬 Tab is replying to your texts</span>' : ''}
      ${head ? `<span class="pill ${dep ? (dep.state === 'success' ? 'g' : dep.state === 'failure' || dep.state === 'error' ? 'r' : 'y') : ''}">site <span class="sha">${esc(head.sha)}</span> ${dep ? esc(dep.state === 'success' ? 'live ✓' : dep.state) : 'no deploy yet'}</span>` : ''}
    </div>
    ${ncomRecent.length ? `<h2>📡 mama → Tab (NCOM_Sys)</h2><div class="ncom">${ncomRecent.map((m) => `<div><span class="sub">${hhmm(m.at)}</span> ${m.from === 'mama' ? '<b style="color:var(--m)">mama →</b>' : '<b style="color:var(--g)">NCOM_Sys:</b>'} ${esc(m.text)}</div>`).join('')}</div>` : ''}
    <h2>Building now (${live.length})</h2>
    <div class="grid">${live.map(card).join('') || '<div class="card sub">nothing running right now</div>'}</div>
    ${d.queue && d.queue.length ? `<h2>Waiting for a builder (${d.queue.length})</h2><div class="grid">${d.queue.map((q) => `<div class="card"><div class="t">${esc(q.ask)}</div><div class="row sub">${q.at ? 'asked ' + ago(q.at) : ''}${q.note ? ' · ' + esc(q.note) : ''}</div></div>`).join('')}</div>` : ''}
    <h2>Finished in the last 3 h (${old.length})</h2>
    <div class="grid">${old.map(card).join('') || '<div class="card sub">none</div>'}</div>
    <h2>Commits + deploys</h2>
    <div class="strip">${d.git.commits.map((c) => { const s = c.deploy && c.deploy.state; const tn = s === 'success' ? 'g' : s === 'failure' || s === 'error' ? 'r' : s ? 'y' : ''; return `<div class="card"><div class="row" style="margin:0"><span class="sha">${esc(c.sha)}</span><span class="pill ${tn}">${s ? esc(s) : 'no deploy'}</span><span class="sub">${ago(c.at)}</span></div><div class="sub" style="margin-top:4px;max-height:4.4em;overflow:hidden">${esc(c.msg)}</div></div>`; }).join('')}</div>
    <h2>Jena's box</h2>
    <div class="two">
      <div class="card"><div class="row" style="margin:0"><span>CPU <b class="mono" style="color:var(--g)">${box.cpu ?? '–'}%</b></span><span>mem <b class="mono" style="color:var(--b)">${box.mem}%</b></span><span class="sub">disk ${box.disk_free_gb} GB free · load ${box.load.toFixed(2)}</span></div>
        <div style="position:relative">${spark(box.hist, 1, '#3ddc84')}<div style="position:absolute;inset:0">${spark(box.hist, 2, '#58a6ff')}</div></div>
        <div class="sub">last 3 min · <span style="color:var(--g)">cpu</span> <span style="color:var(--b)">mem</span></div>
        <div class="sub" style="margin-top:6px">${box.top.map((p) => `${esc(p.name)} <b class="mono">${p.cpu}%</b>`).join(' · ')}</div></div>
      <div class="card"><div class="svc">${box.services.map((s) => `<span><span class="dot ${s.state === 'active' ? 'g' : s.state === 'activating' || s.state === 'reloading' ? 'y' : 'r'}"></span>${esc(s.name)}</span>`).join('')}</div></div>
    </div>
    <h2>Errors + incidents (${d.errors.length})</h2>
    <div class="card feed" id="feed">${d.errors.slice().reverse().map((e) => `<div><span class="sub">${hhmm(e.at)}</span> <b>${esc(e.src)}</b> ${esc(e.msg)}</div>`).join('') || '<span class="sub">no errors in the last 10 min</span>'}</div>
    <p class="sub" style="text-align:center;margin-top:14px">from her box every 3 s · bars move only when a builder finishes a real step</p>`;
  }

  async function poll() {
    clearTimeout(timer);
    const key = localStorage.getItem(KEY);
    if (!key) return lock();
    try {
      const t0 = Date.now();
      const r = await fetch('/api/tablive', { headers: { 'X-Jena-Key': key }, cache: 'no-store' });
      if (r.status === 401) { localStorage.removeItem(KEY); return lock('wrong passcode, try again'); }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      skew = (t0 + Date.now()) / 2 - Date.parse(d.now);
      last = d; lastOk = Date.now(); fails = 0;
      const sc = document.getElementById('feed')?.scrollTop || 0;
      render(d);
      const f = document.getElementById('feed'); if (f) f.scrollTop = sc;
    } catch (e) {
      fails++;
      if (last) { render(last); app.querySelector('.bar')?.insertAdjacentHTML('beforeend', `<span class="pill r">box not answering (${esc(e.message)}) · retrying</span>`); }
      else app.innerHTML = `<div class="lock"><b style="color:var(--g)">TAB LIVE</b><p class="sub">her box isn't answering: ${esc(e.message)} · retrying every 3 s</p></div>`;
    }
    timer = setTimeout(poll, document.hidden ? 10000 : 3000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  poll();
})();
