#!/usr/bin/env python3
"""Mama's mid-action corrections for Jena's desktop agent (read side).

Her gateway (box/jena-gateway.mjs) appends one JSON line to /home/jena/.jena/mama_queue.jsonl when MAMA
(passcode-verified on her site, never public or Twitch chat) says "stop" or "no, do X instead" while Jena works:
  {"ts": 1791903970751, "kind": "stop", "do": null, "text": "stop", "from": "mama", "via": "chat"}
  {"ts": 1791903970770, "kind": "instead", "do": "open youtube", "text": "no, open youtube instead", "from": "mama", "via": "chat"}

Integration in jena_desk.py (owner integrates; 3 lines):
    from jena_mama_queue import MamaQueue
    MAMA = MamaQueue()
    # at the top of every step of a multi-step action / skill loop:
    m = MAMA.poll()
    if m:  # abort the current action; if m["do"] is set, run it as her next command (same path as a chat command)
        ...
poll() returns the newest unread instruction younger than max_age seconds (older ones are skipped, never replayed after a
restart) and remembers how far it read in /home/jena/.jena/mama_queue.offset. Read-only on the queue; no network, no deps.
"""
import json, os, time

QUEUE = os.environ.get('JENA_MAMA_QUEUE', '/home/jena/.jena/mama_queue.jsonl')


class MamaQueue:
    def __init__(self, path=QUEUE, max_age=90):
        self.path, self.max_age = path, max_age
        self.off_path = path.rsplit('.', 1)[0] + '.offset'
        try:
            self.off = int(open(self.off_path).read().strip() or 0)
        except Exception:
            self.off = os.path.getsize(path) if os.path.exists(path) else 0   # first run: start at the end, never replay

    def poll(self):
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return None
        if size < self.off:
            self.off = 0   # queue was truncated
        if size == self.off:
            return None
        with open(self.path, 'rb') as f:
            f.seek(self.off)
            chunk = f.read(size - self.off)
        end = chunk.rfind(b'\n') + 1   # only whole lines
        if not end:
            return None
        self.off += end
        try:
            with open(self.off_path, 'w') as f:
                f.write(str(self.off))
        except OSError:
            pass
        now, newest = time.time() * 1000, None
        for line in chunk[:end].splitlines():
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get('from') == 'mama' and m.get('kind') in ('stop', 'instead') and now - m.get('ts', 0) <= self.max_age * 1000:
                newest = m
        return newest


if __name__ == '__main__':   # self-test on a temp file
    import tempfile
    d = tempfile.mkdtemp(); p = os.path.join(d, 'q.jsonl'); open(p, 'w').close()
    q = MamaQueue(p)
    assert q.poll() is None
    with open(p, 'a') as f:
        f.write(json.dumps({'ts': time.time() * 1000 - 600000, 'kind': 'stop', 'from': 'mama'}) + '\n')   # stale: skipped
        f.write(json.dumps({'ts': time.time() * 1000, 'kind': 'instead', 'do': 'open youtube', 'from': 'mama'}) + '\n')
    m = q.poll(); assert m and m['do'] == 'open youtube', m
    assert q.poll() is None
    assert MamaQueue(p).poll() is None   # offset persisted: no replay after restart
    print('ok')
