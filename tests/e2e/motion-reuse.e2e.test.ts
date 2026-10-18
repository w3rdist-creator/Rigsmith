// RV-009 (use-case review): cross-project motion reuse and saved clip sequences, driven
// through visible controls only — "Import anims…" with an explicit bone mapping and a
// report of what does not match, a key clipboard that survives a reload and a project
// switch, and the "Sequences…" dialog (ordered clips, repeats, stored mixes, preview,
// ZIP / APNG export). Exports are decoded independently (tests/support); the sequence
// frames are compared with the Mix dialog's own export. Generated original pixels only.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { serializeProject } from '../../src/model/format.ts';
import type { Project } from '../../src/model/types.ts';
import { pillow } from '../support/media-check.ts';
import { decodePng } from '../support/png-decode.ts';
import type { Decoded } from '../support/png-decode.ts';
import { encodePng } from '../support/png-encode.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, readIdb, startPreview, waitUntil } from './harness.ts';

const OUT = path.join(EVIDENCE, 'usecase/motion-reuse');
mkdirSync(OUT, { recursive: true });

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

function solid(w: number, h: number, rgba: [number, number, number, number]): string {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set(rgba, i * 4);
  for (let y = 0; y < h; y++) px.set([rgba[0] >> 1, rgba[1] >> 1, rgba[2] >> 1, 255], y * w * 4);
  return `data:image/png;base64,${encodePng(w, h, px).toString('base64')}`;
}

