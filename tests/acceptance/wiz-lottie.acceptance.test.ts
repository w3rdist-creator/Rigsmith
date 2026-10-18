// Wiz Lottie acceptance (use-case review RV-008). The flat, FK-only greeting-demo project
// (.hermes/evidence/wiz-v2-demo/project/wiz-greeting-demo.rig.json, opened read-only) is
// exported through the Export Lottie dialog. Every frame is played by the in-repo subset
// evaluator and by lottie-web 5.13.0 (canvas) and compared with the editor's own PNG
// sequence of the same animation, with the budget of tests/e2e/p4-lottie.e2e.test.ts.
// The articulated, meshed Wiz v3 is refused with diagnostics naming each IK constraint and
// mesh. Mesh support is not claimed; constraint baking is not implemented (decision record:
// docs/WIZ-V3-DELIVERY.md). Needs the private, git-ignored Wiz assets.
// Run: npm run build && npm run test:wiz
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { launchIsolated, pickPort, probe, startPreview } from '../e2e/harness.ts';
import { lottieWebFrames } from '../e2e/lottie-web.ts';
import { lottieFrame } from '../support/lottie-eval.ts';
import type { Decoded } from '../support/png-decode.ts';
import { decodePng } from '../support/png-decode.ts';
import { compositeDraws, diffImages } from '../support/reference-composite.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, ROOT, WIZ } from '../../scripts/wiz/paths.ts';

const DEMO_FILE = path.join(ROOT, '.hermes/evidence/wiz-v2-demo/project/wiz-greeting-demo.rig.json');
const DEMO_SHA = '2a3f47f8a7471a1af5ef4cf001040653dec49f76a06005066345741fcff0c9c8';
const V3_FILE = path.join(WIZ, 'v3-output/wiz-v3.rig.json');
const OUT = path.join(EVIDENCE, 'lottie');
mkdirSync(OUT, { recursive: true });

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const report: string[] = [];
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

async function download(testId: string, file: string): Promise<string> {
  const dl = page.waitForEvent('download');
  await page.getByTestId(testId).click();
  const target = path.join(OUT, file);
  await (await dl).saveAs(target);
  return target;
}

async function open(file: string): Promise<void> {
  await page.getByTestId('open-input').setInputFiles(file);
  await page.waitForFunction((n) => (window as any).__rigsmith.project().name === n && !(window as any).__rigsmith.state().dirty, readJson(file).name);
}

function sequence(seqZip: string): { meta: any; png: (fr: any) => Decoded } {
  const files = readZip(readFileSync(seqZip));
  const meta = JSON.parse(files.find((f) => f.name.endsWith('sequence.json'))!.data.toString('utf8'));
  return { meta, png: (fr) => decodePng(files.find((f) => f.name === fr.file)!.data) };
}

/** Per frame: px over tolerance 24 as a share of covered px, and the mean difference. */
function score(name: string, pairs: [Decoded, Decoded][]) {
  let over = 0, covered = 0, worstMean = 0, worstOver = 0;
  for (const [got, ref] of pairs) {
    const d = diffImages(got, ref, 24);
    over += d.over;
    covered += d.covered;
    worstMean = Math.max(worstMean, d.meanDiff);
    worstOver = Math.max(worstOver, d.covered ? d.over / d.covered : 0);
  }
  report.push(`${name}: ${pairs.length} frames, ${over} of ${covered} covered px over tolerance 24 (${((over / covered) * 100).toFixed(3)}%), worst frame ${(worstOver * 100).toFixed(3)}%, worst mean ${worstMean.toFixed(3)}`);
  return { over, covered, worstMean, worstOver, frames: pairs.length };
}

