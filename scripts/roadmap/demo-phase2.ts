// Phase-2 UI demonstration with original procedural art (tests/support/png-encode.ts):
// one flat limb image is cut at the elbow with a rounded joint (cutout tool + pivot →
// joint bone), bent by two-bone IK, the hand swaps open/closed via image keys, a badge
// blinks (visibility keys) and moves behind the arm (draw-order key). Everything is
// driven through visible controls in headless Chrome for Testing; the project, an
// alpha PNG-sequence ZIP, a contact sheet and an editor screenshot are written to
// .hermes/assets/roadmap-demos/phase2/ (git-ignored). Run: npm run build && npm run demo:phase2
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { writeTestArt } from '../../tests/support/png-encode.ts';
import { ROOT, launchIsolated, pickPort, probe, startPreview } from '../../tests/e2e/harness.ts';

export const DEMO_OUT = path.join(ROOT, '.hermes/assets/roadmap-demos/phase2');
mkdirSync(path.join(DEMO_OUT, 'art'), { recursive: true });
const art = writeTestArt(path.join(DEMO_OUT, 'art'));
const log: string[] = [];
const note = (s: string) => (log.push(s), console.log(s));

type Pt = { x: number; y: number };

async function setField(page: Page, testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function gotoFrame(page: Page, frame: number, frames: number): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
}

async function drag(page: Page, from: Pt, to: Pt): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

