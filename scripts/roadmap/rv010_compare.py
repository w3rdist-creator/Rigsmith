"""RV-010 metrics: dialog-made Wiz pieces vs the prepared pieces, in master coordinates.

Usage: python3 -I rv010_compare.py MASTER PREPARED_DIR RV010_OUT_DIR METRICS_JSON

The metric is defined in scripts/roadmap/rv010-inputs.json ("metric") and was fixed before
the first run: alpha IoU over alpha>0; visible = union of alpha>0; per-pixel max channel
difference of each piece composited on flat RGB 128,128,128; pass when >= 99% of visible
pixels differ by <= 8/255 and IoU >= 0.98; synthesized counts within 25% of the manifest.
PIL + numpy only.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

master_path, prepared, out_dir, metrics_path = map(Path, sys.argv[1:5])
manifest = json.loads((prepared / 'manifest.json').read_text())
W, H = manifest['source']['width'], manifest['source']['height']
made = json.loads((out_dir / 'pieces.json').read_text())
BG = np.array([128, 128, 128], dtype=np.float64)


def place(png: Path, x: int, y: int) -> np.ndarray:
    im = np.asarray(Image.open(png).convert('RGBA'), dtype=np.float64)
    canvas = np.zeros((H, W, 4))
    h, w = im.shape[:2]
    x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
    canvas[y0:y1, x0:x1] = im[y0 - y:y1 - y, x0 - x:x1 - x]
    return canvas


def over_bg(a: np.ndarray) -> np.ndarray:
    al = a[..., 3:4] / 255.0
    return a[..., :3] * al + BG * (1 - al)


def compare(mine: np.ndarray, ref: np.ndarray) -> dict:
    am, ar = mine[..., 3] > 0, ref[..., 3] > 0
    union, inter = am | ar, am & ar
    n = int(union.sum())
    diff = np.abs(over_bg(mine) - over_bg(ref)).max(axis=2)
    within = int((diff[union] <= 8).sum()) if n else 0
    iou = inter.sum() / n if n else 1.0
    return {
        'alphaIoU': round(float(iou), 4),
        'visiblePx': n,
        'onlyMine': int((am & ~ar).sum()),
        'onlyPrepared': int((ar & ~am).sum()),
        'visibleWithin8': round(within / n, 4) if n else 1.0,
        'maxDiff': round(float(diff[union].max()), 1) if n else 0.0,
        'iouPass': bool(iou >= 0.98),
        'diffPass': bool(n and within / n >= 0.99),
    }


rows = []
by_name = {p['name']: p for p in made['pieces']}
for name in manifest['drawOrder']:
    part = manifest['parts'][name]
    ref = place(prepared / part['file'], part['bbox'][0], part['bbox'][1])
    row = {'piece': name}
    limb = manifest['limbs'].get(name, {})
    if name.startswith('sleeve_hole'):
        row.update({'produced': False, 'reason': 'the dialog has no separate patch layer: its patch fills the remainder (measured below as a trial)'})
        row['synthesizedTarget'] = manifest['limbs'][name.replace('sleeve_hole', 'arm')]['holePx']
        rows.append(row)
        continue
    p = by_name.get(name)
    if not p:
        row.update({'produced': False, 'reason': 'missing from the run'})
        rows.append(row)
        continue
    mine = place(out_dir / 'pieces' / f'{name}.png', p['offsetX'], p['offsetY'])
    row.update({'produced': True, 'path': p['path'], 'size': [p['width'], p['height']], 'offset': [p['offsetX'], p['offsetY']]})
    row.update(compare(mine, ref))
    if 'syntheticPx' in limb:
        t = limb['syntheticPx']
        row.update({'synthesized': p['synthesized'], 'synthesizedTarget': t, 'synthesizedPass': bool(abs(p['synthesized'] - t) <= 0.25 * t)})
    rows.append(row)

# Patch trials: where did the flat colour land, vs the prepared sleeve-hole layer?
master = np.asarray(Image.open(master_path).convert('RGBA'), dtype=np.int32)
trials = []
for t in made['trials']:
    side = t['name'][-1]
    rest = np.asarray(Image.open(out_dir / f"trial-{t['name']}-patched-rest.png").convert('RGBA'), dtype=np.int32)
    src = np.asarray(Image.open(out_dir / f"trial-{t['name']}-unpatched-source.png").convert('RGBA'), dtype=np.int32)
    rgb = np.array([int(t['picked'][i:i + 2], 16) for i in (1, 3, 5)])
    region = (rest[..., 3] > 0) & (np.abs(rest[..., :3] - rgb).max(axis=2) == 0) & (np.abs(src[..., :3] - rgb).max(axis=2) > 0)
    part = manifest['parts'][f'sleeve_hole_{side}']
    ref = place(prepared / part['file'], part['bbox'][0], part['bbox'][1])[..., 3] > 0
    n = int((region | ref).sum())
    trials.append({
        'arm': t['name'], 'picked': t['picked'], 'synthesizedReported': t['synthesized'], 'patchRegionPx': int(region.sum()),
        'holeTargetPx': manifest['limbs'][t['name']]['holePx'], 'iouWithSleeveHole': round(float((region & ref).sum() / n), 4) if n else 1.0,
        'patchPxOutsideSleeveHole': int((region & ~ref).sum()),
    })

summary = {'pieces': rows, 'patchTrials': trials, 'clickPrecision': made['precision'], 'metric': 'see scripts/roadmap/rv010-inputs.json "metric"'}
metrics_path.write_text(json.dumps(summary, indent=1) + '\n')
print('piece          IoU     within8  maxDiff  synth (target)        pass')
for r in rows:
    if not r.get('produced'):
        print(f"{r['piece']:<14} not produced: {r['reason']}")
        continue
    syn = f"{r['synthesized']} ({r['synthesizedTarget']})" if 'synthesized' in r else '-'
    ok = r['iouPass'] and r['diffPass'] and r.get('synthesizedPass', True)
    print(f"{r['piece']:<14} {r['alphaIoU']:<7} {r['visibleWithin8']:<8} {r['maxDiff']:<8} {syn:<21} {'PASS' if ok else 'FAIL'}  (only mine {r['onlyMine']}, only prepared {r['onlyPrepared']})")
for t in trials:
    print(f"patch trial {t['arm']}: {t['patchRegionPx']} px flat {t['picked']} (sleeve hole target {t['holeTargetPx']}), IoU with sleeve_hole {t['iouWithSleeveHole']}, {t['patchPxOutsideSleeveHole']} px outside it")
print('click precision: ' + ', '.join(f"{c['name']} {len(c['stored']) // 2}/{len(c['requested'])} vertices" + ('' if c['maxAbsError'] is None else f", max error {c['maxAbsError']:.2f} px") for c in made['precision']))
