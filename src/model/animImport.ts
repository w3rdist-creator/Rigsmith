// Cross-project motion reuse (RV-009): copy animations from another Rigsmith project
// into this one. Every reference an animation holds is remapped explicitly:
//   bone tracks        → source bone id      → target bone (or skip)
//   slot tracks        → source attachment   → target attachment (or skip)
//   image keys         → source image        → target image (or the key is dropped)
//   deform keys        → kept only if the target attachment has a mesh with the same
//                        vertex count (else dropped, reported)
//   draw-order keys    → attachment ids remapped; unmapped ids dropped (the integrity
//                        pass then appends the target's other attachments on top)
//   constraint tracks  → source IK/path constraint → target constraint of the same kind
// Defaults match by exact name; the caller (the import dialog) can change any mapping.
// Key values are absolute local values and are copied unchanged by default: a target
// bone whose setup pose differs from the source bone jumps to the source values at its
// first key. Option `offsetSetup` instead shifts each copied bone key by the setup
// difference (translate and rotate: + target setup − source setup; scale: × target
// setup / source setup), so the bone moves by the same amounts around its own setup.
// The report also lists what the copy cannot carry over by itself:
//   driven — imported keys on bones an IK or path constraint of this project overrides
//            (constraint mix > 0 during the imported animation); option
//            `muteConstraints` keys those constraints' mix to 0 in the imported copy;
//   rig    — mapped bones whose parent differs by name here, and scale-keyed bones that
//            scale a different set of descendant bones here than in the source.
// Mix rules between two imported animations are copied too.
import { uniqueName } from './ops.ts';
import type { Animation, BoneTrack, Channel, IkConstraint, PathConstraint, Project, TransformConstraint } from './types.ts';
import { newId } from './types.ts';

export type RefKind = 'bone' | 'attachment' | 'constraint' | 'image';

export interface ImportMapping {
  bones: Record<string, string | null>;
  attachments: Record<string, string | null>;
  constraints: Record<string, string | null>;
  images: Record<string, string | null>;
}

/** Source ids referenced by the chosen animations, with the number of keys per id. */
export interface UsedRefs {
  bones: Map<string, number>;
  attachments: Map<string, number>;
  constraints: Map<string, number>;
  images: Map<string, number>;
}

export interface ImportReport {
  /** source animation name → name given in this project. */
  imported: { source: string; name: string }[];
  /** Referenced source objects without a target; their keys are not imported. */
  unmatched: { kind: RefKind; name: string; keys: number }[];
  /** Other keys or tracks left out, with the reason. */
  dropped: string[];
  /** Two or more source objects mapped onto the same target (the first one wins). */
  conflicts: string[];
  mixes: number;
  /** Keys imported in total. */
  keys: number;
  /** Constraints of this project that override imported bone keys (see `drivenByConstraints`). */
  driven: DrivenReport[];
  /** Hierarchy differences that change what imported keys do here. */
  rig: string[];
}

export interface ImportOptions {
  /** Shift bone keys by the target − source setup difference (scale: ratio). */
  offsetSetup?: boolean;
  /** Target constraint ids to key to mix 0 (one key at time 0) in every imported animation. */
  muteConstraints?: readonly string[];
}

/** One constraint that overrides imported keys, summed over the imported animations. */
export interface DrivenReport {
  constraintId: string;
  constraint: string;
  kind: 'ik' | 'path' | 'transform';
  /** Setup mix of the constraint. */
  mix: number;
  /** Overridden keys per target bone name (rotate keys for IK; translate, and rotate if the path rotates). */
  bones: { name: string; keys: number }[];
  keys: number;
  /** true when `muteConstraints` keyed it to 0 in the imported copy (the keys then play). */
  muted: boolean;
}

/** Channels a constraint writes on its bones: IK sets rotation, a path sets position (and rotation), a transform constraint rotation (and scale with a mitre). */
function drivenChannels(c: { kind: 'ik' } | { kind: 'path'; pc: PathConstraint } | { kind: 'transform'; tc: TransformConstraint }): Channel[] {
  if (c.kind === 'transform') return c.tc.mitre ? ['rotate', 'scale'] : ['rotate'];
  return c.kind === 'ik' ? ['rotate'] : c.pc.rotate ? ['translate', 'rotate'] : ['translate'];
}