const port = await pickPort([47614, 47615, 47616, 47617]);
const server = await startPreview(port);
const ctx = await launchIsolated('demo-phase2');
const errors: string[] = [];
try {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  if (await page.getByTestId('recovery-discard').isVisible()) await page.getByTestId('recovery-discard').click();

  // 1. Import original art and build a one-bone arm holding the flat limb image.
  await page.getByTestId('image-input').setInputFiles([art['limb.png'], art['hand-open.png'], art['hand-closed.png'], art['badge.png']]);
  await page.getByTestId('image-badge.png').waitFor();
  await page.getByTestId('add-bone').click();
  await setField(page, 'bone-name', 'shoulder');
  await setField(page, 'bone-rotation', 0);
  await setField(page, 'bone-length', 100);
  await page.getByTestId('attach-limb.png').click();
  await setField(page, 'att-x', 78);
  note('built shoulder bone + flat limb attachment');

  // 2. Cut the forearm out with a rounded joint centred on the elbow pivot.
  await page.getByTestId('att-cutout').click();
  const canvas = page.getByTestId('cutout-canvas');
  const box = (await canvas.boundingBox())!;
  const s = Number(await canvas.getAttribute('data-scale')), ox = Number(await canvas.getAttribute('data-ox')), oy = Number(await canvas.getAttribute('data-oy'));
  const at = (x: number, y: number) => ({ x: box.x + ox + x * s, y: box.y + oy + y * s });
  const outline: [number, number][] = [[199, 0.5], [199, 43.5]];
  for (let a = 90; a <= 270; a += 15) outline.push([100 + 21.5 * Math.cos((a * Math.PI) / 180), 22 + 21.5 * Math.sin((a * Math.PI) / 180)]);
  for (const [x, y] of outline) {
    const q = at(x, y);
    await page.mouse.click(q.x, q.y);
  }
  await page.getByTestId('cut-mode-pivot').click();
  const pv = at(100, 22);
  await page.mouse.click(pv.x, pv.y);
  await page.getByTestId('cut-name').fill('forearm');
  await page.getByTestId('cut-name').press('Enter');
  await setField(page, 'cut-overlap', 2);
  await page.getByTestId('cut-bone').check();
  await page.getByTestId('cut-apply').click();
  await page.getByTestId('cutout-dialog').waitFor({ state: 'hidden' });
  note(`cut forearm with a rounded joint: ${await page.getByTestId('status').innerText()}`);

  // 3. Hand on the forearm tip, IK on shoulder → forearm, a world-space badge.
  await page.getByTestId('tree-bone-forearm').click();
  const foreLen = Number(await page.getByTestId('bone-length').inputValue());
  await page.getByTestId('attach-hand-open.png').click();
  await setField(page, 'att-name', 'hand');
  await setField(page, 'att-x', foreLen + 6);
  await setField(page, 'att-rotation', 90);
  await page.getByTestId('tree-bone-forearm').click();
  await page.getByTestId('ik-add-2').click();
  note('added 2-bone IK shoulder → forearm with target forearm-target');
  await page.keyboard.press('Escape');
  await page.getByTestId('attach-badge.png').click();
  const shoulder = (await probe<{ world: Pt }>(page, 'bone', 'shoulder'))!.world;
  await setField(page, 'att-x', Math.round(shoulder.x + 60));
  await setField(page, 'att-y', Math.round(shoulder.y - 4));
  await page.getByTestId('frame-all').click();

  // 4. Animate: a 2 s loop.
  await page.getByTestId('new-animation').click();
  await setField(page, 'anim-name', 'wave');
  await setField(page, 'anim-duration', 2);
  const F = 60;
  await page.getByTestId('tree-bone-forearm-target').click();
  await gotoFrame(page, 0, F);
  await page.getByTestId('key-toggle-translate').click();
  const moves: [number, Pt][] = [[15, { x: -60, y: -110 }], [30, { x: -120, y: -40 }], [45, { x: -50, y: -120 }]];
  for (const [f, d] of moves) {
    await gotoFrame(page, f, F);
    const t = (await probe<{ origin: Pt }>(page, 'bone', 'forearm-target'))!.origin;
    const t0 = t;
    await drag(page, t0, { x: t0.x + d.x * 0.5, y: t0.y + d.y * 0.5 });
  }
  note('keyed the IK target at f0/15/30/45 by dragging it');
  await page.getByTestId('tree-att-hand').click();
  for (const [f, im] of [[15, 'hand-closed.png'], [30, 'hand-open.png'], [45, 'hand-closed.png']] as const) {
    await gotoFrame(page, f, F);
    await page.getByTestId('slot-image').selectOption({ label: im });
  }
  await gotoFrame(page, 0, F);
  await page.getByTestId('slot-key-image').click();
  note('keyed hand image swaps (open/closed)');
  await page.getByTestId('tree-att-badge').click();
  await gotoFrame(page, 20, F);
  await page.getByTestId('slot-visible').uncheck();
  await gotoFrame(page, 26, F);
  await page.getByTestId('slot-visible').check();
  await gotoFrame(page, 30, F);
  for (let i = 0; i < 3; i++) if (await page.getByTestId('draw-backward').isEnabled()) await page.getByTestId('draw-backward').click();
  await gotoFrame(page, 50, F);
  for (let i = 0; i < 3; i++) if (await page.getByTestId('draw-forward').isEnabled()) await page.getByTestId('draw-forward').click();
  note('keyed badge blink (visibility) and behind-the-arm draw order f30–f50');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  await page.getByTestId('curve-preset').selectOption('smooth');
  await page.getByTestId('loop-seam').click();
  note(`eased all curve-capable keys and closed the loop: ${await page.getByTestId('status').innerText()}`);

  // 5. Save, export, screenshot.
  const dl = page.waitForEvent('download');
  await page.getByTestId('save-project').click();
  await (await dl).saveAs(path.join(DEMO_OUT, 'phase2-demo.rig.json'));
  await page.getByTestId('export-sequence').click();
  const dl2 = page.waitForEvent('download');
  await page.getByTestId('seq-export').click();
  await (await dl2).saveAs(path.join(DEMO_OUT, 'phase2-demo-seq.zip'));
  await page.keyboard.press('Escape');
  await gotoFrame(page, 38, F);
  await page.getByTestId('tree-bone-forearm-target').click();
  await page.getByTestId('onion-toggle').check();
  await page.screenshot({ path: path.join(DEMO_OUT, 'editor-phase2.png') });
  const p = await probe<any>(page, 'project');
  note(`project: ${p.bones.length} bones, ${p.attachments.length} attachments, ${p.images.length} images (${p.images.filter((i: any) => i.derived).length} derived), ik ${p.ik?.length ?? 0}`);
} finally {
  await ctx.close();
  server.kill();
}
execFileSync('python3', ['-I', path.join(ROOT, 'scripts/roadmap/contact_sheet.py'), path.join(DEMO_OUT, 'phase2-demo-sheet.png'), `wave (IK + cutout elbow + swaps)=${path.join(DEMO_OUT, 'phase2-demo-seq.zip')}`, '--frames', '0,8,15,20,24,30,38,45,52,59'], { stdio: ['ignore', 'inherit', 'inherit'] });
note(`page errors: ${errors.length ? errors.join('; ') : 0}`);
writeFileSync(path.join(DEMO_OUT, 'build-log.txt'), log.join('\n') + '\n');
if (errors.length) process.exitCode = 1;
