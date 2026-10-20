// RV-012: guided flat-art onboarding — the "Flat-art guide…" checklist driven end to end
// through its visible buttons on an original procedural figure: import → root + attach →
// remove specks → limb cuts (guide preset) → hand by colour → grid mesh + weights → first
// idle, then undo/redo of a step, the exported idle frames, and autosave recovery.
// window.__rigsmith is read-only (assertions).
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { decodePng } from '../support/png-decode.ts';
import { encodePng } from '../support/png-encode.ts';
import { readZip } from '../support/zip-read.ts';
import { cutoutGeometry, EVIDENCE, launchIsolated, pickPort, probe, startPreview, waitUntil } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/rv012-onboarding');
mkdirSync(OUT, { recursive: true });

// 240×320 figure: body, an arm stick touching the body at x = 90, a white hand with a dark
// outline touching the stick at x = 45, a leg touching the body at y = 220, faint far specks.
const W = 240, H = 320;
type R = { x: number; y: number; w: number; h: number };
const BODY: R = { x: 90, y: 40, w: 60, h: 180 }, ARM: R = { x: 45, y: 80, w: 45, h: 14 }, HAND: R = { x: 25, y: 74, w: 20, h: 26 }, LEG: R = { x: 100, y: 220, w: 16, h: 80 };
const inR = (r: R, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const SPECKS: [number, number][] = [[5, 310], [230, 10], [210, 300]];
const SRC = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const edge = inR(HAND, x, y) && (x === HAND.x || y === HAND.y || y === HAND.y + HAND.h - 1);
    const c = inR(BODY, x, y) ? [60, 90, 200, 255] : inR(ARM, x, y) ? [220, 180, 140, 255] : edge ? [20, 20, 20, 255] : inR(HAND, x, y) ? [250, 250, 250, 255] : inR(LEG, x, y) ? [50, 50, 60, 255] : [0, 0, 0, 0];
    SRC.set(c, (y * W + x) * 4);
  }
for (const [x, y] of SPECKS) SRC.set([10, 10, 10, 40], (y * W + x) * 4);
const ART = path.join(OUT, 'figure.png');
writeFileSync(ART, encodePng(W, H, SRC));

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const state = () => probe<any>(page, 'state');
const project = () => probe<any>(page, 'project');
const undoDepth = async () => (await state()).undo;
const stepDone = (id: string) => page.getByTestId(`guide-step-${id}`).getAttribute('data-done');
const status = () => page.getByTestId('status').innerText();

async function setField(testId: string, v: string | number): Promise<void> {
  await page.getByTestId(testId).fill(String(v));
  await page.getByTestId(testId).press('Enter');
}

/** Clicks image pixel coordinates on the cutout canvas (exact; the dialog rounds to 0.1). */
async function cutCanvas(): Promise<(x: number, y: number) => Promise<void>> {
  // The selection tools need the exact source pixels, decoded asynchronously on open.
  const { box, s, ox, oy } = await cutoutGeometry(page);
  return (x, y) => page.mouse.click(box.x + ox + x * s, box.y + oy + y * s);
}

async function applyCut(): Promise<void> {
  const u0 = await undoDepth();
  await page.getByTestId('cut-apply').click();
  await page.getByTestId('cutout-dialog').waitFor({ state: 'hidden' });
  assert.equal(await undoDepth(), u0 + 1, 'a cut is one undo step');
}

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-rv012-onboarding');
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

