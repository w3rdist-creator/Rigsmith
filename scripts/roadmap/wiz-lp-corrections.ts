// Review corrections (LP-001, LP-002, LP-003, LP-008) on the real Wiz art, by driving
// visible controls in an isolated headless Chrome for Testing profile
// (.hermes/browser-profiles/wiz-lp-corrections):
//   Open… wiz-v3.rig.json (read only) → Import anims… greeting-v2 from wiz-v2.rig.json
//   (read only) twice: (A) as is, reading the "overridden by" warning and the rig notes;
//   (B) with "Offset by the setup difference" and the two arm IKs keyed to mix 0 →
//   inspector "Fit to all animations" → Sequences… "wiz-intro" (A) and "wiz-intro-arms"
//   (B), idle-v3 ×2 → greeting → idle-v3 with the stored mixes, each exported as a ZIP at
//   the project frame (15 fps: 30 fps full size is over the export limit, logged) → Save.
// Then `rigsmith sequence` renders both from the saved file (byte parity), per-frame
// pixel differences A vs B are counted, and one contact sheet shows both rows.
// Writes only to a NEW directory .hermes/assets/wiz/lp-corrections-output/ (refuses to run
// if it exists; nothing is deleted) and the log to .hermes/evidence/review-corrections/.
// Usage: npm run build && node scripts/roadmap/wiz-lp-corrections.ts
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { safeName } from '../../src/render/sequence.ts';
import { decodePng } from '../../tests/support/png-decode.ts';
import { readZip } from '../../tests/support/zip-read.ts';
import { launchIsolated, pickPort, probe, startPreview } from '../../tests/e2e/harness.ts';
import { ROOT, WIZ } from '../wiz/paths.ts';

const V2_FILE = path.join(WIZ, 'roadmap-output/wiz-v2.rig.json');
const V3_FILE = path.join(WIZ, 'v3-output/wiz-v3.rig.json');
const OUT = path.join(WIZ, 'lp-corrections-output');
const LOG = path.join(ROOT, '.hermes/evidence/review-corrections/wiz-lp-corrections-log.txt');
const SAVED = path.join(OUT, 'wiz-v3-lp-corrections.rig.json');
if (existsSync(OUT)) throw new Error(`${OUT} exists; this script never overwrites — move it aside first`);
mkdirSync(OUT, { recursive: true });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const lines: string[] = [];
const log = (m: string) => {
  console.log(m);
  lines.push(m);
};

let page: Page;
const project = () => probe<any>(page, 'project');
const ARM_IKS = ['forearm_l-ik', 'forearm_r-ik'];
const ALL_IKS = ['forearm_l-ik', 'forearm_r-ik', 'shin_l-ik', 'shin_r-ik'];

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

async function openImport(): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('import-anims').click()]);
  await chooser.setFiles(V2_FILE);
  await page.getByTestId('import-dialog').waitFor({ state: 'visible' });
  await page.getByTestId('imp-anim-idle').uncheck();
  await page.getByTestId('imp-anim-greeting').uncheck();
}

const text = async (testId: string) => (await page.getByTestId(testId).innerText()).replace(/\n+/g, '\n');

/** Builds one sequence idle-v3 ×2 → anim → idle-v3 (mixes 0.3, 0.4) and exports it. */
async function sequence(name: string, anim: string, file: string): Promise<{ zip: string; warning: string | null }> {
  await page.getByTestId('seqd-new').click();
  await fill('seqd-name', name);
  await page.getByTestId('seqd-step-anim-0').selectOption({ label: 'idle-v3' });
  await fill('seqd-step-repeat-0', 2);
  await page.getByTestId('seqd-add-step').click();
  await page.getByTestId('seqd-step-anim-1').selectOption({ label: anim });
  await page.getByTestId('seqd-add-step').click();
  await page.getByTestId('seqd-step-anim-2').selectOption({ label: 'idle-v3' });
  await fill('seqd-mix-1', 0.3);
  await fill('seqd-mix-2', 0.4);
  await fill('seqd-fps', 30);
  const errs = page.getByTestId('seqd-errors');
  log(`${name} at 30 fps, scale 1: ${(await errs.count()) ? await errs.innerText() : 'no error'}`);
  await fill('seqd-fps', 15);
  assert.equal(await page.getByTestId('seqd-frame').inputValue(), 'project');
  log(`${name}: ${await page.getByTestId('seqd-describe').innerText()} — ${await page.getByTestId('seqd-summary').innerText()}`);
  const warn = page.getByTestId('seqd-frame-warning');
  const warning = (await warn.count()) && (await warn.isVisible()) ? await warn.innerText() : null;
  log(`${name} frame warning: ${warning ?? 'none'}`);
  await page.getByTestId('seqd-time').fill('105');
  await page.screenshot({ path: path.join(OUT, `${safeName(name)}-dialog-f105.png`) });
  const zip = await download('seqd-export', file);
  log(`status: ${await page.getByTestId('status').innerText()}`);
  return { zip, warning };
}

