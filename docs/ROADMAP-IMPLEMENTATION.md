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
| Two-bone IK (target, bend dir, mix, unreachable/degenerate/mirrored) | delivered | `src/model/constraints.ts`; `ik-add-2/1`, `ik-target`, `ik-mix` (+key), `ik-bend`, pink target on canvas; unit `constraints.test.ts` (reach, straighten, fold, degenerate, mirror, mix, turns); p2-rig IK suite incl. Esc, mirrored root, reference render |
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

### Phase 3 — meshes, weights, deformation
| Item | Status | Evidence |
|---|---|---|
| Mesh authoring + triangulation, textured rendering | absent | |
| Editable vertices, weights + weight paint, deform keys | absent | |
| Renderer checks: seams, flips, alpha, degenerate triangles | absent | |
| Format evolution, lossless v1 migration | absent | |
| Bendy limb / secondary motion demo | absent | |

### Phase 4 — follow-ons and pipeline
| Item | Status | Evidence |
|---|---|---|
| Skins / attachment sets, validation | absent | |
| Animation mixing / transition preview (missing tracks, interrupts) | absent | |
| Texture atlas packing + round-trip consumer | absent | |
| Runtime schema + reference player, editor/runtime agreement | absent | |
| Headless CLI/API + brand-pipeline examples | absent | |
| Lottie supported-subset exporter + diagnostics | absent | |
| Animated media export (beyond PNG sequence) | absent | |