const bone = (id: string, name: string, parentId: string | null, x: number, length: number) => ({ id, name, parentId, x, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length, color: '#8fd3c8' });
const att = (id: string, boneId: string, imageId: string, x: number) => ({ id, name: id, boneId, imageId, x, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
const k = (time: number, value: number[]) => ({ time, value, interp: 'linear' });
const images = (prefix: string) => [
  { id: `${prefix}-im-body`, name: 'body.png', mime: 'image/png', width: 120, height: 160, dataUrl: solid(120, 160, [200, 150, 90, 255]) },
  { id: `${prefix}-im-arm`, name: 'arm.png', mime: 'image/png', width: 90, height: 20, dataUrl: solid(90, 20, [230, 140, 40, 255]) },
  { id: `${prefix}-im-hand`, name: 'hand.png', mime: 'image/png', width: 40, height: 40, dataUrl: solid(40, 40, [240, 240, 230, 255]) },
];

/** The donor project: its "hand" bone is called "wrist" in the stage project, and "tail" has no counterpart. */
function donor(): Project {
  return {
    format: 'rigsmith.project', version: 1, name: 'donor',
    images: images('d'),
    bones: [bone('d-root', 'root', null, 0, 40), bone('d-arm', 'arm', 'd-root', 60, 90), bone('d-hand', 'hand', 'd-arm', 90, 30), bone('d-tail', 'tail', 'd-root', -60, 40)],
    attachments: [att('body', 'd-root', 'd-im-body', 0), att('arm', 'd-arm', 'd-im-arm', 45), att('hand', 'd-hand', 'd-im-hand', 20)],
    animations: [
      { id: 'd-wave', name: 'wave', duration: 1, fps: 10, loop: true, tracks: {
        'd-arm': { translate: [], rotate: [k(0, [0]), k(0.5, [-40]), k(1, [0])], scale: [] },
        'd-hand': { translate: [], rotate: [k(0, [10]), k(0.5, [-25])], scale: [] },
        'd-tail': { translate: [], rotate: [k(0, [0]), k(1, [30])], scale: [] },
      } },
      { id: 'd-bob', name: 'bob', duration: 0.5, fps: 10, loop: true, tracks: { 'd-root': { translate: [k(0, [0, 0]), k(0.5, [0, 12])], rotate: [], scale: [] } } },
    ],
  } as unknown as Project;
}

/** The stage project: different ids, a "wrist" instead of a "hand", a fixed delivery frame. */
function stage(): Project {
  return {
    format: 'rigsmith.project', version: 2, name: 'stage',
    images: images('s'),
    bones: [bone('s-root', 'root', null, 0, 40), bone('s-arm', 'arm', 's-root', 60, 90), bone('s-wrist', 'wrist', 's-arm', 90, 30)],
    attachments: [att('body', 's-root', 's-im-body', 0), att('arm', 's-arm', 's-im-arm', 45), att('hand', 's-wrist', 's-im-hand', 20)],
    animations: [
      { id: 's-idle', name: 'idle', duration: 1, fps: 10, loop: true, tracks: { 's-root': { translate: [k(0, [0, 0]), k(0.5, [0, 8]), k(1, [0, 0])], rotate: [], scale: [] } } },
      { id: 's-greeting', name: 'greeting', duration: 1, fps: 10, loop: false, tracks: { 's-arm': { translate: [], rotate: [k(0, [0]), k(0.4, [-80]), k(1, [0])], scale: [] } } },
      { id: 's-bob', name: 'bob', duration: 1, fps: 10, loop: true, tracks: {} },
    ],
    frame: { x: -100, y: -180, width: 320, height: 300 },
  } as unknown as Project;
}

const DONOR = path.join(OUT, 'donor.rig.json');
const STAGE = path.join(OUT, 'stage.rig.json');
writeFileSync(DONOR, serializeProject(donor()));
writeFileSync(STAGE, serializeProject(stage()));

const project = () => probe<any>(page, 'project');
const undoDepth = async () => (await probe<any>(page, 'state')).undo;
const status = () => page.getByTestId('status').innerText();

async function setField(testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function open(file: string, name: string): Promise<void> {
  await page.getByTestId('open-input').setInputFiles(file);
  await page.waitForFunction((n) => (window as any).__rigsmith.project().name === n, name);
}

async function download(click: () => Promise<void>, name: string): Promise<string> {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  const file = path.join(OUT, name);
  await dl.saveAs(file);
  return file;
}

function zipFrames(file: string): { pngs: Decoded[]; meta: any } {
  const files = readZip(readFileSync(file));
  const pngs = files.filter((f) => f.name.endsWith('.png')).sort((a, b) => a.name.localeCompare(b.name)).map((f) => decodePng(f.data));
  const meta = JSON.parse(files.find((f) => f.name.endsWith('sequence.json'))!.data.toString('utf8'));
  return { pngs, meta };
}

async function gotoFrame(frame: number, frames: number): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
}

/** Opens the donor file through the visible "Import anims…" button (a real file chooser). */
async function pickDonor(): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('import-anims').click()]);
  await chooser.setFiles(DONOR);
  await page.getByTestId('import-dialog').waitFor({ state: 'visible' });
}

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-motion-reuse');
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

