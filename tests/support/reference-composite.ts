// Independent reference renderer for correctness checks. It does NOT import src/: the
// pose sampling (linear / step / smoothstep / cubic-bezier via bisection), the TRS
// matrix chain, draw order, slot visibility/opacity/image keys, and the compositing
// (bilinear texture sampling × 4×4 supersampled quad coverage, premultiplied
// source-over) are re-derived here from the project JSON and the format docs.
import type { Decoded } from './png-decode.ts';
import { decodePng } from './png-decode.ts';

export type M = [number, number, number, number, number, number]; // a b c d tx ty

const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

function trs(x: number, y: number, deg: number, sx: number, sy: number): M {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r) * sx, Math.sin(r) * sx, -Math.sin(r) * sy, Math.cos(r) * sy, x, y];
}

function inv(m: M): M {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

function bezierEase(c: number[], t: number): number {
  // Bisection on x(s) (monotonic for x handles in [0,1]); independent of src/model/curve.ts.
  const B = (p1: number, p2: number, s: number) => 3 * (1 - s) * (1 - s) * s * p1 + 3 * (1 - s) * s * s * p2 + s * s * s;
  let lo = 0, hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (B(c[0], c[2], mid) < t) lo = mid;
    else hi = mid;
  }
  return B(c[1], c[3], (lo + hi) / 2);
}

export function sampleTrack(keys: any[] | undefined, t: number, fallback: number[]): number[] {
  if (!keys?.length) return fallback;
  if (t <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.time) return last.value;
  let i = 0;
  while (keys[i + 1].time <= t) i++;
  const a = keys[i], b = keys[i + 1];
  const u = (t - a.time) / (b.time - a.time);
  const e = a.interp === 'step' ? 0 : a.interp === 'smooth' ? u * u * (3 - 2 * u) : a.interp === 'bezier' ? bezierEase(a.curve, u) : u;
  return a.value.map((v: number, k: number) => v + (b.value[k] - v) * e);
}

function stepped(keys: any[] | undefined, t: number): any {
  let out: any;
  for (const k of keys ?? []) if (k.time <= t + 1e-9) out = k;
  return out;
}

/** World matrix per bone id at time t (anim null = setup pose). No constraints. */
export function boneWorlds(project: any, anim: any | null, t: number): Map<string, M> {
  const out = new Map<string, M>();
  const pending = [...project.bones];
  while (pending.length) {
    const i = pending.findIndex((b: any) => b.parentId === null || out.has(b.parentId));
    if (i < 0) throw new Error('cycle');
    const b = pending.splice(i, 1)[0];
    const tr = anim?.tracks?.[b.id];
    const [x, y] = sampleTrack(tr?.translate, t, [b.x, b.y]);
    const [r] = sampleTrack(tr?.rotate, t, [b.rotation]);
    const [sx, sy] = sampleTrack(tr?.scale, t, [b.scaleX, b.scaleY]);
    const local = trs(x, y, r, sx, sy);
    out.set(b.id, b.parentId ? mul(out.get(b.parentId)!, local) : local);
  }
  return out;
}

export interface RefImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function decodeProjectImages(project: any): Map<string, Decoded> {
  const m = new Map<string, Decoded>();
  for (const im of project.images) m.set(im.id, decodePng(Buffer.from(im.dataUrl.split(',')[1], 'base64')));
  return m;
}

/**
 * Composites the project at time t into a w×h transparent RGBA buffer where world point
 * (x,y) maps to pixel ((x - originX)·scale, (y - originY)·scale).
 */
