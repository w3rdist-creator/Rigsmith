# Delivery — Rigsmith initial usable build (2026-10-17)

Worker: Claude Opus 5.5 (`claude-opus-5-5`), effort high, on the Mac mini. Vertical
slice of an independent 2D skeletal animation editor. **Not** a claim of parity with
Spine or any other product.

## Checklist

Legend: **Implemented** = visible control + exercised by a test; **Partial** = works
with stated limits; **Absent** = not built.

| Requirement | Status | Where it is proven |
|---|---|---|
| Local image import (picker + drag-drop), PNG/JPEG/WebP/GIF, type/size/decode errors | Implemented (drag-drop is implemented but not browser-tested) | e2e "imports a local image…" (picker path + non-image rejection toast) |
| Image list with thumbnails, attach/place, remove | Implemented | e2e import/attach test; demo shows 7 images |
| Canvas pan / zoom / fit | Implemented | wheel zoom at cursor, middle/right/Alt-drag or empty-drag pan, F/double-click fit. Pan/zoom are **not** directly asserted by e2e (used implicitly); manual/screenshot evidence only |
| Selectable art on canvas | Implemented | e2e drags the image by clicking on it; a selected image stays grabbable over bones |
| Bone create / select / parent | Implemented | e2e Bone-tool drags create root + child (`parentId` asserted); tree selection; Parent dropdown |
| Correctly composed parent transforms | Implemented | unit: 3-bone chain, non-uniform scale, out-of-order bones, world→local under rotated+scaled parent; e2e: rotating parent moves child to the expected screen point, child world angle = 180° |
| Cycle prevention | Implemented | unit: `wouldCreateCycle`, `reparentBone` throws `CycleError` and leaves state unchanged, loader rejects cyclic files; e2e: descendants/self absent from Parent options; e2e: cyclic file rejected with visible error |
| Transform posing (move/rotate/scale tools + inspector) | Implemented | e2e rotate-drag, move-drag (joint lands under cursor ±2 px), inspector edits. Scale tool on canvas **not** e2e-tested (inspector scale is) |
| Attach images to bones, edit attachment offsets | Implemented | e2e: attach to selected bone, set x/y/rotation in inspector, drag offset on canvas, attachment follows bone rotation |
| Timeline: translate/rotate/scale keys | Implemented | e2e: K keys all three channels; inspector + canvas edits key rotate at frames 15 and 30 |
| Scrubbing | Implemented | e2e: ruler clicks set time (frame-snapped), pose matches keys |
| Interpolation | Implemented (linear / step / smooth) | unit: linear, step, smooth, multi-segment, raw-degree rotation; e2e: linear in-between at frame 6, step hold after switching key interp |
| Playback / loop | Implemented | e2e: demo joints move over time, still playing after > 1 duration; user-made animation plays; pause holds and lands on a whole frame |
| Duration / FPS controls | Implemented | e2e: FPS 12 regrids keys (key at 0.5 s → frame 6), duration 2 s → 24 frames |
| Project save / load / download, original versioned JSON with embedded images | Implemented | unit roundtrip + 15 invalid-input cases; e2e: download → fresh page → open → deep-equal project incl. image sha256 |
| Browser storage save/restore | Implemented | e2e reload + Restore |
| Validation with visible errors | Implemented | e2e invalid (cyclic) file → error toast, project untouched |
| Undo/redo | Implemented | unit: History order/branching/limit, snapshot isolation; e2e: buttons, Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, Ctrl+Y, one drag = one step, key delete undo, image import undo/redo |
| Built-in original articulated demo, visibly animated loop | Implemented | "Tock" (12 bones, 11 attachments, walk + wave), procedurally painted art; e2e pixel-hash + joint movement; REA screenshot digests differ |
| Keyboard/mouse controls, help, practical layout, empty/error states | Implemented | `?` help dialog, tool hints, empty-stage panel, empty panel texts, error toasts; screenshots in `.hermes/evidence/` |
| Animation-data export | Implemented (`rigsmith.runtime` v1: keys + baked per-frame world transforms) | e2e checks format, frame count, baked rows |
| PNG frame export | Implemented (current frame, transparent, cropped) | e2e checks PNG signature |
| Multiple animations per project | Implemented (select / new / rename / delete) | demo has 2; rename/delete not e2e-tested |
| Key retime by dragging ◆ | Implemented | not e2e-tested |
| Mesh deformation, IK, skins, slots/attachment swapping over time, curve editor, onion skin, atlas packing, sequence (multi-frame) PNG export | **Absent** | out of scope for this slice |

## Commands and real results (final run, build `index-bftQBcAc.js`)

Raw outputs: `.hermes/evidence/unit-tests.txt`, `build-typecheck.txt`, `e2e-tests.txt`,
`e2e-repeat-runs.txt`, `e2e-regression-prefix-fail.txt` (git-ignored).

### 1. Model / unit tests — `npm test`
```
ℹ tests 43
ℹ pass 43
ℹ fail 0
exit=0
```
Covers transform composition, cycle prevention, interpolation, save/load roundtrip and
15 invalid-input rejections, undo/redo, runtime export.

