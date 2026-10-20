# Architecture

Rigsmith is a client-only TypeScript app (no framework) built by Vite. All state lives in
the browser; there is no server, account or network call (REA `analyze_web_bundle`
observed 0 endpoints).

```
src/
  model/            pure, DOM-free, unit-tested
    math.ts         2D affine matrices (compose/invert/decompose)
    types.ts        project format types, cloneProject (undo snapshots)
    skeleton.ts     topo order, world transforms, cycle checks, reparent/delete
    animation.ts    key sampling + interpolation, key edit helpers, playback clock
    ops.ts          pose edits: setup mode edits bones, animate mode writes keys
    format.ts       serialize / parse+validate the project file
    history.ts      snapshot undo/redo stack
    exportRuntime.ts  "rigsmith.runtime" export (keys + baked per-frame world transforms)
    demo.ts         built-in rig/animations (art painted in ui/demoArt.ts)
  editor/store.ts   Editor: project, selection, mode, tool, time, playback, history
  ui/               DOM + Canvas2D
    app.ts          actions (file I/O, import, attach, keys, shortcuts), read-only test probe data
    viewport.ts     canvas render, hit testing, pan/zoom, move/rotate/scale/create tools
    panels.ts       skeleton tree, image list, inspector
    timeline.ts     animation settings, transport, ruler/scrub, key lanes, key drag
    toolbar.ts      toolbar + help table
    images.ts       decoded image cache, local file import
    demoArt.ts      procedural original art for the demo
  main.ts           wiring + `window.__rigsmith` read-only probe for tests
```

## Transform model

- World space is **y-down** (screen convention); positive rotation is clockwise on screen.
- Bone local matrix = `T(x,y) · R(rotation) · S(scaleX, scaleY)`;
  `world(bone) = world(parent) · local(bone)`, evaluated in parent-first topological order.
  Bones caught in a parent cycle are skipped (and such files are rejected on load).
- Attachment world = `world(bone) · T·R·S(attachment offset)`; the image is centred on
  that point. `boneId: null` places an image in world space.
- Posing: the Move tool converts the cursor (plus grab offset) into the **parent's** space
  with the inverse parent world matrix, so the joint lands under the cursor under any
  rotated/scaled parent. Rotate accumulates the cursor's angular delta (multi-turn
  capable) and flips sign under a mirrored parent. Decomposition drops skew, which only
  matters for children of rotated, non-uniformly scaled parents (`reparent` with
  keep-world and `deleteBone` use it).

## Animation model

- An animation has `duration` (s), `fps`, `loop`, and per-bone tracks with three channels:
  `translate [x,y]`, `rotate [deg]`, `scale [sx,sy]`.
- Key values are **absolute local values** that override the setup pose for that channel;
  channels without keys use the setup pose.
- Key `time` is stored in **seconds**, so changing FPS re-grids frames without moving keys.
  Shortening the duration keeps later keys (shown faded, counted as "past end") but they
  do not play.
- Interpolation is per key, applied to the segment leaving it: `linear`, `step`, `smooth`
  (smoothstep). Rotation interpolates raw degrees (350→10 sweeps back through 180; key
  370 to go forward), which also allows multi-turn spins.
- Setup vs Animate mode: in Animate mode every pose edit (canvas or inspector) writes a key
  at the current frame (time is snapped to the frame grid); the setup pose is never
  touched. Pausing snaps the playhead to a whole frame so what you see is what you key.

## Undo/redo

Snapshot-based (`History<Project>`): each undoable action records a deep clone of the
project taken *before* the change. Image assets are immutable and shared by reference
between snapshots. Canvas drags and timeline key drags are gestures: a snapshot on
pointer-down, live edits, one history entry on pointer-up (none if nothing changed; Esc
cancels and restores). Selection, view, playhead and playback are not undoable.

