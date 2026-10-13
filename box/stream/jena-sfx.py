#!/usr/bin/env python3
"""Jena's soundboard on her box: play one meme clip so it is heard on her live stream.

  jena-sfx play vine-boom [--why "that reveal"]     play by id (or words: "play the vine boom", "bruh")
  jena-sfx pick "chat said gg we won"               which clip fits a moment (prints it, plays nothing)
  jena-sfx list                                     the clips, their tags and when to use them
  jena-sfx status                                   is a stream sink up, what was played lately, limits left

Same rules as the page soundboard (src/soundboard.js): at least 20 s between sounds, at most 4 in 5 minutes,
never the same clip twice within a minute, never for a private (mama) run (--private refuses). Kid-safe clips only.
Where it is heard: the stream compositor's own audio sink (box/stream/jena-stream.sh, /tmp/jena-stream/pulse),
so it goes out with the stream. With no stream running nothing plays and it says so (exit 4).
Output is one JSON line. Exit 0 played / 2 refused (rate limit, unknown, private) / 4 no stream audio to play into."""
import fcntl, json, os, re, subprocess, sys, time

SOUNDS = os.environ.get("JENA_SOUNDS", "/usr/local/share/jena/sounds")
SINK_SOCK = os.environ.get("JENA_STREAM_PULSE", "/tmp/jena-stream/pulse/native")
STATE = os.environ.get("JENA_SFX_STATE", "/tmp/jena-sfx/state.json")
LOG = os.environ.get("JENA_SFX_LOG", "/tmp/jena-sfx/log.jsonl")
VOLUME = int(os.environ.get("JENA_SFX_VOLUME", "54000"))   # of 65536 (cubic): about -5 dB, the page's 0.55

def index():
    d = json.load(open(os.path.join(SOUNDS, "index.json")))
    return {s["id"]: s for s in d["sounds"] if s.get("kid_safe", True)}, d.get("rules", {})

def norm(s): return re.sub(r"[^a-z0-9 ]+", " ", str(s or "").lower()).strip()

def resolve(want, snd):
    w = norm(re.sub(r"^\s*(jena[\s,]+)?(!sfx\s+|play\s+)?", "", str(want), flags=re.I))
    w = re.sub(r"^(the|a|an|that)\s+", "", w)
    w = re.sub(r"\s+(sound effect|sound|sfx|noise)$", "", w).strip()
    if not w: return None
    wid = w.replace(" ", "-")
    if wid in snd: return wid
    for s in snd.values():
        if s["id"].startswith(wid) or w in s["id"].replace("-", " ") or w in [t.lower() for t in s.get("tags", [])]: return s["id"]
    return None

RULES = [(r"\b(bruh|bro what)\b", "bruh"), (r"\b(sus|suspicious|impostor|imposter)\b", "among-us-sus"),
         (r"\bemotional damage\b", "emotional-damage"), (r"\b(oof|ouch|rip)\b", "roblox-oof"),
         (r"\b(plot twist|dun dun)\b", "dun-dun-dun"), (r"\b(crashed|error|bluescreen|it broke|not responding)\b", "windows-error"),
         (r"\b(we won|i won|let'?s go+|gg|clutch|victory)\b", "mlg-airhorn"), (r"\b(pun|ba dum)\b", "ba-dum-tss"),
         (r"\b(yay|we did it|good news)\b", "yay"), (r"\bnope\b", "nope"), (r"\b(too easy|ez clap|built different|skill issue|get rekt|flex(ing)?|big w)\b", "rizz"), (r"\bhmm+\b", "minecraft-villager"), (r"\bwow+\b", "wow-owen-wilson")]

def pick(text, snd):   # mirrors api/_lib/memes.js pickSound: a clip only on a clear match, else none
    if re.search(r"\b(date|kiss|crush|cute|babe|marry|girlfriend|boyfriend|love you)\b", str(text or ""), re.I): return None   # never on anything romantic
    for rx, sid in RULES:
        if re.search(rx, str(text or ""), re.I) and sid in snd: return sid
    return None

