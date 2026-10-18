# Use-case milestone: "Wiz v3, authored through the editor" — delivery record

Worker handoff for the approved next milestone of the Fable use-case review
(`.hermes/dispatch/fable-usecase-review/REVIEW.md` §6, RV-001 … RV-008). It is not an
acceptance. Hermes verification is external, and visual preference belongs to the
operator (§6). Rigsmith is an initial vertical slice; nothing here claims parity with any
commercial tool.

All Wiz art, projects, exports and media are private and git-ignored, under `.hermes/`.
Git holds the code, tests and this record only.

## 1. Commits (local only; nothing pushed)

| Commit | Scope |
|---|---|
| `e425d5c` | RV-002, RV-004, RV-005, RV-006, RV-007: human-path and save/recovery fixes |
| `c9c45dc` | RV-003: persistent project frame (inspector, sequence/mix/Lottie dialogs, CLI) |
| `dd08697` | RV-001 / RV-008: Wiz v3 builder, its acceptance and delivery scripts, flat-Wiz Lottie proof |
| `251dd79` | Acceptance on Wiz itself for RV-003 (mix frame 0) and RV-007 (Save to browser + autosave); the Mix dialog's Canvas select exercised (test-id audit) |
| docs commit | this record, `docs/lottie.md`, `.hermes/STATUS.md` |

## 2. Gates

`npm run gates` (`scripts/roadmap/run-gates.sh`) was run fresh on HEAD `251dd79` with a
clean tree. That is run `20261018T181350Z-67777`. Raw output is in
`.hermes/evidence/usecase-milestone/gates-251dd79/` (git-ignored).

| Gate | Result |
|---|---|
| preservation | 16/16 protected originals unchanged |
| unit (`npm test`) | 219/219 |
| typecheck, build (`npm run build`) | exit 0, exit 0 |
| e2e (`npm run test:e2e`) | 165/165 |
| cli | 14/14 |
| wiz (`npm run test:wiz`, private assets) | 31/31: v1 and v2 acceptance, v3 (10), Lottie (5) |
| testid-audit | exit 0: 306 ids, 70 allow-listed, 0 never interacted with. Note: `inspector` is allow-listed but was exercised |
| profiles | no browser-profile tree under `.hermes/evidence/` |

**Earlier run.** The first run on `dd08697` (`gates-dd08697/`) passed every gate except
testid-audit. The audit showed that `mix-frame`, the Mix dialog's Canvas select added in
`c9c45dc`, was read but never operated by a test. `251dd79` adds that interaction.

**Wiz originals.** The 201 Wiz asset hashes recorded before this milestone
(`.hermes/evidence/usecase-milestone/wiz-assets-sha-first.txt`) were re-checked after the
last gate run. All 201 match, and the original directories contain exactly the same file
set (`wiz-assets-sha-last-check.txt`). Wiz v3 lives only in the new
`.hermes/assets/wiz/v3-output/`.

**Red → green.** `tests/e2e/usecase-fixes.e2e.test.ts` was run against a pre-fix build of
`c0e557a`: 12 of 13 failed, and the Setup-mode control passed
(`red-usecase-fixes.txt`). After the fixes, 13 of 13 pass (`green-usecase-fixes.txt`).

## 3. Findings and results

### RV-004 · Save never clears the recovery copy unless the file was written (`e425d5c`)

- **Save** uses the File System Access picker where the browser has one. Only a completed
  write (`close()` resolved) marks the project saved and clears the recovery copy. A
  cancelled picker or a failed write changes nothing: the project stays dirty, the copy
  is kept, and an error toast names the reason.
- The fallback download (no picker) keeps the project **unsaved** and keeps the recovery
  copy. The copy is annotated with the downloaded file name, because the page cannot
  confirm that a download landed.
- Tests: `tests/e2e/usecase-fixes.e2e.test.ts` › RV-004. There are three cases:
  - downloads blocked;
  - the real headless picker, which aborts;
  - a stubbed handle that completes and then fails on close.

  All three were red on the pre-fix build (`.hermes/evidence/usecase-milestone/red-usecase-fixes.txt`)
  and are green now (`green-usecase-fixes.txt`).
- Limitation: the "picker completed" path is a stubbed `showSaveFilePicker` handle. Headless
  Chrome for Testing aborts the real picker (probe: `probes/picker-probe.txt`). A real
  disk write through the native dialog was not observed.

### RV-007 · Browser storage in IndexedDB (`e425d5c`, `251dd79`)

- **Save to browser** and autosave use IndexedDB (`src/ui/storage.ts`). The old
  `localStorage` copies are migrated once and removed after the IndexedDB write commits.
