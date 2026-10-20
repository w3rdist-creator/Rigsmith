// Animation mixing (crossfades), shared by the editor's transition preview, the
// runtime player and the CLI. A plan is a chain of entries on one clock: entry 0 plays
// from time 0; entry k starts at `start` (global seconds) and blends from everything
// before it to its own animation over `mix` seconds. Starting an entry while the previous
// blend is still running (an interruption) is continuous: the earlier blend keeps
// advancing and is the "from" pose of the new one.
//
// Per channel (translate / rotate / scale of a bone, opacity / color / deform of a slot):
//   P_k = P_{k−1} + w_k · (value_k − P_{k−1}),  w_k = clamp((T − start_k) / mix_k, 0, 1)
// rotation takes the shortest way round. Constraint mix and path position blend along
// the chain the same way (an entry that does not key them supplies the constraint's
// setup value under 'setup' and leaves them alone under 'hold'), so an animation that
// keys an IK off fades it out over the mix instead of switching at half weight.
// Constraints (IK, paths) are then solved on the blended local pose. Discrete state
// (visibility, image, draw order) comes from the newest entry whose weight has reached 0.5.
//
// Missing channels — a channel entry k does not key:
//   'setup': its value_k is the setup pose (the bone/slot blends back to setup);
//   'hold':  entry k leaves it alone (w_k = 0 for that channel), so it keeps following
//            the live pose before it.
// A channel keyed by the incoming animation but not by the outgoing one blends from
// whatever the outgoing pose shows for it (the setup value if nothing before keyed it),
// under either policy.
import { playbackTime, sampleKeys } from './animation.ts';
import type { Rgba } from './color.ts';
import { clamp01, setupColor } from './color.ts';
import type { ConstraintValues } from './constraints.ts';
import { applyConstraints } from './constraints.ts';
import type { Frame } from './evaluate.ts';
import { evaluate } from './evaluate.ts';
import { meshWorldVertices } from './mesh.ts';
import { computeWorld } from './skeleton.ts';
import type { Animation, LocalPose, Project } from './types.ts';

export type MissingPolicy = 'setup' | 'hold';

export interface MixEntry {
  animId: string;
  /** Global time (s) the entry starts. Entry 0 should start at 0. */
  start: number;
  /** Blend duration (s) from the previous pose; 0 = cut. Ignored for entry 0. */
  mix: number;
  /**
   * Saved sequences: a one-shot animation restarts every `period` seconds, `count` times
   * in all, then holds its end pose. Loops already wrap, so this does not affect them.
   * With `fps`, the time inside a restarted play is snapped to that frame grid, so frame
   * k of the second play is sampled at exactly the time of frame k of the first.
   */
  repeat?: { count: number; period: number; fps?: number };
}

export interface MixPlan {
  entries: MixEntry[];
  missing: MissingPolicy;
}

/** Default mix duration when no rule exists for a pair (seconds). */
export const DEFAULT_MIX = 0.2;

/** Stored rule duration for from → to, or the fallback. */
export function mixDuration(project: Project, from: string, to: string, fallback = DEFAULT_MIX): number {
  return project.mixes?.find((m) => m.from === from && m.to === to)?.duration ?? fallback;
}

/** Sets (or with null removes) the stored mix duration for a pair. */
export function setMixRule(project: Project, from: string, to: string, duration: number | null): void {
  const rest = (project.mixes ?? []).filter((m) => !(m.from === from && m.to === to));
  if (duration !== null) rest.push({ from, to, duration: Math.min(10, Math.max(0, duration)) });
  project.mixes = rest;
}

export function entryWeight(e: MixEntry, index: number, T: number): number {
  if (index === 0) return 1;
  if (T < e.start) return 0;
  if (e.mix <= 0) return 1;
  return Math.min(1, (T - e.start) / e.mix);
}

/** Local time of an entry's animation at global time T (loops wrap, one-shots hold the end). */
export function entryTime(anim: Animation, e: MixEntry, T: number): number {
  let elapsed = Math.max(0, T - e.start);
  if (e.repeat && !anim.loop && e.repeat.count > 1 && e.repeat.period > 0) {
    const k = Math.min(e.repeat.count - 1, Math.floor((elapsed + 1e-9) / e.repeat.period));
    elapsed = Math.max(0, elapsed - k * e.repeat.period);
    const fps = e.repeat.fps;
    if (k > 0 && fps) {
      const f = elapsed * fps;
      if (Math.abs(f - Math.round(f)) < 1e-6) elapsed = Math.round(f) / fps;
    }
  }
  return playbackTime(anim, elapsed).time;
}

const shortest = (a: number, b: number) => {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
};

/** Total length of a plan: the last entry's start + its blend + (for one-shots) its duration. */
export function planLength(project: Project, plan: MixPlan): number {
  const last = plan.entries[plan.entries.length - 1];
  const anim = project.animations.find((a) => a.id === last?.animId);
  if (!last || !anim) return 0;
  return last.start + Math.max(last.mix, anim.duration);
}

export interface MixState {
  /** Weight of each entry at T (entry 0 = 1). */
  weights: number[];
  /** Entry providing discrete state (visibility, image, draw order). */
  discrete: number;
}

export function mixState(plan: MixPlan, T: number): MixState {
  const weights = plan.entries.map((e, i) => entryWeight(e, i, T));
  let discrete = 0;
  weights.forEach((w, i) => {
    if (i > 0 && w >= 0.5) discrete = i;
  });
  return { weights, discrete };
}

