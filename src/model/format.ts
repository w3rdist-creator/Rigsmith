import { findCycles } from './skeleton.ts';
import type { Animation, Attachment, Bone, BoneTrack, ImageAsset, Key, Project } from './types.ts';
import { CHANNEL_ARITY, CHANNELS, FORMAT_ID, FORMAT_VERSION, INTERPS } from './types.ts';

export type ParseResult = { ok: true; project: Project; warnings: string[] } | { ok: false; errors: string[] };

const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,[A-Za-z0-9+/]+=*$/;
const MAX_ERRORS = 25;

export function serializeProject(project: Project): string {
  const out: Project = {
    format: FORMAT_ID,
    version: FORMAT_VERSION,
    name: project.name,
    bones: project.bones,
    images: project.images,
    attachments: project.attachments,
    animations: project.animations,
  };
  return JSON.stringify(out, null, 1);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

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
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.fail(`${where}.${k} must be a finite number`);
      return 0;
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
  if (raw.version !== FORMAT_VERSION) return { ok: false, errors: [`Unsupported project version ${raw.version}.`] };

  const name = typeof raw.name === 'string' ? raw.name : 'Untitled rig';

  // Images
  const images: ImageAsset[] = [];
  const imageIds = new Set<string>();
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
    images.push({ id, name: c.str(im, 'name', w), mime, width, height, dataUrl });
  });

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
  });
  for (const b of bones) {
    if (b.parentId !== null && !boneIds.has(b.parentId)) c.fail(`Bone "${b.name}" references missing parent "${b.parentId}"`);
    if (b.parentId === b.id) c.fail(`Bone "${b.name}" is its own parent`);
  }
  const cyc = findCycles(bones);
  if (cyc.length) c.fail(`Bone hierarchy contains a cycle (${cyc.slice(0, 5).join(', ')})`);

  // Attachments
  const attachments: Attachment[] = [];
  const attIds = new Set<string>();
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
    attachments.push({
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
    });
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
          const list = tr[ch] === undefined ? [] : tr[ch];
          if (!Array.isArray(list)) {
            c.fail(`${tw}.${ch} must be an array`);
            continue;
          }
          let prev = -Infinity;
          list.forEach((k, ki) => {
            const kw = `${tw}.${ch}[${ki}]`;
            if (!isObj(k)) return c.fail(`${kw} must be an object`);
            const time = c.num(k, 'time', kw);
            if (time < 0) c.fail(`${kw}.time must not be negative`);
            if (time <= prev) c.fail(`${kw} keys must be sorted by strictly increasing time`);
            prev = time;
            const value = Array.isArray(k.value) ? k.value : [];
            if (value.length !== CHANNEL_ARITY[ch] || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
              c.fail(`${kw}.value must be ${CHANNEL_ARITY[ch]} finite number(s)`);
            }
            const interp = k.interp ?? 'linear';
            if (!INTERPS.includes(interp as Key['interp'])) c.fail(`${kw}.interp "${String(interp)}" is not supported`);
            track[ch].push({ time, value: value.slice() as number[], interp: interp as Key['interp'] });
          });
        }
        tracks[boneId] = track;
      }
    }
    animations.push({ id, name: c.str(an, 'name', w), duration, fps, loop: an.loop !== false, tracks });
  });

  const used = new Set(attachments.map((a) => a.imageId));
  const unused = images.filter((im) => !used.has(im.id)).length;
  if (unused) c.warnings.push(`${unused} image(s) are not attached to anything.`);

  if (c.errors.length) return { ok: false, errors: c.errors };
  return {
    ok: true,
    warnings: c.warnings,
    project: { format: FORMAT_ID, version: FORMAT_VERSION, name, bones, images, attachments, animations },
  };
}