- Tests:
  - **Migration** (e2e).
  - **Synthetic project** with about 4× the Wiz image bytes: it saves to the browser, and
    autosave completes 2 s or less after an edit (e2e).
  - **Wiz v3 itself**: Save to browser, then an edit, then autosave
    (`tests/acceptance/wiz-v3.acceptance.test.ts`, last test).
- The quota-error path is still covered with a CDP quota override (`probes/quota-probe.txt`).

### RV-002 · Animate mode: clicking the art acts on the bone that moves it (`e425d5c`)

- In Animate mode, a click on attachment art selects the bone that moves it. For a weighted
  mesh, that is the strongest influence of the deformed vertex nearest the click.
- Setup mode still selects and moves the attachment itself.
- Tests: e2e › RV-002. With bones hidden:
  - a click on the glove selects `hand`;
  - a Rotate drag keys it;
  - a Move drag on the body keys `root`.

  This was red before and is green now.

### RV-005 · Enter on an unchanged pose field keys that channel (`e425d5c`)

- In Animate mode, Enter in a rotation, translate or scale field writes a key at the
  current frame even if the value is unchanged. This takes one undo step. A second Enter
  reports that the channel is already keyed.
- Setup mode is unchanged: an unchanged value does nothing.
- Tests: e2e › RV-005. This was red before and is green now.

### RV-006 · Timeline time zoom and scroll (`e425d5c`)

- Ctrl/Cmd+wheel zooms around the cursor. The +/−/Fit buttons and a px-per-frame readout
  also control the zoom. Shift+wheel scrolls time, and the ruler numbering follows the zoom.
- Tests: e2e › RV-006, on a 300-frame animation:
  - the zoom reaches at least 8 px per frame;
  - a 24 px drag moves a key exactly 3 frames;
  - Fit restores the whole animation.

  This was red before and is green now.

### RV-003 · Persistent project delivery frame (`c9c45dc`, `251dd79`)

- The project stores an optional fixed world-space `frame` (format v2 field). The inspector
  **Frame** section can do four things, each as one undo step:
  - **Set frame: fit to all animations**;
  - **Fit this animation**;
  - edit x / y / width / height;
  - **Remove frame**.

  The viewport draws the frame.
- The sequence, mix and Lottie dialogs default to the project frame when one exists and
  can switch to fit. Art outside the frame is clipped, the frame size is kept, and a
  visible warning shows.
- The CLI `render`, `mix`, `media` and `lottie` commands take `--frame project|fit|x,y,w,h`
  or `--frame-from <rig>`, and report the frame and any warnings.
- Tests:
  - `tests/unit/project-frame.test.ts`;
  - `tests/e2e/project-frame.e2e.test.ts` (6);
  - `tests/cli/cli.test.ts`.
- On Wiz v3, the dialog exports of idle-v3, greeting-v3 and the idle-v3 → greeting-v3 mix
  are all 1341×1617 at origin (−643, −1610). The mix's frame 0 is pixel-identical to
  idle-v3 frame 0 (acceptance test, `251dd79`).
- These controls did not exist before, so there is no pre-fix red run for RV-003.

### RV-001 · Wiz v3, articulated and meshed, built through the editor (`dd08697`)

`npm run build && npm run wiz:v3` (`scripts/roadmap/wiz-v3.ts`) opens the UI-authored
`wiz-v2.rig.json` read-only, in an isolated headless Chrome for Testing profile
(`.hermes/browser-profiles/wiz-v3`). It then re-rigs the same prepared pieces using only
visible controls. `window.__rigsmith` is read for assertions only. There is no new art:
the v3 `images` deep-equal the v2 images.

