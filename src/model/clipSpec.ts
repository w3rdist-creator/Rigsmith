// Clip specs (R6): an animation as text — JSON or the YAML subset in yamlLite.ts — that
// names bones, attachments, images and constraints instead of ids, so a factory can
// write clips from a motion spec and re-apply them after art changes.
//
//   format: rigsmith.clip        # optional header
//   version: 1
//   name: wave                   # the animation (created, or replaced with `replace`)
//   fps: 30
//   length: 30                   # frames, or "1.5s"
//   loop: true
//   ease: smooth                 # default ease of keys that name none (default linear)
//   poses:                       # named poses: bone → rotate, or {rotate, translate, scale}
//     up: {arm: -140, hips: {translate: [0, -12]}}
//   timeline:                    # pose keys: every bone/channel any entry uses is keyed at
//     - {at: 0, pose: rest}      # every entry (setup value where an entry omits it)
//     - {at: 10, pose: [up, smile], ease: ease-out}
//     - {at: 20, hold: true}     # the previous entry's values again
//   bones:                       # explicit keys (they win over timeline keys at the same time)
//     hips:
//       translate: [[0, 0, 0], [15, 0, -8, ease-out], {at: 30, value: [0, 0], easeY: step}]
//   slots:                       # by attachment name
//     eyes: {image: [[0, eyes_open], [12, eyes_closed]], visible: [[0, true]], opacity: [[0, 1]],
//            color: [[0, "#ffffffff"]], deform: [{at: 0, value: rest}]}
//   drawOrder: [{at: 10, move: glow, to: front}, {at: 20, move: glow, below: body}, {at: 25, order: [a, b, c]}]
//   constraints: {arm_ik: {mix: [[0, 1], [10, 0]]}}
//   events: [[6, prop_flash], [12, sfx, win_small], {at: "0.9s", name: burst, payload: 3}]
//
// Times (`at`, `length`): a number is a frame (time = frame / fps); "0.125s" is seconds.
// Eases: linear, step, smooth, a curve preset name (ease-in, ease-out, ease-in-out,
// overshoot, anticipate, back-in-out) or `bezier` with `curve: [x1, y1, x2, y2]`;
// translate keys may add `easeY` / `curveY` (separate y easing, v3).
//
// exportClip writes an animation losslessly (frames only where frame / fps is exactly the
// stored time; raw curves where no preset matches), so applyClip(exportClip(a)) evaluates
// identically to a. Every apply is checked by the editor's own project reader.
import { CURVE_PRESETS } from './curve.ts';
import { drawOrderAt } from './evaluate.ts';
import { formatColor, parseColor } from './color.ts';
import { insertSorted, findKeyIndex } from './animation.ts';
import { parseProject, serializeProject } from './format.ts';
import { EMITTER_MAX_RATE } from './types.ts';
import type { Animation, Bone, Channel, ConstraintTrack, Curve, DrawOrderKey, ImageKey, Interp, Key, Project, SlotTrack } from './types.ts';
import { EVENT_NAME, cloneProject, emptyTrack } from './types.ts';
import { flatEvents } from './events.ts';
import { parseYaml, stringifyYaml } from './yamlLite.ts';
import type { YamlValue } from './yamlLite.ts';

export const CLIP_FORMAT = 'rigsmith.clip';
export type ClipSpec = { [k: string]: YamlValue };
export type ClipMode = 'create' | 'replace' | 'merge';
export type ApplyResult = { ok: true; project: Project; animId: string; keys: number; created: boolean } | { ok: false; errors: string[] };

const BONE_CHANNELS: readonly Channel[] = ['translate', 'rotate', 'scale'];
const SLOT_CH = ['visible', 'opacity', 'image', 'deform', 'color', 'rate'] as const;
const CON_CH = ['mix', 'position', 'angle'] as const;
const INTERP_NAMES: readonly Interp[] = ['linear', 'step', 'smooth', 'bezier'];
/** Presets addressable by name; linear and smooth are interpolations of their own. */
const NAMED = Object.entries(CURVE_PRESETS).filter(([n]) => n !== 'linear' && n !== 'smooth') as [string, Curve][];
const TOP_KEYS = new Set(['format', 'version', 'name', 'fps', 'length', 'loop', 'ease', 'poses', 'timeline', 'bones', 'slots', 'drawOrder', 'constraints', 'events']);

