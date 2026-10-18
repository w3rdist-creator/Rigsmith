# Wiz acceptance test — the cheesesteak mascot animated in Rigsmith (2026-10-17/18)

Worker: Claude Opus 5.5 (`claude-opus-5-5`), effort high, Mac mini. This is a worker
self-report; **Hermes verification has not been performed**. It shows that this
vertical slice of Rigsmith can rig and animate the supplied flat Wiz art into two usable
loops. It does **not** claim parity with any commercial tool or a professional
production rig.

The initial delivery record (`docs/DELIVERY.md`, `.hermes/STATUS.md`) is left as it was.
This test found and fixed one editor defect (§6), so the default e2e suite now has 20
tests instead of the 19 recorded there.

## 0. Preflight (before any character work)

The initial worker's `READY_FOR_HERMES_VERIFICATION` was treated as a self-report. I
re-ran its gates on the untouched tree first, then glanced at its demo screenshots:

| Gate | Result | Raw output |
|---|---|---|
| `npm test` | 43/43 pass, exit 0 | `.hermes/evidence/wiz/00-preflight-unit.txt` |
| `npm run build` | exit 0, `index-bftQBcAc.js` (same hash as DELIVERY.md) | `.hermes/evidence/wiz/00-preflight-build.txt` |
| `npm run test:e2e` | 19/19 pass, exit 0 | `.hermes/evidence/wiz/00-preflight-e2e.txt` |

## 1. Source

| | |
|---|---|
| Original (read-only, untouched) | `/Users/w3rd/Code/cheesesteak-diamond-hands/factory/brand/wiz_master.png` |
| Working copy | `.hermes/assets/wiz/source/wiz_master.png` |
| sha256 (both, re-checked at the end) | `2197f409dcac8bdd9f8295591979dacd47edddbb61734534770e36f5baf2cab9` |
| Identity | Brand notes (`factory/brand/directions.yaml`, mascot "Wiz"): an anthropomorphic Philly cheesesteak hoagie with a glossy melted-cheese pompadour, a paper-wrapper jacket, cartoon eyes and a cocky grin. Only that file and the PNG were read in the other repo. |

**Observed in the image** (inspected visually and by pixel statistics):
- 1024×1536 RGBA. It is one flattened illustration, not a layered file.
- The alpha channel already holds a clean character matte. Background alpha is 0 (the
  dark glow lives only in the RGB of transparent pixels); the character is alpha 253–254.
- Wiz stands front-on: hoagie body with the face painted on the bun, cheese pompadour,
  white jacket with red-check sleeves, thin orange stick arms ending in white
  four-finger gloves, stick legs, red high-top sneakers.
- There is background between each arm/glove and the jacket, and between the legs, so
  the limbs separate cleanly. The arm sticks vanish into the sleeve openings, run under
  the glove cuffs, and the leg sticks run under the bun bottom.

## 2. Cutouts (`scripts/wiz/prepare_cutouts.py`, parameters in `scripts/wiz/masks.json`)

```sh
npm run wiz:prepare
# = python3 -I scripts/wiz/prepare_cutouts.py .hermes/assets/wiz/source/wiz_master.png .hermes/assets/wiz/prepared
```

The script is deterministic and uses PIL + numpy only (nothing was installed). It refuses
to run if the source hash does not match `masks.json`. How each part is separated:

- **Limb axes**: PCA of the stick-orange pixels inside each `axisBox`. Measured angles:
  arm_l 125.85°, arm_r 55.27°, leg_l 100.29°, leg_r 79.86° (y-down, clockwise).
- **Arm sticks**: a band along the axis, with half-widths taken from the matte on
  mid-stick rows. The band is cut **per column** where the orange paint starts at the
  sleeve rim and where it stops at the glove cuff, so the oblique sleeve opening keeps
  its own outline.
- **Gloves**: the connected matte region past the cuff (PIL flood fill from `handSeed`).
- **Legs**: the stick band cut at the bun bottom, plus the whole shoe (matte inside
  `footBox`). Leg and shoe form one rigid piece.
- **Body**: the matte minus every limb, glove, leg and shoe pixel. It keeps the face,
  cheese hair, filling, jacket and sleeves.
