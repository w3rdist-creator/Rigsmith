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

## Runtime export (`rigsmith.runtime`, version 1)

Bones/attachments by **name** (images referenced by file name, bytes not embedded), each
animation's keys, plus `baked[boneName][frame] = [worldX, worldY, worldRotDeg,
worldScaleX, worldScaleY]` for every frame, so a consumer can play it without
implementing interpolation.

## Persistence

- Save = download of `<name>.rig.json` (images embedded). Open = file picker or drag &
  drop a `.json` onto the canvas.
- "Save to browser" stores the same JSON in `localStorage` (`rigsmith:project:v1`); a
  `QuotaExceededError` is shown as an error telling the user to download instead.
