// RV-003 (use-case review): a fixed delivery frame stored in the project, offered by the
// export, mix and Lottie dialogs. Every control is visible UI; downloads are decoded
// independently (tests/support). Generated original pixels only.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { serializeProject } from '../../src/model/format.ts';
import type { Project } from '../../src/model/types.ts';
import { decodePng } from '../support/png-decode.ts';
import type { Decoded } from '../support/png-decode.ts';
import { encodePng } from '../support/png-encode.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'usecase/frame');
mkdirSync(OUT, { recursive: true });

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

function solid(w: number, h: number, rgba: [number, number, number, number]): string {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set(rgba, i * 4);
  // A darker left column makes orientation visible in the frames.
  for (let y = 0; y < h; y++) px.set([rgba[0] >> 1, rgba[1] >> 1, rgba[2] >> 1, 255], y * w * 4);
  return `data:image/png;base64,${encodePng(w, h, px).toString('base64')}`;
}

const bone = (id: string, parentId: string | null, x: number, length: number) => ({ id, name: id, parentId, x, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length, color: '#8fd3c8' });
const att = (id: string, boneId: string, imageId: string, x: number) => ({ id, name: id, boneId, imageId, x, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
const k = (time: number, value: number[]) => ({ time, value, interp: 'linear' });

/** Flat (Lottie-exportable) figure: "swing" turns the arm down, "slide" moves the whole figure right. */
function rig(): Project {
  return {
    format: 'rigsmith.project', version: 1, name: 'framed',
    images: [
      { id: 'im-body', name: 'body.png', mime: 'image/png', width: 160, height: 200, dataUrl: solid(160, 200, [200, 150, 90, 255]) },
      { id: 'im-arm', name: 'arm.png', mime: 'image/png', width: 100, height: 24, dataUrl: solid(100, 24, [230, 140, 40, 255]) },
      { id: 'im-glove', name: 'glove.png', mime: 'image/png', width: 60, height: 60, dataUrl: solid(60, 60, [240, 240, 230, 255]) },
    ],
    bones: [bone('root', null, 0, 40), bone('arm', 'root', 80, 100), bone('hand', 'arm', 100, 40)],
    attachments: [att('body', 'root', 'im-body', 0), att('arm', 'arm', 'im-arm', 50), att('glove', 'hand', 'im-glove', 30)],
    animations: [
      { id: 'swing', name: 'swing', duration: 1, fps: 10, loop: true, tracks: { arm: { translate: [], rotate: [k(0, [0]), k(0.5, [90]), k(1, [0])], scale: [] } } },
      { id: 'slide', name: 'slide', duration: 1, fps: 10, loop: true, tracks: { root: { translate: [k(0, [0, 0]), k(0.5, [80, 0]), k(1, [0, 0])], rotate: [], scale: [] } } },
    ],
  } as unknown as Project;
}

const RIG = path.join(OUT, 'framed.rig.json');
writeFileSync(RIG, serializeProject(rig()));

const project = () => probe<any>(page, 'project');

async function setField(testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function download(click: () => Promise<void>, name: string): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  const file = path.join(OUT, name);
  await dl.saveAs(file);
  return readFileSync(file);
}

/** Every PNG frame of an exported ZIP, decoded, plus its sequence.json. */
function frames(zip: Buffer): { pngs: Decoded[]; meta: any } {
  const files = readZip(zip);
  const pngs = files.filter((f) => f.name.endsWith('.png')).sort((a, b) => a.name.localeCompare(b.name)).map((f) => decodePng(f.data));
  const meta = JSON.parse(files.find((f) => f.name.endsWith('sequence.json'))!.data.toString('utf8'));
  return { pngs, meta };
}

async function exportSeq(anim: string, name: string, canvas?: 'project' | 'fit'): Promise<{ pngs: Decoded[]; meta: any; warning: string | null }> {
  await page.getByTestId('export-sequence').click();
  await page.getByTestId('seq-anim').selectOption({ label: anim });
  if (canvas) await page.getByTestId('seq-frame').selectOption(canvas);
  const w = page.getByTestId('seq-frame-warning');
  const warning = (await w.count()) ? await w.innerText() : null;
  const zip = await download(() => page.getByTestId('seq-export').click(), name);
  await page.getByTestId('export-dialog').waitFor({ state: 'hidden' });
  return { ...frames(zip), warning };
}

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-project-frame');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
  await page.getByTestId('open-input').setInputFiles(RIG);
  await page.waitForFunction(() => (window as any).__rigsmith.project().name === 'framed');
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('RV-003: project delivery frame', () => {
  let frame: { x: number; y: number; width: number; height: number };

  it('“Set frame: fit to all animations” stores one frame enclosing every pose; one undo step', async () => {
    assert.equal(await page.getByTestId('frame-x').count(), 0, 'no frame yet');
    const u0 = (await probe<any>(page, 'state')).undo;
    await page.getByTestId('frame-fit').click();
    frame = (await project()).frame;
    assert.ok(frame, 'frame stored in the project');
    // Body −80…80; at rest the glove reaches x 240, slide adds 80 (→ 320); swing lowers it to y 160.
    const encloses = frame.x <= -84 && frame.y <= -104 && frame.x + frame.width >= 324 && frame.y + frame.height >= 164;
    assert.ok(encloses && frame.width <= 412 && frame.height <= 272, `union of every pose + 4 px: ${JSON.stringify(frame)}`);
    assert.equal(await page.getByTestId('frame-width').inputValue(), String(frame.width));
    assert.equal(await page.getByTestId('frame-height').inputValue(), String(frame.height));
    assert.match(await page.getByTestId('frame-summary').innerText(), new RegExp(`${frame.width}×${frame.height}`));
    assert.equal((await probe<any>(page, 'state')).undo, u0 + 1);
    await page.screenshot({ path: path.join(OUT, 'frame-on-canvas.png') });
  });

  it('both loops and the swing→slide mix export at exactly the frame size; mix frame 0 equals swing frame 0', async () => {
    const swing = await exportSeq('swing', 'swing-frame.zip');
    const slide = await exportSeq('slide', 'slide-frame.zip');
    for (const s of [swing, slide]) {
      assert.equal(s.meta.frame, 'project');
      assert.deepEqual([s.meta.width, s.meta.height], [frame.width, frame.height]);
      assert.deepEqual(s.meta.origin, { x: frame.x, y: frame.y });
      for (const png of s.pngs) assert.deepEqual([png.width, png.height], [frame.width, frame.height]);
      assert.equal(s.warning, null, 'fit-to-all frame clips nothing');
    }
    await page.getByTestId('mix-open').click();
    await page.getByTestId('mix-from').selectOption({ label: 'swing' });
    await page.getByTestId('mix-to').selectOption({ label: 'slide' });
    assert.equal(await page.getByTestId('mix-frame').inputValue(), 'project', 'a project frame is the default canvas');
    assert.match(await page.getByTestId('mix-summary').innerText(), new RegExp(`${frame.width}×${frame.height} px · transparent · project frame`));
    const mix = frames(await download(() => page.getByTestId('mix-export').click(), 'mix-frame.zip'));
    await page.getByTestId('mix-close').click();
    assert.equal(mix.meta.frame, 'project');
    for (const png of mix.pngs) assert.deepEqual([png.width, png.height], [frame.width, frame.height]);
    assert.ok(Buffer.from(mix.pngs[0].data).equals(Buffer.from(swing.pngs[0].data)), 'mix frame 0 is pixel-identical to swing frame 0');
    assert.ok(mix.pngs.some((m) => !Buffer.from(m.data).equals(Buffer.from(swing.pngs[0].data))), 'and the mix does change');
  });

  it('“Fit this animation” still gives the old per-animation canvas', async () => {
    const fit = await exportSeq('slide', 'slide-fit.zip', 'fit');
    assert.equal(fit.meta.frame, 'fit');
    assert.notDeepEqual([fit.meta.width, fit.meta.height], [frame.width, frame.height]);
  });

  it('a frame smaller than the art shows a visible warning and clips instead of resizing', async () => {
    await page.keyboard.press('Escape');
    await setField('frame-width', 200);
    assert.equal((await project()).frame.width, 200);
    await page.getByTestId('export-sequence').click();
    await page.getByTestId('seq-anim').selectOption({ label: 'swing' });
    const warn = page.getByTestId('seq-frame-warning');
    await warn.waitFor();
    assert.match(await warn.innerText(), /“swing” extends outside the project frame \(right \d+ world units\) and is clipped; the frame size is kept/);
    await page.screenshot({ path: path.join(OUT, 'frame-clip-warning.png') });
    const zip = await download(() => page.getByTestId('seq-export').click(), 'swing-clipped.zip');
    const clipped = frames(zip);
    for (const png of clipped.pngs) assert.deepEqual([png.width, png.height], [200, frame.height], 'size kept');
    // The clipped edge column holds art (the glove reaches past it) in the raised pose.
    const f0 = clipped.pngs[0];
    let edge = 0;
    for (let y = 0; y < f0.height; y++) edge += f0.data[(y * f0.width + f0.width - 1) * 4 + 3] > 0 ? 1 : 0;
    assert.ok(edge > 10, `art runs into the clipped edge (${edge} px)`);
  });

  it('Lottie uses the frame as its composition size and reports clipping', async () => {
    await page.getByTestId('export-lottie').click();
    await page.getByTestId('lottie-anim').selectOption('slide');
    assert.equal(await page.getByTestId('lottie-frame').inputValue(), 'project');
    assert.match(await page.getByTestId('lottie-summary').innerText(), new RegExp(`^200×${frame.height} ·`));
    assert.match(await page.getByTestId('lottie-frame-warning').innerText(), /clipped/);
    await page.getByTestId('lottie-frame').selectOption('fit');
    assert.ok(!new RegExp(`^200×${frame.height} ·`).test(await page.getByTestId('lottie-summary').innerText()), 'fit size differs');
    assert.equal(await page.getByTestId('lottie-frame-warning').count(), 0);
    await page.getByTestId('lottie-cancel').click();
  });

  it('Remove frame returns every export to fit; undo brings the frame back', async () => {
    await page.getByTestId('frame-clear').click();
    assert.ok(!('frame' in (await project())));
    await page.getByTestId('export-sequence').click();
    assert.equal(await page.getByTestId('seq-frame').inputValue(), 'fit');
    assert.notEqual(await page.getByTestId('seq-frame').locator('option[value="project"]').getAttribute('disabled'), null, 'Project frame option disabled');
    await page.getByTestId('seq-cancel').click();
    await page.getByTestId('undo').click();
    assert.equal((await project()).frame.width, 200);
    await setField('frame-x', frame.x);
    await setField('frame-y', frame.y);
    await setField('frame-height', frame.height);
    assert.deepEqual((await project()).frame, { ...frame, width: 200 });
    assert.deepEqual(pageErrors, []);
  });
});