- **Clean-up**: 3,004 faint isolated matte specks (alpha < 100, more than 6 px from solid
  matte) are dropped. Faint fringe (alpha < 16) within 10 px of a stick goes with that
  stick.

**Invented pixels.** These are the only pixels not copied from the source, and they are
hidden at rest:
- **Joint overlap**: each stick is extended under its cover by sweeping one of the
  stick's own cross-sections along the axis: 60 px into the sleeve (sampled from the
  sleeve-shadowed row just below the cut), 70 px under the glove cuff, 50 px under the
  bun. This is synthesized only under fully opaque cover (source alpha ≥ 250), so
  nothing shows through anti-aliased edges. Counts: arm_l 11,583 px, arm_r 11,351,
  leg_l 3,435, leg_r 3,496.
- **Sleeve-interior patches** (`sleeve_hole_l/_r`, 2,491 / 2,793 px): flat dark fill
  (RGB ≈ 113,89,90) drawn behind each arm. They cover only rows where sleeve paint flanks
  the stick on both sides, so a raised arm reveals "inside of sleeve" instead of a
  see-through hole.

Visible pixels are copied unchanged: no resampling, recolouring or redraw. Crops have
even sizes, because Rigsmith centres images on `w/2, h/2` and odd sizes would blur by
half a pixel.

| Part (draw order, back → front) | Bone | Source bbox x,y,w,h |
|---|---|---|
| leg_l.png | leg_l | 206,1072,282,460 |
| leg_r.png | leg_r | 536,1071,282,460 |
| sleeve_hole_l.png | body | 193,744,74,72 |
| sleeve_hole_r.png | body | 760,744,82,72 |
| arm_l.png | arm_l | 105,687,206,240 |
| arm_r.png | arm_r | 718,687,204,242 |
| body.png | body | 7,0,1012,1146 |
| hand_l.png | hand_l | 0,828,226,274 |
| hand_r.png | hand_r | 800,825,224,276 |

(`_l` / `_r` mean screen-left / screen-right.) Per-file sha256s, pivots and all derived
numbers are in `.hermes/assets/wiz/prepared/manifest.json`. Review images are in
`prepared/review/`: `segmentation-overlay.png`, `exploded.png`, `reassembly.png`, and
`reassembly-diff-x4.png`.

**Reassembly check (Python):** compositing the nine layers in draw order over a flat
background matches the source over the same background. Max diff is 2.6/255 (rounding),
and 0 pixels differ by more than 8. No body pixels remain beside any clean stick
(`bodyPixelsBesideCleanSticks` = 0 for all four), so moving limbs leave no ghost behind.

## 3. Rig built inside Rigsmith (`scripts/wiz/build-in-editor.ts`)

```sh
npm run build
npm run wiz:build      # build-in-editor.ts, then compare_setup.py
```

Headless Chrome for Testing 155.0.8059.39 (the verified Mach-O from `tests/e2e/harness.ts`)
runs with a fresh project-local profile `.hermes/browser-profiles/wiz-build`, against
`vite preview` on a free 127.0.0.1 port in 47614–47617. The script drives only visible
controls, in this order:

1. Inspector **Project name**.
2. **Import…** file input with the 9 PNGs. Import stores the file bytes unchanged (FileReader data URL).
3. **+ Bone** with the parent selected in the Skeleton tree, then the inspector fields **Name, X, Y, Rotation, Length**.
4. Select the bone, click **Attach** on the image, then set **Offset X/Y, Rotation**.
5. **Export PNG** of the setup pose.
6. **+** new animation, then **Name, Length, FPS** (Loop is on by default).
7. For every key: click the **timeline ruler** at the exact frame, select the bone in the tree, type the value in the inspector. Rigsmith's Animate mode writes the key. **◆ key toggle** is clicked only when the typed value equals the current pose.
8. Click each segment-start **◆ diamond** and set **Interp** to `smooth`.
9. **Save**, then catch the download and write it to `.hermes/assets/wiz/output/wiz.rig.json`.

`window.__rigsmith` is only read, to assert that each step landed. The spec (bone
pivots, attachment offsets, key tables) is data in `scripts/wiz/rig-spec.ts`, computed
from the manifest. It never writes a project file itself. The build takes about 9 s and
raises 0 page errors (`.hermes/evidence/wiz/build-log.txt`).

