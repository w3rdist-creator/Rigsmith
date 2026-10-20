// Springs (v3, R8): damped follow-through on bone chains, simulated per clip from the
// clip's own evaluated motion — the same model as the showcase rigs' hand-written
// springBake() — so a hat, ears or a tail lag and settle without baked keys. Evaluation
// adds the offsets to the keyed rotations (before IK and other constraints); the result
// is cached per animation until anything it depends on changes.
import { angleOf, apply } from './math.ts';
import type { Animation, LocalPose, Project, SpringConstraint } from './types.ts';

/** Per bone: the offset (degrees) at every frame 0 … round(duration · fps). */
export type SpringOffsets = Map<string, number[]>;

type Evaluator = (project: Project, anim: Animation, time: number, partial: SpringOffsets) => { world: Map<string, { a: number; b: number; c: number; d: number; tx: number; ty: number }> };

const cache = new WeakMap<Animation, { sig: string; offsets: SpringOffsets }>();
let evaluator: Evaluator | null = null;
let held = false;

/**
 * While held (the editor's drag gestures), springOffsets() keeps returning an animation's
 * last simulation instead of re-simulating on every pointer move (≈0.5 s per 8 s clip on
 * a 56-bone rig); releasing re-simulates on the next evaluate.
 */
export function holdSprings(on: boolean): void {
  held = on;
}

/** evaluate.ts registers itself (avoids an import cycle). */
export function setSpringEvaluator(e: Evaluator): void {
  evaluator = e;
}

const wrap = (d: number) => ((((d + 540) % 360) + 360) % 360) - 180;

/** Everything a simulation depends on (bones, constraints, springs and the clip's keys). */
function signature(p: Project, a: Animation): string {
  return JSON.stringify([p.bones, p.ik, p.paths, p.pathConstraints, p.transformConstraints, p.springs, a.tracks, a.constraints, a.duration, a.fps, a.loop]);
}

/** Simulates one bone (see SpringConstraint); `solved` holds the chain bones before it. */
function simulate(p: Project, a: Animation, s: SpringConstraint, boneId: string, solved: SpringOffsets): number[] {
  const bone = p.bones.find((b) => b.id === boneId)!;
  const n = Math.round(a.duration * a.fps);
  const tgt: number[] = [], base: { x: number; y: number }[] = [];
  for (let f = 0; f <= n; f++) {
    const m = evaluator!(p, a, f / a.fps, solved).world.get(boneId)!;
    tgt.push(angleOf(m));
    base.push(apply(m, { x: 0, y: 0 }));
  }
  const len = Math.max(20, bone.length);
  const passes = a.loop ? 2 : 1;
  let phi = tgt[0], vel = 0;
  const off = new Array<number>(n + 1).fill(0);
  for (let pass = 0; pass < passes; pass++) {
    for (let f = 0; f <= n; f++) {
      const fp = f === 0 ? (a.loop ? n - 1 : 0) : f - 1, fn = f === n ? (a.loop ? 1 : n) : f + 1;
      const ax = base[fn].x - 2 * base[f].x + base[fp].x, ay = base[fn].y - 2 * base[f].y + base[fp].y;
      const dir = (phi * Math.PI) / 180;
      // The base's acceleration across the bone (px/frame²) kicks it the other way.
      const perp = -ax * Math.sin(dir) + ay * Math.cos(dir);
      vel += s.stiffness * wrap(tgt[f] - phi) - s.damping * vel - ((perp / len) * 180) / Math.PI * s.gain * 0.5;
      phi += vel;
      let ofs = wrap(phi - tgt[f]);
      if (Math.abs(ofs) > s.max) {
        ofs = Math.sign(ofs) * s.max;
        phi = tgt[f] + ofs;
        vel *= 0.5;
      }
      if (pass === passes - 1) off[f] = ofs;
    }
  }
  if (a.loop && n > 0) {
    const blend = Math.min(s.blend, n);
    for (let i = 0; i < blend; i++) {
      const f = n - blend + i, w = (i + 1) / blend;
      off[f] = off[f] * (1 - w) + off[0] * w;
    }
    off[n] = off[0];
  }
  return off.map((v) => v * s.mix);
}

/** The spring offsets of an animation (cached; empty without springs). */
export function springOffsets(p: Project, a: Animation): SpringOffsets {
  if (!p.springs?.length || !evaluator) return new Map();
  const hit = cache.get(a);
  if (hit && held) return hit.offsets;
  const sig = signature(p, a);
  if (hit && hit.sig === sig) return hit.offsets;
  const out: SpringOffsets = new Map();
  for (const s of p.springs) for (const id of s.bones) if (p.bones.some((b) => b.id === id)) out.set(id, simulate(p, a, s, id, out));
  cache.set(a, { sig, offsets: out });
  return out;
}

/** Offset of one bone at time t: linear between frames. */
export function offsetAt(offs: number[], a: Animation, t: number): number {
  const n = offs.length - 1;
  const u = Math.min(n, Math.max(0, t * a.fps));
  const f0 = Math.floor(u), f1 = Math.min(n, f0 + 1);
  return offs[f0] + (offs[f1] - offs[f0]) * (u - f0);
}

/** Adds the springs' offsets to a sampled local pose (in place). */
export function applySprings(pose: Map<string, LocalPose>, offsets: SpringOffsets, a: Animation, t: number): void {
  for (const [id, offs] of offsets) {
    const lp = pose.get(id);
    if (lp) pose.set(id, { ...lp, rotation: lp.rotation + offsetAt(offs, a, t) });
  }
}

/** Problems with a spring's parameters (empty when valid). */
export function springProblems(s: Pick<SpringConstraint, 'stiffness' | 'damping' | 'gain' | 'max' | 'blend' | 'mix'>): string[] {
  const e: string[] = [];
  const fin = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!fin(s.stiffness) || s.stiffness <= 0 || s.stiffness > 1) e.push('stiffness must be more than 0 and at most 1');
  if (!fin(s.damping) || s.damping < 0 || s.damping > 1) e.push('damping must be from 0 to 1');
  if (!fin(s.gain) || s.gain < 0 || s.gain > 10) e.push('gain must be from 0 to 10');
  if (!fin(s.max) || s.max <= 0 || s.max > 180) e.push('max must be more than 0 and at most 180 degrees');
  if (!Number.isInteger(s.blend) || s.blend < 0 || s.blend > 120) e.push('blend must be a whole number of frames from 0 to 120');
  if (!fin(s.mix) || s.mix < 0 || s.mix > 1) e.push('mix must be from 0 to 1');
  return e;
}
