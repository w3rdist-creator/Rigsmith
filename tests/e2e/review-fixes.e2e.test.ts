// Regressions for the drwdmrs3 roadmap review (docs/DRWDMRS3-FIX-DELIVERY.md), driven
// through visible controls; window.__rigsmith / __rigsmithPlayer are read-only probes
// used for assertions only. Every input file is generated here from original pixels.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { serializeProject } from '../../src/model/format.ts';
import { gridPoints, triangulate } from '../../src/model/meshOps.ts';
import type { Project } from '../../src/model/types.ts';
import { encodePng } from '../support/png-encode.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'post-review/review-fixes');
mkdirSync(OUT, { recursive: true });

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let base: string;
const pageErrors: string[] = [];
const state = () => probe<any>(page, 'state');
const project = () => probe<any>(page, 'project');

/** A 400×400 opaque panel meshed as an 8×8 grid on a 30 px bone with a 30 px child (Auto weights uses the attachment's bone and its descendants). */
function panelRig(): Project {
  const W = 400, H = 400;
  const px = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) px.set([200, 120, 60, 255], i * 4);
  const dataUrl = `data:image/png;base64,${Buffer.from(encodePng(W, H, px)).toString('base64')}`;
  const g = gridPoints(W, H, 8, 8);
  return {
    format: 'rigsmith.project', version: 2, name: 'panel',
    images: [{ id: 'im', name: 'panel.png', mime: 'image/png', width: W, height: H, dataUrl }],
    bones: [
      { id: 'root', name: 'root', parentId: null, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 30, color: '#8fd3c8' },
      { id: 'tip', name: 'tip', parentId: 'root', x: 30, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 30, color: '#8fd3c8' },
    ],
    attachments: [{ id: 'a', name: 'panel', boneId: 'root', imageId: 'im', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, mesh: triangulate(g.hull, g.interior) }],
    animations: [{ id: 'an', name: 'idle', duration: 1, fps: 30, loop: true, tracks: {} }],
  };
}

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  base = `http://127.0.0.1:${port}/`;
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-review-fixes');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(base);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('P1-1: Auto weights on a large part bound to short bones', () => {
  it('weights every vertex (nearest bone wins), is one undo step, and raises no error', async () => {
    const file = path.join(OUT, 'panel.rig.json');
    writeFileSync(file, serializeProject(panelRig()));
    await page.getByTestId('open-input').setInputFiles(file);
    await page.waitForFunction(() => (window as any).__rigsmith.project().attachments.length === 1);
    await page.getByTestId('tree-att-panel').click();
    assert.equal(await page.getByTestId('mesh-summary').innerText(), '81 vertices · 128 triangles · rigid');
    const undo0 = (await state()).undo;
    await page.getByTestId('weights-auto').click();
    assert.equal(await page.getByTestId('mesh-summary').innerText(), '81 vertices · 128 triangles · weighted (2 bones)');
    assert.equal((await state()).undo, undo0 + 1, 'one undo step');
    const mesh = (await project()).attachments[0].mesh;
    const seg = (x: number, y: number, ax: number, bx: number) => {
      const t = Math.max(0, Math.min(1, (x - ax) / (bx - ax)));
      return Math.hypot(x - ax - t * (bx - ax), y);
    };
    let far = 0;
    mesh.weights.forEach((l: { bone: string; w: number }[], i: number) => {
      assert.ok(Math.abs(l.reduce((s, x) => s + x.w, 0) - 1) < 1e-9, `vertex ${i} sums to 1`);
      // Image centred on the attachment; both bones lie on the x axis (0–30, 30–60).
      const x = mesh.points[2 * i] - 200, y = mesh.points[2 * i + 1] - 200;
      const d0 = seg(x, y, 0, 30), d1 = seg(x, y, 30, 60);
      if (Math.min(d0, d1) > 100) far++;
      if (Math.abs(d0 - d1) > 1e-6) assert.equal(l[0].bone, d0 < d1 ? 'root' : 'tip', `vertex ${i}: nearest bone`);
    });
    assert.ok(far > 20, `many vertices are > 100 px from both bones (${far})`);
    assert.equal(await page.getByTestId('error-toast').count(), 0);
    await page.keyboard.press('Control+z');
    assert.equal(await page.getByTestId('mesh-summary').innerText(), '81 vertices · 128 triangles · rigid', 'undo restores the rigid mesh');
    assert.deepEqual(pageErrors, []);
  });

  it('an exception escaping an event handler is shown as an error toast (safety net)', async () => {
    // No remaining UI path is known to throw; a real uncaught exception from a callback
    // exercises the global handler that would have surfaced the original P1-1 failure.
    await page.evaluate(() => void setTimeout(() => {
      throw new Error('review probe: uncaught handler failure');
    }));
    const toast = page.getByTestId('error-toast').filter({ hasText: 'review probe: uncaught handler failure' });
    await toast.waitFor({ state: 'visible', timeout: 3000 });
    assert.match(await toast.innerText(), /Action failed/);
    await toast.getByRole('button', { name: 'Dismiss' }).click();
    assert.equal(await page.getByTestId('error-toast').count(), 0);
    pageErrors.splice(0, pageErrors.length, ...pageErrors.filter((e) => !e.includes('review probe')));
    assert.deepEqual(pageErrors, []);
  });
});