**Hierarchy.** World = source px − ground point (511.36, 1530). Locals are as typed:

| Bone | Parent | x | y | rotation | length | Joint (source px) |
|---|---|---|---|---|---|---|
| root | — | 0 | 0 | −90 | 110 | ground between the shoes |
| body | root | 406.46 | 0 | 0 | 520 | hip (511.36,1123.54) |
| leg_l | root | 405.92 | −82.95 | −169.71 | 200 | under bun (428.41,1124.08) |
| leg_r | root | 407 | 82.94 | 169.86 | 200 | under bun (594.30,1123.00) |
| arm_l | body | 366.97 | −267.55 | −144.146 | 120.997 | sleeve rim (243.81,756.57) |
| hand_l | arm_l | 120.997 | −0.001 | 0 | 130 | glove cuff (172.94,854.64) |
| arm_r | body | 366.67 | 270.91 | 145.265 | 122.997 | sleeve rim (782.27,756.87) |
| hand_r | arm_r | 122.997 | 0.002 | 0 | 130 | glove cuff (852.35,857.95) |

The legs hang off `root`, not `body`, so body sway leaves the feet planted. Each
attachment has rotation = −(bone world angle), so the setup pose shows the art upright.

**Setup pose through Rigsmith's own renderer** (`scripts/wiz/compare_setup.py`): the
editor's Export PNG of the setup pose (zoom 1) was diffed against the source. Max diff is
2.7/255, mean 0.04, and 0 pixels differ by more than 8. So the y-down axes, clockwise
rotation sign, image centring and offsets are all correct, and the rig at rest **is** the
original artwork. Files: `output/review/rigsmith-setup-export.png` and
`rigsmith-setup-diff-x4.png`.

## 4. Animations (30 fps, loop on, `smooth` interpolation on every segment start)

Deltas below are relative to the setup pose. Rotation is in degrees, clockwise positive.
Full tables are in `scripts/wiz/rig-spec.ts`.

**`idle`: 3.0 s, 90 frames, 18 keys. Subtle.**
- **Breathing**: body scale (local x = up) 1 → 1.016/0.992 → 1 (f0/45/90).
- **Sway**: body rotation +0.8 → −0.8 → +0.8, about 30 px at the head.
- **Arms**: arm_l +4° at f40, arm_r −4° at f50.
- **Gloves**: hand_l +7° at f52, hand_r −7° at f62. Out of phase with the arms, for overlap.
- Feet do not move.

**`greeting`: 2.4 s, 72 frames, 49 keys. Large, and in character.**
- **Hop**: root −34 px at f5. The legs kick out ±7° at the apex.
- **Landing squash**: body scale 0.965/1.025 at f10, then 1.01/0.995 at f15, then 1/1 at f20.
- **Lean**: Wiz leans 3.5° toward the waving side (f14–f46).
- **Wave**: his screen-right arm swings up 80° by f12 and oscillates −68/−84° until f48.
- **Glove waggle**: ±22° about the wrist.
- **Other arm**: flicks out 14°.
- Everything returns to the rest pose by f62 and holds until f72, so the clip loops.

The motion choices follow the brand's "cocky, self-assured" description: a big wave
from a lean, not a timid one.

## 5. Preview media: captured from Rigsmith's canvas

```sh
npm run wiz:capture    # capture-preview.ts, then make_media.py
```

How the frames were made:
- A fresh profile, `.hermes/browser-profiles/wiz-capture` (1500×1300, DPR 2), opens the
  saved project through **Open…**.
- Bones are hidden with the visible **Bones** checkbox, then **Fit** and one wheel notch
  out are applied.
- For each frame 0..N−1 the script clicks the ruler at that exact frame and reads the
  stage canvas with `toDataURL`. Frame N is skipped because it equals frame 0.
- ffmpeg 9.0.1 (already installed) and PIL only crop, scale and encode those frames. The
  dark grid background is the editor's.

