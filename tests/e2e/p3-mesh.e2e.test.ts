// Phase 3 — meshes, weights and deformation, driven through visible controls only
// (window.__rigsmith is read-only: assertions and screen coordinates). Renders are
// compared with the independent reference rasterizer.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { ART_H, ART_MARGIN, ART_W, bandArt, upscale2 } from '../support/mesh-fixtures.ts';
import { decodePng } from '../support/png-decode.ts';
import { encodePng } from '../support/png-encode.ts';
import type { M } from '../support/reference-composite.ts';
import { boneWorlds, composite, decodeProjectImages, diffImages, meshScreenVertices } from '../support/reference-composite.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/p3-mesh');
mkdirSync(path.join(OUT, 'art'), { recursive: true });
const BAND = path.join(OUT, 'art/band.png');
const BAND2 = path.join(OUT, 'art/band@2x.png');
const px = bandArt(ART_W, ART_H, ART_MARGIN);
writeFileSync(BAND, encodePng(ART_W, ART_H, px));
writeFileSync(BAND2, encodePng(ART_W * 2, ART_H * 2, upscale2(ART_W, ART_H, px)));

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let base: string;
const pageErrors: string[] = [];
const report: string[] = [];
type Pt = { x: number; y: number };
const state = () => probe<any>(page, 'state');
const project = () => probe<any>(page, 'project');
const verts = () => probe<Pt[]>(page, 'mesh', 'band');
const band = async () => (await project()).attachments.find((a: any) => a.name === 'band');
const byName = (list: any[], name: string) => list.find((x: any) => x.name === name);

async function setField(testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function drag(from: Pt, to: Pt, opts: { steps?: number; during?: () => Promise<void> } = {}): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: opts.steps ?? 6 });
  if (opts.during) await opts.during();
  await page.mouse.up();
}

async function gotoFrame(frame: number): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  const anim = (await project()).animations[0];
  const frames = Math.round(anim.duration * anim.fps);
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
}

async function exportFrame(frame: number, file: string) {
  await page.getByTestId('export-sequence').click();
  for (const id of ['seq-start', 'seq-end']) await setField(id, frame);
  const dl = page.waitForEvent('download');
  await page.getByTestId('seq-export').click();
  const zip = path.join(OUT, file);
  await (await dl).saveAs(zip);
  await page.keyboard.press('Escape');
  const files = readZip(readFileSync(zip));
  return { meta: JSON.parse(files.find((x) => x.name.endsWith('sequence.json'))!.data.toString('utf8')), png: decodePng(files.find((x) => x.name.endsWith('.png'))!.data) };
}

async function exportPng(file: string) {
  const dl = page.waitForEvent('download');
  await page.getByTestId('export-png').click();
  const target = path.join(OUT, file);
  await (await dl).saveAs(target);
  return decodePng(readFileSync(target));
}

const sums1 = (w: any[][]) => w.every((l) => Math.abs(l.reduce((s: number, x: any) => s + x.w, 0) - 1) < 1e-9);

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  base = `http://127.0.0.1:${port}/`;
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-p3-mesh');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(base);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
});

after(async () => {
  writeFileSync(path.join(OUT, 'report.txt'), report.join('\n') + '\n');
  await ctx?.close();
  server?.kill();
});

