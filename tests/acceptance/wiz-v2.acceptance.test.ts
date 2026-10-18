// Wiz greeting v2 acceptance: opens the separately saved UI-authored project
// (.hermes/assets/wiz/roadmap-output/wiz-v2.rig.json, made by
// scripts/roadmap/wiz-greeting-v2.ts) and measures it through visible controls.
// Needs the private, git-ignored Wiz assets. Run: npm run build && npm run test:wiz
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { launchIsolated, pickPort, probe, startPreview } from '../e2e/harness.ts';
import { borderAlphaCount, decodePng } from '../support/png-decode.ts';
import { composite, decodeProjectImages, diffImages } from '../support/reference-composite.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, PROJECT_FILE, WIZ } from '../../scripts/wiz/paths.ts';

const ROADMAP_OUT = path.join(WIZ, 'roadmap-output');
const V2_FILE = path.join(ROADMAP_OUT, 'wiz-v2.rig.json');
const BASELINE = path.resolve(import.meta.dirname, '../../.hermes/dispatch/roadmap/preservation-baseline.json');
const OUT = path.join(EVIDENCE, 'v2');
mkdirSync(OUT, { recursive: true });

type World = { x: number; y: number; angle: number };
let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let base: string;
const pageErrors: string[] = [];
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const wrap = (d: number) => ((d % 360) + 540) % 360 - 180;
const near = (a: number, b: number, eps: number, msg: string) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≈ ${b} ±${eps}`);
const project = () => probe<any>(page, 'project');
const world = async (n: string) => (await probe<{ world: World }>(page, 'bone', n)).world;
const BONES = ['root', 'body', 'leg_l', 'leg_r', 'arm_l', 'hand_l', 'arm_r', 'hand_r'];

async function gotoFrame(frame: number, frames: number): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
}

async function poses(anim: string, frames: number): Promise<Record<string, World>[]> {
  await page.getByTestId('anim-select').selectOption({ label: anim });
  const out: Record<string, World>[] = [];
  for (let f = 0; f <= frames; f++) {
    await gotoFrame(f, frames);
    near((await probe<{ time: number }>(page, 'state')).time, f / 30, 1e-6, `frame ${f}`);
    out.push(Object.fromEntries(await Promise.all(BONES.map(async (b) => [b, await world(b)] as const))));
  }
  return out;
}

before(async () => {
  assert.ok(existsSync(V2_FILE), `${V2_FILE} missing — run node scripts/roadmap/wiz-greeting-v2.ts first`);
  const port = await pickPort([47614, 47615, 47616, 47617]);
  base = `http://127.0.0.1:${port}/`;
  server = await startPreview(port);
  ctx = await launchIsolated('wiz-v2-verify');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(base);
  await page.getByTestId('open-input').setInputFiles(V2_FILE);
  await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length === 8);
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('Wiz v2 (UI-authored greeting with shaped motion)', () => {
  it('protected originals are unchanged and v1 content is carried over losslessly', async () => {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).files as Record<string, { sha256: string }>;
    for (const [file, { sha256 }] of Object.entries(baseline)) assert.equal(sha(readFileSync(file)), sha256, `${file} unchanged`);
    const original = JSON.parse(readFileSync(PROJECT_FILE, 'utf8'));
    const p = await project();
    assert.equal(p.version, 2);
    assert.deepEqual(p.bones, original.bones);
    assert.deepEqual(p.images, original.images, 'embedded art byte-identical');
    assert.deepEqual(p.attachments, original.attachments);
    for (const a of original.animations) assert.deepEqual(p.animations.find((x: any) => x.id === a.id), a, `"${a.name}" identical`);
    const v2 = p.animations.find((a: any) => a.name === 'greeting-v2');
    const keys = Object.values(v2.tracks).flatMap((t: any) => [...t.translate, ...t.rotate, ...t.scale]) as any[];
    assert.ok(keys.filter((k) => k.interp === 'bezier').length >= 6, 'custom curves present');
  });

  let v1: Record<string, World>[] = [];
  let v2: Record<string, World>[] = [];
  const rel = (p: Record<string, World>, c: string, par: string) => wrap(p[c].angle - p[par].angle);

  it('overshoot: the waving arm swings past its held raise angle; the glove peaks after the arm (follow-through)', async () => {
    v2 = await poses('greeting-v2', 72);
    v1 = await poses('greeting', 72);
    const rest = rel(v2[0], 'arm_r', 'body');
    const arm = v2.map((p) => wrap(rel(p, 'arm_r', 'body') - rest));
    const hold = arm[18]; // keyed raise: -80° (local) from rest
    // World angle also carries the body's non-uniform squash, so allow a small skew.
    near(hold, -80, 0.5, 'raise key value at f18');
    const raise = arm.slice(8, 25);
    const armPeak = Math.min(...raise);
    const armPeakFrame = 8 + raise.indexOf(armPeak);
    assert.ok(armPeak < hold - 2, `arm overshoots its hold: peak ${armPeak.toFixed(2)}° vs hold ${hold.toFixed(2)}°`);
    assert.ok(armPeakFrame < 18, `overshoot peak (f${armPeakFrame}) comes before the arm settles at f18`);
    // Anticipation: the arm first moves the opposite way (down/in) before the raise.
    assert.ok(Math.max(...arm.slice(0, 10)) > 10, `anticipation swing ${Math.max(...arm.slice(0, 10)).toFixed(2)}° before the raise`);
    const gRest = rel(v2[0], 'hand_r', 'arm_r');
    const glove = v2.map((p) => wrap(rel(p, 'hand_r', 'arm_r') - gRest));
    const gWin = glove.slice(8, 31).map(Math.abs);
    const gPeakFrame = 8 + gWin.indexOf(Math.max(...gWin));
    assert.ok(gPeakFrame > armPeakFrame, `glove peak f${gPeakFrame} after arm peak f${armPeakFrame}`);
    // Root dips (anticipation) before the hop.
    const rootY = v2.map((p) => p.root.y - v2[0].root.y);
    assert.ok(Math.max(...rootY.slice(0, 6)) > 4, 'root dips before the hop');
    assert.ok(Math.min(...rootY.slice(6, 14)) < -30, 'then hops');
    const v1arm = v1.map((p) => wrap(rel(p, 'arm_r', 'body') - rest));
    writeFileSync(path.join(OUT, 'motion-metrics.json'), JSON.stringify({
      v2: { armHoldDeg: hold, armPeakDeg: armPeak, armPeakFrame, anticipationDeg: Math.max(...arm.slice(0, 10)), glovePeakFrame: gPeakFrame, glovePeakDeg: glove[gPeakFrame], rootDipPx: Math.max(...rootY.slice(0, 6)) },
      v1: { armMinDeg: Math.min(...v1arm), armMinFrame: v1arm.indexOf(Math.min(...v1arm)), anticipationDeg: Math.max(...v1arm.slice(0, 10)) },
      armDegByFrame: { v1: v1arm.map((x) => +x.toFixed(2)), v2: arm.map((x) => +x.toFixed(2)) },
      gloveDegByFrame: { v2: glove.map((x) => +x.toFixed(2)) },
    }, null, 1));
  });

  it('loop seam: every bone at frame 72 equals frame 0 and the wrap step is not a jump', () => {
    for (const b of BONES) {
      near(v2[72][b].x, v2[0][b].x, 1e-6, `${b} x`);
      near(v2[72][b].y, v2[0][b].y, 1e-6, `${b} y`);
      near(wrap(v2[72][b].angle - v2[0][b].angle), 0, 1e-6, `${b} angle`);
    }
    const step = (i: number) => Math.max(...['hand_l', 'hand_r', 'root'].map((b) => Math.hypot(v2[i + 1][b].x - v2[i][b].x, v2[i + 1][b].y - v2[i][b].y)));
    const steps = Array.from({ length: 72 }, (_, i) => step(i));
    assert.ok(steps[71] <= Math.max(...steps.slice(0, 71)) + 1e-6, 'wrap step within inner motion');
  });

  it('exports through Export sequence… as 72 alpha frames that decode, share one size and match the reference', async () => {
    await page.getByTestId('export-sequence').click();
    await page.getByTestId('seq-anim').selectOption({ label: 'greeting-v2' });
    const dl = page.waitForEvent('download');
    await page.getByTestId('seq-export').click();
    const file = path.join(OUT, 'greeting-v2-seq.zip');
    await (await dl).saveAs(file);
    const files = readZip(readFileSync(file));
    const pngs = files.filter((f) => f.name.endsWith('.png'));
    const meta = JSON.parse(files.find((f) => f.name.endsWith('sequence.json'))!.data.toString('utf8'));
    assert.equal(pngs.length, 72, '2.4 s loop at 30 fps → 72 frames (frame 72 = frame 0 omitted)');
    const dims = new Set<string>();
    let translucent = 0;
    for (const f of pngs) {
      const img = decodePng(f.data);
      dims.add(`${img.width}x${img.height}`);
      assert.equal(borderAlphaCount(img), 0, `${f.name} outer ring transparent`);
      assert.equal(img.data[3], 0, `${f.name} background transparent`);
      for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0 && img.data[i] < 255) translucent++;
    }
    assert.equal(dims.size, 1, 'one frame size');
    assert.ok(translucent > 1000, 'anti-aliased alpha preserved (not thresholded)');
    const p = await project();
    const anim = p.animations.find((a: any) => a.name === 'greeting-v2');
    const imgs = decodeProjectImages(p);
    const report: string[] = [];
    for (const fr of [14, 27]) {
      const got = decodePng(pngs[fr].data);
      const ref = composite(p, anim, fr / 30, imgs, meta.width, meta.height, meta.origin.x, meta.origin.y, meta.scale);
      const d = diffImages(got, ref, 24);
      report.push(`greeting-v2 f${fr}: max ${d.maxDiff.toFixed(1)} mean ${d.meanDiff.toFixed(3)} >24/255: ${d.over} of ${d.covered} covered px`);
      assert.ok(d.over <= d.covered * 0.01 && d.meanDiff < 1.5, report.at(-1));
    }
    writeFileSync(path.join(OUT, 'reference-diff.txt'), report.join('\n') + '\n');
  });

  it('raised no uncaught page errors', () => {
    assert.deepEqual(pageErrors, []);
  });
});
