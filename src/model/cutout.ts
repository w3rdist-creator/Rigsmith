// Flat-art cutout tools: pure pixel operations on straight-alpha RGBA buffers, so the
// browser dialog, the CLI and the unit tests share one implementation. Source images
// are never modified; every result is a new image with provenance (DerivedImage).
//
// Coverage of a pixel by a polygon uses the signed distance from the pixel centre to
// the outline (negative inside, even-odd fill): cov = clamp(grow + 0.5 − sd, 0, 1).
// That gives 1-px anti-aliased edges and an exact outward "overlap" of `grow` px
// (Minkowski dilation by a disc). A piece (grow = overlap) and its remainder
// (1 − cov at grow = 0) are complementary at overlap 0 and share an overlap band
// otherwise, so a rotated piece does not open a gap at the cut.
//
// Patching fills, behind existing pixels, only alpha the original source had inside the
// outline (what a cut removed), with a flat user-chosen colour. Joint extension sweeps
// one clean cross-section of the piece under opaque cover. Neither invents detail, and
// the number of synthesized pixels is recorded.

export interface Rgba {
  width: number;
  height: number;
  /** Straight (non-premultiplied) RGBA, row-major. */
  data: Uint8ClampedArray;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** [x0,y0,x1,y1,…] → bounding box. */
export function polygonBounds(poly: readonly number[]): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    minX = Math.min(minX, poly[i]);
    maxX = Math.max(maxX, poly[i]);
    minY = Math.min(minY, poly[i + 1]);
    maxY = Math.max(maxY, poly[i + 1]);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function polygonArea(poly: readonly number[]): number {
  let a = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[2 * i] * poly[2 * j + 1] - poly[2 * j] * poly[2 * i + 1];
  }
  return Math.abs(a) / 2;
}

/** Area centroid of a simple polygon (vertex mean when the area is zero). */
export function polygonCentroid(poly: readonly number[]): { x: number; y: number } {
  const n = poly.length / 2;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cr = poly[2 * i] * poly[2 * j + 1] - poly[2 * j] * poly[2 * i + 1];
    a += cr;
    cx += (poly[2 * i] + poly[2 * j]) * cr;
    cy += (poly[2 * i + 1] + poly[2 * j + 1]) * cr;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) (sx += poly[2 * i]), (sy += poly[2 * i + 1]);
    return { x: sx / n, y: sy / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Validates a cut polygon; returns an error message or null. */
export function polygonProblem(poly: readonly number[], width: number, height: number): string | null {
  if (poly.length < 6 || poly.length % 2) return 'Place at least 3 points.';
  if (poly.some((v) => !Number.isFinite(v))) return 'The outline has invalid points.';
  if (polygonArea(poly) < 1) return 'The outline encloses no area.';
  const b = polygonBounds(poly);
  if (b.x >= width || b.y >= height || b.x + b.width <= 0 || b.y + b.height <= 0) return 'The outline lies outside the image.';
  return null;
}

/** Signed distance from (x, y) to the polygon outline: negative inside (even-odd). */
export function signedDistance(poly: readonly number[], x: number, y: number): number {
  const n = poly.length / 2;
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    const dx = xj - xi, dy = yj - yi;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - (xi + t * dx), y - (yi + t * dy)));
  }
  return inside ? -best : best;
}

/** Coverage (0..1) of every pixel in `rect` by the polygon grown by `grow` px. */
export function coverage(poly: readonly number[], grow: number, rect: Rect): Float32Array {
  const out = new Float32Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const sd = signedDistance(poly, rect.x + x + 0.5, rect.y + y + 0.5);
      out[y * rect.width + x] = Math.min(1, Math.max(0, grow + 0.5 - sd));
    }
  }
  return out;
}

