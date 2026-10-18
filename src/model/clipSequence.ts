// Saved clip sequences (RV-009): an ordered list of animations, each played a whole
// number of times, with crossfades between consecutive steps taken from the stored mix
// rules (Project.mixes — the same durations the Mix dialog shows and edits).
//
// Schedule at an export rate `fps` (frame-aligned, so frame counts add up exactly):
//   n_i   = max(1, round(duration_i · fps))       frames per play of step i
//   F_i   = Σ_{j<i} n_j · repeat_j                 first frame of step i
//   total = Σ_i n_i · repeat_i                     frames exported (0 … total−1)
// Step i becomes one mix-plan entry starting at F_i / fps that blends in from the live
// pose over mixDuration(step i−1 → step i) (entry 0 never blends). Repeats of a step are
// back to back without a blend: a looping clip simply keeps looping; a one-shot clip
// restarts every n_i / fps seconds. Every play contributes its frames 0 … n_i−1 (the
// loop-export endpoint policy), so a one-shot's very last pose (t = duration) is not a
// separate frame. Frames are sampled at f / fps on one clock with evaluateMix — the same
// evaluator as the Mix dialog — so a sequence frame and a Mix-dialog frame with the same
// entries in force at the same time are computed identically.
import type { MixPlan } from './mix.ts';
import { mixDuration } from './mix.ts';
import type { ClipSequence, Project } from './types.ts';
import { SEQUENCE_MAX_REPEAT } from './types.ts';

export interface ScheduledStep {
  index: number;
  animId: string;
  name: string;
  repeat: number;
  /** Frames per play at the export fps. */
  framesPerPlay: number;
  startFrame: number;
  /** Total frames of this step (framesPerPlay · repeat). */
  frames: number;
  /** Blend into this step (s); 0 for the first step. */
  mix: number;
}

export interface SequenceSchedule {
  steps: ScheduledStep[];
  totalFrames: number;
  plan: MixPlan;
}

export type ScheduleResult = { ok: true; schedule: SequenceSchedule } | { ok: false; errors: string[] };

export function scheduleSequence(project: Project, seq: ClipSequence, fps: number): ScheduleResult {
  const errors: string[] = [];
  if (!Number.isInteger(fps) || fps < 1 || fps > 240) errors.push('FPS must be a whole number from 1 to 240.');
  if (!seq.steps.length) errors.push(`Sequence “${seq.name}” has no clips. Add at least one clip.`);
  seq.steps.forEach((st, i) => {
    if (!project.animations.some((a) => a.id === st.animId)) errors.push(`Step ${i + 1} uses an animation that no longer exists.`);
    if (!Number.isInteger(st.repeat) || st.repeat < 1 || st.repeat > SEQUENCE_MAX_REPEAT) errors.push(`Step ${i + 1}: repeat must be a whole number from 1 to ${SEQUENCE_MAX_REPEAT}.`);
  });
  if (errors.length) return { ok: false, errors };
  const steps: ScheduledStep[] = [];
  let start = 0;
  seq.steps.forEach((st, i) => {
    const anim = project.animations.find((a) => a.id === st.animId)!;
    const n = Math.max(1, Math.round(anim.duration * fps));
    const mix = i === 0 ? 0 : mixDuration(project, seq.steps[i - 1].animId, st.animId);
    steps.push({ index: i, animId: anim.id, name: anim.name, repeat: st.repeat, framesPerPlay: n, startFrame: start, frames: n * st.repeat, mix });
    start += n * st.repeat;
  });
  const plan: MixPlan = {
    missing: 'setup',
    entries: steps.map((s) => ({ animId: s.animId, start: s.startFrame / fps, mix: s.mix, ...(s.repeat > 1 ? { repeat: { count: s.repeat, period: s.framesPerPlay / fps, fps } } : {}) })),
  };
  return { ok: true, schedule: { steps, totalFrames: start, plan } };
}

/** Default export fps of a sequence: its first step's animation fps (30 when empty). */
export function sequenceFps(project: Project, seq: ClipSequence): number {
  return project.animations.find((a) => a.id === seq.steps[0]?.animId)?.fps ?? 30;
}

/** Parses "idle*2, greeting, idle" (animation names, optional *repeat). */
export function parseStepList(project: Project, text: string): { ok: true; steps: ClipSequence['steps'] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const steps: ClipSequence['steps'] = [];
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) errors.push('List at least one animation, e.g. "idle*2,greeting,idle".');
  for (const part of parts) {
    const m = /^(.*?)(?:\s*\*\s*(\d+))?$/.exec(part)!;
    const name = m[1].trim();
    const repeat = m[2] === undefined ? 1 : Number(m[2]);
    const anim = project.animations.find((a) => a.name === name);
    if (!anim) errors.push(`No animation named “${name}”.`);
    else if (!(repeat >= 1 && repeat <= SEQUENCE_MAX_REPEAT)) errors.push(`“${part}”: repeat must be from 1 to ${SEQUENCE_MAX_REPEAT}.`);
    else steps.push({ animId: anim.id, repeat });
  }
  return errors.length ? { ok: false, errors } : { ok: true, steps };
}

/** Human-readable step list ("idle×2 → greeting → idle"). */
export function describeSequence(project: Project, seq: ClipSequence): string {
  return seq.steps.map((st) => `${project.animations.find((a) => a.id === st.animId)?.name ?? '?'}${st.repeat > 1 ? `×${st.repeat}` : ''}`).join(' → ') || '(empty)';
}
