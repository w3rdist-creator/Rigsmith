// Runtime v2: the exported file alone reproduces the editor's evaluation (bones after IK
// and path constraints, mesh vertices, slot state, skins, mixes); v1 files still load.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluate } from '../../src/model/evaluate.ts';
import { exportRuntime, runtimeProblems } from '../../src/model/exportRuntime.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { evaluateMix } from '../../src/model/mix.ts';
import type { Frame } from '../../src/model/evaluate.ts';
import { loadRuntime } from '../../src/runtime/load.ts';
import { richProject } from '../support/runtime-fixture.ts';

function sameFrame(a: Frame, b: Frame, nameOfBone: (id: string) => string, tol: number, what: string): number {
  let worst = 0;
  for (const [id, m] of a.world) {
    const n = b.world.get(nameOfBone(id))!;
    assert.ok(n, `${what}: bone ${nameOfBone(id)}`);
    for (const k of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) worst = Math.max(worst, Math.abs(m[k] - n[k]));
  }
  assert.deepEqual(b.attachments.map((x) => [x.att.name, x.visible, x.image?.name]), a.attachments.map((x) => [x.att.name, x.visible, x.image?.name]), `${what}: order, visibility, image`);
  a.attachments.forEach((x, i) => {
    const y = b.attachments[i];
    worst = Math.max(worst, Math.abs(x.opacity - y.opacity));
    if (x.vertices) x.vertices.forEach((v, k) => (worst = Math.max(worst, Math.abs(v - y.vertices![k]))));
  });
  assert.ok(worst <= tol, `${what}: max difference ${worst}`);
  return worst;
}

describe('runtime v2', () => {
  const p = richProject();
  const parsed = parseProject(serializeProject(p));

  it('the fixture is a valid project using every v2 runtime feature', () => {
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('\n'));
    assert.deepEqual(runtimeProblems(p), []);
    const rt = exportRuntime(p);
    assert.equal(rt.version, 2);
    assert.equal(rt.ik.length, 1);
    assert.equal(rt.pathConstraints.length, 1);
    assert.ok(rt.attachments.find((a) => a.name === 'band')!.mesh!.weights);
    assert.ok(rt.animations[0].keys.torso.rotate[0].curve);
    assert.deepEqual(Object.keys(rt.animations[0].slots).sort(), ['band', 'bead2', 'lower', 'upper']);
    assert.equal(rt.animations[0].drawOrder.length, 1);
    assert.deepEqual(Object.keys(rt.animations[0].constraints).sort(), ['lower-ik', 'path-follow']);
    assert.deepEqual(rt.skins[0], { name: 'alt', entries: [{ attachment: 'torso', image: 'torso-alt.png' }, { attachment: 'upper', image: 'arm-raised-alt.png', from: 'arm-raised.png' }] });
    assert.deepEqual(rt.mixes, [{ from: 'wave', to: 'rest', duration: 0.3 }]);
  });

  it('a project rebuilt from the runtime file evaluates like the editor on every frame, with and without the skin', () => {
    const rt = JSON.parse(JSON.stringify(exportRuntime(p)));
    const q = loadRuntime(rt);
    const boneName = (id: string) => p.bones.find((b) => b.id === id)!.name;
    for (const anim of p.animations)
      for (const skin of [null, 'skin_alt']) {
        const frames = Math.round(anim.duration * anim.fps);
        for (let f = 0; f <= frames; f++) {
          const t = f / anim.fps;
          const a = evaluate(p, anim, t, { skinId: skin });
          const b = evaluate(q, q.animations.find((x) => x.name === anim.name)!, t, { skinId: skin ? 'alt' : null });
          sameFrame(a, b, boneName, 0, `${anim.name} f${f} skin ${skin}`);
        }
      }
    // The baked v1 data agrees with the runtime evaluation too.
    const an = rt.animations[0];
    for (let f = 0; f < an.frames; f++) {
      const fr = evaluate(q, q.animations[0], f / an.fps);
      const m = fr.world.get('lower')!;
      assert.ok(Math.abs(m.tx - an.baked.lower[f][0]) < 2e-3 && Math.abs(m.ty - an.baked.lower[f][1]) < 2e-3, `baked f${f}`);
      fr.attachments.find((x) => x.att.name === 'band')!.vertices!.forEach((v, k) => assert.ok(Math.abs(v - an.bakedMeshes.band[f][k]) < 2e-3));
    }
  });

  it('mixes from the runtime file agree with the editor (stored duration)', () => {
    const q = loadRuntime(JSON.parse(JSON.stringify(exportRuntime(p))));
    const boneName = (id: string) => p.bones.find((b) => b.id === id)!.name;
    for (const T of [0, 0.5, 0.6, 0.65, 0.8, 1.2]) {
      const a = evaluateMix(p, { entries: [{ animId: 'wave', start: 0, mix: 0 }, { animId: 'rest', start: 0.5, mix: 0.3 }], missing: 'setup' }, T);
      const b = evaluateMix(q, { entries: [{ animId: 'wave', start: 0, mix: 0 }, { animId: 'rest', start: 0.5, mix: 0.3 }], missing: 'setup' }, T);
      sameFrame(a, b, boneName, 0, `mix T=${T}`);
    }
  });

  it('rejects bad files with a reason; v1 runtime files (no v2 sections) still load', () => {
    assert.throws(() => loadRuntime({ format: 'x' }), /Not a rigsmith.runtime/);
    assert.throws(() => loadRuntime({ ...exportRuntime(p), version: 3 }), /Unsupported runtime version 3/);
    const broken = JSON.parse(JSON.stringify(exportRuntime(p)));
    broken.attachments[0].bone = 'ghost';
    assert.throws(() => loadRuntime(broken), /Unknown bone “ghost”/);
    const v1 = JSON.parse(JSON.stringify(exportRuntime(p)));
    v1.version = 1;
    for (const k of ['images', 'ik', 'paths', 'pathConstraints', 'skins', 'mixes']) delete v1[k];
    for (const a of v1.animations) for (const k of ['slots', 'drawOrder', 'constraints']) delete a[k];
    for (const a of v1.attachments) if (a.mesh) delete a.mesh.weights;
    const q = loadRuntime(v1);
    assert.equal(q.bones.length, p.bones.length);
    assert.equal(q.ik, undefined);
  });

  it('duplicate names block the runtime export with a reason', () => {
    const d = richProject();
    d.bones[1].name = 'root';
    assert.match(runtimeProblems(d).join('\n'), /Two bones are named “root”/);
  });
});
