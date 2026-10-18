import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, fromTRS, invert, multiply } from '../../src/model/math.ts';
import {
  attachmentWorld,
  boneTip,
  computeWorld,
  CycleError,
  deleteBone,
  findCycles,
  localFromWorld,
  reparentBone,
  toLocal,
  topoOrder,
  wouldCreateCycle,
} from '../../src/model/skeleton.ts';
import type { Bone, Project } from '../../src/model/types.ts';
import { emptyProject } from '../../src/model/types.ts';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

function b(id: string, parentId: string | null, x: number, y: number, rotation: number, sx = 1, sy = 1, length = 10): Bone {
  return { id, name: id, parentId, x, y, rotation, scaleX: sx, scaleY: sy, length, color: '#fff' };
}

test('matrix multiply composes parent then child; invert round-trips', () => {
  const m = fromTRS(10, 5, 30, 2, 0.5);
  const n = fromTRS(-3, 7, -70, 1.5, 3);
  const p = { x: 4, y: -9 };
  const viaCompose = apply(multiply(m, n), p);
  const stepwise = apply(m, apply(n, p));
  close(viaCompose.x, stepwise.x);
  close(viaCompose.y, stepwise.y);
  const back = apply(invert(multiply(m, n)), viaCompose);
  close(back.x, p.x);
  close(back.y, p.y);
});

test('world transform composes through a 3-bone chain', () => {
  // root at (100,50) rotated 90° (pointing down on screen), child 20 along its x, grandchild 10 further.
  const bones = [b('root', null, 100, 50, 90, 1, 1, 20), b('mid', 'root', 20, 0, 0, 1, 1, 10), b('tip', 'mid', 10, 0, -90, 1, 1, 5)];
  const w = computeWorld(bones);
  const mid = w.get('mid')!;
  close(mid.tx, 100);
  close(mid.ty, 70);
  const tip = w.get('tip')!;
  close(tip.tx, 100);
  close(tip.ty, 80);
  // tip rotated -90 relative to a 90° parent → world angle 0 → its own tip lies to the right.
  const end = boneTip(bones[2], tip);
  close(end.x, 105);
  close(end.y, 80);
});

test('child inherits parent scale and rotation (non-uniform scale)', () => {
  const bones = [b('p', null, 0, 0, 0, 2, 3), b('c', 'p', 5, 4, 0)];
  const c = computeWorld(bones).get('c')!;
  close(c.tx, 10);
  close(c.ty, 12);
  close(c.a, 2);
  close(c.d, 3);
});

test('children listed before parents still compose correctly', () => {
  const bones = [b('c', 'p', 10, 0, 0), b('p', null, 1, 2, 90)];
  assert.deepEqual(topoOrder(bones).map((x) => x.id), ['p', 'c']);
  const c = computeWorld(bones).get('c')!;
  close(c.tx, 1);
  close(c.ty, 12);
});

test('animated pose override replaces setup values', () => {
  const bones = [b('p', null, 0, 0, 0), b('c', 'p', 10, 0, 0)];
  const pose = new Map([['p', { x: 0, y: 0, rotation: 90, scaleX: 1, scaleY: 1 }]]);
  const c = computeWorld(bones, pose).get('c')!;
  close(c.tx, 0);
  close(c.ty, 10);
});

test('posing under a rotated, scaled parent: world→local lands on the cursor', () => {
  const bones = [b('p', null, 40, -20, 37, 1.7, 0.6), b('c', 'p', 3, 3, 0)];
  const parent = computeWorld(bones).get('p')!;
  const cursor = { x: 123.4, y: 56.7 };
  const local = toLocal(parent, cursor);
  bones[1].x = local.x;
  bones[1].y = local.y;
  const c = computeWorld(bones).get('c')!;
  close(c.tx, cursor.x);
  close(c.ty, cursor.y);
});

