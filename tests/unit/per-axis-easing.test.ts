// R12 / R7: per-axis translate easing (Key.interpY / curveY). Sampling, the v3 file
// format, runtime export and load, the independent reference sampler, Lottie refusal and
// paste onto non-translate lanes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { easeFor, sampleKeys, setInterpY } from '../../src/model/animation.ts';
import { exportRuntime } from '../../src/model/exportRuntime.ts';
import { parseProject, requiredVersion, serializeProject, v3Features } from '../../src/model/format.ts';
import { pasteKeys } from '../../src/model/keys.ts';
import { exportLottie } from '../../src/model/lottie.ts';
import type { Key } from '../../src/model/types.ts';
import { loadRuntime } from '../../src/runtime/load.ts';
import { lottieProject } from '../support/lottie-fixture.ts';
import { sampleTrack } from '../support/reference-composite.ts';
import { richProject } from '../support/runtime-fixture.ts';

const HOP: Key[] = [
  { time: 0, value: [0, 0], interp: 'linear', interpY: 'bezier', curveY: [0, 0, 0.58, 1] },
  { time: 1, value: [100, -50], interp: 'linear' },
];

/** richProject with a split translate key on arm_target. */
function splitProject() {
  const p = richProject();
  const k = p.animations[0].tracks.arm_target.translate[0];
  setInterpY(k, 'step');
  return p;
}

describe('per-axis translate easing', () => {
  it('samples x and y with their own easing; without interpY both follow interp', () => {
    for (const t of [0.1, 0.25, 0.5, 0.9]) {
      const [x, y] = sampleKeys(HOP, t, [0, 0]);
      assert.ok(Math.abs(x - 100 * t) < 1e-9, `x linear at ${t}`);
      assert.ok(Math.abs(y - -50 * easeFor('bezier', t, [0, 0, 0.58, 1])) < 1e-9, `y ease-out at ${t}`);
    }
    assert.ok(sampleKeys(HOP, 0.25, [0, 0])[1] < -12.5 - 5, 'ease-out runs ahead of linear');
    const step: Key[] = [{ ...HOP[0], interpY: 'step', curveY: undefined }, HOP[1]];
    assert.deepEqual(sampleKeys(step, 0.6, [0, 0]), [60, 0], 'y held, x moving');
    const joined: Key[] = [{ time: 0, value: [0, 0], interp: 'linear' }, HOP[1]];
    assert.deepEqual(sampleKeys(joined, 0.5, [0, 0]), [50, -25]);
  });

  it('setInterpY sets, keeps curveY only for bezier, and clears', () => {
    const k: Key = { time: 0, value: [0, 0], interp: 'smooth' };
    setInterpY(k, 'bezier');
    assert.deepEqual([k.interpY, k.curveY], ['bezier', [1 / 3, 1 / 3, 2 / 3, 2 / 3]]);
    setInterpY(k, 'step');
    assert.deepEqual([k.interpY, 'curveY' in k], ['step', false]);
    setInterpY(k, null);
    assert.deepEqual(['interpY' in k, 'curveY' in k, k.interp], [false, false, 'smooth']);
  });

  it('is a v3 feature that round-trips; v2 files, non-translate keys and stray curveY are refused', () => {
    const p = splitProject();
    assert.ok(v3Features(p).includes('per-axis translate easing'));
    assert.equal(requiredVersion(p), 3);
    const text = serializeProject(p);
    const back = parseProject(text);
    assert.ok(back.ok);
    if (back.ok) assert.equal(back.project.animations[0].tracks.arm_target.translate[0].interpY, 'step');
    const raw = JSON.parse(text);
    const v2 = structuredClone(raw);
    v2.version = 2;
    for (const f of Object.keys(v2)) if (f === 'transformConstraints') delete v2[f];
    const r2 = parseProject(JSON.stringify(v2));
    assert.ok(!r2.ok && r2.errors.some((e) => /interpY \(per-axis translate easing\) requires project version 3/.test(e)), JSON.stringify(r2));
    const onScale = structuredClone(raw);
    onScale.animations[0].tracks.m1.scale[0].interpY = 'step';
    const rs = parseProject(JSON.stringify(onScale));
    assert.ok(!rs.ok && rs.errors.some((e) => /interpY is only allowed on translate keys/.test(e)));
    const stray = structuredClone(raw);
    stray.animations[0].tracks.arm_target.translate[0].curveY = [0, 0, 1, 1];
    const rc = parseProject(JSON.stringify(stray));
    assert.ok(!rc.ok && rc.errors.some((e) => /curveY is only allowed when interpY is bezier/.test(e)));
    const bad = structuredClone(raw);
    bad.animations[0].tracks.arm_target.translate[0].interpY = 'bezier';
    bad.animations[0].tracks.arm_target.translate[0].curveY = [1.5, 0, 0.5, 1];
    assert.ok(!parseProject(JSON.stringify(bad)).ok, 'x handles outside [0, 1]');
  });

  it('runtime export and load keep it; the independent reference sampler agrees with the editor', () => {
    const p = splitProject();
    const rt = exportRuntime(p);
    const name = p.bones.find((b) => b.id === 'arm_target')!.name;
    assert.equal(rt.animations[0].keys[name].translate[0].interpY, 'step');
    const loaded = loadRuntime(JSON.parse(JSON.stringify(rt)));
    const lk = loaded.animations[0].tracks[loaded.bones.find((b) => b.name === name)!.id].translate;
    assert.equal(lk[0].interpY, 'step');
    // Two independent bezier solvers: equal to well under a thousandth of a pixel.
    const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
    for (const t of [0.05, 0.2, 0.37, 0.49, 0.7]) {
      assert.ok(close(sampleTrack(HOP, t, [0, 0]), sampleKeys(HOP, t, [0, 0])), `hop at ${t}`);
      assert.ok(close(sampleTrack(lk, t, [0, 0]), sampleKeys(lk, t, [0, 0])), `loaded at ${t}`);
    }
  });

  it('Lottie refuses it with a diagnostic', () => {
    const p = lottieProject();
    assert.ok(exportLottie(p, p.animations[0].name, null).ok, 'fixture exports before the split');
    setInterpY(p.animations[0].tracks.hips.translate[0], 'step');
    const r = exportLottie(p, p.animations[0].name, null);
    assert.ok(!r.ok && r.errors.some((e) => /Separate x \/ y easing/.test(e)), JSON.stringify(r));
  });

  it('paste keeps it on translate lanes and drops it elsewhere', () => {
    const anim = { id: 'a', name: 'a', duration: 2, fps: 30, loop: false, tracks: { b1: { translate: [], rotate: [], scale: [] } } } as any;
    const key = { time: 0, value: [1, 1], interp: 'linear', interpY: 'step' } as Key;
    pasteKeys(anim, { items: [{ lane: 'b:b1:translate', dt: 0, key: structuredClone(key) }, { lane: 'b:b1:scale', dt: 0, key: structuredClone(key) }] }, 1);
    assert.equal(anim.tracks.b1.translate[0].interpY, 'step');
    assert.equal('interpY' in anim.tracks.b1.scale[0], false);
  });
});
