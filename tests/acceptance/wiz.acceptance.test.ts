// Wiz acceptance test: loads the SAVED character project (.hermes/assets/wiz/output/
// wiz.rig.json, built through the editor UI by scripts/wiz/build-in-editor.ts) into a
// fresh isolated Chrome for Testing profile and exercises it through visible controls.
// Needs the private, git-ignored Wiz assets, so it is not part of `npm run test:e2e`.
// Run: npm run build && npm run test:wiz
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { launchIsolated, pickPort, probe, startPreview } from '../e2e/harness.ts';
import { EVIDENCE, PROJECT_FILE, loadManifest } from '../../scripts/wiz/paths.ts';
import { ANIMS, buildRig } from '../../scripts/wiz/rig-spec.ts';

const SHOTS = path.join(EVIDENCE, 'acceptance');
mkdirSync(SHOTS, { recursive: true });
const manifest = loadManifest();
const rig = buildRig(manifest);
const original = JSON.parse(readFileSync(PROJECT_FILE, 'utf8'));
const BONES = rig.bones.map((b) => b.name);

type World = { x: number; y: number; angle: number };
let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let base: string;
const pageErrors: string[] = [];

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const project = () => probe<any>(page, 'project');
const state = () => probe<{ time: number; playing: boolean; mode: string; animName: string; undo: number }>(page, 'state');
const world = async (name: string) => (await probe<{ world: World }>(page, 'bone', name)).world;
const poseAll = async () => Object.fromEntries(await Promise.all(BONES.map(async (b) => [b, await world(b)] as const))) as Record<string, World>;
const near = (a: number, b: number, eps: number, msg: string) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≈ ${b} ±${eps}`);
const range = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
const wrapDeg = (d: number) => ((d + 540) % 360) - 180;

async function canvasHash(): Promise<string> {
  const url = await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return (document.getElementById('stage-canvas') as HTMLCanvasElement).toDataURL('image/png');
  });
  return sha(url);
}

async function openProject(file: string): Promise<void> {
  if (page) await page.close();
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(base);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
  await page.getByTestId('open-input').setInputFiles(file);
  await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length > 0);
}

async function selectAnim(name: string): Promise<void> {
  await page.getByTestId('anim-select').selectOption({ label: name });
  assert.equal((await state()).animName, name);
}

async function gotoFrame(frame: number, frames: number, fps: number): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
  near((await state()).time, frame / fps, 1e-6, `scrubbed to frame ${frame}`);
}

before(async () => {
  assert.ok(existsSync(PROJECT_FILE), `${PROJECT_FILE} missing — run scripts/wiz/build-in-editor.ts first`);
  const port = await pickPort([47614, 47615, 47616, 47617]);
  base = `http://127.0.0.1:${port}/`;
  server = await startPreview(port);
  ctx = await launchIsolated('wiz-verify');
  await openProject(PROJECT_FILE);
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('saved Wiz project', () => {
  it('opens with every prepared image persisted byte-for-byte, the bone hierarchy and draw order', async () => {
    const p = await project();
    assert.equal(p.format, 'rigsmith.project');
    assert.equal(p.images.length, manifest.drawOrder.length);
    for (const part of manifest.drawOrder) {
      const P = manifest.parts[part];
      const im = p.images.find((i: any) => i.name === P.file);
      assert.ok(im, `image ${P.file} embedded`);
      assert.match(im.dataUrl, /^data:image\/png;base64,/);
      assert.equal(sha(Buffer.from(im.dataUrl.split(',')[1], 'base64')), P.sha256, `${P.file} bytes identical to prepared PNG`);
      assert.deepEqual([im.width, im.height], P.bbox.slice(2), `${P.file} size`);
    }
    assert.deepEqual(p.attachments.map((a: any) => a.name), manifest.drawOrder, 'draw order back→front');
    const nameOf = new Map(p.bones.map((b: any) => [b.id, b.name]));
    for (const b of rig.bones) {
      const got = p.bones.find((x: any) => x.name === b.name);
      assert.equal(got.parentId ? nameOf.get(got.parentId) : null, b.parent, `${b.name} parent`);
    }
    assert.deepEqual(
      p.animations.map((a: any) => [a.name, a.duration, a.fps, a.loop]),
      ANIMS.map((a) => [a.name, a.duration, a.fps, true]),
    );
    // Setup pose: bone joints sit on the pivots measured from the artwork.
    await page.getByTestId('mode-setup').click();
    for (const b of rig.bones) {
      const w = await world(b.name);
      near(w.x, b.world.x, 0.01, `${b.name} world x`);
      near(w.y, b.world.y, 0.01, `${b.name} world y`);
      near(wrapDeg(w.angle - b.world.angle), 0, 0.01, `${b.name} world angle`);
    }
    await page.getByTestId('stage').screenshot({ path: path.join(SHOTS, '00-opened-setup.png') });
  });
});

