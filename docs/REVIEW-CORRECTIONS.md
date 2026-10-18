# Review corrections (LP-001 … LP-014) — 2026-10-18

Input: the Fable review of the later priorities at `40ad69c`
(`.hermes/dispatch/final-two-push-chain/04-fable-review/structured.json`). This is a
worker handoff, not a certification; acceptance belongs to Hermes and the operator.
Raw output is in `.hermes/evidence/review-corrections/` (git-ignored); Wiz outputs are in
`.hermes/assets/wiz/lp-corrections-output/` and `lp004-output/` (git-ignored, new
directories; `v3-output/`, `rv009-output/` and the originals were not written).

New tests: `tests/unit/review-corrections.test.ts` (15), `tests/e2e/review-corrections.e2e.test.ts`
(10), one CLI case (`tests/cli/cli.test.ts`, "wave at 120 fps, scale 0.5 (LP-004)"), and
the mix cases in `tests/unit/reference-constraints.test.ts`.

**Gates.** Fresh run on `e9e50d0` with a clean tree
(`.hermes/evidence/review-corrections/gates-e9e50d0/summary.txt`, run
20261018T215414Z-68031):

| Gate | Result |
|---|---|
| preservation | 0 |
| unit | 256/256 |
| typecheck | 0 |
| build | 0 |
| e2e | 194/194 |
| cli | 15/15 |
| wiz | 31/31 |
| testid-audit | 0 (368 ids, 92 allow-listed, 0 never interacted with) |
| profiles | 0 |

ALL GATES PASSED.
- The first run, on `d1a9061`, failed **testid-audit only**. Three new read-only notices
  (`guide-scope`, `imp-driven`, `imp-rig`) were not in the allow-list. They were added with
  reasons in `e9e50d0`, following the existing convention for read-only containers.
- **Wiz originals.** All 201 pre-milestone hashes were re-checked after the last gate run
  and are OK, with an identical file set (`wiz-assets-sha-check-e9e50d0.txt`).

**Red on the reviewed commit.** The new e2e file was run against a `git archive` build of
`40ad69c`, in `head-40ad69c/` in the evidence directory: 9 of 10 failed
(`e2e-review-corrections-on-head.txt`).
- **Failures on a direct assertion** (the old behaviour itself):
  - LP-002: the old hint is still present;
  - LP-009: the status shows only "Opened …";
  - LP-010: the banner offers the older copy, and the differing browser save was deleted.
- **Failures for a missing control:**
  - LP-011, run alone: there is no `guide-scope`.
- **Failures as a consequence, not a direct red:**
  - LP-001's later tests, LP-006 and the paste test time out behind the earlier failures,
    or on a setup step when run alone. On HEAD these are cascades and missing controls,
    not a direct red of the defect.
  - These were therefore red-checked by mutation on the fixed tree. Each file was restored
    by `cp` and checked with `shasum -c`, then the tree was rebuilt.
    - **LP-006:** with the dialog's `subscribe` removed, the test fails on its first
      assertion: "the list follows the undo", 2 !== 1 (`lp006-mutation/`).
    - **Paste retarget:** with the "onto the selected bone" clause disabled, the status
      assertion fails (`paste-retarget-mutation/`). The first attempt there did not build,
      so it was discarded (`e2e-invalid-build-failed.txt`).
- **LP-001's behavioural red** is `lp001-measure-before.txt`, measured on the unfixed
  model: the report has no driven-by-constraint entry, and the arm keys are dead.
- **The one test that passes on HEAD** is the case HEAD already handled correctly: an older
  legacy autosave is removed.
- **The unit file cannot load on HEAD:** the new exports are missing
  (`unit-review-corrections-on-head.txt`).
- **Mutation red checks** cover LP-004 (`lp004-mutation/`) and FR-003
  (`fr003-mutation-lp004/`).

