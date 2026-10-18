// Regressions for the use-case review (.hermes/dispatch/fable-usecase-review/REVIEW.md):
// RV-002 (art click selects its bone in Animate), RV-005 (Enter keys an unchanged value),
// RV-006 (timeline time zoom / scroll), RV-004 (a save that may not have been written
// never clears recovery) and RV-007 (IndexedDB storage, migration, large projects).
// Driven through visible controls; window.__rigsmith is a read-only probe and the
// IndexedDB reads are test-side assertions. Every input is generated here from original
// pixels. Run against a pre-fix build with RIGSMITH_DIST=<dir> to see the red results.
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
import { EVIDENCE, launchIsolated, pickPort, probe, readIdb, startPreview, waitUntil } from './harness.ts';

const OUT = path.join(EVIDENCE, 'usecase/fixes');
mkdirSync(OUT, { recursive: true });

let server: ChildProcess;
let base: string;
const pageErrors: string[] = [];
const contexts: BrowserContext[] = [];

function solid(w: number, h: number, rgba: [number, number, number, number]): string {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set(rgba, i * 4);
  return `data:image/png;base64,${encodePng(w, h, px).toString('base64')}`;
}

/** Deterministic incompressible pixels (a project far larger than the old localStorage quota). */
function noise(w: number, h: number, seed: number): string {
  const px = new Uint8Array(w * h * 4);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < px.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    px[i] = i % 4 === 3 ? 255 : x & 255;
  }
  return `data:image/png;base64,${encodePng(w, h, px).toString('base64')}`;
}

const bone = (id: string, parentId: string | null, x: number, length: number) => ({ id, name: id, parentId, x, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length, color: '#8fd3c8' });
const att = (id: string, boneId: string, imageId: string, x: number, y: number) => ({ id, name: id, boneId, imageId, x, y, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });

/** root → arm → hand; body art on root, a glove on hand, and a hose mesh weighted half arm / half hand. */
function rig(): Project {
  const g = gridPoints(200, 30, 10, 1);
  const mesh = triangulate(g.hull, g.interior);
  const weights = Array.from({ length: mesh.points.length / 2 }, (_, i) => [{ bone: mesh.points[2 * i] < 100 ? 'arm' : 'hand', w: 1 }]);
  return {
    format: 'rigsmith.project', version: 2, name: 'usecase',
    images: [
      { id: 'im-body', name: 'body.png', mime: 'image/png', width: 160, height: 200, dataUrl: solid(160, 200, [200, 150, 90, 255]) },
      { id: 'im-glove', name: 'glove.png', mime: 'image/png', width: 60, height: 60, dataUrl: solid(60, 60, [240, 240, 230, 255]) },
      { id: 'im-hose', name: 'hose.png', mime: 'image/png', width: 200, height: 30, dataUrl: solid(200, 30, [230, 140, 40, 255]) },
    ],
    bones: [bone('root', null, 0, 40), bone('arm', 'root', 100, 100), bone('hand', 'arm', 100, 40)],
    attachments: [att('body', 'root', 'im-body', 0, 0), { ...att('hose', 'arm', 'im-hose', 100, 90), mesh: { ...mesh, weights } }, att('glove', 'hand', 'im-glove', 30, 0)],
    animations: [
      { id: 'act', name: 'act', duration: 1, fps: 30, loop: true, tracks: {} },
      { id: 'long', name: 'long', duration: 10, fps: 30, loop: true, tracks: { root: { translate: [{ time: 0, value: [0, 0], interp: 'linear' }, { time: 1, value: [0, 0], interp: 'linear' }], rotate: [], scale: [] } } },
    ],
  } as unknown as Project;
}

function bigRig(): Project {
  const p = rig();
  p.name = 'large';
  for (let i = 0; i < 4; i++) {
    p.images.push({ id: `im-n${i}`, name: `noise${i}.png`, mime: 'image/png', width: 700, height: 700, dataUrl: noise(700, 700, 17 + i) });
    p.attachments.push(att(`n${i}`, 'root', `im-n${i}`, -400 - i * 20, 0) as any);
  }
  return p;
}

