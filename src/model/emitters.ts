// FX sockets (v3, R9): an attachment with `emitter` marks where a game spawns a particle
// recipe. Rigsmith stores the recipe id and the rate (keyable) and previews a stand-in in
// the editor viewport only; exports draw nothing for it.
import { sampleKeys } from './animation.ts';
import type { Animation, Attachment, Emitter } from './types.ts';
import { EMITTER_MAX_RATE, EMITTER_RECIPE } from './types.ts';

/** Problems with an emitter (empty when valid). */
export function emitterProblems(e: Emitter): string[] {
  const out: string[] = [];
  if (typeof e.recipe !== 'string' || !EMITTER_RECIPE.test(e.recipe)) out.push('recipe must be 1–64 letters, digits or _ . : -');
  if (typeof e.rate !== 'number' || !Number.isFinite(e.rate) || e.rate < 0 || e.rate > EMITTER_MAX_RATE) out.push(`rate must be from 0 to ${EMITTER_MAX_RATE} particles per second`);
  return out;
}

/** The emitter's rate at time t (its rate keys, else the setup rate). */
export function emitterRate(att: Attachment, anim: Animation | null, t: number): number {
  const keys = anim?.slots?.[att.id]?.rate;
  const v = keys?.length ? sampleKeys(keys, t, [att.emitter!.rate])[0] : att.emitter!.rate;
  return Math.min(EMITTER_MAX_RATE, Math.max(0, v));
}

export interface StandInParticle {
  /** Offset from the socket in the socket's space (px), before its world transform. */
  x: number;
  y: number;
  /** 0..1 (fades out with age). */
  alpha: number;
  scale: number;
}

const hash = (n: number) => {
  let v = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  v ^= v >>> 13;
  v = Math.imul(v, 0xc2b2ae35);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
};

/**
 * A deterministic stand-in for previewing (not the recipe): particles born every 1/rate
 * seconds over the last `life` seconds, flying out along the socket's +x within ±35°,
 * slowing and fading. Same t → same particles, so scrubbing is stable.
 */
export function standInParticles(rate: number, t: number, life = 0.6, speed = 140): StandInParticle[] {
  if (rate <= 0) return [];
  const out: StandInParticle[] = [];
  const last = Math.floor(t * rate);
  for (let k = last; k >= 0 && k > last - Math.min(200, Math.ceil(life * rate) + 1); k--) {
    const age = t - k / rate;
    if (age < 0 || age > life) continue;
    const a = ((hash(k * 3 + 1) - 0.5) * 70 * Math.PI) / 180;
    const v = speed * (0.6 + 0.4 * hash(k * 3 + 2));
    const d = v * age * (1 - age / (2 * life));
    out.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, alpha: 1 - age / life, scale: 0.5 + 0.5 * hash(k * 3 + 3) });
  }
  return out;
}
