#!/usr/bin/env python3
"""Weekly refresh of Jena's meme file (box side). Run by jena-memes.timer (weekly, nice 19, as her own user).

What it does, honestly:
 1. Re-reads each meme's own source page (Know Your Meme og:description, or the Wikipedia summary API) and updates
    its "meaning" when the page answers; a page that does not answer leaves the old text.
 2. Reads Know Your Meme's front page for memes it does not know yet and lists them under "trending" as
    CANDIDATES (kid_safe "unreviewed"). Candidates never reach her brain: only "memes" do, and a candidate moves
    there by a person (or Tab) reviewing it. Anything whose name, slug or text trips the crude/hateful word list is
    dropped outright and noted in "dropped".
 3. X #memes / #shitposts: read only when her X is signed in (an auth_token cookie for x.com in her Firefox
    profile). Today it is not, so the run records "X skipped: not signed in". When she is signed in the run
    records that too; reading X itself needs her browser and is not done by this script.
Writes /home/jena/learned/memes.json (+ memes.md, readable notes) and appends a line to memes_refresh.log there.
The site's copy (public/memes.json -> api/_lib/memes-data.js via memes_build.py) is refreshed from the box copy at
the next site push:  cp /home/jena/learned/memes.json public/memes.json && python3 box/stream/memes_build.py .
Usage: memes_refresh.py [--seed public/memes.json] [--out DIR] [--max-pages N] [--dry]"""
import argparse, datetime, html, json, os, re, sqlite3, shutil, sys, tempfile, time, urllib.parse, urllib.request

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156 Safari/537.36 jena-memes/1"
BAD = re.compile(r"(sex|porn|nude|naked|horny|hentai|nsfw|fuck|shit|cum|dick|penis|vagina|boob|tits|ass\b|rape|nazi|hitler|"
                 r"racis|slur|nigg|fag|retard|kill yourself|kys|suicide|gore|drug|weed|cocaine|onlyfans|thot|simp|waifu|"
                 r"rule 34|lewd|kink|fetish|incel|copypasta|gooner|gyatt|edging|loss\b|harambe|allegation)", re.I)
FF_PROFILES = ["/home/jena/.ffprofile", "/home/jena/.nos-ff"]

