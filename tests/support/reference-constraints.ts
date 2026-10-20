// Independent reference for constraints and mixing (post-review FR-003). Like
// reference-composite.ts it imports nothing from src/: the rules are restated from
// docs/architecture.md ("Evaluation order", "Two-bone IK", "Path constraints", "Mixing")
// and solved by different methods where the docs leave the method open:
//
// - Two-bone IK: closed-form circle intersection in the chain parent's local space
//   (src samples and bisects the elbow-length function). Covered: bone 1 with uniform
//   own scale (|scaleX| = |scaleY|), any parent matrix the TRS chain produces; other
//   chains throw instead of guessing. Unreachable targets straighten toward the target
//   or fold; a target on the shoulder keeps the keyed pose. Inferred from the docs'
//   "clockwise side … in parent space" with y pointing down: bendPositive means
//   cross(shoulder→target, shoulder→elbow) > 0. Solutions are wrapped to the turn of the
//   keyed rotation and mixed from keyed (0) to solved (1).
// - Paths: the documented approximation, an arc-length table of 32 chords per cubic
//   segment, with the curve parameter interpolated linearly between table samples;
//   tangent from the analytic derivative. `exactArcGap` reports how far that table is
//   from the true arc length (a diagnostic, not part of the rule).
// - Transform constraints (v3), after paths in array order: the bend is the signed angle
//   between the source's and its parent's world x axes, from atan2(cross, dot) (src
//   subtracts wrapped angles); the mitre factor uses sec(θ/2) = √(2 / (1 + cos θ)); aim
//   reuses the IK aim rule. Solutions are wrapped to the keyed turn and mixed like IK.
// - Mixing: P_k = P_{k−1} + w_k (v_k − P_{k−1}) per channel, rotation the shortest way,
//   exact incoming value at w = 1; missing channels per `missing`; constraint mix and
//   path position blended along the chain the same way (clamped mix per entry); then
//   constraints solved on the blended local pose; visibility, image and draw order from
//   the newest entry with w ≥ 0.5; opacity and deform blended along the chain.
import type { M } from './reference-composite.ts';
import { childWorld, sampleTrack, worldsFromLocal } from './reference-composite.ts';

export interface Local { x: number; y: number; rotation: number; scaleX: number; scaleY: number }

const RAD = Math.PI / 180;
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const deg = (x: number, y: number) => Math.atan2(y, x) / RAD;

function invert(m: M): M {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
const xform = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const linear = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];

/** Keyed local pose of every bone at local time t (anim null = setup). */
export function keyedLocal(project: any, anim: any | null, t: number): Map<string, Local> {
  const out = new Map<string, Local>();
  for (const b of project.bones) {
    const tr = anim?.tracks?.[b.id];
    const [x, y] = sampleTrack(tr?.translate, t, [b.x, b.y]);
    const [rotation] = sampleTrack(tr?.rotate, t, [b.rotation]);
    const [scaleX, scaleY] = sampleTrack(tr?.scale, t, [b.scaleX, b.scaleY]);
    out.set(b.id, { x, y, rotation, scaleX, scaleY });
  }
  return out;
}

/** Keyed constraint value (mix clamped to 0..1), or the constraint's own value. */
export function constraintValue(anim: any | null, id: string, channel: 'mix' | 'position' | 'angle', t: number, base: number): number {
  const keys = anim?.constraints?.[id]?.[channel];
  const v = keys?.length ? sampleTrack(keys, t, [base])[0] : base;
  return channel === 'mix' ? Math.min(1, Math.max(0, v)) : v;
}

const parentWorld = (project: any, worlds: Map<string, M>, id: string): M => {
  const pid = project.bones.find((b: any) => b.id === id)?.parentId;
  return (pid && worlds.get(pid)) || [1, 0, 0, 1, 0, 0];
};

/** The linear frame a bone's rotation lives in: its parent's axes as the bone inherits them (inherit flags). */
const frameOf = (project: any, worlds: Map<string, M>, id: string): M => {
  const b = project.bones.find((x: any) => x.id === id);
  const m = childWorld(parentWorld(project, worlds, id), b?.inherit, [1, 0, 0, 1, 0, 0]);
  return [m[0], m[1], m[2], m[3], 0, 0];
};
const flagged = (project: any, id: string) => {
  const i = project.bones.find((x: any) => x.id === id)?.inherit;
  return !!i && !(i.rotation && i.scale && i.reflection);
};

