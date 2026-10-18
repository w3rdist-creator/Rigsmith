// Phase 1 browser checks: PNG sequence export (ZIP), renderer correctness against an
// independent reference compositor, autosave + recovery. Visible controls only;
// window.__rigsmith is read-only.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import type { BrowserContext, Page } from 'playwright-core';
import { decodePng, borderAlphaCount } from '../support/png-decode.ts';
import { boneWorlds, composite, decodeProjectImages, diffImages } from '../support/reference-composite.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, launchIsolated, overrideQuota, pickPort, probe, readIdb, startPreview, waitUntil } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/p1-export');
mkdirSync(OUT, { recursive: true });

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let base: string;
const pageErrors: string[] = [];
let downloads = 0;

const state = () => probe<any>(page, 'state');
const project = () => probe<any>(page, 'project');

async function fresh(): Promise<void> {
  if (page) await page.close();
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  page.on('download', () => downloads++);
  await page.goto(base);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
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

async function exportZip(file: string): Promise<{ files: Map<string, Buffer>; meta: any }> {
  const dl = page.waitForEvent('download');
  await page.getByTestId('seq-export').click();
  const d = await dl;
  const target = path.join(OUT, file);
  await d.saveAs(target);
  const files = new Map(readZip(readFileSync(target)).map((f) => [f.name, f.data]));
  const metaName = [...files.keys()].find((n) => n.endsWith('sequence.json'))!;
  return { files, meta: JSON.parse(files.get(metaName)!.toString('utf8')) };
}

function noisePng(w: number, h: number): Buffer {
  // Incompressible RGBA noise: makes a project too large for browser storage.
  const raw = Buffer.alloc((w * 4 + 1) * h);
  const noise = randomBytes(w * 4 * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    noise.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    for (let x = 0; x < w; x++) raw[y * (w * 4 + 1) + 1 + x * 4 + 3] = 255;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  base = `http://127.0.0.1:${port}/`;
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-p1-export');
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('PNG sequence export', () => {
  let walkZip: { files: Map<string, Buffer>; meta: any };

  it('exports a looping animation as one ZIP of equal-size, alpha-bordered PNGs (endpoint omitted)', async () => {
    await demo();
    const before = await project();
    const s0 = await state();
    await page.getByTestId('export-sequence').click();
    await page.getByTestId('export-dialog').waitFor({ state: 'visible' });
    assert.match(await page.getByTestId('seq-policy').textContent() ?? '', /frames 0–29 at 30 fps\. Frame 30 is the loop point/);
    assert.equal(await page.getByTestId('seq-preview-first').getAttribute('data-frame'), '0');
    assert.equal(await page.getByTestId('seq-preview-last').getAttribute('data-frame'), '29');
    await page.getByTestId('export-dialog').screenshot({ path: path.join(OUT, 'dialog.png') });
    walkZip = await exportZip('walk.zip');
    const { files, meta } = walkZip;
    const pngs = [...files.keys()].filter((n) => n.endsWith('.png')).sort();
    assert.equal(pngs.length, 30, '30 frames at 30 fps for a 1 s loop (frame 30 = frame 0 omitted)');
    assert.equal(pngs[0], 'walk/walk_0000.png');
    assert.equal(pngs[29], 'walk/walk_0029.png');
    assert.equal(meta.frames.length, 30);
    assert.ok(meta.frames.at(-1).time < 1, 'last sample before the duration');
    const sizes = new Set<string>();
    for (const n of pngs) {
      const img = decodePng(files.get(n)!);
      sizes.add(`${img.width}x${img.height}`);
      assert.equal(borderAlphaCount(img), 0, `${n}: outer pixel ring fully transparent (nothing clipped)`);
      let opaque = 0;
      for (let i = 3; i < img.data.length; i += 4) if (img.data[i] === 255) opaque++;
      assert.ok(opaque > 1000, `${n} has art`);
      assert.equal(img.data[3], 0, `${n}: background (corner) alpha 0`);
    }
    assert.equal(sizes.size, 1, `every frame has identical dimensions (${[...sizes].join(', ')})`);
    assert.equal([...sizes][0], `${meta.width}x${meta.height}`);
    assert.deepEqual(await project(), before, 'export does not change the project');
    const s1 = await state();
    assert.equal(s1.time, s0.time, 'nor the playhead');
    assert.equal(s1.undo, s0.undo, 'nor the history');
  });

  it('matches an independent reference compositor for posed frames (stated tolerance)', async () => {
    const { files, meta } = walkZip;
    const p = await project();
    const imgs = decodeProjectImages(p);
    const walk = p.animations.find((a: any) => a.name === 'walk');
    const report: string[] = [];
    for (const f of [0, 7, 19]) {
      const got = decodePng(files.get(`walk/walk_${String(f).padStart(4, '0')}.png`)!);
      const ref = composite(p, walk, f / 30, imgs, meta.width, meta.height, meta.origin.x, meta.origin.y, meta.scale);
      const d = diffImages(got, ref, 24);
      report.push(`walk f${f}: max ${d.maxDiff.toFixed(1)} mean ${d.meanDiff.toFixed(3)} >24: ${d.over}/${d.covered}`);
      assert.ok(d.over <= d.covered * 0.01, `frame ${f}: ≤1% of covered pixels differ by >24/255 (got ${d.over}/${d.covered})`);
      assert.ok(d.meanDiff < 1.5, `frame ${f}: mean premultiplied difference ${d.meanDiff.toFixed(3)} < 1.5/255`);
    }
    writeFileSync(path.join(OUT, 'reference-diff.txt'), report.join('\n') + '\n');
  });

  it('setup frame (Export PNG) matches the reference compositor', async () => {
    await page.getByTestId('mode-setup').click();
    const dl = page.waitForEvent('download');
    await page.getByTestId('export-png').click();
    const file = path.join(OUT, 'setup.png');
    await (await dl).saveAs(file);
    const got = decodePng(readFileSync(file));
    const p = await project();
    const imgs = decodeProjectImages(p);
    // Independent bounds: union of every attachment's corners in the setup pose, +8 px.
    const W = boneWorlds(p, null, 0);
    let minX = Infinity, minY = Infinity;
    for (const a of p.attachments) {
      const im = p.images.find((i: any) => i.id === a.imageId);
      const b = W.get(a.boneId)!;
      const r = (a.rotation * Math.PI) / 180;
      const m = [Math.cos(r) * a.scaleX, Math.sin(r) * a.scaleX, -Math.sin(r) * a.scaleY, Math.cos(r) * a.scaleY, a.x, a.y];
      for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lx = m[0] * (x * im.width) / 2 + m[2] * (y * im.height) / 2 + m[4];
        const ly = m[1] * (x * im.width) / 2 + m[3] * (y * im.height) / 2 + m[5];
        minX = Math.min(minX, b[0] * lx + b[2] * ly + b[4]);
        minY = Math.min(minY, b[1] * lx + b[3] * ly + b[5]);
      }
    }
    const ref = composite(p, null, 0, imgs, got.width, got.height, minX - 8, minY - 8, 1);
    const d = diffImages(got, ref, 24);
    writeFileSync(path.join(OUT, 'reference-diff-setup.txt'), `setup: max ${d.maxDiff.toFixed(1)} mean ${d.meanDiff.toFixed(3)} >24: ${d.over}/${d.covered}\n`);
    assert.ok(d.over <= d.covered * 0.01, `setup: ≤1% of covered pixels differ by >24/255 (${d.over}/${d.covered})`);
    assert.ok(d.meanDiff < 1.5);
  });

  it('a one-shot export includes the final pose; export FPS, range and scale are honoured', async () => {
    await page.getByTestId('mode-animate').click();
    await page.getByTestId('anim-loop').uncheck();
    await page.getByTestId('export-sequence').click();
    assert.match(await page.getByTestId('seq-policy').textContent() ?? '', /One-shot: frames 0–30/);
    await setField('seq-fps', 12);
    assert.equal(await page.getByTestId('seq-end').inputValue(), '12', 'end follows the export FPS');
    await setField('seq-start', 2);
    await setField('seq-scale', 0.5);
    const { files, meta } = await exportZip('walk-oneshot-12fps.zip');
    const pngs = [...files.keys()].filter((n) => n.endsWith('.png')).sort();
    assert.equal(pngs.length, 11, 'frames 2..12 inclusive');
    assert.equal(meta.frames.at(-1).time, 1, 'final pose at t = duration');
    assert.equal(meta.fps, 12);
    const img = decodePng(files.get(pngs[0])!);
    assert.ok(img.width < walkZip.meta.width * 0.6, 'scale 0.5 shrinks frames');
    assert.equal(borderAlphaCount(img), 0);
  });

  it('range, capacity and no-animation errors are visible and change nothing', async () => {
    await page.getByTestId('anim-loop').check();
    const before = await project();
    const dl0 = downloads;
    await page.getByTestId('export-sequence').click();
    await setField('seq-end', 30);
    assert.match(await page.getByTestId('seq-errors').textContent() ?? '', /between 0 and 29 \(frame 30 repeats frame 0/);
    assert.equal(await page.getByTestId('seq-export').isDisabled(), true);
    await setField('seq-end', 29);
    await setField('seq-start', 20);
    await setField('seq-end', 10);
    assert.match(await page.getByTestId('seq-errors').textContent() ?? '', /zero frames/);
    await setField('seq-start', 0);
    await setField('seq-end', 29);
    await setField('seq-fps', 240);
    await setField('seq-scale', 8);
    await setField('seq-padding', 200);
    assert.match(await page.getByTestId('seq-errors').textContent() ?? '', /240 frames of \d+×\d+ px is too large/);
    assert.equal(await page.getByTestId('seq-export').isDisabled(), true);
    await page.getByTestId('seq-cancel').click();
    assert.equal(downloads, dl0, 'no download');
    assert.deepEqual(await project(), before, 'project untouched');
    // A project without animations.
    await fresh();
    await page.getByTestId('export-sequence').click();
    assert.match(await page.getByTestId('seq-errors').textContent() ?? '', /Choose an animation/);
    await page.getByTestId('seq-cancel').click();
  });

  it('cancel during export leaves no download and no state change', async () => {
    await demo();
    const before = await project();
    const s0 = await state();
    const dl0 = downloads;
    await page.getByTestId('export-sequence').click();
    await setField('seq-fps', 240);
    await setField('seq-scale', 2);
    await page.getByTestId('seq-export').click();
    await page.waitForFunction(() => /^\d+ \/ \d+$/.test(document.querySelector('[data-testid="seq-progress-text"]')?.textContent ?? ''));
    await page.getByTestId('seq-cancel').click();
    await page.waitForFunction(() => /Cancelled/.test(document.querySelector('[data-testid="seq-progress-text"]')?.textContent ?? ''));
    await page.waitForTimeout(800);
    assert.equal(downloads, dl0, 'no ZIP was downloaded');
    assert.deepEqual(await project(), before);
    assert.equal((await state()).undo, s0.undo);
    await page.getByTestId('export-dialog').screenshot({ path: path.join(OUT, 'cancelled.png') });
    await page.getByTestId('seq-cancel').click();
    assert.equal(await page.getByTestId('export-dialog').isVisible(), false);
  });
});

describe('autosave and recovery', () => {
  it('autosaves edits to its own slot without touching the explicit browser save', async () => {
    // Earlier tests in this profile left unsaved work behind: resolve that recovery first.
    await fresh();
    if (await page.getByTestId('recovery-banner').count()) await page.getByTestId('recovery-discard').click();
    await demo();
    await page.getByTestId('save-browser').click();
    // Storage is IndexedDB since RV-007 (records "browser-save" and "autosave").
    const explicit = await waitUntil(() => readIdb(page, 'browser-save'), (v) => v !== null, 5000, 'browser save');
    await setField('project-name', 'Autosave check');
    await page.waitForFunction(() => /Autosaved/.test(document.querySelector('[data-testid="autosave-status"]')?.textContent ?? ''), null, { timeout: 5000 });
    const stored = await readIdb(page, 'autosave');
    assert.equal(JSON.parse(stored.project).name, 'Autosave check');
    assert.deepEqual(await readIdb(page, 'browser-save'), explicit, 'explicit browser save untouched');
  });

  it('after a reload, offers recovery without loading it; Recover restores the unsaved work', async () => {
    await fresh();
    await page.getByTestId('recovery-banner').waitFor();
    assert.equal(await page.getByTestId('empty-stage').isVisible(), true, 'nothing auto-loaded; start screen usable');
    assert.equal((await state()).autosavePending, true);
    assert.match(await page.getByTestId('autosave-status').textContent() ?? '', /paused/);
    await page.screenshot({ path: path.join(OUT, 'recovery-banner.png') });
    await page.getByTestId('recovery-recover').click();
    await page.waitForFunction(() => (window as any).__rigsmith.project().name === 'Autosave check');
    assert.equal((await state()).dirty, true, 'recovered work is still unsaved');
    assert.equal(await page.getByTestId('recovery-banner').count(), 0);
  });

  it('Discard removes the recoverable copy; an explicit save clears autosave', async () => {
    await fresh();
    await page.getByTestId('recovery-banner').waitFor();
    await page.getByTestId('recovery-discard').click();
    await page.getByTestId('recovery-banner').waitFor({ state: 'detached' });
    await waitUntil(() => readIdb(page, 'autosave'), (v) => v === null, 5000, 'autosave removed');
    await demo();
    await setField('project-name', 'saved explicitly');
    await waitUntil(() => readIdb(page, 'autosave'), (v) => v !== null, 5000, 'autosave written');
    await page.getByTestId('save-browser').click();
    await waitUntil(() => readIdb(page, 'autosave'), (v) => v === null, 5000, 'autosave cleared by the browser save');
    await fresh();
    assert.equal(await page.getByTestId('recovery-banner').count(), 0, 'no stale recovery after an explicit save');
  });

  it('a storage quota failure is shown persistently and as an error', async () => {
    // IndexedDB's quota here is GBs: limit it (CDP) so this ~8 MB project cannot fit. Chrome
    // caches an origin's quota once its storage is open, so the limit is set in a fresh
    // context (from a blank holder page) before the app first opens IndexedDB.
    const shared = ctx;
    await page.close();
    ctx = await launchIsolated('e2e-p1-quota');
    const holder = ctx.pages()[0] ?? (await ctx.newPage());
    const resetQuota = await overrideQuota(holder, new URL(base).origin, 2_000_000);
    await demo();
    const png = noisePng(1400, 1400);
    await page.getByTestId('image-input').setInputFiles({ name: 'noise.png', mimeType: 'image/png', buffer: png });
    await page.getByTestId('image-noise.png').waitFor();
    const indicator = async () => ({ state: await page.getByTestId('autosave-status').getAttribute('data-state'), text: await page.getByTestId('autosave-status').textContent() });
    await waitUntil(indicator, (v) => v.state === 'error', 8000, 'autosave error indicator');
    assert.match(await page.getByTestId('autosave-status').textContent() ?? '', /too large for browser storage/);
    assert.match(await page.getByTestId('error-toast').last().textContent() ?? '', /Autosave failed/);
    await page.screenshot({ path: path.join(OUT, 'autosave-quota.png') });
    await resetQuota();
    await ctx.close();
    ctx = shared;
    page = await ctx.newPage();
  });

  it('raised no uncaught page errors', () => {
    assert.deepEqual(pageErrors, []);
  });
});
