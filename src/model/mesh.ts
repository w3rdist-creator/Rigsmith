// Mesh attachments: vertex positions in image pixel space double as texture
// coordinates. Rigid meshes follow the attachment's bone; weighted meshes are skinned
// with the setup pose as the bind pose:
//   v = Σ wᵢ · Wᵢ(now) · Wᵢ(setup)⁻¹ · A(setup) · (p + deform)
// where A is the attachment's world matrix and p the vertex in attachment-local space.
import type { Mat } from './math.ts';
import { apply, invert, multiply } from './math.ts';
import { attachmentWorld } from './skeleton.ts';
import type { Attachment, ImageAsset } from './types.ts';

/** Vertex i in attachment-local space (image centred), with an optional deform offset. */
export function localVertex(points: readonly number[], i: number, im: { width: number; height: number }, deform?: readonly number[]): { x: number; y: number } {
  return {
    x: points[2 * i] - im.width / 2 + (deform?.[2 * i] ?? 0),
    y: points[2 * i + 1] - im.height / 2 + (deform?.[2 * i + 1] ?? 0),
  };
}

export function meshWorldVertices(att: Attachment, im: ImageAsset, world: ReadonlyMap<string, Mat>, setupWorld: ReadonlyMap<string, Mat>, deform?: readonly number[]): number[] {
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
  const rest = attachmentWorld(att, setupWorld);
  const skinCache = new Map<string, Mat>();
  const skinMat = (bone: string): Mat => {
    let m = skinCache.get(bone);
    if (!m) {
      const now = world.get(bone);
      const bind = setupWorld.get(bone);
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
