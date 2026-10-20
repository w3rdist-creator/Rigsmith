import { ease } from './curve.ts';
import { lerp } from './math.ts';
import type { Animation, Bone, BoneTrack, Channel, Curve, Interp, Key, LocalPose } from './types.ts';
import { emptyTrack } from './types.ts';

/** Two key times closer than this are the same key. */
export const TIME_EPSILON = 1e-6;

export function easeFor(interp: Interp, t: number, curve?: Curve): number {
  return ease(interp, t, curve);
}

/**
 * Samples a channel at time t. Before the first key the first value holds; after the
 * last key the last value holds. Rotation interpolates raw degrees (no shortest-path
 * wrapping) so multi-turn spins can be keyed: 350 → 10 passes through 180; key 370
 * to turn forward through 0.
 */
export function sampleKeys(keys: readonly Key[], t: number, fallback: readonly number[]): number[] {
  if (keys.length === 0) return fallback.slice();
  const first = keys[0];
  if (t <= first.time) return first.value.slice();
  const last = keys[keys.length - 1];
  if (t >= last.time) return last.value.slice();
  // Binary search for the segment [k0, k1) containing t.
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].time <= t) lo = mid;
    else hi = mid;
  }
  const k0 = keys[lo];
  const k1 = keys[hi];
  const span = k1.time - k0.time;
  const u = span > 0 ? (t - k0.time) / span : 0;
  const alpha = span > 0 ? easeFor(k0.interp, u, k0.curve) : 0;
  // Per-axis translate easing (v3): component 1 (y) follows interpY/curveY.
  const alphaY = k0.interpY && span > 0 ? easeFor(k0.interpY, u, k0.curveY) : alpha;
  return k0.value.map((v, i) => lerp(v, k1.value[i] ?? v, i === 1 ? alphaY : alpha));
}

/** Local pose of a bone at time t: keyed channels override the setup pose. */
export function sampleBone(bone: Bone, anim: Animation | null, t: number): LocalPose {
  const track = anim?.tracks[bone.id];
  if (!track) {
    return { x: bone.x, y: bone.y, rotation: bone.rotation, scaleX: bone.scaleX, scaleY: bone.scaleY };
  }
  const [x, y] = sampleKeys(track.translate, t, [bone.x, bone.y]);
  const [rotation] = sampleKeys(track.rotate, t, [bone.rotation]);
  const [scaleX, scaleY] = sampleKeys(track.scale, t, [bone.scaleX, bone.scaleY]);
  return { x, y, rotation, scaleX, scaleY };
}

export function samplePose(bones: readonly Bone[], anim: Animation | null, t: number): Map<string, LocalPose> {
  const out = new Map<string, LocalPose>();
  for (const b of bones) out.set(b.id, sampleBone(b, anim, t));
  return out;
}

export function channelValue(pose: LocalPose, ch: Channel): number[] {
  if (ch === 'translate') return [pose.x, pose.y];
  if (ch === 'rotate') return [pose.rotation];
  return [pose.scaleX, pose.scaleY];
}

export function ensureTrack(anim: Animation, boneId: string): BoneTrack {
  let track = anim.tracks[boneId];
  if (!track) {
    track = emptyTrack();
    anim.tracks[boneId] = track;
  }
  return track;
}

export function findKeyIndex(keys: readonly { time: number }[], time: number): number {
  return keys.findIndex((k) => Math.abs(k.time - time) < TIME_EPSILON);
}

/** Inserts or replaces a key, keeping the list sorted. Returns the stored key. */
export function setKey(keys: Key[], time: number, value: number[], interp?: Interp, curve?: Curve): Key {
  const idx = findKeyIndex(keys, time);
  if (idx >= 0) {
    keys[idx].value = value.slice();
    if (interp) setInterp(keys[idx], interp, curve);
    return keys[idx];
  }
  const key: Key = { time, value: value.slice(), interp: 'linear' };
  if (interp) setInterp(key, interp, curve);
  insertSorted(keys, key);
  return key;
}

/** Sets a key's interpolation; `curve` is kept only for bezier keys. */
export function setInterp(key: Key, interp: Interp, curve?: Curve): void {
  key.interp = interp;
  if (interp === 'bezier') key.curve = (curve ?? key.curve ?? [1 / 3, 1 / 3, 2 / 3, 2 / 3]).slice() as Curve;
  else delete key.curve;
}

/**
 * Sets (or with null clears) a translate key's separate y interpolation; `curveY` is kept
 * only for bezier. x keeps `interp`/`curve`.
 */
export function setInterpY(key: Key, interp: Interp | null, curve?: Curve): void {
  if (!interp) {
    delete key.interpY;
    delete key.curveY;
    return;
  }
  key.interpY = interp;
  if (interp === 'bezier') key.curveY = (curve ?? key.curveY ?? [1 / 3, 1 / 3, 2 / 3, 2 / 3]).slice() as Curve;
  else delete key.curveY;
}

/** Inserts a key object (any keyed type with a time) keeping the list sorted by time. */
export function insertSorted<K extends { time: number }>(keys: K[], key: K): void {
  let insertAt = keys.findIndex((k) => k.time > key.time);
  if (insertAt < 0) insertAt = keys.length;
  keys.splice(insertAt, 0, key);
}

export function removeKey(keys: { time: number }[], time: number): boolean {
  const idx = findKeyIndex(keys, time);
  if (idx < 0) return false;
  keys.splice(idx, 1);
  return true;
}

/** Moves a key to a new time; replaces any key already at the destination. */
export function moveKey<K extends { time: number }>(keys: K[], fromTime: number, toTime: number): boolean {
  const idx = findKeyIndex(keys, fromTime);
  if (idx < 0) return false;
  const [key] = keys.splice(idx, 1);
  removeKey(keys, toTime);
  key.time = toTime;
  insertSorted(keys, key);
  return true;
}

export function snapToFrame(time: number, fps: number): number {
  return Math.round(time * fps) / fps;
}

export function frameCount(anim: Animation): number {
  return Math.max(1, Math.round(anim.duration * anim.fps));
}

/** Maps an unbounded playback clock onto animation time. */
export function playbackTime(anim: Animation, elapsed: number): { time: number; finished: boolean } {
  if (anim.duration <= 0) return { time: 0, finished: true };
  if (anim.loop) return { time: ((elapsed % anim.duration) + anim.duration) % anim.duration, finished: false };
  if (elapsed >= anim.duration) return { time: anim.duration, finished: true };
  return { time: Math.max(0, elapsed), finished: false };
}

/** Number of keys that fall after the animation's end (kept, but not played). */
export function keysBeyondEnd(anim: Animation): number {
  let n = 0;
  const count = (keys: readonly { time: number }[] | undefined) => {
    for (const k of keys ?? []) if (k.time > anim.duration + TIME_EPSILON) n++;
  };
  for (const t of Object.values(anim.tracks)) for (const keys of [t.translate, t.rotate, t.scale]) count(keys);
  for (const s of Object.values(anim.slots ?? {})) for (const keys of [s.visible, s.opacity, s.image, s.deform, s.color]) count(keys);
  for (const c of Object.values(anim.constraints ?? {})) for (const keys of [c.mix, c.position, c.angle]) count(keys);
  count(anim.drawOrder);
  return n;
}

export function allKeyTimes(track: BoneTrack | undefined): number[] {
  if (!track) return [];
  const set = new Set<number>();
  for (const keys of [track.translate, track.rotate, track.scale]) for (const k of keys) set.add(k.time);
  return [...set].sort((a, b) => a - b);
}
