// Mesh renderer checks against the independent reference rasterizer
// (tests/support/reference-composite.ts). Fixture projects are written to disk, opened
// with the visible Open… button and rendered through the real sequence exporter.
// Verified on headless Chrome for Testing's software raster path only.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import type { MeshFixture } from '../support/mesh-fixtures.ts';
import { meshProject } from '../support/mesh-fixtures.ts';
import { decodePng } from '../support/png-decode.ts';
import { composite, decodeProjectImages, diffImages, interiorAlpha } from '../support/reference-composite.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/p3-render');
mkdirSync(OUT, { recursive: true });

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let base: string;
const pageErrors: string[] = [];
const report: string[] = [];

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  base = `http://127.0.0.1:${port}/`;
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-p3-render');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(base);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
});

after(async () => {
  writeFileSync(path.join(OUT, 'report.txt'), report.join('\n') + '\n');
  await ctx?.close();
  server?.kill();
});

/** Opens the fixture with Open…, exports frame `frame` via the sequence exporter, returns render + reference. */
async function render(f: MeshFixture, frame: number) {
  const file = path.join(OUT, `${f.name}.rig.json`);
  writeFileSync(file, JSON.stringify(meshProject(f)));
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('open-project').click();
  await (await chooser).setFiles(file);
  await page.waitForFunction((n) => (window as any).__rigsmith.project().name === n, f.name);
  await page.getByTestId('export-sequence').click();
  for (const id of ['seq-start', 'seq-end']) {
    await page.getByTestId(id).fill(String(frame));
    await page.getByTestId(id).press('Enter');
  }
  const dl = page.waitForEvent('download');
  await page.getByTestId('seq-export').click();
  const zip = path.join(OUT, `${f.name}-f${frame}.zip`);
  await (await dl).saveAs(zip);
  await page.keyboard.press('Escape');
  const files = readZip(readFileSync(zip));
  const meta = JSON.parse(files.find((x) => x.name.endsWith('sequence.json'))!.data.toString('utf8'));
  const got = decodePng(files.find((x) => x.name.endsWith('.png'))!.data);
  writeFileSync(path.join(OUT, `${f.name}-f${frame}.png`), files.find((x) => x.name.endsWith('.png'))!.data);
  const p = await probe<any>(page, 'project');
  const ref = composite(p, p.animations[0], frame / 30, decodeProjectImages(p), meta.width, meta.height, meta.origin.x, meta.origin.y, meta.scale);
  return { got, ref };
}

function check(name: string, got: any, ref: any, interior?: { target: number; tol: number }, budget = { over: 0.01, mean: 1.5 }) {
  const d = diffImages(got, ref, 24);
  const line = [`${name}: max ${d.maxDiff} mean ${d.meanDiff.toFixed(3)} over24 ${d.over}/${d.covered}`];
  let ia;
  if (interior) {
    ia = interiorAlpha(got, ref, interior.target, interior.tol);
    line.push(`interior α target ${interior.target}±${interior.tol}: ${ia.n} px, min ${ia.min} max ${ia.max}, off ${ia.bad}`);
  }
  report.push(line.join(' | '));
  assert.ok(d.over <= d.covered * budget.over && d.meanDiff < budget.mean, `${name} reference diff ${JSON.stringify(d)}`);
  if (ia) {
    assert.ok(ia.n > 500, `${name}: enough interior pixels (${ia.n})`);
    assert.equal(ia.bad, 0, `${name}: no seam cracks/doubling (min ${ia.min} max ${ia.max})`);
  }
}

const tilted = { x: 30, y: 20, rotation: 17, scaleX: 1.3, scaleY: 1.3 };

describe('mesh rendering vs the independent reference', () => {
  it('opaque art, rotated and scaled grid mesh: no seams', async () => {
    const { got, ref } = await render({ name: 'opaque', root: tilted }, 0);
    check('opaque', got, ref, { target: 255, tol: 2 });
  });

  it('translucent art (α 128): seams neither crack nor double', async () => {
    const { got, ref } = await render({ name: 'translucent', root: tilted, alpha: 128 }, 0);
    check('translucent', got, ref, { target: 128, tol: 2 });
  });

  it('attachment opacity 0.5 over opaque art is applied once', async () => {
    const { got, ref } = await render({ name: 'opacity', root: tilted, opacity: 0.5 }, 0);
    check('opacity', got, ref, { target: 128, tol: 2 });
  });

  it('weighted two-bone bend on translucent art', async () => {
    const { got, ref } = await render({ name: 'bend', root: tilted, alpha: 160, weighted: true, cols: 10, tipRotate: 50 }, 1);
    check('bend', got, ref, { target: 160, tol: 2 });
  });

  it('mirrored parent (scaleX −1) keeps the exact seam path', async () => {
    const { got, ref } = await render({ name: 'mirrored', root: { ...tilted, scaleX: -1.3 }, alpha: 128, weighted: true, cols: 10, tipRotate: 30 }, 1);
    check('mirrored', got, ref, { target: 128, tol: 2 });
  });

  it('folded mesh (a vertex dragged across its neighbours) renders in triangle order', async () => {
    // Interior vertex (col 2, row 1) pushed 50 px right, over the next two columns.
    const { got, ref } = await render({ name: 'fold', root: tilted, deform: (m) => m.points.map((_, i) => (i === 2 * m.hull + 2 ? 50 : 0)) }, 1);
    check('fold', got, ref, undefined, { over: 0.03, mean: 3 });
  });

  it('degenerate triangle (a vertex collapsed onto its neighbour) draws nothing extra', async () => {
    // Interior vertex (col 1, row 1) moved onto (col 2, row 1): its triangles collapse.
    const { got, ref } = await render({ name: 'degenerate', root: tilted, deform: (m) => m.points.map((_, i) => (i === 2 * m.hull ? 20 : 0)) }, 1);
    check('degenerate', got, ref, undefined, { over: 0.03, mean: 3 });
  });

  it('image key to a 2× image keeps the geometry and scales texture coordinates', async () => {
    // Scale 2.6 magnifies the 2× texture too: minified hard alpha edges are filtered
    // differently by Canvas2D (one bilinear tap) and the reference (16 taps), which
    // would hide what this checks — the texture-coordinate scaling.
    const big = { ...tilted, scaleX: 2.6, scaleY: 2.6 };
    const a = await render({ name: 'swap', root: big, swapTo2x: true }, 0);
    const b = await render({ name: 'swap', root: big, swapTo2x: true }, 1);
    check('swap-f1', b.got, b.ref, { target: 255, tol: 2 });
    assert.deepEqual([b.got.width, b.got.height], [a.got.width, a.got.height], 'same frame size');
    // Geometry unchanged: the half-alpha silhouettes of frame 0 (1× art) and frame 1 (2×)
    // agree (colours differ slightly: nearest-upscaled art has sharper edges).
    let differ = 0, inside = 0;
    for (let i = 3; i < a.got.data.length; i += 4) {
      const p0 = a.got.data[i] >= 128, p1 = b.got.data[i] >= 128;
      if (p0) inside++;
      if (p0 !== p1) differ++;
    }
    report.push(`swap silhouette f1 vs f0: ${differ} of ${inside} px differ`);
    assert.ok(differ <= inside * 0.005, `same silhouette (${differ}/${inside})`);
  });

  it('raised no uncaught page errors', () => {
    assert.deepEqual(pageErrors, []);
  });
});
