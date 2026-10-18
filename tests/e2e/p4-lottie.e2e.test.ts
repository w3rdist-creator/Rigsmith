// Phase 4 — Lottie subset export through the visible dialog. The exported JSON is played
// two ways and every frame must match the editor's own PNG-sequence export of the same
// animation and skin: (1) by the independent in-repo evaluator (tests/support/lottie-eval.ts)
// rasterized by the reference compositor, and (2) by the third-party lottie-web 5.13.0
// canvas renderer (devDependency only, injected from node_modules into a blank page of the
// isolated Chrome for Testing). Out-of-subset rigs are refused in the dialog.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { serializeProject } from '../../src/model/format.ts';
import { lottieFrame } from '../support/lottie-eval.ts';
import { lottieProject } from '../support/lottie-fixture.ts';
import { decodePng } from '../support/png-decode.ts';
import type { Decoded } from '../support/png-decode.ts';
import { compositeDraws, diffImages } from '../support/reference-composite.ts';
import { richProject } from '../support/runtime-fixture.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, ROOT, launchIsolated, pickPort, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/p4-lottie');
mkdirSync(OUT, { recursive: true });
const SUBSET = path.join(OUT, 'lottie-subset.rig.json');
const RICH = path.join(OUT, 'runtime-rig.rig.json');
writeFileSync(SUBSET, serializeProject(lottieProject()));
writeFileSync(RICH, serializeProject(richProject()));

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const report: string[] = [];

async function download(testId: string, file: string): Promise<string> {
  const dl = page.waitForEvent('download');
  await page.getByTestId(testId).click();
  const target = path.join(OUT, file);
  await (await dl).saveAs(target);
  return target;
}

async function open(file: string): Promise<void> {
  await page.getByTestId('open-input').setInputFiles(file);
  await page.waitForFunction((n) => (window as any).__rigsmith.project().name === n, JSON.parse(readFileSync(file, 'utf8')).name);
}

function frameDiff(name: string, lottie: any, seqZip: string) {
  const files = readZip(readFileSync(seqZip));
  const meta = JSON.parse(files.find((f) => f.name.endsWith('sequence.json'))!.data.toString('utf8'));
  assert.deepEqual([lottie.w, lottie.h, lottie.fr, lottie.op], [meta.width, meta.height, meta.fps, meta.frames.length], `${name}: composition = sequence canvas`);
  assert.deepEqual(lottie.meta.origin, [meta.origin.x, meta.origin.y]);
  const decoded = new Map<string, Decoded>();
  let over = 0, covered = 0, worstMean = 0;
  meta.frames.forEach((fr: any, i: number) => {
    const got = decodePng(files.find((f) => f.name === fr.file)!.data);
    const draws = lottieFrame(lottie, fr.frame).map((d) => {
      if (!decoded.has(d.asset.id)) decoded.set(d.asset.id, decodePng(Buffer.from(d.asset.p.split(',')[1], 'base64')));
      return { m: d.m, width: d.asset.w, height: d.asset.h, img: decoded.get(d.asset.id)!, opacity: d.opacity };
    });
    const ref = compositeDraws(draws, lottie.w, lottie.h, 0, 0, 1);
    const d = diffImages(got, ref, 24);
    over += d.over;
    covered += d.covered;
    worstMean = Math.max(worstMean, d.meanDiff);
    if (i === 15) writeFileSync(path.join(OUT, `${name}-f15-lottie-eval.json`), JSON.stringify(draws.map((x) => ({ m: x.m, opacity: x.opacity }))));
  });
  report.push(`${name}: ${meta.frames.length} frames, ${over} of ${covered} covered px over tolerance 24 (${((over / covered) * 100).toFixed(3)}%), worst mean ${worstMean.toFixed(3)}`);
  return { over, covered, worstMean };
}

/**
 * Plays an exported Lottie JSON in lottie-web's canvas renderer (a blank page, the player
 * script injected from node_modules) and returns each requested frame as decoded RGBA.
 */
