# Rigsmith roadmap: delivery report

- **Contract:** `.hermes/dispatch/roadmap/BUILD-CONTRACT.md`, the operator-approved Fable
  roadmap (phases 1–4).
- **Builder:** Claude Opus 5.5 (`claude-opus-5-5`), alone: no other agents or models.
- **Sync:** the working plan and the detailed per-control evidence are kept in step with
  this report in `docs/ROADMAP-IMPLEMENTATION.md`.
- **Status:** Hermes has **not** verified this work. This is the worker's handoff, not a
  certification.

Rigsmith is an independent browser editor. Nothing here claims parity with Spine or any
other commercial tool, and nothing claims the art or motion is "better". Where art or
motion quality matters, that is the operator's judgement. The numbers below are
measurements, not quality verdicts.

## 1. Commits (local only; the repo has no remote, nothing was pushed or deployed)

| Phase | Commit | Content |
|---|---|---|
| 1 | `8aef453` | Bezier easing + curve editor, timeline multi-select/retime/copy/paste/nudge/loop seam, PNG-sequence export, onion skin, autosave/recovery, reference checks, Wiz greeting v2 |
| 2 | `efcda86`, `0c07e0a` | Slot keys (visibility/opacity/image), draw-order keys, two-bone IK, path constraints, cutout tools; follow-up: patch alpha cap, joint extension, eyedropper, test-id audit gate |
| 3 | `fdb56e8` | Meshes, triangulation, vertex/weight editing + weight paint, deform keys, layered mesh renderer, format v2 |
| 4a | `ff1916b` | Skins, transition mixing (missing-track policies, interrupts) |
| 4b | `69cc9b4` | Texture atlas packing/export, exact PNG codec |
| 4c | `a71e917` | Runtime schema v2, reference player (`player.html`) |
| 4d | `ec57b7e` | Headless CLI/API (`scripts/rigsmith.ts`), brand-pipeline example |
| 4e | `10aa08a` | Lottie supported-subset exporter with diagnostics |
| 4f | `468a13b` | Animated media: APNG + GIF (editor and CLI), WebM/MP4 via ffmpeg (CLI) |
| docs | `e4c4180` | First version of this report, README/architecture/matrix sync, STATUS |
| 2 (completion) | `dfe27bb` | Colour selection (flood fill / threshold), selection cuts, speck removal; media format-note wording; CLI media cancel after the last frame is piped |
| docs | the commit that updates this file | Final numbers, STATUS |

## 2. Final gate run, fresh, at HEAD `dfe27bb`

- **Run:** `sh scripts/roadmap/run-gates.sh final-gates`, finished 2026-10-18T05:59Z.
- **Raw logs:** `.hermes/evidence/roadmap/final-gates/<gate>.log`, with a summary in
  `summary.txt`.
- **Tree:** clean at run time; this docs update came after the run.
- **Earlier final run:** an earlier `final-gates` run on `468a13b` was superseded and its
  folder replaced.

| Gate | Command | Exit | Result |
|---|---|---|---|
| Preservation | `python3 -I scripts/roadmap/check_preservation.py` | 0 | 16/16 protected originals match `preservation-baseline.json` (SHA-256) |
| Control coverage | `node scripts/roadmap/testid-audit.ts` | 0 | 263 UI test ids, 0 allow-listed, 0 never referenced by a test |
| Unit | `npm test` | 0 | 157/157 pass |
| Typecheck | `npm run typecheck` (app + tests/scripts/examples) | 0 | — |
| Build | `npm run build` | 0 | `tsc --noEmit` + Vite (index, player, render pages) |
| Browser e2e | `npm run test:e2e` (headless Chrome for Testing 155.0.8059.39, project-local profiles) | 0 | 132/132 pass |
| CLI | `npm run test:cli` | 0 | 13/13 pass |
| Wiz acceptance | `npm run test:wiz` | 0 | 16/16 pass |

Failure buckets: none in this run. The historical baseline counts (43 unit, 20 browser,
11 Wiz) are from before the roadmap work (`.hermes/evidence/roadmap/baseline/`). They are
**not** results of this run. No original regression assertion was removed or weakened.
`wiz:build` and `wiz:capture` were never run.

Per-phase gate runs, each fresh, all exit 0 (`.hermes/evidence/roadmap/<label>/summary.txt`):

