// Exact PNG codec and texture-atlas packing. PNG output is checked with the independent
// test decoder (node zlib); inputs of other colour types / bit depths are hand-built here.
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { describe, it } from 'node:test';
import type { AtlasOptions } from '../../src/model/atlas.ts';
import { DEFAULT_ATLAS, atlasItems, atlasMeta, packAtlas, renderAtlasPages, trimRect } from '../../src/model/atlas.ts';
import type { Rgba } from '../../src/model/cutout.ts';
import { decodePngExact, encodePngExact } from '../../src/model/png.ts';
import { crc32 } from '../../src/model/zip.ts';
import { decodePng } from '../support/png-decode.ts';
import { encodePng } from '../support/png-encode.ts';

function rgba(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]): Rgba {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, data: d };
}

/** Hand-built PNG with arbitrary colour type / depth (filter 0 rows). */
function rawPng(w: number, h: number, type: number, depth: number, rows: number[][], extra: [string, number[]][] = []): Uint8Array {
  const chunk = (kind: string, body: Uint8Array) => {
    const b = Buffer.alloc(12 + body.length);
    b.writeUInt32BE(body.length, 0);
    Buffer.from(kind, 'ascii').copy(b, 4);
    Buffer.from(body).copy(b, 8);
    b.writeUInt32BE(crc32(new Uint8Array(b.subarray(4, 8 + body.length))), 8 + body.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth;
  ihdr[9] = type;
  const raw = Buffer.concat(rows.map((r) => Buffer.from([0, ...r])));
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...extra.map(([k, v]) => chunk(k, new Uint8Array(v))), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]));
}

async function rejects(p: Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    assert.match((e as Error).message, re);
    return;
  }
  assert.fail(`expected a rejection matching ${re}`);
}

const px = (im: Rgba, x: number, y: number) => [...im.data.subarray((y * im.width + x) * 4, (y * im.width + x) * 4 + 4)];

