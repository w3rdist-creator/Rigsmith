// Deterministic scene renderer: a pure function of (evaluated frame, images, view
// matrix). Used by the editor viewport, onion skins, PNG/sequence export and the
// runtime player. Editor chrome (grid, bones, outlines) is drawn elsewhere.
import type { AttachmentFrame, Frame } from '../model/evaluate.ts';
import type { Mat } from '../model/math.ts';
import { determinant, multiply } from '../model/math.ts';
import type { BlendMode, ImageAsset } from '../model/types.ts';

/**
 * A rectangle of a texture page standing in for an image (texture atlas): source pixel
 * (offsetX + i, offsetY + j) of the image is page pixel (x + i, y + j); the image is
 * transparent outside the rectangle.
 */
export interface ImageRegion {
  source: CanvasImageSource;
  x: number;
  y: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

export type ImageLookup = (asset: ImageAsset) => CanvasImageSource | ImageRegion | null;

function isRegion(v: CanvasImageSource | ImageRegion): v is ImageRegion {
  return typeof (v as ImageRegion).offsetX === 'number' && 'source' in v;
}

/** Draws an image (or its atlas region) into the rectangle [ox, ox+w] × [oy, oy+h] of the current transform. */
function drawImageOrRegion(g: CanvasRenderingContext2D, el: CanvasImageSource | ImageRegion, ox: number, oy: number, w: number, h: number): void {
  if (isRegion(el)) g.drawImage(el.source, el.x, el.y, el.width, el.height, ox + el.offsetX, oy + el.offsetY, el.width, el.height);
  else g.drawImage(el, ox, oy, w, h);
}

export interface DrawOptions {
  /** Draw a translucent red box where an image is missing (editor only). */
  missingPlaceholder?: boolean;
}

export function drawFrame(g: CanvasRenderingContext2D, frame: Frame, images: ImageLookup, vm: Mat, opts: DrawOptions = {}): void {
  for (const f of frame.attachments) drawAttachment(g, f, images, vm, opts);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

/** Canvas composite operation for each blend mode. */
export const BLEND_OP: Record<BlendMode, GlobalCompositeOperation> = { normal: 'source-over', additive: 'lighter', screen: 'screen', multiply: 'multiply' };

export function drawAttachment(g: CanvasRenderingContext2D, f: AttachmentFrame, images: ImageLookup, vm: Mat, opts: DrawOptions = {}): void {
  const im = f.image;
  const alpha = f.opacity * f.color[3];
  if (!im || !f.visible || alpha <= 0) return;
  const el = images(im);
  const op = BLEND_OP[f.blend];
  const tinted = f.color[0] < 1 || f.color[1] < 1 || f.color[2] < 1;
  const mesh = f.vertices && f.att.mesh ? f.att.mesh : null;
  if (el && (tinted || mesh?.alphas)) {
    drawEffectLayer(g, f, el, im, vm, alpha, op, tinted);
    return;
  }
  g.globalAlpha = alpha;
  g.globalCompositeOperation = op;
  if (mesh && el) {
    drawMeshLayer(g, el, im, f.uvs ?? mesh.points, mesh.triangles, f.vertices!, vm, alpha, op);
  } else {
    const m = multiply(vm, f.world);
    g.setTransform(m.a, m.b, m.c, m.d, m.tx, m.ty);
    if (el) drawImageOrRegion(g, el, -im.width / 2, -im.height / 2, im.width, im.height);
    else if (opts.missingPlaceholder) {
      g.fillStyle = 'rgba(255,80,80,0.4)';
      g.fillRect(-im.width / 2, -im.height / 2, im.width, im.height);
    }
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

/**
 * Tinted or vertex-alpha attachments: the attachment is drawn at full opacity into an
 * offscreen layer, its texels are multiplied by the tint (exactly, on unpremultiplied
 * pixels), its vertex alphas are applied as a mask, and the layer is composited once
 * with the attachment's alpha and blend mode.
 */
function drawEffectLayer(g: CanvasRenderingContext2D, f: AttachmentFrame, el: CanvasImageSource | ImageRegion, im: ImageAsset, vm: Mat, alpha: number, op: GlobalCompositeOperation, tinted: boolean): void {
  const mesh = f.vertices && f.att.mesh ? f.att.mesh : null;
  let dev: number[];
  let m: Mat | null = null;
  if (mesh) dev = deviceVertices(f.vertices!, vm);
  else {
    m = multiply(vm, f.world);
    const hw = im.width / 2, hh = im.height / 2;
    dev = [-hw, -hh, hw, -hh, hw, hh, -hw, hh].flatMap((v, i, a) => (i % 2 ? [] : [m!.a * v + m!.c * a[i + 1] + m!.tx, m!.b * v + m!.d * a[i + 1] + m!.ty]));
  }
  const box = deviceBox(g, dev);
  if (!box) return;
  const { x0, y0, w, h } = box;
  const L = layerOf('effect', w, h, true);
  const lg = L.g;
  resetLayer(lg, w, h, g);
  if (mesh) {
    const uvs = f.uvs ?? mesh.points;
    const exact = meshUnfolded(uvs, mesh.triangles, dev);
    lg.globalCompositeOperation = exact ? 'lighter' : 'source-over';
    drawMesh(lg, el, im, uvs, mesh.triangles, f.vertices!, { ...vm, tx: vm.tx - x0, ty: vm.ty - y0 }, exact ? 0 : 0.5);
    lg.globalCompositeOperation = 'source-over';
    if (mesh.alphas) applyVertexAlpha(lg, w, h, mesh.triangles, dev.map((v, i) => v - (i % 2 ? y0 : x0)), mesh.alphas, exact, uvs);
  } else {
    lg.setTransform(m!.a, m!.b, m!.c, m!.d, m!.tx - x0, m!.ty - y0);
    drawImageOrRegion(lg, el, -im.width / 2, -im.height / 2, im.width, im.height);
    lg.setTransform(1, 0, 0, 1, 0, 0);
  }
  if (tinted) tintPixels(lg, w, h, f.color);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = alpha;
  g.globalCompositeOperation = op;
  g.drawImage(L.canvas, 0, 0, w, h, x0, y0, w, h);
  g.restore();
}

/** Multiplies every pixel's colour by the tint (alpha unchanged). */
export function tintPixels(lg: CanvasRenderingContext2D, w: number, h: number, c: readonly number[]): void {
  const data = lg.getImageData(0, 0, w, h);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    d[i] = Math.round(d[i] * c[0]);
    d[i + 1] = Math.round(d[i + 1] * c[1]);
    d[i + 2] = Math.round(d[i + 2] * c[2]);
  }
  lg.putImageData(data, 0, 0);
}

/**
 * Masks the layer by the mesh's vertex alphas: each triangle's alpha is the linear
 * interpolation of its three vertex alphas, which is exactly a linear gradient along
 * the alpha's gradient direction. The mask is drawn with the same clipping rules as the
 * mesh (additive, no bleed, when unfolded), so shared edges sum to the right coverage.
 */
function applyVertexAlpha(lg: CanvasRenderingContext2D, w: number, h: number, triangles: readonly number[], dev: readonly number[], alphas: readonly number[], exact: boolean, uvs: readonly number[]): void {
  const M = layerOf('mask', w, h, true);
  const mg = M.g;
  resetLayer(mg, w, h, lg);
  mg.globalCompositeOperation = exact ? 'lighter' : 'source-over';
  const bleed = exact ? 0 : 0.5;
  for (let t = 0; t < triangles.length; t += 3) {
    const ix = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const p = ix.map((i) => ({ x: dev[2 * i], y: dev[2 * i + 1] }));
    const tu = (uvs[2 * ix[1]] - uvs[2 * ix[0]]) * (uvs[2 * ix[2] + 1] - uvs[2 * ix[0] + 1]) - (uvs[2 * ix[2]] - uvs[2 * ix[0]]) * (uvs[2 * ix[1] + 1] - uvs[2 * ix[0] + 1]);
    const area2 = (p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[2].x - p[0].x) * (p[1].y - p[0].y);
    if (Math.abs(area2) / 2 < MIN_AREA || Math.abs(tu) < 1e-9) continue;
    const a = ix.map((i) => alphas[i]);
    mg.save();
    mg.beginPath();
    const cx = (p[0].x + p[1].x + p[2].x) / 3, cy = (p[0].y + p[1].y + p[2].y) / 3;
    p.forEach((q, k) => {
      const dx = q.x - cx, dy = q.y - cy, len = Math.hypot(dx, dy) || 1;
      const x = bleed ? q.x + (dx / len) * bleed : q.x, y = bleed ? q.y + (dy / len) * bleed : q.y;
      if (k === 0) mg.moveTo(x, y);
      else mg.lineTo(x, y);
    });
    mg.closePath();
    mg.clip();
    mg.fillStyle = alphaGradient(mg, p, a, area2);
    mg.fillRect(0, 0, w, h);
    mg.restore();
  }
  lg.globalCompositeOperation = 'destination-in';
  lg.drawImage(M.canvas, 0, 0);
  lg.globalCompositeOperation = 'source-over';
}

/**
 * The linear function through three (point, alpha) samples as a canvas fill: a solid
 * colour when the alpha is constant, else a linear gradient from the lowest to the
 * highest alpha along the function's gradient (the gradient is exact between them, and
 * the triangle lies between them).
 */
export function alphaGradient(g: CanvasRenderingContext2D, p: readonly { x: number; y: number }[], a: readonly number[], area2: number): string | CanvasGradient {
  const lo = Math.min(a[0], a[1], a[2]), hi = Math.max(a[0], a[1], a[2]);
  if (hi - lo < 1 / 512) return `rgba(0,0,0,${(lo + hi) / 2})`;
  // ∇α from the plane through the three samples.
  const gx = ((a[1] - a[0]) * (p[2].y - p[0].y) - (a[2] - a[0]) * (p[1].y - p[0].y)) / area2;
  const gy = ((a[2] - a[0]) * (p[1].x - p[0].x) - (a[1] - a[0]) * (p[2].x - p[0].x)) / area2;
  const g2 = gx * gx + gy * gy;
  const at = (v: number) => ({ x: p[0].x + (gx * (v - a[0])) / g2, y: p[0].y + (gy * (v - a[0])) / g2 });
  const s = at(lo), e = at(hi);
  const grad = g.createLinearGradient(s.x, s.y, e.x, e.y);
  grad.addColorStop(0, `rgba(0,0,0,${lo})`);
  grad.addColorStop(1, `rgba(0,0,0,${hi})`);
  return grad;
}

function deviceVertices(world: readonly number[], vm: Mat): number[] {
  const dev = new Array<number>(world.length);
  for (let i = 0; i < world.length; i += 2) {
    dev[i] = vm.a * world[i] + vm.c * world[i + 1] + vm.tx;
    dev[i + 1] = vm.b * world[i] + vm.d * world[i + 1] + vm.ty;
  }
  return dev;
}

/** Integer device-pixel box (1 px margin, clipped to the canvas) around points, or null when empty. */
function deviceBox(g: CanvasRenderingContext2D, dev: readonly number[]): { x0: number; y0: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < dev.length; i += 2) {
    minX = Math.min(minX, dev[i]);
    maxX = Math.max(maxX, dev[i]);
    minY = Math.min(minY, dev[i + 1]);
    maxY = Math.max(maxY, dev[i + 1]);
  }
  if (!Number.isFinite(minX + minY + maxX + maxY)) return null;
  const x0 = Math.max(0, Math.floor(minX) - 1), y0 = Math.max(0, Math.floor(minY) - 1);
  const x1 = Math.min(g.canvas.width, Math.ceil(maxX) + 1), y1 = Math.min(g.canvas.height, Math.ceil(maxY) + 1);
  const w = x1 - x0, h = y1 - y0;
  return w > 0 && h > 0 ? { x0, y0, w, h } : null;
}

function resetLayer(lg: CanvasRenderingContext2D, w: number, h: number, like: CanvasRenderingContext2D): void {
  lg.setTransform(1, 0, 0, 1, 0, 0);
  lg.globalAlpha = 1;
  lg.globalCompositeOperation = 'source-over';
  lg.clearRect(0, 0, w, h);
  lg.imageSmoothingEnabled = like.imageSmoothingEnabled;
  lg.imageSmoothingQuality = like.imageSmoothingQuality;
}

/**
 * The 2D context every exported frame is drawn into (PNG frame, ZIP, APNG/GIF, WebM/MP4,
 * CLI) and the reference player draws into. `willReadFrequently` selects Chrome's software
 * raster, and drawMeshLayer then uses a software layer too. On the accelerated path the same data
 * gave history-dependent pixels (LP-004: half-scale Wiz frames 0–90 differed between the
 * dialog and the CLI, 91–170 agreed; the cause lies in the accelerated mesh layer and is
 * not established). On the software path both are byte-identical.
 */
export function exportContext(canvas: { getContext(id: '2d', options?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D | null }): CanvasRenderingContext2D | null {
  return canvas.getContext('2d', { willReadFrequently: true });
}

/** Below this area (device px²) a triangle is degenerate and skipped. */
const MIN_AREA = 1e-6;

type Layer = { canvas: OffscreenCanvas | HTMLCanvasElement; g: CanvasRenderingContext2D };
type LayerKey = 'gpu' | 'software' | 'effect' | 'mask';
const layerCache: Record<LayerKey, Layer | null> = { gpu: null, software: null, effect: null, mask: null };
/**
 * The offscreen layer for a mesh. A target created with `willReadFrequently` (every
 * exported frame, see exportContext) gets its own software layer, so an export never
 * mixes raster paths, and the viewport's layer is never forced out of the GPU.
 */
function layerOf(key: LayerKey, w: number, h: number, software: boolean): Layer {
  let layer = layerCache[key];
  if (!layer) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    layer = layerCache[key] = { canvas, g: canvas.getContext('2d', { willReadFrequently: software }) as CanvasRenderingContext2D };
  }
  // Exactly the mesh's size every time: Chrome's anti-aliased clipping measurably
  // depends on the layer's size, so a grow-only cache made a frame's pixels depend on
  // which frames were drawn before it (found by the runtime-player agreement test).
  const c = layer.canvas;
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return layer;
}

/**
 * Signed device-space areas of the drawable triangles agree in sign (no fold). A mesh
 * that is mirrored as a whole (negative-scale bone) still agrees; only a mesh folded over
 * itself mixes orientations.
 */
export function meshUnfolded(uvs: readonly number[], triangles: readonly number[], dev: readonly number[]): boolean {
  let sign = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const i0 = triangles[t], i1 = triangles[t + 1], i2 = triangles[t + 2];
    const tu = (uvs[2 * i1] - uvs[2 * i0]) * (uvs[2 * i2 + 1] - uvs[2 * i0 + 1]) - (uvs[2 * i2] - uvs[2 * i0]) * (uvs[2 * i1 + 1] - uvs[2 * i0 + 1]);
    const a = (dev[2 * i1] - dev[2 * i0]) * (dev[2 * i2 + 1] - dev[2 * i0 + 1]) - (dev[2 * i2] - dev[2 * i0]) * (dev[2 * i1 + 1] - dev[2 * i0 + 1]);
    if (Math.abs(a) / 2 < MIN_AREA || Math.abs(tu) < 1e-9) continue;
    const s = Math.sign(a) * Math.sign(tu);
    if (!sign) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * Draws a mesh into an offscreen layer at full opacity, then composites the layer once
 * with the attachment opacity (so triangle overlaps never double the opacity).
 * Unfolded meshes draw with additive ('lighter') compositing and no bleed: the
 * anti-aliased clip coverages of two triangles sharing an edge sum to 1, so interior
 * seams are exact even over translucent texels. Folded meshes (mixed orientations) draw
 * source-over in triangle order with a 0.5 px bleed so the fold keeps a stable order.
 */
export function drawMeshLayer(
  g: CanvasRenderingContext2D,
  img: CanvasImageSource | ImageRegion,
  im: { width: number; height: number },
  uvs: readonly number[],
  triangles: readonly number[],
  world: readonly number[],
  vm: Mat,
  opacity: number,
  op: GlobalCompositeOperation = 'source-over',
): void {
  const n = world.length / 2;
  const dev = new Array<number>(world.length);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = vm.a * world[2 * i] + vm.c * world[2 * i + 1] + vm.tx;
    const y = vm.b * world[2 * i] + vm.d * world[2 * i + 1] + vm.ty;
    dev[2 * i] = x;
    dev[2 * i + 1] = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX + minY + maxX + maxY)) return;
  const x0 = Math.max(0, Math.floor(minX) - 1), y0 = Math.max(0, Math.floor(minY) - 1);
  const x1 = Math.min(g.canvas.width, Math.ceil(maxX) + 1), y1 = Math.min(g.canvas.height, Math.ceil(maxY) + 1);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const exact = meshUnfolded(uvs, triangles, dev);
  const soft = g.getContextAttributes?.().willReadFrequently === true;
  const L = layerOf(soft ? 'software' : 'gpu', w, h, soft);
  const lg = L.g;
  lg.setTransform(1, 0, 0, 1, 0, 0);
  lg.globalAlpha = 1;
  lg.globalCompositeOperation = 'source-over';
  lg.clearRect(0, 0, w, h);
  lg.imageSmoothingEnabled = g.imageSmoothingEnabled;
  lg.imageSmoothingQuality = g.imageSmoothingQuality;
  lg.globalCompositeOperation = exact ? 'lighter' : 'source-over';
  drawMesh(lg, img, im, uvs, triangles, world, { ...vm, tx: vm.tx - x0, ty: vm.ty - y0 }, exact ? 0 : 0.5);
  lg.globalCompositeOperation = 'source-over';
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = opacity;
  g.globalCompositeOperation = op;
  g.drawImage(L.canvas, 0, 0, w, h, x0, y0, w, h);
  g.restore();
}

/**
 * Textured triangles on Canvas2D: each triangle is clipped to its destination outline
 * and the image drawn through the affine map from texture space (image px) to the
 * screen. The clip is expanded by `bleed` device px about the triangle's centroid so
 * neighbouring triangles overlap slightly and no hairline cracks show at shared edges.
 */
export function drawMesh(
  g: CanvasRenderingContext2D,
  img: CanvasImageSource | ImageRegion,
  im: { width: number; height: number },
  uvs: readonly number[],
  triangles: readonly number[],
  world: readonly number[],
  vm: Mat,
  bleed = 0.5,
): void {
  for (let t = 0; t < triangles.length; t += 3) {
    const i0 = triangles[t], i1 = triangles[t + 1], i2 = triangles[t + 2];
    const u0 = uvs[2 * i0], v0 = uvs[2 * i0 + 1];
    const u1 = uvs[2 * i1], v1 = uvs[2 * i1 + 1];
    const u2 = uvs[2 * i2], v2 = uvs[2 * i2 + 1];
    const p = [i0, i1, i2].map((i) => ({
      x: vm.a * world[2 * i] + vm.c * world[2 * i + 1] + vm.tx,
      y: vm.b * world[2 * i] + vm.d * world[2 * i + 1] + vm.ty,
    }));
    const tex = triangleAffine(u0, v0, u1, v1, u2, v2, p[0].x, p[0].y, p[1].x, p[1].y, p[2].x, p[2].y);
    if (!tex) continue;
    const area = Math.abs((p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[2].x - p[0].x) * (p[1].y - p[0].y)) / 2;
    if (area < MIN_AREA) continue;
    const cx = (p[0].x + p[1].x + p[2].x) / 3;
    const cy = (p[0].y + p[1].y + p[2].y) / 3;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.beginPath();
    for (let k = 0; k < 3; k++) {
      const dx = p[k].x - cx, dy = p[k].y - cy;
      const len = Math.hypot(dx, dy) || 1;
      const x = bleed ? p[k].x + (dx / len) * bleed : p[k].x, y = bleed ? p[k].y + (dy / len) * bleed : p[k].y;
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.clip();
    g.setTransform(tex.a, tex.b, tex.c, tex.d, tex.tx, tex.ty);
    drawImageOrRegion(g, img, 0, 0, im.width, im.height);
    g.restore();
  }
}

/**
 * Affine map taking texture points (u,v) to screen points (x,y) for one triangle, or
 * null when the texture triangle has no area (cannot be inverted).
 */
export function triangleAffine(
  u0: number, v0: number, u1: number, v1: number, u2: number, v2: number,
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
): Mat | null {
  const du1 = u1 - u0, dv1 = v1 - v0, du2 = u2 - u0, dv2 = v2 - v0;
  const det = du1 * dv2 - du2 * dv1;
  if (Math.abs(det) < 1e-9) return null;
  const dx1 = x1 - x0, dy1 = y1 - y0, dx2 = x2 - x0, dy2 = y2 - y0;
  const inv = 1 / det;
  const a = (dx1 * dv2 - dx2 * dv1) * inv;
  const b = (dy1 * dv2 - dy2 * dv1) * inv;
  const c = (dx2 * du1 - dx1 * du2) * inv;
  const d = (dy2 * du1 - dy1 * du2) * inv;
  const m: Mat = { a, b, c, d, tx: x0 - a * u0 - c * v0, ty: y0 - b * u0 - d * v0 };
  return Number.isFinite(determinant(m)) ? m : null;
}
