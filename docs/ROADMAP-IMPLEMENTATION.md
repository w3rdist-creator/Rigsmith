# Rigsmith roadmap — implementation plan and feature matrix

Contract: `.hermes/dispatch/roadmap/BUILD-CONTRACT.md` (operator-approved, all four phases).
Builder: Claude Opus 5.5 (`claude-opus-5-5`). Status: `.hermes/dispatch/roadmap/STATUS.md`.
This file is the working plan; the final report is `docs/ROADMAP-DELIVERY.md`.

Legend: **absent** · **in progress** · **delivered** (visible control + exercised test) ·
**partial** (stated gap).

## Fresh baseline (2026-10-18, before any roadmap change, commit 3774188)

| Gate | Result | Raw output |
|---|---|---|
| `npm test` | 43/43 pass, exit 0 | `.hermes/evidence/roadmap/baseline/unit.txt` |
| `npm run build` | exit 0 | `.hermes/evidence/roadmap/baseline/build.txt` |
| `npm run test:e2e` | 20/20 pass, exit 0 | `.hermes/evidence/roadmap/baseline/e2e.txt` |
| `npm run test:wiz` | 11/11 pass, exit 0 | `.hermes/evidence/roadmap/baseline/wiz.txt` |
| Preservation hashes | 16/16 match `preservation-baseline.json` | (checked by `scripts/roadmap/check_preservation.py`) |

## Architecture decisions

- **One evaluation pipeline** (`src/model/evaluate.ts`): sample local pose (curves) →
  constraints (IK, path) → world matrices → per-attachment state (visibility, opacity,
  image, skin, draw order) → mesh deform + skinning. Viewport, sequence export, runtime
  player and CLI all consume it. Rendering is a pure function of (project, evaluated
  frame, view, images) in `src/render/`, so export never touches editor time/selection.
- **Format**: `rigsmith.project` v1 (legacy) and v2 (superset). The writer emits v1 when
  a project uses no v2 feature, so v1 files re-save byte-identically; otherwise v2.
  v1 readers reject v2 files (version check) — documented, not "backwards compatible".
  Files whose content needs v2 but declare v1 are rejected.
- **Undo** snapshots use a generic deep clone that shares only immutable `ImageAsset`s.
- **Independent references**: tests carry their own PNG decoder and compositor that do
  not import `src/model`.

## Feature matrix

### Phase 1 — shaped motion and transparent delivery
Fresh gate run: `.hermes/evidence/roadmap/phase1-gates/summary.txt` (unit 76/76, typecheck,
build, e2e 42/42, wiz 16/16, preservation 16/16 — all exit 0).

| Item | Status | Evidence |
|---|---|---|
| Per-key cubic Bezier easing, overshoot, monotonic solver, explicit interp schema | delivered | `src/model/curve.ts`; `tests/unit/curves-keys.test.ts`; p1-motion "curve presets" |
| Curve editor: draggable handles, numeric fields, presets; one undo step; Esc cancel | delivered | `src/ui/curveEditor.ts` (`curve-editor`, `curve-preset`, `curve-x1..y2`); p1-motion handle drag / Esc / numeric |
| Timeline multi-select, group retime, collision policy | delivered | `key-marquee`, shift-click; p1-motion group drag, collision, marquee |
| Copy/paste across frames/bones, nudge, loop-seam helper | delivered | `copy-keys`, `paste-keys`, `nudge-left/right`, `loop-seam`; p1-motion |
| Gesture-level undo + Esc cancel for timeline/curve drags | delivered | `cancelHooks`; p1-motion "Esc during group drag", "handle drag + Esc" |
| PNG sequence export (ZIP), range/FPS/scale, stable bounds+padding, first/last preview, progress/cancel, capacity/errors | delivered | `src/ui/exportDialog.ts`, `src/render/sequence.ts`, `src/model/sequence.ts`; p1-export (decoded with independent `tests/support/png-decode.ts` + `zip-read.ts`) |
| Onion/ghost frames (view state, not undo) | delivered | `onion-toggle/before/after/step`; p1-motion onion test asserts undo depth unchanged |
| Autosave + non-destructive recovery, visible quota failure | delivered | `src/ui/autosave.ts`; p1-export autosave/recover/discard/quota |
| Independent setup + posed render reference checks | delivered | `tests/support/reference-composite.ts` (no `src` imports); p1-export setup + walk f0/f7/f19; wiz-v2 f14/f27 |
| Typecheck covers tests/scripts | delivered | `tsconfig.node.json` + `types/node-shim.d.ts`; `npm run typecheck` |
| Wiz greeting v2 via UI (anticipation, overshoot, glove follow-through), contact sheet, alpha output | delivered | `scripts/roadmap/wiz-greeting-v2.ts` (UI-driven), `tests/acceptance/wiz-v2.acceptance.test.ts`, `scripts/roadmap/contact_sheet.py`; outputs in `.hermes/assets/wiz/roadmap-output/` (git-ignored); metrics `.hermes/evidence/wiz/v2/motion-metrics.json` |

