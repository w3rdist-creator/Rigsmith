import { colorValueProblem, formatColor, isColor, isWhite, parseColor, setupColor } from './color.ts';
import { emitterProblems } from './emitters.ts';
import { clipProblems } from './masks.ts';
import { EMITTER_MAX_RATE } from './types.ts';
import { springProblems } from './springs.ts';
import { findCycles, hasInheritFlags, isAncestorOrSelf } from './skeleton.ts';
import type {
  Affine,
  Animation,
  Attachment,
  Bone,
  BlendMode,
  BoneTrack,
  ClipSequence,
  ConstraintTrack,
  Curve,
  DerivedImage,
  DrawOrderKey,
  FormatVersion,
  IkConstraint,
  ImageAsset,
  ImageKey,
  Interp,
  Key,
  Mesh,
  MixRule,
  PathConstraint,
  PathNode,
  PathShape,
  Project,
  ProjectFrame,
  SequenceStep,
  Skin,
  SlotTrack,
  TransformConstraint,
  VertexWeights,
  EventKey,
  SpringConstraint,
  View,
  ViewEyes,
  ViewSet,
} from './types.ts';
import { BLEND_MODES, CHANNEL_ARITY, CHANNELS, EVENT_NAME, FORMAT_ID, FORMAT_VERSION, FRAME_MAX_SIDE, INTERPS, SEQUENCE_MAX_REPEAT } from './types.ts';

export type ParseResult = { ok: true; project: Project; warnings: string[] } | { ok: false; errors: string[] };

const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,[A-Za-z0-9+/]+=*$/;
const MAX_ERRORS = 25;

// ---- Writing --------------------------------------------------------------------

/**
 * Lists the v2 features a project uses. Empty ⇒ the project is representable as v1 and
 * is written as v1 (so legacy files re-save byte-identically and stay readable by the
 * original slice). Non-empty ⇒ written as v2, which a v1-only reader rejects.
 */
export function v2Features(p: Project): string[] {
  const f = new Set<string>();
  if (p.ik?.length) f.add('IK constraints');
  if (p.paths?.length || p.pathConstraints?.length) f.add('paths');
  if (p.skins?.length) f.add('skins');
  if (p.mixes?.length) f.add('animation mixes');
  if (p.frame) f.add('project frame');
  if (p.sequences?.length) f.add('clip sequences');
  for (const im of p.images) if (im.derived) f.add('derived images');
  for (const a of p.attachments) {
    if (a.hidden) f.add('hidden attachments');
    if (a.mesh) f.add('meshes');
  }
  for (const an of p.animations) {
    for (const tr of Object.values(an.tracks)) for (const ch of CHANNELS) for (const k of tr[ch]) if (k.interp === 'bezier') f.add('bezier curves');
    if (an.slots && Object.values(an.slots).some((s) => s.visible?.length || s.opacity?.length || s.image?.length || s.deform?.length)) f.add('slot keys');
    if (an.drawOrder?.length) f.add('draw-order keys');
    if (an.constraints && Object.values(an.constraints).some((c) => c.mix?.length || c.position?.length)) f.add('constraint keys');
  }
  return [...f];
}

/** Lists the v3 features a project uses; non-empty ⇒ written as v3, which a v2 reader rejects. */
export function v3Features(p: Project): string[] {
  const f = new Set<string>();
  if (p.bones.some(hasInheritFlags)) f.add('bone inherit flags');
  if (p.transformConstraints?.length) f.add('transform constraints');
  if (p.springs?.length) f.add('springs');
  if (p.viewSets?.length) f.add('view sets');
  for (const a of p.attachments) {
    if (a.blend && a.blend !== 'normal') f.add('blend modes');
    if (a.color && !isWhite(setupColor(a))) f.add('tint colours');
    if (a.emitter) f.add('emitters');
    if (a.clip) f.add('clipping masks');
    if (a.mesh?.alphas) f.add('vertex alpha');
    if (a.mesh?.bind) f.add('mesh bind poses');
  }
  for (const an of p.animations) {
    if (an.constraints && Object.values(an.constraints).some((c) => c.angle?.length)) f.add('constraint angle keys');
    if (an.slots && Object.values(an.slots).some((s) => s.color?.length)) f.add('colour keys');
    if (an.slots && Object.values(an.slots).some((s) => s.rate?.length)) f.add('emitters');
    if (Object.values(an.tracks).some((tr) => tr.translate.some((k) => k.interpY))) f.add('per-axis translate easing');
    if (Object.values(an.events ?? {}).some((ks) => ks.length)) f.add('timeline events');
  }
  return [...f];
}

export function requiredVersion(p: Project): FormatVersion {
  return v3Features(p).length ? 3 : v2Features(p).length ? 2 : 1;
}

const nonEmpty = <T>(xs: T[] | undefined): T[] | undefined => (xs && xs.length ? xs : undefined);

function writeKey(k: Key): Key {
  const out: Key = { time: k.time, value: k.value, interp: k.interp };
  if (k.interp === 'bezier' && k.curve) out.curve = k.curve;
  if (k.interpY) {
    out.interpY = k.interpY;
    if (k.interpY === 'bezier' && k.curveY) out.curveY = k.curveY;
  }
  return out;
}

function writeAnimation(an: Animation): Animation {
  const tracks: Record<string, BoneTrack> = {};
  for (const [id, tr] of Object.entries(an.tracks)) tracks[id] = { translate: tr.translate.map(writeKey), rotate: tr.rotate.map(writeKey), scale: tr.scale.map(writeKey) };
  const out: Animation = { id: an.id, name: an.name, duration: an.duration, fps: an.fps, loop: an.loop, tracks };
  const slots: Record<string, SlotTrack> = {};
  for (const [id, s] of Object.entries(an.slots ?? {})) {
    const t: SlotTrack = {};
    if (s.visible?.length) t.visible = s.visible.map(writeKey);
    if (s.opacity?.length) t.opacity = s.opacity.map(writeKey);
    if (s.image?.length) t.image = s.image;
    if (s.deform?.length) t.deform = s.deform.map(writeKey);
    if (s.color?.length) t.color = s.color.map(writeKey);
    if (s.rate?.length) t.rate = s.rate.map(writeKey);
    if (Object.keys(t).length) slots[id] = t;
  }
  if (Object.keys(slots).length) out.slots = slots;
  if (an.drawOrder?.length) out.drawOrder = an.drawOrder;
  const cons: Record<string, ConstraintTrack> = {};
  for (const [id, c] of Object.entries(an.constraints ?? {})) {
    const t: ConstraintTrack = {};
    if (c.mix?.length) t.mix = c.mix.map(writeKey);
    if (c.position?.length) t.position = c.position.map(writeKey);
    if (c.angle?.length) t.angle = c.angle.map(writeKey);
    if (Object.keys(t).length) cons[id] = t;
  }
  if (Object.keys(cons).length) out.constraints = cons;
  const events: Record<string, EventKey[]> = {};
  for (const name of Object.keys(an.events ?? {}).sort()) {
    const ks = an.events![name];
    if (ks.length) events[name] = ks.map((k) => (k.payload !== undefined ? { time: k.time, payload: k.payload } : { time: k.time }));
  }
  if (Object.keys(events).length) out.events = events;
  return out;
}

