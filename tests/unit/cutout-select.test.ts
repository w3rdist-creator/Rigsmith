// Colour selection (flood fill / threshold), mask cuts and speck removal — the Wiz-prep
// steps as editor tools. Checked against a BFS written here, brute-force windows, and
// the prep script's own speck rule run through Pillow (tests/support/specks_reference.py).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Rgba } from '../../src/model/cutout.ts';
import { DEFAULT_SPECKS, cutOutMask, dilateMask, findSpecks, maskBounds, patchBehindMask, removeSpecks, selectColour } from '../../src/model/cutout.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { encodePng } from '../support/png-encode.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, '.hermes/evidence/roadmap/unit-cutout-select');
mkdirSync(OUT, { recursive: true });

/** Two same-coloured blobs (not touching), a near colour, a gradient, faint specks. */
function art(): Rgba {
  const w = 60, h = 40;
  const d = new Uint8ClampedArray(w * h * 4);
  const put = (x: number, y: number, c: number[]) => d.set(c, (y * w + x) * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (x >= 4 && x < 16 && y >= 4 && y < 20) put(x, y, [200, 40, 40, 255]); // blob A
      else if (x >= 30 && x < 40 && y >= 4 && y < 12) put(x, y, [205, 45, 38, 255]); // blob B, within tol 8 of A
      else if (x >= 16 && x < 18 && y >= 8 && y < 12) put(x, y, [230, 40, 40, 255]); // touches A, outside tol 8
      else if (y >= 25 && y < 35 && x >= 4 && x < 56) put(x, y, [x * 4, 120, 60, 255]); // gradient band
    }
  // Faint pixels: some near solid art (kept), some far (specks).
  for (const [x, y, a] of [[18, 22, 60], [50, 15, 40], [55, 2, 90], [2, 38, 99], [21, 4, 100], [45, 18, 30]]) put(x, y, [10, 10, 10, a]);
  return { width: w, height: h, data: d };
}

function bfs(src: Rgba, sx: number, sy: number, tol: number, minA: number): Set<number> {
  const at = (i: number) => [...src.data.subarray(i * 4, i * 4 + 4)];
  const seed = at(sy * src.width + sx);
  const okc = (i: number) => {
    const c = at(i);
    return c[3] > minA && [0, 1, 2].every((k) => Math.abs(c[k] - seed[k]) <= tol);
  };
  const seen = new Set<number>([sy * src.width + sx]);
  const q = [sy * src.width + sx];
  while (q.length) {
    const i = q.shift()!;
    const x = i % src.width, y = Math.floor(i / src.width);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= src.width || Y >= src.height) continue;
      const j = Y * src.width + X;
      if (!seen.has(j) && okc(j)) (seen.add(j), q.push(j));
    }
  }
  return seen;
}

const ids = (m: { data: Uint8Array }) => new Set([...m.data.keys()].filter((i) => m.data[i]));

describe('colour selection (wand)', () => {
  it('contiguous = the 4-connected region (independent BFS); non-contiguous = every pixel in the colour box', () => {
    const src = art();
    for (const tol of [0, 8, 40]) {
      const m = selectColour(src, 6, 6, { tolerance: tol, minAlpha: 0, contiguous: true });
      assert.deepEqual(ids(m), bfs(src, 6, 6, tol, 0), `tol ${tol}`);
      assert.equal(m.count, ids(m).size);
    }
    assert.equal(selectColour(src, 6, 6, { tolerance: 8, minAlpha: 0, contiguous: true }).count, 12 * 16, 'blob A only');
    assert.equal(selectColour(src, 6, 6, { tolerance: 8, minAlpha: 0, contiguous: false }).count, 12 * 16 + 10 * 8, 'A + B (not touching)');
    assert.equal(selectColour(src, 6, 6, { tolerance: 40, minAlpha: 0, contiguous: true }).count, 12 * 16 + 8, 'A + the touching near colour');
    assert.deepEqual(maskBounds(selectColour(src, 6, 6, { tolerance: 8, minAlpha: 0, contiguous: true })), { x: 4, y: 4, width: 12, height: 16 });
  });

  it('min alpha excludes faint pixels; a transparent seed selects nothing', () => {
    const src = art();
    assert.equal(selectColour(src, 0, 0, { tolerance: 255, minAlpha: 0, contiguous: false }).count, 0);
    const all = selectColour(src, 18, 22, { tolerance: 255, minAlpha: 0, contiguous: false }).count;
    const solid = selectColour(src, 6, 6, { tolerance: 255, minAlpha: 200, contiguous: false }).count;
    assert.equal(all - solid, 6, 'the six faint pixels');
  });
});

