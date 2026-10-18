// Phase-3 demo runner: builds the bendy-limb demo through the UI (demo-phase3-build.ts)
// and writes the project, an alpha PNG-sequence ZIP, a contact sheet, an editor
// screenshot (mesh wireframe over the bent arm) and a build log to
// .hermes/assets/roadmap-demos/phase3/ (git-ignored). Run: npm run build && npm run demo:phase3
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeMeshArt } from '../../tests/support/mesh-fixtures.ts';
import { ROOT, launchIsolated, pickPort, probe, startPreview } from '../../tests/e2e/harness.ts';
import { buildBendyDemo, gotoFrame } from './demo-phase3-build.ts';

const OUT = path.join(ROOT, '.hermes/assets/roadmap-demos/phase3');
mkdirSync(path.join(OUT, 'art'), { recursive: true });
const art = writeMeshArt(path.join(OUT, 'art'));
const log: string[] = [];
const note = (s: string) => (log.push(s), console.log(s));

const port = await pickPort([47614, 47615, 47616, 47617]);
const server = await startPreview(port);
const ctx = await launchIsolated('demo-phase3');
const errors: string[] = [];
try {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  if (await page.getByTestId('recovery-discard').isVisible()) await page.getByTestId('recovery-discard').click();
  for (const s of await buildBendyDemo(page, art)) note(s);
  const dl = page.waitForEvent('download');
  await page.getByTestId('save-project').click();
  await (await dl).saveAs(path.join(OUT, 'phase3-demo.rig.json'));
  await page.getByTestId('export-sequence').click();
  const dl2 = page.waitForEvent('download');
  await page.getByTestId('seq-export').click();
  await (await dl2).saveAs(path.join(OUT, 'phase3-demo-seq.zip'));
  await page.keyboard.press('Escape');
  await gotoFrame(page, 15);
  await page.getByTestId('tree-att-hose-arm').click();
  await page.getByTestId('mesh-tool-vertices').click();
  await page.screenshot({ path: path.join(OUT, 'editor-phase3.png') });
  const p = await probe<any>(page, 'project');
  note(`project: ${p.bones.length} bones, ${p.attachments.length} attachments (${p.attachments.filter((a: any) => a.mesh).length} meshes), version ${p.version}`);
} finally {
  await ctx.close();
  server.kill();
}
execFileSync('python3', ['-I', path.join(ROOT, 'scripts/roadmap/contact_sheet.py'), path.join(OUT, 'phase3-demo-sheet.png'), `wave (meshed hose arm + tail follow-through)=${path.join(OUT, 'phase3-demo-seq.zip')}`, '--frames', '0,6,12,15,20,26,33,38,45,52'], { stdio: ['ignore', 'inherit', 'inherit'] });
note(`page errors: ${errors.length ? errors.join('; ') : 0}`);
writeFileSync(path.join(OUT, 'build-log.txt'), log.join('\n') + '\n');
if (errors.length) process.exitCode = 1;
