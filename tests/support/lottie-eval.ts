// Independent evaluator for the Lottie subset Rigsmith exports (does not import src/):
// keyframed properties with hold / cubic-Bezier easing (own bisection solver), split
// position, layer transform T(p)·R(r)·S(s)·T(−a) composed through `parent`, in/out
// points, opacity. Returns the image draws of one frame, back to front, as matrices from
// centred image coordinates to composition pixels (feed them to compositeDraws).
import type { M } from './reference-composite.ts';

const mul = (a: M, b: M): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const T = (x: number, y: number): M => [1, 0, 0, 1, x, y];
const R = (deg: number): M => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
};
const S = (x: number, y: number): M => [x, 0, 0, y, 0, 0];

/** y of the CSS-style cubic Bezier (0,0),(x1,y1),(x2,y2),(1,1) at x = u, by bisection on x(s). */
export function cubicEase(x1: number, y1: number, x2: number, y2: number, u: number): number {
  const c = (p1: number, p2: number, s: number) => 3 * (1 - s) * (1 - s) * s * p1 + 3 * (1 - s) * s * s * p2 + s * s * s;
  let lo = 0, hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (c(x1, x2, mid) < u) lo = mid;
    else hi = mid;
  }
  return c(y1, y2, (lo + hi) / 2);
}

const at = (v: number | number[], d: number) => (Array.isArray(v) ? v[Math.min(d, v.length - 1)] : v);

/** Value of a Lottie property at frame f (numbers or arrays). */
export function propAt(p: any, f: number): number[] {
  if (!p.a) return Array.isArray(p.k) ? p.k : [p.k];
  const ks = p.k as any[];
  if (f <= ks[0].t) return ks[0].s;
  const last = ks[ks.length - 1];
  if (f >= last.t) return last.s;
  let j = 0;
  while (!(ks[j].t <= f && f < ks[j + 1].t)) j++;
  const a = ks[j], b = ks[j + 1];
  if (a.h === 1) return a.s;
  const u = (f - a.t) / (b.t - a.t);
  return a.s.map((v: number, d: number) => v + cubicEase(at(a.o.x, d), at(a.o.y, d), at(a.i.x, d), at(a.i.y, d), u) * (b.s[d] - v));
}

export function layerLocal(ks: any, f: number): M {
  const p = ks.p.s ? [propAt(ks.p.x, f)[0], propAt(ks.p.y, f)[0]] : propAt(ks.p, f);
  const r = propAt(ks.r, f)[0];
  const s = propAt(ks.s, f);
  const a = propAt(ks.a, f);
  return mul(mul(mul(T(p[0], p[1]), R(r)), S(s[0] / 100, s[1] / 100)), T(-a[0], -a[1]));
}

export interface LottieDraw {
  asset: { id: string; w: number; h: number; p: string };
  /** Centred image coordinates → composition pixels. */
  m: M;
  opacity: number;
  layer: string;
}

export function layerWorld(lottie: any, f: number): Map<number, M> {
  const byInd = new Map<number, any>(lottie.layers.map((l: any) => [l.ind, l]));
  const out = new Map<number, M>();
  const world = (ind: number): M => {
    const hit = out.get(ind);
    if (hit) return hit;
    const l = byInd.get(ind)!;
    const local = layerLocal(l.ks, f);
    const m = l.parent ? mul(world(l.parent), local) : local;
    out.set(ind, m);
    return m;
  };
  for (const l of lottie.layers) world(l.ind);
  return out;
}

export function lottieFrame(lottie: any, f: number): LottieDraw[] {
  const assets = new Map<string, any>(lottie.assets.map((a: any) => [a.id, a]));
  const worlds = layerWorld(lottie, f);
  const draws: LottieDraw[] = [];
  // Layer 0 is on top: walk from the last layer to the first.
  for (let i = lottie.layers.length - 1; i >= 0; i--) {
    const l = lottie.layers[i];
    if (l.ty !== 2 || f < l.ip || f >= l.op) continue;
    const asset = assets.get(l.refId);
    const opacity = propAt(l.ks.o, f)[0] / 100;
    draws.push({ asset, m: mul(worlds.get(l.ind)!, T(asset.w / 2, asset.h / 2)), opacity, layer: l.nm });
  }
  return draws;
}
