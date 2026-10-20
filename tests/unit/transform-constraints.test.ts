// R2 transform constraints (rotation fraction with mitre scale, aim): the solver against
// the independent reference (tests/support/reference-constraints.ts), the v3 format and
// runtime gates, repairs, mixing, import and Lottie handling, and the showcase 2
// acceptance: half-angle joint helpers and the whisk aim with zero baked keys.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { setKey } from '../../src/model/animation.ts';
import { importAnimations, defaultMapping } from '../../src/model/animImport.ts';
import { evaluate } from '../../src/model/evaluate.ts';
import { exportRuntime } from '../../src/model/exportRuntime.ts';
import { parseProject, requiredVersion, serializeProject, v3Features } from '../../src/model/format.ts';
import { repairReferences } from '../../src/model/integrity.ts';
import { lottieDiagnostics } from '../../src/model/lottie.ts';
import { angleOf } from '../../src/model/math.ts';
import { evaluateMix } from '../../src/model/mix.ts';
import { makeBone } from '../../src/model/ops.ts';
import { addAimConstraint, addIk, addRotationConstraint, deleteConstraint, keyConstraint } from '../../src/model/rigOps.ts';
import { deleteBone } from '../../src/model/skeleton.ts';
import type { Animation, Key, Project } from '../../src/model/types.ts';
import { FORMAT_ID } from '../../src/model/types.ts';
import { loadRuntime } from '../../src/runtime/load.ts';
import { EVIDENCE, ROOT } from '../e2e/harness.ts';
import { constrainedWorlds, mixFrame } from '../support/reference-constraints.ts';

const k = (time: number, value: number[], interp: Key['interp'] = 'linear'): Key => ({ time, value, interp });
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** shoulder → upper → lower → hand (+ prop); a joint helper beside lower; a non-uniformly scaled, mirrored body. */
function armRig(mirrored = true): Project {
  const p: Project = {
    format: FORMAT_ID, version: 2, name: 'arm',
    bones: [
      makeBone('root', 'root', null, 0, 0, 0, 10),
      makeBone('body', 'body', 'root', 10, 5, 15, 40),
      makeBone('upper', 'upper', 'body', 40, 0, 30, 60),
      makeBone('lower', 'lower', 'upper', 60, 0, 40, 50),
      makeBone('helper', 'helper', 'upper', 60, 0, 0, 8),
      makeBone('hand', 'hand', 'lower', 50, 0, -10, 15),
      makeBone('prop', 'prop', 'hand', 15, 0, 25, 40),
    ],
    images: [], attachments: [], animations: [],
  };
  const body = p.bones.find((b) => b.id === 'body')!;
  if (mirrored) {
    body.scaleX = 1.3;
    body.scaleY = -0.8; // mirrored and non-uniform
  }
  return p;
}

function wave(): Animation {
  return {
    id: 'wave', name: 'wave', duration: 2, fps: 30, loop: true,
    tracks: {
      root: { translate: [], rotate: [k(0, [0]), k(1, [200], 'smooth'), k(2, [360])], scale: [] },
      upper: { translate: [], rotate: [k(0, [30]), k(1, [-60], 'smooth'), k(2, [30])], scale: [] },
      lower: { translate: [], rotate: [k(0, [40]), k(0.7, [150]), k(1.4, [-120]), k(2, [40])], scale: [] },
      hand: { translate: [], rotate: [k(0, [-10]), k(1, [70]), k(2, [-10])], scale: [k(0, [1, 1]), k(1, [-0.9, 1.2]), k(2, [1, 1])] },
    },
  };
}

function constrained(): Project {
  const p = armRig();
  p.animations.push(wave());
  const r = addRotationConstraint(p, 'tc_half', 'helper', 'lower', 0.5)!;
  r.mitre = { k: 0.7, max: 2.2 };
  addAimConstraint(p, 'tc_aim', 'prop', 'root');
  const an = p.animations[0];
  keyConstraint(an, 'tc_aim', 'angle', 0, -75);
  keyConstraint(an, 'tc_aim', 'angle', 1, -40);
  keyConstraint(an, 'tc_aim', 'mix', 1.5, 1);
  keyConstraint(an, 'tc_aim', 'mix', 2, 0.25);
  return p;
}

