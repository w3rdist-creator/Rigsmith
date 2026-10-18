// Browser interaction checks against the production build in an isolated, headless
// Chrome for Testing profile. Every action goes through visible UI controls (buttons,
// inputs, canvas mouse drags, keyboard). window.__rigsmith is read-only and only used
// to read model state and screen coordinates for assertions.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';
import { makePng } from './png.ts';

const SHOTS = path.join(EVIDENCE, 'e2e');
mkdirSync(SHOTS, { recursive: true });

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let base: string;
const pageErrors: string[] = [];

type State = { mode: string; time: number; playing: boolean; selection: { kind: string; id: string } | null; undo: number; redo: number };
type BoneScreen = { origin: { x: number; y: number }; tip: { x: number; y: number }; mid: { x: number; y: number }; world: { x: number; y: number; angle: number } };

const state = () => probe<State>(page, 'state');
const project = () => probe<any>(page, 'project');
const bone = async (name: string) => {
  const b = await probe<BoneScreen | null>(page, 'bone', name);
  assert.ok(b, `bone ${name} exists`);
  return b!;
};
const shot = (name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const near = (a: number, b: number, eps: number, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${a} ≈ ${b} (±${eps})`);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function freshPage(): Promise<void> {
  if (page) await page.close();
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(base);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 8): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

async function fill(testId: string, value: string): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(value);
  await el.press('Enter');
}

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  base = `http://127.0.0.1:${port}/`;
  server = await startPreview(port);
  ctx = await launchIsolated('e2e');
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('demo playback', () => {
  it('loads the built-in demo and animates joints over time', async () => {
    await freshPage();
    await shot('00-empty-state');
    await page.getByTestId('empty-demo').click();
    await page.waitForFunction(() => (window as any).__rigsmith.state().playing === true);
    const s = await state();
    assert.equal(s.mode, 'animate');
    const p = await project();
    assert.equal(p.bones.length, 12);
    assert.equal(p.attachments.length, 11);

    const a = await bone('forearm-front');
    const t1 = (await state()).time;
    const img1 = await page.getByTestId('stage').screenshot({ path: path.join(SHOTS, '01-demo-frame-a.png') });
    await page.waitForTimeout(330);
    const b = await bone('forearm-front');
    const t2 = (await state()).time;
    const img2 = await page.getByTestId('stage').screenshot({ path: path.join(SHOTS, '02-demo-frame-b.png') });
    const moved = Math.hypot(a.world.x - b.world.x, a.world.y - b.world.y) + Math.abs(a.world.angle - b.world.angle);
    assert.notEqual(t1, t2, 'playhead advances');
    assert.ok(moved > 2, `forearm joint moved (${moved.toFixed(2)})`);
    assert.notEqual(sha(img1.toString('base64')), sha(img2.toString('base64')), 'rendered pixels differ between frames');

    // Loop: after more than one full duration (1s) we are still playing.
    await page.waitForTimeout(1200);
    assert.equal((await state()).playing, true, 'looping animation keeps playing past its duration');

    await page.getByTestId('play').click();
    const paused = (await state()).time;
    await page.waitForTimeout(250);
    assert.equal((await state()).playing, false);
    assert.equal((await state()).time, paused, 'paused playhead holds still');
    near(paused * 30, Math.round(paused * 30), 1e-9, 'pausing lands on a whole frame');

    // Regression (found by the REA scenario): an inspector edit right after pausing must
    // show exactly the typed value, because the key goes to the frame being displayed.
    await page.getByTestId('tree-bone-forearm-front').click();
    await fill('bone-rotation', '30');
    assert.equal(await page.getByTestId('bone-rotation').inputValue(), '30');
    assert.equal(await page.getByTestId('key-toggle-rotate').getAttribute('aria-pressed'), 'true');
    await shot('03-demo-paused');
  });
});

describe('rigging from scratch: bones, images, attachments', () => {
  it('creates a bone and a child bone with the Bone tool; parent options prevent cycles', async () => {
    await freshPage();
    await page.getByTestId('tool-create').click();
    const box = (await page.getByTestId('stage').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await drag({ x: cx - 120, y: cy }, { x: cx, y: cy });
    let p = await project();
    assert.equal(p.bones.length, 1);
    const b1 = p.bones[0];
    near(b1.length, 120, 2, 'root bone length');
    near(b1.rotation, 0, 1, 'root bone rotation');
    // Second drag creates a child of the selected bone, pointing down.
    await drag({ x: cx, y: cy }, { x: cx, y: cy + 80 });
    p = await project();
    assert.equal(p.bones.length, 2);
    const b2 = p.bones[1];
    assert.equal(b2.parentId, b1.id, 'new bone is a child of the selected bone');
    near(b2.rotation, 90, 1, 'child rotation relative to parent');
    near(b2.x, 120, 2, 'child origin sits at parent tip (parent space)');

    // Rename via inspector.
    await fill('bone-name', 'forearm');
    await page.getByTestId('tree-bone-bone').click();
    await fill('bone-name', 'upperarm');
    p = await project();
    assert.deepEqual(p.bones.map((b: any) => b.name), ['upperarm', 'forearm']);

    // Cycle prevention: the parent dropdown for "upperarm" must not offer its child.
    const options = await page.getByTestId('bone-parent').locator('option').allTextContents();
    assert.ok(!options.includes('forearm'), `descendant excluded from parent options: ${options.join(', ')}`);
    assert.ok(!options.includes('upperarm'), 'self excluded from parent options');
    await shot('10-two-bones');
  });

  it('posing a parent moves the child (composed transforms) at the correct screen location', async () => {
    await page.getByTestId('tool-rotate').click();
    const up = await bone('upperarm');
    const fa0 = await bone('forearm');
    // Rotate upperarm by +90° about its origin: grab its middle (the tip is shared with the
    // child's joint) and sweep a quarter circle clockwise on screen.
    const r = Math.hypot(up.tip.x - up.origin.x, up.tip.y - up.origin.y);
    await page.mouse.move(up.mid.x, up.mid.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      const a = ((90 * i) / 12) * (Math.PI / 180);
      await page.mouse.move(up.origin.x + (r / 2) * Math.cos(a), up.origin.y + (r / 2) * Math.sin(a));
    }
    await page.mouse.up();
    const p = await project();
    near(p.bones[0].rotation, 90, 1.5, 'parent rotated via canvas drag');
    const fa1 = await bone('forearm');
    // Child origin now sits straight below the parent's origin by the parent length.
    near(fa1.origin.x, up.origin.x, 3, 'child x follows parent rotation');
    near(fa1.origin.y, up.origin.y + r, 3, 'child y follows parent rotation');
    near(fa1.world.angle, 180, 1.5, 'child world angle = parent 90 + local 90');
    assert.notDeepEqual(fa0.origin, fa1.origin);

    // Move tool: drag the child joint to the cursor; it must land where released.
    await page.getByTestId('tool-move').click();
    const target = { x: fa1.origin.x + 40, y: fa1.origin.y + 25 };
    await drag(fa1.mid, { x: fa1.mid.x + 40, y: fa1.mid.y + 25 });
    const fa2 = await bone('forearm');
    near(fa2.origin.x, target.x, 2, 'dragged joint x lands under cursor (rotated parent)');
    near(fa2.origin.y, target.y, 2, 'dragged joint y lands under cursor (rotated parent)');
    await shot('11-posed');
  });

  it('imports a local image, attaches it to a bone and edits the offset', async () => {
    const png = makePng(48, 28, [80, 180, 240]);
    writeFileSync(path.join(SHOTS, 'test-part.png'), png);
    await page.getByTestId('image-input').setInputFiles({ name: 'test-part.png', mimeType: 'image/png', buffer: png });
    await page.getByTestId('image-test-part.png').waitFor();
    let p = await project();
    assert.equal(p.images.length, 1);
    assert.equal(p.images[0].width, 48);
    assert.equal(p.images[0].height, 28);

    // Reject a non-image file with a visible error.
    await page.getByTestId('image-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await page.getByTestId('error-toast').first().waitFor();
    assert.equal((await project()).images.length, 1, 'non-image rejected');

    await page.getByTestId('tree-bone-forearm').click();
    await page.getByTestId('attach-test-part.png').click();
    p = await project();
    assert.equal(p.attachments.length, 1);
    const att = p.attachments[0];
    const forearm = p.bones.find((b: any) => b.name === 'forearm');
    assert.equal(att.boneId, forearm.id, 'attached to the selected bone');
    near(att.x, forearm.length / 2, 0.01, 'attachment centred along bone');
    assert.equal((await state()).selection?.kind, 'attachment');

    await fill('att-x', '12');
    await fill('att-y', '-6');
    await fill('att-rotation', '15');
    p = await project();
    assert.equal(p.attachments[0].x, 12);
    assert.equal(p.attachments[0].y, -6);
    assert.equal(p.attachments[0].rotation, 15);

    // Drag the art itself on the canvas (selectable art) — offset changes, bone stays.
    const a0 = (await probe<{ x: number; y: number }>(page, 'attachment', att.name))!;
    await drag(a0, { x: a0.x + 30, y: a0.y });
    const a1 = (await probe<{ x: number; y: number }>(page, 'attachment', att.name))!;
    near(a1.x, a0.x + 30, 2, 'attachment follows the mouse');
    p = await project();
    assert.notEqual(p.attachments[0].x, 12, 'offset updated by drag');
    assert.equal(p.attachments[0].boneId, forearm.id);

    // Attachment follows its bone when the bone is posed.
    await page.getByTestId('tree-bone-forearm').click();
    await fill('bone-rotation', '45');
    const a2 = (await probe<{ x: number; y: number }>(page, 'attachment', att.name))!;
    assert.ok(Math.hypot(a2.x - a1.x, a2.y - a1.y) > 5, 'attachment moved with its bone');
    await shot('12-image-attached');
  });
});

describe('timeline keys, scrubbing, interpolation, duration/FPS', () => {
  it('creates an animation, keys poses at two frames and interpolates while scrubbing', async () => {
    await page.getByTestId('new-animation').click();
    let s = await state();
    assert.equal(s.mode, 'animate');
    await page.getByTestId('tree-bone-forearm').click();
    // Frame 0: key all channels with K.
    await page.getByTestId('stage').focus();
    await page.keyboard.press('k');
    await page.getByTestId('key-forearm-rotate-0').waitFor();
    let p = await project();
    const track = () => p.animations[0].tracks[p.bones.find((b: any) => b.name === 'forearm').id];
    assert.deepEqual(track().rotate.map((k: any) => k.time), [0]);
    assert.equal(track().translate.length, 1);
    assert.equal(track().scale.length, 1);
    const rot0 = track().rotate[0].value[0];

    // Scrub to frame 15 by clicking the ruler at the middle.
    const ruler = (await page.getByTestId('timeline-ruler').boundingBox())!;
    await page.mouse.click(ruler.x + ruler.width * 0.5, ruler.y + ruler.height / 2);
    s = await state();
    near(s.time, 0.5, 1e-6, 'scrubbed to 0.5s');
    assert.match((await page.getByTestId('time-readout').textContent()) ?? '', /15 \/ 30/);

    // Pose in animate mode via the inspector → writes a rotate key at frame 15.
    await fill('bone-rotation', String(rot0 + 90));
    await page.getByTestId('key-forearm-rotate-15').waitFor();
    p = await project();
    assert.deepEqual(track().rotate.map((k: any) => k.time), [0, 0.5]);
    assert.equal(track().rotate[1].value[0], rot0 + 90);
    assert.equal(p.bones.find((b: any) => b.name === 'forearm').rotation, rot0, 'setup pose untouched by keying');

    // Pose on the canvas at frame 30 with the rotate tool → key at 1.0s.
    await page.mouse.click(ruler.x + ruler.width - 1, ruler.y + ruler.height / 2);
    near((await state()).time, 1, 1e-6);
    await page.getByTestId('tool-rotate').click();
    const fb = await bone('forearm');
    const rr = Math.hypot(fb.tip.x - fb.origin.x, fb.tip.y - fb.origin.y) * 0.6;
    const start = Math.atan2(fb.tip.y - fb.origin.y, fb.tip.x - fb.origin.x);
    await page.mouse.move(fb.origin.x + rr * Math.cos(start), fb.origin.y + rr * Math.sin(start));
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      const a = start - ((30 * i) / 6) * (Math.PI / 180);
      await page.mouse.move(fb.origin.x + rr * Math.cos(a), fb.origin.y + rr * Math.sin(a));
    }
    await page.mouse.up();
    await page.getByTestId('key-forearm-rotate-30').waitFor();
    p = await project();
    near(track().rotate[2].value[0], rot0 + 90 - 30, 1.5, 'canvas rotate keyed at frame 30');

    // Scrub through the middle: linear interpolation between frame 0 and 15 keys.
    const angleAt = async (frac: number) => {
      await page.mouse.click(ruler.x + ruler.width * frac, ruler.y + ruler.height / 2);
      return (await bone('forearm')).world.angle;
    };
    const parentAngle = (await bone('upperarm')).world.angle;
    const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
    const local = (world: number, expected: number) => wrap(world - parentAngle - expected);
    near(local(await angleAt(0), rot0), 0, 0.5, 'frame 0 pose');
    near(local(await angleAt(0.5), rot0 + 90), 0, 0.5, 'frame 15 pose');
    near((await state()).time, 0.5, 1e-6);
    const at6 = await angleAt(0.2); // frame 6 = 0.2s
    near((await state()).time, 0.2, 1e-6, 'scrub snapped to frame 6');
    near(local(at6, rot0 + 90 * (0.2 / 0.5)), 0, 0.6, 'linear in-between at frame 6');
    await shot('20-keys-and-scrub');

    // Step interpolation on the frame-0 key holds the pose until frame 15.
    await page.getByTestId('key-forearm-rotate-0').click();
    await page.getByTestId('key-interp').selectOption('step');
    p = await project();
    assert.equal(track().rotate[0].interp, 'step');
    near(local(await angleAt(0.2), rot0), 0, 0.5, 'step key holds');
  });

  it('duration and FPS controls retime the frame grid without moving keys in seconds', async () => {
    await fill('anim-fps', '12');
    let p = await project();
    assert.equal(p.animations[0].fps, 12);
    await page.getByTestId('key-forearm-rotate-6').waitFor(); // 0.5s @ 12fps
    assert.match((await page.getByTestId('time-readout').textContent()) ?? '', /\/ 12/);
    await fill('anim-duration', '2');
    p = await project();
    assert.equal(p.animations[0].duration, 2);
    assert.match((await page.getByTestId('time-readout').textContent()) ?? '', /\/ 24/);
    await fill('anim-fps', '30');
    await fill('anim-duration', '1');

    // Playback of the user-made animation loops and moves the posed bone.
    await page.getByTestId('play').click();
    const angles = new Set<number>();
    for (let i = 0; i < 12; i++) {
      angles.add(Math.round((await bone('forearm')).world.angle));
      await page.waitForTimeout(100);
    }
    assert.ok((await state()).playing, 'still playing after > 1 loop');
    assert.ok(angles.size >= 3, `user-made animation plays (${[...angles].join(', ')})`);
    await page.getByTestId('play').click();
  });
});

describe('undo / redo', () => {
  it('undoes and redoes inspector edits, canvas drags (one step per drag) and imports', async () => {
    await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-bone-upperarm').click();
    const before = (await project()).bones[0].x;
    const undo0 = (await state()).undo;
    await fill('bone-x', String(before + 33));
    assert.equal((await project()).bones[0].x, before + 33);
    await page.getByTestId('undo').click();
    assert.equal((await project()).bones[0].x, before, 'undo button restores');
    await page.getByTestId('redo').click();
    assert.equal((await project()).bones[0].x, before + 33, 'redo button re-applies');
    await page.getByTestId('stage').focus();
    await page.keyboard.press('ControlOrMeta+z');
    assert.equal((await project()).bones[0].x, before, 'Ctrl/⌘+Z undoes');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    assert.equal((await project()).bones[0].x, before + 33, 'Ctrl/⌘+Shift+Z redoes');

    // A multi-step canvas drag is one undo entry.
    await page.getByTestId('tool-move').click();
    const u = await bone('upperarm');
    const undoBefore = (await state()).undo;
    await drag(u.mid, { x: u.mid.x + 60, y: u.mid.y - 20 }, 15);
    assert.equal((await state()).undo, undoBefore + 1, 'one drag = one undo step');
    const movedX = (await project()).bones[0].x;
    assert.notEqual(movedX, before + 33);
    await page.keyboard.press('ControlOrMeta+z');
    assert.equal((await project()).bones[0].x, before + 33, 'drag undone in one step');

    // Undo a key deletion and an image import.
    await page.getByTestId('key-forearm-rotate-15').click();
    await page.keyboard.press('Delete');
    const fId = (await project()).bones.find((b: any) => b.name === 'forearm').id;
    assert.equal((await project()).animations[0].tracks[fId].rotate.length, 2, 'key deleted');
    await page.keyboard.press('ControlOrMeta+z');
    assert.equal((await project()).animations[0].tracks[fId].rotate.length, 3, 'key restored by undo');

    const png = makePng(20, 20, [240, 120, 60]);
    await page.getByTestId('image-input').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: png });
    await page.getByTestId('image-second.png').waitFor();
    assert.equal((await project()).images.length, 2);
    await page.getByTestId('stage').focus();
    await page.keyboard.press('ControlOrMeta+z');
    assert.equal((await project()).images.length, 1, 'import undone');
    await page.keyboard.press('ControlOrMeta+y');
    assert.equal((await project()).images.length, 2, 'import redone (Ctrl+Y)');
    assert.ok((await state()).undo > undo0);
    await shot('30-after-undo-redo');
  });
});

describe('save / load roundtrip', () => {
  let savedPath = '';
  let savedProject: any;

  it('downloads a project file with embedded images', async () => {
    savedProject = await project();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('save-project').click()]);
    assert.match(dl.suggestedFilename(), /\.rig\.json$/);
    savedPath = path.join(EVIDENCE, 'downloads', `roundtrip-${dl.suggestedFilename()}`);
    await dl.saveAs(savedPath);
    const onDisk = JSON.parse(readFileSync(savedPath, 'utf8'));
    assert.equal(onDisk.format, 'rigsmith.project');
    assert.equal(onDisk.version, 1);
    assert.match(onDisk.images[0].dataUrl, /^data:image\/png;base64,/);
  });

  it('reloads the page, opens the file and gets the identical project back (incl. image bytes)', async () => {
    await freshPage();
    assert.equal((await project()).bones.length, 0, 'fresh page is empty');
    await page.getByTestId('open-input').setInputFiles(savedPath);
    await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length > 0);
    const loaded = await project();
    assert.deepEqual(loaded, savedProject, 'project equal after roundtrip');
    assert.equal(sha(loaded.images[0].dataUrl), sha(savedProject.images[0].dataUrl), 'image bytes identical');
    // The image actually renders (decoded) — attachment visible in the tree and art on canvas.
    await page.getByTestId('tree-att-test-part').waitFor();
    const fId = loaded.bones.find((b: any) => b.name === 'forearm').id;
    assert.deepEqual(loaded.animations[0].tracks[fId].rotate.map((k: any) => k.time), [0, 0.5, 1]);
    await shot('40-reloaded');
  });

  it('rejects an invalid project with a visible error and keeps the current one', async () => {
    const broken = JSON.parse(readFileSync(savedPath, 'utf8'));
    broken.bones[0].parentId = broken.bones[1].id; // introduce a cycle
    const badPath = path.join(EVIDENCE, 'downloads', 'invalid-cycle.rig.json');
    writeFileSync(badPath, JSON.stringify(broken));
    const before = await project();
    await page.getByTestId('open-input').setInputFiles(badPath);
    const toast = page.getByTestId('error-toast').last();
    await toast.waitFor();
    assert.match((await toast.textContent()) ?? '', /cycle/i);
    assert.deepEqual(await project(), before, 'current project untouched');
    await shot('41-invalid-file-error');
  });

  it('saves to browser storage and restores after reload', async () => {
    await page.getByTestId('save-browser').click();
    const before = await project();
    await page.reload();
    await page.getByTestId('restore-browser').click();
    await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length > 0);
    assert.deepEqual(await project(), before);
  });

  it('exports runtime animation data and a PNG frame', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-runtime').click()]);
    const p = path.join(EVIDENCE, 'downloads', dl.suggestedFilename());
    await dl.saveAs(p);
    const rt = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(rt.format, 'rigsmith.runtime');
    assert.equal(rt.animations[0].frames, 30);
    assert.equal(rt.animations[0].baked.forearm.length, 30);
    const [png] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-png').click()]);
    const pp = path.join(EVIDENCE, 'downloads', png.suggestedFilename());
    await png.saveAs(pp);
    const bytes = readFileSync(pp);
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');
  });
});

