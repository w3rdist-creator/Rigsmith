// Mesh attachments: vertex positions are in the pixel space of the attachment's *setup*
// image and double as its texture coordinates. When an image key or skin shows a
// different image, the geometry stays put and only the texture coordinates scale by the
// size ratio (normalized UVs). Rigid meshes follow the attachment's bone; weighted meshes
// are skinned from their bind pose (v3 `mesh.bind`, else the setup pose):
//   v = Σ wᵢ · Wᵢ(now) · Wᵢ(bind)⁻¹ · A(bind) · (p + deform)
// where A is the attachment's world matrix and p the vertex in attachment-local space
// (centred on the setup image).
import type { Mat } from './math.ts';
import { apply, invert, multiply } from './math.ts';
import { attachmentWorld } from './skeleton.ts';
import type { Affine, Attachment } from './types.ts';

export const toMat = (m: readonly number[]): Mat => ({ a: m[0], b: m[1], c: m[2], d: m[3], tx: m[4], ty: m[5] });
/** Matrix as stored; −0 becomes 0 so a stored bind equals its JSON round trip. */
export const toAffine = (m: Mat): Affine => [m.a + 0, m.b + 0, m.c + 0, m.d + 0, m.tx + 0, m.ty + 0];

/**
 * The frame a weighted mesh is skinned from: the attachment's world matrix and each
 * bone's world matrix at bind time (its own bind pose where stored, else the setup pose).
 */
export function bindFrame(att: Attachment, setupWorld: ReadonlyMap<string, Mat>): { rest: Mat; bone: (id: string) => Mat | undefined } {
  const b = att.mesh?.bind;
  if (!b) return { rest: attachmentWorld(att, setupWorld), bone: (id) => setupWorld.get(id) };
  return { rest: toMat(b.attachment), bone: (id) => (b.bones[id] ? toMat(b.bones[id]) : setupWorld.get(id)) };
}

/** Setup bone worlds with the mesh's bind matrices in place (for weight tools working in the bind pose). */
export function bindWorld(att: Attachment, setupWorld: ReadonlyMap<string, Mat>): Map<string, Mat> {
  const out = new Map(setupWorld);
  for (const [id, m] of Object.entries(att.mesh?.bind?.bones ?? {})) out.set(id, toMat(m));
  return out;
}

/** Vertex i in attachment-local space (image centred), with an optional deform offset. */
export function localVertex(points: readonly number[], i: number, im: { width: number; height: number }, deform?: readonly number[]): { x: number; y: number } {
  return {
    x: points[2 * i] - im.width / 2 + (deform?.[2 * i] ?? 0),
    y: points[2 * i + 1] - im.height / 2 + (deform?.[2 * i + 1] ?? 0),
  };
}

export function meshWorldVertices(att: Attachment, im: { width: number; height: number }, world: ReadonlyMap<string, Mat>, setupWorld: ReadonlyMap<string, Mat>, deform?: readonly number[]): number[] {
  const mesh = att.mesh!;
  const n = mesh.points.length / 2;
  const out = new Array<number>(n * 2);
  if (!mesh.weights) {
    const m = attachmentWorld(att, world);
    for (let i = 0; i < n; i++) {
      const q = apply(m, localVertex(mesh.points, i, im, deform));
      out[2 * i] = q.x;
      out[2 * i + 1] = q.y;
    }
    return out;
  }
  const { rest, bone: bindOf } = bindFrame(att, setupWorld);
  const skinCache = new Map<string, Mat>();
  const skinMat = (bone: string): Mat => {
    let m = skinCache.get(bone);
    if (!m) {
      const now = world.get(bone);
      const bind = bindOf(bone);
      m = now && bind ? multiply(now, invert(bind)) : { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
      skinCache.set(bone, m);
    }
    return m;
  };
  for (let i = 0; i < n; i++) {
    const v0 = apply(rest, localVertex(mesh.points, i, im, deform));
    let x = 0;
    let y = 0;
    for (const inf of mesh.weights[i]) {
      const q = apply(skinMat(inf.bone), v0);
      x += q.x * inf.w;
      y += q.y * inf.w;
    }
    out[2 * i] = x;
    out[2 * i + 1] = y;
  }
  return out;
}

/** Texture coordinates of a mesh for the image actually shown (points scaled from the setup image). */
export function meshUvs(points: readonly number[], setup: { width: number; height: number }, shown: { width: number; height: number }): readonly number[] {
  if (setup.width === shown.width && setup.height === shown.height) return points;
  const sx = shown.width / setup.width, sy = shown.height / setup.height;
  return points.map((v, i) => (i % 2 ? v * sy : v * sx));
}
