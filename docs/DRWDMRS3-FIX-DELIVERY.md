# drwdmrs3 review — first fix pass: delivery record

This is the first fix pass on the drwdmrs3 roadmap review (reviewed HEAD `1fb854e`, verdict
CONDITIONAL; the review itself is kept privately at `.hermes/dispatch/roadmap-review/REVIEW.md`).
It records how each finding was handled. **It does not certify acceptance, parity or
publication.** Hermes verification and the next review (Fable 5.1) are separate and come
later.

- Pass HEAD at gates: `a0183ec` (all code final; later commits touch docs only).
- Evidence root (git-ignored): `.hermes/evidence/post-review/first-fix/` — `pre/`
  (before a fix), `red/` (the regression test against the pre-fix build), `green/` (after),
  `post/`, `probes/` (probe scripts and their raw output), `gates/`, `run-evidence/` (test
  outputs redirected with `RIGSMITH_EVIDENCE`).
- RED runs: production files were stashed (`git stash push -- <src files>`), the build
  was rebuilt, the new test was run and its failure saved, and then the change was restored.
- IDs: P1-1 … P3-3 are the reviewer's own. Items the reviewer did not label are numbered
  DRW-001 … DRW-009 and quoted verbatim.

## Summary

| ID | Disposition | Commit(s) |
|---|---|---|
| P1-1 Auto weights throws on distant vertices | fixed | `f07524a`, follow-up `998c7b3` |
| P2-1 Two-bone IK under non-uniform scale | fixed (stated sampling limit) | `25ef689`, `b189509`, `608c4b1` |
| P2-2 Player accepts malformed runtime files | fixed | `b189509` |
| P3-1 Player keeps the previous frame after a load error | fixed | `b189509` |
| P3-2 Undo history ≈ 1.1 GB | fixed (sharing + no-op skip; no byte budget) | `690350d` |
| P3-3 provenance omits ffmpeg | fixed | `d3f431d` |
| DRW-001 Whole deform track deleted | fixed | `48b79e8` |
| DRW-002 Cancel can't interrupt pre-evaluation | not_applicable (grounded) | — |
| DRW-003 Autosave mid-gesture | fixed | `59834ad` |
| DRW-004 Lottie in a third-party player | **unresolved (blocker)** | — |
| DRW-005 WebM alpha in a browser | fixed for Chrome for Testing only | `ce7b1a0` |
| DRW-006 A player that doesn't share the editor's model code | **unresolved (blocker)**; partial check added | `594fb5e`, `97b7a64`, `a0183ec` |
| DRW-007 Testid audit only checks references | **unresolved (blocker)** | — |
| DRW-008 Auto-weight test geometry is narrow | fixed (by the P1-1 tests) | `f07524a`, `998c7b3` |
| DRW-009 Remaining subjective/operator checks | **unresolved (operator-owned blocker)** | — |

Process fix (not a review finding): `e383f3f`. `scripts/roadmap/run-gates.sh` ended with an
`echo` and always exited 0, which hid failed gates. It now exits 1 and prints
`GATES FAILED: <names>`. The regression test is `tests/unit/gates-script.test.ts`, which
uses PATH shims (`red/gates-wrapper.txt`, `green/gates-wrapper.txt`). `fbc5435` adds
`RIGSMITH_EVIDENCE` so that test output can be redirected.

## Final gates (executed, `gates/final-a0183ec/summary.txt`)

| Gate | Result |
|---|---|
| preservation (`check_preservation.py`) | exit 0 — 16/16 protected originals unchanged |
| testid-audit | exit 0 — 263 ids, 0 allow-listed, 0 unreferenced |
| unit `npm test` | exit 0 — 192/192 |
| typecheck `npm run typecheck` | exit 0 |
| build `npm run build` | exit 0 |
| e2e `npm run test:e2e` | exit 0 — 144/144 |
| cli `npm run test:cli` | exit 0 — 13/13 (ffmpeg paths included) |
| wiz `npm run test:wiz` | exit 0 — 16/16 |

The wrapper printed `ALL GATES PASSED`. The first run at `97b7a64` failed typecheck and build
on an unused import in the new DRW-006 test (`gates/final-97b7a64/`), which `a0183ec`
fixed. After the gates: `post/preservation-post.txt` shows 16/16 unchanged; no vite or
Chrome for Testing process remains; ports 47613–47617 are free. `wiz:build` and
`wiz:capture` were never run.

## Findings

