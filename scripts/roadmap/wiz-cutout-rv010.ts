// RV-010: recreate the nine Wiz pieces from wiz_master.png with the "Cut out piece…"
// dialog only, driving its visible controls in an isolated headless Chrome for Testing
// profile (.hermes/browser-profiles/wiz-cutout-rv010), and measure them against the
// prepared pieces (scripts/roadmap/rv010_compare.py). Inputs are fixed in
// scripts/roadmap/rv010-inputs.json (read by eye from the source; provenance per value).
// Nothing is tuned to the result: shortfalls are logged, not worked around.
//   Image → + Bone → Attach → Remove specks → arm_l, arm_r (each first tried with the
//   flat sleeve patch, measured, undone) → leg_l, leg_r → hand_l, hand_r (Select colour)
//   → body = the remainder → Save.
// Outputs: .hermes/assets/wiz/rv010-output/ (git-ignored); log + metrics in .hermes/evidence/usecase/.
// Usage: npm run build && node scripts/roadmap/wiz-cutout-rv010.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from '../../tests/e2e/harness.ts';
import { ROOT, WIZ } from '../wiz/paths.ts';

type Pt = [number, number];
interface PolyCut { name: string; parent: string; polygon: Pt[]; pivot: Pt; extend: number; patchTrial?: { pick: Pt } }
interface SelCut { name: string; parent: string; seed: Pt; tolerance: number; minAlpha: number; contiguous: boolean; pivot: Pt }
const INPUTS = JSON.parse(readFileSync(path.join(ROOT, 'scripts/roadmap/rv010-inputs.json'), 'utf8')) as { global: { overlap: { value: number } }; polygonCuts: PolyCut[]; selectionCuts: SelCut[] };

const MASTER = path.join(WIZ, 'source/wiz_master.png');
const PREPARED = path.join(WIZ, 'prepared');
const OUT = path.join(WIZ, 'rv010-output');
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

/** sha256 of the master and every prepared file (the originals that must stay untouched). */
function originals(): Record<string, string> {
  const o: Record<string, string> = { 'source/wiz_master.png': sha(readFileSync(MASTER)) };
  for (const f of readdirSync(PREPARED).filter((f) => /\.(png|json)$/.test(f)).sort()) o[`prepared/${f}`] = sha(readFileSync(path.join(PREPARED, f)));
  return o;
}

let page: Page;
const project = () => probe<any>(page, 'project');
const undoDepth = async () => (await probe<any>(page, 'state')).undo as number;

async function fill(testId: string, v: string | number): Promise<void> {
  await page.getByTestId(testId).fill(String(v));
  await page.getByTestId(testId).press('Enter');
}

/** Opens the dialog on the source attachment; returns a click at source-pixel coordinates. */
async function openCutout(): Promise<(q: Pt, shift?: boolean) => Promise<void>> {
  await page.getByTestId('tree-att-wiz_master').click();
  await page.getByTestId('att-cutout').click();
  const canvas = page.getByTestId('cutout-canvas');
  await canvas.waitFor();
  await page.waitForFunction(() => !/Counting/.test(document.querySelector('[data-testid="cut-speck-count"]')?.textContent ?? 'Counting'));
  const box = (await canvas.boundingBox())!;
  const s = Number(await canvas.getAttribute('data-scale')), ox = Number(await canvas.getAttribute('data-ox')), oy = Number(await canvas.getAttribute('data-oy'));
  return async ([x, y], shift = false) => {
    if (shift) await page.keyboard.down('Shift');
    // Pass 2: a point on the image's bottom edge is the canvas's bottom edge, where a click
    // does not register (pass 1 lost both y=1536 leg vertices). Click 0.25 CSS px inside.
    const cx = Math.min(box.x + ox + x * s, box.x + box.width - 0.25), cy = Math.min(box.y + oy + y * s, box.y + box.height - 0.25);
    await page.mouse.click(cx, cy);
    if (shift) await page.keyboard.up('Shift');
  };
}

async function setCommon(name: string, parentId: string, extend: number): Promise<void> {
  await page.getByTestId('cut-name').fill(name);
  await page.getByTestId('cut-name').press('Enter');
  await fill('cut-overlap', INPUTS.global.overlap.value);
  await fill('cut-extend', extend);
  await page.getByTestId('cut-parent').selectOption(parentId);
}

