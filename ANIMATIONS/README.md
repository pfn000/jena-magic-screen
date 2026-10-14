# ANIMATIONS: Jena's motion library

Everything about how Jena moves lives here. It's **keypoint JSON and numbers only**: no source video is ever stored, and downloaded clips are deleted once they're tracked. Patterns only: no creator's exact routine is copied. She's a kid, so nothing here is flirty or suggestive (no winks, kisses, blush or body emphasis, and no chest or body jiggle).

> Changing only files under `ANIMATIONS/` doesn't redeploy the site (see `ops/vercel-ignore.sh`). The site picks up `moveset.json` and `styles.json` on the next deploy that touches `src/`.

## Index
| path | what |
|---|---|
| `moveset.json` | The talk/react/direct/brag move set played by `src/motion.js` (29 moves), each tagged by kind, emotions and triggers. |
| `styles.json` | Motion styles (smooth / bouncy / snappy anime / chibi): the default blend, a per-emotion lean, learned numbers, and each clip's style. |
| `sources.json` | Clips she learned from (Saidie's examples first, then public 3D VTuber clips), with why each one was picked. |
| `tracked/<id>.json` | Whole-body tracking per clip (MediaPipe holistic on GitHub Actions `jena-track.yml`): body bones, 21-point fingers per hand, face blendshapes, 15 fps. |
| `stats/<id>.json` | Per-clip motion stats (`moves-pipeline/motion_stats.py`): per-joint velocity and acceleration after One Euro smoothing, gesture onsets, overshoot, gestures/min, head amplitude, sway period, style. |
| `training/motion.jsonl` | Training rows: context/emotion → clip id + stats + style, and trigger → move. A copy goes to the Kaggle dataset folder the driver syncs. |
| `Animations.md`, `index.json`, `*.json`, `*.gif` | The earlier learned-move library (see `public/moves` for what the site plays). |

## The moves (`src/motion.js`)
- **Idle:** sway, head tilt, music bob, look around, neck stretch.
- **Talk:** nod, question tilt, open palms, beat gestures (left and right), shrug, "me" chest tap, head shake. A picker plays these while she talks, matched to her mood, about as often as the tracked talkers gesture ×3 (3D VTubers act bigger). Loud stressed syllables in her voice are beats she can nod or gesture on.
- **Big reactions:** face swing, head snap, recoil, hands to face, laugh (hand to mouth, shoulders bouncing), shock, facepalm, cringe, hype fist pump.
- **Direct to camera** (eye contact locked): point at the viewer, lean in, wave, finger guns, a "you!" point with a lunge. These trigger when she says "chat", "you guys", "y'all", "everyone" or a chatter's username (a greeting gets a wave, a question gets a lean-in, thanks gets finger guns).
- **Brag:** a smug face (heavy-lidded eyes, closed half smile, brows a touch down, side-eye) with a hand on her chin or a fist pump, for a W, a clutch play or roasting chat. Never flirty.
- Her arms reach each pose with two-bone IK aimed at real targets (the camera, her face, her chest), so pointing really points at you.
- **Lip sync:** the mouth blends the text visemes with her real audio's formant bands (F1 → open "aa", low energy → rounded "oh"/"ou", high F2 → "ee"/"ih"), in `src/voice.js` and `src/avatar.js`.
- **Spring bones** (`setupSprings`): hair, clothes and accessories only. Any chest, bust or body joint is deleted. Colliders: hair ↔ head, neck, chest and arms. The skirt was exported pointing at RightHand + LeftUpperLeg only, so it now uses both legs and the spine. The sleeves had no colliders, so they now use the arms and chest.

## API (for the stream camera director and anything else)
```js
const off = window.jena.onReaction((r) => {
  // r = { type: 'shock' | 'laugh' | 'point' | 'smug' | …, move: 'react_shock', kind: 'react' | 'direct' | 'brag',
  //       intensity: 0..1, emotion, trigger: 'shock' | 'chat' | 'username' | 'win' | 'api' | …,
  //       timestamp: Date.now() ms, t: performance.now() ms, durationMs, cam: 'punch' | null }
  if (r.cam === 'punch' && r.intensity >= 0.6) camera.punchIn(r.intensity);
});
off();                                   // unsubscribe
window.jena.react('shock', 0.9);         // play one (react_*, direct_*, brag_*, talk_*, idle_* or the short name)
window.jena.motion.setStyle('snappy', 0.7); // lean toward a style (smooth | bouncy | snappy | chibi)
window.jena.motion.state();              // what's playing, the style mix, arm IK targets, smug weight
window.jena.springs;                     // what setupSprings did (hair / clothes joints, removed body joints, fixed colliders)
```
The same event also goes out as a `window` `CustomEvent('jena-reaction')` and as a `postMessage({type:'jena-reaction', …})` to a parent frame. If nobody has subscribed, any reaction with `cam: 'punch'` at intensity 0.6 or more sends the stream page's existing `jena-cam` punch event (at most one hard zoom per 5 s, enforced there).

## Re-run the analysis
```
python3 moves-pipeline/motion_stats.py ANIMATIONS/tracked/*.json public/moves/*.json --out ANIMATIONS
```
Tracking new clips: add them to `sources.json`, upload each one as a small git blob (640p/15 fps keeps it under the proxy's request size), then dispatch `jena-track.yml` with `{"id","blob"}`. Results land in the `jena-track-moves` release. Copy the JSON into `tracked/` and delete the video.

## Credits
Patterns (timing, amplitude, style), not routines, learned from:
- `sx_carrey_dance`: carrey_play, https://www.tiktok.com/@carrey_play/video/7682618730848832786 (dance). Asked: Saidie 6:49 PM.
- `sx_salpoww_sleepy`: salpoww, https://www.tiktok.com/@salpoww/video/7314082075252903200 (camera transitions / idle). Asked: Saidie 6:49-6:50 PM.
- `sx_feralune_troll`: feralune, https://www.tiktok.com/@feralune/video/7679863361789578527 (reactions, hyper detail). Asked: Saidie 6:50 PM.
- `sx_feralune_driver`: feralune, https://www.tiktok.com/@feralune/video/7692483246432603422 (reaction comedy). Asked: Saidie 6:51 PM.
- `sx_kumivt_unhinged`: kumivt, https://www.tiktok.com/@kumivt/video/7675201090635189534 (big human reactions + camera zooms). Asked: Saidie 6:52 PM.
- `vt_debut_warudo`: Skulls Nightshade, https://www.youtube.com/watch?v=L8d8Hcn_QQY (3D VTuber debut (Warudo/VRChat model) talk). Asked: public 3D.
- `vt_dreamtrove`: DreamTrove, https://www.youtube.com/watch?v=8FoJY56h2y0 (3D VTuber model showcase). Asked: public 3D.
- `sx_xtralir_skit`: xtralir, https://www.tiktok.com/@xtralir/video/7685967188376997150 (comedy skit structure; skit structure, cuts and reaction timing (3D VTuber compilation)). Asked: Saidie 6:53 PM.
- `sx_reallife_lipsync`: valvalvalerii, https://www.tiktok.com/@valvalvalerii/video/7672068854159281430 (real-life face tracking, expressions, hands, lip sync to audio; lip-sync timing (mouth open/close vs audio) and hand-beat timing ONLY; its expressions/poses are not used for Jena (kid-appropriate rule)). Asked: Saidie 6:56 PM.
- People clips in `public/moves` (see `public/moves/index.json` for each source and channel), incl. cg-people.com casual talk references.
Tools: MediaPipe Holistic (Apache-2.0), three.js + @pixiv/three-vrm (MIT), One Euro filter (Casiez, Roussel & Vogel, CHI 2012).
Excluded on purpose: https://www.tiktok.com/t/ZPLSf4w7t/ (suggestive; Jena is a minor).


## K-pop dance

`dance/kpop/` — 5 K-pop dance-practice clips (keypoints only, kid-safe, facing per frame). Credits: [dance/kpop/README.md](dance/kpop/README.md).