/** Pixel rectangle covered by the grown polygon, clipped to the image. */
export function cutRect(poly: readonly number[], grow: number, width: number, height: number): Rect {
  const b = polygonBounds(poly);
  const pad = Math.max(0, grow) + 1;
  const x0 = Math.max(0, Math.floor(b.x - pad)), y0 = Math.max(0, Math.floor(b.y - pad));
  const x1 = Math.min(width, Math.ceil(b.x + b.width + pad)), y1 = Math.min(height, Math.ceil(b.y + b.height + pad));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

export interface CutResult {
  piece: Rgba;
  /** Top-left of the piece inside the source image. */
  offsetX: number;
  offsetY: number;
  /** Source with the (un-grown) polygon removed; same size as the source. */
  remainder: Rgba;
  /** Remainder pixels that became fully transparent (the hole). */
  holePixels: number;
}

/**
 * Cuts `poly` (source pixel coordinates) out of `src`. The piece is cropped to the
 * grown polygon's bounds (shrunk further to its non-transparent pixels) and keeps the
 * source alpha × coverage.
 */
export function cutOut(src: Rgba, poly: readonly number[], overlap: number): CutResult {
  const grow = Math.max(0, overlap);
  const r = cutRect(poly, grow, src.width, src.height);
  const cov = coverage(poly, grow, r);
  const cov0 = grow > 0 ? coverage(poly, 0, r) : cov;
  const pieceFull = new Uint8ClampedArray(r.width * r.height * 4);
  const rem = new Uint8ClampedArray(src.data);
  let hole = 0;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const i = y * r.width + x;
      const s = ((r.y + y) * src.width + (r.x + x)) * 4;
      const a = src.data[s + 3];
      const o = i * 4;
      pieceFull[o] = src.data[s];
      pieceFull[o + 1] = src.data[s + 1];
      pieceFull[o + 2] = src.data[s + 2];
      pieceFull[o + 3] = Math.round(a * cov[i]);
      if (!pieceFull[o + 3]) pieceFull[o] = pieceFull[o + 1] = pieceFull[o + 2] = 0;
      const ra = Math.round(a * (1 - cov0[i]));
      rem[s + 3] = ra;
      if (a > 0 && ra === 0) hole++;
    }
  }
  // Tighten the crop to pixels that carry alpha.
  let minX = r.width, minY = r.height, maxX = -1, maxY = -1;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (pieceFull[(y * r.width + x) * 4 + 3]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    minX = minY = 0;
    maxX = maxY = 0;
  }
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const piece = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) piece.set(pieceFull.subarray(((minY + y) * r.width + minX) * 4, ((minY + y) * r.width + minX + w) * 4), y * w * 4);
  return { piece: { width: w, height: h, data: piece }, offsetX: r.x + minX, offsetY: r.y + minY, remainder: { width: src.width, height: src.height, data: rem }, holePixels: hole };
}

export interface PatchResult {
  image: Rgba;
  /** Pixels whose alpha is now mostly synthesized colour. */
  synthesized: number;
}

/**
 * Fills the inside of `poly` (grown by `grow`) with a flat colour placed *behind* the
 * existing pixels (destination-over). With `limit` (the original source), the filled
 * alpha never exceeds what the source had there, so a loose outline cannot paint
 * background the art never covered — the patch only restores what a cut removed.
 */
export function patchBehind(src: Rgba, poly: readonly number[], grow: number, rgb: [number, number, number], limit?: Rgba): PatchResult {
  const r = cutRect(poly, grow, src.width, src.height);
  const cov = coverage(poly, grow, r);
  const out = new Uint8ClampedArray(src.data);
  let synthesized = 0;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const s = ((r.y + y) * src.width + (r.x + x)) * 4;
      const target = cov[y * r.width + x] * (limit ? limit.data[s + 3] / 255 : 1);
      const da = out[s + 3] / 255;
      const pa = target - da; // patch alpha added behind the existing pixel
      if (pa <= 0) continue;
      for (let k = 0; k < 3; k++) out[s + k] = Math.round((out[s + k] * da + rgb[k] * pa) / target);
      out[s + 3] = Math.round(target * 255);
      if (pa >= 0.5) synthesized++;
    }
  }
  return { image: { width: src.width, height: src.height, data: out }, synthesized };
}

export interface Vec2 {
  x: number;
  y: number;
}

function sampleStraight(img: Rgba, x: number, y: number): [number, number, number, number] {
  // Premultiplied bilinear sample at pixel-space point (x, y); returns straight RGBA.
  const fx = x - 0.5, fy = y - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const acc = [0, 0, 0, 0];
  for (const [dx, dy, w] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]] as const) {
    const px = Math.min(img.width - 1, Math.max(0, x0 + dx)), py = Math.min(img.height - 1, Math.max(0, y0 + dy));
    const i = (py * img.width + px) * 4;
    const a = (img.data[i + 3] / 255) * w;
    acc[0] += img.data[i] * a;
    acc[1] += img.data[i + 1] * a;
    acc[2] += img.data[i + 2] * a;
    acc[3] += a;
  }
  return acc[3] > 0 ? [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3], acc[3] * 255] : [0, 0, 0, 0];
}