/** Canonical project object as written to disk (lowest version that represents it). */
export function toFileObject(project: Project): Project {
  const out: Project = {
    format: FORMAT_ID,
    version: requiredVersion(project),
    name: project.name,
    bones: project.bones.map((b) => {
      if (b.inherit === undefined) return b;
      const { inherit, ...rest } = b;
      return hasInheritFlags(b) ? { ...rest, inherit: { rotation: inherit.rotation, scale: inherit.scale, reflection: inherit.reflection } } : rest;
    }),
    images: project.images,
    attachments: project.attachments.map((a) => {
      const { hidden, mesh, blend, color, emitter, clip, ...base } = a;
      const o: Attachment = { ...base };
      if (hidden) o.hidden = true;
      if (mesh) {
        const { alphas, ...m } = mesh;
        o.mesh = alphas ? { ...m, alphas } : m;
      }
      if (blend && blend !== 'normal') o.blend = blend;
      if (color && !isWhite(setupColor(a))) o.color = formatColor(setupColor(a));
      if (emitter) o.emitter = { recipe: emitter.recipe, rate: emitter.rate };
      if (clip) o.clip = clip;
      return o;
    }),
    animations: project.animations.map(writeAnimation),
  };
  const ik = nonEmpty(project.ik);
  if (ik) out.ik = ik;
  const paths = nonEmpty(project.paths);
  if (paths) out.paths = paths;
  const pcs = nonEmpty(project.pathConstraints);
  if (pcs) out.pathConstraints = pcs;
  const tcs = nonEmpty(project.transformConstraints);
  if (tcs) out.transformConstraints = tcs.map(writeTransform);
  const springs = nonEmpty(project.springs);
  if (springs) out.springs = springs.map((s) => ({ id: s.id, name: s.name, bones: s.bones.slice(), stiffness: s.stiffness, damping: s.damping, gain: s.gain, max: s.max, blend: s.blend, mix: s.mix }));
  const skins = nonEmpty(project.skins);
  if (skins) out.skins = skins;
  const mixes = nonEmpty(project.mixes);
  if (mixes) out.mixes = mixes;
  const seqs = nonEmpty(project.sequences);
  if (seqs) out.sequences = seqs.map((q) => ({ id: q.id, name: q.name, steps: q.steps.map((st) => ({ animId: st.animId, repeat: st.repeat })), loop: q.loop }));
  if (project.frame) out.frame = { x: project.frame.x, y: project.frame.y, width: project.frame.width, height: project.frame.height };
  const viewSets = nonEmpty(project.viewSets);
  if (viewSets) out.viewSets = viewSets.map((s) => ({
    id: s.id, name: s.name, boneId: s.boneId,
    views: s.views.map((v) => {
      const view: View = { id: v.id, name: v.name, attachments: v.attachments.slice() };
      if (v.eyes) {
        view.eyes = {
          attachment: v.eyes.attachment, open: v.eyes.open,
          ...(v.eyes.half !== undefined ? { half: v.eyes.half } : {}),
          closed: v.eyes.closed,
        };
      }
      return view;
    }),
  }));
  return out;
}

function writeTransform(tc: TransformConstraint): TransformConstraint {
  const out: TransformConstraint = { id: tc.id, name: tc.name, kind: tc.kind, bone: tc.bone, factor: tc.factor, angle: tc.angle, mix: tc.mix };
  if (tc.kind === 'rotation') {
    out.source = tc.source;
    if (tc.mitre) out.mitre = { k: tc.mitre.k, max: tc.mitre.max };
  } else out.relativeTo = tc.relativeTo ?? null;
  return out;
}

export function serializeProject(project: Project): string {
  return JSON.stringify(toFileObject(project), null, 1);
}

// ---- Reading --------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

class Checker {
  errors: string[] = [];
  warnings: string[] = [];
  fail(msg: string): void {
    if (this.errors.length < MAX_ERRORS) this.errors.push(msg);
  }
  str(o: Record<string, unknown>, k: string, where: string): string {
    const v = o[k];
    if (typeof v !== 'string') {
      this.fail(`${where}.${k} must be a string`);
      return '';
    }
    return v;
  }
  num(o: Record<string, unknown>, k: string, where: string, fallback?: number): number {
    const v = o[k];
    if (v === undefined && fallback !== undefined) return fallback;
    if (!isFiniteNum(v)) {
      this.fail(`${where}.${k} must be a finite number`);
      return 0;
    }
    return v;
  }
  bool(o: Record<string, unknown>, k: string, where: string, fallback: boolean): boolean {
    const v = o[k];
    if (v === undefined) return fallback;
    if (typeof v !== 'boolean') {
      this.fail(`${where}.${k} must be true or false`);
      return fallback;
    }
    return v;
  }
  arr(o: Record<string, unknown>, k: string, where: string): unknown[] {
    const v = o[k];
    if (!Array.isArray(v)) {
      this.fail(`${where}.${k} must be an array`);
      return [];
    }
    return v;
  }
  optArr(o: Record<string, unknown>, k: string, where: string): unknown[] | undefined {
    if (o[k] === undefined) return undefined;
    return this.arr(o, k, where);
  }
  numbers(v: unknown, where: string, len?: number): number[] {
    if (!Array.isArray(v) || !v.every(isFiniteNum) || (len !== undefined && v.length !== len)) {
      this.fail(`${where} must be ${len ?? 'a list of'} finite number(s)`);
      return [];
    }
    return v.slice();
  }
}