| Output (`.hermes/assets/wiz/output/`) | What it is | sha256 |
|---|---|---|
| `wiz.rig.json` | reopenable Rigsmith project, 9 images embedded, 1.67 MB | `005bbb73f8fbc587034ea29829fa669e1a96c65ef86a77a4539f10e359f2243e` |
| `wiz-preview.mp4` | idle ×2 then greeting ×2; 808×960, 30 fps, 324 frames, 10.8 s, H.264 | `b22824cb03ab30bf8475ee02ca114f4464e125b2c8786658dfbd59d7447127c1` |
| `wiz-preview.webm` | same sequence, VP9 | `014da2eb360e0938133760e40e818574e591658f5c18019192e6b3c7896be8b7` |
| `wiz-preview.gif` | same sequence, 480 px tall, 15 fps | `4ec6540b49a7dc12e76c279d26a19c5afcd0b7acd6ec83296c80eafc135a37d0` |
| `wiz-idle.mp4` / `wiz-greeting.mp4` | each loop ×3 (9.0 s / 7.2 s) | `1d60ec07791915dd02380a3b4ec2b77a756aaa5e095f64fd3914b93b1b6459d2` / `bc9be11bf2d3168dfc0d44abe772a4b08bd29959c331fbcd492ca0b99142e059` |
| `contact-sheet.png` | 8 idle + 12 greeting frames, labelled with frame/time | `93c06ee6b7a8ace0811aeff7fe7c9369734b51f7deb937a76bd911f81f361d51` |
| `frames/idle/f000–f089.png`, `frames/greeting/f000–f071.png` | raw canvas frames (1960×2014) + `pose.json` per animation | — |
| `review/editor-ui-setup.png`, `editor-ui-animate.png` | the editor UI holding the Wiz rig (tree, images, keys) | — |

## 6. Rigsmith defect found and fixed

**Symptom.** In the greeting, frame 72 did not match frame 0. The body's scale-Y key at
f20 was 0.995 instead of 1.

**Cause.** The inspector shows numbers rounded to 2 decimals. With a real value of 0.995
on screen as "1", typing `1` leaves the text unchanged, so the `<input>` fires no
`change` event and the edit is silently lost. A user could not set a value equal to its
rounded display.

**Fix** (`src/ui/dom.ts`, `numberField`). Enter now commits whenever the typed number
differs from the *true* value. A `last` guard stops change and Enter from committing the
same edit twice. Re-entering the true value is still a no-op.

**Regression test.** `tests/e2e/editor.e2e.test.ts` › "inspector number fields". It
**failed on the pre-fix build** (`typed 1 is committed`,
`.hermes/evidence/wiz/regression-prefix-e2e.txt`) and passes after the fix. After the
fix the Wiz project was rebuilt from scratch through the UI.

## 7. Verification commands and results (final build `index-CeSeqo4b.js`)

These are self-reported. Each bucket was run on its own.

| Bucket | Command | Result | Raw output |
|---|---|---|---|
| Unit (model) | `npm test` | 43/43 pass, exit 0 | `.hermes/evidence/wiz/gate-unit.txt` |
| Typecheck + build | `npm run typecheck && npm run build` | exit 0 | `.hermes/evidence/wiz/gate-build.txt` |
| Default browser e2e | `npm run test:e2e` | 20/20 pass, exit 0 (19 original + regression) | `.hermes/evidence/wiz/gate-e2e.txt` |
| Cutout reassembly | `npm run wiz:prepare` | max diff 2.6/255, 0 px > 8 | `prepared/manifest.json` → `reassembly` |
| Editor build + setup-pose diff | `npm run wiz:build` | build OK, 0 page errors; Rigsmith export vs source max 2.7/255, 0 px > 8 | `.hermes/evidence/wiz/build-log.txt`, `pipeline-run.txt` |
| Wiz acceptance | `npm run test:wiz` | **11/11 pass, exit 0, two consecutive runs** | `.hermes/evidence/wiz/acceptance-final-1.txt`, `-2.txt` |

`npm run test:wiz` runs `tests/acceptance/wiz.acceptance.test.ts`. It opens the
**saved** file in a fresh profile, `wiz-verify`, and covers:

1. **Persistence**: every embedded image's bytes have the same sha256 as its prepared
   PNG. Sizes, parents, draw order and animation settings match, and setup-pose joints
   sit on the measured pivots (±0.01 px).
2. **Real-time playback** of `idle` and `greeting`: the playhead advances, the canvas
   hash changes, and playback continues past one full duration (loop).
