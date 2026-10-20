// R11 browser checks: a pupil clipped to its eye from the visible control (Clip to),
// exported frames compared with the independent reference compositor (which restates the
// mask as "the attachment alone × the mask image's alpha"), the pupil darting across the
// socket without ever leaving it, a hidden mask still clipping, and undo.
// window.__rigsmith is read-only (assertions).
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { setKey } from '../../src/model/animation.ts';
import { serializeProject } from '../../src/model/format.ts';
import { makeBone } from '../../src/model/ops.ts';
import type { Project } from '../../src/model/types.ts';
import { emptyProject, emptyTrack } from '../../src/model/types.ts';
import { decodePng } from '../support/png-decode.ts';
import { encodePng } from '../support/png-encode.ts';
import { composite, decodeProjectImages, diffImages } from '../support/reference-composite.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/r11-masks');
mkdirSync(OUT, { recursive: true });

// Original procedural art: a skin backdrop, an eye white (soft-edged ellipse) and a pupil.
function png(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]): string {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(f(x + 0.5, y + 0.5), (y * w + x) * 4);
  return `data:image/png;base64,${encodePng(w, h, px).toString('base64')}`;
}
const ellipse = (w: number, h: number, x: number, y: number) => Math.min(1, Math.max(0, ((1 - Math.hypot((x - w / 2) / (w / 2), (y - h / 2) / (h / 2))) * (w / 2)) / 3));
function rig(): Project {
  const p = emptyProject('eye');
  p.version = 3;
  p.bones.push(makeBone('root', 'root', null, 0, 0, 0, 20), makeBone('pupil', 'pupil', 'root', 0, 0, 0, 10));
  p.images.push(
    { id: 'i_skin', name: 'skin.png', mime: 'image/png', width: 160, height: 110, dataUrl: png(160, 110, (x, y) => [200 - Math.round(x / 4), 140, 90 + Math.round(y / 3), 255]) },
    { id: 'i_white', name: 'white.png', mime: 'image/png', width: 90, height: 60, dataUrl: png(90, 60, (x, y) => [245, 245, 240, Math.round(255 * ellipse(90, 60, x, y))]) },
    { id: 'i_pupil', name: 'pupil.png', mime: 'image/png', width: 40, height: 40, dataUrl: png(40, 40, (x, y) => [30, 40 + Math.round(x), 90, Math.round(255 * ellipse(40, 40, x, y))]) },
  );
  const att = (id: string, boneId: string, imageId: string) => ({ id, name: id, boneId, imageId, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
  p.attachments.push(att('skin', 'root', 'i_skin'), att('white', 'root', 'i_white'), att('pupil', 'pupil', 'i_pupil'));
  const dart = { id: 'dart', name: 'dart', duration: 1, fps: 30, loop: true, tracks: { pupil: emptyTrack() } };
  // Darts are stepped (eyes jump), on whole pixels so exports and the reference resample alike.
  for (const [f, x, y] of [[0, 0, 0], [8, 42, -6], [15, 0, 14], [22, -45, 0]]) setKey(dart.tracks.pupil.translate, f / 30, [x, y], 'step');
  p.animations.push(dart);
  return p;
}
const RIG = path.join(OUT, 'eye.rig.json');
writeFileSync(RIG, serializeProject(rig()));

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const report: string[] = [];
const project = () => probe<any>(page, 'project');

async function setField(testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function exportFrame(frame: number, file: string) {
  await page.getByTestId('export-sequence').click();
  for (const id of ['seq-start', 'seq-end']) await setField(id, frame);
  const dl = page.waitForEvent('download');
  await page.getByTestId('seq-export').click();
  const zip = path.join(OUT, file);
  await (await dl).saveAs(zip);
  await page.keyboard.press('Escape');
  const files = readZip(readFileSync(zip));
  return { meta: JSON.parse(files.find((x) => x.name.endsWith('sequence.json'))!.data.toString('utf8')), png: decodePng(files.find((x) => x.name.endsWith('.png'))!.data) };
}

/** Exports frame f, compares with the reference; returns the pupil-coloured pixels outside the eye white. */
async function check(frame: number, label: string) {
  const { meta, png: got } = await exportFrame(frame, `${label}.zip`);
  const p = await project();
  const ref = composite(p, p.animations[0], frame / 30, decodeProjectImages(p), meta.width, meta.height, meta.origin.x, meta.origin.y, meta.scale);
  const d = diffImages(got, ref, 3);
  // Outside the eye white (skin only there): a pupil pixel is dark blue.
  let leaks = 0;
  for (let y = 0; y < meta.height; y++)
    for (let x = 0; x < meta.width; x++) {
      const wx = (x + 0.5) / meta.scale + meta.origin.x, wy = (y + 0.5) / meta.scale + meta.origin.y;
      if (Math.hypot(wx / 45, wy / 30) < 1.05) continue;
      const i = (y * meta.width + x) * 4;
      if (got.data[i + 3] && got.data[i] < 120) leaks++;
    }
  report.push(`${label}: vs reference max ${d.maxDiff.toFixed(1)} mean ${d.meanDiff.toFixed(3)}; pupil pixels outside the eye ${leaks}`);
  return { d, leaks };
}

before(async () => {
  const port = await pickPort([47652, 47653, 47654]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-r11-masks');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
  await page.getByTestId('open-input').setInputFiles(RIG);
  await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length > 0);
});

after(async () => {
  writeFileSync(path.join(OUT, 'report.txt'), report.join('\n') + '\n');
  await ctx?.close();
  server?.kill();
});

describe('clipping masks (R11)', () => {
  it('unclipped, the darting pupil leaves the eye (the fixture exercises the mask)', async () => {
    const { d, leaks } = await check(8, 'unclipped-f8');
    assert.ok(d.maxDiff <= 2, JSON.stringify(d));
    assert.ok(leaks > 100, `pupil outside the eye: ${leaks}`);
  });

  it('Clip to: the pupil stays inside the eye on every sampled frame; matches the reference within 2/255', async () => {
    if ((await probe<any>(page, 'state')).mode !== 'setup') await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-att-pupil').click();
    await page.getByTestId('att-clip').selectOption({ label: 'white' });
    assert.equal((await project()).attachments.find((a: any) => a.name === 'pupil').clip, 'white');
    for (const f of [0, 8, 15, 22]) {
      const { d, leaks } = await check(f, `clipped-f${f}`);
      assert.ok(d.maxDiff <= 2 && d.meanDiff < 0.5, `frame ${f}: ${JSON.stringify(d)}`);
      assert.equal(leaks, 0, `frame ${f}: no pupil pixel outside the eye`);
    }
  });

  it('a hidden mask still clips; a mask cannot be clipped; undo removes the clip', async () => {
    if ((await probe<any>(page, 'state')).mode !== 'setup') await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-att-white').click();
    await page.getByTestId('att-hidden').check();
    const { d, leaks } = await check(8, 'hidden-mask-f8');
    assert.ok(d.maxDiff <= 2, JSON.stringify(d));
    assert.equal(leaks, 0);
    // A sequence export leaves Setup.
    await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-att-white').click();
    await page.getByTestId('att-hidden').uncheck();
    await page.getByTestId('att-clip').selectOption({ label: 'skin' });
    assert.equal((await project()).attachments.find((a: any) => a.name === 'white').clip, undefined);
    assert.match((await page.getByTestId('status').textContent()) ?? '', /masks are one level deep/);
    await page.getByTestId('tree-att-pupil').click();
    await page.getByTestId('att-clip').selectOption({ label: '— none' });
    assert.equal((await project()).attachments.find((a: any) => a.name === 'pupil').clip, undefined);
    await page.getByTestId('undo').click();
    assert.equal((await project()).attachments.find((a: any) => a.name === 'pupil').clip, 'white');
    assert.deepEqual(pageErrors, []);
  });
});
