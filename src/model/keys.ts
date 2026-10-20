// Timeline lanes and multi-key editing (select, group retime, copy/paste, nudge, loop
// seam). A lane is one keyed property; every key object has a `time` in seconds.
//
// Lane ids:  b:<boneId>:<translate|rotate|scale>   bone channels
//            s:<attachmentId>:<visible|opacity|image|deform|color>   slot (attachment) channels
//            c:<constraintId>:<mix|position|angle> constraint channels
//            d                                    draw order
//
// Collision policy (deterministic): when moved or pasted keys land on a frame that
// already holds a key in the same lane, the incoming key replaces the stationary one.
// Moved keys are computed from the gesture's start state, so a key passed over during a
// drag reappears unless the drop finally lands on it.
import { TIME_EPSILON, findKeyIndex, insertSorted } from './animation.ts';
import type { Animation, BoneTrack, Channel, ConstraintTrack, Key, Project, SlotTrack } from './types.ts';
import { CHANNELS, emptyTrack } from './types.ts';

export type SlotChannel = keyof SlotTrack;
export const SLOT_CHANNELS: readonly SlotChannel[] = ['visible', 'opacity', 'image', 'deform', 'color'];
export type ConstraintChannel = keyof ConstraintTrack;

export interface KeyRef {
  lane: string;
  time: number;
}

export type TimedKey = { time: number };

export type LaneInfo =
  | { kind: 'bone'; id: string; channel: Channel }
  | { kind: 'slot'; id: string; channel: SlotChannel }
  | { kind: 'constraint'; id: string; channel: ConstraintChannel }
  | { kind: 'draw' }
  | { kind: 'event'; name: string };

export const boneLane = (boneId: string, ch: Channel) => `b:${boneId}:${ch}`;
export const slotLane = (attId: string, ch: SlotChannel) => `s:${attId}:${ch}`;
export const constraintLane = (id: string, ch: ConstraintChannel) => `c:${id}:${ch}`;
export const DRAW_LANE = 'd';
export const eventLane = (name: string) => `e:${name}`;

export function parseLane(lane: string): LaneInfo | null {
  if (lane === DRAW_LANE) return { kind: 'draw' };
  if (lane.startsWith('e:')) return lane.length > 2 ? { kind: 'event', name: lane.slice(2) } : null;
  const m = /^([bsc]):(.+):([a-z]+)$/.exec(lane);
  if (!m) return null;
  const [, k, id, ch] = m;
  if (k === 'b' && (CHANNELS as readonly string[]).includes(ch)) return { kind: 'bone', id, channel: ch as Channel };
  if (k === 's' && (SLOT_CHANNELS as readonly string[]).includes(ch)) return { kind: 'slot', id, channel: ch as SlotChannel };
  if (k === 'c' && (ch === 'mix' || ch === 'position' || ch === 'angle')) return { kind: 'constraint', id, channel: ch };
  return null;
}

/** The key array of a lane (created on demand when `create`). */
export function laneKeys(anim: Animation, lane: string, create = false): TimedKey[] | undefined {
  const info = parseLane(lane);
  if (!info) return undefined;
  if (info.kind === 'draw') {
    if (!anim.drawOrder && create) anim.drawOrder = [];
    return anim.drawOrder;
  }
  if (info.kind === 'event') {
    if (!anim.events && create) anim.events = {};
    if (anim.events && !anim.events[info.name] && create) anim.events[info.name] = [];
    return anim.events?.[info.name];
  }
  if (info.kind === 'bone') {
    let tr: BoneTrack | undefined = anim.tracks[info.id];
    if (!tr && create) tr = anim.tracks[info.id] = emptyTrack();
    return tr?.[info.channel];
  }
  if (info.kind === 'slot') {
    if (!anim.slots && create) anim.slots = {};
    let tr: SlotTrack | undefined = anim.slots?.[info.id];
    if (!tr && create) tr = anim.slots![info.id] = {};
    if (tr && !tr[info.channel] && create) tr[info.channel] = [];
    return tr?.[info.channel];
  }
  if (!anim.constraints && create) anim.constraints = {};
  let tr: ConstraintTrack | undefined = anim.constraints?.[info.id];
  if (!tr && create) tr = anim.constraints![info.id] = {};
  if (tr && !tr[info.channel] && create) tr[info.channel] = [];
  return tr?.[info.channel];
}

