// Renders an animation to a transparent PNG sequence packed in one ZIP. Pure with
// respect to editor state: it evaluates its own copy of the project at each sample time.
import type { Bounds, Frame } from '../model/evaluate.ts';
import { evaluate, frameBounds } from '../model/evaluate.ts';
import type { Mat } from '../model/math.ts';
import type { SequenceGeometry, SequencePlan, SequenceRequest } from '../model/sequence.ts';
import { SEQUENCE_LIMITS, checkCapacity, frameWarnings, planSequence, requestGeometry } from '../model/sequence.ts';
import type { ScheduledStep } from '../model/clipSequence.ts';
import { scheduleSequence } from '../model/clipSequence.ts';
import type { MixPlan } from '../model/mix.ts';
import { evaluateMix, planLength } from '../model/mix.ts';
import { buildZip } from '../model/zip.ts';
import type { ZipEntry } from '../model/zip.ts';
import type { Animation, ClipSequence, Project, ProjectFrame } from '../model/types.ts';
import type { ImageLookup } from './draw.ts';
import { drawFrame } from './draw.ts';

export interface SequenceSetup {
  anim: Animation;
  plan: SequencePlan;
  geometry: SequenceGeometry;
  frames: Frame[];
  /** Non-blocking notices (e.g. art clipped by the fixed project frame). */
  warnings: string[];
  /** Saved clip sequences: the step schedule (written to sequence.json). */
  schedule?: ScheduledStep[];
}

export type Prepared = { ok: true; setup: SequenceSetup } | { ok: false; errors: string[] };

/**
 * A transition (mix plan) as a one-shot sequence: frames 0..⌊length·fps⌋ at `fps`,
 * one stable canvas size (the fixed `frame` when given), named "<first>-to-<last>".
 */
export function prepareMixSequence(project: Project, mix: MixPlan, fps: number, skinId: string | null, scale = 1, padding = 4, frame: ProjectFrame | null = null): Prepared {
  const length = planLength(project, mix);
  const names = mix.entries.map((e) => project.animations.find((a) => a.id === e.animId)?.name ?? '?');
  if (!(length > 0) || names.includes('?')) return { ok: false, errors: ['Choose animations for the transition.'] };
  if (!Number.isInteger(fps) || fps < 1 || fps > 240) return { ok: false, errors: ['FPS must be a whole number from 1 to 240.'] };
  const last = Math.floor(length * fps + 1e-9);
  return prepareMixFrames(project, mix, fps, last + 1, { id: 'mix', name: names.join('-to-'), loop: false, duration: length }, skinId, scale, padding, frame);
}

/**
 * A saved clip sequence (src/model/clipSequence.ts) as one sequence: frames
 * 0 … total−1 at `fps`, sampled with the same mix evaluator as the Mix dialog.
 */
export function prepareClipSequence(project: Project, seq: ClipSequence, fps: number, skinId: string | null, scale = 1, padding = 4, frame: ProjectFrame | null = null): Prepared {
  const r = scheduleSequence(project, seq, fps);
  if (!r.ok) return r;
  if (r.schedule.totalFrames > SEQUENCE_LIMITS.maxFrames) return { ok: false, errors: [`${r.schedule.totalFrames} frames is more than the ${SEQUENCE_LIMITS.maxFrames}-frame limit; lower the repeats or the FPS.`] };
  const total = r.schedule.totalFrames;
  const prepared = prepareMixFrames(project, r.schedule.plan, fps, total, { id: 'sequence', name: seq.name, loop: seq.loop, duration: total / fps }, skinId, scale, padding, frame);
  if (prepared.ok) prepared.setup.schedule = r.schedule.steps;
  return prepared;
}

function prepareMixFrames(project: Project, mix: MixPlan, fps: number, count: number, id: { id: string; name: string; loop: boolean; duration: number }, skinId: string | null, scale: number, padding: number, frame: ProjectFrame | null): Prepared {
  if (!(scale > 0) || scale > 8) return { ok: false, errors: ['Scale must be greater than 0 and at most 8.'] };
  const frames = Array.from({ length: count }, (_, f) => f);
  const times = frames.map((f) => f / fps);
  const evaluated = times.map((t) => evaluateMix(project, mix, t, { skinId }));
  let b: Bounds | null = null;
  for (const f of evaluated) b = frameBounds(f, b);
  if (!b) return { ok: false, errors: ['Nothing visible to export: attach at least one visible image.'] };
  const geometry = requestGeometry(b, scale, padding, frame);
  const cap = checkCapacity(geometry, evaluated.length);
  if (cap.length) return { ok: false, errors: cap };
  const anim: Animation = { id: id.id, name: id.name, duration: id.duration, fps, loop: id.loop, tracks: {} };
  return { ok: true, setup: { anim, plan: { times, frames, lastFrame: count - 1 }, geometry, frames: evaluated, warnings: frameWarnings(b, frame, `“${anim.name}”`) } };
}