async function main(): Promise<{ zips: string[]; names: string[] }> {
  const v2Sha = sha(readFileSync(V2_FILE));
  const v3Sha = sha(readFileSync(V3_FILE));
  const port = await pickPort([47614, 47615, 47616, 47617]);
  const server = await startPreview(port);
  const ctx = await launchIsolated('wiz-lp-corrections', [], { viewport: { width: 1600, height: 1000 } });
  const errors: string[] = [];
  const zips: string[] = [];
  const names: string[] = [];
  try {
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => void d.accept());
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
    await page.getByTestId('open-input').setInputFiles(V3_FILE);
    await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length === 21);
    log(`opened v3-output/wiz-v3.rig.json via Open… (sha256 ${v3Sha.slice(0, 16)}…)`);
    const v2 = JSON.parse(readFileSync(V2_FILE, 'utf8'));
    const v2Greeting = v2.animations.find((a: any) => a.name === 'greeting-v2');

    // ---- (A) Import as is: the report must name the four IKs and 26 overridden keys -----
    await openImport();
    const driven = await text('imp-driven');
    log(`(A) imp-driven:\n  ${driven.replace(/\n/g, '\n  ')}`);
    log(`(A) imp-rig:\n  ${(await text('imp-rig')).replace(/\n/g, '\n  ')}`);
    for (const ik of ALL_IKS) assert.match(driven, new RegExp(`IK “${ik}” \\(mix 1\\) overrides \\d+ imported key`), `warning names ${ik}`);
    const counts = [...driven.matchAll(/overrides (\d+) imported key/g)].map((m) => Number(m[1]));
    assert.equal(counts.reduce((a, b) => a + b, 0), 26, '26 overridden keys');
    log(`(A) overridden keys per IK: ${counts.join(' + ')} = 26`);
    assert.match(await text('imp-rig'), /“body” has scale keys; here they also scale 11 bone\(s\)/);
    // The offset option changes nothing on Wiz: greeting-v2 keys only rotation on the
    // re-parented bones, whose setup rotations are equal (their x differs, 300–406 px).
    const before = await text('imp-report');
    await page.getByTestId('imp-offset-setup').check();
    assert.equal(await text('imp-report'), before, 'offset: same report');
    await page.getByTestId('imp-offset-setup').uncheck();
    await page.screenshot({ path: path.join(OUT, 'import-a-warning.png') });
    await page.getByTestId('imp-apply').click();
    await page.getByTestId('import-dialog').waitFor({ state: 'hidden' });
    log(`(A) status: ${await page.getByTestId('status').innerText()}`);

    // ---- (B) Offset on, the two arm IKs keyed to mix 0 in the imported copy -------------
    await openImport();
    await page.getByTestId('imp-offset-setup').check();
    for (const ik of ARM_IKS) await page.getByTestId(`imp-mute-${safeName(ik)}`).check();
    log(`(B) imp-driven:\n  ${(await text('imp-driven')).replace(/\n/g, '\n  ')}`);
    await page.screenshot({ path: path.join(OUT, 'import-b-options.png') });
    await page.getByTestId('imp-apply').click();
    await page.getByTestId('import-dialog').waitFor({ state: 'hidden' });
    log(`(B) status: ${await page.getByTestId('status').innerText()}`);

    const p1 = await project();
    const greetings = p1.animations.filter((a: any) => a.name.startsWith('greeting-v2'));
    assert.equal(greetings.length, 2);
    const [a, b] = greetings;
    names.push(a.name, b.name);
    const byName = (an: any, pr: any) => Object.fromEntries(Object.entries(an.tracks).map(([id, t]) => [pr.bones.find((x: any) => x.id === id)?.name, t]));
    assert.deepEqual(byName(a, p1), byName(v2Greeting, v2), '(A) bone keys equal the source by name');
    assert.deepEqual(byName(b, p1), byName(v2Greeting, v2), '(B) offset is a no-op here: keys equal the source');
    const ikName = (id: string) => p1.ik.find((k: any) => k.id === id)?.name;
    assert.equal(a.constraints, undefined, '(A) no constraint keys');
    assert.deepEqual(Object.fromEntries(Object.entries(b.constraints).map(([id, c]: any) => [ikName(id), c.mix])), Object.fromEntries(ARM_IKS.map((n) => [n, [{ time: 0, value: [0], interp: 'step' }]])), '(B) mix 0 keys on the arm IKs only');
    assert.ok(p1.ik.every((k: any) => k.mix === 1), 'setup IK mixes unchanged');
    log(`imported: “${a.name}” (as is), “${b.name}” (offset on; ${ARM_IKS.join(', ')} keyed to mix 0)`);

    // ---- LP-008: Fit to all animations, then the sequences -----------------------------
    const f0 = p1.frame;
    await page.getByTestId('frame-fit').click();
    const f1 = (await project()).frame;
    log(`project frame: ${JSON.stringify(f0)} → Fit to all animations → ${JSON.stringify(f1)}`);
    await page.getByTestId('anim-select').selectOption({ label: 'idle-v3' });
    await page.getByTestId('sequences-open').click();
    const A = await sequence('wiz-intro', a.name, 'wiz-intro.editor.zip');
    const B = await sequence('wiz-intro-arms', b.name, 'wiz-intro-arms.editor.zip');
    assert.equal(A.warning, null, 'LP-008: no frame warning (A)');
    assert.equal(B.warning, null, 'LP-008: no frame warning (B)');
    zips.push(A.zip, B.zip);
    await page.getByTestId('seqd-close').click();
    const saveDl = page.waitForEvent('download');
    await page.getByTestId('save-project').click();
    await (await saveDl).saveAs(SAVED);
    const saved = JSON.parse(readFileSync(SAVED, 'utf8'));
    assert.deepEqual(saved, await project(), 'saved file = editor project');
    log(`saved lp-corrections-output/${path.basename(SAVED)} (version ${saved.version}, ${saved.sequences.length} sequences)`);
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await ctx.close();
    server.kill();
  }
  assert.equal(sha(readFileSync(V2_FILE)), v2Sha, 'wiz-v2.rig.json unchanged');
  assert.equal(sha(readFileSync(V3_FILE)), v3Sha, 'wiz-v3.rig.json unchanged');
  log(`originals unchanged: wiz-v2 ${v2Sha.slice(0, 16)}…, wiz-v3 ${v3Sha.slice(0, 16)}…`);
  return { zips, names };
}

