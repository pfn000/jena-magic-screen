# Jena's World (/world)

Jena's own 3D room in the browser: three.js + WebXR, no GPU needed on her box, $0.

**Join:** open https://jena-magic-screen.vercel.app/world
- **Bring friends:** tap **invite a friend**. That adds `?room=<id>` and copies the link. Everyone who opens the same link is in the same room.
- **Desktop:** click the room to look around with the mouse. **WASD** walks, **Q/E** turns, **Esc** lets go of the mouse.
- **Phone:** drag to look around. The pad in the bottom left walks.
- **VR headset (Quest, Pico, Vision Pro, any WebXR browser):** open the link in the headset's browser and press **Enter VR**. The left stick walks and the right stick turns.
- Your name: the box at the top, or `?name=`. Names are cleaned: letters, numbers, `space _ . -`, max 16, and a kid-safe filter.

## What's in it
- **The room** (`buildRoom` in `src/world.js`): floor, walls, NCOM purple LED strips, a neon JENA sign, posters, a gaming desk and chair, a bean bag, a shelf of games, a plant, and a **stream screen** on the wall. The screen shows LIVE, who's here, and her last line. It's about 2.5k triangles with Lambert materials, so it stays light on CPU-rendered WebGL.
- **Jena:** the same `Avatar` + `Motion` + `setupSprings` as the main page (`src/avatar.js`, `src/motion.js`), not a fork. She idles with the motion.js moves, says small-talk lines every 13 to 19 s (talk gestures and lip flap come from `talkFor`), and greets each visitor by name (`direct_wave`). The world page holds the camera (`avatar.cameraHeld = true`) and runs its per-frame logic in `avatar.preHooks`.
- **NCOM Focals PRO + controllers** (`buildGear` / `wearGear`): a stylized visor and two controllers made of a few meshes. They are parented to her normalized head and hand bones, so her real head and hand poses drive them every frame. The visor is fitted by casting a ray at her face at eye height.
- **OSC-style readout:** live `/tracking/head|hand/L|R/pos|rot` from those same bones at 10 Hz, plus her current move and the network state. It shows in the HUD (bottom right) and on a panel in the room, so headset users see it too. In VR it adds your own head pose (`/you/head/pos`).
- **WebXR:** the official three.js `VRButton` + `XRControllerModelFactory` (patterns from three.js `examples/webxr_vr_teleport.html`). Locomotion moves the reference space with `getOffsetReferenceSpace`, the same way the teleport example does.

## Multiplayer-lite: peer-to-peer (no relay on her box)
Her box gateway only proxies `/box/*` to the desk agent (a buffered 30 s pass, no streaming) and only proxies websocket upgrades to noVNC. A relay there would need a gateway change and a gateway restart, which isn't allowed. So the room is **peer-to-peer**:
- `trystero` (nostr strategy). WebRTC data channels between visitors. Signaling goes over public Nostr relays: no accounts, no server of ours, $0.
- Each visitor sends `{n: name, p: [x, y, z], y: yaw, vr}` at most **8 times a second**, and only when it changed (plus a 1 Hz heartbeat). Each peer is **token-bucket limited to 24 states a second** on receive. At most **16** visitors. Positions are clamped to the room and names are sanitized again on receive.
- Visitors are capsules with a name tag, eased toward their last state. A quiet peer disappears after 12 s.
- No `?room=`: single-player. If no relay is reachable, it says `solo (no relay reachable)` and keeps working alone.
- Limits: a visitor behind a strict NAT may fail to connect (STUN only, no TURN server, since that would cost money). Everyone else in the room still works.

## Files
`world.html` (its own Vite entry), `src/world-entry.js` (a tiny shell that lazy-imports `src/world.js`), `src/world.js`, `src/world.css`. `vercel.json` rewrites `/world` to `/world.html`. No other page imports any of these.

## Debug / proof
`?cam=x,y,z,yawDeg,pitchDeg` fixes the camera, `?spawn=x,z,yawDeg` sets where you stand, `?say=text` makes her say a line, `?fov=60`, `?dpr=0.5`. `window.jenaWorld` exposes `{avatar, motion, gear, visitors, pose(), say()}`.
