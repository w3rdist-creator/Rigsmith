// Phase 2 (Wiz-prep parity): colour selection — flood fill / colour threshold, Shift+click
// add — cut as a piece, and speck removal, all from the visible "Cut out piece…" dialog.
// Expected pixels come from the test's own art definition and its own brute-force speck
// rule. Original procedural art. window.__rigsmith is read-only (assertions).
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { decodePng } from '../support/png-decode.ts';
import { encodePng } from '../support/png-encode.ts';
import { diffImages } from '../support/reference-composite.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/p2-pixel-tools');
mkdirSync(OUT, { recursive: true });

// 240×160: glove A (48×64), a touching cuff strip (+50 red), a separate same-colour blob B,
// a gradient band and faint specks (some near solid art, some far).
const W = 240, H = 160;
const A = { x: 16, y: 16, w: 48, h: 64 }, STRIP = { x: 64, y: 32, w: 8, h: 16 }, B = { x: 120, y: 16, w: 40, h: 32 };
const inR = (r: typeof A, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const FAINT: [number, number, number][] = [[80, 90, 60], [200, 70, 40], [230, 5, 90], [10, 150, 99], [70, 20, 100], [180, 64, 30], [100, 110, 20]];
const SRC = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const c = inR(A, x, y) ? [200, 40, 40, 255] : inR(STRIP, x, y) ? [250, 40, 40, 255] : inR(B, x, y) ? [205, 45, 38, 255] : y >= 100 && y < 140 && x >= 16 && x < 224 ? [x, 120, 60, 255] : [0, 0, 0, 0];
    SRC.set(c, (y * W + x) * 4);
  }
for (const [x, y, a] of FAINT) SRC.set([10, 10, 10, a], (y * W + x) * 4);
const ART = path.join(OUT, 'glove-art.png');
writeFileSync(ART, encodePng(W, H, SRC));

/** The prep script's rule, brute force: 0 < α < faint and no α > solid in the (2d+1)² window. */
function specks(img: { width: number; height: number; data: Uint8Array }, faint: number, solid: number, d: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const a = img.data[(y * img.width + x) * 4 + 3];
      if (!(a > 0 && a < faint)) continue;
      let near = false;
      for (let yy = Math.max(0, y - d); yy <= Math.min(img.height - 1, y + d) && !near; yy++)
        for (let xx = Math.max(0, x - d); xx <= Math.min(img.width - 1, x + d) && !near; xx++) near = img.data[(yy * img.width + xx) * 4 + 3] > solid;
      if (!near) out.push(y * img.width + x);
    }
  return out;
}

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const state = () => probe<any>(page, 'state');
const project = () => probe<any>(page, 'project');
const imgOf = (p: any, name: string) => decodePng(Buffer.from(p.images.find((i: any) => i.name === name).dataUrl.split(',')[1], 'base64'));

async function setField(testId: string, v: string | number): Promise<void> {
  await page.getByTestId(testId).fill(String(v));
  await page.getByTestId(testId).press('Enter');
}

async function exportPng(file: string) {
  const dl = page.waitForEvent('download');
  await page.getByTestId('export-png').click();
  const target = path.join(OUT, file);
  await (await dl).saveAs(target);
  return decodePng(readFileSync(target));
}

async function openCutout(): Promise<(x: number, y: number, mods?: ('Shift')[]) => Promise<void>> {
  await page.getByTestId('tree-att-glove-art').click();
  await page.getByTestId('att-cutout').click();
  const canvas = page.getByTestId('cutout-canvas');
  await canvas.waitFor();
  const box = (await canvas.boundingBox())!;
  const s = Number(await canvas.getAttribute('data-scale')), ox = Number(await canvas.getAttribute('data-ox')), oy = Number(await canvas.getAttribute('data-oy'));
  await page.waitForFunction(() => !/Counting/.test(document.querySelector('[data-testid="cut-speck-count"]')?.textContent ?? 'Counting'));
  return async (x, y, mods = []) => {
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.click(box.x + ox + (x + 0.5) * s, box.y + oy + (y + 0.5) * s);
    for (const m of mods) await page.keyboard.up(m);
  };
}

