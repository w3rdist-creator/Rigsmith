// Builds Wiz v3 (use-case review RV-001) INSIDE Rigsmith by driving visible controls in an
// isolated headless Chrome for Testing profile (.hermes/browser-profiles/wiz-v3). No new
// art: the prepared pieces of the UI-authored wiz-v2.rig.json are re-rigged.
//   Open… wiz-v2.rig.json (read only) → delete its FK animations → + Bone hips / chest /
//   head → body: Fill grid 8×10 + Auto weights + weight brush (face → head, sleeves →
//   chest, hem and lower bun → hips) → arms under chest, split at the elbow, Fill grid +
//   Auto weights, + 2-bone IK (target under chest) → legs under body, split at the knee,
//   Fill grid + Auto weights, + 2-bone IK (target on the ground) + a foot bone on the
//   target that the shoe is painted to → idle-v3 / greeting-v3 typed in the inspector at
//   the frames of idle / greeting-v2 (provisional timing, RV-011) → curve presets →
//   Close loop → project frame: Fit to all animations → Save → exports.
// window.__rigsmith is only read. wiz-v2.rig.json and every other original are never
// written. Outputs: .hermes/assets/wiz/v3-output/ (git-ignored).
// Usage: npm run build && node scripts/roadmap/wiz-v3.ts   (WIZ_V3_STOP=rig: stop after rigging)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { launchIsolated, pickPort, probe, startPreview } from '../../tests/e2e/harness.ts';
import { WIZ } from '../wiz/paths.ts';

export const V2_FILE = path.join(WIZ, 'roadmap-output/wiz-v2.rig.json');
export const V3_OUT = path.join(WIZ, 'v3-output');
export const V3_FILE = path.join(V3_OUT, 'wiz-v3.rig.json');
const STOP = process.env.WIZ_V3_STOP ?? '';
mkdirSync(V3_OUT, { recursive: true });

const lines: string[] = [];
const log = (m: string) => {
  const l = `${new Date().toISOString()} ${m}`;
  console.log(l);
  lines.push(l);
};
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const r3 = (v: number) => Math.round(v * 1000) / 1000 || 0;
const RAD = Math.PI / 180;

type Pt = { x: number; y: number };
type Ch = 'translate' | 'rotate' | 'scale';
/** [bone, channel, frame, absolute local value(s)]. */
type K = [string, Ch, number, number[]];
const FIELDS: Record<Ch, string[]> = { translate: ['bone-x', 'bone-y'], rotate: ['bone-rotation'], scale: ['bone-scale-x', 'bone-scale-y'] };

let page: Page;

async function fill(testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}
const project = () => probe<any>(page, 'project');
const boneOf = (p: any, name: string) => p.bones.find((b: any) => b.name === name);
const attOf = (p: any, name: string) => p.attachments.find((a: any) => a.name === name);
const screenBone = (name: string) => probe<{ origin: Pt; tip: Pt }>(page, 'bone', name);

async function selectBone(name: string): Promise<void> {
  await page.getByTestId(`tree-bone-${name}`).click();
}

async function setBone(name: string, f: Partial<Record<'x' | 'y' | 'rotation' | 'length' | 'name', number | string>>): Promise<void> {
  await selectBone(name);
  for (const [k, v] of Object.entries(f)) await fill(`bone-${k}`, v);
}

/** + Bone under `parent` (a child at its tip), renamed and placed. */
async function addBone(parent: string, name: string, f: Partial<Record<'x' | 'y' | 'rotation' | 'length', number>>): Promise<void> {
  await selectBone(parent);
  await page.getByTestId('add-bone').click();
  await fill('bone-name', name);
  for (const [k, v] of Object.entries(f)) await fill(`bone-${k}`, v);
  assert.equal(boneOf(await project(), name)?.parentId, boneOf(await project(), parent).id, `${name} is a child of ${parent}`);
}

/** Parent dropdown (keeps the world placement); asserts the bone did not move. */
async function reparent(name: string, parent: string): Promise<void> {
  const before = await screenBone(name);
  await selectBone(name);
  await page.getByTestId('bone-parent').selectOption({ label: parent });
  const after = await screenBone(name);
  assert.ok(Math.hypot(after.origin.x - before.origin.x, after.origin.y - before.origin.y) < 0.01 && Math.hypot(after.tip.x - before.tip.x, after.tip.y - before.tip.y) < 0.01, `${name} keeps its place under ${parent}`);
}

