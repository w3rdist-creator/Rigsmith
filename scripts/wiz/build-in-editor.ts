// Builds the Wiz rig INSIDE Rigsmith by driving its visible controls in an isolated,
// headless Chrome for Testing profile (.hermes/browser-profiles/wiz-build):
//   import the prepared PNGs → add/name/pose bones in the inspector → attach images and
//   set their offsets → create the "idle" and "greeting" animations, scrub to frames and
//   key poses through the inspector → set key interpolation → Save (download).
// window.__rigsmith is only read, to check each step landed. Output:
//   .hermes/assets/wiz/output/wiz.rig.json   (images embedded)
//   .hermes/assets/wiz/output/review/*.png   (editor screenshots, Rigsmith setup-pose PNG export)
//   .hermes/evidence/wiz/build-log.txt
// Usage: npm run build && node scripts/wiz/build-in-editor.ts
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { launchIsolated, pickPort, probe, startPreview } from '../../tests/e2e/harness.ts';
import { EVIDENCE, OUTPUT, PREPARED, PROJECT_FILE, loadManifest } from './paths.ts';
import { ANIMS, buildRig, keyValue } from './rig-spec.ts';
import type { AnimSpec, BoneSetup, Channel } from './rig-spec.ts';

const REVIEW = path.join(OUTPUT, 'review');
mkdirSync(REVIEW, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });
const lines: string[] = [];
const log = (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  lines.push(line);
};

const FIELDS: Record<Channel, string[]> = { translate: ['bone-x', 'bone-y'], rotate: ['bone-rotation'], scale: ['bone-scale-x', 'bone-scale-y'] };

let page: Page;

async function fill(testId: string, value: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(value));
  await el.press('Enter');
}

async function gotoFrame(frame: number, frames: number, fps: number): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  await ruler.scrollIntoViewIfNeeded();
  const box = (await ruler.boundingBox())!;
  const x = Math.min(box.width - 0.5, (box.width * frame) / frames);
  await ruler.click({ position: { x, y: box.height / 2 } });
  const t = (await probe<{ time: number }>(page, 'state')).time;
  assert.ok(Math.abs(t - frame / fps) < 1e-6, `scrubbed to frame ${frame} (got t=${t})`);
}

async function selectBone(name: string): Promise<void> {
  await page.getByTestId(`tree-bone-${name}`).click();
}

async function keyAnimation(anim: AnimSpec, bones: Map<string, BoneSetup>): Promise<number> {
  await page.getByTestId('new-animation').click();
  await fill('anim-name', anim.name);
  await fill('anim-duration', anim.duration);
  await fill('anim-fps', anim.fps);
  assert.equal(await page.getByTestId('anim-loop').isChecked(), true, 'loop on');
  const frames = Math.round(anim.duration * anim.fps);
  const byFrame = new Map<number, typeof anim.keys>();
  for (const k of anim.keys) byFrame.set(k.frame, [...(byFrame.get(k.frame) ?? []), k]);
  let keyed = 0;
  for (const frame of [...byFrame.keys()].sort((a, b) => a - b)) {
    await gotoFrame(frame, frames, anim.fps);
    for (const k of byFrame.get(frame)!) {
      await selectBone(k.bone);
      const value = keyValue(bones.get(k.bone)!, k);
      for (const [i, field] of FIELDS[k.ch].entries()) await fill(field, value[i]);
      // A typed value equal to the current pose fires no change event; key it explicitly.
      const toggle = page.getByTestId(`key-toggle-${k.ch}`);
      if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
      keyed++;
    }
  }
  // Interpolation: set on every key that starts a segment (the last key of a track has none).
  const p = await probe<any>(page, 'project');
  const a = p.animations.find((x: any) => x.name === anim.name);
  const idOf = new Map(p.bones.map((b: any) => [b.name, b.id]));
  for (const k of anim.keys) {
    const track = a.tracks[idOf.get(k.bone) as string][k.ch] as { time: number }[];
    if (Math.abs(track[track.length - 1].time - k.frame / anim.fps) < 1e-6) continue;
    await page.getByTestId(`key-${k.bone}-${k.ch}-${k.frame}`).click();
    await page.getByTestId('key-interp').selectOption(anim.interp);
  }
  return keyed;
}

