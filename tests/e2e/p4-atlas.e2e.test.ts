// Phase 4 — texture atlas export through the visible dialog. Pages are decoded with the
// independent test decoder; every source image is reconstructed from its region and
// compared byte for byte with the file that was imported (including colours under low
// alpha, which a canvas round trip would round). Determinism: two exports are identical.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { decodePng } from '../support/png-decode.ts';
import type { Decoded } from '../support/png-decode.ts';
import { encodePng } from '../support/png-encode.ts';
import { readZip } from '../support/zip-read.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/p4-atlas');
mkdirSync(path.join(OUT, 'art'), { recursive: true });

function art(w: number, h: number, f: (x: number, y: number) => number[]): Buffer {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(f(x, y), (y * w + x) * 4);
  return encodePng(w, h, d);
}
const FILES: Record<string, Buffer> = {
  // Transparent margin of 5 px, a gradient with very low alpha at the left edge.
  'glow.png': art(40, 30, (x, y) => (x >= 5 && y >= 5 && x < 35 && y < 25 ? [200 - x, 30 + y * 3, 77, Math.min(255, (x - 5) * 9 + 1)] : [0, 0, 0, 0])),
  'block.png': art(24, 24, (x, y) => [x * 10, y * 10, 128, 255]),
  'strip.png': art(90, 8, (x) => [255, x * 2, 0, 255]),
  'dot.png': art(6, 6, (x, y) => (x === 3 && y === 3 ? [9, 8, 7, 3] : [0, 0, 0, 0])),
};
const PATHS = Object.entries(FILES).map(([n, b]) => {
  const p = path.join(OUT, 'art', n);
  writeFileSync(p, b);
  return p;
});

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const report: string[] = [];

async function setField(testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

async function exportAtlas(file: string) {
  const dl = page.waitForEvent('download');
  await page.getByTestId('atlas-export').click();
  const zipPath = path.join(OUT, file);
  await (await dl).saveAs(zipPath);
  const bytes = readFileSync(zipPath);
  const files = readZip(bytes);
  const meta = JSON.parse(files.find((x) => x.name.endsWith('.atlas.json'))!.data.toString('utf8'));
  const pages = meta.pages.map((p: any) => decodePng(files.find((x) => x.name.endsWith('/' + p.file))!.data));
  return { bytes, files, meta, pages: pages as Decoded[] };
}

function reconstruct(pages: Decoded[], r: any): Decoded {
  const out = new Uint8Array(r.originalWidth * r.originalHeight * 4);
  const pg = pages[r.page];
  for (let j = 0; j < r.height; j++)
    for (let i = 0; i < r.width; i++) {
      const s = ((r.y + j) * pg.width + r.x + i) * 4, d = ((r.offsetY + j) * r.originalWidth + r.offsetX + i) * 4;
      out.set(pg.data.subarray(s, s + 4), d);
    }
  return { width: r.originalWidth, height: r.originalHeight, data: out };
}

/** Pixel equality where fully transparent pixels compare by alpha only. */
function samePixels(a: Decoded, b: Decoded): number {
  let bad = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    const o = i * 4;
    if (a.data[o + 3] === 0 && b.data[o + 3] === 0) continue;
    for (let c = 0; c < 4; c++) if (a.data[o + c] !== b.data[o + c]) {
      bad++;
      break;
    }
  }
  return bad;
}

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-p4-atlas');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
  await page.getByTestId('image-input').setInputFiles(PATHS);
  await page.getByTestId('image-dot.png').waitFor();
});

after(async () => {
  writeFileSync(path.join(OUT, 'report.txt'), report.join('\n') + '\n');
  await ctx?.close();
  server?.kill();
});

