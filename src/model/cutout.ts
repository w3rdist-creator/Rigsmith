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
// Patching only fills where the remainder became transparent inside the cut, with a
// flat user-chosen colour placed behind existing pixels; it never invents detail, and
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
 * existing pixels (destination-over), so only transparent/translucent pixels change.
 */
export function patchBehind(src: Rgba, poly: readonly number[], grow: number, rgb: [number, number, number]): PatchResult {
  const r = cutRect(poly, grow, src.width, src.height);
  const cov = coverage(poly, grow, r);
  const out = new Uint8ClampedArray(src.data);
  let synthesized = 0;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const c = cov[y * r.width + x];
      if (c <= 0) continue;
      const s = ((r.y + y) * src.width + (r.x + x)) * 4;
      const da = out[s + 3] / 255;
      const pa = c * (1 - da); // patch contribution behind the existing pixel
      if (pa <= 0) continue;
      const a = da + pa;
      for (let k = 0; k < 3; k++) out[s + k] = Math.round((out[s + k] * da + rgb[k] * pa) / a);
      out[s + 3] = Math.round(a * 255);
      if (pa >= 0.5) synthesized++;
    }
  }
  return { image: { width: src.width, height: src.height, data: out }, synthesized };
}

export function parseHexColor(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
