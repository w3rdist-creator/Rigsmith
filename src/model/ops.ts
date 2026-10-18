// Pure editing operations shared by the canvas tools, inspector and tests.
import { channelValue, ensureTrack, sampleBone, setKey, snapToFrame } from './animation.ts';
import type { Animation, Bone, Channel, LocalPose, Project } from './types.ts';

export type EditMode = 'setup' | 'animate';

export function animationById(project: Project, id: string | null): Animation | null {
  if (!id) return null;
  return project.animations.find((a) => a.id === id) ?? null;
}

/** Channels touched by a partial pose edit. */
export function channelsOf(patch: Partial<LocalPose>): Channel[] {
  const out: Channel[] = [];
  if ('x' in patch || 'y' in patch) out.push('translate');
  if ('rotation' in patch) out.push('rotate');
  if ('scaleX' in patch || 'scaleY' in patch) out.push('scale');
  return out;
}

/**
 * Applies a pose edit to a bone. Setup mode edits the setup pose. Animate mode writes
 * (or updates) keys at the current frame for every channel the patch touches, so the
 * edit survives the next sample instead of being overwritten.
 */
export function applyPoseEdit(
  project: Project,
  mode: EditMode,
  animId: string | null,
  time: number,
  boneId: string,
  patch: Partial<LocalPose>,
): void {
  const bone = project.bones.find((b) => b.id === boneId);
  if (!bone) return;
  const anim = animationById(project, animId);
  if (mode === 'setup' || !anim) {
    Object.assign(bone, patch);
    return;
  }
  const t = snapToFrame(time, anim.fps);
  const current = sampleBone(bone, anim, t);
  const next: LocalPose = { ...current, ...patch };
  const track = ensureTrack(anim, boneId);
  for (const ch of channelsOf(patch)) setKey(track[ch], t, channelValue(next, ch));
}

/** Keys the given channels of a bone at the current frame with their current sampled values. */
export function keyChannels(project: Project, animId: string, time: number, boneId: string, channels: readonly Channel[]): void {
  const anim = animationById(project, animId);
  const bone = project.bones.find((b) => b.id === boneId);
  if (!anim || !bone) return;
  const t = snapToFrame(time, anim.fps);
  const pose = sampleBone(bone, anim, t);
  const track = ensureTrack(anim, boneId);
  for (const ch of channels) setKey(track[ch], t, channelValue(pose, ch));
}

export function makeBone(id: string, name: string, parentId: string | null, x: number, y: number, rotation: number, length: number): Bone {
  return { id, name, parentId, x, y, rotation, scaleX: 1, scaleY: 1, length, color: '#8fd3c8' };
}

export function uniqueName(existing: Iterable<string>, base: string): string {
  const set = new Set(existing);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const n = `${base}-${i}`;
    if (!set.has(n)) return n;
  }
}
