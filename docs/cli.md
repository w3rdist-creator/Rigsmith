# Rigsmith headless CLI and Node API

`node scripts/rigsmith.ts <command> …` (or `npm run rigsmith -- <command> …`). The
commands wrap a small Node API (`scripts/lib/rigsmith-api.ts`) that the
`examples/brand-pipeline` example also uses. Nothing here drives the editor UI or its
read-only test probe.

## Output contract

- stdout: exactly one JSON object, `{"ok": true, "command": …, …}` or
  `{"ok": false, "command": …, "error": "…", "errors": ["…"]}`.
- stderr: progress only (`frame 12/30`).
- Exit codes: `0` ok · `1` invalid input (project, names, ranges, sizes) · `2` usage
  (unknown command, missing/ill-typed flag, missing file) · `3` environment (no
  `dist/render.html`, no Chrome for Testing) · `4` render failure or cancel (Ctrl+C).
- Outputs are written atomically (temp file + rename). A failed or cancelled command
  writes nothing.

## Commands

| Command | Needs a browser | What it does |
|---|---|---|
| `validate <project>` | no | parse + validate (the editor's own reader); summary JSON |
| `info <project>` | no | bones, attachments, meshes, images, animations, constraints, skins, mixes |
| `runtime <project> --out f.runtime.json` | no | `rigsmith.runtime` v2 (docs/runtime.md); identical bytes to the editor's **Export data** |
| `atlas <project> --out dir [--padding 2] [--bleed 1] [--no-trim] [--pot] [--max 2048]` | no | `rigsmith.atlas` pages + JSON; same metadata and pixels as **Export atlas…** (PNG bytes may differ: Node's zlib vs Chrome's) |
| `render <project> --anim A --out f.zip [--skin S] [--fps N] [--start F] [--end F] [--scale X] [--padding P]` | yes | transparent PNG sequence ZIP; identical bytes to **Export sequence…** with the same settings |
| `mix <project> --from A --to B --at T --out f.zip [--duration S] [--missing setup\|hold] [--skin S] [--fps N]` | yes | transition sequence (stored mix duration unless `--duration`); identical bytes to the Mix dialog export |
| `lottie <project> --anim A --out f.json [--skin S]` | no | Lottie supported subset (docs/lottie.md); exit 1 with every refusal when the rig is outside it; identical bytes to **Export Lottie…** |
| `media <project> --format apng\|gif\|webm\|mp4 (--anim A \| --from A --to B --at T) --out f [render options] [--background #rrggbb]` | yes (+ ffmpeg for webm/mp4) | one animated file from the same PNG frames as `render` (docs/media.md). APNG/GIF: built in, the editor's encoders (GIF bytes identical to the editor's; APNG identical pixels). WebM (VP9 + alpha) / MP4 (H.264, no alpha, on `--background`, default white): need a local `ffmpeg` (or `RIGSMITH_FFMPEG`) with libvpx-vp9 / libx264, else exit 3. JSON includes the codec/alpha label and, for GIF, the alpha-loss counts |
| `sequence <project> --name S --out f [--format zip\|apng\|gif\|webm\|mp4] [--skin S] [--fps N] [--scale X] [--padding P] [--background #rrggbb] [frame]` | yes (+ ffmpeg for webm/mp4) | renders a saved clip sequence (RV-009): ordered clips with repeat counts and the stored mix durations between them; ZIP bytes identical to the **Sequences…** dialog export with the same settings; JSON lists each step's start frame and frame count |
| `set-sequence <project> --name S --steps "idle*2,greeting,idle" [--loop] --out p2` | no | creates or replaces a saved sequence; `name*N` = N plays (1–100); unknown animations or bad counts → exit 1, nothing written |
| `add-image <project> --file x.png [--name n] --out p2` | no | adds a PNG (id derived from the name — reproducible) |
| `replace-image <project> --image n --file x.png [--allow-resize] --out p2` | no | swaps pixels keeping the id (attachments, keys and skins follow); a size change needs `--allow-resize` |
| `skin <project> --name S [--set att=image …] [--keyed att:fromImage=image …] --out p2` | no | creates/extends a skin (setup-image and keyed-image entries) |
| `set-mix <project> --from A --to B --duration S\|none --out p2` | no | stores or removes a mix rule |
| `mesh <project> --att A --grid CxR --out p2` | no | replaces A's image with a triangulated C×R grid mesh (rigid until weighted) |
| `weights <project> --att A --out p2` + one of `--auto b1,b2 [--max-influences N]` · `--along upper,lower --band inner/outer [--side ±1] [--helper bone] [--end bone:at:band:max] [--root bone:from:to]` · `--mirror-from A2 --swap _l=_r`, and/or `[--smooth N] [--smooth-amount a]` | no | sets A's mesh weights (see below) |
| `inherit <project> --bone B [--rotation on\|off] [--scale on\|off] [--reflection on\|off] --out p2` | no | sets a bone's inherit flags, keeping its setup placement (any flag off → v3) |
| `tint <project> --att A [--blend normal\|additive\|screen\|multiply] [--color #rrggbb[aa]] [--anim N --at s] --out p2` | no | sets the blend mode and/or setup tint; with `--anim`/`--at` keys the colour instead (any non-default → v3) |
| `vertex-alpha <project> --att A --out p2` + one of `--radial cx,cy,inner,outer [--invert]` · `--set i=a[,i=a…]` · `--clear` | no | per-vertex alpha on a mesh attachment: radial fade in image px (1 inside `inner`, 0 beyond `outer`), single vertices, or back to opaque (v3) |
| `bind <project> --att A [--anim N --at s \| --clear] --out p2` | no | binds a weighted mesh at the setup pose or at an animation frame's pose (v3); `--clear` binds at the setup pose again |
| `ik <project> --bone B [--one-bone] [--bend positive\|negative] --out p2` | no | adds 2-bone (or 1-bone) IK ending at B with a target at its tip; the bend side follows the setup elbow unless `--bend` is given |
| `constrain <project> --bone B --out p2` + one of `--copy-rotation SRC [--factor 0.5] [--offset 0] [--mitre k:max]` · `--aim deg\|hold [--relative-to bone]`, and `[--name n] [--mix 1]` | no | adds a transform constraint (file becomes v3) |