/**
 * Constraints of `project` that override keys of `anim` on their bones: the effective
 * mix (keyed in `anim`, else the setup mix) is above 0 at some key. Per constraint, the
 * keys of `anim` on the overridden channels of its bones.
 */
export function drivenByConstraints(project: Project, anim: Animation): Omit<DrivenReport, 'muted'>[] {
  const out: Omit<DrivenReport, 'muted'>[] = [];
  const all: ({ kind: 'ik'; c: IkConstraint; bones: string[] } | { kind: 'path'; c: PathConstraint; bones: string[] } | { kind: 'transform'; c: TransformConstraint; bones: string[] })[] = [
    ...(project.ik ?? []).map((c) => ({ kind: 'ik' as const, c, bones: c.bones })),
    ...(project.pathConstraints ?? []).map((c) => ({ kind: 'path' as const, c, bones: c.bones })),
    ...(project.transformConstraints ?? []).map((c) => ({ kind: 'transform' as const, c, bones: [c.bone] })),
  ];
  for (const it of all) {
    const keyed = anim.constraints?.[it.c.id]?.mix;
    const active = keyed?.length ? keyed.some((k) => k.value[0] > 0) : it.c.mix > 0;
    if (!active) continue;
    const chans = drivenChannels(it.kind === 'ik' ? { kind: 'ik' } : it.kind === 'path' ? { kind: 'path', pc: it.c } : { kind: 'transform', tc: it.c });
    const bones: { name: string; keys: number }[] = [];
    for (const id of it.bones) {
      const tr: BoneTrack | undefined = anim.tracks[id];
      const n = tr ? chans.reduce((s, ch) => s + tr[ch].length, 0) : 0;
      if (n) bones.push({ name: project.bones.find((b) => b.id === id)?.name ?? id, keys: n });
    }
    if (bones.length) out.push({ constraintId: it.c.id, constraint: it.c.name, kind: it.kind, mix: it.c.mix, bones, keys: bones.reduce((s, b) => s + b.keys, 0) });
  }
  return out;
}

/** Bone ids below `id` (children, grandchildren, …). */
function descendants(p: Project, id: string): string[] {
  const out: string[] = [];
  const walk = (pid: string) => {
    for (const b of p.bones) if (b.parentId === pid && !out.includes(b.id)) {
      out.push(b.id);
      walk(b.id);
    }
  };
  walk(id);
  return out;
}

/** Adds n keys for id; with n = 0 the id is only listed when `always` (draw-order slots). */
const add = (m: Map<string, number>, id: string, n: number, always = false) => void ((n || always) && m.set(id, (m.get(id) ?? 0) + n));

export function usedRefs(src: Project, animIds: readonly string[]): UsedRefs {
  const u: UsedRefs = { bones: new Map(), attachments: new Map(), constraints: new Map(), images: new Map() };
  for (const an of src.animations.filter((a) => animIds.includes(a.id))) {
    for (const [id, tr] of Object.entries(an.tracks)) add(u.bones, id, tr.translate.length + tr.rotate.length + tr.scale.length);
    for (const [id, st] of Object.entries(an.slots ?? {})) {
      add(u.attachments, id, (st.visible?.length ?? 0) + (st.opacity?.length ?? 0) + (st.image?.length ?? 0) + (st.deform?.length ?? 0) + (st.color?.length ?? 0));
      for (const k of st.image ?? []) add(u.images, k.imageId, 1);
    }
    for (const k of an.drawOrder ?? []) for (const id of k.order) add(u.attachments, id, 0, true);
    for (const [id, c] of Object.entries(an.constraints ?? {})) add(u.constraints, id, (c.mix?.length ?? 0) + (c.position?.length ?? 0) + (c.angle?.length ?? 0));
  }
  return u;
}

type Named = { id: string; name: string };
const constraintsOf = (p: Project): (Named & { kind: 'ik' | 'path' | 'transform' })[] => [
  ...(p.ik ?? []).map((k) => ({ id: k.id, name: k.name, kind: 'ik' as const })),
  ...(p.pathConstraints ?? []).map((k) => ({ id: k.id, name: k.name, kind: 'path' as const })),
  ...(p.transformConstraints ?? []).map((k) => ({ id: k.id, name: k.name, kind: 'transform' as const })),
];