try {
  const { zips } = await main();
  // ---- CLI parity, A vs B per frame, contact sheet --------------------------------------
  for (const [name, zip] of [['wiz-intro', zips[0]], ['wiz-intro-arms', zips[1]]]) {
    const cli = path.join(OUT, `${name}.cli.zip`);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), 'sequence', SAVED, '--name', name, '--frame', 'project', '--fps', '15', '--out', cli], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    const same = sha(readFileSync(cli)) === sha(readFileSync(zip));
    log(`rigsmith sequence ${name}: ${j.frames} frames ${j.width}×${j.height}; editor ZIP ${same ? '=' : '≠'} CLI ZIP (sha256 ${sha(readFileSync(zip)).slice(0, 16)}…)`);
    assert.ok(same, `${name}: CLI = editor, byte for byte`);
  }
  const [fa, fb] = zips.map((z) => readZip(readFileSync(z)).filter((f) => f.name.endsWith('.png')).map((f) => decodePng(Buffer.from(f.data))));
  assert.equal(fa.length, fb.length);
  assert.ok(fa.every((im, i) => im.width === fb[i].width && im.height === fb[i].height && im.width === fa[0].width && im.height === fa[0].height), 'one frame size for every frame of both rows');
  const diff = fa.map((im, i) => {
    let n = 0;
    for (let k = 0; k < im.data.length; k += 4) if (im.data[k] !== fb[i].data[k] || im.data[k + 1] !== fb[i].data[k + 1] || im.data[k + 2] !== fb[i].data[k + 2] || im.data[k + 3] !== fb[i].data[k + 3]) n++;
    return n;
  });
  log(`frames ${fa.length} of ${fa[0].width}×${fa[0].height} in both rows; pixels differing A vs B per frame: ${diff.map((n, i) => `${i}:${n}`).filter((_, i) => i % 5 === 0 || (i >= 85 && i <= 135)).join(' ')}`);
  log(`A vs B: frames with any difference ${diff.filter((n) => n > 0).length} (first ${diff.findIndex((n) => n > 0)}, last ${diff.length - 1 - [...diff].reverse().findIndex((n) => n > 0)}), max ${Math.max(...diff)} px`);
  execFileSync('python3', ['-I', path.join(ROOT, 'scripts/roadmap/contact_sheet.py'), path.join(OUT, 'wiz-intro-lp-contact-sheet.png'), `wiz-intro (greeting-v2 imported as is: arm keys overridden by IK)=${zips[0]}`, `wiz-intro-arms (arm IKs keyed to mix 0 in the imported copy)=${zips[1]}`, '--frames', '0,45,85,90,95,100,105,110,115,120,126,131,150,170', '--crop']);
  log('contact sheet: lp-corrections-output/wiz-intro-lp-contact-sheet.png');
} finally {
  mkdirSync(path.dirname(LOG), { recursive: true });
  writeFileSync(LOG, lines.join('\n') + '\n');
  writeFileSync(path.join(OUT, 'log.txt'), lines.join('\n') + '\n');
}