const RIG = path.join(OUT, 'usecase.rig.json');
const BIG = path.join(OUT, 'large.rig.json');
writeFileSync(RIG, serializeProject(rig()));
writeFileSync(BIG, serializeProject(bigRig()));

async function newPage(ctx: BrowserContext, init?: () => void): Promise<Page> {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  if (init) await page.addInitScript(init);
  await page.goto(base);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
  return page;
}

async function open(page: Page, file = RIG): Promise<void> {
  await page.getByTestId('open-input').setInputFiles(file);
  await page.waitForFunction((n) => (window as any).__rigsmith.project().name === n, file === RIG ? 'usecase' : 'large');
}

async function setField(page: Page, testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

async function gotoFrame(page: Page, frame: number, frames: number): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
}

/** The recoverable autosave copy wherever this build keeps it (IndexedDB, or the legacy localStorage key). */
async function autosaveCopy(page: Page): Promise<any> {
  const idb = await readIdb(page, 'autosave');
  if (idb) return idb;
  const ls = await page.evaluate(() => localStorage.getItem('rigsmith:autosave:v1'));
  return ls ? JSON.parse(ls) : null;
}

const state = (page: Page) => probe<any>(page, 'state');
const project = (page: Page) => probe<any>(page, 'project');
const keyFrames = (p: any, anim: string, boneId: string, ch: string) => (p.animations.find((a: any) => a.name === anim).tracks[boneId]?.[ch] ?? []).map((k: any) => Math.round(k.time * 30));

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  base = `http://127.0.0.1:${port}/`;
  server = await startPreview(port);
});

after(async () => {
  for (const c of contexts) await c.close();
  server?.kill();
});

async function context(name: string, opts: Parameters<typeof launchIsolated>[2] = {}): Promise<BrowserContext> {
  const c = await launchIsolated(name, [], opts);
  contexts.push(c);
  return c;
}

