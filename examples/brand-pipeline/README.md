# Brand pipeline example

One rigged mascot, one skin per brand colourway, every deliverable produced headlessly by
the documented CLI (`docs/cli.md`). The art is original and procedural (signed-distance
shapes in `pipeline.ts`, palettes in `brands.json`); nothing is imported.

```sh
npm run build                      # the CLI renders with dist/render.html
npm run example:brand              # → .hermes/assets/roadmap-demos/brand-pipeline/
npm run example:brand -- some/dir  # or another output folder
```

What it does (see `pipeline-log.txt` in the output for the exact commands):

1. Draws `body / head / arm / leg / flag` in the base palette and in each brand palette.
2. Builds the base rig with the model API (8 bones, 7 attachments, `wave` and `idle`
   animations with smooth and bezier keys) and writes `work/mascot.rig.json`.
3. Per brand: `rigsmith add-image` for each part, then `rigsmith skin --name <brand>
   --set <attachment>=<brand>-<part>.png …`.
4. `rigsmith set-mix --from idle --to wave --duration 0.3`, `rigsmith validate`.
5. `rigsmith runtime` (one runtime JSON for all brands) and `rigsmith atlas` (one atlas
   with every colourway).
6. Per palette (base + brands): `rigsmith render --anim wave [--skin <brand>]` and
   `rigsmith mix --from idle --to wave --at 0.5 [--skin <brand>]`.
7. `manifest.json`: every output file with its size and sha256.

Adding a brand = adding an entry to `brands.json`. Running twice on the same machine
gives an identical manifest (checked by `npm run test:cli`).
