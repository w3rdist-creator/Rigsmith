# Delivery record: RV-009, RV-010, RV-012 (later priorities after the first publication)

Scope, as approved:
- **RV-009:** cross-project motion reuse and saved clip sequences.
- **RV-010:** real-art cutout evidence. It is the input to RV-012 and fixes nothing.
- **RV-012:** guided flat-art onboarding.

RV-013/014/015, renderer changes, collaboration and publishing are out of scope and were
not touched. Status: **delivered, pending external verification.** This is a worker
handoff, not a certification. Product review belongs to the next Fable stage.

## 1. What a user can do now

| Item | Visible control(s) | Exercised by |
|---|---|---|
| RV-009 animation import with an explicit mapping | **Import anims…** (`import-anims`): file, per-object mapping selects (bone/attachment/constraint/image, each with "(skip — do not import)"), a report of unmatched objects and dropped keys shown before Import, Import (one undo step) | e2e (`tests/e2e/motion-reuse.e2e.test.ts`) drives the **bone** selects, the unmatched report, Cancel, Import and its undo. The attachment/constraint/image mapping and the dropped-key lines are tested at model level only (`tests/unit/motion-reuse.test.ts`); no browser test changes those selects or reads a "Dropped:" line |
| RV-009 durable key clipboard | Copy / Paste keys (timeline). The copy is stored in IndexedDB with object names, restored after a reload, pasted by name into another project, and what does not fit is reported | same files |
| RV-009 saved clip sequences | **Sequences…** (`sequences-open`): new/rename/delete, ordered steps with repeat counts, the stored mix durations (shared with Mix…), loop, preview, project frame, ZIP/APNG/GIF export | same files; CLI parity in `tests/cli/cli.test.ts` |
| RV-009 CLI | `rigsmith set-sequence`, `rigsmith sequence` (docs/cli.md) | `tests/cli/cli.test.ts`: the ZIP is byte-identical to the dialog export |
| RV-010 evidence | none: an evidence run, `npm run wiz:cutout-rv010` | docs/RV010-CUTOUT-SHORTFALLS.md |
| RV-012 flat-art guide | **Flat-art guide…** (`guide-open`), a non-modal checklist: Choose PNG…, Create root bone + attach, Open clean-up…, Cut a limb… (preset + note), Cut by colour… (preset + note), Columns/Rows + Mesh + weigh, Create idle, Close | `tests/e2e/onboarding.e2e.test.ts` (10 tests); `tests/unit/onboarding.test.ts` (9) |
| RV-012 on real art | none: an evidence run, `npm run wiz:guide-rv012` | docs/RV010-CUTOUT-SHORTFALLS.md, "Guide-driven rerun" |

## 2. Compatibility, undo, recovery

- **Format.**
  - RV-009 adds an optional v2 field, `sequences`. v1 files and v2 files without it
    re-save byte-identically (unit test). Deleting an animation removes its steps, with a
    repair note.
  - RV-012 adds **no** format change: its progress is derived from the project.
  - The v1 legacy fixture loads and re-saves byte-identically (unit test).
- **Undo.**
  - Import, every sequence edit and every guide action are one undo step each.
  - Undoing a guide step shows it open again; redo restores it (unit + e2e).
- **Recovery.**
  - The key clipboard survives a reload (e2e).
  - After a reload, autosave recovery brings back a guided project, and the guide shows
    the same progress (e2e: `deepEqual` of the project, all seven steps done).
- **Export validation.**
  - Sequence ZIP from the editor = CLI ZIP, byte for byte (CLI test, and on Wiz:
    `.hermes/evidence/usecase/rv009-wiz-log.txt`).
  - The guide's idle exports as 60 frames that move: frame 15 differs from frame 0 (e2e,
    and on Wiz).

## 3. Found and fixed during this work

- **Cut dialog moved under the pointer.** The dialog is taller than the window. It kept
  its scroll offset from the previous use, and it moved after the first canvas click, so
  later outline points landed off.
  - Found only by running the guide on Wiz.
  - Fixed in `src/ui/cutoutDialog.ts`: the dialog opens at the top and keeps its offset
    across re-renders.
  - Regression test in the onboarding e2e. It fails without the open-time reset; the
    in-render half is defensive and could not be triggered on its own.
- **Guide re-rendering on playback ticks.** The guide now re-renders only on project/load
  changes. An e2e test clicks its controls while the idle plays.

