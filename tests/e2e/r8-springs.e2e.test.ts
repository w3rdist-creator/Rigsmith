// R8 browser checks: springs from the visible controls (+ Spring on a bone, the spring
// inspector's parameters, next/last bone, tree row, Bake all springs, undo). The demo's
// arm swings in "walk", so a spring on the arm visibly changes the forearm's angle.
// window.__rigsmith is read-only (assertions).
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/r8-springs');
mkdirSync(OUT, { recursive: true });

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

const project = () => probe<any>(page, 'project');
const angle = async (id: string) => {
  const m = (await probe<Record<string, number[]>>(page, 'worlds'))[id];
  return (Math.atan2(m[1], m[0]) * 180) / Math.PI;
};

async function gotoFrame(frame: number, frames = 30): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
}

async function setField(id: string, v: string): Promise<void> {
  const f = page.getByTestId(id);
  await f.fill(v);
  await f.press('Enter');
}

before(async () => {
  const port = await pickPort([47646, 47647, 47648]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-r8-springs');
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

describe('springs (R8)', () => {
  it('add on a bone (chain follows single children), tune, extend/shorten, bake, undo', async () => {
    await gotoFrame(9);
    const keyed = await angle('b_fore_front');
    await page.getByTestId('tree-bone-arm-front').click();
    await page.getByTestId('spring-add').click();
    let p = await project();
    assert.equal(p.springs.length, 1);
    assert.deepEqual(p.springs[0].bones, ['b_arm_front', 'b_fore_front']);
    assert.equal(await page.getByTestId('spring-chain').textContent(), 'Chain: arm-front → forearm-front');
    await page.getByTestId('tree-constraint-arm-front-spring').waitFor();
    const lag = Math.abs((await angle('b_fore_front')) - keyed);
    assert.ok(lag > 1, `the forearm lags behind the swing (${lag.toFixed(2)}°)`);

    await setField('spring-stiffness', '0.2');
    await setField('spring-gain', '2');
    p = await project();
    assert.equal(p.springs[0].stiffness, 0.2);
    assert.equal(p.springs[0].gain, 2);
    await setField('spring-mix', '0');
    assert.ok(Math.abs((await angle('b_fore_front')) - keyed) < 1e-6, 'mix 0 shows the keyed pose');
    await setField('spring-mix', '1');

    console.log('pre', JSON.stringify((await project()).springs), await page.getByTestId('status').textContent());
    await page.getByTestId('spring-shorten').click();
    console.log('post', JSON.stringify((await project()).springs), await page.getByTestId('status').textContent());
    assert.deepEqual((await project()).springs[0].bones, ['b_arm_front']);
    assert.equal(await page.getByTestId('spring-shorten').isDisabled(), true);
    await page.getByTestId('spring-extend').click();
    assert.deepEqual((await project()).springs[0].bones, ['b_arm_front', 'b_fore_front']);
    assert.equal(await page.getByTestId('spring-extend').isDisabled(), true, 'the forearm has no child');

    await page.getByTestId('tree-bone-arm-front').click();
    assert.equal(await page.getByTestId('spring-add').isDisabled(), true, 'a bone is in one spring at most');
    await page.getByTestId('goto-constraint-arm-front-spring').click();
    await page.screenshot({ path: path.join(OUT, 'spring-inspector.png') });

    const sprung = await angle('b_fore_front');
    await page.getByTestId('spring-bake').click();
    p = await project();
    assert.equal(p.springs, undefined);
    const walk = p.animations.find((a: any) => a.name === 'walk');
    assert.equal(walk.tracks.b_fore_front.rotate.length, Math.round(walk.duration * walk.fps) + 1, 'one key per frame');
    assert.ok(Math.abs((await angle('b_fore_front')) - sprung) < 1e-3, 'baking keeps the motion');
    assert.match((await page.getByTestId('status').textContent()) ?? '', /Baked springs: 4 bone track\(s\) across 2 animation\(s\)/);

    await page.getByTestId('undo').click();
    assert.equal((await project()).springs.length, 1, 'undo restores the spring');
    assert.deepEqual(pageErrors, []);
  });
});
