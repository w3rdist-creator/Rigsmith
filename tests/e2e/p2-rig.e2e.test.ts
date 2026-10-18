// Phase 2 browser checks: slot visibility/opacity/image keys, draw-order keys, two-bone
// IK (target drag, bend, mix, unreachable, mirrored, Esc), path constraints, cutout
// tools (mask/crop/pivot/overlap/patch, non-destructive), pivot mode, save/reopen.
// Visible controls only; window.__rigsmith is read-only (assertions).
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { decodePng } from '../support/png-decode.ts';
import { writeTestArt } from '../support/png-encode.ts';
import type { M } from '../support/reference-composite.ts';
import { boneWorlds, composite, decodeProjectImages, diffImages } from '../support/reference-composite.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/p2-rig');
const ART = path.join(OUT, 'art');
mkdirSync(ART, { recursive: true });
const art = writeTestArt(ART);

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let base: string;
const pageErrors: string[] = [];

type Pt = { x: number; y: number };
const state = () => probe<any>(page, 'state');
const project = () => probe<any>(page, 'project');
const frameState = () => probe<{ name: string; visible: boolean; opacity: number; image: string | null }[]>(page, 'frame');
const worlds = () => probe<Record<string, M>>(page, 'worlds');
const boneId = async (name: string) => (await project()).bones.find((b: any) => b.name === name).id as string;
const near = (a: number, b: number, eps: number, msg: string) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≈ ${b} ±${eps}`);
const ap = (m: M, p: Pt): Pt => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

async function fresh(): Promise<void> {
  if (page) await page.close();
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(base);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
  if (await page.getByTestId('recovery-discard').isVisible()) await page.getByTestId('recovery-discard').click();
}

async function demo(): Promise<void> {
  await fresh();
  await page.getByTestId('empty-demo').click();
  await page.waitForFunction(() => (window as any).__rigsmith.state().playing === true);
  await page.getByTestId('play').click();
}

async function setField(testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function gotoFrame(frame: number): Promise<void> {
  const name = (await state()).animName;
  const anim = (await project()).animations.find((a: any) => a.name === name);
  const frames = Math.round(anim.duration * anim.fps);
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
  near((await state()).time, frame / anim.fps, 1e-9, `at frame ${frame}`);
}

async function drag(from: Pt, to: Pt, opts: { escape?: boolean } = {}): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  if (opts.escape) await page.keyboard.press('Escape');
  await page.mouse.up();
}

async function boneScreen(name: string): Promise<Pt> {
  return (await probe<{ origin: Pt }>(page, 'bone', name)).origin;
}

async function exportPng(file: string): Promise<ReturnType<typeof decodePng>> {
  const dl = page.waitForEvent('download');
  await page.getByTestId('export-png').click();
  const target = path.join(OUT, file);
  await (await dl).saveAs(target);
  return decodePng(readFileSync(target));
}

/** Chain tip, elbow and target in world space for the demo's front arm IK. */
async function armGeometry() {
  const p = await project();
  const w = await worlds();
  const ik = p.ik[0];
  const lower = p.bones.find((b: any) => b.id === ik.bones[1]);
  const up = w[ik.bones[0]], lo = w[ik.bones[1]], t = w[ik.target];
  return { shoulder: { x: up[4], y: up[5] }, elbow: { x: lo[4], y: lo[5] }, tip: ap(lo, { x: lower.length, y: 0 }), target: { x: t[4], y: t[5] }, up, lo };
}

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  base = `http://127.0.0.1:${port}/`;
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-p2-rig');
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('slot keys and draw-order keys', () => {
  it('visibility, opacity and image keys from the inspector, each one undo step, shown per frame', async () => {
    await demo();
    await gotoFrame(10);
    await page.getByTestId('tree-att-head').click();
    const head = async () => (await frameState()).find((f) => f.name === 'head')!;
    const u0 = (await state()).undo;
    await page.getByTestId('slot-visible').uncheck();
    assert.equal((await state()).undo, u0 + 1, 'hide = one undo step');
    assert.equal((await head()).visible, false, 'hidden at f10');
    await page.getByTestId('key-head-visible-10').waitFor();
    await gotoFrame(9);
    assert.equal((await head()).visible, true, 'stepped: setup visibility before the first key');
    await gotoFrame(20);
    assert.equal((await head()).visible, false, 'stays hidden after the key');
    await page.getByTestId('slot-visible').check();
    assert.equal((await head()).visible, true, 'shown again from f20');
    await gotoFrame(12);
    await setField('slot-opacity', 0.25);
    await gotoFrame(24);
    await setField('slot-opacity', 1);
    await gotoFrame(18);
    near((await head()).opacity, 0.625, 1e-9, 'opacity interpolates linearly f12→f24');
    await gotoFrame(15);
    await page.getByTestId('slot-image').selectOption({ label: 'tock-windup-key.png' });
    assert.equal((await head()).image, 'tock-windup-key.png', 'image swapped at f15');
    await gotoFrame(14);
    assert.equal((await head()).image, 'tock-head.png', 'setup image before the swap');
    await page.getByTestId('key-head-image-15').waitFor();
    const u1 = (await state()).undo;
    await page.getByTestId('undo').click();
    await gotoFrame(15);
    assert.equal((await head()).image, 'tock-head.png', 'undo removes the swap');
    assert.equal((await state()).undo, u1 - 1);
    await page.getByTestId('redo').click();
    assert.equal((await head()).image, 'tock-windup-key.png', 'redo restores it');
  });

  it('draw-order keys move an attachment back/forward from a frame on (stepped)', async () => {
    await gotoFrame(6);
    await page.getByTestId('tree-att-head').click();
    const order = async () => (await frameState()).map((f) => f.name);
    const before = await order();
    const i0 = before.indexOf('head');
    await page.getByTestId('draw-backward').click();
    await page.getByTestId('draw-backward').click();
    const after = await order();
    assert.equal(after.indexOf('head'), i0 - 2, 'two steps back at f6');
    await gotoFrame(5);
    assert.deepEqual(await order(), before, 'setup order before the key');
    await page.getByTestId('key-draw order-order-6').waitFor();
    const p = await project();
    const anim = p.animations.find((a: any) => a.name === 'walk');
    assert.equal(anim.drawOrder.length, 1, 'both clicks wrote the same frame key');
    assert.equal(anim.drawOrder[0].order.length, p.attachments.length, 'key lists every attachment');
  });

  it('renders keyed slot state like the independent reference compositor', async () => {
    await gotoFrame(15);
    await page.getByTestId('export-sequence').click();
    await page.getByTestId('seq-start').fill('15');
    await page.getByTestId('seq-start').press('Enter');
    await page.getByTestId('seq-end').fill('15');
    await page.getByTestId('seq-end').press('Enter');
    const dl = page.waitForEvent('download');
    await page.getByTestId('seq-export').click();
    const file = path.join(OUT, 'slots-f15.zip');
    await (await dl).saveAs(file);
    const files = readZip(readFileSync(file));
    const meta = JSON.parse(files.find((f) => f.name.endsWith('sequence.json'))!.data.toString('utf8'));
    const got = decodePng(files.find((f) => f.name.endsWith('.png'))!.data);
    const p = await project();
    const anim = p.animations.find((a: any) => a.name === 'walk');
    const ref = composite(p, anim, 15 / 30, decodeProjectImages(p), meta.width, meta.height, meta.origin.x, meta.origin.y, meta.scale);
    const d = diffImages(got, ref, 24);
    writeFileSync(path.join(OUT, 'slots-reference.txt'), `walk f15 (hidden head swapped, draw-order key): max ${d.maxDiff} mean ${d.meanDiff.toFixed(3)} over24 ${d.over}/${d.covered}\n`);
    assert.ok(d.over <= d.covered * 0.01 && d.meanDiff < 1.5, `reference diff ${JSON.stringify(d)}`);
  });
});

