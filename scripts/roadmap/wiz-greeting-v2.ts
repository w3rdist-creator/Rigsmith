// Authors "greeting-v2" for the Wiz rig INSIDE Rigsmith by driving visible controls in
// an isolated headless Chrome for Testing profile (.hermes/browser-profiles/wiz-v2):
//   Open… the original wiz.rig.json (read only) → + new animation → scrub the ruler and
//   type poses in the inspector → Ctrl/⌘+A + Interp "smooth" → per-key curve presets
//   (anticipation, overshoot, follow-through) → copy/paste the wave cycle → Close loop →
//   Save → Export sequence (old and new greeting) through the built-in exporter.
// window.__rigsmith is only read. The original project and media are never written.
// Outputs (new, separate directory): .hermes/assets/wiz/roadmap-output/
//   wiz-v2.rig.json, greeting-v1-seq.zip, greeting-v2-seq.zip, build-log.txt
// Usage: npm run build && node scripts/roadmap/wiz-greeting-v2.ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { launchIsolated, pickPort, probe, startPreview } from '../../tests/e2e/harness.ts';
import { OUTPUT, PROJECT_FILE, WIZ } from '../wiz/paths.ts';

export const ROADMAP_OUT = path.join(WIZ, 'roadmap-output');
export const V2_FILE = path.join(ROADMAP_OUT, 'wiz-v2.rig.json');
mkdirSync(ROADMAP_OUT, { recursive: true });

const lines: string[] = [];
const log = (m: string) => {
  const l = `${new Date().toISOString()} ${m}`;
  console.log(l);
  lines.push(l);
};
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

type Ch = 'translate' | 'rotate' | 'scale';
/** [bone, channel, frame, delta-from-setup (rotate/translate) or absolute (scale)]. */
type K = [string, Ch, number, number[]];

const FPS = 30;
const FRAMES = 72;
const KEYS: K[] = [
  // Hop with anticipation: dip and squash first, launch, land, settle.
  ['root', 'translate', 0, [0, 0]], ['root', 'translate', 4, [0, 6]], ['root', 'translate', 10, [0, -40]], ['root', 'translate', 15, [0, 0]],
  ['body', 'scale', 0, [1, 1]], ['body', 'scale', 4, [0.94, 1.04]], ['body', 'scale', 8, [1.05, 0.97]], ['body', 'scale', 15, [0.95, 1.035]], ['body', 'scale', 21, [1, 1]],
  ['body', 'rotate', 0, [0]], ['body', 'rotate', 12, [3.5]], ['body', 'rotate', 46, [3.5]], ['body', 'rotate', 60, [0]],
  ['leg_l', 'rotate', 0, [0]], ['leg_l', 'rotate', 6, [0]], ['leg_l', 'rotate', 10, [8]], ['leg_l', 'rotate', 15, [0]],
  ['leg_r', 'rotate', 0, [0]], ['leg_r', 'rotate', 6, [0]], ['leg_r', 'rotate', 10, [-8]], ['leg_r', 'rotate', 15, [0]],
  // Waving arm: anticipation (+14° down/in) → overshooting raise to -80° → wave (pasted cycle) → overshooting return.
  ['arm_r', 'rotate', 0, [0]], ['arm_r', 'rotate', 8, [14]], ['arm_r', 'rotate', 18, [-80]], ['arm_r', 'rotate', 24, [-68]], ['arm_r', 'rotate', 30, [-84]],
  ['arm_r', 'rotate', 48, [-76]], ['arm_r', 'rotate', 62, [0]],
  // Glove: drags behind the arm, whips past after the arm's peak, waggles a few frames late, settles last.
  ['hand_r', 'rotate', 0, [0]], ['hand_r', 'rotate', 10, [6]], ['hand_r', 'rotate', 21, [18]], ['hand_r', 'rotate', 27, [-24]], ['hand_r', 'rotate', 33, [20]],
  ['hand_r', 'rotate', 51, [-8]], ['hand_r', 'rotate', 66, [0]],
  // Other arm and glove: small counter-swing with delayed follow-through.
  ['arm_l', 'rotate', 0, [0]], ['arm_l', 'rotate', 8, [-6]], ['arm_l', 'rotate', 16, [16]], ['arm_l', 'rotate', 48, [8]], ['arm_l', 'rotate', 62, [0]],
  ['hand_l', 'rotate', 0, [0]], ['hand_l', 'rotate', 12, [-6]], ['hand_l', 'rotate', 22, [14]], ['hand_l', 'rotate', 50, [10]], ['hand_l', 'rotate', 66, [0]],
];

