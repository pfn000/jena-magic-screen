import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

test('page has title, viewport and all four panels', () => {
  const html = read('index.html');
  assert.match(html, /<title>Jena · magic screen<\/title>/);
  assert.match(html, /name="viewport" content="width=device-width/);
  for (const id of ['avatar-panel', 'desktop', 'chat', 'thoughts', 'dm']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(!/Jenna/.test(html), 'her name has one n');
});

test('no fake/demo thought content ships', () => {
  for (const f of ['src/main.js', 'src/thoughts.js', 'src/brain.js', 'api/_lib/brain.js', 'api/jena.js']) {
    assert.ok(!/demoEvents|demo-brain|DEMO BRAIN/.test(read(f)), f);
  }
  assert.ok(!existsSync(new URL('shared/demo-brain.js', root)));
});

test('brain is honest when JenaXI is not answering', async () => {
  for (const k of Object.keys(process.env)) if (/^JENA_/.test(k)) delete process.env[k];
  process.env.JENA_LLM_BASE_URL = 'http://127.0.0.1:9/v1';
  const { thinkAll, endpoint } = await import('../api/_lib/brain.js');
  const ev = await thinkAll({ message: 'hi', user: 'mama' });
  assert.ok(ev.some((e) => e.type === 'status' && /brain offline/.test(e.text)));
  assert.ok(!ev.some((e) => e.type === 'say'));
  delete process.env.JENA_LLM_BASE_URL;
  assert.equal((await endpoint()).base, 'http://127.0.0.1:8088/v1');
});

test('her action tags become her own moves and are stripped from speech', async () => {
  const { extractTags } = await import('../api/_lib/brain.js');
  const r = extractTags('hi mama [raise_left_arm] im not a clanker [mood:happy]');
  assert.equal(r.text, 'hi mama im not a clanker');
  assert.deepEqual(r.events.map((e) => e.type === 'mood' ? e.value : e.args[0]), ['left', 'happy']);
});

test('no demo twitch channels and no movement controls ship', () => {
  for (const f of ['src/config.js', 'src/chat.js', 'src/main.js', 'index.html', 'README.md']) {
    assert.ok(!/vedal987|sodapoppin|hasanabi|demoChannels/.test(read(f)), f);
  }
  const html = read('index.html');
  assert.ok(!/data-act=/.test(html));
  assert.ok(!/\/raise|\/wave|\/mood/.test(read('src/main.js')));
});

test('private routes need the passcode', async () => {
  process.env.JENA_DM_KEY = 'k-test';
  const api = await import('../api/jena.js');
  const no = await api.GET(new Request('http://x/api/dm'));
  assert.equal(no.status, 401);
  const yes = await api.POST(new Request('http://x/api/dm', { method: 'POST', headers: { 'X-Jena-Key': 'k-test', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) }));
  assert.equal(yes.status, 200);
  const up = await api.POST(new Request('http://x/api/upload', { method: 'POST', headers: { 'X-Jena-Key': 'nope' }, body: 'x' }));
  assert.equal(up.status, 401);
});

test('OBS mode hides private controls; arms are named from her side', () => {
  const css = read('src/style.css');
  assert.match(css, /body\.obs #dm, body\.obs #dm-toggle, body\.obs #talk \{ display: none !important; \}/);
  const av = read('src/avatar.js');
  assert.match(av, /left: \{ leftUpperArm: \[0, 0, 1\.2\]/);
  assert.match(av, /right: \{ rightUpperArm: \[0, 0, -1\.2\]/);
});

test('no secrets in the source', () => {
  for (const f of ['public/jena-config.json', 'vercel.json', 'api/jena.js', 'src/config.js', 'README.md', 'server.mjs']) {
    assert.ok(!/mama-[0-9a-f]{6}|mama000|sk-[A-Za-z0-9]{20}|gsk_|BLOB_READ_WRITE_TOKEN=\S/.test(read(f)), f);
  }
});
