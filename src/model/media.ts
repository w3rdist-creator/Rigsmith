// Animated single-file media from the PNG-sequence frames: APNG (lossless, full 8-bit alpha)
// and GIF (one 256-colour palette, 1-bit alpha). Pure TypeScript, no DOM — the editor's
// export dialog and the CLI run the same code on the same PNG frames. The PNG sequence
// stays the reference: APNG frames are its pixels exactly; GIF is a labelled reduction.
//
// APNG: acTL num_plays 0 (loop) / 1 (one-shot); every frame is full-canvas with
// dispose NONE + blend SOURCE, delay 1/fps exactly (delay_num 1, delay_den fps).
// GIF: GIF89a, one global palette from all frames (the exact colours when ≤ 255 exist,
// otherwise median cut over a 15-bit histogram; nearest colour, no dithering); alpha ≥ 128
// is opaque, below is the transparent index; disposal 2 on full-canvas frames; delays in
// whole centiseconds accumulated so the total duration is exact to 1 cs; NETSCAPE loop
// extension only for looping animations. LZW is the standard variable-width (9–12 bit) code.
import type { Rgba } from './cutout.ts';
import { PNG_SIGNATURE, decodePngExact, pngChunk, pngImageData } from './png.ts';

export type MediaFormat = 'apng' | 'gif';

/** GIF delays are whole centiseconds; players slow delays below 2 cs, so cap at 50 fps. */
export const GIF_MAX_FPS = 50;

export function mediaErrors(format: MediaFormat, fps: number): string[] {
  if (format === 'gif' && fps > GIF_MAX_FPS) return [`GIF timing is in whole 1/100 s and players slow frames shorter than 2/100 s: use at most ${GIF_MAX_FPS} fps for GIF (got ${fps}).`];
  return [];
}

/** Per-frame GIF delays (cs) whose running sum is round(100·i/fps): total exact to 1 cs. */
export function gifDelays(count: number, fps: number): number[] {
  return Array.from({ length: count }, (_, i) => Math.round((100 * (i + 1)) / fps) - Math.round((100 * i) / fps));
}

export interface MediaStats {
  format: MediaFormat;
  frames: number;
  width: number;
  height: number;
  bytes: number;
  /** GIF only: palette size and how partial alpha was reduced. */
  paletteColours?: number;
  exactColours?: boolean;
  partialAlphaPixels?: number;
  partialToOpaque?: number;
  partialToTransparent?: number;
  totalPixels?: number;
}

export interface MediaOptions {
  fps: number;
  loop: boolean;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}

export class MediaCancelled extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'MediaCancelled';
  }
}

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u16 = (v: number) => [(v >>> 8) & 255, v & 255];

/**
 * Encodes PNG frames (all the same size) as one animated file. `frame(i)` returns the
 * i-th PNG; GIF reads each frame twice (palette pass, encode pass) so memory stays at
 * the size of the PNGs rather than of the decoded pixels.
 */
export async function encodeAnimated(format: MediaFormat, count: number, frame: (i: number) => Uint8Array | Promise<Uint8Array>, o: MediaOptions): Promise<{ bytes: Uint8Array; stats: MediaStats }> {
  const errors = mediaErrors(format, o.fps);
  if (errors.length) throw new Error(errors[0]);
  if (!(count >= 1)) throw new Error('Nothing to encode.');
  return format === 'apng' ? encodeApng(count, frame, o) : encodeGif(count, frame, o);
}

async function decodeChecked(png: Uint8Array, size: { width: number; height: number } | null): Promise<Rgba> {
  const img = await decodePngExact(png);
  if (size && (img.width !== size.width || img.height !== size.height)) throw new Error(`Frame is ${img.width}×${img.height}; expected ${size.width}×${size.height}.`);
  return img;
}

async function encodeApng(count: number, frame: (i: number) => Uint8Array | Promise<Uint8Array>, o: MediaOptions) {
  if (!Number.isInteger(o.fps) || o.fps < 1 || o.fps > 65535) throw new Error('FPS must be a whole number.');
  const parts: Uint8Array[] = [];
  let seq = 0;
  let size: { width: number; height: number } | null = null;
  for (let i = 0; i < count; i++) {
    if (o.isCancelled?.()) throw new MediaCancelled();
    const img = await decodeChecked(await frame(i), size);
    if (!size) {
      size = { width: img.width, height: img.height };
      parts.push(new Uint8Array(PNG_SIGNATURE));
      parts.push(pngChunk('IHDR', new Uint8Array([...u32(img.width), ...u32(img.height), 8, 6, 0, 0, 0])));
      parts.push(pngChunk('acTL', new Uint8Array([...u32(count), ...u32(o.loop ? 0 : 1)])));
    }
    // fcTL: sequence, w, h, x 0, y 0, delay 1/fps, dispose NONE, blend SOURCE.
    parts.push(pngChunk('fcTL', new Uint8Array([...u32(seq++), ...u32(img.width), ...u32(img.height), ...u32(0), ...u32(0), ...u16(1), ...u16(o.fps), 0, 0])));
    const data = await pngImageData(img);
    if (i === 0) parts.push(pngChunk('IDAT', data));
    else {
      const body = new Uint8Array(4 + data.length);
      body.set(u32(seq++));
      body.set(data, 4);
      parts.push(pngChunk('fdAT', body));
    }
    o.onProgress?.(i + 1, count);
  }
  parts.push(pngChunk('IEND', new Uint8Array(0)));
  const bytes = concat(parts);
  return { bytes, stats: { format: 'apng' as const, frames: count, width: size!.width, height: size!.height, bytes: bytes.length } };
}