async function gridMesh(att: string, cols: number, rows: number): Promise<string> {
  await page.getByTestId(`tree-att-${att}`).click();
  await page.getByTestId('mesh-create').click();
  await fill('mesh-grid-cols', cols);
  await fill('mesh-grid-rows', rows);
  await page.getByTestId('mesh-grid').click();
  await page.getByTestId('mesh-apply').click();
  await page.getByTestId('mesh-dialog').waitFor({ state: 'hidden' });
  const auto = await page.getByTestId('weights-auto').getAttribute('title');
  await page.getByTestId('weights-auto').click();
  return `${await page.getByTestId('mesh-summary').innerText()} — Auto weights: ${auto}`;
}

/** Influence names per vertex (read from the project). */
async function influences(att: string): Promise<string[][]> {
  const p = await project();
  const a = attOf(p, att);
  return a.mesh.weights.map((w: any[]) => w.map((x) => p.bones.find((b: any) => b.id === x.bone).name));
}

/** Image-space points of a mesh. */
async function points(att: string): Promise<Pt[]> {
  const pts: number[] = attOf(await project(), att).mesh.points;
  return Array.from({ length: pts.length / 2 }, (_, i) => ({ x: pts[2 * i], y: pts[2 * i + 1] }));
}

/**
 * Weight brush (Add, strength 1) dabbed twice on each listed vertex with a radius below
 * half the closest vertex spacing, so each dab reaches only its vertex: the vertex ends
 * fully weighted to `bone`.
 */
async function paint(att: string, bone: string, vertices: number[]): Promise<void> {
  if (!vertices.length) return;
  await page.getByTestId(`tree-att-${att}`).click();
  const tool = page.getByTestId('mesh-tool-weights');
  if ((await tool.getAttribute('aria-pressed')) !== 'true') await tool.click();
  await page.getByTestId('wp-bone').selectOption({ label: bone });
  await page.getByTestId('wp-mode').selectOption('add');
  await fill('wp-strength', 1);
  const screen = (await probe<Pt[]>(page, 'mesh', att))!;
  let min = Infinity;
  for (let i = 0; i < screen.length; i++) for (let j = i + 1; j < screen.length; j++) min = Math.min(min, Math.hypot(screen[i].x - screen[j].x, screen[i].y - screen[j].y));
  const radius = Math.max(2, Math.floor(min * 0.4));
  await fill('wp-radius', radius);
  for (const v of vertices) {
    const s = (await probe<Pt[]>(page, 'mesh', att))![v];
    await page.mouse.click(s.x, s.y);
    await page.mouse.click(s.x, s.y);
  }
  await tool.click();
  log(`  painted ${vertices.length} vertices of ${att} → ${bone} (Add, strength 1, radius ${radius} px)`);
}

/**
 * Weight brush in Replace mode: each vertex gets `bone` weight = smoothstep of its position
 * along `from`'s origin → `to`'s tip, across [lo, hi] (fractions of that length), and the
 * rest on the other influence. One dab per vertex whose weight differs, radius below half
 * the vertex spacing, strength = the wanted weight.
 */
