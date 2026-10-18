// Phase 4 — skins (attachment sets) and transition mixing, driven through visible
// controls only (window.__rigsmith is read-only: assertions). Skinned renders and every
// frame of exported transitions are compared with the independent reference rasterizer;
// transition poses are derived here from the mix formula, not from the editor.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { decodePng } from '../support/png-decode.ts';
import { encodePng } from '../support/png-encode.ts';
import { composite, decodeProjectImages, diffImages, worldsFromLocal } from '../support/reference-composite.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/p4-skins-mix');
mkdirSync(path.join(OUT, 'art'), { recursive: true });

/** Solid colour with a half-transparent 1 px rim (exercises edge filtering). */
function swatch(w: number, h: number, rgb: [number, number, number]): Buffer {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      d.set(rgb, o);
      d[o + 3] = x === 0 || y === 0 || x === w - 1 || y === h - 1 ? 128 : 255;
    }
  return encodePng(w, h, d);
}
const COLORS: Record<string, [number, number, number]> = { red: [220, 40, 40], blue: [40, 80, 230], green: [40, 200, 70], yellow: [240, 210, 30] };
const ART: Record<string, string> = {};
for (const [n, c] of Object.entries(COLORS)) writeFileSync((ART[n] = path.join(OUT, `art/${n}.png`)), swatch(40, 20, c));
writeFileSync((ART.wide = path.join(OUT, 'art/wide.png')), swatch(80, 20, [160, 60, 200]));

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const dialogs: string[] = [];
const report: string[] = [];
const state = () => probe<any>(page, 'state');
const project = () => probe<any>(page, 'project');
const imgId = async (name: string) => (await project()).images.find((i: any) => i.name === name).id;

async function setField(testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function gotoFrame(frame: number): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  const name = (await state()).animName;
  const anim = (await project()).animations.find((a: any) => a.name === name);
  const frames = Math.round(anim.duration * anim.fps);
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
}

type Img = { width: number; height: number; data: Uint8Array };

/** Exports one frame through the sequence dialog, optionally choosing a skin there. */
async function exportFrame(frame: number, file: string, skinLabel?: string) {
  await page.getByTestId('export-sequence').click();
  if (skinLabel) await page.getByTestId('seq-skin').selectOption({ label: skinLabel });
  for (const id of ['seq-start', 'seq-end']) await setField(id, frame);
  const dl = page.waitForEvent('download');
  await page.getByTestId('seq-export').click();
  const zip = path.join(OUT, file);
  await (await dl).saveAs(zip);
  await page.keyboard.press('Escape');
  const files = readZip(readFileSync(zip));
  return { meta: JSON.parse(files.find((x) => x.name.endsWith('sequence.json'))!.data.toString('utf8')), png: decodePng(files.find((x) => x.name.endsWith('.png'))!.data) as Img };
}

/** Mean colour of fully opaque pixels. */
function meanOpaque(im: Img): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < im.width * im.height; i++) {
    if (im.data[i * 4 + 3] !== 255) continue;
    r += im.data[i * 4];
    g += im.data[i * 4 + 1];
    b += im.data[i * 4 + 2];
    n++;
  }
  return [r / n, g / n, b / n].map(Math.round) as [number, number, number];
}
const near = (c: number[], target: number[]) => c.every((v, i) => Math.abs(v - target[i]) <= 3);

function check(name: string, got: Img, ref: Img, budget = { over: 0.01, mean: 1.5 }) {
  const d = diffImages(got, ref, 24);
  report.push(`${name}: max ${d.maxDiff} mean ${d.meanDiff.toFixed(3)} over24 ${d.over}/${d.covered}`);
  assert.ok(d.covered > 100, `${name}: something rendered`);
  assert.ok(d.over <= Math.ceil(d.covered * budget.over), `${name}: ${d.over} px over tolerance`);
  assert.ok(d.meanDiff <= budget.mean, `${name}: mean ${d.meanDiff}`);
}

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-p4-skins-mix');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.accept();
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
});

after(async () => {
  writeFileSync(path.join(OUT, 'report.txt'), report.join('\n') + '\n');
  await ctx?.close();
  server?.kill();
});

