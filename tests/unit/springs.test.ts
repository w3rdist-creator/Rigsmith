// R8 springs: the simulation matches the showcase rigs' springBake() (ported below as the
// reference), loops are seamless, results are deterministic and cached, and springs
// survive the file format, bone deletion, baking, runtime export and Lottie refusal.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setKey } from '../../src/model/animation.ts';
import { evaluate } from '../../src/model/evaluate.ts';
import { exportRuntime } from '../../src/model/exportRuntime.ts';
import { parseProject, requiredVersion, serializeProject, v3Features } from '../../src/model/format.ts';
import { repairReferences } from '../../src/model/integrity.ts';
import { exportLottie } from '../../src/model/lottie.ts';
import { angleOf } from '../../src/model/math.ts';
import { makeBone } from '../../src/model/ops.ts';
import { addSpring, bakeSprings, constraintNames, deleteConstraint } from '../../src/model/rigOps.ts';
import { holdSprings, springOffsets } from '../../src/model/springs.ts';
import type { Animation, Project } from '../../src/model/types.ts';
import { emptyProject, emptyTrack } from '../../src/model/types.ts';
import { springBakeRef } from '../support/spring-reference.ts';

function rig(): Project {
  const p = emptyProject('springs');
  p.bones.push(makeBone('root', 'root', null, 0, 0, 0, 40), makeBone('hips', 'hips', 'root', 0, -60, -90, 60));
  p.bones.push(makeBone('t1', 'tail1', 'hips', 0, 0, 160, 50), makeBone('t2', 'tail2', 't1', 50, 0, 10, 45), makeBone('t3', 'tail3', 't2', 45, 0, 10, 40));
  p.bones.push(makeBone('ear', 'ear', 'hips', 60, 0, 30, 30));
  const sway: Animation = { id: 'sway', name: 'sway', duration: 1, fps: 30, loop: true, tracks: { root: emptyTrack(), hips: emptyTrack() } };
  for (const [t, x] of [[0, 0], [0.25, 70], [0.5, 0], [0.75, -70], [1, 0]]) setKey(sway.tracks.root.translate, t, [x, Math.abs(x) * -0.3], 'smooth');
  for (const [t, r] of [[0, -90], [0.5, -70], [1, -90]]) setKey(sway.tracks.hips.rotate, t, [r], 'smooth');
  const hop: Animation = { id: 'hop', name: 'hop', duration: 0.8, fps: 30, loop: false, tracks: { root: emptyTrack(), t2: emptyTrack() } };
  for (const [t, y] of [[0, 0], [0.2, -120], [0.4, 0]]) setKey(hop.tracks.root.translate, t, [0, y], 'linear');
  setKey(hop.tracks.t2.rotate, 0.3, [25], 'smooth');
  p.animations.push(sway, hop);
  return p;
}

const PARAMS = { tail: { stiffness: 0.07, damping: 0.16, gain: 0.7, max: 30 }, ear: { stiffness: 0.12, damping: 0.22, gain: 0.9, max: 25 } };

function sprung(): Project {
  const p = rig();
  assert.ok(!('error' in addSpring(p, 'sp_tail', ['t1'], PARAMS.tail, true)));
  assert.ok(!('error' in addSpring(p, 'sp_ear', ['ear'], PARAMS.ear)));
  return p;
}

const angles = (p: Project, a: Animation, f: number, ids: string[]) => {
  const w = evaluate(p, a, f / a.fps).world;
  return ids.map((id) => angleOf(w.get(id)!));
};
const IDS = ['t1', 't2', 't3', 'ear'];
const diff = (x: number, y: number) => Math.abs(((x - y + 540) % 360) - 180);

