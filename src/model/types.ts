// Rigsmith project format, version 1. See docs/architecture.md#project-format.

export const FORMAT_ID = 'rigsmith.project';
export const FORMAT_VERSION = 1;

export interface Bone {
  id: string;
  name: string;
  /** null = root bone (parented to world). */
  parentId: string | null;
  /** Setup pose, local to the parent bone. Rotation in degrees, clockwise on screen. */
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** Visual length along the bone's local +x axis. */
  length: number;
  color: string;
}

export interface ImageAsset {
  id: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  /** base64 data: URL — the image bytes travel inside the project file. */
  dataUrl: string;
}

export interface Attachment {
  id: string;
  name: string;
  /** Bone the image follows; null = placed in world space. */
  boneId: string | null;
  imageId: string;
  /** Offset relative to the bone (image is centred on this point). */
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
}

export type Interp = 'linear' | 'step' | 'smooth';
export const INTERPS: readonly Interp[] = ['linear', 'step', 'smooth'];

export type Channel = 'translate' | 'rotate' | 'scale';
export const CHANNELS: readonly Channel[] = ['translate', 'rotate', 'scale'];
/** Number of values stored per key for each channel. */
export const CHANNEL_ARITY: Record<Channel, number> = { translate: 2, rotate: 1, scale: 2 };

export interface Key {
  /** Seconds from animation start (independent of fps). */
  time: number;
  /** translate: [x, y]; rotate: [degrees]; scale: [sx, sy]. Absolute local values. */
  value: number[];
  /** Interpolation used from this key to the next one. */
  interp: Interp;
}

export interface BoneTrack {
  translate: Key[];
  rotate: Key[];
  scale: Key[];
}

export interface Animation {
  id: string;
  name: string;
  /** Seconds. */
  duration: number;
  fps: number;
  loop: boolean;
  /** Keyed by bone id. */
  tracks: Record<string, BoneTrack>;
}

export interface Project {
  format: typeof FORMAT_ID;
  version: typeof FORMAT_VERSION;
  name: string;
  bones: Bone[];
  images: ImageAsset[];
  /** Array order is draw order (first = back). */
  attachments: Attachment[];
  animations: Animation[];
}

export interface LocalPose {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export function emptyProject(name = 'Untitled rig'): Project {
  return { format: FORMAT_ID, version: FORMAT_VERSION, name, bones: [], images: [], attachments: [], animations: [] };
}

export function emptyTrack(): BoneTrack {
  return { translate: [], rotate: [], scale: [] };
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

/**
 * Deep clone of the mutable parts of a project. Image assets are immutable once
 * imported, so they are shared by reference (keeps undo snapshots cheap).
 */
export function cloneProject(p: Project): Project {
  return {
    format: p.format,
    version: p.version,
    name: p.name,
    bones: p.bones.map((b) => ({ ...b })),
    images: p.images.slice(),
    attachments: p.attachments.map((a) => ({ ...a })),
    animations: p.animations.map((an) => ({
      ...an,
      tracks: Object.fromEntries(
        Object.entries(an.tracks).map(([k, t]) => [
          k,
          {
            translate: t.translate.map(cloneKey),
            rotate: t.rotate.map(cloneKey),
            scale: t.scale.map(cloneKey),
          },
        ]),
      ),
    })),
  };
}

function cloneKey(k: Key): Key {
  return { time: k.time, value: k.value.slice(), interp: k.interp };
}
