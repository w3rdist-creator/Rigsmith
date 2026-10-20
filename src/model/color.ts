// Attachment tint colours (v3): `#rrggbbaa` strings in the project file, [r, g, b, a]
// (each 0..1) in keys and evaluated frames.
import type { Attachment } from './types.ts';

export type Rgba = [number, number, number, number];
export const WHITE: Rgba = [1, 1, 1, 1];

const HEX = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;

export const isColor = (s: unknown): s is string => typeof s === 'string' && HEX.test(s);

/** `#rrggbb` or `#rrggbbaa` → [r, g, b, a] in 0..1, or null when malformed. */
export function parseColor(s: string): Rgba | null {
  if (!HEX.test(s)) return null;
  const n = (i: number) => parseInt(s.slice(i, i + 2), 16) / 255;
  return [n(1), n(3), n(5), s.length === 9 ? n(7) : 1];
}

/** [r, g, b, a] → lowercase `#rrggbbaa` (channels clamped to 0..1, rounded to 8 bits). */
export function formatColor(c: readonly number[]): string {
  return '#' + c.slice(0, 4).map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');
}

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** The attachment's setup tint. */
export const setupColor = (a: Attachment): Rgba => (a.color ? (parseColor(a.color) ?? WHITE) : WHITE);

export const isWhite = (c: readonly number[]): boolean => c[0] >= 1 && c[1] >= 1 && c[2] >= 1 && c[3] >= 1;

/** A key value is a colour: four numbers in 0..1. */
export const colorValueProblem = (v: number[]): string | null => (v.length === 4 && v.every((x) => x >= 0 && x <= 1) ? null : 'must be four numbers [r, g, b, a] from 0 to 1');

/** Sets vertex i's alpha (creating the list at 1 when absent). Pure: returns the new list. */
export function withVertexAlpha(a: Attachment, i: number, alpha: number): number[] {
  const mesh = a.mesh;
  if (!mesh) throw new Error(`${a.name} has no mesh.`);
  const n = mesh.points.length / 2;
  if (!(Number.isInteger(i) && i >= 0 && i < n)) throw new Error(`Vertex ${i} is out of range (0..${n - 1}).`);
  const out = mesh.alphas ? mesh.alphas.slice() : new Array<number>(n).fill(1);
  out[i] = clamp01(alpha);
  return out;
}

/**
 * Radial vertex alpha in image pixels: 1 within r0 of (cx, cy), fading (smoothstep) to 0
 * at r1 and beyond — e.g. a knee-pit crease drawn over the leg that shows only in the
 * pit. `invert` gives the complement (a hole that fades in).
 */
export function radialAlphas(a: Attachment, cx: number, cy: number, r0: number, r1: number, invert = false): number[] {
  const mesh = a.mesh;
  if (!mesh) throw new Error(`${a.name} has no mesh.`);
  if (!(r0 >= 0 && r1 > r0)) throw new Error('Radial alpha needs 0 ≤ inner < outer radius.');
  const out: number[] = [];
  for (let i = 0; i < mesh.points.length; i += 2) {
    const t = Math.min(1, Math.max(0, (Math.hypot(mesh.points[i] - cx, mesh.points[i + 1] - cy) - r0) / (r1 - r0)));
    const v = 1 - t * t * (3 - 2 * t);
    out.push(invert ? 1 - v : v);
  }
  return out;
}
