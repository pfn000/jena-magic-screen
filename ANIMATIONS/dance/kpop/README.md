# K-pop dance (keypoints only)

Jena's K-pop dances, learned from dance-practice / cover videos (Saidie asked Oct 13, 10:34 PM). Each file is
**keypoint data only** (bone rotations, hips travel, facing track, finger bends, face weights) — no video, image or
audio is stored in this repo; the short slices used for tracking were deleted after the run.

Tracked on GitHub Actions (`.github/workflows/jena-track.yml`, run 38505868266) with MediaPipe Pose + Hands + Face,
retargeted by `moves-pipeline/retarget_full.py` after `moves-pipeline/dance_facing.py`:

* **facing**: the dancer's facing is read every frame from the hip line (shoulder line as backup) and taken out of the
  bones; `facing.yaw` (degrees×10, + = toward her left) is the turn since the first frame and `facing.chest` the
  shoulder line (the difference is torso twist, also inside the spine/chest bones). Jena turns by the same amount from
  her own start facing; her feet pivot under her (`src/dance.js` → `avatar.danceYaw` → `updateFeet`).
* **sides**: the performer's own left = Jena's left. Mirrored practice videos (flagged below) are un-mirrored before
  tracking; nothing is mirrored at playback.
* **kid-safe**: solo dancers, clean choreography, slices picked by eye to skip floor work and scene cuts. The build
  also scans every 1 s window and drops body-roll windows (hip pitch swing >20° with spine pitch swing >15°) and
  hip-focused windows (hip roll swing >25°) — `kid_safe.keep` / `kid_safe.dropped` in each file — and playback clamps
  hip tilt to ±7°.
* **hit-then-ease**: `hit_ease` = median arm attack/settle times (overall 0.27 s / 0.27 s); `src/motion.js` `HIT`
  carries that front-loaded timing into her everyday gestures.

| file | song | dancer / channel (credit) | source | slice | mirrored practice video | dropped (kid-safe) |
|---|---|---|---|---|---|---|
| `kpop_super_svt` | SEVENTEEN – Super (손오공) | 초영 CHOYOUNG | https://www.youtube.com/watch?v=Wp6cE4rrG-o | 40–58 s | yes (un-mirrored before tracking) | 12.8–15.2 s |
| `kpop_sclass_skz` | Stray Kids – S-Class (특) | FUJI | https://www.youtube.com/watch?v=BEYGiD5M4Jc | 37.5–54 s | no | 6.8–9.87 s |
| `kpop_supershy_nj` | NewJeans – Super Shy | 나윤 NaYoon | https://www.youtube.com/watch?v=1eLA1V65OTc | 30–48 s | yes (un-mirrored before tracking) | none |
| `kpop_dynamite_bts` | BTS – Dynamite | KPOP-GO GO (MIRROR) | https://www.youtube.com/watch?v=8ONP2mdCovs | 47–58 s | yes (un-mirrored before tracking) | none |
| `kpop_iam_ive` | IVE – I AM | 현츄 HYEONCHU | https://www.youtube.com/watch?v=DNhoCqA2rnM | 49–65 s | yes (un-mirrored before tracking) | none |

All choreography belongs to the artists and their choreographers; the dance covers belong to the dancers credited
above. Used only as motion reference for Jena's own (non-commercial) avatar.

Play: `jena.dance()` (random, no repeats), `jena.dance('kpop_super_svt')`, `jena.stopDance()`, chat "dance" / "stop dancing";
`jena.danceTrace()` = facing trace (video yaw vs Jena yaw).