| ID | Disposition |
|---|---|
| LP-001 | **Fixed** (warning + opt-in). The opt-in's default is an operator decision |
| LP-002 | **Fixed** (hint reworded + opt-in offset) |
| LP-003 | **Message fixed; capability not built** (operator decision) |
| LP-004 | **Fixed**: exports are byte-identical at scale 0.5; the mechanism is not established |
| LP-005 | **Not changed**: operator decision (the review lists it as one) |
| LP-006 | **Fixed** |
| LP-007 | **Fixed** (documented; the behaviour is unchanged) |
| LP-008 | **Fixed** (Wiz rerun after Fit to all animations) |
| LP-009 | **Fixed** (warning + docs) |
| LP-010 | **Fixed** |
| LP-011 | **Fixed** |
| LP-012 | **Fixed**. Keeping Wiz wording is an operator decision; reversible |
| LP-013, LP-014 | **Carried**, unchanged |

## LP-001 — imported FK keys on IK-driven bones (High)

**Reproduced.** On the Wiz v2 → v3 import, the old report said "Every referenced object
has a target". Measured over the 72 frames of the imported `greeting-v2`
(`lp001-measure-before.txt`, `scripts/roadmap/lp001-measure.ts`):
- `forearm_r − chest` ranges 4.85°, while the source `arm_r` keys span 98°.

**Fix** (`src/model/animImport.ts`, `src/ui/importAnimDialog.ts`):
- **Driven by a constraint.** `drivenByConstraints` lists every IK or path constraint
  that meets both conditions:
  - its setup mix is above 0;
  - the incoming animation does not key it.
  For each it gives the overridden key count per bone. The dialog shows this as a warning
  (`imp-driven`).
- **Opt-in per constraint.** "Key “…” to mix 0 in the imported copy"
  (`imp-mute-<name>`) writes a stepped mix key 0 at t = 0 on that constraint in the
  imported animation. The setup constraint is untouched.
- **Status line.** It reports the overridden keys, for example "26 key(s) overridden by
  forearm_l-ik, …".
- **Rig differences** (`imp-rig`): a mapped bone whose parent differs, and scale keys that
  now also scale bones that are not below that bone in the source. This covers the v2
  `body` scale reaching `hips`, `chest`, `head` and 8 more.
- **Paste report.** Pasting keys reports the same override.

**Acceptance, criterion by criterion:**
1. **Met.** The Wiz import names `forearm_l-ik` (6), `forearm_r-ik` (10), `shin_l-ik` (5)
   and `shin_r-ik` (5), 26 in total.
   - Evidence: `wiz-lp-corrections-log.txt`, `lp-corrections-output/import-a-warning.png`.
2. **Not met as written; a substitute proof is used.** Without the option, the world
   angle of `forearm_r` relative to `chest` is *not* constant: it ranges 4.85°. The cause
   is the imported `body` scale keys, which move the IK target relative to the chest; the
   arm keys themselves still have no effect.
   - Substitute proof: the same import with `arm_r` skipped gives max |Δ (arm_r − chest)|
     = **1.14 × 10⁻¹³°** over 72 frames. So the 10 `arm_r` keys have no effect.
   - Evidence: `lp001-measure-after.txt`.
3. **Met.** With the option, all four constraints get a mix key `[0]`. At the raise frame
   (30) the `arm_r` key Δ is −84.00°, and the solved local Δ and the chest-relative world
   Δ are both −84.00° (within 1°).
   - Range over 72 frames: 101.6°.
   - Evidence: `lp001-measure-after.txt`.
4. **Met.**
   - Unit: `LP-001: imported keys on constraint-driven bones` (5 tests).
   - e2e: `LP-001 / LP-002: Import anims… on an IK rig` (3 tests: the warning, the dead keys
     without the option, the keys playing with it).
   - e2e: the paste report.