describe('view navigation and remaining tools', () => {
  it('wheel zooms around the cursor, middle-drag pans, Fit frames everything', async () => {
    await page.getByTestId('frame-all').click();
    const b0 = await bone('upperarm');
    const at = b0.mid;
    const w0 = await probe<{ x: number; y: number }>(page, 'worldAt', at.x, at.y);
    const len0 = Math.hypot(b0.tip.x - b0.origin.x, b0.tip.y - b0.origin.y);
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(50);
    const w1 = await probe<{ x: number; y: number }>(page, 'worldAt', at.x, at.y);
    const b1 = await bone('upperarm');
    near(w1.x, w0.x, 0.5, 'world point under cursor stays put (x)');
    near(w1.y, w0.y, 0.5, 'world point under cursor stays put (y)');
    assert.ok(Math.hypot(b1.tip.x - b1.origin.x, b1.tip.y - b1.origin.y) > len0 * 1.2, 'zoomed in');

    // Middle-button drag pans the view without touching the model.
    const stage = (await page.getByTestId('stage').boundingBox())!;
    const start = { x: stage.x + 30, y: stage.y + stage.height - 40 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(start.x + 50, start.y - 30, { steps: 5 });
    await page.mouse.up({ button: 'middle' });
    const b2 = await bone('upperarm');
    near(b2.origin.x, b1.origin.x + 50, 1, 'pan x');
    near(b2.origin.y, b1.origin.y - 30, 1, 'pan y');
    near(b2.world.x, b1.world.x, 1e-9, 'pan does not move the bone in world space');

    await page.getByTestId('frame-all').click();
    for (const name of ['upperarm', 'forearm']) {
      const b = await bone(name);
      for (const p of [b.origin, b.tip]) {
        assert.ok(p.x >= stage.x && p.x <= stage.x + stage.width && p.y >= stage.y && p.y <= stage.y + stage.height, `${name} inside stage after Fit`);
      }
    }
    await shot('50-fit');
  });

  it('Scale tool drag scales the selected bone (setup mode)', async () => {
    await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-bone-upperarm').click();
    await page.getByTestId('tool-scale').click();
    const b = await bone('upperarm');
    const dir = { x: b.tip.x - b.origin.x, y: b.tip.y - b.origin.y };
    const from = { x: b.origin.x + dir.x * 0.5, y: b.origin.y + dir.y * 0.5 };
    const to = { x: b.origin.x + dir.x * 0.75, y: b.origin.y + dir.y * 0.75 };
    const s0 = (await project()).bones[0];
    await drag(from, to);
    const s1 = (await project()).bones[0];
    near(s1.scaleX, s0.scaleX * 1.5, 0.05, 'scaleX ×1.5');
    near(s1.scaleY, s0.scaleY * 1.5, 0.05, 'scaleY ×1.5');
    await page.getByTestId('tool-move').click();
  });

  it('dragging a key diamond retimes it as one undo step', async () => {
    const fId = (await project()).bones.find((b: any) => b.name === 'forearm').id;
    const diamond = page.getByTestId('key-forearm-rotate-15');
    const box = (await diamond.boundingBox())!;
    const lanes = (await page.getByTestId('timeline-lanes').boundingBox())!;
    const undo0 = (await state()).undo;
    await drag({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: lanes.x + lanes.width * (20 / 30), y: box.y + box.height / 2 }, 6);
    await page.getByTestId('key-forearm-rotate-20').waitFor();
    const times = (await project()).animations[0].tracks[fId].rotate.map((k: any) => k.time);
    near(times[1], 20 / 30, 1e-9, 'key moved to frame 20');
    assert.equal(times.length, 3);
    assert.equal((await state()).undo, undo0 + 1, 'retime is one undo step');
  });

  it('renames, adds and deletes animations', async () => {
    await fill('anim-name', 'swing');
    assert.equal((await project()).animations[0].name, 'swing');
    await page.getByTestId('new-animation').click();
    assert.equal((await project()).animations.length, 2);
    await page.getByRole('button', { name: 'Delete animation' }).click();
    const p = await project();
    assert.deepEqual(p.animations.map((a: any) => a.name), ['swing']);
  });

  it('imports an image dropped onto the canvas', async () => {
    const before = (await project()).images.length;
    const b64 = makePng(16, 16, [120, 220, 90]).toString('base64');
    // Playwright cannot perform an OS-level file drag, so the drop event (with a real
    // DataTransfer carrying a File) is dispatched on the canvas, as the browser would.
    await page.evaluate((data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
      const canvas = document.querySelector('[data-testid="stage"]')!;
      canvas.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      canvas.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, b64);
    await page.getByTestId('image-dropped.png').waitFor();
    assert.equal((await project()).images.length, before + 1);
  });

  it('shows the controls help dialog', async () => {
    await page.getByTestId('help').click();
    const dlg = page.getByTestId('help-dialog');
    await dlg.waitFor({ state: 'visible' });
    assert.ok((await dlg.locator('tr').count()) >= 10);
    assert.match((await dlg.textContent()) ?? '', /Undo/);
    await shot('51-help');
    await dlg.getByRole('button', { name: 'Close' }).click();
    await dlg.waitFor({ state: 'hidden' });
  });
});

describe('inspector number fields', () => {
  // Regression (found by the Wiz acceptance test): a value shown rounded ("1" for a real
  // 0.995) could not be set to the displayed number — no change event, edit silently lost.
  it('commits a typed value equal to the rounded display when the real value differs', async () => {
    await freshPage();
    await page.getByTestId('add-bone').click();
    await fill('bone-scale-y', '0.995');
    assert.equal(await page.getByTestId('bone-scale-y').inputValue(), '1', 'display is rounded');
    assert.equal((await project()).bones[0].scaleY, 0.995);
    const undo0 = (await state()).undo;
    await fill('bone-scale-y', '1');
    assert.equal((await project()).bones[0].scaleY, 1, 'typed 1 is committed');
    assert.equal((await state()).undo, undo0 + 1, 'exactly one undo step (no double commit)');
    // Re-entering the true value is still a no-op.
    await fill('bone-scale-y', '1');
    assert.equal((await state()).undo, undo0 + 1, 'unchanged value adds no undo step');
  });
});

describe('page health', () => {
  it('raised no uncaught page errors', () => {
    assert.deepEqual(pageErrors, []);
  });
});