/** Blended local pose (before constraints) at global time T. */
export function mixPose(project: Project, plan: MixPlan, T: number): Map<string, LocalPose> {
  const setup = new Map(project.bones.map((b) => [b.id, { x: b.x, y: b.y, rotation: b.rotation, scaleX: b.scaleX, scaleY: b.scaleY }]));
  const pose = new Map([...setup].map(([id, p]) => [id, { ...p }]));
  plan.entries.forEach((e, i) => {
    const anim = project.animations.find((a) => a.id === e.animId);
    if (!anim) return;
    const w = entryWeight(e, i, T);
    if (w <= 0) return;
    const t = entryTime(anim, e, T);
    for (const b of project.bones) {
      const tr = anim.tracks[b.id];
      const cur = pose.get(b.id)!;
      const s = setup.get(b.id)!;
      const keyed = (ch: 'translate' | 'rotate' | 'scale') => !!tr?.[ch]?.length;
      const val = (ch: 'translate' | 'rotate' | 'scale', fb: number[]) => (keyed(ch) ? sampleKeys(tr![ch], t, fb) : plan.missing === 'setup' ? fb : null);
      // At full weight the incoming value is taken exactly (no accumulated rounding).
      const lerp = (a: number, b: number) => (w >= 1 ? b : a + w * (b - a));
      const tv = val('translate', [s.x, s.y]);
      if (tv) {
        cur.x = lerp(cur.x, tv[0]);
        cur.y = lerp(cur.y, tv[1]);
      }
      const rv = val('rotate', [s.rotation]);
      if (rv) cur.rotation = w >= 1 ? rv[0] : cur.rotation + w * shortest(cur.rotation, rv[0]);
      const sv = val('scale', [s.scaleX, s.scaleY]);
      if (sv) {
        cur.scaleX = lerp(cur.scaleX, sv[0]);
        cur.scaleY = lerp(cur.scaleY, sv[1]);
      }
    }
  });
  return pose;
}

/** Constraint mix / path position / transform angle blended along the plan's chain at global time T. */
export function mixConstraintValues(project: Project, plan: MixPlan, T: number): ConstraintValues {
  const blend = (id: string, channel: 'mix' | 'position' | 'angle', base: number) => {
    let v = base;
    plan.entries.forEach((e, i) => {
      const anim = project.animations.find((a) => a.id === e.animId);
      const w = entryWeight(e, i, T);
      if (!anim || w <= 0) return;
      const keys = anim.constraints?.[id]?.[channel];
      const raw = keys?.length ? sampleKeys(keys, entryTime(anim, e, T), [base])[0] : plan.missing === 'setup' ? base : null;
      if (raw === null) return;
      const x = channel === 'mix' ? Math.min(1, Math.max(0, raw)) : raw;
      v = w >= 1 ? x : v + w * (x - v);
    });
    return v;
  };
  return { mix: (id, base) => blend(id, 'mix', base), position: (id, base) => blend(id, 'position', base), angle: (id, base) => blend(id, 'angle', base) };
}

/**
 * Full evaluated frame of a mix plan at global time T: blended pose → constraints →
 * world → attachments (discrete state from the dominant entry; opacity, tint and mesh deform
 * blended along the chain).
 */
export function evaluateMix(project: Project, plan: MixPlan, T: number, opts: { skinId?: string | null } = {}): Frame {
  const st = mixState(plan, T);
  const dEntry = plan.entries[st.discrete];
  const dAnim = project.animations.find((a) => a.id === dEntry?.animId) ?? null;
  const dTime = dAnim ? entryTime(dAnim, dEntry, T) : 0;
  const pose = mixPose(project, plan, T);
  applyConstraints(project, pose, dAnim, dTime, mixConstraintValues(project, plan, T));
  const frame = evaluate(project, dAnim, dTime, { skinId: opts.skinId, pose, constraints: false });
  // Continuous slot channels blend along the chain like bone channels.
  const setupWorld = project.attachments.some((a) => a.mesh?.weights) ? computeWorld(project.bones) : frame.world;
  for (const f of frame.attachments) {
    const att = f.att;
    let opacity = att.opacity;
    let color: number[] = setupColor(att);
    const n = att.mesh?.points.length ?? 0;
    let deform: number[] | null = n ? new Array(n).fill(0) : null;
    let deformed = false;
    plan.entries.forEach((e, i) => {
      const anim = project.animations.find((a) => a.id === e.animId);
      const w = st.weights[i];
      if (!anim || w <= 0) return;
      const t = entryTime(anim, e, T);
      const slot = anim.slots?.[att.id];
      const ok = slot?.opacity?.length ? sampleKeys(slot.opacity, t, [att.opacity])[0] : plan.missing === 'setup' ? att.opacity : null;
      if (ok !== null) opacity += w * (ok - opacity);
      const ck = slot?.color?.length ? sampleKeys(slot.color, t, setupColor(att)) : plan.missing === 'setup' ? setupColor(att) : null;
      if (ck) color = color.map((v, k) => v + w * (ck[k] - v));
      if (deform) {
        const dk = slot?.deform?.length ? sampleKeys(slot.deform, t, deform) : plan.missing === 'setup' ? new Array(n).fill(0) : null;
        if (dk) {
          deform = deform.map((v, k) => v + w * (dk[k] - v));
          deformed = true;
        }
      }
    });
    f.opacity = Math.min(1, Math.max(0, opacity));
    f.color = color.map(clamp01) as Rgba;
    if (deformed && f.vertices && f.image) {
      const setupIm = project.images.find((im) => im.id === att.imageId) ?? f.image;
      f.vertices = meshWorldVertices(att, setupIm, frame.world, setupWorld, deform!);
    }
  }
  return frame;
}
