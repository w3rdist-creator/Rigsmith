// Image-sequence export planning (pure). Endpoint policy: sample frames f/fps for
// f = start..end at the *export* fps. For a looping animation the default range stops
// at N−1 (N = round(duration·fps)) because frame N is frame 0 again; a non-looping
// animation includes frame N (its final pose). Holds may legitimately make the first
// and last pictures identical — the policy is about sample times, not pixels.
import type { Bounds } from './evaluate.ts';
import type { Animation } from './types.ts';

export interface SequenceRequest {
  fps: number;
  start: number;
  end: number;
  scale: number;
  padding: number;
}

export interface SequencePlan {
  times: number[];
  frames: number[];
  lastFrame: number;
}

export const SEQUENCE_LIMITS = {
  maxFrames: 2000,
  maxSide: 8192,
  maxFramePixels: 40_000_000,
  /** Sum of all frame pixels: keeps the in-memory ZIP to a few hundred MB at worst. */
  maxTotalPixels: 600_000_000,
};

/** Last valid export frame for an animation at `fps` (see endpoint policy above). */
export function lastExportFrame(anim: Animation, fps: number): number {
  const n = Math.max(1, Math.round(anim.duration * fps));
  return anim.loop ? n - 1 : n;
}

export function defaultRequest(anim: Animation): SequenceRequest {
  return { fps: anim.fps, start: 0, end: lastExportFrame(anim, anim.fps), scale: 1, padding: 4 };
}

export function planSequence(anim: Animation | null, req: SequenceRequest): { ok: true; plan: SequencePlan } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!anim) return { ok: false, errors: ['Choose an animation to export (the project has none).'] };
  if (!Number.isInteger(req.fps) || req.fps < 1 || req.fps > 240) errors.push('FPS must be a whole number from 1 to 240.');
  if (!(req.scale > 0) || req.scale > 8) errors.push('Scale must be greater than 0 and at most 8.');
  if (!Number.isInteger(req.padding) || req.padding < 2 || req.padding > 512) errors.push('Padding must be a whole number of pixels from 2 to 512 (at least 2 keeps the outer ring transparent).');
  if (errors.length) return { ok: false, errors };
  const last = lastExportFrame(anim, req.fps);
  if (!Number.isInteger(req.start) || !Number.isInteger(req.end)) errors.push('Start and end must be whole frame numbers.');
  else {
    if (req.start < 0 || req.start > last) errors.push(`Start frame must be between 0 and ${last}.`);
    if (req.end < 0 || req.end > last) errors.push(`End frame must be between 0 and ${last}${anim.loop ? ` (frame ${last + 1} repeats frame 0 in a loop)` : ''}.`);
    if (req.start > req.end) errors.push('Start frame must not be after the end frame (zero frames selected).');
  }
  if (errors.length) return { ok: false, errors };
  const frames: number[] = [];
  for (let f = req.start; f <= req.end; f++) frames.push(f);
  if (frames.length > SEQUENCE_LIMITS.maxFrames) return { ok: false, errors: [`${frames.length} frames is more than the ${SEQUENCE_LIMITS.maxFrames}-frame limit; export a shorter range or a lower FPS.`] };
  return { ok: true, plan: { frames, times: frames.map((f) => Math.min(anim.duration, f / req.fps)), lastFrame: last } };
}

export interface SequenceGeometry {
  width: number;
  height: number;
  /** World point that maps to pixel (0,0): px = (world - origin) · scale. */
  originX: number;
  originY: number;
  scale: number;
}

/** One canvas size for every frame: the union bounds of all samples, plus padding. */
export function sequenceGeometry(b: Bounds, scale: number, padding: number): SequenceGeometry {
  const pad = padding / scale;
  const minX = Math.floor((b.minX - pad) * scale) / scale;
  const minY = Math.floor((b.minY - pad) * scale) / scale;
  return {
    width: Math.ceil((b.maxX + pad - minX) * scale),
    height: Math.ceil((b.maxY + pad - minY) * scale),
    originX: minX,
    originY: minY,
    scale,
  };
}

export function checkCapacity(geo: SequenceGeometry, frames: number): string[] {
  const e: string[] = [];
  if (geo.width > SEQUENCE_LIMITS.maxSide || geo.height > SEQUENCE_LIMITS.maxSide) e.push(`Frames would be ${geo.width}×${geo.height} px; the limit is ${SEQUENCE_LIMITS.maxSide} px per side. Lower the scale.`);
  else if (geo.width * geo.height > SEQUENCE_LIMITS.maxFramePixels) e.push(`Frames would be ${geo.width}×${geo.height} px (over ${SEQUENCE_LIMITS.maxFramePixels / 1e6} megapixels). Lower the scale.`);
  else if (geo.width * geo.height * frames > SEQUENCE_LIMITS.maxTotalPixels) e.push(`${frames} frames of ${geo.width}×${geo.height} px is too large to export in the browser (over ${SEQUENCE_LIMITS.maxTotalPixels / 1e6} megapixels in total). Lower the scale, FPS or range.`);
  return e;
}
