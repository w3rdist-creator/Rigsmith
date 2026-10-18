// Mesh authoring operations (pure; the editor wraps each call in one undoable mutation):
// outline validation, triangulation (ear clipping of the outline, interior points
// inserted by splitting, then Delaunay edge flips that never touch outline edges),
// weight normalization / painting / automatic weights, deform keys and the per-vertex
// Jacobian that converts a world-space drag into an image-space offset.
import { sampleKeys } from './animation.ts';
import type { Mat } from './math.ts';
import { apply, invert, multiply } from './math.ts';
import { localVertex } from './mesh.ts';
import { attachmentWorld, computeWorld } from './skeleton.ts';
import type { Animation, Attachment, Key, Mesh, Project, VertexWeights } from './types.ts';

type V = { x: number; y: number };
const cross = (o: V, a: V, b: V) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const pt = (flat: readonly number[], i: number): V => ({ x: flat[2 * i], y: flat[2 * i + 1] });
/** Points closer than this (image px) count as duplicates. */
export const MIN_VERTEX_GAP = 0.5;
/** Triangles with less area (image px²) are degenerate. */
export const MIN_TRIANGLE_AREA = 1e-3;

function segmentsCross(a: V, b: V, c: V, d: V): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p: V, q: V, r: V) => Math.abs(cross(p, q, r)) < 1e-9 && Math.min(p.x, q.x) - 1e-9 <= r.x && r.x <= Math.max(p.x, q.x) + 1e-9 && Math.min(p.y, q.y) - 1e-9 <= r.y && r.y <= Math.max(p.y, q.y) + 1e-9;
  return on(c, d, a) || on(c, d, b) || on(a, b, c) || on(a, b, d);
}

function distToSegment(p: V, a: V, b: V): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

export function insidePolygon(poly: readonly V[], p: V): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Validates an outline + interior points (image px); returns a message or null. */
export function meshProblem(hull: readonly number[], interior: readonly number[], dims: { width: number; height: number }): string | null {
  const n = hull.length / 2;
  if (n < 3) return 'Place at least 3 outline points.';
  const all = [...hull, ...interior];
  for (let i = 0; i < all.length / 2; i++) {
    const p = pt(all, i);
    if (p.x < 0 || p.y < 0 || p.x > dims.width || p.y > dims.height) return `Point ${i + 1} lies outside the image.`;
    for (let j = 0; j < i; j++) if (Math.hypot(p.x - all[2 * j], p.y - all[2 * j + 1]) < MIN_VERTEX_GAP) return `Points ${j + 1} and ${i + 1} are duplicates.`;
  }
  const poly = Array.from({ length: n }, (_, i) => pt(hull, i));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return 'The outline crosses itself.';
    }
  let area = 0;
  for (let i = 0; i < n; i++) area += cross({ x: 0, y: 0 }, poly[i], poly[(i + 1) % n]);
  if (Math.abs(area) / 2 < MIN_TRIANGLE_AREA) return 'The outline encloses no area.';
  for (let k = 0; k < interior.length / 2; k++) {
    const p = pt(interior, k);
    if (!insidePolygon(poly, p)) return `Interior point ${k + 1} lies outside the outline.`;
    for (let i = 0; i < n; i++) if (distToSegment(p, poly[i], poly[(i + 1) % n]) < MIN_VERTEX_GAP) return `Interior point ${k + 1} lies on the outline.`;
  }
  return null;
}

