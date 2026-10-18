// RV-009 on the real Wiz art: reuse a motion across projects and save a clip sequence,
// all by driving visible controls in an isolated headless Chrome for Testing profile
// (.hermes/browser-profiles/wiz-motion-reuse).
//   Open… wiz-v3.rig.json (read only) → Import anims… wiz-v2.rig.json (read only), only
//   greeting-v2, default by-name mapping, report logged → Sequences… idle-v3 ×2 →
//   greeting-v2 → idle-v3 with stored mixes → Export ZIP at the project frame → Save.
// Then `rigsmith sequence` renders the saved project and must equal the dialog ZIP byte
// for byte, and a contact sheet is built from the ZIP. The imported keys are compared
// with the source animation by bone name. Neither original is written (sha256 checked).
// Outputs: .hermes/assets/wiz/rv009-output/ (git-ignored); log also in .hermes/evidence/.
// Usage: npm run build && node scripts/roadmap/wiz-motion-reuse.ts
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { readZip } from '../../tests/support/zip-read.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from '../../tests/e2e/harness.ts';
import { ROOT, WIZ } from '../wiz/paths.ts';

const V2_FILE = path.join(WIZ, 'roadmap-output/wiz-v2.rig.json');
const V3_FILE = path.join(WIZ, 'v3-output/wiz-v3.rig.json');
const OUT = path.join(WIZ, 'rv009-output');
const SAVED = path.join(OUT, 'wiz-v3-motion-reuse.rig.json');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const lines: string[] = [];
const log = (m: string) => {
  console.log(m);
  lines.push(m);
};

let page: Page;
const project = () => probe<any>(page, 'project');

