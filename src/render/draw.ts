// Deterministic scene renderer: a pure function of (evaluated frame, images, view
// matrix). Used by the editor viewport, onion skins, PNG/sequence export and the
// runtime player. Editor chrome (grid, bones, outlines) is drawn elsewhere.
import type { AttachmentFrame, Frame } from '../model/evaluate.ts';
import type { Mat } from '../model/math.ts';
import { determinant, multiply } from '../model/math.ts';
import type { ImageAsset } from '../model/types.ts';

export type ImageLookup = (asset: ImageAsset) => CanvasImageSource | null;

export interface DrawOptions {
  /** Draw a translucent red box where an image is missing (editor only). */
  missingPlaceholder?: boolean;
}

export function drawFrame(g: CanvasRenderingContext2D, frame: Frame, images: ImageLookup, vm: Mat, opts: DrawOptions = {}): void {
  for (const f of frame.attachments) drawAttachment(g, f, images, vm, opts);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
}

export function drawAttachment(g: CanvasRenderingContext2D, f: AttachmentFrame, images: ImageLookup, vm: Mat, opts: DrawOptions = {}): void {
  const im = f.image;
  if (!im || !f.visible || f.opacity <= 0) return;
  const el = images(im);
  g.globalAlpha = f.opacity;
  if (f.vertices && f.att.mesh && el) {
    drawMesh(g, el, im, f.att.mesh.points, f.att.mesh.triangles, f.vertices, vm);
  } else {
    const m = multiply(vm, f.world);
    g.setTransform(m.a, m.b, m.c, m.d, m.tx, m.ty);
    if (el) g.drawImage(el, -im.width / 2, -im.height / 2, im.width, im.height);
    else if (opts.missingPlaceholder) {
      g.fillStyle = 'rgba(255,80,80,0.4)';
      g.fillRect(-im.width / 2, -im.height / 2, im.width, im.height);
    }
  }
  g.globalAlpha = 1;
}

/** Below this area (device px²) a triangle is degenerate and skipped. */
const MIN_AREA = 1e-6;

/**
 * Textured triangles on Canvas2D: each triangle is clipped to its destination outline
 * and the image drawn through the affine map from texture space (image px) to the
 * screen. The clip is expanded by `bleed` device px about the triangle's centroid so
 * neighbouring triangles overlap slightly and no hairline cracks show at shared edges.
 */
export function drawMesh(
  g: CanvasRenderingContext2D,
  img: CanvasImageSource,
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
      const x = p[k].x + (dx / len) * bleed, y = p[k].y + (dy / len) * bleed;
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.clip();
    g.setTransform(tex.a, tex.b, tex.c, tex.d, tex.tx, tex.ty);
    g.drawImage(img, 0, 0, im.width, im.height);
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
