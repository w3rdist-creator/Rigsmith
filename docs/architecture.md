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
| `Attachment.hidden` | hidden in the setup pose (visibility keys can show it) |
| `Animation.slots[attId].visible / opacity / image` | slot keys: visibility `[0|1]` (stepped), opacity `[0..1]` (interpolated), image swaps `{time, imageId}` (stepped) |
| `Animation.drawOrder: [{time, order: [attId…]}]` | stepped draw-order keys; each `order` lists every attachment exactly once |
| `Animation.constraints[id].mix / position` | keyed constraint mix and path position |
| `ik: [{id, name, bones: [parent, child] or [bone], target, mix, bendPositive}]` | IK constraints |
| `paths: [{id, name, boneId, closed, nodes: [{x,y,inX,inY,outX,outY}]}]` | cubic Bezier paths in a bone's space (null = world); handles relative to their node |
| `pathConstraints: [{id, name, pathId, bones, position, spacing, mix, rotate, rotateOffset}]` | bones placed along a path |
| `ImageAsset.derived: {kind, sourceId, offsetX, offsetY, polygon?, synthesized, note?}` | provenance of cutout/remainder/patch images; the source image is kept unmodified |
| `Attachment.mesh: {points, triangles, hull, weights?}` | textured triangle mesh: `points` in the setup image's pixels (also the texture coordinates), the first `hull` points are the outline in order; `weights[v] = [{bone, w}]` sums to 1 per vertex (absent = rigid on the attachment's bone) |
| `Animation.slots[attId].deform` | deform keys: `value` = per-vertex offsets `[dx0,dy0,…]` in image pixels (2 per vertex), interpolated |
| `skins: [{id, name, entries: [{attachmentId, imageId, from?}]}]` | attachment sets: an entry without `from` replaces the attachment's setup image wherever it shows (including through an image key that shows the setup image); an entry with `from` replaces that keyed image. At most one entry per (attachment, from) |
| `mixes: [{from, to, duration}]` | stored crossfade durations per ordered animation pair (seconds, 0–10; default 0.2 s when absent) |

Evaluation order (`src/model/evaluate.ts`, shared by the viewport, onion skin, sequence
export and runtime export): sample local pose → IK constraints (array order) → path
constraints (array order) → world matrices → per-attachment state (visibility, opacity,
image, skin, draw order) → mesh vertices.

- **Stepped slot channels** (visibility, image, draw order) show the setup value before
  their first key; interpolated channels (bone channels, opacity) hold their first key.
- **Two-bone IK**: law of cosines with the cosine clamped to [−1, 1]: unreachable targets
  straighten the chain toward the target, too-close targets fold it, a target on the
  chain root leaves the keyed pose. `bendPositive` puts the elbow on the clockwise side
  of the shoulder→target line; a mirrored parent (negative determinant) mirrors the
  side. Solved angles are written back as local rotations through the inverse parent
  matrix (exact for mirrored and uniformly scaled parents), kept on the keyed turn, and
  `mix` blends local rotations from keyed (0) to solved (1).
- **Path constraints**: arc-length table (32 samples per cubic segment); bone *i* sits at
  `position·L + i·spacing`; open paths clamp, closed paths wrap; `rotate` aligns the
  bone's +x with the tangent plus `rotateOffset`; `mix` blends translation/rotation.
- **Integrity**: every undoable edit runs `repairReferences` (same undo step) so deleting
  bones/attachments/images drops or fixes dependent constraints, slot keys, skin entries
  and draw-order keys, and the project always re-opens.
- **Cutouts** (`src/model/cutout.ts`): coverage from the signed distance to the outline
  (1-px anti-aliased edge, exact outward overlap); piece and remainder are complementary
  at overlap 0; patches fill only transparent pixels inside the outline with a flat
  colour placed behind existing pixels, never above the source image's own alpha, and
  record the synthesized pixel count. Joint extension (`extendPiece`) repeats the piece's
  first clean cross-section back past the pivot (axis: pivot → outline area centroid),
  filling only transparent pixels under opaque cover (alpha ≥ 250), so the grown part
  stays hidden at rest and fills the gap when the joint bends.
- **Meshes** (`src/model/mesh.ts`, `meshOps.ts`): the bind pose is the current **setup
  pose** — a weighted vertex is `Σ wᵢ · Wᵢ(now) · Wᵢ(setup)⁻¹ · A(setup) · (p + deform)`,
  so editing setup bones re-binds (the mesh follows the attachment's bone at setup).
  Geometry is centred on the setup image; an image key or skin showing another image
  scales only the texture coordinates (normalized UVs). Changing the setup image rescales
  the points (and deform keys). Triangulation: ear clipping of the outline, interior
  points inserted by splitting, then Delaunay edge flips that never cross the outline;
  self-crossing outlines, duplicates (< 0.5 px), interior points on/outside the outline
  and degenerate triangles are rejected. Weights renormalize to exactly 1 after every
  edit; subtracting a vertex's only influence hands it to the attachment's bone (no-op
  when that is the painted bone). Deleting a bone passes its weights to its parent; a
  missing bone is dropped and the rest renormalized (integrity pass). Re-meshing resets
  weights and deform keys.
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
  setup pose (`missing: 'setup'`) or keep the previous pose (`'hold'`). Constraints are
  solved on the blended local pose; visibility, image, draw order and constraint keys come
  from the newest entry with weight ≥ 0.5; opacity and mesh deform blend along the chain.
  The Mix dialog (`src/ui/mixDialog.ts`) previews, plays and exports a transition as a
  PNG sequence named `<from>-to-<to>`.

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
  diagnostics. Verified only by an in-repo evaluator (`tests/support/lottie-eval.ts`).
  Details: docs/lottie.md.
- `src/model/media.ts` turns the PNG-sequence frames into APNG (lossless) or GIF (global
  palette, 1-bit alpha, centisecond delays); pure TS, shared by the export dialog and
  the CLI. WebM (VP9 alpha) / MP4 (H.264, no alpha) are CLI-only via a local ffmpeg
  (`scripts/lib/rigsmith-api.ts`). Details: docs/media.md.

## Persistence

- Save = download of `<name>.rig.json` (images embedded). Open = file picker or drag &
  drop a `.json` onto the canvas.
- "Save to browser" stores the same JSON in `localStorage` (`rigsmith:project:v1`); a
  `QuotaExceededError` is shown as an error telling the user to download instead.
