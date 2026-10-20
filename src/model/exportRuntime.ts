// "rigsmith.runtime" export: a playback-oriented file without embedded image bytes.
// Bones and attachments are referenced by name; each animation carries its keys plus
// per-frame baked world transforms so a consumer can play it without an interpolator.
// Version 2 (see docs/runtime.md) keeps every version-1 field and adds what a player
// needs to evaluate from keys alone: curves, slot / draw-order / constraint keys, IK and
// path constraints, mesh weights, skins and mix rules. Version 3 adds transform
// constraints and their angle keys, bone inherit flags, blend modes, tint colours and
// colour keys, mesh vertex alpha and mesh bind poses; it is written only when the rig uses them, so a
// version-2 player keeps reading every other rig. Images are referenced by name (the
// atlas region name, or the file name).
import { frameCount } from './animation.ts';
import { formatColor, isWhite, setupColor } from './color.ts';
import { evaluate } from './evaluate.ts';
import { v3Features } from './format.ts';
import { angleOf, round } from './math.ts';
import { hasInheritFlags, topoOrder } from './skeleton.ts';
import type { Curve, Interp, Key, PathNode, Project } from './types.ts';
import { flatEvents } from './events.ts';
import { bakeSprings } from './rigOps.ts';

export const RUNTIME_FORMAT_ID = 'rigsmith.runtime';
export const RUNTIME_FORMAT_VERSION = 3;

export interface RuntimeKey {
  time: number;
  value: number[];
  interp: Interp;
  /** v2: bezier handles [x1, y1, x2, y2]. */
  curve?: Curve;
  /** v3, translate keys: the y component's own interpolation (and bezier handles). */
  interpY?: Interp;
  curveY?: Curve;
}

export interface RuntimeExport {
  format: typeof RUNTIME_FORMAT_ID;
  version: 2 | typeof RUNTIME_FORMAT_VERSION;
  name: string;
  /** v2: every image an attachment, key or skin can show (name = atlas region name). */
  images: { name: string; width: number; height: number }[];
  /** v3: `inherit` only on bones with a flag off (see Bone.inherit). */
  bones: { name: string; parent: string | null; x: number; y: number; rotation: number; scaleX: number; scaleY: number; length: number; inherit?: { rotation: boolean; scale: boolean; reflection: boolean } }[];
  attachments: {
    name: string; bone: string | null; image: string; width: number; height: number; x: number; y: number; rotation: number; scaleX: number; scaleY: number; opacity: number;
    /** v2: hidden in the setup pose. */
    hidden?: boolean;
    /** Mesh attachments: texture coordinates (setup-image px), triangles and outline length; v2: per-vertex weights by bone name. */
    mesh?: { uvs: number[]; triangles: number[]; hull: number; weights?: { bone: string; w: number }[][]; alphas?: number[]; bind?: { attachment: number[]; bones: Record<string, number[]> } };
    /** v3: absent = normal. */
    blend?: 'additive' | 'screen' | 'multiply';
    /** v3: tint `#rrggbbaa`; absent = white. */
    color?: string;
    /** v3 FX socket: spawn particle recipe `recipe` at the attachment's world transform, `rate` per second (`image` = sprite hint); draw nothing. */
    emitter?: { recipe: string; rate: number };
    /** v3 clipping mask: drawn only where the named attachment's shape (its alpha, full opacity, visible or not) is. */
    clip?: string;
  }[];
  /** v2 */
  ik: { name: string; bones: string[]; target: string; mix: number; bendPositive: boolean }[];
  /** v2: path nodes in the bone's space (null = world); handles relative to the node. */
  paths: { name: string; bone: string | null; closed: boolean; nodes: PathNode[] }[];
  /** v2 */
  pathConstraints: { name: string; path: string; bones: string[]; position: number; spacing: number; mix: number; rotate: boolean; rotateOffset: number }[];
  /** v3 (absent in v2 files): see TransformConstraint; bones by name. */
  transformConstraints?: { name: string; kind: 'rotation' | 'aim'; bone: string; source?: string; factor: number; relativeTo?: string | null; angle: number; mitre?: { k: number; max: number }; mix: number }[];
  /** v2: `from` absent = replaces the attachment's setup image. */
  skins: { name: string; entries: { attachment: string; image: string; from?: string }[] }[];
  /** v2: stored crossfade durations by animation name. */
  mixes: { from: string; to: string; duration: number }[];
  animations: {
    name: string;
    duration: number;
    fps: number;
    loop: boolean;
    frames: number;
    keys: Record<string, { translate: RuntimeKey[]; rotate: RuntimeKey[]; scale: RuntimeKey[] }>;
    /** v2: slot keys by attachment name (image keys by image name). */
    slots: Record<string, { visible?: RuntimeKey[]; opacity?: RuntimeKey[]; image?: { time: number; image: string }[]; deform?: RuntimeKey[]; color?: RuntimeKey[]; rate?: RuntimeKey[] }>;
    /** v2: attachment names back→front. */
    drawOrder: { time: number; order: string[] }[];
    /** v3: timeline events sorted by time, then name (absent when the clip has none). */
    events?: { time: number; name: string; payload?: string | number }[];
    /** v2: by constraint name. */
    constraints: Record<string, { mix?: RuntimeKey[]; position?: RuntimeKey[]; angle?: RuntimeKey[] }>;
    /** baked[boneName][frame] = [worldX, worldY, worldRotationDeg, worldScaleX, worldScaleY] (after IK/path/transform constraints) */
    baked: Record<string, number[][]>;
    /** Only when the animation keys slots or draw order: per frame, attachments back→front with their state. */
    bakedSlots?: { attachment: string; visible: boolean; opacity: number; image: string; color?: number[]; rate?: number }[][];
    /** Only when the project has meshes: bakedMeshes[attachmentName][frame] = world vertices [x0,y0,…] (deform + skinning applied). */
    bakedMeshes?: Record<string, number[][]>;
  }[];
}

