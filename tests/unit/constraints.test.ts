import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PathTable, applyConstraints } from '../../src/model/constraints.ts';
import { evaluate } from '../../src/model/evaluate.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { apply, identity } from '../../src/model/math.ts';
import { samplePose } from '../../src/model/animation.ts';
import { computeWorld } from '../../src/model/skeleton.ts';
import type { Bone, IkConstraint, PathShape, Project } from '../../src/model/types.ts';
import { emptyProject } from '../../src/model/types.ts';

const bone = (id: string, parentId: string | null, x: number, y: number, rotation: number, length: number, scaleX = 1, scaleY = 1): Bone => ({ id, name: id, parentId, x, y, rotation, scaleX, scaleY, length, color: '#fff' });
const near = (a: number, b: number, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≈ ${b}`);

/** root → upper (100 px) → lower (100 px); target bone under root. */
function arm(target: { x: number; y: number }, opts: Partial<IkConstraint> = {}, rootScaleX = 1): Project {
  const p = emptyProject('ik');
  p.version = 2;
  p.bones = [bone('root', null, 0, 0, 0, 0, rootScaleX), bone('upper', 'root', 0, 0, 0, 100), bone('lower', 'upper', 100, 0, 0, 100), bone('tgt', 'root', target.x, target.y, 0, 0)];
  p.ik = [{ id: 'ik1', name: 'arm', bones: ['upper', 'lower'], target: 'tgt', mix: 1, bendPositive: true, ...opts }];
  return p;
}

function solved(p: Project) {
  const f = evaluate(p, null, 0);
  const up = f.world.get('upper')!, lo = f.world.get('lower')!;
  return { f, shoulder: { x: up.tx, y: up.ty }, elbow: { x: lo.tx, y: lo.ty }, tip: apply(lo, { x: 100, y: 0 }) };
}

const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

describe('two-bone IK', () => {
  it('reaches a reachable target exactly; bendPositive puts the elbow on the clockwise side', () => {
    const t = { x: 120, y: 80 };
    const pos = solved(arm(t));
    near(pos.tip.x, t.x, 1e-6, 'tip x');
    near(pos.tip.y, t.y, 1e-6, 'tip y');
    near(Math.hypot(pos.elbow.x, pos.elbow.y), 100, 1e-6, 'upper length preserved');
    assert.ok(cross(pos.shoulder, t, pos.elbow) > 0, 'clockwise (y-down) elbow for bendPositive');
    const neg = solved(arm(t, { bendPositive: false }));
    near(neg.tip.x, t.x);
    near(neg.tip.y, t.y);
    assert.ok(cross(neg.shoulder, t, neg.elbow) < 0, 'opposite side when bendPositive = false');
  });

  it('unreachable target: the chain straightens toward it (deterministic)', () => {
    const t = { x: 300, y: 400 }; // distance 500 > 200
    const { shoulder, elbow, tip } = solved(arm(t));
    const dir = Math.atan2(t.y, t.x);
    near(Math.atan2(elbow.y - shoulder.y, elbow.x - shoulder.x), dir, 1e-9, 'upper aims at target');
    near(Math.atan2(tip.y - elbow.y, tip.x - elbow.x), dir, 1e-9, 'lower aims at target');
    near(Math.hypot(tip.x, tip.y), 200, 1e-6, 'fully extended');
  });

  it('target closer than |l1 − l2| folds the chain; target on the shoulder leaves the keyed pose', () => {
    const p = arm({ x: 30, y: 0 });
    p.bones[2].length = 40; // l2 = 40, |l1 − l2| = 60 > 30
    const f = evaluate(p, null, 0);
    for (const m of f.world.values()) for (const v of Object.values(m)) assert.ok(Number.isFinite(v));
    const lo = f.world.get('lower')!;
    const tip = apply(lo, { x: 40, y: 0 });
    near(Math.hypot(tip.x, tip.y), 60, 1e-6, 'folded: tip at l1 − l2');
    const deg = solved(arm({ x: 0, y: 0 }));
    near(deg.elbow.x, 100);
    near(deg.elbow.y, 0);
    near(deg.tip.x, 200, 1e-9, 'degenerate target: unchanged');
  });

  it('mirrored parent: the solution is the exact mirror image of the unmirrored one', () => {
    const plain = solved(arm({ x: 120, y: 80 }));
    // root scaleX −1 mirrors the whole rig; the target's local x stays 120 → world −120.
    const mir = solved(arm({ x: 120, y: 80 }, {}, -1));
    near(mir.tip.x, -120, 1e-6, 'reaches mirrored target');
    near(mir.tip.y, 80, 1e-6);
    near(mir.elbow.x, -plain.elbow.x, 1e-6, 'elbow mirrored x');
    near(mir.elbow.y, plain.elbow.y, 1e-6, 'elbow same y');
  });

  it('mix blends local rotations; an animated mix key overrides the setup mix', () => {
    const p = arm({ x: 0, y: 150 });
    const full = evaluate(p, null, 0).pose;
    p.ik![0].mix = 0.5;
    const half = evaluate(p, null, 0).pose;
    near(half.get('upper')!.rotation, full.get('upper')!.rotation / 2, 1e-9, 'upper half way');
    near(half.get('lower')!.rotation, full.get('lower')!.rotation / 2, 1e-9, 'lower half way');
    p.animations.push({ id: 'a', name: 'a', duration: 1, fps: 30, loop: false, tracks: {}, constraints: { ik1: { mix: [{ time: 0, value: [0], interp: 'linear' }, { time: 1, value: [1], interp: 'linear' }] } } });
    const a = p.animations[0];
    near(evaluate(p, a, 0).pose.get('upper')!.rotation, 0, 1e-12, 'keyed mix 0 = keyed pose');
    near(evaluate(p, a, 1).pose.get('upper')!.rotation, full.get('upper')!.rotation, 1e-9, 'keyed mix 1 = solved');
  });

  it('one-bone IK aims the bone at the target; constraints can be skipped for setup editing', () => {
    const p = arm({ x: 0, y: 50 });
    p.ik = [{ id: 'ik1', name: 'aim', bones: ['upper'], target: 'tgt', mix: 1, bendPositive: true }];
    near(evaluate(p, null, 0).pose.get('upper')!.rotation, 90, 1e-9);
    near(evaluate(p, null, 0, { constraints: false }).pose.get('upper')!.rotation, 0, 1e-12);
  });

  it('keeps the solved rotation on the keyed turn (no 360° jumps)', () => {
    const p = arm({ x: 0, y: 150 });
    p.bones[1].rotation = 720;
    const r = evaluate(p, null, 0).pose.get('upper')!.rotation;
    assert.ok(Math.abs(r - 720) <= 180, `rotation ${r} stays near 720`);
  });
});

describe('path constraint', () => {
  const line: PathShape = { id: 'p', name: 'line', boneId: null, closed: false, nodes: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 100, outY: 0 }, { x: 300, y: 0, inX: -100, inY: 0, outX: 0, outY: 0 }] };

  it('arc-length table: a straight cubic has its exact length and uniform parameterisation', () => {
    const t = new PathTable(line, identity());
    near(t.length, 300, 1e-6);
    near(t.at(150).point.x, 150, 1e-3);
    near(t.at(-20).point.x, 0, 1e-9, 'open: clamped at start');
    near(t.at(999).point.x, 300, 1e-9, 'open: clamped at end');
  });

  it('a closed circle-ish path wraps and keeps points on the curve', () => {
    const k = 0.5523 * 100;
    const circle: PathShape = { id: 'c', name: 'c', boneId: null, closed: true, nodes: [
      { x: 100, y: 0, inX: 0, inY: -k, outX: 0, outY: k },
      { x: 0, y: 100, inX: k, inY: 0, outX: -k, outY: 0 },
      { x: -100, y: 0, inX: 0, inY: k, outX: 0, outY: -k },
      { x: 0, y: -100, inX: -k, inY: 0, outX: k, outY: 0 },
    ] };
    const t = new PathTable(circle, identity());
    near(t.length, 2 * Math.PI * 100, 0.2, 'circumference');
    for (const s of [0, 50, 200, 400, 600]) near(Math.hypot(t.at(s).point.x, t.at(s).point.y), 100, 0.03, `radius at ${s}`);
    near(t.at(t.length + 10).point.x, t.at(10).point.x, 1e-9, 'wraps');
    near(t.at(0).tangent, 90, 1e-6, 'tangent points down (clockwise on screen) at the start');
  });

  it('places bones by position + spacing, rotates them to the tangent (+offset), honours mix', () => {
    const p = emptyProject('path');
    p.version = 2;
    p.bones = [bone('a', null, 0, 50, 0, 20), bone('b', null, 0, 50, 0, 20), bone('c', 'b', 0, 0, 0, 20)];
    p.paths = [{ ...line, boneId: null }];
    p.pathConstraints = [{ id: 'pc', name: 'pc', pathId: 'p', bones: ['a', 'b', 'c'], position: 0.1, spacing: 100, mix: 1, rotate: true, rotateOffset: 15 }];
    const w = evaluate(p, null, 0).world;
    near(w.get('a')!.tx, 30, 1e-3);
    near(w.get('b')!.tx, 130, 1e-3);
    near(w.get('c')!.tx, 230, 1e-3, 'child of b, placed in world by inverting b');
    for (const id of ['a', 'b', 'c']) {
      near(w.get(id)!.ty, 0, 1e-6, `${id} on the line`);
      near(Math.atan2(w.get(id)!.b, w.get(id)!.a) * 180 / Math.PI, 15, 1e-6, `${id} tangent + offset`);
    }
    p.pathConstraints[0].mix = 0.5;
    const half = evaluate(p, null, 0).world;
    near(half.get('a')!.ty, 25, 1e-6, 'half way between keyed y=50 and the path');
    p.animations.push({ id: 'an', name: 'an', duration: 1, fps: 30, loop: true, tracks: {}, constraints: { pc: { position: [{ time: 0, value: [0], interp: 'linear' }, { time: 1, value: [0.5], interp: 'linear' }] } } });
    p.pathConstraints[0].mix = 1;
    near(evaluate(p, p.animations[0], 1).world.get('a')!.tx, 150, 1e-3, 'animated position');
  });

  it('path in a bone space follows that bone', () => {
    const p = emptyProject('path');
    p.version = 2;
    p.bones = [bone('carrier', null, 0, 0, 90, 10), bone('a', null, 0, 0, 0, 20)];
    p.paths = [{ ...line, boneId: 'carrier' }];
    p.pathConstraints = [{ id: 'pc', name: 'pc', pathId: 'p', bones: ['a'], position: 0.5, spacing: 0, mix: 1, rotate: true, rotateOffset: 0 }];
    const w = evaluate(p, null, 0).world.get('a')!;
    near(w.tx, 0, 1e-3);
    near(w.ty, 150, 1e-3, 'carrier rotated 90°: path runs down');
    near(Math.atan2(w.b, w.a) * 180 / Math.PI, 90, 1e-6);
  });
});

describe('constraint persistence', () => {
  it('IK, paths and constraint keys round-trip losslessly and evaluate identically', () => {
    const p = arm({ x: 120, y: 80 });
    p.paths = [{ id: 'p', name: 'p', boneId: 'root', closed: false, nodes: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 10, outY: 0 }, { x: 50, y: 20, inX: -5, inY: 0, outX: 0, outY: 0 }] }];
    p.pathConstraints = [{ id: 'pc', name: 'pc', pathId: 'p', bones: ['tgt'], position: 0.25, spacing: 0, mix: 0.75, rotate: false, rotateOffset: 0 }];
    p.animations.push({ id: 'a', name: 'a', duration: 1, fps: 30, loop: true, tracks: {}, constraints: { ik1: { mix: [{ time: 0, value: [0.3], interp: 'linear' }] }, pc: { position: [{ time: 0.5, value: [1], interp: 'step' }] } } });
    const text = serializeProject(p);
    const r = parseProject(text);
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    assert.equal(serializeProject(r.project), text, 'byte-identical re-save');
    const a = evaluate(p, p.animations[0], 0.6).world, b = evaluate(r.project, r.project.animations[0], 0.6).world;
    for (const [id, m] of a) assert.deepEqual(b.get(id), m, id);
  });

  it('rejects an IK whose target hangs under the chain', () => {
    const p = arm({ x: 1, y: 1 });
    p.bones[3].parentId = 'lower';
    const r = parseProject(serializeProject(p));
    assert.ok(!r.ok && r.errors.some((e) => /target must not be/.test(e)));
  });

  it('applyConstraints is a no-op without constraints', () => {
    const p = arm({ x: 1, y: 1 });
    delete p.ik;
    const pose = samplePose(p.bones, null, 0);
    applyConstraints(p, pose, null, 0);
    assert.deepEqual(computeWorld(p.bones, pose), computeWorld(p.bones));
  });
});

describe('runtime export after constraints', () => {
  it('bakes IK-solved world transforms and per-frame slot state', async () => {
    const { exportRuntime } = await import('../../src/model/exportRuntime.ts');
    const p = arm({ x: 120, y: 80 });
    p.images = [{ id: 'im', name: 'im.png', mime: 'image/png', width: 4, height: 4, dataUrl: 'data:image/png;base64,AA==' }];
    p.attachments = [{ id: 'a', name: 'a', boneId: 'lower', imageId: 'im', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 }];
    p.animations = [{ id: 'an', name: 'an', duration: 1, fps: 2, loop: true, tracks: {}, slots: { a: { visible: [{ time: 0.5, value: [0], interp: 'step' }] } } }];
    const rt = exportRuntime(p);
    const lo = evaluate(p, p.animations[0], 0).world.get('lower')!;
    near(rt.animations[0].baked.lower[0][0], Math.round(lo.tx * 1000) / 1000, 1e-9, 'baked x = solved x');
    near(rt.animations[0].baked.lower[0][2], Math.round((Math.atan2(lo.b, lo.a) * 180) / Math.PI * 1000) / 1000, 1e-9, 'baked angle = solved angle');
    assert.deepEqual(rt.animations[0].bakedSlots!.map((f) => f[0].visible), [true, false]);
  });
});
