"""The Wiz prep script's speck rule, verbatim (scripts/wiz/prepare_cutouts.py), on any PNG.

usage: python3 -I tests/support/specks_reference.py <in.png> <faint_below> <solid_above> <distance> <out.mask>
Writes one byte per pixel (1 = speck) and prints the count.
"""
import sys

import numpy as np
from PIL import Image, ImageFilter

src, faint, solid_a, dist, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
img = np.array(Image.open(src).convert('RGBA')).astype(np.float32)
A = img[..., 3]
solid = Image.fromarray(((A > solid_a) * 255).astype(np.uint8), 'L').filter(ImageFilter.MaxFilter(2 * dist + 1))
specks = (A > 0) & (A < faint) & (np.array(solid) == 0)
open(out, 'wb').write(specks.astype(np.uint8).tobytes())
print(int(specks.sum()))