function alphaAt(img: Rgba, x: number, y: number): number {
  const px = Math.floor(x), py = Math.floor(y);
  if (px < 0 || py < 0 || px >= img.width || py >= img.height) return 0;
  return img.data[(py * img.width + px) * 4 + 3];
}

export interface ExtendResult {
  piece: Rgba;
  offsetX: number;
  offsetY: number;
  /** Pixels (alpha ≥ 50%) that were synthesized by the sweep. */
  synthesized: number;
}

/**
 * Joint extension (the Wiz preparation step, as a tool): sweeps one clean cross-section
 * of a cut limb piece backwards past the joint, along `axis` (unit vector from the pivot
 * into the piece, source pixels), for `length` px. Only transparent piece pixels are
 * filled, and — with `cover` (what is drawn over the piece at rest, in source pixels) —
 * only where the cover is fully opaque (alpha ≥ 250), so the invented pixels are hidden
 * in the setup pose and only show when the joint bends. Nothing else is inferred.
 */
export function extendPiece(piece: Rgba, offsetX: number, offsetY: number, pivot: Vec2, axis: Vec2, length: number, cover: Rgba | null): ExtendResult {
  const n = Math.hypot(axis.x, axis.y) || 1;
  const d = { x: axis.x / n, y: axis.y / n };
  const pp = { x: -d.y, y: d.x };
  // Piece-local sampling (piece pixel coords = source − offset).
  const pa = (sx: number, sy: number) => alphaAt(piece, sx - offsetX, sy - offsetY);
  let sRef = -1;
  for (let s = 0; s < 400; s += 0.5) {
    if (pa(pivot.x + s * d.x, pivot.y + s * d.y) >= 250) {
      sRef = s + 2;
      break;
    }
  }
  if (sRef < 0 || length <= 0) return { piece, offsetX, offsetY, synthesized: 0 };
  const half = (sign: number) => {
    let t = 0;
    while (t < 400 && pa(pivot.x + sRef * d.x + sign * t * pp.x, pivot.y + sRef * d.y + sign * t * pp.y) >= 128) t += 0.25;
    return t;
  };
  const tPos = half(1) + 1, tNeg = half(-1) + 1;
  const corners = [[-length, -tNeg], [-length, tPos], [sRef, -tNeg], [sRef, tPos]].map(([s, t]) => ({ x: pivot.x + s * d.x + t * pp.x, y: pivot.y + s * d.y + t * pp.y }));
  const x0 = Math.floor(Math.min(offsetX, ...corners.map((c) => c.x))), y0 = Math.floor(Math.min(offsetY, ...corners.map((c) => c.y)));
  const x1 = Math.ceil(Math.max(offsetX + piece.width, ...corners.map((c) => c.x))), y1 = Math.ceil(Math.max(offsetY + piece.height, ...corners.map((c) => c.y)));
  const w = x1 - x0, h = y1 - y0;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < piece.height; y++) out.set(piece.data.subarray(y * piece.width * 4, (y + 1) * piece.width * 4), ((y + offsetY - y0) * w + (offsetX - x0)) * 4);
  let synthesized = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (out[o + 3]) continue;
      const qx = x0 + x + 0.5, qy = y0 + y + 0.5;
      const s = (qx - pivot.x) * d.x + (qy - pivot.y) * d.y;
      const t = (qx - pivot.x) * pp.x + (qy - pivot.y) * pp.y;
      if (s < -length || s > sRef || t < -tNeg || t > tPos) continue;
      if (cover && alphaAt(cover, qx, qy) < 250) continue;
      const c = sampleStraight(piece, pivot.x + sRef * d.x + t * pp.x - offsetX, pivot.y + sRef * d.y + t * pp.y - offsetY);
      if (c[3] < 1) continue;
      out.set([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), Math.round(c[3])], o);
      if (c[3] >= 128) synthesized++;
    }
  }
  // Tighten to pixels that carry alpha.
  let mx = w, my = h, Mx = -1, My = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (out[(y * w + x) * 4 + 3]) {
    if (x < mx) mx = x;
    if (x > Mx) Mx = x;
    if (y < my) my = y;
    if (y > My) My = y;
  }
  const tw = Mx - mx + 1, th = My - my + 1;
  const data = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) data.set(out.subarray(((my + y) * w + mx) * 4, ((my + y) * w + mx + tw) * 4), y * tw * 4);
  return { piece: { width: tw, height: th, data }, offsetX: x0 + mx, offsetY: y0 + my, synthesized };
}

export function parseHexColor(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
