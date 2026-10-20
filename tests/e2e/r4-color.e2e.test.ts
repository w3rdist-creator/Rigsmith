// R4 browser checks: blend modes, tint (setup and keyed) and per-vertex alpha, driven
// from the visible controls, each export compared with the independent reference
// compositor (tests/support/reference-composite.ts: W3C blend formulas, tint, barycentric
// vertex alpha). Visible controls only; window.__rigsmith is read-only (assertions).
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { ART_H, ART_MARGIN, ART_W, bandArt } from '../support/mesh-fixtures.ts';
import { decodePng } from '../support/png-decode.ts';
import { encodePng } from '../support/png-encode.ts';
import { composite, decodeProjectImages, diffImages } from '../support/reference-composite.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/r4-color');
mkdirSync(path.join(OUT, 'art'), { recursive: true });

// Original procedural art: a gradient backdrop, a soft warm glow (alpha falls off), a band.
const BACK = path.join(OUT, 'art/back.png');
const GLOW = path.join(OUT, 'art/glow.png');
const BAND = path.join(OUT, 'art/band.png');
{
  const w = 160, h = 100, px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([40 + x, 70 + Math.round(y / 2), 150 - Math.round(x / 2), 255], (y * w + x) * 4);
  writeFileSync(BACK, encodePng(w, h, px));
  const g = 100, gl = new Uint8Array(g * g * 4);
  for (let y = 0; y < g; y++)
    for (let x = 0; x < g; x++) {
      const r = Math.hypot(x + 0.5 - g / 2, y + 0.5 - g / 2) / (g / 2);
      gl.set([255, 200, 120, Math.round(255 * Math.max(0, 1 - r) ** 2)], (y * g + x) * 4);
    }
  writeFileSync(GLOW, encodePng(g, g, gl));
  writeFileSync(BAND, encodePng(ART_W, ART_H, bandArt(ART_W, ART_H, ART_MARGIN)));
}

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let base: string;
const pageErrors: string[] = [];
const report: string[] = [];
type Pt = { x: number; y: number };

const state = () => probe<any>(page, 'state');
const project = () => probe<any>(page, 'project');
const att = async (name: string) => (await project()).attachments.find((a: any) => a.name === name);
const verts = () => probe<Pt[]>(page, 'mesh', 'band');

async function setField(testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function gotoFrame(frame: number): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  const anim = (await project()).animations[0];
  const frames = Math.round(anim.duration * anim.fps);
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
}

