// Headless CLI / API (scripts/rigsmith.ts): every command is run as a subprocess and
// judged by its JSON output, exit code and files. Rendering is compared with the
// editor's own UI export of the same project (byte-identical ZIPs), the atlas with an
// independent decoder, and the brand pipeline with a second run (identical sha256).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { exportRuntime } from '../../src/model/exportRuntime.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { decodePng } from '../support/png-decode.ts';
import { encodePng } from '../support/png-encode.ts';
import { lottieProject } from '../support/lottie-fixture.ts';
import { ffmpegFrames, ffprobe, hasFfmpeg } from '../support/media-check.ts';
import { richProject } from '../support/runtime-fixture.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, ROOT, launchIsolated, pickPort, startPreview } from '../e2e/harness.ts';
import type { ChildProcess } from 'node:child_process';

const OUT = path.join(EVIDENCE, 'roadmap/p4-cli');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const RIG = path.join(OUT, 'rig.rig.json');
writeFileSync(RIG, serializeProject(richProject()));
const sha = (f: string | Uint8Array) => createHash('sha256').update(typeof f === 'string' ? readFileSync(f) : f).digest('hex');
const report: string[] = [];

function cli(...args: string[]): { code: number | null; json: any; stderr: string } {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  report.push(`$ rigsmith ${args.map((a) => (path.isAbsolute(a) ? path.relative(ROOT, a) : a)).join(' ')} → exit ${r.status}`);
  return { code: r.status, json: JSON.parse(r.stdout), stderr: r.stderr };
}

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  server = await startPreview(port);
  ctx = await launchIsolated('cli-editor');
  page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
  await page.getByTestId('open-input').setInputFiles(RIG);
  await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length > 0);
});

after(async () => {
  writeFileSync(path.join(OUT, 'report.txt'), report.join('\n') + '\n');
  await ctx?.close();
  server?.kill();
});

async function editorDownload(testId: string, file: string): Promise<string> {
  const dl = page.waitForEvent('download');
  await page.getByTestId(testId).click();
  const target = path.join(OUT, file);
  await (await dl).saveAs(target);
  return target;
}

describe('pure-Node commands', () => {
  it('validate / info: JSON on stdout, exit codes 0 / 1 / 2', () => {
    const ok = cli('validate', RIG);
    assert.equal(ok.code, 0);
    assert.equal(ok.json.ok, true);
    assert.deepEqual([ok.json.bones, ok.json.attachments, ok.json.meshes, ok.json.skins], [9, 6, 1, ['alt']]);
    const bad = path.join(OUT, 'bad.rig.json');
    const o = JSON.parse(readFileSync(RIG, 'utf8'));
    o.attachments[0].boneId = 'ghost';
    writeFileSync(bad, JSON.stringify(o));
    const r = cli('validate', bad);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.match(r.json.errors.join('\n'), /missing bone/);
    assert.equal(cli('validate', path.join(OUT, 'nope.json')).code, 2);
    assert.equal(cli('frobnicate', RIG).code, 2);
    const u = cli('render', RIG, '--anim', 'wave', '--fps', 'fast', '--out', path.join(OUT, 'x.zip'));
    assert.equal(u.code, 2);
    assert.match(u.json.error, /--fps must be a number/);
    assert.ok(!existsSync(path.join(OUT, 'x.zip')));
    assert.equal(cli('info', RIG).json.animations.length, 2);
  });

  it('runtime: equals the model export; the editor UI export is byte-identical', async () => {
    const out = path.join(OUT, 'rig.runtime.json');
    const r = cli('runtime', RIG, '--out', out);
    assert.equal(r.code, 0);
    const p = parseProject(readFileSync(RIG, 'utf8'));
    assert.ok(p.ok);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), JSON.parse(JSON.stringify(exportRuntime(p.project))));
    const ui = await editorDownload('export-runtime', 'ui.runtime.json');
    assert.equal(sha(out), sha(ui), 'CLI and editor runtime files are identical');
  });

  it('atlas: deterministic, reconstructs every image, same pixels and metadata as the editor UI', async () => {
    const a = cli('atlas', RIG, '--out', path.join(OUT, 'atlas-a'));
    const b = cli('atlas', RIG, '--out', path.join(OUT, 'atlas-b'));
    assert.equal(a.code, 0);
    assert.deepEqual(a.json.outputs.map((f: string) => sha(f)), b.json.outputs.map((f: string) => sha(f)), 'two runs, identical bytes');
    const meta = JSON.parse(readFileSync(a.json.outputs[0], 'utf8'));
    const page0 = decodePng(readFileSync(a.json.outputs[1]));
    const proj = JSON.parse(readFileSync(RIG, 'utf8'));
    for (const r of meta.regions) {
      const src = decodePng(Buffer.from(proj.images.find((i: any) => i.name === r.name).dataUrl.split(',')[1], 'base64'));
      for (let j = 0; j < r.height; j++)
        for (let i = 0; i < r.width; i++) {
          const s = ((r.offsetY + j) * src.width + r.offsetX + i) * 4, d = ((r.y + j) * page0.width + r.x + i) * 4;
          assert.deepEqual([...page0.data.subarray(d, d + 4)], [...src.data.subarray(s, s + 4)]);
        }
    }
    await page.getByTestId('export-atlas').click();
    const zip = await editorDownload('atlas-export', 'ui-atlas.zip');
    await page.getByTestId('atlas-cancel').click();
    const files = readZip(readFileSync(zip));
    assert.deepEqual(JSON.parse(files.find((f) => f.name.endsWith('.json'))!.data.toString('utf8')), meta, 'same atlas metadata');
    const uiPage = decodePng(files.find((f) => f.name.endsWith('-0.png'))!.data);
    assert.deepEqual([...uiPage.data], [...page0.data], 'same page pixels (PNG bytes may differ: different zlib)');
    report.push(`atlas page sha256 cli ${sha(readFileSync(a.json.outputs[1]))} / editor ${sha(files.find((f) => f.name.endsWith('-0.png'))!.data)}`);
  });

  it('authoring: add-image, replace-image (size checked), skin, set-mix; outputs are valid projects', async () => {
    const png = path.join(OUT, 'stripe.png');
    const d = new Uint8Array(40 * 90 * 4).map((_, i) => (i % 4 === 3 ? 255 : i % 4 === 0 ? 200 : 60));
    writeFileSync(png, encodePng(40, 90, d));
    const small = path.join(OUT, 'small.png');
    writeFileSync(small, encodePng(4, 4, new Uint8Array(64).fill(255)));
    const p1 = path.join(OUT, 'auth-1.rig.json');
    assert.equal(cli('add-image', RIG, '--file', png, '--out', p1).code, 0);
    const dup = cli('add-image', p1, '--file', png, '--out', p1);
    assert.equal(dup.code, 1);
    assert.match(dup.json.error, /already exists/);
    const p2 = path.join(OUT, 'auth-2.rig.json');
    const rs = cli('replace-image', p1, '--image', 'torso.png', '--file', small, '--out', p2);
    assert.equal(rs.code, 1);
    assert.match(rs.json.error, /is 4×4 but “torso.png” is 40×90/);
    assert.ok(!existsSync(p2), 'nothing written on error');
    assert.equal(cli('replace-image', p1, '--image', 'torso.png', '--file', png, '--out', p2).code, 0);
    const p3 = path.join(OUT, 'auth-3.rig.json');
    const sk = cli('skin', p2, '--name', 'stripes', '--set', 'torso=stripe.png', '--keyed', 'upper:arm-raised.png=bead.png', '--out', p3);
    assert.equal(sk.code, 0);
    assert.deepEqual(sk.json.skins, [{ name: 'alt', entries: 2 }, { name: 'stripes', entries: 2 }]);
    assert.equal(cli('skin', p2, '--name', 'x', '--set', 'ghost=stripe.png', '--out', p3).code, 1);
    const p4 = path.join(OUT, 'auth-4.rig.json');
    assert.equal(cli('set-mix', p3, '--from', 'rest', '--to', 'wave', '--duration', '0.25', '--out', p4).code, 0);
    const fin = parseProject(readFileSync(p4, 'utf8'));
    assert.ok(fin.ok);
    const pr = fin.project;
    assert.equal(pr.images.find((i) => i.name === 'torso.png')!.dataUrl, pr.images.find((i) => i.name === 'stripe.png')!.dataUrl, 'replaced pixels');
    assert.deepEqual(pr.mixes!.map((m) => m.duration).sort(), [0.25, 0.3]);
    assert.ok(pr.skins!.find((s) => s.name === 'stripes')!.entries.some((e) => e.from));
  });

  it('lottie: subset rig exports with diagnostics; out-of-subset rig and unknown names exit 1 and write nothing', () => {
    const sub = path.join(OUT, 'lottie-subset.rig.json');
    writeFileSync(sub, serializeProject(lottieProject()));
    const out = path.join(OUT, 'hop.lottie.json');
    const ok = cli('lottie', sub, '--anim', 'hop', '--skin', 'alt', '--out', out);
    assert.equal(ok.code, 0, JSON.stringify(ok.json));
    assert.deepEqual(ok.json.diagnostics.map((d: any) => d.feature), ['visibility / image keys', 'validation']);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).nm, 'lottie-subset — hop (alt)');
    const bad = path.join(OUT, 'refused.lottie.json');
    const r = cli('lottie', RIG, '--anim', 'wave', '--out', bad);
    assert.equal(r.code, 1);
    assert.match(r.json.errors.join('\n'), /mesh — band/);
    assert.equal(cli('lottie', sub, '--anim', 'nope', '--out', bad).code, 1);
    assert.equal(cli('lottie', sub, '--anim', 'hop', '--skin', 'nope', '--out', bad).code, 1);
    assert.ok(!existsSync(bad));
  });
});