/** Validates the request, samples every frame and computes one stable canvas size. */
export function prepareSequence(project: Project, animId: string | null, req: SequenceRequest, skinId?: string | null): Prepared {
  const anim = project.animations.find((a) => a.id === animId) ?? null;
  const r = planSequence(anim, req);
  if (!r.ok) return r;
  const frames = r.plan.times.map((t) => evaluate(project, anim, t, { skinId }));
  let b: Bounds | null = null;
  for (const f of frames) b = frameBounds(f, b);
  if (!b) return { ok: false, errors: ['Nothing visible to export: attach at least one visible image.'] };
  const geometry = requestGeometry(b, req.scale, req.padding, req.frame);
  const cap = checkCapacity(geometry, frames.length);
  if (cap.length) return { ok: false, errors: cap };
  return { ok: true, setup: { anim: anim!, plan: r.plan, geometry, frames, warnings: frameWarnings(b, req.frame, `“${anim!.name}”`) } };
}

export function sequenceViewMatrix(geo: SequenceGeometry): Mat {
  return { a: geo.scale, b: 0, c: 0, d: geo.scale, tx: -geo.originX * geo.scale, ty: -geo.originY * geo.scale };
}

/** Draws one frame of a prepared sequence onto a transparent canvas of the sequence size. */
export function renderSequenceFrame(g: CanvasRenderingContext2D, setup: SequenceSetup, index: number, images: ImageLookup): void {
  const { geometry: geo } = setup;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, geo.width, geo.height);
  g.imageSmoothingEnabled = true;
  drawFrame(g, setup.frames[index], images, sequenceViewMatrix(geo));
}

export interface SequenceMeta {
  format: 'rigsmith.sequence';
  version: 1;
  project: string;
  animation: string;
  loop: boolean;
  fps: number;
  width: number;
  height: number;
  scale: number;
  padding: number;
  /** "project" = the project's fixed frame (padding unused); "fit" = union bounds + padding. */
  frame: 'project' | 'fit';
  /** World point at pixel (0,0); world = origin + px / scale. */
  origin: { x: number; y: number };
  endpointPolicy: string;
  /** Saved clip sequences only: each step's frame range in this export. */
  sequence?: { steps: { animation: string; repeat: number; startFrame: number; frames: number; framesPerPlay: number; mix: number }[] };
  frames: { index: number; frame: number; time: number; file: string }[];
}

export function sequenceFileName(setup: SequenceSetup, i: number): string {
  const base = safeName(setup.anim.name);
  return `${base}/${base}_${String(setup.plan.frames[i]).padStart(4, '0')}.png`;
}

export function safeName(s: string): string {
  return s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'animation';
}

export function sequenceMeta(project: Project, setup: SequenceSetup, req: SequenceRequest): SequenceMeta {
  return {
    format: 'rigsmith.sequence',
    version: 1,
    project: project.name,
    animation: setup.anim.name,
    loop: setup.anim.loop,
    fps: req.fps,
    width: setup.geometry.width,
    height: setup.geometry.height,
    scale: req.scale,
    padding: req.padding,
    frame: req.frame ? 'project' : 'fit',
    origin: { x: setup.geometry.originX, y: setup.geometry.originY },
    endpointPolicy: setup.schedule
      ? `clip sequence: frames 0–${setup.plan.lastFrame}; each play of a step contributes its frames 0…n−1 (n = round(duration·fps)), so the frame count is the sum over steps${setup.anim.loop ? '; the file loops back to frame 0' : ''}`
      : setup.anim.loop
      ? `loop: frame ${setup.plan.lastFrame + 1} (= duration) repeats frame 0 and is never exported`
      : `one-shot: frame ${setup.plan.lastFrame} (= duration) is the final pose and may be exported`,
    ...(setup.schedule ? { sequence: { steps: setup.schedule.map((st) => ({ animation: st.name, repeat: st.repeat, startFrame: st.startFrame, frames: st.frames, framesPerPlay: st.framesPerPlay, mix: st.mix })) } } : {}),
    frames: setup.plan.frames.map((f, i) => ({ index: i, frame: f, time: setup.plan.times[i], file: sequenceFileName(setup, i) })),
  };
}

export class Cancelled extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'Cancelled';
  }
}

/**
 * Encodes every frame as PNG and returns the ZIP bytes. `encode` turns a drawn canvas
 * into PNG bytes; `isCancelled` is polled between frames so a cancel leaves nothing.
 */
export async function encodeSequenceZip(
  project: Project,
  setup: SequenceSetup,
  req: SequenceRequest,
  images: ImageLookup,
  canvas: { width: number; height: number; getContext(id: '2d'): CanvasRenderingContext2D | null },
  encode: () => Promise<Uint8Array>,
  onProgress: (done: number, total: number) => void,
  isCancelled: () => boolean,
): Promise<Uint8Array> {
  canvas.width = setup.geometry.width;
  canvas.height = setup.geometry.height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Could not create a 2D canvas for export.');
  const entries: ZipEntry[] = [];
  const total = setup.frames.length;
  for (let i = 0; i < total; i++) {
    if (isCancelled()) throw new Cancelled();
    renderSequenceFrame(g, setup, i, images);
    entries.push({ name: sequenceFileName(setup, i), data: await encode() });
    onProgress(i + 1, total);
  }
  if (isCancelled()) throw new Cancelled();
  const meta = sequenceMeta(project, setup, req);
  entries.push({ name: `${safeName(setup.anim.name)}/sequence.json`, data: new TextEncoder().encode(JSON.stringify(meta, null, 1)) });
  return buildZip(entries);
}