async function ramp(att: string, bone: string, from: string, to: string, lo: number, hi: number): Promise<number> {
  const [a, b] = [await screenBone(from), await screenBone(to)];
  const axis = { x: b.tip.x - a.origin.x, y: b.tip.y - a.origin.y };
  const L2 = axis.x * axis.x + axis.y * axis.y;
  const screen = (await probe<Pt[]>(page, 'mesh', att))!;
  const inf = attOf(await project(), att).mesh.weights as { bone: string; w: number }[][];
  const id = boneOf(await project(), bone).id;
  const want = screen.map((s) => {
    const f = ((s.x - a.origin.x) * axis.x + (s.y - a.origin.y) * axis.y) / L2;
    const t = Math.min(1, Math.max(0, (f - lo) / (hi - lo)));
    return Math.round(t * t * (3 - 2 * t) * 100) / 100;
  });
  const todo = want.map((w, i) => [w, i] as const).filter(([w, i]) => Math.abs((inf[i].find((x) => x.bone === id)?.w ?? 0) - w) > 0.005);
  if (!todo.length) return 0;
  await page.getByTestId(`tree-att-${att}`).click();
  const tool = page.getByTestId('mesh-tool-weights');
  if ((await tool.getAttribute('aria-pressed')) !== 'true') await tool.click();
  await page.getByTestId('wp-bone').selectOption({ label: bone });
  await page.getByTestId('wp-mode').selectOption('replace');
  let min = Infinity;
  for (let i = 0; i < screen.length; i++) for (let j = i + 1; j < screen.length; j++) min = Math.min(min, Math.hypot(screen[i].x - screen[j].x, screen[i].y - screen[j].y));
  await fill('wp-radius', Math.max(2, Math.floor(min * 0.4)));
  let strength = NaN;
  for (const [w, i] of todo.sort((x, y) => x[0] - y[0])) {
    if (w !== strength) await fill('wp-strength', (strength = w));
    await page.mouse.click(screen[i].x, screen[i].y);
  }
  await tool.click();
  const after = attOf(await project(), att).mesh.weights as { bone: string; w: number }[][];
  for (const [i, w] of want.entries()) assert.ok(Math.abs((after[i].find((x) => x.bone === id)?.w ?? 0) - w) < 0.02, `${att} vertex ${i}: ${bone} weight ${w}`);
  log(`  ramped ${todo.length} vertices of ${att}: ${bone} weight smoothstep over ${lo}–${hi} of ${from} → ${to} (Replace, strength = weight)`);
  return todo.length;
}

/** + 2-bone IK on `end`; the elbow/knee must bend toward `outward` (screen) when `test` moves the target. */
async function twoBoneIk(end: string, start: string, targetParent: string | null, test: (t: any) => Record<'x' | 'y', number>, outward: Pt): Promise<string> {
  await selectBone(end);
  await page.getByTestId('ik-add-2').click();
  const target = `${end}-target`;
  const ik = `${end}-ik`;
  assert.ok(boneOf(await project(), target), `target ${target} created`);
  if (targetParent) await reparent(target, targetParent);
  const side = async () => {
    const t0 = boneOf(await project(), target);
    const moved = test(t0);
    await setBone(target, moved);
    const [s, e, t] = [await screenBone(start), await screenBone(end), await screenBone(target)];
    const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x;
    const d = { x: t.origin.x - s.origin.x, y: t.origin.y - s.origin.y };
    const bend = cross(d, { x: e.origin.x - s.origin.x, y: e.origin.y - s.origin.y });
    await setBone(target, { x: t0.x, y: t0.y });
    return { bent: Math.abs(bend) > 1, ok: Math.sign(bend) === Math.sign(cross(d, outward)) };
  };
  let s1 = await side();
  assert.ok(s1.bent, `${ik}: moving the target bends the chain`);
  if (!s1.ok) {
    await page.getByTestId(`tree-constraint-${ik}`).click();
    await page.getByTestId('ik-bend').click();
    s1 = await side();
  }
  assert.ok(s1.ok, `${ik} bends outward`);
  const c = (await project()).ik.find((k: any) => k.name === ik);
  return `${ik}: chain ${start} → ${end}, target ${target}${targetParent ? ` (under ${targetParent})` : ' (on root)'}, bend ${c.bendPositive ? 'clockwise' : 'counter-clockwise'}`;
}

/** Scrubs the ruler to `frame` of an animation with `frames` frames. */
async function gotoFrame(frame: number, frames: number, fps: number): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  await ruler.scrollIntoViewIfNeeded();
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
  const t = (await probe<{ time: number }>(page, 'state')).time;
  assert.ok(Math.abs(t - frame / fps) < 1e-6, `scrubbed to frame ${frame} (time ${t})`);
}

async function typeKeys(keys: K[], frames: number, fps: number): Promise<void> {
  const byFrame = new Map<number, K[]>();
  for (const k of keys) byFrame.set(k[2], [...(byFrame.get(k[2]) ?? []), k]);
  for (const frame of [...byFrame.keys()].sort((a, b) => a - b)) {
    await gotoFrame(frame, frames, fps);
    for (const [name, ch, , value] of byFrame.get(frame)!) {
      await selectBone(name);
      for (const [i, f] of FIELDS[ch].entries()) await fill(f, r3(value[i]));
      const toggle = page.getByTestId(`key-toggle-${ch}`);
      if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
    }
  }
}

