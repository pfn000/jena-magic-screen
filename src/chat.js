// Live Twitch chat, anonymous and read-only, over Twitch's IRC WebSocket. No account, no token.
// Only HER channel: TWITCH_CHANNEL on the server or ?twitch= in the URL. With none set, nothing connects.
// Light stream-safety mask (Jena is a teen character): slurs and sexual words get starred out.
const BLOCK = /\b(?:(?:n[i1!]gg|f[a@]gg|r[e3]t[a@]rd|tr[a@]nn[yi]|wh[o0]re|sl[u*]tt?|p[o0]rn|h[o0]rn[yi]|onlyfans|nud[e3])\w*|(?:k[i1]kes?|ch[i1]nks?|sp[i1]cs?|r[a@]p(?:e|ed|es|ing)|s[e3]x(?:y|ual)?|d[i1]cks?|c[o0]cks?|puss(?:y|ies)|t[i1]tt?(?:s|ies)|b[o0]{2}b(?:s|ies)?)\b)/gi;

export function clean(text) {
  return String(text).replace(BLOCK, (w) => w[0] + '•'.repeat(Math.max(2, w.length - 1)));
}

// Split a message into text and Twitch emote pieces using the IRC "emotes" tag (id:start-end,...).
export function emoteParts(text, tag) {
  if (!tag) return null;
  const chars = [...text];
  const spans = [];
  for (const group of tag.split('/')) {
    const [id, ranges] = group.split(':');
    for (const r of (ranges || '').split(',')) {
      const [a, b] = r.split('-').map(Number);
      if (Number.isFinite(a) && Number.isFinite(b)) spans.push({ id, a, b });
    }
  }
  if (!spans.length) return null;
  spans.sort((x, y) => x.a - y.a);
  const parts = [];
  let i = 0;
  for (const s of spans) {
    if (s.a > i) parts.push({ text: clean(chars.slice(i, s.a).join('')) });
    parts.push({ emote: s.id, alt: chars.slice(s.a, s.b + 1).join('') });
    i = s.b + 1;
  }
  if (i < chars.length) parts.push({ text: clean(chars.slice(i).join('')) });
  return parts;
}

export class TwitchChat {
  // Connects ONLY to the channel it's given (TWITCH_CHANNEL env or ?twitch=). No default, no hopping.
  constructor({ channel, onMessage, onStatus }) {
    this.channel = String(channel).toLowerCase().replace(/^#/, '').replace(/[^a-z0-9_]/g, '');
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.connect();
  }

  connect() {
    this.ws?.close();
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    this.ws = ws;
    this.onStatus?.({ state: 'connecting', channel: this.channel });
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 89999)}`);
      ws.send(`JOIN #${this.channel}`);
      this.onStatus?.({ state: 'joined', channel: this.channel });
    };
    ws.onmessage = (e) => {
      for (const line of String(e.data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
        const m = line.match(/^(?:@(\S+) )?:(\w+)!\S+ PRIVMSG #(\w+) :(.*)$/);
        if (!m || m[3].toLowerCase() !== this.channel) continue;
        const tags = Object.fromEntries((m[1] || '').split(';').map((kv) => kv.split('=')));
        let text = m[4];
        if (text.startsWith('\u0001ACTION ')) text = text.slice(8, -1);
        this.onMessage({ user: tags['display-name'] || m[2], color: tags.color || null, text: clean(text), parts: emoteParts(text, tags.emotes), channel: m[3], mod: tags.mod === '1' });
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.onStatus?.({ state: 'reconnecting', channel: this.channel });
      setTimeout(() => this.ws === ws && this.connect(), 3000);
    };
  }
}
