// R10 view sets: a head (or any part) painted in several views — front, 3/4 — of one design,
// switched by art swap rather than by warping one painting. A view set names a bone and its
// views; the first view is the base (shown in setup), each other view is one painted
// attachment registered onto the base's alpha extent. Switching is baked into ordinary
// stepped slot keys (visibility, eye images), so every exporter already plays it; the set
// itself is authoring metadata. Swaps are meant to land on a blink: the closed-eye frame hides
// the cut, and the new view opens its eyes over the next frames.
import { setKey, snapToFrame } from './animation.ts';
import { evaluate } from './evaluate.ts';
import type { Mat } from './math.ts';
import { apply, decompose, invert, multiply } from './math.ts';
import { dataUrlBytes, decodePngExact } from './png.ts';
import { keySlotImage, slotValues } from './rigOps.ts';
import type { Animation, Attachment, Project, View, ViewEyes, ViewSet } from './types.ts';

/** Pixels with alpha above this count toward an image's painted extent. */
export const VIEW_ALPHA_MIN = 24;

export interface PaintedViewImages {
  open: string;
  half?: string;
  closed?: string;
}

export interface PaintedViewFit {
  /** Which axis of the base extent the new view's painted extent matches. */
  fit?: 'height' | 'width';
  /** Multiplies the fitted size (a 3/4 head is often a little smaller than the front). */
  scale?: number;
  /** bottom = the chin on the base's bottom line; center = centres coincide. Both centre x. */
  anchor?: 'bottom' | 'center';
  /** Extra world-space nudge after registration. */
  dx?: number;
  dy?: number;
}

