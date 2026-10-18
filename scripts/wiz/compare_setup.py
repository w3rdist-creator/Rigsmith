#!/usr/bin/env python3
"""Pixel-diff Rigsmith's setup-pose Export PNG against the source art.

    python3 -I scripts/wiz/compare_setup.py <source.png> <rigsmith-export.png> <prepared/manifest.json> <out-diff.png>

Export PNG renders at zoom 1, cropped to the attachment bounds with an 8 px pad, so the
export's pixel (0,0) is source pixel (minX-8, minY-8) where minX/minY come from the
union of the prepared part boxes. Both images are composited over the same opaque
background before comparing colour.
"""
import json, sys
import numpy as np
from PIL import Image

src = np.array(Image.open(sys.argv[1]).convert('RGBA')).astype(np.float32)
exp = np.array(Image.open(sys.argv[2]).convert('RGBA')).astype(np.float32)
m = json.load(open(sys.argv[3]))
x0 = min(p['bbox'][0] for p in m['parts'].values()) - 8
y0 = min(p['bbox'][1] for p in m['parts'].values()) - 8
H, W = src.shape[:2]
canvas = np.zeros_like(src)
# place export into source frame
ys, xs = max(0, -y0), max(0, -x0)
h = min(exp.shape[0] - ys, H - (y0 + ys)); w = min(exp.shape[1] - xs, W - (x0 + xs))
canvas[y0 + ys:y0 + ys + h, x0 + xs:x0 + xs + w] = exp[ys:ys + h, xs:xs + w]
bg = np.array([40, 140, 90], np.float32)
def comp(a):
    al = a[..., 3:4] / 255
    return a[..., :3] * al + bg * (1 - al)
d = np.abs(comp(canvas) - comp(src)).max(-1)
solid = src[..., 3] > 200
res = {
    'exportSize': [exp.shape[1], exp.shape[0]], 'offsetInSource': [int(x0), int(y0)],
    'maxAbsDiff': float(d.max()), 'meanAbsDiff': round(float(d.mean()), 4),
    'meanAbsDiffOnSolidArt': round(float(d[solid].mean()), 4),
    'pxOver8': int((d > 8).sum()), 'pxOver32': int((d > 32).sum()), 'solidArtPx': int(solid.sum()),
}
Image.fromarray(np.clip(d * 4, 0, 255).astype(np.uint8), 'L').save(sys.argv[4])
print(json.dumps(res))
