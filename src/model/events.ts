// Timeline events (v3, R7): named cues at moments of a clip. Players fire an event when
// playback passes its time; these helpers give the events crossed by a step of playback.
import type { Animation } from './types.ts';

export interface FiredEvent {
  time: number;
  name: string;
  payload?: string | number;
}

/** Every event of an animation, sorted by time, then name. */
export function flatEvents(anim: Animation): FiredEvent[] {
  const out: FiredEvent[] = [];
  for (const [name, ks] of Object.entries(anim.events ?? {})) for (const k of ks) out.push({ time: k.time, name, ...(k.payload !== undefined ? { payload: k.payload } : {}) });
  return out.sort((a, b) => a.time - b.time || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Events crossed when playback moves from `prev` to `now` (seconds, both within
 * 0..duration): those with prev < time ≤ now. Pass prev = −1 on the first step so time-0
 * events fire. When `now < prev` the clip looped: the rest of the old pass, then the new
 * pass from 0. A looping clip's event at exactly `duration` fires at the wrap (once).
 */
export function eventsBetween(anim: Animation, prev: number, now: number): FiredEvent[] {
  const all = flatEvents(anim);
  if (now >= prev) return all.filter((e) => e.time > prev && e.time <= now);
  return [...all.filter((e) => e.time > prev && e.time <= anim.duration), ...all.filter((e) => e.time <= now && !(anim.loop && e.time === anim.duration))];
}
