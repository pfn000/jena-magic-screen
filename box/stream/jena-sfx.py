#!/usr/bin/env python3
"""Jena's soundboard on her box: play one meme clip so it is heard on her live stream.

  jena-sfx play vine-boom [--why "that reveal"]     play by id (or words: "play the vine boom", "bruh")
  jena-sfx pick "chat said gg we won"               which clip fits a moment (prints it, plays nothing)
  jena-sfx list                                     the clips, their tags and when to use them
  jena-sfx status                                   is a stream sink up, what was played lately, limits left
  jena-sfx clapback "<her line>" [--to "<what chat said>"]   a sound AFTER her clapback line (clean lines only)

Same rules as the page soundboard (src/soundboard.js): at least 20 s between sounds, at most 4 in 5 minutes,
never the same clip twice within a minute, never for a private (mama) run (--private refuses). Kid-safe clips only.
Where it is heard: the stream compositor's own audio sink (box/stream/jena-stream.sh, /tmp/jena-stream/pulse),
so it goes out with the stream. With no stream running nothing plays and it says so (exit 4).
Clapbacks: one clapback sound per 90 s on top of the rules above; a line with a slur or anything sexual never gets a
sound (she out-roasts clean instead); same detector as the site (api/_lib/memes.js clapbackSound).
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

DIRTY = re.compile(r"\b(n[i1!*]gg\w*|f[a@*4]gg?\w*|retard\w*|tranny|k[i1]ke|sp[i1]c|ch[i1]nk|wetback|beaner|r[a@]pe\w*|sex\w*|porn\w*|nude\w*|naked|horny|boob\w*|tits?|dick|cock|pussy|cum|thot|slut\w*|whore\w*|onlyfans|daddy|kys|kill yo(?:ur)?self)\b", re.I)
BAIT = re.compile(r"\b(trash|garbage|mid|cringe|npc|bot|ratio|you suck|u suck|ur (?:so )?(?:bad|dumb|mid)|you'?re (?:so )?(?:bad|dumb|mid|boring)|stupid|dumb|loser|noob|washed|fell off|clown|L)\b", re.I)
COMEBACK = re.compile(r"\b(imagine|couldn'?t be me|who asked|says the (?:one|guy|person|kid)|ratio|cope|skill issue|sit (?:down|tf down)|cooked|L ?\+|try again|stay mad|keep crying|that'?s rich|bold of you|(?:you(?:'re| are)|ur) (?:just )?(?:jealous|mad|pressed)|mad cuz|caught in 4k|no one asked|nobody asked)\b", re.I)
CLAP_GAP = int(os.environ.get("JENA_CLAPBACK_GAP_S", "90"))

def clapback(said, heard, snd):   # mirrors api/_lib/memes.js clapbackSound
    s, h = str(said or ""), str(heard or "")
    if not s.strip() or DIRTY.search(s): return None, "dirty" if s.strip() else "empty"
    if re.search(r"\b(date|kiss|crush|cute|babe|marry|girlfriend|boyfriend|love you)\b", h + " " + s, re.I): return None, "romantic"
    clap = COMEBACK.search(s) or (BAIT.search(h) and re.search(r"\b(you|your|you'?re|ur|u)\b", s, re.I) and re.search(r"[!?]|\b(lol|lmao|bro|bestie|chat)\b", s, re.I))
    if not clap: return None, "not a clapback"
    if re.search(r"\b(skill issue|too easy|built different|ez|cooked)\b", s, re.I): sid = "rizz"
    elif re.search(r"\b(ratio|L ?\+|who asked|nobody asked|no one asked)\b", s, re.I): sid = "emotional-damage"
    else: sid = "vine-boom" if len(s) % 2 else "emotional-damage"
    # no-repeat: if that clip is one she just used, take its sibling instead of the same sound again
    try:
        last = [p["id"] for p in json.load(open(STATE)).get("played", []) if time.time() - p["at"] < 300][-3:]
        if sid in last:
            alt = [x for x in ("vine-boom", "emotional-damage", "rizz" if sid == "rizz" else "vine-boom") if x != sid and x not in last and x in snd]
            if alt: sid = alt[0]
    except Exception: pass
    return (sid if sid in snd else None), None

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
    # no-repeat (Saidie: no loops): not one of the last 3 sounds, and not again inside 3 minutes
    if sid in [p["id"] for p in recent[-3:]] or any(p["id"] == sid and now - p["at"] < 180 for p in recent): return "played recently (no repeats)"
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
    clap = False
    if cmd == "clapback":
        args = argv[1:]; heard = ""
        if "--to" in args: i = args.index("--to"); heard = " ".join(args[i + 1:i + 2]); del args[i:i + 2]
        said = " ".join(a for a in args if a != "--private")
        sid, no = clapback(said, heard, snd)
        if not sid:
            rec = {"at": round(time.time(), 1), "clapback": said[:120], "played": False, "refused": {"dirty": "never a sound on a slur or anything sexual (she out-roasts clean instead)", "romantic": "never on anything romantic"}.get(no, no or "no clip")}
            log(rec); out(rec, 2)
        argv = ["play", sid, "--why", "clapback"] + (["--private"] if "--private" in args else []); cmd = "play"; clap = True
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
        if clap:
            last = max([p["at"] for p in st.get("clapbacks", []) if now - p["at"] < 3600] or [0])
            if now - last < CLAP_GAP: return "one clapback sound per %d s" % CLAP_GAP
        no = refuse(st, sid, rules, now)
        if not no and clap: st["clapbacks"] = [p for p in st.get("clapbacks", []) if now - p["at"] < 3600] + [{"at": now, "id": sid}]
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