async function apply(label: string): Promise<void> {
  const u0 = await undoDepth();
  await page.getByTestId('cut-apply').click();
  await page.getByTestId('cutout-dialog').waitFor({ state: 'hidden', timeout: 120_000 });
  assert.equal(await undoDepth(), u0 + 1, `${label}: one undo step`);
}

const imageOf = (p: any, attName: string) => {
  const att = p.attachments.find((a: any) => a.name === attName);
  return p.images.find((i: any) => i.id === att.imageId);
};
const pngBytes = (im: any) => Buffer.from(im.dataUrl.split(',')[1], 'base64');

function savePiece(name: string, im: any, extra: Record<string, unknown> = {}): Record<string, unknown> {
  writeFileSync(path.join(OUT, 'pieces', `${name}.png`), pngBytes(im));
  const d = im.derived ?? {};
  return { name, image: im.name, width: im.width, height: im.height, offsetX: d.offsetX ?? 0, offsetY: d.offsetY ?? 0, synthesized: d.synthesized ?? 0, kind: d.kind ?? null, note: d.note ?? null, ...extra };
}

async function main(): Promise<void> {
  const before = originals();
  log(`originals before: ${Object.entries(before).map(([k, v]) => `${k} ${v.slice(0, 12)}…`).join(', ')}`);
  const port = await pickPort([47614, 47615, 47616, 47617]);
  const server = await startPreview(port);
  const ctx = await launchIsolated('wiz-cutout-rv010', [], { viewport: { width: 1600, height: 1100 } });
  const errors: string[] = [];
  const pieces: Record<string, unknown>[] = [];
  const trials: Record<string, unknown>[] = [];
  const precision: Record<string, unknown>[] = [];
  try {
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => void d.accept());
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
    await page.getByTestId('image-input').setInputFiles(MASTER);
    await page.getByTestId('image-wiz_master.png').waitFor();
    await page.getByTestId('add-bone').click();
    await page.getByTestId('attach-wiz_master.png').click();
    const root = (await project()).bones[0];
    log(`imported wiz_master.png, + Bone (“${root.name}”), Attach`);
    const boneIds: Record<string, string> = { root: root.id };

    // ---- Remove specks (dialog defaults) -------------------------------------------------
    await openCutout();
    const canvas = page.getByTestId('cutout-canvas');
    const scale = Number(await canvas.getAttribute('data-scale'));
    log(`cutout canvas view scale ${scale.toFixed(4)} CSS px per source px (${(1 / scale).toFixed(2)} source px per CSS px); the dialog has no zoom`);
    log(`speck count: ${await page.getByTestId('cut-speck-count').innerText()}`);
    const u0 = await undoDepth();
    await page.getByTestId('cut-despeckle').click();
    await page.waitForFunction((n) => (window as any).__rigsmith.state().undo === n, u0 + 1);
    log(`status: ${await page.getByTestId('status').innerText()}`);
    await page.getByTestId('cut-cancel').click();

    // ---- Polygon cuts: arms (with a patch trial), legs ------------------------------------
    for (const c of INPUTS.polygonCuts) {
      const cut = async (patchPick?: Pt) => {
        const click = await openCutout();
        await page.getByTestId('cut-mode-polygon').click();
        for (const q of c.polygon) await click(q);
        await page.getByTestId('cut-mode-pivot').click();
        await click(c.pivot);
        if (patchPick) {
          await page.getByTestId('cut-mode-pick').click();
          await click(patchPick);
          assert.ok(await page.getByTestId('cut-patch').isChecked(), 'Pick colour ticks the patch');
        }
        await setCommon(c.name, boneIds[c.parent], c.extend);
        const summary = await page.getByTestId('cut-summary').innerText();
        const color = await page.getByTestId('cut-patch-color').inputValue();
        await apply(c.name);
        return { summary, color };
      };
      if (c.patchTrial) {
        const p0 = await project();
        const { summary, color } = await cut(c.patchTrial.pick);
        const p1 = await project();
        const rest = imageOf(p1, 'wiz_master');
        writeFileSync(path.join(OUT, `trial-${c.name}-patched-rest.png`), pngBytes(rest));
        writeFileSync(path.join(OUT, `trial-${c.name}-unpatched-source.png`), pngBytes(imageOf(p0, 'wiz_master')));
        trials.push({ name: c.name, picked: color, synthesized: rest.derived?.synthesized ?? 0, note: rest.derived?.note, summary });
        log(`${c.name} patch trial: picked ${color}; remainder ${rest.name}: ${rest.derived?.note}`);
        await page.getByTestId('undo').click();
        assert.deepEqual(await project(), p0, `${c.name} patch trial undone exactly`);
        log(`  undone with ↶ Undo (project equals the pre-trial project)`);
      }
      const { summary } = await cut();
      const p = await project();
      const im = imageOf(p, c.name);
      const stored: number[] = im.derived.polygon;
      const err = stored.length === c.polygon.length * 2 ? Math.max(...c.polygon.map(([x, y], i) => Math.max(Math.abs(stored[i * 2] - x), Math.abs(stored[i * 2 + 1] - y)))) : null;
      precision.push({ name: c.name, requested: c.polygon, stored, maxAbsError: err });
      log(`${c.name}: ${summary}`);
      log(`  stored polygon: ${stored.length / 2} of ${c.polygon.length} vertices${err === null ? ' (vertex lost)' : `, max |error| vs requested ${err.toFixed(2)} source px`}`);
      log(`  piece ${im.name} ${im.width}×${im.height} at ${im.derived.offsetX},${im.derived.offsetY}: ${im.derived.note}`);
      const bone = p.bones.find((b: any) => b.name === c.name);
      boneIds[c.name] = bone.id;
      pieces.push(savePiece(c.name, im, { path: 'polygon (canvas pixel round trip)' }));
    }

    // ---- Selection cuts: gloves -----------------------------------------------------------
    for (const c of INPUTS.selectionCuts) {
      const click = await openCutout();
      await page.getByTestId('cut-mode-wand').click();
      await fill('cut-tolerance', c.tolerance);
      await fill('cut-min-alpha', c.minAlpha);
      if (!c.contiguous) await page.getByTestId('cut-contiguous').uncheck();
      await click(c.seed);
      await page.waitForFunction(() => /^selection/.test(document.querySelector('[data-testid="cut-summary"]')?.textContent ?? ''));
      await page.getByTestId('cut-mode-pivot').click();
      await click(c.pivot);
      await setCommon(c.name, boneIds[c.parent], 0);
      const summary = await page.getByTestId('cut-summary').innerText();
      await apply(c.name);
      const p = await project();
      const im = imageOf(p, c.name);
      log(`${c.name}: ${summary}`);
      log(`  piece ${im.name} ${im.width}×${im.height} at ${im.derived.offsetX},${im.derived.offsetY}: ${im.derived.note}`);
      pieces.push(savePiece(c.name, im, { path: 'selection (exact pixels)' }));
    }

    // ---- Body = the remainder; sleeve holes are not producible as pieces -------------------
    const p = await project();
    const body = imageOf(p, 'wiz_master');
    pieces.push(savePiece('body', body, { path: 'remainder chain' }));
    log(`body = remainder ${body.name} (${body.width}×${body.height}); derivation chain: ${p.images.map((i: any) => i.name).join(' → ')}`);
    log(`bones: ${p.bones.map((b: any) => `${b.name}${b.parent ? `←${p.bones.find((x: any) => x.id === b.parent)?.name}` : ''}`).join(', ')}`);
    log(`draw order: ${p.attachments.map((a: any) => a.name).join(', ')}`);
    const dl = page.waitForEvent('download');
    await page.getByTestId('save-project').click();
    await (await dl).saveAs(path.join(OUT, 'wiz-rv010.rig.json'));
    await page.screenshot({ path: path.join(OUT, 'editor-after-cuts.png') });
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await ctx.close();
    server.kill();
  }
  writeFileSync(path.join(OUT, 'pieces.json'), JSON.stringify({ pieces, trials, precision }, null, 1));

  // ---- Metrics (definition fixed in rv010-inputs.json before the first run) ----------------
  const metricsFile = path.join(EV, 'rv010-metrics.json');
  const out = execFileSync('python3', ['-I', path.join(ROOT, 'scripts/roadmap/rv010_compare.py'), MASTER, PREPARED, OUT, metricsFile], { encoding: 'utf8' });
  for (const l of out.trimEnd().split('\n')) log(l);
  const after = originals();
  assert.deepEqual(after, before, 'originals unchanged');
  log(`originals unchanged after the run (${Object.keys(after).length} files, sha256 equal)`);
}

try {
  await main();
} finally {
  const text = lines.join('\n') + '\n';
  writeFileSync(path.join(OUT, 'log.txt'), text);
  writeFileSync(path.join(EV, 'rv010-wiz-cutout-log.txt'), text);
}
