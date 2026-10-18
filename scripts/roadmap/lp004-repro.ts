// LP-004 reproduction (time-boxed): the saved Wiz "wiz-intro" sequence exported at scale
// 0.5 several times in one session, by driving visible controls in an isolated headless
// Chrome for Testing profile, then compared frame by frame with each other and with
// `rigsmith sequence --scale 0.5`. Reads lp-corrections-output/wiz-v3-lp-corrections.rig.json
// (read only). Writes only to a NEW directory .hermes/assets/wiz/lp004-output/<variant>/
// (refuses to run if it exists; nothing is deleted).
// Usage: npm run build && node scripts/roadmap/lp004-repro.ts <variant> [chrome args…]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from '../../tests/support/png-decode.ts';
import { readZip } from '../../tests/support/zip-read.ts';
import { launchIsolated, pickPort, startPreview } from '../../tests/e2e/harness.ts';
import { ROOT, WIZ } from '../wiz/paths.ts';

const [variant, ...chromeArgs] = process.argv.slice(2);
if (!variant || !/^[\w-]+$/.test(variant)) throw new Error('usage: lp004-repro.ts <variant> [chrome args…]');
const SAVED = path.join(WIZ, 'lp-corrections-output/wiz-v3-lp-corrections.rig.json');
const OUT = path.join(WIZ, 'lp004-output', variant);
if (existsSync(OUT)) throw new Error(`${OUT} exists; this script never overwrites`);
mkdirSync(OUT, { recursive: true });
const RUNS = 3;
const FPS = 15;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const lines: string[] = [];
const log = (m: string) => {
  console.log(m);
  lines.push(m);
};

function frames(zip: string): Buffer[] {
  const e = readZip(readFileSync(zip)).filter((x) => x.name.endsWith('.png')).sort((a, b) => a.name.localeCompare(b.name));
  return e.map((x) => x.data);
}

function diffCounts(a: Buffer[], b: Buffer[]): number[] {
  if (a.length !== b.length) throw new Error(`frame counts ${a.length} vs ${b.length}`);
  return a.map((pa, i) => {
    const A = decodePng(pa), B = decodePng(b[i]);
    if (A.width !== B.width || A.height !== B.height) return -1;
    let n = 0;
    for (let p = 0; p < A.data.length; p += 4)
      if (A.data[p] !== B.data[p] || A.data[p + 1] !== B.data[p + 1] || A.data[p + 2] !== B.data[p + 2] || A.data[p + 3] !== B.data[p + 3]) n++;
    return n;
  });
}

const summary = (c: number[]) => {
  const nz = c.map((n, i) => [i, n]).filter(([, n]) => n !== 0);
  return nz.length ? `${nz.length}/${c.length} frames differ: ${nz.map(([i, n]) => `${i}:${n}`).join(' ')}` : `all ${c.length} frames identical`;
};

async function main(): Promise<void> {
  log(`# LP-004 reproduction, variant "${variant}", chrome args ${JSON.stringify(chromeArgs)}`);
  log(`saved project sha256 ${sha(readFileSync(SAVED))}`);
  const port = await pickPort([47614, 47615, 47616, 47617]);
  const server = await startPreview(port);
  const ctx = await launchIsolated(`lp004-${variant}`, chromeArgs, { viewport: { width: 1600, height: 1000 } });
  const zips: string[] = [];
  try {
    const page = await ctx.newPage();
    page.on('dialog', (d) => void d.accept());
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
    await page.getByTestId('open-input').setInputFiles(SAVED);
    await page.waitForFunction(() => (window as any).__rigsmith.project().sequences?.length === 2);
    await page.getByTestId('sequences-open').click();
    await page.getByTestId('seqd-select').selectOption({ label: 'wiz-intro' });
    for (const [id, v] of [['seqd-fps', FPS], ['seqd-scale', 0.5]] as const) {
      await page.getByTestId(id).fill(String(v));
      await page.getByTestId(id).press('Enter');
    }
    log(`summary: ${await page.getByTestId('seqd-summary').innerText()}`);
    for (let r = 0; r < RUNS; r++) {
      const dl = page.waitForEvent('download', { timeout: 600_000 });
      await page.getByTestId('seqd-export').click();
      const file = path.join(OUT, `editor-${r + 1}.zip`);
      await (await dl).saveAs(file);
      zips.push(file);
    }
    // Diagnostic on a separate blank page, after the exports (the app page is not touched).
    const probePage = await ctx.newPage();
    log(`webgl renderer: ${await probePage.evaluate(() => {
      const c = document.createElement('canvas').getContext('webgl');
      const ext = c?.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(c!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'no webgl';
    })}`);
  } finally {
    await ctx.close();
    server.kill('SIGTERM');
  }
  const cli = path.join(OUT, 'cli.zip');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), 'sequence', SAVED, '--name', 'wiz-intro', '--frame', 'project', '--fps', String(FPS), '--scale', '0.5', '--out', cli], { encoding: 'utf8', maxBuffer: 1 << 26 });
  log(`cli rc ${r.status}: ${r.stdout.trim()} ${r.stderr.trim()}`);
  if (r.status !== 0) throw new Error('cli failed');
  for (const z of [...zips, cli]) log(`${sha(readFileSync(z))}  ${path.basename(z)}`);
  const f = zips.map(frames), c = frames(cli);
  for (let i = 1; i < f.length; i++) log(`editor-1 vs editor-${i + 1}: ${summary(diffCounts(f[0], f[i]))}`);
  for (let i = 0; i < f.length; i++) log(`editor-${i + 1} vs cli: ${summary(diffCounts(f[i], c))}`);
  writeFileSync(path.join(OUT, 'log.txt'), lines.join('\n') + '\n');
  const ev = path.join(ROOT, '.hermes/evidence/review-corrections', `lp004-${variant}.txt`);
  writeFileSync(ev, lines.join('\n') + '\n');
}

await main();