/** Ear-clips a simple polygon (indices into `pts`); returns triangles with positive orientation. */
function earClip(pts: readonly V[], ring: number[]): number[] {
  const out: number[] = [];
  let area = 0;
  for (let i = 0; i < ring.length; i++) area += cross({ x: 0, y: 0 }, pts[ring[i]], pts[ring[(i + 1) % ring.length]]);
  const r = area < 0 ? ring.slice().reverse() : ring.slice();
  let guard = 0;
  while (r.length > 3 && guard++ < 10000) {
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < r.length; i++) {
      const a = pts[r[(i + r.length - 1) % r.length]], b = pts[r[i]], c = pts[r[(i + 1) % r.length]];
      if (cross(a, b, c) <= 1e-9) continue; // reflex or collinear: not an ear
      let blocked = false;
      for (let j = 0; j < r.length && !blocked; j++) {
        const q = pts[r[j]];
        if (q === a || q === b || q === c) continue;
        if (cross(a, b, q) >= -1e-9 && cross(b, c, q) >= -1e-9 && cross(c, a, q) >= -1e-9) blocked = true;
      }
      if (blocked) continue;
      // Prefer well-shaped ears (largest smallest angle, via a cheap proxy).
      const e = [Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - b.x, c.y - b.y), Math.hypot(a.x - c.x, a.y - c.y)];
      const score = cross(a, b, c) / Math.max(...e) ** 2;
      if (score > bestScore) (bestScore = score), (best = i);
    }
    if (best < 0) return [];
    out.push(r[(best + r.length - 1) % r.length], r[best], r[(best + 1) % r.length]);
    r.splice(best, 1);
  }
  if (r.length === 3) out.push(r[0], r[1], r[2]);
  return out;
}

function inCircle(a: V, b: V, c: V, d: V): boolean {
  // a,b,c counter-clockwise (positive cross); true when d is strictly inside the circumcircle.
  const ax = a.x - d.x, ay = a.y - d.y, bx = b.x - d.x, by = b.y - d.y, cx = c.x - d.x, cy = c.y - d.y;
  return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay) > 1e-9;
}

/**
 * Triangulates outline `hull` (in order) plus `interior` points. Vertex order of the
 * result: the outline first, then the interior points. Throws on invalid input.
 */
export function triangulate(hull: readonly number[], interior: readonly number[] = []): Mesh {
  const points = [...hull, ...interior];
  const pts = Array.from({ length: points.length / 2 }, (_, i) => pt(points, i));
  const n = hull.length / 2;
  const tris = earClip(pts, Array.from({ length: n }, (_, i) => i));
  if (!tris.length) throw new Error('The outline could not be triangulated.');
  // Insert interior points one by one, splitting the triangle (or edge) that holds them.
  for (let k = n; k < pts.length; k++) {
    const p = pts[k];
    let placed = false;
    for (let t = 0; t < tris.length && !placed; t += 3) {
      const [i0, i1, i2] = [tris[t], tris[t + 1], tris[t + 2]];
      const c0 = cross(pts[i1], pts[i2], p), c1 = cross(pts[i2], pts[i0], p), c2 = cross(pts[i0], pts[i1], p);
      if (c0 < -1e-9 || c1 < -1e-9 || c2 < -1e-9) continue;
      const onEdge = [c0, c1, c2].findIndex((c) => Math.abs(c) <= 1e-9);
      if (onEdge < 0) {
        tris.splice(t, 3, i0, i1, k, i1, i2, k, i2, i0, k);
      } else {
        // On edge (a,b) opposite vertex `opp`: split this triangle and its neighbour.
        // Triangle (a, b, opp) becomes (a, k, opp) + (k, b, opp); the neighbour across
        // b→a, (b, a, other), becomes (b, k, other) + (k, a, other).
        const tri = [i0, i1, i2];
        const opp = tri[onEdge], a = tri[(onEdge + 1) % 3], b = tri[(onEdge + 2) % 3];
        tris.splice(t, 3, a, k, opp, k, b, opp);
        for (let u = 0; u < tris.length; u += 3) {
          const nb = [tris[u], tris[u + 1], tris[u + 2]];
          const ib = nb.indexOf(b), ia = nb.indexOf(a);
          if (ia < 0 || ib < 0 || nb.includes(k) || (ib + 1) % 3 !== ia) continue;
          const other = nb[3 - ia - ib];
          tris.splice(u, 3, b, k, other, k, a, other);
          break;
        }
      }
      placed = true;
    }
    if (!placed) throw new Error(`Interior point ${k - n + 1} lies outside the outline.`);
  }
  // Lawson flips toward a Delaunay triangulation; outline edges are never flipped.
  const isHullEdge = (a: number, b: number) => a < n && b < n && (Math.abs(a - b) === 1 || Math.abs(a - b) === n - 1);
  for (let pass = 0; pass < 100; pass++) {
    let flipped = false;
    for (let t = 0; t < tris.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = tris[t + e], b = tris[t + ((e + 1) % 3)], c = tris[t + ((e + 2) % 3)];
        if (isHullEdge(a, b)) continue;
        for (let u = 0; u < tris.length; u += 3) {
          if (u === t) continue;
          const tri = [tris[u], tris[u + 1], tris[u + 2]];
          const ib = tri.indexOf(b), ia = tri.indexOf(a);
          if (ia < 0 || ib < 0 || (ib + 1) % 3 !== ia) continue;
          const d = tri[3 - ia - ib];
          if (!inCircle(pts[a], pts[b], pts[c], pts[d])) break;
          // Flip only when the quad a-d-b-c is convex (both new triangles positive).
          if (cross(pts[c], pts[a], pts[d]) <= 1e-9 || cross(pts[d], pts[b], pts[c]) <= 1e-9) break;
          tris.splice(t, 3, c, a, d);
          tris.splice(u, 3, d, b, c);
          flipped = true;
          break;
        }
      }
    }
    if (!flipped) break;
  }
  for (let t = 0; t < tris.length; t += 3) {
    if (cross(pts[tris[t]], pts[tris[t + 1]], pts[tris[t + 2]]) / 2 < MIN_TRIANGLE_AREA) throw new Error('Triangulation produced a degenerate triangle (collinear points).');
  }
  return { points, triangles: tris, hull: n };
}