const isObj = (v: unknown): v is { [k: string]: YamlValue } => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parses a spec file: JSON when the name ends in .json or the text starts with `{`, else the YAML subset. */
export function parseClipText(text: string, fileName = ''): { ok: true; spec: ClipSpec } | { ok: false; errors: string[] } {
  let value: YamlValue;
  if (/\.json$/i.test(fileName) || /^\s*\{/.test(text)) {
    try {
      value = JSON.parse(text) as YamlValue;
    } catch (e) {
      return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`] };
    }
  } else {
    const r = parseYaml(text);
    if (!r.ok) return r;
    value = r.value;
  }
  return isObj(value) ? { ok: true, spec: value } : { ok: false, errors: ['A clip spec is a map (name, fps, bones, …).'] };
}

/** YAML (default) or JSON text of a spec. */
export function formatClipSpec(spec: ClipSpec, json = false): string {
  return json ? JSON.stringify(spec, null, 1) + '\n' : stringifyYaml(spec, 'Rigsmith clip spec (docs/cli.md → Clip specs)');
}

// ---- reading ---------------------------------------------------------------------------

interface Ctx {
  project: Project;
  fps: number;
  duration: number;
  defaultEase: string;
  errors: string[];
}

function byName<T extends { id: string; name: string }>(list: readonly T[], name: unknown, kind: string, where: string, ctx: Ctx): T | null {
  if (typeof name !== 'string') {
    ctx.errors.push(`${where}: ${kind} name must be a string`);
    return null;
  }
  const hits = list.filter((x) => x.name === name);
  if (hits.length === 1) return hits[0];
  ctx.errors.push(`${where}: ${hits.length ? `${kind} name “${name}” is ambiguous (${hits.length} share it)` : `unknown ${kind} “${name}”`}`);
  return null;
}

/** A time: a frame number (time = frame / fps) or "<seconds>s". */
function readTime(v: unknown, where: string, ctx: Ctx): number | null {
  let t: number | null = null;
  if (isNum(v)) t = v / ctx.fps;
  else if (typeof v === 'string' && /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?s$/.test(v)) t = parseFloat(v);
  if (t === null) {
    ctx.errors.push(`${where}: a time is a frame number or "<seconds>s" (got ${JSON.stringify(v)})`);
    return null;
  }
  if (t < 0) ctx.errors.push(`${where}: time must not be negative`);
  else if (t > ctx.duration + 1e-9) ctx.errors.push(`${where}: time ${fmtTime(t, ctx.fps)} is past the clip's end (${fmtTime(ctx.duration, ctx.fps)})`);
  return t;
}

const fmtTime = (t: number, fps: number) => (Number.isInteger(t * fps) && (t * fps) / fps === t ? `frame ${t * fps}` : `${t}s`);

function readCurve(v: unknown, where: string, ctx: Ctx): Curve | null {
  if (Array.isArray(v) && v.length === 4 && v.every(isNum) && v[0] >= 0 && v[0] <= 1 && v[2] >= 0 && v[2] <= 1) return v.slice() as Curve;
  ctx.errors.push(`${where}: curve must be [x1, y1, x2, y2] with x1 and x2 from 0 to 1`);
  return null;
}

/** An ease name (+ optional curve) → interp/curve. */
function readEase(name: unknown, curve: unknown, where: string, ctx: Ctx): { interp: Interp; curve?: Curve } | null {
  if (name === undefined && curve !== undefined) name = 'bezier';
  if (typeof name !== 'string') {
    ctx.errors.push(`${where}: ease must be a name`);
    return null;
  }
  const preset = NAMED.find(([n]) => n === name);
  if (preset) {
    if (curve !== undefined) ctx.errors.push(`${where}: ease “${name}” is a preset; give either it or a curve`);
    return { interp: 'bezier', curve: preset[1].slice() as Curve };
  }
  if (!INTERP_NAMES.includes(name as Interp)) {
    ctx.errors.push(`${where}: unknown ease “${name}” (use linear, step, smooth, bezier + curve, or ${NAMED.map(([n]) => n).join(', ')})`);
    return null;
  }
  if (name === 'bezier') {
    if (curve === undefined) {
      ctx.errors.push(`${where}: ease bezier needs a curve`);
      return null;
    }
    const c = readCurve(curve, where, ctx);
    return c ? { interp: 'bezier', curve: c } : null;
  }
  if (curve !== undefined) ctx.errors.push(`${where}: a curve needs ease bezier`);
  return { interp: name as Interp };
}

type Kind = 'translate' | 'rotate' | 'scale' | 'opacity' | 'visible' | 'color' | 'deform' | 'rate' | 'mix' | 'position' | 'angle';

/** Value arity and range per channel (`n` = mesh vertex count for deform). */
function checkValue(kind: Kind, v: number[], n: number | undefined): string | null {
  const len = kind === 'translate' || kind === 'scale' ? 2 : kind === 'color' ? 4 : kind === 'deform' ? 2 * (n ?? 0) : 1;
  if (v.length !== len) return kind === 'deform' ? `deform needs ${len} offsets (2 per mesh vertex; the mesh has ${n ?? 0} vertices), got ${v.length}` : `${kind} needs ${len} number(s), got ${v.length}`;
  if (!v.every(isNum)) return `${kind} values must be finite numbers`;
  if ((kind === 'opacity' || kind === 'mix' || kind === 'position' || kind === 'color') && !v.every((x) => x >= 0 && x <= 1)) return `${kind} values must be from 0 to 1`;
  if (kind === 'visible' && !(v[0] === 0 || v[0] === 1)) return 'visible must be true or false';
  if (kind === 'rate' && !(v[0] >= 0 && v[0] <= EMITTER_MAX_RATE)) return `rate must be from 0 to ${EMITTER_MAX_RATE} particles per second`;
  return null;
}

/** A value in spec form → numbers. */
function toNumbers(kind: Kind, raw: YamlValue, n: number | undefined): number[] | string {
  if (kind === 'color' && typeof raw === 'string') return parseColor(raw) ?? `colour must be #rrggbb or #rrggbbaa (got “${raw}”)`;
  if (kind === 'visible' && typeof raw === 'boolean') return [raw ? 1 : 0];
  if (kind === 'deform' && raw === 'rest') return new Array<number>(2 * (n ?? 0)).fill(0);
  if (isNum(raw)) return [raw];
  if (Array.isArray(raw)) return raw as number[];
  return `bad value ${JSON.stringify(raw)}`;
}

/** Reads one key in array or object form. */
function readKey(kind: Kind, raw: YamlValue, where: string, ctx: Ctx, n?: number): Key | null {
  let at: YamlValue | undefined, value: YamlValue | undefined, ease: YamlValue | undefined, curve: YamlValue | undefined, easeY: YamlValue | undefined, curveY: YamlValue | undefined;
  if (Array.isArray(raw)) {
    if (raw.length < 2) {
      ctx.errors.push(`${where}: a key is [at, value…, ease?]`);
      return null;
    }
    at = raw[0];
    let rest = raw.slice(1);
    // A trailing name is the ease (a single string is the value: a colour or deform "rest").
    if (rest.length >= 2 && typeof rest[rest.length - 1] === 'string') {
      ease = rest[rest.length - 1];
      rest = rest.slice(0, -1);
    }
    value = rest.length === 1 ? rest[0] : rest;
  } else if (isObj(raw)) {
    for (const k of Object.keys(raw)) if (!['at', 'value', 'ease', 'curve', 'easeY', 'curveY'].includes(k)) ctx.errors.push(`${where}: unknown field “${k}”`);
    ({ at, value, ease, curve, easeY, curveY } = raw);
    if (value === undefined) {
      ctx.errors.push(`${where}: missing value`);
      return null;
    }
  } else {
    ctx.errors.push(`${where}: a key is [at, value…, ease?] or {at, value, ease?}`);
    return null;
  }
  const time = readTime(at, `${where}.at`, ctx);
  const nums = toNumbers(kind, value!, n);
  if (typeof nums === 'string') {
    ctx.errors.push(`${where}: ${nums}`);
    return null;
  }
  const bad = checkValue(kind, nums, n);
  if (bad) ctx.errors.push(`${where}: ${bad}`);
  const e = readEase(ease ?? (curve !== undefined ? undefined : kind === 'visible' ? 'step' : ctx.defaultEase), curve, where, ctx);
  if (time === null || bad || !e) return null;
  const key: Key = { time, value: nums, interp: e.interp, ...(e.curve ? { curve: e.curve } : {}) };
  if (easeY !== undefined || curveY !== undefined) {
    if (kind !== 'translate') ctx.errors.push(`${where}: easeY is only for translate keys`);
    else {
      const ey = readEase(easeY, curveY, `${where}.easeY`, ctx);
      if (ey) {
        key.interpY = ey.interp;
        if (ey.curve) key.curveY = ey.curve;
      }
    }
  }
  return key;
}

function readKeyList(kind: Kind, raw: YamlValue | undefined, where: string, ctx: Ctx, n?: number): Key[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    ctx.errors.push(`${where}: must be a list of keys`);
    return [];
  }
  const out: Key[] = [];
  raw.forEach((k, i) => {
    const key = readKey(kind, k, `${where}[${i}]`, ctx, n);
    if (key) put(out, key);
  });
  return out;
}

/** Inserts or replaces (same time) keeping the list sorted. */
function put<K extends { time: number }>(list: K[], key: K): void {
  const i = findKeyIndex(list, key.time);
  if (i >= 0) list[i] = key;
  else insertSorted(list, key);
}

// ---- poses -----------------------------------------------------------------------------

type PoseVals = Map<string, Partial<Record<Channel, number[]>>>;

function readPose(raw: YamlValue, where: string, ctx: Ctx, poses: Map<string, PoseVals>): PoseVals {
  const out: PoseVals = new Map();
  const merge = (p: PoseVals) => {
    for (const [b, ch] of p) out.set(b, { ...(out.get(b) ?? {}), ...ch });
  };
  if (typeof raw === 'string' || Array.isArray(raw)) {
    for (const name of Array.isArray(raw) ? raw : [raw]) {
      const p = typeof name === 'string' ? poses.get(name) : undefined;
      if (!p) ctx.errors.push(`${where}: unknown pose “${String(name)}”`);
      else merge(p);
    }
    return out;
  }
  if (!isObj(raw)) {
    ctx.errors.push(`${where}: a pose is a pose name, a list of names or a map of bones`);
    return out;
  }
  for (const [boneName, v] of Object.entries(raw)) {
    const bone = byName(ctx.project.bones, boneName, 'bone', `${where}.${boneName}`, ctx);
    if (!bone) continue;
    const ch: Partial<Record<Channel, number[]>> = {};
    if (isNum(v)) ch.rotate = [v];
    else if (isObj(v)) {
      for (const [c, x] of Object.entries(v)) {
        if (!BONE_CHANNELS.includes(c as Channel)) {
          ctx.errors.push(`${where}.${boneName}: unknown channel “${c}” (rotate, translate, scale)`);
          continue;
        }
        const nums = isNum(x) ? [x] : Array.isArray(x) ? (x as number[]) : [];
        const bad = checkValue(c as Kind, nums, undefined);
        if (bad) ctx.errors.push(`${where}.${boneName}.${c}: ${bad}`);
        else ch[c as Channel] = nums.slice();
      }
    } else ctx.errors.push(`${where}.${boneName}: rotate degrees or {rotate, translate, scale}`);
    out.set(bone.id, ch);
  }
  return out;
}

const setupValue = (b: Bone, ch: Channel): number[] => (ch === 'translate' ? [b.x, b.y] : ch === 'rotate' ? [b.rotation] : [b.scaleX, b.scaleY]);

function applyTimeline(spec: ClipSpec, anim: Animation, ctx: Ctx): void {
  const poses = new Map<string, PoseVals>();
  if (spec.poses !== undefined) {
    if (!isObj(spec.poses)) ctx.errors.push('poses: must be a map of named poses');
    else for (const [name, p] of Object.entries(spec.poses)) poses.set(name, readPose(p, `poses.${name}`, ctx, poses));
  }
  if (spec.timeline === undefined) return;
  if (!Array.isArray(spec.timeline)) return void ctx.errors.push('timeline: must be a list of {at, pose | hold, ease?}');
  const entries: { time: number; vals: PoseVals; ease: { interp: Interp; curve?: Curve } }[] = [];
  spec.timeline.forEach((raw, i) => {
    const w = `timeline[${i}]`;
    if (!isObj(raw)) return void ctx.errors.push(`${w}: must be {at, pose | hold, ease?}`);
    for (const k of Object.keys(raw)) if (!['at', 'pose', 'hold', 'ease', 'curve'].includes(k)) ctx.errors.push(`${w}: unknown field “${k}”`);
    const time = readTime(raw.at, `${w}.at`, ctx);
    const ease = readEase(raw.ease ?? (raw.curve !== undefined ? undefined : ctx.defaultEase), raw.curve, w, ctx);
    let vals: PoseVals;
    if (raw.hold === true) {
      if (raw.pose !== undefined) ctx.errors.push(`${w}: give pose or hold, not both`);
      if (!entries.length) ctx.errors.push(`${w}: hold needs an earlier entry`);
      vals = entries.at(-1)?.vals ?? new Map();
    } else if (raw.pose !== undefined) vals = readPose(raw.pose, `${w}.pose`, ctx, poses);
    else return void ctx.errors.push(`${w}: needs pose or hold: true`);
    if (time !== null && ease) {
      if (entries.length && time <= entries.at(-1)!.time) ctx.errors.push(`${w}: entries must be in increasing time order`);
      entries.push({ time, vals, ease });
    }
  });
  // Every (bone, channel) any entry uses is keyed at every entry: the setup value where omitted.
  const used = new Map<string, Set<Channel>>();
  for (const e of entries) for (const [b, ch] of e.vals) for (const c of Object.keys(ch) as Channel[]) (used.get(b) ?? used.set(b, new Set()).get(b)!).add(c);
  for (const [boneId, chs] of used) {
    const bone = ctx.project.bones.find((b) => b.id === boneId)!;
    const track = (anim.tracks[boneId] ??= emptyTrack());
    for (const ch of BONE_CHANNELS) {
      if (!chs.has(ch)) continue;
      for (const e of entries) put(track[ch], { time: e.time, value: (e.vals.get(boneId)?.[ch] ?? setupValue(bone, ch)).slice(), interp: e.ease.interp, ...(e.ease.curve ? { curve: e.ease.curve.slice() as Curve } : {}) });
    }
  }
}

// ---- draw order ------------------------------------------------------------------------

function applyDrawOrder(spec: ClipSpec, anim: Animation, ctx: Ctx): void {
  if (spec.drawOrder === undefined) return;
  if (!Array.isArray(spec.drawOrder)) return void ctx.errors.push('drawOrder: must be a list');
  const atts = ctx.project.attachments;
  const parsed: { time: number; raw: { [k: string]: YamlValue }; w: string }[] = [];
  spec.drawOrder.forEach((raw, i) => {
    const w = `drawOrder[${i}]`;
    if (!isObj(raw)) return void ctx.errors.push(`${w}: must be {at, order} or {at, move, to | above | below}`);
    for (const k of Object.keys(raw)) if (!['at', 'order', 'move', 'to', 'above', 'below'].includes(k)) ctx.errors.push(`${w}: unknown field “${k}”`);
    const time = readTime(raw.at, `${w}.at`, ctx);
    if (time !== null) parsed.push({ time, raw, w });
  });
  parsed.sort((a, b) => a.time - b.time);
  for (const { time, raw, w } of parsed) {
    let order: string[] | null = null;
    if (raw.order !== undefined) {
      if (!Array.isArray(raw.order)) {
        ctx.errors.push(`${w}.order: must list attachment names back to front`);
        continue;
      }
      const ids = raw.order.map((n, j) => byName(atts, n, 'attachment', `${w}.order[${j}]`, ctx)?.id ?? null);
      if (ids.includes(null)) continue;
      if (new Set(ids).size !== ids.length || ids.length !== atts.length) {
        ctx.errors.push(`${w}.order: must list every attachment exactly once (${atts.length}), or use move`);
        continue;
      }
      order = ids as string[];
    } else if (raw.move !== undefined) {
      const att = byName(atts, raw.move, 'attachment', `${w}.move`, ctx);
      const dests = (['to', 'above', 'below'] as const).filter((k) => raw[k] !== undefined);
      if (dests.length !== 1) {
        ctx.errors.push(`${w}: move needs exactly one of to (front | back), above or below`);
        continue;
      }
      if (!att) continue;
      // The order in effect just before this key (a key at the same time is replaced).
      const before = keyBefore(ctx.project, anim, time) ?? ctx.project.attachments.map((a) => a.id);
      const rest = before.filter((id) => id !== att.id);
      const d = dests[0];
      if (d === 'to') {
        if (raw.to === 'front') rest.push(att.id);
        else if (raw.to === 'back') rest.unshift(att.id);
        else {
          ctx.errors.push(`${w}.to: front or back`);
          continue;
        }
      } else {
        const ref = byName(atts, raw[d], 'attachment', `${w}.${d}`, ctx);
        if (!ref) continue;
        if (ref.id === att.id) {
          ctx.errors.push(`${w}: an attachment cannot move ${d} itself`);
          continue;
        }
        const j = rest.indexOf(ref.id);
        rest.splice(d === 'above' ? j + 1 : j, 0, att.id);
      }
      order = rest;
    } else {
      ctx.errors.push(`${w}: needs order or move`);
      continue;
    }
    put((anim.drawOrder ??= []), { time, order } as DrawOrderKey);
  }
}

/** The keyed order before `time`, as drawOrderAt shows it (later attachments on top). */
function keyBefore(project: Project, anim: Animation, time: number): string[] | null {
  let key: DrawOrderKey | undefined;
  for (const k of anim.drawOrder ?? []) if (k.time < time - 1e-9) key = k;
  return key ? drawOrderAt(project, { ...anim, drawOrder: [key] }, key.time).map((a) => a.id) : null;
}

// ---- apply -----------------------------------------------------------------------------

function newAnimId(p: Project, name: string): string {
  const base = `anim_${name.replace(/[^A-Za-z0-9_-]+/g, '_') || 'clip'}`;
  let id = base;
  for (let n = 2; p.animations.some((a) => a.id === id); n++) id = `${base}_${n}`;
  return id;
}

/**
 * Builds the spec's animation into a copy of the project. `create` (default) refuses an
 * existing name; `replace` rebuilds it in place (same id, so mixes and sequences keep it);
 * `merge` adds the spec's keys to it (a key at the same time replaces the old one).
 */
export function applyClip(project: Project, spec: ClipSpec, mode: ClipMode = 'create'): ApplyResult {
  const errors: string[] = [];
  for (const k of Object.keys(spec)) if (!TOP_KEYS.has(k)) errors.push(`unknown top-level field “${k}”`);
  if (spec.format !== undefined && spec.format !== CLIP_FORMAT) errors.push(`format must be ${CLIP_FORMAT}`);
  if (spec.version !== undefined && spec.version !== 1) errors.push('version must be 1');
  if (typeof spec.name !== 'string' || !spec.name.trim()) errors.push('name: the animation name is required');
  if (errors.length) return { ok: false, errors };
  const name = spec.name as string;
  const p = cloneProject(project);
  const existing = p.animations.find((a) => a.name === name) ?? null;
  if (mode === 'create' && existing) return { ok: false, errors: [`An animation named “${name}” exists; apply with replace (CLI --replace) or merge.`] };
  if (mode === 'merge' && !existing) return { ok: false, errors: [`No animation named “${name}” to add keys to.`] };
  const fps = spec.fps ?? existing?.fps ?? 30;
  if (!isNum(fps) || !Number.isInteger(fps) || fps < 1 || fps > 240) return { ok: false, errors: ['fps: a whole number from 1 to 240'] };
  if (mode === 'merge' && fps !== existing!.fps) return { ok: false, errors: [`fps ${fps} differs from “${name}” (${existing!.fps}); merge keeps the animation's fps.`] };
  const ctx: Ctx = { project: p, fps, duration: Infinity, defaultEase: 'linear', errors };
  let duration = existing?.duration ?? 1;
  if (spec.length !== undefined) {
    const d = readTime(spec.length, 'length', ctx);
    if (d !== null && !(d > 0)) errors.push('length: must be more than 0');
    if (d !== null) duration = d;
  } else if (mode !== 'merge' && !existing) errors.push('length: frames or "<seconds>s" (required for a new animation)');
  ctx.duration = duration;
  if (spec.loop !== undefined && typeof spec.loop !== 'boolean') errors.push('loop: true or false');
  if (spec.ease !== undefined) {
    if (readEase(spec.ease, undefined, 'ease', ctx)) ctx.defaultEase = spec.ease as string;
  }
  const anim: Animation =
    mode === 'merge'
      ? existing!
      : { id: existing?.id ?? newAnimId(p, name), name, duration, fps, loop: (spec.loop as boolean | undefined) ?? existing?.loop ?? true, tracks: {} };
  if (mode === 'merge') {
    anim.duration = duration;
    if (typeof spec.loop === 'boolean') anim.loop = spec.loop;
  }
  applyTimeline(spec, anim, ctx);
  // Bones.
  if (spec.bones !== undefined) {
    if (!isObj(spec.bones)) errors.push('bones: must be a map of bone names');
    else
      for (const [bn, chs] of Object.entries(spec.bones)) {
        const bone = byName(p.bones, bn, 'bone', `bones.${bn}`, ctx);
        if (!bone) continue;
        if (!isObj(chs)) {
          errors.push(`bones.${bn}: must be {translate, rotate, scale}`);
          continue;
        }
        const track = (anim.tracks[bone.id] ??= emptyTrack());
        for (const [ch, list] of Object.entries(chs)) {
          if (!BONE_CHANNELS.includes(ch as Channel)) {
            errors.push(`bones.${bn}: unknown channel “${ch}” (translate, rotate, scale)`);
            continue;
          }
          for (const k of readKeyList(ch as Kind, list, `bones.${bn}.${ch}`, ctx)) put(track[ch as Channel], k);
        }
      }
  }
  // Slots.
  if (spec.slots !== undefined) {
    if (!isObj(spec.slots)) errors.push('slots: must be a map of attachment names');
    else
      for (const [an, chs] of Object.entries(spec.slots)) {
        const att = byName(p.attachments, an, 'attachment', `slots.${an}`, ctx);
        if (!att) continue;
        if (!isObj(chs)) {
          errors.push(`slots.${an}: must be {visible, opacity, image, deform, color, rate}`);
          continue;
        }
        anim.slots ??= {};
        const st: SlotTrack = (anim.slots[att.id] ??= {});
        for (const [ch, list] of Object.entries(chs)) {
          const w = `slots.${an}.${ch}`;
          if (!(SLOT_CH as readonly string[]).includes(ch)) {
            errors.push(`slots.${an}: unknown channel “${ch}” (${SLOT_CH.join(', ')})`);
            continue;
          }
          if (ch === 'image') {
            readImageKeys(list, w, ctx, (st.image ??= []));
            continue;
          }
          if (ch === 'deform' && !att.mesh) {
            errors.push(`${w}: “${an}” has no mesh`);
            continue;
          }
          if (ch === 'rate' && !att.emitter) {
            errors.push(`${w}: “${an}” is not an emitter`);
            continue;
          }
          const keys = readKeyList(ch as Kind, list, w, ctx, att.mesh ? att.mesh.points.length / 2 : undefined);
          const dest = ((st as Record<string, Key[]>)[ch] ??= []);
          for (const k of keys) put(dest, k);
        }
      }
  }
  applyDrawOrder(spec, anim, ctx);
  applyEvents(spec, anim, ctx);
  // Constraints.
  if (spec.constraints !== undefined) {
    if (!isObj(spec.constraints)) errors.push('constraints: must be a map of constraint names');
    else {
      const all = [...(p.ik ?? []).map((c) => ({ ...c, kind: 'ik' })), ...(p.pathConstraints ?? []).map((c) => ({ ...c, kind: 'path' })), ...(p.transformConstraints ?? []).map((c) => ({ ...c, kind: 'transform' }))];
      for (const [cn, chs] of Object.entries(spec.constraints)) {
        const con = byName(all, cn, 'constraint', `constraints.${cn}`, ctx);
        if (!con) continue;
        if (!isObj(chs)) {
          errors.push(`constraints.${cn}: must be {mix, position, angle}`);
          continue;
        }
        anim.constraints ??= {};
        const ct: ConstraintTrack = (anim.constraints[con.id] ??= {});
        for (const [ch, list] of Object.entries(chs)) {
          if (!(CON_CH as readonly string[]).includes(ch)) {
            errors.push(`constraints.${cn}: unknown channel “${ch}” (mix, position, angle)`);
            continue;
          }
          if (ch === 'position' && con.kind !== 'path') errors.push(`constraints.${cn}.position: only path constraints have a position`);
          else if (ch === 'angle' && con.kind !== 'transform') errors.push(`constraints.${cn}.angle: only transform constraints have an angle`);
          else for (const k of readKeyList(ch as Kind, list, `constraints.${cn}.${ch}`, ctx)) put(((ct as Record<string, Key[]>)[ch] ??= []), k);
        }
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  if (!existing) p.animations.push(anim);
  else if (mode === 'replace') p.animations[p.animations.indexOf(existing)] = anim;
  // The editor's own reader is the final check (the same one every authoring command uses).
  const check = parseProject(serializeProject(p));
  if (!check.ok) return { ok: false, errors: check.errors };
  return { ok: true, project: p, animId: anim.id, keys: countKeys(anim), created: !existing };
}

/** events: [at, name, payload?] or {at, name, payload?}; a name + time pair is one key. */
function applyEvents(spec: ClipSpec, anim: Animation, ctx: Ctx): void {
  if (spec.events === undefined) return;
  if (!Array.isArray(spec.events)) return void ctx.errors.push('events: must be a list of [at, name, payload?]');
  spec.events.forEach((raw, i) => {
    const w = `events[${i}]`;
    let at: YamlValue | undefined, name: YamlValue | undefined, payload: YamlValue | undefined;
    if (Array.isArray(raw) && (raw.length === 2 || raw.length === 3)) [at, name, payload] = raw;
    else if (isObj(raw)) {
      for (const k of Object.keys(raw)) if (!['at', 'name', 'payload'].includes(k)) ctx.errors.push(`${w}: unknown field “${k}”`);
      ({ at, name, payload } = raw);
    } else return void ctx.errors.push(`${w}: an event is [at, name, payload?] or {at, name, payload?}`);
    const time = readTime(at, `${w}.at`, ctx);
    if (typeof name !== 'string' || !EVENT_NAME.test(name)) return void ctx.errors.push(`${w}: event names are 1–64 letters, digits and _ . : - (got ${JSON.stringify(name)})`);
    if (payload !== undefined && !(typeof payload === 'string' ? payload.length <= 256 : isNum(payload))) return void ctx.errors.push(`${w}: payload is a string (at most 256 characters) or a number`);
    if (time === null) return;
    anim.events ??= {};
    put((anim.events[name] ??= []), { time, ...(payload !== undefined ? { payload: payload as string | number } : {}) });
  });
}

function readImageKeys(list: YamlValue | undefined, w: string, ctx: Ctx, dest: ImageKey[]): void {
  if (!Array.isArray(list)) return void ctx.errors.push(`${w}: must be a list of [at, image]`);
  list.forEach((raw, i) => {
    const kw = `${w}[${i}]`;
    const at = Array.isArray(raw) ? raw[0] : isObj(raw) ? raw.at : undefined;
    const img = Array.isArray(raw) ? raw[1] : isObj(raw) ? raw.image : undefined;
    if ((Array.isArray(raw) && raw.length !== 2) || (!Array.isArray(raw) && !isObj(raw))) return void ctx.errors.push(`${kw}: an image key is [at, image name]`);
    const time = readTime(at, `${kw}.at`, ctx);
    const im = byName(ctx.project.images, img, 'image', kw, ctx);
    if (time !== null && im) put(dest, { time, imageId: im.id });
  });
}

function countKeys(a: Animation): number {
  let n = a.drawOrder?.length ?? 0;
  for (const tr of Object.values(a.tracks)) for (const ch of BONE_CHANNELS) n += tr[ch].length;
  for (const st of Object.values(a.slots ?? {})) for (const ch of SLOT_CH) n += st[ch]?.length ?? 0;
  for (const ct of Object.values(a.constraints ?? {})) for (const ch of CON_CH) n += ct[ch]?.length ?? 0;
  for (const ks of Object.values(a.events ?? {})) n += ks.length;
  return n;
}

/** Problems a spec would hit against this project, without changing it (exit 1 in `clip lint`). */
export function lintClip(project: Project, spec: ClipSpec, mode: ClipMode = 'replace'): string[] {
  const r = applyClip(project, spec, mode);
  return r.ok ? [] : r.errors;
}

// ---- export ----------------------------------------------------------------------------

/** Lossless spec of an animation (see the header). Throws when names are ambiguous. */
export function exportClip(project: Project, animId: string): ClipSpec {
  const anim = project.animations.find((a) => a.id === animId);
  if (!anim) throw new Error('No such animation.');
  const fps = anim.fps;
  const dup = (kind: string, list: readonly { id: string; name: string }[], used: Set<string>) => {
    for (const x of list) if (used.has(x.id) && list.filter((y) => y.name === x.name).length > 1) throw new Error(`Two ${kind}s are named “${x.name}”; rename one before exporting (a spec refers to names).`);
  };
  const time = (t: number): YamlValue => {
    const f = Math.round(t * fps);
    return f / fps === t ? f : `${t}s`;
  };
  const easeOf = (interp: Interp, curve: Curve | undefined): { ease: string; curve?: Curve } => {
    if (interp !== 'bezier') return { ease: interp };
    const named = curve && NAMED.find(([, c]) => c.every((v, i) => Object.is(v, curve[i])));
    return named ? { ease: named[0] } : { ease: 'bezier', curve: curve ?? (CURVE_PRESETS.linear.slice() as Curve) };
  };
  // The most common ease is the default, so it need not be repeated per key.
  const tally = new Map<string, number>();
  const allKeys: Key[] = [];
  for (const tr of Object.values(anim.tracks)) for (const ch of BONE_CHANNELS) allKeys.push(...tr[ch]);
  for (const st of Object.values(anim.slots ?? {})) for (const ch of ['opacity', 'color', 'deform', 'rate'] as const) allKeys.push(...(st[ch] ?? []));
  for (const ct of Object.values(anim.constraints ?? {})) for (const ch of CON_CH) allKeys.push(...(ct[ch] ?? []));
  for (const k of allKeys) {
    const e = easeOf(k.interp, k.curve);
    if (!e.curve) tally.set(e.ease, (tally.get(e.ease) ?? 0) + 1);
  }
  const def = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'linear';
  const key = (k: Key, value: YamlValue, defEase: string): YamlValue => {
    const e = easeOf(k.interp, k.curve);
    const ey = k.interpY ? easeOf(k.interpY, k.curveY) : null;
    if (!e.curve && !ey && !(Array.isArray(value) && value.length > 4)) {
      const head: YamlValue[] = [time(k.time), ...(Array.isArray(value) ? value : [value])];
      return e.ease === defEase ? head : [...head, e.ease];
    }
    return {
      at: time(k.time),
      value,
      ...(e.ease !== defEase || e.curve ? { ease: e.ease } : {}),
      ...(e.curve ? { curve: e.curve } : {}),
      ...(ey ? { easeY: ey.ease, ...(ey.curve ? { curveY: ey.curve } : {}) } : {}),
    };
  };
  const spec: ClipSpec = { format: CLIP_FORMAT, version: 1, name: anim.name, fps, length: time(anim.duration), loop: anim.loop, ease: def };
  const usedBones = new Set(Object.keys(anim.tracks));
  dup('bone', project.bones, usedBones);
  const bones: ClipSpec = {};
  for (const b of project.bones) {
    const tr = anim.tracks[b.id];
    if (!tr) continue;
    const chs: ClipSpec = {};
    for (const ch of BONE_CHANNELS) if (tr[ch].length) chs[ch] = tr[ch].map((k) => key(k, ch === 'rotate' ? k.value[0] : k.value.slice(), def));
    if (Object.keys(chs).length) bones[b.name] = chs;
  }
  if (Object.keys(bones).length) spec.bones = bones;
  const usedAtts = new Set([...Object.keys(anim.slots ?? {}), ...(anim.drawOrder?.length ? project.attachments.map((a) => a.id) : [])]);
  dup('attachment', project.attachments, usedAtts);
  const usedImages = new Set<string>();
  for (const st of Object.values(anim.slots ?? {})) for (const k of st.image ?? []) usedImages.add(k.imageId);
  dup('image', project.images, usedImages);
  const imgName = (id: string) => project.images.find((i) => i.id === id)?.name ?? id;
  const slots: ClipSpec = {};
  for (const a of project.attachments) {
    const st = anim.slots?.[a.id];
    if (!st) continue;
    const chs: ClipSpec = {};
    if (st.visible?.length) chs.visible = st.visible.map((k) => key(k, k.value[0] === 1, 'step'));
    if (st.opacity?.length) chs.opacity = st.opacity.map((k) => key(k, k.value[0], def));
    if (st.image?.length) chs.image = st.image.map((k) => [time(k.time), imgName(k.imageId)]);
    if (st.color?.length) chs.color = st.color.map((k) => (k.value.every((v) => Math.round(v * 255) / 255 === v) ? key(k, formatColor(k.value), def) : key(k, k.value.slice(), def)));
    if (st.rate?.length) chs.rate = st.rate.map((k) => key(k, k.value[0], def));
    if (st.deform?.length) chs.deform = st.deform.map((k) => key(k, k.value.every((v) => v === 0 && !Object.is(v, -0)) ? 'rest' : k.value.slice(), def));
    if (Object.keys(chs).length) slots[a.name] = chs;
  }
  if (Object.keys(slots).length) spec.slots = slots;
  const attName = (id: string) => project.attachments.find((a) => a.id === id)?.name ?? id;
  if (anim.drawOrder?.length) spec.drawOrder = anim.drawOrder.map((k) => ({ at: time(k.time), order: k.order.map(attName) }));
  const cons = [...(project.ik ?? []), ...(project.pathConstraints ?? []), ...(project.transformConstraints ?? [])];
  dup('constraint', cons, new Set(Object.keys(anim.constraints ?? {})));
  const ctOut: ClipSpec = {};
  for (const c of cons) {
    const ct = anim.constraints?.[c.id];
    if (!ct) continue;
    const chs: ClipSpec = {};
    for (const ch of CON_CH) if (ct[ch]?.length) chs[ch] = ct[ch]!.map((k) => key(k, k.value[0], def));
    if (Object.keys(chs).length) ctOut[c.name] = chs;
  }
  if (Object.keys(ctOut).length) spec.constraints = ctOut;
  const events = flatEvents(anim);
  if (events.length) spec.events = events.map((e) => (e.payload !== undefined ? [time(e.time), e.name, e.payload] : [time(e.time), e.name]));
  return spec;
}

