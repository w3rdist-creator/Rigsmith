// Original procedural mesh fixtures: patterned band art with transparent margins (so the
// mesh hull, on the image rectangle, never cuts opaque texels), grid meshes and small
// project JSON files built directly in the documented format.
import { writeFileSync } from 'node:fs';
import { encodePng } from './png-encode.ts';

/** Band art: a colour gradient + checker (unless `smooth`) inside a `margin` px transparent border. */
export function bandArt(w: number, h: number, margin: number, alpha = 255, smooth = false): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = margin; y < h - margin; y++)
    for (let x = margin; x < w - margin; x++) {
      const checker = smooth ? 0.5 : ((x >> 3) + (y >> 3)) & 1;
      out.set([Math.round((255 * x) / w), Math.round((255 * y) / h), Math.round(40 + 180 * checker), alpha], (y * w + x) * 4);
    }
  return out;
}

/** Nearest-neighbour 2× upscale (same art at another resolution, for image-swap checks). */
export function upscale2(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(w * h * 16);
  for (let y = 0; y < h * 2; y++) for (let x = 0; x < w * 2; x++) out.set(rgba.subarray(((y >> 1) * w + (x >> 1)) * 4, ((y >> 1) * w + (x >> 1)) * 4 + 4), (y * w * 2 + x) * 4);
  return out;
}

export interface GridMesh {
  points: number[];
  triangles: number[];
  hull: number;
}

/** cols×rows grid over a w×h image: hull vertices first (clockwise from top-left), then interior. */
export function gridMesh(w: number, h: number, cols: number, rows: number): GridMesh {
  const ring: [number, number][] = [];
  for (let i = 0; i < cols; i++) ring.push([i, 0]);
  for (let j = 0; j < rows; j++) ring.push([cols, j]);
  for (let i = cols; i > 0; i--) ring.push([i, rows]);
  for (let j = rows; j > 0; j--) ring.push([0, j]);
  const index = new Map<string, number>();
  const points: number[] = [];
  const add = (i: number, j: number) => {
    index.set(`${i},${j}`, points.length / 2);
    points.push((i * w) / cols, (j * h) / rows);
  };
  for (const [i, j] of ring) add(i, j);
  for (let j = 1; j < rows; j++) for (let i = 1; i < cols; i++) add(i, j);
  const at = (i: number, j: number) => index.get(`${i},${j}`)!;
  const triangles: number[] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      triangles.push(at(i, j), at(i + 1, j), at(i + 1, j + 1));
      triangles.push(at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  return { points, triangles, hull: ring.length };
}

export const dataUrl = (w: number, h: number, rgba: Uint8Array) => `data:image/png;base64,${encodePng(w, h, rgba).toString('base64')}`;

export interface MeshFixture {
  name: string;
  /** Root bone setup transform. */
  root?: { x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number };
  alpha?: number;
  opacity?: number;
  cols?: number;
  rows?: number;
  /** Two-bone bend: weights blend from root to tip across the middle fifth. */
  weighted?: boolean;
  /** Keys for frame 1 (t = 1/30): tip rotation, deform offsets per vertex, image swap. */
  tipRotate?: number;
  deform?: (mesh: GridMesh) => number[];
  swapTo2x?: boolean;
}

export const ART_W = 120, ART_H = 40, ART_MARGIN = 4;

/** A one-attachment mesh project (version 2) and its art, per the format docs. */
export function meshProject(f: MeshFixture): any {
  const W = ART_W, H = ART_H;
  // The 2× swap uses smooth art so filtering differences of a sharper texture do not mask the UV check.
  const px = bandArt(W, H, ART_MARGIN, f.alpha ?? 255, !!f.swapTo2x);
  const mesh: any = gridMesh(W, H, f.cols ?? 6, f.rows ?? 2);
  const images: any[] = [{ id: 'img_band', name: 'band.png', mime: 'image/png', width: W, height: H, dataUrl: dataUrl(W, H, px) }];
  const bones: any[] = [
    { id: 'b_root', name: 'root', parentId: null, x: f.root?.x ?? 0, y: f.root?.y ?? 0, rotation: f.root?.rotation ?? 0, scaleX: f.root?.scaleX ?? 1, scaleY: f.root?.scaleY ?? 1, length: W / 2, color: '#f2c14e' },
    { id: 'b_tip', name: 'tip', parentId: 'b_root', x: W / 2, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: W / 2, color: '#4ea8f2' },
  ];
  if (f.weighted) {
    mesh.weights = [];
    for (let i = 0; i < mesh.points.length / 2; i++) {
      const u = mesh.points[2 * i] / W;
      const wt = Math.min(1, Math.max(0, (u - 0.4) / 0.2));
      mesh.weights.push(wt <= 0 ? [{ bone: 'b_root', w: 1 }] : wt >= 1 ? [{ bone: 'b_tip', w: 1 }] : [{ bone: 'b_root', w: 1 - wt }, { bone: 'b_tip', w: wt }]);
    }
  }
  const tracks: any = {};
  if (f.tipRotate !== undefined) tracks.b_tip = { translate: [], rotate: [{ time: 1 / 30, value: [f.tipRotate], interp: 'linear' }], scale: [] };
  const slots: any = {};
  if (f.deform) slots.att_band = { deform: [{ time: 1 / 30, value: f.deform(mesh), interp: 'linear' }] };
  if (f.swapTo2x) {
    images.push({ id: 'img_band2x', name: 'band@2x.png', mime: 'image/png', width: W * 2, height: H * 2, dataUrl: dataUrl(W * 2, H * 2, upscale2(W, H, px)) });
    slots.att_band = { ...slots.att_band, image: [{ time: 1 / 30, imageId: 'img_band2x' }] };
  }
  const anim: any = { id: 'anim_a', name: 'a', duration: 1, fps: 30, loop: false, tracks };
  if (Object.keys(slots).length) anim.slots = slots;
  return {
    format: 'rigsmith.project',
    version: 2,
    name: f.name,
    bones,
    images,
    attachments: [{ id: 'att_band', name: 'band', boneId: 'b_root', imageId: 'img_band', x: W / 2, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: f.opacity ?? 1, mesh }],
    animations: [anim],
  };
}

// ---- Bendy-limb demo art (original, procedural) ----------------------------------------

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function paintArt(w: number, h: number, shade: (x: number, y: number) => [number, number, number, number] | null): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = shade(x + 0.5, y + 0.5);
      if (c) out.set(c, (y * w + x) * 4);
    }
  return out;
}

