// Constraints, applied to the sampled local pose before world matrices are final:
// every IK constraint in array order, then every path constraint in array order.
// Each solver works in world space and writes local rotation/translation back, so
// parents with negative determinants (mirrored rigs) and non-unit scale behave
// deterministically.
//
// Two-bone IK (bones [parent, child], target bone T):
//   l1 = |child origin − parent origin|, l2 = child length (world), d = |T − parent|.
//   The elbow angle comes from the law of cosines with cos clamped to [−1, 1], so an
//   unreachable target (d > l1 + l2) straightens the chain toward T and a too-close
//   target (d < |l1 − l2|) folds it. d ≈ 0 (target on the shoulder) leaves the pose
//   untouched. `bendPositive` puts the elbow on the clockwise side of the
//   shoulder→target line on screen; under a mirrored parent the side mirrors too, so a
//   mirrored rig produces the mirror image of the unmirrored solution.
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

export function applyConstraints(project: Project, pose: Map<string, LocalPose>, anim: Animation | null, time: number): void {
  if (!project.ik?.length && !project.pathConstraints?.length) return;
  for (const ik of project.ik ?? []) {
    const mix = constraintMix(anim, ik.id, time, ik.mix);
    if (mix > 0) solveIk(project.bones, pose, ik, mix);
  }
  for (const pc of project.pathConstraints ?? []) {
    const path = project.paths?.find((p) => p.id === pc.pathId);
    const mix = constraintMix(anim, pc.id, time, pc.mix);
    if (path && mix > 0) solvePath(project.bones, pose, path, pc, pathPosition(anim, pc, time), mix);
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
  let world = computeWorld(bones, pose);
  const target = world.get(ik.target);
  const wp = world.get(pId);
  if (!target || !wp) return;
  const t: Vec = { x: target.tx, y: target.ty };
  const p: Vec = { x: wp.tx, y: wp.ty };
  const base1 = pose.get(pId)!.rotation;
  const parent1 = parentWorldOf(bones, world, pId);

  const cBone = cId ? bones.find((b) => b.id === cId) : undefined;
  const wc = cId ? world.get(cId) : undefined;
  if (!cBone || !wc) {
    // One bone: aim +x at the target.
    const dir = { x: t.x - p.x, y: t.y - p.y };
    if (Math.hypot(dir.x, dir.y) < EPS) return;
    const solved = nearTurn(base1, localRotationFor(parent1, dir, pose.get(pId)!));
    setRotation(pose, pId, base1 + mix * (solved - base1));
    return;
  }
  const base2 = pose.get(cId)!.rotation;
  const c: Vec = { x: wc.tx, y: wc.ty };
  const tip = apply(wc, { x: cBone.length, y: 0 });
  const l1 = Math.hypot(c.x - p.x, c.y - p.y);
  const l2 = Math.hypot(tip.x - c.x, tip.y - c.y);
  const d = Math.hypot(t.x - p.x, t.y - p.y);
  if (d < 1e-6) return; // degenerate: target on the chain root — leave the pose as keyed
  let solved1 = base1;
  if (l1 > EPS) {
    const cosA = l2 > EPS ? Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))) : 1;
    const mirrored = determinant(parent1) < 0;
    const side = ik.bendPositive !== mirrored ? 1 : -1;
    const want = angle({ x: t.x - p.x, y: t.y - p.y }) + side * (Math.acos(cosA) / DEG);
    const delta = wrap(want - angle({ x: c.x - p.x, y: c.y - p.y }));
    const xDir = rotate(applyLinear(wp, { x: 1, y: 0 }), delta);
    solved1 = nearTurn(base1, localRotationFor(parent1, xDir, pose.get(pId)!));
    setRotation(pose, pId, solved1);
    world = computeWorld(bones, pose);
  }
  const wc2 = world.get(cId)!;
  const c2: Vec = { x: wc2.tx, y: wc2.ty };
  const aim = { x: t.x - c2.x, y: t.y - c2.y };
  let solved2 = base2;
  if (Math.hypot(aim.x, aim.y) > EPS && l2 > EPS) {
    solved2 = nearTurn(base2, localRotationFor(world.get(pId)!, aim, pose.get(cId)!));
  }
  setRotation(pose, pId, base1 + mix * (solved1 - base1));
  setRotation(pose, cId, base2 + mix * (solved2 - base2));
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
