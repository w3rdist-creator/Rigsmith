// R6 browser check: Export spec / Apply spec… in the timeline. The demo's walk is exported,
// edited in the editor, then restored by applying the exported spec (one undo step); a
// renamed spec creates a new animation; a bad spec changes nothing and says why.
// Visible controls only; window.__rigsmith is read-only (assertions).
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/r6-clip-spec');
mkdirSync(OUT, { recursive: true });

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

const state = () => probe<any>(page, 'state');
const anims = async () => (await probe<any>(page, 'project')).animations;
const walk = async () => (await anims()).find((a: any) => a.name === 'walk');
const status = async () => (await page.getByTestId('status').textContent()) ?? '';

before(async () => {
  const port = await pickPort([47640, 47641, 47642]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-r6-clip-spec');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('empty-demo').click();
  await page.waitForFunction(() => (window as any).__rigsmith.state().playing === true);
  await page.getByTestId('play').click();
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('clip specs in the editor (R6)', () => {
  it('export → edit → apply restores the animation in one undo step; a renamed spec creates; a bad spec changes nothing', async () => {
    const original = await walk();
    const dl = page.waitForEvent('download');
    await page.getByTestId('anim-export-spec').click();
    const d = await dl;
    assert.equal(d.suggestedFilename(), 'walk.clip.yaml');
    const file = path.join(OUT, 'walk.clip.yaml');
    await d.saveAs(file);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^name: walk$/m);
    assert.match(text, /^bones:$/m);

    // Edit: a new rotation key on the head at frame 4.
    await page.getByTestId('tree-bone-head').click();
    const ruler = page.getByTestId('timeline-ruler');
    const box = (await ruler.boundingBox())!;
    await ruler.click({ position: { x: (box.width * 4) / 30, y: box.height / 2 } });
    const rot = page.getByTestId('bone-rotation');
    await rot.fill('40');
    await rot.press('Enter');
    const edited = await walk();
    assert.notDeepEqual(edited, original);

    const undo0 = (await state()).undo;
    await page.getByTestId('clip-spec-input').setInputFiles(file);
    await page.waitForFunction((n) => (window as any).__rigsmith.state().undo === n + 1, undo0);
    assert.deepEqual(await walk(), original, 'restored exactly (same id, keys and settings)');
    assert.match(await status(), /Replaced “walk” from walk\.clip\.yaml \(\d+ keys\)/);
    await page.getByTestId('undo').click();
    assert.deepEqual(await walk(), edited, 'one undo step');

    const renamed = path.join(OUT, 'walk2.clip.yaml');
    writeFileSync(renamed, text.replace(/^name: walk$/m, 'name: walk2'));
    const n0 = (await anims()).length;
    await page.getByTestId('anim-apply-spec').waitFor();
    await page.getByTestId('clip-spec-input').setInputFiles(renamed);
    await page.waitForFunction((n) => (window as any).__rigsmith.project().animations.length === n + 1, n0);
    const created = (await anims()).find((a: any) => a.name === 'walk2');
    assert.deepEqual({ ...created, id: 'x', name: 'x' }, { ...original, id: 'x', name: 'x' });

    const bad = path.join(OUT, 'bad.clip.yaml');
    writeFileSync(bad, 'name: walk\nbones:\n  nobody: {rotate: [[0, 1]]}\n');
    const before = await probe<any>(page, 'project');
    const undo1 = (await state()).undo;
    await page.getByTestId('clip-spec-input').setInputFiles(bad);
    await page.waitForFunction(() => /Clip spec not applied/.test(document.querySelector('[data-testid="status"]')?.textContent ?? ''));
    assert.match(await status(), /unknown bone “nobody”/);
    assert.deepEqual(await probe<any>(page, 'project'), before);
    assert.equal((await state()).undo, undo1);
    await page.screenshot({ path: path.join(OUT, 'timeline-spec-buttons.png') });
    assert.deepEqual(pageErrors, []);
  });
});