## 4. Gaps and limits (honest list)

**RV-010/RV-012: the cut tools do not meet the pixel tolerance.**
- 3 of 9 Wiz pieces pass, both in RV-010 and through the guide. The pieces that pass are
  the body and both gloves.
- Ten shortfalls are listed and **not** fixed, in docs/RV010-CUTOUT-SHORTFALLS.md:
  - one-sided, capped extension;
  - different extension content;
  - no patch layer;
  - no zoom or numeric vertex entry;
  - unclickable edge points;
  - canvas round trips in polygon cuts;
  - a non-obvious glove technique (now explained by the guide's note);
  - no fringe rule;
  - derivation clutter;
  - the overlap default (the guide presets 0).
- The guide works around none of them. It states the limits in its notes and in an
  "Honest limits" line.

**RV-012 guide:**
- It was verified on a synthetic figure (e2e) and on Wiz (evidence script, not a gate).
  No person has used it.
- The user still outlines limbs and places pivots by hand. The guide does not detect
  limbs or joints.
- The 40 px limb extension preset is one number for all art. On Wiz the prep used 50–70,
  and RV-010's run used 50/60.
- The starter idle's sway rule ("bone origin above the art's centre") is a heuristic.
  - On Wiz the arm pivots are only 7 px above the centre.
  - The body mesh is weighted to all bones, so it leans slightly with the arm sway.
  - Not reviewed by a person.
- The grid mesh covers the whole image rectangle, so vertices also fall in transparent
  space.
- The art is the **first** attachment whose image is not a cut piece. Projects with
  several flat images get the guide's mesh and idle on that one only.
- The panel sits over the left part of the stage, about 360 px wide. Close it to see the
  whole stage.

**RV-009:**
- Two exports of the same sequence at scale 0.5 in one session can differ (Chrome raster
  nondeterminism).
  - Raw output: `.hermes/evidence/usecase/rv009-scale05-nondeterminism.txt`.
  - Byte identity is claimed only at scale 1, where it was checked.
- The Sequences dialog has no skin select (the CLI has `--skin`).
- Wiz: the v3 project frame clips greeting-v2 by 21 world units at the top (warned in the
  dialog, frame kept).
- At 30 fps and scale 1, the 342-frame Wiz sequence is over the browser export cap. The
  evidence run used 15 fps.
- The evidence contact sheet lost the "×" and "→" glyphs (font). The data is unaffected.

## 5. How to reproduce

- `npm test`, `npm run build`, `npm run test:e2e`, or everything at once with
  `npm run gates`.
- Evidence runs (they need the Wiz assets; outputs are git-ignored):
  - `npm run wiz:motion-reuse`
  - `npm run wiz:cutout-rv010`
  - `npm run wiz:guide-rv012`
- Gates for this handoff: run 20261018T200849Z-13692 on the clean HEAD f73ca06. All exit 0:
  - preservation 16/16
  - unit 240/240
  - typecheck and build
  - e2e 184/184
  - cli 15/15
  - wiz 31/31
  - testid-audit: 363 ids, 0 never interacted with
  - profiles

  Raw output is git-ignored, in `.hermes/evidence/roadmap/final-f73ca06/`.
- a3d5ce0 changed only docs and STATUS. Unit tests were re-run on it: 240/240
  (`.hermes/evidence/roadmap/unit-a3d5ce0.txt`).
- Wiz originals:
  - All 201 hashes recorded before the use-case milestone were re-checked with
    `shasum -c` after this work. All match.
  - The same directories hold exactly the same 201 files
    (`.hermes/evidence/roadmap/wiz-assets-sha-check-a3d5ce0.txt`).
  - This work only added the output directories `rv009-output`, `rv010-output` and
    `rv012-guide-output` under `.hermes/assets/wiz/`.
- Order of work:
  - RV-010 and RV-012 share one commit, f73ca06, so git history does not show the order.
  - The file times do. The RV-010 evidence (`.hermes/evidence/usecase/rv010*`) was
    written 15:32–15:40 local time.
  - `src/model/onboarding.ts` and `src/ui/guideDialog.ts` were created at 15:43 and
    15:45.
  - The guide's Wiz run followed at 16:01.
- The earlier smoke run failed only the test-id audit. The guide's ids were passed through
  a `btn()` helper that the static scan did not read. The scan was extended to read them;
  the allow-list was not used to hide them.