async function fill(testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function download(testId: string, name: string): Promise<string> {
  const dl = page.waitForEvent('download', { timeout: 600_000 });
  await page.getByTestId(testId).click();
  const file = path.join(OUT, name);
  await (await dl).saveAs(file);
  return file;
}

/** Tracks of one animation keyed by bone name (ids differ between the two projects). */
function tracksByName(p: any, animName: string): Record<string, unknown> {
  const a = p.animations.find((x: any) => x.name === animName);
  const name = (id: string) => p.bones.find((b: any) => b.id === id)?.name ?? `?${id}`;
  return Object.fromEntries(Object.entries(a.tracks).map(([id, t]) => [name(id), t]));
}

async function main(): Promise<void> {
  const v2Sha = sha(readFileSync(V2_FILE));
  const v3Sha = sha(readFileSync(V3_FILE));
  const port = await pickPort([47614, 47615, 47616, 47617]);
  const server = await startPreview(port);
  const ctx = await launchIsolated('wiz-motion-reuse', [], { viewport: { width: 1600, height: 1000 } });
  const errors: string[] = [];
  let editorZip = '';
  try {
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => void d.accept());
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
    await page.getByTestId('open-input').setInputFiles(V3_FILE);
    await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length === 21);
    log(`opened v3-output/wiz-v3.rig.json via Open… (sha256 ${v3Sha.slice(0, 16)}…)`);

    // ---- Import anims… greeting-v2 from Wiz v2 -----------------------------------------
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('import-anims').click()]);
    await chooser.setFiles(V2_FILE);
    await page.getByTestId('import-dialog').waitFor({ state: 'visible' });
    await page.getByTestId('imp-anim-idle').uncheck();
    await page.getByTestId('imp-anim-greeting').uncheck();
    const report = await page.getByTestId('imp-report').innerText();
    log(`import dialog report (default by-name mapping):\n  ${report.replace(/\n+/g, '\n  ')}`);
    for (const t of ['bones', 'atts', 'cons', 'imgs']) {
      const table = page.getByTestId(`imp-map-${t}`);
      if (!(await table.count())) continue;
      const rows = await table.locator('tr').evaluateAll((trs) => trs.map((tr) => {
        const sel = tr.querySelector('select')!;
        const cells = (tr as HTMLTableRowElement).cells;
        return `${cells[0].textContent} (${cells[1].textContent}) → ${sel.selectedOptions[0]?.textContent}`;
      }));
      log(`  mapping ${t}: ${rows.join('; ')}`);
    }
    await page.screenshot({ path: path.join(OUT, 'import-dialog.png') });
    await page.getByTestId('imp-apply').click();
    await page.getByTestId('import-dialog').waitFor({ state: 'hidden' });
    log(`status: ${await page.getByTestId('status').innerText()}`);
    const v2 = JSON.parse(readFileSync(V2_FILE, 'utf8'));
    const p1 = await project();
    const imported = tracksByName(p1, 'greeting-v2');
    const source = tracksByName(v2, 'greeting-v2');
    assert.deepEqual(imported, source, 'greeting-v2 bone keys equal the source, by bone name');
    log(`greeting-v2 bone tracks equal the Wiz v2 source by bone name (${Object.keys(source).length} bones: ${Object.keys(source).join(', ')})`);
    const slots = p1.animations.find((a: any) => a.name === 'greeting-v2').slots ?? {};
    log(`greeting-v2 slot lanes after import: ${Object.keys(slots).length} (source: ${Object.keys(v2.animations.find((a: any) => a.name === 'greeting-v2').slots ?? {}).length})`);

    // ---- Sequences… idle-v3 ×2 → greeting-v2 → idle-v3 --------------------------------
    await page.getByTestId('anim-select').selectOption({ label: 'idle-v3' });
    await page.getByTestId('sequences-open').click();
    await page.getByTestId('seqd-new').click();
    await fill('seqd-name', 'wiz-intro');
    await fill('seqd-step-repeat-0', 2);
    await page.getByTestId('seqd-add-step').click();
    await page.getByTestId('seqd-step-anim-1').selectOption({ label: 'greeting-v2' });
    await page.getByTestId('seqd-add-step').click();
    await fill('seqd-mix-1', 0.3);
    await fill('seqd-mix-2', 0.4);
    // At 30 fps and full size the 342 frames exceed the browser's 600-megapixel export
    // budget (the dialog says so). Half scale fits, but Chrome's downscaled canvas output
    // is not reproducible run to run (raw diffs: .hermes/evidence/usecase/
    // rv009-scale05-nondeterminism.txt), so the byte-parity proof uses scale 1 at 15 fps.
    const errs = page.getByTestId('seqd-errors');
    if (await errs.count()) log(`at 30 fps, scale 1: ${await errs.innerText()}`);
    await fill('seqd-fps', 15);
    const summary = await page.getByTestId('seqd-summary').innerText();
    const frames = Number(await page.getByTestId('seqd-summary').getAttribute('data-frames'));
    log(`sequence: ${await page.getByTestId('seqd-describe').innerText()} — ${summary}`);
    assert.equal(frames, 45 * 2 + 36 + 45, 'frame count = sum of the clips at 15 fps');
    assert.equal(await page.getByTestId('seqd-frame').inputValue(), 'project');
    const warn = page.getByTestId('seqd-frame-warning');
    log(`frame warning: ${(await warn.count()) ? await warn.innerText() : 'none'}`);
    await page.getByTestId('seqd-time').fill('100');
    await page.screenshot({ path: path.join(OUT, 'sequence-dialog-f100.png') });
    editorZip = await download('seqd-export', 'wiz-intro.editor.zip');
    log(`status: ${await page.getByTestId('status').innerText()}`);
    await page.getByTestId('seqd-close').click();
    const saveDl = page.waitForEvent('download');
    await page.getByTestId('save-project').click();
    await (await saveDl).saveAs(SAVED);
    const saved = JSON.parse(readFileSync(SAVED, 'utf8'));
    assert.deepEqual(saved, await project(), 'saved file = editor project');
    log(`saved rv009-output/wiz-v3-motion-reuse.rig.json (version ${saved.version}, ${saved.sequences.length} sequence, ${saved.mixes.length} mix rules)`);
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await ctx.close();
    server.kill();
  }

  // ---- CLI parity, ZIP facts, contact sheet ---------------------------------------------
  const cliZip = path.join(OUT, 'wiz-intro.cli.zip');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), 'sequence', SAVED, '--name', 'wiz-intro', '--frame', 'project', '--fps', '15', '--out', cliZip], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  log(`rigsmith sequence: ${j.frames} frames ${j.width}×${j.height}, steps ${j.sequence.steps.map((s: any) => `${s.animation}×${s.repeat}@${s.startFrame}+${s.frames} (mix ${s.mix})`).join(', ')}`);
  const same = sha(readFileSync(cliZip)) === sha(readFileSync(editorZip));
  log(`editor ZIP sha256 ${sha(readFileSync(editorZip)).slice(0, 16)}… ${same ? '=' : '≠'} CLI ZIP sha256 ${sha(readFileSync(cliZip)).slice(0, 16)}…`);
  assert.ok(same, 'CLI = editor, byte for byte');
  const pngs = readZip(readFileSync(editorZip)).filter((f) => f.name.endsWith('.png'));
  assert.equal(pngs.length, j.frames);
  execFileSync('python3', ['-I', path.join(ROOT, 'scripts/roadmap/contact_sheet.py'), path.join(OUT, 'wiz-intro-contact-sheet.png'), `wiz-intro (idle-v3×2 → greeting-v2 → idle-v3)=${editorZip}`, '--frames', '0,22,45,67,85,90,95,100,108,115,126,131,150,170', '--crop']);
  log('contact sheet: rv009-output/wiz-intro-contact-sheet.png');
  assert.equal(sha(readFileSync(V2_FILE)), v2Sha, 'wiz-v2.rig.json unchanged');
  assert.equal(sha(readFileSync(V3_FILE)), v3Sha, 'wiz-v3.rig.json unchanged');
  log(`originals unchanged: wiz-v2 ${v2Sha.slice(0, 16)}…, wiz-v3 ${v3Sha.slice(0, 16)}…`);
}

try {
  await main();
} finally {
  const text = lines.join('\n') + '\n';
  writeFileSync(path.join(OUT, 'log.txt'), text);
  mkdirSync(path.join(EVIDENCE, 'usecase'), { recursive: true });
  writeFileSync(path.join(EVIDENCE, 'usecase/rv009-wiz-log.txt'), text);
}
