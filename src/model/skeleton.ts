import type { Mat, Vec } from './math.ts';
import { apply, applyLinear, decompose, fromTRS, identity, invert, multiply } from './math.ts';
import type { Attachment, Bone, BoneInherit, LocalPose, Project } from './types.ts';

export function boneById(bones: readonly Bone[], id: string | null | undefined): Bone | undefined {
  if (!id) return undefined;
  return bones.find((b) => b.id === id);
}

/** True if `ancestorId` is `boneId` itself or one of its ancestors. */
export function isAncestorOrSelf(bones: readonly Bone[], ancestorId: string, boneId: string): boolean {
  const byId = new Map(bones.map((b) => [b.id, b]));
  let cur: string | null = boneId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === ancestorId) return true;
    if (seen.has(cur)) return false; // pre-existing cycle; stop walking
    seen.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}

/** Would setting `boneId`'s parent to `newParentId` create a cycle? */
export function wouldCreateCycle(bones: readonly Bone[], boneId: string, newParentId: string | null): boolean {
  if (newParentId === null) return false;
  return isAncestorOrSelf(bones, boneId, newParentId);
}

/** Finds bone ids that participate in (or hang below) a parent cycle. */
export function findCycles(bones: readonly Bone[]): string[] {
  const byId = new Map(bones.map((b) => [b.id, b]));
  const bad: string[] = [];
  for (const b of bones) {
    const seen = new Set<string>();
    let cur: string | null = b.id;
    while (cur) {
      if (seen.has(cur)) {
        bad.push(b.id);
        break;
      }
      seen.add(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
  }
  return bad;
}

/** Parents-before-children order. Bones caught in a cycle are omitted. */
export function topoOrder(bones: readonly Bone[]): Bone[] {
  const children = new Map<string | null, Bone[]>();
  const ids = new Set(bones.map((b) => b.id));
  for (const b of bones) {
    const p = b.parentId && ids.has(b.parentId) ? b.parentId : null;
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(b);
  }
  const out: Bone[] = [];
  const visit = (parent: string | null) => {
    for (const c of children.get(parent) ?? []) {
      out.push(c);
      visit(c.id);
    }
  };
  visit(null);
  return out;
}

export function depthOf(bones: readonly Bone[], id: string): number {
  const byId = new Map(bones.map((b) => [b.id, b]));
  let d = 0;
  let cur = byId.get(id)?.parentId ?? null;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    d++;
    cur = byId.get(cur)?.parentId ?? null;
  }
  return d;
}

export function localMatrix(p: LocalPose): Mat {
  return fromTRS(p.x, p.y, p.rotation, p.scaleX, p.scaleY);
}

/** True when the bone drops some part of its parent's transform (v3 inherit flags). */
export function hasInheritFlags(b: Pick<Bone, 'inherit'>): boolean {
  const i = b.inherit;
  return !!i && (!i.rotation || !i.scale || !i.reflection);
}

const linearOf = (m: Mat): Mat => ({ a: m.a, b: m.b, c: m.c, d: m.d, tx: 0, ty: 0 });

/**
 * Linear part (translation 0) a bone takes from its parent's world matrix M.
 * Without flags: M's linear part. Otherwise M is factored as R(θ) · K · F, where F is a
 * left↔right mirror when det M < 0 (else identity), R(θ) the rotation of M·F's x axis
 * (the world x-axis angle) and K upper triangular with a positive diagonal (scale and
 * shear); a flag set to false drops its factor. Reflection is always a left↔right mirror,
 * so a rig mirrored with scaleX −1 stays the exact mirror image with any flags.
 */
export function inheritedLinear(parent: Mat, inherit: Bone['inherit']): Mat {
  if (!inherit || (inherit.rotation && inherit.scale && inherit.reflection)) return linearOf(parent);
  const flip = parent.a * parent.d - parent.b * parent.c < 0;
  const na = flip ? -parent.a : parent.a, nb = flip ? -parent.b : parent.b;
  const sx = Math.hypot(na, nb);
  let cos = 1, sin = 0;
  let k: Mat = { a: na, b: nb, c: parent.c, d: parent.d, tx: 0, ty: 0 };
  if (sx > 1e-12) {
    cos = na / sx;
    sin = nb / sx;
    k = { a: sx, b: 0, c: cos * parent.c + sin * parent.d, d: (na * parent.d - nb * parent.c) / sx, tx: 0, ty: 0 };
  }
  let m = identity();
  if (inherit.rotation) m = { a: cos, b: sin, c: -sin, d: cos, tx: 0, ty: 0 };
  if (inherit.scale) m = multiply(m, k);
  if (flip && inherit.reflection) m = multiply(m, { a: -1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });
  return m;
}

/**
 * World matrix of a bone under `parent`: its origin is always placed by the full parent
 * matrix; its axes take the parent's linear part filtered by the inherit flags.
 */
export function composeChild(parent: Mat, bone: Pick<Bone, 'inherit'>, local: Mat): Mat {
  if (!hasInheritFlags(bone)) return multiply(parent, local);
  const o = apply(parent, { x: local.tx, y: local.ty });
  const lin = multiply(inheritedLinear(parent, bone.inherit), linearOf(local));
  return { ...lin, tx: o.x, ty: o.y };
}

/**
 * World matrix per bone: world(bone) = world(parent) · local(bone) (composeChild with
 * inherit flags). `pose` overrides setup values (used for animation); missing entries use setup.
 */
export function computeWorld(bones: readonly Bone[], pose?: ReadonlyMap<string, LocalPose>): Map<string, Mat> {
  const world = new Map<string, Mat>();
  for (const b of topoOrder(bones)) {
    const local = localMatrix(pose?.get(b.id) ?? b);
    const parent = b.parentId ? world.get(b.parentId) : undefined;
    world.set(b.id, parent ? composeChild(parent, b, local) : local);
  }
  return world;
}

export function parentWorld(bones: readonly Bone[], world: ReadonlyMap<string, Mat>, boneId: string): Mat {
  const b = boneById(bones, boneId);
  return (b?.parentId && world.get(b.parentId)) || identity();
}

/**
 * The linear frame a bone's local rotation and scale live in (its parent's linear part
 * filtered by the bone's inherit flags). Use it for angles; use parentWorld for positions.
 */
export function parentLinear(bones: readonly Bone[], world: ReadonlyMap<string, Mat>, boneId: string): Mat {
  const b = boneById(bones, boneId);
  const parent = (b?.parentId && world.get(b.parentId)) || identity();
  return b && hasInheritFlags(b) ? inheritedLinear(parent, b.inherit) : linearOf(parent);
}

export function attachmentWorld(att: Attachment, world: ReadonlyMap<string, Mat>): Mat {
  const base = (att.boneId && world.get(att.boneId)) || identity();
  return multiply(base, fromTRS(att.x, att.y, att.rotation, att.scaleX, att.scaleY));
}

export function boneTip(bone: Bone, world: Mat): Vec {
  return apply(world, { x: bone.length, y: 0 });
}

export function boneOrigin(world: Mat): Vec {
  return { x: world.tx, y: world.ty };
}

/** Converts a world-space point into the given parent space. */
export function toLocal(parent: Mat, worldPoint: Vec): Vec {
  return apply(invert(parent), worldPoint);
}

/** Local TRS that reproduces `targetWorld` under `parent`. */
export function localFromWorld(parent: Mat, targetWorld: Mat): LocalPose {
  const t = decompose(multiply(invert(parent), targetWorld));
  return { x: t.x, y: t.y, rotation: t.rotation, scaleX: t.scaleX, scaleY: t.scaleY };
}

/** localFromWorld for a bone with inherit flags: position under the full parent, axes under its filtered linear part. */
export function boneLocalFromWorld(bone: Pick<Bone, 'inherit'>, parent: Mat, targetWorld: Mat): LocalPose {
  if (!hasInheritFlags(bone)) return localFromWorld(parent, targetWorld);
  const o = apply(invert(parent), { x: targetWorld.tx, y: targetWorld.ty });
  const t = decompose(multiply(invert(inheritedLinear(parent, bone.inherit)), linearOf(targetWorld)));
  return { x: o.x, y: o.y, rotation: t.rotation, scaleX: t.scaleX, scaleY: t.scaleY };
}

export function childrenOf(bones: readonly Bone[], id: string | null): Bone[] {
  return bones.filter((b) => b.parentId === id);
}

export function descendantIds(bones: readonly Bone[], id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of bones) {
      if (c.parentId === cur && !out.has(c.id)) {
        out.add(c.id);
        stack.push(c.id);
      }
    }
  }
  return out;
}