def locked_state(fn):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    try: os.chmod(os.path.dirname(STATE), 0o1777)
    except OSError: pass
    with open(STATE + ".lock", "a+") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        try: st = json.load(open(STATE))
        except Exception: st = {"played": []}
        st.setdefault("played", [])
        res = fn(st)
        # written in place under the lock (a sticky /tmp dir refuses a rename over another user's file)
        with open(STATE, "a+") as f: f.seek(0); f.truncate(); json.dump(st, f)
        for p in (STATE, STATE + ".lock"):
            try: os.chmod(p, 0o666)
            except OSError: pass
        return res

def refuse(st, sid, rules, now):
    recent = [p for p in st["played"] if now - p["at"] < 300]
    st["played"] = recent
    if recent and now - recent[-1]["at"] < rules.get("min_gap_s", 20): return "too soon after the last one (%ds gap)" % rules.get("min_gap_s", 20)
    if len(recent) >= rules.get("max_per_5min", 4): return "enough sounds for now (%d in 5 min)" % rules.get("max_per_5min", 4)
    if recent and recent[-1]["id"] == sid and now - recent[-1]["at"] < 60: return "same sound twice in a row"
    return ""

def log(rec):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a") as f: f.write(json.dumps(rec) + "\n")
        os.chmod(LOG, 0o666)
    except OSError: pass

def out(rec, code):
    print(json.dumps(rec)); sys.exit(code)

def main(argv):
    if not argv or argv[0] in ("-h", "--help", "help"): print(__doc__); return
    snd, rules = index(); cmd = argv[0]
    if cmd == "list":
        for s in snd.values(): print("%-22s %4.1fs  %-40s %s" % (s["id"], s.get("dur", 0), ",".join(s.get("tags", [])), s.get("when", "")))
        return
    if cmd == "pick": out({"pick": pick(" ".join(argv[1:]), snd)}, 0)
    if cmd == "status":
        now = time.time()
        try: st = json.load(open(STATE))
        except Exception: st = {"played": []}
        recent = [p for p in st["played"] if now - p["at"] < 300]
        out({"stream_audio": os.path.exists(SINK_SOCK), "played_5min": recent, "left_5min": max(0, rules.get("max_per_5min", 4) - len(recent))}, 0)
    if cmd != "play": out({"played": False, "why": "unknown command %s" % cmd}, 2)
    args = argv[1:]; why = ""; private = False
    if "--why" in args: i = args.index("--why"); why = " ".join(args[i + 1:i + 2]); del args[i:i + 2]
    if "--private" in args: private = True; args.remove("--private")
    sid = resolve(" ".join(args), snd)
    rec = {"at": round(time.time(), 1), "want": " ".join(args), "id": sid, "why": why}
    if private: rec.update(played=False, refused="never for a private (mama) run"); log(rec); out(rec, 2)
    if not sid: rec.update(played=False, refused="unknown sound"); log(rec); out(rec, 2)
    if not os.path.exists(SINK_SOCK): rec.update(played=False, refused="no stream running (nothing to play into)"); log(rec); out(rec, 4)
    now = time.time()
    def claim(st):
        no = refuse(st, sid, rules, now)
        if not no: st["played"].append({"id": sid, "at": now, "why": why})
        return no
    no = locked_state(claim)
    if no: rec.update(played=False, refused=no); log(rec); out(rec, 2)
    env = dict(os.environ, PULSE_SERVER="unix:" + SINK_SOCK)
    f = os.path.join(SOUNDS, os.path.basename(snd[sid]["file"]))
    # mp3 -> raw PCM -> the stream sink (paplay can't read mp3)
    dec = subprocess.Popen(["ffmpeg", "-nostdin", "-v", "error", "-i", f, "-f", "s16le", "-ac", "2", "-ar", "44100", "-"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE)
    r = subprocess.run(["pacat", "--playback", "-d", "jena_stream", "--rate=44100", "--channels=2", "--format=s16le",
                        "--volume=%d" % VOLUME], stdin=dec.stdout, env=env, capture_output=True, timeout=20)
    dec.wait(timeout=5)
    rec.update(played=r.returncode == 0, dur=snd[sid].get("dur"))
    if r.returncode: rec["refused"] = "stream audio said: " + r.stderr.decode(errors="replace").strip()[-200:]
    log(rec); out(rec, 0 if r.returncode == 0 else 4)

if __name__ == "__main__":
    main(sys.argv[1:])
