// Rigsmith project format. Version 1 is the original slice; version 2 is a strict
// superset (curves, slot/draw-order keys, constraints, cutout provenance, meshes,
// skins, mixes). Every v2 field is optional and absent when unused, so a project that
// uses no v2 feature is written — byte for byte — as version 1. See
// docs/architecture.md#project-format.

export const FORMAT_ID = 'rigsmith.project';
/** Newest version this editor reads and writes. */
export const FORMAT_VERSION = 3;
export type FormatVersion = 1 | 2 | 3;

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
  /**
   * v3: what the bone takes from its parent besides position (absent = everything). A
   * flag set to false drops that part of the parent's transform (see inheritedLinear).
   * Written only when a flag is false.
   */
  inherit?: BoneInherit;
}

export interface BoneInherit {
  rotation: boolean;
  scale: boolean;
  reflection: boolean;
}

/** How a derived image was produced from another one (v2, cutout tools). */
export interface DerivedImage {
  kind: 'cutout' | 'remainder' | 'patch' | 'extension' | 'cleanup';
  /** Image the pixels came from (never modified). */
  sourceId: string;
  /** Top-left of this image inside the source, in source pixels. */
  offsetX: number;
  offsetY: number;
  /** Mask polygon in source pixels [x0,y0,x1,y1,…] (cutout/remainder/patch). */
  polygon?: number[];
  /** Pixels that were synthesized rather than copied (extension/patch). */
  synthesized: number;
  note?: string;
}

export interface ImageAsset {
  id: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  /** base64 data: URL — the image bytes travel inside the project file. */
  dataUrl: string;
  derived?: DerivedImage;
}

/** Per-vertex bone influences (normalized so weights sum to 1). */
export type VertexWeights = { bone: string; w: number }[];

/** Textured triangle mesh on an image attachment (v2). */
export interface Mesh {
  /** Vertex positions in image pixel space [x0,y0,x1,y1,…]; also the texture coordinates. */
  points: number[];
  /** Triangles as vertex index triples. */
  triangles: number[];
  /** The first `hull` vertices, in order, form the outline polygon. */
  hull: number;
  /** Optional skinning: one influence list per vertex. Absent = rigid on the attachment's bone. */
  weights?: VertexWeights[];
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
  /** v2: hidden in the setup pose (visibility keys can show it). */
  hidden?: boolean;
  /** v2: textured mesh instead of a flat quad. */
  mesh?: Mesh;
}

export type Interp = 'linear' | 'step' | 'smooth' | 'bezier';
export const INTERPS: readonly Interp[] = ['linear', 'step', 'smooth', 'bezier'];
/** Cubic Bezier easing handles [x1, y1, x2, y2]; x in [0, 1], y unbounded (overshoot). */
export type Curve = [number, number, number, number];

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
  /** v2: present iff interp === 'bezier'. */
  curve?: Curve;
}

export interface BoneTrack {
  translate: Key[];
  rotate: Key[];
  scale: Key[];
}

/** v2: image key — the attachment shows `imageId` from this time on (always stepped). */
export interface ImageKey {
  time: number;
  imageId: string;
}

/** v2: draw-order key — attachment ids back→front from this time on (stepped). */
export interface DrawOrderKey {
  time: number;
  order: string[];
}

/** v2: animated attachment ("slot") properties. */
export interface SlotTrack {
  /** value [1] shown / [0] hidden; always stepped. */
  visible?: Key[];
  /** value [opacity 0..1]. */
  opacity?: Key[];
  image?: ImageKey[];
  /** Mesh deform: value = per-vertex offsets [dx0,dy0,…] in image pixels. */
  deform?: Key[];
}

/** v2: animated constraint properties. */
export interface ConstraintTrack {
  /** value [mix 0..1]. */
  mix?: Key[];
  /** Path constraints: value [position 0..1 along the path]. */
  position?: Key[];
  /** v3 transform constraints: value [angle, degrees] (see TransformConstraint.angle). */
  angle?: Key[];
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
  /** v2: keyed by attachment id. */
  slots?: Record<string, SlotTrack>;
  /** v2 */
  drawOrder?: DrawOrderKey[];
  /** v2: keyed by IK or path constraint id. */
  constraints?: Record<string, ConstraintTrack>;
}

/** v2: one- or two-bone IK. bones = [bone] or [parent, child]; target is any other bone. */
export interface IkConstraint {
  id: string;
  name: string;
  bones: string[];
  target: string;
  mix: number;
  /** Bend direction of a two-bone chain (+1 = clockwise elbow on screen). */
  bendPositive: boolean;
}

