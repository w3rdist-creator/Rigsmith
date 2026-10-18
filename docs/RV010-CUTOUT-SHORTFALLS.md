# RV-010 — real-art cutout evidence (Wiz, dialog only)

**Question:** can the nine prepared Wiz pieces be recreated from `wiz_master.png` using only
the "Cut out piece…" dialog? Each piece is diffed against `.hermes/assets/wiz/prepared/*.png`.
The acceptance bar from the use-case review:
- per piece, alpha-mask IoU ≥ 0.98;
- ≥ 99 % of visible pixels within 8/255;
- synthesized-pixel counts within 25 % of the manifest.

**Answer: no. 3 of 9 pieces pass (both gloves and the body).** The legs pass IoU and the
synthesized count but fail the pixel diff, and every failing pixel is hidden extension. The
arms fail. The two sleeve-hole layers cannot be made with the dialog at all. The tools were
not tuned to pass; the shortfalls below are the next cutout backlog. The originals were not
modified (sha256 of `wiz_master.png` and of every `prepared/*` file is equal before and
after; checked by the script).

## How it was run

- `npm run build && node scripts/roadmap/wiz-cutout-rv010.ts`
- The script drives visible controls in an isolated headless Chrome for Testing profile:
  Image → + Bone → Attach → Remove specks → each cut through `att-cutout` (mode buttons,
  canvas clicks, Name, Overlap, Extend, Bone parent, Cut out).
- `window.__rigsmith` is read only, to collect results.
- Inputs: `scripts/roadmap/rv010-inputs.json`.
  - Every coordinate was read by eye from gridded zoom crops of the source.
  - The three extension lengths (60, 60, 50 px) are the prep script's own parameters (`masks.json`).
  - Nothing was taken from `prepared/*.png` or from the manifest's contours, bboxes or pivots.
- The metric definition in the same file was fixed before the first run. Each piece is
  placed in 1024×1536 master coordinates. IoU is over alpha > 0. "Visible" means the union
  of the two pieces' alpha. The per-pixel diff is the maximum channel difference after
  compositing each piece on flat RGB 128.
- Metrics: `scripts/roadmap/rv010_compare.py` (PIL + numpy).
- Raw output, all git-ignored:
  - `.hermes/evidence/usecase/rv010-wiz-cutout-log.txt` and `rv010-metrics.json` (pass 2);
  - `rv010-pass1-*` (pass 1);
  - `rv010-pass2-diagnostic.txt` (where the differences are);
  - the pieces are in `.hermes/assets/wiz/rv010-output/`.

**Passes.** Pass 1 lost both leg vertices at y = 1536: the image's bottom edge is the
canvas's bottom edge, and a click exactly there does not register. The legs were cut as
5-point polygons (IoU 0.09). Pass 2 changed only the driver, which now clicks 0.25 CSS px
inside the canvas edge. The inputs are unchanged. Both passes are kept.

## Results (pass 2)

| Piece | Route in the dialog | Alpha IoU | Visible ≤ 8/255 | Synthesized (manifest) | Result |
|---|---|---|---|---|---|
| leg_l | polygon + pivot, extend 50 | 0.9914 | 94.4 % | 3,643 (3,435, +6 %) | **fail** (diff) |
| leg_r | polygon + pivot, extend 50 | 0.9909 | 94.2 % | 3,655 (3,496, +5 %) | **fail** (diff) |
| sleeve_hole_l | — | — | — | (2,491) | **not producible** |
| sleeve_hole_r | — | — | — | (2,793) | **not producible** |
| arm_l | polygon + pivot, extend 60 | 0.6377 | 57.0 % | 3,556 (11,583, −69 %) | **fail** |
| arm_r | polygon + pivot, extend 60 | 0.6627 | 60.0 % | 4,088 (11,351, −64 %) | **fail** |
| body | the remainder after all cuts | 0.9963 | 99.6 % | — | pass |
| hand_l | Select colour, flood, tolerance 255 | 0.9949 | 99.36 % | — | pass |
| hand_r | Select colour, flood, tolerance 255 | 0.9944 | 99.35 % | — | pass |