| Run | Unit | e2e | CLI | Wiz |
|---|---|---|---|---|
| `phase1-gates` | 76 | 42 | — | 16 |
| `phase2-gates` | 102 | 58 | — | 16 |
| `phase2b-gates` | 106 | 66 | — | 16 |
| `phase3-gates` | 122 | 93 | — | 16 |
| `phase4a-gates` | 129 | 105 | — | 16 |
| `phase4b-gates` | 136 | 109 | — | 16 |
| `phase4c-gates` | 141 | 118 | — | 16 |
| `phase4d-gates` | 141 | 118 | 8 | 16 |
| `phase4e-gates` | 145 | 122 | 9 | 16 |
| `phase4f-gates` | 152 | 129 | 12 | 16 |
| `final-gates` (at `dfe27bb`) | 157 | 132 | 13 | 16 |

## 3. Matrix against the contract

"Delivered" means a visible control (or a documented CLI command) exists and a test
exercises it. The ids and measurements for each row are in
`docs/ROADMAP-IMPLEMENTATION.md`.

### Phase 1: shaped motion and transparent delivery
| Contract item | Status | Notes |
|---|---|---|
| Per-key cubic Bezier easing, overshoot, monotonic solver, explicit interp schema; editable curve controls | delivered | `curve-editor`: handles, numbers, presets; one undo step; Esc cancels |
| Multi-select, group retime, copy/paste across frames/bones, nudge, loop seam, collision policy, gesture undo, Esc | delivered | p1-motion e2e |
| Generic PNG-sequence ZIP: range/FPS/scale, stable bounds + padding, first/last preview, progress/cancel, capacity/errors | delivered | Independent PNG/ZIP decoders; loop policy omits the duration endpoint |
| Onion / ghost frames as view state | delivered | Undo depth unchanged (tested) |
| Autosave / recovery, non-destructive, visible quota failure | delivered | — |
| Independent setup + posed reference checks; typecheck covers tests/scripts | delivered | `tests/support/reference-composite.ts` imports nothing from `src/` |
| New Wiz greeting via UI controls: anticipation, overshoot, glove follow-through; contact sheet; alpha output; originals untouched | delivered | Authored by a scripted browser driving visible controls, not by a human. Measured: anticipation +15.5°, overshoot 6.3°, glove peak 10 frames after the arm. Outputs in `.hermes/assets/wiz/roadmap-output/` (git-ignored) |

### Phase 2: articulation and flat-art workflow
| Contract item | Status | Notes |
|---|---|---|
| Attachment swaps / visibility / opacity / draw-order keys, persisted and in the runtime | delivered | — |
| Two-bone IK: target, bend direction, mix, unreachable / degenerate / mirrored | delivered | — |
| Path constraints: author/edit, sampling/spacing, persistence/export | delivered | Checked against an independent arc-length sampler |
| Cutout tools: mask/crop, pivot, overlap, patch, non-destructive | delivered | Flat-colour patch only. No hidden art is inferred |
| Bring the Wiz-prep workflow into visible controls | delivered | Every prep step has a control: polygon masks, pivots, patch, joint extension, colour-threshold selection, flood fill (Shift+click adds), speck removal. Each uses the prep script's semantics and constants as defaults, and speck removal equals the script's rule run through Pillow. Selection cuts render in place with max diff 0 (`dfe27bb`) |
| Demonstrate authoring, swaps and bent limbs via the UI | delivered | `npm run demo:phase2` on original procedural art |
| Jointed Wiz v2 (optional, "may") | not produced | The generic tools are demonstrated on original art |

### Phase 3: meshes, weights, deformation
| Contract item | Status | Notes |
|---|---|---|
| Mesh authoring/triangulation, textured rendering, editable vertices, normalized weights + weight paint, deform keys, undo/redo, import validation | delivered | — |
| Smallest sound renderer, with seams/flips/alpha/degenerate triangles verified independently | delivered | Canvas2D clipped affine triangles, layered. Verified on CfT's software raster only |
| Versioned format, lossless v1 migration, documented reader limits | delivered | v1 files re-save byte-identically; v1 readers reject v2 (documented) |
| Bendy-limb / secondary-motion demo with rendered reference tests | delivered | `npm run demo:phase3`. Appeal is the operator's call |

### Phase 4: follow-ons and pipeline
| Contract item | Status | Notes |
|---|---|---|
| Skins with visible editing/switching, safe reuse, validation | delivered | — |
| Mixing/transition preview incl. missing tracks and interrupts | delivered | Frames match an independent blend: 0 px over tolerance |
| Texture atlas: deterministic metadata, padding/bleed, round-trip consumer | delivered | 0 differing px on reconstruction; byte-identical re-export; the player consumes it |
| Runtime schema + reference player with editor/runtime agreement | delivered | Player frames equal editor frames (0 px over tolerance), wave / skin / mix |
| Headless authoring/export via stable commands/API (not the probe); reproducible brand pipeline | delivered | `scripts/rigsmith.ts` (12 commands), `docs/cli.md`. Brand manifest is identical across two runs |
| Lottie supported-subset exporter with explicit diagnostics | delivered (subset) | See the Lottie note below the table |
| Animated media with honest codec/alpha/platform labels; PNG sequence stays the alpha path | delivered | See the media note below the table |
| HEVC-alpha, ProRes 4444, animated WebP, audio | absent | Not attempted |