/** v2: a cubic Bezier path. Handles are relative to their node. */
export interface PathNode {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

export interface PathShape {
  id: string;
  name: string;
  /** Path coordinates are in this bone's space (null = world). */
  boneId: string | null;
  closed: boolean;
  nodes: PathNode[];
}

/** v2: places bones along a path, spaced by arc length. */
export interface PathConstraint {
  id: string;
  name: string;
  pathId: string;
  bones: string[];
  /** 0..1 fraction of the path length where the first bone sits. */
  position: number;
  /** Arc-length distance between consecutive bones, world px. */
  spacing: number;
  /** 0..1: how much bones adopt the path position/tangent. */
  mix: number;
  /** Rotate bones to the path tangent (plus this offset, degrees). */
  rotate: boolean;
  rotateOffset: number;
}

/**
 * v3: sets one bone's rotation from the rig instead of keys (applied after IK and paths).
 * - `rotation`: local rotation = angle + factor · bend(source), where bend is the source
 *   bone's world angle minus its parent's (wrapped to ±180°): e.g. a joint helper that takes
 *   half the elbow's bend. With `mitre`, local scaleY = min(max, 1 + (sec(|bend|/2) − 1)·k),
 *   so a joint's cross-section keeps its volume.
 * - `aim`: world angle = angle (+ relativeTo's world angle): a prop held at a fixed screen
 *   angle while the hand moves.
 * mix blends rotation (and the mitre scale) from the keyed pose (0) to the constrained one (1).
 */
export interface TransformConstraint {
  id: string;
  name: string;
  kind: 'rotation' | 'aim';
  bone: string;
  /** rotation: the bone whose bend is copied. */
  source?: string;
  /** rotation: fraction of the bend. */
  factor: number;
  /** aim: angles are relative to this bone's world angle (null = screen). */
  relativeTo?: string | null;
  /** rotation: offset added to the copied bend; aim: the held world angle (degrees). */
  angle: number;
  /** rotation: scale the bone's local y toward the mitre length of the bend. */
  mitre?: { k: number; max: number };
  mix: number;
}

/**
 * v2: an attachment set. While the skin is active, an entry replaces the image an
 * attachment shows: without `from` it replaces the attachment's setup image (wherever
 * that image is shown, including via image keys); with `from` it replaces that keyed
 * image on that attachment.
 */
export interface SkinEntry {
  attachmentId: string;
  imageId: string;
  from?: string;
}
export interface Skin {
  id: string;
  name: string;
  entries: SkinEntry[];
}

/** v2: default crossfade duration between two animations. */
export interface MixRule {
  from: string;
  to: string;
  duration: number;
}

/** v2: one clip of a saved sequence, played `repeat` times back to back. */
export interface SequenceStep {
  animId: string;
  /** Whole number of plays, 1..SEQUENCE_MAX_REPEAT. */
  repeat: number;
}

/**
 * v2: a saved clip sequence (ordered steps). Transitions between consecutive steps use
 * the stored mix rules (`Project.mixes`), the same durations the Mix dialog edits.
 */
export interface ClipSequence {
  id: string;
  name: string;
  steps: SequenceStep[];
  /** Exported animated files loop forever (else they play once). */
  loop: boolean;
}

export const SEQUENCE_MAX_REPEAT = 100;

export interface Project {
  format: typeof FORMAT_ID;
  version: FormatVersion;
  name: string;
  bones: Bone[];
  images: ImageAsset[];
  /** Array order is draw order (first = back). */
  attachments: Attachment[];
  animations: Animation[];
  ik?: IkConstraint[];
  paths?: PathShape[];
  pathConstraints?: PathConstraint[];
  /** v3 */
  transformConstraints?: TransformConstraint[];
  skins?: Skin[];
  mixes?: MixRule[];
  /** v2: saved clip sequences. */
  sequences?: ClipSequence[];
  /** Fixed delivery frame for exports (v2; absent = each export fits its animation). */
  frame?: ProjectFrame;
}

/**
 * A fixed export canvas in world units: the rectangle from (x, y) (its top-left world
 * point, which maps to pixel 0,0) spanning width × height. Exports that use it render
 * width·scale × height·scale pixels and clip art outside it.
 */
/** Largest project-frame side in world units (exports also cap pixels per side). */
export const FRAME_MAX_SIDE = 8192;

export interface ProjectFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LocalPose {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export function emptyProject(name = 'Untitled rig'): Project {
  return { format: FORMAT_ID, version: 1, name, bones: [], images: [], attachments: [], animations: [] };
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
 * Deep clone of the mutable parts of a project (undo snapshots). Image assets are
 * immutable once imported, so they are shared by reference (keeps snapshots cheap);
 * everything else — including every v2 nested field — is cloned generically.
 */
export function cloneProject(p: Project): Project {
  const { images, ...rest } = p;
  const copy = structuredClone(rest) as Omit<Project, 'images'>;
  return { ...copy, images: images.slice() };
}
