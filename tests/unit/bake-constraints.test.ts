// R14: bakeConstraints writes the solved local pose of every constrained bone as one key
// per frame and removes the constraints; the motion is unchanged at whole frames, and an
// IK rig inside the Lottie subset then exports.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluate } from '../../src/model/evaluate.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { exportLottie } from '../../src/model/lottie.ts';
import { addIk, addSpring, bakeConstraints } from '../../src/model/rigOps.ts';
import { lottieProject } from '../support/lottie-fixture.ts';
import { richProject } from '../support/runtime-fixture.ts';

const worlds = (p: any, a: any, f: number) => [...evaluate(p, a, Math.min(a.duration, f / a.fps)).world].map(([id, m]) => [id, m.a, m.b, m.c, m.d, m.tx, m.ty] as const);

describe('bakeConstraints', () => {
  it('keeps every bone world matrix at every frame; removes constraints and their keys', () => {
    const p = richProject();
    assert.ok(p.ik?.length && p.pathConstraints?.length, 'fixture has IK and a path constraint');
    const before = p.animations.map((a) => Array.from({ length: Math.round(a.duration * a.fps) + 1 }, (_, f) => worlds(p, a, f)));
    const n = p.ik!.length + p.pathConstraints!.length + (p.transformConstraints?.length ?? 0);
    assert.equal(bakeConstraints(p).constraints, n);
    assert.equal(p.ik, undefined);
    assert.equal(p.pathConstraints, undefined);
    assert.ok(p.animations.every((a) => !a.constraints));
    let worst = 0;
    p.animations.forEach((a, i) => before[i].forEach((w, f) => worlds(p, a, f).forEach((row, k) => row.slice(1).forEach((v, j) => (worst = Math.max(worst, Math.abs((v as number) - (w[k][j + 1] as number))))))));
    assert.ok(worst < 1e-6, `worst ${worst}`);
    assert.ok(parseProject(serializeProject(p)).ok);
  });

  it('springs are baked first; an IK rig in the Lottie subset exports after baking', () => {
    const p = lottieProject();
    const parent = p.bones.find((b) => p.bones.some((c) => c.parentId === b.id && b.parentId))!;
    const child = p.bones.find((c) => c.parentId === parent.id)!;
    assert.ok(addIk(p, child.id, true, { ik: 'ik1', target: 'tgt1' }));
    assert.ok(!exportLottie(p, p.animations[0].name, null).ok, 'refused with IK');
    const r = bakeConstraints(p);
    assert.deepEqual([r.constraints, r.bones], [1, 2]);
    const l = exportLottie(p, p.animations[0].name, null);
    assert.ok(l.ok, JSON.stringify(l.diagnostics.filter((d) => d.level === 'error')));
    const q = richProject();
    q.ik = [];
    q.pathConstraints = [];
    addSpring(q, 's1', ['m1'], {}, true);
    assert.equal(bakeConstraints(q).springs, 4, 'bone tracks: m1, m2 × 2 animations');
    assert.equal(q.springs, undefined);
  });
});
