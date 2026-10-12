// The thought process chain panel: each run is a card; steps stream in one at a time.
// Only real events: what people say to her, file drops, her own movements, what she sees of herself,
// and what her brain (JenaXI) actually answers. Nothing is invented.
const ICON = { notice: '📥', think: '🧠', tool: '🔧', feel: '💢', plan: '🗺️', say: '💬', status: '⚠️', body: '🤸', see: '👁️', sense: '🫧', private: '🔒' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const EMPTY = '<p class="empty">Nothing yet. Real events show up here as they happen: what you say to Jena, chat that mentions her, file drops, her own moves, what she sees of herself, and what her brain answers.</p>';

export class ThoughtChain {
  constructor(root, { obs = false } = {}) {
    this.list = root.querySelector('.thought-list');
    this.badge = root.querySelector('.brain-badge');
    this.obs = obs;
    this.max = 10;
    this.selfCard = null;
    this.list.innerHTML = EMPTY;
  }

  // health: {online, detail}
  setHealth(h) {
    const online = !!h?.online;
    const loading = !online && h?.detail === 'JenaXI is loading';
    this.online = online;
    this.badge.textContent = online ? 'JenaXI online' : loading ? 'JenaXI waking up…' : 'JenaXI-0 is training — brain offline';
    this.badge.title = online ? 'her own model is answering' : 'her brain (JenaXI.gguf on llama-server) is not answering yet; checked every 15 s';
    this.badge.classList.toggle('is-live', online);
    this.badge.classList.toggle('is-off', !online);
  }

  // trigger: {user, source, text|message, attachment, private, channel}
  start(trigger) {
    this.list.querySelector('.empty')?.remove();
    this.selfCard = null;
    const card = document.createElement('article');
    card.className = 'run';
    const src = trigger.source === 'twitch' ? `#${trigger.channel || 'chat'}` : trigger.private ? 'private' : trigger.source === 'stage' ? 'talk box' : trigger.source || 'stage';
    const who = esc(trigger.user || 'someone');
    const said = trigger.text || trigger.message || '';
    let line;
    if (trigger.private && (this.obs || !said)) line = `<b>${who}</b> sent a private message`;
    else if (trigger.attachment) line = `<b>${who}</b> dropped 📎 ${esc(trigger.attachment.name)}${said ? ` <i>${esc(said.slice(0, 80))}</i>` : ''}`;
    else line = `<b>${who}:</b> ${esc(said.slice(0, 160))}`;
    card.innerHTML = `<header><span class="who">event</span><span class="src">${esc(src)}</span><span class="time">${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></header>
      <p class="trigger">${line}</p>${trigger.thumb ? `<img class="thumb" src="${esc(trigger.thumb)}" alt="">` : ''}<ol class="steps"></ol>`;
    return this.mount(card);
  }

  // Jena's own body + self-vision log: consecutive entries share one card.
  self(kind, text) {
    // the same thought twice in a row (or again within a minute) isn't news
    const now = Date.now();
    if (text === this.lastSelf && now - this.lastSelfAt < 60000) return;
    this.recentSelf = (this.recentSelf || []).filter((r) => now - r.t < 60000);
    if (this.recentSelf.some((r) => r.text === text)) return;
    this.recentSelf.push({ text, t: now });
    this.lastSelf = text; this.lastSelfAt = now;
    if (!this.selfCard || !this.selfCard.isConnected || this.selfCard.querySelectorAll('.step').length >= 6) {
      this.list.querySelector('.empty')?.remove();
      const card = document.createElement('article');
      card.className = 'run self is-done';
      card.innerHTML = `<header><span class="who">Jena</span><span class="src">her body</span><span class="time">${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></header><ol class="steps"></ol>`;
      this.selfCard = card;
      this.mount(card);
    }
    this.addStep(this.selfCard.querySelector('.steps'), kind, text);
  }

  mount(card) {
    this.list.appendChild(card);
    while (this.list.children.length > this.max) this.list.firstElementChild.remove();
    this.scroll();
    const steps = card.querySelector('.steps');
    return {
      step: (kind, text) => this.addStep(steps, kind, text),
      done: () => card.classList.add('is-done'),
    };
  }

  addStep(steps, kind, text) {
    const li = document.createElement('li');
    li.className = `step k-${kind}`;
    li.innerHTML = `<span class="ico">${ICON[kind] || '•'}</span><span class="txt">${esc(text)}</span>`;
    steps.appendChild(li);
    this.scroll();
  }

  scroll() {
    this.list.scrollTo({ top: this.list.scrollHeight, behavior: 'smooth' });
  }
}
