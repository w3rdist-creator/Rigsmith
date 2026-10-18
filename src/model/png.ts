// Minimal exact PNG codec (no canvas): decoding keeps straight-alpha colour bytes exactly
// (a canvas round trip premultiplies and loses colour under low alpha), and encoding is
// deterministic. Compression uses the platform's zlib streams (`CompressionStream` /
// `DecompressionStream` 'deflate' = zlib format), available in browsers and Node ≥ 18.
// Supported input: bit depths 1/2/4/8/16, colour types 0/2/3/4/6, tRNS, no interlacing
// (Adam7 is rejected; callers fall back to the canvas). Output: 8-bit RGBA, filter 0 per row.
import { crc32 } from './zip.ts';
import type { Rgba } from './cutout.ts';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && SIG.every((b, i) => bytes[i] === b);
}

export async function decodePngExact(bytes: Uint8Array): Promise<Rgba> {
  if (!isPng(bytes)) throw new Error('Not a PNG file.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off);
    const kind = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const body = bytes.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      depth = body[8];
      type = body[9];
      interlace = body[12];
    } else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') trns = body;
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  if (!width || !height) throw new Error('PNG has no image header.');
  if (interlace) throw new Error('Interlaced PNGs are not supported by the exact decoder.');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) throw new Error(`Unsupported PNG colour type ${type} / depth ${depth}.`);
  const total = idat.reduce((s, c) => s + c.length, 0);
  const z = new Uint8Array(total);
  let p = 0;
  for (const c of idat) {
    z.set(c, p);
    p += c.length;
  }
  const raw = await pipe(z, new DecompressionStream('deflate'));
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = (width * channels * depth + 7) >> 3;
  if (raw.length < (stride + 1) * height) throw new Error('PNG data is truncated.');
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = new Uint8ClampedArray(width * height * 4);
  const max = (1 << depth) - 1;
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error(`Bad PNG filter ${f}.`);
      cur[i] = v & 255;
    }
    const sample = (x: number, ch: number): number => {
      if (depth === 8) return cur[x * channels + ch];
      if (depth === 16) return cur[(x * channels + ch) * 2];
      const bit = (x * channels + ch) * depth;
      return (cur[bit >> 3] >> (8 - depth - (bit & 7))) & max;
    };
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (type === 3) {
        const idx = sample(x, 0);
        if (!palette || idx * 3 + 2 >= palette.length) throw new Error('PNG palette index out of range.');
        out[o] = palette[idx * 3];
        out[o + 1] = palette[idx * 3 + 1];
        out[o + 2] = palette[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
        continue;
      }
      // Scale low bit depths to 8 bits; 16-bit samples keep the high byte.
      const s8 = (v: number) => (depth >= 8 ? v : Math.round((v * 255) / max));
      if (type === 0 || type === 4) {
        const g = sample(x, 0);
        out[o] = out[o + 1] = out[o + 2] = s8(g);
        if (type === 4) out[o + 3] = s8(sample(x, 1));
        else {
          const key = trns && trns.length >= 2 ? (depth === 16 ? trns[0] : (trns[0] << 8) | trns[1]) : -1;
          out[o + 3] = key >= 0 && (depth === 16 ? g === trns![0] && cur[x * 2 + 1] === trns![1] : g === key) ? 0 : 255;
        }
      } else {
        for (let ch = 0; ch < 3; ch++) out[o + ch] = sample(x, ch);
        if (type === 6) out[o + 3] = sample(x, 3);
        else {
          let transparent = !!trns && trns.length >= 6;
          for (let ch = 0; ch < 3 && transparent; ch++) {
            const want = depth === 16 ? [trns![ch * 2], trns![ch * 2 + 1]] : [(trns![ch * 2] << 8) | trns![ch * 2 + 1]];
            const got = depth === 16 ? [cur[x * 6 + ch * 2], cur[x * 6 + ch * 2 + 1]] : [cur[x * 3 + ch]];
            transparent = want.every((w, i) => w === got[i]);
          }
          out[o + 3] = transparent ? 0 : 255;
        }
      }
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

function chunk(kind: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = kind.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** 8-bit RGBA PNG; deterministic for the same platform zlib. */
export async function encodePngExact(img: Rgba): Promise<Uint8Array> {
  const { width, height, data } = img;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = await pipe(raw, new CompressionStream('deflate'));
  const parts = [new Uint8Array(SIG), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const x of parts) {
    out.set(x, p);
    p += x.length;
  }
  return out;
}

/** Bytes of a `data:` URL. */
export function dataUrlBytes(url: string): Uint8Array {
  const comma = url.indexOf(',');
  const b64 = url.slice(comma + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