test('localFromWorld reproduces a target world transform under a rotated parent', () => {
  const parent = fromTRS(5, 6, 50, 2, 2);
  const target = fromTRS(-10, 30, -20, 1, 1);
  const local = localFromWorld(parent, target);
  const rebuilt = multiply(parent, fromTRS(local.x, local.y, local.rotation, local.scaleX, local.scaleY));
  for (const k of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) close(rebuilt[k], target[k]);
});

test('attachment world follows its bone', () => {
  const bones = [b('p', null, 10, 10, 90)];
  const w = computeWorld(bones);
  const a = attachmentWorld({ id: 'a', name: 'a', boneId: 'p', imageId: 'i', x: 5, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 }, w);
  close(a.tx, 10);
  close(a.ty, 15);
});

test('cycle prevention: cannot parent a bone under itself or a descendant', () => {
  const bones = [b('a', null, 0, 0, 0), b('b', 'a', 0, 0, 0), b('c', 'b', 0, 0, 0), b('d', null, 0, 0, 0)];
  assert.equal(wouldCreateCycle(bones, 'a', 'a'), true);
  assert.equal(wouldCreateCycle(bones, 'a', 'c'), true);
  assert.equal(wouldCreateCycle(bones, 'b', 'c'), true);
  assert.equal(wouldCreateCycle(bones, 'c', 'a'), false);
  assert.equal(wouldCreateCycle(bones, 'a', 'd'), false);
  assert.equal(wouldCreateCycle(bones, 'a', null), false);

  const project: Project = { ...emptyProject(), bones };
  assert.throws(() => reparentBone(project, 'a', 'c'), CycleError);
  assert.equal(project.bones[0].parentId, null, 'failed reparent leaves hierarchy unchanged');
});

test('findCycles detects corrupt hierarchies and topoOrder skips them', () => {
  const bones = [b('x', 'y', 0, 0, 0), b('y', 'x', 0, 0, 0), b('ok', null, 0, 0, 0)];
  assert.deepEqual(findCycles(bones).sort(), ['x', 'y']);
  assert.deepEqual(topoOrder(bones).map((x) => x.id), ['ok']);
  assert.equal(computeWorld(bones).size, 1);
});

test('reparent with keepWorld preserves the setup-pose world placement', () => {
  const bones = [b('a', null, 50, 0, 45), b('b', null, -20, 30, 10), b('c', 'a', 10, 0, 0)];
  const project: Project = { ...emptyProject(), bones };
  const before = computeWorld(project.bones).get('c')!;
  reparentBone(project, 'c', 'b');
  assert.equal(project.bones[2].parentId, 'b');
  const after = computeWorld(project.bones).get('c')!;
  for (const k of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) close(after[k], before[k]);
});

test('deleteBone moves children and attachments to the grandparent without visual jumps', () => {
  const bones = [b('a', null, 0, 0, 30), b('b', 'a', 10, 0, 20), b('c', 'b', 10, 0, 0)];
  const project: Project = {
    ...emptyProject(),
    bones,
    attachments: [{ id: 'att', name: 'att', boneId: 'b', imageId: 'i', x: 2, y: 3, rotation: 5, scaleX: 1, scaleY: 1, opacity: 1 }],
    animations: [{ id: 'an', name: 'an', duration: 1, fps: 30, loop: true, tracks: { b: { translate: [], rotate: [], scale: [] } } }],
  };
  const w0 = computeWorld(project.bones);
  const cBefore = w0.get('c')!;
  const attBefore = attachmentWorld(project.attachments[0], w0);
  deleteBone(project, 'b');
  assert.deepEqual(project.bones.map((x) => x.id), ['a', 'c']);
  assert.equal(project.bones[1].parentId, 'a');
  assert.equal(project.attachments[0].boneId, 'a');
  assert.equal(project.animations[0].tracks.b, undefined);
  const w1 = computeWorld(project.bones);
  const cAfter = w1.get('c')!;
  close(cAfter.tx, cBefore.tx);
  close(cAfter.ty, cBefore.ty);
  const attAfter = attachmentWorld(project.attachments[0], w1);
  close(attAfter.tx, attBefore.tx);
  close(attAfter.ty, attBefore.ty);
});
