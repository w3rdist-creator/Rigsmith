// RV-012 on real art: the "Flat-art guide…" checklist driven end to end on wiz_master.png,
// using only the guide's buttons and the presets it opens the cut dialog with (overlap 0,
// extend 40 for limbs; Select colour at tolerance 255 for hands). The cut outlines, pivots
// and seeds are the RV-010 inputs (scripts/roadmap/rv010-inputs.json); the extension length
// is deliberately the guide's 40 px, not RV-010's 50/60, because that is what a user gets.
// Then the guide's default 4×6 mesh + weights and its first idle, exported as frames.
// Pieces are measured with the RV-010 metric (rv010_compare.py). Isolated headless CfT
// profile .hermes/browser-profiles/wiz-guide-rv012; window.__rigsmith is read only.
// Outputs: .hermes/assets/wiz/rv012-guide-output/ (git-ignored); log + metrics in .hermes/evidence/usecase/.
// Usage: npm run build && node scripts/roadmap/wiz-guide-rv012.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { decodePng } from '../../tests/support/png-decode.ts';
import { readZip } from '../../tests/support/zip-read.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from '../../tests/e2e/harness.ts';
import { ROOT, WIZ } from '../wiz/paths.ts';

type Pt = [number, number];
interface PolyCut { name: string; polygon: Pt[]; pivot: Pt }
interface SelCut { name: string; parent: string; seed: Pt; pivot: Pt }
const INPUTS = JSON.parse(readFileSync(path.join(ROOT, 'scripts/roadmap/rv010-inputs.json'), 'utf8')) as { polygonCuts: PolyCut[]; selectionCuts: SelCut[] };

const MASTER = path.join(WIZ, 'source/wiz_master.png');
const PREPARED = path.join(WIZ, 'prepared');
const OUT = path.join(WIZ, 'rv012-guide-output');
const EV = path.join(EVIDENCE, 'usecase');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, 'pieces'), { recursive: true });
mkdirSync(EV, { recursive: true });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const lines: string[] = [];
const log = (m: string) => {
  console.log(m);
  lines.push(m);
};

function originals(): Record<string, string> {
  const o: Record<string, string> = { 'source/wiz_master.png': sha(readFileSync(MASTER)) };
  for (const f of readdirSync(PREPARED).filter((f) => /\.(png|json)$/.test(f)).sort()) o[`prepared/${f}`] = sha(readFileSync(path.join(PREPARED, f)));
  return o;
}

let page: Page;
const project = () => probe<any>(page, 'project');
const undoDepth = async () => (await probe<any>(page, 'state')).undo as number;
const status = () => page.getByTestId('status').innerText();
const progress = () => page.getByTestId('guide-progress').innerText();

/** Waits for the cut dialog opened by a guide button; returns a click at source-pixel coordinates. */
async function cutDialog(): Promise<(q: Pt) => Promise<void>> {
  const canvas = page.getByTestId('cutout-canvas');
  await canvas.waitFor();
  await page.waitForFunction(() => !/Counting/.test(document.querySelector('[data-testid="cut-speck-count"]')?.textContent ?? 'Counting'));
  const box = (await canvas.boundingBox())!;
  const s = Number(await canvas.getAttribute('data-scale')), ox = Number(await canvas.getAttribute('data-ox')), oy = Number(await canvas.getAttribute('data-oy'));
  // As RV-010 pass 2: a point on the bottom image edge is clicked 0.25 CSS px inside.
  return ([x, y]) => page.mouse.click(Math.min(box.x + ox + x * s, box.x + box.width - 0.25), Math.min(box.y + oy + y * s, box.y + box.height - 0.25));
}

/** The cut dialog's settings as the guide opened it. */
async function preset(): Promise<string> {
  const pressed: string[] = [];
  for (const m of ['polygon', 'wand']) if ((await page.getByTestId(`cut-mode-${m}`).getAttribute('aria-pressed')) === 'true') pressed.push(m);
  return `mode ${pressed.join('/')}, overlap ${await page.getByTestId('cut-overlap').inputValue()}, extend ${await page.getByTestId('cut-extend').inputValue()}, tolerance ${await page.getByTestId('cut-tolerance').inputValue()}`;
}