/** Outline points around the image rectangle plus a cols×rows interior grid (bendy limbs). */
export function gridPoints(width: number, height: number, cols: number, rows: number): { hull: number[]; interior: number[] } {
  const hull: number[] = [];
  for (let i = 0; i < cols; i++) hull.push((i * width) / cols, 0);
  for (let j = 0; j < rows; j++) hull.push(width, (j * height) / rows);
  for (let i = cols; i > 0; i--) hull.push((i * width) / cols, height);
  for (let j = rows; j > 0; j--) hull.push(0, (j * height) / rows);
  const interior: number[] = [];
  for (let j = 1; j < rows; j++) for (let i = 1; i < cols; i++) interior.push((i * width) / cols, (j * height) / rows);
  return { hull, interior };
}

// ---- Weights -----------------------------------------------------------------------

/** Below this a weight is dropped. */
export const MIN_WEIGHT = 1e-4;

/** Drops tiny/negative weights and rescales the rest to sum to exactly 1 (null if none remain). */
export function normalizeWeights(list: VertexWeights): VertexWeights | null {
  const merged = new Map<string, number>();
  for (const { bone, w } of list) if (w > 0) merged.set(bone, (merged.get(bone) ?? 0) + w);
  let kept = [...merged].filter(([, w]) => w >= MIN_WEIGHT);
  const sum = kept.reduce((s, [, w]) => s + w, 0);
  if (!kept.length || sum <= 0) return null;
  kept = kept.sort((a, b) => b[1] - a[1]);
  const out = kept.map(([bone, w]) => ({ bone, w: w / sum }));
  // Exact sum: put the rounding residue on the largest influence.
  out[0].w = 1 - out.slice(1).reduce((s, x) => s + x.w, 0);
  return out;
}

export type PaintMode = 'add' | 'subtract' | 'replace';

/**
 * Paints `amount` (0..1) of `bone` onto one vertex. Other influences scale so the sum
 * stays 1. Subtracting from a vertex whose only influence is `bone` hands the removed
 * weight to `fallback` (the attachment's bone); when that is `bone` itself it is a no-op.
 */