**Default is off.** On Wiz, muting the leg IK lets the feet drift: the shin-tip-to-foot
gap goes from 14.8 to 38.0 px. The Wiz rerun therefore mutes only the arm IKs, in the
copy `greeting-v2-2` used by the sequence `wiz-intro-arms`.
- The A/B pixel difference is confined to frames 91–131 (the greeting) and peaks at
  176 397 px.
- Evidence: `wiz-lp-corrections-log.txt`, `wiz-intro-lp-contact-sheet.png`.
- *Operator decision:* keep the default off, or pre-tick it.

**A related semantics change, made deliberately.** A mix key 0 only fades cleanly if the
mix transition blends constraint mix. Before this pass, the dominant entry's constraint
keys switched at weight 0.5: the old evaluator stepped 154.9° in one frame.
- Constraint mix and path position now blend along the mix chain (`src/model/mix.ts`,
  `docs/architecture.md`). This changes transition frames of any rig whose animations key
  constraints.
- The independent reference (`tests/support/reference-constraints.ts`) was extended the
  same way.
- Model vs reference over a 31-frame transition: worst 8.1 × 10⁻¹⁰
  (`fr003-model-vs-reference-mix.txt`).
- A reference-clamp mutation is caught (`reference-clamp-mutation.txt`).

## LP-002 — setup-relative retargeting promised, not provided (Medium)

**Reproduced.** A unit test copies a source rotate track (setup −90, first key −90) onto
a target with setup −60: the first key stays −90.

**Fix:**
- **Hint reworded.** Values are absolute local values; a bone with a different setup
  jumps to them. The phrase "plays the same local motion" is gone.
- **Opt-in "Offset by the setup difference"** (`imp-offset-setup`):
  - translate and rotate get + (target − source setup);
  - scale is multiplied by the setup ratio;
  - a zero source setup scale is copied unchanged, with a note.
- **Equal setups copy keys exactly.** A first version added float noise;
  `offset-noise-red.txt` is that red run.

**Acceptance:**
- Off gives −90; on gives −60. Unit: `LP-002: setup-pose offset option` (3 tests).
- e2e: the options test.

## LP-003 — the 600 MP total cap binds the CLI too (Medium)

**Reproduced.** At 30 fps and scale 1, `wiz-intro` is 342 frames of 1370 × 1659 px, which
is over the cap in both the dialog and the CLI.

**Changed:**
- The error now says that the command-line renderer has the same limit, and how many
  frames fit at that size (263 here).
- Sequences and mixes are no longer told to shorten a range they do not have.
- Unit: `LP-003: the total-pixel limit message`.

