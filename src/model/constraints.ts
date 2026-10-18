// Constraints, applied to the sampled local pose before world matrices are final:
// every IK constraint in array order, then every path constraint in array order.
// Solvers write local rotation/translation back through the inverse parent matrix, so
// mirrored parents (negative determinant) and scaled parents give the same local
// solution as the unscaled rig.
//
// Two-bone IK (bones [parent, child], target bone T) is solved in the chain parent's
// local space (the space bone 1's local transform lives in), where any parent scale,
// non-uniform or mirrored, has been undone:
//   o = shoulder (bone 1 local x, y), t = T mapped into that space,
//   tip − o = R(r1) · S1 · (e + k·(cos r2, sin r2)), with S1 bone 1's own scale, e the
//   child's local offset and k = child scaleX · child length.
//   R(r1) is a pure rotation, so |tip − o| depends only on r2: the elbow angle solves
//   |S1 · (e + k·(cos r2, sin r2))| = |t − o| numerically for every scale (uniform or
//   not): the extremes of that length are bracketed by sampling r2 every 0.5° and
//   bisected, each monotonic stretch between them holds at most one root, bisected to
//   rounding; then r1 turns the result onto t. Limitation: two extremes closer than
//   one 0.5° sample step (only possible for extreme non-uniform scale) can be missed. A target outside the reachable annulus takes the
//   elbow angle whose length is closest (straightens the chain toward T, or folds it),
//   measured in parent space. A world distance ≈ 0 (target on the shoulder) leaves the
//   pose untouched. `bendPositive` puts the elbow on the clockwise side of the
//   shoulder→target line in parent space; under a mirrored parent the side mirrors on
//   screen, so a mirrored rig produces the mirror image of the unmirrored solution.
//   When several elbow angles qualify, the one nearest the keyed rotation wins.
//   mix blends each bone's local rotation from its keyed value (0) to the solution (1).
// One-bone IK aims the bone's +x axis at the target.
//
// Path constraint: bones are placed along a cubic Bezier path (in its bone's space) at
// arc length position·L + i·spacing. Open paths clamp to [0, L]; closed paths wrap.
// With `rotate`, bones turn to the path tangent plus rotateOffset. mix blends local
// translation/rotation from the keyed values (0) to the constrained values (1).
import { sampleKeys } from './animation.ts';
import type { Mat, Vec } from './math.ts';
import { apply, applyLinear, DEG, determinant, identity, invert } from './math.ts';
import { computeWorld } from './skeleton.ts';
import type { Animation, Bone, IkConstraint, LocalPose, PathConstraint, PathShape, Project } from './types.ts';

const EPS = 1e-9;

export function constraintMix(anim: Animation | null, id: string, time: number, base: number): number {
  const keys = anim?.constraints?.[id]?.mix;
  const v = keys?.length ? sampleKeys(keys, time, [base])[0] : base;
  return Math.min(1, Math.max(0, v));
}

export function pathPosition(anim: Animation | null, pc: PathConstraint, time: number): number {
  const keys = anim?.constraints?.[pc.id]?.position;
  return keys?.length ? sampleKeys(keys, time, [pc.position])[0] : pc.position;
}

/** Constraint values supplied by the caller (a blended mix) instead of one animation's keys. */
export interface ConstraintValues {
  mix(id: string, base: number): number;
  position(id: string, base: number): number;
}

export function applyConstraints(project: Project, pose: Map<string, LocalPose>, anim: Animation | null, time: number, values?: ConstraintValues): void {
  if (!project.ik?.length && !project.pathConstraints?.length) return;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  for (const ik of project.ik ?? []) {
    const mix = values ? clamp(values.mix(ik.id, ik.mix)) : constraintMix(anim, ik.id, time, ik.mix);
    if (mix > 0) solveIk(project.bones, pose, ik, mix);
  }
  for (const pc of project.pathConstraints ?? []) {
    const path = project.paths?.find((p) => p.id === pc.pathId);
    const mix = values ? clamp(values.mix(pc.id, pc.mix)) : constraintMix(anim, pc.id, time, pc.mix);
    if (path && mix > 0) solvePath(project.bones, pose, path, pc, values ? values.position(pc.id, pc.position) : pathPosition(anim, pc, time), mix);
  }
}

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const angle = (v: Vec) => Math.atan2(v.y, v.x) / DEG;
const rotate = (v: Vec, deg: number): Vec => {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
};

