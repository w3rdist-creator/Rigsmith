// Pure rigging operations behind the phase-2 controls: slot (attachment) keys,
// draw-order keys, IK and path constraints, cutout placement and pivot editing.
import { findKeyIndex, insertSorted, sampleKeys, setKey, snapToFrame } from './animation.ts';
import type { Rgba } from './color.ts';
import { clamp01, setupColor } from './color.ts';
import { localRotationFor } from './constraints.ts';
import { angleOf } from './math.ts';
import type { Mat, Vec } from './math.ts';
import { apply, applyLinear, identity, invert, multiply, fromTRS } from './math.ts';
import { drawOrderAt, steppedAt } from './evaluate.ts';
import { attachmentWorld, boneLocalFromWorld, computeWorld, hasInheritFlags, isAncestorOrSelf, localFromWorld, parentLinear } from './skeleton.ts';
import type { Animation, Attachment, Bone, ImageAsset, IkConstraint, PathConstraint, PathShape, Project, TransformConstraint } from './types.ts';
import { makeBone, uniqueName } from './ops.ts';

// ---- Slot keys ------------------------------------------------------------------------

export type ScalarSlotChannel = 'visible' | 'opacity';

function slotTrack(anim: Animation, attId: string) {
  anim.slots ??= {};
  return (anim.slots[attId] ??= {});
}

/** Keys visibility (stepped) or opacity at time t. */
export function keySlotScalar(anim: Animation, attId: string, ch: ScalarSlotChannel, time: number, value: number): void {
  const t = snapToFrame(time, anim.fps);
  const st = slotTrack(anim, attId);
  const keys = (st[ch] ??= []);
  if (ch === 'visible') setKey(keys, t, [value >= 0.5 ? 1 : 0], 'step');
  else setKey(keys, t, [Math.min(1, Math.max(0, value))]);
}

/** Keys the tint [r, g, b, a] (each clamped to 0..1) at time t. */
export function keySlotColor(anim: Animation, attId: string, time: number, value: readonly number[]): void {
  const t = snapToFrame(time, anim.fps);
  setKey((slotTrack(anim, attId).color ??= []), t, value.slice(0, 4).map(clamp01));
}

export function keySlotImage(anim: Animation, attId: string, time: number, imageId: string): void {
  const t = snapToFrame(time, anim.fps);
  const keys = (slotTrack(anim, attId).image ??= []);
  const i = findKeyIndex(keys, t);
  if (i >= 0) keys[i].imageId = imageId;
  else insertSorted(keys, { time: t, imageId });
}

/** Current (sampled) slot values, for keying "the value shown now". */
export function slotValues(att: Attachment, anim: Animation | null, time: number): { visible: boolean; opacity: number; color: Rgba; imageId: string } {
  const st = anim?.slots?.[att.id];
  return {
    visible: (steppedAt(st?.visible, time)?.value[0] ?? (att.hidden ? 0 : 1)) >= 0.5,
    opacity: st?.opacity?.length ? sampleKeys(st.opacity, time, [att.opacity])[0] : att.opacity,
    color: (st?.color?.length ? sampleKeys(st.color, time, setupColor(att)) : setupColor(att)).map(clamp01) as Rgba,
    imageId: steppedAt(st?.image, time)?.imageId ?? att.imageId,
  };
}