describe('clip specs (R6)', () => {
  it('clip export → lint → apply --replace round-trips; create refuses an existing name; lint names problems (exit 1, nothing written)', () => {
    const spec = path.join(OUT, 'wave.clip.yaml');
    assert.equal(cli('clip', 'export', RIG, '--anim', 'wave', '--out', spec).code, 0);
    assert.match(readFileSync(spec, 'utf8'), /^format: rigsmith\.clip$/m);
    assert.equal(cli('clip', 'lint', RIG, '--spec', spec).json.clean, true);
    const created = cli('clip', 'apply', RIG, '--spec', spec, '--out', path.join(OUT, 'c1.rig.json'));
    assert.equal(created.code, 1);
    assert.match(created.json.errors[0], /exists; apply with replace/);
    assert.ok(!existsSync(path.join(OUT, 'c1.rig.json')));
    const out = path.join(OUT, 'c2.rig.json');
    const r = cli('clip', 'apply', RIG, '--spec', spec, '--replace', '--out', out);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    const again = path.join(OUT, 'c3.rig.json');
    cli('clip', 'apply', out, '--spec', spec, '--replace', '--out', again);
    assert.equal(sha(out), sha(again), 'applying twice gives the same bytes');
    const a = parseProject(readFileSync(RIG, 'utf8')), b = parseProject(readFileSync(out, 'utf8'));
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.deepEqual(b.project.animations.find((x) => x.name === 'wave'), a.project.animations.find((x) => x.name === 'wave'), 'the replaced animation equals the original (key order of tracks aside)');
    // JSON specs too; a new name creates.
    const json = path.join(OUT, 'wave.clip.json');
    cli('clip', 'export', RIG, '--anim', 'wave', '--out', json);
    const spec2 = JSON.parse(readFileSync(json, 'utf8'));
    spec2.name = 'wave2';
    writeFileSync(json, JSON.stringify(spec2));
    const c = cli('clip', 'apply', RIG, '--spec', json, '--out', path.join(OUT, 'c4.rig.json'));
    assert.deepEqual([c.code, c.json.created], [0, true]);
    const bad = path.join(OUT, 'bad.clip.yaml');
    writeFileSync(bad, 'name: wave\nbones:\n  nobody: {rotate: [[0, 1]]}\n  torso: {rotate: [[99, 1, wobbly]]}\n');
    const lint = cli('clip', 'lint', RIG, '--spec', bad);
    assert.equal(lint.code, 1);
    assert.deepEqual(lint.json.errors.length, 3, lint.json.errors.join('\n'));
    writeFileSync(bad, 'name: wave\nbones: &a {}\n');
    const yaml = cli('clip', 'lint', RIG, '--spec', bad);
    assert.equal(yaml.code, 1);
    assert.match(yaml.json.errors[0], /line 2: .*anchors/);
  });

  it('key / deform-key / draw-order / constraint-key / event add one key each through the same applier', () => {
    const out = path.join(OUT, 'k.rig.json');
    const steps: string[][] = [
      ['key', RIG, '--anim', 'wave', '--bone', 'torso', '--channel', 'rotate', '--at', '10', '--value', '-70', '--ease', 'ease-out'],
      ['key', out, '--anim', 'wave', '--bone', 'lower-target', '--channel', 'translate', '--at', '0.2s', '--value', '5,6', '--ease-y', 'step'],
      ['key', out, '--anim', 'wave', '--slot', 'upper', '--channel', 'image', '--at', '25', '--value', 'arm.png'],
      ['key', out, '--anim', 'wave', '--slot', 'torso', '--channel', 'color', '--at', '5', '--value', '#ff000080'],
      ['deform-key', out, '--anim', 'wave', '--att', 'band', '--at', '20', '--rest'],
      ['draw-order', out, '--anim', 'wave', '--at', '20', '--move', 'band', '--to', 'front'],
      ['constraint-key', out, '--anim', 'wave', '--constraint', 'lower-ik', '--channel', 'mix', '--at', '25', '--value', '0.2'],
      ['event', out, '--anim', 'wave', '--at', '6', '--name', 'prop_flash', '--payload', '3'],
      ['event', out, '--anim', 'wave', '--at', '0.5s', '--name', 'sfx:win', '--payload', 'big'],
    ];
    for (const s of steps) assert.equal(cli(...s, '--out', out).code, 0, s.join(' '));
    const r = parseProject(readFileSync(out, 'utf8'));
    assert.ok(r.ok);
    if (!r.ok) return;
    const w = r.project.animations.find((a) => a.name === 'wave')!;
    assert.deepEqual(w.tracks.torso.rotate.find((k) => Math.abs(k.time - 1 / 3) < 1e-9)?.curve, [0, 0, 0.58, 1]);
    assert.equal(w.tracks.arm_target.translate.find((k) => k.time === 0.2)?.interpY, 'step');
    assert.deepEqual(w.slots!.a_upper.image!.at(-1), { time: 25 / 30, imageId: 'i_arm' });
    assert.deepEqual(w.drawOrder!.at(-1)!.order.at(-1), 'a_band');
    assert.deepEqual(w.constraints!.ik_arm.mix!.at(-1)!.value, [0.2]);
    assert.deepEqual(w.events, { prop_flash: [{ time: 0.2, payload: 3 }], 'sfx:win': [{ time: 0.5, payload: 'big' }] });
    assert.equal(r.project.version, 3);
    const miss = cli('key', RIG, '--anim', 'nope', '--bone', 'torso', '--channel', 'rotate', '--at', '1', '--value', '1', '--out', path.join(OUT, 'k2.rig.json'));
    assert.equal(miss.code, 1);
    assert.match(miss.json.errors[0], /No animation named “nope” to add keys to/);
    assert.equal(cli('draw-order', RIG, '--anim', 'wave', '--at', '1', '--out', path.join(OUT, 'k2.rig.json')).code, 2);
  });

  it('spring adds a follow-through chain (R8); bake-springs turns it into keys; bad input exits 1 / 2 and writes nothing', () => {
    const out = path.join(OUT, 's.rig.json');
    const r = cli('spring', RIG, '--bones', 'm1', '--follow', '--stiffness', '0.1', '--gain', '1.4', '--max', '40', '--out', out);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.deepEqual(r.json.spring, { name: 'm1-spring', bones: ['m1', 'm2'], stiffness: 0.1, damping: 0.18, gain: 1.4, max: 40, blend: 12, mix: 1 });
    const p = parseProject(readFileSync(out, 'utf8'));
    assert.ok(p.ok && p.project.version === 3 && p.project.springs?.length === 1);
    const lot = cli('lottie', out, '--anim', 'wave', '--out', path.join(OUT, 's.lottie.json'));
    assert.match(lot.json.errors.join('\n'), /Bake springs first/);
    const baked = path.join(OUT, 's-baked.rig.json');
    const b = cli('bake-springs', out, '--out', baked);
    assert.deepEqual([b.code, b.json.springs, b.json.bones, b.json.animations], [0, 1, 4, 2]);
    const q = parseProject(readFileSync(baked, 'utf8'));
    assert.ok(q.ok && !q.project.springs && q.project.animations[0].tracks.m2.rotate.length === 31);
    const bad = path.join(OUT, 's-bad.rig.json');
    assert.equal(cli('spring', out, '--bones', 'm2', '--out', bad).code, 1, 'already in a spring');
    assert.equal(cli('spring', RIG, '--bones', 'm1', '--damping', '3', '--out', bad).code, 1);
    assert.equal(cli('spring', RIG, '--bones', 'm1,m2', '--follow', '--out', bad).code, 2);
    assert.equal(cli('bake-springs', RIG, '--out', bad).code, 1, 'nothing to bake');
    assert.ok(!existsSync(bad));
  });

  it('emitter makes an FX socket (R9); key --channel rate keys it; --clear drops it and its keys; bad input exits 1 / 2', () => {
    const out = path.join(OUT, 'e.rig.json');
    const r = cli('emitter', RIG, '--att', 'bead1', '--recipe', 'glint.sparkle', '--rate', '30', '--out', out);
    assert.deepEqual([r.code, r.json.emitter], [0, { recipe: 'glint.sparkle', rate: 30 }], JSON.stringify(r.json));
    assert.equal(cli('key', out, '--anim', 'wave', '--slot', 'bead1', '--channel', 'rate', '--at', '10', '--value', '90', '--out', out).code, 0);
    const p = parseProject(readFileSync(out, 'utf8'));
    assert.ok(p.ok && p.project.version === 3);
    if (p.ok) assert.deepEqual(p.project.animations.find((a) => a.name === 'wave')!.slots!.a_bead1.rate!.map((k) => k.value), [[90]]);
    const rt = path.join(OUT, 'e.runtime.json');
    assert.equal(cli('runtime', out, '--out', rt).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(rt, 'utf8')).attachments.find((a: any) => a.name === 'bead1').emitter, { recipe: 'glint.sparkle', rate: 30 });
    const cleared = path.join(OUT, 'e2.rig.json');
    assert.equal(cli('emitter', out, '--att', 'bead1', '--clear', '--out', cleared).code, 0);
    const q = parseProject(readFileSync(cleared, 'utf8'));
    assert.ok(q.ok && !q.project.attachments.find((a) => a.name === 'bead1')!.emitter && !q.project.animations.find((a) => a.name === 'wave')!.slots?.a_bead1?.rate);
    const bad = path.join(OUT, 'e-bad.rig.json');
    assert.equal(cli('emitter', RIG, '--att', 'bead1', '--recipe', 'no spaces', '--out', bad).code, 1);
    assert.equal(cli('emitter', RIG, '--att', 'band', '--recipe', 'x', '--out', bad).code, 1, 'a mesh');
    assert.equal(cli('emitter', RIG, '--att', 'bead1', '--out', bad).code, 2);
    assert.equal(cli('key', RIG, '--anim', 'wave', '--slot', 'torso', '--channel', 'rate', '--at', '1', '--value', '5', '--out', bad).code, 1, 'not an emitter');
    assert.ok(!existsSync(bad));
  });

  it('mask clips an attachment to another (R11) and clears it; chains and missing names exit 1, bad usage 2', () => {
    const out = path.join(OUT, 'm.rig.json');
    const r = cli('mask', RIG, '--att', 'bead2', '--to', 'bead1', '--out', out);
    assert.deepEqual([r.code, r.json.clip], [0, 'bead1'], JSON.stringify(r.json));
    const p = parseProject(readFileSync(out, 'utf8'));
    assert.ok(p.ok && p.project.version === 3 && p.project.attachments.find((a) => a.name === 'bead2')!.clip === 'a_bead1');
    const bad = path.join(OUT, 'm-bad.rig.json');
    assert.equal(cli('mask', out, '--att', 'torso', '--to', 'bead2', '--out', bad).code, 1, 'masks are one level deep');
    assert.equal(cli('mask', RIG, '--att', 'bead2', '--to', 'nope', '--out', bad).code, 1);
    assert.equal(cli('mask', RIG, '--att', 'bead2', '--out', bad).code, 2);
    assert.ok(!existsSync(bad));
    const c = cli('mask', out, '--att', 'bead2', '--clear', '--out', path.join(OUT, 'm2.rig.json'));
    assert.deepEqual([c.code, c.json.clip], [0, null]);
  });

  it('bake-constraints (R14) writes IK and path constraints into keys and removes them; nothing to bake exits 1', () => {
    const out = path.join(OUT, 'b.rig.json');
    const r = cli('bake-constraints', RIG, '--out', out);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.ok(r.json.constraints >= 2 && r.json.bones >= 3 && r.json.animations === 2);
    const p = parseProject(readFileSync(out, 'utf8'));
    assert.ok(p.ok && !p.project.ik && !p.project.pathConstraints);
    assert.equal(cli('bake-constraints', out, '--out', path.join(OUT, 'b2.rig.json')).code, 1);
    assert.ok(!existsSync(path.join(OUT, 'b2.rig.json')));
  });

  it('smear (R13) adds smear images and keys the swaps; slow clips and unknown names exit 1, bad usage 2; nothing written on failure', () => {
    const out = path.join(OUT, 's.rig.json');
    const r = cli('smear', RIG, '--anim', 'wave', '--att', 'upper', '--min-px', '2', '--out', out);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    const frames: number[] = r.json.frames.upper;
    assert.ok(frames.length > 0 && r.json.images.length === frames.length);
    const p = parseProject(readFileSync(out, 'utf8'));
    assert.ok(p.ok);
    const keys = p.project.animations.find((a) => a.name === 'wave')!.slots!.a_upper.image!;
    assert.deepEqual(keys.filter((k) => k.imageId.includes('~smear~')).map((k) => Math.round(k.time * 30)), frames.filter((f) => f < 30), 'one swap per fast frame (a loop’s last frame is frame 0)');
    const bad = path.join(OUT, 's-bad.rig.json');
    assert.equal(cli('smear', RIG, '--anim', 'wave', '--att', 'upper', '--out', bad).code, 1, 'nothing moves 40 px a frame');
    assert.equal(cli('smear', RIG, '--anim', 'wave', '--att', 'nope', '--out', bad).code, 1);
    assert.equal(cli('smear', RIG, '--anim', 'wave', '--out', bad).code, 2);
    assert.equal(cli('smear', RIG, '--anim', 'wave', '--att', 'upper', '--min-px', '0', '--out', bad).code, 2);
    assert.ok(!existsSync(bad));
  });
});

