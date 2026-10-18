// Phase 4 — runtime v2 + atlas consumed by the reference player (dist/player.html).
// The editor opens a rig using every runtime feature (bezier keys, IK + keyed mix, path
// constraint, weighted mesh + deform, slot/draw-order keys, skin, mix rule), exports
// runtime JSON, atlases and PNG sequences through visible controls; the player loads
// only the runtime JSON + atlas files through its own file control. Every sampled frame
// is compared: player canvas vs editor export (pixels), player pose vs the runtime's
// baked editor data (numbers). Atlas bleed 0 vs 1 is measured, not assumed.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { serializeProject } from '../../src/model/format.ts';
import { decodePng } from '../support/png-decode.ts';
import type { Decoded } from '../support/png-decode.ts';
import { boneWorlds, composite, decodeProjectImages, diffImages } from '../support/reference-composite.ts';
import type { M } from '../support/reference-composite.ts';
import { richProject } from '../support/runtime-fixture.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, launchIsolated, pickPort, startPreview } from './harness.ts';

/** Read-only player probe (window.__rigsmithPlayer), assertions only. */
const playerProbe = <T>(page: Page, fn: 'state' | 'frame'): Promise<T> => page.evaluate((f) => (window as any).__rigsmithPlayer[f](), fn);

const OUT = path.join(EVIDENCE, 'roadmap/p4-player');
mkdirSync(OUT, { recursive: true });
const RIG = path.join(OUT, 'runtime-rig.rig.json');
const fixture = richProject();
writeFileSync(RIG, serializeProject(fixture));
// The same images as loose files (for the no-atlas path).
const LOOSE = path.join(OUT, 'loose');
mkdirSync(LOOSE, { recursive: true });
const loosePaths = fixture.images.map((im) => {
  const f = path.join(LOOSE, im.name);
  writeFileSync(f, Buffer.from(im.dataUrl.split(',')[1], 'base64'));
  return f;
});

let server: ChildProcess;
let ctx: BrowserContext;
let editor: Page;
let player: Page;
let base: string;
const pageErrors: string[] = [];
const report: string[] = [];
const files: Record<string, string> = {};