**Lottie.** Bones, flat images, all easing types, opacity, visibility/image swaps and
skins are exported. IK, paths, meshes, deform keys, draw-order keys and constraint keys
are refused, and the diagnostic names the item. Fidelity was checked only by an in-repo
evaluator, frame by frame against the editor: 0.108% px over tolerance; a wrong-skin
control gives 23.1%. **Not tested in lottie-web, After Effects or any other player.**

**Media.**
- APNG (lossless, the frames exactly) and GIF (256 colours, 1-bit alpha with the alpha
  loss reported) are available from the editor and the CLI.
- WebM VP9-alpha and MP4 H.264 (no alpha, on a background colour) are **CLI only** and
  need a local ffmpeg.
- Every codec is decoded independently: Pillow, ffmpeg/ffprobe, and Chrome for
  Testing's `ImageDecoder` for APNG/GIF.

Export gates (contract §"Export gates") for every shipped output:
- Frame counts follow the chosen fps, range and endpoint policy.
- Every frame has the same size, with bounded padding and a transparent background.
- Each sample is decoded independently.
- Tested in the browser:
  - range errors: the GIF fps cap and capacity limits;
  - cancel: the ZIP, plus the rendering and encoding phases of APNG/GIF (the Mix dialog's
    export shares the ZIP encoder, but its cancel is not tested separately);
  - large export: 50 frames at 539×541, APNG and GIF.
- Tested in the CLI: cancel kills ffmpeg and Chrome, and leaves no partial output.
- Setup and posed frames are compared with independent references at stated tolerances.

## 4. Limitations and residual uncertainty

- **Raster and platform:**
  - Rendering was verified on headless Chrome for Testing 155 (software raster) on this
    Mac only.
  - Canvas2D mesh rendering reallocates the mesh layer canvas on every mesh draw (cost
    grows with mesh count). This fixed a history-dependent antialiasing bug.
- **Lottie:** limited to the subset above; validated by our own evaluator, not a
  third-party player. Players differ on skewed parented nulls.
- **Media:**
  - GIF has a 50 fps cap and binary alpha.
  - WebM/MP4 bytes are deterministic only for this machine's ffmpeg build.
  - No browser or player playback of WebM alpha was tested.
  - The editor cannot write WebM/MP4: there is no muxer in the browser build.
- **Bytes:**
  - CLI APNG/atlas PNG bytes differ from the editor's (Node vs Chrome zlib); the pixels
    are identical.
  - CLI render/mix ZIPs and GIFs are byte-identical to the editor's.
- **Authorship:** Wiz greeting v2 and the demos were authored by scripts driving visible
  controls, not by a human animator. No claim is made about art quality or appeal.
- **Pixel tools:** selections are pixel-exact (no antialiased edge, no feathering). Speck
  removal handles faint isolated pixels only; there is no general pixel painting.
- **Not offered:** weight smoothing or mirroring; on-canvas add/delete of mesh vertices;
  automatic outline tracing.
- **REA:** no REA MCP calls were made during the roadmap work. `docs/rea-evidence.md`
  covers only the original slice. All roadmap evidence is from the repo's own tests and
  the independent decoders named above.

## 5. Reproduction

```sh
npm ci                                    # once
npm run build                             # dist/ (editor, player.html, render.html)
sh scripts/roadmap/run-gates.sh mylabel   # every gate fresh → .hermes/evidence/roadmap/mylabel/
# or individually:
npm test; npm run typecheck; npm run test:e2e; npm run test:cli; npm run test:wiz
python3 -I scripts/roadmap/check_preservation.py
npm run demo:phase2; npm run demo:phase3  # demo outputs → .hermes/assets/roadmap-demos/
npm run example:brand                     # brand pipeline → .hermes/assets/roadmap-demos/brand-pipeline/
node scripts/rigsmith.ts media rig.rig.json --anim wave --format gif --out wave.gif
npm run preview                           # http://127.0.0.1:47613/ (local only); player at /player.html
```

Requirements:
- Headless Chrome for Testing at the path in `tests/e2e/harness.ts` (or `RIGSMITH_CFT`).
- `python3` with Pillow, for the media decode checks.
- `ffmpeg`/`ffprobe` for the WebM/MP4 tests; that CLI test block is skipped and reported
  as skipped when they are missing.