describe('exact PNG codec', () => {
  it('round-trips straight alpha exactly (low-alpha colours kept) and is deterministic', async () => {
    const img = rgba(7, 5, (x, y) => [x * 37, y * 51, (x * y * 13) & 255, [0, 1, 2, 128, 255][y]]);
    const a = await encodePngExact(img);
    const b = await encodePngExact(img);
    assert.deepEqual(a, b, 'same bytes twice');
    const dec = decodePng(Buffer.from(a));
    assert.deepEqual([...dec.data], [...img.data], 'independent decoder reads the same pixels');
    const back = await decodePngExact(a);
    assert.deepEqual([...back.data], [...img.data]);
    const ext = await decodePngExact(new Uint8Array(encodePng(7, 5, new Uint8Array(img.data))));
    assert.deepEqual([...ext.data], [...img.data], 'decodes PNGs written by another encoder');
  });

  it('decodes grey, grey+alpha, RGB+tRNS, palette+tRNS, 1/4/16-bit and filtered data', async () => {
    const g8 = await decodePngExact(rawPng(2, 1, 0, 8, [[10, 200]]));
    assert.deepEqual([px(g8, 0, 0), px(g8, 1, 0)], [[10, 10, 10, 255], [200, 200, 200, 255]]);
    const ga = await decodePngExact(rawPng(1, 1, 4, 8, [[50, 7]]));
    assert.deepEqual(px(ga, 0, 0), [50, 50, 50, 7]);
    const rgbT = await decodePngExact(rawPng(2, 1, 2, 8, [[1, 2, 3, 4, 5, 6]], [['tRNS', [0, 4, 0, 5, 0, 6]]]));
    assert.deepEqual([px(rgbT, 0, 0), px(rgbT, 1, 0)], [[1, 2, 3, 255], [4, 5, 6, 0]]);
    const pal = await decodePngExact(rawPng(3, 1, 3, 8, [[0, 1, 2]], [['PLTE', [255, 0, 0, 0, 255, 0, 0, 0, 255]], ['tRNS', [255, 100]]]));
    assert.deepEqual([px(pal, 0, 0), px(pal, 1, 0), px(pal, 2, 0)], [[255, 0, 0, 255], [0, 255, 0, 100], [0, 0, 255, 255]]);
    const g1 = await decodePngExact(rawPng(9, 1, 0, 1, [[0b10100000, 0b10000000]]));
    assert.deepEqual([0, 1, 2, 8].map((x) => px(g1, x, 0)[0]), [255, 0, 255, 255]);
    const p4 = await decodePngExact(rawPng(3, 1, 3, 4, [[0x10, 0x20]], [['PLTE', [9, 9, 9, 50, 60, 70, 1, 2, 3]]]));
    assert.deepEqual([px(p4, 0, 0), px(p4, 1, 0), px(p4, 2, 0)], [[50, 60, 70, 255], [9, 9, 9, 255], [1, 2, 3, 255]]);
    const r16 = await decodePngExact(rawPng(1, 1, 6, 16, [[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]]));
    assert.deepEqual(px(r16, 0, 0), [0x12, 0x56, 0x9a, 0xde], '16-bit keeps the high byte');
    // Sub / up / average / Paeth filters, written by node's encoder via our test encoder path:
    const img = rgba(9, 6, (x, y) => [(x * 29 + y * 7) & 255, (x * x + y) & 255, (y * 40) & 255, 255 - x * 3]);
    const rows: number[][] = [];
    // Filter each row with type (y % 5) by hand.
    const bpp = 4, stride = 36;
    for (let y = 0; y < 6; y++) {
      const f = y % 5;
      const cur = [...img.data.subarray(y * stride, (y + 1) * stride)];
      const prev = y ? [...img.data.subarray((y - 1) * stride, y * stride)] : new Array(stride).fill(0);
      rows.push([f, ...cur.map((v, i) => {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
        return (v - pred) & 255;
      })]);
    }
    const filtered = rawPng(9, 6, 6, 8, []);
    // Replace IDAT: rebuild with explicit filter bytes.
    const head = Buffer.from(filtered).subarray(0, 33);
    const body = deflateSync(Buffer.concat(rows.map((r) => Buffer.from(r))));
    const idat = Buffer.alloc(12 + body.length);
    idat.writeUInt32BE(body.length, 0);
    Buffer.from('IDAT', 'ascii').copy(idat, 4);
    body.copy(idat, 8);
    idat.writeUInt32BE(crc32(new Uint8Array(idat.subarray(4, 8 + body.length))), 8 + body.length);
    const iend = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 0xae, 0x42, 0x60, 0x82]);
    const dec = await decodePngExact(new Uint8Array(Buffer.concat([head, idat, iend])));
    assert.deepEqual([...dec.data], [...img.data], 'all five filter types');
  });

  it('rejects non-PNG, interlaced and truncated data', async () => {
    await rejects(decodePngExact(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), /Not a PNG/);
    const inter = rawPng(1, 1, 6, 8, [[1, 2, 3, 4]]);
    inter[8 + 8 + 12] = 1;
    await rejects(decodePngExact(inter), /Interlaced/);
    await rejects(decodePngExact(rawPng(4, 4, 6, 8, [[1, 2, 3, 4]])), /truncated/);
  });
});