async function setField(page: Page, testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function download(page: Page, testId: string, file: string): Promise<string> {
  const dl = page.waitForEvent('download');
  await page.getByTestId(testId).click();
  const target = path.join(OUT, file);
  await (await dl).saveAs(target);
  return target;
}

/** Unzips an atlas into its own folder; returns [atlas json, ...pages]. */
function unpackAtlas(zipPath: string, dir: string): string[] {
  const d = path.join(OUT, dir);
  mkdirSync(d, { recursive: true });
  return readZip(readFileSync(zipPath)).map((f) => {
    const p = path.join(d, path.basename(f.name));
    writeFileSync(p, f.data);
    return p;
  }).sort((a, b) => (a.endsWith('.json') ? -1 : b.endsWith('.json') ? 1 : 0));
}

function sequence(zipPath: string) {
  const fs = readZip(readFileSync(zipPath));
  const meta = JSON.parse(fs.find((x) => x.name.endsWith('sequence.json'))!.data.toString('utf8'));
  const pngs = meta.frames.map((fr: any) => decodePng(fs.find((x) => x.name === fr.file)!.data)) as Decoded[];
  return { meta, pngs };
}

async function playerCanvas(): Promise<{ img: Decoded; ox: number; oy: number; scale: number; frame: number }> {
  const c = player.getByTestId('player-canvas');
  const url = await c.evaluate((el: HTMLCanvasElement) => el.toDataURL('image/png'));
  const d = (k: string) => c.getAttribute(`data-${k}`).then(Number);
  return { img: decodePng(Buffer.from(url.split(',')[1], 'base64')), ox: await d('ox'), oy: await d('oy'), scale: await d('scale'), frame: await d('frame') };
}

async function loadPlayer(paths: string[]): Promise<void> {
  await player.getByTestId('player-files').setInputFiles(paths);
  await player.waitForFunction(() => {
    const s = document.querySelector('[data-testid="player-status"]')!.textContent!;
    const e = document.querySelector('[data-testid="player-errors"]') as HTMLElement;
    return s !== 'Loading…' && (s.startsWith('Loaded') || !e.hidden);
  });
}

/** Steps the player through every frame and diffs against the editor export (differing pixels are listed in the report). */
async function compareAll(name: string, seq: { meta: any; pngs: Decoded[] }, budget = { over: 0, mean: 0.5 }) {
  let over = 0, worstMean = 0, worstMax = 0;
  for (let i = 0; i < seq.pngs.length; i++) {
    await player.getByTestId('player-time').fill(String(i));
    const got = await playerCanvas();
    assert.equal(got.frame, seq.meta.frames[i].frame, `${name}: frame number`);
    assert.deepEqual([got.ox, got.oy, got.scale], [seq.meta.origin.x, seq.meta.origin.y, seq.meta.scale], `${name}: same canvas geometry as the editor export`);
    const d = diffImages(got.img, seq.pngs[i], 24);
    if (d.over) {
      const a = got.img.data, b = seq.pngs[i].data, w = got.img.width;
      const where: string[] = [];
      for (let k = 0; k < a.length; k += 4) {
        const worst = Math.max(Math.abs(a[k + 3] - b[k + 3]), ...[0, 1, 2].map((c) => Math.abs((a[k + c] * a[k + 3]) / 255 - (b[k + c] * b[k + 3]) / 255)));
        if (worst > 24) where.push(`(${(k / 4) % w},${Math.floor(k / 4 / w)}) player ${[...a.subarray(k, k + 4)]} editor ${[...b.subarray(k, k + 4)]}`);
      }
      report.push(`  ${name} frame ${i}: ${where.join('; ')}`);
    }
    over += d.over;
    worstMean = Math.max(worstMean, d.meanDiff);
    worstMax = Math.max(worstMax, d.maxDiff);
  }
  report.push(`${name}: ${seq.pngs.length} frames, ${over} px over tolerance 24 in total, worst mean ${worstMean.toFixed(3)}, worst max ${worstMax}`);
  assert.ok(over <= budget.over, `${name}: ${over} px over tolerance`);
  assert.ok(worstMean <= budget.mean, `${name}: mean ${worstMean}`);
  return { over, worstMean, worstMax };
}

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  base = `http://127.0.0.1:${port}/`;
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-p4-player');
  editor = await ctx.newPage();
  editor.on('pageerror', (e) => pageErrors.push(`editor: ${e.message}`));
  editor.on('dialog', (d) => void d.accept());
  await editor.goto(base);
  await editor.getByTestId('empty-stage').waitFor({ state: 'visible' });
  player = await ctx.newPage();
  player.on('pageerror', (e) => pageErrors.push(`player: ${e.message}`));
  await player.goto(`${base}player.html`);
  await player.getByTestId('player-files').waitFor({ state: 'attached' });
});

after(async () => {
  writeFileSync(path.join(OUT, 'report.txt'), report.join('\n') + '\n');
  await ctx?.close();
  server?.kill();
});

