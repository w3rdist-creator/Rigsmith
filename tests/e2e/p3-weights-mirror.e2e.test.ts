// Mesh ▸ Limb weights ▸ Mirror weights, through visible controls only: a left limb mesh is
// weighted upper_l → lower_l, a right limb mesh with the same vertex count is mirrored from
// it with the default _l → _r bone swap. The right mesh gets the left weights vertex for
// vertex on the _r bones, in one undo step. window.__rigsmith is read-only (assertions).
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { ART_H, ART_MARGIN, ART_W, bandArt } from '../support/mesh-fixtures.ts';
import { encodePng } from '../support/png-encode.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/p3-weights-mirror');
mkdirSync(path.join(OUT, 'art'), { recursive: true });
const LEFT = path.join(OUT, 'art/band-l.png');
const RIGHT = path.join(OUT, 'art/band-r.png');
const png = encodePng(ART_W, ART_H, bandArt(ART_W, ART_H, ART_MARGIN));
writeFileSync(LEFT, png);
writeFileSync(RIGHT, png);

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const state = () => probe<any>(page, 'state');
const project = () => probe<any>(page, 'project');
const att = async (name: string) => (await project()).attachments.find((a: any) => a.name === name);
const boneId = async (name: string) => (await project()).bones.find((b: any) => b.name === name).id;

async function setField(testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function addBone(name: string): Promise<void> {
  await page.getByTestId('add-bone').click();
  await setField('bone-name', name);
  await setField('bone-rotation', 0);
  await setField('bone-length', 60);
}

/** Attaches the image to the bone and gives it a 6×2 grid mesh (21 vertices). */
async function meshOn(bone: string, image: string): Promise<void> {
  await page.getByTestId(`tree-bone-${bone}`).click();
  await page.getByTestId(`attach-${image}`).click();
  await setField('att-x', 60);
  await page.getByTestId('mesh-create').click();
  await setField('mesh-grid-cols', 6);
  await setField('mesh-grid-rows', 2);
  await page.getByTestId('mesh-grid').click();
  await page.getByTestId('mesh-apply').click();
  await page.getByTestId('mesh-dialog').waitFor({ state: 'hidden' });
}

before(async () => {
  const port = await pickPort([47667, 47668, 47669]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-p3-weights-mirror');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('mirror weights', () => {
  it('Mirror weights copies the left limb’s weights onto the right mesh with _l → _r bones, in one undo step', async () => {
    await page.getByTestId('image-input').setInputFiles([LEFT, RIGHT]);
    await page.getByTestId('image-band-r.png').waitFor();
    for (const b of ['upper_l', 'lower_l', 'upper_r', 'lower_r']) await addBone(b);
    const ids = { ul: await boneId('upper_l'), ll: await boneId('lower_l'), ur: await boneId('upper_r'), lr: await boneId('lower_r') };

    // Left limb: banded upper_l → lower_l weights.
    await meshOn('upper_l', 'band-l.png');
    await page.getByTestId('lw-upper').selectOption({ label: 'upper_l' });
    await page.getByTestId('lw-lower').selectOption({ label: 'lower_l' });
    await page.getByTestId('lw-helper').selectOption('');
    await page.getByTestId('weights-limb').click();
    const left = (await att('band-l')).mesh.weights as { bone: string; w: number }[][];
    assert.equal(left.length, 21);
    assert.ok(left.some((l) => l.some((x) => x.bone === ids.ul)) && left.some((l) => l.some((x) => x.bone === ids.ll)), 'left mesh uses both left bones');
    assert.ok(left.every((l) => l.every((x) => x.bone === ids.ul || x.bone === ids.ll)), 'left mesh uses only left bones');

    // Right limb: same grid, no weights yet. Mirror is off until a source is chosen.
    await meshOn('upper_r', 'band-r.png');
    assert.equal((await att('band-r')).mesh.weights, undefined);
    assert.equal(await page.getByTestId('weights-mirror').isDisabled(), true, 'no source chosen yet');
    assert.deepEqual(await page.getByTestId('wm-source').locator('option').allInnerTexts(), ['—', 'band-l']);
    await page.getByTestId('wm-source').selectOption({ label: 'band-l' });
    assert.equal(await page.getByTestId('wm-swap').inputValue(), '_l=_r');
    const undo0 = (await state()).undo;
    await page.getByTestId('weights-mirror').click();
    assert.equal((await state()).undo, undo0 + 1, 'one undo step');

    const right = (await att('band-r')).mesh.weights as { bone: string; w: number }[][];
    const swap = (b: string) => (b === ids.ul ? ids.ur : b === ids.ll ? ids.lr : b);
    const norm = (w: { bone: string; w: number }[][]) => w.map((l) => l.map((x) => `${x.bone}:${x.w.toFixed(9)}`).sort());
    assert.deepEqual(norm(right), norm(left.map((l) => l.map((x) => ({ bone: swap(x.bone), w: x.w })))), 'vertex-for-vertex left weights on the _r bones');
    assert.deepEqual(norm((await att('band-l')).mesh.weights), norm(left), 'the source is unchanged');

    await page.keyboard.press('Control+z');
    assert.equal((await att('band-r')).mesh.weights, undefined, 'undo removes the mirrored weights');
    assert.deepEqual(pageErrors, []);
  });
});