const summary = () => page.getByTestId('cut-summary').innerText();

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-p2-pixel-tools');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
  await page.getByTestId('image-input').setInputFiles(ART);
  await page.getByTestId('image-glove-art.png').waitFor();
  await page.getByTestId('add-bone').click();
  await page.getByTestId('attach-glove-art.png').click();
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('pixel selection and clean-up tools (cutout dialog)', () => {
  it('flood fill selects the glove only; threshold adds the separate blob; Shift+click adds; tolerance reselects', async () => {
    const click = await openCutout();
    await page.getByTestId('cut-mode-wand').click();
    await click(30, 40);
    assert.match(await summary(), /^selection 3072 px · 48×64 px at 16,16 \(flood fill, tolerance 32, α > 0\)/);
    await page.getByTestId('cut-contiguous').uncheck();
    assert.match(await summary(), /^selection 4352 px · 144×64 px at 16,16 \(colour threshold/, 'glove + blob B (not touching)');
    await page.getByTestId('cut-contiguous').check();
    await click(66, 40, ['Shift']);
    assert.match(await summary(), /^selection 3200 px · 56×64 px at 16,16 .*2 clicks/, 'cuff strip added');
    await click(30, 40);
    await setField('cut-tolerance', 60);
    assert.match(await summary(), /^selection 3200 px · 56×64 px .*tolerance 60/, 'tolerance 60 floods into the cuff');
    await setField('cut-tolerance', 32);
    await setField('cut-min-alpha', 254);
    assert.match(await summary(), /^selection 3072 px/);
    await click(5, 5);
    assert.match(await summary(), /^selection 0 px/);
    assert.ok(await page.getByTestId('cut-apply').isDisabled(), 'empty selection cannot be cut');
    // Esc closes without changing anything.
    const p0 = await project(), u0 = (await state()).undo;
    await page.keyboard.press('Escape');
    await page.getByTestId('cutout-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await project(), p0);
    assert.equal((await state()).undo, u0);
  });

  it('cutting the selection: exact source pixels, complementary remainder, one undo step, source unchanged, renders in place', async () => {
    const before = await exportPng('before.png');
    const srcUrl = (await project()).images[0].dataUrl;
    const click = await openCutout();
    await page.getByTestId('cut-mode-wand').click();
    await click(30, 40);
    await setField('cut-overlap', 0);
    await page.getByTestId('cut-bone').uncheck();
    await page.getByTestId('cut-name').fill('glove');
    await page.getByTestId('cut-name').press('Enter');
    const u0 = (await state()).undo;
    await page.getByTestId('cut-apply').click();
    await page.getByTestId('cutout-dialog').waitFor({ state: 'hidden' });
    assert.equal((await state()).undo, u0 + 1);
    const p = await project();
    assert.equal(p.images.find((i: any) => i.name === 'glove-art.png').dataUrl, srcUrl, 'source bytes unchanged');
    const pieceAsset = p.images.find((i: any) => i.name === 'glove-art-glove.png');
    assert.deepEqual([pieceAsset.derived.kind, pieceAsset.derived.offsetX, pieceAsset.derived.offsetY], ['cutout', 16, 16]);
    assert.match(pieceAsset.derived.note, /flood fill from 30,40, tolerance 32, alpha > 0: 3072 px/);
    const piece = imgOf(p, 'glove-art-glove.png');
    assert.deepEqual([piece.width, piece.height], [48, 64]);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 48; x++) assert.deepEqual([...piece.data.subarray((y * 48 + x) * 4, (y * 48 + x) * 4 + 4)], [200, 40, 40, 255]);
    const rest = imgOf(p, 'glove-art-rest.png');
    for (let i = 0; i < W * H; i++) {
      const x = i % W, y = Math.floor(i / W);
      assert.deepEqual([...rest.data.subarray(i * 4, i * 4 + 4)], inR(A, x, y) ? [0, 0, 0, 0] : [...SRC.subarray(i * 4, i * 4 + 4)], `rest ${x},${y}`);
    }
    assert.match(await page.getByTestId('image-derived-glove-art-glove.png').innerText(), /cutout of glove-art\.png/);
    const afterCut = await exportPng('after.png');
    const d = diffImages(afterCut, before, 2);
    writeFileSync(path.join(OUT, 'cut-in-place.txt'), `selection cut in place: max ${d.maxDiff}, over2 ${d.over}/${d.covered}\n`);
    assert.equal(d.over, 0, `piece + remainder render like the source (${JSON.stringify(d)})`);
  });

  it('speck removal: count = the prep-script rule (brute force here); cleaned copy, one undo step, source kept', async () => {
    const p0 = await project();
    const rest = imgOf(p0, 'glove-art-rest.png');
    await openCutout();
    const want = specks(rest, 100, 200, 6);
    assert.equal(await page.getByTestId('cut-speck-count').innerText(), `${want.length} speck px in glove-art-rest.png`);
    await setField('cut-speck-dist', 2);
    assert.equal(await page.getByTestId('cut-speck-count').innerText(), `${specks(rest, 100, 200, 2).length} speck px in glove-art-rest.png`);
    await setField('cut-speck-dist', 6);
    await setField('cut-speck-faint', 101);
    assert.equal(await page.getByTestId('cut-speck-count').innerText(), `${specks(rest, 101, 200, 6).length} speck px in glove-art-rest.png`, 'α 100 now counts as faint');
    await setField('cut-speck-faint', 100);
    // The art is fully opaque, so only a "solid" threshold below some faint pixels' own alpha
    // (20–99) changes the count: at 50 those pixels count as solid and stop being specks.
    const solid = specks(rest, 100, 50, 6).length;
    assert.ok(solid < want.length, `solid 50 changes the reference count (${solid} vs ${want.length})`);
    await setField('cut-speck-solid', 50);
    assert.equal(await page.getByTestId('cut-speck-count').innerText(), `${solid} speck px in glove-art-rest.png`, 'solid threshold 50');
    await setField('cut-speck-solid', 200);
    assert.equal(await page.getByTestId('cut-speck-count').innerText(), `${want.length} speck px in glove-art-rest.png`);
    assert.ok(want.length >= 3 && want.length < FAINT.length, `some faint pixels are near art (${want.length} of ${FAINT.length})`);
    const u0 = (await state()).undo;
    await page.getByTestId('cut-despeckle').click();
    await page.waitForFunction((n) => (window as any).__rigsmith.state().undo === n, u0 + 1);
    assert.match(await page.getByTestId('status').innerText(), new RegExp(`Removed ${want.length} speck px: glove-art now uses glove-art-rest-clean\\.png\\. glove-art-rest\\.png is unchanged\\.`));
    assert.equal(await page.getByTestId('cut-speck-count').innerText(), '0 speck px in glove-art-rest-clean.png');
    assert.ok(await page.getByTestId('cut-despeckle').isDisabled());
    await page.getByTestId('cut-cancel').click();
    const p = await project();
    assert.equal(p.images.find((i: any) => i.name === 'glove-art-rest.png').dataUrl, p0.images.find((i: any) => i.name === 'glove-art-rest.png').dataUrl);
    const clean = imgOf(p, 'glove-art-rest-clean.png');
    const removed = new Set(want);
    for (let i = 0; i < W * H; i++) assert.deepEqual([...clean.data.subarray(i * 4, i * 4 + 4)], removed.has(i) ? [0, 0, 0, 0] : [...rest.data.subarray(i * 4, i * 4 + 4)], `pixel ${i}`);
    assert.equal(p.attachments.find((a: any) => a.name === 'glove-art').imageId, p.images.find((i: any) => i.name === 'glove-art-rest-clean.png').id);
    assert.match(await page.getByTestId('image-derived-glove-art-rest-clean.png').innerText(), /cleanup of glove-art-rest\.png/);
    await page.getByTestId('undo').click();
    const pu = await project();
    assert.equal(pu.attachments.find((a: any) => a.name === 'glove-art').imageId, pu.images.find((i: any) => i.name === 'glove-art-rest.png').id, 'undo restores the attachment image');
    await page.getByTestId('redo').click();
    assert.deepEqual(pageErrors, []);
  });
});
