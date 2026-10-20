// R10 painted views: visible controls only; the editor probe is read-only assertions.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { serializeProject } from '../../src/model/format.ts';
import { makeBone } from '../../src/model/ops.ts';
import { slotValues } from '../../src/model/rigOps.ts';
import { emptyProject, type Project } from '../../src/model/types.ts';
import { decodePng } from '../support/png-decode.ts';
import { encodePng } from '../support/png-encode.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'r10-views');
mkdirSync(OUT, { recursive: true });
const areas: Record<string, number> = {};
function rig(): Project {
  const p = emptyProject('painted heads');
  p.bones.push(makeBone('head', 'head', null, 0, 0, 0, 30));
  for (const view of ['front', '34']) for (const eyes of ['open', 'half', 'closed']) {
    const w = 80, h = 64, px = new Uint8Array(w * h * 4);
    let area = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (Math.hypot((x + 0.5 - 40) / (view === 'front' ? 30 : 21), (y + 0.5 - 32) / 24) > 1) continue;
      const eyeX = view === 'front' ? [29, 51] : [43, 55];
      const dark = eyeX.some((ex) => Math.abs(x - ex) <= 3 && Math.abs(y - 27) <= (eyes === 'closed' ? 0 : eyes === 'half' ? 1 : 3));
      px.set(dark ? [45, 30, 25, 255] : [240, 140, 50, 255], (y * w + x) * 4);
      area++;
    }
    areas[view] = area;
    p.images.push({ id: `${view}_${eyes}`, name: `${view}_${eyes}.png`, mime: 'image/png', width: w, height: h, dataUrl: `data:image/png;base64,${encodePng(w, h, px).toString('base64')}` });
  }
  p.attachments.push({ id: 'front', name: 'front', boneId: 'head', imageId: 'front_open', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
  p.animations.push({ id: 'idle', name: 'idle', duration: 2, fps: 30, loop: false, tracks: {}, slots: { front: { image: [
    { time: 0, imageId: 'front_open' }, { time: 8 / 30, imageId: 'front_half' },
    { time: 10 / 30, imageId: 'front_closed' }, { time: 12 / 30, imageId: 'front_half' }, { time: 14 / 30, imageId: 'front_open' },
  ] } } });
  return p;
}
const RIG = path.join(OUT, 'procedural.rig.json');
writeFileSync(RIG, serializeProject(rig()));
let server: ChildProcess, ctx: BrowserContext, page: Page;
const errors: string[] = [];
const project = () => probe<Project>(page, 'project');
const status = async () => (await page.getByTestId('status').textContent()) ?? '';
const slots = async () => (await project()).animations[0].slots;
async function field(id: string, v: number) {
  await page.getByTestId(id).fill(String(v));
  await page.getByTestId(id).press('Enter');
}
async function frame(f: number) {
  const ruler = page.getByTestId('timeline-ruler'), box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, box.width * f / 60), y: box.height / 2 } });
  assert.equal(Math.round((await probe<any>(page, 'state')).time * 30), f);
}
async function undo() { await page.getByTestId('undo').click(); }
async function redo() { await page.getByTestId('redo').click(); }

before(async () => {
  const port = await pickPort([47664, 47665, 47666]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-r10-views');
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
  await page.getByTestId('open-input').setInputFiles(RIG);
  await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length === 1);
  await page.getByTestId('mode-setup').click();
  await page.getByTestId('tree-bone-head').click();
});
after(async () => { await ctx?.close(); server?.kill(); });

