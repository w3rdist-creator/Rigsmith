// Minimal RGBA PNG encoder and original procedural test art (no external assets).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0, 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}

type Shade = (x: number, y: number) => [number, number, number, number] | null;

function paint(w: number, h: number, shade: Shade): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = shade(x + 0.5, y + 0.5);
      if (c) out.set(c, (y * w + x) * 4);
    }
  return out;
}

/** Anti-aliased coverage of a capsule from (x0,y) to (x1,y) with radius r. */
function capsule(x: number, y: number, x0: number, x1: number, cy: number, r: number): number {
  const cx = Math.min(x1, Math.max(x0, x));
  return Math.min(1, Math.max(0, r + 0.5 - Math.hypot(x - cx, y - cy)));
}

/**
 * Original test art: a two-segment striped limb (one image, to be cut at the elbow),
 * plus open/closed hand variants and a small badge — simple procedural shapes.
 */
export const TEST_ART: Record<string, { w: number; h: number; shade: Shade }> = {
  'limb.png': {
    w: 200, h: 44,
    shade: (x, y) => {
      const a = capsule(x, y, 22, 178, 22, 19);
      if (!a) return null;
      const upper = x < 100;
      const stripe = Math.floor(x / 12) % 2 === 0;
      const base = upper ? (stripe ? [52, 120, 220] : [40, 96, 190]) : (stripe ? [240, 140, 40] : [214, 112, 24]);
      const shadeY = 1 - Math.abs(y - 22) / 40;
      return [Math.round(base[0] * shadeY), Math.round(base[1] * shadeY), Math.round(base[2] * shadeY), Math.round(255 * a)];
    },
  },
  'hand-open.png': {
    w: 48, h: 48,
    shade: (x, y) => {
      const palm = Math.min(1, Math.max(0, 16.5 - Math.hypot(x - 24, y - 28)));
      let fingers = 0;
      for (const fx of [12, 20, 28, 36]) fingers = Math.max(fingers, capsule(y, x, 4, 20, fx, 3.5));
      const a = Math.max(palm, fingers);
      return a ? [250, 246, 236, Math.round(255 * a)] : null;
    },
  },
  'hand-closed.png': {
    w: 48, h: 48,
    shade: (x, y) => {
      const a = Math.min(1, Math.max(0, 17.5 - Math.hypot(x - 24, y - 26)));
      if (!a) return null;
      const knuckle = Math.abs(y - 16) < 2 && x > 12 && x < 36;
      return knuckle ? [190, 182, 170, Math.round(255 * a)] : [236, 230, 218, Math.round(255 * a)];
    },
  },
  'badge.png': {
    w: 36, h: 36,
    shade: (x, y) => {
      const a = Math.min(1, Math.max(0, 16.5 - Math.hypot(x - 18, y - 18)));
      return a ? [40, 200, 120, Math.round(255 * a)] : null;
    },
  },
};

export function writeTestArt(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, art] of Object.entries(TEST_ART)) {
    const file = path.join(dir, name);
    writeFileSync(file, encodePng(art.w, art.h, paint(art.w, art.h, art.shade)));
    out[name] = file;
  }
  return out;
}