export function paintVertex(list: VertexWeights, bone: string, amount: number, mode: PaintMode, fallback: string): VertexWeights {
  const cur = list.find((x) => x.bone === bone)?.w ?? 0;
  const target = Math.min(1, Math.max(0, mode === 'add' ? cur + amount : mode === 'subtract' ? cur - amount : amount));
  const others = list.filter((x) => x.bone !== bone);
  const otherSum = others.reduce((s, x) => s + x.w, 0);
  let next: VertexWeights;
  if (otherSum > 0) next = [...others.map((x) => ({ bone: x.bone, w: (x.w / otherSum) * (1 - target) })), { bone, w: target }];
  else if (target >= 1 || fallback === bone) next = [{ bone, w: 1 }];
  else next = [{ bone, w: target }, { bone: fallback, w: 1 - target }];
  return normalizeWeights(next) ?? list;
}

/** One-bone (rigid) weights for every vertex. */
export function bindAll(mesh: Mesh, bone: string): VertexWeights[] {
  return Array.from({ length: mesh.points.length / 2 }, () => [{ bone, w: 1 }]);
}

/** Setup-pose world positions of a mesh's vertices (no deform). */
export function setupVertices(project: Project, att: Attachment): V[] {
  const im = project.images.find((i) => i.id === att.imageId)!;
  const m = attachmentWorld(att, computeWorld(project.bones));
  const n = att.mesh!.points.length / 2;
  return Array.from({ length: n }, (_, i) => apply(m, localVertex(att.mesh!.points, i, im)));
}

/**
 * Automatic weights: inverse-square distance (setup pose) from each vertex to each
 * chosen bone's segment, keeping the `maxInfluences` strongest, normalized. Weights are
 * taken relative to the strongest influence before normalizing, so the nearest bone
 * always survives the MIN_WEIGHT cut however far the vertex is from every bone (an
 * absolute 1/d² fell under MIN_WEIGHT beyond 100 px and left the vertex unweighted).
 */
export function autoWeights(project: Project, att: Attachment, boneIds: readonly string[], maxInfluences = 2): VertexWeights[] {
  if (!boneIds.length) throw new Error('Auto weights needs at least one bone.');
  const world = computeWorld(project.bones);
  const segs = boneIds.map((id) => {
    const b = project.bones.find((x) => x.id === id)!;
    const m = world.get(id)!;
    return { id, a: apply(m, { x: 0, y: 0 }), b: apply(m, { x: Math.max(b.length, 1e-3), y: 0 }) };
  });
  return setupVertices(project, att).map((v) => {
    const ws = segs.map((s) => ({ bone: s.id, w: 1 / Math.max(1, distToSegment(v, s.a, s.b)) ** 2 }));
    ws.sort((x, y) => y.w - x.w);
    const top = ws[0].w;
    return normalizeWeights(ws.slice(0, maxInfluences).map((x) => ({ bone: x.bone, w: x.w / top }))) ?? [{ bone: ws[0].bone, w: 1 }];
  });
}

// ---- Deform ------------------------------------------------------------------------

/**
 * Linear part of the map from a vertex's image-space offset to its world position
 * (current pose). Inverting it turns a world drag into a deform/point offset.
 */
