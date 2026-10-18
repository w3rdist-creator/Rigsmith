import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { evaluate } from '../../src/model/evaluate.ts';
import { exportRuntime } from '../../src/model/exportRuntime.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { repairReferences } from '../../src/model/integrity.ts';
import { computeWorld } from '../../src/model/skeleton.ts';
import { meshWorldVertices } from '../../src/model/mesh.ts';
import {
  autoWeights, bindAll, deformAt, gridPoints, keyDeform, meshProblem, normalizeWeights, paintVertex,
  setAttachmentImage, setMesh, triangulate, vertexJacobian, worldDeltaToLocal,
} from '../../src/model/meshOps.ts';
import { deleteBone } from '../../src/model/skeleton.ts';
import type { Mesh, Project } from '../../src/model/types.ts';
import { meshUnfolded } from '../../src/render/draw.ts';

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/legacy-v1.rig.json');
function load(text: string): Project {
  const r = parseProject(text);
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return (r as { project: Project }).project;
}
const legacy = () => load(readFileSync(FIXTURE, 'utf8'));

function area(points: readonly number[], t: readonly number[], k: number): number {
  const [a, b, c] = [t[k], t[k + 1], t[k + 2]];
  return ((points[2 * b] - points[2 * a]) * (points[2 * c + 1] - points[2 * a + 1]) - (points[2 * c] - points[2 * a]) * (points[2 * b + 1] - points[2 * a + 1])) / 2;
}
function polyArea(flat: readonly number[]): number {
  let s = 0;
  const n = flat.length / 2;
  for (let i = 0; i < n; i++) s += flat[2 * i] * flat[2 * ((i + 1) % n) + 1] - flat[2 * ((i + 1) % n)] * flat[2 * i + 1];
  return Math.abs(s) / 2;
}
function checkMesh(m: Mesh, hull: readonly number[], interior: readonly number[]) {
  const n = hull.length / 2, k = interior.length / 2;
  assert.deepEqual(m.points, [...hull, ...interior], 'outline vertices first, then interior');
  assert.equal(m.hull, n);
  assert.equal(m.triangles.length / 3, n - 2 + 2 * k, 'Euler count for a simple polygon');
  let sum = 0;
  for (let t = 0; t < m.triangles.length; t += 3) {
    const a = area(m.points, m.triangles, t);
    assert.ok(a > 1e-3, `triangle ${t / 3} positive and non-degenerate (${a})`);
    sum += a;
  }
  assert.ok(Math.abs(sum - polyArea(hull)) < 1e-6, `triangles tile the outline (${sum} vs ${polyArea(hull)})`);
  // Every interior edge is shared by exactly two triangles, outline edges by one.
  const edges = new Map<string, number>();
  for (let t = 0; t < m.triangles.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = m.triangles[t + e], b = m.triangles[t + ((e + 1) % 3)];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  for (let i = 0; i < n; i++) {
    const a = i, b = (i + 1) % n;
    assert.equal(edges.get(a < b ? `${a}-${b}` : `${b}-${a}`), 1, `outline edge ${a}-${b} kept`);
  }
  assert.ok([...edges.values()].every((c) => c === 1 || c === 2), 'manifold');
}

describe('triangulation', () => {
  it('convex, concave (L), collinear outline points, interior points and a point on an internal edge', () => {
    const square = [0, 0, 10, 0, 10, 10, 0, 10];
    checkMesh(triangulate(square), square, []);
    const L = [0, 0, 30, 0, 30, 10, 10, 10, 10, 30, 0, 30];
    const mL = triangulate(L);
    checkMesh(mL, L, []);
    // No triangle of the L lies in the notch (centroids inside the outline).
    for (let t = 0; t < mL.triangles.length; t += 3) {
      const cx = (mL.points[2 * mL.triangles[t]] + mL.points[2 * mL.triangles[t + 1]] + mL.points[2 * mL.triangles[t + 2]]) / 3;
      const cy = (mL.points[2 * mL.triangles[t] + 1] + mL.points[2 * mL.triangles[t + 1] + 1] + mL.points[2 * mL.triangles[t + 2] + 1]) / 3;
      assert.ok(!(cx > 10 && cy > 10), 'not in the notch');
    }
    const g = gridPoints(120, 40, 6, 2);
    checkMesh(triangulate(g.hull, g.interior), g.hull, g.interior);
    // Centre of the square lies on the first ear's diagonal → edge split path.
    checkMesh(triangulate(square, [5, 5]), square, [5, 5]);
    // Counter-clockwise input works too.
    const ccw = [0, 0, 0, 10, 10, 10, 10, 0];
    checkMesh(triangulate(ccw, [3, 4]), ccw, [3, 4]);
  });

  it('flips toward Delaunay: no interior edge has the opposite vertex inside its circumcircle', () => {
    const hull = [0, 0, 40, 0, 41, 5, 40, 10, 0, 10, -1, 5];
    const m = triangulate(hull, [10, 5, 20, 4, 30, 6]);
    const P = (i: number) => ({ x: m.points[2 * i], y: m.points[2 * i + 1] });
    const tri = (t: number) => [m.triangles[t], m.triangles[t + 1], m.triangles[t + 2]];
    for (let t = 0; t < m.triangles.length; t += 3)
      for (let u = 0; u < m.triangles.length; u += 3) {
        if (t === u) continue;
        const A = tri(t), B = tri(u);
        const shared = A.filter((x) => B.includes(x));
        if (shared.length !== 2) continue;
        const d = B.find((x) => !shared.includes(x))!;
        const [a, b, c] = A.map(P), q = P(d);
        const ax = a.x - q.x, ay = a.y - q.y, bx = b.x - q.x, by = b.y - q.y, cx = c.x - q.x, cy = c.y - q.y;
        const det = (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
        assert.ok(det <= 1e-6, `edge ${shared} locally Delaunay (${det})`);
      }
  });

  it('rejects bad outlines with a clear message', () => {
    const dims = { width: 100, height: 100 };
    assert.match(meshProblem([0, 0, 10, 0], [], dims)!, /at least 3/);
    assert.match(meshProblem([0, 0, 10, 0, 10.2, 0.1, 0, 10], [], dims)!, /duplicates/);
    assert.match(meshProblem([0, 0, 10, 10, 10, 0, 0, 10], [], dims)!, /crosses itself/);
    assert.match(meshProblem([0, 0, 10, 0, 20, 0], [], dims)!, /no area/);
    assert.match(meshProblem([0, 0, 10, 0, 10, 10, 0, 10], [20, 20], dims)!, /outside the outline/);
    assert.match(meshProblem([0, 0, 10, 0, 10, 10, 0, 10], [5, 0.2], dims)!, /on the outline/);
    assert.match(meshProblem([0, 0, 110, 0, 10, 10], [], dims)!, /outside the image/);
    assert.equal(meshProblem([0, 0, 10, 0, 10, 10, 0, 10], [5, 5], dims), null);
  });
});

describe('weights', () => {
  it('normalize: merges duplicates, drops tiny/negative, sums to exactly 1', () => {
    const w = normalizeWeights([{ bone: 'a', w: 0.3 }, { bone: 'b', w: 0.6 }, { bone: 'a', w: 0.3 }, { bone: 'c', w: 1e-6 }, { bone: 'd', w: -1 }])!;
    assert.deepEqual(w.map((x) => x.bone), ['a', 'b']);
    assert.equal(w.reduce((s, x) => s + x.w, 0), 1);
    assert.equal(normalizeWeights([{ bone: 'a', w: 0 }]), null);
  });

  it('paint add / subtract / replace keeps the sum at 1; subtracting the only influence hands it to the fallback', () => {
    const sum = (l: { w: number }[]) => l.reduce((s, x) => s + x.w, 0);
    let l = paintVertex([{ bone: 'a', w: 1 }], 'b', 0.25, 'add', 'a');
    assert.deepEqual(l, [{ bone: 'a', w: 0.75 }, { bone: 'b', w: 0.25 }]);
    l = paintVertex(l, 'b', 0.1, 'subtract', 'a');
    assert.ok(Math.abs(l.find((x) => x.bone === 'b')!.w - 0.15) < 1e-12 && Math.abs(sum(l) - 1) < 1e-15);
    l = paintVertex(l, 'b', 1, 'replace', 'a');
    assert.deepEqual(l, [{ bone: 'b', w: 1 }]);
    l = paintVertex(l, 'b', 0.4, 'subtract', 'a');
    assert.deepEqual(l, [{ bone: 'b', w: 0.6 }, { bone: 'a', w: 0.4 }].sort((x, y) => y.w - x.w));
    assert.deepEqual(paintVertex([{ bone: 'a', w: 1 }], 'a', 0.5, 'subtract', 'a'), [{ bone: 'a', w: 1 }], 'no-op: nothing to hand it to');
    for (let i = 0; i < 200; i++) l = paintVertex(l, i % 3 ? 'a' : 'c', 0.037, i % 2 ? 'add' : 'subtract', 'b');
    assert.ok(Math.abs(sum(l) - 1) < 1e-12, `no drift after 200 strokes (${sum(l)})`);
  });

  it('auto weights follow bone distance; bindAll makes one rigid influence', () => {
    const p = legacy();
    const att = p.attachments.find((a) => a.name === 'torso')!;
    const im = p.images.find((i) => i.id === att.imageId)!;
    const g = gridPoints(im.width, im.height, 2, 4);
    att.mesh = triangulate(g.hull, g.interior);
    const w = autoWeights(p, att, ['b_torso', 'b_head']);
    assert.equal(w.length, att.mesh.points.length / 2);
    assert.ok(w.every((l) => Math.abs(l.reduce((s, x) => s + x.w, 0) - 1) < 1e-12 && l.length <= 2));
    assert.ok(w.some((l) => l[0].bone === 'b_torso') && w.some((l) => l[0].bone === 'b_head'), 'both bones dominate somewhere');
    assert.deepEqual(bindAll(att.mesh, 'b_root')[0], [{ bone: 'b_root', w: 1 }]);
  });
});

function meshedLegacy(): { p: Project; attId: string } {
  const p = legacy();
  p.version = 2;
  const att = p.attachments.find((a) => a.name === 'torso')!;
  const im = p.images.find((i) => i.id === att.imageId)!;
  const g = gridPoints(im.width, im.height, 2, 3);
  att.mesh = triangulate(g.hull, g.interior);
  att.mesh.weights = autoWeights(p, att, ['b_torso', 'b_head']);
  return { p, attId: att.id };
}

describe('deform and skinning', () => {
  it('the vertex Jacobian maps an image-space offset to the world motion of a skinned vertex', () => {
    const { p, attId } = meshedLegacy();
    const att = p.attachments.find((a) => a.id === attId)!;
    const im = p.images.find((i) => i.id === att.imageId)!;
    const anim = p.animations[0];
    const fr = evaluate(p, anim, 0.37);
    const setup = computeWorld(p.bones);
    const i = 4;
    const j = vertexJacobian(att, i, fr.world, setup);
    const base = meshWorldVertices(att, im, fr.world, setup);
    const d = new Array(att.mesh!.points.length).fill(0);
    d[2 * i] = 3;
    d[2 * i + 1] = -2;
    const moved = meshWorldVertices(att, im, fr.world, setup, d);
    const want = { x: j.a * 3 + j.c * -2, y: j.b * 3 + j.d * -2 };
    assert.ok(Math.abs(moved[2 * i] - base[2 * i] - want.x) < 1e-9 && Math.abs(moved[2 * i + 1] - base[2 * i + 1] - want.y) < 1e-9);
    const back = worldDeltaToLocal(j, want.x, want.y)!;
    assert.ok(Math.abs(back.x - 3) < 1e-9 && Math.abs(back.y + 2) < 1e-9, 'inverse recovers the offset');
    assert.equal(worldDeltaToLocal({ a: 1, b: 2, c: 2, d: 4, tx: 0, ty: 0 }, 1, 1), null, 'singular');
  });

  it('deform keys: write, replace at the same time, interpolate between', () => {
    const { p, attId } = meshedLegacy();
    const att = p.attachments.find((a) => a.id === attId)!;
    const anim = p.animations[0];
    const n = att.mesh!.points.length;
    keyDeform(anim, attId, 0, new Array(n).fill(0));
    keyDeform(anim, attId, 0.5, new Array(n).fill(4));
    keyDeform(anim, attId, 0.5, new Array(n).fill(8));
    assert.equal(anim.slots![attId].deform!.length, 2);
    assert.deepEqual(deformAt(anim, att, 0.25), new Array(n).fill(4));
    const back = load(serializeProject(p));
    assert.deepEqual(back.animations[0].slots![attId].deform, anim.slots![attId].deform, 'round trip');
  });

  it('a different-size image (image key) keeps the mesh geometry; uvs scale', () => {
    const { p, attId } = meshedLegacy();
    const att = p.attachments.find((a) => a.id === attId)!;
    const im = p.images.find((i) => i.id === att.imageId)!;
    const other = { ...im, id: 'img_big', name: 'big.png', width: im.width * 2, height: im.height * 2 };
    p.images.push(other);
    const anim = p.animations[0];
    const a = evaluate(p, anim, 0.1).attachments.find((f) => f.att.id === attId)!;
    anim.slots = { [attId]: { image: [{ time: 0, imageId: 'img_big' }] } };
    const b = evaluate(p, anim, 0.1).attachments.find((f) => f.att.id === attId)!;
    assert.deepEqual(b.vertices, a.vertices, 'geometry unchanged');
    assert.deepEqual(b.uvs, att.mesh!.points.map((v) => v * 2), 'uvs in the shown image');
  });
});

describe('mesh integrity and format', () => {
  it('deleting a weighted bone passes its weight to the parent; the project re-opens', () => {
    const { p, attId } = meshedLegacy();
    deleteBone(p, 'b_head');
    repairReferences(p);
    const w = p.attachments.find((a) => a.id === attId)!.mesh!.weights!;
    assert.ok(w.every((l) => l.every((x) => x.bone !== 'b_head') && Math.abs(l.reduce((s, x) => s + x.w, 0) - 1) < 1e-12));
    assert.ok(w.some((l) => l.some((x) => x.bone === 'b_torso' && x.w === 1)), 'merged into the parent');
    load(serializeProject(p));
  });

  it('a missing bone in weights is dropped and renormalized; empty lists go to the attachment bone', () => {
    const { p, attId } = meshedLegacy();
    const att = p.attachments.find((a) => a.id === attId)!;
    att.mesh!.weights![0] = [{ bone: 'gone', w: 1 }];
    att.mesh!.weights![1] = [{ bone: 'gone', w: 0.5 }, { bone: 'b_head', w: 0.5 }];
    const notes = repairReferences(p);
    assert.match(notes.join(' '), /2 vertex weight list/);
    assert.deepEqual(att.mesh!.weights![0], [{ bone: att.boneId, w: 1 }]);
    assert.deepEqual(att.mesh!.weights![1], [{ bone: 'b_head', w: 1 }]);
    load(serializeProject(p));
  });

  it('changing the setup image rescales the mesh (and its deform keys) so the file still validates', () => {
    const { p, attId } = meshedLegacy();
    const att = p.attachments.find((a) => a.id === attId)!;
    const im = p.images.find((i) => i.id === att.imageId)!;
    const small = p.images.find((i) => i.width < im.width && i.height < im.height)!;
    keyDeform(p.animations[0], attId, 0, new Array(att.mesh!.points.length).fill(2));
    const before = att.mesh!.points.slice();
    setAttachmentImage(p, att, small.id);
    assert.equal(att.mesh!.points[2], (before[2] * small.width) / im.width);
    assert.equal(p.animations[0].slots![attId].deform![0].value[0], (2 * small.width) / im.width);
    load(serializeProject(p));
  });

  it('re-authoring a mesh drops the old deform keys; removing it drops the mesh', () => {
    const { p, attId } = meshedLegacy();
    const att = p.attachments.find((a) => a.id === attId)!;
    keyDeform(p.animations[0], attId, 0, new Array(att.mesh!.points.length).fill(1));
    setMesh(p, attId, triangulate([0, 0, 10, 0, 10, 10]));
    assert.equal(p.animations[0].slots![attId].deform, undefined);
    setMesh(p, attId, null);
    assert.equal(att.mesh, undefined);
  });

  it('mesh v2 round trip is lossless; malformed meshes are rejected with a location', () => {
    const { p } = meshedLegacy();
    const text = serializeProject(p);
    assert.equal(serializeProject(load(text)), text);
    const o = JSON.parse(text);
    const i = o.attachments.findIndex((a: any) => a.mesh);
    const bad: [string, (m: any) => void, RegExp][] = [
      ['odd points', (m) => m.points.push(1), /at least 3 x,y pairs/],
      ['triangle index', (m) => (m.triangles[0] = 999), /index triples/],
      ['hull', (m) => (m.hull = 2), /hull must be/],
      ['weights length', (m) => m.weights.pop(), /one entry per vertex/],
      ['missing bone', (m) => (m.weights[0] = [{ bone: 'nope', w: 1 }]), /missing bone/],
      ['negative', (m) => (m.weights[0] = [{ bone: 'b_root', w: -1 }, { bone: 'b_root', w: 2 }]), /w ≥ 0/],
      ['outside image', (m) => (m.points[0] = -50), /outside the image/],
    ];
    for (const [name, mut, re] of bad) {
      const c = structuredClone(o);
      mut(c.attachments[i].mesh);
      const r = parseProject(JSON.stringify(c));
      assert.ok(!r.ok && r.errors.some((e) => re.test(e) && e.includes(`attachments[${i}].mesh`)), `${name}: ${r.ok ? 'accepted' : r.errors.join('; ')}`);
    }
  });

  it('runtime export carries mesh topology and per-frame vertices equal to the editor evaluation', () => {
    const { p, attId } = meshedLegacy();
    const att = p.attachments.find((a) => a.id === attId)!;
    keyDeform(p.animations[0], attId, 0.2, new Array(att.mesh!.points.length).fill(3));
    const rt = exportRuntime(p);
    const ra = rt.attachments.find((a) => a.name === att.name)!;
    const boneName = new Map(p.bones.map((b) => [b.id, b.name]));
    assert.deepEqual(ra.mesh, {
      uvs: att.mesh!.points,
      triangles: att.mesh!.triangles,
      hull: att.mesh!.hull,
      // v2: weights by bone name.
      weights: att.mesh!.weights!.map((l) => l.map((x) => ({ bone: boneName.get(x.bone)!, w: x.w }))),
    });
    const an = rt.animations[0];
    for (const f of [0, 7, 15]) {
      const want = evaluate(p, p.animations[0], f / p.animations[0].fps).attachments.find((x) => x.att.id === attId)!.vertices!;
      const got = an.bakedMeshes![att.name][f];
      assert.ok(got.every((v, k) => Math.abs(v - want[k]) <= 0.001), `frame ${f} vertices`);
    }
  });
});

describe('fold detection for the renderer', () => {
  const uvs = [0, 0, 10, 0, 10, 10, 0, 10];
  const tris = [0, 1, 2, 0, 2, 3];
  it('a whole-mesh mirror is not a fold; a vertex dragged across is', () => {
    assert.equal(meshUnfolded(uvs, tris, uvs), true);
    assert.equal(meshUnfolded(uvs, tris, uvs.map((v, i) => (i % 2 ? v : -v))), true, 'mirrored');
    assert.equal(meshUnfolded(uvs, tris, [0, 0, 10, 0, -5, 12, 0, 10]), false, 'vertex 2 crossed the diagonal');
    assert.equal(meshUnfolded(uvs, tris, [0, 0, 10, 0, 10, 10, 10, 10]), true, 'degenerate triangles are ignored');
  });
});
