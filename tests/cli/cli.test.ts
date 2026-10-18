// Headless CLI / API (scripts/rigsmith.ts): every command is run as a subprocess and
// judged by its JSON output, exit code and files. Rendering is compared with the
// editor's own UI export of the same project (byte-identical ZIPs), the atlas with an
// independent decoder, and the brand pipeline with a second run (identical sha256).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { exportRuntime } from '../../src/model/exportRuntime.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { decodePng } from '../support/png-decode.ts';
import { encodePng } from '../support/png-encode.ts';
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
    const ps = spawnSync('pgrep', ['-f', 'browser-profiles/cli([^-]|$)'], { encoding: 'utf8' });
    assert.equal(ps.stdout.trim(), '', 'the CLI browser is closed');
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
    for (const b of ['base', 'tidewater', 'ember', 'grove']) for (const f of ['wave.zip', 'idle-to-wave.zip']) assert.ok(files.includes(`${b}/${f}`), `${b}/${f}`);
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
