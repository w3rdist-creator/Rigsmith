// R3 inherit flags (rotation, scale, reflection per bone): the showcase repros (L2 shear,
// R6 IK reach under a hips squash), the mirror property for every flag combination, the
// independent reference (tests/support/reference-*.ts) with IK, paths and transform
// constraints on flagged bones, the v3 gate, edits that keep world placement, and the CLI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { evaluate } from '../../src/model/evaluate.ts';
import { exportRuntime } from '../../src/model/exportRuntime.ts';
import { parseProject, requiredVersion, serializeProject } from '../../src/model/format.ts';
import { repairReferences } from '../../src/model/integrity.ts';
import { lottieDiagnostics } from '../../src/model/lottie.ts';
import type { Mat } from '../../src/model/math.ts';
import { apply } from '../../src/model/math.ts';
import { makeBone } from '../../src/model/ops.ts';
import { addAimConstraint, addIk, addPath, addPathConstraint, moveBonePivot } from '../../src/model/rigOps.ts';
import { computeWorld, deleteBone, reparentBone, setBoneInherit } from '../../src/model/skeleton.ts';
import type { Animation, BoneInherit, Key, Project } from '../../src/model/types.ts';
import { FORMAT_ID } from '../../src/model/types.ts';
import { loadRuntime } from '../../src/runtime/load.ts';
import { EVIDENCE, ROOT } from '../e2e/harness.ts';
import { worldsFromLocal } from '../support/reference-composite.ts';
import { constrainedWorlds, keyedLocal } from '../support/reference-constraints.ts';

const k = (time: number, value: number[], interp: Key['interp'] = 'linear'): Key => ({ time, value, interp });
const deg = (x: number, y: number) => (Math.atan2(y, x) * 180) / Math.PI;
const project = (bones: Project['bones']): Project => ({ format: FORMAT_ID, version: 2, name: 'inherit', bones, images: [], attachments: [], animations: [] });
const COMBOS: BoneInherit[] = [true, false].flatMap((rotation) => [true, false].flatMap((scale) => [true, false].map((reflection) => ({ rotation, scale, reflection }))));
const near = (a: Mat, b: Mat, eps: number, msg: string) => {
  for (const ch of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) assert.ok(Math.abs(a[ch] - b[ch]) <= eps, `${msg}: ${ch} ${a[ch]} vs ${b[ch]}`);
};

describe('showcase repros', () => {
  it('L2: a stretched parent shears a rotated child (101.03°); with scale not inherited the axes stay at 90°', () => {
    // Showcase 2 repro-limits L2: parent scaleX 1.25, child at (100, 0) rotated 60° with scaleX 1/1.25.
    const p = project([makeBone('a', 'parent', null, 0, 0, 0, 100), makeBone('b', 'child', 'a', 100, 0, 60, 100)]);
    p.bones[0].scaleX = 1.25;
    p.bones[1].scaleX = 1 / 1.25;
    const between = () => {
      const w = computeWorld(p.bones).get('b')!;
      return deg(w.c, w.d) - deg(w.a, w.b);
    };
    assert.equal(+between().toFixed(2), 101.03, 'the repro value without flags');
    const before = computeWorld(p.bones).get('b')!;
    setBoneInherit(p, 'b', { scale: false });
    assert.ok(Math.abs(between() - 90) < 1e-9, `${between()}`);
    const after = computeWorld(p.bones).get('b')!;
    assert.ok(Math.hypot(after.tx - before.tx, after.ty - before.ty) < 1e-9, 'the origin still follows the full parent');
    assert.ok(Math.abs(deg(after.a, after.b) - deg(before.a, before.b)) < 1e-9, 'setting the flag keeps the setup x axis on screen');
  });

  it('R6: squashing the hips (scale key 0.85) opens the IK ankle gap; thigh not inheriting scale keeps it at 0', () => {
    const rig = () => {
      const p = project([
        makeBone('root', 'root', null, 0, 0, 0, 10),
        makeBone('hips', 'hips', 'root', 0, -100, 0, 20),
        makeBone('thigh', 'thigh', 'hips', 0, 0, 90, 50),
        makeBone('shin', 'shin', 'thigh', 50, 0, -10, 50),
      ]);
      addIk(p, 'shin', true, { ik: 'leg', target: 'foot' });
      const foot = p.bones.find((b) => b.id === 'foot')!;
      foot.x = 4; // planted near full reach
      foot.y = -2;
      const an: Animation = { id: 'squash', name: 'squash', duration: 1, fps: 30, loop: true, tracks: { hips: { translate: [], rotate: [], scale: [k(0, [1, 1]), k(0.5, [1.16, 0.85]), k(1, [1, 1])] } } };
      p.animations.push(an);
      return p;
    };
    const gap = (p: Project) => {
      let worst = 0;
      for (let f = 0; f <= 30; f++) {
        const w = evaluate(p, p.animations[0], f / 30).world;
        const tip = apply(w.get('shin')!, { x: 50, y: 0 }), t = w.get('foot')!;
        worst = Math.max(worst, Math.hypot(tip.x - t.tx, tip.y - t.ty));
      }
      return worst;
    };
    const plain = rig();
    assert.ok(gap(plain) > 5, `squash opens a gap (${gap(plain)} px)`);
    const flagged = rig();
    setBoneInherit(flagged, 'thigh', { scale: false });
    assert.ok(gap(flagged) < 1e-9, `gap ${gap(flagged)} px`);
  });
});

