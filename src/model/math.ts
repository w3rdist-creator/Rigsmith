// 2D affine matrices. Point mapping: x' = a*x + c*y + tx, y' = b*x + d*y + ty.
// World space is y-down (screen convention); positive rotation is clockwise on screen.

export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export interface Vec {
  x: number;
  y: number;
}

export const DEG = Math.PI / 180;

export function identity(): Mat {
  return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
}

/** Returns m ∘ n: applying the result equals applying n first, then m. */
export function multiply(m: Mat, n: Mat): Mat {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    tx: m.a * n.tx + m.c * n.ty + m.tx,
    ty: m.b * n.tx + m.d * n.ty + m.ty,
  };
}

/** Translate · Rotate · Scale, rotation in degrees. */
export function fromTRS(x: number, y: number, rotationDeg: number, sx: number, sy: number): Mat {
  const r = rotationDeg * DEG;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { a: cos * sx, b: sin * sx, c: -sin * sy, d: cos * sy, tx: x, ty: y };
}

export function determinant(m: Mat): number {
  return m.a * m.d - m.b * m.c;
}

export function invert(m: Mat): Mat {
  const det = determinant(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    // Degenerate (zero scale): fall back to translation-only inverse so callers stay finite.
    return { a: 1, b: 0, c: 0, d: 1, tx: -m.tx, ty: -m.ty };
  }
  const inv = 1 / det;
  return {
    a: m.d * inv,
    b: -m.b * inv,
    c: -m.c * inv,
    d: m.a * inv,
    tx: (m.c * m.ty - m.d * m.tx) * inv,
    ty: (m.b * m.tx - m.a * m.ty) * inv,
  };
}

export function apply(m: Mat, p: Vec): Vec {
  return { x: m.a * p.x + m.c * p.y + m.tx, y: m.b * p.x + m.d * p.y + m.ty };
}

/** Applies only the linear part (for direction vectors). */
export function applyLinear(m: Mat, p: Vec): Vec {
  return { x: m.a * p.x + m.c * p.y, y: m.b * p.x + m.d * p.y };
}

/** World angle of the matrix x-axis, degrees. */
export function angleOf(m: Mat): number {
  return Math.atan2(m.b, m.a) / DEG;
}

export interface TRS {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/**
 * Decomposes into translate/rotate/scale. Skew cannot be represented and is dropped
 * (this only matters under rotated, non-uniformly scaled parents).
 */
export function decompose(m: Mat): TRS {
  const sx = Math.hypot(m.a, m.b);
  const det = determinant(m);
  const sy = sx > 1e-12 ? det / sx : Math.hypot(m.c, m.d);
  return { x: m.tx, y: m.ty, rotation: Math.atan2(m.b, m.a) / DEG, scaleX: sx, scaleY: sy };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wraps degrees into (-180, 180]. */
export function wrapDegrees(d: number): number {
  let r = ((d + 180) % 360 + 360) % 360 - 180;
  if (r === -180) r = 180;
  return r;
}

export function round(v: number, places = 4): number {
  const f = 10 ** places;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
}