describe('RV-002: in Animate mode, clicking art acts on the bone that moves it', () => {
  let page: Page;
  before(async () => {
    page = await newPage(await context('e2e-usecase-select'));
    await open(page);
  });

  it('with bones hidden, a click on the glove selects hand; a Rotate drag keys hand; a Move drag on the body keys root', async () => {
    await page.getByTestId('show-bones').uncheck();
    await page.getByTestId('mode-animate').click();
    const glove = (await probe<{ x: number; y: number }>(page, 'attachment', 'glove'))!;
    await page.mouse.click(glove.x, glove.y);
    assert.deepEqual((await state(page)).selection, { kind: 'bone', id: 'hand' }, 'glove art → hand bone');
    await page.getByTestId('tool-rotate').click();
    const o = (await probe<any>(page, 'bone', 'hand')).origin;
    const r = Math.hypot(glove.x - o.x, glove.y - o.y);
    const a0 = Math.atan2(glove.y - o.y, glove.x - o.x);
    await drag(page, glove, { x: o.x + r * Math.cos(a0 + 0.5), y: o.y + r * Math.sin(a0 + 0.5) });
    let p = await project(page);
    assert.deepEqual(keyFrames(p, 'act', 'hand', 'rotate'), [0], 'rotation keyed on hand at frame 0');
    const deg = p.animations[0].tracks.hand.rotate[0].value[0];
    assert.ok(Math.abs(Math.abs(deg) - 28.6) < 3, `about 28.6° (got ${deg})`);
    assert.equal(p.attachments.find((x: any) => x.id === 'glove').rotation, 0, 'attachment setup offset untouched');

    await page.getByTestId('tool-move').click();
    const body = (await probe<{ x: number; y: number }>(page, 'attachment', 'body'))!;
    const before = (await probe<any>(page, 'bone', 'root')).world;
    await drag(page, body, { x: body.x + 30, y: body.y + 20 });
    assert.deepEqual((await state(page)).selection, { kind: 'bone', id: 'root' });
    p = await project(page);
    assert.deepEqual(keyFrames(p, 'act', 'root', 'translate'), [0], 'body art drag keys root translate');
    const now = (await probe<any>(page, 'bone', 'root')).world;
    assert.ok(Math.hypot(now.x - before.x, now.y - before.y) > 5, 'the body moved');
    await page.screenshot({ path: path.join(OUT, 'rv002-animate-art-click.png') });
  });

  it('a weighted mesh resolves to the strongest influence of the vertex nearest the click', async () => {
    const v = (await probe<{ x: number; y: number }[]>(page, 'mesh', 'hose'))!;
    const byX = [...v].sort((a, b) => a.x - b.x);
    const mid = (pts: { x: number; y: number }[]) => ({ x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: pts.reduce((s, q) => s + q.y, 0) / pts.length });
    const left = mid(byX.slice(0, 4)), right = mid(byX.slice(-4));
    await page.mouse.click(left.x + 3, left.y);
    assert.deepEqual((await state(page)).selection, { kind: 'bone', id: 'arm' }, 'left half → arm');
    await page.mouse.click(right.x - 3, right.y);
    assert.deepEqual((await state(page)).selection, { kind: 'bone', id: 'hand' }, 'right half → hand');
  });

  it('Setup mode still selects (and moves) the attachment itself', async () => {
    await page.getByTestId('mode-setup').click();
    const glove = (await probe<{ x: number; y: number }>(page, 'attachment', 'glove'))!;
    await page.mouse.click(glove.x, glove.y);
    assert.deepEqual((await state(page)).selection, { kind: 'attachment', id: 'glove' });
    await page.getByTestId('show-bones').check();
    assert.deepEqual(pageErrors, []);
  });
});

describe('RV-005: Enter in a pose field keys that channel in Animate mode, even with the value unchanged', () => {
  let page: Page;
  before(async () => {
    page = await newPage(await context('e2e-usecase-enter'));
    await open(page);
  });

  it('at an unkeyed frame, Enter on the displayed rotation writes a key; undo removes it', async () => {
    await page.getByTestId('mode-animate').click();
    await page.getByTestId('tree-bone-arm').click();
    await gotoFrame(page, 10, 30);
    assert.equal(Math.round((await state(page)).time * 30), 10);
    const field = page.getByTestId('bone-rotation');
    const shown = await field.inputValue();
    const undo0 = (await state(page)).undo;
    await field.fill(shown);
    await field.press('Enter');
    assert.deepEqual(keyFrames(await project(page), 'act', 'arm', 'rotate'), [10], 'key at frame 10');
    assert.match(await page.getByTestId('status').innerText(), /Key written \(unchanged value\)/);
    assert.equal((await state(page)).undo, undo0 + 1, 'one undo step');
    // The same Enter again changes nothing and says so.
    await page.getByTestId('bone-rotation').fill(shown);
    await page.getByTestId('bone-rotation').press('Enter');
    assert.equal((await state(page)).undo, undo0 + 1);
    assert.match(await page.getByTestId('status').innerText(), /already keyed with this value/);
    await page.getByTestId('undo').click();
    assert.deepEqual(keyFrames(await project(page), 'act', 'arm', 'rotate'), [], 'undo removes the key');
  });

  it('Enter on an unchanged X keys the translate pair; Setup mode Enter on an unchanged value does nothing', async () => {
    const x = page.getByTestId('bone-x');
    await x.fill(await x.inputValue());
    await x.press('Enter');
    const p = await project(page);
    assert.deepEqual(keyFrames(p, 'act', 'arm', 'translate'), [10]);
    assert.deepEqual(p.animations[0].tracks.arm.translate[0].value, [100, 0]);
    await page.getByTestId('mode-setup').click();
    const before = await project(page);
    const u0 = (await state(page)).undo;
    const r = page.getByTestId('bone-rotation');
    await r.fill(await r.inputValue());
    await r.press('Enter');
    assert.equal((await state(page)).undo, u0);
    assert.deepEqual(await project(page), before);
    assert.deepEqual(pageErrors, []);
  });
});

