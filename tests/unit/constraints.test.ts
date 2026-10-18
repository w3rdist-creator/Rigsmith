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

describe('two-bone IK under non-uniform scale (review P2-1)', () => {
  // Reviewer probe (drwdmrs3 P2-1): with a non-uniformly scaled parent the world-space
  // law of cosines missed 125/180 reachable targets by up to 71.6 px. Reachability here
  // is measured by forward kinematics only (computeWorld), independent of the solver.
  let seed = 777;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  interface Case { root: [number, number]; own?: [number, number]; elbowY?: number; bendPositive?: boolean }
  function rig(c: Case, tx: number, ty: number): Project {
    const p = emptyProject('ik');
    p.version = 2;
    p.bones = [
      bone('r', null, 0, 0, 0, 10, c.root[0], c.root[1]),
      bone('a', 'r', 0, 0, 0, 100, c.own?.[0] ?? 1, c.own?.[1] ?? 1),
      bone('b', 'a', 100, c.elbowY ?? 0, 0, 80),
      bone('t', null, tx, ty, 0, 5),
    ];
    p.ik = [{ id: 'k', name: 'k', bones: ['a', 'b'], target: 't', mix: 1, bendPositive: c.bendPositive ?? true }];
    return p;
  }
  /** World tip of bone b and elbow (b origin) for given local rotations of a and b. */
  function fk(p: Project, ra: number, rb: number) {
    const pose = samplePose(p.bones, null, 0);
    pose.set('a', { ...pose.get('a')!, rotation: ra });
    pose.set('b', { ...pose.get('b')!, rotation: rb });
    const w = computeWorld(p.bones, pose);
    const b = w.get('b')!;
    return { tip: apply(b, { x: 80, y: 0 }), elbow: { x: b.tx, y: b.ty }, rootInv: w.get('r')! };
  }
  /** Reach annulus in parent (r) space: min/max shoulder→tip distance over the elbow angle. */
  function reach(p: Project) {
    const inv = (m: { a: number; b: number; c: number; d: number; tx: number; ty: number }, q: { x: number; y: number }) => {
      const det = m.a * m.d - m.b * m.c, x = q.x - m.tx, y = q.y - m.ty;
      return { x: (m.d * x - m.c * y) / det, y: (m.a * y - m.b * x) / det };
    };
    let lo = Infinity, hi = 0;
    for (let i = 0; i < 7200; i++) {
      const f = fk(p, 0, i / 20);
      const q = inv(f.rootInv, f.tip);
      const d = Math.hypot(q.x, q.y);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    return { lo, hi, local: (q: { x: number; y: number }) => inv(fk(p, 0, 0).rootInv, q) };
  }

  const cases: [string, Case][] = [
    ['parent scale (2, 1)', { root: [2, 1] }],
    ['parent scale (1, 0.5)', { root: [1, 0.5] }],
    ['parent scale (1.5, 0.75)', { root: [1.5, 0.75] }],
    ['mirrored parent scale (−2, 1)', { root: [-2, 1] }],
    ['own scale (1.5, 0.6), elbow off-axis, bend negative', { root: [1, 1], own: [1.5, 0.6], elbowY: 20, bendPositive: false }],
    ['parent (2, 0.5) and own (0.7, 1.4)', { root: [2, 0.5], own: [0.7, 1.4] }],
  ];
  for (const [label, c] of cases) {
    it(`${label}: reaches every reachable target on the requested side; unreachable targets get the closest reach`, () => {
      const r = reach(rig(c, 0, 0));
      let reached = 0;
      for (let i = 0; i < 60; i++) {
        const ang = rand() * Math.PI * 2, dist = 40 + rand() * 200;
        const tx = Math.cos(ang) * dist, ty = Math.sin(ang) * dist;
        const p = rig(c, tx, ty);
        const pose = samplePose(p.bones, null, 0);
        applyConstraints(p, pose, null, 0);
        const f = fk(p, pose.get('a')!.rotation, pose.get('b')!.rotation);
        const miss = Math.hypot(f.tip.x - tx, f.tip.y - ty);
        const tl = r.local({ x: tx, y: ty }), d = Math.hypot(tl.x, tl.y);
        if (d > r.lo + 0.5 && d < r.hi - 0.5) {
          reached++;
          assert.ok(miss < 1e-6, `target (${tx.toFixed(1)}, ${ty.toFixed(1)}) is reachable but missed by ${miss.toFixed(3)} px`);
          // Bend side in the parent's own space (a mirrored parent mirrors it on screen).
          const el = r.local(f.elbow);
          const side = tl.x * el.y - tl.y * el.x;
          assert.ok((c.bendPositive ?? true) ? side > 0 : side < 0, `elbow on the requested side (${side})`);
        } else if (d > r.hi + 0.5 || d < r.lo - 0.5) {
          // Unreachable: the tip lands as close as the chain can get (distance to the annulus, in parent space).
          const tipL = r.local(f.tip);
          const gap = Math.hypot(tl.x - tipL.x, tl.y - tipL.y);
          const best = d > r.hi ? d - r.hi : r.lo - d;
          assert.ok(gap < best + 1e-3, `unreachable target: parent-space gap ${gap} ≈ ${best}`);
        }
      }
      assert.ok(reached > 20, `enough reachable samples (${reached})`);
    });
  }

  it('the reviewer brute-force check: no target with a brute-force solution is missed by the solver', () => {
    let checked = 0;
    const tip = (p: Project, a: number, b: number, tx: number, ty: number) => {
      const t = fk(p, a, b).tip;
      return Math.hypot(t.x - tx, t.y - ty);
    };
    for (const root of [[2, 1], [1, 0.5], [1.5, 0.75]] as [number, number][]) {
      for (let i = 0; i < 4; i++) {
        const ang = rand() * Math.PI * 2, dist = 40 + rand() * 200;
        const tx = Math.cos(ang) * dist, ty = Math.sin(ang) * dist;
        const p = rig({ root }, tx, ty);
        let best = { d: Infinity, a: 0, b: 0 };
        for (let a = -180; a < 180; a += 4) for (let b = -180; b < 180; b += 4) {
          const d = tip(p, a, b, tx, ty);
          if (d < best.d) best = { d, a, b };
        }
        for (let step = 2; step > 1e-4; ) {
          let improved = false;
          for (const [da, db] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
            const d = tip(p, best.a + da, best.b + db, tx, ty);
            if (d < best.d) { best = { d, a: best.a + da, b: best.b + db }; improved = true; }
          }
          if (!improved) step /= 2;
        }
        const pose = samplePose(p.bones, null, 0);
        applyConstraints(p, pose, null, 0);
        const solver = tip(p, pose.get('a')!.rotation, pose.get('b')!.rotation, tx, ty);
        // The reviewer's criterion: brute force reaches it (< 0.05 px) ⇒ the solver must too.
        if (best.d < 0.05) checked++;
        if (best.d < 0.05) assert.ok(solver < 1e-6, `scale (${root}) target (${tx.toFixed(1)}, ${ty.toFixed(1)}): solver misses by ${solver.toFixed(4)} px, brute force ${best.d.toFixed(4)} px`);
      }
    }
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