async function apply(label: string): Promise<void> {
  const u0 = await undoDepth();
  await page.getByTestId('cut-apply').click();
  await page.getByTestId('cutout-dialog').waitFor({ state: 'hidden', timeout: 120_000 });
  assert.equal(await undoDepth(), u0 + 1, `${label}: one undo step`);
}

const imageOf = (p: any, attName: string) => p.images.find((i: any) => i.id === p.attachments.find((a: any) => a.name === attName).imageId);
const pngBytes = (im: any) => Buffer.from(im.dataUrl.split(',')[1], 'base64');
function savePiece(name: string, im: any, extra: Record<string, unknown> = {}): Record<string, unknown> {
  writeFileSync(path.join(OUT, 'pieces', `${name}.png`), pngBytes(im));
  const d = im.derived ?? {};
  return { name, image: im.name, width: im.width, height: im.height, offsetX: d.offsetX ?? 0, offsetY: d.offsetY ?? 0, synthesized: d.synthesized ?? 0, kind: d.kind ?? null, note: d.note ?? null, ...extra };
}

async function main(): Promise<void> {
  const before = originals();
  const port = await pickPort([47614, 47615, 47616, 47617]);
  const server = await startPreview(port);
  const ctx = await launchIsolated('wiz-guide-rv012', [], { viewport: { width: 1600, height: 1100 } });
  const errors: string[] = [];
  const pieces: Record<string, unknown>[] = [];
  try {
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => void d.accept());
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByTestId('empty-stage').waitFor({ state: 'visible' });

    await page.getByTestId('guide-open').click();
    log(`guide opened: ${await progress()}`);
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('guide-import').click();
    await (await chooser).setFiles(MASTER);
    await page.getByTestId('image-wiz_master.png').waitFor();
    await page.getByTestId('guide-rig').click();
    log(`Choose PNG… → wiz_master.png; Create root bone + attach → ${await status()}`);

    await page.getByTestId('guide-clean').click();
    await cutDialog();
    log(`Open clean-up…: ${await page.getByTestId('cut-speck-count').innerText()}`);
    const u0 = await undoDepth();
    await page.getByTestId('cut-despeckle').click();
    await page.waitForFunction((n) => (window as any).__rigsmith.state().undo === n, u0 + 1);
    log(`  ${await status()}`);
    await page.getByTestId('cut-cancel').click();

    for (const c of INPUTS.polygonCuts) {
      await page.getByTestId('guide-limb').click();
      const click = await cutDialog();
      const pre = await preset();
      for (const q of c.polygon) await click(q);
      await page.getByTestId('cut-mode-pivot').click();
      await click(c.pivot);
      await page.getByTestId('cut-name').fill(c.name);
      await page.getByTestId('cut-name').press('Enter');
      const summary = await page.getByTestId('cut-summary').innerText();
      await apply(c.name);
      const im = imageOf(await project(), c.name);
      log(`Cut a limb… ${c.name} (preset as opened: ${pre}): ${summary}; ${im.derived.note}`);
      pieces.push(savePiece(c.name, im, { path: 'guide limb preset (polygon)' }));
    }
    for (const c of INPUTS.selectionCuts) {
      await page.getByTestId('guide-colour').click();
      const click = await cutDialog();
      const pre = await preset();
      await click(c.seed);
      await page.waitForFunction(() => /^selection/.test(document.querySelector('[data-testid="cut-summary"]')?.textContent ?? ''));
      await page.getByTestId('cut-mode-pivot').click();
      await click(c.pivot);
      await page.getByTestId('cut-parent').selectOption({ label: c.parent });
      await page.getByTestId('cut-name').fill(c.name);
      await page.getByTestId('cut-name').press('Enter');
      const summary = await page.getByTestId('cut-summary').innerText();
      await apply(c.name);
      const im = imageOf(await project(), c.name);
      log(`Cut by colour… ${c.name} (preset as opened: ${pre}): ${summary}`);
      pieces.push(savePiece(c.name, im, { path: 'guide colour preset (selection)' }));
    }
    const body = imageOf(await project(), 'wiz_master');
    pieces.push(savePiece('body', body, { path: 'remainder chain' }));

    const um = await undoDepth();
    await page.getByTestId('guide-mesh').click();
    assert.equal(await undoDepth(), um + 1);
    log(`Mesh + weigh the body (default grid ${await page.getByTestId('guide-grid-cols').inputValue()}×${await page.getByTestId('guide-grid-rows').inputValue()}): ${await status()}`);
    await page.getByTestId('guide-idle').click();
    log(`Create idle: ${await status()}`);
    log(`progress: ${await progress()}`);
    await page.getByTestId('guide-dialog').screenshot({ path: path.join(OUT, 'guide-on-wiz.png') });
    const p = await project();
    const an = p.animations.find((a: any) => a.name === 'idle');
    const name = (id: string) => p.bones.find((b: any) => b.id === id)?.name;
    const world = await Promise.all(p.bones.map(async (b: any) => [b.name, (await probe<any>(page, 'bone', b.name))?.origin.y]));
    log(`bones (world origin y): ${world.map(([n, y]) => `${n} ${Number(y).toFixed(1)}`).join(', ')}; root at art centre`);
    log(`idle tracks: ${Object.keys(an.tracks).map(name).join(', ')}`);

    await page.getByTestId('guide-close').click();
    await page.getByTestId('export-sequence').click();
    await page.getByTestId('export-dialog').waitFor({ state: 'visible' });
    const dl = page.waitForEvent('download');
    await page.getByTestId('seq-export').click();
    const zipPath = path.join(OUT, 'wiz-guide-idle.zip');
    await (await dl).saveAs(zipPath);
    const files = new Map(readZip(readFileSync(zipPath)).map((f) => [f.name, f.data]));
    const pngs = [...files.keys()].filter((n) => n.endsWith('.png')).sort();
    const f0 = decodePng(files.get(pngs[0])!), f15 = decodePng(files.get(pngs[15])!);
    let changed = 0;
    for (let i = 3; i < f0.data.length; i += 4) if (Math.abs(f0.data[i] - f15.data[i]) > 8) changed++;
    writeFileSync(path.join(OUT, 'idle-frame-00.png'), files.get(pngs[0])!);
    writeFileSync(path.join(OUT, 'idle-frame-15.png'), files.get(pngs[15])!);
    log(`Export sequence…: ${pngs.length} frames ${f0.width}×${f0.height}; frame 15 vs 0: ${changed} px change alpha by > 8`);
    await page.keyboard.press('Escape');
    const dlp = page.waitForEvent('download');
    await page.getByTestId('save-project').click();
    await (await dlp).saveAs(path.join(OUT, 'wiz-rv012-guide.rig.json'));
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await ctx.close();
    server.kill();
  }
  writeFileSync(path.join(OUT, 'pieces.json'), JSON.stringify({ pieces, trials: [], precision: [] }, null, 1));
  const out = execFileSync('python3', ['-I', path.join(ROOT, 'scripts/roadmap/rv010_compare.py'), MASTER, PREPARED, OUT, path.join(EV, 'rv012-guide-metrics.json')], { encoding: 'utf8' });
  for (const l of out.trimEnd().split('\n')) log(l);
  assert.deepEqual(originals(), before, 'originals unchanged');
  log(`originals unchanged after the run (${Object.keys(before).length} files, sha256 equal)`);
}

try {
  await main();
} finally {
  const text = lines.join('\n') + '\n';
  writeFileSync(path.join(OUT, 'log.txt'), text);
  writeFileSync(path.join(EV, 'rv012-wiz-guide-log.txt'), text);
}