describe('texture atlas export', () => {
  it('packs with defaults (padding 2, bleed 1, trim) and previews the page', async () => {
    await page.getByTestId('export-atlas').click();
    await page.getByTestId('atlas-dialog').waitFor();
    const summary = await page.getByTestId('atlas-summary').innerText();
    report.push(`defaults: ${summary}`);
    assert.match(summary, /^4 region\(s\) on 1 page\(s\): \d+×\d+ · \d+% filled$/);
    await page.getByTestId('atlas-page-0').waitFor();
    assert.equal(await page.getByTestId('atlas-inexact').count(), 0, 'all PNGs read exactly');
  });

  it('exported pages reproduce every imported file exactly; trimmed regions and bleed as specified', async () => {
    const { meta, pages, files } = await exportAtlas('atlas-default.zip');
    assert.equal(meta.format, 'rigsmith.atlas');
    assert.deepEqual([meta.padding, meta.bleed, meta.trim, meta.pot], [2, 1, true, false]);
    assert.deepEqual(files.map((f) => f.name).sort(), ['untitled-rig-atlas/untitled-rig-0.png', 'untitled-rig-atlas/untitled-rig.atlas.json'].sort());
    const byName = Object.fromEntries(meta.regions.map((r: any) => [r.name, r]));
    assert.deepEqual([byName['glow.png'].offsetX, byName['glow.png'].offsetY, byName['glow.png'].width, byName['glow.png'].height], [4, 4, 32, 22], 'trim + 1 px margin');
    assert.deepEqual([byName['block.png'].width, byName['block.png'].height], [24, 24], 'opaque to the edge: untrimmed');
    assert.deepEqual([byName['dot.png'].offsetX, byName['dot.png'].width], [2, 3]);
    for (const r of meta.regions) {
      const src = decodePng(FILES[r.name]);
      const bad = samePixels(reconstruct(pages, r), src);
      report.push(`${r.name}: page ${r.page} @${r.x},${r.y} ${r.width}×${r.height} (offset ${r.offsetX},${r.offsetY} of ${r.originalWidth}×${r.originalHeight}) — ${bad} px differ`);
      assert.equal(bad, 0, `${r.name} reconstructs byte-exactly`);
    }
    // Bleed: the column left of block.png equals its first column.
    const b = byName['block.png'], pg = pages[0];
    for (let j = 0; j < b.height; j++) {
      const at = (x: number) => [...pg.data.subarray(((b.y + j) * pg.width + x) * 4, ((b.y + j) * pg.width + x) * 4 + 4)];
      assert.deepEqual(at(b.x - 1), at(b.x));
      assert.deepEqual(at(b.x - 2), [0, 0, 0, 0], 'beyond the bleed: transparent padding');
    }
  });

  it('is deterministic: a second export is byte-identical', async () => {
    const a = readFileSync(path.join(OUT, 'atlas-default.zip'));
    const { bytes } = await exportAtlas('atlas-default-2.zip');
    const sha = (x: Buffer) => createHash('sha256').update(x).digest('hex');
    report.push(`sha256 ${sha(a)} vs ${sha(bytes)}`);
    assert.equal(sha(bytes), sha(a));
  });

  it('options: no trim, padding 0 / bleed 0, power-of-two, too-small pages and invalid bleed report errors', async () => {
    await page.getByTestId('atlas-trim').uncheck();
    await setField('atlas-bleed', 0);
    await setField('atlas-padding', 0);
    await page.getByTestId('atlas-pot').check();
    const { meta, pages } = await exportAtlas('atlas-pot.zip');
    assert.deepEqual([meta.padding, meta.bleed, meta.trim, meta.pot], [0, 0, false, true]);
    for (const p of meta.pages) assert.ok(Number.isInteger(Math.log2(p.width)) && Number.isInteger(Math.log2(p.height)), `${p.width}×${p.height}`);
    for (const r of meta.regions) {
      assert.deepEqual([r.width, r.height, r.offsetX, r.offsetY], [r.originalWidth, r.originalHeight, 0, 0]);
      assert.equal(samePixels(reconstruct(pages, r), decodePng(FILES[r.name])), 0);
    }
    await page.getByTestId('atlas-max').selectOption('64');
    assert.match(await page.getByTestId('atlas-errors').innerText(), /strip\.png \(90×8 after trim\) does not fit a 64×64 page/);
    assert.ok(await page.getByTestId('atlas-export').isDisabled());
    await page.getByTestId('atlas-max').selectOption('128');
    await setField('atlas-padding', 2);
    await setField('atlas-bleed', 2);
    assert.match(await page.getByTestId('atlas-errors').innerText(), /Bleed must be a whole number from 0 to half the padding/);
    await setField('atlas-bleed', 1);
    assert.match(await page.getByTestId('atlas-summary').innerText(), /4 region\(s\)/);
    await page.getByTestId('atlas-cancel').click();
    await page.getByTestId('atlas-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(pageErrors, []);
    assert.equal((await probe<any>(page, 'project')).images.length, 4, 'export never changes the project');
  });
});
