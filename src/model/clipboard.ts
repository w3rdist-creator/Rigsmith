// Durable, cross-project key clipboard (RV-009). Copied keys are stored with the *names*
// of everything they reference (bone, attachment, constraint, image), so they survive a
// reload (the editor keeps them in IndexedDB) and can be pasted into another project.
// At paste time each lane resolves to the object with the same id *and* name (same
// project), else to the unique object with that name; lanes and image keys that do not
// resolve are dropped and reported, never guessed.
import type { KeyClipboard, TimedKey } from './keys.ts';
import { DRAW_LANE, boneLane, constraintLane, parseLane, slotLane } from './keys.ts';
import type { DrawOrderKey, ImageKey, Project } from './types.ts';

export interface PortableClipboard {
  format: 'rigsmith.keys';
  version: 1;
  /** Name of the project the keys were copied from. */
  project: string;
  copiedAt: string;
  items: KeyClipboard['items'];
  /** Names of every id the items reference (lanes, image keys, draw-order lists). */
  names: { bones: Record<string, string>; attachments: Record<string, string>; constraints: Record<string, string>; images: Record<string, string> };
}

const constraintList = (p: Project) => [...(p.ik ?? []), ...(p.pathConstraints ?? [])];

export function toPortable(project: Project, clip: KeyClipboard, now = new Date()): PortableClipboard {
  const names: PortableClipboard['names'] = { bones: {}, attachments: {}, constraints: {}, images: {} };
  const att = (id: string) => {
    const a = project.attachments.find((x) => x.id === id);
    if (a) names.attachments[id] = a.name;
  };
  for (const it of clip.items) {
    const info = parseLane(it.lane);
    if (info?.kind === 'bone') {
      const b = project.bones.find((x) => x.id === info.id);
      if (b) names.bones[b.id] = b.name;
    } else if (info?.kind === 'slot') {
      att(info.id);
      if (info.channel === 'image') {
        const im = project.images.find((x) => x.id === (it.key as ImageKey).imageId);
        if (im) names.images[im.id] = im.name;
      }
    } else if (info?.kind === 'constraint') {
      const c = constraintList(project).find((x) => x.id === info.id);
      if (c) names.constraints[c.id] = c.name;
    } else if (info?.kind === 'draw') for (const id of (it.key as DrawOrderKey).order) att(id);
  }
  return { format: 'rigsmith.keys', version: 1, project: project.name, copiedAt: now.toISOString(), items: structuredClone(clip.items), names };
}

/** Validates a stored clipboard record (from IndexedDB); null when unusable. */
export function parsePortable(raw: unknown): PortableClipboard | null {
  const o = raw as PortableClipboard | null;
  if (!o || o.format !== 'rigsmith.keys' || o.version !== 1 || !Array.isArray(o.items) || !o.names || typeof o.names !== 'object') return null;
  for (const k of ['bones', 'attachments', 'constraints', 'images'] as const) if (!o.names[k] || typeof o.names[k] !== 'object') return null;
  const ok = o.items.every((it) => it && typeof it.lane === 'string' && parseLane(it.lane) && Number.isFinite(it.dt) && it.dt >= 0 && it.key && typeof it.key === 'object');
  return ok ? o : null;
}

export interface Resolved {
  clip: KeyClipboard;
  /** Names (with kind) that have no counterpart here; their keys are not pasted. */
  unresolved: string[];
  /** Keys left out because their lane or image did not resolve. */
  dropped: number;
}

/** Maps a portable clipboard onto `project`'s ids (same id + name, else unique name). */
export function resolvePortable(project: Project, pc: PortableClipboard): Resolved {
  const unresolved = new Set<string>();
  const resolver = (list: readonly { id: string; name: string }[], names: Record<string, string>, kind: string) => (id: string): string | null => {
    const name = names[id];
    if (name === undefined) return list.some((x) => x.id === id) ? id : null;
    if (list.some((x) => x.id === id && x.name === name)) return id;
    const hits = list.filter((x) => x.name === name);
    if (hits.length === 1) return hits[0].id;
    unresolved.add(`${kind} “${name}”${hits.length > 1 ? ' (ambiguous)' : ''}`);
    return null;
  };
  const bone = resolver(project.bones, pc.names.bones, 'bone');
  const att = resolver(project.attachments, pc.names.attachments, 'attachment');
  const con = resolver(constraintList(project), pc.names.constraints, 'constraint');
  const img = resolver(project.images, pc.names.images, 'image');
  const items: KeyClipboard['items'] = [];
  let dropped = 0;
  for (const it of pc.items) {
    const info = parseLane(it.lane);
    let lane: string | null = null;
    let key: TimedKey = structuredClone(it.key);
    if (info?.kind === 'bone') {
      const id = bone(info.id);
      lane = id && boneLane(id, info.channel);
    } else if (info?.kind === 'slot') {
      const id = att(info.id);
      lane = id && slotLane(id, info.channel);
      if (lane && info.channel === 'image') {
        const im = img((key as ImageKey).imageId);
        if (im) (key as ImageKey).imageId = im;
        else lane = null;
      }
    } else if (info?.kind === 'constraint') {
      const id = con(info.id);
      lane = id && constraintLane(id, info.channel);
    } else if (info?.kind === 'draw') {
      lane = DRAW_LANE;
      const order = (key as DrawOrderKey).order.flatMap((id) => {
        const r = att(id);
        return r ? [r] : [];
      });
      key = { ...(key as DrawOrderKey), order } as TimedKey;
    }
    if (lane) items.push({ lane, dt: it.dt, key });
    else dropped++;
  }
  return { clip: { items }, unresolved: [...unresolved], dropped };
}

/** "12 key(s) from “wiz”" — for button titles and the status bar. */
export function describePortable(pc: PortableClipboard): string {
  return `${pc.items.length} key(s) copied from “${pc.project}”`;
}