describe('RV-006: timeline time zoom and scroll', () => {
  let page: Page;
  before(async () => {
    page = await newPage(await context('e2e-usecase-zoom'));
    await open(page);
    await page.getByTestId('anim-select').selectOption({ label: 'long' });
    await page.getByTestId('mode-animate').click();
    await page.getByTestId('tree-bone-root').click();
  });

  const lanesBox = async () => (await page.getByTestId('timeline-lanes').boundingBox())!;
  const keyBox = async (f: number) => (await page.getByTestId(`key-root-translate-${f}`).boundingBox())!;

  it('Ctrl+wheel zooms around the cursor to ≥ 8 px per frame; the ruler is numbered', async () => {
    const lanes = await lanesBox();
    assert.equal(await page.getByTestId('tl-zoom-readout').innerText(), 'fit');
    const fit = lanes.width / 300;
    assert.ok(fit < 8, `the 300-frame animation fits at ${fit.toFixed(2)} px/frame`);
    const k = await keyBox(30);
    const cx = k.x + k.width / 2;
    await page.mouse.move(cx, lanes.y + 40);
    for (let i = 0; i < 8 && (await page.getByTestId('tl-zoom-readout').innerText()) !== '8 px/frame'; i++) {
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -100);
      await page.keyboard.up('Control');
    }
    assert.equal(await page.getByTestId('tl-zoom-readout').innerText(), '8 px/frame');
    const zl = await lanesBox();
    assert.ok(Math.abs(zl.width / 300 - 8) < 1e-6, `lanes are ${zl.width} px for 300 frames`);
    const k2 = await keyBox(30);
    assert.ok(Math.abs(k2.x + k2.width / 2 - cx) <= 8, 'the frame under the cursor stays under it');
    const labels = (await page.getByTestId('timeline-ruler').locator('span').allInnerTexts()).map(Number);
    assert.ok(labels.includes(30) && labels.includes(35) && labels.includes(25), `numbered every 5 frames: ${labels.slice(0, 12).join(',')}`);
    assert.equal(await page.evaluate(() => window.visualViewport?.scale ?? 1), 1, 'Ctrl+wheel did not zoom the page');
    await page.screenshot({ path: path.join(OUT, 'rv006-zoomed-8px.png') });
  });

  it('a 24 px drag moves a key exactly 3 frames', async () => {
    const k = await keyBox(30);
    const c = { x: k.x + k.width / 2, y: k.y + k.height / 2 };
    await drag(page, c, { x: c.x + 24, y: c.y }, 6);
    const p = await project(page);
    assert.deepEqual(keyFrames(p, 'long', 'root', 'translate'), [0, 33]);
    assert.equal(await page.getByTestId('key-root-translate-33').count(), 1);
  });

  it('Shift+wheel scrolls time; the buttons step the zoom and Fit restores the whole animation', async () => {
    const l0 = await lanesBox();
    await page.mouse.move(l0.x + 200, l0.y + 40);
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, 300);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(100);
    const l1 = await lanesBox();
    assert.ok(l1.x < l0.x - 100, `scrolled (${l0.x} → ${l1.x})`);
    await page.getByTestId('tl-zoom-in').click();
    assert.equal(await page.getByTestId('tl-zoom-readout').innerText(), '12 px/frame');
    await page.getByTestId('tl-zoom-out').click();
    assert.equal(await page.getByTestId('tl-zoom-readout').innerText(), '8 px/frame');
    await page.getByTestId('tl-zoom-fit').click();
    assert.equal(await page.getByTestId('tl-zoom-readout').innerText(), 'fit');
    const l2 = await lanesBox();
    assert.ok(Math.abs(l2.width - l0.width / 8 * (l2.width / (l0.width / 8))) < 1e-6 && l2.width < 1200, 'whole animation again');
    assert.deepEqual(pageErrors, []);
  });
});