/** Parses and validates a Rigsmith project file. Never throws. */
export function parseProject(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`] };
  }
  return validateProject(raw);
}

/** Validates a key list (sorted, arity, interpolation). Shared by every keyed channel. */
/** `perAxis`: translate keys, which may carry a separate y interpolation (v3). */
function readKeys(c: Checker, list: unknown, where: string, arity: number | ((k: number[]) => string | null), version: number, perAxis = false): Key[] {
  const out: Key[] = [];
  if (list === undefined) return out;
  if (!Array.isArray(list)) {
    c.fail(`${where} must be an array`);
    return out;
  }
  let prev = -Infinity;
  list.forEach((k, ki) => {
    const kw = `${where}[${ki}]`;
    if (!isObj(k)) return c.fail(`${kw} must be an object`);
    const time = c.num(k, 'time', kw);
    if (time < 0) c.fail(`${kw}.time must not be negative`);
    if (time <= prev) c.fail(`${kw} keys must be sorted by strictly increasing time`);
    prev = time;
    const value = Array.isArray(k.value) ? k.value : [];
    const nums = value.every(isFiniteNum);
    if (typeof arity === 'number') {
      if (value.length !== arity || !nums) c.fail(`${kw}.value must be ${arity} finite number(s)`);
    } else {
      const msg = nums ? arity(value as number[]) : 'must be finite numbers';
      if (msg) c.fail(`${kw}.value ${msg}`);
    }
    const interp = (k.interp ?? 'linear') as Interp;
    if (!INTERPS.includes(interp)) c.fail(`${kw}.interp "${String(interp)}" is not supported`);
    const key: Key = { time, value: value.slice() as number[], interp };
    if (interp === 'bezier') {
      if (version < 2) c.fail(`${kw}.interp "bezier" requires project version 2`);
      const cv = k.curve;
      if (!Array.isArray(cv) || cv.length !== 4 || !cv.every(isFiniteNum)) c.fail(`${kw}.curve must be [x1, y1, x2, y2] finite numbers`);
      else if (cv[0] < 0 || cv[0] > 1 || cv[2] < 0 || cv[2] > 1) c.fail(`${kw}.curve x handles must lie in [0, 1] (time must not run backwards)`);
      else key.curve = cv.slice() as Curve;
    } else if (k.curve !== undefined) {
      c.fail(`${kw}.curve is only allowed on bezier keys`);
    }
    if (k.interpY !== undefined) {
      const iy = k.interpY as Interp;
      if (!perAxis) c.fail(`${kw}.interpY is only allowed on translate keys`);
      else if (version < 3) c.fail(`${kw}.interpY (per-axis translate easing) requires project version 3`);
      else if (!INTERPS.includes(iy)) c.fail(`${kw}.interpY "${String(iy)}" is not supported`);
      else {
        key.interpY = iy;
        if (iy === 'bezier') {
          const cv = k.curveY;
          if (!Array.isArray(cv) || cv.length !== 4 || !cv.every(isFiniteNum)) c.fail(`${kw}.curveY must be [x1, y1, x2, y2] finite numbers`);
          else if (cv[0] < 0 || cv[0] > 1 || cv[2] < 0 || cv[2] > 1) c.fail(`${kw}.curveY x handles must lie in [0, 1] (time must not run backwards)`);
          else key.curveY = cv.slice() as Curve;
        } else if (k.curveY !== undefined) c.fail(`${kw}.curveY is only allowed when interpY is bezier`);
      }
    } else if (k.curveY !== undefined) c.fail(`${kw}.curveY needs interpY`);
    out.push(key);
  });
  return out;
}

function sortedTimes(c: Checker, list: { time: number }[], where: string): void {
  let prev = -Infinity;
  list.forEach((k, i) => {
    if (k.time < 0) c.fail(`${where}[${i}].time must not be negative`);
    if (k.time <= prev) c.fail(`${where}[${i}] keys must be sorted by strictly increasing time`);
    prev = k.time;
  });
}

/** Every top-level field this version reads and writes. */
const TOP_LEVEL_KEYS: readonly string[] = ['format', 'version', 'name', 'bones', 'images', 'attachments', 'animations', 'ik', 'paths', 'pathConstraints', 'transformConstraints', 'springs', 'skins', 'mixes', 'sequences', 'frame', 'viewSets'];

export function validateProject(raw: unknown): ParseResult {
  const c = new Checker();
  if (!isObj(raw)) return { ok: false, errors: ['Project file must be a JSON object.'] };
  if (raw.format !== FORMAT_ID) {
    return { ok: false, errors: [`Not a Rigsmith project (expected format "${FORMAT_ID}").`] };
  }
  if (typeof raw.version !== 'number') return { ok: false, errors: ['Missing format version.'] };
  if (raw.version > FORMAT_VERSION) {
    return { ok: false, errors: [`Project version ${raw.version} is newer than this editor supports (${FORMAT_VERSION}).`] };
  }
  if (raw.version !== 1 && raw.version !== 2 && raw.version !== 3) return { ok: false, errors: [`Unsupported project version ${raw.version}.`] };
  const version = raw.version as FormatVersion;
  const v2only = (what: string, where: string) => {
    if (version < 2) c.fail(`${where}: ${what} requires project version 2`);
  };
  const v3only = (what: string, where: string) => {
    if (version < 3) c.fail(`${where}: ${what} requires project version 3`);
  };

  const name = typeof raw.name === 'string' ? raw.name : 'Untitled rig';

  // Images
  const images: ImageAsset[] = [];
  const imageIds = new Set<string>();
  const imageDims = new Map<string, [number, number]>();
  c.arr(raw, 'images', 'project').forEach((im, i) => {
    const w = `images[${i}]`;
    if (!isObj(im)) return c.fail(`${w} must be an object`);
    const id = c.str(im, 'id', w);
    if (imageIds.has(id)) c.fail(`${w}.id "${id}" is duplicated`);
    imageIds.add(id);
    const dataUrl = c.str(im, 'dataUrl', w);
    const m = DATA_URL_RE.exec(dataUrl);
    if (!m) c.fail(`${w}.dataUrl must be a base64 PNG/JPEG/WebP/GIF data URL`);
    const mime = typeof im.mime === 'string' ? im.mime : (m?.[1] ?? '');
    if (!ALLOWED_IMAGE_MIME.includes(mime)) c.fail(`${w}.mime "${mime}" is not a supported image type`);
    const width = c.num(im, 'width', w);
    const height = c.num(im, 'height', w);
    if (width <= 0 || height <= 0) c.fail(`${w} must have positive width/height`);
    imageDims.set(id, [width, height]);
    const asset: ImageAsset = { id, name: c.str(im, 'name', w), mime, width, height, dataUrl };
    if (im.derived !== undefined) {
      v2only('derived image provenance', w);
      const d = im.derived;
      if (!isObj(d)) c.fail(`${w}.derived must be an object`);
      else {
        const kind = d.kind as DerivedImage['kind'];
        if (!['cutout', 'remainder', 'patch', 'extension', 'cleanup'].includes(kind)) c.fail(`${w}.derived.kind "${String(kind)}" is not supported`);
        const der: DerivedImage = {
          kind,
          sourceId: c.str(d, 'sourceId', `${w}.derived`),
          offsetX: c.num(d, 'offsetX', `${w}.derived`),
          offsetY: c.num(d, 'offsetY', `${w}.derived`),
          synthesized: c.num(d, 'synthesized', `${w}.derived`, 0),
        };
        if (d.polygon !== undefined) der.polygon = c.numbers(d.polygon, `${w}.derived.polygon`);
        if (typeof d.note === 'string') der.note = d.note;
        asset.derived = der;
      }
    }
    images.push(asset);
  });
  for (const im of images) {
    if (im.derived && !imageIds.has(im.derived.sourceId)) c.warnings.push(`Derived image "${im.name}" refers to a source image that is no longer in the project.`);
  }

  // Bones
  const bones: Bone[] = [];
  const boneIds = new Set<string>();
  c.arr(raw, 'bones', 'project').forEach((b, i) => {
    const w = `bones[${i}]`;
    if (!isObj(b)) return c.fail(`${w} must be an object`);
    const id = c.str(b, 'id', w);
    if (boneIds.has(id)) c.fail(`${w}.id "${id}" is duplicated`);
    boneIds.add(id);
    const parentId = b.parentId === null || b.parentId === undefined ? null : c.str(b, 'parentId', w);
    bones.push({
      id,
      name: c.str(b, 'name', w),
      parentId,
      x: c.num(b, 'x', w),
      y: c.num(b, 'y', w),
      rotation: c.num(b, 'rotation', w),
      scaleX: c.num(b, 'scaleX', w, 1),
      scaleY: c.num(b, 'scaleY', w, 1),
      length: c.num(b, 'length', w, 0),
      color: typeof b.color === 'string' ? b.color : '#8fd3c8',
    });
    if (b.inherit !== undefined) {
      v3only('bone inherit flags', w);
      if (!isObj(b.inherit)) c.fail(`${w}.inherit must be an object`);
      else {
        const inh = { rotation: c.bool(b.inherit, 'rotation', `${w}.inherit`, true), scale: c.bool(b.inherit, 'scale', `${w}.inherit`, true), reflection: c.bool(b.inherit, 'reflection', `${w}.inherit`, true) };
        // All flags on is the default: not stored, so the project re-saves at the lowest version.
        if (!inh.rotation || !inh.scale || !inh.reflection) bones[bones.length - 1].inherit = inh;
      }
    }
  });
  for (const b of bones) {
    if (b.parentId !== null && !boneIds.has(b.parentId)) c.fail(`Bone "${b.name}" references missing parent "${b.parentId}"`);
    if (b.parentId === b.id) c.fail(`Bone "${b.name}" is its own parent`);
  }
  const cyc = findCycles(bones);
  if (cyc.length) c.fail(`Bone hierarchy contains a cycle (${cyc.slice(0, 5).join(', ')})`);
  const acyclic = cyc.length === 0;

  // Attachments
  const attachments: Attachment[] = [];
  const attIds = new Set<string>();
  const meshVerts = new Map<string, number>();
  const emitterIds = new Set<string>();
  c.arr(raw, 'attachments', 'project').forEach((a, i) => {
    const w = `attachments[${i}]`;
    if (!isObj(a)) return c.fail(`${w} must be an object`);
    const id = c.str(a, 'id', w);
    if (attIds.has(id)) c.fail(`${w}.id "${id}" is duplicated`);
    attIds.add(id);
    const boneId = a.boneId === null || a.boneId === undefined ? null : c.str(a, 'boneId', w);
    if (boneId !== null && !boneIds.has(boneId)) c.fail(`${w} references missing bone "${boneId}"`);
    const imageId = c.str(a, 'imageId', w);
    if (!imageIds.has(imageId)) c.fail(`${w} references missing image "${imageId}"`);
    const opacity = c.num(a, 'opacity', w, 1);
    const att: Attachment = {
      id,
      name: c.str(a, 'name', w),
      boneId,
      imageId,
      x: c.num(a, 'x', w),
      y: c.num(a, 'y', w),
      rotation: c.num(a, 'rotation', w, 0),
      scaleX: c.num(a, 'scaleX', w, 1),
      scaleY: c.num(a, 'scaleY', w, 1),
      opacity: Math.min(1, Math.max(0, opacity)),
    };
    if (a.hidden !== undefined) {
      v2only('hidden', w);
      if (c.bool(a, 'hidden', w, false)) att.hidden = true;
    }
    if (a.mesh !== undefined) {
      v2only('mesh', w);
      const mesh = readMesh(c, a.mesh, `${w}.mesh`, boneIds, imageDims.get(imageId));
      if (mesh) {
        if (mesh.alphas) v3only('vertex alpha', `${w}.mesh`);
        if (mesh.bind) v3only('bind', `${w}.mesh`);
        att.mesh = mesh;
        meshVerts.set(id, mesh.points.length / 2);
      }
    }
    if (a.blend !== undefined) {
      v3only('blend', w);
      if (typeof a.blend !== 'string' || !(BLEND_MODES as readonly string[]).includes(a.blend)) c.fail(`${w}.blend must be one of ${BLEND_MODES.join(', ')}`);
      else if (a.blend !== 'normal') att.blend = a.blend as BlendMode;
    }
    if (a.color !== undefined) {
      v3only('color', w);
      if (!isColor(a.color)) c.fail(`${w}.color must be #rrggbb or #rrggbbaa`);
      else if (!isWhite(parseColor(a.color)!)) att.color = formatColor(parseColor(a.color)!);
    }
    if (a.emitter !== undefined) {
      v3only('emitters', w);
      const ew = `${w}.emitter`;
      if (!isObj(a.emitter)) c.fail(`${ew} must be an object`);
      else {
        const em = { recipe: c.str(a.emitter, 'recipe', ew), rate: c.num(a.emitter, 'rate', ew) };
        for (const e of emitterProblems(em)) c.fail(`${ew}: ${e}`);
        if (att.mesh) c.fail(`${w}: an emitter cannot have a mesh`);
        att.emitter = em;
        emitterIds.add(id);
      }
    }
    if (a.clip !== undefined) {
      v3only('clipping masks', w);
      att.clip = c.str(a, 'clip', w);
    }
    attachments.push(att);
  });

  attachments.forEach((att, i) => {
    if (att.clip === undefined) return;
    for (const e of clipProblems(attachments, att, att.clip)) c.fail(`attachments[${i}].clip: ${e}`);
  });

  // View metadata does not override Attachment.hidden. Creation helpers establish
  // base/nonbase setup visibility; parsing preserves later manual visibility edits.
  const viewSets: ViewSet[] = [];
  const viewSetsRaw = c.optArr(raw, 'viewSets', 'project');
  if (viewSetsRaw) v3only('view sets', 'project');
  const viewSetIds = new Set<string>();
  const viewIds = new Set<string>();
  viewSetsRaw?.forEach((s, i) => {
    const w = `viewSets[${i}]`;
    if (!isObj(s)) return c.fail(`${w} must be an object`);
    const id = c.str(s, 'id', w);
    if (!id.trim()) c.fail(`${w}.id must not be empty`);
    if (viewSetIds.has(id)) c.fail(`${w}.id "${id}" is duplicated`);
    viewSetIds.add(id);
    const boneId = c.str(s, 'boneId', w);
    if (!boneIds.has(boneId)) c.fail(`${w} references missing bone "${boneId}"`);
    const views: View[] = [];
    const viewsRaw = c.arr(s, 'views', w);
    if (!viewsRaw.length) c.fail(`${w}.views must contain a base view`);
    const members = new Set<string>();
    viewsRaw.forEach((v, vi) => {
      const vw = `${w}.views[${vi}]`;
      if (!isObj(v)) return c.fail(`${vw} must be an object`);
      const viewId = c.str(v, 'id', vw);
      if (!viewId.trim()) c.fail(`${vw}.id must not be empty`);
      if (viewIds.has(viewId)) c.fail(`${vw}.id "${viewId}" is duplicated`);
      viewIds.add(viewId);
      const attachmentIds: string[] = [];
      const membersRaw = c.arr(v, 'attachments', vw);
      if (!membersRaw.length) c.fail(`${vw}.attachments must not be empty`);
      membersRaw.forEach((attachmentId, ai) => {
        const aw = `${vw}.attachments[${ai}]`;
        if (typeof attachmentId !== 'string') return c.fail(`${aw} must be a string`);
        if (!attIds.has(attachmentId)) c.fail(`${aw} references missing attachment "${attachmentId}"`);
        if (members.has(attachmentId)) c.fail(`${aw}: attachment "${attachmentId}" appears more than once in this view set`);
        members.add(attachmentId);
        attachmentIds.push(attachmentId);
      });
      const view: View = { id: viewId, name: c.str(v, 'name', vw), attachments: attachmentIds };
      if (v.eyes !== undefined) {
        const ew = `${vw}.eyes`;
        if (!isObj(v.eyes)) c.fail(`${ew} must be an object`);
        else {
          const eyes: ViewEyes = {
            attachment: c.str(v.eyes, 'attachment', ew),
            open: c.str(v.eyes, 'open', ew),
            closed: c.str(v.eyes, 'closed', ew),
          };
          if (v.eyes.half !== undefined) eyes.half = c.str(v.eyes, 'half', ew);
          if (!attachmentIds.includes(eyes.attachment)) c.fail(`${ew}.attachment must belong to its view`);
          for (const key of ['open', 'half', 'closed'] as const) {
            const imageId = eyes[key];
            if (imageId !== undefined && !imageIds.has(imageId)) c.fail(`${ew}.${key} references missing image "${imageId}"`);
          }
          view.eyes = eyes;
        }
      }
      views.push(view);
    });
    viewSets.push({ id, name: c.str(s, 'name', w), boneId, views });
  });

  // Constraints
  const constraintIds = new Set<string>();
  const ik: IkConstraint[] = [];
  const ikRaw = c.optArr(raw, 'ik', 'project');
  if (ikRaw) v2only('ik', 'project');
  ikRaw?.forEach((k, i) => {
    const w = `ik[${i}]`;
    if (!isObj(k)) return c.fail(`${w} must be an object`);
    const id = c.str(k, 'id', w);
    if (constraintIds.has(id)) c.fail(`${w}.id "${id}" is duplicated`);
    constraintIds.add(id);
    const chain = Array.isArray(k.bones) ? k.bones.filter((x): x is string => typeof x === 'string') : [];
    if (chain.length < 1 || chain.length > 2 || chain.length !== (k.bones as unknown[]).length) c.fail(`${w}.bones must list 1 or 2 bone ids`);
    for (const b of chain) if (!boneIds.has(b)) c.fail(`${w} references missing bone "${b}"`);
    if (chain.length === 2 && bones.find((b) => b.id === chain[1])?.parentId !== chain[0]) c.fail(`${w}: the second bone must be a child of the first`);
    if (chain.length === 2 && bones.some((b) => b.id === chain[1] && hasInheritFlags(b))) c.fail(`${w}: the second bone must inherit its parent's full transform (clear its inherit flags)`);
    const target = c.str(k, 'target', w);
    if (!boneIds.has(target)) c.fail(`${w} references missing target bone "${target}"`);
    else if (acyclic && chain.some((b) => isAncestorOrSelf(bones, b, target))) c.fail(`${w}: the target must not be (a child of) a constrained bone`);
    const mix = c.num(k, 'mix', w, 1);
    if (mix < 0 || mix > 1) c.fail(`${w}.mix must be between 0 and 1`);
    ik.push({ id, name: c.str(k, 'name', w), bones: chain, target, mix, bendPositive: c.bool(k, 'bendPositive', w, true) });
  });

  const paths: PathShape[] = [];
  const pathIds = new Set<string>();
  const pathsRaw = c.optArr(raw, 'paths', 'project');
  if (pathsRaw) v2only('paths', 'project');
  pathsRaw?.forEach((pr, i) => {
    const w = `paths[${i}]`;
    if (!isObj(pr)) return c.fail(`${w} must be an object`);
    const id = c.str(pr, 'id', w);
    if (pathIds.has(id)) c.fail(`${w}.id "${id}" is duplicated`);
    pathIds.add(id);
    const boneId = pr.boneId === null || pr.boneId === undefined ? null : c.str(pr, 'boneId', w);
    if (boneId !== null && !boneIds.has(boneId)) c.fail(`${w} references missing bone "${boneId}"`);
    const nodes: PathNode[] = [];
    c.arr(pr, 'nodes', w).forEach((n, ni) => {
      const nw = `${w}.nodes[${ni}]`;
      if (!isObj(n)) return c.fail(`${nw} must be an object`);
      nodes.push({ x: c.num(n, 'x', nw), y: c.num(n, 'y', nw), inX: c.num(n, 'inX', nw, 0), inY: c.num(n, 'inY', nw, 0), outX: c.num(n, 'outX', nw, 0), outY: c.num(n, 'outY', nw, 0) });
    });
    if (nodes.length < 2) c.fail(`${w} needs at least 2 nodes`);
    paths.push({ id, name: c.str(pr, 'name', w), boneId, closed: c.bool(pr, 'closed', w, false), nodes });
  });

  const pathConstraints: PathConstraint[] = [];
  const pcRaw = c.optArr(raw, 'pathConstraints', 'project');
  if (pcRaw) v2only('pathConstraints', 'project');
  pcRaw?.forEach((pc, i) => {
    const w = `pathConstraints[${i}]`;
    if (!isObj(pc)) return c.fail(`${w} must be an object`);
    const id = c.str(pc, 'id', w);
    if (constraintIds.has(id)) c.fail(`${w}.id "${id}" is duplicated`);
    constraintIds.add(id);
    const pathId = c.str(pc, 'pathId', w);
    if (!pathIds.has(pathId)) c.fail(`${w} references missing path "${pathId}"`);
    const list = Array.isArray(pc.bones) ? pc.bones.filter((x): x is string => typeof x === 'string') : [];
    if (!list.length) c.fail(`${w}.bones must list at least one bone id`);
    for (const b of list) if (!boneIds.has(b)) c.fail(`${w} references missing bone "${b}"`);
    const owner = paths.find((p) => p.id === pathId)?.boneId;
    if (owner && acyclic && list.some((b) => isAncestorOrSelf(bones, b, owner))) c.fail(`${w}: a constrained bone must not carry its own path`);
    const mix = c.num(pc, 'mix', w, 1);
    if (mix < 0 || mix > 1) c.fail(`${w}.mix must be between 0 and 1`);
    pathConstraints.push({
      id,
      name: c.str(pc, 'name', w),
      pathId,
      bones: list,
      position: c.num(pc, 'position', w, 0),
      spacing: c.num(pc, 'spacing', w, 0),
      mix,
      rotate: c.bool(pc, 'rotate', w, true),
      rotateOffset: c.num(pc, 'rotateOffset', w, 0),
    });
  });

  const transformConstraints: TransformConstraint[] = [];
  const tcRaw = c.optArr(raw, 'transformConstraints', 'project');
  if (tcRaw) v3only('transformConstraints', 'project');
  tcRaw?.forEach((tc, i) => {
    const w = `transformConstraints[${i}]`;
    if (!isObj(tc)) return c.fail(`${w} must be an object`);
    const id = c.str(tc, 'id', w);
    if (constraintIds.has(id)) c.fail(`${w}.id "${id}" is duplicated`);
    constraintIds.add(id);
    const kind = tc.kind;
    if (kind !== 'rotation' && kind !== 'aim') return c.fail(`${w}.kind must be "rotation" or "aim"`);
    const bone = c.str(tc, 'bone', w);
    if (!boneIds.has(bone)) c.fail(`${w} references missing bone "${bone}"`);
    const mix = c.num(tc, 'mix', w, 1);
    if (mix < 0 || mix > 1) c.fail(`${w}.mix must be between 0 and 1`);
    const out: TransformConstraint = { id, name: c.str(tc, 'name', w), kind, bone, factor: c.num(tc, 'factor', w, 1), angle: c.num(tc, 'angle', w, 0), mix };
    if (kind === 'rotation') {
      const source = c.str(tc, 'source', w);
      if (!boneIds.has(source)) c.fail(`${w} references missing source bone "${source}"`);
      else if (source === bone) c.fail(`${w}: a bone cannot copy its own rotation`);
      out.source = source;
      if (tc.mitre !== undefined) {
        if (!isObj(tc.mitre)) c.fail(`${w}.mitre must be an object`);
        else {
          const k = c.num(tc.mitre, 'k', `${w}.mitre`), max = c.num(tc.mitre, 'max', `${w}.mitre`);
          if (k < 0) c.fail(`${w}.mitre.k must not be negative`);
          if (max < 1) c.fail(`${w}.mitre.max must be at least 1`);
          out.mitre = { k, max };
        }
      }
    } else {
      const rel = tc.relativeTo === null || tc.relativeTo === undefined ? null : c.str(tc, 'relativeTo', w);
      if (rel !== null && !boneIds.has(rel)) c.fail(`${w} references missing bone "${rel}"`);
      else if (rel === bone) c.fail(`${w}: a bone cannot aim relative to itself`);
      out.relativeTo = rel;
    }
    transformConstraints.push(out);
  });

  const springs: SpringConstraint[] = [];
  const springRaw = c.optArr(raw, 'springs', 'project');
  if (springRaw) v3only('springs', 'project');
  const sprung = new Set<string>();
  springRaw?.forEach((sr, i) => {
    const w = `springs[${i}]`;
    if (!isObj(sr)) return c.fail(`${w} must be an object`);
    const id = c.str(sr, 'id', w);
    if (constraintIds.has(id) || springs.some((s) => s.id === id)) c.fail(`${w}.id "${id}" is duplicated`);
    const bones = c.arr(sr, 'bones', w).filter((b): b is string => typeof b === 'string');
    if (!bones.length) c.fail(`${w}.bones must list at least one bone`);
    for (const b of bones) {
      if (!boneIds.has(b)) c.fail(`${w} references missing bone "${b}"`);
      if (sprung.has(b)) c.fail(`${w}: bone "${b}" is already in a spring`);
      sprung.add(b);
    }
    const s: SpringConstraint = { id, name: c.str(sr, 'name', w), bones, stiffness: c.num(sr, 'stiffness', w), damping: c.num(sr, 'damping', w), gain: c.num(sr, 'gain', w), max: c.num(sr, 'max', w), blend: c.num(sr, 'blend', w), mix: c.num(sr, 'mix', w, 1) };
    for (const e of springProblems(s)) c.fail(`${w}: ${e}`);
    springs.push(s);
  });

  // Animations
  const animations: Animation[] = [];
  const animIds = new Set<string>();
  c.arr(raw, 'animations', 'project').forEach((an, i) => {
    const w = `animations[${i}]`;
    if (!isObj(an)) return c.fail(`${w} must be an object`);
    const id = c.str(an, 'id', w);
    if (animIds.has(id)) c.fail(`${w}.id "${id}" is duplicated`);
    animIds.add(id);
    const duration = c.num(an, 'duration', w);
    const fps = c.num(an, 'fps', w);
    if (duration <= 0 || duration > 3600) c.fail(`${w}.duration must be between 0 and 3600 seconds`);
    if (fps < 1 || fps > 240 || !Number.isInteger(fps)) c.fail(`${w}.fps must be an integer from 1 to 240`);
    const tracks: Record<string, BoneTrack> = {};
    if (!isObj(an.tracks)) c.fail(`${w}.tracks must be an object`);
    else {
      for (const [boneId, tr] of Object.entries(an.tracks)) {
        const tw = `${w}.tracks["${boneId}"]`;
        if (!boneIds.has(boneId)) {
          c.fail(`${tw} references missing bone`);
          continue;
        }
        if (!isObj(tr)) {
          c.fail(`${tw} must be an object`);
          continue;
        }
        const track: BoneTrack = { translate: [], rotate: [], scale: [] };
        for (const ch of CHANNELS) {
          if (tr[ch] !== undefined && !Array.isArray(tr[ch])) {
            c.fail(`${tw}.${ch} must be an array`);
            continue;
          }
          track[ch] = readKeys(c, tr[ch], `${tw}.${ch}`, CHANNEL_ARITY[ch], version, ch === 'translate');
        }
        tracks[boneId] = track;
      }
    }
    const anim: Animation = { id, name: c.str(an, 'name', w), duration, fps, loop: an.loop !== false, tracks };

    if (an.slots !== undefined) {
      v2only('slots', w);
      if (!isObj(an.slots)) c.fail(`${w}.slots must be an object`);
      else {
        const slots: Record<string, SlotTrack> = {};
        for (const [attId, sr] of Object.entries(an.slots)) {
          const sw = `${w}.slots["${attId}"]`;
          if (!attIds.has(attId)) {
            c.fail(`${sw} references missing attachment`);
            continue;
          }
          if (!isObj(sr)) {
            c.fail(`${sw} must be an object`);
            continue;
          }
          const st: SlotTrack = {};
          if (sr.visible !== undefined) st.visible = readKeys(c, sr.visible, `${sw}.visible`, (v) => (v.length === 1 && (v[0] === 0 || v[0] === 1) ? null : 'must be [0] or [1]'), version);
          if (sr.opacity !== undefined) st.opacity = readKeys(c, sr.opacity, `${sw}.opacity`, (v) => (v.length === 1 && v[0] >= 0 && v[0] <= 1 ? null : 'must be one number from 0 to 1'), version);
          if (sr.image !== undefined) {
            const list: ImageKey[] = [];
            if (!Array.isArray(sr.image)) c.fail(`${sw}.image must be an array`);
            else
              sr.image.forEach((k, ki) => {
                const kw = `${sw}.image[${ki}]`;
                if (!isObj(k)) return c.fail(`${kw} must be an object`);
                const imageId = c.str(k, 'imageId', kw);
                if (!imageIds.has(imageId)) c.fail(`${kw} references missing image "${imageId}"`);
                list.push({ time: c.num(k, 'time', kw), imageId });
              });
            sortedTimes(c, list, `${sw}.image`);
            st.image = list;
          }
          if (sr.deform !== undefined) {
            const n = meshVerts.get(attId);
            if (n === undefined) c.fail(`${sw}.deform needs the attachment to have a mesh`);
            st.deform = readKeys(c, sr.deform, `${sw}.deform`, (v) => (n !== undefined && v.length === 2 * n ? null : `must hold ${2 * (n ?? 0)} offsets (2 per mesh vertex)`), version);
          }
          if (sr.color !== undefined) {
            v3only('colour keys', sw);
            st.color = readKeys(c, sr.color, `${sw}.color`, colorValueProblem, version);
          }
          if (sr.rate !== undefined) {
            v3only('emitters', sw);
            if (!emitterIds.has(attId)) c.fail(`${sw}.rate needs the attachment to be an emitter`);
            st.rate = readKeys(c, sr.rate, `${sw}.rate`, (v) => (v.length === 1 && v[0] >= 0 && v[0] <= EMITTER_MAX_RATE ? null : `must be one number from 0 to ${EMITTER_MAX_RATE}`), version);
          }
          slots[attId] = st;
        }
        anim.slots = slots;
      }
    }
    if (an.drawOrder !== undefined) {
      v2only('drawOrder', w);
      const list: DrawOrderKey[] = [];
      if (!Array.isArray(an.drawOrder)) c.fail(`${w}.drawOrder must be an array`);
      else
        an.drawOrder.forEach((k, ki) => {
          const kw = `${w}.drawOrder[${ki}]`;
          if (!isObj(k)) return c.fail(`${kw} must be an object`);
          const order = Array.isArray(k.order) ? k.order.filter((x): x is string => typeof x === 'string') : [];
          const set = new Set(order);
          if (order.length !== attIds.size || set.size !== order.length || order.some((x) => !attIds.has(x))) c.fail(`${kw}.order must list every attachment id exactly once`);
          list.push({ time: c.num(k, 'time', kw), order });
        });
      sortedTimes(c, list, `${w}.drawOrder`);
      anim.drawOrder = list;
    }
    if (an.constraints !== undefined) {
      v2only('constraint keys', w);
      if (!isObj(an.constraints)) c.fail(`${w}.constraints must be an object`);
      else {
        const cons: Record<string, ConstraintTrack> = {};
        for (const [cid, cr] of Object.entries(an.constraints)) {
          const cw = `${w}.constraints["${cid}"]`;
          if (!constraintIds.has(cid)) {
            c.fail(`${cw} references a missing constraint`);
            continue;
          }
          if (!isObj(cr)) {
            c.fail(`${cw} must be an object`);
            continue;
          }
          const ct: ConstraintTrack = {};
          if (cr.mix !== undefined) ct.mix = readKeys(c, cr.mix, `${cw}.mix`, (v) => (v.length === 1 && v[0] >= 0 && v[0] <= 1 ? null : 'must be one number from 0 to 1'), version);
          if (cr.position !== undefined) ct.position = readKeys(c, cr.position, `${cw}.position`, 1, version);
          if (cr.angle !== undefined) {
            v3only('constraint angle keys', cw);
            ct.angle = readKeys(c, cr.angle, `${cw}.angle`, 1, version);
          }
          cons[cid] = ct;
        }
        anim.constraints = cons;
      }
    }
    if (an.events !== undefined) {
      v3only('timeline events', w);
      if (!isObj(an.events)) c.fail(`${w}.events must be an object of event name → keys`);
      else {
        const events: Record<string, EventKey[]> = {};
        for (const [name, list] of Object.entries(an.events)) {
          const ew = `${w}.events["${name}"]`;
          if (!EVENT_NAME.test(name)) c.fail(`${ew}: event names are 1–64 letters, digits and _ . : -`);
          if (!Array.isArray(list)) {
            c.fail(`${ew} must be an array`);
            continue;
          }
          const keys: EventKey[] = [];
          list.forEach((k, ki) => {
            const kw = `${ew}[${ki}]`;
            if (!isObj(k)) return c.fail(`${kw} must be an object`);
            const time = c.num(k, 'time', kw);
            if (time < 0) c.fail(`${kw}.time must not be negative`);
            const key: EventKey = { time };
            if (k.payload !== undefined) {
              if (typeof k.payload === 'string' ? k.payload.length > 256 : !isFiniteNum(k.payload)) c.fail(`${kw}.payload must be a string (at most 256 characters) or a finite number`);
              else key.payload = k.payload as string | number;
            }
            keys.push(key);
          });
          let prev = -Infinity;
          for (const k of keys) {
            if (k.time <= prev) c.fail(`${ew} keys must be sorted by strictly increasing time`);
            prev = k.time;
          }
          events[name] = keys;
        }
        anim.events = events;
      }
    }
    animations.push(anim);
  });

  const skins: Skin[] = [];
  const skinsRaw = c.optArr(raw, 'skins', 'project');
  if (skinsRaw) v2only('skins', 'project');
  const skinIds = new Set<string>();
  skinsRaw?.forEach((s, i) => {
    const w = `skins[${i}]`;
    if (!isObj(s)) return c.fail(`${w} must be an object`);
    const id = c.str(s, 'id', w);
    if (skinIds.has(id)) c.fail(`${w}.id "${id}" is duplicated`);
    skinIds.add(id);
    const entries: Skin['entries'] = [];
    const seen = new Set<string>();
    c.arr(s, 'entries', w).forEach((e, ei) => {
      const ew = `${w}.entries[${ei}]`;
      if (!isObj(e)) return c.fail(`${ew} must be an object`);
      const attachmentId = c.str(e, 'attachmentId', ew);
      const imageId = c.str(e, 'imageId', ew);
      if (!attIds.has(attachmentId)) c.fail(`${ew} references missing attachment "${attachmentId}"`);
      if (!imageIds.has(imageId)) c.fail(`${ew} references missing image "${imageId}"`);
      let from: string | undefined;
      if (e.from !== undefined) {
        from = c.str(e, 'from', ew);
        if (!imageIds.has(from)) c.fail(`${ew}.from references missing image "${from}"`);
      }
      const key = `${attachmentId}|${from ?? ''}`;
      if (seen.has(key)) c.fail(`${ew}: attachment "${attachmentId}"${from ? ` with from "${from}"` : ''} appears twice in one skin`);
      seen.add(key);
      entries.push(from ? { attachmentId, imageId, from } : { attachmentId, imageId });
    });
    skins.push({ id, name: c.str(s, 'name', w), entries });
  });

  const mixes: MixRule[] = [];
  const mixRaw = c.optArr(raw, 'mixes', 'project');
  if (mixRaw) v2only('mixes', 'project');
  mixRaw?.forEach((m, i) => {
    const w = `mixes[${i}]`;
    if (!isObj(m)) return c.fail(`${w} must be an object`);
    const from = c.str(m, 'from', w);
    const to = c.str(m, 'to', w);
    if (!animIds.has(from) || !animIds.has(to)) c.fail(`${w} references a missing animation`);
    const duration = c.num(m, 'duration', w);
    if (duration < 0 || duration > 10) c.fail(`${w}.duration must be between 0 and 10 seconds`);
    mixes.push({ from, to, duration });
  });

  const sequences: ClipSequence[] = [];
  const seqRaw = c.optArr(raw, 'sequences', 'project');
  if (seqRaw) v2only('sequences', 'project');
  const seqIds = new Set<string>();
  const seqNames = new Set<string>();
  seqRaw?.forEach((q, i) => {
    const w = `sequences[${i}]`;
    if (!isObj(q)) return c.fail(`${w} must be an object`);
    const id = c.str(q, 'id', w);
    if (seqIds.has(id)) c.fail(`${w}.id "${id}" is duplicated`);
    seqIds.add(id);
    const sname = c.str(q, 'name', w);
    if (!sname.trim()) c.fail(`${w}.name must not be empty`);
    if (seqNames.has(sname)) c.fail(`${w}.name "${sname}" is duplicated`);
    seqNames.add(sname);
    const steps: SequenceStep[] = [];
    c.arr(q, 'steps', w).forEach((st, si) => {
      const sw = `${w}.steps[${si}]`;
      if (!isObj(st)) return c.fail(`${sw} must be an object`);
      const animId = c.str(st, 'animId', sw);
      if (!animIds.has(animId)) c.fail(`${sw} references missing animation "${animId}"`);
      const repeat = c.num(st, 'repeat', sw, 1);
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > SEQUENCE_MAX_REPEAT) c.fail(`${sw}.repeat must be a whole number from 1 to ${SEQUENCE_MAX_REPEAT}`);
      steps.push({ animId, repeat });
    });
    sequences.push({ id, name: sname, steps, loop: c.bool(q, 'loop', w, false) });
  });

  let frame: ProjectFrame | undefined;
  if (raw.frame !== undefined) {
    v2only('frame', 'project');
    const fr = raw.frame;
    if (!isObj(fr)) c.fail('frame must be an object');
    else {
      frame = { x: c.num(fr, 'x', 'frame'), y: c.num(fr, 'y', 'frame'), width: c.num(fr, 'width', 'frame'), height: c.num(fr, 'height', 'frame') };
      if (!(frame.width >= 1 && frame.width <= FRAME_MAX_SIDE) || !(frame.height >= 1 && frame.height <= FRAME_MAX_SIDE)) c.fail(`frame width and height must be between 1 and ${FRAME_MAX_SIDE} world units`);
    }
  }

  const used = new Set(attachments.map((a) => a.imageId));
  for (const s of skins) for (const e of s.entries) used.add(e.imageId);
  for (const s of viewSets) for (const v of s.views) if (v.eyes) {
    used.add(v.eyes.open);
    if (v.eyes.half !== undefined) used.add(v.eyes.half);
    used.add(v.eyes.closed);
  }
  for (const an of animations) for (const st of Object.values(an.slots ?? {})) for (const k of st.image ?? []) used.add(k.imageId);
  for (const im of images) if (im.derived) used.add(im.derived.sourceId);
  const unused = images.filter((im) => !used.has(im.id)).length;
  if (unused) c.warnings.push(`${unused} image(s) are not attached to anything.`);
  // A field this version does not know (e.g. written by a newer editor) is not kept on the
  // next save; say so instead of dropping it silently.
  const unknown = Object.keys(raw).filter((k) => !TOP_LEVEL_KEYS.includes(k));
  if (unknown.length) c.warnings.push(`Unknown top-level field(s) ignored — they will not be saved again: ${unknown.map((k) => `"${k}"`).join(', ')}.`);

  if (c.errors.length) return { ok: false, errors: c.errors };
  const project: Project = { format: FORMAT_ID, version, name, bones, images, attachments, animations };
  if (ikRaw) project.ik = ik;
  if (pathsRaw) project.paths = paths;
  if (pcRaw) project.pathConstraints = pathConstraints;
  if (tcRaw) project.transformConstraints = transformConstraints;
  if (springRaw) project.springs = springs;
  if (skinsRaw) project.skins = skins;
  if (mixRaw) project.mixes = mixes;
  if (seqRaw) project.sequences = sequences;
  if (viewSetsRaw) project.viewSets = viewSets;
  if (frame) project.frame = frame;
  return { ok: true, warnings: c.warnings, project };
}

