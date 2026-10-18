// The independent IK / path / mix reference (tests/support/reference-constraints.ts),
// checked on its own terms against forward kinematics and closed-form values — not
// against src/ (post-review FR-003).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { M } from '../support/reference-composite.ts';
import { worldsFromLocal } from '../support/reference-composite.ts';
import { arcTable, constrainedWorlds, keyedLocal, mixFrame, pathAt, pathSegs, solveIkRef } from '../support/reference-constraints.ts';

const bone = (id: string, parentId: string | null, x: number, y: number, rotation: number, length = 0, scaleX = 1, scaleY = 1) => ({ id, name: id, parentId, x, y, rotation, scaleX, scaleY, length });

/** Shoulder (upper) under a parent with the given scale; elbow at 50, forearm 40. */
function arm(parentScale: [number, number], target: [number, number], bendPositive: boolean) {
  return {
    bones: [bone('root', null, 10, 20, 30, 0, ...parentScale), bone('upper', 'root', 5, 0, 0, 50), bone('lower', 'upper', 50, 0, 0, 40), bone('t', null, ...target, 0)],
    ik: [{ id: 'ik', name: 'ik', bones: ['upper', 'lower'], target: 't', mix: 1, bendPositive }],
    attachments: [],
    paths: [],
    pathConstraints: [],
  };
}
const tip = (w: Map<string, M>) => { const m = w.get('lower')!; return [m[0] * 40 + m[4], m[1] * 40 + m[5]]; };

describe('reference two-bone IK (circle intersection)', () => {
  test('reaches a reachable target on both bend sides, under a non-uniform parent', () => {
    for (const ps of [[1, 1], [1.5, 0.7], [-1, 1]] as [number, number][]) {
      const sides: number[] = [];
      for (const bend of [true, false]) {
        const p = arm(ps, [60, 70], bend);
        const w = constrainedWorlds(p, null, 0);
        const [x, y] = tip(w);
        assert.ok(Math.hypot(x - 60, y - 70) < 1e-9, `parent scale ${ps} bend ${bend}: tip (${x}, ${y})`);
        // Side in the parent's local space: cross(shoulder→target, shoulder→elbow).
        const inv = (m: number[]) => { const d = m[0] * m[3] - m[1] * m[2]; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]; };
        const pi = inv(w.get('root')!);
        const loc = (x0: number, y0: number) => [pi[0] * x0 + pi[2] * y0 + pi[4], pi[1] * x0 + pi[3] * y0 + pi[5]];
        const [sx, sy] = loc(w.get('upper')![4], w.get('upper')![5]), [ex, ey] = loc(w.get('lower')![4], w.get('lower')![5]), [tx, ty] = loc(60, 70);
        sides.push((tx - sx) * (ey - sy) - (ty - sy) * (ex - sx));
      }
      assert.ok(sides[0] > 0 && sides[1] < 0, `bendPositive → positive cross in parent space (${sides})`);
    }
  });

  test('straightens toward an unreachable target and folds for a too-near one', () => {
    const far = constrainedWorlds(arm([1, 1], [400, 300], true), null, 0);
    const [fx, fy] = tip(far), s = far.get('upper')!;
    const dir = Math.atan2(300 - s[5], 400 - s[4]);
    assert.ok(Math.abs(Math.atan2(fy - s[5], fx - s[4]) - dir) < 1e-9 && Math.abs(Math.hypot(fx - s[4], fy - s[5]) - 90) < 1e-9, 'straight, full reach');
    const near = constrainedWorlds(arm([1, 1], [20, 30], true), null, 0);
    const [nx, ny] = tip(near), n = near.get('upper')!;
    assert.ok(Math.abs(Math.hypot(nx - n[4], ny - n[5]) - 10) < 1e-9, 'folded: |50 − 40|');
  });

  test('a target on the shoulder keeps the keyed pose; mix 0.5 is halfway in local rotation', () => {
    const p = arm([1, 1], [0, 0], true);
    const shoulder = worldsFromLocal(p, keyedLocal(p, null, 0)).get('upper')!;
    p.bones[3].x = shoulder[4];
    p.bones[3].y = shoulder[5];
    const pose = keyedLocal(p, null, 0);
    solveIkRef(p, pose, p.ik[0], 1);
    assert.equal(pose.get('upper')!.rotation, 0);
    const q = arm([1, 1], [60, 70], true), full = keyedLocal(q, null, 0), half = keyedLocal(q, null, 0);
    solveIkRef(q, full, q.ik[0], 1);
    solveIkRef(q, half, q.ik[0], 0.5);
    assert.ok(Math.abs(half.get('upper')!.rotation - full.get('upper')!.rotation / 2) < 1e-9);
  });

  test('a non-uniform bone-1 scale is refused rather than guessed', () => {
    const p = arm([1, 1], [60, 70], true);
    p.bones[1].scaleY = 2;
    assert.throws(() => constrainedWorlds(p, null, 0), /uniform bone-1 scale/);
  });
});

