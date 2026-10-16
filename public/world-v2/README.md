# world-v2: Jena's room (Q-WORLD v1 preview)

A standalone three.js viewer for Jena's baked 3D room. It is not wired into the site and is not on main.

- `index.html` + `viewer.js`: camera switcher (Room, Desk, Bed, Window, Sit in chair) plus a Day/Night toggle. Orbit or drag to look around; in the chair view you look around from the seat.
- `room.glb`: geometry and PBR materials (Draco, WebP textures capped at 1024 px).
- `exterior_day.jpg` / `exterior_night.jpg`: the view out of the window (CC0 HDRI `meadow_2`, Poly Haven), swapped by the Day/Night toggle.
- `SOURCE_RUN`: the pfn000/tab-render run the assets come from. Changing it on this branch runs `.github/workflows/world-v2.yml`, which pulls that run's files from the private render dataset, commits them here and takes headless proof shots (1600×900 and 390×844).
- `lightmap.webp` / `lightmap_day.webp`: Cycles-baked diffuse lighting (night/neon and daylight), on UV channel 2.
- `env.hdr` / `env_day.hdr`: in-room panoramas used for reflections.
- `cameras.json`: the same five camera presets as the Blender renders.

Built headless in Blender 4.2 LTS on GitHub Actions (pfn000/tab-render, qworld/). Assets are CC0 (Poly Haven, ambientCG); see CREDITS.md.
URL params: `?cam=wide|desk|bed|window|chair`, `?look=day|night`, `?nobar=1`, `?exp=1.4`.