describe('two-bone IK', () => {
  let cross0 = 0;
  it('adds IK from the inspector without moving the limb; dragging the target keys it and the tip follows', async () => {
    await demo();
    await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-bone-forearm-front').click();
    const fore = await boneId('forearm-front');
    const w0 = await worlds();
    await page.getByTestId('ik-add-2').click();
    const p = await project();
    assert.equal(p.ik.length, 1);
    assert.deepEqual(p.ik[0].bones, [await boneId('arm-front'), fore]);
    await page.getByTestId('tree-constraint-forearm-front-ik').waitFor();
    const w1 = await worlds();
    for (let k = 0; k < 6; k++) near(w1[fore][k], w0[fore][k], 1e-6, 'forearm unchanged by adding IK');
    await page.getByTestId('mode-animate').click();
    await gotoFrame(8);
    const t = await boneScreen('forearm-front-target');
    const u0 = (await state()).undo;
    await drag(t, { x: t.x + 25, y: t.y - 30 });
    assert.equal((await state()).undo, u0 + 1, 'target drag = one undo step');
    await page.getByTestId('key-forearm-front-target-translate-8').waitFor();
    const g = await armGeometry();
    near(Math.hypot(g.tip.x - g.target.x, g.tip.y - g.target.y), 0, 1e-6, 'forearm tip on the target');
    cross0 = cross(g.shoulder, g.target, g.elbow);
    assert.ok(Math.abs(cross0) > 1, 'elbow is bent');
  });

  it('bend direction flips the elbow; mix 0 (keyed) restores the animated pose; Esc cancels a target drag', async () => {
    await page.getByTestId('tree-constraint-forearm-front-ik').click();
    await page.getByTestId('ik-bend').click();
    let g = await armGeometry();
    assert.ok(Math.sign(cross(g.shoulder, g.target, g.elbow)) === -Math.sign(cross0), 'elbow on the other side');
    near(Math.hypot(g.tip.x - g.target.x, g.tip.y - g.target.y), 0, 1e-6, 'still on target');
    await setField('ik-mix', 0);
    await page.getByTestId('key-forearm-front-ik-mix-8').waitFor();
    const p = await project();
    const anim = p.animations.find((a: any) => a.name === 'walk');
    const ref = boneWorlds(p, anim, 8 / 30);
    g = await armGeometry();
    const upId = p.ik[0].bones[0];
    for (let k = 0; k < 6; k++) near(g.up[k], ref.get(upId)![k], 1e-6, 'mix 0 = keyed pose (independent sampler)');
    await setField('ik-mix', 1);
    const t = await boneScreen('forearm-front-target');
    const before = (await worlds())[p.ik[0].target];
    const u0 = (await state()).undo;
    await drag(t, { x: t.x + 60, y: t.y + 40 }, { escape: true });
    assert.deepEqual((await worlds())[p.ik[0].target], before, 'Esc restored the target');
    assert.equal((await state()).undo, u0, 'no history entry');
  });

  it('an unreachable target straightens the chain toward it', async () => {
    const t = await boneScreen('forearm-front-target');
    await drag(t, { x: t.x + 260, y: t.y + 120 });
    const g = await armGeometry();
    const a1 = Math.atan2(g.elbow.y - g.shoulder.y, g.elbow.x - g.shoulder.x);
    const a2 = Math.atan2(g.tip.y - g.elbow.y, g.tip.x - g.elbow.x);
    const at = Math.atan2(g.target.y - g.shoulder.y, g.target.x - g.shoulder.x);
    near(a1, at, 1e-6, 'upper arm aims at target');
    near(a2, at, 1e-6, 'forearm aims at target');
    assert.ok(Math.hypot(g.target.x - g.tip.x, g.target.y - g.tip.y) > 20, 'target really out of reach');
  });

  it('a mirrored rig (root scale X −1) mirrors the bend and still reaches the target', async () => {
    await page.getByTestId('mode-setup').click();
    let g = await armGeometry();
    const plain = Math.sign(cross(g.shoulder, g.target, g.elbow));
    near(Math.hypot(g.tip.x - g.target.x, g.tip.y - g.target.y), 0, 1e-6, 'setup: on target');
    await page.getByTestId('tree-bone-root').click();
    await setField('bone-scale-x', -1);
    g = await armGeometry();
    near(Math.hypot(g.tip.x - g.target.x, g.tip.y - g.target.y), 0, 1e-6, 'mirrored: on target');
    assert.equal(Math.sign(cross(g.shoulder, g.target, g.elbow)), -plain, 'bend side mirrored on screen');
    await page.getByTestId('undo').click();
  });

  it('IK frames export like the reference compositor fed the editor’s bone matrices', async () => {
    await page.getByTestId('mode-animate').click();
    await gotoFrame(20);
    const w = await worlds();
    await page.getByTestId('export-sequence').click();
    for (const f of ['seq-start', 'seq-end']) {
      await page.getByTestId(f).fill('20');
      await page.getByTestId(f).press('Enter');
    }
    const dl = page.waitForEvent('download');
    await page.getByTestId('seq-export').click();
    const file = path.join(OUT, 'ik-f20.zip');
    await (await dl).saveAs(file);
    const files = readZip(readFileSync(file));
    const meta = JSON.parse(files.find((f) => f.name.endsWith('sequence.json'))!.data.toString('utf8'));
    const got = decodePng(files.find((f) => f.name.endsWith('.png'))!.data);
    const p = await project();
    const anim = p.animations.find((a: any) => a.name === 'walk');
    const ref = composite(p, anim, 20 / 30, decodeProjectImages(p), meta.width, meta.height, meta.origin.x, meta.origin.y, meta.scale, new Map(Object.entries(w)));
    const d = diffImages(got, ref, 24);
    writeFileSync(path.join(OUT, 'ik-reference.txt'), `walk f20 with IK: max ${d.maxDiff} mean ${d.meanDiff.toFixed(3)} over24 ${d.over}/${d.covered}\n`);
    assert.ok(d.over <= d.covered * 0.01 && d.meanDiff < 1.5, `reference diff ${JSON.stringify(d)}`);
  });
});

