// "rigsmith.runtime" export: a playback-oriented file without embedded image bytes.
// Bones and attachments are referenced by name; each animation carries its keys plus
// per-frame baked world transforms so a consumer can play it without an interpolator.
import { frameCount } from './animation.ts';
import { evaluate } from './evaluate.ts';
import { angleOf, round } from './math.ts';
import { topoOrder } from './skeleton.ts';
import type { Project } from './types.ts';

export const RUNTIME_FORMAT_ID = 'rigsmith.runtime';
export const RUNTIME_FORMAT_VERSION = 1;

export interface RuntimeExport {
  format: typeof RUNTIME_FORMAT_ID;
  version: typeof RUNTIME_FORMAT_VERSION;
  name: string;
  bones: { name: string; parent: string | null; x: number; y: number; rotation: number; scaleX: number; scaleY: number; length: number }[];
  attachments: { name: string; bone: string | null; image: string; width: number; height: number; x: number; y: number; rotation: number; scaleX: number; scaleY: number; opacity: number }[];
  animations: {
    name: string;
    duration: number;
    fps: number;
    loop: boolean;
    frames: number;
    keys: Record<string, { translate: unknown[]; rotate: unknown[]; scale: unknown[] }>;
    /** baked[boneName][frame] = [worldX, worldY, worldRotationDeg, worldScaleX, worldScaleY] (after IK/path constraints) */
    baked: Record<string, number[][]>;
    /** Only when the animation keys slots or draw order: per frame, attachments back→front with their state. */
    bakedSlots?: { attachment: string; visible: boolean; opacity: number; image: string }[][];
  }[];
}

export function exportRuntime(project: Project): RuntimeExport {
  const ordered = topoOrder(project.bones);
  const nameOf = new Map(project.bones.map((b) => [b.id, b.name]));
  const imageOf = new Map(project.images.map((im) => [im.id, im]));
  return {
    format: RUNTIME_FORMAT_ID,
    version: RUNTIME_FORMAT_VERSION,
    name: project.name,
    bones: ordered.map((b) => ({
      name: b.name,
      parent: b.parentId ? (nameOf.get(b.parentId) ?? null) : null,
      x: round(b.x),
      y: round(b.y),
      rotation: round(b.rotation),
      scaleX: round(b.scaleX),
      scaleY: round(b.scaleY),
      length: round(b.length),
    })),
    attachments: project.attachments.map((a) => {
      const im = imageOf.get(a.imageId);
      return {
        name: a.name,
        bone: a.boneId ? (nameOf.get(a.boneId) ?? null) : null,
        image: im?.name ?? a.imageId,
        width: im?.width ?? 0,
        height: im?.height ?? 0,
        x: round(a.x),
        y: round(a.y),
        rotation: round(a.rotation),
        scaleX: round(a.scaleX),
        scaleY: round(a.scaleY),
        opacity: round(a.opacity),
      };
    }),
    animations: project.animations.map((anim) => {
      const frames = frameCount(anim) + (anim.loop ? 0 : 1);
      const baked: Record<string, number[][]> = {};
      for (const b of ordered) baked[b.name] = [];
      const slotted = !!(anim.drawOrder?.length || Object.keys(anim.slots ?? {}).length);
      const bakedSlots: NonNullable<RuntimeExport['animations'][number]['bakedSlots']> = [];
      for (let f = 0; f < frames; f++) {
        const t = Math.min(anim.duration, f / anim.fps);
        const fr = evaluate(project, anim, t);
        const world = fr.world;
        if (slotted) bakedSlots.push(fr.attachments.map((a) => ({ attachment: a.att.name, visible: a.visible, opacity: round(a.opacity, 4), image: a.image?.name ?? '' })));
        for (const b of ordered) {
          const m = world.get(b.id)!;
          baked[b.name].push([round(m.tx, 3), round(m.ty, 3), round(angleOf(m), 3), round(Math.hypot(m.a, m.b), 4), round(Math.hypot(m.c, m.d), 4)]);
        }
      }
      const keys: RuntimeExport['animations'][number]['keys'] = {};
      for (const [boneId, track] of Object.entries(anim.tracks)) {
        const n = nameOf.get(boneId);
        if (!n) continue;
        const conv = (ks: typeof track.translate) => ks.map((k) => ({ time: round(k.time, 6), value: k.value.map((v) => round(v)), interp: k.interp }));
        keys[n] = { translate: conv(track.translate), rotate: conv(track.rotate), scale: conv(track.scale) };
      }
      return { name: anim.name, duration: anim.duration, fps: anim.fps, loop: anim.loop, frames, keys, baked, ...(slotted ? { bakedSlots } : {}) };
    }),
  };
}