describe('reference path table', () => {
  const line = { closed: false, nodes: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 10, outY: 0 }, { x: 30, y: 0, inX: -10, inY: 0, outX: 0, outY: 0 }] };
  test('a straight cubic has its exact length; positions clamp on an open path', () => {
    const segs = pathSegs(line, [1, 0, 0, 1, 0, 0]), table = arcTable(segs);
    assert.ok(Math.abs(table.length - 30) < 1e-9);
    assert.deepEqual([pathAt(segs, table, false, -5).x, pathAt(segs, table, false, 99).x], [0, 30]);
    assert.ok(Math.abs(pathAt(segs, table, false, 12).x - 12) < 1e-6 && pathAt(segs, table, false, 12).tangent === 0);
  });
  test('a closed path wraps', () => {
    const sq = { closed: true, nodes: [[0, 0], [20, 0], [20, 20], [0, 20]].map(([x, y]) => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 })) };
    const segs = pathSegs(sq, [1, 0, 0, 1, 0, 0]), table = arcTable(segs);
    assert.ok(Math.abs(table.length - 80) < 1e-9);
    const a = pathAt(segs, table, true, 85), b = pathAt(segs, table, true, 5);
    assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9);
  });
});

describe('reference mixing', () => {
  const p: any = {
    bones: [bone('b', null, 0, 0, 0)],
    attachments: [{ id: 'att', opacity: 1 }],
    animations: [],
  };
  const key = (time: number, value: number[]) => ({ time, value, interp: 'linear' });
  const A = { duration: 1, loop: true, tracks: { b: { rotate: [key(0, [170])], translate: [key(0, [10, 0])] } }, slots: { att: { opacity: [key(0, [0.2])] } } };
  const B = { duration: 0.5, loop: false, tracks: { b: { rotate: [key(0, [-170])] } } };
  const plan = [{ anim: A, start: 0, mix: 0 }, { anim: B, start: 0.5, mix: 0.4 }];
  test('rotation blends the shortest way; unkeyed channels blend to setup; discrete state flips at w = 0.5', () => {
    const m = mixFrame(p, plan, 0.7, 'setup'); // w ≈ 0.5
    const r = (Math.atan2(m.worlds.get('b')![1], m.worlds.get('b')![0]) * 180) / Math.PI;
    assert.ok(Math.abs(Math.abs(r) - 180) < 1e-6, `170 → −170 through 180 (${r})`);
    assert.ok(Math.abs(m.worlds.get('b')![4] - 5) < 1e-9, 'translate halfway to setup');
    assert.ok(Math.abs(m.opacity.get('att')! - 0.6) < 1e-9, 'opacity halfway to setup');
    // (0.7 − 0.5) / 0.4 rounds just below 0.5 in binary floating point: probe either side.
    assert.equal(mixFrame(p, plan, 0.71, 'setup').discrete.anim, B);
    assert.equal(mixFrame(p, plan, 0.69, 'setup').discrete.anim, A);
    assert.ok(Math.abs(mixFrame(p, plan, 0.7, 'hold').worlds.get('b')![4] - 10) < 1e-9, "'hold' keeps the outgoing translate");
  });
});
