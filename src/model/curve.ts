// Cubic Bezier easing (the CSS `cubic-bezier(x1, y1, x2, y2)` shape): the curve runs
// from (0,0) to (1,1) with handles P1 = (x1,y1), P2 = (x2,y2). x is normalized time and
// is clamped to [0,1] so X(s) is monotonic (time never runs backwards); y is free, so a
// handle above 1 or below 0 overshoots / anticipates past the key values.
import type { Curve, Interp } from './types.ts';

/** Named presets offered by the curve editor. */
export const CURVE_PRESETS: Record<string, Curve> = {
  linear: [1 / 3, 1 / 3, 2 / 3, 2 / 3],
  /** Exactly the legacy `smooth` interpolation (smoothstep 3t²−2t³). */
  smooth: [1 / 3, 0, 2 / 3, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
  overshoot: [0.3, 0, 0.35, 1.45],
  anticipate: [0.55, -0.45, 0.7, 1],
  'back-in-out': [0.68, -0.55, 0.27, 1.55],
};

export function clampCurve(c: readonly number[]): Curve {
  const x1 = Math.min(1, Math.max(0, Number.isFinite(c[0]) ? c[0] : 0));
  const x2 = Math.min(1, Math.max(0, Number.isFinite(c[2]) ? c[2] : 1));
  const y1 = Number.isFinite(c[1]) ? c[1] : 0;
  const y2 = Number.isFinite(c[3]) ? c[3] : 1;
  return [x1, y1, x2, y2];
}

/** One coordinate of the cubic at parameter s with endpoints 0 and 1. */
function bez(p1: number, p2: number, s: number): number {
  const u = 1 - s;
  return 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s;
}

function bezSlope(p1: number, p2: number, s: number): number {
  const u = 1 - s;
  return 3 * u * u * p1 + 6 * u * s * (p2 - p1) + 3 * s * s * (1 - p2);
}

/**
 * Solves X(s) = t for s. Newton's method from s = t, falling back to bisection when the
 * slope vanishes or an iterate leaves [0,1]. X is monotonic for x1, x2 in [0,1], so the
 * root is unique; the result is accurate to ~1e-9 in x.
 */
export function solveCurveParam(x1: number, x2: number, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let s = t;
  for (let i = 0; i < 8; i++) {
    const err = bez(x1, x2, s) - t;
    if (Math.abs(err) < 1e-10) return s;
    const d = bezSlope(x1, x2, s);
    if (Math.abs(d) < 1e-7) break;
    const next = s - err / d;
    if (next < 0 || next > 1) break;
    s = next;
  }
  let lo = 0;
  let hi = 1;
  s = t;
  for (let i = 0; i < 60; i++) {
    const x = bez(x1, x2, s);
    if (Math.abs(x - t) < 1e-10) break;
    if (x < t) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return s;
}

/** Eased progress y for normalized time t in [0,1]. */
export function evalCurve(c: Curve, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const [x1, y1, x2, y2] = c;
  return bez(y1, y2, solveCurveParam(x1, x2, t));
}

/** Eased progress for a key's interpolation mode. */
export function ease(interp: Interp, t: number, curve?: Curve): number {
  switch (interp) {
    case 'step':
      return 0;
    case 'smooth':
      return t * t * (3 - 2 * t);
    case 'bezier':
      return curve ? evalCurve(curve, t) : t;
    default:
      return t;
  }
}

/** Cubic-Bezier handles that reproduce an interpolation mode exactly (step has none). */
export function curveFor(interp: Interp, curve?: Curve): Curve | null {
  if (interp === 'bezier') return curve ?? CURVE_PRESETS.linear;
  if (interp === 'smooth') return CURVE_PRESETS.smooth;
  if (interp === 'linear') return CURVE_PRESETS.linear;
  return null;
}