function maxWorldGap(p: Project, anim: Animation | null, t: number): number {
  const ours = evaluate(p, anim, t).world;
  const ref = constrainedWorlds(p, anim, t);
  let gap = 0;
  for (const b of p.bones) {
    const m = ours.get(b.id)!, r = ref.get(b.id)!;
    gap = Math.max(gap, Math.abs(m.a - r[0]), Math.abs(m.b - r[1]), Math.abs(m.c - r[2]), Math.abs(m.d - r[3]), Math.abs(m.tx - r[4]) / 100, Math.abs(m.ty - r[5]) / 100);
  }
  return gap;
}

describe('transform constraints: solver', () => {
  it('matches the independent reference on a mirrored, non-uniformly scaled rig at every frame', () => {
    const p = constrained();
    const an = p.animations[0];
    let worst = 0;
    for (let f = 0; f <= 60; f++) worst = Math.max(worst, maxWorldGap(p, an, f / 30));
    assert.ok(worst < 1e-9, `max matrix gap ${worst}`);
  });

  it('rotation: local rotation = offset + factor × bend; mitre scale Y = min(max, 1 + (sec(bend/2) − 1)·k)', () => {
    const p = armRig(false);
    p.transformConstraints = [{ id: 'h', name: 'h', kind: 'rotation', bone: 'helper', source: 'lower', factor: 0.5, angle: 3, mitre: { k: 0.7, max: 2.2 }, mix: 1 }];
    for (const bend of [0, 40, 120, 179, -150]) {
      p.bones.find((b) => b.id === 'lower')!.rotation = bend;
      const w = evaluate(p, null, 0).world;
      const helperLocal = wrap(angleOf(w.get('helper')!) - angleOf(w.get('upper')!));
      const m = w.get('upper')!;
      const expect = 3 + 0.5 * bend;
      assert.ok(Math.abs(wrap(helperLocal - expect)) < 1e-9, `bend ${bend}: helper local ${helperLocal} vs ${expect}`);
      const sy = Math.hypot(w.get('helper')!.c, w.get('helper')!.d) / Math.hypot(m.c, m.d);
      const mitre = Math.min(2.2, 1 + (1 / Math.cos((Math.abs(bend) * Math.PI) / 360) - 1) * 0.7);
      assert.ok(Math.abs(sy - mitre) < 1e-9, `bend ${bend}: scaleY ${sy} vs ${mitre}`);
    }
  });

  it('aim holds the screen angle (relative to the reference bone) whatever the parents do; mix 0 leaves the keys', () => {
    const p = armRig();
    p.animations.push(wave());
    p.transformConstraints = [{ id: 'a', name: 'a', kind: 'aim', bone: 'prop', relativeTo: null, factor: 1, angle: -75, mix: 1 }];
    for (const t of [0, 0.3, 0.9, 1.6]) {
      const w = evaluate(p, p.animations[0], t).world.get('prop')!;
      // prop has no own flip; hand's keyed scaleX may be negative, which the solver undoes through the parent.
      assert.ok(Math.abs(wrap(angleOf(w) - -75)) < 1e-9, `t=${t}: ${angleOf(w)}`);
    }
    p.transformConstraints[0].relativeTo = 'root';
    for (const t of [0.4, 1.2]) {
      const w = evaluate(p, p.animations[0], t).world;
      assert.ok(Math.abs(wrap(angleOf(w.get('prop')!) - angleOf(w.get('root')!) - -75)) < 1e-9);
    }
    p.transformConstraints[0].mix = 0;
    const keyed = evaluate(p, p.animations[0], 0.4, { constraints: false }).world.get('prop')!;
    assert.deepEqual(evaluate(p, p.animations[0], 0.4).world.get('prop'), keyed);
  });

  it('adding either constraint leaves the setup pose where it was', () => {
    const p = armRig();
    const before = evaluate(p, null, 0).world;
    p.bones.find((b) => b.id === 'helper')!.rotation = 17;
    const before2 = evaluate(p, null, 0).world;
    addRotationConstraint(p, 'r', 'helper', 'lower', 0.5);
    addAimConstraint(p, 'a', 'prop', 'root');
    const after = evaluate(p, null, 0).world;
    for (const id of ['helper', 'prop']) {
      const a = after.get(id)!, b = (id === 'helper' ? before2 : before).get(id)!;
      for (const ch of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) assert.ok(Math.abs(a[ch] - b[ch]) < 1e-9, `${id}.${ch}`);
    }
    assert.equal(addRotationConstraint(p, 'x', 'helper', 'helper'), null, 'a bone cannot copy itself');
    assert.equal(addAimConstraint(p, 'y', 'prop', 'prop'), null);
    assert.deepEqual(p.transformConstraints!.map((t) => t.name), ['helper-rotation', 'prop-aim']);
  });

  it('runs after IK: a knee helper follows the IK-solved bend', () => {
    const p = armRig(false);
    const ik = addIk(p, 'lower', true, { ik: 'ik', target: 'tgt' })!;
    p.transformConstraints = [{ id: 'h', name: 'h', kind: 'rotation', bone: 'helper', source: 'lower', factor: 0.5, angle: 0, mix: 1 }];
    const tgt = p.bones.find((b) => b.id === ik.target)!;
    assert.equal(tgt.parentId, 'root');
    const sh = evaluate(p, null, 0, { constraints: false }).world.get('upper')!;
    // Pull the target halfway to the shoulder: the chain must fold.
    tgt.x = (tgt.x + sh.tx) / 2;
    tgt.y = (tgt.y + sh.ty) / 2;
    assert.ok(maxWorldGap(p, null, 0) < 1e-9);
    const w = evaluate(p, null, 0).world;
    const bend = wrap(angleOf(w.get('lower')!) - angleOf(w.get('upper')!));
    const helper = wrap(angleOf(w.get('helper')!) - angleOf(w.get('upper')!));
    assert.ok(Math.abs(bend) > 5, 'IK changed the bend');
    assert.ok(Math.abs(helper - bend / 2) < 1e-9, `${helper} vs ${bend}/2`);
  });
});