export class CycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CycleError';
  }
}

/**
 * Sets which parts of its parent's transform a bone inherits (v3). The bone keeps its
 * setup-pose world placement (its local transform is recomputed); its keys are unchanged.
 * Refused for the second bone of a two-bone IK chain, which must inherit fully.
 */
export function setBoneInherit(project: Project, boneId: string, change: Partial<BoneInherit>): void {
  const bone = boneById(project.bones, boneId);
  if (!bone) throw new Error(`Unknown bone ${boneId}`);
  const next: BoneInherit = { rotation: true, scale: true, reflection: true, ...bone.inherit, ...change };
  const flagged = !next.rotation || !next.scale || !next.reflection;
  if (flagged && project.ik?.some((k) => k.bones.length === 2 && k.bones[1] === boneId)) {
    throw new Error(`“${bone.name}” is the second bone of an IK chain, which must inherit its parent's full transform.`);
  }
  const world = computeWorld(project.bones);
  const parent = bone.parentId ? world.get(bone.parentId) : undefined;
  if (flagged) bone.inherit = next;
  else delete bone.inherit;
  if (parent) Object.assign(bone, boneLocalFromWorld(bone, parent, world.get(boneId)!));
}

/**
 * Reparents a bone in the setup pose. With keepWorld the bone stays visually where it
 * is (its local transform is recomputed under the new parent). Throws CycleError if
 * the change would make the bone its own ancestor.
 */