describe('simulation', () => {
  it('matches the showcase springBake() on every frame of a loop and a one-shot', () => {
    for (const name of ['sway', 'hop']) {
      const p = sprung();
      const ref = rig();
      const ra = ref.animations.find((a) => a.name === name)!;
      springBakeRef(ref, ra, ['ear'], { k: 0.12, damp: 0.22, gain: 0.9, max: 25 });
      springBakeRef(ref, ra, ['tail1', 'tail2', 'tail3'], { k: 0.07, damp: 0.16, gain: 0.7, max: 30 });
      const a = p.animations.find((x) => x.name === name)!;
      let worst = 0, moved = 0;
      for (let f = 0; f <= Math.round(a.duration * a.fps); f++) {
        const got = angles(p, a, f, IDS), want = angles(ref, ra, f, IDS), keyed = angles(rig(), rig().animations.find((x) => x.name === name)!, f, IDS);
        got.forEach((g, i) => {
          worst = Math.max(worst, diff(g, want[i]));
          moved = Math.max(moved, diff(g, keyed[i]));
        });
      }
      // Springs here run ear first (the reference order); the order only matters within a chain.
      assert.ok(worst < 1e-6, `${name}: worst ${worst}°`);
      assert.ok(moved > 3, `${name}: the spring visibly lags (max ${moved}°)`);
    }
  });

  it('loops are seamless (frame 0 = frame n); results are deterministic and cached', () => {
    const p = sprung();
    const a = p.animations[0];
    const offs = springOffsets(p, a);
    for (const o of offs.values()) assert.equal(o[0], o[o.length - 1]);
    assert.equal(springOffsets(p, a), offs, 'cached while nothing changes');
    assert.deepEqual([...springOffsets(sprung(), sprung().animations[0])], [...offs]);
    p.springs![0].gain = 0.2;
    assert.notEqual(springOffsets(p, a), offs, 'a parameter change re-simulates');
    holdSprings(true);
    const held = springOffsets(p, a);
    p.springs![0].gain = 0.9;
    assert.equal(springOffsets(p, a), held, 'held (drag gesture): the last simulation is reused');
    holdSprings(false);
    assert.notEqual(springOffsets(p, a), held, 'released: re-simulated');
    p.springs![0].mix = 0;
    assert.ok(springOffsets(p, a).get('t1')!.every((v) => v === 0), 'mix 0 = keyed pose');
  });
});

describe('editing and storage', () => {
  it('addSpring follows single children, refuses taken bones and bad parameters; names are unique', () => {
    const p = sprung();
    assert.deepEqual(p.springs![0].bones, ['t1', 't2', 't3']);
    assert.equal(p.springs![0].name, 'tail1-spring');
    assert.match((addSpring(p, 'x', ['t2']) as { error: string }).error, /already in a spring/);
    assert.match((addSpring(p, 'x', ['root'], { damping: 2 }) as { error: string }).error, /damping/);
    assert.ok(constraintNames(p).includes('ear-spring'));
    deleteConstraint(p, 'sp_ear');
    assert.equal(p.springs!.length, 1);
  });

  it('v3 format round-trips; bad springs are refused; deleted bones leave the chain', () => {
    const p = sprung();
    assert.ok(v3Features(p).includes('springs'));
    assert.equal(requiredVersion(p), 3);
    const text = serializeProject(p);
    const back = parseProject(text);
    assert.ok(back.ok);
    if (back.ok) assert.deepEqual(back.project.springs, p.springs);
    const raw = JSON.parse(text);
    const bad = (f: (x: any) => void, re: RegExp) => {
      const r = structuredClone(raw);
      f(r);
      const res = parseProject(JSON.stringify(r));
      assert.ok(!res.ok && res.errors.some((e) => re.test(e)), `${re}: ${JSON.stringify(res)}`);
    };
    bad((r) => (r.version = 2), /springs requires project version 3/);
    bad((r) => (r.springs[1].bones = ['t2']), /already in a spring/);
    bad((r) => (r.springs[1].bones = ['nope']), /missing bone/);
    bad((r) => (r.springs[1].stiffness = 0), /stiffness/);
    bad((r) => (r.springs[1].id = 'sp_tail'), /duplicated/);
    p.bones = p.bones.filter((b) => b.id !== 't3' && b.id !== 'ear');
    repairReferences(p);
    assert.deepEqual(p.springs!.map((s) => s.bones), [['t1', 't2']]);
  });

  it('bakeSprings keeps the motion and removes the springs; runtime export bakes; Lottie refuses', () => {
    const p = sprung();
    const before = p.animations.map((a) => [0, 7, 15, 23].map((f) => angles(p, a, f, IDS)));
    const rt = exportRuntime(p);
    assert.equal((rt as any).springs, undefined);
    assert.ok(p.springs, 'export leaves the project alone');
    const lot = exportLottie(p, 'sway', null);
    assert.ok(!lot.ok && lot.diagnostics.some((d) => d.feature === 'spring' && /Bake springs/.test(d.message)));
    const res = bakeSprings(p);
    assert.deepEqual(res, { bones: 8, animations: 2 });
    assert.equal(p.springs, undefined);
    p.animations.forEach((a, i) => [0, 7, 15, 23].forEach((f, j) => angles(p, a, f, IDS).forEach((v, k) => assert.ok(diff(v, before[i][j][k]) < 1e-6))));
    const tail = rt.animations.find((a) => a.name === 'sway')!;
    assert.equal(JSON.stringify(tail).includes('tail3'), true);
  });
});