describe('playback', () => {
  for (const anim of ANIMS) {
    it(`plays "${anim.name}" in real time and keeps looping past its ${anim.duration}s length`, async () => {
      await selectAnim(anim.name);
      await page.getByTestId('show-bones').uncheck();
      await page.getByTestId('play').click();
      await page.waitForTimeout(300);
      const s1 = await state();
      const h1 = await canvasHash();
      await page.waitForTimeout(450);
      const s2 = await state();
      const h2 = await canvasHash();
      assert.ok(s1.playing && s2.playing, 'playing');
      assert.notEqual(s1.time, s2.time, 'playhead advances');
      assert.notEqual(h1, h2, 'rendered canvas changes during playback');
      await page.waitForTimeout(anim.duration * 1000);
      const s3 = await state();
      assert.ok(s3.playing, 'still playing after more than one full duration (loop)');
      assert.ok(s3.time >= 0 && s3.time <= anim.duration, 'time wrapped into the clip');
      await page.getByTestId('stage').screenshot({ path: path.join(SHOTS, `10-playing-${anim.name}.png`) });
      await page.getByTestId('play').click();
      assert.equal((await state()).playing, false, 'paused');
    });
  }
});

describe('sampling: independently articulated parts', () => {
  const rel = (p: Record<string, World>, child: string, parent: string) => wrapDeg(p[child].angle - p[parent].angle);
  const samplesFor = async (anim: (typeof ANIMS)[number], n: number) => {
    await selectAnim(anim.name);
    const frames = Math.round(anim.duration * anim.fps);
    const out: { frame: number; pose: Record<string, World>; hash: string }[] = [];
    for (let i = 0; i < n; i++) {
      const frame = Math.round((i * frames) / n);
      await gotoFrame(frame, frames, anim.fps);
      out.push({ frame, pose: await poseAll(), hash: await canvasHash() });
    }
    return out;
  };

  it('idle: subtle body sway + breathing, arms and gloves articulate relative to their parents, feet planted', async () => {
    const s = await samplesFor(ANIMS[0], 8);
    const r = (c: string, p: string) => range(s.map((x) => rel(x.pose, c, p)));
    assert.ok(range(s.map((x) => x.pose.body.angle)) >= 1, `body sways (${range(s.map((x) => x.pose.body.angle)).toFixed(2)}°)`);
    assert.ok(range(s.map((x) => x.pose.body.angle)) <= 4, 'idle sway stays subtle');
    assert.ok(r('arm_l', 'body') >= 3, `arm_l vs body ${r('arm_l', 'body').toFixed(2)}°`);
    assert.ok(r('arm_r', 'body') >= 3, `arm_r vs body ${r('arm_r', 'body').toFixed(2)}°`);
    assert.ok(r('hand_l', 'arm_l') >= 5, `hand_l vs arm_l ${r('hand_l', 'arm_l').toFixed(2)}°`);
    assert.ok(r('hand_r', 'arm_r') >= 5, `hand_r vs arm_r ${r('hand_r', 'arm_r').toFixed(2)}°`);
    for (const leg of ['leg_l', 'leg_r']) assert.ok(range(s.map((x) => x.pose[leg].angle)) < 1e-6, `${leg} planted in idle`);
    assert.ok(new Set(s.map((x) => x.hash)).size >= 7, 'rendered frames differ across samples');
  });

  it('greeting: hop, raised waving arm, glove waggle, leg kick — far larger than idle', async () => {
    const s = await samplesFor(ANIMS[1], 12);
    const r = (c: string, p: string) => range(s.map((x) => rel(x.pose, c, p)));
    assert.ok(r('arm_r', 'body') >= 60, `waving arm vs body ${r('arm_r', 'body').toFixed(1)}°`);
    assert.ok(r('hand_r', 'arm_r') >= 30, `glove waggle vs arm ${r('hand_r', 'arm_r').toFixed(1)}°`);
    assert.ok(r('arm_l', 'body') >= 8, `other arm ${r('arm_l', 'body').toFixed(1)}°`);
    const fine = await samplesFor(ANIMS[1], 72);
    assert.ok(range(fine.map((x) => x.pose.root.y)) >= 25, `hop height ${range(fine.map((x) => x.pose.root.y)).toFixed(1)}px`);
    assert.ok(range(fine.map((x) => rel(x.pose, 'leg_l', 'root'))) >= 5, 'leg kick during hop');
    assert.ok(new Set(s.map((x) => x.hash)).size >= 10, 'rendered frames differ across samples');
    // Art region of the waving glove changes between the down and raised poses.
    await gotoFrame(0, 72, 30);
    const down = await page.screenshot({ clip: await gloveClip() });
    await gotoFrame(24, 72, 30);
    const up = await page.screenshot({ clip: await gloveClip() });
    assert.notEqual(sha(down), sha(up), 'glove pixels differ between rest and wave');
    await page.getByTestId('stage').screenshot({ path: path.join(SHOTS, '20-greeting-f24.png') });
  });
});

