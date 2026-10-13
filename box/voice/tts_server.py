# Jena's voice: Piper (free, local, MIT-licensed neural TTS) kept loaded in memory, on her own box.
# GET /tts?text=...&voice=hfc_female -> audio/mpeg. GET /voices -> what is installed. 127.0.0.1 only;
# the gateway passes /tts through for her site (signed requests only).
import io, json, os, re, subprocess, threading, time, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from piper import PiperVoice

HERE = os.path.dirname(os.path.abspath(__file__))
VOICES = {f.split('-')[1]: os.path.join(HERE, f) for f in os.listdir(HERE) if f.endswith('.onnx')}
DEFAULT = os.environ.get('JENA_VOICE', 'hfc_female')
loaded, lock = {}, threading.Lock()

def voice(name):
    name = name if name in VOICES else DEFAULT
    with lock:
        if name not in loaded: loaded[name] = PiperVoice.load(VOICES[name])
        return name, loaded[name]

def synth(text, name):
    name, v = voice(name)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        v.synthesize_wav(text, w)
    mp3 = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-ac', '1', '-b:a', '64k', '-f', 'mp3', 'pipe:1'], input=buf.getvalue(), capture_output=True, timeout=30).stdout
    return name, mp3

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == '/voices':
            body = json.dumps({'voices': sorted(VOICES), 'default': DEFAULT, 'engine': 'piper'}).encode(); ct = 'application/json'
        elif u.path == '/tts':
            text = re.sub(r'\s+', ' ', (q.get('text') or [''])[0])[:400].strip()
            if not text: self.send_response(400); self.end_headers(); return
            t0 = time.time()
            name, body = synth(text, (q.get('voice') or [DEFAULT])[0]); ct = 'audio/mpeg'
            self.send_response(200); self.send_header('Content-Type', ct); self.send_header('Content-Length', str(len(body)))
            self.send_header('X-Jena-Voice', f'piper/{name}'); self.send_header('X-Jena-TTS-Ms', str(int((time.time() - t0) * 1000))); self.end_headers(); self.wfile.write(body); return
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header('Content-Type', ct); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

if __name__ == '__main__':
    voice(DEFAULT)
    ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('PORT', '8095'))), H).serve_forever()