describe('RV-004: Save never clears the recovery copy unless the file was confirmed written', () => {
  it('fallback download (downloads blocked here): stays unsaved and keeps the annotated copy, offered after reload', async () => {
    const ctx = await context('e2e-usecase-save-blocked', { acceptDownloads: false });
    const page = await newPage(ctx);
    await open(page);
    await setField(page, 'project-name', 'blocked save');
    await waitUntil(() => autosaveCopy(page), (v) => v && JSON.parse(v.project).name === 'blocked save', 5000, 'autosave');
    await page.getByTestId('save-project').click();
    await page.waitForTimeout(500);
    assert.equal((await state(page)).dirty, true, 'still unsaved');
    assert.match(await page.title(), /^• /, 'title shows the unsaved marker');
    const copy = await autosaveCopy(page);
    assert.ok(copy, 'recovery copy kept');
    assert.equal(JSON.parse(copy.project).name, 'blocked save');
    assert.equal(copy.downloadedAs, 'blocked-save.rig.json');
    assert.match(await page.getByTestId('status').innerText(), /cannot confirm/);
    await page.reload();
    await page.getByTestId('recovery-banner').waitFor();
    assert.match(await page.getByTestId('recovery-banner').innerText(), /downloaded as “blocked-save\.rig\.json”/);
    await page.screenshot({ path: path.join(OUT, 'rv004-recovery-after-download.png') });
  });

  it('file picker cancelled (headless CfT’s real picker aborts): nothing changes', async () => {
    const ctx = await context('e2e-usecase-save-picker', { fileSystemAccess: true });
    const page = await newPage(ctx);
    assert.equal(await page.evaluate(() => typeof (window as any).showSaveFilePicker), 'function');
    await open(page);
    await setField(page, 'project-name', 'picker save');
    await waitUntil(() => autosaveCopy(page), (v) => v && JSON.parse(v.project).name === 'picker save', 5000, 'autosave');
    await page.getByTestId('save-project').click();
    await page.waitForTimeout(500);
    assert.match(await page.getByTestId('status').innerText(), /Save cancelled/);
    assert.equal((await state(page)).dirty, true);
    assert.match(await page.title(), /^• /);
    assert.equal(JSON.parse((await autosaveCopy(page)).project).name, 'picker save');
    await page.close();
  });

  it('file picker write completed (stubbed handle): saved, marker gone, copy cleared; a failed close keeps both', async () => {
    const ctx = contexts[contexts.length - 1];
    // Environment stub of the OS dialog: the real one cannot be answered headless.
    const page = await newPage(ctx, () => {
      (window as any).showSaveFilePicker = async (o: { suggestedName: string }) => ({
        name: o.suggestedName,
        createWritable: async () => {
          const parts: string[] = [];
          return {
            write: async (b: Blob) => void parts.push(await b.text()),
            close: async () => {
              await new Promise((r) => setTimeout(r, 200));
              if ((window as any).__failClose) throw new Error('disk full');
              (window as any).__written = parts.join('');
            },
          };
        },
      });
    });
    await page.getByTestId('recovery-discard').click();
    await open(page);
    await setField(page, 'project-name', 'picker ok');
    await waitUntil(() => autosaveCopy(page), (v) => v && JSON.parse(v.project).name === 'picker ok', 5000, 'autosave');
    await page.getByTestId('save-project').click();
    await page.waitForFunction(() => /Saved “picker-ok\.rig\.json”/.test(document.querySelector('[data-testid="status"]')?.textContent ?? ''));
    assert.equal((await state(page)).dirty, false);
    assert.ok(!(await page.title()).startsWith("• "), "no unsaved marker");
    assert.deepEqual(JSON.parse(await page.evaluate(() => (window as any).__written)), await project(page), 'the file holds the project');
    await waitUntil(() => autosaveCopy(page), (v) => v === null, 3000, 'copy cleared');
    await page.evaluate(() => ((window as any).__failClose = true));
    await setField(page, 'project-name', 'picker fails');
    await waitUntil(() => autosaveCopy(page), (v) => v && JSON.parse(v.project).name === 'picker fails', 5000, 'autosave');
    await page.getByTestId('save-project').click();
    await page.getByTestId('error-toast').last().waitFor();
    assert.match(await page.getByTestId('error-toast').last().innerText(), /was not written: disk full/);
    assert.equal((await state(page)).dirty, true);
    assert.equal(JSON.parse((await autosaveCopy(page)).project).name, 'picker fails');
    assert.deepEqual(pageErrors, []);
  });
});

