// Client side of the brain socket: POST {message, source, user, attachment} to the brain URL and
// read back NDJSON events (see api/_lib/brain.js). No fake fallback: if the API is unreachable,
// the stream says so.
export async function* think(url, input, key) {
  if (!url) {
    yield { type: 'step', kind: 'notice', text: `message received from ${input.user || 'someone'}` };
    yield { type: 'status', text: 'no Jena API on this host, so no brain' };
    yield { type: 'done' };
    return;
  }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Jena-Key': key } : {}) },
      body: JSON.stringify(input),
    });
    if (!r.ok || !r.body) throw new Error(String(r.status));
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) yield JSON.parse(line);
      }
    }
    if (buf.trim()) yield JSON.parse(buf);
  } catch (e) {
    yield { type: 'status', text: `couldn't reach Jena's API (${e.message})` };
    yield { type: 'done' };
  }
}