Memory (drwdmrs3 review P3-2): an action (or gesture) that leaves the project
structurally unchanged after `repairReferences` records no step. Each recorded snapshot
shares every subtree equal to the previous snapshot's (`shareUnchanged`), so undo/redo
hand back a deep copy (`cloneProject`) and shared parts are never mutated. Measured on
the review's 300-bone / 9 920-key / 2 025-vertex rig, 200 single-key edits retain about
7 MB instead of about 1 121 MB; the costs are about 3 ms more per edit (≈ 12.7 ms) and
≈ 16 ms per undo/redo (the copy). Depth stays 200 steps; nothing is dropped by size.
Numbers: `.hermes/evidence/post-review/first-fix/{pre,post}/history-perf.txt`.

## Project format (`rigsmith.project`, version 1)

```jsonc
{
  "format": "rigsmith.project", "version": 1, "name": "…",
  "bones": [{ "id", "name", "parentId": null|"id", "x", "y", "rotation", "scaleX", "scaleY", "length", "color" }],
  "images": [{ "id", "name", "mime", "width", "height", "dataUrl": "data:image/png;base64,…" }],
  "attachments": [{ "id", "name", "boneId": null|"id", "imageId", "x", "y", "rotation", "scaleX", "scaleY", "opacity" }],
  "animations": [{ "id", "name", "duration", "fps", "loop",
                   "tracks": { "<boneId>": { "translate": [{ "time", "value": [x,y], "interp" }], "rotate": […], "scale": […] } } }]
}
```

`attachments` order is draw order (back to front). Validation (`format.ts`) rejects:
wrong format id, newer/unsupported versions, non-finite numbers, duplicate ids, missing
parents/bones/images, parent cycles, non-base64 or non-image data URLs (remote URLs are
not allowed), unsorted keys, wrong value arity, unknown interpolation, out-of-range
fps/duration, tracks for missing bones. After validation every image is decoded
**before** the project is swapped in; any decode failure aborts the load with an error and
leaves the current project untouched.

## Project format version 2 (roadmap)

Version 2 is a strict superset of version 1; every new field is optional and omitted
when unused. The writer emits the **minimum** version a project needs (`requiredVersion`
in `format.ts`), so a project using no v2 feature is still written — byte for byte — as
version 1, and v1 files load without any defaults being added. A version-1 reader rejects
version-2 files by version number (it is not "backwards compatible"); this editor rejects
files that declare version 1 but contain v2 fields, and versions newer than 2.

| Field | Meaning |
|---|---|
| `Key.interp: "bezier"` + `Key.curve: [x1,y1,x2,y2]` | cubic easing of the segment leaving the key; x in [0,1], y unbounded (overshoot/anticipation); `curve` only on bezier keys |
| v3: `Key.interpY` (+ `Key.curveY` when bezier) | translate keys only: the y component's own easing (x keeps `interp`/`curve`); editor: Curve ▸ Separate Y and the axis menu; Lottie refuses it |
| `Attachment.hidden` | hidden in the setup pose (visibility keys can show it) |
| `Animation.slots[attId].visible / opacity / image` | slot keys: visibility `[0|1]` (stepped), opacity `[0..1]` (interpolated), image swaps `{time, imageId}` (stepped) |
| `Animation.drawOrder: [{time, order: [attId…]}]` | stepped draw-order keys; each `order` lists every attachment exactly once |
| `Animation.constraints[id].mix / position` | keyed constraint mix and path position |
| `ik: [{id, name, bones: [parent, child] or [bone], target, mix, bendPositive}]` | IK constraints |
| `paths: [{id, name, boneId, closed, nodes: [{x,y,inX,inY,outX,outY}]}]` | cubic Bezier paths in a bone's space (null = world); handles relative to their node |
| `pathConstraints: [{id, name, pathId, bones, position, spacing, mix, rotate, rotateOffset}]` | bones placed along a path |
| `ImageAsset.derived: {kind, sourceId, offsetX, offsetY, polygon?, synthesized, note?}` | provenance of cutout/remainder/patch/extension/cleanup images; the source image is kept unmodified |
| `Attachment.mesh: {points, triangles, hull, weights?}` | textured triangle mesh: `points` in the setup image's pixels (also the texture coordinates), the first `hull` points are the outline in order; `weights[v] = [{bone, w}]` sums to 1 per vertex (absent = rigid on the attachment's bone) |
| `Animation.slots[attId].deform` | deform keys: `value` = per-vertex offsets `[dx0,dy0,…]` in image pixels (2 per vertex), interpolated |
| `skins: [{id, name, entries: [{attachmentId, imageId, from?}]}]` | attachment sets: an entry without `from` replaces the attachment's setup image wherever it shows (including through an image key that shows the setup image); an entry with `from` replaces that keyed image. At most one entry per (attachment, from) |
| `mixes: [{from, to, duration}]` | stored crossfade durations per ordered animation pair (seconds, 0–10; default 0.2 s when absent) |
| `sequences: [{id, name, steps: [{animId, repeat}], loop}]` | saved clip sequences (RV-009): ordered animations, each played `repeat` (1–100) times; transitions use the stored `mixes` durations; `loop` = exported animated files loop. Deleting an animation removes its steps, with a repair note (the sequence itself stays, possibly empty) |

