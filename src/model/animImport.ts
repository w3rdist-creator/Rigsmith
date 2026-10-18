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
// Values are copied unchanged: bone keys are local to the bone, so a target bone with a
// different setup pose or parent plays the same local motion on its own rig.
// Mix rules between two imported animations are copied too.
import { uniqueName } from './ops.ts';
import type { Animation, Project } from './types.ts';
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
}

/** Adds n keys for id; with n = 0 the id is only listed when `always` (draw-order slots). */
const add = (m: Map<string, number>, id: string, n: number, always = false) => void ((n || always) && m.set(id, (m.get(id) ?? 0) + n));

export function usedRefs(src: Project, animIds: readonly string[]): UsedRefs {
  const u: UsedRefs = { bones: new Map(), attachments: new Map(), constraints: new Map(), images: new Map() };
  for (const an of src.animations.filter((a) => animIds.includes(a.id))) {
    for (const [id, tr] of Object.entries(an.tracks)) add(u.bones, id, tr.translate.length + tr.rotate.length + tr.scale.length);
    for (const [id, st] of Object.entries(an.slots ?? {})) {
      add(u.attachments, id, (st.visible?.length ?? 0) + (st.opacity?.length ?? 0) + (st.image?.length ?? 0) + (st.deform?.length ?? 0));
      for (const k of st.image ?? []) add(u.images, k.imageId, 1);
    }
    for (const k of an.drawOrder ?? []) for (const id of k.order) add(u.attachments, id, 0, true);
    for (const [id, c] of Object.entries(an.constraints ?? {})) add(u.constraints, id, (c.mix?.length ?? 0) + (c.position?.length ?? 0));
  }
  return u;
}

type Named = { id: string; name: string };
const constraintsOf = (p: Project): (Named & { kind: 'ik' | 'path' })[] => [
  ...(p.ik ?? []).map((k) => ({ id: k.id, name: k.name, kind: 'ik' as const })),
  ...(p.pathConstraints ?? []).map((k) => ({ id: k.id, name: k.name, kind: 'path' as const })),
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
export function importAnimations(dst: Project, src: Project, animIds: readonly string[], mapping: ImportMapping): ImportReport {
  const report: ImportReport = { imported: [], unmatched: [], dropped: [], conflicts: [], mixes: 0, keys: 0 };
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
      out.tracks[t] = structuredClone(tr);
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
      const n = (copy.visible?.length ?? 0) + (copy.opacity?.length ?? 0) + (copy.image?.length ?? 0) + (copy.deform?.length ?? 0);
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
      if (kind === 'ik' && copy.position?.length) {
        report.dropped.push(`“${an.name}”: ${copy.position.length} path-position key(s) (the target is an IK constraint).`);
        delete copy.position;
      }
      const n = (copy.mix?.length ?? 0) + (copy.position?.length ?? 0);
      if (!n) continue;
      (out.constraints ??= {})[t] = copy;
      report.keys += n;
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
  if (r.dropped.length) parts.push(`${r.dropped.length} note(s) on dropped keys`);
  return parts.join(' · ');
}
