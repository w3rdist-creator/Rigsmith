# Rigsmith runtime: file formats and reference player

Rigsmith's own web-native runtime formats and a small reference player. They are
independent formats; this is not a Spine, Lottie or other third-party runtime.

| File | Produced by | Contents |
|---|---|---|
| `<name>.runtime.json` (`rigsmith.runtime`, version 2; 3 when the rig has transform constraints) | toolbar **Export data** (`export-runtime`), `node scripts/rigsmith.ts runtime` | rig, keys, constraints, meshes, skins, mixes; baked per-frame data |
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
  "bones": [{ "name", "parent": null | "name", "x", "y", "rotation", "scaleX", "scaleY", "length",
              "inherit"?: { "rotation", "scale", "reflection" } }],              // inherit: v3, only when a flag is off
  "attachments": [{                                                       // array order = setup draw order (back first)
    "name", "bone": null | "name", "image": "torso.png", "width", "height",
    "x", "y", "rotation", "scaleX", "scaleY", "opacity",
    "hidden": true,                                                        // v2, only when hidden at setup
    "mesh": { "uvs": [u0, v0, …], "triangles": [i0, i1, i2, …], "hull": 10,
              "weights": [[{ "bone": "m1", "w": 0.7 }, { "bone": "m2", "w": 0.3 }], …],  // weights v2
              "alphas"?: [a0, a1, …],                                                    // v3: per-vertex alpha 0..1
              "bind"?: { "attachment": [a, b, c, d, tx, ty], "bones": { "<bone>": [a, b, c, d, tx, ty] } } }, // v3 bind pose
    "blend"?: "additive" | "screen" | "multiply",                             // v3, absent = normal
    "color"?: "#rrggbbaa",                                                     // v3 tint, absent = white
    "emitter"?: { "recipe": "<id>", "rate": <per second> },                   // v3 FX socket: not drawn (see FX sockets)
    "clip"?: "<mask attachment>"                                              // v3 clipping mask (see Clipping masks)
  }],
  "ik": [{ "name", "bones": ["upper", "lower"], "target": "bone", "mix", "bendPositive" }],           // v2
  "paths": [{ "name", "bone": null | "name", "closed", "nodes": [{ "x", "y", "inX", "inY", "outX", "outY" }] }], // v2
  "pathConstraints": [{ "name", "path", "bones": [], "position", "spacing", "mix", "rotate", "rotateOffset" }],  // v2
  "transformConstraints": [{ "name", "kind": "rotation" | "aim", "bone", "factor", "angle", "mix",          // v3 only
      "source"?: "bone", "mitre"?: { "k", "max" },   // rotation
      "relativeTo"?: null | "bone" }],                 // aim
  "skins": [{ "name": "alt", "entries": [{ "attachment", "image", "from"?: "keyed image" }] }],      // v2
  "mixes": [{ "from": "wave", "to": "rest", "duration": 0.3 }],                                      // v2
  "animations": [{
    "name", "duration", "fps", "loop", "frames",
    "keys": { "<bone>": { "translate": [Key], "rotate": [Key], "scale": [Key] } },
    "slots": { "<attachment>": { "visible": [Key], "opacity": [Key], "image": [{ "time", "image" }], "deform": [Key],
                                "color": [Key], "rate": [Key] } },        // v2; color v3, value [r, g, b, a] 0..1; rate v3 (emitters), value [per second]
    "drawOrder": [{ "time", "order": ["<attachment>", …] }],                                          // v2
    "events"?: [{ "time", "name", "payload"?: "<text>" | <number> }],                                // v3: by time, then name
    "constraints": { "<constraint>": { "mix": [Key], "position": [Key], "angle": [Key] } },           // v2; angle v3
    "baked": { "<bone>": [[worldX, worldY, worldRotationDeg, worldScaleX, worldScaleY], …] },
    "bakedSlots": [[{ "attachment", "visible", "opacity", "image", "color"?, "rate"? }, …], …],   // only with slot / draw-order keys; color only when not white; rate on emitters
    "bakedMeshes": { "<attachment>": [[x0, y0, …], …] }                         // only with meshes
  }]
}
```

`Key = { "time", "value": [..], "interp": "linear" | "step" | "smooth" | "bezier", "curve"?: [x1, y1, x2, y2] }`
(the interpolation applies to the segment leaving the key; `curve` only on bezier keys).
v3, translate keys only: `"interpY"` (+ `"curveY"` when it is bezier) eases the y component
separately; x keeps `interp`/`curve`. Absent = y follows `interp`.

Evaluation rules are those of the editor (`docs/architecture.md`): local pose from keys
(stepped channels show setup before their first key; interpolated channels hold their
first key) → IK in array order → path constraints in array order → transform constraints
in array order (v3) → world matrices →
slot state, skin, draw order → mesh vertices
`Σ wᵢ · Wᵢ(now) · Wᵢ(bind)⁻¹ · A(bind) · (p + deform)`, where the bind terms are the mesh's
`bind` matrices when present (v3) and the setup pose otherwise. Skins: an entry without `from`
replaces the attachment's setup image wherever it shows; with `from` it replaces that keyed
image. Mixes: `docs/architecture.md` → Mixing.

Baked data lets a consumer play without an interpolator: `frames` samples at `i / fps`
(`frames = duration·fps` for loops, which omit the repeat of frame 0; `+1` for one-shots).
Bakes ignore skins and mixes (evaluate from keys for those).

Clipping masks (v3): an attachment with `clip: "<mask>"` is drawn only where the mask
attachment's own drawn shape is — its image alpha at its current transform, image and mesh,
at full opacity and untinted, whether or not the mask is visible. Draw it into a layer,
multiply by the mask's shape, then composite with its opacity and blend (Pixi: a sprite
mask). Masks are one level deep. `baked` data is unaffected.

FX sockets (v3): an attachment with `emitter: {recipe, rate}` is not drawn. A player spawns
the particle recipe `recipe` (its own particle system, e.g. a factory particle family; the
attachment's `image` is a sprite hint) at the attachment's world transform — bone baked
world × the attachment's x/y/rotation/scale, exactly as for an image — at `rate` particles
per second: the slot's `rate` keys, else the setup rate (`bakedSlots[].rate` has it per
frame). Visibility and opacity keys still apply (hidden = not emitting). One-off bursts are
timeline events. `cheeseweb-rig`'s RigSprite does not spawn them yet (pending).

Springs (the editor's follow-through, v3) are never written to a runtime file: the export
bakes them into each spring bone's rotate keys (one linear key per frame), so players need
no simulation and `baked` includes them.

**Version 3** is version 2 plus `transformConstraints`, `angle` constraint keys, bone
`inherit` flags, attachment `blend` and `color`, slot `color` keys, mesh `alphas`, mesh `bind`, translate keys' `interpY`/`curveY` and animation `events`
(rules: `docs/architecture.md` → Transform constraints, Inherit flags, Blend, tint and
vertex alpha). It is written only when the rig uses them; a v2-only consumer can still
play a v3 file's `baked` data, which already includes the constraints (but must draw the
colour fields itself: a consumer that ignores them renders the attachments untinted and
normally blended).

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
Measured on the p4-player rig (30 frames, software raster since LP-004, see below):
padding 2 / bleed 0 → 14 898 px over tolerance; padding 0 / bleed 0 → 10 788; padding 2 /
bleed 1 → 0 (max channel diff 1.1); padding 4 / bleed 2 → 0 (max 1.3). (Accelerated
raster before LP-004: 14 234, 9 165, 0 with max 3, 0 with max 1.) Trimmed regions keep a 1 px transparent margin, so
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
  with bleed 1 → 0 px over tolerance (max 1.1); the skin and the wave → rest transition
  likewise; the player's pose matches the editor-baked runtime data within 5e-4 (the
  bake's rounding).
- **Raster path (LP-004, review-corrections pass).** Every exported frame (ZIP, APNG/GIF,
  WebM/MP4, the CLI) and the player's canvas draw into `exportContext` — a 2D context
  created with `willReadFrequently: true`, i.e. Chrome's software raster — and meshes go
  through a separate software layer canvas (`src/render/draw.ts`). On the accelerated path
  the same data gave history-dependent pixels: the Wiz `wiz-intro` sequence at scale 0.5
  exported identically three times in one dialog session, but the dialog and the CLI
  differed on frames 0–90 (139 180 px at frame 0, ≈ 15 500 px on each later one) and
  agreed on frames 91–170; earlier sessions also differed between two exports. With the
  software path the dialog (three exports) and the CLI are byte-identical on all 171
  frames, and equal to a `--disable-gpu` run. A software export target alone, with the
  mesh layer left accelerated, reproduced the old bytes exactly, so the dependence lives
  in the accelerated mesh layer; why it depends on history is **not established**. The
  editor viewport stays accelerated, so it is not pixel-identical to exports.
- Because evaluation and drawing are shared code, these tests do not independently
  re-derive the maths; the independent checks are the reference rasterizer tests of the
  editor renderer (`tests/support/reference-composite.ts`, phases 1–4).
- Since the post-review fix pass (FR-003, superseding the drwdmrs3 DRW-006 check), the
  **player's own canvas** is compared frame by frame with an independent reference for
  wave (30 frames), wave with skin `alt` (30) and the wave → rest transition (31; mix at
  0.5 s, stored 0.3 s, missing channels to setup). The reference
  (`tests/support/reference-composite.ts` + `reference-constraints.ts`) imports nothing
  from `src/` — checked transitively, with planted-import controls, by
  `tests/unit/reference-independence.test.ts` — and reads only the project file: no
  runtime-file data is an input (the baked rows are compared only afterwards, as a
  diagnostic: max |Δ| 4.98e-4 px/deg over x, y, rotation, scaleX, scaleY, i.e. the bake's
  3-decimal rounding). It re-derives key sampling, the bone chain, slot / draw-order /
  skin rules, mesh skinning + deform, compositing, and now also:
  - **Two-bone IK** by closed-form circle intersection in the chain parent's local space
    (src samples and bisects the elbow-length function). Covered: bone 1 with uniform own
    scale (any parent the TRS chain produces); other chains throw rather than guess.
    `bendPositive` is read as cross(shoulder→target, shoulder→elbow) > 0 in parent space
    with y down — inferred from "clockwise side" in docs/architecture.md.
  - **Path constraints** with the documented approximation (32 chords per cubic, curve
    parameter interpolated between table rows, analytic tangent). Diagnostic: the table
    is 2.6e-2 px shorter than the exact arc length of this fixture's path.
  - **Mixing** per docs/architecture.md (chain blend, shortest rotation, constraint mix
    and path position blended along the chain like any channel — each entry's mix clamped
    to 0..1, an entry that does not key them supplying the setup value under `setup` —
    discrete state from the newest entry with w ≥ 0.5, opacity/deform blended). Until the
    review-corrections pass the constraint keys also came from that newest entry, so an
    IK keyed off switched at half weight instead of fading.
  Unit checks of the reference itself (forward-kinematics reach, bend side under
  non-uniform and mirrored parents, straighten/fold, mix 0.5, path clamp/wrap, shortest
  rotation, `setup`/`hold`, blended constraint mix with per-entry clamp):
  `tests/unit/reference-constraints.test.ts`.

  Result (`report.txt` of p4-player, software raster since LP-004): strict mismatches
  (solid vs clear, or opaque colour differing by > 24) — wave **51**, skin alt **53**,
  transition **34** (accelerated raster before LP-004: 9 / 7 / 12). Each strict pixel is
  classified in the test (`explained === strict` is asserted, and each case's budget is
  that classified count): 118 are **the anti-aliased edge of `upper` over the opaque
  `torso`** (41 / 47 / 30), 8 the same edge where the reference's 4×4 subsamples all fall
  inside `upper` (3 / 5 / 0, below), and 12 a **texture edge inside `torso`** (7 / 1 / 4,
  below). Over an opaque layer a coverage difference becomes a colour difference, which
  the strict rule cannot tell from a wrong colour; the test recomposites the reference
  without `upper` (U) and with `upper` alone (X) and accepts a pixel only if both the
  player's and the reference's colour lie on the line U → X (residual ≤ 6/255, observed
  ≤ 2.3) with partial coverage on both sides. The coverage gap of these pixels is 1.9–3.3
  of 16 subsamples. On the software raster 8 pixels on that edge have the reference at
  16/16 (every subsample inside `upper`) and the player at 13.2–14.0/16; they are
  accepted only if an 8-neighbour has `upper` partially covered (the pixel is on its
  outline) and the player's colour lies on U → X (residual ≤ 6, 0 < α < 1), and their gap
  (2.0–2.8/16, residual ≤ 1.6) joins the asserted gaps. Root cause: the reference's 4×4 subsampled
  coverage of a quad edge vs the canvas's analytic coverage — the art is opaque up to its
  image border, so the edge is the quad's geometric boundary. Checks that rule out a pose
  or size error: measured along the whole edge of `upper` (≈ 700 px per side per case),
  the mean coverage gap is −0.16…+0.24/16 on both sides of the bone, over a clear
  background and over the torso alike (asserted |mean| ≤ 0.25/16; a 0.1 px edge offset
  would move it by 1.6/16; accelerated raster: −0.04…+0.09), with tails of −3.3…+3.3/16
  over a clear background (where it is an alpha-only difference); world scaleY and determinants agree with
  the bake (≤ 4.6e-5, none mirrored); region and image sizes agree (56 × 14). The strict
  gaps also lie within the gaps on all edges over a clear background (worst 12.0 / 12.0 /
  9.0 of 16, asserted). The remaining over-tolerance pixels (4 896 / 4 896 / 5 175) are
  alpha-only edge differences (worst 2.75 % of covered pixels, mean ≤ 0.32); their
  thresholds (4 %, 0.5) are fixed limits, not derived counts. Controls through the same
  reference: no constraints 32 386 / 32 084 / 33 764 strict pixels, the elbow flipped
  8 263 / 8 186 / 7 051 (each asserted > 100 × the case's strict count). A mutation of
  src's path spacing (× 1.1) passes every player-vs-editor comparison and the old
  baked-row check, and fails this one: accelerated raster 1 181 strict, 9 explained (none
  by the texture-edge rule); software raster with both added rules 1 236 strict, 51
  explained — the 16/16 rule explains the same 3 pixels as without the mutation.

  The transition counts changed in the review-corrections pass because the transition
  pose changed: `wave` keys `ik_arm`'s mix (1 → 0.5), which now fades to the setup mix
  over the transition instead of switching at half weight. Over all 31 frames the
  reference and src agree on every bone's world transform to ≤ 8.1e-10 (≤ 7.5e-12 over the
  transition frames 15–25), and the player still equals the editor export at 0 px; the
  over-tolerance count was unchanged (7 035, accelerated raster). Two pixels at f18 crossed the strict line:
  one is the edge of `lower` over the torso (classified by the rule above); the other
  (163,43) is covered by `torso` alone (α 255, every other layer α 0) next to a sharp
  blue → yellow boundary inside the torso art, and the player's colour is the reference
  colour moved 0.22 of the way toward the neighbouring pixel above it (residual 0.6/255,
  largest channel difference 25, threshold > 24). The test accepts such a pixel only if
  exactly one layer covers it at α 255, both images are opaque there, and the player's
  colour lies on the line from the reference colour to an in-bounds 8-neighbour's
  reference colour that differs by ≥ 24 (0 < t < 1, residual ≤ 6): a sub-pixel shift of an
  internal colour boundary of a deformed mesh — the same coverage mechanism as the outline
  edges, but on a boundary the strict rule cannot see as an edge. On the software raster
  (LP-004) 12 pixels take this rule (t 0.13–0.89, residual ≤ 3.0). Not covered: any third-party runtime — none exists for this
  format; IK chains whose first bone has non-uniform own scale (the reference refuses
  them; this fixture has none).

Limits: Canvas2D only (no WebGL path); verified in headless Chrome for Testing only; one
skin at a time (no skin composition); transitions in the player are a single A → B
crossfade (the editor's preview also does interruptions); the player has no event,
audio or physics support (the editor has none either).

## Timeline events (v3)

`animations[].events` lists named cues — a sound, a flash, a particle burst — at times in
the clip, sorted by time then name, each with an optional `payload` (text, or a number).
A player fires an event when playback passes its time: the events with
`previous < time ≤ now`, starting from −1 so time-0 events fire. When a looping clip wraps,
it fires the rest of the old pass, then the new pass from 0. An event at exactly the
duration fires once, at the wrap. `src/model/events.ts` (`eventsBetween`) implements this,
and the reference player (`player.html`) lists what it fires. Events do not change any
pose, so `baked` data is unaffected. Sequence exports list the events in their range in
`sequence.json` (`frame` = round(time · fps)); Lottie exports write them as markers.