### P1-1 — Auto weights throws and does nothing when a vertex is more than 100 px from every candidate bone
- **Reproduced:** `pre/autoweights-ui.txt` was produced through the visible `weights-auto`
  control on the reviewer's case (`probes/autoweights-case.rig.json`). Output: summary stays
  "rigid", undo 0, no toast, page error `Cannot read properties of null (reading 'reduce')`.
- **Fix:**
  - `src/model/meshOps.ts` `autoWeights`: influences under the absolute `MIN_WEIGHT`
    (farther than 100 px) are dropped. A vertex left with none is bound fully to the nearest
    bone, so the result is never null.
  - `src/model/integrity.ts`: null or non-array weight lists are repaired instead of
    throwing.
  - `src/ui/app.ts`: an exception that escapes an event handler is shown as an error toast.
- **Follow-up `998c7b3`:** the first version scaled weights by the strongest influence
  before the cut. That kept far second influences and changed the weights of meshes that
  were already weighted: the p3-demo elbow flattened from 77° to 41.7° (bisected,
  `probes/p3-demo-bisect-absolute-cut.txt`, 7/7). The absolute cut was restored; only the
  empty case falls back.
- **Tests:**
  - `tests/e2e/review-fixes.e2e.test.ts` "P1-1: Auto weights on a large part bound to short
    bones": every vertex is weighted (nearest bone wins), one undo step, no error; plus a
    toast safety-net test.
  - `tests/unit/mesh.test.ts`, including "leaves every previously weighted vertex unchanged
    (absolute 1e-4 cut)".
  - RED/GREEN: `red/p1-1-review-fixes.e2e.txt` → `green/p1-1-review-fixes.e2e.txt`;
    `red/p1-1-mesh.test.txt`; `red/p1-1b-mesh-weights-unchanged.txt` →
    `green/p1-1b-mesh-weights-unchanged.txt`; full e2e `green/p3-2-e2e-all-2.txt`
    (140/140 at the time).
- **Limitation:** beyond 100 px a vertex is bound to its single nearest bone, with no
  blending.

### P2-1 — Two-bone IK misses reachable targets under non-uniform ancestor scale
- **Reproduced:** `pre/ik-nonuniform.txt` (the reviewer's probe, `probes/ik-nonuniform.ts`):
  125/180 reachable targets missed by more than 1 px, worst 71.6 px.
- **Fix (`25ef689`):** `src/model/constraints.ts` solves the chain in the parent's local
  space. The elbow angle is bracketed between the extremes of the shoulder→tip length and
  bisected; bone 1 then turns onto the target. `b189509` makes a non-finite pose stay as
  keyed instead of throwing. `608c4b1` corrects the header comment and
  `docs/architecture.md`.
- **Result:** `post/ik-nonuniform.txt` — 0/180 missed, worst 0.00 px.
- **Tests:** `tests/unit/constraints.test.ts` "two-bone IK under non-uniform scale (review
  P2-1)", which checks reach and bend side against forward kinematics and the brute-force
  probe. RED/GREEN: `red/p2-1-constraints.test.txt`, `red/p2-1-constraints-nonfinite.test.txt`
  → `green/p2-1-*.txt`; `green/p2-1-p2-rig.e2e.txt`.
- **Limitation (documented):** the extremes are located by sampling every 0.5°. Two extremes
  closer than one step (extreme non-uniform scale only) can be missed.

### P2-2 — Runtime loader / reference player accept malformed runtime files as "Loaded"
- **Reproduced:** `pre/player-ui.txt` (`probes/player-ui.ts`; cases from
  `probes/make-player-cases.ts`): bone-cycle, string-number, tri-out-of-range and
  deform-arity were all "Loaded…" with no errors.
- **Fix:**
  - `src/runtime/load.ts` runs the converted rig through `validateProject`: numbers,
    cycles, triangle ranges, deform arity, fps/duration, constraint and mix references.
  - Errors are reported with runtime field paths.
  - A file too broken to convert is reported as malformed.
  - `docs/runtime.md` was updated to match.
- **Tests:** `tests/unit/runtime.test.ts` "runtime file validation (review P2-2)";
  `tests/e2e/review-fixes.e2e.test.ts` "P2-2 / P3-1 …" (each malformed case through
  `player-files`). RED/GREEN: `red/p2-2-runtime.test.txt`, `red/p2-2-p3-1-review-fixes.e2e.txt`
  → `green/p2-2-runtime.test.txt`, `green/p2-2-p3-1-review-fixes.e2e.txt`,
  `green/p2-2-p4-player.e2e.txt`.
- **Limitation:** the baked v1 data (`baked`, `bakedMeshes`, `frames`) is not read and not
  validated.