**Not built: chunked or streaming CLI rendering.** It is a new capability, and the review
lists it as an operator decision ("whether 30 fps full-size sequence delivery is a
requirement"). It would also need `--start/--end` on `rigsmith sequence`, which does not
exist today.
- Until then, deliver at 15 fps, at scale 0.5 (now reproducible, see LP-004), or with at
  most 263 frames per export.

## LP-004 — half-scale exports differ run to run (Medium)

**Not reproduced between consecutive dialog exports in this session.** It *was*
reproduced as a dialog ≠ CLI difference: `scripts/roadmap/lp004-repro.ts`, ANGLE Metal on
an M4.
- `lp004-base.txt` (unfixed): 3 dialog exports were identical to each other (`38fb0d…`),
  and the CLI gave `942d9f…`.
- The two differ on frames 0–90:
  - frame 0: 139 180 px; frame 1: 83 305 px;
  - after that about 15 400–15 670 px, repeating with period 45.
- They agree on frames 91–170.
- The reviewer's earlier in-session difference is in
  `.hermes/evidence/usecase/rv009-scale05-nondeterminism.txt`.

**What was measured:**
- `--disable-gpu`: dialog ×3 = `59da1f…` on every frame, but different from the
  accelerated CLI (`lp004-disable-gpu.txt`).
- Software target with an accelerated mesh layer: identical to the unfixed result
  (`lp004-wrf-gpu-layer.txt`). So the dependence lies in the accelerated mesh-layer path.
- Neither unfixed output equals the software output on any frame
  (`lp004-base-vs-software.txt`). So the accelerated canvas was not demoted to software
  part-way through.
- **The mechanism inside Chrome's accelerated raster is not established.**

**Fix:**
- Every exported frame is now drawn on Chrome's software raster: `exportContext()` creates
  a 2D context with `willReadFrequently: true`, and the mesh layer follows the target's
  raster path (`src/render/draw.ts`).
- Covered paths: PNG frame, ZIP, APNG, GIF, WebM/MP4, the CLI and the reference player.
- The editor viewport and previews stay accelerated.

**Acceptance: met.** After the fix, dialog ×3 = CLI = `59da1f…` on all 171 frames of
`wiz-intro` at scale 0.5 (`lp004-wrf.txt`).
- The regression is the CLI case "wave at 120 fps, scale 0.5 (LP-004)": editor ZIP = CLI
  ZIP.
- It went red under the mutation that restores the accelerated path: CLI `d7934b…` vs
  editor `46b766…` (`lp004-mutation/`, restored, `shasum -c` OK).
- The RV-009 nondeterminism note now points here.

**Consequences:**
- Every export's bytes changed.
  - The Wiz LP run's recorded editor = CLI hashes (`77948c2e…`, `d4f892c2…`) are
    **pre-LP-004 bytes**. They are a parity proof of the accelerated path only.
- The viewport is no longer pixel-identical to exports.
- The FR-003 player check moved to the software path, and its counts were recalibrated
  (see "FR-003" below).
- Software raster is slower. On the full e2e suite, no timeouts were seen.

## LP-005 — fallback download leaves the project "unsaved" forever (Medium, carried from RV-004)

**Not changed.** The smallest correction would stop arming the leave-page prompt after a
fallback download. That reverses the protection the first-stage RV-004 decision kept, and
the review lists it as an operator decision.
- The current behaviour remains covered by `usecase-fixes.e2e.test.ts` (RV-004), which is
  green in the full e2e run.
- *Operator decision:* stop arming `beforeunload` after a fallback download (keeping the
  annotated recovery copy), or keep it.

## LP-006 — Sequences dialog stale on undo/redo (Low)

**Fix:** the dialog subscribes to `project` and `load` changes and re-renders, deferring
the re-render while an export runs. Every `q.steps[i]` access is guarded.

**Acceptance: met.** e2e `LP-006 / LP-007: Sequences… stays in step with undo/redo`:
1. Add a step and focus Close.
2. Ctrl+Z: the list shrinks, with no error toast.
3. Redo restores it.
4. Undoing the sequence itself shows the empty state.

## LP-007 — sequences hard-code the 'setup' missing-channel policy (Low)

**Documented**, using the review's first option. The behaviour is unchanged and the format
is unchanged.
- The Sequences dialog hint and `docs/architecture.md` say that sequences use the Mix
  dialog's default, `setup`.
- Unit test: a sequence plan is `missing: 'setup'` and equals `evaluateMix` with
  `'setup'`, not `'hold'`.

## LP-008 — Wiz sequence evidence clipped (Low)

**Rerun** by `scripts/roadmap/wiz-lp-corrections.ts`, driving visible controls:
- **Fit to all animations** changed the frame from 1341 × 1617 to 1370 × 1659.
- The dialog shows no `seqd-frame-warning` for either sequence.
- Both contact-sheet rows share one frame.

Evidence: `wiz-lp-corrections-log.txt`, `lp-corrections-output/wiz-intro-dialog-f105.png`,
`wiz-intro-lp-contact-sheet.png`.

The `rv009-output` artefacts are untouched and remain clipped, as recorded.

## LP-009 — older readers drop `sequences` silently (Low)

**Fix:** `validateProject` warns `Unknown top-level field(s) ignored — they will not be
saved again: "…"` for any key outside `TOP_LEVEL_KEYS`. `docs/architecture.md` says which
builds drop `sequences` and `frame`.
- Builds up to `40ad69c` cannot be changed and still drop fields silently.
- Unknown keys *inside* objects are still dropped without a warning.

**Tests:**
- Unit test.
- e2e `LP-009: Open reports a field this version does not know`.

## LP-010 — legacy migration deletes a newer localStorage copy (Low)

**Fix** (`migrateLegacy`, `src/ui/storage.ts`). A legacy copy is removed only when
nothing is lost:
- it was written into IndexedDB; or
- IndexedDB holds the same text; or
- it is an autosave older than the IndexedDB record.

A differing "Save to browser" copy has no timestamp, so it is kept in localStorage.

**Acceptance: met.** e2e `LP-010` (3 tests):
- A newer legacy autosave replaces the older IndexedDB copy, and the banner offers the
  newer one.
- An older legacy autosave is removed.
- A differing browser save is kept.

## LP-011 — the guide acts on the first attachment of layered projects (Low)

**Fix:** `guideBlocked`.
- With more than one original image, the guide names no attachment.
- Create root bone, Mesh and Create idle are disabled with the reason, and the model
  functions refuse.

**Tests:**
- Unit test, plus e2e `LP-011` on the demo.
- The synthetic one-PNG flow (`onboarding.e2e.test.ts`) is unchanged and green.

## LP-012 — private test vocabulary in the UI (Low)

**Fix:** there is no "Wiz" string under `src/ui`. The guide's limits now describe what the
tools cannot do, and the e2e assertion was updated.
- *Operator decision:* if the Wiz wording is wanted back, the change is two strings in
  `guideDialog.ts`.

## LP-013, LP-014 and first-stage items — carried

- **LP-013 (RV-010 cutout backlog).** Not touched. Ordering the backlog is an operator
  decision.
- **LP-014.** The starter idle and guide mesh are heuristics, and nobody has judged them.
- **RV-008.**
  - No bake command exists.
  - The Lottie IK refusal no longer names a command. It now says "Rigsmith has no command
    that bakes IK into keys: … delete the IK constraint and key the chain’s rotations by
    hand" (unit test).
  - Whether Lottie is a target is an operator decision.
- **Still open:**
  - RV-011 / criterion (g) preference;
  - v3 visual acceptability;
  - WebM/MP4 on publishing targets;
  - the thirty-minute human session on Wiz v3.

## Found while correcting

**Paste retarget** was silent. A one-bone clip pasted with another bone selected now says
where it went (unit test and e2e).

**FR-003 recalibration (from LP-004).** Moving the player onto the software raster changed
the strict mismatches to 51 / 53 / 34 (wave / skin alt / transition; previously
9 / 7 / 12).
- Every mismatch is classified:
  - upper-edge pixels;
  - texture-edge pixels;
  - a new, scoped rule: edge coverage of a layer over an opaque layer, where the reference
    is at 16/16 (8 pixels, residual ≤ 1.6).
- The structural checks and control margins held.
- The path-spacing mutation is still caught (`fr003-mutation-lp004/`).
- Details: `docs/runtime.md`.

## Operator decisions for the second publication

1. **LP-001:** keep "Key … to mix 0" off by default (the current state), or pre-tick it.
2. **LP-003:** whether 30 fps full-size sequence delivery is required. Yes would mean
   chunked CLI rendering plus `--start/--end` for sequences.
3. **LP-005:** stop arming the leave-page prompt after a fallback download, or keep it.
4. **LP-012:** neutral wording (current state) or Wiz wording.
5. **LP-013:** the order of the cutout backlog.
6. **Carried:**
   - RV-011 / criterion (g);
   - Lottie as a target and the bake command (RV-008);
   - v3 visual acceptability;
   - media on publishing targets;
   - the human Wiz v3 session.
7. **LP-004 trade-off:** software raster for every export means slower exports, and the
   viewport differs from exports at the pixel level. The alternative is a deterministic
   in-repo resampler; it was not needed.
