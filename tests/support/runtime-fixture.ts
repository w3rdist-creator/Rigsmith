// A rig that exercises every runtime feature at once: bezier keys, two-bone IK with a
// keyed mix, a path constraint with keyed position, a weighted mesh with deform keys,
// slot opacity / image / draw-order keys, a skin with setup and keyed-image entries, two
// animations and a stored mix rule. Built with the model ops (pure) and serialized as a
// project file that the e2e test opens through the editor's visible Open control.
// Art is opaque to the image edge on purpose (atlas bleed matters there).
import { makeBone } from '../../src/model/ops.ts';
import { autoWeights, gridPoints, keyDeform, setMesh, triangulate } from '../../src/model/meshOps.ts';
import { addIk, addPath, addPathConstraint, keyConstraint, keyDrawOrder, keySlotImage, keySlotScalar } from '../../src/model/rigOps.ts';
import { setMixRule } from '../../src/model/mix.ts';
import { addSkin, setSkinEntry } from '../../src/model/skinOps.ts';
import type { Animation, Key, Project } from '../../src/model/types.ts';
import { FORMAT_ID } from '../../src/model/types.ts';
import { encodePng } from './png-encode.ts';

function art(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]): string {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(f(x, y), (y * w + x) * 4);
  return `data:image/png;base64,${encodePng(w, h, d).toString('base64')}`;
}

const grad = (r: number, g: number, b: number) => (x: number, y: number): [number, number, number, number] => [Math.min(255, r + x * 2), Math.min(255, g + y * 2), b, 255];