describe('editor exports (visible controls)', () => {
  it('opens the rig and exports runtime v2 JSON', async () => {
    await editor.getByTestId('open-input').setInputFiles(RIG);
    await editor.waitForFunction(() => (window as any).__rigsmith.project().bones.length > 0);
    files.runtime = await download(editor, 'export-runtime', 'runtime-rig.runtime.json');
    const rt = JSON.parse(readFileSync(files.runtime, 'utf8'));
    assert.equal(rt.format, 'rigsmith.runtime');
    assert.equal(rt.version, 2);
    assert.deepEqual(rt.skins.map((s: any) => s.name), ['alt']);
  });

  it('exports atlases (default bleed 1, bleed 0, padding 0)', async () => {
    const variant = async (file: string, padding: number, bleed: number) => {
      await editor.getByTestId('export-atlas').click();
      await editor.getByTestId('atlas-dialog').waitFor();
      await setField(editor, 'atlas-padding', padding);
      await setField(editor, 'atlas-bleed', bleed);
      const z = await download(editor, 'atlas-export', file);
      await editor.getByTestId('atlas-cancel').click();
      return z;
    };
    files.atlas1 = await variant('atlas-p2-b1.zip', 2, 1);
    files.atlas0 = await variant('atlas-p2-b0.zip', 2, 0);
    files.atlasTight = await variant('atlas-p0-b0.zip', 0, 0);
    files.atlas2 = await variant('atlas-p4-b2.zip', 4, 2);
  });

  it('exports the reference sequences: wave, wave with the skin, and the wave → rest transition', async () => {
    const seq = async (file: string, skin: string) => {
      await editor.getByTestId('export-sequence').click();
      await editor.getByTestId('seq-anim').selectOption({ label: 'wave' });
      await editor.getByTestId('seq-skin').selectOption({ label: skin });
      const z = await download(editor, 'seq-export', file);
      await editor.getByTestId('export-dialog').waitFor({ state: 'hidden' });
      return z;
    };
    files.wave = await seq('wave.zip', '(no skin)');
    files.waveAlt = await seq('wave-alt.zip', 'alt');
    await editor.getByTestId('skin-active').selectOption({ label: '(default images)' });
    await editor.getByTestId('mix-open').click();
    await editor.getByTestId('mix-from').selectOption({ label: 'wave' });
    await editor.getByTestId('mix-to').selectOption({ label: 'rest' });
    await setField(editor, 'mix-start', 0.5);
    assert.equal(await editor.getByTestId('mix-duration').inputValue(), '0.3', 'stored rule');
    files.mix = await download(editor, 'mix-export', 'wave-to-rest.zip');
    await editor.getByTestId('mix-close').click();
    assert.equal(sequence(files.wave).pngs.length, 30);
  });
});

