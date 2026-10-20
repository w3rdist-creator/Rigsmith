// Control coverage: every visible control the earlier suites did not touch gets at
// least one real interaction with an asserted effect (scripts/roadmap/testid-audit.ts
// fails the gates if a test id is never referenced). Visible controls only;
// window.__rigsmith is read-only (assertions).
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { decodePng } from '../support/png-decode.ts';
import { writeTestArt } from '../support/png-encode.ts';
import { diffImages } from '../support/reference-composite.ts';
import { EVIDENCE, ROOT, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/controls');
mkdirSync(path.join(OUT, 'art'), { recursive: true });
const art = writeTestArt(path.join(OUT, 'art'));

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let base: string;
const pageErrors: string[] = [];
type Pt = { x: number; y: number };
const state = () => probe<any>(page, 'state');
const project = () => probe<any>(page, 'project');
const near = (a: number, b: number, eps: number, msg: string) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≈ ${b} ±${eps}`);
const byName = (list: any[], name: string) => list.find((x: any) => x.name === name);

async function fresh(): Promise<void> {
  if (page) await page.close();
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(base);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
  if (await page.getByTestId('recovery-discard').isVisible()) await page.getByTestId('recovery-discard').click();
}

async function demo(): Promise<void> {
  await fresh();
  await page.getByTestId('empty-demo').click();
  await page.waitForFunction(() => (window as any).__rigsmith.state().playing === true);
  await page.getByTestId('play').click();
}

async function setField(testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function gotoFrame(frame: number): Promise<void> {
  const name = (await state()).animName;
  const anim = byName((await project()).animations, name);
  const frames = Math.round(anim.duration * anim.fps);
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
}

async function drag(from: Pt, to: Pt, mods: { shift?: boolean; during?: () => Promise<void> } = {}): Promise<void> {
  if (mods.shift) await page.keyboard.down('Shift');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  if (mods.during) await mods.during();
  await page.mouse.up();
  if (mods.shift) await page.keyboard.up('Shift');
}

async function exportPng(file: string) {
  const dl = page.waitForEvent('download');
  await page.getByTestId('export-png').click();
  const target = path.join(OUT, file);
  await (await dl).saveAs(target);
  return decodePng(readFileSync(target));
}

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  base = `http://127.0.0.1:${port}/`;
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-controls');
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('panels, toolbar and transport controls', () => {
  it('empty states; Demo / New / Open… / Import… from visible buttons', async () => {
    await fresh();
    for (const id of ['empty-skeleton', 'empty-images', 'timeline-empty', 'constraints-panel', 'inspector', 'timeline']) await page.getByTestId(id).waitFor();
    assert.equal(await page.getByTestId('mode-badge').innerText(), 'SETUP');
    await page.getByTestId('load-demo').click();
    await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length === 12);
    assert.match(await page.getByTestId('mode-badge').innerText(), /ANIMATE/);
    for (const id of ['bone-tree', 'image-list', 'curve-panel', 'playhead']) await page.getByTestId(id).waitFor();
    await page.getByTestId('play').click();
    await page.getByTestId('new-project').click();
    await page.getByTestId('empty-skeleton').waitFor();
    assert.equal((await project()).bones.length, 0, 'New gives an empty rig');
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('open-project').click();
    await (await chooser).setFiles(path.join(ROOT, 'tests/fixtures/legacy-v1.rig.json'));
    await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length > 0);
    const imgChooser = page.waitForEvent('filechooser');
    await page.getByTestId('import-images').click();
    await (await imgChooser).setFiles(art['badge.png']);
    await page.getByTestId('image-badge.png').waitFor();
  });

  it('bone/attachment setup fields, Key bone, frame stepping, playhead, nudge, marquee, onion settings, Delete', async () => {
    await demo();
    await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-bone-arm-front').click();
    await setField('bone-length', 55);
    await setField('bone-y', 3);
    let arm = byName((await project()).bones, 'arm-front');
    assert.deepEqual([arm.length, arm.y], [55, 3]);
    await page.getByTestId('tree-att-head').click();
    await setField('att-name', 'head-renamed');
    await page.getByTestId('tree-att-head-renamed').waitFor();
    await setField('att-name', 'head');
    await page.getByTestId('tree-att-head').waitFor();
    const order = async () => (await project()).attachments.map((a: any) => a.name);
    const i0 = (await order()).indexOf('head');
    await page.getByTestId('att-backward').click();
    assert.equal((await order()).indexOf('head'), i0 - 1);
    await page.getByTestId('att-forward').click();
    assert.equal((await order()).indexOf('head'), i0);
    await page.getByTestId('att-bone').selectOption({ label: 'torso' });
    await page.getByTestId('att-image').selectOption({ label: 'tock-windup-key.png' });
    await setField('att-opacity', 0.5);
    await setField('att-scale-x', 2);
    await setField('att-scale-y', 1.5);
    let head = byName((await project()).attachments, 'head');
    const p = await project();
    assert.equal(head.boneId, byName(p.bones, 'torso').id);
    assert.equal(head.imageId, byName(p.images, 'tock-windup-key.png').id);
    assert.deepEqual([head.opacity, head.scaleX, head.scaleY], [0.5, 2, 1.5]);
    await page.getByTestId('att-hidden').check();
    head = byName((await project()).attachments, 'head');
    assert.equal(head.hidden, true);
    assert.equal(byName(await probe<any[]>(page, 'frame'), 'head').visible, false, 'hidden in setup');
    await page.getByTestId('att-hidden').uncheck();
    assert.equal(byName((await project()).attachments, 'head').hidden, undefined);

    await page.getByTestId('mode-animate').click();
    await page.getByTestId('tree-bone-arm-front').click();
    await gotoFrame(5);
    await page.getByTestId('key-selected').click();
    arm = byName((await project()).bones, 'arm-front');
    const tr = (await project()).animations[0].tracks[arm.id];
    for (const ch of ['translate', 'rotate', 'scale']) assert.ok(tr[ch].some((k: any) => Math.round(k.time * 30) === 5), `${ch} keyed at f5`);
    await page.getByTestId('next-frame').click();
    near((await state()).time, 6 / 30, 1e-9, 'next frame');
    const left = await page.getByTestId('playhead').evaluate((el) => (el as HTMLElement).style.left);
    near(parseFloat(left), (6 / 30) * 100, 1e-6, 'playhead at 20%');
    await page.getByTestId('prev-frame').click();
    near((await state()).time, 5 / 30, 1e-9, 'previous frame');
    await page.getByTestId('key-arm-front-rotate-5').click();
    await page.getByTestId('nudge-left').click();
    assert.ok((await project()).animations[0].tracks[arm.id].rotate.some((k: any) => Math.round(k.time * 30) === 4), 'nudged to f4');
    await page.keyboard.press('Escape');
    assert.equal((await state()).keySels.length, 0, 'Esc cleared the key selection');
    const k = (await page.getByTestId('key-arm-front-rotate-4').boundingBox())!;
    await drag({ x: k.x - 14, y: k.y - 8 }, { x: k.x + k.width + 14, y: k.y + k.height + 8 }, {
      shift: true,
      during: async () => void (await page.getByTestId('key-marquee').waitFor()),
    });
    const sel = (await state()).keySels;
    assert.ok(sel.length > 0 && sel.every((r: any) => Math.round(r.time * 30) === 4), `marquee selected the f4 keys (${JSON.stringify(sel)})`);
    await page.getByTestId('onion-toggle').check();
    await setField('onion-after', 3);
    await setField('onion-step', 4);
    const o = (await state()).onion;
    assert.deepEqual([o.after, o.step], [3, 4]);
    await page.keyboard.press('Escape');
    await page.getByTestId('tree-bone-windup-key').click();
    const n = (await project()).bones.length;
    await page.getByTestId('delete-selection').click();
    assert.equal((await project()).bones.length, n - 1, 'Delete removed the bone');
    assert.equal(byName((await project()).attachments, 'key').boneId, byName((await project()).bones, 'torso').id, 'its image moved to the parent');
  });

  it('slot key toggles add and remove keys at the current frame', async () => {
    await demo();
    await gotoFrame(7);
    await page.getByTestId('tree-att-head').click();
    for (const [ch, toggle] of [['visible', 'slot-key-visible'], ['opacity', 'slot-key-opacity'], ['image', 'slot-key-image']]) {
      await page.getByTestId(toggle).click();
      await page.getByTestId(`key-head-${ch}-7`).waitFor();
      await page.getByTestId(toggle).click();
      await page.getByTestId(`key-head-${ch}-7`).waitFor({ state: 'detached' });
    }
    const a = (await project()).animations[0];
    assert.ok(!a.slots || Object.values(a.slots).every((s: any) => !s.visible?.length && !s.opacity?.length && !s.image?.length), 'all removed');
  });

  it('export dialog: skin selector, summary and progress', async () => {
    await page.getByTestId('export-sequence').click();
    assert.equal(await page.getByTestId('seq-skin').inputValue(), '', 'no skin');
    assert.match(await page.getByTestId('seq-summary').innerText(), /^30 frames · \d+×\d+ px/);
    const dl = page.waitForEvent('download');
    await page.getByTestId('seq-export').click();
    await dl;
    near(Number(await page.getByTestId('seq-progress').getAttribute('value') ?? (await page.getByTestId('seq-progress').evaluate((el) => (el as HTMLProgressElement).value))), 1, 1e-9, 'progress complete');
    await page.keyboard.press('Escape');
  });
});

