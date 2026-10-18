// Regressions for the drwdmrs3 roadmap review (docs/DRWDMRS3-FIX-DELIVERY.md), driven
// through visible controls; window.__rigsmith / __rigsmithPlayer are read-only probes
// used for assertions only. Every input file is generated here from original pixels.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { exportRuntime } from '../../src/model/exportRuntime.ts';
import { serializeProject } from '../../src/model/format.ts';
import { gridPoints, triangulate } from '../../src/model/meshOps.ts';
import type { Project } from '../../src/model/types.ts';
import { encodePng } from '../support/png-encode.ts';
import { richProject } from '../support/runtime-fixture.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'post-review/review-fixes');
mkdirSync(OUT, { recursive: true });

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let player: Page;
let base: string;
const pageErrors: string[] = [];
const playerErrors: string[] = [];
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
  player = await ctx.newPage();
  player.on('pageerror', (e) => playerErrors.push(e.message));
  await player.goto(`${base}player.html`);
  await player.getByTestId('player-files').waitFor({ state: 'attached' });
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

describe('P2-2 / P3-1: the reference player validates runtime files and never shows a stale frame', () => {
  // Runtime files are generated from the shared fixture with the model exporter (the
  // editor-UI export path is covered by p4-player); malformed variants mutate one field.
  const DIR = path.join(OUT, 'player');
  mkdirSync(DIR, { recursive: true });
  const fixture = richProject();
  const images = fixture.images.map((im) => {
    const f = path.join(DIR, im.name);
    writeFileSync(f, Buffer.from(im.dataUrl.split(',')[1], 'base64'));
    return f;
  });
  const runtime = (name: string, mutate: (o: any) => void = () => {}) => {
    const o = JSON.parse(JSON.stringify(exportRuntime(fixture)));
    mutate(o);
    const f = path.join(DIR, `${name}.runtime.json`);
    writeFileSync(f, JSON.stringify(o));
    return f;
  };
  const view = () => player.evaluate(() => {
    const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
    const c = q('player-canvas') as HTMLCanvasElement;
    return {
      status: q('player-status').textContent!,
      errors: q('player-errors').hidden ? '' : q('player-errors').innerText,
      canvas: `${c.width}x${c.height}`,
      sliderMax: (q('player-time') as HTMLInputElement).max,
      label: q('player-frame-label').textContent,
      probe: (window as any).__rigsmithPlayer.state(),
    };
  });
  async function load(file: string) {
    await player.getByTestId('player-files').setInputFiles([file, ...images]);
    await player.waitForFunction(() => document.querySelector('[data-testid="player-status"]')!.textContent !== 'Loading…');
  }
  async function loadValid() {
    await load(runtime('valid'));
    const v = await view();
    assert.match(v.status, /^Loaded “runtime-rig” \(runtime v2\)/);
    assert.equal(v.errors, '');
    assert.notEqual(v.canvas, '0x0');
    assert.equal(v.probe.frames, 30);
  }

  const malformed: [string, (o: any) => void, RegExp][] = [
    ['bone-cycle', (o) => { o.bones[0].parent = o.bones[o.bones.length - 1].name; }, /cycle/],
    ['string-number', (o) => { o.bones[1].x = 'oops'; }, /bones\[1\]\.x must be a finite number/],
    ['tri-out-of-range', (o) => { o.attachments.find((x: any) => x.mesh).mesh.triangles[0] = 9999; }, /triangles must be index triples/],
    ['deform-arity', (o) => { for (const an of o.animations) for (const st of Object.values<any>(an.slots)) if (st.deform) st.deform.forEach((k: any) => (k.value = [1])); }, /deform.*must hold \d+ offsets/],
    ['fps-zero', (o) => { for (const an of o.animations) an.fps = 0; }, /fps must be an integer from 1 to 240/],
  ];
  for (const [name, mutate, pattern] of malformed) {
    it(`a valid file, then ${name}: rejected with the reason; the previous frame is cleared`, async () => {
      await loadValid();
      await load(runtime(name, mutate));
      const v = await view();
      assert.equal(v.status, 'Not loaded.');
      assert.match(v.errors, pattern);
      assert.equal(v.canvas, '0x0', 'no stale frame');
      assert.equal(v.sliderMax, '0');
      assert.equal(v.label, '');
      assert.equal(v.probe.loaded, false);
      assert.deepEqual(playerErrors, []);
    });
  }

  it('a loadable file whose animation cannot be prepared: status says so, canvas cleared; another animation recovers', async () => {
    await loadValid();
    // 100 s at 60 fps = 6000 frames (looping: frame 0 is not repeated), over the 2000-frame sequence limit (valid file, failing prepare).
    await load(runtime('too-long', (o) => { o.animations[0].duration = 100; o.animations[0].fps = 60; }));
    let v = await view();
    assert.match(v.errors, /6000 frames is more than the 2000-frame limit/);
    assert.match(v.status, /“wave” cannot be shown/);
    assert.equal(v.canvas, '0x0', 'no stale frame');
    assert.equal(v.sliderMax, '0');
    assert.equal(v.probe.frames, 0);
    await player.getByTestId('player-play').click();
    assert.equal((await view()).probe.playing, false, 'nothing to play');
    await player.getByTestId('player-anim').selectOption('rest');
    v = await view();
    assert.match(v.status, /^Loaded “runtime-rig”/);
    assert.equal(v.errors, '');
    assert.notEqual(v.canvas, '0x0');
    assert.equal(v.probe.frames, 16);
    assert.deepEqual(playerErrors, []);
  });
});
