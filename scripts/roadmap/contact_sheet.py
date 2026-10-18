"""Old/new greeting contact sheet built only from the PNG-sequence ZIPs that
Rigsmith's Export sequence… dialog produced (no re-rendering here).

usage: python3 -I scripts/roadmap/contact_sheet.py <v1.zip> <v2.zip> <out.png>

Rows: v1 greeting (top) and v2 greeting (bottom) at the same frames, over a
checkerboard so the exported alpha is visible. Writes <out>.json with the
frame list and per-frame alpha statistics.
"""
import io
import json
import sys
import zipfile

from PIL import Image, ImageDraw

FRAMES = [0, 4, 8, 12, 16, 18, 22, 26, 30, 36, 48, 60]
CELL = 180
LABEL = 22


def frames(zpath):
    with zipfile.ZipFile(zpath) as z:
        names = sorted(n for n in z.namelist() if n.endswith(".png"))
        meta = json.loads(z.read(next(n for n in z.namelist() if n.endswith("sequence.json"))))
        return [Image.open(io.BytesIO(z.read(n))).convert("RGBA") for n in names], meta


def checker(w, h, s=10):
    im = Image.new("RGBA", (w, h), (236, 236, 236, 255))
    d = ImageDraw.Draw(im)
    for y in range(0, h, s):
        for x in range(0, w, s):
            if (x // s + y // s) % 2:
                d.rectangle([x, y, x + s - 1, y + s - 1], fill=(206, 206, 206, 255))
    return im


def fit(img):
    k = min(CELL / img.width, CELL / img.height)
    return img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)


def main(v1zip, v2zip, out):
    rows = [("greeting (original, unchanged)", *frames(v1zip)), ("greeting-v2 (curves, anticipation, overshoot, follow-through)", *frames(v2zip))]
    sheet = Image.new("RGBA", (CELL * len(FRAMES), (CELL + LABEL) * len(rows) + LABEL), (255, 255, 255, 255))
    d = ImageDraw.Draw(sheet)
    stats = {}
    for r, (title, imgs, meta) in enumerate(rows):
        y0 = r * (CELL + LABEL) + LABEL
        d.text((4, y0 - LABEL + 4), f"{title} - {meta['width']}x{meta['height']} @ {meta['fps']} fps", fill=(0, 0, 0, 255))
        stats[title] = []
        for c, f in enumerate(FRAMES):
            img = imgs[f % len(imgs)]
            a = img.getchannel("A")
            hist = a.histogram()
            stats[title].append({"frame": f, "opaque": hist[255], "translucent": sum(hist[1:255]), "transparent": hist[0]})
            cell = checker(CELL, CELL)
            t = fit(img)
            cell.alpha_composite(t, ((CELL - t.width) // 2, (CELL - t.height) // 2))
            sheet.paste(cell, (c * CELL, y0))
            d.text((c * CELL + 4, y0 + 4), f"f{f}", fill=(0, 0, 0, 255))
    d.text((4, sheet.height - LABEL + 4), "Frames copied from the exported sequence ZIPs; checkerboard shows exported alpha.", fill=(60, 60, 60, 255))
    sheet.convert("RGB").save(out)
    with open(out.rsplit(".", 1)[0] + ".json", "w") as fh:
        json.dump({"frames": FRAMES, "sources": [v1zip, v2zip], "alpha": stats}, fh, indent=1)
    print(f"wrote {out} ({sheet.width}x{sheet.height})")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