describe('rendering (headless Chrome for Testing via render.html)', () => {
  it('render: byte-identical to the editor UI sequence export (plain, skin, sub-range)', async () => {
    for (const [label, args, ui] of [
      ['wave', [], async () => {
        await page.getByTestId('export-sequence').click();
        await page.getByTestId('seq-anim').selectOption({ label: 'wave' });
        await page.getByTestId('seq-skin').selectOption({ label: '(no skin)' });
      }],
      ['wave skin alt, frames 5–12 at 24 fps, scale 1.5', ['--skin', 'alt', '--fps', '24', '--start', '5', '--end', '12', '--scale', '1.5'], async () => {
        await page.getByTestId('export-sequence').click();
        await page.getByTestId('seq-anim').selectOption({ label: 'wave' });
        await page.getByTestId('seq-skin').selectOption({ label: 'alt' });
        for (const [id, v] of [['seq-fps', '24'], ['seq-start', '5'], ['seq-end', '12'], ['seq-scale', '1.5']]) {
          await page.getByTestId(id).fill(v);
          await page.getByTestId(id).press('Enter');
        }
      }],
      // LP-004: on the accelerated raster, half-scale exports depended on what had been
      // drawn before (the dialog and the CLI disagreed on early frames of long exports).
      // Exports now draw on the software path (exportContext); this case was red without it.
      ['wave at 120 fps, scale 0.5 (LP-004)', ['--fps', '120', '--start', '0', '--end', '119', '--scale', '0.5'], async () => {
        await page.getByTestId('export-sequence').click();
        await page.getByTestId('seq-anim').selectOption({ label: 'wave' });
        await page.getByTestId('seq-skin').selectOption({ label: '(no skin)' });
        for (const [id, v] of [['seq-fps', '120'], ['seq-start', '0'], ['seq-end', '119'], ['seq-scale', '0.5']]) {
          await page.getByTestId(id).fill(v);
          await page.getByTestId(id).press('Enter');
        }
      }],
    ] as const) {
      const out = path.join(OUT, `cli-${label.split(' ')[0]}-${args.length}.zip`);
      const r = cli('render', RIG, '--anim', 'wave', ...args, '--out', out);
      assert.equal(r.code, 0, JSON.stringify(r.json));
      await ui();
      const editor = await editorDownload('seq-export', `ui-${label.split(' ')[0]}-${args.length}.zip`);
      report.push(`${label}: cli ${sha(out)} editor ${sha(editor)} (${r.json.frames} frames ${r.json.width}×${r.json.height})`);
      assert.equal(sha(out), sha(editor), `${label}: identical ZIP`);
    }
    await page.getByTestId('skin-active').selectOption({ label: '(default images)' });
  });

  it('mix: byte-identical to the editor Mix dialog export', async () => {
    const out = path.join(OUT, 'cli-mix.zip');
    const r = cli('mix', RIG, '--from', 'wave', '--to', 'rest', '--at', '0.5', '--out', out);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.equal(r.json.animation, 'wave-to-rest');
    await page.getByTestId('mix-open').click();
    await page.getByTestId('mix-from').selectOption({ label: 'wave' });
    await page.getByTestId('mix-to').selectOption({ label: 'rest' });
    await page.getByTestId('mix-start').fill('0.5');
    await page.getByTestId('mix-start').press('Enter');
    const editor = await editorDownload('mix-export', 'ui-mix.zip');
    await page.getByTestId('mix-close').click();
    assert.equal(sha(out), sha(editor));
  });

  it('errors: unknown animation / skin, capacity, missing Chrome (exit 3); cancel leaves nothing (exit 4)', async () => {
    const r1 = cli('render', RIG, '--anim', 'dance', '--out', path.join(OUT, 'e1.zip'));
    assert.equal(r1.code, 1);
    assert.match(r1.json.errors[0], /No animation named “dance”/);
    assert.match(cli('render', RIG, '--anim', 'wave', '--skin', 'neon', '--out', path.join(OUT, 'e1.zip')).json.errors[0], /No skin named “neon”/);
    const scale = cli('render', RIG, '--anim', 'wave', '--scale', '40', '--out', path.join(OUT, 'e1.zip'));
    assert.equal(scale.code, 1);
    assert.match(scale.json.errors.join(' '), /Scale must be greater than 0 and at most 8/);
    const big = cli('render', RIG, '--anim', 'wave', '--scale', '8', '--fps', '240', '--out', path.join(OUT, 'e1.zip'));
    assert.equal(big.code, 1);
    assert.match(big.json.errors.join(' '), /too large to export/);
    const range = cli('render', RIG, '--anim', 'wave', '--start', '20', '--end', '3', '--out', path.join(OUT, 'e1.zip'));
    assert.equal(range.code, 1);
    assert.ok(!existsSync(path.join(OUT, 'e1.zip')));
    const env = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), 'render', RIG, '--anim', 'wave', '--out', path.join(OUT, 'e2.zip')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, RIGSMITH_CFT: '/nonexistent/chrome' } });
    assert.equal(env.status, 3);
    assert.match(JSON.parse(env.stdout).error, /Chrome for Testing not found/);
    // Cancel: SIGINT after the first frames → exit 4, no output.
    const out = path.join(OUT, 'cancelled.zip');
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), 'render', RIG, '--anim', 'wave', '--fps', '120', '--scale', '2', '--out', out], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout!.on('data', (c: Buffer) => (stdout += c.toString()));
    await new Promise<void>((resolve) => child.stderr!.on('data', (c: Buffer) => /frame [3-9]\//.test(c.toString()) && resolve()));
    child.kill('SIGINT');
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c: number | null) => resolve(c)));
    assert.equal(code, 4);
    assert.match(JSON.parse(stdout).error, /Cancelled/);
    assert.ok(!existsSync(out) && !existsSync(`${out}.partial`), 'nothing written');
    // Only this checkout's CLI profile: other Rigsmith checkouts on the machine may be rendering.
    const ps = spawnSync('pgrep', ['-f', `${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.hermes/browser-profiles/cli([^-]|$)`], { encoding: 'utf8' });
    assert.equal(ps.stdout.trim(), '', 'the CLI browser is closed');
  });

  it('limits and profile (R12): --max-frames / --max-megapixels bounded by the ceilings; --profile-dir keeps the browser profile out of the checkout', () => {
    const few = cli('render', RIG, '--anim', 'wave', '--max-frames', '5', '--out', path.join(OUT, 'l1.zip'));
    assert.equal(few.code, 1);
    assert.match(few.json.errors.join(' '), /more than the 5-frame limit/);
    for (const bad of [['--max-frames', '0'], ['--max-frames', '20001'], ['--max-megapixels', '6001']]) {
      const r = cli('render', RIG, '--anim', 'wave', ...bad, '--out', path.join(OUT, 'l1.zip'));
      assert.equal(r.code, 2, bad.join(' '));
    }
    const tight = cli('render', RIG, '--anim', 'wave', '--max-megapixels', '1', '--out', path.join(OUT, 'l1.zip'));
    assert.equal(tight.code, 1);
    assert.match(tight.json.errors.join(' '), /over 1 megapixels in total; the --max-megapixels limit/);
    assert.ok(!existsSync(path.join(OUT, 'l1.zip')));
    const dir = path.join(OUT, 'profiles');
    rmSync(dir, { recursive: true, force: true });
    const ok = cli('render', RIG, '--anim', 'wave', '--max-frames', '4000', '--profile-dir', dir, '--out', path.join(OUT, 'l2.zip'));
    assert.equal(ok.code, 0, JSON.stringify(ok.json));
    assert.deepEqual(readdirSync(dir), [], 'the throw-away profile is removed');
    assert.equal(cli('render', RIG, '--anim', 'wave', '--out', path.join(OUT, 'l3.zip')).code, 0);
    assert.equal(sha(path.join(OUT, 'l2.zip')), sha(path.join(OUT, 'l3.zip')), 'limits do not change the pixels');
  });

  it('frame (RV-003): --frame project / x,y,w,h / --frame-from match the editor project-frame export; clips with a warning', async () => {
    // The editor sets a fitted project frame (visible control); the CLI renders with the same rect.
    await page.getByTestId('frame-fit').click();
    const frame = await page.evaluate(() => (window as any).__rigsmith.project().frame);
    assert.ok(frame && frame.width > 0, 'the editor stored a frame');
    const rect = `${frame.x},${frame.y},${frame.width},${frame.height}`;
    const framed = path.join(OUT, 'framed.rig.json');
    const base = parseProject(readFileSync(RIG, 'utf8'));
    assert.ok(base.ok);
    writeFileSync(framed, serializeProject({ ...base.project, frame }));
    const zips: Record<string, string> = {};
    for (const [label, file, extra] of [['project', framed, ['--frame', 'project']], ['rect', RIG, ['--frame', rect]], ['from', RIG, ['--frame-from', framed]]] as const) {
      const out = path.join(OUT, `cli-frame-${label}.zip`);
      const r = cli('render', file, '--anim', 'wave', ...extra, '--out', out);
      assert.equal(r.code, 0, JSON.stringify(r.json));
      assert.deepEqual([r.json.width, r.json.height, r.json.frame], [frame.width, frame.height, 'project'], label);
      zips[label] = sha(out);
    }
    await page.getByTestId('export-sequence').click();
    await page.getByTestId('seq-anim').selectOption({ label: 'wave' });
    await page.getByTestId('seq-skin').selectOption({ label: '(no skin)' });
    assert.equal(await page.getByTestId('seq-frame').inputValue(), 'project', 'the dialog defaults to the project frame');
    const editor = await editorDownload('seq-export', 'ui-frame.zip');
    report.push(`frame ${rect}: cli project ${zips.project} rect ${zips.rect} from ${zips.from} editor ${sha(editor)}`);
    assert.deepEqual([zips.rect, zips.from, sha(editor)], [zips.project, zips.project, zips.project], 'all four are byte-identical');
    const mix = cli('mix', framed, '--from', 'wave', '--to', 'rest', '--at', '0.5', '--frame', 'project', '--out', path.join(OUT, 'cli-frame-mix.zip'));
    assert.equal(mix.code, 0, JSON.stringify(mix.json));
    assert.deepEqual([mix.json.width, mix.json.height, mix.json.warnings], [frame.width, frame.height, []]);
    // A frame too small for the art: same size, clipped, a warning on stderr and in the JSON.
    const small = cli('render', RIG, '--anim', 'wave', '--frame', `${frame.x},${frame.y},40,40`, '--out', path.join(OUT, 'cli-frame-small.zip'));
    assert.equal(small.code, 0);
    assert.deepEqual([small.json.width, small.json.height], [40, 40]);
    assert.match(small.json.warnings.join(' '), /extends outside the project frame .* is clipped; the frame size is kept/);
    assert.match(small.stderr, /warning: Art of/);
    // Errors: both flags (usage, exit 2); --frame project without a frame (exit 1); bad rect (exit 2).
    assert.equal(cli('render', framed, '--anim', 'wave', '--frame', 'project', '--frame-from', framed, '--out', path.join(OUT, 'e3.zip')).code, 2);
    const none = cli('render', RIG, '--anim', 'wave', '--frame', 'project', '--out', path.join(OUT, 'e3.zip'));
    assert.equal(none.code, 1);
    assert.match(none.json.errors.join(' '), /has no frame/);
    assert.equal(cli('render', RIG, '--anim', 'wave', '--frame', '1,2,3', '--out', path.join(OUT, 'e3.zip')).code, 2);
    assert.equal(cli('render', RIG, '--anim', 'wave', '--frame-from', RIG, '--out', path.join(OUT, 'e3.zip')).code, 1);
    assert.ok(!existsSync(path.join(OUT, 'e3.zip')));
    await page.getByTestId('frame-clear').click();
  });

  it('sequence (RV-009): set-sequence saves an ordered clip list; sequence renders it byte-identical to the editor Sequences dialog', async () => {
    const seqRig = path.join(OUT, 'sequenced.rig.json');
    const set = cli('set-sequence', RIG, '--name', 'intro', '--steps', 'wave*2, rest, wave', '--loop', '--out', seqRig);
    assert.equal(set.code, 0, JSON.stringify(set.json));
    assert.deepEqual(set.json.sequence, { name: 'intro', loop: true, steps: [{ animation: 'wave', repeat: 2 }, { animation: 'rest', repeat: 1 }, { animation: 'wave', repeat: 1 }] });
    const saved = parseProject(readFileSync(seqRig, 'utf8'));
    assert.ok(saved.ok && saved.project.sequences?.length === 1, 'a valid project with the sequence');
    assert.equal(cli('validate', seqRig).code, 0);
    // Bad step lists exit 1 and write nothing.
    for (const steps of ['wave*0', 'dance', 'wave*101', '']) {
      const bad = cli('set-sequence', RIG, '--name', 'x', '--steps', steps, '--out', path.join(OUT, 'e-seq.rig.json'));
      assert.notEqual(bad.code, 0, steps);
      assert.ok(!existsSync(path.join(OUT, 'e-seq.rig.json')));
    }
    const out = path.join(OUT, 'cli-sequence.zip');
    const r = cli('sequence', seqRig, '--name', 'intro', '--out', out);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    // 30 fps: wave 30 frames × 2, rest 15, wave 30.
    assert.equal(r.json.frames, 105);
    assert.equal(readZip(readFileSync(out)).filter((f) => f.name.endsWith('.png')).length, 105);
    assert.deepEqual(r.json.sequence.steps.map((s: any) => [s.animation, s.repeat, s.startFrame, s.frames]), [['wave', 2, 0, 60], ['rest', 1, 60, 15], ['wave', 1, 75, 30]]);
    assert.equal(cli('sequence', seqRig, '--name', 'outro', '--out', path.join(OUT, 'e-seq.zip')).code, 1);
    assert.ok(!existsSync(path.join(OUT, 'e-seq.zip')));
    await page.getByTestId('open-input').setInputFiles(seqRig);
    await page.waitForFunction(() => (window as any).__rigsmith.project().sequences?.length === 1);
    await page.getByTestId('sequences-open').click();
    assert.equal(await page.getByTestId('seqd-summary').getAttribute('data-frames'), '105');
    const editor = await editorDownload('seqd-export', 'ui-sequence.zip');
    await page.getByTestId('seqd-close').click();
    report.push(`sequence intro: cli ${sha(out)} editor ${sha(editor)}`);
    assert.equal(sha(out), sha(editor), 'byte-identical ZIPs');
    await page.getByTestId('open-input').setInputFiles(RIG);
    await page.waitForFunction(() => !(window as any).__rigsmith.project().sequences);
  });
});

