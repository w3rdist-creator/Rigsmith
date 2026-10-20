// Weight authoring beyond distance (R1): banded limb weights, left/right mirroring and
// Laplacian smoothing. Pure; the editor and the CLI wrap each call in one mutation.
//
// Banded limb weights make one continuous limb image (arm, leg, tail segment) bend as a
// round tube instead of two rigid capsules. Along the limb axis, s = distance from the
// upper bone's origin; the upper bone hands over to the lower bone over a smoothstep of
// ±B around the joint (s = upper length), and an optional helper bone (typically keyed or
// constrained to half the joint angle) takes the middle, 4t(1−t), so the joint keeps its
// volume. The band is asymmetric across the limb: `inner` on the side the joint usually
// folds toward (tight, so the walls meet in a short crease), `outer` on the other (wide,
// so the outside stays round). Optional end/root blends hand the tip to the next bone
// (wrist turns with the hand) and the top to the body bone (the shoulder stretches like
// skin instead of pivoting on a pin).
import { angleOf, apply, DEG } from './math.ts';
import { bindWorld } from './mesh.ts';
import { normalizeWeights, setupVertices } from './meshOps.ts';
import { computeWorld } from './skeleton.ts';
import type { Attachment, Project, VertexWeights } from './types.ts';

export interface LimbBand {
  /** Half-width (px along the axis) of the hand-over on the inside of the bend. */
  inner: number;
  /** Half-width on the outside of the bend. */
  outer: number;
  /** +1: the joint folds toward the bone's local +y; −1: toward −y. */
  side: 1 | -1;
}
export interface LimbEnd {
  /** Bone that takes the tip of the limb (e.g. the hand). */
  bone: string;
  /** Axis distance (px from the upper bone's origin) where the hand-over is centred. */
  at: number;
  /** Half-width of the hand-over. */
  band: number;
  /** Largest share the end bone gets (0..1). */
  max: number;
}
export interface LimbRoot {
  /** Body bone that keeps the top of the limb (e.g. chest, hips). */
  bone: string;
  /** The root share is 1 at s ≤ from and 0 at s ≥ to (axis px). */
  from: number;
  to: number;
}
export interface LimbSpec {
  upper: string;
  lower: string;
  helper?: string;
  band: LimbBand;
  end?: LimbEnd;
  root?: LimbRoot;
}

export const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function bone(project: Project, id: string) {
  const b = project.bones.find((x) => x.id === id);
  if (!b) throw new Error(`Unknown bone ${id}.`);
  return b;
}

/** Banded weights for every vertex of a mesh attachment (setup pose). */
export function limbWeights(project: Project, att: Attachment, spec: LimbSpec): VertexWeights[] {
  if (!att.mesh) throw new Error(`${att.name} has no mesh.`);
  if (!(spec.band.inner > 0 && spec.band.outer > 0)) throw new Error('Band half-widths must be positive.');
  if (spec.end && !(spec.end.band > 0 && spec.end.max >= 0 && spec.end.max <= 1)) throw new Error('End blend needs band > 0 and 0 ≤ max ≤ 1.');
  if (spec.root && !(spec.root.to > spec.root.from)) throw new Error('Root blend needs from < to.');
  const up = bone(project, spec.upper), low = bone(project, spec.lower);
  const helper = spec.helper ? bone(project, spec.helper) : null;
  const end = spec.end ? bone(project, spec.end.bone) : null;
  const root = spec.root ? bone(project, spec.root.bone) : null;
  const m = bindWorld(att, computeWorld(project.bones)).get(up.id)!;
  const R = apply(m, { x: 0, y: 0 });
  const a = angleOf(m) * DEG;
  const dir = { x: Math.cos(a), y: Math.sin(a) };
  const im = project.images.find((i) => i.id === att.imageId)!;
  const half = im.width / 2;
  return setupVertices(project, att).map((v) => {
    const s = (v.x - R.x) * dir.x + (v.y - R.y) * dir.y;
    const q = dir.x * (v.y - R.y) - dir.y * (v.x - R.x);
    const B = spec.band.outer + (spec.band.inner - spec.band.outer) * smoothstep(-half, half, spec.band.side * q);
    const t = smoothstep(up.length - B, up.length + B, s);
    const h = helper ? 4 * t * (1 - t) : 0;
    let list: VertexWeights = [{ bone: up.id, w: (1 - t) * (1 - h) }, ...(helper ? [{ bone: helper.id, w: h }] : []), { bone: low.id, w: t * (1 - h) }];
    if (end && spec.end) {
      const e = spec.end.max * smoothstep(spec.end.at - spec.end.band, spec.end.at + spec.end.band, s);
      list = [...list.map((x) => ({ ...x, w: x.w * (1 - e) })), { bone: end.id, w: e }];
    }
    if (root && spec.root) {
      const r = 1 - smoothstep(spec.root.from, spec.root.to, s);
      if (r > 0) list = [...list.map((x) => ({ ...x, w: x.w * (1 - r) })), { bone: root.id, w: r }];
    }
    return normalizeWeights(list) ?? [{ bone: up.id, w: 1 }];
  });
}

