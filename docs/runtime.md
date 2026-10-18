# Rigsmith runtime: file formats and reference player

Rigsmith's own web-native runtime formats and a small reference player. They are
independent formats; this is not a Spine, Lottie or other third-party runtime.

| File | Produced by | Contents |
|---|---|---|
| `<name>.runtime.json` (`rigsmith.runtime`, version 2) | toolbar **Export data** (`export-runtime`), `node scripts/rigsmith.ts runtime` | rig, keys, constraints, meshes, skins, mixes; baked per-frame data |
| `<name>-atlas.zip` → `<name>.atlas.json` (`rigsmith.atlas`, version 1) + `<name>-<n>.png` | toolbar **Export atlas…** (`export-atlas`), `node scripts/rigsmith.ts atlas` | packed texture pages and regions |
| `dist/player.html` | `npm run build` | reference player: loads the two files above (or loose images) |

## `rigsmith.runtime` version 2

Everything is referenced by **name**, so names must be unique per kind (bones,
attachments, images, animations, constraints, paths, skins); the editor refuses to
export otherwise and says which names collide. Units: pixels, degrees (clockwise on
screen, y down), seconds. Version 2 keeps every version-1 field with the same meaning.
Setup values and keys are written at full precision; only the `baked*` arrays are
rounded.

```jsonc
{
  "format": "rigsmith.runtime", "version": 2, "name": "…",
  "images": [{ "name": "torso.png", "width": 40, "height": 90 }],          // v2
  "bones": [{ "name", "parent": null | "name", "x", "y", "rotation", "scaleX", "scaleY", "length" }],
  "attachments": [{                                                       // array order = setup draw order (back first)
    "name", "bone": null | "name", "image": "torso.png", "width", "height",
    "x", "y", "rotation", "scaleX", "scaleY", "opacity",
    "hidden": true,                                                        // v2, only when hidden at setup
    "mesh": { "uvs": [u0, v0, …], "triangles": [i0, i1, i2, …], "hull": 10,
              "weights": [[{ "bone": "m1", "w": 0.7 }, { "bone": "m2", "w": 0.3 }], …] }  // weights v2
  }],
  "ik": [{ "name", "bones": ["upper", "lower"], "target": "bone", "mix", "bendPositive" }],           // v2
  "paths": [{ "name", "bone": null | "name", "closed", "nodes": [{ "x", "y", "inX", "inY", "outX", "outY" }] }], // v2
  "pathConstraints": [{ "name", "path", "bones": [], "position", "spacing", "mix", "rotate", "rotateOffset" }],  // v2
  "skins": [{ "name": "alt", "entries": [{ "attachment", "image", "from"?: "keyed image" }] }],      // v2
  "mixes": [{ "from": "wave", "to": "rest", "duration": 0.3 }],                                      // v2
  "animations": [{
    "name", "duration", "fps", "loop", "frames",
    "keys": { "<bone>": { "translate": [Key], "rotate": [Key], "scale": [Key] } },
    "slots": { "<attachment>": { "visible": [Key], "opacity": [Key], "image": [{ "time", "image" }], "deform": [Key] } }, // v2
    "drawOrder": [{ "time", "order": ["<attachment>", …] }],                                          // v2
    "constraints": { "<constraint>": { "mix": [Key], "position": [Key] } },                           // v2
    "baked": { "<bone>": [[worldX, worldY, worldRotationDeg, worldScaleX, worldScaleY], …] },
    "bakedSlots": [[{ "attachment", "visible", "opacity", "image" }, …], …],   // only with slot / draw-order keys
    "bakedMeshes": { "<attachment>": [[x0, y0, …], …] }                         // only with meshes
  }]
}
```

`Key = { "time", "value": [..], "interp": "linear" | "step" | "smooth" | "bezier", "curve"?: [x1, y1, x2, y2] }`
(the interpolation applies to the segment leaving the key; `curve` only on bezier keys).

Evaluation rules are those of the editor (`docs/architecture.md`): local pose from keys
(stepped channels show setup before their first key; interpolated channels hold their
first key) → IK in array order → path constraints in array order → world matrices →
slot state, skin, draw order → mesh vertices
`Σ wᵢ · Wᵢ(now) · Wᵢ(setup)⁻¹ · A(setup) · (p + deform)`. Skins: an entry without `from`
replaces the attachment's setup image wherever it shows; with `from` it replaces that keyed
image. Mixes: `docs/architecture.md` → Mixing.

Baked data lets a consumer play without an interpolator: `frames` samples at `i / fps`
(`frames = duration·fps` for loops, which omit the repeat of frame 0; `+1` for one-shots).
Bakes ignore skins and mixes (evaluate from keys for those).

## `rigsmith.atlas` version 1