describe('reference player', () => {
  it('loads runtime + atlas through its file control', async () => {
    await loadPlayer([files.runtime, ...unpackAtlas(files.atlas1, 'atlas-p2-b1')]);
    const status = await player.getByTestId('player-status').innerText();
    report.push(status);
    assert.match(status, /^Loaded “runtime-rig” \(runtime v2\): 9 bones, 6 attachments, 2 animation\(s\), atlas with 7 region\(s\) on 1 page\(s\)\.$/);
    assert.deepEqual(await player.locator('[data-testid="player-anim"] option').allInnerTexts(), ['wave', 'rest']);
    assert.deepEqual(await player.locator('[data-testid="player-skin"] option').allInnerTexts(), ['(default)', 'alt']);
  });

  it('every frame of wave matches the editor pixels; poses and mesh vertices match the editor-baked runtime data', async () => {
    await compareAll('wave via atlas (padding 2, bleed 1)', sequence(files.wave));
    const rt = JSON.parse(readFileSync(files.runtime, 'utf8'));
    const an = rt.animations[0];
    let worst = 0;
    for (const i of [0, 7, 13, 21, 29]) {
      await player.getByTestId('player-time').fill(String(i));
      const fr = await playerProbe<any>(player, 'frame');
      for (const [bone, rows] of Object.entries<number[][]>(an.baked)) {
        const m = fr.bones[bone];
        worst = Math.max(worst, Math.abs(m.tx - rows[i][0]), Math.abs(m.ty - rows[i][1]));
        const rot = (Math.atan2(m.b, m.a) * 180) / Math.PI;
        worst = Math.max(worst, Math.abs(((rot - rows[i][2] + 540) % 360) - 180));
      }
      const band = fr.attachments.find((a: any) => a.name === 'band').vertices;
      band.forEach((v: number, k: number) => (worst = Math.max(worst, Math.abs(v - an.bakedMeshes.band[i][k]))));
      const slots = an.bakedSlots[i];
      assert.deepEqual(fr.attachments.map((a: any) => [a.name, a.visible, a.image]), slots.map((s: any) => [s.attachment, s.visible, s.image]), `slot state f${i}`);
    }
    report.push(`player pose vs editor-baked runtime data: max |Δ| ${worst.toExponential(2)} (px / deg)`);
    assert.ok(worst < 2e-3, `max difference ${worst}`);
  });

  // Review DRW-006: the checks above compare the player with the editor, and both use
  // src/model. Here the pixels come from tests/support/reference-composite.ts, which
  // imports nothing from src/: it does its own keyframe sampling (bezier included), bone
  // hierarchy, slot/draw-order rules, mesh skinning + deform and compositing. It does
  // not solve IK or path constraints, so only the constraint-driven bones (and their
  // descendants) take their world pose from the runtime file's baked rows — that part
  // stays the exporter's (shared-model) output. Baked rows hold no shear, so they are
  // used only for bones whose own world pose has none.
  it('every frame of wave matches an independent renderer; only IK/path bones come from the runtime’s baked rows (review DRW-006)', async () => {
    const rt = JSON.parse(readFileSync(files.runtime, 'utf8'));
    const an = rt.animations.find((a: any) => a.name === 'wave');
    const anim = fixture.animations.find((a) => a.name === 'wave')!;
    const nameOf = new Map(fixture.bones.map((b) => [b.id, b.name]));
    const driven = new Set<string>([...(fixture.ik ?? []).flatMap((k) => k.bones), ...(fixture.pathConstraints ?? []).flatMap((k) => k.bones)]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const b of fixture.bones) if (b.parentId && driven.has(b.parentId) && !driven.has(b.id)) grew = !!driven.add(b.id);
    }
    assert.deepEqual([...driven].sort(), ['f1', 'f2', 'lower', 'upper'], 'constraint-driven bones of the fixture');
    const images = decodeProjectImages(fixture);
    // A strict mismatch is a solid-vs-clear pixel or a colour difference where both are
    // opaque; the rest are anti-aliased edge coverages (the reference subsamples 4×4,
    // the canvas clips analytically), which a deformed mesh outline has many of.
    const strictCount = (a: Uint8Array, b: Uint8Array): number => {
      let n = 0;
      for (let k = 0; k < a.length; k += 4) {
        const dc = Math.max(...[0, 1, 2].map((c) => Math.abs((a[k + c] * a[k + 3]) / 255 - (b[k + c] * b[k + 3]) / 255)));
        const solidVsClear = Math.max(a[k + 3], b[k + 3]) >= 224 && Math.min(a[k + 3], b[k + 3]) <= 31;
        if (solidVsClear || (a[k + 3] === 255 && b[k + 3] === 255 && dc > 24)) n++;
      }
      return n;
    };
    let over = 0, strict = 0, worstMean = 0, worstEdge = 0, controlStrict = 0, freeWorst = 0;
    for (let i = 0; i < 30; i++) {
      await player.getByTestId('player-time').fill(String(i));
      const got = await playerCanvas();
      const t = got.frame / an.fps;
      const own = boneWorlds(fixture, anim, t);
      const worlds = new Map(own);
      for (const id of driven) {
        const [x, y, deg, sx, sy] = an.baked[nameOf.get(id)!][i];
        const r = (deg * Math.PI) / 180;
        worlds.set(id, [Math.cos(r) * sx, Math.sin(r) * sx, -Math.sin(r) * sy, Math.cos(r) * sy, x, y]);
      }
      // Unconstrained bones: the reference's own pose agrees with the baked position.
      for (const [id, m] of own) if (!driven.has(id)) {
        const row = an.baked[nameOf.get(id)!][i];
        freeWorst = Math.max(freeWorst, Math.abs(m[4] - row[0]), Math.abs(m[5] - row[1]));
      }
      const view = [got.img.width, got.img.height, got.ox, got.oy, got.scale] as const;
      const ref = composite(fixture, anim, t, images, ...view, worlds);
      const d = diffImages(got.img, ref, 24);
      const s = strictCount(got.img.data, ref.data);
      over += d.over;
      strict += s;
      worstMean = Math.max(worstMean, d.meanDiff);
      worstEdge = Math.max(worstEdge, (d.over - s) / d.covered);
      // Control: the same renderer without the constrained poses must not match.
      controlStrict += strictCount(got.img.data, composite(fixture, anim, t, images, ...view, own).data);
    }
    report.push(`DRW-006 player vs independent reference (IK/path bones from baked rows): 30 frames, ${over} px over tolerance 24 of which ${strict} strict (solid vs clear or opaque colour), worst edge-coverage share ${(worstEdge * 100).toFixed(2)}% of covered px, worst mean ${worstMean.toFixed(3)}; unconstrained bones vs baked max |Δ| ${freeWorst.toExponential(2)} px; control without constraints: ${controlStrict} strict px`);
    assert.ok(freeWorst < 2e-3, `unconstrained bones differ by ${freeWorst}`);
    assert.ok(strict <= 30, `${strict} strict mismatches`);
    assert.ok(worstEdge <= 0.04, `edge-coverage share ${worstEdge}`);
    assert.ok(worstMean <= 0.5, `mean ${worstMean}`);
    assert.ok(controlStrict > 100 * Math.max(1, strict), 'the comparison can tell an unconstrained pose apart');
  });

  it('the skin and the stored transition match the editor', async () => {
    await player.getByTestId('player-skin').selectOption({ label: 'alt' });
    await compareAll('wave with skin alt', sequence(files.waveAlt));
    await player.getByTestId('player-skin').selectOption({ label: '(default)' });
    await setField(player, 'player-mix-at', 0.5);
    await player.getByTestId('player-mix-to').selectOption({ label: 'rest' });
    const mix = sequence(files.mix);
    assert.equal(mix.meta.animation, 'wave-to-rest');
    await compareAll('wave → rest transition (0.3 s stored mix)', mix);
    await player.getByTestId('player-mix-to').selectOption({ label: '(none)' });
  });

  it('play advances and pauses', async () => {
    await player.getByTestId('player-time').fill('0');
    await player.getByTestId('player-play').click();
    await player.waitForFunction(() => (window as any).__rigsmithPlayer.state().index > 3);
    await player.getByTestId('player-play').click();
    const s = await playerProbe<any>(player, 'state');
    assert.equal(s.playing, false);
    assert.match(await player.getByTestId('player-frame-label').innerText(), /^frame \d+ \/ 29 · /);
  });

  it('atlas bleed measured: bleed 0 and padding 0 vs bleed 1; loose images match exactly', async () => {
    const wave = sequence(files.wave);
    await loadPlayer([files.runtime, ...unpackAtlas(files.atlas0, 'atlas-p2-b0')]);
    const b0 = await compareAll('wave via atlas (padding 2, bleed 0)', wave, { over: Infinity, mean: Infinity });
    await loadPlayer([files.runtime, ...unpackAtlas(files.atlasTight, 'atlas-p0-b0')]);
    const tight = await compareAll('wave via atlas (padding 0, bleed 0)', wave, { over: Infinity, mean: Infinity });
    await loadPlayer([files.runtime, ...loosePaths]);
    assert.match(await player.getByTestId('player-status').innerText(), /loose images\.$/);
    await loadPlayer([files.runtime, ...unpackAtlas(files.atlas2, 'atlas-p4-b2')]);
    const b2 = await compareAll('wave via atlas (padding 4, bleed 2)', wave);
    await loadPlayer([files.runtime, ...unpackAtlas(files.atlas1, 'atlas-p2-b1')]);
    const b1 = await compareAll('wave via atlas (padding 2, bleed 1), again', wave);
    await loadPlayer([files.runtime, ...loosePaths]);
    assert.match(await player.getByTestId('player-status').innerText(), /loose images\.$/);
    const loose = await compareAll('wave via loose images', wave, { over: 0, mean: 0 });
    assert.equal(loose.worstMax, 0, 'loose images: identical pixels');
    report.push(`bleed measurement (px over tolerance, 30 frames): padding0/bleed0=${tight.over}, padding2/bleed0=${b0.over}, padding2/bleed1=${b1.over}, padding4/bleed2=${b2.over}; loose images max diff ${loose.worstMax}`);
    assert.ok(b1.over * 100 < b0.over && b2.over <= b1.over, 'bleed removes the edge artefacts');
  });

  it('reports missing textures and pages instead of drawing garbage', async () => {
    await loadPlayer([files.runtime]);
    assert.match(await player.getByTestId('player-errors').innerText(), /No texture for: .*torso\.png/);
    const [json] = unpackAtlas(files.atlas1, 'atlas-p2-b1');
    await loadPlayer([files.runtime, json]);
    assert.match(await player.getByTestId('player-errors').innerText(), /Atlas page runtime-rig-0\.png was not loaded/);
    await loadPlayer([json]);
    assert.match(await player.getByTestId('player-errors').innerText(), /No rigsmith\.runtime JSON among the files/);
    assert.equal((await playerProbe<any>(player, 'state')).loaded, false);
    assert.deepEqual(pageErrors, []);
  });
});