/** Every non-empty lane of an animation, in a stable order. */
export function allLanes(anim: Animation): string[] {
  const out: string[] = [];
  for (const [id, tr] of Object.entries(anim.tracks)) for (const ch of CHANNELS) if (tr[ch].length) out.push(boneLane(id, ch));
  for (const [id, tr] of Object.entries(anim.slots ?? {})) for (const ch of SLOT_CHANNELS) if (tr[ch]?.length) out.push(slotLane(id, ch));
  for (const [id, tr] of Object.entries(anim.constraints ?? {})) for (const ch of ['mix', 'position', 'angle'] as const) if (tr[ch]?.length) out.push(constraintLane(id, ch));
  if (anim.drawOrder?.length) out.push(DRAW_LANE);
  for (const [name, ks] of Object.entries(anim.events ?? {})) if (ks.length) out.push(eventLane(name));
  return out;
}

export function findKey(anim: Animation, ref: KeyRef): TimedKey | undefined {
  const keys = laneKeys(anim, ref.lane);
  if (!keys) return undefined;
  const i = findKeyIndex(keys, ref.time);
  return i >= 0 ? keys[i] : undefined;
}

export function sameRef(a: KeyRef, b: KeyRef): boolean {
  return a.lane === b.lane && Math.abs(a.time - b.time) < TIME_EPSILON;
}

/** Drops refs that no longer point at a key, and duplicates. */
export function validRefs(anim: Animation, refs: readonly KeyRef[]): KeyRef[] {
  const out: KeyRef[] = [];
  for (const r of refs) if (findKey(anim, r) && !out.some((o) => sameRef(o, r))) out.push(r);
  return out;
}

function cloneKey<K>(k: K): K {
  return structuredClone(k);
}

/** Clamps a time shift so the moved keys stay inside [0, duration]. */
export function clampShift(anim: Animation, refs: readonly KeyRef[], delta: number): number {
  if (!refs.length) return 0;
  const lo = Math.min(...refs.map((r) => r.time));
  const hi = Math.max(...refs.map((r) => r.time));
  return Math.min(Math.max(delta, -lo), Math.max(0, anim.duration - hi));
}

/**
 * Shifts the referenced keys by `delta` seconds (already frame-aligned by the caller)
 * and returns the refs at their new times. Moved keys replace stationary keys they
 * land on. The shift is clamped to keep keys inside the animation.
 */
export function shiftKeys(anim: Animation, refs: readonly KeyRef[], delta: number): KeyRef[] {
  const valid = validRefs(anim, refs);
  const d = clampShift(anim, valid, delta);
  if (Math.abs(d) < TIME_EPSILON) return valid;
  const byLane = new Map<string, number[]>();
  for (const r of valid) byLane.set(r.lane, [...(byLane.get(r.lane) ?? []), r.time]);
  const out: KeyRef[] = [];
  for (const [lane, times] of byLane) {
    const keys = laneKeys(anim, lane)!;
    const moving = times.map((t) => keys.splice(findKeyIndex(keys, t), 1)[0]);
    for (const k of moving) {
      const nt = alignTime(anim, k.time + d);
      const hit = findKeyIndex(keys, nt);
      if (hit >= 0) keys.splice(hit, 1);
      k.time = nt;
      insertSorted(keys, k);
      out.push({ lane, time: nt });
    }
  }
  return out;
}

export function deleteKeys(anim: Animation, refs: readonly KeyRef[]): number {
  let n = 0;
  for (const r of validRefs(anim, refs)) {
    const keys = laneKeys(anim, r.lane)!;
    keys.splice(findKeyIndex(keys, r.time), 1);
    n++;
  }
  return n;
}

export interface KeyClipboard {
  /** Keys relative to the earliest copied key. */
  items: { lane: string; dt: number; key: TimedKey }[];
}

export function copyKeys(anim: Animation, refs: readonly KeyRef[]): KeyClipboard | null {
  const valid = validRefs(anim, refs);
  if (!valid.length) return null;
  const base = Math.min(...valid.map((r) => r.time));
  return { items: valid.map((r) => ({ lane: r.lane, dt: round6(r.time - base), key: cloneKey(findKey(anim, r)!) })) };
}

/** Bone ids that appear in a clipboard's bone lanes. */
export function clipboardBones(clip: KeyClipboard): string[] {
  const ids = new Set<string>();
  for (const it of clip.items) {
    const info = parseLane(it.lane);
    if (info?.kind === 'bone') ids.add(info.id);
  }
  return [...ids];
}

/**
 * Pastes clipboard keys starting at `time`. With `retargetBone`, keys copied from a
 * single bone go onto that bone instead (same channels; reported in `retarget` so the
 * caller can say so). Keys landing past the end are dropped (reported in `skipped`).
 * Incoming keys replace keys at the same frame.
 */