describe('composition rules', () => {
  const chain = (rootScale: [number, number], inherit: BoneInherit) => {
    const p = project([
      makeBone('root', 'root', null, 0, 0, 0, 10),
      makeBone('body', 'body', 'root', 20, 10, 35, 40),
      makeBone('arm', 'arm', 'body', 40, 5, 50, 30),
      makeBone('hand', 'hand', 'arm', 30, 0, -20, 10),
    ]);
    [p.bones[0].scaleX, p.bones[0].scaleY] = rootScale;
    Object.assign(p.bones[1], { scaleX: 1.4, scaleY: 0.7 });
    p.bones[2].inherit = inherit.rotation && inherit.scale && inherit.reflection ? undefined : { ...inherit };
    return p;
  };
  const F = (m: Mat, fx: number, fy: number): Mat => ({ a: fx * m.a, b: fy * m.b, c: fx * m.c, d: fy * m.d, tx: fx * m.tx, ty: fy * m.ty });

  it('a rig mirrored with root scaleX −1 is the exact left↔right mirror image for every flag combination that keeps reflection', () => {
    for (const inh of COMBOS) {
      const plain = computeWorld(chain([1, 1], inh).bones), mirrored = computeWorld(chain([-1, 1], inh).bones);
      for (const id of ['body', 'arm', 'hand']) {
        if (inh.reflection || id === 'body') near(mirrored.get(id)!, F(plain.get(id)!, -1, 1), 1e-9, `${JSON.stringify(inh)} ${id}`);
        else {
          const m = mirrored.get(id)!;
          assert.ok(m.a * m.d - m.b * m.c > 0, `${JSON.stringify(inh)} ${id}: reflection off → not mirrored`);
        }
      }
    }
  });

  it('root scaleY −1: with rotation inherited it is the up↕down mirror; without rotation the reflection is a left↔right mirror (documented)', () => {
    for (const inh of COMBOS.filter((c) => c.reflection)) {
      const plain = computeWorld(chain([1, 1], inh).bones), flipped = computeWorld(chain([1, -1], inh).bones);
      const arm = flipped.get('arm')!;
      if (inh.rotation) near(arm, F(plain.get('arm')!, 1, -1), 1e-9, JSON.stringify(inh));
      else assert.ok(arm.a * arm.d - arm.b * arm.c < 0, `${JSON.stringify(inh)}: still mirrored`);
    }
  });

  it('every combination equals the independent reference composition; default bones are bit-identical to world(parent) · local', () => {
    for (const inh of COMBOS)
      for (const rs of [[1, 1], [-1, 1], [1, -1], [-0.6, 1.3]] as [number, number][]) {
        const p = chain(rs, inh);
        const ours = computeWorld(p.bones), ref = worldsFromLocal(p, keyedLocal(p, null, 0));
        for (const b of p.bones) {
          const r = ref.get(b.id)!;
          near(ours.get(b.id)!, { a: r[0], b: r[1], c: r[2], d: r[3], tx: r[4], ty: r[5] }, 1e-9, `${JSON.stringify(inh)} root ${rs} ${b.name}`);
        }
      }
    const p = chain([1.2, 0.8], { rotation: true, scale: true, reflection: true });
    assert.equal(p.bones[2].inherit, undefined);
    const l = computeWorld(p.bones).get('arm')!;
    const viaRef = worldsFromLocal(p, keyedLocal(p, null, 0)).get('arm')!;
    assert.deepEqual([l.a, l.b, l.c, l.d, l.tx, l.ty], viaRef, 'bit-identical to the plain matrix chain');
  });
});