function parentWorldOf(bones: readonly Bone[], world: Map<string, Mat>, id: string): Mat {
  const pid = bones.find((b) => b.id === id)?.parentId;
  return (pid && world.get(pid)) || identity();
}

/** Local rotation that points the bone's +x axis along `worldDir` under `parent`. */
export function localRotationFor(parent: Mat, worldDir: Vec, local: LocalPose): number {
  const d = applyLinear(invert(parent), worldDir);
  const r = angle(d);
  return local.scaleX < 0 ? r - 180 : r;
}

/** Returns `target` wrapped to the nearest turn of `from` (keeps rotations continuous). */
function nearTurn(from: number, target: number): number {
  return from + wrap(target - from);
}

function setRotation(pose: Map<string, LocalPose>, id: string, rotation: number): void {
  const cur = pose.get(id)!;
  pose.set(id, { ...cur, rotation });
}

export function solveIk(bones: readonly Bone[], pose: Map<string, LocalPose>, ik: IkConstraint, mix: number): void {
  const [pId, cId] = ik.bones;
  const pBone = bones.find((b) => b.id === pId);
  if (!pBone || !pose.has(pId)) return;
  const world = computeWorld(bones, pose);
  const target = world.get(ik.target);
  const wp = world.get(pId);
  if (!target || !wp) return;
  const t: Vec = { x: target.tx, y: target.ty };
  const p: Vec = { x: wp.tx, y: wp.ty };
  const local1 = pose.get(pId)!;
  const base1 = local1.rotation;
  const parent1 = parentWorldOf(bones, world, pId);

  const cBone = cId ? bones.find((b) => b.id === cId) : undefined;
  if (!cBone || !world.get(cId) || !pose.has(cId)) {
    // One bone: aim +x at the target.
    const dir = { x: t.x - p.x, y: t.y - p.y };
    if (Math.hypot(dir.x, dir.y) < EPS) return;
    const solved = nearTurn(base1, localRotationFor(parent1, dir, local1));
    setRotation(pose, pId, base1 + mix * (solved - base1));
    return;
  }
  if (Math.hypot(t.x - p.x, t.y - p.y) < 1e-6) return; // degenerate: target on the chain root — leave the pose as keyed
  if (Math.abs(determinant(parent1)) < 1e-12) return; // collapsed parent: no local solution
  const local2 = pose.get(cId)!;
  const base2 = local2.rotation;
  // Parent-local space: shoulder o, target q relative to o.
  const tl = apply(invert(parent1), t);
  const q: Vec = { x: tl.x - local1.x, y: tl.y - local1.y };
  const D = Math.hypot(q.x, q.y);
  const chain: Chain = { sx: local1.scaleX, sy: local1.scaleY, ex: local2.x, ey: local2.y, k: local2.scaleX * cBone.length };
  const { ex, ey, k } = chain;
  if (![D, chain.sx, chain.sy, ex, ey, k].every(Number.isFinite)) return; // non-finite pose: leave it as keyed
  const elbowArm: Vec = { x: chain.sx * ex, y: chain.sy * ey };
  const side = ik.bendPositive ? 1 : -1;

  let solved1 = base1, solved2 = base2;
  if (Math.hypot(elbowArm.x, elbowArm.y) <= EPS) {
    // Child sits on the shoulder: bone 1 keeps its rotation, bone 2 aims at the target.
    if (Math.abs(k) > EPS) {
      const aim = { x: t.x - (wp.a * ex + wp.c * ey + wp.tx), y: t.y - (wp.b * ex + wp.d * ey + wp.ty) };
      if (Math.hypot(aim.x, aim.y) > EPS) solved2 = nearTurn(base2, localRotationFor(wp, aim, local2));
    }
  } else if (Math.abs(k) <= EPS) {
    // Zero-length child: aim the elbow at the target.
    solved1 = nearTurn(base1, angle(q) - angle(elbowArm));
  } else {
    const pick = (r2: number) => {
      const r1 = angle(q) - angle(chainVec(chain, r2));
      const el = rotate(elbowArm, r1);
      return { r1, r2, side: q.x * el.y - q.y * el.x };
    };
    const tol = 1e-9 * (D * Math.hypot(elbowArm.x, elbowArm.y) + 1);
    const options = elbowAngles(chain, D, base2).map(pick);
    const wanted = options.filter((o) => side * o.side > tol);
    const straight = options.filter((o) => Math.abs(o.side) <= tol);
    // Requested side first; a straight (collinear) chain serves either side.
    const pool = wanted.length ? wanted : straight.length ? straight : options;
    pool.sort((a, b) => Math.abs(wrap(a.r2 - base2)) - Math.abs(wrap(b.r2 - base2)));
    if (!pool.length || !Number.isFinite(pool[0].r1)) return; // no finite solution: leave the pose as keyed
    solved1 = nearTurn(base1, pool[0].r1);
    solved2 = nearTurn(base2, pool[0].r2);
  }
  setRotation(pose, pId, base1 + mix * (solved1 - base1));
  setRotation(pose, cId, base2 + mix * (solved2 - base2));
}

