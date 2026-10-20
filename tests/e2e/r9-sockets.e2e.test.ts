// R9 browser checks: FX sockets from the visible controls (the attachment inspector's
// Particle emitter checkbox, recipe and rate in setup; the keyable emit rate in Animate
// mode; turning it off drops the rate keys; undo), with a viewport screenshot of the
// stand-in. window.__rigsmith is read-only (assertions).
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/r9-sockets');
mkdirSync(OUT, { recursive: true });

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

const project = () => probe<any>(page, 'project');
const keyAtt = async () => (await project()).attachments.find((a: any) => a.name === 'key');
const walk = async () => (await project()).animations.find((a: any) => a.name === 'walk');

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
  const port = await pickPort([47649, 47650, 47651]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-r9-sockets');
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

describe('FX sockets (R9)', () => {
  it('make an emitter, set recipe and rate, key the rate, turn it off (rate keys go), undo', async () => {
    await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-att-key').click();
    await page.getByTestId('att-emitter').check();
    assert.deepEqual((await keyAtt()).emitter, { recipe: 'sparkle', rate: 20 });
    await setField('emitter-recipe', 'glint.sparkle');
    await setField('emitter-rate', '45');
    assert.deepEqual((await keyAtt()).emitter, { recipe: 'glint.sparkle', rate: 45 });
    await setField('emitter-recipe', 'bad recipe');
    assert.equal((await keyAtt()).emitter.recipe, 'glint.sparkle', 'an invalid recipe is refused');

    await page.getByTestId('mode-animate').click();
    await page.getByTestId('tree-att-key').click();
    await gotoFrame(5);
    await setField('slot-rate', '0');
    await gotoFrame(20);
    await setField('slot-rate', '120');
    assert.deepEqual((await walk()).slots.att_key.rate.map((k: any) => k.value[0]), [0, 120]);
    await page.getByTestId('slot-key-rate').click();
    assert.deepEqual((await walk()).slots.att_key.rate.map((k: any) => k.value[0]), [0], 'the ◆ removes the key at the playhead');
    await page.getByTestId('slot-key-rate').click();
    assert.deepEqual((await walk()).slots.att_key.rate.map((k: any) => k.time), [5 / 30, 20 / 30], 'and keys the current rate again');
    await setField('slot-rate', '120');
    await page.screenshot({ path: path.join(OUT, 'emitter-stand-in.png') });

    await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-att-key').click();
    await page.getByTestId('att-emitter').uncheck();
    assert.equal((await keyAtt()).emitter, undefined);
    assert.equal((await walk()).slots?.att_key?.rate, undefined, 'its rate keys go with it');
    await page.getByTestId('undo').click();
    assert.equal((await keyAtt()).emitter.rate, 45);
    assert.equal((await walk()).slots.att_key.rate.length, 2);
    assert.deepEqual(pageErrors, []);
  });
});