describe('skins', () => {
  it('builds a one-bone rig with an image key from visible controls', async () => {
    await page.getByTestId('image-input').setInputFiles([ART.red, ART.blue, ART.green, ART.yellow, ART.wide]);
    await page.getByTestId('image-wide.png').waitFor();
    await page.getByTestId('add-bone').click();
    await setField('bone-name', 'arm');
    await setField('bone-rotation', 0);
    await setField('bone-length', 60);
    await page.getByTestId('attach-red.png').click();
    await setField('att-x', 30);
    await page.getByTestId('new-animation').click();
    await setField('anim-name', 'swap');
    await page.getByTestId('mode-animate').click();
    await page.getByTestId('tree-att-red').click();
    await gotoFrame(15);
    await page.getByTestId('slot-image').selectOption({ label: 'green.png' });
    const an = (await project()).animations[0];
    const att = (await project()).attachments[0];
    assert.deepEqual(an.slots[att.id].image.map((k: any) => [Math.round(k.time * 30), k.imageId]), [[15, await imgId('green.png')]]);
    await page.getByTestId('mode-setup').click();
    assert.match(await page.getByTestId('skins-panel').innerText(), /No skins/);
  });

  it('creates a skin, renames it and maps the setup image and the keyed image', async () => {
    await page.getByTestId('skin-add').click();
    const s0 = await state();
    const p0 = await project();
    assert.equal(p0.skins.length, 1);
    assert.equal(s0.skinId, p0.skins[0].id, 'new skin becomes active');
    await setField('skin-name', 'blue-team');
    assert.equal((await project()).skins[0].name, 'blue-team');
    await page.getByTestId('tree-att-red').click();
    await page.getByTestId('skin-image').selectOption({ label: 'blue.png' });
    await page.getByTestId('skin-from-green.png').selectOption({ label: 'yellow.png' });
    const p = await project();
    const att = p.attachments[0];
    assert.deepEqual(p.skins[0].entries, [
      { attachmentId: att.id, imageId: await imgId('blue.png') },
      { attachmentId: att.id, imageId: await imgId('yellow.png'), from: await imgId('green.png') },
    ]);
    assert.equal(p.attachments[0].imageId, await imgId('red.png'), 'setup attachment untouched');
    assert.equal(await page.getByTestId('skin-summary').innerText(), '2 replacement(s) · 1 attachment(s)');
    assert.equal(await page.getByTestId('skin-diagnostics').innerText(), 'No issues found.');
  });

  it('renders the skin (setup + keyed image) like the reference; the export skin control changes pixels', async () => {
    const p = await project();
    const skinId = p.skins[0].id;
    const images = decodeProjectImages(p);
    for (const frame of [0, 15]) {
      const { meta, png } = await exportFrame(frame, `skin-f${frame}.zip`);
      const ref = composite(p, p.animations[0], frame / 30, images, meta.width, meta.height, meta.origin.x, meta.origin.y, meta.scale, undefined, skinId);
      check(`skin blue-team f${frame}`, png, ref);
      assert.ok(near(meanOpaque(png), frame === 0 ? COLORS.blue : COLORS.yellow), `f${frame} shows the skin image: ${meanOpaque(png)}`);
    }
    // The export dialog's skin control switches the editor's skin; pixels follow.
    const { meta, png } = await exportFrame(15, 'noskin-f15.zip', '(no skin)');
    assert.equal((await state()).skinId, null);
    const ref = composite(p, p.animations[0], 0.5, images, meta.width, meta.height, meta.origin.x, meta.origin.y, meta.scale);
    check('no skin f15', png, ref);
    assert.ok(near(meanOpaque(png), COLORS.green), `no skin shows the keyed image: ${meanOpaque(png)}`);
    await page.getByTestId('skin-active').selectOption({ label: 'blue-team' });
    assert.equal((await state()).skinId, skinId);
  });

  it('validates assets: aspect-ratio warning, sharing between skins, duplicate name rejected', async () => {
    await page.getByTestId('tree-att-red').click();
    await page.getByTestId('skin-image').selectOption({ label: 'wide.png' });
    assert.match(await page.getByTestId('skin-diagnostics').innerText(), /wide\.png \(80×20\) has a different aspect ratio from red\.png \(40×20\)/);
    await page.getByTestId('skin-image').selectOption({ label: 'blue.png' });
    assert.equal(await page.getByTestId('skin-diagnostics').innerText(), 'No issues found.');
    await page.getByTestId('skin-duplicate').click();
    const p = await project();
    assert.deepEqual(p.skins.map((s: any) => s.name), ['blue-team', 'blue-team-copy']);
    assert.equal((await state()).skinId, p.skins[1].id, 'the copy becomes active');
    assert.deepEqual(p.skins[1].entries, p.skins[0].entries);
    assert.match(await page.getByTestId('skin-diagnostics').innerText(), /blue\.png is shared by 2 skins \(safe: images are never modified\)/);
    await setField('skin-name', 'blue-team');
    assert.match(await page.getByTestId('error-toast').last().innerText(), /A skin named “blue-team” already exists/);
    assert.equal((await project()).skins[1].name, 'blue-team-copy');
    assert.equal(await page.getByTestId('skin-name').inputValue(), 'blue-team-copy');
  });

  it('delete + undo; removing a used image warns, drops the entries, and undoes', async () => {
    await page.getByTestId('skin-delete').click();
    assert.equal((await project()).skins.length, 1);
    assert.equal((await state()).skinId, null);
    await page.getByTestId('undo').click();
    assert.equal((await project()).skins.length, 2);
    await page.getByLabel('Remove yellow.png').click();
    assert.match(dialogs.at(-1)!, /“yellow\.png” is used by skin\(s\) blue-team, blue-team-copy/);
    const p = await project();
    assert.ok(!p.images.some((i: any) => i.name === 'yellow.png'));
    assert.ok(p.skins.every((s: any) => s.entries.length === 1 && !s.entries[0].from), 'keyed-image entries removed');
    await page.getByTestId('undo').click();
    assert.equal((await project()).skins[0].entries.length, 2);
  });

  it('save → reopen keeps skins (including keyed-image entries)', async () => {
    const before = await project();
    const dl = page.waitForEvent('download');
    await page.getByTestId('save-project').click();
    const file = path.join(OUT, 'skins.rig.json');
    await (await dl).saveAs(file);
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(disk.version, 2);
    assert.ok(disk.skins[0].entries.some((e: any) => e.from));
    await page.getByTestId('new-project').click();
    assert.equal((await project()).bones.length, 0);
    await page.getByTestId('open-input').setInputFiles(file);
    await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length > 0);
    assert.deepEqual((await project()).skins, before.skins);
  });
});