async function curves(list: [string, Ch, number, string][]): Promise<void> {
  await page.keyboard.press('Escape');
  await page.getByTestId('stage').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+A');
  await page.getByTestId('key-interp').selectOption('smooth');
  for (const [name, ch, frame, preset] of list) {
    await selectBone(name);
    await page.getByTestId(`key-${name}-${ch}-${frame}`).click();
    await page.getByTestId('curve-preset').selectOption(preset);
  }
  await page.keyboard.press('Escape');
  await page.getByTestId('stage').click({ position: { x: 5, y: 5 } });
  await page.getByTestId('loop-seam').click();
}

async function newAnimation(name: string, duration: number, fps: number): Promise<void> {
  await page.getByTestId('new-animation').click();
  await fill('anim-name', name);
  await fill('anim-duration', duration);
  await fill('anim-fps', fps);
}

async function download(testId: string, file: string): Promise<string> {
  const dl = page.waitForEvent('download');
  await page.getByTestId(testId).click();
  const d = await dl;
  const out = path.join(V3_OUT, file);
  await d.saveAs(out);
  log(`  ${testId} → ${file} (${d.suggestedFilename()})`);
  return out;
}

async function main(): Promise<void> {
  const v2Bytes = readFileSync(V2_FILE);
  const v2Sha = sha(v2Bytes);
  const port = await pickPort([47614, 47615, 47616, 47617]);
  const server = await startPreview(port);
  const ctx = await launchIsolated('wiz-v3', [], { viewport: { width: 1600, height: 1000 } });
  const errors: string[] = [];
  try {
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => void d.accept());
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
    await page.getByTestId('open-input').setInputFiles(V2_FILE);
    await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length === 8);
    log(`opened roadmap-output/wiz-v2.rig.json via Open… (sha256 ${v2Sha.slice(0, 16)}…)`);
    await fill('project-name', 'Wiz v3 — cheesesteak mascot (articulated)');

    // The FK animations of v2 would be overridden by the IK added below; v3 carries only
    // its own animations (the v2 originals stay in wiz-v2.rig.json).
    for (const name of ['idle', 'greeting', 'greeting-v2']) {
      await page.getByTestId('anim-select').selectOption({ label: name });
      await page.getByRole('button', { name: 'Delete animation' }).click();
    }
    assert.equal((await project()).animations.length, 0);
    log('deleted the inherited FK animations idle, greeting, greeting-v2 (🗑 Delete animation)');
    await page.getByTestId('mode-setup').click();

    // ---- Spine: body (hop + lean) → hips (squash) / chest → head ----------------------
    const v2 = JSON.parse(v2Bytes.toString('utf8'));
    const len = (n: string) => v2.bones.find((b: any) => b.name === n).length as number;
    await setBone('body', { length: 60 });
    await addBone('body', 'hips', { x: 0, length: 300 });
    await addBone('body', 'chest', { x: 300, length: 263 });
    await addBone('chest', 'head', { length: 400 });
    log('bones: body (length 60) → hips (0, length 300) and chest (300, length 263) → head (length 400)');

    log(`body mesh: ${await gridMesh('body', 8, 10)}`);
    {
      const pts = await points('body');
      const rowOf = (v: Pt) => Math.round(v.y / (1146 / 10));
      const pick = (rows: number[]) => pts.map((v, i) => [v, i] as const).filter(([v]) => rows.includes(rowOf(v))).map(([, i]) => i);
      await paint('body', 'head', pick([0, 1, 2, 3, 4]));
      await paint('body', 'chest', pick([6, 7]));
      await paint('body', 'hips', pick([8, 9, 10]));
      // Row 5 keeps its Auto chest/head blend (the neck), except vertices that Auto weights
      // gave to an arm or hand (far from every bone it falls back to the nearest two).
      const stray = (await influences('body')).map((w, i) => [w, i] as const).filter(([w]) => w.some((n) => !['hips', 'chest', 'head'].includes(n))).map(([, i]) => i);
      await paint('body', 'chest', stray);
      const inf = await influences('body');
      const bad = inf.map((w, i) => [w, i] as const).filter(([w]) => w.some((n) => !['hips', 'chest', 'head'].includes(n)));
      assert.deepEqual(bad, [], 'body vertices are weighted only to hips / chest / head');
      for (const [i, v] of pts.entries()) {
        const r = rowOf(v);
        const want = r <= 4 ? 'head' : r <= 5 ? null : r <= 7 ? 'chest' : 'hips';
        if (want) assert.deepEqual(inf[i], [want], `body vertex ${i} (row ${r}) rigid to ${want}`);
      }
      log(`body weights: rows 0–4 head, row 5 Auto (chest/head; ${stray.length} stray arm/hand vertices painted to chest), rows 6–7 chest, rows 8–10 hips (${inf.length} vertices)`);
    }

    // ---- Arms: under chest, split at the elbow, meshed, 2-bone IK -------------------------
    for (const s of ['l', 'r'] as const) {
      await reparent(`arm_${s}`, 'chest');
      const L = len(`arm_${s}`);
      await setBone(`arm_${s}`, { length: r3(L / 2) });
      await addBone(`arm_${s}`, `forearm_${s}`, { length: r3(L / 2) });
      await reparent(`hand_${s}`, `forearm_${s}`);
      log(`arm_${s}: under chest; split at the elbow: arm_${s} ${r3(L / 2)} → forearm_${s} ${r3(L / 2)} → hand_${s}`);
      log(`arm_${s} mesh: ${await gridMesh(`arm_${s}`, 10, 10)}`);
      const inf = await influences(`arm_${s}`);
      await paint(`arm_${s}`, `forearm_${s}`, inf.map((w, i) => [w, i] as const).filter(([w]) => w.includes(`hand_${s}`)).map(([, i]) => i));
      // A hard elbow folds the mesh into a crease that shows the sleeve hole behind it:
      // blend the forearm in across the middle half of the arm.
      await ramp(`arm_${s}`, `forearm_${s}`, `arm_${s}`, `forearm_${s}`, 0.25, 0.75);
      const after = await influences(`arm_${s}`);
      assert.ok(after.every((w) => w.every((n) => n === `arm_${s}` || n === `forearm_${s}`)), `arm_${s} mesh weighted only to arm_${s} / forearm_${s}`);
      const sh = boneOf(await project(), `arm_${s}`);
      const raise = s === 'r' ? 65 : -65;
      // Test pose: the target raised to the side and pulled in (the elbow must point down).
      log(await twoBoneIk(`forearm_${s}`, `arm_${s}`, 'chest', () => ({ x: r3(sh.x + 0.8 * L * Math.cos(raise * RAD)), y: r3(sh.y + 0.8 * L * Math.sin(raise * RAD)) }), { x: 0, y: 1 }));
    }

    // Sleeve holes follow the chest: rebind and shift by the chest offset (300).
    for (const s of ['l', 'r']) {
      const before = await probe<Pt>(page, 'attachment', `sleeve_hole_${s}`);
      await page.getByTestId(`tree-att-sleeve_hole_${s}`).click();
      const a = attOf(await project(), `sleeve_hole_${s}`);
      await page.getByTestId('att-bone').selectOption({ label: 'chest' });
      await fill('att-x', a.x - 300);
      const after = await probe<Pt>(page, 'attachment', `sleeve_hole_${s}`);
      assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 0.01, `sleeve_hole_${s} keeps its place`);
    }
    log('sleeve holes: rebound to chest (Attachment bone) with X − 300; placement unchanged');

    // ---- Legs: under body, split at the knee, meshed, IK on the ground, foot on the target --
    for (const s of ['l', 'r'] as const) {
      await reparent(`leg_${s}`, 'body');
      await setBone(`leg_${s}`, { length: 102 });
      await addBone(`leg_${s}`, `shin_${s}`, { length: 102 });
      log(`leg_${s}: under body; split at the knee: leg_${s} 102 → shin_${s} 102 (ankle 4 px below the v2 bone tip)`);
      log(`leg_${s} mesh: ${await gridMesh(`leg_${s}`, 4, 10)}`);
      // Test pose: the target 30 px up; the knee must point outward.
      log(await twoBoneIk(`shin_${s}`, `leg_${s}`, null, (t) => ({ x: r3(t.x + 30), y: t.y }), { x: s === 'l' ? -1 : 1, y: 0 }));
      await addBone(`shin_${s}-target`, `foot_${s}`, { rotation: 180, length: 120 });
      const pts = await points(`leg_${s}`);
      await paint(`leg_${s}`, `foot_${s}`, pts.map((v, i) => [v, i] as const).filter(([v]) => v.y >= 225).map(([, i]) => i));
      const inf = await influences(`leg_${s}`);
      for (const [i, v] of pts.entries()) {
        if (v.y >= 225) assert.deepEqual(inf[i], [`foot_${s}`], `leg_${s} vertex ${i} (shoe) rigid to foot_${s}`);
        else assert.ok(inf[i].every((n) => n === `leg_${s}` || n === `shin_${s}`), `leg_${s} vertex ${i} on the thigh/shin`);
      }
      log(`foot_${s}: child of shin_${s}-target; shoe vertices (image y ≥ 225) painted to it`);
    }
    await page.getByTestId('frame-all').click();
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(V3_OUT, 'editor-rig-v3.png') });
    {
      const p = await project();
      log(`rig: ${p.bones.length} bones, ${p.ik.length} IK, meshes ${p.attachments.filter((a: any) => a.mesh).map((a: any) => `${a.name} ${a.mesh.points.length / 2}v`).join(', ')}`);
    }
    if (STOP === 'rig') {
      const save = page.waitForEvent('download');
      await page.getByTestId('save-project').click();
      await (await save).saveAs(path.join(V3_OUT, 'scratch-rig.rig.json'));
      return;
    }

    // ---- Animations: the frames of v2 idle / greeting-v2 (provisional timing, RV-011) ---
    const p0 = await project();
    const S = (n: string) => boneOf(p0, n);
    const body = S('body');
    const up = (d: number): number[] => [body.x + d, body.y];
    const chest = (d: number): number[] => [S('chest').x + d, S('chest').y];
    // IK target in chest space: the v2 arm direction θ (body frame = chest frame), reach k × arm length
    // (θ null = the setup target). Translation keys interpolate the target along a straight
    // chord, which pulls it toward the shoulder between distant angles and folds the elbow;
    // where two keys are more than 40° apart an in-between on the arc is added at the middle frame.
    const arm = (s: 'l' | 'r', list: [number, number | null, number?][]): K[] => {
      const a = S(`arm_${s}`), t = S(`forearm_${s}-target`);
      const L = a.length + S(`forearm_${s}`).length;
      const polar = ([f, th, k]: [number, number | null, number?]): [number, number, number] =>
        th === null ? [f, Math.atan2(t.y - a.y, t.x - a.x) / RAD, Math.hypot(t.x - a.x, t.y - a.y) / L] : [f, th, k ?? 1];
      const keys = list.map(polar);
      const out: [number, number, number][] = [];
      keys.forEach((key, i) => {
        const next = keys[i + 1];
        out.push(key);
        if (next && Math.abs(next[1] - key[1]) > 40) out.push([Math.round((key[0] + next[0]) / 2), (key[1] + next[1]) / 2, (key[2] + next[2]) / 2]);
      });
      if (out.length > keys.length) log(`  forearm_${s}-target arc in-betweens at ${out.filter((o) => !list.some((x) => x[0] === o[0])).map(([f, th, k]) => `f${f} (${r3(th)}°, ${r3(k)})`).join(", ")}`);
      return out.map(([f, th, k]): K => {
        const src = list.find((x) => x[0] === f);
        const v = src && src[1] === null ? [t.x, t.y] : [a.x + k * L * Math.cos(th * RAD), a.y + k * L * Math.sin(th * RAD)];
        return [`forearm_${s}-target`, 'translate', f, v];
      });
    };
    // Ground target in root space (x up, y to screen right); `out` is away from the body.
    const foot = (s: 'l' | 'r', lift = 0, out = 0): number[] => {
      const t = S(`shin_${s}-target`);
      return [t.x + lift, t.y + (s === 'l' ? -out : out)];
    };
    const IDLE: K[] = [
      ['body', 'rotate', 0, [0.8]], ['body', 'rotate', 45, [-0.8]],
      ['body', 'translate', 0, up(0)], ['body', 'translate', 45, up(-2)],
      ['hips', 'scale', 0, [1, 1]], ['hips', 'scale', 45, [1.02, 0.99]],
      ['chest', 'translate', 0, chest(0)], ['chest', 'translate', 45, chest(6)],
      ['head', 'rotate', 0, [0]], ['head', 'rotate', 50, [-2]],
      ...arm('l', [[0, null], [40, -140.15, 0.96]]),
      ...arm('r', [[0, null], [50, 141.26, 0.96]]),
      ['hand_l', 'rotate', 0, [0]], ['hand_l', 'rotate', 52, [7]],
      ['hand_r', 'rotate', 0, [0]], ['hand_r', 'rotate', 62, [-7]],
    ];
    const GREET: K[] = [
      // Hop on body (the legs bend on the ground targets), squash on hips with the chest
      // lowered by the same amount (the face keeps its shape), lean on body.
      ['body', 'translate', 0, up(0)], ['body', 'translate', 4, up(-6)], ['body', 'translate', 10, up(40)], ['body', 'translate', 15, up(-8)], ['body', 'translate', 21, up(0)],
      ['body', 'rotate', 0, [0]], ['body', 'rotate', 12, [3.5]], ['body', 'rotate', 46, [3.5]], ['body', 'rotate', 60, [0]],
      ['hips', 'scale', 0, [1, 1]], ['hips', 'scale', 4, [0.94, 1.04]], ['hips', 'scale', 8, [1.05, 0.97]], ['hips', 'scale', 15, [0.95, 1.03]], ['hips', 'scale', 21, [1, 1]],
      ['chest', 'translate', 0, chest(0)], ['chest', 'translate', 4, chest(-18)], ['chest', 'translate', 8, chest(15)], ['chest', 'translate', 15, chest(-15)], ['chest', 'translate', 21, chest(0)],
      // The head leads: nods into the dip, looks up at the apex, tilts toward the wave.
      ['head', 'rotate', 0, [0]], ['head', 'rotate', 4, [4]], ['head', 'rotate', 10, [-5]], ['head', 'rotate', 18, [6]], ['head', 'rotate', 46, [6]], ['head', 'rotate', 60, [0]],
      // Shoes stay on the ground through the dip and the landing, tuck and splay in the air.
      ['shin_l-target', 'translate', 0, foot('l')], ['shin_l-target', 'translate', 6, foot('l')], ['shin_l-target', 'translate', 10, foot('l', 28, 22)], ['shin_l-target', 'translate', 15, foot('l')],
      ['shin_r-target', 'translate', 0, foot('r')], ['shin_r-target', 'translate', 6, foot('r')], ['shin_r-target', 'translate', 10, foot('r', 28, 22)], ['shin_r-target', 'translate', 15, foot('r')],
      ['foot_l', 'rotate', 0, [180]], ['foot_l', 'rotate', 6, [180]], ['foot_l', 'rotate', 10, [188]], ['foot_l', 'rotate', 15, [180]],
      ['foot_r', 'rotate', 0, [180]], ['foot_r', 'rotate', 6, [180]], ['foot_r', 'rotate', 10, [172]], ['foot_r', 'rotate', 15, [180]],
      // Wave: the greeting-v2 arm angles, reached with a bent elbow (0.88–0.92 of the arm).
      ...arm('r', [[0, null], [8, 159.26, 0.97], [18, 65.27, 0.88], [24, 77.27, 0.92], [30, 61.27, 0.88], [36, 77.27, 0.92], [42, 61.27, 0.88], [48, 69.27, 0.9], [62, null]]),
      ['hand_r', 'rotate', 0, [0]], ['hand_r', 'rotate', 10, [6]], ['hand_r', 'rotate', 21, [18]], ['hand_r', 'rotate', 27, [-24]], ['hand_r', 'rotate', 33, [20]],
      ['hand_r', 'rotate', 39, [-24]], ['hand_r', 'rotate', 45, [20]], ['hand_r', 'rotate', 51, [-8]], ['hand_r', 'rotate', 66, [0]],
      ...arm('l', [[0, null], [8, -150.15, 0.98], [16, -128.15, 0.93], [48, -136.15, 0.95], [62, null]]),
      ['hand_l', 'rotate', 0, [0]], ['hand_l', 'rotate', 12, [-6]], ['hand_l', 'rotate', 22, [14]], ['hand_l', 'rotate', 50, [10]], ['hand_l', 'rotate', 66, [0]],
    ];
    const GREET_CURVES: [string, Ch, number, string][] = [
      ['body', 'translate', 4, 'ease-out'], ['body', 'translate', 10, 'ease-in'],
      ['hips', 'scale', 15, 'overshoot'], ['chest', 'translate', 15, 'overshoot'],
      ['forearm_r-target', 'translate', 8, 'overshoot'], ['forearm_r-target', 'translate', 48, 'overshoot'],
      ['forearm_l-target', 'translate', 8, 'overshoot'],
      ['hand_r', 'rotate', 21, 'back-in-out'], ['hand_r', 'rotate', 51, 'overshoot'], ['hand_l', 'rotate', 12, 'back-in-out'],
    ];
    for (const [name, dur, keys, crv] of [['idle-v3', 3, IDLE, []], ['greeting-v3', 2.4, GREET, GREET_CURVES]] as const) {
      await newAnimation(name, dur, 30);
      await typeKeys(keys as K[], Math.round(dur * 30), 30);
      await curves(crv as [string, Ch, number, string][]);
      log(`${name}: ${keys.length} keys typed in the inspector at ${new Set(keys.map((k) => k[2])).size} frames; Ctrl+A → smooth; ${crv.length} curve presets; Close loop: ${await page.getByTestId('status').textContent()}`);
    }

    // ---- Delivery frame -------------------------------------------------------------------
    await page.keyboard.press('Escape');
    await page.getByTestId('stage').click({ position: { x: 5, y: 5 } });
    await page.getByTestId('frame-fit').click();
    const frame = (await project()).frame;
    log(`project frame: Set frame: fit to all animations → ${frame.width}×${frame.height} at (${frame.x}, ${frame.y})`);


    // ---- Exports through the dialogs, at the project frame ----------------------------------
    await page.getByTestId('show-bones').uncheck();
    for (const anim of ['idle-v3', 'greeting-v3']) {
      for (const [format, ext] of [['zip', 'seq.zip'], ['apng', 'apng']] as const) {
        await page.getByTestId('export-sequence').click();
        await page.getByTestId('seq-anim').selectOption({ label: anim });
        assert.equal(await page.getByTestId('seq-frame').inputValue(), 'project');
        await page.getByTestId('seq-format').selectOption(format);
        assert.equal(await page.getByTestId('seq-frame-warning').count(), 0, `${anim}: no clipping warning`);
        await download('seq-export', `${anim}.${ext}`);
      }
    }
    await page.getByTestId('mix-open').click();
    await page.getByTestId('mix-from').selectOption({ label: 'idle-v3' });
    await page.getByTestId('mix-to').selectOption({ label: 'greeting-v3' });
    await fill('mix-start', 1);
    await fill('mix-duration', 0.3);
    assert.equal(await page.getByTestId('mix-frame').inputValue(), 'project');
    assert.equal(await page.getByTestId('mix-frame-warning').count(), 0, 'mix: no clipping warning');
    await download('mix-export', 'idle-v3-to-greeting-v3.seq.zip');
    await page.getByTestId('mix-close').click();
    log('exports: idle-v3 / greeting-v3 PNG ZIP + APNG (Export sequence…), idle-v3 → greeting-v3 at 1 s over 0.3 s PNG ZIP (Mix…), all at the project frame, no clipping warnings');
    // Saved after the mix dialog: its duration is a project mix rule.
    const saveDl = page.waitForEvent('download');
    await page.getByTestId('save-project').click();
    await (await saveDl).saveAs(V3_FILE);
    const saved = JSON.parse(readFileSync(V3_FILE, 'utf8'));
    assert.deepEqual(saved, await project(), 'saved file = editor project');
    log(`saved v3-output/wiz-v3.rig.json (version ${saved.version}, sha256 ${sha(readFileSync(V3_FILE)).slice(0, 16)}…)`);
    await page.getByTestId('show-bones').check();
    await page.getByTestId('anim-select').selectOption({ label: 'greeting-v3' });
    await gotoFrame(18, 72, 30);
    await page.screenshot({ path: path.join(V3_OUT, 'editor-greeting-v3-f18.png') });
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    writeFileSync(path.join(V3_OUT, 'build-log.txt'), lines.join('\n') + '\n');
    assert.equal(sha(readFileSync(V2_FILE)), v2Sha, 'wiz-v2.rig.json unchanged');
    if (errors.length) log(`page errors: ${errors.join(' | ')}`);
    await ctx.close();
    server.kill();
  }
}

main().catch((e) => {
  log(`FAILED: ${(e as Error).stack}`);
  writeFileSync(path.join(V3_OUT, 'build-log.txt'), lines.join('\n') + '\n');
  process.exit(1);
});
