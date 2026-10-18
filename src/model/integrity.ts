// Keeps cross references valid after edits (run inside every undoable mutation, so a
// repair is part of the same undo step). The file validator is strict — e.g. every
// draw-order key must list each attachment exactly once — and this pass guarantees an
// edited project always re-opens. Returns human-readable notes for what it changed.
import { normalizeWeights } from './meshOps.ts';
import { isAncestorOrSelf } from './skeleton.ts';
import type { Project } from './types.ts';

export function repairReferences(p: Project): string[] {
  const notes: string[] = [];
  const boneIds = new Set(p.bones.map((b) => b.id));
  const attIds = new Set(p.attachments.map((a) => a.id));
  const imageIds = new Set(p.images.map((i) => i.id));

  if (p.ik) {
    const before = p.ik.length;
    p.ik = p.ik.filter((k) => {
      if (!boneIds.has(k.target) || k.bones.some((b) => !boneIds.has(b))) return false;
      if (k.bones.length === 2 && p.bones.find((b) => b.id === k.bones[1])?.parentId !== k.bones[0]) return false;
      return !k.bones.some((b) => isAncestorOrSelf(p.bones, b, k.target));
    });
    if (p.ik.length !== before) notes.push(`${before - p.ik.length} IK constraint(s) removed (their bones changed).`);
  }
  if (p.paths) for (const path of p.paths) if (path.boneId && !boneIds.has(path.boneId)) path.boneId = null;
  const pathIds = new Set((p.paths ?? []).map((x) => x.id));
  if (p.pathConstraints) {
    const before = p.pathConstraints.length;
    p.pathConstraints = p.pathConstraints
      .map((pc) => ({ ...pc, bones: pc.bones.filter((b) => boneIds.has(b)) }))
      .filter((pc) => {
        if (!pathIds.has(pc.pathId) || !pc.bones.length) return false;
        const owner = p.paths!.find((x) => x.id === pc.pathId)!.boneId;
        return !owner || !pc.bones.some((b) => isAncestorOrSelf(p.bones, b, owner));
      });
    if (p.pathConstraints.length !== before) notes.push(`${before - p.pathConstraints.length} path constraint(s) removed.`);
  }
  // Mesh weights: influences of missing bones are dropped and the rest renormalized; a
  // vertex left without influences goes to the attachment's bone (or, with no bone, the
  // mesh becomes rigid).
  for (const a of p.attachments) {
    const m = a.mesh;
    if (!m?.weights) continue;
    let changed = 0;
    let rigid = false;
    const next = m.weights.map((raw) => {
      // A list that is not an array (null from a failed computation) counts as empty.
      const list = Array.isArray(raw) ? raw.filter((x) => x && typeof x.bone === 'string' && Number.isFinite(x.w)) : [];
      const sum = list.reduce((s, x) => s + x.w, 0);
      if (list.length === (raw as unknown[] | null)?.length && list.every((x) => boneIds.has(x.bone)) && Math.abs(sum - 1) < 1e-6) return raw;
      changed++;
      const nw = normalizeWeights(list.filter((x) => boneIds.has(x.bone)));
      if (nw) return nw;
      if (a.boneId) return [{ bone: a.boneId, w: 1 }];
      rigid = true;
      return list;
    });
    if (rigid || next.length !== m.points.length / 2) delete m.weights;
    else m.weights = next;
    if (changed) notes.push(`${a.name}: ${changed} vertex weight list(s) repaired.`);
  }
  const constraintIds = new Set([...(p.ik ?? []).map((k) => k.id), ...(p.pathConstraints ?? []).map((k) => k.id)]);
  if (p.skins)
    for (const s of p.skins) {
      const seen = new Set<string>();
      s.entries = s.entries.filter((e) => {
        const att = p.attachments.find((a) => a.id === e.attachmentId);
        if (!att || !imageIds.has(e.imageId) || (e.from !== undefined && !imageIds.has(e.from))) return false;
        // A `from` equal to the setup image is the plain entry; keep one entry per key.
        if (e.from === att.imageId) delete e.from;
        const key = `${e.attachmentId}|${e.from ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  if (p.mixes) {
    const animIds = new Set(p.animations.map((a) => a.id));
    const seen = new Set<string>();
    p.mixes = p.mixes.filter((m) => {
      const key = `${m.from}|${m.to}`;
      if (!animIds.has(m.from) || !animIds.has(m.to) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  for (const an of p.animations) {
    for (const id of Object.keys(an.tracks)) if (!boneIds.has(id)) delete an.tracks[id];
    if (an.slots) {
      for (const [id, st] of Object.entries(an.slots)) {
        if (!attIds.has(id)) {
          delete an.slots[id];
          continue;
        }
        if (st.image) st.image = st.image.filter((k) => imageIds.has(k.imageId));
        const att = p.attachments.find((a) => a.id === id)!;
        const n = att.mesh ? att.mesh.points.length : -1;
        if (st.deform && (n < 0 || st.deform.some((k) => k.value.length !== n))) delete st.deform;
      }
    }
    if (an.constraints) for (const id of Object.keys(an.constraints)) if (!constraintIds.has(id)) delete an.constraints[id];
    if (an.drawOrder) {
      for (const k of an.drawOrder) {
        const seen = new Set<string>();
        const order = k.order.filter((id) => attIds.has(id) && !seen.has(id) && seen.add(id));
        // Attachments added after the key was written go on top, in setup order.
        for (const a of p.attachments) if (!seen.has(a.id)) order.push(a.id);
        k.order = order;
      }
    }
  }
  return notes;
}