/** A rubber-hose arm (one continuous tube with ring stripes and a top highlight), a tapered tail and a body. */
export const MESH_ART: Record<string, { w: number; h: number; px: () => Uint8Array }> = {
  'hose-arm.png': {
    w: 240, h: 48,
    px: () => paintArt(240, 48, (x, y) => {
      const cx = Math.min(216, Math.max(24, x));
      const a = clamp01(20.5 - Math.hypot(x - cx, y - 24));
      if (!a) return null;
      const ring = Math.floor((x - 24) / 16) % 2 === 0;
      const light = 1 - Math.abs(y - 16) / 34;
      const base = x > 200 ? [250, 246, 236] : ring ? [70, 130, 230] : [52, 104, 200];
      return [Math.round(base[0] * light), Math.round(base[1] * light), Math.round(base[2] * light), Math.round(255 * a)];
    }),
  },
  'tail.png': {
    w: 180, h: 28,
    px: () => paintArt(180, 28, (x, y) => {
      const u = clamp01((x - 14) / 156);
      const r = 12 - 9 * u;
      const cx = Math.min(170, Math.max(14, x));
      const a = clamp01(r + 0.5 - Math.hypot(x - cx, y - 14));
      if (!a) return null;
      const tip = x > 150;
      return [tip ? 60 : Math.round(240 - 40 * u), tip ? 40 : Math.round(150 - 60 * u), tip ? 30 : 40, Math.round(255 * a)];
    }),
  },
  'body.png': {
    w: 96, h: 112,
    px: () => paintArt(96, 112, (x, y) => {
      const d = Math.hypot((x - 48) / 44, (y - 56) / 52);
      const a = clamp01((1 - d) * 44 + 0.5);
      if (!a) return null;
      return [Math.round(120 + 60 * (y / 112)), 86, 160, Math.round(255 * a)];
    }),
  },
};

export function writeMeshArt(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, art] of Object.entries(MESH_ART)) {
    const file = `${dir}/${name}`;
    writeFileSync(file, encodePng(art.w, art.h, art.px()));
    out[name] = file;
  }
  return out;
}
