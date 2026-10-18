// Guided flat-art onboarding (RV-012): the steps from one flat character image to a first
// idle, and the few one-step operations the guide adds on top of the existing tools
// (cutout dialog, mesh grid, auto weights). Progress is *derived from the project* —
// nothing is stored — so undo, autosave/reload recovery and old files need no migration:
// undoing a step simply shows it as not done again.
// The step texts carry the RV-010 real-art findings (docs/RV010-CUTOUT-SHORTFALLS.md).
import { autoWeights, gridPoints, meshProblem, setMesh, triangulate } from './meshOps.ts';
import { makeBone, uniqueName } from './ops.ts';
import { attachmentWorld, computeWorld, isAncestorOrSelf } from './skeleton.ts';
import type { Animation, Attachment, ImageAsset, Project } from './types.ts';

export type GuideStepId = 'import' | 'rig' | 'clean' | 'limbs' | 'colour' | 'mesh' | 'idle';

export interface GuideStep {
  id: GuideStepId;
  title: string;
  done: boolean;
  optional: boolean;
  /** What is there now (counts, names) — shown under the step. */
  detail: string;
}

const PIECE_KINDS = new Set(['cutout', 'extension']);
const isPiece = (im: ImageAsset | undefined) => !!im?.derived && PIECE_KINDS.has(im.derived.kind);

/** The attachment that holds the flat art (the original image or what is left of it after cuts). */
export function guideArt(p: Project): { att: Attachment; im: ImageAsset } | null {
  for (const att of p.attachments) {
    const im = p.images.find((i) => i.id === att.imageId);
    if (im && !isPiece(im)) return { att, im };
  }
  return null;
}

/** The images an image was derived from, nearest first (cycle-safe). */
function lineage(p: Project, im: ImageAsset): ImageAsset[] {
  const out: ImageAsset[] = [];
  const seen = new Set<string>([im.id]);
  let cur: ImageAsset | undefined = im;
  while (cur?.derived) {
    const src = p.images.find((i) => i.id === cur!.derived!.sourceId);
    if (!src || seen.has(src.id)) break;
    seen.add(src.id);
    out.push(src);
    cur = src;
  }
  return out;
}

/** Cut pieces in the project: polygon (outline) cuts and colour-selection cuts. */
export function guidePieces(p: Project): { limbs: Attachment[]; colour: Attachment[] } {
  const limbs: Attachment[] = [], colour: Attachment[] = [];
  for (const a of p.attachments) {
    const im = p.images.find((i) => i.id === a.imageId);
    if (!isPiece(im)) continue;
    (im!.derived!.polygon?.length ? limbs : colour).push(a);
  }
  return { limbs, colour };
}

const keyCount = (an: Animation) => Object.values(an.tracks).reduce((n, t) => n + t.translate.length + t.rotate.length + t.scale.length, 0);

export function guideSteps(p: Project): GuideStep[] {
  const originals = p.images.filter((i) => !i.derived);
  const art = guideArt(p);
  const bone = art?.att.boneId ? p.bones.find((b) => b.id === art.att.boneId) : undefined;
  const cleaned = !!art && [art.im, ...lineage(p, art.im)].some((i) => i.derived?.kind === 'cleanup');
  const { limbs, colour } = guidePieces(p);
  const mesh = art?.att.mesh;
  const idle = p.animations.find((a) => keyCount(a) > 0);
  const names = (as: Attachment[]) => as.map((a) => a.name).join(', ');
  return [
    { id: 'import', title: 'Import the flat art (one PNG of the whole character)', optional: false, done: originals.length > 0, detail: originals.length ? `${originals.map((i) => `${i.name} ${i.width}×${i.height}`).join(', ')}` : 'No image yet.' },
    { id: 'rig', title: 'Root bone with the art attached', optional: false, done: !!art && !!bone, detail: art && bone ? `“${art.att.name}” on bone “${bone.name}”.` : art ? `“${art.att.name}” is not on a bone.` : 'Nothing attached yet.' },
    { id: 'clean', title: 'Remove faint specks', optional: true, done: cleaned, detail: cleaned ? `${art!.att.name} uses a cleaned copy (the original is kept).` : 'Optional. Strays far from the art would otherwise ride along with whatever piece you cut around them.' },
    { id: 'limbs', title: 'Cut the limbs: outline, pivot at the joint, joint extension', optional: false, done: limbs.length > 0, detail: limbs.length ? `${limbs.length} outline cut(s): ${names(limbs)}.` : 'No limb cut yet.' },
    { id: 'colour', title: 'Cut hands or feet by colour', optional: true, done: colour.length > 0, detail: colour.length ? `${colour.length} colour cut(s): ${names(colour)}.` : 'Optional.' },
    { id: 'mesh', title: 'Bend the body: grid mesh + auto weights', optional: false, done: !!mesh?.weights, detail: mesh ? `${mesh.points.length / 2} vertices${mesh.weights ? ', weighted' : ', not weighted yet'}.` : 'The body is a flat image.' },
    { id: 'idle', title: 'First idle', optional: false, done: !!idle, detail: idle ? `“${idle.name}” (${idle.duration} s, ${keyCount(idle)} keys). Press Play, then edit its keys.` : 'No animation with keys yet.' },
  ];
}