**Fields a reader does not know are lost on re-save.** A build that predates a field
neither rejects nor keeps it: builds before RV-009 (`58e43fa`) drop `sequences`, builds
before RV-003 (`c9c45dc`) drop `frame`, and every build up to `40ad69c` does so silently.
Since the review-corrections pass, Open warns
`Unknown top-level field(s) ignored — they will not be saved again: "…"` for any top-level
key outside the list above (`TOP_LEVEL_KEYS` in `format.ts`); unknown keys inside objects
are still dropped without a warning.

Evaluation order (`src/model/evaluate.ts`, shared by the viewport, onion skin, sequence
export and runtime export): sample local pose → IK constraints (array order) → path
constraints (array order) → transform constraints (array order, v3) → world matrices → per-attachment state (visibility, opacity,
tint, image, skin, draw order) → mesh vertices.

- **Stepped slot channels** (visibility, image, draw order) show the setup value before
  their first key; interpolated channels (bone channels, opacity, tint) hold their first key.
- **Two-bone IK**: solved in the chain parent's local space, where any parent scale
  (non-uniform or mirrored) is undone. There the shoulder→tip length depends only on the
  elbow angle, so the elbow angle solves `|S1·(e + k·(cos r2, sin r2))| = |target − shoulder|`
  (S1 = bone 1's own scale, e = child offset, k = child scaleX × length): |v|² is
  monotonic between its extremes (located by sampling the elbow angle every 0.5° and
  bisecting the derivative), so each root is bracketed and bisected to rounding — for
  every scale, uniform or not; two extremes closer than one 0.5° step (extreme
  non-uniform scale only) can be missed;
  bone 1 then turns the result onto the target. Unreachable targets take the closest
  length in parent space (straighten toward the target, or fold), a target on the chain
  root leaves the keyed pose. `bendPositive` puts the elbow on the clockwise side of the
  shoulder→target line in parent space; a mirrored parent mirrors the side on screen.
  When several elbow angles qualify (possible under non-uniform scale) the one nearest
  the keyed rotation wins. Solutions are kept on the keyed turn, and `mix` blends local
  rotations from keyed (0) to solved (1). Unit tests check reach and side against
  forward kinematics for non-uniform parent, own and mirrored scales (review P2-1).
- **Path constraints**: arc-length table (32 samples per cubic segment); bone *i* sits at
  `position·L + i·spacing`; open paths clamp, closed paths wrap; `rotate` aligns the
  bone's +x with the tangent plus `rotateOffset`; `mix` blends translation/rotation.
- **Inherit flags** (v3, `Bone.inherit`, absent = all on): a bone's origin is always
  placed by its parent's full world matrix M; its axes take M's linear part filtered by
  the flags. M is factored as R(θ)·K·F: F a left↔right mirror when det M < 0 (else
  identity), R(θ) the rotation to the world x axis of M·F, K upper triangular with a
  positive diagonal (scale and shear). `rotation`, `scale` and `reflection` set to false
  drop R, K and F respectively. So a scaled parent no longer shears or shortens a bone
  that does not inherit scale (a squashed hips keep the IK leg's reach), and a rig
  mirrored with root scaleX −1 stays the exact mirror image under any flags that keep
  reflection. Without rotation, a parent's reflection is applied as a left↔right mirror
  (a root scaleY −1 then mirrors the bone left↔right instead of up↕down). Solvers and
  tools use the filtered frame for angles and the full parent for positions. The second
  bone of a two-bone IK chain must inherit fully (validator, editor and CLI refuse
  otherwise; the IK length formula assumes it). Default bones compose exactly as before
  (no factoring), and flags are written only when one is off (v3).
- **Transform constraints** (v3, `TransformConstraint`): run after IK and paths, so they
  read the solved pose (a knee helper follows the IK knee). `rotation`: local rotation =
  `angle + factor · bend`, bend = the source's world angle minus its parent's (wrapped to
  ±180°); with `mitre`, local scaleY = `min(max, 1 + (sec(|bend|/2) − 1)·k)`, so a joint
  helper keeps the limb's width at the bend. `aim`: the bone's +x is turned (through the
  inverse parent, like IK) to world angle `angle` (+ `relativeTo`'s world angle). `angle`
  and `mix` are keyable; the solution is kept on the keyed turn and `mix` blends rotation
  (and the mitre scale) from keyed (0) to solved (1). Adding one in the editor keeps the
  setup pose (rotation: the offset absorbs the current bend; aim: holds the current
  angle). Files and runtime exports use version 3 only when a rig has transform
  constraints or angle keys, so every other rig stays readable by v2 consumers.
- **Blend, tint and vertex alpha** (v3, `Attachment.blend`, `Attachment.color`, slot
  `color` keys, `Mesh.alphas`): `blend` is `normal` (absent), `additive`, `screen` or
  `multiply` and maps to the canvas operations `source-over`, `lighter`, `screen` and
  `multiply` (W3C compositing; additive clamps). The tint `#rrggbbaa` (absent = white)
  multiplies every texel's rgb and multiplies `aa` into the opacity; `color` keys hold
  `[r, g, b, a]` in 0..1, interpolate like opacity and blend through mixes. `alphas` holds
  one alpha per mesh vertex, interpolated linearly across each triangle and multiplied into
  the texture. Rendering (`src/render/draw.ts`): an attachment with neither tint nor vertex
  alpha draws as before with the blend's composite operation (pixel-identical for normal);
  otherwise it is drawn at full opacity into an offscreen layer, the tint multiplies the
  layer's unpremultiplied pixels exactly, the vertex alphas are applied as a mask (each
  triangle filled with the linear gradient that equals the plane through its three alphas,
  clipped like the mesh itself so shared edges sum to the right coverage), and the layer
  is composited once with the opacity and blend. Exports, the player and the CLI share
  this path. Lottie refuses blend modes, tints and colour keys. Written only when used
  (v3); a white tint and the normal blend are not stored.
- **Integrity**: every undoable edit runs `repairReferences` (same undo step) so deleting
  bones/attachments/images drops or fixes dependent constraints, slot keys, skin entries
  and draw-order keys, and the project always re-opens.
- **Pixel selections** (`selectColour`, `cutOutMask`, `findSpecks` in `src/model/cutout.ts`),
  with the Wiz prep script's semantics: a per-channel colour box around the clicked pixel
  on pixels with α > min; contiguous = the 4-connected region (PIL flood fill), otherwise
  every matching pixel (threshold). A selection cut is pixel-exact (remainder = source
  minus the selected pixels; overlap = disc dilation). Specks = 0 < α < faint with no
  α > solid in a (2d+1)² window (default 100 / 200 / 6, the script's constants); removal
  writes a `cleanup` copy and re-points the attachment (one undo step).
- **Cutouts** (`src/model/cutout.ts`): coverage from the signed distance to the outline
  (1-px anti-aliased edge, exact outward overlap); piece and remainder are complementary
  at overlap 0; patches fill only transparent pixels inside the outline with a flat
  colour placed behind existing pixels, never above the source image's own alpha, and
  record the synthesized pixel count. Joint extension (`extendPiece`) repeats the piece's
  first clean cross-section back past the pivot (axis: pivot → outline area centroid),
  filling only transparent pixels under opaque cover (alpha ≥ 250), so the grown part
  stays hidden at rest and fills the gap when the joint bends.
- **Meshes** (`src/model/mesh.ts`, `meshOps.ts`): by default the bind pose is the current
  **setup pose** — a weighted vertex is `Σ wᵢ · Wᵢ(now) · Wᵢ(setup)⁻¹ · A(setup) · (p + deform)`,
  so editing setup bones re-binds (the mesh follows the attachment's bone at setup). A
  weighted mesh can instead store its own bind pose (v3 `mesh.bind`: the attachment's and
  the weight bones' world matrices, captured by Mesh ▸ Bind pose or the `bind` CLI at the
  setup pose or at an animation frame); skinning then uses `W(bind)` and `A(bind)` in place
  of the setup terms (bones without an entry bind at setup), so the mesh is the undistorted
  image whenever the bones are in the bind pose, and setup edits bend it like animation
  does (a tail drawn straight can rest curled). Weight tools (auto, limb, mirror input)
  measure geometry in the bind frame. A bind needs weights: making the mesh rigid drops it,
  and deleting a bone drops its entry. `addIk` takes the bend side from the setup elbow
  unless given (`ik --bend`), since a straight chain has no side of its own.
  Geometry is centred on the setup image; an image key or skin showing another image
  scales only the texture coordinates (normalized UVs). Changing the setup image rescales
  the points (and deform keys). Triangulation: ear clipping of the outline, interior
  points inserted by splitting, then Delaunay edge flips that never cross the outline;
  self-crossing outlines, duplicates (< 0.5 px), interior points on/outside the outline
  and degenerate triangles are rejected. Weights renormalize to exactly 1 after every
  edit; subtracting a vertex's only influence hands it to the attachment's bone (no-op
  when that is the painted bone). Deleting a bone passes its weights to its parent; a
  missing bone is dropped and the rest renormalized (integrity pass). Re-meshing resets
  weights and deform keys. A deform key whose vertex count does not match the mesh (an
  old mesh's key pasted after re-meshing) is removed on its own, with a status note; the
  rest of the deform track stays.
- **Auto weights** (`autoWeights`): inverse-square distance 1/max(1, d)² from each vertex
  to each chosen bone's segment (setup pose), the strongest two kept. Influences fade out
  between 70.7 px and 100 px (a smoothstep ramp on 1/d² from 2·10⁻⁴ down to 10⁻⁴) instead
  of being cut, and that list is blended, by the strongest influence's ramp, with the
  plain normalized inverse-square weights, which also weight vertices beyond 100 px from
  every bone. The weights are therefore continuous; the earlier hard cut tore a skinned
  mesh by up to 102 px (post-review FR-002, `scripts/post-review/fr002-autoweights-probe.ts`).
  Vertices with no influence inside the band keep exactly the earlier weights. With more
  than two candidate bones, picking the strongest two can still switch an influence where
  two distances are equal.
- **Mesh rendering** (`src/render/draw.ts`): each mesh is drawn into an integer-aligned
  offscreen layer and composited once with the attachment opacity. Each triangle is
  clipped to its outline and the image drawn through the triangle's affine map
  (Canvas2D). Unfolded meshes (all non-degenerate triangles share one orientation — a
  whole-mesh mirror counts as unfolded) use additive (`lighter`) compositing with no
  bleed: the anti-aliased clip coverages of triangles sharing an edge sum to 1, so seams
  are exact even on translucent art (measured: interior alpha min = max = target). A
  folded mesh (mixed orientations) draws source-over in triangle order with a 0.5 px
  bleed. Degenerate triangles (screen or texture area ≈ 0) draw nothing. Verified only on
  headless Chrome for Testing's software raster; GPU-accelerated canvases were not
  checked. Known limits: a mesh that overlaps itself *without* any reversed triangle would
  add colours where it overlaps; minified hard texture edges use Canvas2D's single
  bilinear tap (the reference supersamples coverage only).

- **Skins** (`src/model/skinOps.ts`): images are shared by reference and never copied or
  modified, so reusing one image across skins is safe. Validation (`skinDiagnostics`,
  shown in the Skins panel) flags aspect-ratio mismatches (warning; a mesh keeps its
  geometry and stretches the texture), size differences, self-replacements, entries for
  keyed images no animation shows, empty skins and shared images. Removing an image
  removes the skin entries and image keys that use it (after a confirm listing them).
- **Mixing** (`src/model/mix.ts`): a plan is a chain of entries on one clock; entry *k*
  starts at `start_k` and blends over `mix_k`: `P_k = P_{k−1} + w_k (v_k − P_{k−1})`,
  `w_k = clamp((T − start_k)/mix_k, 0, 1)`, rotation the shortest way, exact incoming
  value at `w = 1`. Interrupting a running blend therefore starts from the live blended
  pose (continuous). Channels the incoming animation does not key either blend to the
  setup pose (`missing: 'setup'`) or keep the previous pose (`'hold'`). Constraint mix
  and path position blend along the chain the same way (an entry that does not key them
  supplies the constraint's setup value under `'setup'`, nothing under `'hold'`; each
  entry's mix is clamped to 0..1), so an animation that keys an IK to mix 0 fades the IK
  out over the transition (until the review-corrections pass the dominant entry's
  constraint keys switched at weight 0.5). Constraints are then solved on the blended
  local pose; visibility, image and draw order come from the newest entry with weight
  ≥ 0.5; opacity and mesh deform blend along the chain.
  The Mix dialog (`src/ui/mixDialog.ts`) previews, plays and exports a transition as a
  PNG sequence named `<from>-to-<to>`. Saved clip sequences (`src/model/clipSequence.ts`)
  always use `missing: 'setup'` (the Mix dialog's default); the Sequences dialog says so,
  and its frames equal the Mix dialog's only with that setting.

## Runtime export (`rigsmith.runtime`, version 2 — full schema in docs/runtime.md)

Bones/attachments by **name** (images referenced by file name, bytes not embedded), each
animation's keys, plus `baked[boneName][frame] = [worldX, worldY, worldRotDeg,
worldScaleX, worldScaleY]` for every frame (after constraints), so a consumer can play it
without implementing interpolation. Animations with slot or draw-order keys also carry
`bakedSlots[frame]` = attachments back→front with `{attachment, visible, opacity, image}`.
Mesh attachments carry `mesh: {uvs, triangles, hull}` (uvs in setup-image pixels), and
animations of projects with meshes carry `bakedMeshes[attachmentName][frame]` = world
vertices `[x0,y0,…]` with deform keys and skinning applied (the same `evaluate()` output
the editor draws). Version 2 adds everything needed to evaluate from keys (curves, slot,
draw-order and constraint keys, IK/paths, mesh weights, skins, mixes) at full precision;
the reference player (`player.html`) plays it with a texture atlas. Mesh layers are sized
exactly to each mesh every draw: a grow-only layer cache made Chrome's anti-aliased clip
coverage depend on previously drawn frames.

## Lottie and animated media exports

- `src/model/lottie.ts` writes a Lottie *subset* (bones → parented null layers, flat
  images → image layers, exact easing mapping; discrete keys and skins → in/out-point
  layer runs) and refuses IK, paths, meshes, deform/draw-order/constraint keys with named
  diagnostics. Verified by an in-repo evaluator (`tests/support/lottie-eval.ts`) and,
  frame by frame, by lottie-web 5.13.0's canvas renderer (test-only devDependency).
  Details: docs/lottie.md.
- `src/model/media.ts` turns the PNG-sequence frames into APNG (lossless) or GIF (global
  palette, 1-bit alpha, centisecond delays); pure TS, shared by the export dialog and
  the CLI. WebM (VP9 alpha) / MP4 (H.264, no alpha) are CLI-only via a local ffmpeg
  (`scripts/lib/rigsmith-api.ts`). Details: docs/media.md.

## Motion reuse and onboarding (RV-009, RV-012)

- **Clip sequences** (`src/model/clipSequence.ts`): a sequence is scheduled at the export
  rate — each play of a step is `max(1, round(duration · fps))` frames, steps follow each
  other on one clock, and step *i* blends in from the live pose over the stored mix
  duration of (step *i−1* → step *i*), evaluated by the Mix dialog's `evaluateMix`. The
  Sequences… dialog and `rigsmith sequence` render the same frames (the CLI test checks
  byte-identical ZIPs). The dialog defaults to the project frame when one is set; the CLI
  uses it with `--frame project` (its default is `fit`, as for the other render commands).
- **Animation import** (`src/model/animImport.ts`): animations from another project file
  are copied with an explicit source → target map for bones, attachments, constraints
  and images (exact-name defaults, every entry changeable or skippable). The dialog shows
  a dry-run report (unmatched objects, keys that would be dropped) before Import, which
  is one undo step. Key values are **absolute local values** and are copied unchanged, so
  a target bone whose setup differs from the source bone's jumps to the source values at
  its first key; the opt-in "Offset by the setup difference" adds (target − source setup)
  to translate and rotate keys and multiplies scale keys by the setup-scale ratio (a zero
  source setup scale is copied unchanged, with a note). The report lists, per IK / path
  constraint with mix > 0 that the imported animation does not key, how many imported
  keys it overrides and on which bones (`drivenByConstraints`): those keys have no visible
  effect. A per-constraint opt-in writes a stepped mix key 0 at t = 0 on that constraint
  in the imported copy only (the setup constraint is untouched), so the keys play and the
  constraint stops solving in that animation. It is off by default: on the Wiz v3 rig
  muting the leg IK lets the feet drift (shin-to-foot gap 14.8 → 38.0 px). Rig
  differences (a mapped bone whose parent name differs; scale keys that now also scale
  bones not below it in the source) are listed as notes. Pasting keys reports the same
  override and, when a one-bone clip lands on another selected bone, where it went.
- **Key clipboard** (`src/model/clipboard.ts`): copied keys are stored with the *names* of
  what they reference; pasting resolves same id + name, else the unique same name, and
  reports what does not resolve instead of guessing.
- **Flat-art guide** (`src/model/onboarding.ts`, `src/ui/guideDialog.ts`): a non-modal
  checklist on top of the existing tools. Its progress is **derived from the project**
  (an original image exists; the art attachment is on a bone; a `cleanup` image is in the
  art's lineage; pieces with / without a cut polygon; the art's mesh has weights; an
  animation has keys). Nothing is stored, so the file format is unchanged, old files need
  no migration, and undo, redo and autosave recovery show the right state by
  construction. Each guide action is one undo step: root bone + attach, grid mesh + auto
  weights (to the art's bone and the bones below it), and a starter idle (2 s loop, root
  bob of 1 % of the art height, ±3° sway on bones whose origin is above the art's centre).
  The cut steps open the existing Cut out piece… dialog with presets (overlap 0, extend 40
  for limbs; Select colour at tolerance 255 for hands) and a note with the RV-010 limits.

## Persistence

- Save = download of `<name>.rig.json` (images embedded). Open = file picker or drag &
  drop a `.json` onto the canvas.
- Browser storage is IndexedDB (database `rigsmith`, store `kv`; `src/ui/storage.ts`):
  `browser-save` ("Save to browser"), `autosave` (offered for recovery after a reload),
  and `clipboard` (the last copied keys, `rigsmith.keys` v1, so they survive a reload and
  can be pasted into another project). The old `localStorage` copies are migrated once.
