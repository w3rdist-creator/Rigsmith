"""Contact sheet built only from PNG-sequence ZIPs that Rigsmith's Export sequence…
dialog produced (no re-rendering here).

usage: python3 -I scripts/roadmap/contact_sheet.py <out.png> <label=seq.zip> [<label=seq.zip> ...]
       [--frames 0,4,8,...]

One row per ZIP at the same frame numbers, over a checkerboard so the exported alpha
is visible. Writes <out>.json with the frame list and per-frame alpha statistics.
"""
import io
import json
import sys
import zipfile

from PIL import Image, ImageDraw

DEFAULT_FRAMES = [0, 4, 8, 12, 16, 18, 22, 26, 30, 36, 48, 60]
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


def main(out, rows_spec, frame_list):
    rows = []
    for spec in rows_spec:
        label, path = spec.split("=", 1)
        rows.append((label, path, *frames(path)))
    sheet = Image.new("RGBA", (CELL * len(frame_list), (CELL + LABEL) * len(rows) + LABEL), (255, 255, 255, 255))
    d = ImageDraw.Draw(sheet)
    stats = {}
    for r, (title, _path, imgs, meta) in enumerate(rows):
        y0 = r * (CELL + LABEL) + LABEL
        d.text((4, y0 - LABEL + 4), f"{title} - {meta['width']}x{meta['height']} @ {meta['fps']} fps, {len(imgs)} frames", fill=(0, 0, 0, 255))
        stats[title] = []
        for c, f in enumerate(frame_list):
            img = imgs[f % len(imgs)]
            hist = img.getchannel("A").histogram()
            stats[title].append({"frame": f, "opaque": hist[255], "translucent": sum(hist[1:255]), "transparent": hist[0]})
            cell = checker(CELL, CELL)
            t = fit(img)
            cell.alpha_composite(t, ((CELL - t.width) // 2, (CELL - t.height) // 2))
            sheet.paste(cell, (c * CELL, y0))
            d.text((c * CELL + 4, y0 + 4), f"f{f}", fill=(0, 0, 0, 255))
    d.text((4, sheet.height - LABEL + 4), "Frames copied from the exported sequence ZIPs; checkerboard shows exported alpha.", fill=(60, 60, 60, 255))
    sheet.convert("RGB").save(out)
    with open(out.rsplit(".", 1)[0] + ".json", "w") as fh:
        json.dump({"frames": frame_list, "sources": [r[1] for r in rows], "alpha": stats}, fh, indent=1)
    print(f"wrote {out} ({sheet.width}x{sheet.height})")


if __name__ == "__main__":
    args = sys.argv[1:]
    frame_list = DEFAULT_FRAMES
    if "--frames" in args:
        i = args.index("--frames")
        frame_list = [int(x) for x in args[i + 1].split(",")]
        del args[i:i + 2]
    if len(args) < 2 or any("=" not in a for a in args[1:]):
        sys.exit(__doc__)
    main(args[0], args[1:], frame_list)