// ---- GIF ---------------------------------------------------------------------------------

const TRANSPARENT = 255;

/** Colour statistics of the opaque (α ≥ 128) pixels of every frame. */
class Histogram {
  readonly count = new Float64Array(32768);
  readonly sum = new Float64Array(32768 * 3);
  exact: Map<number, number> | null = new Map();
  partial = 0;
  partialToOpaque = 0;
  total = 0;

  add(img: Rgba): void {
    const d = img.data;
    this.total += img.width * img.height;
    for (let p = 0; p < d.length; p += 4) {
      const a = d[p + 3];
      if (a > 0 && a < 255) {
        this.partial++;
        if (a >= 128) this.partialToOpaque++;
      }
      if (a < 128) continue;
      const r = d[p], g = d[p + 1], b = d[p + 2];
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      this.count[k]++;
      this.sum[k * 3] += r;
      this.sum[k * 3 + 1] += g;
      this.sum[k * 3 + 2] += b;
      if (this.exact) {
        const rgb = (r << 16) | (g << 8) | b;
        if (!this.exact.has(rgb)) {
          if (this.exact.size >= 255) this.exact = null;
          else this.exact.set(rgb, this.exact.size);
        }
      }
    }
  }

  /** Up to 255 RGB entries (index 255 is transparent). */
  palette(): { colours: number[][]; exact: boolean } {
    if (this.exact) return { colours: [...this.exact.keys()].sort((a, b) => a - b).map((c) => [c >> 16, (c >> 8) & 255, c & 255]), exact: true };
    // Median cut over occupied 15-bit bins (weighted by pixel count).
    const bins: number[] = [];
    for (let k = 0; k < 32768; k++) if (this.count[k] > 0) bins.push(k);
    const ch = (k: number, c: number) => (k >> (10 - 5 * c)) & 31;
    type Box = { bins: number[]; range: number; axis: number; weight: number };
    const box = (bs: number[]): Box => {
      let axis = 0, range = -1, weight = 0;
      for (const b of bs) weight += this.count[b];
      for (let c = 0; c < 3; c++) {
        let lo = 31, hi = 0;
        for (const b of bs) {
          const v = ch(b, c);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > range) {
          range = hi - lo;
          axis = c;
        }
      }
      return { bins: bs, range, axis, weight };
    };
    const boxes: Box[] = bins.length ? [box(bins)] : [];
    while (boxes.length < 255) {
      // Split the box with the largest (range × weight); ties by position, deterministic.
      let best = -1, score = 0;
      boxes.forEach((b, i) => {
        const s = b.range * b.weight;
        if (b.bins.length > 1 && s > score) {
          score = s;
          best = i;
        }
      });
      if (best < 0) break;
      const b = boxes[best];
      const sorted = [...b.bins].sort((x, y) => ch(x, b.axis) - ch(y, b.axis) || x - y);
      let acc = 0, cut = 1;
      for (let i = 0; i < sorted.length - 1; i++) {
        acc += this.count[sorted[i]];
        cut = i + 1;
        if (acc >= b.weight / 2) break;
      }
      boxes.splice(best, 1, box(sorted.slice(0, cut)), box(sorted.slice(cut)));
    }
    const colours = boxes.map((b) => {
      let n = 0, r = 0, g = 0, bl = 0;
      for (const k of b.bins) {
        n += this.count[k];
        r += this.sum[k * 3];
        g += this.sum[k * 3 + 1];
        bl += this.sum[k * 3 + 2];
      }
      return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
    });
    return { colours, exact: false };
  }
}

/** GIF LZW (min code size 8) packed LSB-first into ≤ 255-byte sub-blocks. */
class Lzw {
  private table = new Int16Array(4096 * 256);
  private stamp = new Uint16Array(4096 * 256);
  private gen = 1;