/** Root bone + attach the art to it, centred on the bone (one undo step for the caller). */
export function startRig(p: Project, imageId: string, ids: { bone: string; att: string }, at: { x: number; y: number }): void {
  const im = p.images.find((i) => i.id === imageId);
  if (!im) throw new Error('The image no longer exists.');
  const art = guideArt(p);
  let boneId = p.bones.find((b) => b.parentId === null)?.id;
  if (!boneId) {
    p.bones.push(makeBone(ids.bone, uniqueName(p.bones.map((b) => b.name), 'root'), null, Math.round(at.x), Math.round(at.y), 0, 60));
    boneId = ids.bone;
  }
  if (art) {
    art.att.boneId = boneId;
    art.att.x = art.att.y = art.att.rotation = 0;
    return;
  }
  p.attachments.push({ id: ids.att, name: uniqueName(p.attachments.map((a) => a.name), im.name.replace(/\.[a-z0-9]+$/i, '')), boneId, imageId, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
}

/**
 * Grid mesh on the art (image rectangle + an even interior grid) weighted to its bone and
 * every bone below it — the same as Create mesh… → Fill grid, then Auto weights.
 */
export function meshArt(p: Project, attId: string, cols: number, rows: number): { vertices: number; bones: string[] } {
  const att = p.attachments.find((a) => a.id === attId);
  const im = att && p.images.find((i) => i.id === att.imageId);
  if (!att || !im) throw new Error('The art attachment no longer exists.');
  if (!att.boneId) throw new Error('Attach the art to a bone first.');
  const g = gridPoints(im.width, im.height, cols, rows);
  const problem = meshProblem(g.hull, g.interior, im);
  if (problem) throw new Error(problem);
  setMesh(p, attId, triangulate(g.hull, g.interior));
  const bones = p.bones.filter((b) => isAncestorOrSelf(p.bones, att.boneId!, b.id)).map((b) => b.id);
  att.mesh!.weights = autoWeights(p, att, bones);
  return { vertices: att.mesh!.points.length / 2, bones: bones.map((id) => p.bones.find((b) => b.id === id)!.name) };
}

/**
 * A 2-second looping starter idle: the root breathes (a small bob, 1 % of the art's
 * height) and every bone that *starts above the art's centre line* sways ±3° in
 * alternating directions. Lower bones (legs) stay planted. Smooth (eased) keys.
 */
export function firstIdle(p: Project, id: string): { name: string; swaying: string[] } {
  const art = guideArt(p);
  const root = p.bones.find((b) => b.id === art?.att.boneId) ?? p.bones.find((b) => b.parentId === null);
  if (!root) throw new Error('Create the root bone first.');
  const world = computeWorld(p.bones);
  const centreY = art ? attachmentWorld(art.att, world).ty : world.get(root.id)!.ty;
  const amp = Math.max(1, Math.round((art?.im.height ?? 100) * 0.01));
  const k = (time: number, value: number[]) => ({ time, value, interp: 'smooth' as const });
  const tracks: Animation['tracks'] = {
    [root.id]: { translate: [k(0, [root.x, root.y]), k(1, [root.x, root.y + amp]), k(2, [root.x, root.y])], rotate: [], scale: [] },
  };
  const swaying: string[] = [];
  for (const b of p.bones) {
    if (b.id === root.id || world.get(b.id)!.ty > centreY) continue;
    const d = swaying.length % 2 ? -3 : 3;
    swaying.push(b.name);
    tracks[b.id] = { translate: [], rotate: [k(0, [b.rotation]), k(1, [b.rotation + d]), k(2, [b.rotation])], scale: [] };
  }
  const name = uniqueName(p.animations.map((a) => a.name), 'idle');
  p.animations.push({ id, name, duration: 2, fps: 30, loop: true, tracks });
  return { name, swaying };
}