/** Local rotation (degrees) that points the bone's +x along world direction (dx, dy). */
function aimRotation(parent: M, dx: number, dy: number, local: Local): number {
  const [lx, ly] = linear(invert(parent), dx, dy);
  return deg(lx, ly) - (local.scaleX < 0 ? 180 : 0);
}

/** Two-bone (or one-bone) IK by circle intersection; mutates `pose`. */
export function solveIkRef(project: any, pose: Map<string, Local>, ik: any, mix: number): void {
  const [p1, p2] = ik.bones;
  const worlds = worldsFromLocal(project, pose);
  const tw = worlds.get(ik.target)!, w1 = worlds.get(p1)!;
  const l1 = pose.get(p1)!;
  const parent = flagged(project, p1) ? frameOf(project, worlds, p1) : parentWorld(project, worlds, p1);
  const keep = (id: string, solved: number) => {
    const l = pose.get(id)!;
    const near = l.rotation + wrap180(solved - l.rotation);
    pose.set(id, { ...l, rotation: l.rotation + mix * (near - l.rotation) });
  };
  if (!p2) {
    if (Math.hypot(tw[4] - w1[4], tw[5] - w1[5]) < 1e-9) return;
    keep(p1, aimRotation(parent, tw[4] - w1[4], tw[5] - w1[5], l1));
    return;
  }
  if (Math.hypot(tw[4] - w1[4], tw[5] - w1[5]) < 1e-6) return; // target on the shoulder: keyed pose
  // Within float noise (Reparent keeps world placement and can leave 1 ± 2e-16).
  if (Math.abs(Math.abs(l1.scaleX) - Math.abs(l1.scaleY)) > 1e-9) throw new Error(`reference IK covers uniform bone-1 scale only (${ik.name})`);
  const l2 = pose.get(p2)!;
  const child = project.bones.find((b: any) => b.id === p2);
  // Parent-local space: shoulder at l1.(x,y), target q relative to it.
  // With inherit flags the shoulder's axes live in its filtered frame: q = frame⁻¹ · (target − shoulder).
  const [qx, qy] = flagged(project, p1) ? xform(invert(parent), tw[4] - w1[4], tw[5] - w1[5]) : ((t) => [t[0] - l1.x, t[1] - l1.y])(xform(invert(parent), tw[4], tw[5]));
  const D = Math.hypot(qx, qy);
  const s = l1.scaleX; // uniform: S1 = s·I (s < 0 = a half turn)
  const k = l2.scaleX * child.length;
  // Elbow (child origin) at distance a from the shoulder, tip at distance b from the elbow.
  const a = Math.abs(s) * Math.hypot(l2.x, l2.y), b = Math.abs(s * k);
  const ux = qx / D, uy = qy / D;
  let ex: number, ey: number; // elbow, relative to the shoulder
  if (D >= a + b) [ex, ey] = [a * ux, a * uy]; // straighten toward the target
  else if (D <= Math.abs(a - b)) [ex, ey] = a >= b ? [a * ux, a * uy] : [-a * ux, -a * uy]; // fold
  else {
    // Circle(shoulder, a) ∩ circle(target, b): foot along q, offset h perpendicular.
    const along = (a * a - b * b + D * D) / (2 * D), h = Math.sqrt(Math.max(0, a * a - along * along));
    // Perpendicular (−uy, ux) has cross(q, ·) = D > 0: the clockwise side on screen (y down).
    const side = ik.bendPositive ? 1 : -1;
    [ex, ey] = [along * ux - side * h * uy, along * uy + side * h * ux];
  }
  // Bone 1 turns its elbow arm s·(l2.x, l2.y) onto the elbow; bone 2 turns s·k·(1,0) onto tip − elbow.
  const r1 = deg(ex, ey) - deg(s * l2.x, s * l2.y);
  const r2 = deg(qx - ex, qy - ey) - r1 - (s * k < 0 ? 180 : 0);
  keep(p1, r1);
  keep(p2, r2);
}

