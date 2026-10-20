// Smears (R13): on frames where an attachment moves fast (a twirl, a whip), a still frame
// strobes. smearAnimation() paints a motion-smeared copy of the attachment's own image for
// each such frame — the current pose solid, with a fading trail along the rigid motion
// since the previous frame (rotation about its fixed point, or a slide) — and keys an image
// swap to it, restoring the image the clip showed on the next slow frame. The smear image
// is padded about the same centre, so the unsmeared pixels stay exactly where they were.
import { snapToFrame } from './animation.ts';
import type { Rgba } from './cutout.ts';
import { evaluate } from './evaluate.ts';
import type { Mat } from './math.ts';
import { invert, multiply } from './math.ts';
import { decodePngExact, dataUrlBytes, encodePngExact } from './png.ts';
import { keySlotImage } from './rigOps.ts';
import type { ImageAsset, Project } from './types.ts';

export interface SmearOptions {
  /**
   * Attachments to smear (ids): props and limbs that whip — a whisk, a paw. Smearing
   * features that ride on an unsmeared mesh (eyes on a head) would tear them apart.
   */
  attachments: string[];
  /** A frame smears when some corner of the image moves at least this far (image px). */
  minPx?: number;
  /** Trail samples (more = smoother streak). */
  samples?: number;
  /** Trail opacity where every sample covers, 0..1. */
  strength?: number;
}

export const SMEAR_DEFAULTS = { minPx: 40, samples: 10, strength: 0.6 };
/** A smear image may be at most this many times the source's pixel count (the trail is cut). */
const MAX_GROWTH = 9;

/** The motion since the previous frame, in the current image's centred coordinates. */
export interface Motion {
  /** Rotation (degrees) about `cx, cy`; 0 = a pure slide by `tx, ty`. */
  angle: number;
  cx: number;
  cy: number;
  tx: number;
  ty: number;
}

/** Rigid part of prev→current: where the previous image sits in the current image's frame. */
export function motionBetween(prev: Mat, cur: Mat): Motion {
  const m = multiply(invert(cur), prev);
  const a = Math.atan2(m.b, m.a);
  const angle = (a * 180) / Math.PI;
  if (Math.abs(a) < 1e-6) return { angle: 0, cx: 0, cy: 0, tx: m.tx, ty: m.ty };
  // Fixed point c of p ↦ R p + t: (I − R) c = t.
  const c = Math.cos(a), s = Math.sin(a);
  const d = (1 - c) * (1 - c) + s * s;
  return { angle, cx: ((1 - c) * m.tx - s * m.ty) / d, cy: (s * m.tx + (1 - c) * m.ty) / d, tx: m.tx, ty: m.ty };
}

/** The motion at fraction u (0 = now, 1 = the previous frame) applied to point (x, y). */
function along(mo: Motion, u: number, x: number, y: number): [number, number] {
  if (!mo.angle) return [x + mo.tx * u, y + mo.ty * u];
  const a = (mo.angle * u * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const dx = x - mo.cx, dy = y - mo.cy;
  return [mo.cx + c * dx - s * dy, mo.cy + s * dx + c * dy];
}

/** Largest distance any image corner travels between the frames (image px). */
export function motionSize(mo: Motion, w: number, h: number): number {
  let out = 0;
  for (const [x, y] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) {
    const [px, py] = along(mo, 1, x, y);
    out = Math.max(out, Math.hypot(px - x, py - y));
  }
  return out;
}

/**
 * The smeared image: the source drawn solid over its trail (`samples` copies along the
 * motion, fading with age, averaged at `strength`), on a canvas padded symmetrically so
 * the source's centre and pixels keep their place.
 */
export function smearPixels(src: Rgba, mo: Motion, samples = SMEAR_DEFAULTS.samples, strength = SMEAR_DEFAULTS.strength): Rgba {
  const w = src.width, h = src.height;
  let ex = w / 2, ey = h / 2;
  for (let k = 1; k <= samples; k++)
    for (const [x, y] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) {
      const [px, py] = along(mo, k / samples, x, y);
      ex = Math.max(ex, Math.abs(px));
      ey = Math.max(ey, Math.abs(py));
    }
  let padX = Math.ceil(ex - w / 2), padY = Math.ceil(ey - h / 2);
  const grow = ((w + 2 * padX) * (h + 2 * padY)) / (w * h);
  if (grow > MAX_GROWTH) {
    // Shrink both paddings by the same factor k: (w + 2k·padX)(h + 2k·padY) = MAX_GROWTH·w·h.
    const A = 4 * padX * padY, B = 2 * (w * padY + h * padX), C = w * h * (1 - MAX_GROWTH);
    const k = A > 0 ? (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A) : -C / B;
    padX = Math.max(0, Math.floor(padX * k));
    padY = Math.max(0, Math.floor(padY * k));
  }
  const W = w + 2 * padX, H = h + 2 * padY;
  const out = new Uint8ClampedArray(W * H * 4);
  const d = src.data;
  // Bilinear, premultiplied, transparent outside.
  const sample = (x: number, y: number, acc: number[], wgt: number) => {
    const fx = x + w / 2 - 0.5, fy = y + h / 2 - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++) {
        const xx = x0 + i, yy = y0 + j;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = (i ? ax : 1 - ax) * (j ? ay : 1 - ay) * wgt;
        const o = (yy * w + xx) * 4, a = (d[o + 3] / 255) * k;
        acc[0] += (d[o] / 255) * a;
        acc[1] += (d[o + 1] / 255) * a;
        acc[2] += (d[o + 2] / 255) * a;
        acc[3] += a;
      }
  };
  const front = [0, 0, 0, 0], trail = [0, 0, 0, 0];
  for (let py = 0; py < H; py++)
    for (let px = 0; px < W; px++) {
      const x = px + 0.5 - W / 2, y = py + 0.5 - H / 2;
      front.fill(0);
      trail.fill(0);
      sample(x, y, front, 1);
      for (let k = 1; k <= samples; k++) {
        // The copy that sits at fraction u along the motion: undo the motion for this pixel.
        const u = k / samples;
        const [sx, sy] = along({ ...mo, angle: -mo.angle, tx: -mo.tx, ty: -mo.ty }, u, x, y);
        sample(sx, sy, trail, ((1 - 0.8 * (k - 1) / samples) * strength) / samples * 1.6);
      }
      const ta = Math.min(1, trail[3]), tk = trail[3] > 0 ? ta / trail[3] : 0;
      const a = front[3] + ta * (1 - front[3]);
      if (a <= 0) continue;
      const o = (py * W + px) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(((front[c] + trail[c] * tk * (1 - front[3])) / a) * 255);
      out[o + 3] = Math.round(a * 255);
    }
  return { width: W, height: H, data: out };
}