describe('mesh authoring', () => {
  let flat: { width: number; height: number; data: Uint8Array };
  it('builds a two-bone limb with a flat image from visible controls', async () => {
    await page.getByTestId('image-input').setInputFiles([BAND, BAND2]);
    await page.getByTestId('image-band.png').waitFor();
    await page.getByTestId('add-bone').click();
    await setField('bone-name', 'upper');
    await setField('bone-rotation', 0);
    await setField('bone-length', 60);
    await page.getByTestId('add-bone').click();
    await setField('bone-name', 'lower');
    await setField('bone-length', 60);
    await page.getByTestId('tree-bone-upper').click();
    await page.getByTestId('attach-band.png').click();
    await setField('att-x', 60);
    const p = await project();
    assert.deepEqual(p.bones.map((b: any) => b.name), ['upper', 'lower']);
    assert.equal((await band()).x, 60);
    flat = await exportPng('flat.png');
  });

  it('outline + interior clicks, live triangle count, self-crossing error, undo point, cancel', async () => {
    await page.getByTestId('mesh-create').click();
    await page.getByTestId('mesh-dialog').waitFor();
    const c = page.getByTestId('mesh-canvas');
    const box = (await c.boundingBox())!;
    const s = Number(await c.getAttribute('data-scale')), ox = Number(await c.getAttribute('data-ox')), oy = Number(await c.getAttribute('data-oy'));
    const at = (x: number, y: number) => ({ x: box.x + ox + x * s, y: box.y + oy + y * s });
    const click = async (x: number, y: number) => {
      const q = at(x, y);
      await page.mouse.click(q.x, q.y);
    };
    // Bow-tie: crosses itself.
    for (const [x, y] of [[2, 2], [118, 38], [118, 2], [2, 38]]) await click(x, y);
    assert.match(await page.getByTestId('mesh-problem').innerText(), /crosses itself/);
    await page.getByTestId('mesh-apply').click();
    assert.match(await page.getByTestId('mesh-errors').innerText(), /crosses itself/);
    assert.equal((await band()).mesh, undefined, 'nothing applied');
    await page.getByTestId('mesh-clear').click();
    for (const [x, y] of [[2, 2], [118, 2], [118, 38], [2, 38]]) await click(x, y);
    await page.getByTestId('mesh-mode-interior').click();
    await click(40, 20);
    await click(80, 20);
    assert.equal(await page.getByTestId('mesh-summary-dialog').innerText(), '4 outline · 2 interior point(s) · 6 triangles');
    await page.getByTestId('mesh-undo-point').click();
    assert.equal(await page.getByTestId('mesh-summary-dialog').innerText(), '4 outline · 1 interior point(s) · 4 triangles');
    await page.getByTestId('mesh-cancel').click();
    await page.getByTestId('mesh-dialog').waitFor({ state: 'hidden' });
    assert.equal((await band()).mesh, undefined, 'cancel applies nothing');
  });

  it('Fill grid creates a triangulated mesh in one undo step; the rigid mesh renders like the flat image', async () => {
    await page.getByTestId('mesh-create').click();
    await setField('mesh-grid-cols', 6);
    await setField('mesh-grid-rows', 2);
    await page.getByTestId('mesh-grid').click();
    assert.equal(await page.getByTestId('mesh-summary-dialog').innerText(), '16 outline · 5 interior point(s) · 24 triangles');
    const undo0 = (await state()).undo;
    await page.getByTestId('mesh-apply').click();
    await page.getByTestId('mesh-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.getByTestId('mesh-summary').innerText(), '21 vertices · 24 triangles · rigid');
    assert.equal((await state()).undo, undo0 + 1);
    const m = (await band()).mesh;
    assert.equal(m.hull, 16);
    const meshed = await exportPng('rigid-mesh.png');
    const d = diffImages(meshed, flat, 24);
    report.push(`rigid mesh vs flat image: max ${d.maxDiff} mean ${d.meanDiff.toFixed(3)} over24 ${d.over}/${d.covered}`);
    assert.ok(d.over === 0 && d.meanDiff < 0.5, `rigid mesh renders like the quad: ${JSON.stringify(d)}`);
    await page.keyboard.press('Control+z');
    assert.equal((await band()).mesh, undefined, 'undo removes the mesh');
    await page.keyboard.press('Control+Shift+z');
    assert.equal((await band()).mesh.triangles.length, 72, 'redo restores it');
  });
});

describe('vertex editing and weights (Setup)', () => {
  it('Edit vertices: dragging an interior vertex moves its image point; Esc cancels; the field is exact', async () => {
    await page.getByTestId('tree-att-band').click();
    await page.getByTestId('mesh-tool-vertices').click();
    assert.equal((await state()).meshTool, 'vertices');
    const v = await verts();
    const i = 16 + 2; // interior row: third interior vertex (x = 60, y = 20)
    const before = (await band()).mesh.points.slice();
    const zoom = await page.evaluate(() => (window as any).__rigsmith.worldAt(100, 0).x - (window as any).__rigsmith.worldAt(0, 0).x) / 100;
    await drag(v[i], { x: v[i].x + 9, y: v[i].y - 6 }, { during: async () => void (await page.keyboard.press('Escape')) });
    assert.deepEqual((await band()).mesh.points, before, 'Esc mid-drag restores the points');
    const undo0 = (await state()).undo;
    await drag(v[i], { x: v[i].x + 9, y: v[i].y - 6 });
    const after = (await band()).mesh.points;
    assert.equal((await state()).meshVertex, i);
    assert.ok(Math.abs(after[2 * i] - before[2 * i] - 9 * zoom) < 0.02 && Math.abs(after[2 * i + 1] - before[2 * i + 1] + 6 * zoom) < 0.02, `moved by the drag in image px (${after[2 * i]},${after[2 * i + 1]})`);
    assert.equal((await state()).undo, undo0 + 1, 'one undo step');
    const reUv = await exportPng('re-uv.png');
    const flat = decodePng(readFileSync(path.join(OUT, 'flat.png')));
    const d = diffImages(reUv, flat, 24);
    report.push(`setup vertex move (re-UV) vs flat: max ${d.maxDiff} mean ${d.meanDiff.toFixed(3)} over24 ${d.over}/${d.covered}`);
    assert.ok(d.over <= 2, `moving an interior point in Setup re-maps the texture: the art stays put (${JSON.stringify(d)})`);
    await setField('mv-x', 60);
    await setField('mv-y', 20);
    const back = (await band()).mesh.points;
    assert.deepEqual([back[2 * i], back[2 * i + 1]], [60, 20]);
  });

  it('Auto weights / Make rigid; a weight-paint stroke is one undo step and every vertex sums to 1', async () => {
    await page.getByTestId('weights-auto').click();
    assert.equal(await page.getByTestId('mesh-summary').innerText(), '21 vertices · 24 triangles · weighted (2 bones)');
    const p = await project();
    const lowerId = byName(p.bones, 'lower').id, upperId = byName(p.bones, 'upper').id;
    let w = (await band()).mesh.weights;
    assert.ok(sums1(w));
    assert.equal(w[0][0].bone, upperId, 'left end follows the upper bone');
    assert.equal(w[8][0].bone, lowerId, 'right end follows the lower bone');
    await page.getByTestId('weights-rigid').click();
    assert.equal((await band()).mesh.weights, undefined);
    await page.getByTestId('mesh-tool-weights').click();
    await page.getByTestId('wp-bone').selectOption({ label: 'lower' });
    await page.getByTestId('wp-mode').selectOption('add');
    await setField('wp-radius', 30);
    await setField('wp-strength', 0.5);
    const b = (await state()).brush;
    assert.deepEqual([b.boneId, b.mode, b.radius, b.strength], [lowerId, 'add', 30, 0.5]);
    const v = await verts();
    const undo0 = (await state()).undo;
    // Hull order: 0–5 top edge, 6–7 right edge, 8 bottom-right corner (see gridPoints).
    await drag(v[6], v[8], { steps: 4 }); // down the right end
    w = (await band()).mesh.weights;
    assert.equal((await state()).undo, undo0 + 1, 'the whole stroke is one undo step');
    assert.ok(sums1(w), 'normalized');
    const lowerW = (i: number) => w[i].find((x: any) => x.bone === lowerId)?.w ?? 0;
    assert.ok(lowerW(8) > 0.5, `painted vertex gained lower weight (${lowerW(8)})`);
    assert.equal(lowerW(0), 0, 'far vertex untouched');
    await page.keyboard.press('Control+z');
    assert.equal((await band()).mesh.weights, undefined, 'undo restores the rigid mesh');
    await page.keyboard.press('Control+Shift+z');
    const painted = lowerW(8);
    await page.getByTestId('wp-mode').selectOption('subtract');
    await drag(v[8], v[8], { steps: 1 });
    w = (await band()).mesh.weights;
    assert.ok(lowerW(8) < painted - 0.1 && sums1(w), `subtract lowers it (${painted} → ${lowerW(8)})`);
    // Per-vertex weight field (vertex tool: click a vertex, edit its weights).
    await page.getByTestId('mesh-tool-vertices').click();
    await page.mouse.click(v[8].x, v[8].y);
    assert.equal((await state()).meshVertex, 8);
    // Two dabs of subtract 0.5 (down + move) removed the lower influence: add it back.
    if (!(await page.getByTestId('mv-w-lower').count())) await page.getByTestId('mv-add-bone').selectOption({ label: 'lower' });
    assert.ok(lowerW(8) >= 0 && (await page.getByTestId('mv-w-lower').count()) === 1, 'lower influence listed');
    await setField('mv-w-lower', 0.75);
    w = (await band()).mesh.weights;
    assert.ok(Math.abs(lowerW(8) - 0.75) < 1e-9 && sums1(w), 'field sets the weight; the rest rescales');
    await page.getByTestId('weights-auto').click();
    await page.keyboard.press('Escape');
    assert.equal((await state()).meshTool, 'off', 'Esc leaves the mesh tool');
  });

  it('Limb weights form: banded upper → lower hand-over in one undo step; Smooth; Mirror needs a matching mesh', async () => {
    const p = await project();
    const lowerId = byName(p.bones, 'lower').id, upperId = byName(p.bones, 'upper').id;
    await page.getByTestId('lw-upper').selectOption({ label: 'upper' });
    await page.getByTestId('lw-lower').selectOption({ label: 'lower' });
    await page.getByTestId('lw-helper').selectOption('');
    await page.getByTestId('lw-side').selectOption('1');
    await setField('lw-inner', 6);
    await setField('lw-outer', 30);
    assert.equal(await page.getByTestId('weights-mirror').isDisabled(), true, 'no other weighted mesh to mirror from');
    assert.deepEqual(await page.getByTestId('wm-source').locator('option').allInnerTexts(), ['(no matching mesh)']);
    await page.getByTestId('wm-source').selectOption('');
    await setField('wm-swap', '_a=_b');
    assert.equal(await page.getByTestId('wm-swap').inputValue(), '_a=_b');
    const undo0 = (await state()).undo;
    await page.getByTestId('weights-limb').click();
    assert.equal((await state()).undo, undo0 + 1, 'one undo step');
    let w = (await band()).mesh.weights;
    const pts: number[] = (await band()).mesh.points;
    assert.ok(sums1(w));
    const lowerW = (i: number) => w[i].find((x: any) => x.bone === lowerId)?.w ?? 0;
    assert.equal(w[0][0].bone, upperId, 'left end follows the upper bone');
    assert.equal(lowerW(0), 0);
    // First grid column past the joint, inside (+y, bottom edge) vs outside (top edge): the tight inside band is more decided.
    const at = (x: number, y: number) => pts.findIndex((_, k) => k % 2 === 0 && Math.abs(pts[k] - x) < 1e-9 && Math.abs(pts[k + 1] - y) < 1e-9) / 2;
    const xs = [...new Set(pts.filter((_, k) => k % 2 === 0))].sort((a, b) => a - b);
    const ys = pts.filter((_, k) => k % 2 === 1);
    const past = xs.find((x) => x > ART_W / 2)!;
    const top = at(past, Math.min(...ys)), bottom = at(past, Math.max(...ys));
    assert.ok(top >= 0 && bottom >= 0, `edge vertices at x=${past}`);
    assert.ok(lowerW(bottom) > lowerW(top), `inside ${lowerW(bottom)} > outside ${lowerW(top)}`);
    report.push(`limb weights: column x=${past} lower share inside ${lowerW(bottom).toFixed(3)} / outside ${lowerW(top).toFixed(3)}`);
    await page.getByTestId('lw-side').selectOption('-1');
    await page.getByTestId('weights-limb').click();
    w = (await band()).mesh.weights;
    assert.ok(lowerW(top) > lowerW(bottom), 'side −1 tightens the top edge instead');
    const before = w.map((l: any[]) => l.map((x) => x.w));
    await page.getByTestId('weights-smooth').click();
    w = (await band()).mesh.weights;
    assert.ok(sums1(w));
    assert.notDeepEqual(w.map((l: any[]) => l.map((x) => x.w)), before, 'smoothing changed the weights');
    await page.keyboard.press('Control+z');
    assert.deepEqual((await band()).mesh.weights.map((l: any[]) => l.map((x: any) => x.w)), before, 'undo restores the limb weights');
    await page.getByTestId('lw-lower').selectOption({ label: 'upper' });
    assert.equal(await page.getByTestId('weights-limb').isDisabled(), true, 'upper = lower disables Apply');
    await page.getByTestId('lw-lower').selectOption({ label: 'lower' });
    await page.getByTestId('weights-auto').click(); // later tests expect auto weights
  });
});

describe('bending, deform keys and output', () => {
  it('rotating the lower bone bends the weighted mesh; the export matches the independent reference', async () => {
    await page.getByTestId('new-animation').click();
    await page.getByTestId('mode-animate').click();
    await gotoFrame(10);
    await page.getByTestId('tree-bone-lower').click();
    await setField('bone-rotation', 45);
    const { meta, png } = await exportFrame(10, 'bend-f10.zip');
    const p = await project();
    const ref = composite(p, p.animations[0], 10 / 30, decodeProjectImages(p), meta.width, meta.height, meta.origin.x, meta.origin.y, meta.scale);
    const d = diffImages(png, ref, 24);
    report.push(`bend f10 vs reference: max ${d.maxDiff} mean ${d.meanDiff.toFixed(3)} over24 ${d.over}/${d.covered}`);
    assert.ok(d.over <= d.covered * 0.01 && d.meanDiff < 1.5, `bend reference diff ${JSON.stringify(d)}`);
    // The tip really moved: right-end vertices rotated ~45° about the lower bone origin.
    const v = await verts();
    assert.ok(v[8].y - v[0].y > 25, `right end swung down (${v[8].y - v[0].y} px)`);
  });

  it('Deform vertices in Animate keys a deform that lands the vertex under the pointer; Esc cancels', async () => {
    await gotoFrame(5);
    await page.getByTestId('tree-att-band').click();
    await page.getByTestId('mesh-tool-vertices').click();
    const v = await verts();
    const i = 16 + 3;
    const target = { x: v[i].x + 10, y: v[i].y + 7 };
    await drag(v[i], target, { during: async () => void (await page.keyboard.press('Escape')) });
    assert.equal((await project()).animations[0].slots?.[(await band()).id]?.deform, undefined, 'Esc: no deform key');
    await drag(v[i], target);
    const keys = (await project()).animations[0].slots[(await band()).id].deform;
    assert.deepEqual(keys.map((k: any) => Math.round(k.time * 30)), [5]);
    await page.getByTestId('key-band-deform-5').waitFor();
    const moved = (await verts())[i];
    assert.ok(Math.hypot(moved.x - target.x, moved.y - target.y) < 0.6, `vertex under the pointer (${JSON.stringify(moved)} vs ${JSON.stringify(target)})`);
    assert.ok(keys[0].value.every((o: number, k: number) => (k === 2 * i || k === 2 * i + 1) || o === 0), 'only that vertex offset');
    await setField('mv-dx', 7);
    await setField('mv-dy', -3);
    const k5 = (await project()).animations[0].slots[(await band()).id].deform[0].value;
    assert.deepEqual([k5[2 * i], k5[2 * i + 1]], [7, -3]);
  });

  it('deform key toggle and reset at other frames; interpolation between deform keys', async () => {
    const attId = (await band()).id;
    await gotoFrame(15);
    await page.getByTestId('slot-key-deform').click();
    let keys = (await project()).animations[0].slots[attId].deform;
    assert.deepEqual(keys.map((k: any) => Math.round(k.time * 30)), [5, 15]);
    await page.getByTestId('slot-key-deform').click();
    keys = (await project()).animations[0].slots[attId].deform;
    assert.deepEqual(keys.map((k: any) => Math.round(k.time * 30)), [5], 'toggle removes it');
    await gotoFrame(20);
    await page.getByTestId('deform-reset').click();
    keys = (await project()).animations[0].slots[attId].deform;
    assert.ok(keys[1].value.every((o: number) => o === 0), 'reset keys zeros');
    const { meta, png } = await exportFrame(12, 'deform-f12.zip');
    const p = await project();
    const ref = composite(p, p.animations[0], 12 / 30, decodeProjectImages(p), meta.width, meta.height, meta.origin.x, meta.origin.y, meta.scale);
    const d = diffImages(png, ref, 24);
    report.push(`deform f12 (between deform keys, bent) vs reference: max ${d.maxDiff} mean ${d.meanDiff.toFixed(3)} over24 ${d.over}/${d.covered}`);
    assert.ok(d.over <= d.covered * 0.01 && d.meanDiff < 1.5, `deform reference diff ${JSON.stringify(d)}`);
  });

  it('runtime export bakes mesh vertices that match the independent skinning; save/reopen is lossless', async () => {
    const dl = page.waitForEvent('download');
    await page.getByTestId('export-runtime').click();
    const rtFile = path.join(OUT, 'runtime.json');
    await (await dl).saveAs(rtFile);
    const rt = JSON.parse(readFileSync(rtFile, 'utf8'));
    const p = await project();
    const ra = rt.attachments.find((a: any) => a.name === 'band');
    assert.deepEqual(ra.mesh.triangles, (await band()).mesh.triangles);
    const anim = p.animations[0];
    const att = p.attachments.find((a: any) => a.name === 'band');
    const setup = boneWorlds(p, null, 0);
    for (const f of [0, 5, 10, 12, 20]) {
      const want = meshScreenVertices(att, anim.slots?.[att.id], f / 30, p, boneWorlds(p, anim, f / 30), setup, [1, 0, 0, 1, 0, 0] as M);
      const got = rt.animations[0].bakedMeshes.band[f];
      const worst = Math.max(...got.map((x: number, k: number) => Math.abs(x - want[k])));
      assert.ok(worst < 0.002, `frame ${f}: runtime vertices = independent skinning (max err ${worst})`);
    }
    const sdl = page.waitForEvent('download');
    await page.getByTestId('save-project').click();
    const saved = path.join(OUT, 'mesh.rig.json');
    await (await sdl).saveAs(saved);
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('open-project').click();
    await (await chooser).setFiles(saved);
    await page.waitForFunction(() => (window as any).__rigsmith.project().attachments.some((a: any) => a.mesh));
    assert.deepEqual(await project(), p, 'reopened project equals the saved one');
    assert.equal(JSON.parse(readFileSync(saved, 'utf8')).version, 2);
  });

  it('changing the setup image to the 2× art rescales the mesh; the project still saves and re-opens', async () => {
    await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-att-band').click();
    const before = (await band()).mesh.points.slice();
    await page.getByTestId('att-image').selectOption({ label: 'band@2x.png' });
    const after = (await band()).mesh.points;
    assert.deepEqual(after, before.map((v: number) => v * 2));
    const sdl = page.waitForEvent('download');
    await page.getByTestId('save-project').click();
    const saved = path.join(OUT, 'mesh-2x.rig.json');
    await (await sdl).saveAs(saved);
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('open-project').click();
    await (await chooser).setFiles(saved);
    await page.waitForFunction(() => (window as any).__rigsmith.project().images.length === 2);
    assert.deepEqual((await band()).mesh.points, after, 'reopened with the rescaled mesh');
    await page.getByTestId('tree-att-band').click();
    assert.ok((await project()).animations[0].slots[(await band()).id].deform.length > 0, 'deform keys before re-meshing');
    await page.getByTestId('mesh-edit').click();
    assert.equal(await page.getByTestId('mesh-summary-dialog').innerText(), '16 outline · 5 interior point(s) · 24 triangles', 'Re-mesh… opens with the current points');
    await page.getByTestId('mesh-apply').click();
    await page.getByTestId('mesh-dialog').waitFor({ state: 'hidden' });
    assert.equal((await band()).mesh.weights, undefined, 're-meshing resets weights');
    assert.equal((await project()).animations[0].slots?.[(await band()).id]?.deform, undefined, 'and drops the old deform keys');
    await page.getByTestId('weights-auto').click();
    await page.getByTestId('mesh-remove').click();
    assert.equal((await band()).mesh, undefined, 'Remove mesh');
    assert.equal((await project()).animations[0].slots?.[(await band()).id]?.deform, undefined, 'no deform keys remain');
  });

  it('raised no uncaught page errors', () => {
    assert.deepEqual(pageErrors, []);
  });
});
