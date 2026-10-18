// Wiz v3 acceptance (use-case review RV-001 a–f): opens the separately saved UI-built
// project (.hermes/assets/wiz/v3-output/wiz-v3.rig.json, made by scripts/roadmap/wiz-v3.ts),
// exports its loops and the idle → greeting mix through the dialogs in this session, and
// measures them. Image-space landmarks (face rect, arm centre line, jacket hem) are mapped
// through the independently re-skinned meshes (tests/support/reference-composite.ts) with
// the independently solved IK (tests/support/reference-constraints.ts).
// (g) operator visual review is not measured here. Needs the private, git-ignored Wiz
// assets. Run: npm run build && npm run test:wiz
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { launchIsolated, pickPort, probe, startPreview } from '../e2e/harness.ts';
import type { Decoded } from '../support/png-decode.ts';
import { decodePng } from '../support/png-decode.ts';
import type { M } from '../support/reference-composite.ts';
import { composite, decodeProjectImages, diffImages, meshScreenVertices, boneWorlds, worldsFromLocal } from '../support/reference-composite.ts';
import { applyConstraintsRef, constrainedWorlds, keyedLocal, mixFrame } from '../support/reference-constraints.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, WIZ } from '../../scripts/wiz/paths.ts';

const V2_FILE = path.join(WIZ, 'roadmap-output/wiz-v2.rig.json');
const V3_FILE = path.join(WIZ, 'v3-output/wiz-v3.rig.json');
const BASELINE = path.resolve(import.meta.dirname, '../../.hermes/dispatch/roadmap/preservation-baseline.json');
const OUT = path.join(EVIDENCE, 'v3');
mkdirSync(OUT, { recursive: true });

