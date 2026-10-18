# Rigsmith

An independently written, browser-based 2D skeletal animation editor — initial
vertical slice. Import images, build a bone hierarchy, attach art to bones, pose, key
translate/rotate/scale on a timeline, play it back, save/load projects and export
animation data or PNG frames. Everything runs locally in the browser.

> Scope: a first usable slice, not a replacement for commercial animation suites.

## Run

Developed and tested only on Node 25.9.0. The tests run `.ts` files directly through
Node's built-in type stripping, which is on by default from Node 23.6 / 22.18, so those
are the expected minimums (untested here).

```sh
npm install
npm run dev        # http://127.0.0.1:47613  (dev server, 127.0.0.1 only)
# or production build + preview
npm run build
npm run preview    # http://127.0.0.1:47613
```

Open `http://127.0.0.1:47613/?demo` to start straight into the playing demo.

## Test

```sh
npm test            # model unit tests (node:test)
npm run typecheck   # tsc --noEmit
npm run build       # typecheck + production build into dist/
npm run test:e2e    # browser tests; needs `npm run build` first
node tests/e2e/tour.ts   # optional: screenshots of main states → .hermes/evidence/screens/
```

Character acceptance test (needs the private, git-ignored Wiz art under `.hermes/assets/wiz/`):
`npm run wiz:prepare && npm run wiz:build && npm run wiz:capture && npm run test:wiz` — see
`docs/WIZ-ANIMATION-DELIVERY.md`.

The e2e suite launches **headless Chrome for Testing** with a throwaway profile in
`.hermes/browser-profiles/e2e` and its own `vite preview` on a free port in 47614–47617.
Set `RIGSMITH_CFT=/path/to/Google Chrome for Testing` if your binary lives elsewhere
(default: `~/chrome-for-testing/chrome/mac_arm-155.0.8059.39/…`).

## Using the editor

| Do | How |
|---|---|
| Try the demo | **Demo** button (or the empty-state button) — loads "Tock" and plays the walk loop |
| Import art | **Import…** in Images, or drop PNG/JPEG/WebP/GIF files on the canvas |
| Make bones | **Bone** tool (B): press-drag on the canvas. With a bone selected, the new bone is its child. Or **+ Bone** |
| Re-parent | Inspector → Parent (descendants are not offered; cycles are impossible) |
| Attach art | Select a bone, then **Attach** on an image. Edit offset/rotation/scale/opacity/draw order in the inspector or drag the image (Move tool) |
| Pose | Move (V) / Rotate (R) / Scale (S) tools on the canvas, or type values in the inspector |
| Animate | **+** in the timeline creates an animation and switches to Animate mode (Tab toggles). Any pose edit writes a key at the current frame; **K** keys all channels; ◆ buttons in the inspector toggle a channel key |
| Timeline | Click/drag to scrub (snaps to frames); click a ◆ to select it, drag to retime, change its interpolation (linear/step/smooth), Delete to remove. Set length (s), FPS and loop; ▶ Play / Space |
| Undo | Ctrl/⌘+Z, Ctrl/⌘+Shift+Z or Ctrl+Y, or the toolbar buttons |
| Save | **Save** downloads `<name>.rig.json` (images embedded); **Open…** loads it; **Save to browser / Restore** use localStorage |
| Export | **Export data** → `<name>.runtime.json` (keys + baked per-frame world transforms); **Export PNG** → current frame, transparent, cropped to the art |
| Navigate | Wheel = zoom at cursor; middle/right-drag, Alt+drag or drag empty canvas = pan; F / double-click = fit; H = hide bones; **?** = all controls |

Docs: `docs/architecture.md` (model, formats), `docs/provenance.md`,
`docs/rea-evidence.md`, `docs/DELIVERY.md`.