/** Name-based default: each used source object maps to the target object with the same name. */
export function defaultMapping(src: Project, dst: Project, animIds: readonly string[]): ImportMapping {
  const u = usedRefs(src, animIds);
  const byName = (ids: Iterable<string>, from: readonly Named[], to: readonly Named[]) => {
    const out: Record<string, string | null> = {};
    for (const id of ids) {
      const name = from.find((x) => x.id === id)?.name;
      out[id] = (name !== undefined && to.find((x) => x.name === name)?.id) || null;
    }
    return out;
  };
  const sc = constraintsOf(src), dc = constraintsOf(dst);
  const constraints: Record<string, string | null> = {};
  for (const id of u.constraints.keys()) {
    const s = sc.find((x) => x.id === id);
    constraints[id] = (s && dc.find((x) => x.name === s.name && x.kind === s.kind)?.id) || null;
  }
  return {
    bones: byName(u.bones.keys(), src.bones, dst.bones),
    attachments: byName(u.attachments.keys(), src.attachments, dst.attachments),
    constraints,
    images: byName(u.images.keys(), src.images, dst.images),
  };
}

/**
 * Copies the chosen source animations into `dst` (mutates it; run inside one undoable
 * edit). Returns the report of what was imported, skipped and dropped.
 */
export function importAnimations(dst: Project, src: Project, animIds: readonly string[], mapping: ImportMapping, options: ImportOptions = {}): ImportReport {
  const report: ImportReport = { imported: [], unmatched: [], dropped: [], conflicts: [], mixes: 0, keys: 0, driven: [], rig: [] };
  const u = usedRefs(src, animIds);
  const nameOf = (list: readonly Named[], id: string) => list.find((x) => x.id === id)?.name ?? id;
  const dstOf = (kind: RefKind, id: string): string | null => {
    const t = mapping[`${kind}s` as 'bones'][id] ?? null;
    const pool: readonly Named[] = kind === 'bone' ? dst.bones : kind === 'attachment' ? dst.attachments : kind === 'image' ? dst.images : constraintsOf(dst);
    return t && pool.some((x) => x.id === t) ? t : null;
  };
  const srcList = (kind: RefKind): readonly Named[] => (kind === 'bone' ? src.bones : kind === 'attachment' ? src.attachments : kind === 'image' ? src.images : constraintsOf(src));
  for (const kind of ['bone', 'attachment', 'constraint', 'image'] as const) {
    const used = u[`${kind}s` as 'bones'];
    const seen = new Map<string, string>();
    for (const [id, keys] of used) {
      const t = dstOf(kind, id);
      if (!t) {
        report.unmatched.push({ kind, name: nameOf(srcList(kind), id), keys });
        continue;
      }
      const prev = seen.get(t);
      if (prev !== undefined && kind !== 'image') report.conflicts.push(`${kind} “${nameOf(srcList(kind), id)}” and “${nameOf(srcList(kind), prev)}” both map to “${nameOf(kind === 'constraint' ? constraintsOf(dst) : kind === 'bone' ? dst.bones : dst.attachments, t)}”; only “${nameOf(srcList(kind), prev)}” is imported there.`);
      else seen.set(t, id);
    }
  }
  const winner = (kind: 'bone' | 'attachment' | 'constraint', id: string): string | null => {
    const t = dstOf(kind, id);
    if (!t) return null;
    // First source (in usedRefs order) mapped to this target wins.
    for (const sid of u[`${kind}s` as 'bones'].keys()) if (dstOf(kind, sid) === t) return sid === id ? t : null;
    return null;
  };

  // Bone keys: setup offsets (option) and hierarchy notes.
  const mappedBones = [...u.bones.keys()].map((sid) => ({ sid, tid: winner('bone', sid) })).filter((x): x is { sid: string; tid: string } => !!x.tid);
  const boneName = (p: Project, id: string | null) => (id ? (p.bones.find((b) => b.id === id)?.name ?? id) : '(world)');
  const scaled = new Set<string>();
  for (const an of src.animations.filter((a) => animIds.includes(a.id))) for (const [id, tr] of Object.entries(an.tracks)) if (tr.scale.length) scaled.add(id);
  for (const { sid, tid } of mappedBones) {
    const sb = src.bones.find((b) => b.id === sid)!, tb = dst.bones.find((b) => b.id === tid)!;
    const sp = boneName(src, sb.parentId), tp = boneName(dst, tb.parentId);
    if (sp !== tp) report.rig.push(`“${tb.name}”: its parent here is “${tp}”, in the source “${sp}”.`);
    if (scaled.has(sid)) {
      const sd = descendants(src, sid).map((id) => boneName(src, id)), td = descendants(dst, tid).map((id) => boneName(dst, id));
      const extra = td.filter((n) => !sd.includes(n));
      if (extra.length) report.rig.push(`“${tb.name}” has scale keys; here they also scale ${extra.length} bone(s) that are not below it in the source: ${extra.join(', ')}.`);
    }
  }
  const offsetTrack = (tr: BoneTrack, sid: string, tid: string): BoneTrack => {
    const s = src.bones.find((b) => b.id === sid)!, t = dst.bones.find((b) => b.id === tid)!;
    const copy = structuredClone(tr);
    // Differences first: (v + t) − s is not v when t = s in floating point, so equal setups
    // would otherwise write rounding noise into every key.
    const dx = t.x - s.x, dy = t.y - s.y, dr = t.rotation - s.rotation;
    for (const k of copy.translate) k.value = [k.value[0] + dx, k.value[1] + dy];
    for (const k of copy.rotate) k.value = [k.value[0] + dr];
    const ratio = (a: number, b: number) => (b !== 0 ? a / b : 1);
    for (const k of copy.scale) k.value = [k.value[0] * ratio(t.scaleX, s.scaleX), k.value[1] * ratio(t.scaleY, s.scaleY)];
    return copy;
  };
  if (options.offsetSetup) for (const { sid } of mappedBones) {
    const s = src.bones.find((b) => b.id === sid)!;
    if ((s.scaleX === 0 || s.scaleY === 0) && scaled.has(sid)) report.dropped.push(`“${s.name}”: its source setup scale is 0, so its scale keys are copied without the setup ratio.`);
  }
  const muted = new Set((options.muteConstraints ?? []).filter((id) => constraintsOf(dst).some((c) => c.id === id)));

  const newIds = new Map<string, string>();
  const names = dst.animations.map((a) => a.name);
  for (const an of src.animations.filter((a) => animIds.includes(a.id))) {
    const name = uniqueName(names, an.name);
    names.push(name);
    const out: Animation = { id: newId('anim'), name, duration: an.duration, fps: an.fps, loop: an.loop, tracks: {} };
    newIds.set(an.id, out.id);
    for (const [id, tr] of Object.entries(an.tracks)) {
      const t = winner('bone', id);
      if (!t) continue;
      out.tracks[t] = options.offsetSetup ? offsetTrack(tr, id, t) : structuredClone(tr);
      report.keys += tr.translate.length + tr.rotate.length + tr.scale.length;
    }
    for (const [id, st] of Object.entries(an.slots ?? {})) {
      const t = winner('attachment', id);
      if (!t) continue;
      const tAtt = dst.attachments.find((a) => a.id === t)!;
      const copy = structuredClone(st);
      if (copy.image) {
        const before = copy.image.length;
        copy.image = copy.image.filter((k) => {
          const im = dstOf('image', k.imageId);
          if (im) k.imageId = im;
          return !!im;
        });
        if (copy.image.length !== before) report.dropped.push(`“${an.name}”: ${before - copy.image.length} image key(s) of ${tAtt.name} (their image has no match here).`);
        if (!copy.image.length) delete copy.image;
      }
      if (copy.deform) {
        const n = tAtt.mesh ? tAtt.mesh.points.length : -1;
        const kept = copy.deform.filter((k) => k.value.length === n);
        if (kept.length !== copy.deform.length) report.dropped.push(`“${an.name}”: ${copy.deform.length - kept.length} deform key(s) of ${tAtt.name} (${n < 0 ? 'it has no mesh here' : 'its mesh has a different vertex count'}).`);
        if (kept.length) copy.deform = kept;
        else delete copy.deform;
      }
      const n = (copy.visible?.length ?? 0) + (copy.opacity?.length ?? 0) + (copy.image?.length ?? 0) + (copy.deform?.length ?? 0) + (copy.color?.length ?? 0);
      if (!n) continue;
      (out.slots ??= {})[t] = copy;
      report.keys += n;
    }
    if (an.drawOrder?.length) {
      let missing = 0;
      out.drawOrder = an.drawOrder.map((k) => ({
        time: k.time,
        order: k.order.flatMap((id) => {
          const t = winner('attachment', id);
          if (!t) missing++;
          return t ? [t] : [];
        }),
      }));
      report.keys += out.drawOrder.length;
      if (missing) report.dropped.push(`“${an.name}”: draw-order keys list ${missing} unmatched attachment slot(s); this project's other attachments are placed on top in setup order.`);
    }
    for (const [id, c] of Object.entries(an.constraints ?? {})) {
      const t = winner('constraint', id);
      if (!t) continue;
      const kind = constraintsOf(dst).find((x) => x.id === t)!.kind;
      const copy = structuredClone(c);
      if (kind !== 'path' && copy.position?.length) {
        report.dropped.push(`“${an.name}”: ${copy.position.length} path-position key(s) (the target is ${kind === 'ik' ? 'an IK' : 'a transform'} constraint).`);
        delete copy.position;
      }
      if (kind !== 'transform' && copy.angle?.length) {
        report.dropped.push(`“${an.name}”: ${copy.angle.length} angle key(s) (the target is ${kind === 'ik' ? 'an IK' : 'a path'} constraint).`);
        delete copy.angle;
      }
      const n = (copy.mix?.length ?? 0) + (copy.position?.length ?? 0) + (copy.angle?.length ?? 0);
      if (!n) continue;
      (out.constraints ??= {})[t] = copy;
      report.keys += n;
    }
    // Constraints that would override the imported bone keys here.
    for (const d of drivenByConstraints(dst, out)) {
      const isMuted = muted.has(d.constraintId);
      const prev = report.driven.find((x) => x.constraintId === d.constraintId);
      if (prev) {
        for (const b of d.bones) {
          const pb = prev.bones.find((x) => x.name === b.name);
          if (pb) pb.keys += b.keys;
          else prev.bones.push({ ...b });
        }
        prev.keys += d.keys;
      } else report.driven.push({ ...d, bones: d.bones.map((b) => ({ ...b })), muted: isMuted });
      if (isMuted) {
        const ct = ((out.constraints ??= {})[d.constraintId] ??= {});
        if (ct.mix?.length) report.dropped.push(`“${an.name}”: ${ct.mix.length} mix key(s) of ${d.constraint} replaced by mix 0.`);
        ct.mix = [{ time: 0, value: [0], interp: 'step' }];
      }
    }
    dst.animations.push(out);
    report.imported.push({ source: an.name, name });
  }
  for (const r of src.mixes ?? []) {
    const from = newIds.get(r.from), to = newIds.get(r.to);
    if (!from || !to) continue;
    (dst.mixes ??= []).push({ from, to, duration: r.duration });
    report.mixes++;
  }
  return report;
}

/** One-line summary of a report (status bar / dialog). */
export function reportSummary(r: ImportReport): string {
  const parts = [`${r.imported.length} animation(s), ${r.keys} key(s)`];
  if (r.mixes) parts.push(`${r.mixes} mix rule(s)`);
  if (r.unmatched.length) parts.push(`${r.unmatched.length} unmatched (${r.unmatched.map((x) => x.name).join(', ')}) skipped`);
  const live = r.driven.filter((d) => !d.muted);
  if (live.length) parts.push(`${live.reduce((n, d) => n + d.keys, 0)} key(s) overridden by ${live.map((d) => d.constraint).join(', ')}`);
  const off = r.driven.filter((d) => d.muted);
  if (off.length) parts.push(`mix keyed to 0: ${off.map((d) => d.constraint).join(', ')}`);
  if (r.dropped.length) parts.push(`${r.dropped.length} note(s) on dropped keys`);
  return parts.join(' · ');
}