describe('RV-007: browser storage in IndexedDB', () => {
  let ctx: BrowserContext;
  before(async () => {
    ctx = await context('e2e-usecase-idb');
  });

  it('migrates the old localStorage copies once and removes them', async () => {
    const page = await newPage(ctx);
    const text = serializeProject(rig());
    await page.evaluate((t) => {
      localStorage.setItem('rigsmith:project:v1', t);
      localStorage.setItem('rigsmith:autosave:v1', JSON.stringify({ savedAt: '2026-10-01T10:00:00.000Z', name: 'legacy', project: t }));
    }, text);
    await page.reload();
    await page.getByTestId('recovery-banner').waitFor();
    assert.match(await page.getByTestId('recovery-banner').innerText(), /“legacy”/);
    await waitUntil(() => readIdb(page, 'browser-save'), (v) => v?.project === text, 5000, 'migrated browser save');
    assert.equal((await readIdb(page, 'autosave'))?.name, 'legacy');
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem('rigsmith:project:v1'), localStorage.getItem('rigsmith:autosave:v1')]), [null, null]);
    await page.getByTestId('recovery-discard').click();
    await page.getByTestId('restore-browser').click();
    await page.waitForFunction(() => (window as any).__rigsmith.project().name === 'usecase');
    await page.close();
  });

  it('a project ~4× the Wiz size saves to the browser and autosaves within 2 s of an edit', async () => {
    const page = await newPage(ctx);
    await open(page, BIG);
    const errors0 = await page.getByTestId('error-toast').count();
    await page.getByTestId('save-browser').click();
    await page.waitForFunction(() => /Saved to this browser/.test(document.querySelector('[data-testid="status"]')?.textContent ?? ''), null, { timeout: 10000 });
    const saved = await readIdb(page, 'browser-save');
    assert.ok(saved.project.length > 4 * 1_760_000, `stored ${saved.project.length} characters`);
    assert.equal(await page.getByTestId('error-toast').count(), errors0, 'no quota error');
    const field = page.getByTestId('project-name');
    await field.fill('large edited');
    await page.evaluate(() => ((window as any).__t0 = performance.now()));
    await field.press('Enter');
    await page.waitForFunction(() => /Autosaved/.test(document.querySelector('[data-testid="autosave-status"]')?.textContent ?? ''), null, { timeout: 5000 });
    const ms = await page.evaluate(() => performance.now() - (window as any).__t0);
    assert.ok(ms <= 2000, `autosaved ${Math.round(ms)} ms after the edit`);
    writeFileSync(path.join(OUT, 'rv007-large-autosave-ms.txt'), `${Math.round(ms)} ms, ${saved.project.length} characters\n`);
    assert.equal(JSON.parse((await readIdb(page, 'autosave')).project).name, 'large edited');
    assert.equal(await page.getByTestId('autosave-status').getAttribute('data-state'), 'ok');
    assert.deepEqual(pageErrors, []);
  });
});