describe('constraint and path controls', () => {
  it('IK: 1-bone IK, chain text, rename, target select, navigation links, delete; root cannot take 2-bone IK', async () => {
    await demo();
    await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-bone-root').click();
    assert.equal(await page.getByTestId('ik-add-2').isDisabled(), true, 'root has no parent');
    await page.getByTestId('tree-bone-arm-back').click();
    await page.getByTestId('ik-add-1').click();
    let p = await project();
    assert.equal(p.ik.length, 1);
    assert.deepEqual(p.ik[0].bones, [byName(p.bones, 'arm-back').id]);
    await page.getByTestId('constraint-list').waitFor();
    assert.equal(await page.getByTestId('ik-chain').innerText(), 'Chain: arm-back');
    await setField('constraint-name', 'aim-back');
    await page.getByTestId('ik-target').selectOption({ label: 'head' });
    p = await project();
    assert.equal(p.ik[0].name, 'aim-back');
    assert.equal(p.ik[0].target, byName(p.bones, 'head').id);
    await page.getByTestId('goto-ik-target').click();
    assert.deepEqual((await state()).selection, { kind: 'bone', id: byName(p.bones, 'head').id });
    await page.getByTestId('tree-bone-arm-back').click();
    await page.getByTestId('goto-constraint-aim-back').click();
    assert.equal((await state()).selection.kind, 'constraint');
    const nb = p.bones.length;
    await page.getByTestId('constraint-delete').click();
    p = await project();
    assert.equal(p.ik, undefined, 'constraint removed');
    assert.equal(p.bones.length, nb, 'bones kept');
  });

  it('paths: rename, add/remove node, node X/Y fields, spacing/rotate/mix/path fields, delete via button and key', async () => {
    await page.keyboard.press('Escape');
    await page.getByTestId('add-path').click();
    await setField('path-name', 'rail');
    await page.getByTestId('path-add-node').click();
    let p = await project();
    assert.equal(p.paths[0].name, 'rail');
    assert.equal(p.paths[0].nodes.length, 4);
    await setField('path-node-x', 42);
    await setField('path-node-y', -7);
    p = await project();
    assert.deepEqual([p.paths[0].nodes[0].x, p.paths[0].nodes[0].y], [42, -7]);
    await page.getByTestId('path-remove-node').click();
    assert.equal((await project()).paths[0].nodes.length, 3);
    await page.getByTestId('pc-bone-windup-key').check();
    await page.getByTestId('path-constrain').click();
    await setField('pc-spacing', 25);
    await page.getByTestId('pc-rotate').uncheck();
    await setField('pc-mix', 0.5);
    p = await project();
    assert.deepEqual([p.pathConstraints[0].spacing, p.pathConstraints[0].rotate, p.pathConstraints[0].mix], [25, false, 0.5]);
    await page.keyboard.press('Escape');
    await page.getByTestId('add-path').click();
    await page.getByTestId(`tree-constraint-${p.pathConstraints[0].name}`).click();
    await page.getByTestId('pc-path').selectOption({ label: 'path' });
    p = await project();
    const second = byName(p.paths, 'path');
    assert.equal(p.pathConstraints[0].pathId, second.id);
    await page.getByTestId('tree-path-path').click();
    await page.getByTestId('path-delete').click();
    p = await project();
    assert.equal(p.paths.length, 1);
    assert.equal(p.pathConstraints, undefined, 'its constraint went with it');
    await page.getByTestId('tree-path-rail').click();
    await page.getByTestId('stage').focus();
    await page.keyboard.press('Delete');
    assert.equal((await project()).paths, undefined, 'Delete key removes the selected path');
  });
});