/** Writes a draw-order key at t that moves `attId` one step back (−1) or forward (+1). */
export function keyDrawOrderStep(project: Project, anim: Animation, time: number, attId: string, dir: -1 | 1): boolean {
  const t = snapToFrame(time, anim.fps);
  const order = drawOrderAt(project, anim, t).map((a) => a.id);
  const i = order.indexOf(attId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return false;
  [order[i], order[j]] = [order[j], order[i]];
  keyDrawOrder(anim, t, order);
  return true;
}

export function keyDrawOrder(anim: Animation, time: number, order: string[]): void {
  const keys = (anim.drawOrder ??= []);
  const i = findKeyIndex(keys, time);
  if (i >= 0) keys[i].order = order.slice();
  else insertSorted(keys, { time, order: order.slice() });
}

/** Keys a constraint's mix, a path constraint's position or a transform constraint's angle at time t. */
export function keyConstraint(anim: Animation, id: string, ch: 'mix' | 'position' | 'angle', time: number, value: number): void {
  const t = snapToFrame(time, anim.fps);
  anim.constraints ??= {};
  const ct = (anim.constraints[id] ??= {});
  setKey((ct[ch] ??= []), t, [ch === 'mix' ? Math.min(1, Math.max(0, value)) : value]);
}

// ---- IK --------------------------------------------------------------------------------

/** Root-most ancestor of `id` (the bone itself if it is a root). */
function topAncestor(bones: readonly Bone[], id: string): string {
  let cur = bones.find((b) => b.id === id);
  const seen = new Set<string>();
  while (cur?.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next = bones.find((b) => b.id === cur!.parentId);
    if (!next) break;
    cur = next;
  }
  return cur!.id;
}

/**
 * Adds a 1- or 2-bone IK ending at `endBoneId` and a new target bone at its tip. The
 * target hangs under the chain's top-most ancestor (outside the chain), or at the root.
 * The bend side follows the setup elbow unless `bendPositive` is given (a straight chain
 * has no side of its own).
 */
export function addIk(project: Project, endBoneId: string, twoBone: boolean, ids: { ik: string; target: string }, bendPositive?: boolean): IkConstraint | null {
  const end = project.bones.find((b) => b.id === endBoneId);
  if (!end) return null;
  const chain = twoBone ? (end.parentId ? [end.parentId, end.id] : null) : [end.id];
  if (!chain) return null;
  if (twoBone && hasInheritFlags(end)) return null; // bone 2 of a chain must inherit fully
  const world = computeWorld(project.bones);
  const tip = apply(world.get(end.id)!, { x: end.length, y: 0 });
  const top = topAncestor(project.bones, chain[0]);
  const parentId = chain.includes(top) ? null : top;
  const pw = (parentId && world.get(parentId)) || identity();
  const local = apply(invert(pw), tip);
  const name = uniqueName(project.bones.map((b) => b.name), `${end.name}-target`);
  // Exact tip position (no rounding) so adding IK does not move the limb.
  const target = makeBone(ids.target, name, parentId, local.x, local.y, 0, 0);
  target.color = '#ff6b9a';
  project.bones.push(target);
  const ik: IkConstraint = { id: ids.ik, name: uniqueName(constraintNames(project), `${end.name}-ik`), bones: chain, target: target.id, mix: 1, bendPositive: bendPositive ?? bendOf(project, chain) };
  (project.ik ??= []).push(ik);
  return ik;
}

/** Bend direction matching the current setup elbow, so adding IK does not flip it. */
function bendOf(project: Project, chain: string[]): boolean {
  if (chain.length < 2) return true;
  const w = computeWorld(project.bones);
  const p = w.get(chain[0])!, c = w.get(chain[1])!;
  const cb = project.bones.find((b) => b.id === chain[1])!;
  const tip = apply(c, { x: cb.length, y: 0 });
  const cross = (tip.x - p.tx) * (c.ty - p.ty) - (tip.y - p.ty) * (c.tx - p.tx);
  // The frame bone 1's rotation lives in (its parent's linear part, filtered by its inherit flags).
  const pm = parentLinear(project.bones, w, chain[0]);
  const mirrored = pm.a * pm.d - pm.b * pm.c < 0;
  return (cross >= 0) !== mirrored;
}

export function constraintNames(p: Project): string[] {
  return [...(p.ik ?? []), ...(p.pathConstraints ?? []), ...(p.transformConstraints ?? [])].map((k) => k.name);
}

/** Bones that may serve as the target of `ik` (not in or under its chain). */
export function validIkTargets(project: Project, chain: readonly string[]): Bone[] {
  return project.bones.filter((b) => !chain.some((c) => isAncestorOrSelf(project.bones, c, b.id)));
}

export function deleteConstraint(project: Project, id: string): void {
  if (project.ik) project.ik = project.ik.filter((k) => k.id !== id);
  if (project.pathConstraints) project.pathConstraints = project.pathConstraints.filter((k) => k.id !== id);
  if (project.transformConstraints) project.transformConstraints = project.transformConstraints.filter((k) => k.id !== id);
  for (const an of project.animations) if (an.constraints) delete an.constraints[id];
}

// ---- Transform constraints -------------------------------------------------------------

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/**
 * Adds a rotation-fraction constraint: `boneId` takes `factor` of `sourceId`'s bend. The
 * offset angle is chosen so the setup pose does not move (like adding IK).
 */
export function addRotationConstraint(project: Project, id: string, boneId: string, sourceId: string, factor = 0.5): TransformConstraint | null {
  const bone = project.bones.find((b) => b.id === boneId);
  const src = project.bones.find((b) => b.id === sourceId);
  if (!bone || !src || bone.id === src.id) return null;
  const w = computeWorld(project.bones);
  const bend = wrap180(angleOf(w.get(src.id)!) - angleOf((src.parentId && w.get(src.parentId)) || identity()));
  const tc: TransformConstraint = { id, name: uniqueName(constraintNames(project), `${bone.name}-rotation`), kind: 'rotation', bone: bone.id, source: src.id, factor, angle: bone.rotation - factor * bend, mix: 1 };
  (project.transformConstraints ??= []).push(tc);
  return tc;
}

/** Adds an aim constraint holding `boneId` at its current setup world angle (relative to `relativeTo`'s, if given). */
export function addAimConstraint(project: Project, id: string, boneId: string, relativeTo: string | null = null): TransformConstraint | null {
  const bone = project.bones.find((b) => b.id === boneId);
  if (!bone || relativeTo === boneId || (relativeTo && !project.bones.some((b) => b.id === relativeTo))) return null;
  const w = computeWorld(project.bones);
  // A negative own scaleX flips the drawn axis; the constraint holds the unflipped one (see localRotationFor).
  const angle = wrap180(angleOf(w.get(bone.id)!) + (bone.scaleX < 0 ? 180 : 0) - (relativeTo ? angleOf(w.get(relativeTo)!) : 0));
  const tc: TransformConstraint = { id, name: uniqueName(constraintNames(project), `${bone.name}-aim`), kind: 'aim', bone: bone.id, relativeTo, factor: 1, angle, mix: 1 };
  (project.transformConstraints ??= []).push(tc);
  return tc;
}

// ---- Paths -------------------------------------------------------------------------------

/** A three-node S path centred on `center` (world), stored in `boneId`'s space. */
export function addPath(project: Project, id: string, boneId: string | null, center: Vec, size = 120): PathShape {
  const world = computeWorld(project.bones);
  const m = (boneId && world.get(boneId)) || identity();
  const inv = invert(m);
  const h = size / 2;
  const pts = [{ x: center.x - size, y: center.y + h / 2 }, { x: center.x, y: center.y - h / 2 }, { x: center.x + size, y: center.y + h / 2 }];
  const handle = applyLinear(inv, { x: h, y: 0 });
  const nodes = pts.map((wp) => {
    const q = apply(inv, wp);
    return { x: round3(q.x), y: round3(q.y), inX: round3(-handle.x), inY: round3(-handle.y), outX: round3(handle.x), outY: round3(handle.y) };
  });
  const path: PathShape = { id, name: uniqueName((project.paths ?? []).map((p) => p.name), 'path'), boneId, closed: false, nodes };
  (project.paths ??= []).push(path);
  return path;
}

export function addPathNode(path: PathShape): void {
  const n = path.nodes;
  const a = n[n.length - 2], b = n[n.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  n.push({ x: round3(b.x + dx), y: round3(b.y + dy), inX: round3(-dx / 3), inY: round3(-dy / 3), outX: round3(dx / 3), outY: round3(dy / 3) });
}

export function deletePath(project: Project, id: string): void {
  if (project.paths) project.paths = project.paths.filter((p) => p.id !== id);
  for (const pc of (project.pathConstraints ?? []).filter((c) => c.pathId === id)) deleteConstraint(project, pc.id);
}

export function addPathConstraint(project: Project, id: string, pathId: string, bones: string[]): PathConstraint | null {
  const path = project.paths?.find((p) => p.id === pathId);
  if (!path || !bones.length) return null;
  if (path.boneId && bones.some((b) => isAncestorOrSelf(project.bones, b, path.boneId!))) return null;
  const pc: PathConstraint = { id, name: uniqueName(constraintNames(project), `${path.name}-follow`), pathId, bones: bones.slice(), position: 0, spacing: 40, mix: 1, rotate: true, rotateOffset: 0 };
  (project.pathConstraints ??= []).push(pc);
  return pc;
}

// ---- Pivot editing ---------------------------------------------------------------------

/**
 * Moves a bone's origin (setup pose, parent space) without moving its images or child
 * bones on screen: their setup transforms are recomputed under the moved bone. The
 * bone's own translate keys shift by the same amount (exact); children's translate
 * keys get the setup-pose compensation (exact while the bone's rotation/scale is at its
 * setup value).
 */
export function moveBonePivot(project: Project, boneId: string, x: number, y: number): void {
  const bone = project.bones.find((b) => b.id === boneId);
  if (!bone) return;
  const before = computeWorld(project.bones);
  const oldWorld = before.get(boneId)!;
  const dx = x - bone.x, dy = y - bone.y;
  bone.x = x;
  bone.y = y;
  const newWorld = computeWorld(project.bones).get(boneId)!;
  const childShift = new Map<string, Vec>();
  for (const c of project.bones.filter((b) => b.parentId === boneId)) {
    const l = boneLocalFromWorld(c, newWorld, before.get(c.id)!);
    childShift.set(c.id, { x: l.x - c.x, y: l.y - c.y });
    Object.assign(c, { x: round3(l.x), y: round3(l.y), rotation: l.rotation, scaleX: l.scaleX, scaleY: l.scaleY });
  }
  for (const a of project.attachments.filter((q) => q.boneId === boneId)) {
    const l = localFromWorld(newWorld, multiply(oldWorld, fromTRS(a.x, a.y, a.rotation, a.scaleX, a.scaleY)));
    Object.assign(a, { x: round3(l.x), y: round3(l.y), rotation: l.rotation, scaleX: l.scaleX, scaleY: l.scaleY });
  }
  for (const path of project.paths ?? []) {
    if (path.boneId !== boneId) continue;
    const m = multiply(invert(newWorld), oldWorld);
    for (const n of path.nodes) {
      const q = apply(m, n);
      const i = applyLinear(m, { x: n.inX, y: n.inY }), o = applyLinear(m, { x: n.outX, y: n.outY });
      Object.assign(n, { x: q.x, y: q.y, inX: i.x, inY: i.y, outX: o.x, outY: o.y });
    }
  }
  for (const an of project.animations) {
    for (const k of an.tracks[boneId]?.translate ?? []) k.value = [k.value[0] + dx, k.value[1] + dy];
    for (const [cid, s] of childShift) for (const k of an.tracks[cid]?.translate ?? []) k.value = [k.value[0] + s.x, k.value[1] + s.y];
  }
}

// ---- Cutout placement ------------------------------------------------------------------

export interface CutoutPlacement {
  sourceAttId: string;
  piece: ImageAsset;
  /** Replaces the source attachment's image (the original image stays in the project). */
  remainder?: ImageAsset;
  name: string;
  /** Joint position in source image pixels; with `boneParentId` creates a bone there. */
  pivot?: Vec | null;
  createBone: boolean;
  boneParentId: string | null;
  /** Cut outline (source pixels) — the new bone points at its farthest vertex. */
  polygon: number[];
  /** Insert the piece just below the source in draw order (hides a joint extension at rest). */
  behind?: boolean;
  ids: { att: string; bone: string };
}

/**
 * Adds the piece as a new attachment that sits exactly where those pixels were in the
 * source attachment (setup pose), directly above it in draw order; optionally creates a
 * bone at the pivot and binds the piece to it.
 */
export function placeCutout(project: Project, o: CutoutPlacement): { attId: string; boneId: string | null } {
  const src = project.attachments.find((a) => a.id === o.sourceAttId);
  const srcImg = project.images.find((i) => i.id === src?.imageId);
  if (!src || !srcImg) throw new Error('The source attachment no longer exists.');
  const world = computeWorld(project.bones);
  const wa = attachmentWorld(src, world);
  const toWorld = (px: number, py: number) => apply(wa, { x: px - srcImg.width / 2, y: py - srcImg.height / 2 });
  project.images.push(o.piece);
  if (o.remainder) project.images.push(o.remainder);
  let boneId = src.boneId;
  let createdBone: string | null = null;
  if (o.createBone && o.pivot) {
    const pw: Mat = (o.boneParentId && world.get(o.boneParentId)) || identity();
    const pivotW = toWorld(o.pivot.x, o.pivot.y);
    let far = pivotW, best = -1;
    for (let i = 0; i < o.polygon.length; i += 2) {
      const q = toWorld(o.polygon[i], o.polygon[i + 1]);
      const d = Math.hypot(q.x - pivotW.x, q.y - pivotW.y);
      if (d > best) {
        best = d;
        far = q;
      }
    }
    const local = apply(invert(pw), pivotW);
    const dir = { x: far.x - pivotW.x, y: far.y - pivotW.y };
    const scale = Math.max(1e-6, Math.hypot(pw.a, pw.b));
    const b = makeBone(o.ids.bone, uniqueName(project.bones.map((x) => x.name), o.name), o.boneParentId, round3(local.x), round3(local.y), 0, round3(Math.max(10, best / scale)));
    if (best > 1e-6) b.rotation = round3(localRotationFor(pw, dir, b));
    project.bones.push(b);
    boneId = createdBone = b.id;
  }
  const bw = computeWorld(project.bones);
  const base = (boneId && bw.get(boneId)) || identity();
  const d = o.piece.derived!;
  const centre = toWorld(d.offsetX + o.piece.width / 2, d.offsetY + o.piece.height / 2);
  const pieceWorld: Mat = { ...wa, tx: centre.x, ty: centre.y };
  const l = localFromWorld(base, pieceWorld);
  const att: Attachment = { id: o.ids.att, name: uniqueName(project.attachments.map((a) => a.name), o.name), boneId, imageId: o.piece.id, x: round3(l.x), y: round3(l.y), rotation: l.rotation, scaleX: l.scaleX, scaleY: l.scaleY, opacity: src.opacity };
  const idx = project.attachments.indexOf(src);
  project.attachments.splice(o.behind ? idx : idx + 1, 0, att);
  if (o.remainder) src.imageId = o.remainder.id;
  return { attId: att.id, boneId: createdBone };
}

function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}
