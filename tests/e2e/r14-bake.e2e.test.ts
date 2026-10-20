// R14 browser check: Constraints ▸ Bake from the visible control — a 2-bone IK added on the
// demo's arm is written into per-frame keys and removed, the arm's pose is unchanged at the
// playhead, and undo restores the IK. window.__rigsmith is read-only (assertions).
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { launchIsolated, pickPort, probe, startPreview } from './harness.ts';

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const project = () => probe<any>(page, 'project');
const worlds = () => probe<Record<string, number[]>>(page, 'worlds');

before(async () => {
  const port = await pickPort([47655, 47656, 47657]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-r14-bake');
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

describe('bake constraints (R14)', () => {
  it('IK → per-frame keys; pose unchanged; undo restores the IK', async () => {
    assert.equal(await page.getByTestId('bake-constraints').isDisabled(), true, 'nothing to bake yet');
    await page.getByTestId('tree-bone-forearm-front').click();
    await page.getByTestId('ik-add-2').click();
    assert.equal((await project()).ik.length, 1);
    const before = await worlds();
    await page.getByTestId('bake-constraints').click();
    const p = await project();
    assert.equal(p.ik, undefined);
    const walk = p.animations.find((a: any) => a.name === 'walk');
    assert.equal(walk.tracks.b_fore_front.rotate.length, Math.round(walk.duration * walk.fps) + 1);
    const after = await worlds();
    for (const id of ['b_arm_front', 'b_fore_front']) after[id].forEach((v, i) => assert.ok(Math.abs(v - before[id][i]) < 1e-6, `${id}[${i}]`));
    assert.match((await page.getByTestId('status').textContent()) ?? '', /Baked 1 constraint\(s\): 2 bone\(s\)/);
    await page.getByTestId('undo').click();
    assert.equal((await project()).ik.length, 1);
    assert.deepEqual(pageErrors, []);
  });
});