describe('transform constraints: format v3 and runtime v3', () => {
  it('a rig without them stays v2 (file and runtime); with them it is written as v3 and round-trips', () => {
    const plain = armRig();
    plain.animations.push(wave());
    assert.notEqual(requiredVersion(plain), 3);
    assert.equal(exportRuntime(plain).version, 2);
    assert.equal('transformConstraints' in exportRuntime(plain), false);
    const p = constrained();
    assert.deepEqual(v3Features(p), ['transform constraints', 'constraint angle keys']);
    const text = serializeProject(p);
    assert.equal(JSON.parse(text).version, 3);
    const back = parseProject(text);
    assert.ok(back.ok, back.ok ? '' : back.errors.join('\n'));
    assert.equal(serializeProject(back.project), text, 'lossless');
    const rt = exportRuntime(p);
    assert.equal(rt.version, 3);
    assert.deepEqual(rt.transformConstraints!.map((c) => [c.name, c.kind, c.bone]), [['helper-rotation', 'rotation', 'helper'], ['prop-aim', 'aim', 'prop']]);
    assert.ok(rt.animations[0].constraints['prop-aim'].angle!.length === 2);
    const loaded = loadRuntime(rt);
    for (let f = 0; f <= 60; f += 7) {
      const a = evaluate(p, p.animations[0], f / 30).world, b = evaluate(loaded, loaded.animations[0], f / 30).world;
      for (const bone of p.bones) assert.ok(Math.abs(angleOf(a.get(bone.id)!) - angleOf(b.get(bone.name)!)) < 1e-9);
    }
  });

  it('the validator rejects v3 data in a v2 file and malformed constraints', () => {
    const good = JSON.parse(serializeProject(constrained()));
    const bad: [string, (o: any) => void, RegExp][] = [
      ['v2 file', (o) => (o.version = 2), /transformConstraints requires project version 3/],
      ['bad kind', (o) => (o.transformConstraints[0].kind = 'scale'), /kind must be "rotation" or "aim"/],
      ['missing source', (o) => (o.transformConstraints[0].source = 'nope'), /missing source bone "nope"/],
      ['self source', (o) => (o.transformConstraints[0].source = 'helper'), /cannot copy its own rotation/],
      ['mitre max', (o) => (o.transformConstraints[0].mitre.max = 0.5), /mitre.max must be at least 1/],
      ['aim self', (o) => (o.transformConstraints[1].relativeTo = 'prop'), /cannot aim relative to itself/],
      ['duplicate id', (o) => (o.transformConstraints[1].id = 'tc_half'), /duplicated/],
      ['mix', (o) => (o.transformConstraints[1].mix = 2), /mix must be between 0 and 1/],
    ];
    for (const [what, f, msg] of bad) {
      const o = structuredClone(good);
      f(o);
      const r = parseProject(JSON.stringify(o));
      assert.equal(r.ok, false, what);
      assert.match((r as { errors: string[] }).errors.join('\n'), msg, what);
    }
    const o = structuredClone(good);
    delete o.transformConstraints;
    o.version = 2;
    o.animations[0].constraints = { };
    assert.ok(parseProject(JSON.stringify(o)).ok, 'without them a v2 file is fine');
  });
});