function readMesh(c: Checker, raw: unknown, w: string, boneIds: Set<string>, dims: [number, number] | undefined): Mesh | null {
  if (!isObj(raw)) {
    c.fail(`${w} must be an object`);
    return null;
  }
  const points = c.numbers(raw.points, `${w}.points`);
  const n = points.length / 2;
  if (points.length % 2 || n < 3) c.fail(`${w}.points must hold at least 3 x,y pairs`);
  if (dims) {
    for (let i = 0; i < n; i++) {
      const x = points[2 * i], y = points[2 * i + 1];
      if (x < -0.5 || y < -0.5 || x > dims[0] + 0.5 || y > dims[1] + 0.5) {
        c.fail(`${w}.points[${i}] lies outside the image`);
        break;
      }
    }
  }
  const triangles = c.numbers(raw.triangles, `${w}.triangles`);
  if (!triangles.length || triangles.length % 3 || !triangles.every((t) => Number.isInteger(t) && t >= 0 && t < n)) c.fail(`${w}.triangles must be index triples into points`);
  const hull = c.num(raw, 'hull', w);
  if (!Number.isInteger(hull) || hull < 3 || hull > n) c.fail(`${w}.hull must be an integer from 3 to the vertex count`);
  const mesh: Mesh = { points, triangles, hull };
  if (raw.weights !== undefined) {
    if (!Array.isArray(raw.weights) || raw.weights.length !== n) {
      c.fail(`${w}.weights must have one entry per vertex`);
      return mesh;
    }
    const weights: VertexWeights[] = [];
    raw.weights.forEach((vw, vi) => {
      const ww = `${w}.weights[${vi}]`;
      if (!Array.isArray(vw) || !vw.length) return c.fail(`${ww} must list at least one bone influence`);
      const list: VertexWeights = [];
      let sum = 0;
      for (const inf of vw) {
        if (!isObj(inf) || typeof inf.bone !== 'string' || !isFiniteNum(inf.w) || inf.w < 0) {
          c.fail(`${ww} entries must be { bone, w ≥ 0 }`);
          return;
        }
        if (!boneIds.has(inf.bone)) c.fail(`${ww} references missing bone "${inf.bone}"`);
        list.push({ bone: inf.bone, w: inf.w });
        sum += inf.w;
      }
      if (Math.abs(sum - 1) > 1e-3) c.fail(`${ww} weights must sum to 1 (got ${sum.toFixed(4)})`);
      weights.push(list);
    });
    mesh.weights = weights;
  }
  if (raw.bind !== undefined) {
    const bw = `${w}.bind`;
    const affine = (v: unknown, where: string): Affine | null => {
      const m = c.numbers(v, where);
      if (m.length !== 6 || Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12) {
        c.fail(`${where} must be an invertible matrix [a, b, c, d, tx, ty]`);
        return null;
      }
      return m as Affine;
    };
    if (!isObj(raw.bind) || !isObj(raw.bind.bones)) c.fail(`${bw} must be { attachment, bones }`);
    else if (!mesh.weights) c.fail(`${bw} needs weights`);
    else {
      const att = affine(raw.bind.attachment, `${bw}.attachment`);
      const bones: Record<string, Affine> = {};
      for (const [id, m] of Object.entries(raw.bind.bones)) {
        if (!boneIds.has(id)) c.fail(`${bw}.bones references missing bone "${id}"`);
        const a = affine(m, `${bw}.bones["${id}"]`);
        if (a) bones[id] = a;
      }
      if (att) mesh.bind = { attachment: att, bones };
    }
  }
  if (raw.alphas !== undefined) {
    const alphas = c.numbers(raw.alphas, `${w}.alphas`);
    if (alphas.length !== n || !alphas.every((v) => v >= 0 && v <= 1)) c.fail(`${w}.alphas must hold one number from 0 to 1 per vertex`);
    else mesh.alphas = alphas;
  }
  return mesh;
}