async function gloveClip() {
  const a = (await probe<{ x: number; y: number }>(page, 'attachment', 'hand_r'))!;
  return { x: a.x - 60, y: a.y - 60, width: 120, height: 120 };
}

describe('loop continuity', () => {
  for (const anim of ANIMS) {
    it(`"${anim.name}": last frame equals first and no per-frame jump at the wrap`, async () => {
      await selectAnim(anim.name);
      const frames = Math.round(anim.duration * anim.fps);
      const poses: Record<string, World>[] = [];
      for (let f = 0; f <= frames; f++) {
        await gotoFrame(f, frames, anim.fps);
        poses.push(await poseAll());
      }
      for (const b of BONES) {
        near(poses[frames][b].x, poses[0][b].x, 1e-6, `${b} x at end == start`);
        near(poses[frames][b].y, poses[0][b].y, 1e-6, `${b} y at end == start`);
        near(wrapDeg(poses[frames][b].angle - poses[0][b].angle), 0, 1e-6, `${b} angle at end == start`);
      }
      // Per-frame motion of the glove joints: the step into the loop seam (frame N-1 → N,
      // which equals frame 0) must not be a jump compared with the motion inside the clip.
      const step = (i: number) => Math.max(...['hand_l', 'hand_r', 'root'].map((b) => Math.hypot(poses[i + 1][b].x - poses[i][b].x, poses[i + 1][b].y - poses[i][b].y)));
      const steps = Array.from({ length: frames }, (_, i) => step(i));
      const inner = Math.max(...steps.slice(0, -1));
      assert.ok(steps[frames - 1] <= inner + 1e-6, `wrap step ${steps[frames - 1].toFixed(3)} ≤ max inner step ${inner.toFixed(3)}`);
      assert.ok(inner < 40, `no frame-to-frame jump over 40 world px (max ${inner.toFixed(2)})`);
    });
  }
});