// v2: setup values and keys are written at full precision (JSON numbers round-trip
// exactly), so a player evaluating from keys reproduces the editor exactly; only the
// baked per-frame data is rounded.
const conv = (ks: readonly Key[] | undefined): RuntimeKey[] =>
  (ks ?? []).map((k) => ({ time: k.time, value: k.value.slice(), interp: k.interp, ...(k.curve ? { curve: [...k.curve] as Curve } : {}), ...(k.interpY ? { interpY: k.interpY } : {}), ...(k.curveY ? { curveY: [...k.curveY] as Curve } : {}) }));

/**
 * Names must be unique per kind for name references to be unambiguous; returns the
 * problems (empty = exportable).
 */
export function runtimeProblems(project: Project): string[] {
  const out: string[] = [];
  const dup = (kind: string, names: string[]) => {
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) out.push(`Two ${kind} are named “${n}”; rename one (runtime files reference ${kind} by name).`);
      seen.add(n);
    }
  };
  dup('bones', project.bones.map((b) => b.name));
  dup('attachments', project.attachments.map((a) => a.name));
  dup('images', project.images.map((i) => i.name));
  dup('animations', project.animations.map((a) => a.name));
  dup('constraints', [...(project.ik ?? []), ...(project.pathConstraints ?? []), ...(project.transformConstraints ?? [])].map((c) => c.name));
  dup('paths', (project.paths ?? []).map((p) => p.name));
  dup('skins', (project.skins ?? []).map((s) => s.name));
  return out;
}