async function lottieWebFrames(lottie: any, frames: number[]): Promise<Buffer[]> {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => pageErrors.push(`lottie-web: ${e.message}`));
  try {
    await p.goto('about:blank');
    await p.addScriptTag({ path: path.join(ROOT, 'node_modules/lottie-web/build/player/lottie_canvas.js') });
    const urls: string[] = await p.evaluate(async ([data, list]) => {
      const host = document.createElement('div');
      host.style.cssText = `position:absolute;left:0;top:0;width:${data.w}px;height:${data.h}px`;
      document.body.style.margin = '0';
      document.body.appendChild(host);
      const anim = (window as any).lottie.loadAnimation({
        container: host, renderer: 'canvas', loop: false, autoplay: false, animationData: data,
        rendererSettings: { clearCanvas: true, dpr: 1, preserveAspectRatio: 'xMidYMid meet' },
      });
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error('lottie-web did not load')), 10000);
        anim.addEventListener('DOMLoaded', () => { clearTimeout(t); res(); });
      });
      const canvas = host.querySelector('canvas')!;
      if (canvas.width !== data.w || canvas.height !== data.h) throw new Error(`canvas ${canvas.width}×${canvas.height}`);
      return list.map((f: number) => { anim.goToAndStop(f, true); return canvas.toDataURL('image/png'); });
    }, [lottie, frames] as const);
    return urls.map((u) => Buffer.from(u.split(',')[1], 'base64'));
  } finally {
    await p.close();
  }
}

/** Every editor sequence frame vs the same frame (or, for the timing control, frame + shift) drawn by lottie-web. */
async function webDiff(name: string, lottie: any, seqZip: string, shift = 0) {
  const files = readZip(readFileSync(seqZip));
  const meta = JSON.parse(files.find((f) => f.name.endsWith('sequence.json'))!.data.toString('utf8'));
  assert.deepEqual([lottie.w, lottie.h, lottie.fr, lottie.op], [meta.width, meta.height, meta.fps, meta.frames.length], `${name}: composition = sequence canvas`);
  const pngs = await lottieWebFrames(lottie, meta.frames.map((fr: any) => fr.frame));
  if (!shift) writeFileSync(path.join(OUT, `${name.split(' ')[0]}-f15-lottie-web.png`), pngs[15]);
  const web = pngs.map(decodePng);
  let over = 0, covered = 0, worstMean = 0, worstOver = 0;
  meta.frames.forEach((fr: any, i: number) => {
    const d = diffImages(decodePng(files.find((f) => f.name === fr.file)!.data), web[(i + shift) % web.length], 24);
    over += d.over;
    covered += d.covered;
    worstMean = Math.max(worstMean, d.meanDiff);
    worstOver = Math.max(worstOver, d.covered ? d.over / d.covered : 0);
  });
  report.push(`lottie-web ${name}: ${meta.frames.length} frames, ${over} of ${covered} covered px over tolerance 24 (${((over / covered) * 100).toFixed(3)}%), worst frame ${(worstOver * 100).toFixed(3)}%, worst mean ${worstMean.toFixed(3)}`);
  return { over, covered, worstMean, worstOver, frames: meta.frames.length };
}

function compareAll(name: string, lottie: any, seqZip: string) {
  const { over, covered, worstMean } = frameDiff(name, lottie, seqZip);
  assert.ok(over <= covered * 0.005, `${name}: ${over} px over tolerance`);
  assert.ok(worstMean <= 1.5, `${name}: mean ${worstMean}`);
}

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-p4-lottie');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
});

after(async () => {
  writeFileSync(path.join(OUT, 'report.txt'), report.join('\n') + '\n');
  await ctx?.close();
  server?.kill();
});