export function composite(project: any, anim: any | null, t: number, images: Map<string, Decoded>, w: number, h: number, originX: number, originY: number, scale: number, worldOverride?: Map<string, M>): RefImage {
  // Constraints (IK/paths) are not re-solved here: callers that need them pass bone
  // world matrices measured elsewhere and check the constraint geometry separately.
  const worlds = worldOverride ?? boneWorlds(project, anim, t);
  // Premultiplied float accumulation.
  const acc = new Float64Array(w * h * 4);
  const view: M = [scale, 0, 0, scale, -originX * scale, -originY * scale];
  const dk = stepped(anim?.drawOrder, t);
  const byId = new Map(project.attachments.map((a: any) => [a.id, a]));
  const order: any[] = dk ? dk.order.map((id: string) => byId.get(id)) : project.attachments;
  for (const a of order) {
    const st = anim?.slots?.[a.id];
    // Stepped channels show the setup value before their first key.
    const vk = stepped(st?.visible, t);
    const visible = vk ? vk.value[0] >= 0.5 : !a.hidden;
    const opacity = st?.opacity?.length ? sampleTrack(st.opacity, t, [a.opacity])[0] : a.opacity;
    if (!visible || opacity <= 0) continue;
    const imageId = stepped(st?.image, t)?.imageId ?? a.imageId;
    const meta = project.images.find((i: any) => i.id === imageId);
    const img = images.get(imageId)!;
    const base = a.boneId ? worlds.get(a.boneId)! : ([1, 0, 0, 1, 0, 0] as M);
    const m = mul(view, mul(base, trs(a.x, a.y, a.rotation, a.scaleX, a.scaleY)));
    const im = inv(m);
    const hw = meta.width / 2, hh = meta.height / 2;
    // Screen bounding box of the quad.
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0])))), x1 = Math.min(w - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1])))), y1 = Math.min(h - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))));
    const sx = meta.width / img.width, sy = meta.height / img.height;
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        // Coverage of the pixel by the quad (4×4 subsamples).
        let cov = 0;
        for (let j = 0; j < 4; j++)
          for (let i = 0; i < 4; i++) {
            const qx = px + (i + 0.5) / 4, qy = py + (j + 0.5) / 4;
            const u = im[0] * qx + im[2] * qy + im[4], v = im[1] * qx + im[3] * qy + im[5];
            if (u >= -hw && u <= hw && v >= -hh && v <= hh) cov++;
          }
        if (!cov) continue;
        const cx = px + 0.5, cy = py + 0.5;
        const u = (im[0] * cx + im[2] * cy + im[4] + hw) / sx - 0.5;
        const v = (im[1] * cx + im[3] * cy + im[5] + hh) / sy - 0.5;
        const s = bilinear(img, u, v);
        const k = (cov / 16) * opacity;
        const o = (py * w + px) * 4;
        const sa = s[3] * k;
        for (let c = 0; c < 3; c++) acc[o + c] = s[c] * k + acc[o + c] * (1 - sa);
        acc[o + 3] = sa + acc[o + 3] * (1 - sa);
      }
    }
  }
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = acc[i * 4 + 3];
    data[i * 4 + 3] = Math.round(a * 255);
    for (let c = 0; c < 3; c++) data[i * 4 + c] = a > 0 ? Math.round(Math.min(1, acc[i * 4 + c] / a) * 255) : 0;
  }
  return { width: w, height: h, data };
}

/** Premultiplied bilinear sample (clamped to the image), channels in 0..1. */
function bilinear(img: Decoded, u: number, v: number): [number, number, number, number] {
  const cu = Math.min(img.width - 1, Math.max(0, u)), cv = Math.min(img.height - 1, Math.max(0, v));
  const x0 = Math.floor(cu), y0 = Math.floor(cv);
  const x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1);
  const fx = cu - x0, fy = cv - y0;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  const tap = (x: number, y: number, wgt: number) => {
    const o = (y * img.width + x) * 4;
    const a = img.data[o + 3] / 255;
    out[0] += (img.data[o] / 255) * a * wgt;
    out[1] += (img.data[o + 1] / 255) * a * wgt;
    out[2] += (img.data[o + 2] / 255) * a * wgt;
    out[3] += a * wgt;
  };
  tap(x0, y0, (1 - fx) * (1 - fy));
  tap(x1, y0, fx * (1 - fy));
  tap(x0, y1, (1 - fx) * fy);
  tap(x1, y1, fx * fy);
  return out;
}

export interface DiffStats {
  /** Max abs difference over premultiplied RGBA channels (0..255). */
  maxDiff: number;
  meanDiff: number;
  /** Pixels where any premultiplied channel differs by more than `tol`. */
  over: number;
  /** Pixels with alpha > 0 in either image. */
  covered: number;
  tol: number;
}

/** Compares two straight-alpha RGBA buffers in premultiplied space. */
export function diffImages(a: { width: number; height: number; data: Uint8Array }, b: { width: number; height: number; data: Uint8Array }, tol: number): DiffStats {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size mismatch ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  let maxDiff = 0, sum = 0, over = 0, covered = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    const o = i * 4;
    const aa = a.data[o + 3], ba = b.data[o + 3];
    if (aa || ba) covered++;
    let worst = Math.abs(aa - ba);
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs((a.data[o + c] * aa) / 255 - (b.data[o + c] * ba) / 255));
    maxDiff = Math.max(maxDiff, worst);
    sum += worst;
    if (worst > tol) over++;
  }
  return { maxDiff, meanDiff: sum / (a.width * a.height), over, covered, tol };
}