def get(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(2_000_000).decode("utf-8", "replace")

def og(page, prop):
    m = re.search(r"<meta[^>]+(?:property|name)=['\"]%s['\"][^>]+content=(?:'([^']*)'|\"([^\"]*)\")" % re.escape(prop), page)
    return html.unescape(m.group(1) if m.group(1) is not None else m.group(2)).strip() if m else ""

def fresh_meaning(src):
    if "knowyourmeme.com/memes/" in src:
        return og(get(src), "og:description")
    if "wikipedia.org/wiki/" in src:
        title = src.rsplit("/wiki/", 1)[1]
        d = json.loads(get("https://en.wikipedia.org/api/rest_v1/page/summary/" + title))
        return (d.get("extract") or "").strip()
    return ""

def x_signed_in():
    for p in FF_PROFILES:
        db = os.path.join(p, "cookies.sqlite")
        if not os.path.exists(db): continue
        try:
            tmp = tempfile.mktemp(suffix=".sqlite"); shutil.copy(db, tmp)   # Firefox holds a lock on the live file
            n = sqlite3.connect(tmp).execute("select count(*) from moz_cookies where host like '%x.com' and name='auth_token'").fetchone()[0]
            os.remove(tmp)
            if n: return p
        except Exception:
            pass
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", default="/usr/local/share/jena/memes.json")
    ap.add_argument("--out", default="/home/jena/learned")
    ap.add_argument("--max-pages", type=int, default=80)
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    cur = os.path.join(a.out, "memes.json")
    data = json.load(open(cur if os.path.exists(cur) else a.seed))
    today = datetime.date.today().isoformat()
    rep = {"at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), "refreshed": 0, "unchanged": 0, "failed": 0,
           "new_candidates": 0, "dropped": 0}
    pages = 0
    for m in data["memes"]:
        src = m.get("source") or ""
        if not src.startswith("http") or pages >= a.max_pages: continue
        pages += 1
        try:
            t = re.sub(r"\s+", " ", fresh_meaning(src))
            if len(t) > 80 and not BAD.search(t.replace(m.get("meaning", ""), "")):
                if t[:150] != (m.get("meaning") or "")[:150]: m["meaning"] = t; rep["refreshed"] += 1
                else: rep["unchanged"] += 1
                m["checked"] = today
            else: rep["unchanged"] += 1
        except Exception:
            rep["failed"] += 1
        time.sleep(1.0)   # polite: one page a second
    # new memes on Know Your Meme's front page -> candidates only
    known = {re.sub(r"[^a-z0-9]+", "-", m["name"].lower()).strip("-") for m in data["memes"]}
    known |= {re.sub(r"[^a-z0-9]+", "-", x["name"].lower()).strip("-") for x in data.get("excluded", [])}
    known |= {c["slug"] for c in data.get("trending", []) if c.get("slug")}
    dropped = data.setdefault("dropped", [])
    try:
        front = get("https://knowyourmeme.com/")
        slugs = list(dict.fromkeys(re.findall(r'href="/memes/([a-z0-9-]{3,80})"', front)))
        for slug in slugs[:25]:
            if slug in known or slug in ("memes", "meme") or slug.startswith(("page", "sort", "all", "popular", "submissions", "trending")): continue
            if BAD.search(slug.replace("-", " ")): dropped.append({"slug": slug, "why": "crude/hateful word", "at": today}); rep["dropped"] += 1; continue
            try:
                p = get("https://knowyourmeme.com/memes/" + slug); time.sleep(1.0)
                name, desc = og(p, "og:title").replace(" | Know Your Meme", ""), og(p, "og:description")
            except Exception:
                continue
            if not name or BAD.search(name + " " + desc):
                dropped.append({"slug": slug, "why": "crude/hateful word", "at": today}); rep["dropped"] += 1; continue
            data.setdefault("trending", []).append({"name": name, "slug": slug, "meaning": desc, "source": "https://knowyourmeme.com/memes/" + slug,
                                                    "seen": today, "kid_safe": "unreviewed"})
            rep["new_candidates"] += 1
    except Exception as e:
        rep["kym_front"] = "failed: %s" % e
    data["dropped"] = dropped[-200:]
    data["trending"] = data.get("trending", [])[-60:]
    xp = x_signed_in()
    rep["x"] = ("X signed in (%s): reading #memes/#shitposts needs her browser, not done by this script" % xp) if xp else "X skipped: not signed in"
    srcs = [s for s in data.get("sources", []) if not s.startswith("X ")]
    data["sources"] = srcs + ["X #memes / #shitposts: " + ("signed in, not read by the weekly script yet" if xp else "NOT read, her X isn't signed in")]
    data["refreshed"] = rep["at"]
    if a.dry: print(json.dumps(rep)); return
    os.makedirs(a.out, exist_ok=True)
    tmp = cur + ".tmp"; json.dump(data, open(tmp, "w"), indent=1, ensure_ascii=False); os.replace(tmp, cur)
    with open(os.path.join(a.out, "memes.md"), "w") as f:
        f.write("# My meme file (refreshed %s)\nKid-safe only. One meme reference per message at most, only when it fits.\n\n" % rep["at"])
        for m in data["memes"]:
            f.write("- **%s** (%s): %s How people use it: %s.%s\n" % (m["name"], m.get("year") or m.get("era") or "?", (m.get("meaning") or "")[:240],
                    m.get("how_used", ""), " Sound: %s." % m["sound"] if m.get("sound") else ""))
        if data.get("trending"):
            f.write("\n## New on Know Your Meme (not reviewed yet: don't use these until they are)\n")
            for c in data["trending"][-20:]: f.write("- %s (seen %s)\n" % (c["name"], c["seen"]))
    with open(os.path.join(a.out, "memes_refresh.log"), "a") as f: f.write(json.dumps(rep) + "\n")
    print(json.dumps(rep))

if __name__ == "__main__":
    main()
