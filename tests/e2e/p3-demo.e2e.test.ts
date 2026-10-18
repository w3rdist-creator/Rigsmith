// Phase 3 demo acceptance: the bendy-limb / secondary-motion rig is built through the UI
// (scripts/roadmap/demo-phase3-build.ts) and its exported frames are checked against the
// independent reference rasterizer, including seam-free interiors across the bends.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { buildBendyDemo } from '../../scripts/roadmap/demo-phase3-build.ts';
import { writeMeshArt } from '../support/mesh-fixtures.ts';
import { decodePng } from '../support/png-decode.ts';
import { boneWorlds, composite, decodeProjectImages, diffImages, interiorAlpha, meshScreenVertices } from '../support/reference-composite.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/p3-demo');
mkdirSync(path.join(OUT, 'art'), { recursive: true });
const art = writeMeshArt(path.join(OUT, 'art'));

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const report: string[] = [];

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-p3-demo');
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

describe('bendy-limb / secondary-motion demo', () => {
  it('builds through the UI: two weighted meshes, follow-through bone keys and tail deform keys', async () => {
    report.push(...(await buildBendyDemo(page, art)));
    const p = await probe<any>(page, 'project');
    const arm = p.attachments.find((a: any) => a.name === 'hose-arm');
    const tail = p.attachments.find((a: any) => a.name === 'tail');
    assert.equal(arm.mesh.weights.length, arm.mesh.points.length / 2);
    assert.equal(new Set(tail.mesh.weights.flat().map((x: any) => x.bone)).size, 3, 'tail weighted to three bones');
    const deform = p.animations[0].slots[tail.id].deform;
    assert.deepEqual(deform.map((k: any) => Math.round(k.time * 30)), [0, 33, 60], 'rest, flick, loop seam');
    assert.ok(deform[1].value.some((v: number) => Math.abs(v) > 5), 'flick moved tip vertices');
    const elbow = p.bones.find((b: any) => b.name === 'elbow').id;
    assert.deepEqual(p.animations[0].tracks[elbow].rotate.map((k: any) => [Math.round(k.time * 30), k.value[0]]), [[0, 0], [15, -80], [30, -10], [45, -80], [60, 0]], 'elbow keys incl. the f0 rest key and loop seam');
  });

  for (const frame of [0, 15, 26, 33, 45]) {
    it(`frame ${frame} matches the independent reference with seam-free interiors`, async () => {
      await page.getByTestId('export-sequence').click();
      for (const id of ['seq-start', 'seq-end']) {
        await page.getByTestId(id).fill(String(frame));
        await page.getByTestId(id).press('Enter');
      }
      const dl = page.waitForEvent('download');
      await page.getByTestId('seq-export').click();
      const zip = path.join(OUT, `demo-f${frame}.zip`);
      await (await dl).saveAs(zip);
      await page.keyboard.press('Escape');
      const files = readZip(readFileSync(zip));
      const meta = JSON.parse(files.find((x) => x.name.endsWith('sequence.json'))!.data.toString('utf8'));
      const got = decodePng(files.find((x) => x.name.endsWith('.png'))!.data);
      const p = await probe<any>(page, 'project');
      const anim = p.animations[0];
      const t = frame / anim.fps;
      const ref = composite(p, anim, t, decodeProjectImages(p), meta.width, meta.height, meta.origin.x, meta.origin.y, meta.scale);
      const d = diffImages(got, ref, 24);
      const ia = interiorAlpha(got, ref, 255, 2);
      report.push(`f${frame}: max ${d.maxDiff.toFixed(1)} mean ${d.meanDiff.toFixed(3)} over24 ${d.over}/${d.covered} | interior α255±2: ${ia.n} px, min ${ia.min}, off ${ia.bad}`);
      assert.ok(d.over <= d.covered * 0.01 && d.meanDiff < 1.5, `reference diff ${JSON.stringify(d)}`);
      assert.ok(ia.n > 2000 && ia.bad === 0, `no seams across the bends (${JSON.stringify(ia)})`);
      // The arm really bends: the angle between its first and last mesh segments.
      const arm = p.attachments.find((a: any) => a.name === 'hose-arm');
      const v = meshScreenVertices(arm, undefined, t, p, boneWorlds(p, anim, t), boneWorlds(p, null, 0), [1, 0, 0, 1, 0, 0]);
      const ang = (i: number, j: number) => Math.atan2(v[2 * j + 1] - v[2 * i + 1], v[2 * j] - v[2 * i]);
      const bend = Math.abs(((ang(10, 12) - ang(0, 2) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * (180 / Math.PI);
      report.push(`  arm bend (top edge, end vs start): ${bend.toFixed(1)}°`);
      if (frame === 0) assert.ok(bend < 25, `rest pose nearly straight (${bend.toFixed(1)}°)`);
      if (frame === 15 || frame === 45) assert.ok(bend > 60, `bent at the elbow key (${bend.toFixed(1)}°)`);
    });
  }

  it('raised no uncaught page errors', () => {
    assert.deepEqual(pageErrors, []);
  });
});