export function pasteKeys(anim: Animation, clip: KeyClipboard, time: number, retargetBone?: string | null): { refs: KeyRef[]; skipped: number; retarget: { from: string; to: string } | null } {
  const bones = clipboardBones(clip);
  const retarget = retargetBone && bones.length === 1 && bones[0] !== retargetBone ? { from: bones[0], to: retargetBone } : null;
  const refs: KeyRef[] = [];
  let skipped = 0;
  for (const it of clip.items) {
    const t = alignTime(anim, time + it.dt);
    if (t > anim.duration + TIME_EPSILON) {
      skipped++;
      continue;
    }
    let lane = it.lane;
    const info = parseLane(lane);
    if (retarget && info?.kind === 'bone' && info.id === retarget.from) lane = boneLane(retarget.to, info.channel);
    const keys = laneKeys(anim, lane, true);
    if (!keys) {
      skipped++;
      continue;
    }
    const hit = findKeyIndex(keys, t);
    if (hit >= 0) keys.splice(hit, 1);
    const k = cloneKey(it.key);
    k.time = t;
    // Per-axis easing exists only on translate keys (a pasted clipboard file may say otherwise).
    const target = parseLane(lane);
    if (!(target?.kind === 'bone' && target.channel === 'translate') && 'interpY' in k) {
      delete (k as Key).interpY;
      delete (k as Key).curveY;
    }
    insertSorted(keys, k);
    refs.push({ lane, time: t });
  }
  return { refs, skipped, retarget };
}

/** Stepped lanes show the setup value before their first key (visibility, image, draw order). */
export function isSteppedLane(lane: string): boolean {
  const info = parseLane(lane);
  return info?.kind === 'draw' || (info?.kind === 'slot' && (info.channel === 'visible' || info.channel === 'image'));
}

/** A key holding the setup value of a stepped lane (what frame 0 shows before any key). */
function setupKey(project: Project, lane: string, time: number): TimedKey | null {
  const info = parseLane(lane);
  if (info?.kind === 'draw') return { time, order: project.attachments.map((a) => a.id) } as TimedKey;
  if (info?.kind !== 'slot') return null;
  const att = project.attachments.find((a) => a.id === info.id);
  if (!att) return null;
  if (info.channel === 'visible') return { time, value: [att.hidden ? 0 : 1], interp: 'step' } as TimedKey;
  if (info.channel === 'image') return { time, imageId: att.imageId } as TimedKey;
  return null;
}

/**
 * Loop-seam helper: for each lane (default: all keyed lanes) writes, at the animation's
 * end, the value frame 0 shows, so the loop closes exactly: the first key for
 * interpolated lanes (which hold their first key before it), and — with `project` — the
 * setup value for stepped lanes whose first key comes after frame 0. A key already at
 * the end is overwritten. Returns the lanes changed.
 */
export function closeLoopSeam(anim: Animation, lanes?: readonly string[], project?: Project): string[] {
  const changed: string[] = [];
  for (const lane of lanes ?? allLanes(anim)) {
    const keys = laneKeys(anim, lane);
    if (!keys?.length) continue;
    const first = keys[0];
    if (Math.abs(first.time - anim.duration) < TIME_EPSILON) continue;
    const end = findKeyIndex(keys, anim.duration);
    const fromSetup = project && isSteppedLane(lane) && first.time > TIME_EPSILON ? setupKey(project, lane, anim.duration) : null;
    const k = fromSetup ?? cloneKey(first);
    k.time = anim.duration;
    if (end >= 0) {
      // Keep the end key's own outgoing interpolation (it has no segment anyway).
      keys[end] = k;
    } else {
      insertSorted(keys, k);
    }
    changed.push(lane);
  }
  return changed;
}

/** All key refs whose time falls within [t0, t1] on the given lanes. */
export function refsInRange(anim: Animation, lanes: readonly string[], t0: number, t1: number): KeyRef[] {
  const lo = Math.min(t0, t1) - TIME_EPSILON;
  const hi = Math.max(t0, t1) + TIME_EPSILON;
  const out: KeyRef[] = [];
  for (const lane of lanes) for (const k of laneKeys(anim, lane) ?? []) if (k.time >= lo && k.time <= hi) out.push({ lane, time: k.time });
  return out;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Lands a computed time exactly on the frame grid when it is (numerically) on it. */
export function alignTime(anim: Animation, t: number): number {
  const f = t * anim.fps;
  const r = Math.round(f);
  return Math.abs(f - r) < 1e-4 ? r / anim.fps : t;
}
