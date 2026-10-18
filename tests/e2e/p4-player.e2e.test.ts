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
import type { M, SlotOverride } from '../support/reference-composite.ts';
import { composite, decodeProjectImages, diffImages, slotOpacities } from '../support/reference-composite.ts';
import { constrainedWorlds, mixFrame } from '../support/reference-constraints.ts';
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

  // Review DRW-006 / post-review FR-003: the checks above compare the player with the
  // editor, and both use src/model. Here every pixel of the expected image comes from
  // tests/support (reference-composite.ts + reference-constraints.ts), which import
  // nothing from src/ (tests/unit/reference-independence.test.ts): keyframe sampling,
  // the bone chain, two-bone IK (circle intersection), the path constraint (32-chord
  // arc-length table), mixing, skins, slot/draw-order rules, mesh skinning + deform and
  // compositing are all re-derived from the project JSON and docs/architecture.md. The
  // runtime file's baked rows are not an input: the project handed to the reference is
  // the fixture (no baked data), and the baked rows are only compared afterwards.
  // Every strict mismatch is listed in the report with its pixel, attachment and values,
  // and the budget per case is the count classified in docs/runtime.md.
  it('wave, skin alt and the wave → rest transition match an independent renderer with its own IK, paths and mixing (review DRW-006, FR-003)', async () => {
    // The reference reads only the project (no runtime file): fps and keys included.
    const project: any = JSON.parse(serializeProject(fixture));
    assert.ok(!/"baked/.test(JSON.stringify(project)), 'the reference input carries no baked data');
    const wave = project.animations.find((a: any) => a.name === 'wave');
    const rest = project.animations.find((a: any) => a.name === 'rest');
    const fps = wave.fps;
    const nameOf = new Map<string, string>(project.bones.map((b: any) => [b.id, b.name]));
    const noConstraints = { ...project, ik: [], pathConstraints: [] };
    const flipped = { ...project, ik: project.ik.map((k: any) => ({ ...k, bendPositive: !k.bendPositive })) };
    const images = decodeProjectImages(project);
    const mixMeta = sequence(files.mix).meta;
    const mixRule = project.mixes.find((m: any) => m.from === wave.id && m.to === rest.id);
    assert.equal(mixRule.duration, 0.3, 'stored wave → rest mix');
    // A strict mismatch is a solid-vs-clear pixel or a colour difference where both are
    // opaque; the rest are anti-aliased edge coverages (the reference subsamples 4×4,
    // the canvas clips analytically), which a deformed mesh outline has many of.
    const isStrict = (a: Uint8Array, b: Uint8Array, k: number): boolean => {
      const dc = Math.max(...[0, 1, 2].map((c) => Math.abs((a[k + c] * a[k + 3]) / 255 - (b[k + c] * b[k + 3]) / 255)));
      return (Math.max(a[k + 3], b[k + 3]) >= 224 && Math.min(a[k + 3], b[k + 3]) <= 31) || (a[k + 3] === 255 && b[k + 3] === 255 && dc > 24);
    };
    const strictCount = (a: Uint8Array, b: Uint8Array): number => {
      let n = 0;
      for (let k = 0; k < a.length; k += 4) if (isStrict(a, b, k)) n++;
      return n;
    };
    type Case = { name: string; frames: number; skin: string | null; budget: number; frame: (i: number, p?: any) => { T: number; worlds: Map<string, M>; anim: any; t: number; slots?: SlotOverride } };
    const cases: Case[] = [
      { name: 'wave', frames: 30, skin: null, budget: 51, frame: (i, p = project) => ({ T: i / fps, worlds: constrainedWorlds(p, wave, i / fps), anim: wave, t: i / fps }) },
      { name: 'wave, skin alt', frames: 30, skin: 'skin_alt', budget: 53, frame: (i, p = project) => ({ T: i / fps, worlds: constrainedWorlds(p, wave, i / fps), anim: wave, t: i / fps }) },
      {
        name: 'wave → rest (mix at 0.5 s, stored 0.3 s)', frames: mixMeta.frames.length, skin: null, budget: 34,
        frame: (i, p = project) => {
          const T = mixMeta.frames[i].time;
          const m = mixFrame(p, [{ anim: wave, start: 0, mix: 0 }, { anim: rest, start: 0.5, mix: mixRule.duration }], T, 'setup');
          return { T, worlds: m.worlds, anim: m.discrete.anim, t: m.discrete.t, slots: { opacity: m.opacity, deform: m.deform } };
        },
      },
    ];
    const waveWorlds: Map<string, M>[] = [];
    try {
      for (const c of cases) {
        await player.getByTestId('player-skin').selectOption({ label: c.skin ? 'alt' : '(default)' });
        if (c.name.startsWith('wave → rest')) {
          await setField(player, 'player-mix-at', 0.5);
          await player.getByTestId('player-mix-to').selectOption({ label: 'rest' });
        }
        let over = 0, strict = 0, worstMean = 0, worstEdge = 0, controlStrict = 0, sideStrict = 0, explained = 0, gap = 0, edgeN = 0, edgeSum = 0, edgeMax = 0;
        const classes = new Map<string, number>();
        const textureClasses = new Map<string, number>();
        const fullClasses = new Map<string, number>();
        const upperGap = { clear: [0, 1].map(() => ({ n: 0, sum: 0, min: Infinity, max: -Infinity })), opaque: [0, 1].map(() => ({ n: 0, sum: 0, min: Infinity, max: -Infinity })) };
        const dump: string[] = [];
        for (let i = 0; i < c.frames; i++) {
          await player.getByTestId('player-time').fill(String(i));
          const got = await playerCanvas();
          assert.equal(got.frame, i, `${c.name}: frame`);
          const f = c.frame(i);
          assert.ok(Math.abs(f.T - got.frame / fps) < 1e-12, `${c.name}: clock`);
          if (c.name === 'wave') waveWorlds.push(f.worlds);
          const view = [got.img.width, got.img.height, got.ox, got.oy, got.scale] as const;
          const ref = composite(project, f.anim, f.t, images, ...view, f.worlds, c.skin, f.slots);
          const d = diffImages(got.img, ref, 24);
          const s = strictCount(got.img.data, ref.data);
          over += d.over;
          strict += s;
          worstMean = Math.max(worstMean, d.meanDiff);
          worstEdge = Math.max(worstEdge, (d.over - s) / d.covered);
          // Edges over a clear background (reference alpha strictly between 0 and 255): the
          // player's coverage minus the reference's, in 4×4 subsamples.
          for (let k = 3; k < ref.data.length; k += 4) if (ref.data[k] > 0 && ref.data[k] < 255) {
            const g = ((got.img.data[k] - ref.data[k]) / 255) * 16;
            edgeN++;
            edgeSum += g;
            edgeMax = Math.max(edgeMax, Math.abs(g));
          }
          // The strict class, measured along the whole edge of `upper`: its coverage gap
          // (player − reference, 4×4 subsamples) over a clear background vs over an opaque
          // layer, split by side of the bone axis.
          {
            const op0 = f.slots?.opacity ?? slotOpacities(project, f.anim, f.t);
            const upId = project.attachments.find((a: any) => a.name === 'upper').id;
            const only = (keep: boolean) => composite(project, f.anim, f.t, images, ...view, f.worlds, c.skin, {
              opacity: new Map([...op0].map(([k2, v]) => [k2, (k2 === upId) === keep ? v : 0])),
              deform: f.slots?.deform ?? new Map(),
            }).data;
            const X = only(true), U = only(false);
            const m = f.worlds.get(project.attachments.find((a: any) => a.name === 'upper').boneId)!;
            const ox = (m[4] - got.ox) * got.scale, oy = (m[5] - got.oy) * got.scale;
            for (let k = 0; k < X.length; k += 4) {
              const cov = X[k + 3];
              if (cov === 0 || cov === 255) continue;
              const px = (k / 4) % got.img.width + 0.5, py = Math.floor(k / 4 / got.img.width) + 0.5;
              const side = m[0] * (py - oy) - m[1] * (px - ox) > 0 ? 1 : 0;
              let g: number | null = null;
              if (U[k + 3] === 0) g = ((got.img.data[k + 3] - cov) / 255) * 16;
              else if (U[k + 3] === 255) {
                const dir = [0, 1, 2].map((c2) => X[k + c2] - (U[k + c2] * U[k + 3]) / 255);
                const n2 = dir.reduce((q, v) => q + v * v, 0);
                if (n2 > 40 * 40) {
                  const al = [0, 1, 2].reduce((q, c2) => q + ((got.img.data[k + c2] * got.img.data[k + 3]) / 255 - U[k + c2]) * dir[c2], 0) / n2;
                  g = (al - cov / 255) * 16;
                }
              }
              if (g === null) continue;
              const e = upperGap[U[k + 3] === 0 ? 'clear' : 'opaque'][side];
              e.n++;
              e.sum += g;
              e.min = Math.min(e.min, g);
              e.max = Math.max(e.max, g);
            }
          }
          if (s) {
            // Classify each strict pixel. The reference is recomposited with one attachment
            // X at a time removed (U) and alone (X); if X lies on top with partial coverage,
            // a composite is U + α·(X − U) per premultiplied channel. A pixel is explained as
            // "edge coverage of X over an opaque layer" when the player's colour lies on that
            // line (residual ≤ 6 of 255) and both coverages are partial; the gap in coverage
            // is reported in 4×4 subsamples.
            const op = f.slots?.opacity ?? slotOpacities(project, f.anim, f.t);
            const without = (id: string | null, only: boolean) => composite(project, f.anim, f.t, images, ...view, f.worlds, c.skin, {
              opacity: new Map([...op].map(([k, v]) => [k, only ? (k === id ? v : 0) : k === id ? 0 : v])),
              deform: f.slots?.deform ?? new Map(),
            }).data;
            const layers = project.attachments.map((a: any) => ({ a, alone: without(a.id, true), rest: without(a.id, false) }));
            for (let k = 0; k < got.img.data.length; k += 4) if (isStrict(got.img.data, ref.data, k)) {
              const px = (k / 4) % got.img.width, py = Math.floor(k / 4 / got.img.width);
              const pre = (d: Uint8Array) => [0, 1, 2].map((c2) => (d[k + c2] * d[k + 3]) / 255);
              const P = pre(got.img.data), R = pre(ref.data);
              let why = '';
              for (const { a, alone, rest: U0 } of layers) {
                const cov = alone[k + 3];
                if (cov === 0 || cov === 255 || U0[k + 3] !== 255) continue;
                const U = pre(U0), X = [0, 1, 2].map((c2) => alone[k + c2]);
                const dir = X.map((v, c2) => v - U[c2]);
                const n2 = dir.reduce((q, v) => q + v * v, 0);
                const fit = (Q: number[]) => {
                  const al = Q.reduce((q, v, c2) => q + (v - U[c2]) * dir[c2], 0) / n2;
                  return { al, res: Math.hypot(...Q.map((v, c2) => v - U[c2] - al * dir[c2])) };
                };
                const fp = fit(P), fr = fit(R);
                if (fp.res <= 6 && fr.res <= 6 && fp.al > 0 && fp.al < 1 && fr.al > 0 && fr.al < 1) {
                  why = `edge coverage of ${a.name} over an opaque layer: player ${(fp.al * 16).toFixed(1)}/16, reference ${(fr.al * 16).toFixed(1)}/16 (residual ${fp.res.toFixed(1)})`;
                  explained++;
                  classes.set(a.name, (classes.get(a.name) ?? 0) + 1);
                  gap = Math.max(gap, Math.abs(fp.al - fr.al) * 16);
                  break;
                }
              }
              // The same outline where the reference's 4×4 subsamples all fall inside X (alone
              // α 255) but an 8-neighbour of the pixel has X partially covered, so the pixel is on
              // X's edge: explained when the player's colour lies on the line from the rest (U) to
              // X (residual ≤ 6, 0 < α < 1); its gap 16·(1 − α) joins the coverage gaps, which
              // must lie within those of edges over a clear background.
              if (!why) for (const { a, alone, rest: U0 } of layers) {
                if (alone[k + 3] !== 255 || U0[k + 3] !== 255) continue;
                const W = got.img.width, H = got.img.height;
                const onOutline = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]].some(([dx, dy]) => {
                  const nx = px + dx, ny = py + dy;
                  if (nx < 0 || ny < 0 || nx >= W || ny >= H) return false;
                  const al = alone[4 * (ny * W + nx) + 3];
                  return al > 0 && al < 255;
                });
                if (!onOutline) continue;
                const U = pre(U0), X = [0, 1, 2].map((c2) => alone[k + c2]);
                const dir = X.map((v, c2) => v - U[c2]);
                const n2 = dir.reduce((q, v) => q + v * v, 0);
                if (Math.sqrt(n2) < 24) continue;
                const al = P.reduce((q, v, c2) => q + (v - U[c2]) * dir[c2], 0) / n2;
                const res = Math.hypot(...P.map((v, c2) => v - U[c2] - al * dir[c2]));
                if (res <= 6 && al > 0 && al < 1) {
                  why = `edge coverage of ${a.name} over an opaque layer, reference 16/16: player ${(al * 16).toFixed(1)}/16 (residual ${res.toFixed(1)})`;
                  explained++;
                  fullClasses.set(a.name, (fullClasses.get(a.name) ?? 0) + 1);
                  gap = Math.max(gap, (1 - al) * 16);
                  break;
                }
              }
              // Not an outline: a colour boundary inside one image. A pixel covered by exactly one
              // layer (alone α 255, every other layer α 0), opaque in both images, is explained as
              // "texture edge inside X" when the player's colour lies on the line from the
              // reference's colour to an in-bounds 8-neighbour's reference colour that differs by
              // ≥ 24 (residual ≤ 6, 0 < t < 1): a sub-pixel shift of that boundary.
              const covering = why ? [] : layers.filter(({ alone }: any) => alone[k + 3] > 0);
              if (covering.length === 1 && covering[0].alone[k + 3] === 255 && got.img.data[k + 3] === 255 && ref.data[k + 3] === 255) {
                const W = got.img.width, H = got.img.height, rgb = (d: Uint8Array, q: number) => [0, 1, 2].map((c2) => d[q + c2]);
                const Rc = rgb(ref.data, k), Pc = rgb(got.img.data, k);
                for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
                  const nx = px + dx, ny = py + dy;
                  if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                  const q = 4 * (ny * W + nx);
                  if (ref.data[q + 3] !== 255) continue;
                  const dir = rgb(ref.data, q).map((v, c2) => v - Rc[c2]);
                  const n2 = dir.reduce((acc, v) => acc + v * v, 0);
                  if (Math.sqrt(n2) < 24) continue;
                  const t = Pc.reduce((acc, v, c2) => acc + (v - Rc[c2]) * dir[c2], 0) / n2;
                  const res = Math.hypot(...Pc.map((v, c2) => v - Rc[c2] - t * dir[c2]));
                  if (t > 0 && t < 1 && res <= 6) {
                    const name = covering[0].a.name;
                    why = `texture edge inside ${name}: player ${t.toFixed(2)} of the way to the neighbour at (${dx},${dy}) (residual ${res.toFixed(1)})`;
                    explained++;
                    textureClasses.set(name, (textureClasses.get(name) ?? 0) + 1);
                    break;
                  }
                }
              }
              // Unexplained: list each layer that covers the pixel (its coverage alone, the alpha of
              // everything else, and both fit residuals) so the cause can be read off the report.
              if (!why) why = 'UNEXPLAINED — ' + layers.filter(({ alone }: any) => alone[k + 3] > 0).map(({ a, alone, rest: U0 }: any) => {
                const U = pre(U0), X = [0, 1, 2].map((c2) => alone[k + c2]), dir = X.map((v, c2) => v - U[c2]), n2 = dir.reduce((q, v) => q + v * v, 0) || 1;
                const fit = (Q: number[]) => { const al = Q.reduce((q, v, c2) => q + (v - U[c2]) * dir[c2], 0) / n2; return `α ${al.toFixed(2)} res ${Math.hypot(...Q.map((v, c2) => v - U[c2] - al * dir[c2])).toFixed(1)}`; };
                return `${a.name}: alone α ${alone[k + 3]}, others α ${U0[k + 3]}, player ${fit(P)}, reference ${fit(R)}`;
              }).join('; ') + ' | 3×3 player / reference: ' + [-1, 0, 1].map((dy) => [-1, 0, 1].map((dx) => {
                const q = k + 4 * (dy * got.img.width + dx);
                return `${[...got.img.data.subarray(q, q + 3)]}/${[...ref.data.subarray(q, q + 3)]}`;
              }).join(' ')).join(' ‖ ');
              dump.push(`    f${i} (${px},${py}) player ${[...got.img.data.subarray(k, k + 4)]} reference ${[...ref.data.subarray(k, k + 4)]}: ${why}`);
            }
          }
          // Controls, through the same frame function: no constraints, and the elbow flipped.
          for (const [variant, add] of [[noConstraints, (n: number) => (controlStrict += n)], [flipped, (n: number) => (sideStrict += n)]] as const) {
            const g = c.frame(i, variant);
            add(strictCount(got.img.data, composite(project, g.anim, g.t, images, ...view, g.worlds, c.skin, g.slots).data));
          }
        }
        report.push(`FR-003 ${c.name}: player vs independent reference (own IK, paths${c.name.startsWith('wave → rest') ? ', mixing' : ''}): ${c.frames} frames, ${over} px over tolerance 24 of which ${strict} strict, worst edge-coverage share ${(worstEdge * 100).toFixed(2)}%, worst mean ${worstMean.toFixed(3)}; strict explained ${explained}/${strict} (${[...[...classes].map(([n, v]) => `${v} × ${n} edge over an opaque layer`), ...[...fullClasses].map(([n, v]) => `${v} × ${n} edge over an opaque layer with the reference at 16/16`), ...[...textureClasses].map(([n, v]) => `${v} × texture edge inside ${n}`)].join(', ') || 'none'}, worst coverage gap ${gap.toFixed(1)}/16 subsamples; edges over a clear background: ${edgeN} px, mean gap ${(edgeSum / edgeN).toFixed(2)}/16, worst ${edgeMax.toFixed(1)}/16); control without constraints ${controlStrict} strict px, control with the elbow flipped ${sideStrict} strict px`);
        const fmt = (e: { n: number; sum: number; min: number; max: number }) => `${e.n} px mean ${(e.sum / e.n).toFixed(2)} range ${e.min.toFixed(1)}…${e.max.toFixed(1)}`;
        // No systematic offset or thickness: a 0.1 px shift of an edge moves its mean by 1.6/16.
        for (const e of [...upperGap.clear, ...upperGap.opaque]) assert.ok(e.n > 300 && Math.abs(e.sum / e.n) <= 0.25, `${c.name}: upper edge mean gap ${e.sum / e.n} over ${e.n} px`);
        report.push(`  upper edge coverage gap (/16): over clear — side A ${fmt(upperGap.clear[0])}, side B ${fmt(upperGap.clear[1])}; over an opaque layer — side A ${fmt(upperGap.opaque[0])}, side B ${fmt(upperGap.opaque[1])}`);
        report.push(...dump);
        assert.equal(explained, strict, `${c.name}: every strict mismatch is classified`);
        assert.ok(gap <= edgeMax, `${c.name}: strict coverage gaps (${gap}) lie within the gaps of edges over a clear background (${edgeMax})`);
        assert.ok(strict <= c.budget, `${c.name}: ${strict} strict mismatches (budget ${c.budget}, the classified count of docs/runtime.md)`);
        assert.ok(worstEdge <= 0.04, `${c.name}: edge-coverage share ${worstEdge}`);
        assert.ok(worstMean <= 0.5, `${c.name}: mean ${worstMean}`);
        assert.ok(controlStrict > 100 * Math.max(1, strict), `${c.name}: the comparison tells an unconstrained pose apart`);
        assert.ok(sideStrict > 100 * Math.max(1, strict), `${c.name}: the comparison tells the elbow side apart`);
      }
      // Diagnostic only, after every expected image is fixed: the reference's world pose
      // vs the runtime file's baked rows (the exporter's shared-model output, 3 decimals).
      const an = JSON.parse(readFileSync(files.runtime, 'utf8')).animations.find((a: any) => a.name === 'wave');
      let bakedWorst = 0;
      waveWorlds.forEach((w, i) => {
        for (const [id, m] of w) {
          const row = an.baked[nameOf.get(id)!][i];
          const rot = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
          bakedWorst = Math.max(bakedWorst, Math.abs(m[4] - row[0]), Math.abs(m[5] - row[1]), Math.abs(((rot - row[2] + 540) % 360) - 180), Math.abs(Math.hypot(m[0], m[1]) - row[3]), Math.abs(Math.hypot(m[2], m[3]) - row[4]));
        }
      });
      report.push(`FR-003 reference worlds vs the runtime's baked rows (diagnostic, rows rounded to 3 decimals): max |Δ| ${bakedWorst.toExponential(2)} px / deg / scale over x, y, rotation, scaleX, scaleY`);
      assert.equal(waveWorlds.length, 30);
      assert.ok(bakedWorst < 1e-3, `reference vs baked ${bakedWorst}`);
    } finally {
      // Later tests expect the default skin and no transition.
      await player.getByTestId('player-mix-to').selectOption({ label: '(none)' });
      await player.getByTestId('player-skin').selectOption({ label: '(default)' });
    }
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