/** Curve presets applied to the key that STARTS a segment. Others stay "smooth". */
const CURVES: [string, Ch, number, string][] = [
  ['root', 'translate', 4, 'ease-out'], // launch fast, hang at the apex
  ['root', 'translate', 10, 'ease-in'], // fall faster and faster into the landing
  ['body', 'scale', 15, 'overshoot'], // landing squash springs past rest
  ['arm_r', 'rotate', 8, 'overshoot'], // raise overshoots -80° before settling
  ['arm_r', 'rotate', 48, 'overshoot'], // return overshoots rest a little
  ['arm_l', 'rotate', 8, 'overshoot'],
  ['hand_r', 'rotate', 21, 'back-in-out'], // glove whip
  ['hand_r', 'rotate', 51, 'overshoot'], // glove settles last, past rest
  ['hand_l', 'rotate', 12, 'back-in-out'],
];

const FIELDS: Record<Ch, string[]> = { translate: ['bone-x', 'bone-y'], rotate: ['bone-rotation'], scale: ['bone-scale-x', 'bone-scale-y'] };
let page: Page;

async function fill(testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function gotoFrame(frame: number): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  await ruler.scrollIntoViewIfNeeded();
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / FRAMES), y: box.height / 2 } });
  const t = (await probe<{ time: number }>(page, 'state')).time;
  assert.ok(Math.abs(t - frame / FPS) < 1e-6, `scrubbed to frame ${frame}`);
}

const r3 = (v: number) => Math.round(v * 1000) / 1000 || 0;

async function exportSeq(animName: string, file: string): Promise<void> {
  await page.getByTestId('export-sequence').click();
  await page.getByTestId('seq-anim').selectOption({ label: animName });
  const dl = page.waitForEvent('download');
  await page.getByTestId('seq-export').click();
  const d = await dl;
  await d.saveAs(path.join(ROADMAP_OUT, file));
  log(`exported "${animName}" via Export sequence… → ${file} (${d.suggestedFilename()})`);
}

