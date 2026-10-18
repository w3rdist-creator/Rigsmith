// The single evaluation pipeline shared by the editor viewport, sequence export, the
// runtime player and the CLI:
//   local pose (keys + curves) → constraints (IK, paths) → world matrices →
//   per-attachment draw state (visibility, opacity, image, skin, draw order) →
//   mesh vertices (deform keys + skinning).
import { TIME_EPSILON, samplePose, sampleKeys } from './animation.ts';
import type { Mat, Vec } from './math.ts';
import { apply } from './math.ts';
import { applyConstraints } from './constraints.ts';
import { meshWorldVertices } from './mesh.ts';
import { attachmentWorld, computeWorld } from './skeleton.ts';
import type { Animation, Attachment, ImageAsset, LocalPose, Project } from './types.ts';

export interface EvalOptions {
  /** Active skin id (null/undefined = no skin). */
  skinId?: string | null;
  /** Evaluate IK/path constraints (default true). */
  constraints?: boolean;
  /** Use this local pose instead of sampling `anim` (animation mixing). */
  pose?: Map<string, LocalPose>;
}

export interface AttachmentFrame {
  att: Attachment;
  image: ImageAsset | undefined;
  visible: boolean;
  opacity: number;
  /** World matrix of the image quad (image centred on its origin). */
  world: Mat;
  /** World-space mesh vertex positions [x0,y0,…] (mesh attachments only). */
  vertices?: number[];
}

export interface Frame {
  pose: Map<string, LocalPose>;
  world: Map<string, Mat>;
  /** Attachments in draw order (back → front), including hidden ones. */
  attachments: AttachmentFrame[];
}

/** Latest stepped key at or before t (keys sorted by time). */
export function steppedAt<K extends { time: number }>(keys: readonly K[] | undefined, t: number): K | undefined {
  if (!keys?.length) return undefined;
  let lo = -1;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].time <= t + TIME_EPSILON) lo = i;
    else break;
  }
  return lo >= 0 ? keys[lo] : undefined;
}

export function drawOrderAt(project: Project, anim: Animation | null, t: number): Attachment[] {
  const key = anim ? steppedAt(anim.drawOrder, t) : undefined;
  if (!key) return project.attachments;
  const byId = new Map(project.attachments.map((a) => [a.id, a]));
  const out = key.order.map((id) => byId.get(id)).filter((a): a is Attachment => !!a);
  // Attachments added after the key was written go on top, in setup order.
  for (const a of project.attachments) if (!key.order.includes(a.id)) out.push(a);
  return out;
}

export function evaluate(project: Project, anim: Animation | null, time: number, opts: EvalOptions = {}): Frame {
  const pose = opts.pose ? new Map(opts.pose) : samplePose(project.bones, anim, time);
  if (opts.constraints !== false) applyConstraints(project, pose, anim, time);
  const world = computeWorld(project.bones, pose);
  const skin = opts.skinId ? project.skins?.find((s) => s.id === opts.skinId) : undefined;
  const imageById = new Map(project.images.map((im) => [im.id, im]));
  const setupWorld = project.attachments.some((a) => a.mesh?.weights) ? computeWorld(project.bones) : world;
  const attachments: AttachmentFrame[] = drawOrderAt(project, anim, time).map((att) => {
    const st = anim?.slots?.[att.id];
    let imageId = steppedAt(st?.image, time)?.imageId ?? att.imageId;
    const skinned = skin?.entries.find((e) => e.attachmentId === att.id);
    // A skin replaces the attachment's setup image; image keys still pick explicitly.
    if (skinned && !steppedAt(st?.image, time)) imageId = skinned.imageId;
    // Stepped slot channels (visibility, image, draw order) show the setup value before
    // their first key; interpolated opacity holds its first key like bone channels.
    const visKey = steppedAt(st?.visible, time);
    const vis = visKey ? visKey.value[0] >= 0.5 : !att.hidden;
    const opacity = st?.opacity?.length ? sampleKeys(st.opacity, time, [att.opacity])[0] : att.opacity;
    const w = attachmentWorld(att, world);
    const frame: AttachmentFrame = { att, image: imageById.get(imageId), visible: vis, opacity: Math.min(1, Math.max(0, opacity)), world: w };
    if (att.mesh && frame.image) {
      const deform = st?.deform?.length ? sampleKeys(st.deform, time, new Array(att.mesh.points.length).fill(0)) : undefined;
      frame.vertices = meshWorldVertices(att, frame.image, world, setupWorld, deform);
    }
    return frame;
  });
  return { pose, world, attachments };
}

/** World-space outline points of an attachment frame (quad corners or mesh vertices). */
export function attachmentPoints(f: AttachmentFrame): Vec[] {
  if (f.vertices) {
    const out: Vec[] = [];
    for (let i = 0; i < f.vertices.length; i += 2) out.push({ x: f.vertices[i], y: f.vertices[i + 1] });
    return out;
  }
  const im = f.image;
  if (!im) return [];
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => apply(f.world, { x: (x * im.width) / 2, y: (y * im.height) / 2 }));
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounds of the visible art in a frame (null when nothing is drawn). */
export function frameBounds(frame: Frame, b: Bounds | null = null): Bounds | null {
  let out = b ? { ...b } : null;
  for (const f of frame.attachments) {
    if (!f.visible || f.opacity <= 0 || !f.image) continue;
    for (const q of attachmentPoints(f)) {
      if (!out) out = { minX: q.x, minY: q.y, maxX: q.x, maxY: q.y };
      else {
        out.minX = Math.min(out.minX, q.x);
        out.minY = Math.min(out.minY, q.y);
        out.maxX = Math.max(out.maxX, q.x);
        out.maxY = Math.max(out.maxY, q.y);
      }
    }
  }
  return out;
}