describe('editing the character project', () => {
  it('scrubs, keys a new arm pose in the inspector, sees it render, and undoes/redoes it exactly', async () => {
    await selectAnim('idle');
    await page.getByTestId('show-bones').check();
    await gotoFrame(20, 90, 30);
    const before = await project();
    const undo0 = (await state()).undo;
    await page.getByTestId('tree-bone-arm_l').click();
    const rot0 = Number(await page.getByTestId('bone-rotation').inputValue());
    const w0 = await world('arm_l');
    const h0 = await canvasHash();
    const input = page.getByTestId('bone-rotation');
    await input.fill(String(rot0 + 40));
    await input.press('Enter');
    const p1 = await project();
    const armId = p1.bones.find((b: any) => b.name === 'arm_l').id;
    const idle = p1.animations.find((a: any) => a.name === 'idle');
    const k = idle.tracks[armId].rotate.find((x: any) => Math.abs(x.time - 20 / 30) < 1e-9);
    assert.ok(k, 'key written at frame 20');
    near(k.value[0], rot0 + 40, 0.011, 'keyed value');
    assert.equal(await page.getByTestId('key-toggle-rotate').getAttribute('aria-pressed'), 'true');
    // World angle ≠ local delta exactly: the breathing body is scaled non-uniformly at frame 20.
    near(wrapDeg((await world('arm_l')).angle - w0.angle), 40, 0.5, 'arm turned by ~40° on canvas');
    assert.notEqual(await canvasHash(), h0, 'canvas re-rendered with the new pose');
    await page.getByTestId('stage').screenshot({ path: path.join(SHOTS, '30-edited-arm.png') });
    assert.equal((await state()).undo, undo0 + 1, 'one undo step');

    await page.getByTestId('undo').click();
    assert.deepEqual(await project(), before, 'undo restores the project exactly');
    near(wrapDeg((await world('arm_l')).angle - w0.angle), 0, 1e-9, 'arm back');
    await page.getByTestId('redo').click();
    assert.deepEqual(await project(), p1, 'redo re-applies the key');
    await page.getByTestId('undo').click();
    assert.deepEqual(await project(), before);
  });

  it('rotates the waving glove with a canvas drag (Rotate tool) as one undoable key', async () => {
    await selectAnim('greeting');
    await gotoFrame(24, 72, 30);
    await page.getByTestId('tree-bone-hand_r').click();
    await page.getByTestId('tool-rotate').click();
    const before = await project();
    const b = (await probe<{ origin: { x: number; y: number }; world: World }>(page, 'bone', 'hand_r'))!;
    // Drag on empty canvas well away from the art: the Rotate tool then acts on the selected bone.
    const r = 180;
    const a0 = (-30 * Math.PI) / 180;
    await page.mouse.move(b.origin.x + r * Math.cos(a0), b.origin.y + r * Math.sin(a0));
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      const a = a0 + ((-30 * i) / 10) * (Math.PI / 180);
      await page.mouse.move(b.origin.x + r * Math.cos(a), b.origin.y + r * Math.sin(a));
    }
    await page.mouse.up();
    const after = await world('hand_r');
    near(wrapDeg(after.angle - b.world.angle), -30, 2, 'glove rotated about its wrist by the drag');
    await page.getByTestId('stage').screenshot({ path: path.join(SHOTS, '31-glove-drag.png') });
    await page.getByTestId('undo').click();
    assert.deepEqual(await project(), before, 'single undo restores the drag');
    await page.getByTestId('tool-move').click();
  });
});

describe('save / reload integrity', () => {
  it('Save downloads the same project, which reopens identically in a fresh page', async () => {
    const dl = page.waitForEvent('download');
    await page.getByTestId('save-project').click();
    const file = path.join(SHOTS, 'resaved-wiz.rig.json');
    await (await dl).saveAs(file);
    const resaved = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(resaved, original, 'after undoing all edits the saved file equals the original project');
    await openProject(file);
    assert.deepEqual(await project(), original, 'reopened project is identical, incl. embedded image bytes');
    await selectAnim('greeting');
    await page.getByTestId('play').click();
    await page.waitForTimeout(500);
    assert.ok((await state()).playing, 'reopened project plays');
    await page.getByTestId('play').click();
  });

  it('raised no uncaught page errors', () => {
    assert.deepEqual(pageErrors, []);
  });
});
