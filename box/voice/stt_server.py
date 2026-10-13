#!/usr/bin/env python3
# Jena's ears: free, local speech-to-text on her own box (faster-whisper "small", int8, CPU), kept loaded.
#   POST /hear?user=<name>&learn=0|1&private=0|1   raw audio body (webm/opus, mp4/aac, ogg, wav; <= 2 MB, <= 30 s)
#     -> {"text", "lang", "duration_s", "ms", "saved"}
# The audio is transcribed in memory/tmp and deleted right away; it is never kept.
# learn=1 (the speaker ticked "help Jena learn how people talk") and not private: the TEXT (not the audio) is appended
# to ~/learned/speech_notes.jsonl, which her Kaggle training sync picks up for the next run. Mama's private (DM) voice
# messages are never saved. Listens on 127.0.0.1 only; her gateway lets only signed requests from her own site through.
import json, os, re, sys, tempfile, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HOME = os.environ.get('HOME', '/home/jena')
PORT = int(os.environ.get('JENA_STT_PORT', '8096'))
MODEL = os.environ.get('JENA_STT_MODEL', 'small')
NOTES = os.path.join(HOME, 'learned', 'speech_notes.jsonl')
MAX_BYTES, MAX_SECS = 2 * 1024 * 1024, 30.5
BAD = re.compile(r"\b(sex\w*|porn\w*|nude\w*|naked|nsfw|onlyfans|fetish\w*|erotic\w*|hentai|xxx|boob\w*|horny|kiss\w*|"
                 r"lingerie|bikini|hook ?up|date me|marry me|bae|babe|daddy|nazi\w*|suicide|self.?harm|gore|cocaine|meth|"
                 r"password\w*|credit card|ssn)\b", re.I)

from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
t0 = time.time()
model = WhisperModel(MODEL, device='cpu', compute_type='int8', cpu_threads=4, num_workers=1)
print(f'loaded whisper {MODEL} in {time.time() - t0:.1f}s', flush=True)
busy = threading.Semaphore(1)
waiting = [0]
stats = {'heard': 0, 'saved': 0, 'refused': 0, 'last_ms': None, 'model': MODEL, 'since': int(time.time() * 1000)}

def transcribe(data):
    fd, path = tempfile.mkstemp(prefix='hear-', dir='/tmp')
    try:
        with os.fdopen(fd, 'wb') as f: f.write(data)
        audio = decode_audio(path, sampling_rate=16000)
    finally:
        try: os.remove(path)
        except OSError: pass
    dur = len(audio) / 16000.0
    if dur > MAX_SECS: return None, dur, None
    if dur < 0.3: return '', dur, None
    segs, info = model.transcribe(audio, beam_size=1, vad_filter=True, condition_on_previous_text=False, language=None)
    text = ' '.join(s.text.strip() for s in segs).strip()
    return text, dur, info.language

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if urlparse(self.path).path in ('/health', '/hear/health'): return self.send(200, {'ok': True, **stats})
        self.send(404, {'error': 'not here'})
    def reply(self):
        # her real answer to a saved voice note, attached as its own line: {"reply_to": id, "reply": ...}
        try: b = json.loads(self.rfile.read(min(int(self.headers.get('Content-Length') or 0), 8192)) or b'{}')
        except Exception: return self.send(400, {'error': 'bad json'})
        nid, rep = str(b.get('id', ''))[:40], str(b.get('reply', ''))[:600].strip()
        if not nid or not rep: return self.send(400, {'error': 'id and reply needed'})
        try: lines = open(NOTES).read().splitlines()[-500:]
        except FileNotFoundError: lines = []
        recs = [json.loads(l) for l in lines if l.strip()]
        if not any(r.get('id') == nid for r in recs): return self.send(404, {'error': 'no such voice note'})
        if any(r.get('reply_to') == nid for r in recs): return self.send(200, {'ok': True, 'already': True})
        if BAD.search(rep): return self.send(200, {'ok': False, 'skipped': 'unsafe'})
        with open(NOTES, 'a') as f: f.write(json.dumps({'reply_to': nid, 'ts': int(time.time() * 1000), 'reply': rep}) + '\n')
        return self.send(200, {'ok': True})

    def do_POST(self):
        u = urlparse(self.path); q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == '/hear/reply': return self.reply()
        if u.path not in ('/hear',): return self.send(404, {'error': 'not here'})
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0: return self.send(400, {'error': 'no audio'})
        if n > MAX_BYTES: stats['refused'] += 1; return self.send(413, {'error': 'that recording is too big (2 MB max, about 30 s)'})
        data = self.rfile.read(n)
        if waiting[0] >= 2: stats['refused'] += 1; return self.send(429, {'error': "she's still listening to someone else, try again in a few seconds"})
        waiting[0] += 1
        try:
            with busy:
                t = time.time()
                try: text, dur, lang = transcribe(data)
                except Exception as e: return self.send(422, {'error': f"couldn't read that audio ({str(e)[:80]})"})
                ms = int((time.time() - t) * 1000)
        finally:
            waiting[0] -= 1
        if text is None: stats['refused'] += 1; return self.send(413, {'error': f'that recording is {dur:.0f} s; 30 s max'})
        stats['heard'] += 1; stats['last_ms'] = ms
        private = q.get('private') == '1'
        saved = False
        if text and q.get('learn') == '1' and not private and not BAD.search(text):
            rec = {'id': uuid.uuid4().hex[:12], 'ts': int(time.time() * 1000), 'user': re.sub(r'[^\w .-]', '', q.get('user', 'guest'))[:40] or 'guest', 'text': text[:600],
                   'lang': lang, 'duration_s': round(dur, 1), 'source': 'voice', 'consent': 'ticked "help Jena learn how people talk" on her site'}
            os.makedirs(os.path.dirname(NOTES), exist_ok=True)
            with open(NOTES, 'a') as f: f.write(json.dumps(rec) + '\n')
            saved = True; stats['saved'] += 1
        print(time.strftime('%H:%M:%S'), f'heard {dur:.1f}s in {ms}ms', 'private' if private else ('saved' if saved else 'not saved'), flush=True)
        self.send(200, {'id': rec['id'] if saved else None, 'text': text, 'lang': lang, 'duration_s': round(dur, 1), 'ms': ms, 'saved': saved, 'model': f'whisper-{MODEL} (local, on her box)'})

ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