### P3-1 — The player keeps the previous file's frame after a load error
- **Fix (`b189509`):** `src/player-main.ts` clears the canvas, slider and frame label on a
  failed load. The same happens for an animation or transition that cannot be prepared,
  and the status says so.
- **Tests:** the same e2e describe as P2-2: "a valid file, then <case>: rejected with the
  reason; the previous frame is cleared", and the unpreparable-animation test.

### P3-2 — Undo history memory reaches about 1.1 GB for a large rig
- **Reproduced:** `pre/history-perf.txt` (`probes/history-perf.ts`, the reviewer's rig shape):
  200 edits retain ≈ 1121 MB; a no-op mutation adds an undo step.
- **Fix (`690350d`):** `src/model/history.ts` snapshots share every subtree equal to the
  previous snapshot, and undo/redo restore a deep copy. `src/editor/store.ts` records no
  step for a mutation or gesture that changes nothing.
- **Result:** `post/history-perf.txt` — ≈ 7 MB, and no-op adds 0 steps.
- **No byte budget was added.** The reviewer suggested a byte-budgeted history *or* skipping
  unchanged snapshots; this pass does the second, plus structural sharing.
- **Tests:** `tests/unit/history-memory.test.ts` ("undo history memory (review P3-2)",
  "shareUnchanged / History options"). RED/GREEN: `red/p3-2-history-memory.test.txt` →
  `green/p3-2-history-memory.test.txt`.
- **Limitations:**
  - An edit that rewrites a large subtree (re-meshing a big mesh) still retains a full
    copy of what it changes, for every such step.
  - Undo of a large rig now costs a deep copy (16 ms/step measured).

### P3-3 — `docs/provenance.md` omits ffmpeg
- **Grounded:** `pre/external-tools.txt`.
- **Fix (`d3f431d`):** `docs/provenance.md` gains "External programs run but not vendored or
  bundled":
  - ffmpeg/ffprobe (used by CLI WebM/MP4 and tests). The installed build is GPL-enabled.
    It is not distributed or linked, and exit 3 is returned without it.
  - python3 and Pillow (dev scripts and test decoding only).
- **Test:** `tests/unit/provenance.test.ts` inventories every spawned program name in the
  code and fails if any is missing from `docs/provenance.md`. RED/GREEN:
  `red/p3-3-provenance.test.txt` → `green/p3-3-provenance.test.txt`.

### DRW-001 — Whole deform track deleted
> "Whole deform track deleted. `src/model/integrity.ts:96` deletes an attachment's *entire* deform track if any one key has the wrong vertex count. That can happen after pasting an old deform key into a re-meshed attachment. It can be undone and is reported in the status bar, but it is a coarse data-loss path."
- **Fix (`48b79e8`):** `src/model/integrity.ts` drops only the mismatched keys and notes the
  count ("N deform key(s) of <name> removed (vertex count does not match its mesh)").
  `src/ui/app.ts` paste status counts only the pasted keys that survive and appends the
  repair note.
- **Tests:**
  - `tests/unit/mesh.test.ts` "deform keys of the wrong vertex count (review DRW-001)".
  - `tests/e2e/review-fixes.e2e.test.ts` "DRW-001 …": copy a key → re-mesh with the visible
    grid controls → key frames 10 and 20 → paste at 15. Keys [10, 20] are kept, and the
    status reads "Pasted 0 key(s) at frame 15. 1 deform key(s) of sheet removed …".
  - RED/GREEN: `red/drw-001-*.txt` → `green/drw-001-*.txt`.

### DRW-002 — Cancel can't interrupt pre-evaluation
> "Cancel can't interrupt pre-evaluation. `prepareSequence` (`src/render/sequence.ts`) evaluates every frame synchronously before the cancellable encode loop starts, so long sequences can't be cancelled during that phase."
- **Disposition:** not_applicable, grounded at every call site (`pre/drw-002-callsites.txt`).
  - `src/ui/exportDialog.ts:82` and `src/ui/mixDialog.ts:106` prepare inside `render()`,
    i.e. while the settings preview is shown and before Export is clicked.
  - The Export buttons (`exportDialog.ts:113`, `mixDialog.ts:171-172`) pass the
    already-prepared setup to the cancellable `run()`, so no evaluation happens after
    Export.
  - The player (`src/runtime/player.ts:53,60`) prepares for preview and has no export.
  - `src/render-main.ts` is the headless CLI render page and has no cancel control.
  - `planSequence` caps a sequence at 2000 frames.
- **Measured:** `pre/prepare-sequence.txt` (`probes/prepare-sequence.ts`): a 300-bone rig at
  1980 frames takes 430–506 ms.
- **Existing tests:** cancel during render/encode in `tests/e2e/p1-export.e2e.test.ts` and
  `tests/e2e/p4-media.e2e.test.ts`.
- **Limitation:** each settings change on a very large rig blocks the main thread for up to
  ~0.5 s.

### DRW-003 — Autosave mid-gesture
> "Autosave mid-gesture. Autosave may serialize while a drag is in progress. I saw no harm from it."
- **Reproduced (RED):** `red/drw-003-review-fixes.e2e.txt` — after holding a drag past the
  autosave delay, the stored copy had x = 11.32, an uncommitted pose, against a committed 0.
- **Fix (`59834ad`):** `src/ui/autosave.ts` `writeNow` reschedules while `ed.inGesture`, so
  only committed states are written.
- **Test:** `tests/e2e/review-fixes.e2e.test.ts` "DRW-003 …": hold a drag 2.3 s, check that
  the stored x equals the committed x; Esc; then a finished drag autosaves.
  GREEN: `green/drw-003-e2e-files.txt` (21/21).

### DRW-004 — Lottie in a third-party player
> Missing verification: "Lottie in a third-party player"; remaining checks: "External playback: Lottie output in an actual Lottie player (e.g. lottie-web)".
- **Unresolved (blocker).** `pre/lottie-players.txt` searched node_modules, global npm,
  python `lottie`/`rlottie_python`, binaries, Homebrew formulae and Spotlight, and found no
  third-party Lottie player on this machine.
- Installing one (for example lottie-web as a devDependency) adds a dependency, which is an
  operator decision not taken in this pass.
- **Current coverage:** the in-repo evaluator only (`tests/unit/lottie.test.ts`,
  `tests/e2e/p4-lottie.e2e.test.ts`). The docs already say "Not tested in lottie-web/AE".

### DRW-005 — WebM alpha in a browser
> Missing verification: "WebM alpha in a browser"; matrix: "**alpha playback not verified** | ffprobe checks only; no browser playback test".
- **Verification added (`ce7b1a0`), no product change.** `tests/e2e/p4-media.e2e.test.ts`
  "WebM alpha plays in Chrome for Testing (review DRW-005)" (skipped without ffmpeg):
  - The CLI-made WebM is loaded in a `<video>` in headless Chrome for Testing 155.
  - Seek: each of 30 frames is drawn on `seeked` and compared with the reference frames.
  - Play: at rate 0.25 with `requestVideoFrameCallback`, frames must arrive in order and
    there must be at least 20.
  - Alpha is compared with the reference: mean < 1, and clear/solid agreement > 0.995.
  - Negative control: a yuv420p (no-alpha) re-encode must show almost no clear pixels.
- **Result** (`green/drw-005-p4-media.e2e.txt` 8/8, `green/drw-005-p4-media-report.txt`):
  30/30 seeked frames, 29 played, worst alpha mean diff 0.088; the control had 0/66 652
  clear pixels.
- **Probes:** `probes/webm-video*.ts/.txt`. They found that in headless Chrome
  `requestVideoFrameCallback` does not fire for a paused, seeked video, so the test draws
  on `seeked`.
- **Limitations:** other browsers (Firefox, Safari) not tested (operator item, DRW-009); MP4
  is not played in a browser.

### DRW-006 — A player that doesn't share the editor's model code
> Missing verification: "a player that doesn't share the editor's model code"; matrix: "Editor vs runtime max difference 0, but both use the same model code".
- **Unresolved (blocker); a partial independent check was added (`594fb5e`).**
  - `tests/e2e/p4-player.e2e.test.ts` "every frame of wave matches an independent renderer;
    only IK/path bones come from the runtime's baked rows (review DRW-006)".
  - It diffs the **player's own canvas** on all 30 wave frames against
    `tests/support/reference-composite.ts`.
  - The reference imports nothing from `src/`. It does its own key sampling (bezier
    included), bone hierarchy, slot and draw-order rules, mesh skinning and deform, and
    compositing.
  - It does not solve IK or path constraints, so the four constraint-driven bones (`upper`,
    `lower`, `f1`, `f2`) take their world pose from the runtime's `baked` rows. Those rows
    come from the shared-code exporter.
  - The baked rows hold no shear, so they are used only for those bones. Their world pose has
    no shear because they hang from uniformly scaled bones. `m2` under the non-uniformly
    keyed `m1` is sheared, which is why rebuilding every bone from baked rows failed in the
    first attempt.
- **Result** (`green/drw-006-p4-player.e2e.txt` 10/10, `green/drw-006-p4-player-report.txt`):
  - 6913 px over tolerance 24 in 30 frames, of which only 9 are strict (solid vs clear, or
    an opaque colour difference).
  - A control with the unconstrained pose gives 32 376 strict px.
  - Unconstrained bones agree with the baked rows within 5e-4 px.
- **Diagnosis** (probes `drw-006-localize`, `-mesh`, `-where`, `-classes`, `-fold`):
  - Observed: all remaining differences are alpha-only and on the outline of the deformed
    mesh `band`.
  - Observed: the reference's skinned vertices equal the exporter's `bakedMeshes` within
    1e-3 px.
  - Observed: the mesh never folds (24/24 triangles keep one orientation in every frame).
  - Observed: the player's outline carries ~45–50 px less alpha per frame than the
    reference, with the interior equal.
  - Inferred, not proven: edge sampling or coverage differences (canvas texture filtering at
    the image border vs the reference's 4×4 subsampling).
- **Budgets** (strict ≤ 30, edge share ≤ 4 % of covered px per frame, mean ≤ 0.5) were set
  from the first observed run (9, 3.2 %, 0.26). They are looser than the p3-mesh precedent of
  ≤ 1 % over.
- **Not covered:**
  - constraint solving by a non-shared implementation;
  - the skin and the transition (still player vs editor only);
  - any third-party runtime. None exists for this format.
- Docs: `docs/runtime.md`, `docs/ROADMAP-IMPLEMENTATION.md` (`97b7a64`).

### DRW-007 — The testid audit only checks that each id is referenced
> "Coverage gaps: the testid audit only checks that each id is referenced, and the auto-weight test geometry is narrow." (first half)
- **Unresolved (blocker).** `scripts/roadmap/testid-audit.ts` still only proves that each
  UI test id is *referenced* under `tests/`, not that a browser test *interacts* with it.
- Probe (`probes/testid-strength.ts` → `probes/testid-strength.txt`):
  - All 248 static, non-allow-listed ids are referenced in browser-run test files.
    `anim-select` is referenced only in `tests/acceptance` (run by `test:wiz`, also in a
    browser).
  - 56 ids are reached only through helper wrappers (e.g. `setField(page, 'anim-fps', …)`),
    so a stricter literal-selector rule would be noisy.
- A real "exercised" check would need the browser harness to record interactions. That was
  not done in this pass, and the audit was left unchanged.

### DRW-008 — The auto-weight test geometry is narrow
> "Coverage gaps: … and the auto-weight test geometry is narrow." (second half)
- **Fixed by the P1-1 tests (`f07524a`, `998c7b3`).**
  - The new e2e uses a large part bound to short bones, with vertices more than 100 px from
    every bone: `tests/e2e/review-fixes.e2e.test.ts` "P1-1: …".
  - The unit tests cover the far-vertex fallback and check that existing weights are
    unchanged: `tests/unit/mesh.test.ts`.

### DRW-009 — Remaining subjective/operator checks
> "Remaining subjective/operator checks — Motion appeal … Visual quality of cutout edges and atlas bleed at real art scales. External playback: Lottie output in an actual Lottie player (e.g. lottie-web), and WebM alpha in browsers. Acceptability of the codecs declared absent and of the missing jointed Wiz v2. Parity: no commercial-parity claim is supported, and I make none."
- **Unresolved, operator-owned (blocker).** These are judgments this pass cannot make or
  certify. Status of each part:
  - **Motion appeal, visual quality, codec and jointed-Wiz acceptability:** untouched, for
    the operator.
  - **WebM alpha in browsers:** covered for Chrome for Testing only (DRW-005); other browsers
    remain with the operator.
  - **Lottie playback:** DRW-004.
  - **Parity:** the reviewer's parity line is a statement, not a finding. No parity claim is
    made here.

## Noted, no action (reviewer scope statements, not findings)
- "Error paths covered only by the builder's e2e": the reviewer reran them green but did not
  probe them separately. They remain covered by the same e2e files, all green in
  `gates/final-a0183ec/e2e.log`.
- Matrix rows marked "builder evidence" (cutout workflow, headless CLI, attachment swaps):
  these are about the reviewer's own scope, not defects. The suites are green in the final
  gates (e2e 144/144, cli 13/13).

## Not done in this pass
- No new dependency, no Lottie player installed (DRW-004).
- No byte-budgeted undo history (P3-2).
- No runtime-instrumented testid audit (DRW-007).
- No remote, push or publication; no Spine material; no REA calls.