| Part | What the builder did (log: `.hermes/evidence/usecase-milestone/wiz-v3-run-6.txt`) |
|---|---|
| Body | **+ Bone** `hips` (0, length 300) and `chest` (300, 263) under `body`, `head` (400) under `chest`. **Fill grid** 8×10 (99 vertices) + **Auto weights**, then weight brush (Add, strength 1): rows 0–4 → head, 6–7 → chest, 8–10 → hips; row 5 keeps the Auto chest/head blend. |
| Arms | Under chest, split at the elbow (`arm_s` → `forearm_s` → `hand_s`). **Fill grid** 10×10 (121 vertices) + Auto weights, then the brush. Hand-region vertices go to the forearm. A Replace-mode ramp of 68 / 65 vertices runs the forearm weight from 0 to 1 over 25–75 % of the arm. **2-bone IK**, target under chest. Sleeve holes are rebound to chest with their placement unchanged. |
| Legs | Under body, split at the knee (102 + 102). **Fill grid** 4×10 (55 vertices) + Auto weights. **2-bone IK**, target on root. A `foot` bone on each IK target, with the shoe vertices painted to it. |
| Rig | 21 bones, 4 IK (`forearm_l/r-ik`, `shin_l/r-ik`), 5 meshes (body 99 v, arms 121 v, legs 55 v). |
| Motion | The inherited FK animations are deleted. `idle-v3` (18 keys, 6 frames) and `greeting-v3` (71 keys, 28 frames) are typed in the inspector at the key frames of `idle` / `greeting-v2` (the provisional timing baseline, see §5). Then Ctrl+A → smooth, 10 curve presets on greeting-v3, and **Close loop**. |
| Delivery | **Set frame: fit to all animations** → 1341×1617 at (−643, −1610). **Export sequence…** (PNG ZIP + APNG) for each loop and **Mix…** (idle-v3 → greeting-v3 at 1 s, 0.3 s) at the project frame, with no clipping warnings. **Save** → `.hermes/assets/wiz/v3-output/wiz-v3.rig.json`. |

**Determinism.** Two consecutive builder runs (run-5 and run-6) produce the same project
once the 45 generated IDs (`bone_…`, `att_…`, `ik_…`, `img_…`, `anim_…`, which are
time-based) are canonicalised in order of first appearance. The canonical sha256 is
`20f62116f2f50c49…`. The file sha differs between runs because of those IDs; the delivered
file is sha256 `2c45f4520b8aea2e…`.

**Acceptance** (`tests/acceptance/wiz-v3.acceptance.test.ts`, part of `npm run test:wiz`).
It opens the saved v3 file, exports through the dialogs in its own session, and measures
editor worlds and exported pixels. Landmarks are mapped through an independent re-skinning
and an independent 2-bone IK (`tests/support/reference-*.ts`). Numbers are from the gate
run, `run-evidence/wiz/v3/rv001-metrics.json`.

| Criterion | Required | Measured | How |
|---|---|---|---|
| (a) head keyed ±6°, hem moves | < 4 px | **0 px**. Reference: head ±6° about its keyed value, at every frame of both loops. Editor: setup pose, in an unsaved scratch animation `head-test`, head rotation typed as ±6° and keyed in the inspector; the animation is deleted afterwards. Other body vertices move up to 79 px, so the head did turn | Hem rows (image y ≥ 900) carry no head weight; the result is structural (§5) |
| (b) elbow bend | ≥ 40° | **left 43.53°, right 68.35°** (max over both loops, editor worlds after IK) | — |
| (b) arm medial axis covered | no transparent px | **min alpha 252** along the centre line, sleeve to glove, at every exported frame | PCA centre line of the mapped arm |
| (c) landing knee flex | ≥ 15° | **left 19.23°, right 40.85°** at greeting-v3 f15 | — |
| (c) shoe bottoms | within 2 px of setup | **0 / 0 px** | Lowest opaque row per half, f15 vs f0 |
| (d) face aspect change | < 3% | **max 1.61%** (f4 1.08%, f8 0.74%, f15 0.68%; rest aspect 1.337) | Eyes + mouth rect mapped through the re-skinned body mesh. The rect (y 335–522) reaches below the rigid head rows (y ≤ 458.4) into the row-5 blend |
| (e) loop seam | last frame = frame 0 | **equal** for all 21 bone world matrices in both loops (\|Δ\| ≤ 1e-6) | — |
| (f) reference diff | p3 budget: ≤ 1% px over 24/255, mean < 1.5 | **worst frame:** greeting-v3 f10, 38 of 783 760 px over (0.005%), mean 0.065. **Others:** 0–24 px over, mean ≈ 0.06 (idle f0/40/62, greeting f4/10/15/24/36, mix f30/35/39/60) | Independent IK + skinning composite vs dialog PNGs |
| editor worlds vs reference IK | — | max \|Δ\| 9.9e-9 over every frame of both loops | Scrubbed on the ruler |
| (g) operator visual review | judgment | **not measured; not claimed** | §6 |

Exports: idle-v3 90 frames, greeting-v3 72 frames, mix 103 frames, all 1341×1617 at the
project frame with no clipping warning.

### RV-008 · Lottie on Wiz (`dd08697`)

`tests/acceptance/wiz-lottie.acceptance.test.ts` (part of `npm run test:wiz`):