type Pt = [number, number];
type Seg = [Pt, Pt, Pt, Pt];

const bez = (s: Seg, t: number): Pt => {
  const u = 1 - t;
  const c = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [c[0] * s[0][0] + c[1] * s[1][0] + c[2] * s[2][0] + c[3] * s[3][0], c[0] * s[0][1] + c[1] * s[1][1] + c[2] * s[2][1] + c[3] * s[3][1]];
};
const bezTangent = (s: Seg, t: number): Pt => {
  const u = 1 - t;
  const c = [3 * u * u, 6 * u * t, 3 * t * t];
  return [0, 1].map((i) => c[0] * (s[1][i] - s[0][i]) + c[1] * (s[2][i] - s[1][i]) + c[2] * (s[3][i] - s[2][i])) as Pt;
};

/** World-space cubic segments of a path (handles relative to their node). */
export function pathSegs(path: any, m: M): Seg[] {
  const n = path.nodes, segs: Seg[] = [];
  for (let i = 0; i < (path.closed ? n.length : n.length - 1); i++) {
    const p = n[i], q = n[(i + 1) % n.length];
    segs.push([xform(m, p.x, p.y), xform(m, p.x + p.outX, p.y + p.outY), xform(m, q.x + q.inX, q.y + q.inY), xform(m, q.x, q.y)]);
  }
  return segs;
}

const CHORDS = 32;

/** Arc-length table: rows [cumulative length, segment, t]. */
export function arcTable(segs: Seg[]): { rows: [number, number, number][]; length: number } {
  const rows: [number, number, number][] = [[0, 0, 0]];
  let L = 0;
  segs.forEach((s, si) => {
    for (let j = 1; j <= CHORDS; j++) {
      const a = bez(s, (j - 1) / CHORDS), b = bez(s, j / CHORDS);
      L += Math.hypot(b[0] - a[0], b[1] - a[1]);
      rows.push([L, si, j / CHORDS]);
    }
  });
  return { rows, length: L };
}

/** Point and tangent (degrees) at table arc length `at` (open paths clamp, closed wrap). */
export function pathAt(segs: Seg[], table: ReturnType<typeof arcTable>, closed: boolean, at: number): { x: number; y: number; tangent: number } {
  const L = table.length;
  const d = closed ? ((at % L) + L) % L : Math.min(L, Math.max(0, at));
  // Linear scan for the chord holding d (the rows are few).
  let j = 1;
  while (j < table.rows.length - 1 && table.rows[j][0] < d) j++;
  const [l0] = table.rows[j - 1], [l1, si, t1] = table.rows[j];
  const t0 = t1 - 1 / CHORDS;
  const t = l1 > l0 ? t0 + ((d - l0) / (l1 - l0)) * (t1 - t0) : t0;
  const s = segs[si];
  let [dx, dy] = bezTangent(s, t);
  if (Math.hypot(dx, dy) < 1e-9) [dx, dy] = [s[3][0] - s[0][0], s[3][1] - s[0][1]];
  const [x, y] = bez(s, t);
  return { x, y, tangent: deg(dx, dy) };
}