before(async () => {
  assert.ok(existsSync(DEMO_FILE), `${DEMO_FILE} missing`);
  assert.ok(existsSync(V3_FILE), `${V3_FILE} missing — run node scripts/roadmap/wiz-v3.ts first`);
  const port = await pickPort([47614, 47615, 47616, 47617]);
  server = await startPreview(port);
  ctx = await launchIsolated('wiz-lottie-verify', [], { viewport: { width: 1600, height: 1000 } });
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

describe('Wiz Lottie delivery — RV-008', () => {
  it('flat greeting-demo: the dialog exports greeting-demo inside the subset (no refusals)', async () => {
    assert.equal(sha(readFileSync(DEMO_FILE)), DEMO_SHA, 'greeting-demo project unchanged before');
    await open(DEMO_FILE);
    const p = await probe<any>(page, 'project');
    assert.equal(p.frame, undefined, 'greeting-demo has no project frame: both exports fit the animation');
    await page.getByTestId('export-lottie').click();
    await page.getByTestId('lottie-dialog').waitFor();
    await page.getByTestId('lottie-anim').selectOption('greeting-demo');
    const summary = await page.getByTestId('lottie-summary').innerText();
    const diags = await page.getByTestId('lottie-diagnostics').innerText();
    report.push(`greeting-demo summary: ${summary}`, `greeting-demo diagnostics:\n${diags}`);
    assert.match(summary, /^\d+×\d+ · 72 frames at 30 fps · \d+ image layer\(s\), \d+ null layer\(s\), \d+ embedded PNG\(s\)$/);
    assert.ok(!/✖/.test(diags), `no refusal: ${diags}`);
    assert.ok(await page.getByTestId('lottie-export').isEnabled());
    const file = await download('lottie-export', 'greeting-demo.lottie.json');
    await page.getByTestId('lottie-cancel').click();
    const L = readJson(file);
    assert.equal(L.v, '5.7.0');
    assert.ok(L.assets.every((a: any) => a.e === 1 && a.p.startsWith('data:image/png;base64,')));
    // The editor's own PNG sequence of the same animation, same (fit) canvas.
    await page.getByTestId('export-sequence').click();
    await page.getByTestId('seq-anim').selectOption({ label: 'greeting-demo' });
    assert.equal(await page.getByTestId('seq-frame').inputValue(), 'fit');
    await download('seq-export', 'greeting-demo-seq.zip');
    const { meta } = sequence(path.join(OUT, 'greeting-demo-seq.zip'));
    assert.deepEqual([L.w, L.h, L.fr, L.op], [meta.width, meta.height, meta.fps, meta.frames.length], 'composition = sequence canvas');
    assert.deepEqual(L.meta.origin, [meta.origin.x, meta.origin.y]);
  });

  it('every frame played by the independent subset evaluator matches the editor sequence', () => {
    const L = readJson(path.join(OUT, 'greeting-demo.lottie.json'));
    const { meta, png } = sequence(path.join(OUT, 'greeting-demo-seq.zip'));
    const assets = new Map<string, Decoded>();
    const pairs = meta.frames.map((fr: any): [Decoded, Decoded] => {
      const draws = lottieFrame(L, fr.frame).map((d) => {
        if (!assets.has(d.asset.id)) assets.set(d.asset.id, decodePng(Buffer.from(d.asset.p.split(',')[1], 'base64')));
        return { m: d.m, width: d.asset.w, height: d.asset.h, img: assets.get(d.asset.id)!, opacity: d.opacity };
      });
      return [png(fr), compositeDraws(draws, L.w, L.h, 0, 0, 1)];
    });
    const r = score('evaluator greeting-demo', pairs);
    assert.ok(r.over <= r.covered * 0.005, `${r.over} px over tolerance`);
    assert.ok(r.worstMean <= 1.5, `mean ${r.worstMean}`);
  });

  it('lottie-web 5.13.0 (canvas renderer) plays every frame within the p4 budget; a frame-shifted control fails', async () => {
    // Budget (tests/e2e/p4-lottie.e2e.test.ts): per frame, px over tolerance 24 <= 0.5% of
    // covered px and mean <= 1.5; the control must exceed 5%.
    const L = readJson(path.join(OUT, 'greeting-demo.lottie.json'));
    const { meta, png } = sequence(path.join(OUT, 'greeting-demo-seq.zip'));
    const shots = await lottieWebFrames(ctx, L, meta.frames.map((fr: any) => fr.frame), (m) => pageErrors.push(m));
    for (const f of [0, 10, 15, 36]) writeFileSync(path.join(OUT, `greeting-demo-f${f}-lottie-web.png`), shots[f]);
    const web = shots.map(decodePng);
    const editor = meta.frames.map(png);
    const r = score('lottie-web greeting-demo', editor.map((e: Decoded, i: number): [Decoded, Decoded] => [e, web[i]]));
    assert.equal(r.frames, 72);
    assert.ok(r.worstOver <= 0.005, `worst frame ${(r.worstOver * 100).toFixed(3)}% over tolerance`);
    assert.ok(r.worstMean <= 1.5, `mean ${r.worstMean}`);
    const late = score('timing control (lottie-web frame i+10 vs editor frame i)', editor.map((e: Decoded, i: number): [Decoded, Decoded] => [e, web[(i + 10) % web.length]]));
    assert.ok(late.over > late.covered * 0.05, `timing control differs: ${late.over} of ${late.covered}`);
  });

  it('the CLI writes the identical Lottie file; the demo project is unchanged', () => {
    const out = path.join(OUT, 'cli-greeting-demo.lottie.json');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), 'lottie', DEMO_FILE, '--anim', 'greeting-demo', '--out', out], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(out, 'utf8'), readFileSync(path.join(OUT, 'greeting-demo.lottie.json'), 'utf8'));
    assert.equal(sha(readFileSync(DEMO_FILE)), DEMO_SHA, 'greeting-demo project unchanged after');
  });

  it('meshed, IK Wiz v3: refused for both loops, naming every IK constraint and mesh; export disabled; CLI exit 1', async () => {
    const v3 = readJson(V3_FILE);
    await open(V3_FILE);
    const iks: string[] = v3.ik.map((c: any) => c.name);
    const meshes: string[] = v3.attachments.filter((a: any) => a.mesh).map((a: any) => a.name);
    assert.equal(iks.length, 4);
    assert.equal(meshes.length, 5);
    await page.getByTestId('export-lottie').click();
    await page.getByTestId('lottie-dialog').waitFor();
    for (const anim of ['idle-v3', 'greeting-v3']) {
      await page.getByTestId('lottie-anim').selectOption(anim);
      const diags = await page.getByTestId('lottie-diagnostics').innerText();
      if (anim === 'greeting-v3') report.push(`v3 ${anim} diagnostics:\n${diags}`);
      for (const n of iks) assert.match(diags, new RegExp(`✖ IK constraint — ${n}:`), `${anim}: refuses IK ${n}`);
      for (const n of meshes) assert.match(diags, new RegExp(`✖ mesh — ${n}:`), `${anim}: refuses mesh ${n}`);
      assert.ok(await page.getByTestId('lottie-export').isDisabled(), `${anim}: export disabled`);
      assert.equal(await page.getByTestId('lottie-summary').count(), 0);
    }
    await page.getByTestId('lottie-cancel').click();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), 'lottie', V3_FILE, '--anim', 'greeting-v3', '--out', path.join(OUT, 'nope.json')], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 1);
    const errors = JSON.parse(r.stdout).errors.join('\n');
    for (const n of [...iks.map((n) => `IK constraint — ${n}`), ...meshes.map((n) => `mesh — ${n}`)]) assert.ok(errors.includes(n), `CLI names ${n}`);
    assert.ok(!existsSync(path.join(OUT, 'nope.json')), 'no file written on refusal');
    assert.deepEqual(pageErrors, []);
  });
});