  encode(indices: Uint8Array): Uint8Array {
    const out: number[] = [];
    let cur = 0, bits = 0;
    let size = 9, next = 258;
    const emit = (code: number) => {
      cur |= code << bits;
      bits += size;
      while (bits >= 8) {
        out.push(cur & 255);
        cur >>>= 8;
        bits -= 8;
      }
    };
    const reset = () => {
      this.gen = this.gen === 65535 ? 1 : this.gen + 1;
      if (this.gen === 1) this.stamp.fill(0);
      size = 9;
      next = 258;
    };
    reset();
    emit(256);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const c = indices[i];
      const slot = prefix * 256 + c;
      if (this.stamp[slot] === this.gen) {
        prefix = this.table[slot];
        continue;
      }
      emit(prefix);
      if (next < 4096) {
        this.table[slot] = next;
        this.stamp[slot] = this.gen;
        // The decoder widens one code later than the encoder assigns: widen after
        // assigning code 2^size (i.e. when `next` passes the current width).
        if (next === 1 << size && size < 12) size++;
        next++;
        if (next === 4096) {
          // Table full: clear (emitted at 12 bits) and start over.
          emit(256);
          reset();
        }
      }
      prefix = c;
    }
    emit(prefix);
    emit(257);
    if (bits > 0) out.push(cur & 255);
    const blocks: number[] = [8];
    for (let i = 0; i < out.length; i += 255) {
      const n = Math.min(255, out.length - i);
      blocks.push(n);
      for (let j = 0; j < n; j++) blocks.push(out[i + j]);
    }
    blocks.push(0);
    return new Uint8Array(blocks);
  }
}

async function encodeGif(count: number, frame: (i: number) => Uint8Array | Promise<Uint8Array>, o: MediaOptions) {
  const hist = new Histogram();
  let size: { width: number; height: number } | null = null;
  // Pass 1: palette statistics (progress counts both passes).
  for (let i = 0; i < count; i++) {
    if (o.isCancelled?.()) throw new MediaCancelled();
    const img = await decodeChecked(await frame(i), size);
    size ??= { width: img.width, height: img.height };
    if (size.width > 65535 || size.height > 65535) throw new Error('GIF frames are limited to 65535 px per side.');
    hist.add(img);
    o.onProgress?.(i + 1, count * 2);
    await yieldNow();
  }
  const { colours, exact } = hist.palette();
  const pal = new Uint8Array(256 * 3);
  colours.forEach((c, i) => pal.set(c, i * 3));
  const nearest = new Map<number, number>();
  const lookup = (r: number, g: number, b: number): number => {
    const rgb = (r << 16) | (g << 8) | b;
    let idx = nearest.get(rgb);
    if (idx === undefined) {
      let best = Infinity;
      idx = 0;
      for (let i = 0; i < colours.length; i++) {
        const c = colours[i];
        const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
        if (d < best) {
          best = d;
          idx = i;
        }
      }
      nearest.set(rgb, idx);
    }
    return idx;
  };
  const { width, height } = size!;
  const parts: Uint8Array[] = [];
  parts.push(new TextEncoder().encode('GIF89a'));
  parts.push(new Uint8Array([width & 255, width >> 8, height & 255, height >> 8, 0xf7, TRANSPARENT, 0]));
  parts.push(pal);
  if (o.loop) parts.push(new Uint8Array([0x21, 0xff, 0x0b, ...new TextEncoder().encode('NETSCAPE2.0'), 3, 1, 0, 0, 0]));
  const delays = gifDelays(count, o.fps);
  const lzw = new Lzw();
  const indices = new Uint8Array(width * height);
  // Pass 2: map and compress each frame.
  for (let i = 0; i < count; i++) {
    if (o.isCancelled?.()) throw new MediaCancelled();
    const d = (await decodeChecked(await frame(i), size)).data;
    for (let p = 0, q = 0; q < indices.length; p += 4, q++) indices[q] = d[p + 3] < 128 ? TRANSPARENT : lookup(d[p], d[p + 1], d[p + 2]);
    // Graphic control: disposal 2 (restore to background = transparent), transparency on.
    parts.push(new Uint8Array([0x21, 0xf9, 4, (2 << 2) | 1, delays[i] & 255, delays[i] >> 8, TRANSPARENT, 0]));
    parts.push(new Uint8Array([0x2c, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0]));
    parts.push(lzw.encode(indices));
    o.onProgress?.(count + i + 1, count * 2);
    await yieldNow();
  }
  parts.push(new Uint8Array([0x3b]));
  const bytes = concat(parts);
  return {
    bytes,
    stats: {
      format: 'gif' as const,
      frames: count,
      width,
      height,
      bytes: bytes.length,
      paletteColours: colours.length,
      exactColours: exact,
      partialAlphaPixels: hist.partial,
      partialToOpaque: hist.partialToOpaque,
      partialToTransparent: hist.partial - hist.partialToOpaque,
      totalPixels: hist.total,
    },
  };
}