/** Setup mode with an attachment selected (a sequence export leaves Setup). */
async function setupOn(name: string): Promise<void> {
  if ((await state()).mode !== 'setup') await page.getByTestId('mode-setup').click();
  await page.getByTestId(`tree-att-${name}`).click();
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

/** Exports frame f and compares it with the reference of `p` (default: the live project). */
async function checkFrame(frame: number, label: string, alter?: (p: any) => void) {
  const { meta, png } = await exportFrame(frame, `${label}.zip`);
  const p = await project();
  const refOf = (q: any) => composite(q, q.animations[0], frame / q.animations[0].fps, decodeProjectImages(q), meta.width, meta.height, meta.origin.x, meta.origin.y, meta.scale);
  const d = diffImages(png, refOf(p), 3);
  report.push(`${label}: vs reference max ${d.maxDiff.toFixed(1)} mean ${d.meanDiff.toFixed(3)} >3: ${d.over}/${d.covered}`);
  assert.ok(d.maxDiff <= 2 && d.meanDiff < 0.5, `${label} matches the reference within 2/255: ${JSON.stringify(d)}`);
  if (alter) {
    const q = structuredClone(p);
    alter(q);
    const x = diffImages(png, refOf(q), 3);
    report.push(`${label}: vs the reference without the effect max ${x.maxDiff.toFixed(1)} >3: ${x.over}`);
    assert.ok(x.maxDiff >= 30 && x.over > 50, `${label}: the effect is visible (${JSON.stringify(x)})`);
  }
  return d;
}

before(async () => {
  const port = await pickPort([47631, 47632, 47633]);
  base = `http://127.0.0.1:${port}/`;
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-r4-color');
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

describe('R4 colour: blend modes, tint, vertex alpha', () => {
  it('builds a backdrop, a glow and a band on one bone from visible controls', async () => {
    await page.getByTestId('image-input').setInputFiles([BACK, GLOW, BAND]);
    await page.getByTestId('image-band.png').waitFor();
    await page.getByTestId('add-bone').click();
    await setField('bone-name', 'root');
    await setField('bone-rotation', 0);
    for (const [img, x, y] of [['back.png', 0, 0], ['glow.png', 30, -10], ['band.png', -10, 25]] as const) {
      await page.getByTestId('tree-bone-root').click();
      await page.getByTestId(`attach-${img}`).click();
      await setField('att-x', x);
      await setField('att-y', y);
    }
    assert.deepEqual((await project()).attachments.map((a: any) => a.name), ['back', 'glow', 'band']);
    await page.getByTestId('new-animation').click();
  });

  it('Blend: each mode is one undo step and renders like the reference; normal is not stored', async () => {
    await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-att-glow').click();
    for (const mode of ['additive', 'screen', 'multiply'] as const) {
      const u0 = (await state()).undo;
      await page.getByTestId('att-blend').selectOption(mode);
      assert.equal((await state()).undo, u0 + 1, `${mode}: one undo step`);
      assert.equal((await att('glow')).blend, mode);
      await checkFrame(0, `blend-${mode}`, (q) => delete q.attachments[1].blend);
      await setupOn('glow');
    }
    await page.getByTestId('att-blend').selectOption('normal');
    assert.equal((await att('glow')).blend, undefined, 'normal is the default');
    await checkFrame(0, 'blend-normal');
  });

  it('Tint: colour and tint alpha set #rrggbbaa; an additive tinted glow adds tinted light', async () => {
    await setupOn('glow');
    await page.getByTestId('att-blend').selectOption('additive');
    await page.getByTestId('att-tint').fill('#40a0ff');
    assert.equal((await att('glow')).color, '#40a0ffff');
    await setField('att-tint-alpha', 0.6);
    assert.equal((await att('glow')).color, '#40a0ff99');
    await checkFrame(0, 'tint-additive', (q) => delete q.attachments[1].color);
    // The additive glow only adds light: no channel of the backdrop gets darker.
    const { png } = await exportFrame(0, 'tint-additive-again.zip');
    const before = (await project());
    const q = structuredClone(before);
    q.attachments.splice(1, 1);
    const { meta } = await exportFrame(0, 'meta.zip');
    const noGlow = composite(q, q.animations[0], 0, decodeProjectImages(q), meta.width, meta.height, meta.origin.x, meta.origin.y, meta.scale);
    let darker = 0;
    for (let i = 0; i < png.data.length; i += 4) if (noGlow.data[i + 3] === 255) for (let c = 0; c < 3; c++) if (png.data[i + c] < noGlow.data[i + c] - 2) darker++;
    assert.equal(darker, 0, 'additive never darkens');
    await setupOn('glow');
    await page.getByTestId('att-tint').fill('#ffffff');
    await setField('att-tint-alpha', 1);
    assert.equal((await att('glow')).color, undefined, 'white is the default');
  });

  it('Tint keys in Animate: set at two frames, toggle at a third; interpolated frames match the reference', async () => {
    await page.getByTestId('mode-animate').click();
    await page.getByTestId('tree-att-glow').click();
    await gotoFrame(0);
    await page.getByTestId('slot-color').fill('#ff0000');
    await gotoFrame(20);
    await page.getByTestId('slot-color').fill('#0000ff');
    await setField('slot-color-alpha', 0.25);
    let keys = (await project()).animations[0].slots[(await att('glow')).id].color;
    assert.deepEqual(keys.map((k: any) => [Math.round(k.time * 30), k.value]), [[0, [1, 0, 0, 1]], [20, [0, 0, 1, 0.25]]]);
    await gotoFrame(10);
    assert.equal(await page.getByTestId('slot-key-color').getAttribute('aria-pressed'), 'false');
    await page.getByTestId('slot-key-color').click();
    keys = (await project()).animations[0].slots[(await att('glow')).id].color;
    assert.equal(keys.length, 3);
    const mid = keys[1].value;
    [0.5, 0, 0.5, 0.625].forEach((v, i) => assert.ok(Math.abs(mid[i] - v) < 1e-9, `keyed the sampled tint (channel ${i}: ${mid[i]})`));
    await page.getByTestId('slot-key-color').click();
    assert.equal((await project()).animations[0].slots[(await att('glow')).id].color.length, 2, 'toggle removes it');
    await checkFrame(10, 'tint-keys-f10', (q) => delete q.animations[0].slots[q.attachments[1].id].color);
  });

  it('Vertex alpha: radial fade, invert, per-vertex field and clear, each one undo step, rendered like the reference', async () => {
    await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-att-band').click();
    await page.getByTestId('mesh-create').click();
    await setField('mesh-grid-cols', 6);
    await setField('mesh-grid-rows', 2);
    await page.getByTestId('mesh-grid').click();
    await page.getByTestId('mesh-apply').click();
    await page.getByTestId('mesh-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.getByTestId('va-summary').innerText(), 'All vertices opaque');
    await setField('va-cx', 60);
    await setField('va-cy', 20);
    await setField('va-r0', 10);
    await setField('va-r1', 50);
    const u0 = (await state()).undo;
    await page.getByTestId('va-radial').click();
    assert.equal((await state()).undo, u0 + 1);
    const m = (await att('band')).mesh;
    const expect: number[] = [];
    for (let i = 0; i < m.points.length; i += 2) {
      const t = Math.min(1, Math.max(0, (Math.hypot(m.points[i] - 60, m.points[i + 1] - 20) - 10) / 40));
      expect.push(1 - t * t * (3 - 2 * t));
    }
    m.alphas.forEach((v: number, i: number) => assert.ok(Math.abs(v - expect[i]) < 1e-12, `vertex ${i}`));
    assert.match(await page.getByTestId('va-summary').innerText(), /^\d+ of 21 vertices below 1$/);
    await checkFrame(0, 'valpha-radial', (q) => delete q.attachments[2].mesh.alphas);
    await setupOn('band');
    await page.getByTestId('va-invert').check();
    await page.getByTestId('va-radial').click();
    (await att('band')).mesh.alphas.forEach((v: number, i: number) => assert.ok(Math.abs(v - (1 - expect[i])) < 1e-12, `inverted vertex ${i}`));
    await checkFrame(0, 'valpha-inverted');
    await setupOn('band');
    await page.getByTestId('mesh-tool-vertices').click();
    const v = await verts();
    await page.mouse.click(v[18].x, v[18].y);
    assert.equal((await state()).meshVertex, 18);
    await setField('mv-alpha', 0.3);
    assert.equal((await att('band')).mesh.alphas[18], 0.3);
    await page.getByTestId('mesh-tool-vertices').click();
    await page.getByTestId('att-blend').selectOption('multiply');
    await checkFrame(0, 'valpha-multiply');
    await setupOn('band');
    await page.getByTestId('va-clear').click();
    assert.equal((await att('band')).mesh.alphas, undefined);
    await page.keyboard.press('Control+z');
    assert.equal((await att('band')).mesh.alphas[18], 0.3, 'undo restores the alphas');
  });

  it('save/re-open is lossless and the file is v3', async () => {
    const p = await project();
    assert.ok(p.attachments[2].blend === 'multiply' && p.attachments[2].mesh.alphas && p.animations[0].slots[p.attachments[1].id].color.length === 2);
    const sdl = page.waitForEvent('download');
    await page.getByTestId('save-project').click();
    const saved = path.join(OUT, 'color.rig.json');
    await (await sdl).saveAs(saved);
    assert.equal(JSON.parse(readFileSync(saved, 'utf8')).version, 3);
    await page.keyboard.press('Control+z');
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('open-project').click();
    await (await chooser).setFiles(saved);
    await page.waitForFunction(() => (window as any).__rigsmith.project().attachments[2]?.mesh?.alphas?.length === 21 && (window as any).__rigsmith.project().attachments[2].blend === 'multiply');
    assert.deepEqual(await project(), p, 'reopened project equals the saved one');
  });

  it('raised no uncaught page errors', () => {
    assert.deepEqual(pageErrors, []);
  });
});