/** Shoulder→tip vector before bone 1's rotation: v(r2) = S1 · (e + k·(cos r2, sin r2)). */
interface Chain { sx: number; sy: number; ex: number; ey: number; k: number }

function chainVec(c: Chain, r2: number): Vec {
  return { x: c.sx * (c.ex + c.k * Math.cos(r2 * DEG)), y: c.sy * (c.ey + c.k * Math.sin(r2 * DEG)) };
}

/** d|v|²/dr2 (per radian), from v'(r2) = S1 · k·(−sin r2, cos r2). */
function chainSlope(c: Chain, r2: number): number {
  const w = chainVec(c, r2);
  return 2 * (w.x * -c.sx * c.k * Math.sin(r2 * DEG) + w.y * c.sy * c.k * Math.cos(r2 * DEG));
}

const IK_SAMPLES = 720;

function bisect(g: (r: number) => number, lo: number, hi: number): number {
  let glo = g(lo);
  for (let i = 0; i < 100 && hi - lo > 1e-13; i++) {
    const mid = (lo + hi) / 2, gm = g(mid);
    if (gm === 0) return mid;
    if (gm < 0 === glo < 0) { lo = mid; glo = gm; } else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Elbow angles r2 (degrees) with |v(r2)| = D: |v|² is monotonic between consecutive
 * extremes (roots of its derivative, located by sampling and bisection), so each
 * stretch holds at most one root, refined by bisection. When D lies outside the reach
 * annulus, returns the extreme(s) whose length is closest to D.
 */
function elbowAngles(c: Chain, D: number, from: number): number[] {
  const len2 = (r: number) => { const w = chainVec(c, r); return w.x * w.x + w.y * w.y; };
  const f = (r: number) => len2(r) - D * D;
  const slope = (r: number) => chainSlope(c, r);
  const step = 360 / IK_SAMPLES;
  const extremes: number[] = [];
  // Samples start off the round angles (where extremes of symmetric chains sit exactly)
  // and close the loop, so an extreme on a sample boundary is still bracketed once.
  const start = from - 180 + 0.3819660113 * step;
  for (let i = 0; i < IK_SAMPLES; i++) {
    const a = start + i * step, b = i + 1 < IK_SAMPLES ? a + step : start + 360;
    const da = slope(a), db = slope(b);
    if (da === 0) extremes.push(a);
    else if (da < 0 !== db < 0 && db !== 0) extremes.push(bisect(slope, a, b));
  }
  if (!extremes.length) return [from]; // |v| constant: every elbow angle reaches equally far
  const roots: number[] = [];
  extremes.forEach((a, i) => {
    const b = i + 1 < extremes.length ? extremes[i + 1] : extremes[0] + 360;
    const fa = f(a), fb = f(b);
    if (fa === 0) roots.push(a);
    else if (fa < 0 !== fb < 0 && fb !== 0) roots.push(bisect(f, a, b));
  });
  if (roots.length) return roots;
  const gap = (r: number) => Math.abs(Math.sqrt(len2(r)) - D);
  const best = Math.min(...extremes.map(gap));
  return extremes.filter((r) => gap(r) <= best + 1e-9 * (D + 1));
}

// ---- Paths --------------------------------------------------------------------------

export interface PathSample {
  point: Vec;
  /** Tangent direction (degrees, world). */
  tangent: number;
}

type Seg = [Vec, Vec, Vec, Vec];

/** World-space cubic segments of a path. */
export function pathSegments(path: PathShape, m: Mat): Seg[] {
  const n = path.nodes;
  const segs: Seg[] = [];
  const count = path.closed ? n.length : n.length - 1;
  for (let i = 0; i < count; i++) {
    const a = n[i], b = n[(i + 1) % n.length];
    segs.push([
      apply(m, { x: a.x, y: a.y }),
      apply(m, { x: a.x + a.outX, y: a.y + a.outY }),
      apply(m, { x: b.x + b.inX, y: b.y + b.inY }),
      apply(m, { x: b.x, y: b.y }),
    ]);
  }
  return segs;
}

function bez(s: Seg, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * s[0].x + b * s[1].x + c * s[2].x + d * s[3].x, y: a * s[0].y + b * s[1].y + c * s[2].y + d * s[3].y };
}

function bezDeriv(s: Seg, t: number): Vec {
  const u = 1 - t;
  const a = 3 * u * u, b = 6 * u * t, c = 3 * t * t;
  return {
    x: a * (s[1].x - s[0].x) + b * (s[2].x - s[1].x) + c * (s[3].x - s[2].x),
    y: a * (s[1].y - s[0].y) + b * (s[2].y - s[1].y) + c * (s[3].y - s[2].y),
  };
}

export const PATH_SAMPLES_PER_SEGMENT = 32;

/** Arc-length table: cumulative length at each (segment, t) sample. */
export class PathTable {
  readonly segs: Seg[];
  readonly closed: boolean;
  private readonly lens: number[] = [0];
  readonly length: number;

  constructor(path: PathShape, m: Mat) {
    this.segs = pathSegments(path, m);
    this.closed = path.closed;
    let acc = 0;
    for (const s of this.segs) {
      let prev = s[0];
      for (let k = 1; k <= PATH_SAMPLES_PER_SEGMENT; k++) {
        const q = bez(s, k / PATH_SAMPLES_PER_SEGMENT);
        acc += Math.hypot(q.x - prev.x, q.y - prev.y);
        this.lens.push(acc);
        prev = q;
      }
    }
    this.length = acc;
  }

  /** Point and tangent at arc length s (clamped on open paths, wrapped on closed ones). */
  at(s: number): PathSample {
    const L = this.length;
    if (!this.segs.length) return { point: { x: 0, y: 0 }, tangent: 0 };
    if (L <= EPS) return { point: this.segs[0][0], tangent: 0 };
    s = this.closed ? ((s % L) + L) % L : Math.min(L, Math.max(0, s));
    let lo = 0, hi = this.lens.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.lens[mid] <= s) lo = mid;
      else hi = mid;
    }
    const span = this.lens[hi] - this.lens[lo];
    const f = span > EPS ? (s - this.lens[lo]) / span : 0;
    const seg = Math.min(this.segs.length - 1, Math.floor(lo / PATH_SAMPLES_PER_SEGMENT));
    const t = Math.min(1, (lo - seg * PATH_SAMPLES_PER_SEGMENT + f) / PATH_SAMPLES_PER_SEGMENT);
    const s3 = this.segs[seg];
    let dv = bezDeriv(s3, t);
    if (Math.hypot(dv.x, dv.y) < EPS) dv = { x: s3[3].x - s3[0].x, y: s3[3].y - s3[0].y };
    return { point: bez(s3, t), tangent: angle(dv) };
  }
}

export function pathWorldMatrix(path: PathShape, world: Map<string, Mat>): Mat {
  return (path.boneId && world.get(path.boneId)) || identity();
}

export function solvePath(bones: readonly Bone[], pose: Map<string, LocalPose>, path: PathShape, pc: PathConstraint, position: number, mix: number): void {
  let world = computeWorld(bones, pose);
  const table = new PathTable(path, pathWorldMatrix(path, world));
  pc.bones.forEach((id, i) => {
    const cur = pose.get(id);
    if (!cur) return;
    const sample = table.at(position * table.length + i * pc.spacing);
    const parent = parentWorldOf(bones, world, id);
    const local = apply(invert(parent), sample.point);
    const next: LocalPose = { ...cur, x: cur.x + mix * (local.x - cur.x), y: cur.y + mix * (local.y - cur.y) };
    if (pc.rotate) {
      const dir = rotate({ x: 1, y: 0 }, sample.tangent + pc.rotateOffset);
      const solved = nearTurn(cur.rotation, localRotationFor(parent, dir, cur));
      next.rotation = cur.rotation + mix * (solved - cur.rotation);
    }
    pose.set(id, next);
    world = computeWorld(bones, pose);
  });
}