describe('media: WebM (VP9 alpha) / MP4 (H.264) via the local ffmpeg; decoded by ffmpeg, compared with the PNG sequence', { skip: !hasFfmpeg() && 'ffmpeg is not installed' }, () => {
  let ref: { width: number; height: number; data: Uint8Array }[] = [];
  before(() => {
    const out = path.join(OUT, 'media-ref.zip');
    assert.equal(cli('render', RIG, '--anim', 'wave', '--out', out).code, 0);
    const z = readZip(readFileSync(out));
    ref = z.filter((f) => f.name.endsWith('.png')).sort((a, b) => (a.name < b.name ? -1 : 1)).map((f) => decodePng(f.data));
  });

  it('webm: VP9 with alpha_mode 1, 30 frames at 30/1; alpha and colour within measured bounds; deterministic; plain decode drops alpha', () => {
    const a = path.join(OUT, 'wave-a.webm'), b = path.join(OUT, 'wave-b.webm');
    const r = cli('media', RIG, '--anim', 'wave', '--format', 'webm', '--out', a);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.match(r.json.label, /8-bit alpha; no loop flag/);
    assert.equal(cli('media', RIG, '--anim', 'wave', '--format', 'webm', '--out', b).code, 0);
    assert.equal(sha(a), sha(b), 'two runs, identical bytes (single-threaded bitexact)');
    const p = ffprobe(a);
    assert.deepEqual([p.codec, p.width, p.height, p.frames, p.rate, p.tags.alpha_mode], ['vp9', ref[0].width, ref[0].height, 30, '30/1', '1']);
    const frames = ffmpegFrames(a, p.width, p.height, true);
    assert.equal(frames.length, 30);
    let aErr = 0, aMax = 0, cErr = 0, cN = 0, px = 0;
    frames.forEach((f, i) => {
      const d = ref[i].data;
      for (let k = 0; k < f.length; k += 4) {
        const e = Math.abs(f[k + 3] - d[k + 3]);
        aErr += e;
        aMax = Math.max(aMax, e);
        px++;
        if (d[k + 3] === 255 && f[k + 3] === 255) for (let c = 0; c < 3; c++, cN++) cErr += Math.abs(f[k + c] - d[k + c]);
      }
    });
    const line = `webm: alpha mean abs error ${(aErr / px).toFixed(3)} (max ${aMax}), opaque colour mean abs error ${(cErr / cN).toFixed(2)}`;
    report.push(line);
    assert.ok(aErr / px < 1 && cErr / cN < 4, line);
    // The pitfall, recorded: ffmpeg's native vp9 decoder ignores the alpha side data.
    const plain = ffmpegFrames(a, p.width, p.height, false);
    assert.ok(plain[0].every((v, k) => k % 4 !== 3 || v === 255), 'native decoder: opaque');
  });

  it('mp4: H.264, no alpha, composited on the background, padded to even height; colour within measured bounds', () => {
    for (const bg of ['#ffffff', '#203040']) {
      const out = path.join(OUT, `wave-${bg.slice(1)}.mp4`);
      const r = cli('media', RIG, '--anim', 'wave', '--format', 'mp4', '--background', bg, '--out', out);
      assert.equal(r.code, 0, JSON.stringify(r.json));
      assert.match(r.json.label, /NO alpha — composited on #/);
      const p = ffprobe(out);
      const w = ref[0].width + (ref[0].width % 2), h = ref[0].height + (ref[0].height % 2);
      assert.deepEqual([p.codec, p.width, p.height, p.frames, p.rate], ['h264', w, h, 30, '30/1']);
      const bgc = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
      let err = 0, n = 0;
      ffmpegFrames(out, w, h).forEach((f, i) => {
        const d = ref[i];
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            assert.equal(f[o + 3], 255);
            const inside = x < d.width && y < d.height;
            const s = (y * d.width + x) * 4;
            const al = inside ? d.data[s + 3] / 255 : 0;
            for (let c = 0; c < 3; c++, n++) err += Math.abs(f[o + c] - ((inside ? d.data[s + c] : 0) * al + bgc[c] * (1 - al)));
          }
      });
      const line = `mp4 on ${bg}: ${w}×${h} (source ${ref[0].width}×${ref[0].height}), colour mean abs error vs straight-alpha composite ${(err / n).toFixed(2)}`;
      report.push(line);
      assert.ok(err / n < 3, line);
    }
  });

  it('errors: missing ffmpeg exit 3, GIF over 50 fps exit 1, bad format / background exit 2; nothing written; cancel kills ffmpeg (exit 4)', async () => {
    const out = path.join(OUT, 'err.webm');
    const env = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), 'media', RIG, '--anim', 'wave', '--format', 'webm', '--out', out], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, RIGSMITH_FFMPEG: '/nonexistent/ffmpeg' } });
    assert.equal(env.status, 3);
    assert.match(JSON.parse(env.stdout).error, /needs ffmpeg/);
    const gif = cli('media', RIG, '--anim', 'wave', '--format', 'gif', '--fps', '60', '--out', path.join(OUT, 'err.gif'));
    assert.equal(gif.code, 1);
    assert.match(gif.json.error, /at most 50 fps for GIF/);
    assert.equal(cli('media', RIG, '--anim', 'wave', '--format', 'avi', '--out', out).code, 2);
    assert.equal(cli('media', RIG, '--anim', 'wave', '--format', 'mp4', '--background', 'white', '--out', out).code, 2);
    assert.ok(![out, path.join(OUT, 'err.gif')].some((f) => existsSync(f) || existsSync(`${f}.partial`)));
    const big = path.join(OUT, 'cancelled.webm');
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), 'media', RIG, '--anim', 'wave', '--format', 'webm', '--fps', '120', '--scale', '2', '--out', big], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout!.on('data', (c: Buffer) => (stdout += c.toString()));
    await new Promise<void>((resolve) => child.stderr!.on('data', (c: Buffer) => /encode [1-9]\d*\//.test(c.toString()) && resolve()));
    child.kill('SIGINT');
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c: number | null) => resolve(c)));
    assert.equal(code, 4);
    assert.match(JSON.parse(stdout).error, /Cancelled/);
    assert.ok(!existsSync(big) && !existsSync(`${big}.partial`), 'nothing written');
    assert.equal(spawnSync('pgrep', ['-f', `ffmpeg.*${path.basename(big)}`], { encoding: 'utf8' }).stdout.trim(), '', 'ffmpeg was stopped');
  });

  it('Ctrl+C after every frame was piped, while ffmpeg is still encoding: exit 4, nothing written, encoder stopped', async () => {
    // A stand-in encoder (RIGSMITH_FFMPEG) that lists libvpx-vp9, reads all frames, then
    // keeps "encoding": the cancel must land in the post-pipe phase deterministically.
    const stub = path.join(OUT, 'slow-ffmpeg.sh');
    writeFileSync(stub, '#!/bin/sh\nif [ "$2" = "-encoders" ]; then echo " V....D libvpx-vp9           libvpx VP9"; exit 0; fi\ncat > /dev/null\nexec sleep 59.75\n');
    chmodSync(stub, 0o755);
    const out = path.join(OUT, 'slow-cancel.webm');
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), 'media', RIG, '--anim', 'wave', '--format', 'webm', '--out', out], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RIGSMITH_FFMPEG: stub } });
    let stdout = '';
    child.stdout!.on('data', (c: Buffer) => (stdout += c.toString()));
    await new Promise<void>((resolve) => child.stderr!.on('data', (c: Buffer) => /encode 30\/30/.test(c.toString()) && resolve()));
    await new Promise((r) => setTimeout(r, 300));
    child.kill('SIGINT');
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c: number | null) => resolve(c)));
    assert.equal(code, 4, stdout);
    assert.match(JSON.parse(stdout).error, /Cancelled/);
    assert.ok(!existsSync(out) && !existsSync(`${out}.partial`), 'nothing written');
    assert.equal(spawnSync('pgrep', ['-f', 'slow-ffmpeg.sh|sleep 59.75'], { encoding: 'utf8' }).stdout.trim(), '', 'stand-in encoder stopped');
  });
});