async function main(): Promise<void> {
  const originalBytes = readFileSync(PROJECT_FILE);
  const originalSha = sha(originalBytes);
  const setup = JSON.parse(originalBytes.toString('utf8'));
  const bone = (n: string) => setup.bones.find((b: any) => b.name === n);
  const port = await pickPort([47614, 47615, 47616, 47617]);
  const server = await startPreview(port);
  const ctx = await launchIsolated('wiz-v2', [], { viewport: { width: 1600, height: 1000 } });
  const errors: string[] = [];
  try {
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => void d.accept());
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
    await page.getByTestId('open-input').setInputFiles(PROJECT_FILE);
    await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length === 8);
    log(`opened ${path.relative(OUTPUT, PROJECT_FILE)} via Open… (sha256 ${originalSha.slice(0, 16)}…)`);

    await page.getByTestId('new-animation').click();
    await fill('anim-name', 'greeting-v2');
    await fill('anim-duration', 2.4);
    await fill('anim-fps', FPS);

    const byFrame = new Map<number, K[]>();
    for (const k of KEYS) byFrame.set(k[2], [...(byFrame.get(k[2]) ?? []), k]);
    for (const frame of [...byFrame.keys()].sort((a, b) => a - b)) {
      await gotoFrame(frame);
      for (const [name, ch, , v] of byFrame.get(frame)!) {
        await page.getByTestId(`tree-bone-${name}`).click();
        const b = bone(name);
        const value = ch === 'rotate' ? [r3(b.rotation + v[0])] : ch === 'translate' ? [r3(b.x + v[0]), r3(b.y + v[1])] : v;
        for (const [i, f] of FIELDS[ch].entries()) await fill(f, value[i]);
        const toggle = page.getByTestId(`key-toggle-${ch}`);
        if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
      }
    }
    log(`typed ${KEYS.length} keys through the inspector at ${byFrame.size} frames`);

    // Wave cycle: copy the f24/f30 arm keys and paste them at f36 (→ f36, f42).
    await page.getByTestId('tree-bone-arm_r').click();
    await page.getByTestId('key-arm_r-rotate-24').click();
    await page.getByTestId('key-arm_r-rotate-30').click({ modifiers: ['Shift'] });
    await page.getByTestId('copy-keys').click();
    await gotoFrame(36);
    await page.getByTestId('paste-keys').click();
    // Glove waggle: copy f27/f33 and paste at f39 (→ f39, f45): a few frames behind the arm.
    await page.getByTestId('tree-bone-hand_r').click();
    await page.getByTestId('key-hand_r-rotate-27').click();
    await page.getByTestId('key-hand_r-rotate-33').click({ modifiers: ['Shift'] });
    await page.getByTestId('copy-keys').click();
    await gotoFrame(39);
    await page.getByTestId('paste-keys').click();
    log('pasted the arm wave (f24/f30 → f36/f42) and the delayed glove waggle (f27/f33 → f39/f45) with Copy / Paste');

    // Easing: select every key, make them smooth, then shape individual segments.
    await page.keyboard.press('Escape');
    await page.getByTestId('stage').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+A');
    const all = (await probe<{ keySels: unknown[] }>(page, 'state')).keySels.length;
    await page.getByTestId('key-interp').selectOption('smooth');
    log(`Ctrl+A selected ${all} keys; Interp → smooth for all in one step`);
    for (const [name, ch, frame, preset] of CURVES) {
      await page.getByTestId(`tree-bone-${name}`).click();
      await page.getByTestId(`key-${name}-${ch}-${frame}`).click();
      await page.getByTestId('curve-preset').selectOption(preset);
    }
    log(`applied curve presets: ${CURVES.map((c) => `${c[0]}.${c[1]}@f${c[2]}=${c[3]}`).join(', ')}`);

    // Loop seam: copy every lane's first key to frame 72.
    await page.keyboard.press('Escape');
    await page.getByTestId('stage').click({ position: { x: 5, y: 5 } });
    await page.getByTestId('loop-seam').click();
    log(`Close loop: ${await page.getByTestId('status').textContent()}`);

    const p = await probe<any>(page, 'project');
    const v2 = p.animations.find((a: any) => a.name === 'greeting-v2');
    const count = Object.values(v2.tracks).reduce((s: number, t: any) => s + t.translate.length + t.rotate.length + t.scale.length, 0);
    log(`greeting-v2: ${count} keys, ${Object.values(v2.tracks).flatMap((t: any) => [...t.translate, ...t.rotate, ...t.scale]).filter((k: any) => k.interp === 'bezier').length} with custom curves`);
    for (const a of setup.animations) assert.deepEqual(p.animations.find((x: any) => x.id === a.id), a, `original "${a.name}" untouched`);

    const save = page.waitForEvent('download');
    await page.getByTestId('save-project').click();
    await (await save).saveAs(V2_FILE);
    const saved = JSON.parse(readFileSync(V2_FILE, 'utf8'));
    assert.equal(saved.version, 2, 'uses v2 features → written as version 2');
    assert.deepEqual(saved, p);
    log(`saved ${path.relative(WIZ, V2_FILE)} (version ${saved.version}, sha256 ${sha(readFileSync(V2_FILE)).slice(0, 16)}…)`);

    await page.getByTestId('show-bones').uncheck();
    await exportSeq('greeting', 'greeting-v1-seq.zip');
    await exportSeq('greeting-v2', 'greeting-v2-seq.zip');
    await page.getByTestId('anim-select').selectOption({ label: 'greeting-v2' });
    await page.getByTestId('show-bones').check();
    await page.screenshot({ path: path.join(ROADMAP_OUT, 'editor-greeting-v2.png') });

    assert.equal(sha(readFileSync(PROJECT_FILE)), originalSha, 'original project file unchanged');
    assert.deepEqual(errors, [], 'no page errors');
    log('original wiz.rig.json unchanged; page errors: 0');
  } finally {
    writeFileSync(path.join(ROADMAP_OUT, 'build-log.txt'), lines.join('\n') + '\n');
    await ctx.close();
    server.kill();
  }
}

main().catch((e) => {
  log(`FAILED: ${(e as Error).stack}`);
  writeFileSync(path.join(ROADMAP_OUT, 'build-log.txt'), lines.join('\n') + '\n');
  process.exit(1);
});