| Check | Result (gate run) |
|---|---|
| greeting-demo (flat, FK-only; `.hermes/evidence/wiz-v2-demo/project/wiz-greeting-demo.rig.json`, opened read-only, sha unchanged before and after) through **Export Lottie…** | Inside the subset, no refusal. 1355×1716 · 72 frames at 30 fps · 9 image layers, 9 null layers, 9 embedded PNGs. Composition equals the editor's PNG sequence canvas (fit; the demo has no project frame) |
| In-repo subset evaluator vs the editor sequence, every frame | 1 of 55 890 066 covered px over tolerance 24; worst mean 0.059 |
| **lottie-web 5.13.0** (canvas renderer, headless Chrome for Testing) vs the editor sequence, every frame. Budget of `tests/e2e/p4-lottie.e2e.test.ts`: per frame ≤ 0.5% over and mean ≤ 1.5 | **0 of 55 889 596** px over; worst frame 0.000%; worst mean 0.002 |
| Timing control (lottie-web frame i+10 vs editor frame i; must exceed 5%) | 46.7% over, so the comparison detects differences |
| `rigsmith lottie` | byte-identical to the dialog file |
| Wiz v3 (meshed, IK) in the dialog, idle-v3 and greeting-v3 | Refused. The diagnostics name all 4 IK constraints and all 5 meshes, Export is disabled, and no summary is shown. The CLI exits 1 with the same errors and writes no file |

No mesh support is claimed; meshes stay refused (review: "Expanding the Lottie subset
to meshes — deliberately skip").

**Against the review's three-part acceptance:**

| Part | Status |
|---|---|
| greeting-demo passes the lottie-web budget | **Met** |
| A baked copy of an IK rig exports and matches | **Not implemented.** Per the brief, there is a decision record only, below |
| Live-IK refusal names the bake command | **Partial.** The diagnostic says "bake it into keys first", but no such command exists |

The lottie-web helper was moved to `tests/e2e/lottie-web.ts` and is shared with the p4 test.

**Decision record: "Bake constraints to keys" (not implemented in this milestone).**

- *Proposal (review RV-008).* Add a command that samples the IK/path results per frame into
  bone keys and drops the constraints in a derived copy, so IK rigs can export to Lottie.
- *What it would and would not buy.* Baking IK alone does **not** make Wiz v3 exportable. Its
  five meshes are refused independently of the IK, and image layers cannot deform; the
  review rules out extending the Lottie subset to meshes. Baking only helps rigs with
  **FK + IK + flat art**. The flat greeting-demo is already inside the subset and exports
  today. A flat-art v3 variant (rigid pieces with IK) would be the first real candidate.
- *Design constraints, if it is built.*
  - Output is a derived copy; the live project keeps its constraints.
  - Bake on the animation's frame grid (`fps`). Lottie keys between frames would otherwise
    be a fresh approximation.
  - Key every affected bone's local rotate/translate/scale per frame with linear interpolation.
  - Verify with the existing budget: the baked copy's Lottie against the live project's PNG
    sequence.
  - The IK diagnostic would then name the command. Today it says "bake it into keys first",
    and no such command exists; this is recorded as a partial answer to the review's
    "names the bake command" criterion.
- *Decision.* Deferred, and owned by the operator. It depends on the RV-008 operator
  question (is Lottie a delivery target?) and on whether a flat-art IK rig is wanted. It is
  not implemented here.

## 4. Delivery artifacts (git-ignored)

`npm run wiz:v3:deliver` (`scripts/roadmap/wiz-v3-deliver.ts`) writes
`.hermes/assets/wiz/v3-output/delivery/` with `MANIFEST.json` (21 files, sha256) and
`delivery-log.txt`.

| File(s) | What, and how it was checked |
|---|---|
| `idle-v3.seq.zip`, `greeting-v3.seq.zip` | `rigsmith render --frame project`, byte-identical to the Export sequence… ZIPs saved by the builder |
| `idle-v3-to-greeting-v3.seq.zip` | `rigsmith mix --at 1 --frame project` (stored 0.3 s rule), byte-identical to the Mix… dialog ZIP |
| `*.apng` | idle-v3 / greeting-v3 from the dialog. Mix from the CLI, decoded by Pillow and equal to the PNG frames |
| `*.webm` | VP9 yuva420p, 1341×1617, alpha. Decoded with libvpx-vp9: mean \|Δ\| vs PNG 0.50–0.59 at 3 frames per file |
| `*.mp4` | H.264 yuv420p, no alpha, on `#ffffff`, padded to 1342×1618. Mean \|Δ\| 2.25–2.33 |
| `greeting-v2-vs-v3.png` | Before/after sheet, greeting-v2 (FK, rigid) over greeting-v3 at frames 0,4,8,10,15,18,24,30,36,48,60,66 |
| `idle-v2-vs-v3.png` | Same for idle / idle-v3 at frames 0,15,30,40,45,50,60,75,89 |
| `mix-idle-v3-to-greeting-v3.png` | The mix at frames 0,20,29,30,32,34,36,39,45,60,80,102 |
| `compare-*.seq.zip` | The four sources of the sheets |
| `greeting-demo.lottie.json` | `rigsmith lottie` of the flat demo, identical to the dialog export of the acceptance run |

**Comparison frame.** The sheets render v2 and v3 on one explicit world rect:
−643, −1646, 1370 × 1659. This is the union of the v3 project frame and the fitted v2
frames, because greeting-v2's art extends past the v3 frame (the CLI reports clipping of
32 / 25 / 2 px at top / right / bottom). Each sheet uses one shared crop for all rows
(`contact_sheet.py --crop`). The frame numbers are identical across rows.