/** Independent arc-length sampling of a world-space path (fine uniform subdivision). */
function pathAt(path: any, s01: number): { p: Pt; tangent: number } {
  const n = path.nodes;
  const segs: Pt[][] = [];
  const count = path.closed ? n.length : n.length - 1;
  for (let i = 0; i < count; i++) {
    const a = n[i], b = n[(i + 1) % n.length];
    segs.push([{ x: a.x, y: a.y }, { x: a.x + a.outX, y: a.y + a.outY }, { x: b.x + b.inX, y: b.y + b.inY }, { x: b.x, y: b.y }]);
  }
  const bez = (s: Pt[], t: number): Pt => {
    const u = 1 - t;
    return { x: u * u * u * s[0].x + 3 * u * u * t * s[1].x + 3 * u * t * t * s[2].x + t * t * t * s[3].x, y: u * u * u * s[0].y + 3 * u * u * t * s[1].y + 3 * u * t * t * s[2].y + t * t * t * s[3].y };
  };
  const pts: Pt[] = [];
  for (const s of segs) for (let k = 0; k <= 4000; k++) if (k || !pts.length) pts.push(bez(s, k / 4000));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const target = s01 * cum[cum.length - 1];
  const i = Math.max(1, cum.findIndex((c) => c >= target));
  return { p: pts[i], tangent: (Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x) * 180) / Math.PI };
}