/** Diagnostic: |table length − exact arc length| (exact by 4096-chord refinement per segment). */
export function exactArcGap(segs: Seg[]): number {
  let exact = 0;
  for (const s of segs) for (let j = 1; j <= 4096; j++) {
    const a = bez(s, (j - 1) / 4096), b = bez(s, j / 4096);
    exact += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return Math.abs(exact - arcTable(segs).length);
}

/** Path constraint: bones placed at position·L + i·spacing; mutates `pose`. */
export function solvePathRef(project: any, pose: Map<string, Local>, pc: any, position: number, mix: number): void {
  const path = project.paths.find((p: any) => p.id === pc.pathId);
  let worlds = worldsFromLocal(project, pose);
  const segs = pathSegs(path, (path.boneId && worlds.get(path.boneId)) || [1, 0, 0, 1, 0, 0]);
  const table = arcTable(segs);
  pc.bones.forEach((id: string, i: number) => {
    const cur = pose.get(id)!;
    const at = pathAt(segs, table, path.closed, position * table.length + i * pc.spacing);
    const parent = parentWorld(project, worlds, id);
    const [lx, ly] = xform(invert(parent), at.x, at.y);
    const next = { ...cur, x: cur.x + mix * (lx - cur.x), y: cur.y + mix * (ly - cur.y) };
    if (pc.rotate) {
      const a = (at.tangent + pc.rotateOffset) * RAD;
      const solved = aimRotation(frameOf(project, worlds, id), Math.cos(a), Math.sin(a), cur);
      next.rotation = cur.rotation + mix * wrap180(solved - cur.rotation);
    }
    pose.set(id, next);
    worlds = worldsFromLocal(project, pose);
  });
}

type ValueOf = (id: string, channel: 'mix' | 'position' | 'angle', base: number) => number;

/** Rotation-fraction / aim constraint; mutates `pose`. */
export function solveTransformRef(project: any, pose: Map<string, Local>, tc: any, angle: number, mix: number): void {
  const cur = pose.get(tc.bone);
  if (!cur) return;
  const worlds = worldsFromLocal(project, pose);
  let solved: number;
  let scaleY: number | null = null;
  if (tc.kind === 'rotation') {
    const s = worlds.get(tc.source);
    if (!s) return;
    const q = parentWorld(project, worlds, tc.source);
    const cross = q[0] * s[1] - q[1] * s[0], dot = q[0] * s[0] + q[1] * s[1];
    const bend = Math.atan2(cross, dot) / RAD;
    solved = angle + tc.factor * bend;
    if (tc.mitre) scaleY = Math.min(tc.mitre.max, 1 + (Math.sqrt(2 / (1 + Math.cos(bend * RAD))) - 1) * tc.mitre.k);
  } else {
    const ref = tc.relativeTo ? worlds.get(tc.relativeTo) : null;
    const a = (angle + (ref ? deg(ref[0], ref[1]) : 0)) * RAD;
    solved = aimRotation(frameOf(project, worlds, tc.bone), Math.cos(a), Math.sin(a), cur);
  }
  const next = { ...cur, rotation: cur.rotation + mix * wrap180(solved - cur.rotation) };
  if (scaleY !== null) next.scaleY = cur.scaleY + mix * (scaleY - cur.scaleY);
  pose.set(tc.bone, next);
}

/** IK, then paths, then transform constraints (each in array order) on `pose`; constraint values from (anim, t) or `valueOf`. */
export function applyConstraintsRef(project: any, pose: Map<string, Local>, anim: any | null, t: number, valueOf?: ValueOf): void {
  const get: ValueOf = valueOf ? (id, ch, base) => (ch === 'mix' ? Math.min(1, Math.max(0, valueOf(id, ch, base))) : valueOf(id, ch, base)) : (id, ch, base) => constraintValue(anim, id, ch, t, base);
  for (const ik of project.ik ?? []) {
    const mix = get(ik.id, 'mix', ik.mix);
    if (mix > 0) solveIkRef(project, pose, ik, mix);
  }
  for (const pc of project.pathConstraints ?? []) {
    const mix = get(pc.id, 'mix', pc.mix);
    if (mix > 0 && project.paths?.some((p: any) => p.id === pc.pathId)) solvePathRef(project, pose, pc, get(pc.id, 'position', pc.position), mix);
  }
  for (const tc of project.transformConstraints ?? []) {
    const mix = get(tc.id, 'mix', tc.mix);
    if (mix > 0) solveTransformRef(project, pose, tc, get(tc.id, 'angle', tc.angle), mix);
  }
}

/** World matrices of one animation at local time t, constraints solved here. */
export function constrainedWorlds(project: any, anim: any | null, t: number): Map<string, M> {
  const pose = keyedLocal(project, anim, t);
  applyConstraintsRef(project, pose, anim, t);
  return worldsFromLocal(project, pose);
}

// ---- Mixing --------------------------------------------------------------------------

export interface PlanEntry { anim: any; start: number; mix: number }

/** Local time of an entry's animation at clock T: loops wrap, one-shots hold their end. */
export function entryClock(e: PlanEntry, T: number): number {
  const d = e.anim.duration, el = Math.max(0, T - e.start);
  if (d <= 0) return 0;
  return e.anim.loop ? ((el % d) + d) % d : Math.min(el, d);
}

export function entryW(e: PlanEntry, k: number, T: number): number {
  if (k === 0) return 1;
  if (T < e.start) return 0;
  return e.mix <= 0 ? 1 : Math.min(1, (T - e.start) / e.mix);
}

export interface MixedFrame {
  worlds: Map<string, M>;
  /** Animation and local time that supply visibility, image, draw order and constraint keys. */
  discrete: { anim: any; t: number };
  opacity: Map<string, number>;
  deform: Map<string, number[]>;
}

/** One frame of a mix plan at clock T (missing channels: 'setup' or 'hold'). */
export function mixFrame(project: any, plan: PlanEntry[], T: number, missing: 'setup' | 'hold'): MixedFrame {
  const pose = keyedLocal(project, null, 0);
  let dk = 0;
  plan.forEach((e, k) => {
    const w = entryW(e, k, T);
    if (k > 0 && w >= 0.5) dk = k;
    if (w <= 0) return;
    const t = entryClock(e, T);
    for (const b of project.bones) {
      const tr = e.anim.tracks?.[b.id];
      const cur = pose.get(b.id)!;
      const pick = (ch: string, setup: number[]) => (tr?.[ch]?.length ? sampleTrack(tr[ch], t, setup) : missing === 'setup' ? setup : null);
      const blend = (from: number, to: number) => (w >= 1 ? to : from + w * (to - from));
      const tv = pick('translate', [b.x, b.y]);
      if (tv) [cur.x, cur.y] = [blend(cur.x, tv[0]), blend(cur.y, tv[1])];
      const rv = pick('rotate', [b.rotation]);
      if (rv) cur.rotation = w >= 1 ? rv[0] : cur.rotation + w * wrap180(rv[0] - cur.rotation);
      const sv = pick('scale', [b.scaleX, b.scaleY]);
      if (sv) [cur.scaleX, cur.scaleY] = [blend(cur.scaleX, sv[0]), blend(cur.scaleY, sv[1])];
    }
  });
  const discrete = { anim: plan[dk].anim, t: entryClock(plan[dk], T) };
  const blended: ValueOf = (id, ch, base) => {
    let v = base;
    plan.forEach((e, k) => {
      const w = entryW(e, k, T);
      if (w <= 0) return;
      const keys = e.anim.constraints?.[id]?.[ch];
      // constraintValue clamps a sampled mix to 0..1, so each entry's mix is clamped.
      const x = keys?.length ? constraintValue(e.anim, id, ch, entryClock(e, T), base) : missing === 'setup' ? base : null;
      if (x !== null) v = w >= 1 ? x : v + w * (x - v);
    });
    return v;
  };
  applyConstraintsRef(project, pose, discrete.anim, discrete.t, blended);
  const opacity = new Map<string, number>(), deform = new Map<string, number[]>();
  for (const a of project.attachments) {
    let o = a.opacity;
    const n = a.mesh?.points.length ?? 0;
    let dv: number[] = new Array(n).fill(0);
    plan.forEach((e, k) => {
      const w = entryW(e, k, T);
      if (w <= 0) return;
      const t = entryClock(e, T), st = e.anim.slots?.[a.id];
      const ok = st?.opacity?.length ? sampleTrack(st.opacity, t, [a.opacity])[0] : missing === 'setup' ? a.opacity : null;
      if (ok !== null) o += w * (ok - o);
      if (n) {
        const d = st?.deform?.length ? sampleTrack(st.deform, t, dv) : missing === 'setup' ? new Array(n).fill(0) : null;
        if (d) dv = dv.map((v, i) => v + w * (d[i] - v));
      }
    });
    opacity.set(a.id, Math.min(1, Math.max(0, o)));
    if (n) deform.set(a.id, dv);
  }
  return { worlds: worldsFromLocal(project, pose), discrete, opacity, deform };
}