describe('cutout dialog extras', () => {
  it('undo point / clear / rectangle / pick colour / joint extension behind the source / bone parent / keep source', async () => {
    await fresh();
    await page.getByTestId('image-input').setInputFiles([art['limb.png']]);
    await page.getByTestId('image-limb.png').waitFor();
    await page.getByTestId('add-bone').click();
    await setField('bone-name', 'upper');
    await setField('bone-rotation', 0);
    await page.getByTestId('attach-limb.png').click();
    const before = await exportPng('ext-before.png');
    await page.getByTestId('att-cutout').click();
    const c = page.getByTestId('cutout-canvas');
    await c.waitFor({ state: 'visible' }); // the dialog lays out before its box is read
    const box = (await c.boundingBox())!;
    const s = Number(await c.getAttribute('data-scale')), ox = Number(await c.getAttribute('data-ox')), oy = Number(await c.getAttribute('data-oy'));
    const at = (x: number, y: number) => ({ x: box.x + ox + x * s, y: box.y + oy + y * s });
    for (const [x, y] of [[20, 10], [40, 10], [30, 30]]) {
      const q = at(x, y);
      await page.mouse.click(q.x, q.y);
    }
    assert.match(await page.getByTestId('cut-summary').innerText(), /^3 point/);
    await page.getByTestId('cut-undo-point').click();
    assert.match(await page.getByTestId('cut-summary').innerText(), /^2 point/);
    await page.getByTestId('cut-clear').click();
    assert.match(await page.getByTestId('cut-summary').innerText(), /^0 point/);
    await page.getByTestId('cut-mode-rect').click();
    await drag(at(100, 0.5), at(199, 43.5));
    assert.match(await page.getByTestId('cut-summary').innerText(), /^4 point/);
    await page.getByTestId('cut-mode-pick').click();
    const orange = at(150, 22);
    await page.mouse.click(orange.x, orange.y);
    const picked = await page.getByTestId('cut-patch-color').inputValue();
    assert.notEqual(picked, '#808080', 'colour picked from the art');
    assert.ok(parseInt(picked.slice(1, 3), 16) > 150, `orange-ish red channel (${picked})`);
    assert.equal(await page.getByTestId('cut-patch').isChecked(), true, 'picking enables the patch');
    await page.getByTestId('cut-patch').uncheck();
    await page.getByTestId('cut-mode-pivot').click();
    const pv = at(100, 22);
    await page.mouse.click(pv.x, pv.y);
    await setField('cut-extend', 12);
    assert.equal(await page.getByTestId('cut-behind').isChecked(), true, 'extension defaults to behind');
    await page.getByTestId('cut-remainder').uncheck();
    await page.getByTestId('cut-parent').selectOption({ label: 'upper' });
    await page.getByTestId('cut-apply').click();
    await page.getByTestId('cutout-dialog').waitFor({ state: 'hidden' });
    const p = await project();
    const limbImg = byName(p.images, 'limb.png');
    assert.equal(byName(p.attachments, 'limb').imageId, limbImg.id, 'source kept on its attachment');
    const piece = p.images.find((i: any) => i.derived);
    assert.equal(piece.derived.kind, 'extension');
    assert.ok(piece.derived.synthesized > 100, `extension synthesized ${piece.derived.synthesized} px`);
    assert.equal(piece.derived.offsetX, 88, 'grew 12 px back past the cut at x = 100');
    const names = p.attachments.map((a: any) => a.name);
    assert.ok(names.indexOf('piece') < names.indexOf('limb') || names.indexOf('limb-piece') < names.indexOf('limb'), `piece behind the source (${names})`);
    const bone = p.bones.find((b: any) => b.parentId === byName(p.bones, 'upper').id);
    assert.ok(bone, 'joint bone under the chosen parent');
    const afterImg = await exportPng('ext-after.png');
    // Keeping the source and adding a duplicate piece behind it legitimately thickens the
    // source's semi-transparent edges (alpha compounds); everywhere the source is opaque —
    // including over the hidden extension — the render must be unchanged.
    const d = diffImages(afterImg, before, 24);
    let opaqueChanged = 0;
    for (let i = 0; i < before.data.length; i += 4) {
      if (before.data[i + 3] < 250) continue;
      for (let c = 0; c < 4; c++) if (Math.abs(afterImg.data[i + c] - before.data[i + c]) > 2) {
        opaqueChanged++;
        break;
      }
    }
    assert.equal(opaqueChanged, 0, `opaque pixels unchanged (edge-only diff ${JSON.stringify(d)})`);
  });

  it('raised no uncaught page errors', () => {
    assert.deepEqual(pageErrors, []);
  });
});