Authoring commands validate the result with the editor's reader before writing and
never modify their input file unless `--out` names it.

### Options shared by the rendering commands (`render`, `mix`, `media`, `sequence`; `lottie` takes `[frame]` too)

| Option | Meaning |
|---|---|
| `--frame fit` | default: each export is cropped to its own animation's bounds plus `--padding` |
| `--frame project` | the project's fixed frame (editor: Project ▸ Frame); exit 1 if the project has none. Art outside the frame is clipped with a warning on stderr and in the JSON `warnings` |
| `--frame x,y,width,height` | an explicit fixed frame in world units (width and height ≥ 1) |
| `--frame-from other.rig.json` | the frame saved in another project, e.g. to render two versions of a character pixel-aligned; not together with `--frame` |
| `--max-frames N` | raises the 2000-frame cap for this run (1–20000) |
| `--max-megapixels M` | raises the 600-megapixel total-size cap (sum of all frame pixels; 1–6000). The per-frame caps (8192 px per side, 40 megapixels) stay. Values beyond the ceilings exit 2 |
| `--profile-dir DIR` | puts the headless browser's profile in a fresh `rigsmith-profile-*` folder inside DIR, removed when the command ends (also `RIGSMITH_PROFILE_DIR`); without it the profile is `.hermes/browser-profiles/cli` in the checkout |

Raised caps hold every frame in memory: about 4 bytes per pixel before the ZIP or
encoder, so 6000 megapixels needs tens of gigabytes. The editor's export dialogs always
use the defaults.

### Limb weights (`weights --along`)

One continuous limb image bends as a round tube. With `s` = distance along the upper
bone from its origin (setup pose) and `q` = signed distance across it, the upper bone
hands over to the lower over `smoothstep(L−B, L+B, s)` (L = upper length), where the
half-width B runs from `outer` to `inner` across the image (`inner` on the side the
joint folds toward: bone +y for `--side 1`, −y for `--side -1`). A `--helper` bone takes
`4t(1−t)` on the joint line. `--end` hands up to `max` of the tip to another bone
(wrist), `--root` keeps the top on a body bone (shoulder/hip). `--mirror-from` copies a
twin mesh's weights vertex for vertex (same grid), renaming bones containing the
`--swap` text. `--smooth N` runs N Laplacian passes over the triangle graph (each moves a
vertex `--smooth-amount`, default 0.5, toward its neighbours' average; at most 4
influences kept). The editor has the same controls under Mesh ▸ Limb weights (Tip follows /
Top stays on for `--end` / `--root`; each Smooth click is one pass at 0.5).

## How rendering works