describe('path constraint', () => {
  it('adds and edits a path on the canvas (node drag = one undo step; Esc cancels a handle drag)', async () => {
    await demo();
    await page.getByTestId('mode-setup').click();
    await page.keyboard.press('Escape');
    await page.getByTestId('add-path').click();
    let p = await project();
    assert.equal(p.paths.length, 1);
    assert.equal(p.paths[0].boneId, null, 'nothing selected → world space');
    const n2 = (await probe<{ node: Pt }>(page, 'path', 'path', 2)).node;
    const u0 = (await state()).undo;
    await drag(n2, { x: n2.x, y: n2.y + 40 });
    p = await project();
    assert.equal((await state()).undo, u0 + 1);
    assert.ok(p.paths[0].nodes[2].y > 10, 'node moved down');
    const n1 = (await probe<{ node: Pt; out: Pt }>(page, 'path', 'path', 1));
    await page.mouse.click(n1.node.x, n1.node.y);
    assert.equal((await state()).pathNode, 1);
    const snap = JSON.stringify((await project()).paths);
    const out = (await probe<{ out: Pt }>(page, 'path', 'path', 1)).out;
    await drag(out, { x: out.x + 50, y: out.y + 50 }, { escape: true });
    assert.equal(JSON.stringify((await project()).paths), snap, 'Esc restored the handle');
  });

  it('constrains a bone; keyed position moves it along the path at the arc-length point and tangent', async () => {
    await page.getByTestId('pc-bone-windup-key').check();
    await page.getByTestId('path-constrain').click();
    let p = await project();
    assert.equal(p.pathConstraints.length, 1);
    await page.getByTestId('pc-bones').waitFor();
    await setField('pc-offset', 15);
    await page.getByTestId('mode-animate').click();
    await gotoFrame(0);
    // The field already shows 0, so key the current value with the key toggle.
    await page.getByTestId('pc-key-position').click();
    await page.getByTestId('key-path-follow-position-0').waitFor();
    await gotoFrame(30);
    await setField('pc-position', 1);
    await page.getByTestId('key-path-follow-position-30').waitFor();
    await gotoFrame(15);
    p = await project();
    const key = p.bones.find((b: any) => b.name === 'windup-key').id;
    const m = (await worlds())[key];
    const want = pathAt(p.paths[0], 0.5);
    near(m[4], want.p.x, 0.6, 'x on the path at half its length');
    near(m[5], want.p.y, 0.6, 'y on the path at half its length');
    const ang = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
    near(((ang - want.tangent - 15 + 540) % 360) - 180, 0, 0.5, 'rotated to tangent + 15°');
    await page.getByTestId('tree-path-path').click();
    await page.getByTestId('path-closed').check();
    assert.equal((await project()).paths[0].closed, true);
  });
});