describe('atlas packing', () => {
  const opts = (o: Partial<AtlasOptions> = {}): AtlasOptions => ({ ...DEFAULT_ATLAS, ...o });
  const box = (w: number, h: number, margin = 0) => rgba(w, h, (x, y) => (x >= margin && y >= margin && x < w - margin && y < h - margin ? [x * 9, y * 9, 100, x === margin ? 90 : 255] : [0, 0, 0, 0]));
  const sources = () => new Map<string, Rgba>([
    ['a.png', box(30, 20, 3)],
    ['b.png', box(12, 40)],
    ['c.png', box(50, 10, 1)],
    ['d.png', box(8, 8)],
    ['e.png', box(16, 16, 8)], // fully transparent
  ]);
  const items = (trim = true, order?: string[]) => {
    const s = sources();
    const names = order ?? [...s.keys()];
    return atlasItems(names.map((name) => ({ name, pixels: s.get(name)! })), trim);
  };

  it('trims to the visible bounds plus a 1 px margin, clipped to the image; blank images keep 1×1', () => {
    assert.deepEqual(trimRect(box(30, 20, 3)), { x: 2, y: 2, width: 26, height: 16 });
    assert.deepEqual(trimRect(box(12, 40)), { x: 0, y: 0, width: 12, height: 40 }, 'opaque to the edge: nothing to trim');
    assert.deepEqual(trimRect(box(16, 16, 8)), { x: 0, y: 0, width: 1, height: 1 });
  });

  it('is deterministic and independent of input order; regions never overlap and keep padding', () => {
    for (const o of [opts(), opts({ padding: 4, bleed: 2 }), opts({ pot: true }), opts({ trim: false, padding: 0, bleed: 0 }), opts({ maxSize: 64 })]) {
      const a = packAtlas(items(o.trim), o), b = packAtlas(items(o.trim, ['e.png', 'c.png', 'a.png', 'd.png', 'b.png']), o);
      assert.ok(a.ok && b.ok);
      assert.deepEqual(a.layout, b.layout, 'same layout for any input order');
      const L = a.layout;
      assert.deepEqual(L.regions.map((r) => r.name), ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']);
      for (const p of L.pages) {
        assert.ok(p.width <= o.maxSize && p.height <= o.maxSize);
        if (o.pot) assert.ok(Number.isInteger(Math.log2(p.width)) && Number.isInteger(Math.log2(p.height)), 'power of two');
      }
      for (const r of L.regions) {
        const p = L.pages[r.page];
        assert.ok(r.x >= o.padding && r.y >= o.padding && r.x + r.width + o.padding <= p.width && r.y + r.height + o.padding <= p.height, `${r.name} inside its page with edge padding`);
      }
      for (const r of L.regions)
        for (const q of L.regions) {
          if (r === q || r.page !== q.page) continue;
          const gapX = Math.max(q.x - (r.x + r.width), r.x - (q.x + q.width));
          const gapY = Math.max(q.y - (r.y + r.height), r.y - (q.y + q.height));
          assert.ok(Math.max(gapX, gapY) >= o.padding, `${r.name}/${q.name} at least ${o.padding}px apart`);
        }
    }
  });

  it('spills onto further pages, and rejects images that cannot fit or invalid options', () => {
    const r = packAtlas(items(false), opts({ maxSize: 64, trim: false }));
    assert.ok(r.ok);
    assert.ok(r.layout.pages.length >= 2, `pages ${r.layout.pages.length}`);
    const big = packAtlas(items(false), opts({ maxSize: 32, trim: false }));
    assert.ok(!big.ok);
    assert.match(big.errors.join('\n'), /b\.png \(12×40 after trim\) does not fit a 32×32 page/);
    const bad = packAtlas(items(), opts({ padding: 2, bleed: 2 }));
    assert.ok(!bad.ok && /Bleed must be/.test(bad.errors[0]));
    const dup = packAtlas([...items(), ...items().slice(0, 1)], opts());
    assert.ok(!dup.ok && /Two images are named “a\.png”/.test(dup.errors[0]));
    assert.ok(!packAtlas([], opts()).ok);
  });

  it('pages reproduce every source exactly; bleed copies edge pixels; the rest is transparent', () => {
    const o = opts({ padding: 4, bleed: 2, trim: true });
    const r = packAtlas(items(), o);
    assert.ok(r.ok);
    const src = sources();
    const pages = renderAtlasPages(r.layout, src, o.bleed);
    const owned = pages.map((p) => new Uint8Array(p.width * p.height));
    for (const g of r.layout.regions) {
      const s = src.get(g.name)!, pg = pages[g.page];
      // Reconstruct the full source from the region (outside the trim rect = transparent).
      const back = rgba(g.originalWidth, g.originalHeight, (x, y) => {
        const i = x - g.offsetX, j = y - g.offsetY;
        return i >= 0 && j >= 0 && i < g.width && j < g.height ? (px(pg, g.x + i, g.y + j) as [number, number, number, number]) : [0, 0, 0, 0];
      });
      assert.deepEqual([...back.data].map((v, k) => (k % 4 === 3 || back.data[k - (k % 4) + 3] ? v : 0)), [...s.data].map((v, k) => (k % 4 === 3 || s.data[k - (k % 4) + 3] ? v : 0)), `${g.name} round-trips`);
      for (let j = -o.bleed; j < g.height + o.bleed; j++)
        for (let i = -o.bleed; i < g.width + o.bleed; i++) {
          const ci = Math.min(g.width - 1, Math.max(0, i)), cj = Math.min(g.height - 1, Math.max(0, j));
          assert.deepEqual(px(pg, g.x + i, g.y + j), px(s, g.offsetX + ci, g.offsetY + cj));
          owned[g.page][(g.y + j) * pg.width + g.x + i] = 1;
        }
    }
    pages.forEach((p, k) => {
      for (let i = 0; i < p.width * p.height; i++) if (!owned[k][i]) assert.equal(p.data[i * 4 + 3], 0, 'unowned pixels are transparent');
    });
    const meta = atlasMeta(r.layout, o, (i) => `x-${i}.png`);
    assert.equal(meta.format, 'rigsmith.atlas');
    assert.deepEqual(meta.pages.map((p) => p.file), r.layout.pages.map((_, i) => `x-${i}.png`));
  });
});