describe('RV-012: flat-art guide', () => {
  it('opens on an empty project with nothing done; later steps are disabled until their inputs exist', async () => {
    await page.getByTestId('guide-open').click();
    await page.getByTestId('guide-dialog').waitFor({ state: 'visible' });
    assert.match(await page.getByTestId('guide-progress').innerText(), /^0 of 5 required steps done\./);
    for (const id of ['import', 'rig', 'clean', 'limbs', 'colour', 'mesh', 'idle']) assert.equal(await stepDone(id), 'false', id);
    for (const id of ['guide-rig', 'guide-clean', 'guide-limb', 'guide-colour', 'guide-mesh', 'guide-idle']) assert.equal(await page.getByTestId(id).isDisabled(), true, id);
    assert.match(await page.getByTestId('guide-dialog').innerText(), /hidden joint extension they synthesise differs from a hand-prepared one/, 'the RV-010 limits are stated');
    assert.ok(!/Wiz/.test(await page.getByTestId('guide-dialog').innerText()), 'no private test vocabulary (LP-012)');
  });

  it('import and rig: Choose PNG… uses the image picker; Create root bone + attach is one undo step', async () => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('guide-import').click();
    await (await chooser).setFiles(ART);
    await page.getByTestId('image-figure.png').waitFor();
    await waitUntil(() => stepDone('import'), (v) => v === 'true', 5000, 'import step done');
    const u0 = await undoDepth();
    await page.getByTestId('guide-rig').click();
    assert.equal(await undoDepth(), u0 + 1);
    assert.equal(await stepDone('rig'), 'true');
    assert.equal(await page.getByTestId('guide-rig').isDisabled(), true, 'done');
    const p = await project();
    assert.deepEqual(p.bones.map((b: any) => [b.name, b.parentId]), [['root', null]]);
    assert.deepEqual(p.attachments.map((a: any) => [a.name, a.boneId === p.bones[0].id, a.x, a.y]), [['figure', true, 0, 0]]);
    assert.match(await status(), /“figure” is on the root bone/);
  });

  it('clean: the guide opens the cut dialog with its note; Remove specks makes a cleaned copy', async () => {
    await page.getByTestId('guide-clean').click();
    await page.getByTestId('cutout-dialog').waitFor({ state: 'visible' });
    assert.match(await page.getByTestId('cut-guide-hint').innerText(), /Remove specks/);
    await page.waitForFunction(() => !/Counting/.test(document.querySelector('[data-testid="cut-speck-count"]')?.textContent ?? 'Counting'));
    assert.equal(await page.getByTestId('cut-speck-count').innerText(), `${SPECKS.length} speck px in figure.png`);
    const u0 = await undoDepth();
    await page.getByTestId('cut-despeckle').click();
    await waitUntil(undoDepth, (n) => n === u0 + 1, 5000, 'despeckle undo step');
    await page.getByTestId('cut-cancel').click();
    assert.equal(await stepDone('clean'), 'true');
    const p = await project();
    assert.ok(p.images.some((i: any) => i.name === 'figure.png' && !i.derived), 'the original is kept');
  });

  it('limbs: the guide preset (outline, overlap 0, extend 40, note) cuts the arm and the leg with joint bones', async () => {
    const cutLimb = async (name: string, poly: [number, number][], pivot: [number, number]) => {
      await page.getByTestId('guide-limb').click();
      await page.getByTestId('cutout-dialog').waitFor({ state: 'visible' });
      assert.equal(await page.getByTestId('cut-mode-polygon').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByTestId('cut-overlap').inputValue(), '0');
      assert.equal(await page.getByTestId('cut-extend').inputValue(), '40');
      assert.match(await page.getByTestId('cut-guide-hint').innerText(), /at most 64 px/);
      const click = await cutCanvas();
      for (const [x, y] of poly) await click(x, y);
      await page.getByTestId('cut-mode-pivot').click();
      await click(...pivot);
      await setField('cut-name', name);
      await applyCut();
    };
    await cutLimb('arm', [[45, 78], [90, 78], [90, 96], [45, 96]], [90, 87]);
    assert.equal(await stepDone('limbs'), 'true');
    assert.match(await page.getByTestId('guide-step-limbs').innerText(), /1 outline cut\(s\): arm\./);
    await cutLimb('leg', [[98, 220], [118, 220], [118, 302], [98, 302]], [108, 220]);
    assert.match(await page.getByTestId('guide-step-limbs').innerText(), /2 outline cut\(s\): arm, leg\./);
    const p = await project();
    for (const n of ['arm', 'leg']) {
      const im = p.images.find((i: any) => i.name === `figure-clean-${n}.png` || i.name.endsWith(`-${n}.png`));
      assert.ok(im, `${n} piece image`);
      assert.equal(im.derived.kind, 'extension', `${n}: extended under the joint`);
      assert.ok(im.derived.synthesized > 0 && im.derived.synthesized <= 40 * 20, `${n}: ${im.derived.synthesized} px synthesized`);
      assert.ok(im.derived.polygon.length === 8);
    }
    assert.deepEqual(p.bones.map((b: any) => b.name).sort(), ['arm', 'leg', 'root']);
  });

  it('colour: the guide preset (Select colour, tolerance 255) takes the whole outlined hand in one click', async () => {
    await page.getByTestId('guide-colour').click();
    await page.getByTestId('cutout-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.getByTestId('cut-mode-wand').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByTestId('cut-tolerance').inputValue(), '255');
    assert.equal(await page.getByTestId('cut-overlap').inputValue(), '0');
    assert.match(await page.getByTestId('cut-guide-hint').innerText(), /tolerance 255/);
    const click = await cutCanvas();
    await click(35.5, 87.5);
    assert.match(await page.getByTestId('cut-summary').innerText(), new RegExp(`^selection ${HAND.w * HAND.h} px · ${HAND.w}×${HAND.h} px at ${HAND.x},${HAND.y}`), 'fill + dark outline, nothing else');
    await page.getByTestId('cut-mode-pivot').click();
    await click(45, 87);
    await page.getByTestId('cut-parent').selectOption({ label: 'arm' });
    await setField('cut-name', 'hand');
    await applyCut();
    assert.equal(await stepDone('colour'), 'true');
    const p = await project();
    const hand = p.bones.find((b: any) => b.name === 'hand');
    assert.equal(hand.parentId, p.bones.find((b: any) => b.name === 'arm').id);
    assert.match(await page.getByTestId('guide-progress').innerText(), /^3 of 5 required steps done · 2 optional\./);
  });

  it('the cut dialog opens scrolled to the top and keeps its scroll and canvas position while points are clicked', async () => {
    // Found by the guide's real-art run (scripts/roadmap/wiz-guide-rv012.ts): the dialog is
    // taller than the window, kept the scroll offset of its previous use, and moved after
    // the first click, so every later outline point landed off. Replays that sequence.
    // At this window height the dialog scrolls and reaching Cancel scrolls it down.
    await page.setViewportSize({ width: 1440, height: 1100 });
    try {
      const canvas = page.getByTestId('cutout-canvas');
      const dlgScroll = () => page.getByTestId('cutout-dialog').evaluate((d) => d.scrollTop);
      const toBottom = async () => {
        const b = (await canvas.boundingBox())!;
        await page.mouse.move(b.x + 10, b.y + b.height - 10);
        await page.mouse.wheel(0, 5000);
        await waitUntil(dlgScroll, (v) => v > 0, 3000, 'dialog scrolled by the wheel');
      };
      await page.getByTestId('guide-clean').click();
      await canvas.waitFor();
      await page.getByTestId('cut-cancel').click();
      await page.getByTestId('guide-limb').click();
      await canvas.waitFor();
      await page.waitForFunction(() => !/Counting/.test(document.querySelector('[data-testid="cut-speck-count"]')?.textContent ?? 'Counting'));
      assert.equal(await dlgScroll(), 0, 'reopened scrolled to the top, not at the previous offset');
      const click = await cutCanvas();
      const b0 = (await canvas.boundingBox())!;
      for (const [x, y] of [[150, 20], [200, 20], [200, 60]] as const) await click(x, y);
      assert.deepEqual(await canvas.boundingBox(), b0, 'canvas did not move under the pointer');
      assert.match(await page.getByTestId('cut-summary').innerText(), /^3 point\(s\) · outline 50×40 px at 150,20/);
      await page.getByTestId('cut-clear').click();
      await toBottom();
      const scrolled = await dlgScroll();
      const b1 = (await canvas.boundingBox())!;
      const click2 = await cutCanvas();
      for (const [x, y] of [[150, 260], [200, 260], [200, 300]] as const) await click2(x, y);
      assert.equal(await dlgScroll(), scrolled, 'a scrolled dialog keeps its offset across re-renders');
      assert.deepEqual(await canvas.boundingBox(), b1);
      assert.match(await page.getByTestId('cut-summary').innerText(), /^3 point\(s\) · outline 50×40 px at 150,260/);
      const p0 = await project();
      await page.getByTestId('cut-cancel').click();
      assert.deepEqual(await project(), p0, 'cancel changes nothing');
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  it('mesh: the grid inputs and Mesh + weigh build a weighted mesh on the body in one undo step', async () => {
    await setField('guide-grid-cols', 3);
    await setField('guide-grid-rows', 5);
    const u0 = await undoDepth();
    await page.getByTestId('guide-mesh').click();
    assert.equal(await undoDepth(), u0 + 1);
    assert.equal(await stepDone('mesh'), 'true');
    const p = await project();
    const body = p.attachments.find((a: any) => a.name === 'figure');
    assert.ok(body.mesh?.weights?.length === body.mesh.points.length / 2, 'every vertex weighted');
    const used = new Set(body.mesh.weights.flat().map((w: any) => p.bones.find((b: any) => b.id === w.bone).name));
    assert.ok(used.has('root'), `weights use the root (${[...used]})`);
    assert.match(await status(), /meshed \(3×5 grid, \d+ vertices\), weighted to /);
  });

  it('idle: Create idle adds a 2 s loop where the arm side sways and the leg stays; undo/redo reopen and redo the step', async () => {
    const u0 = await undoDepth();
    await page.getByTestId('guide-idle').click();
    assert.equal(await undoDepth(), u0 + 1);
    assert.equal(await stepDone('idle'), 'true');
    assert.equal((await state()).animName, 'idle');
    assert.match(await status(), /“idle” created — root bob, sway on arm, hand\./);
    const p = await project();
    const an = p.animations.find((a: any) => a.name === 'idle');
    const id = (n: string) => p.bones.find((b: any) => b.name === n).id;
    assert.deepEqual([an.duration, an.loop], [2, true]);
    assert.ok(an.tracks[id('arm')] && an.tracks[id('hand')] && !an.tracks[id('leg')], 'upper bones sway, the leg is planted');
    assert.match(await page.getByTestId('guide-progress').innerText(), /^5 of 5 required steps done · 2 optional\./);
    await page.getByTestId('guide-dialog').screenshot({ path: path.join(OUT, 'guide-complete.png') });

    await page.getByTestId('undo').click();
    assert.equal(await stepDone('idle'), 'false', 'undo shows the step open again');
    assert.equal(await stepDone('mesh'), 'true');
    await page.getByTestId('redo').click();
    assert.equal(await stepDone('idle'), 'true');

    // While the idle plays, the checklist is not rebuilt per frame: its controls still act.
    if ((await state()).animName !== 'idle') await page.getByTestId('anim-select').selectOption({ label: 'idle' });
    await page.getByTestId('play').click();
    await page.waitForFunction(() => (window as any).__rigsmith.state().time > 0.2);
    await page.screenshot({ path: path.join(OUT, 'guide-open-playing.png') });
    await setField('guide-grid-cols', 4);
    const u1 = await undoDepth();
    await page.getByTestId('guide-mesh').click();
    assert.equal(await undoDepth(), u1 + 1, 'Re-mesh + weigh acted during playback');
    assert.match(await status(), /meshed \(4×5 grid/);
    await page.getByTestId('guide-close').click();
    await page.getByTestId('guide-dialog').waitFor({ state: 'hidden' });
    await page.getByTestId('play').click();
    assert.equal((await state()).playing, false);
    await page.getByTestId('guide-open').click();
    assert.equal(await stepDone('mesh'), 'true');
  });

  it('export: the idle exports as 60 loop frames that move (frame 15 differs from frame 0)', async () => {
    await page.getByTestId('export-sequence').click();
    await page.getByTestId('export-dialog').waitFor({ state: 'visible' });
    const dl = page.waitForEvent('download');
    await page.getByTestId('seq-export').click();
    const target = path.join(OUT, 'idle.zip');
    await (await dl).saveAs(target);
    const files = new Map(readZip(readFileSync(target)).map((f) => [f.name, f.data]));
    const pngs = [...files.keys()].filter((n) => n.endsWith('.png')).sort();
    assert.equal(pngs.length, 60, '2 s at 30 fps, loop point omitted');
    const f0 = decodePng(files.get(pngs[0])!), f15 = decodePng(files.get(pngs[15])!);
    assert.deepEqual([f0.width, f0.height], [f15.width, f15.height]);
    let changed = 0, opaque = 0;
    for (let i = 0; i < f0.data.length; i += 4) {
      if (f0.data[i + 3] === 255) opaque++;
      if (Math.abs(f0.data[i + 3] - f15.data[i + 3]) > 8) changed++;
    }
    assert.ok(opaque > 5000, `frame 0 has the art (${opaque} opaque px)`);
    assert.ok(changed > 50, `the idle moves the art (${changed} px change alpha by > 8)`);
    writeFileSync(path.join(OUT, 'export.txt'), `${pngs.length} frames ${f0.width}x${f0.height}; frame 0 opaque ${opaque}; frame 15 vs 0 alpha changes ${changed}\n`);
    await page.keyboard.press('Escape');
  });

  it('recovery: after a reload, Recover brings back the work and the guide shows the same progress', async () => {
    await page.waitForFunction(() => /Autosaved/.test(document.querySelector('[data-testid="autosave-status"]')?.textContent ?? ''), null, { timeout: 10000 });
    const before = await project();
    await page.getByTestId('guide-close').click();
    await page.getByTestId('guide-dialog').waitFor({ state: 'hidden' });
    await page.reload();
    await page.getByTestId('recovery-banner').waitFor();
    await page.getByTestId('recovery-recover').click();
    await page.waitForFunction((n) => (window as any).__rigsmith.project().animations.length === n, before.animations.length);
    assert.deepEqual(await project(), before);
    await page.getByTestId('guide-open').click();
    assert.match(await page.getByTestId('guide-progress').innerText(), /^5 of 5 required steps done · 2 optional\./);
    for (const id of ['import', 'rig', 'clean', 'limbs', 'colour', 'mesh', 'idle']) assert.equal(await stepDone(id), 'true', id);
    await page.getByTestId('guide-close').click();
    assert.deepEqual(pageErrors, []);
  });
});
