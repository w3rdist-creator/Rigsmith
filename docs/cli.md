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
| `add-image <project> --file x.png [--name n] --out p2` | no | adds a PNG (id derived from the name — reproducible) |
| `replace-image <project> --image n --file x.png [--allow-resize] --out p2` | no | swaps pixels keeping the id (attachments, keys and skins follow); a size change needs `--allow-resize` |
| `skin <project> --name S [--set att=image …] [--keyed att:fromImage=image …] --out p2` | no | creates/extends a skin (setup-image and keyed-image entries) |
| `set-mix <project> --from A --to B --duration S\|none --out p2` | no | stores or removes a mix rule |

Authoring commands validate the result with the editor's reader before writing and
never modify their input file unless `--out` names it.

## How rendering works

`withRenderer` (API) starts headless **Chrome for Testing** (path from `RIGSMITH_CFT`,
default: the machine's CfT 155 build) with a profile under
`.hermes/browser-profiles/cli`, serves the built `dist/` through request interception
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
`runtime`, `atlas`, and per palette `render` (wave) + `mix` (idle → wave). It writes `manifest.json` (sha256 per output);
`tests/cli/cli.test.ts` runs it twice and requires identical manifests — reproducible
on this Chrome for Testing build (other Chrome builds may encode PNG bytes differently).

## Verified by

`npm run test:cli` (`tests/cli/cli.test.ts`): exit codes and JSON for valid/invalid/
missing/unknown inputs; runtime = model export = editor UI export (identical bytes);
atlas deterministic, reconstructs every image, equals the editor's atlas metadata and
pixels; render (plain, and skin + sub-range + 24 fps + scale 1.5) and mix ZIPs
byte-identical to the editor UI exports; unknown animation/skin, scale and capacity
limits, inverted range → exit 1 with nothing written; missing Chrome → exit 3; Ctrl+C
mid-render → exit 4, no output, no browser left running; authoring commands; the brand
pipeline twice with identical manifests and recoloured-but-identical silhouettes.
