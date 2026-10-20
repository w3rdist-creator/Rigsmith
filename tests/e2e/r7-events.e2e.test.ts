// R7 browser checks: timeline events from the visible controls (name field, ◆ Event,
// selected-event name/payload, delete, undo, save and reopen), and the reference player
// firing a runtime file's events while it plays (≤ 1 frame from each event's time).
// window.__rigsmith / __rigsmithPlayer are read-only (assertions).
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { exportRuntime } from '../../src/model/exportRuntime.ts';
import { richProject } from '../support/runtime-fixture.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/r7-events');
mkdirSync(path.join(OUT, 'loose'), { recursive: true });

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let base: string;
const pageErrors: string[] = [];

const state = () => probe<any>(page, 'state');
const walk = async () => (await probe<any>(page, 'project')).animations.find((a: any) => a.name === 'walk');

async function gotoFrame(frame: number, frames = 30): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
}

before(async () => {
  const port = await pickPort([47643, 47644, 47645]);
  base = `http://127.0.0.1:${port}/`;
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-r7-events');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(base);
  await page.getByTestId('empty-demo').click();
  await page.waitForFunction(() => (window as any).__rigsmith.state().playing === true);
  await page.getByTestId('play').click();
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('timeline events (R7)', () => {
  it('add at the playhead, set a payload, rename, delete, undo; saved as v3 and reopened', async () => {
    await gotoFrame(6);
    await page.getByTestId('event-name').fill('bad name');
    await page.getByTestId('add-event').click();
    assert.equal((await walk()).events, undefined, 'an invalid name adds nothing');
    assert.match((await page.getByTestId('status').textContent()) ?? '', /Event names are/);
    await page.getByTestId('event-name').fill('prop_flash');
    await page.getByTestId('add-event').click();
    assert.deepEqual((await walk()).events, { prop_flash: [{ time: 0.2 }] });
    await page.getByTestId('key-event-prop_flash-6').waitFor();
    assert.equal((await state()).keySel.lane, 'e:prop_flash', 'the new event is selected');
    const pay = page.getByTestId('event-key-payload');
    await pay.fill('3');
    await pay.press('Enter');
    assert.deepEqual((await walk()).events, { prop_flash: [{ time: 0.2, payload: 3 }] }, 'a plain number is stored as a number');
    await gotoFrame(15);
    await page.getByTestId('event-name').fill('sfx:step');
    await page.getByTestId('event-name').press('Enter');
    await page.getByTestId('key-event-prop_flash-6').click();
    const nm = page.getByTestId('event-key-name');
    await nm.fill('flash');
    await nm.press('Enter');
    assert.deepEqual((await walk()).events, { flash: [{ time: 0.2, payload: 3 }], 'sfx:step': [{ time: 0.5 }] }, 'renamed: moved lanes, payload kept');
    await page.getByTestId('key-event-flash-6').click();
    await page.getByTestId('delete-key').click();
    assert.deepEqual((await walk()).events?.flash ?? [], []);
    await page.getByTestId('undo').click();
    assert.deepEqual((await walk()).events.flash, [{ time: 0.2, payload: 3 }]);
    await page.screenshot({ path: path.join(OUT, 'event-lanes.png') });
    const dl = page.waitForEvent('download');
    await page.getByTestId('save-project').click();
    const file = path.join(OUT, 'events.rig.json');
    await (await dl).saveAs(file);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.version, 3);
    assert.deepEqual(saved.animations.find((a: any) => a.name === 'walk').events, { flash: [{ time: 0.2, payload: 3 }], 'sfx:step': [{ time: 0.5 }] });
    await page.getByTestId('open-input').setInputFiles(file);
    await page.waitForFunction(() => !!(window as any).__rigsmith.project().animations.find((a: any) => a.name === 'walk')?.events?.flash);
    assert.deepEqual(pageErrors, []);
  });

  it('the reference player fires a runtime file’s events while it plays, within a frame, including across the loop', async () => {
    const p = richProject();
    const wave = p.animations.find((a) => a.name === 'wave')!;
    wave.events = { prop_flash: [{ time: 0.2 }], burst: [{ time: 0.5, payload: 'big' }], beat: [{ time: 0.123 }] };
    const rt = path.join(OUT, 'events.runtime.json');
    writeFileSync(rt, JSON.stringify(exportRuntime(p)));
    const loose = p.images.map((im) => {
      const f = path.join(OUT, 'loose', im.name);
      writeFileSync(f, Buffer.from(im.dataUrl.split(',')[1], 'base64'));
      return f;
    });
    const player = await ctx.newPage();
    player.on('pageerror', (e) => pageErrors.push(e.message));
    await player.goto(`${base}player.html`);
    await player.getByTestId('player-files').setInputFiles([rt, ...loose]);
    await player.waitForFunction(() => /^Loaded/.test(document.querySelector('[data-testid="player-status"]')!.textContent!));
    await player.getByTestId('player-anim').selectOption({ label: 'wave' });
    await player.getByTestId('player-play').click();
    // One full pass (30 frames at 30 fps) plus part of the second.
    await player.waitForFunction(() => (window as any).__rigsmithPlayer.events().filter((e: any) => e.name === 'prop_flash').length >= 2, undefined, { timeout: 10000 });
    await player.getByTestId('player-play').click();
    const fired: { name: string; time: number; frame: number; payload?: unknown }[] = await player.evaluate(() => (window as any).__rigsmithPlayer.events());
    const firsts = ['beat', 'prop_flash', 'burst'].map((n) => fired.find((e) => e.name === n)!);
    for (const e of firsts) assert.ok(e && e.frame >= e.time * 30 - 1e-9 && e.frame - e.time * 30 <= 1, `${e?.name} fired at frame ${e?.frame} for time ${e?.time}`);
    assert.deepEqual(firsts.map((e) => e.name), ['beat', 'prop_flash', 'burst'], 'in time order');
    assert.equal(fired.find((e) => e.name === 'burst')!.payload, 'big');
    const pass1 = fired.slice(0, 3).map((e) => e.name), pass2 = fired.slice(3, 5).map((e) => e.name);
    assert.deepEqual(pass1, ['beat', 'prop_flash', 'burst']);
    assert.deepEqual(pass2, ['beat', 'prop_flash'], 'each fires once per loop pass');
    assert.match(await player.getByTestId('player-events').innerText(), /f6 prop_flash/);
    await player.screenshot({ path: path.join(OUT, 'player-events.png') });
    await player.close();
    assert.deepEqual(pageErrors, []);
  });
});