### 2. Build checks — `npm run typecheck`, `npm run build`
```
exit=0   (tsc --noEmit)
dist/index.html                  2.61 kB │ gzip:  1.06 kB
dist/assets/index-CumTPsn2.css  10.17 kB │ gzip:  2.93 kB
dist/assets/index-bftQBcAc.js   74.11 kB │ gzip: 23.70 kB
exit=0
```

### 3. Browser interaction checks — `npm run test:e2e`
Headless Chrome for Testing 155.0.8059.39, isolated profile `.hermes/browser-profiles/e2e`,
own `vite preview` on a verified-free loopback port.
```
✔ demo playback › loads the built-in demo and animates joints over time
✔ rigging › creates a bone and a child bone with the Bone tool; parent options prevent cycles
✔ rigging › posing a parent moves the child (composed transforms) at the correct screen location
✔ rigging › imports a local image, attaches it to a bone and edits the offset
✔ timeline › creates an animation, keys poses at two frames and interpolates while scrubbing
✔ timeline › duration and FPS controls retime the frame grid without moving keys in seconds
✔ undo / redo › undoes and redoes inspector edits, canvas drags (one step per drag) and imports
✔ save/load › downloads a project file with embedded images
✔ save/load › reloads the page, opens the file and gets the identical project back (incl. image bytes)
✔ save/load › rejects an invalid project with a visible error and keeps the current one
✔ save/load › saves to browser storage and restores after reload
✔ save/load › exports runtime animation data and a PNG frame
✔ page health › raised no uncaught page errors
ℹ tests 13  ℹ pass 13  ℹ fail 0   exit=0
```
Repeat runs: 13/13 twice more (`e2e-repeat-runs.txt`; those were on the build before the
pause-snap fix, the final build was run once in full). The pause regression assertion
**failed on the pre-fix build** (`expected 23.070000000022354 ≈ 23`) and passes now.
Screenshots: `.hermes/evidence/e2e/*.png` (frames a/b, posed rig, attached image, keys
and scrub, undo, reloaded project, invalid-file error) and `.hermes/evidence/screens/*.png`.
Downloads produced by the tests: `.hermes/evidence/downloads/`.

### 4. REA evidence
See `docs/rea-evidence.md`. Raw bundle: `.hermes/evidence/rea/rea-evidence-bundle.json`
(11 records). Highlights: passive target listing, two screenshots with different digests,
passive page inspection (0 console events, "Pause" state in a11y tree), static analysis
of `dist/`, passive bundle capture (1 script, digest equal to the built file, 0
endpoints), four controlled scenarios. REA found two a11y labelling issues and a
pause/keying bug, all fixed and re-verified. Not run: `compare_web_screenshots` and
`reconcile_javascript_runtime` (inline payload size; documented). Passive/static REA
evidence (#2–#7) is of an earlier build (`index-C7ix3IWp.js`, sha256 `4642d205…`); the
final bundle `index-bftQBcAc.js` (sha256 `64586339…5096fb`) was exercised by the e2e suite
and by REA controlled scenario `ev_19ca685c…` (11/11 steps, 0 console/page errors).

## Preview

`http://127.0.0.1:47613/` (`?demo` opens the playing demo) — `vite preview` of the final
`dist/`, bound to 127.0.0.1 only, verified HTTP 200 serving `index-bftQBcAc.js`. It was
started by the worker session and may stop when that session ends; restart with
`npm run build && npm run preview`.

## Provenance

Original: all code, UI, name/mark, file formats, demo rig/animation/art (procedural),
test images. Third-party: dev/build-only packages (Vite/Rolldown/LightningCSS MIT/MPL-2.0,
TypeScript Apache-2.0, playwright-core Apache-2.0); no runtime dependencies. No Spine
material of any kind was obtained or used. Details: `docs/provenance.md`. Independently
written, not a certified clean-room.

## Remaining gaps

- Absent features listed above (meshes, IK, skins, attachment keying, curve editor, etc.).
- Not browser-tested: drag-drop import, canvas Scale tool, pan/zoom gestures, key retime
  drag, animation rename/delete, attachment draw-order buttons, help dialog contents.
- Skew from rotated + non-uniformly scaled parents is dropped when reparenting with
  keep-world (documented in architecture).
- Large projects: every undo step clones bones/keys (images shared); fine for slice-sized
  rigs, untested at thousands of keys. `localStorage` save is limited by browser quota
  (shown as an error; download still works).
- Toolbar and panels re-render on edits, so keyboard focus can move after clicking toolbar
  buttons.
- Environment (operator-side): `~/Applications/Google Chrome for Testing.app` symlink is
  dangling and `~/chrome-for-testing/current` 155.0.8059.84 wrapper execs itself forever.

## Residual uncertainty

The e2e suite asserts the model through a read-only probe and coordinates; it checks
that rendered pixels *change* during playback but does not check that the rendered art
is *correct*, for example that each image lands exactly on its bone at the right
rotation. That was judged only from the screenshots, which a human should glance at
(`.hermes/evidence/e2e/12-image-attached.png`, `screens/02-demo-playing.png`).