export interface SmearResult {
  images: ImageAsset[];
  /** attachment name → smeared frames */
  frames: Record<string, number[]>;
}

/**
 * Adds a smear image per fast frame of `animId` and keys the image swaps (see the file
 * comment). Mesh attachments, emitters and hidden frames are skipped. Image ids are
 * derived from the image, attachment, animation and frame, so repeated runs are reproducible.
 */
export async function smearAnimation(project: Project, animId: string, opts: SmearOptions): Promise<SmearResult> {
  const anim = project.animations.find((a) => a.id === animId);
  if (!anim) throw new Error(`No animation "${animId}".`);
  const { minPx, samples, strength } = { ...SMEAR_DEFAULTS, ...opts };
  const n = Math.round(anim.duration * anim.fps);
  const frames = Array.from({ length: n + 1 }, (_, f) => evaluate(project, anim, f / anim.fps));
  const atts = project.attachments.filter((a) => !a.mesh && !a.emitter && opts.attachments.includes(a.id));
  const result: SmearResult = { images: [], frames: {} };
  const decoded = new Map<string, Rgba>();
  for (const att of atts) {
    const smeared: { f: number; imageId: string }[] = [];
    const shown: (string | undefined)[] = [];
    for (let f = 0; f <= n; f++) {
      const cur = frames[f].attachments.find((x) => x.att.id === att.id)!;
      shown.push(cur.image?.id);
      const pf = f > 0 ? f - 1 : anim.loop && n > 1 ? n - 1 : -1;
      if (pf < 0 || !cur.image || !cur.visible || cur.opacity <= 0) continue;
      const prev = frames[pf].attachments.find((x) => x.att.id === att.id)!;
      const mo = motionBetween(prev.world, cur.world);
      if (motionSize(mo, cur.image.width, cur.image.height) < minPx) continue;
      const im = cur.image;
      if (!decoded.has(im.id)) decoded.set(im.id, await decodePngExact(dataUrlBytes(im.dataUrl)));
      const px = smearPixels(decoded.get(im.id)!, mo, samples, strength);
      const id = `${im.id}~smear~${att.id}~${anim.id}~${f}`;
      const bytes = await encodePngExact(px);
      let b64 = '';
      for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const asset: ImageAsset = { id, name: `${im.name.replace(/\.png$/i, '')}~smear-${att.name}-${anim.name}-${f}.png`, mime: 'image/png', width: px.width, height: px.height, dataUrl: `data:image/png;base64,${btoa(b64)}` };
      result.images.push(asset);
      smeared.push({ f, imageId: id });
    }
    if (!smeared.length) continue;
    const set = new Set(smeared.map((s) => s.f));
    for (const s of smeared) {
      // A loop's last frame repeats frame 0 and is never shown on its own.
      if (anim.loop && s.f === n) continue;
      keySlotImage(anim, att.id, s.f / anim.fps, s.imageId);
      const next = s.f + 1;
      if (next <= n && !set.has(next) && shown[next]) keySlotImage(anim, att.id, next / anim.fps, shown[next]!);
    }
    if (anim.loop && set.has(0) && shown[1] && !set.has(1)) keySlotImage(anim, att.id, snapToFrame(1 / anim.fps, anim.fps), shown[1]!);
    result.frames[att.name] = smeared.map((s) => s.f);
  }
  project.images.push(...result.images.filter((im) => !project.images.some((x) => x.id === im.id)));
  return result;
}