describe('brand pipeline example', () => {
  it('runs end to end through the CLI and is reproducible (identical manifest twice)', () => {
    const runs = ['brand-a', 'brand-b'].map((d) => {
      const dir = path.join(OUT, d);
      const r = spawnSync(process.execPath, [path.join(ROOT, 'examples/brand-pipeline/pipeline.ts'), dir], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { file: string; sha256: string }[];
    });
    assert.deepEqual(runs[0], runs[1]);
    const files = runs[0].map((f) => f.file);
    for (const b of ['base', 'tidewater', 'ember', 'grove']) for (const f of ['wave.zip', 'idle-to-wave.zip', 'wave.gif', ...(hasFfmpeg() ? ['wave.webm'] : [])]) assert.ok(files.includes(`${b}/${f}`), `${b}/${f}`);
    assert.ok(files.includes('mascot.runtime.json') && files.includes('atlas/mascot.atlas.json'));
    // Skins really recolour: brand frames differ from base, geometry identical.
    const frame0 = (b: string) => {
      const z = readZip(readFileSync(path.join(OUT, 'brand-a/out', b, 'wave.zip')));
      return decodePng(z.filter((f) => f.name.endsWith('.png')).sort((x, y) => (x.name < y.name ? -1 : 1))[0].data);
    };
    const base = frame0('base');
    for (const b of ['tidewater', 'ember', 'grove']) {
      const im = frame0(b);
      assert.deepEqual([im.width, im.height], [base.width, base.height]);
      let diff = 0, alphaDiff = 0;
      for (let i = 0; i < im.data.length; i += 4) {
        if (im.data[i + 3] !== base.data[i + 3]) alphaDiff++;
        if (im.data[i] !== base.data[i] || im.data[i + 1] !== base.data[i + 1] || im.data[i + 2] !== base.data[i + 2]) diff++;
      }
      report.push(`${b}: ${diff} px recoloured, ${alphaDiff} px alpha changed vs base`);
      assert.ok(diff > 1000 && alphaDiff === 0, `${b}: recoloured (${diff}) with the same silhouette (${alphaDiff})`);
    }
    report.push(`pipeline manifest (${runs[0].length} files) identical across two runs`);
  });
});