describe('transform constraints: edits, mixing, import, Lottie', () => {
  it('deleting the source bone removes the constraint and its keys; a deleted aim reference falls back to the screen', () => {
    const p = constrained();
    deleteBone(p, 'lower'); // the rotation constraint's source
    const notes = repairReferences(p);
    assert.deepEqual(p.transformConstraints!.map((t) => t.id), ['tc_aim'], 'the rotation constraint is removed, the aim stays');
    assert.ok(notes.some((n) => /transform constraint/.test(n)), notes.join('\n'));
    assert.equal(p.animations[0].constraints?.tc_half, undefined);
    const r = constrained();
    r.transformConstraints![1].relativeTo = 'body';
    r.bones = r.bones.filter((b) => b.id !== 'body').map((b) => (b.parentId === 'body' ? { ...b, parentId: 'root' } : b));
    repairReferences(r);
    assert.equal(r.transformConstraints!.find((t) => t.id === 'tc_aim')!.relativeTo, null);
    deleteConstraint(r, 'tc_aim');
    assert.equal(r.animations[0].constraints?.tc_aim, undefined, 'its keys go with it');
  });

  it('a mix blends the angle keys along the chain like the reference', () => {
    const p = constrained();
    const b: Animation = { id: 'still', name: 'still', duration: 1, fps: 30, loop: true, tracks: {}, constraints: { tc_aim: { angle: [k(0, [20])] } } };
    p.animations.push(b);
    const plan = { entries: [{ animId: 'wave', start: 0, mix: 0 }, { animId: 'still', start: 0.5, mix: 0.6 }], missing: 'setup' as const };
    for (const T of [0.4, 0.7, 0.9, 1.3]) {
      const ours = evaluateMix(p, plan as any, T).world;
      const ref = mixFrame(p, [{ anim: p.animations[0], start: 0, mix: 0 }, { anim: b, start: 0.5, mix: 0.6 }], T, 'setup').worlds;
      for (const bone of p.bones) assert.ok(Math.abs(wrap(angleOf(ours.get(bone.id)!) - Math.atan2(ref.get(bone.id)![1], ref.get(bone.id)![0]) * 180 / Math.PI)) < 1e-9, `${bone.name} at ${T}`);
    }
  });

  it('import drops angle keys aimed at a non-transform constraint; Lottie refuses the constraint', () => {
    const src = constrained();
    const dst = armRig();
    dst.animations = [];
    addIk(dst, 'lower', true, { ik: 'tc_aim_ik', target: 't' });
    dst.ik![0].name = 'prop-aim'; // same name, different kind
    const map = defaultMapping(src, dst, ['wave']);
    assert.equal(map.constraints.tc_aim, null, 'the default mapping never pairs different kinds');
    map.constraints.tc_aim = 'tc_aim_ik'; // mapped by hand in the dialog
    const r = importAnimations(dst, src, ['wave'], map, {});
    assert.ok(r.dropped.some((d) => /angle key\(s\)/.test(d)), r.dropped.join('\n'));
    const diag = lottieDiagnostics(src, src.animations[0]);
    assert.ok(diag.some((d) => d.feature === 'transform constraint' && d.level === 'error'));
  });
});

