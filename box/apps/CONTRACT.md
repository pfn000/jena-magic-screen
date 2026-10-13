# Jena apps: the N•OS contract (owner of this pipeline: Tab worker 5a4cbf29; N•OS shell: 4e60181d)

## The one file N•OS reads
`/home/jena/.jena/apps_status.json` is a JSON object keyed by app name. It is written atomically (tmp + rename,
under the lock file `apps_status.json.lock`), so a reader never sees half a file. Re-read it every 2–5 s, or on inotify
`IN_MOVED_TO`.

    {
      "st": {
        "status": "ready",            // queued | building | downloading | installing | ready | failed
        "progress": 100,              // 0-100
        "error": null,                // a plain-words reason when status == failed
        "title": "st terminal",
        "version": "0.9.2",
        "kind": "install",            // "install" = a real app; "output" = a Windows-only program's result (text)
        "exec": "/home/jena/Apps/st/bin/st-launch",              // what to launch (only when status == ready)
        "desktop_file": "/home/jena/.local/share/applications/jena-app-st.desktop",   // Name=, Icon= (freedesktop icon name), Exec=
        "path": "/home/jena/Apps/st",
        "run_url": "https://github.com/pfn000/jena-magic-screen/actions/runs/…",
        "updated": 1791923441         // epoch seconds
      }
    }

## Rules for the drawer / dock
- Show "setting up…" (with `progress`) ONLY while `status` is `building`, `downloading` or `installing`.
- `queued`: no icon and no "setting up…" yet. If you show it anywhere, show it as "waiting" in a list, never as an app.
- `ready`: the icon appears. Tapping it runs `exec` (the same command is the `.desktop` file's Exec=). Name and icon come from
  the `.desktop` file: `Name=`, and `Icon=` is a freedesktop icon name to resolve from your real icon set (Papirus/Adwaita).
  `kind: "output"` entries (Windows-only programs run on GitHub, e.g. `du-windows`) open their result text (Exec runs
  mousepad on `<path>/output.txt`).
- `failed`: no icon in the drawer. `error` is plain words for Settings → Apps (for example "not enough disk: 1.2 GB free …").
- An app missing from the file is not installed. Steam is not in it, because it is switched off until the disk resize
  (ops/apps/apps.json `"enabled": false`).
- Removing: `python3 /home/jena/jena-apps/installer.py remove <name>` deletes the app, its .desktop and its status row.

## Starting an install from N•OS (optional)
List the installable apps with `python3 /home/jena/jena-apps/installer.py list` (JSON: title, about, enabled, why_off).
Start one, detached, as user jena: `nice -n 19 python3 /home/jena/jena-apps/installer.py install <name>`. Respect your
own takeover gate: don't start one while `/home/jena/.jena/mama_takeover.json` has active or connected true (Jena's
`install_app` skill already refuses then).

## How an install really happens (so "setting up…" is honest)
1. queued: installer.py checks the disk (it refuses anything that would leave under 1 GB free) and writes a request to
   `~/jena-apps/spool/<id>.json`.
2. building: Tab sends it to the GitHub workflow `jena-apps.yml` through Saidie's connected GitHub app
   (`/usr/local/bin/jena-apps-gh drain`, run inside a Tab turn) and writes the run URL back. GitHub builds it (Linux:
   debian:bookworm, same glibc as this box) or runs it (Windows: windows-latest).
3. downloading: the package + manifest come from the public release `jena-app-<name>`, and the sha256 and size are checked.
4. installing: it's unpacked to `/home/jena/Apps/<name>/`, missing shared libraries are checked with ldd, and the .desktop is written.
5. ready / failed.
