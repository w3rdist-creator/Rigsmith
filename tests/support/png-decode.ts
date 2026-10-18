// Independent PNG decoder for tests (does not import src/). Supports 8-bit grayscale,
// RGB, palette, gray+alpha and RGBA, non-interlaced — what browsers and PIL emit.
// Also reads APNG frame control chunks for animated-PNG validation.
import { inflateSync } from 'node:zlib';

export interface Decoded {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, straight (non-premultiplied) alpha. */
  data: Uint8Array;
}

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface Chunk {
  type: string;
  data: Buffer;
}

export function readChunks(buf: Buffer): Chunk[] {
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('not a PNG (bad signature)');
  const out: Chunk[] = [];
  let o = 8;
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    out.push({ type, data: buf.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
    if (type === 'IEND') break;
  }
  if (out.at(-1)?.type !== 'IEND') throw new Error('PNG truncated (no IEND)');
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes zlib-compressed scanlines (IDAT or fdAT payload) of a w×h image. */
export function decodeScanlines(z: Buffer, width: number, height: number, colorType: number, palette?: Buffer, trns?: Buffer): Uint8Array {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType as 0 | 2 | 3 | 4 | 6];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  const raw = inflateSync(z);
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG data too short');
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const r = raw[src + x];
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      let v: number;
      if (f === 0) v = r;
      else if (f === 1) v = r + a;
      else if (f === 2) v = r + b;
      else if (f === 3) v = r + ((a + b) >> 1);
      else if (f === 4) v = r + paeth(a, b, c);
      else throw new Error(`bad PNG filter ${f}`);
      px[y * stride + x] = v & 255;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    let r: number, g: number, b: number, al: number;
    if (colorType === 6) [r, g, b, al] = [px[s], px[s + 1], px[s + 2], px[s + 3]];
    else if (colorType === 2) [r, g, b, al] = [px[s], px[s + 1], px[s + 2], 255];
    else if (colorType === 0) [r, g, b, al] = [px[s], px[s], px[s], 255];
    else if (colorType === 4) [r, g, b, al] = [px[s], px[s], px[s], px[s + 1]];
    else {
      const k = px[s];
      [r, g, b] = [palette![k * 3], palette![k * 3 + 1], palette![k * 3 + 2]];
      al = trns && k < trns.length ? trns[k] : 255;
    }
    out.set([r, g, b, al], i * 4);
  }
  return out;
}

export function decodePng(buf: Buffer): Decoded {
  const chunks = readChunks(buf);
  const ihdr = chunks[0];
  if (ihdr.type !== 'IHDR') throw new Error('PNG has no IHDR first');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8], colorType = ihdr.data[9], interlace = ihdr.data[12];
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  if (interlace) throw new Error('interlaced PNG not supported');
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const plte = chunks.find((c) => c.type === 'PLTE')?.data;
  const trns = chunks.find((c) => c.type === 'tRNS')?.data;
  return { width, height, data: decodeScanlines(idat, width, height, colorType, plte, trns) };
}

export function alphaAt(img: Decoded, x: number, y: number): number {
  return img.data[(y * img.width + x) * 4 + 3];
}

/** Count of pixels with alpha > 0 on the outermost 1-px ring. */
export function borderAlphaCount(img: Decoded): number {
  let n = 0;
  for (let x = 0; x < img.width; x++) {
    if (alphaAt(img, x, 0)) n++;
    if (alphaAt(img, x, img.height - 1)) n++;
  }
  for (let y = 1; y < img.height - 1; y++) {
    if (alphaAt(img, 0, y)) n++;
    if (alphaAt(img, img.width - 1, y)) n++;
  }
  return n;
}
