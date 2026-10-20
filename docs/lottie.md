# Lottie export (supported subset)

**Export Lottie…** (`export-lottie`) and `rigsmith lottie` write one animation, with the
active skin (or `--skin`), as Lottie (Bodymovin JSON, `v` 5.7.0). It is a *subset*
exporter. A feature is exported only when the Lottie model can represent it exactly. Any
other feature refuses the export, and the diagnostic names the feature and the item.
Nothing is approximated. The code is in `src/model/lottie.ts`.

## Subset

| Rigsmith feature | Lottie mapping | Status |
|---|---|---|
| Bone hierarchy | one null layer (`ty 3`, `bone:<name>`) per bone, parented like the skeleton; the extra `world` null holds T(−origin) | exported |
| Translate keys | split position (`p.s = true`); x and y animate independently, like Rigsmith's per-component interpolation | exported |
| Rotate / scale keys | `r`, `s` (×100) | exported |
| Linear / stepped / smooth / bezier keys | `(1/3,1/3,2/3,2/3)` / `h: 1` / `(1/3,0,2/3,1)` = exactly 3t²−2t³ / the key's own handles (overshoot kept) | exported |
| Keys between frames | fractional key times `t` (frames) | exported |
| Flat image attachments | image layer (`ty 2`, `<attachment>:<image>`) parented to its bone; `p` = attachment offset, `a` = image centre; PNG embedded as a data URL (`e: 1`) | exported |
| Attachment opacity + opacity keys | `o` (×100) | exported |
| Visibility keys, image-swap keys, skins | one image layer per run of frames with the same image and visibility, switched by `ip`/`op`. Exact at whole frames; a key between frames takes effect at the next frame, as in the PNG sequence (shown as a note) | exported |
| Draw order (static) | layers are written front to back | exported |
| IK constraints, path constraints, constraint keys | none in Lottie | **refused** |
| FX sockets / emitters (v3) | Lottie has no particles | **refused** |
| Springs (v3) | simulated by Rigsmith | **refused** — bake them first (spring inspector ▸ Bake all springs, or `rigsmith bake-springs`) |
| Meshes, deform keys | image layers cannot deform | **refused** |
| Draw-order keys | Lottie layer order is fixed | **refused** |
| Non-PNG images | only PNG is embedded | **refused** |

The composition size, frame rate, frame count and origin are the same as the editor's PNG
sequence at scale 1, padding 4 (`meta.origin` records the origin). A rig that uses a
refused feature can still be exported after baking that feature into bone keys by hand.

## How fidelity is verified, and the limits

- `tests/support/lottie-eval.ts` is an independent evaluator for this subset. It imports
  nothing from `src/` and implements Lottie's cubic easing solver, hold keys, split
  position, parenting and ip/op. It plays the exported JSON.
- Unit tests (`tests/unit/lottie.test.ts`) check, on every frame, both with and without a
  skin, that the matrices of every bone and image layer equal the editor's (difference
  < 1e-6), and so do opacity and which image is shown.
- Browser test (`tests/e2e/p4-lottie.e2e.test.ts`):
  - The JSON is exported through the dialog, played by the evaluator and rasterized by the
    test's reference compositor.
  - Each frame is compared with the editor's own PNG-sequence export. Measured: 223 of
    206 272 covered px over tolerance 24 (0.108%) for both the default images and skin
    `alt`, with edge antialiasing as the only difference.
  - Control: the unskinned file compared with skinned frames gives 23.1% over tolerance,
    which shows the comparison detects differences.
  - The CLI output is byte-identical to the dialog's file.
- Third-party player (same browser test, FR-001): the dialog-exported JSON is played by
  **lottie-web 5.13.0**, canvas renderer, in the isolated headless Chrome for Testing.
  - lottie-web is a pinned `devDependency` only (MIT; installed with `--ignore-scripts`).
    The test injects `node_modules/lottie-web/build/player/lottie_canvas.js` into a blank
    page; nothing in `src/` imports it and it is not in `dist/`.
  - The canvas is the sequence geometry (w × h, dpr 1); each frame is
    `goToAndStop(frame, true)` and read back with `toDataURL`.
  - Budget, declared before the first run: per frame ≤ 0.5% of covered px over tolerance
    24 and mean ≤ 1.5. Measured: 0 of 206 221 covered px over tolerance on all 30 frames,
    for both the default images and skin `alt` (worst mean 0.002).
  - Controls: the unskinned file against the skinned frames gives 23.0% over tolerance;
    lottie-web frame i+10 against editor frame i gives 81.6%. Both must exceed 5%.
  - This rig includes a non-uniformly scaled parent null (skewed children); lottie-web's
    canvas renderer matches it.
- On the Wiz mascot (use-case review RV-008, `tests/acceptance/wiz-lottie.acceptance.test.ts`,
  private assets): the flat, FK-only greeting-demo exports inside the subset, and every
  one of its 72 frames is within the same budget for both the evaluator and lottie-web.
  The meshed IK Wiz v3 is refused, naming its 4 IK constraints and 5 meshes. Numbers are
  in `docs/WIZ-V3-DELIVERY.md`. No "bake constraints" command exists yet. A baked copy
  would still be refused for its meshes.
- **Not tested** in lottie-web's SVG or HTML renderers, After Effects, or any other Lottie
  player. The dialog states this.
- No masks, mattes, shapes, text or expressions are written. One composition per
  animation; no mixing.