async function main(): Promise<void> {
  const manifest = loadManifest();
  const { bones, attachments } = buildRig(manifest);
  const boneMap = new Map(bones.map((b) => [b.name, b]));
  const port = await pickPort([47614, 47615, 47616, 47617]);
  const server = await startPreview(port);
  const ctx = await launchIsolated('wiz-build', [], { viewport: { width: 1600, height: 1000 } });
  const errors: string[] = [];
  try {
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => void d.accept());
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
    log(`editor open on 127.0.0.1:${port} (isolated profile wiz-build)`);

    await fill('project-name', 'Wiz — cheesesteak mascot');

    // 1. Import the prepared cutouts through the Images panel's file input.
    const files = manifest.drawOrder.map((n) => path.join(PREPARED, manifest.parts[n].file));
    await page.getByTestId('image-input').setInputFiles(files);
    for (const n of manifest.drawOrder) await page.getByTestId(`image-${manifest.parts[n].file}`).waitFor();
    log(`imported ${files.length} images via the Import file input`);

    // 2. Bones: "+ Bone" adds a child of the selected bone; then name + setup pose in the inspector.
    for (const b of bones) {
      if (b.parent) await selectBone(b.parent);
      await page.getByTestId('add-bone').click();
      await fill('bone-name', b.name);
      await fill('bone-x', b.x);
      await fill('bone-y', b.y);
      await fill('bone-rotation', b.rotation);
      await fill('bone-length', b.length);
      if (!b.parent) await page.keyboard.press('Escape');
    }
    let p = await probe<any>(page, 'project');
    const nameOf = new Map(p.bones.map((x: any) => [x.id, x.name]));
    for (const b of bones) {
      const got = p.bones.find((x: any) => x.name === b.name);
      assert.ok(got, `bone ${b.name}`);
      assert.equal(got.parentId ? nameOf.get(got.parentId) : null, b.parent, `${b.name} parent`);
      for (const k of ['x', 'y', 'rotation', 'length'] as const) assert.equal(got[k], b[k], `${b.name}.${k}`);
      const ws = await probe<any>(page, 'bone', b.name);
      assert.ok(Math.abs(ws.world.x - b.world.x) < 0.01 && Math.abs(ws.world.y - b.world.y) < 0.01, `${b.name} world origin`);
    }
    log(`created ${bones.length} bones: ${bones.map((b) => `${b.name}${b.parent ? `<${b.parent}` : ''}`).join(', ')}`);

    // 3. Attach each image to its bone (in draw order, back to front) and set the offset.
    for (const a of attachments) {
      await selectBone(a.bone);
      await page.getByTestId(`attach-${a.file}`).click();
      await fill('att-x', a.x);
      await fill('att-y', a.y);
      await fill('att-rotation', a.rotation);
    }
    p = await probe<any>(page, 'project');
    assert.deepEqual(p.attachments.map((a: any) => a.name), attachments.map((a) => a.name), 'draw order');
    log(`attached ${attachments.length} images in draw order: ${attachments.map((a) => `${a.name}→${a.bone}`).join(', ')}`);

    await page.getByTestId('frame-all').click();
    await page.getByTestId('stage').screenshot({ path: path.join(REVIEW, 'editor-setup-with-bones.png') });
    await page.screenshot({ path: path.join(REVIEW, 'editor-ui-setup.png') });

    // Setup-pose PNG through Rigsmith's own exporter (zoom 1, transparent, cropped).
    await page.keyboard.press('Escape');
    const dl = page.waitForEvent('download');
    await page.getByTestId('export-png').click();
    await (await dl).saveAs(path.join(REVIEW, 'rigsmith-setup-export.png'));
    log('exported the setup pose with Export PNG → review/rigsmith-setup-export.png');

    // 4. Animations, keyed through the timeline + inspector.
    for (const anim of ANIMS) {
      const n = await keyAnimation(anim, boneMap);
      log(`animation "${anim.name}": ${anim.duration}s @ ${anim.fps} fps, loop, ${n} keys typed, interp ${anim.interp}`);
    }
    p = await probe<any>(page, 'project');
    for (const anim of ANIMS) {
      const a = p.animations.find((x: any) => x.name === anim.name);
      const count = Object.values(a.tracks).reduce((s: number, t: any) => s + t.translate.length + t.rotate.length + t.scale.length, 0);
      assert.equal(count, anim.keys.length, `${anim.name} key count`);
    }
    await page.getByTestId('stage').screenshot({ path: path.join(REVIEW, 'editor-animate-end.png') });
    await page.screenshot({ path: path.join(REVIEW, 'editor-ui-animate.png') });

    // 5. Save via the Save button (download with embedded images).
    const save = page.waitForEvent('download');
    await page.getByTestId('save-project').click();
    const d = await save;
    await d.saveAs(PROJECT_FILE);
    const saved = JSON.parse(readFileSync(PROJECT_FILE, 'utf8'));
    assert.deepEqual(saved, await probe<any>(page, 'project'), 'saved file equals editor project');
    log(`saved ${PROJECT_FILE} (${(readFileSync(PROJECT_FILE).length / 1024 / 1024).toFixed(2)} MB, suggested name ${d.suggestedFilename()})`);
    assert.deepEqual(errors, [], 'no page errors');
    log('page errors: 0');
  } finally {
    writeFileSync(path.join(EVIDENCE, 'build-log.txt'), lines.join('\n') + '\n');
    await ctx.close();
    server.kill();
  }
}

main().catch((e) => {
  log(`FAILED: ${(e as Error).stack}`);
  writeFileSync(path.join(EVIDENCE, 'build-log.txt'), lines.join('\n') + '\n');
  process.exit(1);
});
