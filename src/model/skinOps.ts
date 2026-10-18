// Skin (attachment set) operations and validation. Pure; the editor wraps each call in
// one undoable mutation. See SkinEntry for the replacement rule.
import { uniqueName } from './ops.ts';
import type { Project, Skin } from './types.ts';

export function addSkin(project: Project, id: string, name = 'skin'): Skin {
  const skin: Skin = { id, name: uniqueName((project.skins ?? []).map((s) => s.name), name), entries: [] };
  (project.skins ??= []).push(skin);
  return skin;
}

export function duplicateSkin(project: Project, skinId: string, id: string): Skin | null {
  const src = project.skins?.find((s) => s.id === skinId);
  if (!src) return null;
  const copy: Skin = { id, name: uniqueName(project.skins!.map((s) => s.name), `${src.name}-copy`), entries: src.entries.map((e) => ({ ...e })) };
  project.skins!.push(copy);
  return copy;
}

/** Renames a skin; returns an error message (name taken / empty) or null. */
export function renameSkin(project: Project, skinId: string, name: string): string | null {
  const n = name.trim();
  if (!n) return 'A skin needs a name.';
  if (project.skins?.some((s) => s.id !== skinId && s.name === n)) return `A skin named “${n}” already exists.`;
  const s = project.skins?.find((x) => x.id === skinId);
  if (s) s.name = n;
  return null;
}

export function deleteSkin(project: Project, skinId: string): void {
  if (!project.skins) return;
  project.skins = project.skins.filter((s) => s.id !== skinId);
}

/**
 * Sets (imageId) or clears (null) the replacement for one attachment in one skin.
 * `from` null = the attachment's setup image; otherwise a keyed image.
 */
export function setSkinEntry(project: Project, skinId: string, attachmentId: string, from: string | null, imageId: string | null): void {
  const s = project.skins?.find((x) => x.id === skinId);
  const att = project.attachments.find((a) => a.id === attachmentId);
  if (!s || !att) return;
  const f = from && from !== att.imageId ? from : undefined;
  s.entries = s.entries.filter((e) => !(e.attachmentId === attachmentId && (e.from ?? undefined) === f));
  if (imageId) s.entries.push(f ? { attachmentId, imageId, from: f } : { attachmentId, imageId });
}

/** The image a skin shows for an attachment when it would show `shown` (null = no entry). */
export function skinReplacement(project: Project, skinId: string, attachmentId: string, shown: string): string | null {
  const s = project.skins?.find((x) => x.id === skinId);
  const att = project.attachments.find((a) => a.id === attachmentId);
  if (!s || !att) return null;
  return s.entries.find((e) => e.attachmentId === attachmentId && (e.from ?? att.imageId) === shown)?.imageId ?? null;
}

/** Images an attachment can show without a skin: its setup image, then keyed images (first use order). */
export function attachmentImages(project: Project, attachmentId: string): string[] {
  const att = project.attachments.find((a) => a.id === attachmentId);
  if (!att) return [];
  const out = [att.imageId];
  for (const an of project.animations) for (const k of an.slots?.[attachmentId]?.image ?? []) if (!out.includes(k.imageId)) out.push(k.imageId);
  return out;
}

export interface SkinDiagnostic {
  level: 'warning' | 'info';
  skin: string;
  message: string;
}

/**
 * Asset validation for skins: replacements that will look different from the image they
 * stand in for (size / aspect, especially on meshes, whose geometry stays fixed while the
 * texture stretches), redundant and unreachable entries, empty skins, and images shared
 * between skins (safe: images are immutable and shared by reference).
 */
export function skinDiagnostics(project: Project): SkinDiagnostic[] {
  const out: SkinDiagnostic[] = [];
  const im = new Map(project.images.map((i) => [i.id, i]));
  const name = (id: string) => im.get(id)?.name ?? id;
  const users = new Map<string, Set<string>>();
  for (const s of project.skins ?? []) {
    if (!s.entries.length) out.push({ level: 'info', skin: s.name, message: 'Empty: every attachment shows its default image.' });
    for (const e of s.entries) {
      const att = project.attachments.find((a) => a.id === e.attachmentId);
      if (!att) continue;
      const from = e.from ?? att.imageId;
      const a = im.get(from), b = im.get(e.imageId);
      (users.get(e.imageId) ?? users.set(e.imageId, new Set()).get(e.imageId)!).add(s.name);
      if (!a || !b) continue;
      if (e.imageId === from) {
        out.push({ level: 'info', skin: s.name, message: `${att.name}: replaces ${a.name} with itself (no effect).` });
        continue;
      }
      if (e.from && !attachmentImages(project, att.id).includes(e.from)) out.push({ level: 'info', skin: s.name, message: `${att.name}: no animation shows ${a.name}, so its replacement is never used.` });
      const ra = a.width / a.height, rb = b.width / b.height;
      if (Math.abs(ra / rb - 1) > 0.02) {
        out.push({ level: 'warning', skin: s.name, message: att.mesh
          ? `${att.name}: ${b.name} (${b.width}×${b.height}) has a different aspect ratio from ${a.name} (${a.width}×${a.height}); on this mesh it will stretch.`
          : `${att.name}: ${b.name} (${b.width}×${b.height}) has a different aspect ratio from ${a.name} (${a.width}×${a.height}).` });
      } else if (b.width !== a.width || b.height !== a.height) {
        out.push({ level: 'info', skin: s.name, message: att.mesh
          ? `${att.name}: ${b.name} is ${b.width}×${b.height} vs ${a.width}×${a.height}; the mesh keeps its shape and samples it at scale.`
          : `${att.name}: ${b.name} is ${b.width}×${b.height} vs ${a.width}×${a.height}; it draws at its own size.` });
      }
    }
  }
  for (const [id, skins] of users) if (skins.size > 1) out.push({ level: 'info', skin: [...skins].join(', '), message: `${name(id)} is shared by ${skins.size} skins (safe: images are never modified).` });
  return out;
}
