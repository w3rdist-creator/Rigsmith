// Phase 4 — animated media from the visible Export sequence… dialog (Format: APNG / GIF).
// The PNG-sequence ZIP from the same dialog is the reference. Every exported file is
// decoded by tools that are not Rigsmith code: Pillow (frames, durations, loop), ffprobe
// (frame count, rate) and Chrome for Testing's own ImageDecoder. Also: range errors,
// over-capacity, cancel in both phases (no download), one large export, CLI agreement.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { serializeProject } from '../../src/model/format.ts';
import { gifDelays } from '../../src/model/media.ts';
import { ffprobe, hasFfmpeg, pillow } from '../support/media-check.ts';
import { decodePng } from '../support/png-decode.ts';
import { diffImages } from '../support/reference-composite.ts';
import { richProject } from '../support/runtime-fixture.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, ROOT, launchIsolated, pickPort, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/p4-media');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const RIG = path.join(OUT, 'runtime-rig.rig.json');
writeFileSync(RIG, serializeProject(richProject()));

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let downloads = 0;
const pageErrors: string[] = [];
const report: string[] = [];
let ref: { width: number; height: number; data: Uint8Array }[] = [];

async function setField(testId: string, v: string | number): Promise<void> {
  await page.getByTestId(testId).fill(String(v));
  await page.getByTestId(testId).press('Enter');
}

async function openExport(format: 'zip' | 'apng' | 'gif', fields: [string, number][] = []): Promise<void> {
  await page.getByTestId('export-sequence').click();
  await page.getByTestId('seq-anim').selectOption({ label: 'wave' });
  await page.getByTestId('seq-format').selectOption(format);
  for (const [id, v] of fields) await setField(id, v);
}

async function download(file: string): Promise<string> {
  const dl = page.waitForEvent('download', { timeout: 120000 });
  await page.getByTestId('seq-export').click();
  const target = path.join(OUT, file);
  await (await dl).saveAs(target);
  return target;
}

/** Chrome for Testing's ImageDecoder: frame count, repetition count, durations, RGBA per frame. */
async function chromeDecode(file: string, type: string) {
  const r = await page.evaluate(async ({ b64, type }) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const supported = await (window as any).ImageDecoder.isTypeSupported(type);
    const dec = new (window as any).ImageDecoder({ data: bin, type });
    await dec.tracks.ready;
    const tr = dec.tracks.selectedTrack;
    const frames: string[] = [];
    const durations: number[] = [];
    let w = 0, h = 0;
    for (let i = 0; i < tr.frameCount; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      w = image.displayWidth;
      h = image.displayHeight;
      durations.push(image.duration);
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d')!;
      g.drawImage(image, 0, 0);
      image.close();
      const d = g.getImageData(0, 0, w, h).data;
      let s = '';
      for (let k = 0; k < d.length; k += 0x8000) s += String.fromCharCode(...d.subarray(k, k + 0x8000));
      frames.push(btoa(s));
    }
    return { supported, frameCount: tr.frameCount, repetitionCount: tr.repetitionCount, durations, w, h, frames };
  }, { b64: readFileSync(file).toString('base64'), type });
  return { ...r, frames: r.frames.map((b) => ({ width: r.w, height: r.h, data: new Uint8Array(Buffer.from(b, 'base64')) })) };
}

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-p4-media');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  page.on('download', () => void downloads++);
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
  await page.getByTestId('open-input').setInputFiles(RIG);
  await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length > 0);
});

after(async () => {
  writeFileSync(path.join(OUT, 'report.txt'), report.join('\n') + '\n');
  await ctx?.close();
  server?.kill();
});