Builder outputs in `.hermes/assets/wiz/v3-output/`:
- `wiz-v3.rig.json`;
- the dialog ZIP/APNG exports;
- `editor-greeting-v3-f18.png`;
- `editor-rig-v3.png`;
- `build-log.txt`;
- `check/` (zoomed frames used for the visual notes in §5).

## 5. Deviations and limitations

- **Timing baseline.** The key frames of `idle` / `greeting-v2` are used as the provisional
  baseline. No operator preference between greeting-v2 and greeting-demo has been recorded
  (RV-011). Departures from that baseline are new motion and need operator review:
  - head keys (v2 had no head bone);
  - forearm IK-target arc in-betweens at greeting-v3 f13 and f55. A translation key
    interpolates as a chord, which folded the elbow mid-swing; the key-pose frames are
    unchanged;
  - knee flex from the IK legs.
- **Rig choices that differ from the review sketch:**
  - arm grids are 10×10 (the review said 2×6) plus a forearm weight ramp, for a smoother
    elbow;
  - foot bones on the IK targets keep the shoes planted;
  - the FK animations are not carried into v3.
- **Visual limitations seen in the exports, for the operator:**
  - a small sleeve-hole sliver near the right cuff at greeting-v3 f8;
  - crease marks in the prepared arm art become visible as the forearm bends (the art, not
    the mesh);
  - the bend sits close to the cuff;
  - the knee flex is asymmetric (left 19°, right 41° at f15) because of the lean;
  - the face rect partly overlaps the row-5 neck blend band.
- **(a) is structural.** The hem vertices carry no head weight, so 0 px hem motion comes
  from the weights, not a measured blend. The head-tilt angle at which the jacket shear
  becomes visible is still an operator question (review §7).
- **(g)** Operator visual review is not measured and is not claimed.
- **Reference tolerance.** `tests/support/reference-constraints.ts` accepts bone-1 scale
  within 1e-9 of uniform. Reparent leaves 1 ± 2e-16.
- **Earlier deviations (`e425d5c`, `c9c45dc`):**
  - the fallback download keeps the project dirty by design;
  - dialogs default to the project frame when there is one;
  - the frame carries no background colour;
  - an older reader ignores `frame`;
  - `sequence.json` records `frame`.
- **Not done (non-goals or later priorities):**
  - new art, blinks or mouths;
  - RV-009 (motion reuse), RV-010, RV-012 onward;
  - constraint baking;
  - mesh support in Lottie;
  - renderer changes.
- **Media.** WebM alpha was verified only by the ffmpeg libvpx-vp9 decode on this machine,
  not in Safari or headed Chrome. MP4 was not checked in the publishing targets.
- **No human session.** No person has used the editor on Wiz v3. Every interaction was
  scripted through visible controls.

## 6. Operator-only decisions

1. Visual preference: greeting-v2 vs greeting-demo (RV-011), and v2 vs v3 using the sheets
   and media in §4. Criterion (g).
2. Whether the v3 timing departures in §5 (head keys, arc in-betweens, knee flex) are
   wanted, or whether authoring should restart from a different preferred timing.
3. Whether Lottie is a delivery target, and so whether "Bake constraints to keys" (§3,
   RV-008) or a flat-art IK variant should be built.
4. Acceptability at delivery size of the sleeve-hole sliver, the elbow art creases, the
   cuff-side bend, and the head-tilt / neck-blend behaviour.
5. The fallback-download UX (stays unsaved), and whether exports should default to the
   project frame.
6. The thirty-minute hands-on session in the editor on Wiz v3 (review §6), which no worker
   can supply.