`withRenderer` (API) starts headless **Chrome for Testing** (path from `RIGSMITH_CFT`,
default: the machine's CfT 155 build) with a profile under
`.hermes/browser-profiles/cli` (or a throw-away folder under `--profile-dir` /
`RIGSMITH_PROFILE_DIR`), serves the built `dist/` through request interception
(origin `http://rigsmith.invalid`; no port is opened and every other request is refused)
and loads `render.html`, a dedicated render entry that holds no editor state. It renders
with the same code as the editor's export dialogs and returns PNG frames one by one; the
browser is closed in a `finally`, including on errors and Ctrl+C. Run `npm run build`
first.

## API (scripts/lib/rigsmith-api.ts)

`readProject(file)`, `writeProject(file, p)`, `summary(p)`, `addImage(p, file, name?)`,
`replaceImage(p, imageName, file, allowResize?)`, `setSkin(p, name, entries, keyed?)`,
`setMix(p, from, to, duration | null)`, `runtime(p)`, `atlas(p, options)`,
`withRenderer(async (r) => r.render(p, request, {onProgress, isCancelled}))`,
`sequenceZip(result)`, `zip(entries)`, `writeOutput(file, data)`. Errors are `ApiError`
with `errors[]` and an exit `code`.

## Brand pipeline example

`npm run example:brand [-- outDir]` (default `.hermes/assets/roadmap-demos/brand-pipeline`)
— see `examples/brand-pipeline/README.md`. It draws original procedural mascot art in a
base palette and three brand palettes (`brands.json`), builds the rig with the model API,
then only uses CLI commands: `add-image` ×15, `skin` ×3, `set-mix`, `validate`,
`runtime`, `atlas`, and per palette `render` (wave) + `mix` (idle → wave) + `media` (wave.gif, and wave.webm when ffmpeg exists). It writes `manifest.json` (sha256 per output);
`tests/cli/cli.test.ts` runs it twice and requires identical manifests — reproducible
on this Chrome for Testing build (other Chrome builds may encode PNG bytes differently).

## Verified by

`npm test` (`tests/unit/bind-pose.test.ts`): `bind` (at a frame, at setup, clear) equals the
model's `bindMesh`; `ik --bend negative` writes the side with name-derived ids; usage errors
exit 2, invalid requests exit 1, nothing written on failure.

`npm test` (`tests/unit/blend-tint.test.ts`): `tint` and `vertex-alpha` as subprocesses —
blend + setup tint, a keyed tint and a radial fade equal the model functions; usage errors
exit 2, invalid requests exit 1. `npm run test:e2e` (`tests/e2e/r4-color.e2e.test.ts`):
every blend mode, a tint, interpolated tint keys and vertex alpha render within 2/255 of the
independent reference compositor.

`npm test` (`tests/unit/transform-constraints.test.ts`): `constrain` as a subprocess — a mitred
half-angle helper and a held aim written as v3 exactly as requested; usage errors exit 2,
invalid requests exit 1, nothing written on failure.

`npm test` (`tests/unit/limb-weights.test.ts`): `mesh` / `weights` as subprocesses — the
limb → mirror → smooth chain equals the model functions exactly; usage errors exit 2,
invalid requests exit 1, nothing written on failure; the limb formula is recomputed
independently per vertex.


`npm run test:cli` (`tests/cli/cli.test.ts`): exit codes and JSON for valid/invalid/
missing/unknown inputs; runtime = model export = editor UI export (identical bytes);
atlas deterministic, reconstructs every image, equals the editor's atlas metadata and
pixels; render (plain, and skin + sub-range + 24 fps + scale 1.5) and mix ZIPs
byte-identical to the editor UI exports; unknown animation/skin, scale and capacity
limits, inverted range → exit 1 with nothing written; missing Chrome → exit 3; Ctrl+C
mid-render → exit 4, no output, no browser left running; `lottie` (subset export, refusal
exit 1); `media` WebM/MP4 decoded by ffmpeg vs the PNG sequence (alpha_mode 1, measured
error bounds, deterministic bytes), missing ffmpeg exit 3, Ctrl+C during the ffmpeg phase
exit 4 with nothing left behind, also after the last frame was piped (stand-in encoder); `set-sequence` + `sequence` (RV-009: saved list, invalid step lists and unknown sequence → exit 1 with nothing written, ZIP byte-identical to the Sequences dialog export) (GIF/APNG CLI vs editor are checked in
`tests/e2e/p4-media.e2e.test.ts`); authoring commands; the brand
pipeline twice with identical manifests and recoloured-but-identical silhouettes.
