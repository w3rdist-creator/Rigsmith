// Phase 1 browser checks: curve editor, multi-key timeline editing, onion skin.
// Every action goes through visible controls; window.__rigsmith is read-only.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const SHOTS = path.join(EVIDENCE, 'roadmap/p1');
mkdirSync(SHOTS, { recursive: true });

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let base: string;
const pageErrors: string[] = [];

type KeyRef = { lane: string; time: number };
type State = { mode: string; time: number; undo: number; redo: number; keySels: KeyRef[]; keySel: KeyRef | null; onion: { enabled: boolean; before: number; after: number; step: number } };
const state = () => probe<State>(page, 'state');
const project = () => probe<any>(page, 'project');
const near = (a: number, b: number, eps: number, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${a} ≈ ${b} (±${eps})`);
const shot = (name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const boneId = async (name: string) => (await project()).bones.find((b: any) => b.name === name).id as string;
const walk = async () => (await project()).animations.find((a: any) => a.name === 'walk');

async function freshDemo(): Promise<void> {
  if (page) await page.close();
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(base);
  await page.getByTestId('empty-demo').click();
  await page.waitForFunction(() => (window as any).__rigsmith.state().playing === true);
  await page.getByTestId('play').click();
}

async function gotoFrame(frame: number, frames = 30): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
}

async function rotationAt(frames: number[]): Promise<number[]> {
  const out: number[] = [];
  for (const f of frames) {
    await gotoFrame(f);
    out.push(Number(await page.getByTestId('bone-rotation').inputValue()));
  }
  return out;
}

async function keyCenter(testId: string): Promise<{ x: number; y: number }> {
  const b = (await page.getByTestId(testId).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function laneX(frame: number, frames = 30): Promise<number> {
  const lanes = (await page.getByTestId('timeline-lanes').boundingBox())!;
  return lanes.x + (lanes.width * frame) / frames;
}

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  base = `http://127.0.0.1:${port}/`;
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-p1-motion');
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('curve editor', () => {
  it('overshoot preset samples past the next key; linear stays inside; one undo step each', async () => {
    await freshDemo();
    await page.getByTestId('tree-bone-thigh-front').click();
    await page.getByTestId('key-thigh-front-rotate-0').click();
    assert.match(await page.getByTestId('curve-segment').textContent() ?? '', /thigh-front rotate · f0→f15/);
    const undo0 = (await state()).undo;
    await page.getByTestId('curve-preset').selectOption('overshoot');
    assert.equal((await state()).undo, undo0 + 1, 'preset = one undo step');
    const tid = await boneId('thigh-front');
    const k0 = (await walk()).tracks[tid].rotate[0];
    assert.equal(k0.interp, 'bezier');
    assert.deepEqual(k0.curve, [0.3, 0, 0.35, 1.45]);
    // The segment runs 62° → 118°: overshoot must exceed 118 between the keys.
    const over = await rotationAt([4, 6, 8, 10, 12, 14]);
    assert.ok(Math.max(...over) > 118.5, `overshoot peak ${Math.max(...over)} > 118`);
    await shot('curve-overshoot');
    await page.getByTestId('key-thigh-front-rotate-0').click();
    await page.getByTestId('key-interp').selectOption('linear');
    const lin = await rotationAt([4, 6, 8, 10, 12, 14]);
    assert.ok(Math.max(...lin) <= 118 && Math.min(...lin) >= 62, `linear stays within 62..118 (${lin.join(', ')})`);
    near(lin[2], 62 + (118 - 62) * (8 / 15), 0.01, 'linear value at frame 8');
  });

  it('dragging a curve handle reshapes the easing as one undo step; Esc mid-drag cancels', async () => {
    await page.getByTestId('key-thigh-front-rotate-0').click();
    await page.getByTestId('curve-preset').selectOption('ease-in-out');
    const tid = await boneId('thigh-front');
    const before = (await walk()).tracks[tid].rotate[0].curve;
    const [mid0] = await rotationAt([7]);
    await page.getByTestId('key-thigh-front-rotate-0').click();
    const canvas = page.getByTestId('curve-editor');
    const cb = (await canvas.boundingBox())!;
    const [hx, hy] = (await canvas.getAttribute('data-h2'))!.split(',').map(Number);
    const undo0 = (await state()).undo;
    await page.mouse.move(cb.x + hx, cb.y + hy);
    await page.mouse.down();
    await page.mouse.move(cb.x + hx - 10, cb.y + hy - 30, { steps: 6 });
    await page.mouse.up();
    const afterDrag = (await walk()).tracks[tid].rotate[0].curve;
    assert.ok(afterDrag[3] > before[3] + 0.2, `handle y2 raised (${before[3]} → ${afterDrag[3]})`);
    assert.ok(afterDrag[2] < before[2], 'handle x2 moved left');
    assert.equal((await state()).undo, undo0 + 1, 'handle drag = one undo step');
    const [mid1] = await rotationAt([7]);
    assert.ok(mid1 > mid0 + 1, `sampled value changed (${mid0} → ${mid1})`);
    await shot('curve-handle-dragged');

    // Esc during a handle drag restores the curve and records nothing.
    await page.getByTestId('key-thigh-front-rotate-0').click();
    const [gx, gy] = (await canvas.getAttribute('data-h1'))!.split(',').map(Number);
    const cb2 = (await canvas.boundingBox())!;
    await page.mouse.move(cb2.x + gx, cb2.y + gy);
    await page.mouse.down();
    await page.mouse.move(cb2.x + gx + 20, cb2.y + gy - 40, { steps: 5 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.deepEqual((await walk()).tracks[tid].rotate[0].curve, afterDrag, 'curve restored');
    assert.equal((await state()).undo, undo0 + 1, 'no history entry for the cancelled drag');

    await page.getByTestId('undo').click();
    assert.deepEqual((await walk()).tracks[tid].rotate[0].curve, before, 'undo restores the pre-drag curve');
  });

  it('numeric handle fields edit the curve exactly', async () => {
    await page.getByTestId('key-thigh-front-rotate-0').click();
    const y2 = page.getByTestId('curve-y2');
    await y2.fill('1.3');
    await y2.press('Enter');
    const tid = await boneId('thigh-front');
    assert.equal((await walk()).tracks[tid].rotate[0].curve[3], 1.3);
  });
});

describe('multi-key timeline editing', () => {
  it('shift-click builds a multi-selection; dragging one key moves the group as one undo step', async () => {
    await freshDemo();
    await page.getByTestId('tree-bone-thigh-front').click();
    await page.getByTestId('key-thigh-front-rotate-15').click();
    await page.getByTestId('key-thigh-back-rotate-15').click({ modifiers: ['Shift'] });
    assert.equal((await state()).keySels.length, 2);
    assert.match(await page.getByTestId('key-sel-count').textContent() ?? '', /2 keys selected/);
    const undo0 = (await state()).undo;
    const from = await keyCenter('key-thigh-front-rotate-15');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(await laneX(18), from.y, { steps: 6 });
    await page.mouse.up();
    const a = await walk();
    const [tf, tb] = [await boneId('thigh-front'), await boneId('thigh-back')];
    assert.deepEqual(a.tracks[tf].rotate.map((k: any) => Math.round(k.time * 30)), [0, 18, 30]);
    assert.deepEqual(a.tracks[tb].rotate.map((k: any) => Math.round(k.time * 30)), [0, 18, 30]);
    assert.equal(a.tracks[tf].rotate[1].time, 18 / 30, 'exactly on the frame grid');
    assert.equal((await state()).undo, undo0 + 1, 'group drag = one undo step');
    assert.equal((await state()).keySels.length, 2, 'selection follows the moved keys');
    await shot('group-drag');
    await page.getByTestId('undo').click();
    assert.deepEqual((await walk()).tracks[tf].rotate.map((k: any) => Math.round(k.time * 30)), [0, 15, 30]);
    // Regression: a plain click (no drag) on a key inside a multi-selection selects only it,
    // so a following curve/interp change cannot silently hit the other keys.
    await page.getByTestId('key-thigh-front-rotate-15').click();
    await page.getByTestId('key-thigh-back-rotate-15').click({ modifiers: ['Shift'] });
    assert.equal((await state()).keySels.length, 2);
    await page.getByTestId('key-thigh-back-rotate-15').click();
    assert.equal((await state()).keySels.length, 1, 'plain click collapses the selection');
    assert.equal((await state()).keySel!.lane, `b:${tb}:rotate`);
  });

  it('Esc during a group drag restores everything and records no history', async () => {
    await page.getByTestId('key-thigh-front-rotate-15').click();
    await page.getByTestId('key-thigh-back-rotate-15').click({ modifiers: ['Shift'] });
    const before = await project();
    const undo0 = (await state()).undo;
    const from = await keyCenter('key-thigh-front-rotate-15');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(await laneX(24), from.y, { steps: 6 });
    assert.notDeepEqual(await project(), before, 'keys move live during the drag');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.deepEqual(await project(), before, 'Esc restores the pre-drag project');
    assert.equal((await state()).undo, undo0);
  });

  it('collision policy: a dragged key replaces the key it is dropped on', async () => {
    await page.getByTestId('key-thigh-front-rotate-15').click();
    const tf = await boneId('thigh-front');
    const moving = (await walk()).tracks[tf].rotate[1].value[0];
    const from = await keyCenter('key-thigh-front-rotate-15');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((await laneX(30)) - 1, from.y, { steps: 8 });
    await page.mouse.up();
    const keys = (await walk()).tracks[tf].rotate;
    assert.deepEqual(keys.map((k: any) => Math.round(k.time * 30)), [0, 30]);
    assert.equal(keys[1].value[0], moving, 'the moved key won');
    await page.getByTestId('undo').click();
  });

  it('shift-drag on the lanes box-selects keys', async () => {
    await page.getByTestId('tree-bone-thigh-front').click();
    const a = await keyCenter('key-forearm-back-rotate-15');
    const b = await keyCenter('key-thigh-back-rotate-15');
    await page.keyboard.down('Shift');
    await page.mouse.move(a.x - 12, a.y - 8);
    await page.mouse.down();
    await page.mouse.move(b.x + 12, b.y + 8, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    const sel = (await state()).keySels;
    assert.ok(sel.length >= 3, `box selected ${sel.length} keys`);
    assert.ok(sel.every((r) => Math.round(r.time * 30) === 15), 'only frame-15 keys');
    await shot('marquee');
  });

  it('copy/paste across frames and onto another bone, nudge, delete — each one undo step', async () => {
    await page.getByTestId('tree-bone-thigh-front').click();
    await page.getByTestId('key-thigh-front-rotate-0').click();
    await page.getByTestId('copy-keys').click();
    await page.getByTestId('tree-bone-shin-front').click();
    await gotoFrame(5);
    const undo0 = (await state()).undo;
    await page.getByTestId('paste-keys').click();
    const sf = await boneId('shin-front');
    const tf = await boneId('thigh-front');
    let a = await walk();
    const pasted = a.tracks[sf].rotate.find((k: any) => Math.round(k.time * 30) === 5);
    assert.ok(pasted, 'pasted onto shin-front at frame 5');
    assert.equal(pasted.value[0], a.tracks[tf].rotate[0].value[0], 'value copied from thigh-front frame 0');
    assert.equal((await state()).undo, undo0 + 1);
    // Paste the same key onto the original bone at another frame (copy across frames).
    await page.getByTestId('tree-bone-thigh-front').click();
    await gotoFrame(20);
    await page.keyboard.press('Control+V');
    a = await walk();
    assert.ok(a.tracks[tf].rotate.some((k: any) => Math.round(k.time * 30) === 20), 'Ctrl+V pasted at frame 20');
    // Nudge the pasted key right twice, left once.
    await page.getByTestId('key-thigh-front-rotate-20').click();
    await page.keyboard.press(']');
    await page.getByTestId('nudge-right').click();
    await page.keyboard.press('[');
    a = await walk();
    assert.ok(a.tracks[tf].rotate.some((k: any) => Math.round(k.time * 30) === 21), 'nudged to frame 21');
    assert.equal((await state()).undo, undo0 + 5, 'paste, paste, nudge×3 = 5 undo steps');
    await page.getByTestId('delete-key').click();
    a = await walk();
    assert.ok(!a.tracks[tf].rotate.some((k: any) => Math.round(k.time * 30) === 21), 'deleted');
  });

  it('Close loop copies each lane’s first key to the end', async () => {
    await page.getByTestId('new-animation').click();
    await page.getByTestId('tree-bone-torso').click();
    await gotoFrame(0);
    await page.getByTestId('bone-rotation').fill('-80');
    await page.getByTestId('bone-rotation').press('Enter');
    await gotoFrame(12);
    await page.getByTestId('bone-rotation').fill('-100');
    await page.getByTestId('bone-rotation').press('Enter');
    await page.getByTestId('tree-bone-head').click();
    await gotoFrame(3);
    await page.getByTestId('bone-rotation').fill('9');
    await page.getByTestId('bone-rotation').press('Enter');
    await page.keyboard.press('Escape');
    await page.getByTestId('loop-seam').click();
    const p = await project();
    const an = p.animations.find((x: any) => x.name === 'animation');
    const torso = an.tracks[await boneId('torso')].rotate;
    const head = an.tracks[await boneId('head')].rotate;
    assert.deepEqual(torso.at(-1), { ...torso[0], time: 1 }, 'torso end key = first key');
    assert.deepEqual(head.at(-1), { ...head[0], time: 1 }, 'head end key = first key (first key at frame 3)');
    assert.match(await page.getByTestId('status').textContent() ?? '', /Loop seam closed on 2 lane/);
  });
});

describe('onion skin (view state)', () => {
  it('draws tinted ghosts of neighbouring frames without touching project history', async () => {
    await freshDemo();
    await page.getByTestId('show-bones').uncheck();
    await gotoFrame(10);
    const snap = async () => createHash('sha256').update(await page.getByTestId('stage').screenshot()).digest('hex');
    const plain = await snap();
    const undo0 = (await state()).undo;
    const proj0 = await project();
    await page.getByTestId('onion-toggle').check();
    assert.equal((await state()).onion.enabled, true);
    const ghosted = await snap();
    assert.notEqual(ghosted, plain, 'ghosts change the picture');
    await page.getByTestId('stage').screenshot({ path: path.join(SHOTS, 'onion-on.png') });
    await page.getByTestId('onion-before').fill('4');
    await page.getByTestId('onion-before').press('Enter');
    assert.equal((await state()).onion.before, 4);
    assert.notEqual(await snap(), ghosted, 'more ghosts change the picture again');
    assert.equal((await state()).undo, undo0, 'onion changes are not undo steps');
    assert.deepEqual(await project(), proj0, 'project unchanged');
    // Red tint appears where an earlier frame's limb was: count reddish pixels.
    const reddish = await page.evaluate(() => {
      const c = document.getElementById('stage-canvas') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 120 && d[i] > d[i + 1] * 1.6 && d[i] > d[i + 2] * 1.4) n++;
      return n;
    });
    assert.ok(reddish > 200, `red ghost pixels present (${reddish})`);
    await page.getByTestId('onion-toggle').uncheck();
    assert.equal(await snap(), plain, 'turning it off restores the plain picture');
  });

  it('raised no uncaught page errors', () => {
    assert.deepEqual(pageErrors, []);
  });
});