export interface Extent {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'view';

function freshId(taken: (id: string) => boolean, base: string): string {
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}_${i}`)) return `${base}_${i}`;
}

function allViewIds(project: Project): Set<string> {
  return new Set((project.viewSets ?? []).flatMap((s) => s.views.map((v) => v.id)));
}

export function viewSet(project: Project, setId: string): ViewSet {
  const s = project.viewSets?.find((v) => v.id === setId || v.name === setId);
  if (!s) throw new Error(`no view set "${setId}"`);
  return s;
}

export function viewOf(set: ViewSet, viewId: string): View {
  const v = set.views.find((x) => x.id === viewId || x.name === viewId);
  if (!v) throw new Error(`view set "${set.name}" has no view "${viewId}"`);
  return v;
}

/** The view set (if any) a bone owns. */
export function viewSetForBone(project: Project, boneId: string): ViewSet | undefined {
  return project.viewSets?.find((s) => s.boneId === boneId);
}

/**
 * A view set on `boneId` whose base view is `baseAttachmentIds` (default: every attachment
 * on the bone, in draw order). The base attachments keep their setup visibility.
 */
export function createViewSet(project: Project, boneId: string, name: string, baseAttachmentIds?: string[]): ViewSet {
  if (!project.bones.some((b) => b.id === boneId)) throw new Error(`no bone "${boneId}"`);
  if (viewSetForBone(project, boneId)) throw new Error(`bone "${boneId}" already has a view set`);
  const ids = baseAttachmentIds ?? project.attachments.filter((a) => a.boneId === boneId).map((a) => a.id);
  if (!ids.length) throw new Error(`bone "${boneId}" has no attachments to make the base view from`);
  for (const id of ids) if (!project.attachments.some((a) => a.id === id)) throw new Error(`no attachment "${id}"`);
  if (new Set(ids).size !== ids.length) throw new Error('an attachment is listed twice');
  const sets = (project.viewSets ??= []);
  const viewIds = allViewIds(project);
  const set: ViewSet = {
    id: freshId((id) => sets.some((s) => s.id === id), `vs_${slug(name)}`),
    name: name.trim() || 'views',
    boneId,
    views: [{ id: freshId((id) => viewIds.has(id), `view_${slug(name)}_base`), name: 'base', attachments: ids.slice() }],
  };
  sets.push(set);
  return set;
}

type Alpha = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };

/** Pixel box of the painted (alpha > VIEW_ALPHA_MIN) area, or null for a blank image. */
export function alphaBox(im: Alpha): Extent | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < im.height; y++)
    for (let x = 0; x < im.width; x++)
      if (im.data[(y * im.width + x) * 4 + 3] > VIEW_ALPHA_MIN) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x + 1 > x1) x1 = x + 1;
        if (y + 1 > y1) y1 = y + 1;
      }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

async function decodeImage(project: Project, imageId: string): Promise<Alpha> {
  const im = project.images.find((i) => i.id === imageId);
  if (!im) throw new Error(`no image "${imageId}"`);
  return decodePngExact(dataUrlBytes(im.dataUrl));
}

/** World-space box of the painted pixels of `attIds` at the setup pose (meshes use their quad). */
export async function setupAlphaExtent(project: Project, attIds: readonly string[]): Promise<Extent> {
  const rest = evaluate(project, null, 0);
  const out: Extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const id of attIds) {
    const fa = rest.attachments.find((f) => f.att.id === id);
    if (!fa) continue;
    const im = await decodeImage(project, fa.att.imageId);
    const b = alphaBox(im);
    if (!b) continue;
    for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) {
      const w = apply(fa.world, { x: x - im.width / 2, y: y - im.height / 2 });
      out.x0 = Math.min(out.x0, w.x); out.x1 = Math.max(out.x1, w.x);
      out.y0 = Math.min(out.y0, w.y); out.y1 = Math.max(out.y1, w.y);
    }
  }
  if (!Number.isFinite(out.x0)) throw new Error('the base view has no painted pixels');
  return out;
}

/** Index in `order` just above the topmost of `ids` (ids missing from `order` are ignored). */
function aboveTopmost(order: readonly string[], ids: readonly string[]): number {
  let top = -1;
  for (const id of ids) top = Math.max(top, order.indexOf(id));
  return top < 0 ? order.length : top + 1;
}

/**
 * Adds a painted view: ONE new attachment on the set's bone showing `images.open`, hidden in
 * setup, sized so its painted extent matches the base view's (fit axis × scale) and placed by
 * `anchor`, drawn just above the base view's topmost attachment — in the attachment list and
 * in every animation's draw-order keys (a key that omits it would push it to the very top).
 * With `half`/`closed`, the view's eyes are set to blink on its own attachment.
 */
export async function addPaintedView(project: Project, setId: string, name: string, images: PaintedViewImages, o: PaintedViewFit = {}): Promise<{ view: View; attachment: Attachment }> {
  const set = viewSet(project, setId);
  const label = name.trim();
  if (!label) throw new Error('a view needs a name');
  if (set.views.some((v) => v.name === label)) throw new Error(`view set "${set.name}" already has a view "${label}"`);
  for (const k of ['open', 'half', 'closed'] as const) {
    const id = images[k];
    if (id !== undefined && !project.images.some((i) => i.id === id)) throw new Error(`no image "${id}" (${k})`);
  }
  const scale = o.scale ?? 1;
  if (!(scale > 0)) throw new Error('scale must be above 0');
  const base = set.views[0];
  const ext = await setupAlphaExtent(project, base.attachments);
  const im = await decodeImage(project, images.open);
  const box = alphaBox(im);
  if (!box) throw new Error(`image "${images.open}" is blank`);
  const fit = o.fit ?? 'height';
  const px = fit === 'width' ? ((ext.x1 - ext.x0) / (box.x1 - box.x0)) * scale : ((ext.y1 - ext.y0) / (box.y1 - box.y0)) * scale;
  // World point the painted box's anchor lands on, and the image centre that puts it there.
  const cx = (ext.x0 + ext.x1) / 2 + (o.dx ?? 0);
  const ay = (o.anchor ?? 'bottom') === 'bottom' ? ext.y1 : (ext.y0 + ext.y1) / 2;
  const boxAy = (o.anchor ?? 'bottom') === 'bottom' ? box.y1 : (box.y0 + box.y1) / 2;
  const centre = { x: cx - ((box.x0 + box.x1) / 2 - im.width / 2) * px, y: ay + (o.dy ?? 0) - (boxAy - im.height / 2) * px };
  const want: Mat = { a: px, b: 0, c: 0, d: px, tx: centre.x, ty: centre.y };
  const bone = evaluate(project, null, 0).world.get(set.boneId)!;
  const local = decompose(multiply(invert(bone), want));
  const viewIds = allViewIds(project);
  const attId = freshId((id) => project.attachments.some((a) => a.id === id), `att_${slug(set.name)}_${slug(label)}`);
  const att: Attachment = { id: attId, name: `${set.name} ${label}`, boneId: set.boneId, imageId: images.open, x: local.x, y: local.y, rotation: local.rotation, scaleX: local.scaleX, scaleY: local.scaleY, opacity: 1, hidden: true };
  const list = project.attachments.map((a) => a.id);
  project.attachments.splice(aboveTopmost(list, base.attachments), 0, att);
  for (const an of project.animations) for (const k of an.drawOrder ?? []) k.order.splice(aboveTopmost(k.order, base.attachments), 0, attId);
  const view: View = { id: freshId((id) => viewIds.has(id), `view_${slug(set.name)}_${slug(label)}`), name: label, attachments: [attId] };
  if (images.closed) view.eyes = { attachment: attId, open: images.open, closed: images.closed, ...(images.half ? { half: images.half } : {}) };
  set.views.push(view);
  return { view, attachment: att };
}

/** Names the attachment and images that blink for a view (open → half → closed). */
export function setEyes(project: Project, setId: string, viewId: string, eyes: ViewEyes): View {
  const set = viewSet(project, setId);
  const view = viewOf(set, viewId);
  if (!view.attachments.includes(eyes.attachment)) throw new Error(`attachment "${eyes.attachment}" is not part of view "${view.name}"`);
  for (const k of ['open', 'half', 'closed'] as const) {
    const id = eyes[k];
    if (id !== undefined && !project.images.some((i) => i.id === id)) throw new Error(`no image "${id}" (${k})`);
  }
  view.eyes = { attachment: eyes.attachment, open: eyes.open, ...(eyes.half !== undefined ? { half: eyes.half } : {}), closed: eyes.closed };
  return view;
}

const att = (project: Project, id: string) => project.attachments.find((a) => a.id === id);

/** The view whose attachments are shown at `time` (the first with a visible attachment), or null. */
export function currentView(project: Project, anim: Animation | null, setId: string, time: number): View | null {
  const set = viewSet(project, setId);
  for (const v of set.views)
    if (v.attachments.some((id) => { const a = att(project, id); return a && slotValues(a, anim, time).visible; })) return v;
  return null;
}

/**
 * Shows `viewId` from `frame` on: stepped visibility keys — its attachments on, every other
 * view's off. A track without keys first gets a key at 0 holding its current state, so earlier
 * frames are unchanged. A view with eyes opens them over the swap: closed at `frame`, half at
 * +2, open at +4 — the later two only where the user has no image key of their own in
 * (frame, frame+4].
 */
export function keyView(project: Project, anim: Animation, setId: string, viewId: string, frame: number): void {
  const set = viewSet(project, setId);
  const target = viewOf(set, viewId);
  const T = (f: number) => snapToFrame(f / anim.fps, anim.fps);
  const t = T(frame);
  for (const v of set.views)
    for (const id of v.attachments) {
      const a = att(project, id);
      if (!a) continue;
      anim.slots ??= {};
      const st = (anim.slots[id] ??= {});
      const keys = (st.visible ??= []);
      if (!keys.length && t > 0) setKey(keys, 0, [slotValues(a, anim, 0).visible ? 1 : 0], 'step');
      setKey(keys, t, [v === target ? 1 : 0], 'step');
    }
  const eyes = target.eyes;
  if (!eyes) return;
  const own = anim.slots?.[eyes.attachment]?.image ?? [];
  const userAfter = own.some((k) => k.time > t + 1e-9 && k.time <= T(frame + 4) + 1e-9);
  keySlotImage(anim, eyes.attachment, t, eyes.closed);
  if (userAfter) return;
  if (eyes.half) keySlotImage(anim, eyes.attachment, T(frame + 2), eyes.half);
  keySlotImage(anim, eyes.attachment, T(frame + 4), eyes.open);
}

/** The first frame ≥ `fromFrame` where the view shown then has its eyes closed, or null. */
export function nextBlink(project: Project, anim: Animation, setId: string, fromFrame: number): number | null {
  const last = Math.round(anim.duration * anim.fps);
  for (let f = Math.max(0, Math.round(fromFrame)); f <= last; f++) {
    const t = f / anim.fps;
    const v = currentView(project, anim, setId, t);
    if (!v?.eyes) continue;
    const a = att(project, v.eyes.attachment);
    if (a && slotValues(a, anim, t).imageId === v.eyes.closed) return f;
  }
  return null;
}

/** keyView at the next blink; returns the frame keyed. */
export function keyViewOnBlink(project: Project, anim: Animation, setId: string, viewId: string, fromFrame: number): number {
  const f = nextBlink(project, anim, setId, fromFrame);
  if (f === null) throw new Error(`no closed-eye frame after f${Math.round(fromFrame)}; key a blink first`);
  keyView(project, anim, setId, viewId, f);
  return f;
}

/** Removes the set's visibility keys with frames in [from, to]; returns how many. */
export function removeViewKeys(project: Project, anim: Animation, setId: string, from: number, to: number): number {
  const set = viewSet(project, setId);
  const t0 = from / anim.fps - 1e-9, t1 = to / anim.fps + 1e-9;
  let n = 0;
  for (const v of set.views)
    for (const id of v.attachments) {
      const st = anim.slots?.[id];
      if (!st?.visible) continue;
      const keep = st.visible.filter((k) => k.time < t0 || k.time > t1);
      n += st.visible.length - keep.length;
      if (keep.length) st.visible = keep;
      else delete st.visible;
    }
  return n;
}

/** Previews a view in setup (no keys): shows its attachments, hides the other views'. */
export function showViewInSetup(project: Project, setId: string, viewId: string): void {
  const set = viewSet(project, setId);
  const target = viewOf(set, viewId);
  for (const v of set.views)
    for (const id of v.attachments) {
      const a = att(project, id);
      if (!a) continue;
      if (v === target) delete a.hidden;
      else a.hidden = true;
    }
}