Remove specks with the dialog defaults (faint < 100, solid > 200, within 6 px) removed
3,004 px, the same count as the prep script.

## Shortfalls (the next cutout backlog)

1. **One-sided, capped joint extension.**
   - Extension sweeps only back past the pivot, and the cap is 64 px.
   - The prep script extended each arm at both ends: 60 px into the sleeve and 70 px under the glove cuff.
   - About 7,000 hidden px per arm exist only in the prepared piece. That is the whole arm failure: IoU 0.64 / 0.66, synthesized −69 % / −64 %.
   - A user cannot add the distal extension any other way.
2. **The extension content differs from the prep's.**
   - The dialog samples one cross-section 2 px past the first opaque pixel along pivot→centroid.
   - The prep sampled a sleeve-shadowed row along a PCA axis.
   - On the legs, 3,092 / 3,206 hidden pixels differ by more than 8. They are the legs' only diff failure: excluding the pixels both pieces synthesized, 99.2 % (leg_l) and 99.1 % (leg_r) are within 8. That figure is a diagnostic, not the acceptance metric.
3. **No separate patch layer.**
   - "Patch the hole" paints the whole cut hole of the remainder flat. Measured as a trial cut, then undone with ↶ Undo (the project equalled the pre-trial project):
     - arm_l: 8,671 px, against the 2,491-px sleeve hole;
     - arm_r: 8,744 px, against the 2,793-px sleeve hole;
     - IoU with the prepared sleeve holes 0.24 / 0.26.
   - The flat colour also fills the visible stick shape between sleeve and glove, so it shows as a flat silhouette wherever the arm swings away.
   - The prepared sleeve holes cover only rows flanked by sleeve paint, as their own layers. The dialog cannot express that.
4. **No zoom or numeric vertex entry.**
   - For a 1024×1536 image the 520×400 cutout canvas shows 0.26 CSS px per source px, so one CSS pixel is 3.84 source px.
   - The driver's fractional clicks landed exactly (0.00–1.00 px error).
   - A mouse user places cut lines with roughly ±2–4 px error, and there is no way to type, drag or nudge a vertex. Only "Undo point" and "Clear" exist.
   - The cut line is what decides IoU at a joint.
5. **Points on the image edge are unclickable.** When the image fills the canvas height, a vertex at the bottom edge is lost silently. The summary does show "5 point(s)" instead of 7, but nothing warns.
6. **Polygon cuts are not pixel-exact.**
   - The polygon path reads pixels through `drawImage`/`getImageData` and writes the piece and the remainder through `putImageData`/`toDataURL`. Both are premultiplied canvas round trips.
   - Wiz is alpha 253–254 almost everywhere, so RGB changes. Examples where the prepared piece equals the master:
     - 15,746 body px, max channel change 252, on faint pixels;
     - 4,151 leg_l px.
   - After compositing these changes stay mostly within 8/255, but they break "visible pixels copied unchanged". Selection cuts and Remove specks are exact, but they inherit the round-tripped remainders.
7. **Gloves need a non-obvious technique.**
   - At the default tolerance of 32, Select colour stops at the glove's dark outline.
   - The working route: cut the arm sticks first, then flood fill at tolerance 255 on the remainder. That takes the connected matte, which is the glove.
   - Nothing in the dialog suggests it.
8. **No fringe-ownership rule.** The prep gives faint fringe (alpha < 16 within 10 px of a stick) to the stick. The dialog has no equivalent. It accounts for some of the 164–186 "only prepared" glove pixels.
9. **Derivation clutter.**
   - Every cut keeps a full-size remainder in the project: 13 images for 6 cuts, with names growing to `wiz_master-clean-rest-rest-rest-rest-rest-rest.png`.
   - That is correct (non-destructive) but heavy for real art. There is no "prune intermediate remainders" control.