describe('showcase 2 acceptance: constraints replace the per-frame bakes', () => {
  const FIX = path.resolve(import.meta.dirname, '../fixtures/showcase2-limbs.rig.json');
  const load = () => {
    const r = parseProject(readFileSync(FIX, 'utf8'));
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    return r.project;
  };
  const id = (p: Project, n: string) => p.bones.find((b) => b.name === n)!.id;

  it('rotation constraints (0.5 × bend, mitre elbow 0.7 / knee 1, max 1.5 as in v2) reproduce halfAngles() with zero baked keys', () => {
    const baked = load();
    const p = load();
    p.transformConstraints = [];
    for (const s of ['l', 'r'])
      for (const [helper, , child, k] of [[`elbow_${s}`, `upper_arm_${s}`, `lower_arm_${s}`, 0.7], [`knee_${s}`, `thigh_${s}`, `shin_${s}`, 1]] as const) {
        p.transformConstraints.push({ id: `tc_${helper}`, name: `${helper}-half`, kind: 'rotation', bone: id(p, helper), source: id(p, child), factor: 0.5, angle: 0, mitre: { k, max: 1.5 }, mix: 1 });
        for (const an of p.animations) delete an.tracks[id(p, helper)];
      }
    let worstRot = 0, worstScale = 0, frames = 0;
    for (let ai = 0; ai < p.animations.length; ai++) {
      const an = p.animations[ai], bn = baked.animations[ai];
      for (let f = 0; f <= Math.round(an.duration * an.fps); f++) {
        const t = f / an.fps;
        const ours = evaluate(p, an, t).world, ref = evaluate(baked, bn, t).world;
        for (const tc of p.transformConstraints) {
          const parent = p.bones.find((b) => b.id === tc.bone)!.parentId!;
          const rot = (w: Map<string, any>) => wrap(angleOf(w.get(tc.bone)) - angleOf(w.get(parent)));
          worstRot = Math.max(worstRot, Math.abs(wrap(rot(ours) - rot(ref))));
          const sy = (w: Map<string, any>) => Math.hypot(w.get(tc.bone).c, w.get(tc.bone).d) / Math.hypot(w.get(parent).c, w.get(parent).d);
          worstScale = Math.max(worstScale, Math.abs(sy(ours) - sy(ref)));
        }
        frames++;
      }
    }
    // halfAngles() rounds its keys to 1e-3 (rotation 0.5·bend → ±5e-4°, scale ±5e-4).
    assert.ok(worstRot <= 5.01e-4, `rotation gap ${worstRot}°`);
    assert.ok(worstScale <= 5.01e-4, `scale gap ${worstScale}`);
    assert.ok(frames > 300);
  });

  it('an aim constraint (keyed smooth angle, relative to root) reproduces aim() with zero baked keys', () => {
    const p = load();
    const an = p.animations.find((a) => a.name === 'celebrate')!; // includes the somersault
    const n = Math.round(an.duration * an.fps);
    const keys: [number, number][] = [[0, -75], [40, -40], [90, -110], [n, -75]];
    // aim() pass 1–3 with no clearance offset: A = smoothstep-eased key angle + unwrapped root angle; local = A − hand angle.
    const whisk = id(p, 'whisk'), hand = id(p, 'hand_l'), root = id(p, 'root');
    const at = (f: number) => {
      let i = 0;
      while (i < keys.length - 1 && keys[i + 1][0] <= f) i++;
      if (i >= keys.length - 1) return keys[keys.length - 1][1];
      const [f0, a0] = keys[i], [f1, a1] = keys[i + 1];
      const t = (f - f0) / (f1 - f0), s = t * t * (3 - 2 * t);
      return a0 + (a1 - a0) * s;
    };
    const bakedP = load();
    const bakedAn = bakedP.animations.find((a) => a.name === 'celebrate')!;
    bakedAn.tracks[whisk] = { translate: bakedAn.tracks[whisk]?.translate ?? [], rotate: [], scale: bakedAn.tracks[whisk]?.scale ?? [] };
    let rootPrev = 0, rootAcc = 0, prev: number | null = null;
    for (let f = 0; f <= n; f++) {
      const fr = evaluate(bakedP, bakedAn, f / an.fps);
      const ra = angleOf(fr.world.get(root)!);
      rootAcc += wrap(ra - rootPrev);
      rootPrev = ra;
      let local = at(f) + rootAcc - angleOf(fr.world.get(hand)!);
      if (prev !== null) while (local - prev > 180) local -= 360;
      if (prev !== null) while (local - prev < -180) local += 360;
      prev = local;
      setKey(bakedAn.tracks[whisk].rotate, f / an.fps, [Math.round(local * 1000) / 1000], 'linear');
    }
    // The constraint: no whisk rotate keys, angle keyed with 'smooth' (= smoothstep) at the same frames.
    p.transformConstraints = [{ id: 'tc_whisk', name: 'whisk-aim', kind: 'aim', bone: whisk, relativeTo: root, factor: 1, angle: -75, mix: 1 }];
    an.tracks[whisk] = { translate: an.tracks[whisk]?.translate ?? [], rotate: [], scale: an.tracks[whisk]?.scale ?? [] };
    an.constraints = { tc_whisk: { angle: keys.map(([f, a]) => k(f / an.fps, [a], 'smooth')) } };
    let worst = 0;
    for (let f = 0; f <= n; f++) {
      const a = evaluate(p, an, f / an.fps).world.get(whisk)!, b = evaluate(bakedP, bakedAn, f / an.fps).world.get(whisk)!;
      worst = Math.max(worst, Math.abs(wrap(angleOf(a) - angleOf(b))));
    }
    assert.ok(worst <= 5.01e-4, `whisk world angle gap ${worst}° (aim() rounds its keys to 1e-3)`);
    assert.equal(requiredVersion(p), 3);
  });
});

