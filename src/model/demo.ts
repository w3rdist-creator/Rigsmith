// Built-in demo: "Tock", an original wind-up tin courier. Art is generated at runtime
// (src/ui/demoArt.ts); this module only defines the rig, attachments and animations.
import type { Animation, Attachment, Bone, ImageAsset, Interp, Key, Project } from './types.ts';
import { FORMAT_ID, FORMAT_VERSION } from './types.ts';

export interface DemoPart {
  id: string;
  name: string;
  width: number;
  height: number;
}

/** Upright art sizes, in pixels. */
export const DEMO_PARTS: readonly DemoPart[] = [
  { id: 'img_torso', name: 'tock-torso.png', width: 74, height: 92 },
  { id: 'img_head', name: 'tock-head.png', width: 70, height: 60 },
  { id: 'img_upperarm', name: 'tock-upper-arm.png', width: 20, height: 50 },
  { id: 'img_forearm', name: 'tock-forearm.png', width: 22, height: 50 },
  { id: 'img_thigh', name: 'tock-thigh.png', width: 24, height: 50 },
  { id: 'img_shin', name: 'tock-shin.png', width: 30, height: 56 },
  { id: 'img_key', name: 'tock-windup-key.png', width: 40, height: 26 },
];

function bone(id: string, name: string, parentId: string | null, x: number, y: number, rotation: number, length: number, color: string): Bone {
  return { id, name, parentId, x, y, rotation, scaleX: 1, scaleY: 1, length, color };
}

function att(id: string, boneId: string, imageId: string, x: number, y: number, rotation: number): Attachment {
  return { id, name: id.replace(/^att_/, ''), boneId, imageId, x, y, rotation, scaleX: 1, scaleY: 1, opacity: 1 };
}

function keys(interp: Interp, ...pairs: [number, ...number[]][]): Key[] {
  return pairs.map(([time, ...value]) => ({ time, value, interp }));
}

export function demoBones(): Bone[] {
  return [
    bone('b_root', 'root', null, 0, 0, 0, 24, '#f2c14e'),
    bone('b_torso', 'torso', 'b_root', 0, -6, -90, 84, '#f78154'),
    bone('b_head', 'head', 'b_torso', 84, 0, 0, 52, '#f78154'),
    bone('b_key', 'windup-key', 'b_torso', 50, -34, 270, 26, '#b4c5e4'),
    bone('b_arm_back', 'arm-back', 'b_torso', 72, 6, 180, 46, '#5fad56'),
    bone('b_fore_back', 'forearm-back', 'b_arm_back', 46, 0, -12, 44, '#5fad56'),
    bone('b_thigh_back', 'thigh-back', 'b_root', -5, 4, 90, 46, '#4d9078'),
    bone('b_shin_back', 'shin-back', 'b_thigh_back', 46, 0, 0, 48, '#4d9078'),
    bone('b_thigh_front', 'thigh-front', 'b_root', 5, 4, 90, 46, '#3c91e6'),
    bone('b_shin_front', 'shin-front', 'b_thigh_front', 46, 0, 0, 48, '#3c91e6'),
    bone('b_arm_front', 'arm-front', 'b_torso', 72, -6, 180, 46, '#3c91e6'),
    bone('b_fore_front', 'forearm-front', 'b_arm_front', 46, 0, -12, 44, '#3c91e6'),
  ];
}

/** Draw order: back limbs first, front limbs last. */
export function demoAttachments(): Attachment[] {
  return [
    att('att_arm_back', 'b_arm_back', 'img_upperarm', 23, 0, -90),
    att('att_fore_back', 'b_fore_back', 'img_forearm', 22, 0, -90),
    att('att_thigh_back', 'b_thigh_back', 'img_thigh', 23, 0, -90),
    att('att_shin_back', 'b_shin_back', 'img_shin', 24, 4, -90),
    att('att_key', 'b_key', 'img_key', 18, 0, 0),
    att('att_torso', 'b_torso', 'img_torso', 42, 0, 90),
    att('att_head', 'b_head', 'img_head', 26, 0, 90),
    att('att_thigh_front', 'b_thigh_front', 'img_thigh', 23, 0, -90),
    att('att_shin_front', 'b_shin_front', 'img_shin', 24, 4, -90),
    att('att_arm_front', 'b_arm_front', 'img_upperarm', 23, 0, -90),
    att('att_fore_front', 'b_fore_front', 'img_forearm', 22, 0, -90),
  ];
}

export function demoAnimations(): Animation[] {
  const walk: Animation = {
    id: 'anim_walk',
    name: 'walk',
    duration: 1,
    fps: 30,
    loop: true,
    tracks: {
      b_root: {
        translate: keys('smooth', [0, 0, 0], [0.25, 0, -7], [0.5, 0, 0], [0.75, 0, -7], [1, 0, 0]),
        rotate: [],
        scale: [],
      },
      b_torso: { translate: [], rotate: keys('smooth', [0, -86], [0.5, -94], [1, -86]), scale: [] },
      b_head: { translate: [], rotate: keys('smooth', [0, -5], [0.5, 5], [1, -5]), scale: [] },
      b_key: { translate: [], rotate: keys('linear', [0, 270], [1, 630]), scale: [] },
      b_thigh_front: { translate: [], rotate: keys('smooth', [0, 62], [0.5, 118], [1, 62]), scale: [] },
      b_shin_front: { translate: [], rotate: keys('smooth', [0, 4], [0.25, 8], [0.5, 2], [0.75, 48], [1, 4]), scale: [] },
      b_thigh_back: { translate: [], rotate: keys('smooth', [0, 118], [0.5, 62], [1, 118]), scale: [] },
      b_shin_back: { translate: [], rotate: keys('smooth', [0, 2], [0.25, 48], [0.5, 4], [0.75, 8], [1, 2]), scale: [] },
      b_arm_front: { translate: [], rotate: keys('smooth', [0, 210], [0.5, 150], [1, 210]), scale: [] },
      b_fore_front: { translate: [], rotate: keys('smooth', [0, -10], [0.5, -40], [1, -10]), scale: [] },
      b_arm_back: { translate: [], rotate: keys('smooth', [0, 150], [0.5, 210], [1, 150]), scale: [] },
      b_fore_back: { translate: [], rotate: keys('smooth', [0, -40], [0.5, -10], [1, -40]), scale: [] },
    },
  };
  const wave: Animation = {
    id: 'anim_wave',
    name: 'wave',
    duration: 1.6,
    fps: 30,
    loop: true,
    tracks: {
      b_arm_front: { translate: [], rotate: keys('smooth', [0, 20], [1.6, 20]), scale: [] },
      b_fore_front: {
        translate: [],
        rotate: keys('smooth', [0, -60], [0.4, -20], [0.8, -60], [1.2, -20], [1.6, -60]),
        scale: [],
      },
      b_head: { translate: [], rotate: keys('smooth', [0, 0], [0.8, 8], [1.6, 0]), scale: [] },
      b_torso: { translate: [], rotate: [], scale: keys('smooth', [0, 1, 1], [0.8, 1.04, 0.97], [1.6, 1, 1]) },
      b_key: { translate: [], rotate: keys('linear', [0, 270], [1.6, 450]), scale: [] },
    },
  };
  return [walk, wave];
}

export function buildDemoProject(images: ImageAsset[]): Project {
  return {
    format: FORMAT_ID,
    version: FORMAT_VERSION,
    name: 'Tock the tin courier (demo)',
    bones: demoBones(),
    images,
    attachments: demoAttachments(),
    animations: demoAnimations(),
  };
}