10. **Overlap default.** The dialog's default overlap of 4 px adds visible duplicate pixels at each cut line. The prepared pieces have none. This run used 0 by choice (recorded in the inputs). The onboarding guide (RV-012) presets 0 and explains why.

11. **The dialog moved under the pointer (fixed in RV-012).**
    - Found by the guide-driven rerun below, not by RV-010. The dialog is taller than a
      1100 px window. It kept its scroll offset from the previous use (reaching Cancel
      scrolls it), and the re-render after the first canvas click moved it (scroll 171 → 47).
    - Every outline point after the first then landed off: arm_l became a 134×489 outline
      with its pivot at 240,104 instead of 240,761, and hand_l then took the whole body.
    - RV-010 did not hit it because its driver reopened the dialog unscrolled.
    - Fix (`src/ui/cutoutDialog.ts`): the dialog opens scrolled to the top and keeps its
      scroll offset across re-renders.
    - Regression test: `tests/e2e/onboarding.e2e.test.ts` replays the sequence; it fails
      without the open-time reset. The in-render half could not be triggered on its own
      and is kept as a defensive measure.

**What worked as-is:** polygon cuts at sub-pixel input precision, pivots, joint bones with
parents, one undo step per cut, Remove specks parity, exact selection cuts, and the body
as the remainder. The body passed at IoU 0.996.

## Guide-driven rerun (RV-012)

`npm run build && npm run wiz:guide-rv012` (`scripts/roadmap/wiz-guide-rv012.ts`) runs the
**Flat-art guide…** on `wiz_master.png` with its own buttons and presets, in an isolated
headless Chrome for Testing profile:
- Choose PNG… → Create root bone + attach → Open clean-up… (Remove specks) → Cut a limb… ×4
  → Cut by colour… ×2 → Mesh + weigh (default 4×6 grid) → Create idle → Export sequence….
- The outlines, pivots and seeds are the RV-010 inputs.
- The extension length is the guide's preset of **40 px**, not RV-010's 50/60, because that
  is what a user of the guide gets.
- Metric: the same script and definition as above.
- Log: `.hermes/evidence/usecase/rv012-wiz-guide-log.txt`.
- Metrics: `rv012-guide-metrics.json`.
- Outputs: `.hermes/assets/wiz/rv012-guide-output/` (all git-ignored).

| Piece | Alpha IoU | Visible ≤ 8/255 | Synthesized (manifest) | Result |
|---|---|---|---|---|
| leg_l | 0.9921 | 94.98 % | 2,910 (3,435, −15 %) | fail (diff) |
| leg_r | 0.9901 | 94.69 % | 2,917 (3,496, −17 %) | fail (diff) |
| arm_l | 0.5775 | 52.2 % | 2,374 (11,583) | fail |
| arm_r | 0.5937 | 54.5 % | 2,699 (11,351) | fail |
| body | 0.9963 | 99.6 % | — | pass |
| hand_l | 0.9949 | 99.36 % | — | pass |
| hand_r | 0.9944 | 99.35 % | — | pass |
| sleeve_hole_l / _r | — | — | — | not producible |

- **3 of 9 pass, the same pieces as RV-010.** Compared with RV-010, the legs come out
  slightly closer and the arms slightly further, because the extension is shorter. Its
  cap is still one-sided, as in shortfall 1.
- **Mesh:** the guide's 4×6 grid gives 35 vertices on the body, weighted to all seven
  bones (root, arms, legs, hands).
- **Idle:** 2 s, 60 exported frames, 1068×1560. The sway rule ("origin above the art's
  centre") picks arm_l and arm_r. Their pivots (y = 761) are only 7 px above the art's
  centre (y = 768): on art with lower shoulders the arms would not sway.
  - The hands and legs stay planted.
  - The body mesh is weighted partly to the arm bones, so it leans and its shoulders tilt
    slightly with the sway: 49,801 px change alpha between frames 0 and 15.
  - Plausible, but not reviewed by a person.
- Originals: sha256 of the master and every `prepared/*` file is equal before and after.
