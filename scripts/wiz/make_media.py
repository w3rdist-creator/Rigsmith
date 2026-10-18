#!/usr/bin/env python3
"""Encode the Rigsmith-canvas frames captured by capture-preview.ts into preview media.

    python3 -I scripts/wiz/make_media.py <output_dir>

Reads <output_dir>/frames/{idle,greeting}/f###.png (frames 0..N-1 of each loop, straight
from the editor's stage canvas), crops every frame to one shared box around the
character (union of non-background pixels over all frames + margin) and writes:
  wiz-idle.mp4, wiz-greeting.mp4      one clip each, 3 loops, H.264 30 fps
  wiz-preview.mp4 / wiz-preview.webm   idle x2 then greeting x2
  wiz-preview.gif                      same sequence, 480 px tall, 15 fps
  contact-sheet.png                    evenly spaced labelled frames of both animations
Only pixels already rendered by Rigsmith are used (crop + scale; no re-animation).
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

out = Path(sys.argv[1])
anims = ['idle', 'greeting']
frames = {a: sorted((out / 'frames' / a).glob('f*.png')) for a in anims}
bg = np.array([28, 26, 34])  # Rigsmith animate-mode stage colour

union = None
for a in anims:
    for p in frames[a][::3]:
        im = np.array(Image.open(p).convert('RGB')).astype(int)
        mask = np.abs(im - bg).max(-1) > 40
        # Erode so the editor's 1 px world-axis/grid lines don't count as content.
        mask = np.array(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(5))) > 0
        union = mask if union is None else union | mask
ys, xs = np.nonzero(union)
H, W = union.shape
m = 60
x0, y0 = max(0, xs.min() - m), max(0, ys.min() - m)
x1, y1 = min(W, xs.max() + m), min(H, ys.max() + m)
w, h = (x1 - x0) // 2 * 2, (y1 - y0) // 2 * 2
crop = f'crop={w}:{h}:{x0}:{y0}'


def ff(args):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args], check=True)


for a in anims:
    n = len(frames[a])
    ff(['-framerate', '30', '-i', str(out / 'frames' / a / 'f%03d.png'),
        '-vf', f'{crop},loop=loop=2:size={n}:start=0,scale=-2:960:flags=lanczos',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', str(out / f'wiz-{a}.mp4')])

ni, ng = len(frames['idle']), len(frames['greeting'])
seq = (f"[0:v]{crop},loop=loop=1:size={ni}:start=0,setpts=N/30/TB[i];"
       f"[1:v]{crop},loop=loop=1:size={ng}:start=0,setpts=N/30/TB[g];[i][g]concat=n=2:v=1:a=0")
inputs = ['-framerate', '30', '-i', str(out / 'frames/idle/f%03d.png'), '-framerate', '30', '-i', str(out / 'frames/greeting/f%03d.png')]
ff([*inputs, '-filter_complex', seq + ',scale=-2:960:flags=lanczos[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', str(out / 'wiz-preview.mp4')])
ff([*inputs, '-filter_complex', seq + ',scale=-2:960:flags=lanczos[v]', '-map', '[v]', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', '32', '-row-mt', '1', str(out / 'wiz-preview.webm')])
ff([*inputs, '-filter_complex', seq + ',fps=15,scale=-2:480:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=sierra2_4a[v]',
    '-map', '[v]', '-loop', '0', str(out / 'wiz-preview.gif')])

# Contact sheet: 8 idle + 12 greeting frames.
font = ImageFont.load_default(size=26)
rows = []
for a, count in (('idle', 8), ('greeting', 12)):
    fs = frames[a]
    idx = [round(i * len(fs) / count) for i in range(count)]
    tiles = []
    for i in idx:
        im = Image.open(fs[i]).convert('RGB').crop((x0, y0, x0 + w, y0 + h))
        im = im.resize((round(im.width * 360 / im.height), 360), Image.LANCZOS)
        tile = Image.new('RGB', (im.width, 396), (0, 0, 0))
        tile.paste(im, (0, 36))
        ImageDraw.Draw(tile).text((8, 3), f'{a}  f{i}  {i / 30:.2f}s', fill=(255, 220, 120), font=font)
        tiles.append(tile)
    rows.append(tiles)
tw = rows[0][0].width
cols = 6
lines = []
for tiles in rows:
    for k in range(0, len(tiles), cols):
        lines.append(tiles[k:k + cols])
sheet = Image.new('RGB', (cols * tw + (cols + 1) * 8, len(lines) * 404 + 8), (12, 12, 16))
for r, line in enumerate(lines):
    for c, t in enumerate(line):
        sheet.paste(t, (8 + c * (tw + 8), 8 + r * 404))
sheet.save(out / 'contact-sheet.png')

info = {'crop': [int(x0), int(y0), int(w), int(h)], 'frames': {a: len(frames[a]) for a in anims}}
for f in ['wiz-idle.mp4', 'wiz-greeting.mp4', 'wiz-preview.mp4', 'wiz-preview.webm', 'wiz-preview.gif', 'contact-sheet.png']:
    info[f] = (out / f).stat().st_size
(out / 'media-info.json').write_text(json.dumps(info, indent=1))
print(json.dumps(info))
