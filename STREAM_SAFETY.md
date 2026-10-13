# Stream safety

Saidie, 2026-10-13: *"even if the website refreshes or the website updates in its back ends, the stream won't stop."*

The stream is the OBS browser source on `https://jena-magic-screen.vercel.app/?obs=1`. This is what keeps it up.

## A site deploy never touches the OBS page

- `src/updates.js` polls `/api/version`. In `?obs=1` it shows **nothing** (no banner, no badge) and **never reloads**. The 10 s countdown and auto-reload are only for the normal view.
- `src/refresh.js` (`softReloadTo`) is only reached from the update banner, and the OBS page has none.
- The dev panel (with its "reload" link) and the deploy bar are never built in `?obs=1` (`src/main.js`).
- A new version reaches the OBS page only when mama presses **📺 reload OBS view** in the dev panel (the *deploys* tab). That POSTs `/api/tablive?what=obs-reload` (mama only), which writes a timestamp on her box (`/box/tab-live/obs-reload`, kept in `~/tab/state/obs_reload.json`). The OBS page polls the public `/api/tablive?what=obs` every 20 s and reloads **once** when the mark is newer than the one it started with (`src/obsguard.js`). A page started by that reload remembers the mark, so it cannot loop.
- The OBS page loads its JS once. Old asset files vanishing after a deploy doesn't matter: the only lazy chunk (noVNC) is for mama's takeover, which the OBS page never uses.

## The OBS page survives backend changes and outages

- **Config.** `src/config.js` keeps the last `/api/config` that named her box in localStorage (`jena.lastConfig`). If the API is down, slow (8 s timeout), or answers without a box or in an unexpected shape, the page still comes up whole with the last good box and desktop address.
- **Desktop stream** (`src/desktop.js`, public mode). Frames swap only once the new one has decoded, so the panel never blanks. On failure the last frame stays up with a small reconnecting dot. Retries back off up to 30 s, and every 3rd failure re-asks `/api/config` for a new tunnel address. "Napping" shows only if her box itself reported stale frames for 60 s+, never just because the tunnel or API is unreachable.
- **Avatar.** She is rendered locally and needs no server after load. If WebGL fails or stalls, a still picture shows instead (`src/avatar.js`, `src/main.js`).
- **Voice and chat overlay.** These keep their last state. Requests that fail are dropped quietly.
- **Brain-restarting pill.** Not shown in `?obs=1`: nothing about her plumbing goes out on stream.
- **Box address.** It survives redeploys. The box POSTs its signed address to `/api/box` every 2 min. The site republishes it to the ntfy relay when the relay is behind. The box also commits it to the `box-state` branch. Cold instances take the newest valid signature from either source (`api/_lib/boxlink.js`).

## Nothing on a site deploy restarts box services (audit, 2026-10-13)

- No webhook from GitHub or Vercel reaches the box. A deploy is Vercel building static files plus one serverless function; the box learns nothing about it.
- `jena-gateway` (box/jena-gateway.mjs) restarts **only the tunnel**, and only when its public URL fails 4 checks in a row (≥90 s). It never restarts itself or other units.
- `jena-tunnel-watchdog.timer` (/usr/local/bin/jena-tunnel-watchdog.sh, every 2 min) **was a stream risk**. It took the URL from the last 20 lines of the gateway journal. Once that line scrolled away it read "no URL" and restarted the tunnel **and the gateway**. Fixed 2026-10-13: it reads the gateway's `/status` (fallback: the cloudflared log) and restarts only the tunnel, only when the public URL really fails twice 5 s apart.
- `jena-watchdog` (box/watchdog) restarts a unit only after it **crashes or flaps** (≥3 crash/down events in 10 min). Its rollback step is about box files changing, not site deploys.
- `jena-desk` hot-reloads her skills module from her repo **without restarting** (`hot_reload_skills`). "Update my packages" restarts only her MCP helper processes, not the desk or the stream.
- `jena-memory-mirror.timer`, `jena-auths-sync.timer`, the `box-state` push and the Kaggle tick only read or write files and git branches. They restart nothing.
- What remains is people: a builder restarting `jena-gateway`, `jena-desk`, `jena-novnc` or `jena-vnc` by hand drops the desktop stream for a few seconds. The OBS page holds the last frame and reconnects by itself. While streaming, those restarts should wait.