describe('mask cut', () => {
  it('overlap 0: piece + remainder = source exactly; overlap grows by a disc; patch capped by the source alpha', () => {
    const src = art();
    const m = selectColour(src, 6, 6, { tolerance: 8, minAlpha: 0, contiguous: true });
    const r = cutOutMask(src, m, 0);
    assert.deepEqual([r.offsetX, r.offsetY, r.piece.width, r.piece.height, r.holePixels], [4, 4, 12, 16, 192]);
    for (let y = 0; y < src.height; y++)
      for (let x = 0; x < src.width; x++) {
        const s = (y * src.width + x) * 4;
        const inP = x >= r.offsetX && y >= r.offsetY && x < r.offsetX + r.piece.width && y < r.offsetY + r.piece.height;
        const pa = inP ? r.piece.data[((y - r.offsetY) * r.piece.width + x - r.offsetX) * 4 + 3] : 0;
        assert.equal(pa + r.remainder.data[s + 3], src.data[s + 3], `alpha at ${x},${y}`);
      }
    const g = dilateMask(m, 2);
    for (let i = 0; i < g.data.length; i++) {
      const x = i % m.width, y = Math.floor(i / m.width);
      let want = 0;
      for (let j = 0; j < m.data.length && !want; j++) if (m.data[j] && ((j % m.width) - x) ** 2 + (Math.floor(j / m.width) - y) ** 2 <= 4) want = 1;
      assert.equal(g.data[i], want, `dilate ${x},${y}`);
    }
    const r2 = cutOutMask(src, m, 2);
    assert.equal(r2.piece.width, 12 + 2, 'grows into the touching near-colour pixels only (the rest is transparent)');
    const p = patchBehindMask(r.remainder, m, [90, 90, 90], src);
    assert.equal(p.synthesized, 192);
    for (let i = 0; i < m.data.length; i++) assert.equal(p.image.data[i * 4 + 3], src.data[i * 4 + 3]);
  });
});

describe('speck removal', () => {
  it('equals the Wiz prep script rule run through Pillow (MaxFilter), for default and other parameters', () => {
    const src = art();
    const png = path.join(OUT, 'art.png');
    writeFileSync(png, encodePng(src.width, src.height, new Uint8Array(src.data)));
    for (const o of [DEFAULT_SPECKS, { faintBelow: 50, solidAbove: 100, distance: 2 }, { faintBelow: 255, solidAbove: 250, distance: 0 }]) {
      const m = findSpecks(src, o);
      const out = path.join(OUT, `ref-${o.faintBelow}-${o.solidAbove}-${o.distance}.mask`);
      const r = spawnSync('python3', ['-I', path.join(ROOT, 'tests/support/specks_reference.py'), png, String(o.faintBelow), String(o.solidAbove), String(o.distance), out], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(m.count, Number(r.stdout.trim()));
      assert.deepEqual([...m.data], [...readFileSync(out)], JSON.stringify(o));
    }
    const d = removeSpecks(src, DEFAULT_SPECKS);
    // Specks: (50,15), (55,2), (45,18) — 7 px from the nearest solid pixel. Kept: (18,22) and
    // (2,38) are within 6 px of solid art; α 100 at (21,4) is not faint.
    assert.equal(d.removed, 3);
    assert.equal(d.image.data[(38 * 60 + 2) * 4 + 3], 99);
    assert.equal(d.image.data[(15 * 60 + 50) * 4 + 3], 0);
    assert.equal(d.image.data[(22 * 60 + 18) * 4 + 3], 60);
    assert.equal(src.data[(15 * 60 + 50) * 4 + 3], 40, 'source untouched');
  });

  it("format: 'cleanup' provenance round-trips; an unknown kind is rejected", () => {
    const p = { format: 'rigsmith.project', version: 2, name: 'c', bones: [], attachments: [], animations: [], images: [{ id: 'a', name: 'a.png', mime: 'image/png', width: 1, height: 1, dataUrl: 'data:image/png;base64,' + encodePng(1, 1, new Uint8Array([0, 0, 0, 255])).toString('base64') }, { id: 'b', name: 'a-clean.png', mime: 'image/png', width: 1, height: 1, dataUrl: 'data:image/png;base64,' + encodePng(1, 1, new Uint8Array([0, 0, 0, 255])).toString('base64'), derived: { kind: 'cleanup', sourceId: 'a', offsetX: 0, offsetY: 0, synthesized: 0, note: '3 speck px removed' } }] };
    const r = parseProject(JSON.stringify(p));
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    assert.equal(parseProject(serializeProject(r.project)).ok, true);
    (p.images[1] as any).derived.kind = 'magic';
    assert.equal(parseProject(JSON.stringify(p)).ok, false);
  });
});
