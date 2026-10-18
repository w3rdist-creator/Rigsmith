# Animated media export

The **PNG sequence (ZIP)** is still the reference output and the reliable path for alpha.
Each animated format below is built from those same PNG frames: same frame count, same
endpoint policy, same canvas, same timing. Every shipped codec is decoded in tests by
tools that are not Rigsmith code. Where to find each format:
- Editor: **Export sequence…** → **Format** (`seq-format`).
- CLI: `rigsmith media`, see `docs/cli.md`.

| Format | Where | Codec / container | Alpha | Timing / loop | Needs |
|---|---|---|---|---|---|
| PNG sequence (ZIP) | editor, CLI `render` | PNG per frame + `sequence.json` | full 8-bit, lossless | `sequence.json` | nothing |
| APNG (`.apng`) | editor, CLI | PNG frames (`acTL`/`fcTL`/`fdAT`), dispose NONE, blend SOURCE | full 8-bit, lossless (the PNG frames exactly) | exactly 1/fps per frame; plays forever for looping animations, once for one-shots | nothing |
| GIF (`.gif`) | editor, CLI | GIF89a, one 256-colour global palette, LZW | **1-bit**: α ≥ 128 → opaque, else transparent. Soft edges lose their blend; the count of affected pixels is reported | whole centiseconds, accumulated so the total is exact to 1 cs (30 fps → 3/4/3 cs); at most 50 fps; NETSCAPE loop only for looping animations | nothing |
| WebM (`.webm`) | CLI only | VP9 `yuva420p` (lossy), `alpha_mode 1` | 8-bit alpha, lossy | constant fps; WebM has no loop flag (the player decides) | local `ffmpeg` with `libvpx-vp9` |
| MP4 (`.mp4`) | CLI only | H.264 `yuv420p` (lossy) | **none**: composited on `--background` (default white) | constant fps; no loop flag | local `ffmpeg` with `libx264` |

GIF palette: if all frames together use 255 colours or fewer, those exact colours are
kept. Otherwise the palette comes from a median cut over a 15-bit histogram, with
nearest-colour mapping and no dithering. MP4 frames are padded with the background colour
to even width and height (x264 needs both even), so they can be 1 px larger than the PNG
frames. WebM and MP4 use single-threaded, bitexact ffmpeg settings: two runs on this
machine gave identical bytes. Other ffmpeg/libvpx/x264 builds may give other bytes.

## Verification (this machine; numbers from the test reports)

- Unit tests (`tests/unit/media.test.ts`), decoded by Pillow and checked with ffprobe:
  - APNG frames are byte-equal to the input, with the right delay and play count.
  - GIF: alpha is binary at 128 on every pixel; the alpha-loss counts equal an independent
    count; an exact palette keeps colours exact.
  - GIF, synthetic worst case (three independent gradients): colour error mean 4.41, max 40.
  - LZW holds across many table resets (exact decode of 300×300 noise).
  - Determinism, cancel, mixed frame sizes, the fps cap.
- Browser tests (`tests/e2e/p4-media.e2e.test.ts`), through the dialog:
  - APNG: Pillow frames identical to the PNG sequence (30/30). Chrome for Testing's
    `ImageDecoder` reads 30 frames, repetition ∞, max channel difference 0.
  - GIF, rig `wave`:
    - Alpha binary at 128 on every pixel; colour mean error 1.66.
    - Alpha loss: 39 524 of 2 260 500 px had partial alpha. The status reports this, and
      it matches the test's own count.
    - Chrome's `ImageDecoder` frames are identical to Pillow's.
  - CLI GIF is byte-identical to the dialog's GIF. CLI APNG decodes to the same pixels;
    its bytes may differ because Node's and Chrome's zlib differ.
  - Range errors: GIF above 50 fps; over-capacity frames.
  - Cancel during rendering (APNG) and during encoding (GIF) saves nothing.
  - Large export: 50 frames at 539×541 for both formats, decoded.
- CLI tests (`tests/cli/cli.test.ts`), decoded by ffmpeg:
  - WebM: `vp9`, `alpha_mode 1`, 30 frames at 30/1. Against the PNG sequence: alpha mean
    error 0.066 (max 35), opaque colour mean error 2.64.
  - WebM decoder pitfall: ffmpeg's native vp9 decoder drops alpha. Decode with
    `-c:v libvpx-vp9` placed before `-i`. Also, ffprobe reports `pix_fmt yuv420p` even
    for alpha files; the `alpha_mode` tag is the reliable signal.
  - MP4: `h264`, 274×276 from 274×275 frames. Against a straight-alpha composite: colour
    mean error 2.26 on white, 1.77 on #203040.
  - Missing ffmpeg → exit 3. Ctrl+C in the ffmpeg phase → exit 4, no output, ffmpeg stopped.

## Not claimed

- No player or platform support beyond the decoders named above: Pillow 12.3, this
  machine's ffmpeg, headless Chrome for Testing 155 `ImageDecoder` for APNG and GIF, and
  headless Chrome for Testing 155 `<video>` for WebM alpha (seeked and played frames
  match the PNG-sequence alpha; tests/e2e/p4-media). WebM in other browsers, MP4 in a
  browser, Safari/iOS behaviour and social-platform upload handling were not tested.
- Absent: HEVC with alpha, ProRes 4444, animated WebP, WebM/MP4 from inside the editor
  (the browser build has no muxer), audio.