```jsonc
{
  "format": "rigsmith.atlas", "version": 1,
  "padding": 2, "bleed": 1, "trim": true, "pot": false, "maxSize": 2048,
  "pages": [{ "file": "rig-0.png", "width": 99, "height": 38 }],
  "regions": [{ "name": "torso.png", "page": 0, "x": 2, "y": 2, "width": 40, "height": 90,
                "offsetX": 0, "offsetY": 0, "originalWidth": 40, "originalHeight": 90 }]
}
```

Source pixel `(offsetX + i, offsetY + j)` of image `name` is page pixel `(x + i, y + j)`
for `0 ≤ i < width`, `0 ≤ j < height`; everything else in the source is fully
transparent. Regions are never rotated. Pages are straight-alpha 8-bit RGBA PNGs written
by Rigsmith's own encoder; the same input gives byte-identical files (sha256 checked).
**Bleed** copies each region's edge pixels `bleed` px outward into its padding: Chrome's
`drawImage` of a sub-rectangle filters across the rectangle's edge, so without bleed the
edges of art that is opaque up to its border pick up transparent padding or neighbours.
Measured on the p4-player rig (30 frames): padding 2 / bleed 0 → 14 234 px over
tolerance; padding 0 / bleed 0 → 9 165; padding 2 / bleed 1 → 0 (max channel diff 3);
padding 4 / bleed 2 → 0 (max 1). Trimmed regions keep a 1 px transparent margin, so
bleed only matters where art touches its image border.

## Reference player (`player.html`, `src/runtime/`)

Controls: `player-files` (multi-select: the runtime JSON, the atlas JSON and its page
PNGs, or the loose image files), `player-anim`, `player-skin`, `player-mix-to` +
`player-mix-at` (transition with the stored mix duration, default 0.2 s), `player-time`
(frame), `player-play`, `player-frame-label`, `player-canvas`, `player-status`,
`player-errors` (missing texture / page / runtime file, unknown names). Read-only probe
`window.__rigsmithPlayer` (`state()`, `frame()`) for tests.

**Validation.** After converting the runtime file, the loader runs the rig through the
editor's project validator (`validateProject`: finite numbers, bone cycles, triangle
index ranges, deform-key arity, fps 1–240 / duration ranges, constraint and mix
references) with stub image data, since the file carries image sizes only. Every
problem is listed in `player-errors` with runtime field paths (`keys` for bone tracks,
`mesh.uvs` for mesh points); a file too broken to convert is reported as malformed. The
baked v1 data (`baked`, `bakedMeshes`, `frames`) is not read and not validated. A failed
load, or an animation/transition that cannot be prepared (for example over the
2000-frame limit), clears the canvas, slider and frame label, so no stale frame stays on
screen (drwdmrs3 review P2-2, P3-1; `tests/unit/runtime.test.ts`,
`tests/e2e/review-fixes.e2e.test.ts`).

**Code shared with the editor** (deliberately — one evaluator, one renderer):
`src/model/evaluate.ts`, `constraints.ts`, `mesh.ts`, `mix.ts`, `animation.ts`,
`curve.ts`, `skeleton.ts`, `math.ts`, `src/model/sequence.ts` +
`src/render/sequence.ts` (frame sampling, stable canvas geometry) and
`src/render/draw.ts` (Canvas2D renderer, which accepts atlas regions). **Player-only**:
`src/runtime/load.ts` (runtime JSON → rig, name resolution, validation),
`src/runtime/player.ts` (atlas regions, frame/transition preparation),
`src/player-main.ts` (page). The player bundle is ~42 kB minified (~16 kB gzip)
including the shared code.

What the agreement tests show (`tests/unit/runtime.test.ts`, `tests/e2e/p4-player.e2e.test.ts`):
- The rig rebuilt from the runtime file alone evaluates **identically** (difference 0)
  to the editor for every frame of both animations, with and without the skin, and for
  a transition — so the file carries the whole rig.
- In the browser, the player's frames (loaded through its own file control) match the
  editor's exported PNG sequence on every frame: loose images identical (max 0); atlas
  with bleed 1 → 0 px over tolerance (max 3); the skin and the wave → rest transition
  likewise; the player's pose matches the editor-baked runtime data within 5e-4 (the
  bake's rounding).
- Because evaluation and drawing are shared code, these tests do not independently
  re-derive the maths; the independent checks are the reference rasterizer tests of the
  editor renderer (`tests/support/reference-composite.ts`, phases 1–4).

Limits: Canvas2D only (no WebGL path); verified in headless Chrome for Testing only; one
skin at a time (no skin composition); transitions in the player are a single A → B
crossfade (the editor's preview also does interruptions); the player has no event,
audio or physics support (the editor has none either).
