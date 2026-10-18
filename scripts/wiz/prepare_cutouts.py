#!/usr/bin/env python3
"""Deterministic cutouts of the Wiz master art for the Rigsmith acceptance test.

    python3 -I scripts/wiz/prepare_cutouts.py <wiz_master.png> <out_dir> [masks.json]

The source is a single flattened illustration whose alpha channel already holds a
character matte (background alpha = 0). Parts are separated from that matte with the
cut parameters in masks.json (source-pixel coordinates):

* limb axes come from a PCA of the stick-orange pixels inside each limb's axisBox;
* each arm/leg stick is cut per column along the line where its orange paint starts
  (sleeve rim / bun bottom) and, for arms, where it ends (glove cuff);
* hidden overlap at the joints is synthesized by sweeping one clean cross-section of
  the same stick along its axis (topExtension / bottomExtension px). These pixels sit
  under the sleeve, bun or glove at rest; they are the only invented pixels besides
  the flat sleeve-interior patch;
* gloves are the connected matte region past the cuff (flood fill from handSeed);
* legs include their shoe (matte inside footBox);
* body = matte minus every limb, glove, leg and shoe pixel.

Visible pixels are copied from the source unchanged (no resampling, no recolouring).
Outputs: one even-sized transparent PNG per part, manifest.json (geometry, pivots,
hashes) and review images under <out_dir>/review/. The source file is only read.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    src_path = Path(sys.argv[1])
    out = Path(sys.argv[2])
    cfg_path = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(__file__).with_name('masks.json')
    cfg = json.loads(cfg_path.read_text())
    src_hash = sha256(src_path)
    if src_hash != cfg['sourceSha256']:
        sys.exit(f'source sha256 {src_hash} does not match masks.json {cfg["sourceSha256"]}')
    out.mkdir(parents=True, exist_ok=True)
    (out / 'review').mkdir(exist_ok=True)

    img = np.array(Image.open(src_path).convert('RGBA')).astype(np.float32)
    H, W = img.shape[:2]
    R, G, B, A = (img[..., i] for i in range(4))
    so, sc = cfg['stickOrange'], cfg['stickColour']
    orange = (R > so['rMin']) & (G > so['gMin']) & (G < so['gMax']) & (B < so['bMax']) & (A > so['aMin'])
    stick_col = (R - B > sc['rMinusBMin']) & (R > sc['rMin']) & (G > sc['gMin']) & (B < sc['bMax']) & (A > sc['aMin'])
    # The supplied matte carries a few faint isolated specks (alpha < 100) away from the
    # character; drop those that are not within 6 px of solid matte.
    solid = Image.fromarray(((A > 200) * 255).astype(np.uint8), 'L').filter(ImageFilter.MaxFilter(13))
    specks = (A > 0) & (A < 100) & (np.array(solid) == 0)
    img[specks] = 0
    A = img[..., 3]
    matte = A > 0
    Y, X = np.mgrid[0:H, 0:W].astype(np.float32)

    def at(arr, x, y):
        xi, yi = int(round(x)), int(round(y))
        return arr[yi, xi] if 0 <= xi < W and 0 <= yi < H else 0

    def bilinear(xs, ys):
        """RGBA bilinear sample of the source at float coords (arrays)."""
        x0 = np.clip(np.floor(xs).astype(int), 0, W - 2)
        y0 = np.clip(np.floor(ys).astype(int), 0, H - 2)
        fx = np.clip(xs - x0, 0, 1)[..., None]
        fy = np.clip(ys - y0, 0, 1)[..., None]
        p00, p10, p01, p11 = img[y0, x0], img[y0, x0 + 1], img[y0 + 1, x0], img[y0 + 1, x0 + 1]
        return (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy

    def limb_frame(box):
        x0, y0, x1, y1 = box
        ys, xs = np.nonzero(orange[y0:y1, x0:x1])
        xs, ys = xs + x0, ys + y0
        c = np.array([xs.mean(), ys.mean()])
        M = np.stack([xs - c[0], ys - c[1]], 1)
        _, v = np.linalg.eigh(M.T @ M)
        d = v[:, 1] if v[1, 1] > 0 else -v[:, 1]  # point "down the limb"
        p = np.array([-d[1], d[0]])
        pt = lambda s, t: c + s * d + t * p
        # Half widths (stick incl. outline) from the alpha matte on mid-stick rows.
        pos, neg = [], []
        for s in range(0, 41, 2):
            for sgn, lst in ((1, pos), (-1, neg)):
                t = 0.0
                while at(A, *pt(s, sgn * t)) > 128 and t < 80:
                    t += 0.25
                lst.append(t)
        tpos, tneg = float(np.median(pos)), float(np.median(neg))
        hw = max(tpos, tneg)
        clean = lambda s: at(A, *pt(s, hw + 4)) < 30 and at(A, *pt(s, -(hw + 4))) < 30
        smin = 0
        while clean(smin - 1) and smin > -250:
            smin -= 1
        smax = 0
        while clean(smax + 1) and smax < 300:
            smax += 1
        S = (X - c[0]) * d[0] + (Y - c[1]) * d[1]
        T = (X - c[0]) * p[0] + (Y - c[1]) * p[1]
        return dict(c=c, d=d, p=p, pt=pt, tpos=tpos, tneg=tneg, smin=smin, smax=smax, S=S, T=T)

    def column_ends(f, direction, start):
        """Per integer t column: last s (walking from `start` in `direction`) still stick-coloured.
        Outline columns (no paint at s=start) take the value of the nearest painted column."""
        ts = np.arange(-int(np.ceil(f['tneg'])) - 2, int(np.ceil(f['tpos'])) + 3)
        vals = np.full(len(ts), np.nan)
        for i, t in enumerate(ts):
            if not at(stick_col, *f['pt'](start, t)):
                continue
            s = start
            while at(stick_col, *f['pt'](s + direction, t)) and abs(s) < 300:
                s += direction
            vals[i] = s
        core = ~np.isnan(vals)
        idx = np.arange(len(ts))
        vals = np.interp(idx, idx[core], vals[core])
        return ts, vals

    def band_mask(f, pad=0.0):
        return (f['T'] >= -f['tneg'] - pad) & (f['T'] <= f['tpos'] + pad)

    def sweep(f, s_ref, region):
        """Fill `region` by sweeping the cross-section at s_ref along the axis."""
        T = f['T'][region]
        q = f['c'][None, :] + s_ref * f['d'][None, :] + T[:, None] * f['p'][None, :]
        return bilinear(q[:, 0], q[:, 1])

    layers = {}  # name -> float RGBA full-canvas arrays
    taken = np.zeros((H, W), bool)  # pixels removed from the body
    manifest = {'source': {'path': str(src_path), 'sha256': src_hash, 'width': W, 'height': H}, 'limbs': {}, 'parts': {}}

    def empty():
        return np.zeros((H, W, 4), np.float32)

    for arm in cfg['arms']:
        f = limb_frame(arm['axisBox'])
        ts, s_top = column_ends(f, -1, f['smin'] + 2)
        _, s_bot = column_ends(f, +1, f['smax'] - 2)
        top_at = np.interp(f['T'], ts, s_top)
        bot_at = np.interp(f['T'], ts, s_bot)
        band = band_mask(f)
        # Pad the band by 3 px where the stick is clean (only background beside it) so its
        # anti-aliased outline edge leaves the body completely.
        wide = band_mask(f, 3.0) & (f['S'] > f['smin']) & (f['S'] < f['smax'])
        # Faint (alpha < 16) fringe within 10 px of the clean stick goes with the stick too.
        faint = band_mask(f, 10.0) & (A < 16) & (f['S'] > f['smin']) & (f['S'] < f['smax'])
        genuine = (band | wide | faint) & matte & (f['S'] >= top_at) & (f['S'] <= bot_at)
        s_top_c, s_bot_c = float(np.interp(0, ts, s_top)), float(np.interp(0, ts, s_bot))
        # Synthesize only under fully opaque cover, so nothing hidden shows through the
        # anti-aliased edges of the sleeve / glove at rest.
        covered = (A >= 250) & ~genuine
        syn_top = band & covered & (f['S'] < top_at) & (f['S'] >= s_top_c - arm['topExtension'])
        syn_bot = band & covered & (f['S'] > bot_at) & (f['S'] <= s_bot_c + arm['bottomExtension'])
        s_mid = (f['smin'] + f['smax']) / 2
        L = empty()
        L[genuine] = img[genuine]
        # The top extension continues the stick's own sleeve-shadowed paint: sample the
        # first row that lies below the cut for every painted column.
        hw_min = min(f['tpos'], f['tneg'])
        s_shadow = float(s_top[np.abs(ts) <= 0.6 * hw_min].max()) + 3
        L[syn_top] = sweep(f, s_shadow, syn_top)
        L[syn_bot] = sweep(f, s_mid, syn_bot)
        layers[arm['name']] = L
        taken |= genuine

        # Glove: connected matte region past the cuff, excluding the stick itself.
        hx0, hy0, hx1, hy1 = arm['handBox']
        cand = matte & ~genuine & ~(band & (f['S'] <= bot_at)) & (f['S'] > f['smax'] - 30)
        box = np.zeros_like(cand)
        box[hy0:hy1, hx0:hx1] = True
        cand &= box
        # .copy(): ImageDraw.floodfill does not write into an array-backed image.
        cimg = Image.fromarray((cand * 255).astype(np.uint8), 'L').copy()
        ImageDraw.floodfill(cimg, tuple(arm['handSeed']), 128)
        glove = np.array(cimg) == 128
        Gl = empty()
        Gl[glove] = img[glove]
        layers[arm['hand']] = Gl
        taken |= glove

        # Sleeve-interior patch behind the arm: only where the sleeve flanks the stick, so
        # a rotated arm reveals the inside of the sleeve instead of a see-through gap.
        ring = (~band_mask(f, 2.0)) & band_mask(f, 14.0) & (f['S'] >= s_top_c) & (f['S'] <= f['smin']) & matte
        lum = (R + G + B) / 3
        ring_px = img[ring & (lum > 90) & (lum < 215)][:, :3]
        interior = (np.median(ring_px, 0) * 0.6) if len(ring_px) else np.array([90, 70, 75])
        hole = band_mask(f, 1.0) & (f['S'] >= top_at - 3) & (f['S'] <= f['smin'] + 2) & (A >= 250)
        # Only rows where sleeve paint flanks the stick on BOTH sides (inside the opening),
        # so the patch never extends past the sleeve rim.
        hy, hx = np.nonzero(hole)
        hs = f['S'][hy, hx]
        hw_max = max(f['tpos'], f['tneg']) + 4
        def opaque_at(tt):
            q = f['c'][None, :] + hs[:, None] * f['d'][None, :] + tt * f['p'][None, :]
            qx = np.clip(np.round(q[:, 0]).astype(int), 0, W - 1)
            qy = np.clip(np.round(q[:, 1]).astype(int), 0, H - 1)
            return A[qy, qx] >= 250
        inside = opaque_at(hw_max) & opaque_at(-hw_max)
        hole[hy[~inside], hx[~inside]] = False
        Ho = empty()
        Ho[hole, :3] = interior
        Ho[hole, 3] = 255
        layers[arm['hole']] = Ho

        manifest['limbs'][arm['name']] = {
            'axisCentre': f['c'].round(3).tolist(), 'axisDir': f['d'].round(5).tolist(),
            'axisAngleDeg': round(float(np.degrees(np.arctan2(f['d'][1], f['d'][0]))), 3),
            'halfWidth': [f['tneg'], f['tpos']], 'cleanRange': [f['smin'], f['smax']],
            'sTopCentre': s_top_c, 'sBottomCentre': s_bot_c,
            'pivot': f['pt'](s_top_c - 4, 0).round(2).tolist(),
            'wrist': f['pt'](s_bot_c + 12, 0).round(2).tolist(),
            'sleeveInteriorRGB': [round(float(v)) for v in interior],
            'syntheticPx': int(syn_top.sum() + syn_bot.sum()), 'holePx': int(hole.sum()), 'topExtensionSampleRow': s_shadow,
        }

    for leg in cfg['legs']:
        f = limb_frame(leg['axisBox'])
        ts, s_top = column_ends(f, -1, f['smin'] + 2)
        top_at = np.interp(f['T'], ts, s_top)
        band = band_mask(f)
        s_top_c = float(np.interp(0, ts, s_top))
        faint = band_mask(f, 10.0) & (A < 16)
        genuine = (band_mask(f, 3.0) | faint) & matte & (f['S'] >= top_at) & (f['S'] <= f['smax'] + 12)
        fx0, fy0, fx1, fy1 = leg['footBox']
        foot = np.zeros_like(matte)
        foot[fy0:fy1, fx0:fx1] = True
        foot &= matte & (f['S'] > f['smax'] - 15)
        syn_top = band & (A >= 250) & ~genuine & (f['S'] < top_at) & (f['S'] >= s_top_c - leg['topExtension'])
        L = empty()
        L[genuine | foot] = img[genuine | foot]
        L[syn_top] = sweep(f, (f['smin'] + f['smax']) / 2, syn_top)
        layers[leg['name']] = L
        taken |= genuine | foot
        manifest['limbs'][leg['name']] = {
            'axisCentre': f['c'].round(3).tolist(), 'axisDir': f['d'].round(5).tolist(),
            'axisAngleDeg': round(float(np.degrees(np.arctan2(f['d'][1], f['d'][0]))), 3),
            'halfWidth': [f['tneg'], f['tpos']], 'cleanRange': [f['smin'], f['smax']],
            'sTopCentre': s_top_c, 'pivot': f['pt'](s_top_c - 4, 0).round(2).tolist(),
            'syntheticPx': int(syn_top.sum()),
        }

    keep = matte & ~taken
    residual = {}
    for name in [a['name'] for a in cfg['arms']] + [l['name'] for l in cfg['legs']]:
        box = [a for a in cfg['arms'] + cfg['legs'] if a['name'] == name][0]['axisBox']
        f = limb_frame(box)
        near = band_mask(f, 8.0) & (f['S'] > f['smin'] + 2) & (f['S'] < f['smax'] - 2)
        residual[name] = int((keep & near).sum())
    manifest['bodyPixelsBesideCleanSticks'] = residual
    manifest['droppedSpecks'] = int(specks.sum())
    body = empty()
    body[keep] = img[keep]
    layers['body'] = body

    # ---- write even-sized crops -------------------------------------------------------
    for name in cfg['drawOrder']:
        L = layers[name]
        L[L[..., 3] <= 0] = 0
        ys, xs = np.nonzero(L[..., 3] > 0)
        x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
        if (x1 - x0) % 2:
            x1 = x1 + 1 if x1 < W else x1
            x0 = x0 - 1 if (x1 - x0) % 2 else x0
        if (y1 - y0) % 2:
            y1 = y1 + 1 if y1 < H else y1
            y0 = y0 - 1 if (y1 - y0) % 2 else y0
        crop = np.clip(np.round(L[y0:y1, x0:x1]), 0, 255).astype(np.uint8)
        path = out / f'{name}.png'
        Image.fromarray(crop, 'RGBA').save(path, optimize=True)
        manifest['parts'][name] = {
            'file': path.name, 'sha256': sha256(path), 'bbox': [x0, y0, x1 - x0, y1 - y0],
            'centre': [x0 + (x1 - x0) / 2, y0 + (y1 - y0) / 2], 'opaquePx': int((crop[..., 3] > 0).sum()),
        }

    legs = manifest['limbs']
    hip = (np.array(legs['leg_l']['pivot']) + np.array(legs['leg_r']['pivot'])) / 2
    manifest['rigPoints'] = {
        'hip': hip.round(2).tolist(),
        'ground': [float(round(hip[0], 2)), float(np.nonzero(matte.any(1))[0].max())],
    }
    manifest['drawOrder'] = cfg['drawOrder']

    # ---- review images + reassembly check -----------------------------------------------
    bgc = np.array([40, 140, 90, 255], np.float32)

    def over(dst, src):
        a = src[..., 3:4] / 255
        dst[..., :3] = src[..., :3] * a + dst[..., :3] * (1 - a)
        return dst

    ref = over(np.tile(bgc, (H, W, 1)), img.copy())
    comp = np.tile(bgc, (H, W, 1))
    for name in cfg['drawOrder']:
        P = manifest['parts'][name]
        x0, y0, w, h = P['bbox']
        L = np.zeros((H, W, 4), np.float32)
        L[y0:y0 + h, x0:x0 + w] = np.array(Image.open(out / P['file'])).astype(np.float32)
        comp = over(comp, L)
    diff = np.abs(comp[..., :3] - ref[..., :3]).max(-1)
    manifest['reassembly'] = {
        'maxAbsDiff': float(diff.max()), 'meanAbsDiff': round(float(diff.mean()), 4),
        'pxOver8': int((diff > 8).sum()), 'pxOver32': int((diff > 32).sum()),
    }
    Image.fromarray(np.clip(diff * 4, 0, 255).astype(np.uint8), 'L').save(out / 'review' / 'reassembly-diff-x4.png')
    Image.fromarray(comp.astype(np.uint8), 'RGBA').save(out / 'review' / 'reassembly.png')

    tints = {'body': (255, 255, 255), 'arm_l': (255, 60, 60), 'arm_r': (255, 60, 60), 'hand_l': (60, 120, 255), 'hand_r': (60, 120, 255),
             'leg_l': (255, 200, 0), 'leg_r': (255, 200, 0), 'sleeve_hole_l': (200, 0, 200), 'sleeve_hole_r': (200, 0, 200)}
    seg = np.tile(np.array([20, 20, 24, 255], np.float32), (H, W, 1))
    for name in cfg['drawOrder']:
        a = (layers[name][..., 3:4] / 255) * 0.55
        seg[..., :3] = np.array(tints[name], np.float32) * a + seg[..., :3] * (1 - a)
    seg = over(seg, np.concatenate([img[..., :3], img[..., 3:4] * 0.45], -1))
    Image.fromarray(seg.astype(np.uint8), 'RGBA').save(out / 'review' / 'segmentation-overlay.png')

    # Exploded view: each part on its own tile.
    tiles = []
    for name in cfg['drawOrder']:
        im = Image.open(out / f'{name}.png')
        t = Image.new('RGBA', (im.width + 20, im.height + 20), (40, 140, 90, 255))
        t.alpha_composite(im, (10, 10))
        tiles.append(t)
    sheet = Image.new('RGBA', (sum(t.width for t in tiles) + 10 * len(tiles), max(t.height for t in tiles)), (20, 20, 24, 255))
    x = 0
    for t in tiles:
        sheet.alpha_composite(t, (x, 0))
        x += t.width + 10
    sheet.save(out / 'review' / 'exploded.png')

    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps({'parts': {k: v['bbox'] for k, v in manifest['parts'].items()}, 'reassembly': manifest['reassembly'],
                      'bodyPixelsBesideCleanSticks': residual, 'droppedSpecks': manifest['droppedSpecks']}))


if __name__ == '__main__':
    main()