describe('animated media export (APNG / GIF) from the Export sequence dialog', () => {
  it('reference: the PNG-sequence ZIP (default format, unchanged)', async () => {
    await openExport('zip');
    assert.equal(await page.getByTestId('seq-export').innerText(), 'Export ZIP');
    assert.match(await page.getByTestId('seq-format-note').innerText(), /reliable path for alpha/);
    const zip = readZip(readFileSync(await download('wave.zip')));
    const meta = JSON.parse(zip.find((f) => f.name.endsWith('sequence.json'))!.data.toString('utf8'));
    ref = meta.frames.map((fr: any) => decodePng(zip.find((f) => f.name === fr.file)!.data));
    assert.equal(ref.length, 30);
    assert.equal(meta.loop, true);
  });

  it('APNG: every frame equals the PNG sequence exactly (Pillow and Chrome for Testing); 1/30 s; loops', async () => {
    await openExport('apng');
    assert.equal(await page.getByTestId('seq-export').innerText(), 'Export APNG');
    assert.match(await page.getByTestId('seq-format-note').innerText(), /lossless, full 8-bit alpha\), 1\/30 s per frame, loops forever/);
    const file = await download('wave.apng');
    assert.match(await page.getByTestId('status').innerText(), /Exported 30 frames \(\d+×\d+\) as runtime-rig-wave-30fps\.apng\. APNG: lossless, full alpha\./);
    const d = pillow(file);
    assert.deepEqual([d.info.frames, d.info.width, d.info.height, d.info.loop], [30, ref[0].width, ref[0].height, 0]);
    d.info.durations.forEach((ms: number) => assert.ok(Math.abs(ms - 1000 / 30) < 1e-6));
    d.frames.forEach((f, i) => assert.deepEqual(f, ref[i].data, `Pillow frame ${i} = PNG sequence`));
    const c = await chromeDecode(file, 'image/png');
    assert.deepEqual([c.supported, c.frameCount, c.repetitionCount], [true, 30, Infinity]);
    let worst = 0, over = 0;
    c.frames.forEach((f, i) => {
      const s = diffImages(f, ref[i], 2);
      worst = Math.max(worst, s.maxDiff);
      over += s.over;
    });
    // Chrome's canvas premultiplies, so partially transparent colour may move by rounding.
    assert.equal(over, 0, 'Chrome decode within 2 levels everywhere');
    report.push(`APNG ${readFileSync(file).length} bytes: Pillow 30/30 frames exact; Chrome ImageDecoder 30 frames, repetition ∞, max channel diff ${worst} (premultiplied canvas readback)`);
    if (hasFfmpeg()) {
      const p = ffprobe(file);
      // ffmpeg's APNG demuxer uses a 1/100000 time base: 30 fps reads as 100000/3333.
      const [a, b] = p.rate.split('/').map(Number);
      assert.deepEqual([p.codec, p.frames], ['apng', 30]);
      assert.ok(Math.abs(a / b - 30) < 0.01, p.rate);
    }
  });

  it('GIF: binary alpha exactly at 50%, palette error measured, reported alpha loss = independent count, centisecond timing (Pillow, Chrome, ffprobe)', async () => {
    await openExport('gif');
    assert.match(await page.getByTestId('seq-format-note').innerText(), /256-colour palette \(no dithering\) and 1-bit alpha.*3\/4\/3\/3\/4\/3 cs/s);
    const file = await download('wave.gif');
    const status = await page.getByTestId('status').innerText();
    const m = status.match(/GIF: (\d+) colours \((exact|reduced, no dithering)\); (\d+) of (\d+) px had partial alpha and became binary \((\d+) opaque, (\d+) transparent\)\./);
    assert.ok(m, status);
    let partial = 0, toOpaque = 0, total = 0;
    for (const f of ref)
      for (let p = 3; p < f.data.length; p += 4) {
        total++;
        if (f.data[p] > 0 && f.data[p] < 255) {
          partial++;
          if (f.data[p] >= 128) toOpaque++;
        }
      }
    assert.deepEqual(m.slice(3, 7).map(Number), [partial, total, toOpaque, partial - toOpaque], 'reported counts = counted from the PNG sequence');
    const d = pillow(file);
    assert.deepEqual([d.info.frames, d.info.width, d.info.height, d.info.loop], [30, ref[0].width, ref[0].height, 0]);
    assert.deepEqual(d.info.durations, gifDelays(30, 30).map((cs) => cs * 10));
    let err = 0, n = 0, max = 0;
    d.frames.forEach((f, i) => {
      for (let p = 0; p < f.length; p += 4) {
        const a = ref[i].data[p + 3];
        assert.equal(f[p + 3], a >= 128 ? 255 : 0);
        if (a >= 128)
          for (let k = 0; k < 3; k++) {
            const e = Math.abs(f[p + k] - ref[i].data[p + k]);
            err += e;
            n++;
            max = Math.max(max, e);
          }
      }
    });
    const mean = err / n;
    assert.ok(mean < 3, `palette mean error ${mean}`);
    const c = await chromeDecode(file, 'image/gif');
    assert.deepEqual([c.supported, c.frameCount, c.repetitionCount], [true, 30, Infinity]);
    c.frames.forEach((f, i) => assert.deepEqual(f.data, d.frames[i], `Chrome frame ${i} = Pillow frame ${i}`));
    report.push(`GIF ${readFileSync(file).length} bytes, ${m[1]} colours (${m[2]}): alpha binary at 128 on every pixel; colour mean abs error ${mean.toFixed(2)}, max ${max}; ${partial} of ${total} px partial alpha (${toOpaque} → opaque); Chrome ImageDecoder frames identical to Pillow; durations ${d.info.durations.slice(0, 6).join('/')}… ms`);
    if (hasFfmpeg()) assert.equal(ffprobe(file).frames, 30);
  });

  it('CLI media: GIF byte-identical to the dialog file; APNG decodes to the same pixels', () => {
    for (const f of ['gif', 'apng']) {
      const out = path.join(OUT, `cli-wave.${f}`);
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), 'media', RIG, '--anim', 'wave', '--format', f, '--out', out], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 << 20 });
      assert.equal(r.status, 0, r.stdout);
      if (f === 'gif') assert.deepEqual(readFileSync(out), readFileSync(path.join(OUT, 'wave.gif')));
      else pillow(out).frames.forEach((fr, i) => assert.deepEqual(fr, ref[i].data));
    }
  });

  it('range errors: GIF above 50 fps and over-capacity are refused with the export disabled', async () => {
    await openExport('gif', [['seq-fps', 60]]);
    assert.match(await page.getByTestId('seq-errors').innerText(), /at most 50 fps for GIF \(got 60\)/);
    assert.ok(await page.getByTestId('seq-export').isDisabled());
    await page.getByTestId('seq-format').selectOption('apng');
    assert.equal(await page.getByTestId('seq-errors').count(), 0, 'APNG has no fps cap');
    assert.ok(!(await page.getByTestId('seq-export').isDisabled()));
    await setField('seq-fps', 240);
    await setField('seq-scale', 8);
    assert.match(await page.getByTestId('seq-errors').innerText(), /too large to export/);
    assert.ok(await page.getByTestId('seq-export').isDisabled());
    await page.getByTestId('seq-format').selectOption('gif');
    const both = await page.getByTestId('seq-errors').innerText();
    assert.match(both, /too large to export/);
    assert.match(both, /at most 50 fps for GIF \(got 240\)/);
    await page.getByTestId('seq-cancel').click();
  });

  it('cancel while rendering (APNG) and while encoding (GIF) saves nothing', async () => {
    for (const [format, phase] of [['apng', /^rendering \d+ \/ \d+$/], ['gif', /^encoding \d+ \/ \d+$/]] as const) {
      const dl0 = downloads;
      await openExport(format, [['seq-fps', 50], ['seq-scale', 3]]);
      await page.getByTestId('seq-export').click();
      await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-testid="seq-progress-text"]')?.textContent ?? ''), phase.source, { timeout: 120000 });
      await page.getByTestId('seq-cancel').click();
      await page.waitForFunction(() => /Cancelled/.test(document.querySelector('[data-testid="seq-progress-text"]')?.textContent ?? ''), undefined, { timeout: 60000 });
      await page.waitForTimeout(500);
      assert.equal(downloads, dl0, `${format}: no download`);
      assert.match(await page.getByTestId('status').innerText(), new RegExp(`${format.toUpperCase()} export cancelled; nothing was saved`));
      await page.getByTestId('seq-cancel').click();
    }
  });

  it('large export completes and decodes: APNG and GIF at 2× scale, 50 fps', async () => {
    for (const format of ['apng', 'gif'] as const) {
      await openExport(format, [['seq-fps', 50], ['seq-scale', 2]]);
      const summary = await page.getByTestId('seq-summary').innerText();
      const t0 = Date.now();
      const file = await download(`large.${format}`);
      const ms = Date.now() - t0;
      const d = pillow(file);
      const [w, h] = summary.match(/(\d+)×(\d+) px/)!.slice(1).map(Number);
      assert.deepEqual([d.info.frames, d.info.width, d.info.height], [50, w, h]);
      assert.ok(d.frames.every((f) => f.length === w * h * 4));
      report.push(`large ${format}: 50 frames ${w}×${h}, ${readFileSync(file).length} bytes, ${ms} ms in the browser`);
    }
    assert.deepEqual(pageErrors, []);
  });
});