export function exportRuntime(source: Project): RuntimeExport {
  // Springs are simulated in the editor only: players get them as baked rotate keys.
  const project = source.springs?.length ? structuredClone(source) : source;
  if (project !== source) bakeSprings(project);
  const ordered = topoOrder(project.bones);
  const nameOf = new Map(project.bones.map((b) => [b.id, b.name]));
  const imageOf = new Map(project.images.map((im) => [im.id, im]));
  const attName = new Map(project.attachments.map((a) => [a.id, a.name]));
  const animName = new Map(project.animations.map((a) => [a.id, a.name]));
  const pathName = new Map((project.paths ?? []).map((p) => [p.id, p.name]));
  const conName = new Map([...(project.ik ?? []), ...(project.pathConstraints ?? []), ...(project.transformConstraints ?? [])].map((c) => [c.id, c.name]));
  const v3 = v3Features(project).length > 0;
  const img = (id: string) => imageOf.get(id)?.name ?? id;
  const bone = (id: string) => nameOf.get(id) ?? id;
  return {
    format: RUNTIME_FORMAT_ID,
    version: v3 ? RUNTIME_FORMAT_VERSION : 2,
    name: project.name,
    images: project.images.map((im) => ({ name: im.name, width: im.width, height: im.height })),
    ik: (project.ik ?? []).map((k) => ({ name: k.name, bones: k.bones.map(bone), target: bone(k.target), mix: k.mix, bendPositive: k.bendPositive })),
    paths: (project.paths ?? []).map((p) => ({ name: p.name, bone: p.boneId ? bone(p.boneId) : null, closed: p.closed, nodes: p.nodes.map((n) => ({ ...n })) })),
    pathConstraints: (project.pathConstraints ?? []).map((c) => ({ name: c.name, path: pathName.get(c.pathId) ?? c.pathId, bones: c.bones.map(bone), position: c.position, spacing: c.spacing, mix: c.mix, rotate: c.rotate, rotateOffset: c.rotateOffset })),
    ...(v3
      ? {
          transformConstraints: (project.transformConstraints ?? []).map((c) => ({
            name: c.name, kind: c.kind, bone: bone(c.bone), factor: c.factor, angle: c.angle, mix: c.mix,
            ...(c.kind === 'rotation' ? { source: bone(c.source!), ...(c.mitre ? { mitre: { ...c.mitre } } : {}) } : { relativeTo: c.relativeTo ? bone(c.relativeTo) : null }),
          })),
        }
      : {}),
    skins: (project.skins ?? []).map((s) => ({ name: s.name, entries: s.entries.map((e) => ({ attachment: attName.get(e.attachmentId) ?? e.attachmentId, image: img(e.imageId), ...(e.from ? { from: img(e.from) } : {}) })) })),
    mixes: (project.mixes ?? []).map((m) => ({ from: animName.get(m.from) ?? m.from, to: animName.get(m.to) ?? m.to, duration: m.duration })),
    bones: ordered.map((b) => ({
      name: b.name,
      parent: b.parentId ? (nameOf.get(b.parentId) ?? null) : null,
      x: b.x,
      y: b.y,
      rotation: b.rotation,
      scaleX: b.scaleX,
      scaleY: b.scaleY,
      length: b.length,
      ...(hasInheritFlags(b) ? { inherit: { ...b.inherit! } } : {}),
    })),
    attachments: project.attachments.map((a) => {
      const im = imageOf.get(a.imageId);
      return {
        name: a.name,
        bone: a.boneId ? (nameOf.get(a.boneId) ?? null) : null,
        image: im?.name ?? a.imageId,
        width: im?.width ?? 0,
        height: im?.height ?? 0,
        x: a.x,
        y: a.y,
        rotation: a.rotation,
        scaleX: a.scaleX,
        scaleY: a.scaleY,
        opacity: a.opacity,
        ...(a.hidden ? { hidden: true } : {}),
        ...(a.mesh ? { mesh: { uvs: a.mesh.points.slice(), triangles: a.mesh.triangles.slice(), hull: a.mesh.hull, ...(a.mesh.weights ? { weights: a.mesh.weights.map((l) => l.map((x) => ({ bone: bone(x.bone), w: x.w }))) } : {}), ...(a.mesh.alphas ? { alphas: a.mesh.alphas.slice() } : {}), ...(a.mesh.bind ? { bind: { attachment: a.mesh.bind.attachment.slice(), bones: Object.fromEntries(Object.entries(a.mesh.bind.bones).map(([id, m]) => [bone(id), m.slice()])) } } : {}) } } : {}),
        ...(a.blend && a.blend !== 'normal' ? { blend: a.blend } : {}),
        ...(a.color && !isWhite(setupColor(a)) ? { color: formatColor(setupColor(a)) } : {}),
        ...(a.emitter ? { emitter: { recipe: a.emitter.recipe, rate: a.emitter.rate } } : {}),
        ...(a.clip ? { clip: attName.get(a.clip) ?? a.clip } : {}),
      };
    }),
    animations: project.animations.map((anim) => {
      const frames = frameCount(anim) + (anim.loop ? 0 : 1);
      const baked: Record<string, number[][]> = {};
      for (const b of ordered) baked[b.name] = [];
      const slotted = !!(anim.drawOrder?.length || Object.keys(anim.slots ?? {}).length);
      const bakedSlots: NonNullable<RuntimeExport['animations'][number]['bakedSlots']> = [];
      const meshed = project.attachments.filter((a) => a.mesh);
      const bakedMeshes: Record<string, number[][]> = Object.fromEntries(meshed.map((a) => [a.name, []]));
      for (let f = 0; f < frames; f++) {
        const t = Math.min(anim.duration, f / anim.fps);
        const fr = evaluate(project, anim, t);
        const world = fr.world;
        for (const a of fr.attachments) if (a.vertices && a.att.name in bakedMeshes) bakedMeshes[a.att.name].push(a.vertices.map((v) => round(v, 3)));
        if (slotted) bakedSlots.push(fr.attachments.map((a) => ({ attachment: a.att.name, visible: a.visible, opacity: round(a.opacity, 4), image: a.image?.name ?? '', ...(isWhite(a.color) ? {} : { color: a.color.map((v) => round(v, 4)) }), ...(a.emitter ? { rate: round(a.emitter.rate, 3) } : {}) })));
        for (const b of ordered) {
          const m = world.get(b.id)!;
          baked[b.name].push([round(m.tx, 3), round(m.ty, 3), round(angleOf(m), 3), round(Math.hypot(m.a, m.b), 4), round(Math.hypot(m.c, m.d), 4)]);
        }
      }
      const keys: RuntimeExport['animations'][number]['keys'] = {};
      for (const [boneId, track] of Object.entries(anim.tracks)) {
        const n = nameOf.get(boneId);
        if (!n) continue;
        keys[n] = { translate: conv(track.translate), rotate: conv(track.rotate), scale: conv(track.scale) };
      }
      const slots: RuntimeExport['animations'][number]['slots'] = {};
      for (const [attId, st] of Object.entries(anim.slots ?? {})) {
        const n = attName.get(attId);
        if (!n) continue;
        slots[n] = {
          ...(st.visible?.length ? { visible: conv(st.visible) } : {}),
          ...(st.opacity?.length ? { opacity: conv(st.opacity) } : {}),
          ...(st.image?.length ? { image: st.image.map((k) => ({ time: k.time, image: img(k.imageId) })) } : {}),
          ...(st.deform?.length ? { deform: conv(st.deform) } : {}),
          ...(st.color?.length ? { color: conv(st.color) } : {}),
          ...(st.rate?.length ? { rate: conv(st.rate) } : {}),
        };
      }
      const constraints: RuntimeExport['animations'][number]['constraints'] = {};
      for (const [cId, ct] of Object.entries(anim.constraints ?? {})) {
        const n = conName.get(cId);
        if (!n) continue;
        constraints[n] = { ...(ct.mix?.length ? { mix: conv(ct.mix) } : {}), ...(ct.position?.length ? { position: conv(ct.position) } : {}), ...(ct.angle?.length ? { angle: conv(ct.angle) } : {}) };
      }
      const drawOrder = (anim.drawOrder ?? []).map((k) => ({ time: k.time, order: k.order.map((id) => attName.get(id) ?? id) }));
      const events = flatEvents(anim);
      return { name: anim.name, duration: anim.duration, fps: anim.fps, loop: anim.loop, frames, keys, slots, drawOrder, constraints, ...(events.length ? { events } : {}), baked, ...(slotted ? { bakedSlots } : {}), ...(meshed.length ? { bakedMeshes } : {}) };
    }),
  };
}