describe('CLI constrain (subprocess, no browser)', () => {
  const OUT = path.join(EVIDENCE, 'roadmap/r2-constraints');
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const IN = path.resolve(import.meta.dirname, '../fixtures/showcase2-limbs.rig.json');
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), ...args], { cwd: ROOT, encoding: 'utf8' });
    return { code: r.status, json: JSON.parse(r.stdout) };
  };
  it('adds a mitred half-angle helper and a held aim; the file becomes v3', () => {
    const a = path.join(OUT, 'a.rig.json'), b = path.join(OUT, 'b.rig.json');
    let r = cli('constrain', IN, '--bone', 'elbow_l', '--copy-rotation', 'lower_arm_l', '--factor', '0.5', '--mitre', '0.7:1.5', '--name', 'elbow_l-half', '--out', a);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.deepEqual(r.json.constraint, { name: 'elbow_l-half', kind: 'rotation', angle: 0 });
    r = cli('constrain', a, '--bone', 'whisk', '--aim', 'hold', '--relative-to', 'root', '--mix', '0.8', '--out', b);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    const p = JSON.parse(readFileSync(b, 'utf8'));
    assert.equal(p.version, 3);
    const byName = (n: string) => p.bones.find((x: any) => x.name === n).id;
    assert.deepEqual(p.transformConstraints[0], { id: p.transformConstraints[0].id, name: 'elbow_l-half', kind: 'rotation', bone: byName('elbow_l'), factor: 0.5, angle: 0, mix: 1, source: byName('lower_arm_l'), mitre: { k: 0.7, max: 1.5 } });
    assert.equal(p.transformConstraints[1].kind, 'aim');
    assert.equal(p.transformConstraints[1].relativeTo, byName('root'));
    assert.equal(p.transformConstraints[1].mix, 0.8);
    // "hold" keeps the setup pose where it was.
    const q = parseProject(readFileSync(b, 'utf8'));
    assert.ok(q.ok);
    const held = evaluate(q.project, null, 0).world.get(byName('whisk'))!;
    const free = evaluate(q.project, null, 0, { constraints: false }).world.get(byName('whisk'))!;
    assert.ok(Math.abs(wrap(angleOf(held) - angleOf(free))) < 1e-9);
  });
  it('usage errors exit 2, invalid requests exit 1, nothing written', () => {
    const bad = path.join(OUT, 'never.rig.json');
    const cases: [string[], number, RegExp][] = [
      [['constrain', IN, '--bone', 'elbow_l', '--out', bad], 2, /exactly one of/],
      [['constrain', IN, '--bone', 'elbow_l', '--copy-rotation', 'x', '--aim', '3', '--out', bad], 2, /exactly one of/],
      [['constrain', IN, '--bone', 'elbow_l', '--copy-rotation', 'lower_arm_l', '--mitre', '1', '--out', bad], 2, /--mitre/],
      [['constrain', IN, '--bone', 'whisk', '--aim', 'up', '--out', bad], 2, /--aim/],
      [['constrain', IN, '--bone', 'nope', '--aim', '3', '--out', bad], 1, /No bone named/],
      [['constrain', IN, '--bone', 'elbow_l', '--copy-rotation', 'elbow_l', '--out', bad], 1, /own rotation/],
      [['constrain', IN, '--bone', 'whisk', '--aim', '3', '--mix', '2', '--out', bad], 1, /--mix/],
      [['constrain', IN, '--bone', 'elbow_l', '--copy-rotation', 'lower_arm_l', '--mitre', '1:0.5', '--out', bad], 1, /--mitre/],
      [['constrain', IN, '--bone', 'whisk', '--aim', '3', '--name', 'leg_l_ik', '--out', bad], 1, /already exists/],
    ];
    for (const [args, code, msg] of cases) {
      const r = cli(...args);
      assert.equal(r.code, code, `${args.join(' ')} → ${JSON.stringify(r.json)}`);
      assert.match(r.json.error + ' ' + (r.json.errors ?? []).join(' '), msg);
    }
    assert.equal(existsSync(bad), false);
  });
});