describe('painted views (R10)', () => {
  it('makes a view set from the bone attachments in one undo step', async () => {
    await page.getByTestId('views-create').click();
    assert.match(await status(), /Made view set/);
    assert.deepEqual((await project()).viewSets![0].views[0].attachments, ['front']);
    await undo();
    assert.equal((await project()).viewSets, undefined);
    await redo();
  });

  it('adds a registered view, configures eyes per view, and previews without keys; each action undoes', async () => {
    await page.getByTestId('views-name').fill('3/4');
    await page.getByTestId('views-open').selectOption('34_open');
    await page.getByTestId('views-half').selectOption('34_half');
    await page.getByTestId('views-closed').selectOption('34_closed');
    await page.getByTestId('views-fit').selectOption('height');
    await field('views-scale', 1);
    await page.getByTestId('views-add').click();
    await page.waitForFunction(() => /Added view/.test(document.querySelector('[data-testid=status]')?.textContent ?? ''));
    const added = await project();
    assert.equal(added.attachments.length, 2);
    assert.equal(added.attachments[1].hidden, true);
    assert.equal(added.attachments[1].scaleX, 1);
    await undo();
    assert.equal((await project()).attachments.length, 1);
    await redo();
    await page.getByTestId('views-eyes-view').selectOption({ label: 'base' });
    await page.getByTestId('views-eyes-att').selectOption('front');
    await page.getByTestId('views-eyes-open').selectOption('front_open');
    await page.getByTestId('views-eyes-half').selectOption('front_half');
    await page.getByTestId('views-eyes-closed').selectOption('front_closed');
    await page.getByTestId('views-eyes').click();
    assert.match(await status(), /Set blink eyes.*base/);
    assert.equal((await project()).viewSets![0].views[0].eyes!.closed, 'front_closed');
    await undo();
    assert.equal((await project()).viewSets![0].views[0].eyes, undefined);
    await redo();
    const before = await slots();
    await page.getByTestId('view-show-3/4').check();
    assert.match(await status(), /Setup; animation keys unchanged/);
    assert.equal((await project()).attachments[0].hidden, true);
    assert.deepEqual(await slots(), before);
    await undo();
    assert.equal((await project()).attachments[0].hidden, undefined);
    await page.getByTestId('view-show-3/4').check();
    await page.getByTestId('view-show-base').check();
    assert.equal((await project()).attachments[0].hidden, undefined);
  });

  it('keys at playhead with undo and reports a missing blink without changes', async () => {
    await page.getByTestId('mode-animate').click();
    await frame(50);
    const before = await slots();
    await page.getByTestId('view-blink-3/4').click();
    assert.match((await page.getByTestId('error-toast').textContent())!, /no closed-eye frame after f50; key a blink first/);
    assert.deepEqual(await slots(), before);
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.getByTestId('view-key-3/4').click();
    assert.match(await status(), /Keyed view “3\/4” at frame 50/);
    assert.deepEqual((await slots())!.front.visible!.map((k) => [Math.round(k.time * 30), k.value[0]]), [[0, 1], [50, 0]]);
    await undo();
    assert.deepEqual(await slots(), before);
  });

  it('swaps there and back on blinks, exports exactly one head in all 60 frames, and undoes both swaps', async () => {
    // Author the second blink on the new painting using the existing visible image-key control.
    await page.getByTestId('tree-att-head 3/4').click();
    for (const [f, im] of [[0, '34_open'], [38, '34_half'], [40, '34_closed'], [42, '34_half'], [44, '34_open']] as const) {
      await frame(f);
      await page.getByTestId('slot-image').selectOption(im);
    }
    await page.getByTestId('tree-bone-head').click();
    const before = await slots();
    await frame(5);
    await page.getByTestId('view-blink-3/4').click();
    assert.match(await status(), /Keyed view “3\/4” at frame 10 \(closed-eye blink\)/);
    const there = await slots();
    await frame(30);
    await page.getByTestId('view-blink-base').click();
    assert.match(await status(), /Keyed view “base” at frame 40 \(closed-eye blink\)/);
    const p = await project(), a = p.animations[0], side = p.attachments[1];
    assert.deepEqual(a.slots!.front.visible!.map((k) => [Math.round(k.time * 30), k.value[0]]), [[0, 1], [10, 0], [40, 1]]);
    assert.deepEqual(a.slots![side.id].visible!.map((k) => [Math.round(k.time * 30), k.value[0]]), [[0, 0], [10, 1], [40, 0]]);
    for (const [id, start, prefix] of [[side.id, 10, '34'], ['front', 40, 'front']] as const) {
      for (const [delta, eye] of [[0, 'closed'], [2, 'half'], [4, 'open']] as const)
        assert.equal(a.slots![id].image!.find((k) => Math.round(k.time * 30) === start + delta)!.imageId, `${prefix}_${eye}`);
    }
    await frame(10);
    await page.getByTestId('frame-all').click();
    await page.screenshot({ path: path.join(OUT, 'views-blink-f10.png') });
    await page.getByTestId('export-sequence').click();
    await field('seq-start', 0);
    await field('seq-end', 59);
    const download = page.waitForEvent('download');
    await page.getByTestId('seq-export').click();
    const zip = path.join(OUT, 'procedural-sequence.zip');
    await (await download).saveAs(zip);
    await page.keyboard.press('Escape');
    const files = readZip(readFileSync(zip));
    const pngs = files.filter((f) => f.name.endsWith('.png')).sort((x, y) => x.name.localeCompare(y.name));
    assert.equal(pngs.length, 60);
    const census: string[] = [];
    for (const [f, file] of pngs.entries()) {
      const im = decodePng(file.data);
      let pixels = 0;
      for (let i = 3; i < im.data.length; i += 4) if (im.data[i] > 24) pixels++;
      const expected = areas[f >= 10 && f < 40 ? '34' : 'front'];
      assert.ok(Math.abs(pixels - expected) <= expected * 0.01, `frame ${f}: alpha census ${pixels}, expected one head (${expected})`);
      assert.equal(p.attachments.filter((att) => slotValues(att, a, f / 30).visible).length, 1, `frame ${f}: exclusive visibility`);
      census.push(`frame ${f}: alpha pixels ${pixels}; expected ${expected}; visible heads 1`);
    }
    writeFileSync(path.join(OUT, 'procedural-alpha-census.txt'), census.join('\n') + '\n');
    await undo();
    assert.deepEqual(await slots(), there, 'one undo removes the return swap and its eye keys');
    await undo();
    assert.deepEqual(await slots(), before, 'another removes the first swap and its eye keys');
    assert.deepEqual(errors, []);
  });
});