describe('RV-009: import animations from another project with an explicit mapping', () => {
  it('the report lists unmatched bones before Import; Cancel changes nothing', async () => {
    await open(STAGE, 'stage');
    const before = await project();
    assert.equal(await page.getByTestId('import-anims-input').count(), 1, 'the hidden file input behind the button');
    await pickDonor();
    assert.deepEqual(await page.getByTestId('imp-anims').locator('input[type=checkbox]').count(), 2);
    assert.equal(await page.getByTestId('imp-anim-wave').isChecked(), true);
    assert.equal(await page.getByTestId('imp-anim-bob').isChecked(), true);
    // Defaults by name: root → root, arm → arm; hand and tail have no same-named bone.
    assert.equal(await page.getByTestId('imp-map-bone-root').inputValue(), 's-root');
    assert.equal(await page.getByTestId('imp-map-bone-arm').inputValue(), 's-arm');
    assert.equal(await page.getByTestId('imp-map-bone-hand').inputValue(), '');
    assert.equal(await page.getByTestId('imp-map-bone-tail').inputValue(), '');
    assert.match(await page.getByTestId('imp-map-bones').innerText(), /hand\s+2 key\(s\)/);
    assert.match(await page.getByTestId('imp-unmatched').innerText(), /^Unmatched \(not imported\): bone “hand” \(2 key\(s\)\); bone “tail” \(2 key\(s\)\)\.$/);
    assert.match(await page.getByTestId('imp-report').innerText(), /Will import: wave, bob as bob-2 — 5 key\(s\)\./);
    await page.screenshot({ path: path.join(OUT, 'import-report-defaults.png') });
    await page.getByTestId('imp-cancel').click();
    await page.getByTestId('import-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await project(), before, 'Cancel imports nothing');
  });

  it('mapping hand → wrist and choosing one animation: Import is one undo step, keys land on the mapped bones', async () => {
    await pickDonor();
    await page.getByTestId('imp-anim-bob').uncheck();
    assert.match(await page.getByTestId('imp-report').innerText(), /Will import: wave — 3 key\(s\)\./);
    await page.getByTestId('imp-map-bone-hand').selectOption({ label: 'wrist' });
    assert.match(await page.getByTestId('imp-unmatched').innerText(), /^Unmatched \(not imported\): bone “tail” \(2 key\(s\)\)\.$/);
    assert.match(await page.getByTestId('imp-report').innerText(), /Will import: wave — 5 key\(s\)\./);
    await page.screenshot({ path: path.join(OUT, 'import-report-mapped.png') });
    const u0 = await undoDepth();
    await page.getByTestId('imp-apply').click();
    await page.getByTestId('import-dialog').waitFor({ state: 'hidden' });
    assert.equal(await undoDepth(), u0 + 1, 'one undo step');
    assert.match(await status(), /^Imported from “donor”: 1 animation\(s\), 5 key\(s\) · 1 unmatched \(tail\) skipped\./);
    const p = await project();
    const wave = p.animations.find((a: any) => a.name === 'wave');
    const src = donor().animations[0].tracks;
    assert.deepEqual(wave.tracks['s-arm'], src['d-arm'], 'arm keys unchanged on the same-named bone');
    assert.deepEqual(wave.tracks['s-wrist'], src['d-hand'], 'hand keys on the explicitly mapped wrist');
    assert.deepEqual(Object.keys(wave.tracks).sort(), ['s-arm', 's-wrist'], 'tail keys not imported');
    assert.equal(await page.getByTestId('anim-select').locator('option:checked').innerText(), 'wave', 'the imported animation is shown');
    await page.getByTestId('undo').click();
    assert.ok(!(await project()).animations.some((a: any) => a.name === 'wave'), 'undo removes the import');
    await page.getByTestId('redo').click();
    assert.ok((await project()).animations.some((a: any) => a.name === 'wave'), 'redo restores it');
    assert.deepEqual(pageErrors, []);
  });
});

describe('RV-009: durable key clipboard', () => {
  it('copied keys survive a reload and paste into another project by bone name, with a report of what did not fit', async () => {
    await open(DONOR, 'donor');
    await page.getByTestId('anim-select').selectOption({ label: 'wave' });
    await page.getByTestId('mode-animate').click();
    await page.getByTestId('key-arm-rotate-5').click();
    await page.getByTestId('key-hand-rotate-5').click({ modifiers: ['Shift'] });
    await page.getByTestId('copy-keys').click();
    const stored = await waitUntil(() => readIdb(page, 'clipboard'), (v) => !!v, 5000, 'clipboard record');
    assert.equal(stored.format, 'rigsmith.keys');
    assert.equal(stored.project, 'donor');
    assert.equal(stored.items.length, 2);
    assert.deepEqual(stored.names.bones, { 'd-arm': 'arm', 'd-hand': 'hand' });

    await page.reload();
    await page.getByTestId('open-input').waitFor({ state: 'attached' });
    await open(STAGE, 'stage');
    await page.getByTestId('anim-select').selectOption({ label: 'greeting' });
    await page.getByTestId('mode-animate').click();
    await waitUntil(() => page.getByTestId('paste-keys').getAttribute('data-clip'), (v) => v === '2', 5000, 'clipboard restored after the reload');
    assert.match((await page.getByTestId('paste-keys').getAttribute('title'))!, /2 key\(s\) copied from “donor”/);
    await gotoFrame(7, 10);
    const u0 = await undoDepth();
    await page.getByTestId('paste-keys').click();
    assert.match(await status(), /^Pasted 1 key\(s\) at frame 7\. 1 key\(s\) not pasted: no bone “hand” in this project\.$/);
    assert.equal(await undoDepth(), u0 + 1);
    const arm = (await project()).animations.find((a: any) => a.name === 'greeting').tracks['s-arm'].rotate;
    assert.deepEqual(arm.map((x: any) => [Math.round(x.time * 10), x.value[0]]), [[0, 0], [4, -80], [7, -40], [10, 0]], 'the donor arm key (−40°) lands on “arm” at frame 7');
    await page.screenshot({ path: path.join(OUT, 'clipboard-pasted-across-projects.png') });
    await page.getByTestId('undo').click();
    assert.equal((await project()).animations.find((a: any) => a.name === 'greeting').tracks['s-arm'].rotate.length, 3);
    assert.deepEqual(pageErrors, []);
  });
});

describe('RV-009: saved clip sequences', () => {
  let zip: { pngs: Decoded[]; meta: any };

  it('builds idle×2 → greeting → idle with the visible controls; every edit is one undo step', async () => {
    await page.getByTestId('anim-select').selectOption({ label: 'idle' });
    await page.getByTestId('sequences-open').click();
    await page.getByTestId('sequence-dialog').waitFor({ state: 'visible' });
    assert.match(await page.getByTestId('seqd-empty').innerText(), /No saved sequences/);
    assert.equal(await page.getByTestId('seqd-select').isDisabled(), true);
    let u = await undoDepth();
    await page.getByTestId('seqd-new').click();
    assert.equal(await undoDepth(), ++u);
    await setField('seqd-name', 'intro');
    await setField('seqd-step-repeat-0', 2);
    await page.getByTestId('seqd-add-step').click();
    await page.getByTestId('seqd-step-anim-1').selectOption({ label: 'greeting' });
    await page.getByTestId('seqd-add-step').click();
    await setField('seqd-mix-1', 0.3);
    await setField('seqd-mix-2', 0.25);
    u += 7;
    assert.equal(await undoDepth(), u, 'name, repeat, add, clip, add, two mixes');
    assert.equal(await page.getByTestId('seqd-describe').innerText(), 'idle×2 → greeting → idle');
    // Reorder and back, add and remove, loop.
    await page.getByTestId('seqd-step-down-1').click();
    assert.equal(await page.getByTestId('seqd-describe').innerText(), 'idle×2 → idle → greeting');
    await page.getByTestId('seqd-step-up-2').click();
    await page.getByTestId('seqd-add-step').click();
    assert.equal(await page.getByTestId('seqd-steps').locator('li.seq-step').count(), 4);
    await page.getByTestId('seqd-step-remove-3').click();
    await page.getByTestId('seqd-loop').check();
    assert.equal(await undoDepth(), u + 5);
    assert.equal(await page.getByTestId('seqd-describe').innerText(), 'idle×2 → greeting → idle');
    const p = await project();
    assert.deepEqual(p.sequences.map((q: any) => ({ name: q.name, loop: q.loop, steps: q.steps })), [{ name: 'intro', loop: true, steps: [{ animId: 's-idle', repeat: 2 }, { animId: 's-greeting', repeat: 1 }, { animId: 's-idle', repeat: 1 }] }]);
    const rule = (from: string, to: string) => p.mixes.find((m: any) => m.from === from && m.to === to)?.duration;
    assert.deepEqual([rule('s-idle', 's-greeting'), rule('s-greeting', 's-idle')], [0.3, 0.25], 'mixes stored as project rules');
    // 10 fps: idle 10 frames × 2, greeting 10, idle 10.
    assert.equal(await page.getByTestId('seqd-summary').getAttribute('data-frames'), '40');
    assert.match(await page.getByTestId('seqd-summary').innerText(), /^40 frames \(idle×2 20 \+ greeting 10 \+ idle 10\) · 320×300 px · transparent · project frame · loops$/);
    assert.equal(await page.getByTestId('seqd-frame-warning').count(), 0);
    await page.getByTestId('seqd-time').fill('25');
    assert.equal(await page.getByTestId('seqd-canvas').getAttribute('data-frame'), '25');
    assert.equal(await page.getByTestId('seqd-time-label').innerText(), 'frame 25 · 2.500 s · greeting');
    await page.screenshot({ path: path.join(OUT, 'sequence-dialog.png') });
  });

  it('a recovery copy holds the sequence; the field rejects a bad repeat without an undo step', async () => {
    const copy = await waitUntil(() => readIdb(page, 'autosave'), (v) => !!v && /"sequences"/.test(v.project), 5000, 'autosave with sequences');
    assert.equal(JSON.parse(copy.project).sequences[0].name, 'intro');
    const u = await undoDepth();
    await setField('seqd-step-repeat-1', 0);
    assert.equal(await undoDepth(), u);
    assert.match(await status(), /Repeat must be a whole number from 1 to 100/);
    assert.equal(await page.getByTestId('seqd-step-repeat-1').inputValue(), '1');
  });

  it('ZIP export: frame count = sum of the clips; frames equal the Mix dialog’s idle → greeting export at the same switch', async () => {
    assert.equal(await page.getByTestId('seqd-frame').inputValue(), 'project');
    const file = await download(() => page.getByTestId('seqd-export').click(), 'intro-seq.zip');
    assert.equal(path.basename(file), 'intro-seq.zip');
    assert.match(await status(), /^Exported sequence “intro”: 40 frames \(320×300\) as stage-intro-10fps\.zip\./);
    zip = zipFrames(file);
    assert.equal(zip.pngs.length, 40);
    assert.equal(zip.meta.frame, 'project');
    assert.deepEqual(zip.meta.sequence.steps.map((s: any) => [s.animation, s.repeat, s.startFrame, s.frames, s.mix]), [['idle', 2, 0, 20, 0], ['greeting', 1, 20, 10, 0.3], ['idle', 1, 30, 10, 0.25]]);
    await page.getByTestId('seqd-close').click();

    await page.getByTestId('mix-open').click();
    await page.getByTestId('mix-from').selectOption({ label: 'idle' });
    await page.getByTestId('mix-to').selectOption({ label: 'greeting' });
    await setField('mix-start', 2);
    assert.equal(await page.getByTestId('mix-duration').inputValue(), '0.3', 'the Mix dialog reads the rule the sequence set');
    assert.equal(await page.getByTestId('mix-fps').inputValue(), '10');
    const mix = zipFrames(await download(() => page.getByTestId('mix-export').click(), 'idle-to-greeting-mix.zip'));
    await page.getByTestId('mix-close').click();
    assert.deepEqual([mix.meta.width, mix.meta.height], [zip.meta.width, zip.meta.height]);
    for (let i = 0; i < 30; i++) assert.ok(Buffer.from(zip.pngs[i].data).equals(Buffer.from(mix.pngs[i].data)), `sequence frame ${i} = mix frame ${i}`);
    assert.ok(!Buffer.from(zip.pngs[20].data).equals(Buffer.from(zip.pngs[24].data)), 'greeting moves the arm');
  });

  it('APNG export: same 40 frames (Pillow), 1/10 s each, loops because the sequence loops', async () => {
    await page.getByTestId('sequences-open').click();
    assert.equal(await page.getByTestId('seqd-select').inputValue(), (await project()).sequences[0].id);
    await page.getByTestId('seqd-format').selectOption('apng');
    assert.equal(await page.getByTestId('seqd-export').innerText(), 'Export APNG');
    const file = await download(() => page.getByTestId('seqd-export').click(), 'intro.apng');
    await page.getByTestId('seqd-progress-text').filter({ hasText: /encoding 40 \/ 40/ }).waitFor();
    assert.equal(await page.getByTestId('seqd-progress').evaluate((el) => (el as HTMLProgressElement).value), 1);
    const d = pillow(file);
    assert.deepEqual([d.info.frames, d.info.width, d.info.height, d.info.loop], [40, 320, 300, 0]);
    d.info.durations.forEach((ms: number) => assert.ok(Math.abs(ms - 100) < 1e-6));
    d.frames.forEach((f, i) => assert.deepEqual(f, zip.pngs[i].data, `APNG frame ${i} = ZIP frame ${i}`));
  });

  it('GIF over 50 fps and an out-of-range scale are refused with a visible error; half scale halves the frame; Fit drops the project frame', async () => {
    await page.getByTestId('seqd-format').selectOption('gif');
    await setField('seqd-fps', 60);
    assert.match(await page.getByTestId('seqd-errors').innerText(), /50/);
    assert.equal(await page.getByTestId('seqd-export').isDisabled(), true);
    await setField('seqd-fps', 10);
    await page.getByTestId('seqd-format').selectOption('zip');
    // Scale: the project frame scales with it; out of range is refused.
    await setField('seqd-scale', 0.5);
    assert.match(await page.getByTestId('seqd-summary').innerText(), / · 160×150 px · /);
    await setField('seqd-scale', 9);
    assert.match(await page.getByTestId('seqd-errors').innerText(), /Scale must be greater than 0 and at most 8/);
    await setField('seqd-scale', 1);
    assert.match(await page.getByTestId('seqd-summary').innerText(), / · 320×300 px · /);
    await page.getByTestId('seqd-frame').selectOption('fit');
    assert.ok(!/project frame/.test(await page.getByTestId('seqd-summary').innerText()));
    await page.getByTestId('seqd-frame').selectOption('project');
  });

  it('a second sequence can be selected and deleted (undoable); deleting the animation repairs the sequence', async () => {
    await page.getByTestId('seqd-new').click();
    assert.equal(await page.getByTestId('seqd-name').inputValue(), 'sequence');
    await page.getByTestId('seqd-select').selectOption({ label: 'intro' });
    assert.equal(await page.getByTestId('seqd-describe').innerText(), 'idle×2 → greeting → idle');
    await page.getByTestId('seqd-select').selectOption({ label: 'sequence' });
    await page.getByTestId('seqd-delete').click();
    assert.deepEqual((await project()).sequences.map((q: any) => q.name), ['intro']);
    assert.equal(await page.getByTestId('seqd-name').inputValue(), 'intro');
    await page.getByTestId('seqd-close').click();
    await page.getByTestId('undo').click();
    assert.deepEqual((await project()).sequences.map((q: any) => q.name), ['intro', 'sequence']);
    await page.getByTestId('redo').click();

    // Deleting "greeting" removes its step from the saved sequence, as one undoable edit.
    await page.getByTestId('anim-select').selectOption({ label: 'greeting' });
    await page.getByRole('button', { name: 'Delete animation' }).click();
    assert.match(await status(), /Sequence “intro”: 1 step\(s\) removed \(their animation was deleted\)\./);
    assert.deepEqual((await project()).sequences[0].steps.map((s: any) => s.animId), ['s-idle', 's-idle']);
    await page.getByTestId('undo').click();
    assert.deepEqual((await project()).sequences[0].steps.map((s: any) => s.animId), ['s-idle', 's-greeting', 's-idle']);
    assert.deepEqual(pageErrors, []);
  });
});