describe('cutout tools and pivot mode', () => {
  let limbUrl = '';
  it('cuts a forearm out of one limb image with overlap and a joint bone — non-destructive, pixel-identical in place', async () => {
    await fresh();
    await page.getByTestId('image-input').setInputFiles([art['limb.png'], art['hand-open.png'], art['hand-closed.png']]);
    await page.getByTestId('image-limb.png').waitFor();
    await page.getByTestId('add-bone').click();
    await setField('bone-rotation', 0);
    await page.getByTestId('attach-limb.png').click();
    limbUrl = (await project()).images.find((i: any) => i.name === 'limb.png').dataUrl;
    const before = await exportPng('cut-before.png');
    await page.getByTestId('att-cutout').click();
    const canvas = page.getByTestId('cutout-canvas');
    const box = (await canvas.boundingBox())!;
    const geo = { s: Number(await canvas.getAttribute('data-scale')), ox: Number(await canvas.getAttribute('data-ox')), oy: Number(await canvas.getAttribute('data-oy')) };
    const at = (x: number, y: number) => ({ x: box.x + geo.ox + x * geo.s, y: box.y + geo.oy + y * geo.s });
    for (const [x, y] of [[100, -2], [202, -2], [202, 46], [100, 46]]) {
      const q = at(Math.max(0, Math.min(199, x)), Math.max(0, Math.min(43.5, y)));
      await page.mouse.click(q.x, q.y);
    }
    assert.ok(await page.getByTestId('cut-apply').isDisabled() === false, 'polygon complete');
    await page.getByTestId('cut-bone').check();
    await page.getByTestId('cut-apply').click();
    await page.getByTestId('cut-errors').waitFor();
    assert.match(await page.getByTestId('cut-errors').innerText(), /Set a pivot/);
    await page.getByTestId('cut-mode-pivot').click();
    const pv = at(100, 22);
    await page.mouse.click(pv.x, pv.y);
    await setField('cut-overlap', 3);
    await page.getByTestId('cut-name').fill('fore');
    await page.getByTestId('cut-name').press('Enter');
    const u0 = (await state()).undo;
    await page.getByTestId('cut-apply').click();
    await page.getByTestId('cutout-dialog').waitFor({ state: 'hidden' });
    assert.equal((await state()).undo, u0 + 1, 'one undo step');
    const p = await project();
    assert.equal(p.images.find((i: any) => i.name === 'limb.png').dataUrl, limbUrl, 'source image bytes unchanged');
    const piece = p.images.find((i: any) => i.name === 'limb-fore.png');
    assert.equal(piece.derived.kind, 'cutout');
    assert.equal(piece.derived.offsetX, 97, 'overlap 3 px grows the crop left of the cut');
    assert.equal(p.images.find((i: any) => i.name === 'limb-rest.png').derived.kind, 'remainder');
    assert.match(await page.getByTestId('image-derived-limb-fore.png').innerText(), /cutout of limb\.png/);
    const bone = p.bones.find((b: any) => b.name === 'fore');
    assert.ok(bone, 'joint bone created at the pivot');
    const after = await exportPng('cut-after.png');
    assert.equal(after.width, before.width);
    assert.equal(after.height, before.height);
    const d = diffImages(after, before, 24);
    writeFileSync(path.join(OUT, 'cut-in-place.txt'), `before vs after cut: max ${d.maxDiff} mean ${d.meanDiff.toFixed(3)} over24 ${d.over}/${d.covered}\n`);
    assert.ok(d.over <= d.covered * 0.005, `piece + remainder render like the source: ${JSON.stringify(d)}`);
  });

  it('rotating the joint bone bends the limb (the cut piece follows its bone)', async () => {
    // Note: a straight cut opens a small wedge on the outer side of the bend; overlap
    // only covers a few pixels (documented limitation — use a rounded outline or patch).
    await page.getByTestId('tree-bone-fore').click();
    const r0 = Number(await page.getByTestId('bone-rotation').inputValue());
    await setField('bone-rotation', r0 - 35);
    const bent = await exportPng('cut-bent.png');
    assert.ok(bent.height > 60, `forearm rotated up out of the 44 px strip (export height ${bent.height})`);
    await page.getByTestId('undo').click();
  });

  it('patch fills a hole with a labelled flat colour; errors and cancel change nothing', async () => {
    await page.getByTestId('tree-att-limb').click();
    const n0 = (await project()).images.length;
    await page.getByTestId('att-cutout').click();
    const canvas = page.getByTestId('cutout-canvas');
    const box = (await canvas.boundingBox())!;
    const s = Number(await canvas.getAttribute('data-scale')), ox = Number(await canvas.getAttribute('data-ox')), oy = Number(await canvas.getAttribute('data-oy'));
    await page.mouse.click(box.x + ox + 20 * s, box.y + oy + 10 * s);
    await page.mouse.click(box.x + ox + 40 * s, box.y + oy + 10 * s);
    assert.equal(await page.getByTestId('cut-apply').isDisabled(), true, 'two points cannot be applied');
    await page.getByTestId('cut-cancel').click();
    assert.equal((await project()).images.length, n0, 'cancel: nothing added');
    await page.getByTestId('att-cutout').click();
    await page.getByTestId('cut-mode-rect').click();
    const c2 = (await page.getByTestId('cutout-canvas').boundingBox())!;
    await drag({ x: c2.x + ox + 30 * s, y: c2.y + oy + 8 * s }, { x: c2.x + ox + 60 * s, y: c2.y + oy + 36 * s });
    await page.getByTestId('cut-bone').uncheck();
    await page.getByTestId('cut-patch').check();
    await page.getByTestId('cut-patch-color').fill('#ff00ff');
    await page.getByTestId('cut-apply').click();
    await page.getByTestId('cutout-dialog').waitFor({ state: 'hidden' });
    const p = await project();
    const patched = p.images.find((i: any) => i.derived?.kind === 'patch');
    assert.ok(patched && patched.derived.synthesized > 500, `patch records synthesized pixels (${patched?.derived.synthesized})`);
    assert.match(patched.derived.note, /#ff00ff/);
    assert.match(await page.getByTestId(`image-derived-${patched.name}`).innerText(), /px synthesized/);
    assert.equal(p.images.find((i: any) => i.name === 'limb.png').dataUrl, limbUrl, 'original still untouched');
  });

  it('pivot mode moves a bone origin while its images and child bones stay in place', async () => {
    await demo();
    await page.getByTestId('mode-setup').click();
    await page.getByTestId('tree-bone-arm-front').click();
    await page.getByTestId('pivot-mode').check();
    const att0 = await probe<Pt>(page, 'attachment', 'arm_front');
    const child0 = await boneScreen('forearm-front');
    const o = await boneScreen('arm-front');
    const u0 = (await state()).undo;
    await drag(o, { x: o.x + 12, y: o.y + 18 });
    assert.equal((await state()).undo, u0 + 1);
    const o1 = await boneScreen('arm-front');
    assert.ok(Math.hypot(o1.x - o.x - 12, o1.y - o.y - 18) < 1.5, 'origin moved');
    const att1 = await probe<Pt>(page, 'attachment', 'arm_front');
    const child1 = await boneScreen('forearm-front');
    near(att1.x, att0.x, 0.02, 'image x stays');
    near(att1.y, att0.y, 0.02, 'image y stays');
    near(child1.x, child0.x, 0.02, 'child x stays');
    near(child1.y, child0.y, 0.02, 'child y stays');
  });
});

describe('persistence', () => {
  it('a project with slot keys, draw order, IK, path constraint and cutouts saves and reopens losslessly', async () => {
    await demo();
    await gotoFrame(10);
    await page.getByTestId('tree-att-head').click();
    await page.getByTestId('slot-visible').uncheck();
    await page.getByTestId('draw-forward').click();
    await page.getByTestId('tree-bone-forearm-front').click();
    await page.getByTestId('ik-add-2').click();
    await page.keyboard.press('Escape');
    await page.getByTestId('add-path').click();
    await page.getByTestId('pc-bone-windup-key').check();
    await page.getByTestId('path-constrain').click();
    await page.getByTestId('tree-att-torso').click();
    await page.getByTestId('mode-setup').click();
    await page.getByTestId('att-cutout').click();
    const canvas = page.getByTestId('cutout-canvas');
    const box = (await canvas.boundingBox())!;
    for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.5, 0.6]]) await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.getByTestId('cut-bone').uncheck();
    await page.getByTestId('cut-apply').click();
    await page.getByTestId('cutout-dialog').waitFor({ state: 'hidden' });
    await page.getByTestId('mode-animate').click();
    const frames: unknown[] = [];
    for (const f of [0, 10, 20]) {
      await gotoFrame(f);
      frames.push([await frameState(), await worlds()]);
    }
    const before = await project();
    assert.equal(before.version, 2);
    const dl = page.waitForEvent('download');
    await page.getByTestId('save-project').click();
    const file = path.join(OUT, 'p2-saved.rig.json');
    await (await dl).saveAs(file);
    await fresh();
    await page.getByTestId('open-input').setInputFiles(file);
    await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length > 0);
    assert.deepEqual(await project(), before, 'reopened project equals the saved one');
    await page.getByTestId('mode-animate').click();
    for (const [i, f] of [0, 10, 20].entries()) {
      await gotoFrame(f);
      assert.deepEqual([await frameState(), await worlds()], frames[i], `frame ${f} evaluates identically`);
    }
  });

  it('raised no uncaught page errors', () => {
    assert.deepEqual(pageErrors, []);
  });
});