3. **Articulation**, measured as angles *relative to the parent bone*:
   - Idle: body sway is 1–4°, both arms ≥ 3°, both gloves ≥ 5°, legs constant.
   - Greeting: waving arm ≥ 60°, glove waggle ≥ 30°, other arm ≥ 8°, hop ≥ 25 px, leg
     kick ≥ 5°.
   - Distinct canvas hashes across samples, and the glove's screen region differs
     between rest and wave.
4. **Loop continuity**: all 8 bone world transforms at frame N equal frame 0 (1e-6).
   The step into the loop seam is ≤ the largest step inside the clip, and no glove or
   root step exceeds 40 px per frame.
5. **Editing the character**:
   - Scrub to frame 20, type a new `arm_l` rotation. A key is written, the arm turns
     about 40° on the canvas, and the canvas re-renders.
   - Undo restores a deep-equal project; redo re-applies; undo again.
   - A Rotate-tool canvas drag turns the waving glove −30° (±2°) about its wrist, and a
     single undo restores it.
6. **Save → reload**: the Save download deep-equals the original file. It reopens
   identically in a fresh page and plays.
7. No uncaught page errors.

**What I judged by eye, not by numbers.** I looked at the screenshots and frames
(contact sheet, 4× crops of the sleeve, wrist, hip and hop frames, and a frame from the
encoded MP4). Wiz stays recognizable in every frame. Both loops read as intended. None of
the numerical tests above asserts art quality.

## 8. Known limitations (flat art)

- **Head, face and cheese hair are not articulated.** The face is painted on the bun and
  the bun shows between the lapels down to the hem; the pompadour drips into the face. A
  head tilt would need invented bun and face pixels under the collar, so it was not
  faked. The whole sandwich moves as one body (sway, breathing, lean, squash).
- **No facial animation**: no blinks, mouth shapes or eye moves; the art has one expression.
- **Raised-arm seam.** With the arm fully raised (greeting f12–f48), the inside of the
  sleeve opening shows the dark synthesized patch and a small step in the stick outline
  where the per-column cut meets the swept extension. It is visible in 4× crops; at the
  delivered 960 px size it is a few pixels inside the sleeve shadow. Raising the arm
  further than about 85° would make the stick visibly emerge from behind the sleeve
  cloth, so the wave is limited to that range.
- **Non-uniform body scale** (breathing/squash) slightly skews child limbs (≤ 3.5%),
  which Rigsmith's matrix composition renders faithfully. This is intended stretch, not
  a bug, but it is not volume-preserving deformation: there are no meshes.
- **Rigid limbs**: one bone per stick, no elbows or knees and no IK. The hop lifts the
  shoes off the ground rather than compressing the legs.
- **Rigsmith limits** still apply: no mesh deformation, IK, curve editor or easing beyond
  linear/step/smoothstep. `smooth` eases to rest at every key; that suits the waving
  oscillation and breathing, but there is no overshoot or follow-through control.
- The previews show the editor's dark grid background, because they come straight from
  the stage canvas. There is no transparent video export.

## 9. How the operator opens and watches it

```sh
cd /Users/w3rd/Code/rig-animation-editor
npm run build && npm run preview          # http://127.0.0.1:47613 (loopback only; check the port is free)
```

In the editor:
1. Click **Open…** and choose `.hermes/assets/wiz/output/wiz.rig.json`.
2. Pick `idle` or `greeting` in the timeline's animation menu.
3. Press **▶ Play** (or Space). Scrub on the ruler, and untick **Bones** to hide the
   skeleton.

To watch without the editor, open `.hermes/assets/wiz/output/wiz-preview.mp4` (or
`.webm`/`.gif`) and `contact-sheet.png` in any viewer.

Full rebuild from the source art:

```sh
npm run wiz:prepare && npm run build && npm run wiz:build && npm run wiz:capture && npm run test:wiz
```

## 10. Git hygiene

`git check-ignore -v` confirms each private path is ignored:
- `.hermes/assets/` (`.gitignore:15`) covers the source copy, prepared PNGs, manifest,
  project file, media and frames.
- `.hermes/evidence/` (`:3`) covers the re-saved project copy and screenshots.
- `.hermes/browser-profiles/` (`:4`) covers the browser profiles.

Commits contain only code, tests, the mask parameters and docs. No images, base64 art or
project files are committed. `.hermes/dispatch/` (operator orchestration) is left
uncommitted, as before.
