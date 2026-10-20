// R5 browser checks: Mesh ▸ Bind pose. A weighted band is bound at an animation frame's
// pose (then it renders as the undistorted image in that pose) and at the setup pose
// (then setup edits bend it); clear goes back to binding at the setup pose. Exports are
// compared with the independent reference skinning (tests/support/reference-composite.ts).
// Visible controls only; window.__rigsmith is read-only (assertions).
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { ART_H, ART_MARGIN, ART_W, bandArt } from '../support/mesh-fixtures.ts';
import { decodePng } from '../support/png-decode.ts';
import { encodePng } from '../support/png-encode.ts';
import { composite, decodeProjectImages, diffImages } from '../support/reference-composite.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/r5-bind');
mkdirSync(path.join(OUT, 'art'), { recursive: true });
const BAND = path.join(OUT, 'art/band.png');
writeFileSync(BAND, encodePng(ART_W, ART_H, bandArt(ART_W, ART_H, ART_MARGIN)));

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let base: string;
const pageErrors: string[] = [];
const report: string[] = [];
type Pt = { x: number; y: number };

const state = () => probe<any>(page, 'state');
const project = () => probe<any>(page, 'project');
const band = async () => (await project()).attachments.find((a: any) => a.name === 'band');
const verts = () => probe<Pt[]>(page, 'mesh', 'band');

async function setField(testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function gotoFrame(frame: number): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  const anim = (await project()).animations[0];
  const frames = Math.round(anim.duration * anim.fps);
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
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

async function checkFrame(frame: number, label: string) {
  const { meta, png } = await exportFrame(frame, `${label}.zip`);
  const p = await project();
  const ref = composite(p, p.animations[0], frame / 30, decodeProjectImages(p), meta.width, meta.height, meta.origin.x, meta.origin.y, meta.scale);
  const d = diffImages(png, ref, 24);
  report.push(`${label}: vs reference max ${d.maxDiff.toFixed(1)} mean ${d.meanDiff.toFixed(3)} >24: ${d.over}/${d.covered}`);
  assert.ok(d.over <= d.covered * 0.01 && d.meanDiff < 1.5, `${label} matches the reference: ${JSON.stringify(d)}`);
}

/** Pairwise distances between mesh vertices (screen px): equal ⇔ the mesh is the undistorted image. */
const shape = (v: Pt[]) => v.flatMap((a, i) => v.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.y - b.y)));
const maxDiff = (a: number[], b: number[]) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));

before(async () => {
  const port = await pickPort([47634, 47635, 47636]);
  base = `http://127.0.0.1:${port}/`;
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-r5-bind');
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

describe('R5 bind pose', () => {
  let flat: number[] = [];
  it('builds a weighted two-bone band and an animation that bends it', async () => {
    await page.getByTestId('image-input').setInputFiles([BAND]);
    await page.getByTestId('image-band.png').waitFor();
    await page.getByTestId('add-bone').click();
    await setField('bone-name', 'upper');
    await setField('bone-rotation', 0);
    await setField('bone-length', 60);
    await page.getByTestId('add-bone').click();
    await setField('bone-name', 'lower');
    await setField('bone-length', 60);
    await page.getByTestId('tree-bone-upper').click();
    await page.getByTestId('attach-band.png').click();
    await setField('att-x', 60);
    await page.getByTestId('mesh-create').click();
    await setField('mesh-grid-cols', 6);
    await setField('mesh-grid-rows', 2);
    await page.getByTestId('mesh-grid').click();
    await page.getByTestId('mesh-apply').click();
    await page.getByTestId('mesh-dialog').waitFor({ state: 'hidden' });
    await page.getByTestId('weights-auto').click();
    flat = shape(await verts());
    assert.equal(await page.getByTestId('mesh-bind-summary').innerText(), 'Bound at the setup pose');
    await page.getByTestId('new-animation').click();
    await page.getByTestId('mode-animate').click();
    await gotoFrame(0);
    await page.getByTestId('tree-bone-lower').click();
    await setField('bone-rotation', 50);
    assert.ok(maxDiff(shape(await verts()), flat) > 5, 'the animation bends the band');
  });

  it('Bind at frame: the band is the undistorted image at that frame and bends at the setup pose instead', async () => {
    await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-att-band').click();
    await page.getByTestId('mesh-bind-anim').selectOption({ index: 0 });
    await setField('mesh-bind-frame', 0);
    const u0 = (await state()).undo;
    await page.getByTestId('mesh-bind-at-frame').click();
    assert.equal((await state()).undo, u0 + 1, 'one undo step');
    assert.equal(await page.getByTestId('mesh-bind-summary').innerText(), 'Own bind pose · 2 bones');
    const setupShape = shape(await verts());
    assert.ok(maxDiff(setupShape, flat) > 5, 'at the straight setup pose the curled-bound band is bent');
    await checkFrame(0, 'bound-at-f0-frame0');
    await page.getByTestId('mode-animate').click();
    await gotoFrame(0);
    const d = maxDiff(shape(await verts()), flat);
    report.push(`bound at frame 0: shape error at frame 0 ${d.toFixed(4)} px`);
    assert.ok(d < 0.01, `in the bind pose the band is undistorted (${d})`);
  });

  it('Bind at setup, then a setup bend bends the band (L7); Clear bind restores the default; undo', async () => {
    await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-att-band').click();
    await page.getByTestId('mesh-bind').click();
    assert.equal(await page.getByTestId('mesh-bind-summary').innerText(), 'Own bind pose · 2 bones');
    assert.ok(maxDiff(shape(await verts()), flat) < 0.01, 'bound at the setup pose: undistorted there');
    await page.getByTestId('tree-bone-lower').click();
    await setField('bone-rotation', -30);
    const bent = maxDiff(shape(await verts()), flat);
    report.push(`bound at setup, then setup lower −30°: shape change ${bent.toFixed(2)} px`);
    assert.ok(bent > 5, 'the setup bend now bends the band');
    await checkFrame(0, 'bound-setup-bent');
    await page.getByTestId('tree-att-band').click();
    await page.getByTestId('mesh-unbind').click();
    assert.equal(await page.getByTestId('mesh-bind-summary').innerText(), 'Bound at the setup pose');
    assert.equal((await band()).mesh.bind, undefined);
    assert.ok(maxDiff(shape(await verts()), flat) < 0.01, 'unbound: the setup pose shows the image undistorted again');
    await page.keyboard.press('Control+z');
    assert.ok((await band()).mesh.bind, 'undo restores the bind');
  });

  it('raised no uncaught page errors', () => {
    assert.deepEqual(pageErrors, []);
  });
});