export function vertexJacobian(att: Attachment, i: number, world: ReadonlyMap<string, Mat>, setupWorld: ReadonlyMap<string, Mat>): Mat {
  const mesh = att.mesh!;
  if (!mesh.weights) return { ...attachmentWorld(att, world), tx: 0, ty: 0 };
  const rest = attachmentWorld(att, setupWorld);
  let a = 0, b = 0, c = 0, d = 0;
  for (const inf of mesh.weights[i]) {
    const now = world.get(inf.bone), bind = setupWorld.get(inf.bone);
    const s = now && bind ? multiply(now, invert(bind)) : { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    const m = multiply(s, rest);
    a += m.a * inf.w;
    b += m.b * inf.w;
    c += m.c * inf.w;
    d += m.d * inf.w;
  }
  return { a, b, c, d, tx: 0, ty: 0 };
}

/** World-space delta → image-space offset for vertex i (null when the map is singular). */
export function worldDeltaToLocal(j: Mat, dx: number, dy: number): V | null {
  const det = j.a * j.d - j.b * j.c;
  if (Math.abs(det) < 1e-12) return null;
  return { x: (j.d * dx - j.c * dy) / det, y: (-j.b * dx + j.a * dy) / det };
}

/** Deform offsets of an attachment at time t (zeros when unkeyed). */
export function deformAt(anim: Animation | null, att: Attachment, t: number): number[] {
  const zeros = new Array(att.mesh!.points.length).fill(0);
  const keys = anim?.slots?.[att.id]?.deform;
  return keys?.length ? sampleKeys(keys, t, zeros).slice() : zeros;
}

/** Writes (or replaces) a deform key at `time`. */
export function keyDeform(anim: Animation, attId: string, time: number, offsets: readonly number[]): void {
  anim.slots ??= {};
  const st = (anim.slots[attId] ??= {});
  const keys = (st.deform ??= []);
  const k: Key = { time, value: offsets.map((v) => Math.round(v * 1000) / 1000), interp: 'linear' };
  const i = keys.findIndex((x) => Math.abs(x.time - time) < 1e-6);
  if (i >= 0) keys[i] = { ...keys[i], value: k.value };
  else {
    keys.push(k);
    keys.sort((x, y) => x.time - y.time);
  }
}

// ---- Mesh-level edits ----------------------------------------------------------------

/** Replaces an attachment's mesh (weights and deform keys of the old mesh are dropped). */
export function setMesh(project: Project, attId: string, mesh: Mesh | null): void {
  const att = project.attachments.find((a) => a.id === attId);
  if (!att) return;
  if (mesh) att.mesh = mesh;
  else delete att.mesh;
  for (const an of project.animations) {
    const st = an.slots?.[attId];
    if (st?.deform) delete st.deform;
  }
}

/** Changes an attachment's setup image; a mesh keeps its shape relative to the image (points rescale). */
export function setAttachmentImage(project: Project, att: Attachment, imageId: string): void {
  const from = project.images.find((i) => i.id === att.imageId);
  const to = project.images.find((i) => i.id === imageId);
  att.imageId = imageId;
  if (!att.mesh || !from || !to || (from.width === to.width && from.height === to.height)) return;
  const sx = to.width / from.width, sy = to.height / from.height;
  att.mesh.points = att.mesh.points.map((v, i) => (i % 2 ? v * sy : v * sx));
  for (const an of project.animations) {
    const keys = an.slots?.[att.id]?.deform;
    if (keys) for (const k of keys) k.value = k.value.map((v, i) => (i % 2 ? v * sy : v * sx));
  }
}

/** Moves a mesh vertex in the setup pose (position and texture coordinate together), clamped to the image. */
export function moveMeshPoint(project: Project, att: Attachment, i: number, x: number, y: number): void {
  const im = project.images.find((m) => m.id === att.imageId);
  if (!att.mesh || !im) return;
  att.mesh.points[2 * i] = Math.min(im.width, Math.max(0, x));
  att.mesh.points[2 * i + 1] = Math.min(im.height, Math.max(0, y));
}

/** Summary used by the inspector: "N vertices · M triangles · rigid | weighted (K bones)". */
export function meshSummary(mesh: Mesh): string {
  const n = mesh.points.length / 2, m = mesh.triangles.length / 3;
  if (!mesh.weights) return `${n} vertices · ${m} triangles · rigid`;
  const bones = new Set(mesh.weights.flatMap((w) => w.map((x) => x.bone)));
  return `${n} vertices · ${m} triangles · weighted (${bones.size} bone${bones.size === 1 ? '' : 's'})`;
}