describe('transition mixing', () => {
  const T0 = 0.2, MIX = 0.4, FPS = 30;
  let arm: any;

  it('keys an "idle" (rotate 0, scale 1.5) and a "wave" (rotate 90 only) animation', async () => {
    await page.getByTestId('mode-setup').click();
    await page.getByTestId('skin-active').selectOption({ label: '(default images)' });
    await page.getByTestId('new-animation').click();
    await setField('anim-name', 'idle');
    await page.getByTestId('mode-animate').click();
    await page.getByTestId('tree-bone-arm').click();
    await gotoFrame(0);
    await page.getByTestId('key-toggle-rotate').click();
    await setField('bone-scale-x', 1.5);
    await page.getByTestId('new-animation').click();
    await setField('anim-name', 'wave');
    await page.getByTestId('mode-animate').click();
    await page.getByTestId('tree-bone-arm').click();
    await gotoFrame(0);
    await setField('bone-rotation', 90);
    const p = await project();
    arm = p.bones[0];
    const idle = p.animations.find((a: any) => a.name === 'idle'), wave = p.animations.find((a: any) => a.name === 'wave');
    assert.deepEqual(idle.tracks[arm.id].rotate.map((k: any) => k.value), [[0]]);
    assert.deepEqual(idle.tracks[arm.id].scale.map((k: any) => k.value), [[1.5, 1]]);
    assert.deepEqual(Object.entries(wave.tracks[arm.id]).filter(([, k]: any) => k.length).map(([ch]) => ch), ['rotate'], 'wave keys rotation only');
  });

  /** Independent pose: P_k = P_{k−1} + w_k (v_k − P_{k−1}), w_k = clamp((T − s_k)/m_k). */
  function refLocal(T: number, entries: { rot: number; sx: number | null; start: number; mix: number }[]) {
    let rot = entries[0].rot, sx = entries[0].sx ?? 1;
    for (const e of entries.slice(1)) {
      const w = Math.min(1, Math.max(0, (T - e.start) / e.mix));
      rot += w * (e.rot - rot);
      if (e.sx !== null) sx += w * (e.sx - sx);
    }
    return new Map([[arm.id, { x: arm.x, y: arm.y, rotation: rot, scaleX: sx, scaleY: 1 }]]);
  }

  async function exportMix(file: string) {
    const dl = page.waitForEvent('download');
    await page.getByTestId('mix-export').click();
    const zip = path.join(OUT, file);
    await (await dl).saveAs(zip);
    const files = readZip(readFileSync(zip));
    const meta = JSON.parse(files.find((x) => x.name.endsWith('sequence.json'))!.data.toString('utf8'));
    const pngs = files.filter((x) => x.name.endsWith('.png')).map((x) => decodePng(x.data) as Img);
    return { meta, pngs };
  }

  /** Angle (deg) of the opaque centroid around the bone origin, in pixels. */
  function angle(im: Img, meta: any): number {
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < im.width * im.height; i++)
      if (im.data[i * 4 + 3] === 255) {
        sx += (i % im.width) + 0.5;
        sy += Math.floor(i / im.width) + 0.5;
        n++;
      }
    const ox = (arm.x - meta.origin.x) * meta.scale, oy = (arm.y - meta.origin.y) * meta.scale;
    return (Math.atan2(sy / n - oy, sx / n - ox) * 180) / Math.PI;
  }

  function compareAll(name: string, meta: any, pngs: Img[], p: any, entries: Parameters<typeof refLocal>[1]) {
    const images = decodeProjectImages(p);
    const angles: number[] = [];
    pngs.forEach((png, i) => {
      const T = meta.frames[i].time;
      const ref = composite(p, null, 0, images, meta.width, meta.height, meta.origin.x, meta.origin.y, meta.scale, worldsFromLocal(p, refLocal(T, entries)));
      check(`${name} frame ${i} (T=${T.toFixed(3)})`, png, ref);
      angles.push(angle(png, meta));
    });
    return angles;
  }

  it('previews idle → wave: stored mix duration, scrubbing, weights, play, errors', async () => {
    await page.getByTestId('mix-open').click();
    await page.getByTestId('mix-dialog').waitFor();
    await page.getByTestId('mix-from').selectOption({ label: 'idle' });
    await page.getByTestId('mix-to').selectOption({ label: 'wave' });
    await setField('mix-start', T0);
    await setField('mix-duration', MIX);
    const p = await project();
    const idle = p.animations.find((a: any) => a.name === 'idle'), wave = p.animations.find((a: any) => a.name === 'wave');
    assert.deepEqual(p.mixes, [{ from: idle.id, to: wave.id, duration: MIX }], 'rule stored in the project');
    assert.match(await page.getByTestId('mix-rules').innerText(), /idle → wave: 0\.4 s/);
    // 0.2 s switch + max(0.4 s mix, 1 s wave) = 1.2 s → 37 frames.
    assert.match(await page.getByTestId('mix-summary').innerText(), /^37 frames · \d+×\d+ px · transparent$/);
    await page.getByTestId('mix-time').fill('12');
    assert.equal(await page.getByTestId('mix-time-label').innerText(), 'frame 12 · 0.400 s');
    assert.equal(await page.getByTestId('mix-weights').innerText(), 'idle 50% · wave 50%');
    assert.equal(await page.getByTestId('mix-canvas').getAttribute('data-time'), '0.4');
    await page.getByTestId('mix-time').fill('0');
    await page.getByTestId('mix-play').click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="mix-time"]') as HTMLInputElement).valueAsNumber > 3);
    await page.getByTestId('mix-play').click();
    const paused = await page.getByTestId('mix-time-label').innerText();
    assert.ok(!/^frame 0 /.test(paused), `playback advanced: ${paused}`);
    await setField('mix-fps', 0);
    assert.match(await page.getByTestId('mix-errors').innerText(), /FPS must be a whole number/);
    assert.ok(await page.getByTestId('mix-export').isDisabled());
    await setField('mix-fps', FPS);
    assert.equal(await page.getByTestId('mix-errors').count(), 0);
  });

  it('exported transition matches the independently blended pose on every frame (missing scale → setup)', async () => {
    const { meta, pngs } = await exportMix('idle-to-wave.zip');
    assert.equal(meta.animation, 'idle-to-wave');
    assert.equal(pngs.length, 37);
    const p = await project();
    const angles = compareAll('setup policy', meta, pngs, p, [{ rot: 0, sx: 1.5, start: 0, mix: 0 }, { rot: 90, sx: 1, start: T0, mix: MIX }]);
    // Starts exactly at idle and ends exactly at wave.
    assert.ok(Math.abs(angles[0]) < 1 && Math.abs(angles.at(-1)! - 90) < 1, `${angles[0]} … ${angles.at(-1)}`);
    report.push(`setup policy angles: ${angles.map((a) => a.toFixed(1)).join(' ')}`);
  });

  it('"keep the previous pose" holds channels the incoming animation does not key', async () => {
    await page.getByTestId('mix-missing').selectOption('hold');
    const { meta, pngs } = await exportMix('idle-to-wave-hold.zip');
    compareAll('hold policy', meta, pngs, await project(), [{ rot: 0, sx: 1.5, start: 0, mix: 0 }, { rot: 90, sx: null, start: T0, mix: MIX }]);
    await page.getByTestId('mix-missing').selectOption('setup');
  });

  it('an interruption mid-blend continues from the blended pose (no jump)', async () => {
    const AT = 0.4, MIX2 = 0.4;
    await page.getByTestId('mix-interrupt').check();
    await page.getByTestId('mix-interrupt-anim').selectOption({ label: 'idle' });
    await setField('mix-interrupt-at', AT);
    await setField('mix-interrupt-duration', MIX2);
    await page.getByTestId('mix-time').fill('12');
    assert.equal(await page.getByTestId('mix-weights').innerText(), 'idle 50% · wave 50% · idle 0%');
    const { meta, pngs } = await exportMix('interrupted.zip');
    assert.equal(meta.animation, 'idle-to-wave-to-idle');
    assert.equal(pngs.length, Math.floor((AT + 1) * FPS) + 1);
    const angles = compareAll('interrupted', meta, pngs, await project(), [{ rot: 0, sx: 1.5, start: 0, mix: 0 }, { rot: 90, sx: 1, start: T0, mix: MIX }, { rot: 0, sx: 1.5, start: AT, mix: MIX2 }]);
    const steps = angles.slice(1).map((a, i) => Math.abs(a - angles[i]));
    report.push(`interrupted angles: ${angles.map((a) => a.toFixed(1)).join(' ')}; max step ${Math.max(...steps).toFixed(2)}°`);
    // A cut at the interruption would jump 45°; the blend never moves more than a few degrees a frame.
    assert.ok(Math.max(...steps) < 8, `max per-frame step ${Math.max(...steps)}`);
    // Peak of 90·w1·(1 − w2) is at T = 0.5: 90 · 0.75 · 0.75 = 50.6° — it never reaches wave.
    assert.ok(Math.abs(Math.max(...angles) - 50.625) < 2, `peak ${Math.max(...angles)}`);
    await page.getByTestId('mix-interrupt').uncheck();
  });

  it('removes a stored rule; undo restores it; close', async () => {
    await page.getByTestId('mix-rule-delete-idle-wave').click();
    assert.deepEqual((await project()).mixes ?? [], []);
    assert.equal(await page.getByTestId('mix-duration').inputValue(), '0.2');
    assert.match(await page.getByTestId('mix-rules').innerText(), /None: every pair uses 0\.2 s/);
    await page.getByTestId('mix-close').click();
    await page.getByTestId('mix-dialog').waitFor({ state: 'hidden' });
    await page.getByTestId('undo').click();
    assert.equal((await project()).mixes[0].duration, MIX);
    await page.getByTestId('mix-open').click();
    assert.match(await page.getByTestId('mix-rules').innerText(), /0\.4 s/);
    assert.equal(await page.getByTestId('mix-progress').count(), 1);
    assert.equal(await page.getByTestId('mix-progress-text').count(), 1);
    await page.getByTestId('mix-close').click();
    assert.deepEqual(pageErrors, []);
  });
});