/** Body-image px: the eyes + mouth bounding rect, and the jacket's lower edge band. */
const FACE = { x0: 420, y0: 335, x1: 670, y1: 522 };
const HEM_Y = 900;
const IDENTITY: M = [1, 0, 0, 1, 0, 0];

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let p: any;
let images: Map<string, Decoded>;
const pageErrors: string[] = [];
const metrics: Record<string, unknown> = {};
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const wrap = (d: number) => ((d % 360) + 540) % 360 - 180;
const ang = (m: M) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;
const near = (a: number, b: number, eps: number, msg: string) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≈ ${b} ±${eps}`);
const r2 = (v: number) => Math.round(v * 100) / 100;
const id = (name: string) => p.bones.find((b: any) => b.name === name).id as string;
const att = (name: string) => p.attachments.find((a: any) => a.name === name);
const anim = (name: string) => p.animations.find((a: any) => a.name === name);

async function gotoFrame(frame: number, frames: number, fps = 30): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  await ruler.scrollIntoViewIfNeeded();
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
  near((await probe<{ time: number }>(page, 'state')).time, frame / fps, 1e-6, `scrubbed to frame ${frame}`);
}

/** Editor bone worlds (after IK) at every frame 0..frames, scrubbed on the ruler. */
async function editorWorlds(name: string, frames: number): Promise<Map<string, M>[]> {
  await page.getByTestId('anim-select').selectOption({ label: name });
  const out: Map<string, M>[] = [];
  for (let f = 0; f <= frames; f++) {
    await gotoFrame(f, frames);
    out.push(new Map(Object.entries(await probe<Record<string, M>>(page, 'worlds'))));
  }
  return out;
}

async function exportZip(open: () => Promise<void>, button: string, file: string): Promise<{ meta: any; pngs: Decoded[] }> {
  await open();
  const dl = page.waitForEvent('download');
  await page.getByTestId(button).click();
  const out = path.join(OUT, file);
  await (await dl).saveAs(out);
  const files = readZip(readFileSync(out));
  const meta = JSON.parse(files.find((f) => f.name.endsWith('sequence.json'))!.data.toString('utf8'));
  const pngs = files.filter((f) => f.name.endsWith('.png')).sort((a, b) => a.name.localeCompare(b.name)).map((f) => decodePng(f.data));
  return { meta, pngs };
}

/** Maps rest image points of a mesh attachment to world points of the skinned mesh. */
function skin(a: any, points: { x: number; y: number }[]): (worlds: Map<string, M>) => ({ x: number; y: number } | null)[] {
  const P = a.mesh.points as number[], T = a.mesh.triangles as number[];
  const bary = points.map(({ x, y }) => {
    for (let t = 0; t < T.length; t += 3) {
      const [i, j, k] = [T[t], T[t + 1], T[t + 2]];
      const [ax, ay, bx, by, cx, cy] = [P[2 * i], P[2 * i + 1], P[2 * j], P[2 * j + 1], P[2 * k], P[2 * k + 1]];
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
      const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return { i, j, k, l1, l2, l3 };
    }
    return null;
  });
  const setup = boneWorlds(p, null, 0);
  return (worlds) => {
    const v = meshScreenVertices(a, undefined, 0, p, worlds, setup, IDENTITY);
    return bary.map((b) => (b ? { x: b.l1 * v[2 * b.i] + b.l2 * v[2 * b.j] + b.l3 * v[2 * b.k], y: b.l1 * v[2 * b.i + 1] + b.l2 * v[2 * b.j + 1] + b.l3 * v[2 * b.k + 1] } : null));
  };
}

/** Centre line of an image's opaque strip (principal axis; midpoint of each cross-section). */
function centreLine(img: Decoded): { x: number; y: number }[] {
  const px: [number, number][] = [];
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4 + 3] > 128) px.push([x + 0.5, y + 0.5]);
  const mx = px.reduce((s, q) => s + q[0], 0) / px.length, my = px.reduce((s, q) => s + q[1], 0) / px.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of px) [sxx, syy, sxy] = [sxx + (x - mx) ** 2, syy + (y - my) ** 2, sxy + (x - mx) * (y - my)];
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const [ux, uy, nx, ny] = [Math.cos(th), Math.sin(th), -Math.sin(th), Math.cos(th)];
  const bins = new Map<number, [number, number]>();
  for (const [x, y] of px) {
    const s = Math.round(((x - mx) * ux + (y - my) * uy) / 2);
    const n = (x - mx) * nx + (y - my) * ny;
    const b = bins.get(s);
    bins.set(s, b ? [Math.min(b[0], n), Math.max(b[1], n)] : [n, n]);
  }
  return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([s, [lo, hi]]) => ({ x: mx + 2 * s * ux + ((lo + hi) / 2) * nx, y: my + 2 * s * uy + ((lo + hi) / 2) * ny }));
}

const alphaAt = (img: Decoded, meta: any, w: { x: number; y: number }) => {
  const x = Math.floor((w.x - meta.origin.x) * meta.scale), y = Math.floor((w.y - meta.origin.y) * meta.scale);
  return x < 0 || y < 0 || x >= img.width || y >= img.height ? 0 : img.data[(y * img.width + x) * 4 + 3];
};

let idleE: Map<string, M>[] = [];
let greetE: Map<string, M>[] = [];
let idleX: { meta: any; pngs: Decoded[] };
let greetX: { meta: any; pngs: Decoded[] };
let mixX: { meta: any; pngs: Decoded[] };

before(async () => {
  assert.ok(existsSync(V3_FILE), `${V3_FILE} missing — run node scripts/roadmap/wiz-v3.ts first`);
  const port = await pickPort([47614, 47615, 47616, 47617]);
  server = await startPreview(port);
  ctx = await launchIsolated('wiz-v3-verify', [], { viewport: { width: 1600, height: 1000 } });
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('open-input').setInputFiles(V3_FILE);
  await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length === 21);
  p = await probe<any>(page, 'project');
  images = decodeProjectImages(p);
});

after(async () => {
  writeFileSync(path.join(OUT, 'rv001-metrics.json'), JSON.stringify(metrics, null, 1));
  await ctx?.close();
  server?.kill();
});

describe('Wiz v3 (UI-built articulated, meshed rig) — RV-001', () => {
  it('originals unchanged; v3 is a separate file carrying the v2 art byte-identically', () => {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).files as Record<string, { sha256: string }>;
    for (const [file, { sha256 }] of Object.entries(baseline)) assert.equal(sha(readFileSync(file)), sha256, `${file} unchanged`);
    const v2 = JSON.parse(readFileSync(V2_FILE, 'utf8'));
    assert.deepEqual(v2.animations.map((a: any) => a.name), ['idle', 'greeting', 'greeting-v2'], 'wiz-v2.rig.json keeps its animations');
    assert.equal(v2.bones.length, 8, 'wiz-v2.rig.json keeps its 8 bones');
    assert.deepEqual(p.images, v2.images, 'v3 embeds the v2 art byte-identically (no new art)');
    assert.equal(p.ik.length, 4);
    assert.deepEqual(p.attachments.filter((a: any) => a.mesh).map((a: any) => a.name).sort(), ['arm_l', 'arm_r', 'body', 'leg_l', 'leg_r']);
    assert.ok(p.frame, 'project frame set');
    assert.deepEqual(p.animations.map((a: any) => [a.name, a.duration, a.fps, a.loop]), [['idle-v3', 3, 30, true], ['greeting-v3', 2.4, 30, true]]);
  });

  it('exports both loops and the idle → greeting mix through the dialogs at the project frame', async () => {
    const seq = (name: string) => async () => {
      await page.getByTestId('export-sequence').click();
      await page.getByTestId('seq-anim').selectOption({ label: name });
      assert.equal(await page.getByTestId('seq-frame').inputValue(), 'project');
      assert.equal(await page.getByTestId('seq-frame-warning').count(), 0, `${name}: nothing clipped`);
    };
    idleX = await exportZip(seq('idle-v3'), 'seq-export', 'idle-v3.seq.zip');
    greetX = await exportZip(seq('greeting-v3'), 'seq-export', 'greeting-v3.seq.zip');
    mixX = await exportZip(async () => {
      await page.getByTestId('mix-open').click();
      await page.getByTestId('mix-from').selectOption({ label: 'idle-v3' });
      await page.getByTestId('mix-to').selectOption({ label: 'greeting-v3' });
      const start = page.getByTestId('mix-start');
      await start.fill('1');
      await start.press('Enter');
      assert.equal(await page.getByTestId('mix-duration').inputValue(), '0.3', 'saved mix rule idle-v3 → greeting-v3 0.3 s');
      assert.equal(await page.getByTestId('mix-frame-warning').count(), 0, 'mix: nothing clipped');
    }, 'mix-export', 'idle-v3-to-greeting-v3.seq.zip');
    await page.getByTestId('mix-close').click();
    for (const x of [idleX, greetX, mixX]) {
      assert.deepEqual([x.meta.frame, x.meta.origin, x.meta.width, x.meta.height, x.meta.scale], ['project', { x: p.frame.x, y: p.frame.y }, p.frame.width, p.frame.height, 1]);
    }
    assert.deepEqual([idleX.pngs.length, greetX.pngs.length, mixX.pngs.length], [90, 72, 103]);
    idleE = await editorWorlds('idle-v3', 90);
    greetE = await editorWorlds('greeting-v3', 72);
    // The editor's solved worlds equal the independent reference IK at every frame.
    let worst = 0;
    for (const [name, E] of [['idle-v3', idleE], ['greeting-v3', greetE]] as const) {
      E.forEach((w, f) => {
        const ref = constrainedWorlds(p, anim(name), f / 30);
        for (const [k, m] of w) worst = Math.max(worst, ...m.map((v, i) => Math.abs(v - ref.get(k)![i])));
      });
    }
    metrics.editorVsReferenceWorldsMaxAbs = worst;
    assert.ok(worst < 1e-6, `editor worlds = reference IK worlds (max |Δ| ${worst})`);
  });

  it('(a) head keyed ±6°: the jacket hem moves less than 4 px', async () => {
    const body = att('body');
    const pts = body.mesh.points as number[];
    const hem = skin(body, Array.from({ length: pts.length / 2 }, (_, i) => ({ x: pts[2 * i], y: pts[2 * i + 1] })).filter((v) => v.y >= HEM_Y));
    // Reference: the head's own key replaced by ±6° about the keyed value at every frame.
    let worst = 0;
    for (const [name, frames] of [['idle-v3', 90], ['greeting-v3', 72]] as const) {
      for (let f = 0; f <= frames; f++) {
        const base = hem(constrainedWorlds(p, anim(name), f / 30));
        for (const d of [-6, 6]) {
          const pose = keyedLocal(p, anim(name), f / 30);
          pose.get(id('head'))!.rotation += d;
          applyConstraintsRef(p, pose, anim(name), f / 30);
          hem(worldsFromLocal(p, pose)).forEach((q, i) => (worst = Math.max(worst, Math.hypot(q!.x - base[i]!.x, q!.y - base[i]!.y))));
        }
      }
    }
    // Editor: key the head at +6 / −6 in an unsaved scratch animation through the inspector.
    await page.getByTestId('new-animation').click();
    await page.getByTestId('anim-name').fill('head-test');
    await page.getByTestId('anim-name').press('Enter');
    const before = (await probe<{ x: number; y: number }[]>(page, 'mesh', 'body'))!;
    const hipsS = await probe<{ origin: { x: number; y: number }; tip: { x: number; y: number } }>(page, 'bone', 'hips');
    const zoom = Math.hypot(hipsS.tip.x - hipsS.origin.x, hipsS.tip.y - hipsS.origin.y) / p.bones.find((b: any) => b.name === 'hips').length;
    let editorWorst = 0, headMoved = 0;
    for (const d of [6, -6]) {
      await page.getByTestId('tree-bone-head').click();
      const rot = page.getByTestId('bone-rotation');
      await rot.fill(String(d));
      await rot.press('Enter');
      const toggle = page.getByTestId('key-toggle-rotate');
      if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
      const keyed = (await probe<{ x: number; y: number }[]>(page, 'mesh', 'body'))!;
      keyed.forEach((q, i) => {
        const m = Math.hypot(q.x - before[i].x, q.y - before[i].y) / zoom;
        if (pts[2 * i + 1] >= HEM_Y) editorWorst = Math.max(editorWorst, m);
        else headMoved = Math.max(headMoved, m);
      });
    }
    await page.getByRole('button', { name: 'Delete animation' }).click();
    metrics.a = { hemMaxPx_reference_allFrames: r2(worst), hemMaxPx_editor_setup: r2(editorWorst), faceMaxPx_editor: r2(headMoved), hemImageY: `≥ ${HEM_Y}` };
    assert.ok(headMoved > 20, `the key moves the head (${headMoved.toFixed(1)} px)`);
    assert.ok(worst < 4 && editorWorst < 4, `hem moves < 4 px: reference ${worst.toFixed(3)}, editor ${editorWorst.toFixed(3)}`);
  });

  it('(b) elbow bends ≥ 40° and the arm centre line is covered at every frame', () => {
    const bends: Record<string, number> = {};
    let minAlpha = 255, at = '';
    for (const s of ['l', 'r']) {
      const a = att(`arm_${s}`);
      const line = centreLine(images.get(a.imageId)!);
      const map = skin(a, line);
      assert.ok(map(boneWorlds(p, null, 0)).filter(Boolean).length > 0.9 * line.length, `arm_${s} centre line lies in its mesh`);
      bends[s] = Math.max(...greetE.map((w) => Math.abs(wrap(ang(w.get(id(`forearm_${s}`))!) - ang(w.get(id(`arm_${s}`))!)))));
      for (const [name, x] of [['idle-v3', idleX], ['greeting-v3', greetX]] as const) {
        x.pngs.forEach((img, f) => {
          for (const q of map(constrainedWorlds(p, anim(name), f / 30))) {
            if (!q) continue;
            const al = alphaAt(img, x.meta, q);
            if (al < minAlpha) [minAlpha, at] = [al, `${name} f${f} arm_${s}`];
          }
        });
      }
    }
    metrics.b = { elbowBendMaxDeg: { l: r2(bends.l), r: r2(bends.r) }, centreLineMinAlpha: minAlpha, at };
    assert.ok(bends.r >= 40, `waving elbow bends ${bends.r.toFixed(1)}° (≥ 40°)`);
    assert.ok(minAlpha > 0, `no transparent pixel on the arm centre line (min alpha ${minAlpha} at ${at})`);
  });

  it('(c) landing (f15, the shin targets back on the ground): knees flex ≥ 15°, shoe bottoms within 2 px of setup', () => {
    const flex = (w: Map<string, M>, s: string) => Math.abs(wrap(ang(w.get(id(`shin_${s}`))!) - ang(w.get(id(`leg_${s}`))!)));
    const knees = { l: flex(greetE[15], 'l'), r: flex(greetE[15], 'r') };
    const bottom = (img: Decoded, half: 0 | 1) => {
      for (let y = img.height - 1; y >= 0; y--)
        for (let x = half ? img.width >> 1 : 0; x < (half ? img.width : img.width >> 1); x++) if (img.data[(y * img.width + x) * 4 + 3] > 128) return y;
      return -1;
    };
    const shoe = { l: bottom(greetX.pngs[15], 0) - bottom(greetX.pngs[0], 0), r: bottom(greetX.pngs[15], 1) - bottom(greetX.pngs[0], 1) };
    metrics.c = { landingFrame: 15, kneeFlexDeg: { l: r2(knees.l), r: r2(knees.r) }, shoeBottomDeltaPx: shoe, kneeFlexDegByFrame: greetE.map((w) => [r2(flex(w, 'l')), r2(flex(w, 'r'))]) };
    assert.ok(Math.min(knees.l, knees.r) >= 15, `knee flex at landing ${JSON.stringify(knees)}`);
    assert.ok(Math.abs(shoe.l) <= 2 && Math.abs(shoe.r) <= 2, `shoe bottom rows vs setup ${JSON.stringify(shoe)}`);
  });

  it('(d) the face (eyes + mouth rect) keeps its aspect within 3% through the squash', () => {
    const corners = [{ x: FACE.x0, y: FACE.y0 }, { x: FACE.x1, y: FACE.y0 }, { x: FACE.x1, y: FACE.y1 }, { x: FACE.x0, y: FACE.y1 }];
    const map = skin(att('body'), corners);
    const aspect = (w: Map<string, M>) => {
      const [a, b, c, d] = map(w) as { x: number; y: number }[];
      const L = (u: typeof a, v: typeof a) => Math.hypot(u.x - v.x, u.y - v.y);
      return (L(a, b) + L(d, c)) / (L(a, d) + L(b, c));
    };
    const rest = aspect(boneWorlds(p, null, 0));
    const change = (name: string, frames: number) => Array.from({ length: frames + 1 }, (_, f) => Math.abs(aspect(constrainedWorlds(p, anim(name), f / 30)) / rest - 1));
    const g = change('greeting-v3', 72), i = change('idle-v3', 90);
    const worst = Math.max(...g, ...i);
    metrics.d = { faceRectImagePx: FACE, rigidHeadRowsEndImageY: 458.4, restAspect: r2(rest * 1000) / 1000, maxAspectChangePct: r2(worst * 100), greetingSquashFramesPct: Object.fromEntries([4, 8, 15].map((f) => [`f${f}`, r2(g[f] * 100)])) };
    assert.ok(worst < 0.03, `face aspect change ${(worst * 100).toFixed(2)}% (< 3%)`);
  });

  it('(e) loop seam: the last frame equals frame 0 for all 21 bones (after IK)', () => {
    for (const [name, E] of [['idle-v3', idleE], ['greeting-v3', greetE]] as const) {
      assert.equal(E[0].size, 21);
      for (const [k, m] of E[0]) m.forEach((v, j) => near(E.at(-1)!.get(k)![j], v, 1e-6, `${name} bone ${k} [${j}]`));
    }
    metrics.e = 'idle-v3 f90 = f0 and greeting-v3 f72 = f0 for all 21 bone world matrices (|Δ| ≤ 1e-6)';
  });

  it('(f) dialog exports match the independent reference (IK + skinning) within the p3 budgets', () => {
    const report: string[] = [];
    const check = (label: string, x: { meta: any; pngs: Decoded[] }, f: number, ref: ReturnType<typeof composite>) => {
      const d = diffImages(x.pngs[f], ref, 24);
      report.push(`${label} f${f}: max ${d.maxDiff.toFixed(1)} mean ${d.meanDiff.toFixed(3)} >24/255: ${d.over} of ${d.covered} covered px`);
      assert.ok(d.over <= d.covered * 0.01 && d.meanDiff < 1.5, report.at(-1));
    };
    const ref = (name: string, x: { meta: any }, t: number, worlds = constrainedWorlds(p, anim(name), t)) =>
      composite(p, anim(name), t, images, x.meta.width, x.meta.height, x.meta.origin.x, x.meta.origin.y, x.meta.scale, worlds);
    for (const f of [0, 40, 62]) check('idle-v3', idleX, f, ref('idle-v3', idleX, f / 30));
    for (const f of [4, 10, 15, 24, 36]) check('greeting-v3', greetX, f, ref('greeting-v3', greetX, f / 30));
    const rule = p.mixes.find((m: any) => m.from === anim('idle-v3').id && m.to === anim('greeting-v3').id);
    for (const f of [30, 35, 39, 60]) {
      const T = mixX.meta.frames[f].time;
      const m = mixFrame(p, [{ anim: anim('idle-v3'), start: 0, mix: 0 }, { anim: anim('greeting-v3'), start: 1, mix: rule.duration }], T, 'setup');
      const img = composite(p, m.discrete.anim, m.discrete.t, images, mixX.meta.width, mixX.meta.height, mixX.meta.origin.x, mixX.meta.origin.y, mixX.meta.scale, m.worlds, null, { opacity: m.opacity, deform: m.deform });
      check('idle-v3 → greeting-v3', mixX, f, img);
    }
    metrics.f = report;
    writeFileSync(path.join(OUT, 'reference-diff.txt'), report.join('\n') + '\n');
  });

  it('raised no uncaught page errors', () => {
    assert.deepEqual(pageErrors, []);
  });
});
