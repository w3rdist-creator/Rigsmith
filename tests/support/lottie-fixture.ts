// A rig inside the Lottie subset: nested bones with a non-uniformly scaled parent (skew in
// the children), linear / step / smooth / bezier (overshoot) keys, keys between frames,
// opacity keys, a visibility key, an image swap, a hidden-at-setup attachment, a world
// (boneless) attachment and a skin with setup + keyed entries. Original procedural art.
import { makeBone } from '../../src/model/ops.ts';
import { keySlotImage, keySlotScalar } from '../../src/model/rigOps.ts';
import { addSkin, setSkinEntry } from '../../src/model/skinOps.ts';
import type { Key, Project } from '../../src/model/types.ts';
import { FORMAT_ID } from '../../src/model/types.ts';
import { encodePng } from './png-encode.ts';

function art(w: number, h: number, c: [number, number, number], soft = false): string {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
      d.set([Math.min(255, c[0] + x), Math.min(255, c[1] + y * 2), c[2], soft ? Math.min(255, 60 + edge * 40) : 255], (y * w + x) * 4);
    }
  return `data:image/png;base64,${encodePng(w, h, d).toString('base64')}`;
}

export function lottieProject(): Project {
  const img = (id: string, w: number, h: number, c: [number, number, number], soft = false) => ({ id, name: `${id}.png`, mime: 'image/png', width: w, height: h, dataUrl: art(w, h, c, soft) });
  const att = (id: string, boneId: string | null, imageId: string, x: number, y: number, rotation: number, extra: object = {}) => ({ id, name: id, boneId, imageId, x, y, rotation, scaleX: 1, scaleY: 1, opacity: 1, ...extra });
  const k = (time: number, value: number[], interp: Key['interp'] = 'linear', curve?: Key['curve']): Key => ({ time, value, interp, ...(curve ? { curve } : {}) });
  const p: Project = {
    format: FORMAT_ID,
    version: 2,
    name: 'lottie-subset',
    bones: [
      makeBone('root', 'root', null, 0, 0, 0, 10),
      makeBone('hips', 'hips', 'root', 0, 0, -90, 30),
      makeBone('torso', 'torso', 'hips', 30, 0, 10, 70),
      makeBone('head', 'head', 'torso', 70, 0, -10, 30),
      makeBone('arm', 'arm', 'torso', 55, 10, 120, 50),
      makeBone('hand', 'hand', 'arm', 50, 0, 0, 15),
    ],
    images: [img('torso', 44, 80, [60, 80, 200]), img('head', 40, 40, [220, 180, 60], true), img('head-wink', 40, 40, [240, 120, 60], true), img('arm', 50, 14, [40, 170, 90]), img('hand', 16, 16, [200, 60, 60], true), img('badge', 20, 20, [250, 250, 250]), img('head-alt', 40, 40, [120, 60, 220], true), img('wink-alt', 40, 40, [60, 200, 220], true)],
    attachments: [
      att('arm', 'arm', 'arm', 25, 0, 0, { opacity: 0.9 }),
      att('torso', 'torso', 'torso', 35, 0, 90),
      att('head', 'head', 'head', 18, 0, 90),
      att('hand', 'hand', 'hand', 6, 0, 30),
      att('badge', 'torso', 'badge', 40, -14, 0, { hidden: true }),
      att('shadow', null, 'torso', 0, 8, 90, { scaleX: 1.4, scaleY: 0.18, opacity: 0.35 }),
    ],
    animations: [
      {
        id: 'hop', name: 'hop', duration: 1, fps: 30, loop: true,
        tracks: {
          hips: { translate: [k(0, [0, 0], 'smooth'), k(0.4, [6, -30], 'bezier', [0.2, 0, 0.3, 1.35]), k(1, [0, 0])], rotate: [], scale: [k(0, [1, 1], 'smooth'), k(0.25, [1.25, 0.8], 'smooth'), k(0.5, [0.9, 1.1]), k(1, [1, 1])] },
          torso: { translate: [], rotate: [k(0, [10], 'bezier', [0.55, -0.45, 0.7, 1]), k(0.517, [-15], 'linear'), k(1, [10])], scale: [] },
          arm: { translate: [], rotate: [k(0, [120]), k(0.3, [40], 'step'), k(0.6, [80], 'smooth'), k(1, [120])], scale: [] },
          head: { translate: [k(0, [70, 0]), k(0.5, [74, 3], 'smooth'), k(1, [70, 0])], rotate: [], scale: [] },
        },
      },
    ],
  };
  const hop = p.animations[0];
  keySlotScalar(hop, 'arm', 'opacity', 0.1, 0.9);
  keySlotScalar(hop, 'arm', 'opacity', 0.55, 0.3);
  keySlotScalar(hop, 'badge', 'visible', 0.35, 1);
  keySlotScalar(hop, 'badge', 'visible', 0.8, 0);
  keySlotImage(hop, 'head', 0.51, 'head-wink');
  keySlotImage(hop, 'head', 0.7, 'head');
  // Between frames on purpose (keySlotImage snaps to frames): 0.51 s = frame 15.3.
  hop.slots!.head.image![0].time = 0.51;
  addSkin(p, 'skin_alt', 'alt');
  setSkinEntry(p, 'skin_alt', 'head', null, 'head-alt');
  setSkinEntry(p, 'skin_alt', 'head', 'head-wink', 'wink-alt');
  return p;
}