describe('constraints on flagged bones', () => {
  it('IK (bone 1 not inheriting scale or rotation), a path and an aim match the reference under a squashed, rotating, mirrored parent', () => {
    const p = project([
      makeBone('root', 'root', null, 0, 0, 0, 10),
      makeBone('hips', 'hips', 'root', 0, -60, 10, 20),
      makeBone('thigh', 'thigh', 'hips', 5, 0, 80, 50),
      makeBone('shin', 'shin', 'thigh', 50, 0, -15, 45),
      makeBone('tail', 'tail', 'hips', -10, 0, 160, 30),
      makeBone('flag', 'flag', 'hips', 10, -10, -30, 25),
    ]);
    p.bones[0].scaleX = -1;
    addIk(p, 'shin', true, { ik: 'leg', target: 'foot' });
    const path = addPath(p, 'arc', 'root', { x: -40, y: -30 }, 80);
    addPathConstraint(p, 'pc', path.id, ['tail']);
    addAimConstraint(p, 'aim', 'flag', null);
    setBoneInherit(p, 'thigh', { scale: false, rotation: false });
    setBoneInherit(p, 'tail', { rotation: false });
    setBoneInherit(p, 'flag', { scale: false, reflection: false });
    p.animations.push({
      id: 'a', name: 'a', duration: 1, fps: 30, loop: true,
      tracks: {
        hips: { translate: [], rotate: [k(0, [10]), k(0.5, [60], 'smooth'), k(1, [10])], scale: [k(0, [1, 1]), k(0.5, [1.3, 0.75]), k(1, [1, 1])] },
        foot: { translate: [k(0, [10, -5]), k(0.5, [30, -20]), k(1, [10, -5])], rotate: [], scale: [] },
      },
      constraints: { pc: { position: [k(0, [0]), k(1, [1])] } },
    });
    for (let f = 0; f <= 30; f += 3) {
      const t = f / 30, ours = evaluate(p, p.animations[0], t).world, ref = constrainedWorlds(p, p.animations[0], t);
      for (const b of p.bones) {
        const r = ref.get(b.id)!;
        near(ours.get(b.id)!, { a: r[0], b: r[1], c: r[2], d: r[3], tx: r[4], ty: r[5] }, 1e-7, `frame ${f} ${b.name}`);
      }
      const tip = apply(ours.get('shin')!, { x: 45, y: 0 }), tg = ours.get('foot')!;
      assert.ok(Math.hypot(tip.x - tg.tx, tip.y - tg.ty) < 1e-6, `frame ${f}: tip on target`);
      const fl = ours.get('flag')!;
      assert.ok(Math.abs(((deg(fl.a, fl.b) - p.transformConstraints![0].angle + 540) % 360) - 180) < 1e-9, `frame ${f}: aim held`);
    }
  });

  it('the second bone of an IK chain must inherit fully: refused by the op, addIk, the validator; repaired away', () => {
    const p = project([makeBone('a', 'a', null, 0, 0, 0, 40), makeBone('b', 'b', 'a', 40, 0, 0, 40)]);
    addIk(p, 'b', true, { ik: 'ik', target: 't' });
    assert.throws(() => setBoneInherit(p, 'b', { scale: false }), /second bone of an IK chain/);
    setBoneInherit(p, 'a', { scale: false }); // bone 1 is fine
    const q = project([makeBone('a', 'a', null, 0, 0, 0, 40), makeBone('b', 'b', 'a', 40, 0, 0, 40)]);
    q.bones[1].inherit = { rotation: true, scale: false, reflection: true };
    assert.equal(addIk(q, 'b', true, { ik: 'ik', target: 't' }), null);
    const o = JSON.parse(serializeProject(p));
    o.bones.find((b: any) => b.id === 'b').inherit = { rotation: false, scale: true, reflection: true };
    const r = parseProject(JSON.stringify(o));
    assert.equal(r.ok, false);
    assert.match((r as { errors: string[] }).errors.join('\n'), /second bone must inherit its parent's full transform/);
    p.bones[1].inherit = { rotation: false, scale: true, reflection: true };
    repairReferences(p);
    assert.equal(p.ik!.length, 0, 'an edit that breaks the rule drops the IK');
  });
});

describe('format, runtime, edits, Lottie', () => {
  it('flags are written only when off (v3); all-on objects are dropped; v2 files reject them; runtime v3 round-trips', () => {
    const p = project([makeBone('a', 'a', null, 0, 0, 0, 40), makeBone('b', 'b', 'a', 40, 0, 30, 40)]);
    p.bones[0].scaleX = 1.5;
    p.bones[1].inherit = { rotation: true, scale: true, reflection: true };
    assert.notEqual(requiredVersion(p), 3);
    assert.equal('inherit' in JSON.parse(serializeProject(p)).bones[1], false, 'default flags are not written');
    setBoneInherit(p, 'b', { scale: false });
    const text = serializeProject(p);
    const o = JSON.parse(text);
    assert.equal(o.version, 3);
    assert.deepEqual(o.bones[1].inherit, { rotation: true, scale: false, reflection: true });
    const back = parseProject(text);
    assert.ok(back.ok);
    assert.equal(serializeProject(back.project), text);
    const allOn = structuredClone(o);
    allOn.bones[1].inherit = { rotation: true, scale: true, reflection: true };
    const r = parseProject(JSON.stringify(allOn));
    assert.ok(r.ok);
    assert.equal(r.project.bones[1].inherit, undefined);
    const v2 = structuredClone(o);
    v2.version = 2;
    assert.match((parseProject(JSON.stringify(v2)) as { errors: string[] }).errors.join('\n'), /bone inherit flags requires project version 3/);
    const rt = exportRuntime(p);
    assert.equal(rt.version, 3);
    assert.deepEqual(rt.bones.find((b) => b.name === 'b')!.inherit, { rotation: true, scale: false, reflection: true });
    assert.equal('inherit' in rt.bones.find((b) => b.name === 'a')!, false);
    const loaded = loadRuntime(rt);
    near(computeWorld(loaded.bones).get('b')!, computeWorld(p.bones).get('b')!, 0, 'runtime load keeps the flags');
  });

  it('reparent, delete, pivot moves and flag changes keep flagged bones where they are on screen', () => {
    const rig = () => {
      const p = project([
        makeBone('a', 'a', null, 0, 0, 20, 40),
        makeBone('m', 'm', 'a', 40, 0, 30, 40),
        makeBone('b', 'b', 'm', 40, 0, -50, 40),
        makeBone('c', 'c', 'b', 40, 0, 10, 20),
      ]);
      Object.assign(p.bones[0], { scaleX: 1.3, scaleY: -0.7 });
      Object.assign(p.bones[1], { scaleX: 0.8, scaleY: 1.6 });
      setBoneInherit(p, 'b', { scale: false, rotation: false });
      return p;
    };
    const ops: [string, (p: Project) => void][] = [
      ['delete parent', (p) => deleteBone(p, 'm')],
      ['reparent to a', (p) => reparentBone(p, 'b', 'a', true)],
      ['reparent to root', (p) => reparentBone(p, 'b', null, true)],
      ['pivot move', (p) => moveBonePivot(p, 'm', 50, 10)],
      ['flag change', (p) => setBoneInherit(p, 'b', { reflection: false })],
    ];
    for (const [what, op] of ops) {
      const p = rig();
      const before = computeWorld(p.bones);
      op(p);
      const after = computeWorld(p.bones);
      // moveBonePivot rounds child positions to 1e-3 px (its documented setup rounding).
      for (const id of ['b', 'c']) near(after.get(id)!, before.get(id)!, what === 'pivot move' ? 2e-3 : 1e-9, `${what}: ${id}`);
    }
  });

  it('Lottie refuses bones with inherit flags', () => {
    const p = project([makeBone('a', 'a', null, 0, 0, 0, 40), makeBone('b', 'b', 'a', 40, 0, 0, 40)]);
    p.animations.push({ id: 'x', name: 'x', duration: 1, fps: 30, loop: true, tracks: {} });
    setBoneInherit(p, 'b', { rotation: false });
    assert.ok(lottieDiagnostics(p, p.animations[0]).some((d) => d.feature === 'inherit flags' && d.level === 'error'));
  });
});

describe('CLI inherit (subprocess, no browser)', () => {
  const OUT = path.join(EVIDENCE, 'roadmap/r3-inherit');
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const IN = path.join(OUT, 'in.rig.json');
  const p = project([makeBone('hips', 'hips', null, 0, 0, 0, 20), makeBone('thigh', 'thigh', 'hips', 0, 0, 90, 50), makeBone('shin', 'shin', 'thigh', 50, 0, 0, 50)]);
  p.bones[0].scaleY = 0.85;
  addIk(p, 'shin', true, { ik: 'leg', target: 'foot' });
  writeFileSync(IN, serializeProject(p));
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), ...args], { cwd: ROOT, encoding: 'utf8' });
    return { code: r.status, json: JSON.parse(r.stdout) };
  };
  it('sets flags (v3 file, setup placement kept) and turns them back on (back to v2)', () => {
    const a = path.join(OUT, 'a.rig.json'), b = path.join(OUT, 'b.rig.json');
    let r = cli('inherit', IN, '--bone', 'thigh', '--scale', 'off', '--out', a);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.deepEqual(r.json.inherit, { rotation: true, scale: false, reflection: true });
    const pa = parseProject(readFileSync(a, 'utf8'));
    assert.ok(pa.ok);
    assert.equal(JSON.parse(readFileSync(a, 'utf8')).version, 3);
    near(computeWorld(pa.project.bones).get('thigh')!, computeWorld(p.bones).get('thigh')!, 1e-9, 'placement kept');
    r = cli('inherit', a, '--bone', 'thigh', '--scale', 'on', '--out', b);
    assert.equal(r.code, 0);
    assert.notEqual(JSON.parse(readFileSync(b, 'utf8')).version, 3);
  });
  it('usage errors exit 2, refused changes exit 1, nothing written', () => {
    const bad = path.join(OUT, 'never.rig.json');
    const cases: [string[], number, RegExp][] = [
      [['inherit', IN, '--bone', 'thigh', '--out', bad], 2, /at least one/],
      [['inherit', IN, '--bone', 'thigh', '--scale', 'no', '--out', bad], 2, /on or off/],
      [['inherit', IN, '--bone', 'nope', '--scale', 'off', '--out', bad], 1, /No bone named/],
      [['inherit', IN, '--bone', 'shin', '--rotation', 'off', '--out', bad], 1, /second bone of an IK chain/],
    ];
    for (const [args, code, msg] of cases) {
      const r = cli(...args);
      assert.equal(r.code, code, `${args.join(' ')} → ${JSON.stringify(r.json)}`);
      assert.match(r.json.error + ' ' + (r.json.errors ?? []).join(' '), msg);
    }
    assert.equal(existsSync(bad), false);
  });
});
