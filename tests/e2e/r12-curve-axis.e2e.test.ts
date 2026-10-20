// R12 / R7 browser check: per-axis translate easing from the visible curve-editor
// controls (Separate Y, axis menu, preset). Y held by a step while x eases on, one undo
// step per edit, and the y easing survives save and reload. window.__rigsmith is read-only.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { parseProject } from '../../src/model/format.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/r12-curve-axis');
mkdirSync(OUT, { recursive: true });

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

const state = () => probe<any>(page, 'state');
const rootKey0 = async () => (await probe<any>(page, 'project')).animations.find((a: any) => a.name === 'walk').tracks.b_root.translate[0];
const pose = async () => [Number(await page.getByTestId('bone-x').inputValue()), Number(await page.getByTestId('bone-y').inputValue())];

async function gotoFrame(frame: number, frames = 30): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
}

before(async () => {
  const port = await pickPort([47637, 47638, 47639]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-r12-curve-axis');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('empty-demo').click();
  await page.waitForFunction(() => (window as any).__rigsmith.state().playing === true);
  await page.getByTestId('play').click();
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('per-axis translate easing (R7)', () => {
  it('Separate Y + a step on Y holds y while x eases on; axis menu shows each curve; undo; save/reload keeps it', async () => {
    await page.getByTestId('tree-bone-root').click();
    await gotoFrame(0);
    // Give the 0 → 0.25 s segment an x move: key 0 becomes [20, 0] (still smooth), key 0.25 s is [0, -7].
    const x = page.getByTestId('bone-x');
    await x.fill('20');
    await x.press('Enter');
    await page.getByTestId('key-root-translate-0').click();
    assert.equal(await page.getByTestId('curve-axis').isDisabled(), true, 'one curve until split');
    const undo0 = (await state()).undo;
    await page.getByTestId('curve-split-y').check();
    assert.equal((await state()).undo, undo0 + 1, 'split = one undo step');
    assert.deepEqual([(await rootKey0()).interp, (await rootKey0()).interpY], ['smooth', 'smooth'], 'y starts as a copy: nothing moves');
    assert.equal(await page.getByTestId('curve-axis').inputValue(), 'y');
    await page.getByTestId('curve-preset').selectOption('step');
    assert.equal((await state()).undo, undo0 + 2);
    let k = await rootKey0();
    assert.deepEqual([k.interp, k.interpY, k.curveY], ['smooth', 'step', undefined]);
    await gotoFrame(4);
    const [px, py] = await pose();
    assert.equal(py, 0, 'y holds the key value (step)');
    assert.ok(px > 1 && px < 19, `x eases between the keys (${px})`);
    await page.screenshot({ path: path.join(OUT, 'split-y-step.png') });
    // The axis menu switches which curve is shown and edited.
    await page.getByTestId('key-root-translate-0').click();
    await page.getByTestId('curve-axis').selectOption('x');
    assert.equal(await page.getByTestId('curve-interp').innerText(), 'smooth');
    await page.getByTestId('curve-preset').selectOption('ease-out');
    k = await rootKey0();
    assert.deepEqual([k.interp, k.curve, k.interpY], ['bezier', [0, 0, 0.58, 1], 'step'], 'x edit leaves y alone');
    await page.getByTestId('curve-axis').selectOption('y');
    assert.equal(await page.getByTestId('curve-interp').innerText(), 'step');
    await page.getByTestId('curve-preset').selectOption('overshoot');
    k = await rootKey0();
    assert.deepEqual([k.interpY, k.curveY], ['bezier', [0.3, 0, 0.35, 1.45]]);
    // Save, then reopen the saved file: the y easing is in the v3 project.
    const dl = page.waitForEvent('download');
    await page.getByTestId('save-project').click();
    const file = path.join(OUT, 'per-axis.rig.json');
    await (await dl).saveAs(file);
    const text = readFileSync(file, 'utf8');
    assert.equal(JSON.parse(text).version, 3);
    const parsed = parseProject(text);
    assert.ok(parsed.ok);
    if (parsed.ok) assert.deepEqual(parsed.project.animations.find((a) => a.name === 'walk')!.tracks.b_root.translate[0].curveY, [0.3, 0, 0.35, 1.45]);
    await page.getByTestId('open-input').setInputFiles(file);
    await page.waitForFunction(() => (window as any).__rigsmith.project().animations[0]?.tracks?.b_root?.translate?.[0]?.interpY === 'bezier');
    // Join: y follows x again; undo restores the split.
    await page.getByTestId('tree-bone-root').click();
    await page.getByTestId('key-root-translate-0').click();
    await page.getByTestId('curve-split-y').uncheck();
    assert.equal((await rootKey0()).interpY, undefined);
    assert.equal(await page.getByTestId('curve-axis').isDisabled(), true);
    await page.getByTestId('undo').click();
    assert.equal((await rootKey0()).interpY, 'bezier');
    // Rotate keys have no Separate Y.
    await page.getByTestId('tree-bone-thigh-front').click();
    await page.getByTestId('key-thigh-front-rotate-0').click();
    assert.equal(await page.getByTestId('curve-split-y').count(), 0);
    assert.deepEqual(pageErrors, []);
  });
});