export function richProject(): Project {
  const img = (id: string, name: string, w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) => ({ id, name, mime: 'image/png', width: w, height: h, dataUrl: art(w, h, f) });
  const p: Project = {
    format: FORMAT_ID,
    version: 2,
    name: 'runtime-rig',
    bones: [
      makeBone('root', 'root', null, 0, 0, 0, 20),
      makeBone('torso', 'torso', 'root', 0, 0, -90, 80),
      makeBone('upper', 'upper', 'torso', 70, 0, 100, 50),
      makeBone('lower', 'lower', 'upper', 50, 0, -30, 45),
      makeBone('m1', 'm1', 'root', -150, 40, 0, 60),
      makeBone('m2', 'm2', 'm1', 60, 0, 0, 60),
      makeBone('f1', 'f1', 'root', 0, 120, 0, 20),
      makeBone('f2', 'f2', 'root', 0, 120, 0, 20),
    ],
    images: [
      img('i_torso', 'torso.png', 40, 90, grad(40, 60, 200)),
      img('i_torso_alt', 'torso-alt.png', 40, 90, grad(200, 40, 60)),
      img('i_arm', 'arm.png', 56, 14, grad(30, 180, 60)),
      img('i_arm2', 'arm-raised.png', 56, 14, grad(220, 200, 20)),
      img('i_arm2_alt', 'arm-raised-alt.png', 56, 14, grad(250, 120, 0)),
      img('i_band', 'band.png', 120, 30, grad(120, 30, 180)),
      img('i_bead', 'bead.png', 12, 12, grad(240, 240, 240)),
    ],
    attachments: [
      { id: 'a_band', name: 'band', boneId: 'm1', imageId: 'i_band', x: 60, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 },
      { id: 'a_torso', name: 'torso', boneId: 'torso', imageId: 'i_torso', x: 40, y: 0, rotation: 90, scaleX: 1, scaleY: 1, opacity: 1 },
      { id: 'a_upper', name: 'upper', boneId: 'upper', imageId: 'i_arm', x: 25, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 },
      { id: 'a_lower', name: 'lower', boneId: 'lower', imageId: 'i_arm', x: 22, y: 0, rotation: 0, scaleX: 0.9, scaleY: 1, opacity: 0.85 },
      { id: 'a_bead1', name: 'bead1', boneId: 'f1', imageId: 'i_bead', x: 0, y: 0, rotation: 15, scaleX: 1, scaleY: 1, opacity: 1 },
      { id: 'a_bead2', name: 'bead2', boneId: 'f2', imageId: 'i_bead', x: 0, y: 0, rotation: 15, scaleX: 1, scaleY: 1, opacity: 1 },
    ],
    animations: [],
  };
  // Mesh over a two-bone chain, auto-weighted.
  const g = gridPoints(120, 30, 6, 2);
  setMesh(p, 'a_band', triangulate(g.hull, g.interior));
  const band = p.attachments.find((a) => a.id === 'a_band')!;
  band.mesh!.weights = autoWeights(p, band, ['m1', 'm2']);
  addIk(p, 'lower', true, { ik: 'ik_arm', target: 'arm_target' });
  addPath(p, 'path_a', 'root', { x: 0, y: 140 }, 90);
  addPathConstraint(p, 'pc_beads', 'path_a', ['f1', 'f2']);
  p.pathConstraints![0].spacing = 30;

  const k = (time: number, value: number[], interp: Key['interp'] = 'linear', curve?: Key['curve']): Key => ({ time, value, interp, ...(curve ? { curve } : {}) });
  const target = p.bones.find((b) => b.id === 'arm_target')!;
  const wave: Animation = {
    id: 'wave', name: 'wave', duration: 1, fps: 30, loop: true,
    tracks: {
      torso: { translate: [], rotate: [k(0, [-90], 'bezier', [0.3, 0, 0.2, 1.4]), k(0.5, [-75], 'bezier', [0.42, 0, 0.58, 1]), k(1, [-90])], scale: [] },
      arm_target: { translate: [k(0, [target.x, target.y], 'smooth'), k(0.5, [target.x + 40, target.y - 50], 'smooth'), k(1, [target.x, target.y])], rotate: [], scale: [] },
      m2: { translate: [], rotate: [k(0, [0]), k(0.5, [35], 'bezier', [0.25, 0.1, 0.25, 1]), k(1, [0])], scale: [] },
      m1: { translate: [], rotate: [], scale: [k(0, [1, 1]), k(0.5, [1.1, 0.9]), k(1, [1, 1])] },
    },
  };
  keySlotScalar(wave, 'a_lower', 'opacity', 0, 0.85);
  keySlotScalar(wave, 'a_lower', 'opacity', 0.6, 0.4);
  keySlotImage(wave, 'a_upper', 0.5, 'i_arm2');
  keySlotScalar(wave, 'a_bead2', 'visible', 0.8, 0);
  keyDrawOrder(wave, 0.4, ['a_torso', 'a_band', 'a_upper', 'a_lower', 'a_bead1', 'a_bead2']);
  keyConstraint(wave, 'ik_arm', 'mix', 0, 1);
  keyConstraint(wave, 'ik_arm', 'mix', 0.7, 0.5);
  keyConstraint(wave, 'pc_beads', 'position', 0, 0.1);
  keyConstraint(wave, 'pc_beads', 'position', 1, 0.6);
  p.animations.push(wave);
  const n = band.mesh!.points.length;
  keyDeform(wave, 'a_band', 0, new Array(n).fill(0));
  keyDeform(wave, 'a_band', 0.5, band.mesh!.points.map((_, i) => (i % 2 ? Math.sin(i) * 4 : 2)));
  const rest: Animation = {
    id: 'rest', name: 'rest', duration: 0.5, fps: 30, loop: false,
    tracks: { torso: { translate: [], rotate: [k(0, [-90]), k(0.5, [-100])], scale: [] }, m2: { translate: [], rotate: [k(0, [-20])], scale: [] } },
  };
  p.animations.push(rest);
  setMixRule(p, 'wave', 'rest', 0.3);
  addSkin(p, 'skin_alt', 'alt');
  setSkinEntry(p, 'skin_alt', 'a_torso', null, 'i_torso_alt');
  setSkinEntry(p, 'skin_alt', 'a_upper', 'i_arm2', 'i_arm2_alt');
  return p;
}
