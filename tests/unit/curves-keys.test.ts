import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleKeys } from '../../src/model/animation.ts';
import { CURVE_PRESETS, clampCurve, evalCurve, solveCurveParam } from '../../src/model/curve.ts';
import { boneLane, closeLoopSeam, copyKeys, deleteKeys, laneKeys, pasteKeys, refsInRange, shiftKeys } from '../../src/model/keys.ts';
import type { Animation, Curve, Key } from '../../src/model/types.ts';

const near = (a: number, b: number, eps: number, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≈ ${b} ±${eps}`);

test('curve solver: X(s) = t is solved to 1e-9 and is monotonic for every preset', () => {
  for (const [name, c] of Object.entries(CURVE_PRESETS)) {
    let prevS = -1;
    for (let i = 0; i <= 200; i++) {
      const t = i / 200;
      const s = solveCurveParam(c[0], c[2], t);
      const u = 1 - s;
      const x = 3 * u * u * s * c[0] + 3 * u * s * s * c[2] + s * s * s;
      near(x, t, 1e-9, `${name} x(s(t))`);
      assert.ok(s >= prevS - 1e-12, `${name}: parameter is monotonic in time`);
      prevS = s;
    }
  }
});

test('curve solver copes with flat-slope handles (x1 = x2 = 0 or 1)', () => {
  for (const c of [[0, 0, 0, 1], [1, 0, 1, 1], [0, 1, 1, 0], [1, 0, 0, 1]] as Curve[]) {
    for (const t of [0.001, 0.25, 0.5, 0.75, 0.999]) {
      const s = solveCurveParam(c[0], c[2], t);
      const u = 1 - s;
      near(3 * u * u * s * c[0] + 3 * u * s * s * c[2] + s * s * s, t, 1e-8, `${c} at ${t}`);
    }
  }
});

test('the smooth preset is exactly the legacy smoothstep; the linear preset is exactly linear', () => {
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    near(evalCurve(CURVE_PRESETS.smooth, t), t * t * (3 - 2 * t), 1e-9, 'smooth');
    near(evalCurve(CURVE_PRESETS.linear, t), t, 1e-9, 'linear');
  }
});

test('clampCurve keeps x handles in [0,1] (time never runs backwards) and leaves y free', () => {
  assert.deepEqual(clampCurve([-0.5, -2, 1.7, 3]), [0, -2, 1, 3]);
  assert.deepEqual(clampCurve([NaN, NaN, NaN, NaN]), [0, 0, 1, 1]);
});

const keysOf = (interp: Key['interp'], curve?: Curve): Key[] => [
  { time: 0, value: [0], interp, ...(curve ? { curve } : {}) },
  { time: 1, value: [100], interp: 'linear' },
];

test('overshoot easing samples outside the span of its two keys; linear and smooth do not', () => {
  const over = keysOf('bezier', CURVE_PRESETS.overshoot);
  const values = Array.from({ length: 101 }, (_, i) => sampleKeys(over, i / 100, [0])[0]);
  assert.ok(Math.max(...values) > 100.5, `overshoot peaks above the end key (${Math.max(...values).toFixed(2)})`);
  const ant = keysOf('bezier', CURVE_PRESETS.anticipate);
  assert.ok(Math.min(...Array.from({ length: 101 }, (_, i) => sampleKeys(ant, i / 100, [0])[0])) < -0.5, 'anticipation dips below the start key');
  for (const interp of ['linear', 'smooth'] as const) {
    const vs = Array.from({ length: 101 }, (_, i) => sampleKeys(keysOf(interp), i / 100, [0])[0]);
    assert.ok(Math.max(...vs) <= 100 && Math.min(...vs) >= 0, `${interp} stays within the keys`);
  }
});

test('a bezier key samples its endpoints exactly and moving a handle changes the mid value', () => {
  const k = keysOf('bezier', [0.25, 0.1, 0.25, 1]);
  assert.equal(sampleKeys(k, 0, [0])[0], 0);
  assert.equal(sampleKeys(k, 1, [0])[0], 100);
  const a = sampleKeys(k, 0.5, [0])[0];
  k[0].curve = [0.25, 0.1, 0.25, 1.4];
  const b = sampleKeys(k, 0.5, [0])[0];
  assert.ok(b > a + 1, `raising the second handle raises the mid value (${a.toFixed(2)} → ${b.toFixed(2)})`);
});

function anim(): Animation {
  const k = (time: number, v: number): Key => ({ time, value: [v], interp: 'linear' });
  return {
    id: 'a',
    name: 'a',
    duration: 1,
    fps: 30,
    loop: true,
    tracks: {
      b1: { translate: [], rotate: [k(0, 0), k(10 / 30, 10), k(20 / 30, 20)], scale: [] },
      b2: { translate: [], rotate: [k(0, 5), k(15 / 30, 50)], scale: [] },
    },
  };
}

test('group retime moves several keys on several lanes by the same frames and keeps them on the frame grid', () => {
  const a = anim();
  const refs = [{ lane: boneLane('b1', 'rotate'), time: 10 / 30 }, { lane: boneLane('b2', 'rotate'), time: 15 / 30 }];
  const out = shiftKeys(a, refs, 3 / 30);
  assert.deepEqual(out.map((r) => Math.round(r.time * 30)), [13, 18]);
  assert.equal(a.tracks.b1.rotate[1].time, 13 / 30, 'exactly on frame 13');
  assert.equal(a.tracks.b2.rotate[1].time, 18 / 30);
});

test('collision policy: a moved key replaces the stationary key it lands on', () => {
  const a = anim();
  shiftKeys(a, [{ lane: boneLane('b1', 'rotate'), time: 10 / 30 }], 10 / 30);
  assert.deepEqual(a.tracks.b1.rotate.map((k) => [Math.round(k.time * 30), k.value[0]]), [[0, 0], [20, 10]]);
});

test('retime clamps to the animation range instead of pushing keys before 0 or past the end', () => {
  const a = anim();
  const out = shiftKeys(a, [{ lane: boneLane('b1', 'rotate'), time: 10 / 30 }, { lane: boneLane('b1', 'rotate'), time: 20 / 30 }], -1);
  assert.deepEqual(out.map((r) => Math.round(r.time * 30)), [0, 10], 'earliest moved key stops at 0');
  const b = anim();
  const out2 = shiftKeys(b, [{ lane: boneLane('b1', 'rotate'), time: 20 / 30 }], 1);
  assert.deepEqual(out2.map((r) => Math.round(r.time * 30)), [30]);
});

test('copy/paste across frames and onto another bone; delete', () => {
  const a = anim();
  const clip = copyKeys(a, [{ lane: boneLane('b1', 'rotate'), time: 10 / 30 }, { lane: boneLane('b1', 'rotate'), time: 20 / 30 }])!;
  const r = pasteKeys(a, clip, 25 / 30);
  assert.equal(r.skipped, 1, 'the key that would land past the end is skipped');
  assert.deepEqual(a.tracks.b1.rotate.map((k) => [Math.round(k.time * 30), k.value[0]]), [[0, 0], [10, 10], [20, 20], [25, 10]]);
  const r2 = pasteKeys(a, clip, 0, 'b2');
  assert.deepEqual(r2.refs.map((x) => x.lane), [boneLane('b2', 'rotate'), boneLane('b2', 'rotate')], 'retargeted to b2');
  assert.deepEqual(a.tracks.b2.rotate.map((k) => [Math.round(k.time * 30), k.value[0]]), [[0, 10], [10, 20], [15, 50]], 'paste replaced b2 frame 0');
  // Pasted keys are copies, not shared objects.
  a.tracks.b2.rotate[0].value[0] = 999;
  assert.equal(a.tracks.b1.rotate[1].value[0], 10);
  assert.equal(deleteKeys(a, r2.refs), 2);
  assert.equal(a.tracks.b2.rotate.length, 1);
});

test('loop seam helper copies each lane’s first key to the end', () => {
  const a = anim();
  const changed = closeLoopSeam(a);
  assert.equal(changed.length, 2);
  assert.deepEqual(a.tracks.b1.rotate.at(-1), { time: 1, value: [0], interp: 'linear' });
  assert.deepEqual(a.tracks.b2.rotate.at(-1), { time: 1, value: [5], interp: 'linear' });
  assert.equal(closeLoopSeam(a).length, 2, 'running again overwrites the end key (idempotent result)');
  assert.equal(a.tracks.b1.rotate.length, 4);
});

test('range selection and lane access', () => {
  const a = anim();
  const refs = refsInRange(a, [boneLane('b1', 'rotate'), boneLane('b2', 'rotate')], 5 / 30, 16 / 30);
  assert.deepEqual(refs.map((r) => Math.round(r.time * 30)), [10, 15]);
  assert.equal(laneKeys(a, 'b:nobone:rotate'), undefined);
  assert.equal(laneKeys(a, 'garbage'), undefined);
  assert.ok(laneKeys(a, 's:att1:visible', true), 'slot lanes are created on demand');
  assert.deepEqual(a.slots, { att1: { visible: [] } });
});