/**
 * Copies weights from a mirrored attachment with the same mesh topology (vertex i ↔ i),
 * renaming bones through `boneMap` (bone id → bone id). Bones without a mapping keep
 * their id (e.g. a shared chest).
 */
export function mirrorWeights(source: Attachment, target: Attachment, boneMap: ReadonlyMap<string, string>): VertexWeights[] {
  const sw = source.mesh?.weights;
  if (!sw) throw new Error(`${source.name} has no weights to mirror.`);
  if (!target.mesh) throw new Error(`${target.name} has no mesh.`);
  if (target.mesh.points.length !== source.mesh!.points.length) throw new Error(`${source.name} and ${target.name} have different vertex counts (${source.mesh!.points.length / 2} vs ${target.mesh.points.length / 2}).`);
  return sw.map((l) => normalizeWeights(l.map((x) => ({ bone: boneMap.get(x.bone) ?? x.bone, w: x.w })))!);
}

/** Bone-name map for mirroring: every bone whose name contains `from` maps to the same name with `to`, when that bone exists. */
export function suffixBoneMap(project: Project, from: string, to: string): Map<string, string> {
  const byName = new Map(project.bones.map((b) => [b.name, b.id]));
  const out = new Map<string, string>();
  for (const b of project.bones) {
    if (!b.name.includes(from)) continue;
    const other = byName.get(b.name.split(from).join(to));
    if (other) out.set(b.id, other);
  }
  return out;
}

/**
 * Laplacian smoothing over the triangle graph: each pass blends every vertex's weights
 * `amount` of the way toward its neighbours' average, then keeps the `maxInfluences`
 * strongest and renormalizes.
 */
export function smoothWeights(att: Attachment, passes: number, amount = 0.5, maxInfluences = 4): VertexWeights[] {
  const mesh = att.mesh;
  if (!mesh?.weights) throw new Error(`${att.name} has no weights to smooth.`);
  if (!(Number.isInteger(passes) && passes >= 0)) throw new Error('Smoothing passes must be a whole number ≥ 0.');
  if (!(amount > 0 && amount <= 1)) throw new Error('Smoothing amount must be in (0, 1].');
  const n = mesh.points.length / 2;
  const nb = Array.from({ length: n }, () => new Set<number>());
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const [i, j, k] = [mesh.triangles[t], mesh.triangles[t + 1], mesh.triangles[t + 2]];
    nb[i].add(j).add(k); nb[j].add(i).add(k); nb[k].add(i).add(j);
  }
  let cur = mesh.weights.map((l) => new Map(l.map((x) => [x.bone, x.w])));
  for (let pass = 0; pass < passes; pass++) {
    cur = cur.map((own, i) => {
      const avg = new Map<string, number>();
      for (const j of nb[i]) for (const [b, w] of cur[j]) avg.set(b, (avg.get(b) ?? 0) + w / nb[i].size);
      const next = new Map<string, number>();
      for (const b of new Set([...own.keys(), ...avg.keys()])) next.set(b, (1 - amount) * (own.get(b) ?? 0) + amount * (avg.get(b) ?? 0));
      return next;
    });
  }
  return cur.map((m) => {
    const top = [...m].sort((a, b) => b[1] - a[1]).slice(0, maxInfluences).map(([bone, w]) => ({ bone, w }));
    return normalizeWeights(top)!;
  });
}