export function reparentBone(project: Project, boneId: string, newParentId: string | null, keepWorld = true): void {
  const bone = boneById(project.bones, boneId);
  if (!bone) throw new Error(`Unknown bone ${boneId}`);
  if (newParentId !== null && !boneById(project.bones, newParentId)) throw new Error(`Unknown parent ${newParentId}`);
  if (wouldCreateCycle(project.bones, boneId, newParentId)) {
    throw new CycleError(`Cannot parent "${bone.name}" under itself or one of its descendants.`);
  }
  if (keepWorld) {
    const world = computeWorld(project.bones);
    const boneWorld = world.get(boneId) ?? identity();
    const newParent = (newParentId && world.get(newParentId)) || identity();
    Object.assign(bone, newParentId === null ? localFromWorld(identity(), boneWorld) : boneLocalFromWorld(bone, newParent, boneWorld));
  }
  bone.parentId = newParentId;
}

/**
 * Deletes a bone. Its children and attachments move to the deleted bone's parent,
 * keeping their setup-pose world placement. Its animation tracks are removed.
 */
export function deleteBone(project: Project, boneId: string): void {
  const bone = boneById(project.bones, boneId);
  if (!bone) return;
  const world = computeWorld(project.bones);
  const newParentId = bone.parentId;
  const newParent = (newParentId && world.get(newParentId)) || identity();
  for (const child of childrenOf(project.bones, boneId)) {
    Object.assign(child, newParentId === null ? localFromWorld(identity(), world.get(child.id) ?? identity()) : boneLocalFromWorld(child, newParent, world.get(child.id) ?? identity()));
    child.parentId = newParentId;
  }
  for (const att of project.attachments) {
    if (att.boneId !== boneId) continue;
    const aw = attachmentWorld(att, world);
    const local = localFromWorld(newParent, aw);
    att.x = local.x;
    att.y = local.y;
    att.rotation = local.rotation;
    att.scaleX = local.scaleX;
    att.scaleY = local.scaleY;
    att.boneId = newParentId;
  }
  // Paths drawn in the bone's space move to the parent's space, keeping their shape.
  const boneWorld = world.get(boneId) ?? identity();
  for (const path of project.paths ?? []) {
    if (path.boneId !== boneId) continue;
    const m = multiply(invert(newParent), boneWorld);
    for (const n of path.nodes) {
      const q = apply(m, n);
      const i = applyLinear(m, { x: n.inX, y: n.inY }), o = applyLinear(m, { x: n.outX, y: n.outY });
      Object.assign(n, { x: q.x, y: q.y, inX: i.x, inY: i.y, outX: o.x, outY: o.y });
    }
    path.boneId = newParentId;
  }
  // Mesh weights on the deleted bone pass to its parent (merged; sums stay 1). With no
  // parent the integrity pass drops them and renormalizes.
  if (newParentId)
    for (const att of project.attachments) {
      if (!att.mesh?.weights) continue;
      att.mesh.weights = att.mesh.weights.map((list) => {
        if (!list.some((x) => x.bone === boneId)) return list;
        const merged = new Map<string, number>();
        for (const x of list) {
          const id = x.bone === boneId ? newParentId : x.bone;
          merged.set(id, (merged.get(id) ?? 0) + x.w);
        }
        return [...merged].map(([bone, w]) => ({ bone, w }));
      });
    }
  project.bones = project.bones.filter((b) => b.id !== boneId);
  for (const anim of project.animations) delete anim.tracks[boneId];
}