Wiz v2 measured (world-space, relative to setup): anticipation +15.5° before the raise
(v1: 0°); arm peaks at −86.1° on f16 then settles to the −79.8° hold on f18 (overshoot
6.3°); glove peaks f26 (−27.7°), 10 frames after the arm peak; root dips 6 px before the
hop; loop frame 72 equals frame 0 for all 8 bones. Limits: authored by a scripted
browser driving visible controls, not by a human artist; "better" is not claimed —
only the measured properties above.

### Phase 2 — expressive articulation and flat-art workflow
Fresh gate run: `.hermes/evidence/roadmap/phase2-gates/summary.txt` (unit 102/102, typecheck,
build, e2e 58/58, wiz 16/16, preservation 16/16 — all exit 0).

| Item | Status | Evidence |
|---|---|---|
| Attachment (slot) visibility/opacity/image keys | delivered | inspector `slot-visible`, `slot-opacity`, `slot-image` + key toggles; `src/model/rigOps.ts`; p2-rig "visibility, opacity and image keys…"; reference compositor diff `p2-rig/slots-reference.txt` |
| Draw-order keys | delivered | `draw-backward/forward` (Animate mode); integrity pass keeps keys valid on attachment add/delete (`src/model/integrity.ts`); p2-rig "draw-order keys…"; unit `rig-ops.test.ts` |
| Two-bone IK (target, bend dir, mix, unreachable/degenerate/mirrored) | delivered | `src/model/constraints.ts`; `ik-add-2/1`, `ik-target`, `ik-mix` (+key), `ik-bend`, pink target on canvas; unit `constraints.test.ts` (reach, straighten, fold, degenerate, mirror, mix, turns; non-uniform parent/own/mirrored scale checked against forward kinematics and the review's brute-force probe — fixed in the drwdmrs3 fix pass, P2-1); p2-rig IK suite incl. Esc, mirrored root, reference render |
| Path constraints (authoring, sampling/spacing, persistence/export) | delivered | `+ Path`, canvas node/handle drag, `path-closed`, `path-add-node`, `pc-bone-*`, `path-constrain`, `pc-position/mix/spacing/rotate/offset` (+keys); arc-length `PathTable`; p2-rig path suite checks position against an independent arc-length sampler; save/reopen test |
| Cutout tools (mask/crop, pivot, overlap, patch, non-destructive) | delivered | `src/model/cutout.ts` (pure, unit-tested), `✂ Cut out piece…` dialog (`cutout-canvas`, polygon/rectangle/pivot modes, `cut-overlap`, `cut-remainder`, `cut-patch`, `cut-bone`); provenance `ImageAsset.derived` shown in Images panel; pivot mode (`pivot-mode`) via `moveBonePivot`; p2-rig: cut in place renders pixel-identical (max diff 0), source bytes unchanged, patch labelled with synthesized pixel count |
| UI demonstration: authoring, swaps, bent limbs (original art) | delivered | `scripts/roadmap/demo-phase2.ts` (`npm run demo:phase2`) drives the UI with procedural original art (`tests/support/png-encode.ts`): rounded-joint cutout elbow, IK wave, hand image swaps, badge blink + draw order; outputs `.hermes/assets/roadmap-demos/phase2/` (rig, sequence ZIP, contact sheet, editor screenshot) |

Phase-2 semantics and limits (also in docs/architecture.md):
- Stepped slot channels (visibility, image, draw order) show the setup value before their
  first key; interpolated opacity holds its first key (like bone channels). Close loop
  writes the frame-0 value at the end (setup value for stepped lanes keyed after 0).
- Constraint order: all IK constraints (array order), then all path constraints.
  Open paths clamp at the ends (no extrapolation); closed paths wrap.
- Pivot mode compensates setup transforms exactly; children's translate keys are
  compensated for the setup rotation/scale of the moved bone only.
- A straight cut opens a wedge on the outer side of a bend; a rounded outline centred on
  the pivot (as in the demo) avoids it. Patching fills only with a flat colour — no
  hidden artwork is inferred.
- Jointed Wiz v2 (optional in the contract) was not produced; the generic tools are
  demonstrated on original procedural art.
- The v1 runtime export now bakes worlds through `evaluate()` (constraints included) and
  adds per-frame slot state; the full runtime schema + player is phase 4.

Phase-2 follow-up (after review):
- Patch bug fixed: the flat patch previously also filled background the source never
  covered; it is now capped by the source alpha (`patchBehind(…, limit)`, red→green unit test).
- Joint extension (`cut-extend`, px): sweeps the piece's clean cross-section back past the
  pivot, only under opaque cover (remainder when replacing, else the source), and places the
  piece behind the source (`cut-behind`, auto-ticked). Axis = pivot → outline area centroid.
  Provenance `derived.kind = 'extension'` with the synthesized pixel count. Limit: one
  cross-section is repeated (no texture inference); keeping the source *and* a piece behind
  it thickens the source's semi-transparent edges (opaque pixels unchanged, tested).
- Eyedropper (`cut-mode-pick`) sets the patch colour from the art.
- Pixel tools (completion, after the delivery review): `cut-mode-wand` colour selection —
  flood fill (`cut-contiguous`) or threshold, `cut-tolerance`, `cut-min-alpha`, Shift+click
  adds — cut as a pixel-exact piece (`cutOutMask`; overlap, remainder, patch, extension,
  bone as for outlines); speck removal (`cut-speck-faint/solid/dist`, `cut-speck-count`,
  `cut-despeckle` → `cleanup` copy). Unit `cutout-select.test.ts` (independent BFS, the
  prep script's speck rule via Pillow on 3 parameter sets, complementary cut, dilation,
  patch cap, format); e2e `p2-pixel-tools`: counts/bboxes per mode, Esc changes nothing,
  cut pixels exact + remainder complementary + one undo + source bytes unchanged + render
  in place max diff 0, speck count = brute-force rule while parameters change, cleaned
  copy exact, undo/redo, provenance label.
- Control coverage: `scripts/roadmap/testid-audit.ts` (now a gate in `run-gates.sh`) fails
  if any UI `data-testid` is never referenced by a test; `tests/e2e/controls.e2e.test.ts`
  exercises the 64 previously untested controls with asserted effects. 170/170 referenced,
  0 allow-listed.

Wiz-prep parity (the original Wiz art was prepared by scripts; what the editor now offers):

| Wiz prep step | Editor equivalent | Status |
|---|---|---|
| Polygon masks for limb pieces | `cut-mode-polygon` / `cut-mode-rect` | mapped |
| Joint pivots | `cut-mode-pivot`, `pivot-mode` for later edits | mapped |
| Sleeve gap patch | flat `cut-patch` + `cut-mode-pick` eyedropper, capped by source alpha | mapped (flat colour only) |
| Joint extension under the parent | `cut-extend` + `cut-behind` | mapped (single cross-section sweep) |
| Colour-threshold masks | `cut-mode-wand` with `cut-contiguous` off (`cut-tolerance`, `cut-min-alpha`) | mapped (per-channel colour box like the script's ranges) |
| Flood-fill glove selection | `cut-mode-wand` with `cut-contiguous` on (4-connected, PIL floodfill semantics); Shift+click adds | mapped |
| Speck/stray-pixel removal | `cut-speck-faint/solid/dist` (defaults = the script's 100/200/6), live `cut-speck-count`, `cut-despeckle` → `cleanup` copy | mapped (equals the script's rule run through Pillow) |

### Phase 3 — meshes, weights, deformation
Fresh gate run: `.hermes/evidence/roadmap/phase3-gates/summary.txt` (preservation 16/16,
test-id audit 0 missing of 197, unit 122/122, typecheck, build, e2e 93/93, wiz 16/16 —
all exit 0).

| Item | Status | Evidence |
|---|---|---|
| Mesh authoring + triangulation, textured rendering | delivered | `▦ Create mesh…` dialog (`mesh-canvas`, `mesh-mode-outline/interior`, `mesh-grid-cols/rows` + `mesh-grid`, `mesh-undo-point`, `mesh-clear`, live `mesh-summary-dialog`, `mesh-problem`/`mesh-errors`, `mesh-apply`/`mesh-cancel`), `mesh-edit` (re-mesh), `mesh-remove`; `src/model/meshOps.ts` (ear clipping + interior insertion + Delaunay flips; validation); unit `mesh.test.ts` (Euler count, tiling, outline edges kept, manifold, Delaunay, rejections); p3-mesh: bow-tie rejected, counts, cancel, one undo step, rigid mesh renders identical to the flat image (max diff 0) |
| Editable vertices, weights + weight paint, deform keys | delivered | `mesh-tool-vertices` (Setup: moves the image point — render unchanged, max diff 0; Animate: keys a deform that lands the vertex under the pointer ±0.6 px; Esc cancels), `mv-x/y`, `mv-dx/dy`; `mesh-tool-weights` + brush `wp-bone/mode/radius/strength` (one undo step per stroke, sums exactly 1), `mv-w-<bone>`, `mv-add-bone`, `weights-auto`, `weights-rigid`; `slot-key-deform`, `deform-reset`, timeline deform lane |
| Renderer checks: seams, flips, alpha, degenerate triangles | delivered | layered renderer (`drawMeshLayer`: additive no-bleed for unfolded meshes, bleed + triangle order for folds); independent rasterizer in `tests/support/reference-composite.ts`; p3-render: opaque / α128 / opacity 0.5 / weighted bend / mirrored parent all have interior alpha exactly the target, fold and degenerate cases within budget, 2× image swap keeps the silhouette (`p3-render/report.txt`) |
| Format evolution, lossless v1 migration | delivered | `Attachment.mesh`, `slots[].deform` (v2 only; v1 files still re-save byte-identically — format-v2 tests); `readMesh` rejections with locations (unit); integrity: deleted/missing weight bones, setup-image swaps (points rescale), re-mesh drops deform keys — each re-opens (unit + p3-mesh save/reopen deep-equal) |
| Runtime data reproduces editor output | delivered | runtime export `mesh: {uvs, triangles, hull}` + `bakedMeshes[att][frame]`; unit: equals `evaluate()`; p3-mesh: equals the independent skinning (max err < 0.002 px) |
| Bendy limb / secondary motion demo | delivered | `scripts/roadmap/demo-phase3-build.ts` (UI-driven: Fill grid + Auto weights on a continuous hose arm over shoulder→elbow, tail over a 3-bone chain with follow-through keys, tail-tip deform flick drawn with the vertex tool); `npm run demo:phase3` → `.hermes/assets/roadmap-demos/phase3/`; p3-demo: frames 0/15/26/33/45 vs the reference (0 px over tolerance, interior alpha 255 exact across the bends; arm bend 0° at rest, 77° at the elbow keys) |

Phase-3 decisions and limits (also in docs/architecture.md):
- Bind pose = current setup pose (editing setup bones re-binds). Mesh points live in the
  setup image's pixel space; other images (keys/skins) scale only the UVs.
- Renderer verified on headless Chrome for Testing's software raster only. Additive
  seams assume no self-overlap without a reversed triangle; minified hard texture edges
  use Canvas2D's single bilinear tap.
- Weight painting is Setup-only; one stroke dabs on pointer-down and each move (amount
  depends on stroke sampling). No mesh vertex add/delete on the canvas (re-mesh instead),
  no weight smoothing/mirroring tools, no automatic outline tracing from alpha.

### Phase 4 — follow-ons and pipeline
Fresh gate runs: `.hermes/evidence/roadmap/phase4{a..f}-gates/` per sub-phase. Final run at
`dfe27bb`: `.hermes/evidence/roadmap/final-gates/summary.txt` (preservation 16/16, test-id
audit 0 missing of 263, unit 157/157, typecheck, build, e2e 132/132, cli 13/13, wiz 16/16 —
all exit 0).

| Item | Status | Evidence |
|---|---|---|
| Skins / attachment sets, validation | delivered | Skins panel (`skin-add`, `skin-active`, `skin-name`, `skin-duplicate`, `skin-delete`, `skin-summary`, `skin-diagnostics`); attachment inspector `skin-image` (setup image) and `skin-from-<image>` (keyed images); export `seq-skin` switches the editor skin; `src/model/skinOps.ts`; unit `skins-mix.test.ts` (rule incl. keyed images, ops, diagnostics, format rejections); p4-skins-mix: setup + keyed replacement render vs the reference (0 px over tolerance), `seq-skin` changes the pixels, aspect warning, shared-image note, duplicate name rejected, delete + undo, image removal confirm drops entries + undo, save/reopen deep-equal |
| Animation mixing / transition preview (missing tracks, interrupts) | delivered | `⇄ Mix…` (`mix-open`) dialog: `mix-from/to`, `mix-start`, `mix-duration` (stored per pair in `project.mixes`, undoable), `mix-missing` (blend to setup / keep previous pose), `mix-interrupt` + `mix-interrupt-anim/at/duration`, `mix-time` scrub, `mix-play`, `mix-weights`, `mix-canvas`, `mix-rules` + `mix-rule-delete-*`, `mix-export` (PNG sequence ZIP); `src/model/mix.ts`; unit: endpoints exact, shortest rotation, both missing policies, interruption continuity, IK solved after blending, opacity blend, rules persist/repair; p4-skins-mix: every exported frame of idle→wave (both policies) and an interrupted idle→wave→idle matches a pose blended independently in the test (0 px over tolerance), max step 7.5°/frame, peak 50.6° as derived |
| Texture atlas packing + round-trip consumer | delivered (consumer = the reference player, next row) | `Export atlas…` (`export-atlas`) dialog: `atlas-padding`, `atlas-bleed`, `atlas-trim`, `atlas-pot`, `atlas-max`, live `atlas-summary` / `atlas-errors`, `atlas-page-<n>` previews, `atlas-inexact` (non-PNG fallback), `atlas-export` (ZIP: page PNGs + `<name>.atlas.json`), `atlas-cancel`; `src/model/atlas.ts` (trim + 1 px margin, deterministic shelf packing, padding, bleed ≤ padding/2, multi-page, POT, no rotation), `src/model/png.ts` (exact straight-alpha PNG codec); unit `atlas.test.ts` (codec vs independent decoder incl. palette/grey/16-bit/filters, order-independent layout, no overlap, padding, spill, errors, bleed pixels, exact reconstruction); p4-atlas: every imported file reconstructs from the exported pages with 0 differing pixels, bleed column = edge column, two exports byte-identical (sha256), POT/no-trim/too-small/invalid-bleed paths |
| Runtime schema + reference player, editor/runtime agreement | delivered | `docs/runtime.md` (rigsmith.runtime v2 + rigsmith.atlas v1 schemas, shared-code statement); `src/model/exportRuntime.ts` v2 (curves, slot/draw-order/constraint keys, IK, paths, weights, skins, mixes, full-precision keys; duplicate names refused with a reason); `dist/player.html` (`player-files`, `player-anim`, `player-skin`, `player-mix-to`, `player-mix-at`, `player-time`, `player-play`, `player-frame-label`, `player-canvas`, `player-status`, `player-errors`); renderer draws atlas regions; unit `runtime.test.ts` (rig rebuilt from the runtime file evaluates identically — difference 0 — on every frame, both skins, and a mix; v1 files load; bad files rejected); p4-player: runtime + atlas exported from the editor UI, loaded through the player's file control: every frame of wave (30), wave+skin (30) and wave→rest (31) matches the editor export (0 px over tolerance; loose images identical), pose vs baked data ≤ 5e-4, bleed measured (bleed 0: 14 234 px over, bleed 1: 0), missing-texture/page/runtime errors. Found and fixed a renderer history dependence (mesh layer size) |
| Headless CLI/API + brand-pipeline examples | delivered | `scripts/rigsmith.ts` (validate, info, runtime, atlas, render, mix, add-image, replace-image, skin, set-mix; later `lottie` (4e) and `media` (4f), test:cli now 13 tests; JSON stdout, exit codes 0–4, atomic outputs, Ctrl+C cancel) over `scripts/lib/rigsmith-api.ts`; rendering via `render.html` in headless CfT with `dist/` served by request interception (no socket); `docs/cli.md`; `examples/brand-pipeline` (procedural original art, 3 brand skins, CLI-only pipeline, sha256 manifest); `npm run test:cli` (8 tests at 4d): runtime and render/mix ZIPs byte-identical to the editor UI exports, atlas = editor atlas metadata + pixels, error/exit-code paths, cancel leaves nothing and no browser, pipeline twice → identical manifest |
| Lottie supported-subset exporter + diagnostics | delivered (subset; verified by an in-repo evaluator only) | `Export Lottie…` (`export-lottie`) dialog: `lottie-anim`, `lottie-summary`, `lottie-diagnostics` (refusals ✖ + notes), `lottie-export` (disabled when anything is outside the subset), `lottie-cancel`; CLI `lottie`; `src/model/lottie.ts`; `docs/lottie.md` (subset table); unit `lottie.test.ts`: the independent evaluator `tests/support/lottie-eval.ts` (no `src/` imports) reproduces every bone/image matrix, opacity and shown image on every frame (< 1e-6, with/without skin), smooth = cubic exactly, refusal of IK/path/mesh/deform/draw-order/constraint keys; p4-lottie: dialog export played by the evaluator and rasterized vs the editor PNG sequence, every frame (0.108% px over tolerance 24, both skins; a deliberately wrong control gives 23.1%), CLI byte-identical, refusal disables export, CLI exit 1. Not tested in lottie-web/AE |
| Animated media export: APNG + GIF (editor and CLI) | delivered | `Export sequence…` → `seq-format` (PNG ZIP default / APNG / GIF), `seq-format-note` (codec, alpha, timing, loop, what was checked), GIF fps cap and capacity in `seq-errors`, two-phase progress + `seq-cancel`, status reports GIF alpha loss; `src/model/media.ts` (pure-TS APNG + GIF89a/LZW, median-cut palette); CLI `media --format apng\|gif`; `docs/media.md`; unit `media.test.ts` (Pillow + ffprobe decode: APNG exact, GIF binary alpha + counts + timing + LZW resets); p4-media: dialog APNG = PNG sequence on all 30 frames (Pillow exact; Chrome for Testing ImageDecoder max diff 0), GIF alpha binary at 128 everywhere, colour mean error 1.66, reported alpha loss = independent count, Chrome frames = Pillow frames, CLI GIF byte-identical, range/capacity errors, cancel in both phases, 50-frame 539×541 large export |
| Animated media export: WebM VP9-alpha + MP4 H.264 | delivered — CLI only, requires a local ffmpeg | CLI `media --format webm\|mp4 [--background]`; exit 3 without ffmpeg/encoder; single-threaded bitexact (identical bytes twice); Ctrl+C also cancels after the last frame is piped (stand-in encoder test, red before the fix); cli tests: ffprobe (vp9 `alpha_mode 1` / h264 even size, 30 frames 30/1) and ffmpeg libvpx-vp9 decode vs the PNG sequence (alpha mean err 0.066, colour 2.64; MP4 vs composite 2.26/1.77), Ctrl+C kills ffmpeg (exit 4, nothing written); brand pipeline adds wave.gif + wave.webm per brand. Not tested in any browser/player; no editor-side WebM/MP4 |
| HEVC-alpha, ProRes 4444, animated WebP, audio | absent | not attempted |
