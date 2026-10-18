"""Independent decoder for exported animated media (Pillow; not Rigsmith code).

usage: python3 -I tests/support/media_decode.py <file.apng|file.gif> <out-dir>

Writes <out-dir>/frame_NNNN.rgba (raw straight RGBA, composited by Pillow according to
the file's own disposal/blend rules) and prints a JSON summary on stdout: format, size,
frame count, per-frame duration (ms) and the loop count Pillow reports.
"""
import json
import os
import sys

from PIL import Image, ImageSequence


def main() -> None:
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    im = Image.open(src)
    durations = []
    for i, fr in enumerate(ImageSequence.Iterator(im)):
        durations.append(fr.info.get("duration"))
        with open(os.path.join(out, "frame_%04d.rgba" % i), "wb") as f:
            f.write(fr.convert("RGBA").tobytes())
    info = {
        "format": im.format,
        "width": im.size[0],
        "height": im.size[1],
        "frames": len(durations),
        "durations": durations,
        # APNG: 'loop' = num_plays (0 = forever). GIF: 'loop' present only with NETSCAPE2.0.
        "loop": im.info.get("loop"),
        "pillow": Image.__version__ if hasattr(Image, "__version__") else __import__("PIL").__version__,
    }
    print(json.dumps(info))


if __name__ == "__main__":
    main()