describe('Lottie subset export', () => {
  it('dialog: summary and notes for a rig inside the subset; export downloads the JSON', async () => {
    await open(SUBSET);
    await page.getByTestId('export-lottie').click();
    await page.getByTestId('lottie-dialog').waitFor();
    assert.equal(await page.getByTestId('lottie-anim').inputValue(), 'hop');
    const summary = await page.getByTestId('lottie-summary').innerText();
    report.push(`summary: ${summary}`);
    assert.match(summary, /^\d+×\d+ · 30 frames at 30 fps · \d+ image layer\(s\), 7 null layer\(s\), \d+ embedded PNG\(s\)$/);
    const diags = await page.getByTestId('lottie-diagnostics').innerText();
    assert.match(diags, /visibility \/ image keys — hop: Exported as separate image layers/);
    assert.match(diags, /in-repo Lottie subset evaluator and by lottie-web 5\.13\.0 \(canvas renderer, Chrome\); not tested in lottie-web’s SVG\/HTML renderers/);
    const file = await download('lottie-export', 'hop.lottie.json');
    await page.getByTestId('lottie-cancel').click();
    const L = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(L.v, '5.7.0');
    assert.ok(L.assets.every((a: any) => a.e === 1 && a.p.startsWith('data:image/png;base64,')));
  });

  it('every frame played by the independent evaluator matches the editor PNG sequence (no skin, skin)', async () => {
    const seq = async (file: string, skin: string) => {
      await page.getByTestId('export-sequence').click();
      await page.getByTestId('seq-anim').selectOption({ label: 'hop' });
      assert.equal(await page.getByTestId('seq-skin').locator('option:checked').innerText(), skin);
      return download('seq-export', file);
    };
    compareAll('hop', JSON.parse(readFileSync(path.join(OUT, 'hop.lottie.json'), 'utf8')), await seq('hop-seq.zip', '(no skin)'));
    await page.getByTestId('skin-active').selectOption({ label: 'alt' });
    await page.getByTestId('export-lottie').click();
    assert.match(await page.getByTestId('lottie-dialog').innerText(), /Skin \(from the editor\)\s*alt/);
    const alt = await download('lottie-export', 'hop-alt.lottie.json');
    await page.getByTestId('lottie-cancel').click();
    const altSeq = await seq('hop-alt-seq.zip', 'alt');
    compareAll('hop-alt', JSON.parse(readFileSync(alt, 'utf8')), altSeq);
    // Control: the comparison is sensitive — the no-skin Lottie does not match the skinned frames.
    const ctl = frameDiff('control (no-skin Lottie vs alt frames)', JSON.parse(readFileSync(path.join(OUT, 'hop.lottie.json'), 'utf8')), altSeq);
    assert.ok(ctl.over > ctl.covered * 0.05, `control differs: ${ctl.over}`);
    await page.getByTestId('skin-active').selectOption({ label: '(default images)' });
  });

  it('lottie-web 5.13.0 (canvas renderer) plays every frame of both exports like the editor sequence; wrong skin fails', async () => {
    // Budget declared before the first lottie-web run: per frame, px over tolerance 24
    // <= 0.5% of covered px and mean <= 1.5; the wrong-skin control must exceed 5%.
    const read = (f: string) => JSON.parse(readFileSync(path.join(OUT, f), 'utf8'));
    for (const [name, json, seqZip] of [['hop', 'hop.lottie.json', 'hop-seq.zip'], ['hop-alt', 'hop-alt.lottie.json', 'hop-alt-seq.zip']]) {
      const r = await webDiff(name, read(json), path.join(OUT, seqZip));
      assert.equal(r.frames, 30);
      assert.ok(r.worstOver <= 0.005, `${name}: worst frame ${(r.worstOver * 100).toFixed(3)}% over tolerance`);
      assert.ok(r.worstMean <= 1.5, `${name}: mean ${r.worstMean}`);
    }
    const ctl = await webDiff('control (no-skin Lottie vs alt frames)', read('hop.lottie.json'), path.join(OUT, 'hop-alt-seq.zip'));
    assert.ok(ctl.over > ctl.covered * 0.05, `control differs: ${ctl.over} of ${ctl.covered}`);
    // Timing control: lottie-web really advances — frame i+10 does not match editor frame i.
    const late = await webDiff('timing control (lottie-web frame i+10 vs editor frame i)', read('hop.lottie.json'), path.join(OUT, 'hop-seq.zip'), 10);
    assert.ok(late.over > late.covered * 0.05, `timing control differs: ${late.over} of ${late.covered}`);
    assert.deepEqual(pageErrors, []);
  });

  it('the CLI produces the identical file', () => {
    const out = path.join(OUT, 'cli-hop.lottie.json');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), 'lottie', SUBSET, '--anim', 'hop', '--out', out], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout);
    assert.equal(readFileSync(out, 'utf8'), readFileSync(path.join(OUT, 'hop.lottie.json'), 'utf8'));
  });

  it('refuses a rig outside the subset, listing each feature; export disabled; CLI exit 1', async () => {
    await open(RICH);
    await page.getByTestId('export-lottie').click();
    const diags = await page.getByTestId('lottie-diagnostics').innerText();
    for (const re of [/IK constraint — lower-ik/, /path constraint — path-follow/, /mesh — band/, /draw-order keys — wave/, /deform keys — band/]) assert.match(diags, re);
    assert.ok(await page.getByTestId('lottie-export').isDisabled());
    assert.equal(await page.getByTestId('lottie-summary').count(), 0);
    await page.getByTestId('lottie-cancel').click();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), 'lottie', RICH, '--anim', 'wave', '--out', path.join(OUT, 'nope.json')], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(JSON.parse(r.stdout).errors.join('\n'), /IK constraint — lower-ik/);
    assert.deepEqual(pageErrors, []);
  });
});
