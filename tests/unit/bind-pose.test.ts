// R5: a mesh bind pose separate from the setup pose, and an explicit IK bend side.
// Showcase 2's L7 (a setup bend never bends the tail: weights rebind to the setup) and
// L16 (addIk infers the bend from a straight setup → always positive), the independent
// reference skinning (tests/support/reference-composite.ts), format v3, integrity,
// runtime, weight tools in the bind frame, and the CLI (`bind`, `ik`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { evaluate } from '../../src/model/evaluate.ts';
import { exportRuntime } from '../../src/model/exportRuntime.ts';
import { parseProject, requiredVersion, serializeProject, v3Features } from '../../src/model/format.ts';
import { repairReferences } from '../../src/model/integrity.ts';
import { limbWeights } from '../../src/model/limbWeights.ts';
import { apply } from '../../src/model/math.ts';
import { localVertex, toMat } from '../../src/model/mesh.ts';
import { autoWeights, bindMesh, gridPoints, setupVertices, triangulate } from '../../src/model/meshOps.ts';
import { makeBone } from '../../src/model/ops.ts';
import { addIk } from '../../src/model/rigOps.ts';
import { computeWorld, deleteBone } from '../../src/model/skeleton.ts';
import type { Key, Project } from '../../src/model/types.ts';
import { FORMAT_ID } from '../../src/model/types.ts';
import { loadRuntime } from '../../src/runtime/load.ts';
import { EVIDENCE, ROOT } from '../e2e/harness.ts';
import type { M } from '../support/reference-composite.ts';
import { boneWorlds, meshScreenVertices } from '../support/reference-composite.ts';

const k = (time: number, value: number[]): Key => ({ time, value, interp: 'linear' });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ID: M = [1, 0, 0, 1, 0, 0];

/** A straight three-bone tail with a 150×30 band mesh skinned along it (drawn straight). */
function tail(): Project {
  const g = gridPoints(150, 30, 10, 2);
  const mesh = triangulate(g.hull, g.interior);
  const p: Project = {
    format: FORMAT_ID, version: 2, name: 'tail',
    bones: [makeBone('root', 'root', null, 0, 0, 0, 10), makeBone('t1', 'tail1', 'root', 10, 0, 0, 50), makeBone('t2', 'tail2', 't1', 50, 0, 0, 50), makeBone('t3', 'tail3', 't2', 50, 0, 0, 50)],
    images: [{ id: 'i1', name: 'tail.png', mime: 'image/png', width: 150, height: 30, dataUrl: PNG }],
    attachments: [{ id: 'a_tail', name: 'tail', boneId: 't1', imageId: 'i1', x: 75, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, mesh }],
    animations: [{ id: 'curl', name: 'curl', duration: 1, fps: 30, loop: true, tracks: { t2: { translate: [], rotate: [k(0, [25])], scale: [] }, t3: { translate: [], rotate: [k(0, [40]), k(1, [10])], scale: [] } } }],
  };
  p.attachments[0].mesh!.weights = autoWeights(p, p.attachments[0], ['t1', 't2', 't3']);
  return p;
}

const verts = (p: Project, anim: string | null = null, t = 0) => evaluate(p, anim ? p.animations.find((a) => a.id === anim)! : null, t).attachments.find((a) => a.att.id === 'a_tail')!.vertices!;
const maxMove = (a: number[], b: number[]) => Math.max(...a.map((_, i) => (i % 2 ? 0 : Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1]))));
const roundTrip = (p: Project) => {
  const r = parseProject(serializeProject(p));
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  return (r as { project: Project }).project;
};

describe('bind pose (L7)', () => {
  it('unbound: a setup bend leaves the tail unbent (L7 = 0); bound at setup: the same bend bends it', () => {
    const p = tail();
    const v0 = verts(p);
    p.bones[3].rotation += 30;
    assert.equal(maxMove(verts(p), v0), 0, 'L7_setup_bend_moves_tail_vertices_px = 0 without a bind pose');
    const q = tail();
    bindMesh(q.attachments[0], computeWorld(q.bones));
    assert.ok(maxMove(verts(q), v0) < 1e-9, 'binding at the setup pose changes nothing by itself');
    q.bones[3].rotation += 30;
    const moved = maxMove(verts(q), v0);
    assert.ok(moved > 20, `after rebind-at-pose the setup bend moves the tail (${moved.toFixed(2)} px)`);
  });

  it('bound in pose P, the mesh is the undistorted image whenever the bones are in P (setup = P)', () => {
    const p = tail();
    const P = evaluate(p, p.animations[0], 0).world;
    bindMesh(p.attachments[0], P);
    const im = p.images[0];
    const bindA = toMat(p.attachments[0].mesh!.bind!.attachment);
    const flat = (): number[] => {
      const out: number[] = [];
      for (let i = 0; i < p.attachments[0].mesh!.points.length / 2; i++) {
        const q = apply(bindA, localVertex(p.attachments[0].mesh!.points, i, im));
        out.push(q.x, q.y);
      }
      return out;
    };
    assert.ok(maxMove(verts(p, 'curl', 0), flat()) < 1e-9, 'at frame 0 (= P) the image is undistorted');
    assert.ok(maxMove(verts(p), flat()) > 20, 'the straight setup now bends the curled art straight');
    p.bones[2].rotation = 25;
    p.bones[3].rotation = 40;
    assert.ok(maxMove(verts(p), flat()) < 1e-9, 'setup = P: undistorted at the setup pose');
    assert.deepEqual(setupVertices(p, p.attachments[0]).flatMap((v) => [v.x, v.y]).map((x) => +x.toFixed(9)), flat().map((x) => +x.toFixed(9)), 'weight tools see the bind-pose geometry');
  });

  it('matches the independent reference skinning at every frame, bound and unbound', () => {
    for (const bound of [false, true]) {
      const p = tail();
      if (bound) bindMesh(p.attachments[0], evaluate(p, p.animations[0], 0.5).world);
      p.bones[2].rotation = 10;
      const anim = p.animations[0];
      const setup = boneWorlds(p, null, 0);
      for (let f = 0; f <= 30; f += 3) {
        const ours = verts(p, 'curl', f / 30);
        const ref = meshScreenVertices(p.attachments[0], undefined, f / 30, p, boneWorlds(p, anim, f / 30), setup, ID);
        assert.ok(maxMove(ours, ref) < 1e-9, `${bound ? 'bound' : 'unbound'} frame ${f}`);
      }
    }
  });

  it('weight tools work in the bind frame: weights after binding at P equal weights of an unbound rig whose setup is P', () => {
    const p = tail();
    bindMesh(p.attachments[0], evaluate(p, p.animations[0], 0).world);
    const q = tail();
    q.bones[2].rotation = 25;
    q.bones[3].rotation = 40;
    assert.deepEqual(autoWeights(p, p.attachments[0], ['t1', 't2', 't3']), autoWeights(q, q.attachments[0], ['t1', 't2', 't3']));
    const spec = { upper: 't1', lower: 't2', band: { inner: 6, outer: 12, side: 1 as const } };
    assert.deepEqual(limbWeights(p, p.attachments[0], spec), limbWeights(q, q.attachments[0], spec));
  });
});

describe('bind pose: format, integrity, runtime', () => {
  it('v3 only when bound; round-trips; the validator rejects a bind in v2, without weights, singular, or on a missing bone', () => {
    assert.deepEqual(v3Features(tail()), []);
    const p = tail();
    bindMesh(p.attachments[0], evaluate(p, p.animations[0], 0).world);
    assert.deepEqual(v3Features(p), ['mesh bind poses']);
    assert.equal(requiredVersion(p), 3);
    const q = roundTrip(p);
    assert.deepEqual(q.attachments[0].mesh!.bind, p.attachments[0].mesh!.bind);
    assert.equal(serializeProject(q), serializeProject(p));
    const bad = (mut: (raw: any) => void, re: RegExp) => {
      const raw = JSON.parse(serializeProject(p));
      mut(raw);
      const r = parseProject(JSON.stringify(raw));
      assert.ok(!r.ok && r.errors.some((e) => re.test(e)), `${re}: ${!r.ok && r.errors.join(' | ')}`);
    };
    bad((r) => void (r.version = 2), /bind requires project version 3/);
    bad((r) => void delete r.attachments[0].mesh.weights, /bind needs weights/);
    bad((r) => void (r.attachments[0].mesh.bind.attachment = [1, 0, 2, 0, 0, 0]), /invertible matrix/);
    bad((r) => void (r.attachments[0].mesh.bind.bones.ghost = [1, 0, 0, 1, 0, 0]), /missing bone "ghost"/);
  });

  it('integrity: deleting a bone drops its bind entry; removing the weights drops the bind', () => {
    const p = tail();
    bindMesh(p.attachments[0], computeWorld(p.bones));
    assert.deepEqual(Object.keys(p.attachments[0].mesh!.bind!.bones).sort(), ['t1', 't2', 't3']);
    deleteBone(p, 't3');
    repairReferences(p);
    assert.deepEqual(Object.keys(p.attachments[0].mesh!.bind!.bones).sort(), ['t1', 't2']);
    delete p.attachments[0].mesh!.weights;
    repairReferences(p);
    assert.equal(p.attachments[0].mesh!.bind, undefined);
  });

  it('runtime v3 carries the bind by bone name; a rebuilt project skins identically', () => {
    const p = tail();
    bindMesh(p.attachments[0], evaluate(p, p.animations[0], 0).world);
    p.bones[3].rotation = -15;
    const rt = exportRuntime(p);
    assert.equal(rt.version, 3);
    assert.deepEqual(Object.keys(rt.attachments[0].mesh!.bind!.bones).sort(), ['tail1', 'tail2', 'tail3']);
    const back = loadRuntime(JSON.parse(JSON.stringify(rt)));
    for (let f = 0; f <= 30; f += 5) {
      const a = verts(p, 'curl', f / 30);
      const b = evaluate(back, back.animations[0], f / 30).attachments[0].vertices!;
      assert.ok(maxMove(a, b) < 1e-9, `frame ${f}`);
    }
    for (let f = 0; f < rt.animations[0].frames; f += 6) assert.ok(maxMove(rt.animations[0].bakedMeshes!.tail[f], verts(p, 'curl', f / 30)) < 0.002, `baked frame ${f}`);
  });
});

describe('IK bend side (L16)', () => {
  const chain = (bend: number) => {
    const p: Project = { format: FORMAT_ID, version: 2, name: 'ik', bones: [makeBone('t', 'thigh', null, 0, 0, 90, 100), makeBone('s', 'shin', 't', 100, 0, bend, 100)], images: [], attachments: [], animations: [] };
    return p;
  };
  it('inferred from the setup bend as before (straight → positive); explicit when given, either way', () => {
    assert.deepEqual([20, -20, 0].map((b) => addIk(chain(b), 's', true, { ik: 'ik', target: 'tg' })!.bendPositive), [false, true, true], 'L16 values unchanged');
    for (const want of [true, false]) assert.equal(addIk(chain(0), 's', true, { ik: 'ik', target: 'tg' }, want)!.bendPositive, want);
    // A straight leg with an explicit side bends that way when the target comes closer.
    for (const want of [true, false]) {
      const p = chain(0);
      addIk(p, 's', true, { ik: 'ik', target: 'tg' }, want);
      p.bones.find((b) => b.id === 'tg')!.y -= 40;
      const w = computeWorld(p.bones);
      const knee = w.get('s')!;
      const ev = evaluate(p, null, 0).world.get('s')!;
      assert.ok(Math.abs(ev.tx - knee.tx) > 5, 'the knee moved off the line');
      // Hip at (0,0), foot target straight below at y = 160: the knee goes to ±x.
      assert.equal(ev.tx < 0, want, `bendPositive=${want} puts the knee at x=${ev.tx.toFixed(2)}`);
    }
  });
});

describe('CLI: bind and ik', () => {
  const dir = path.join(EVIDENCE, 'r5-bind/cli');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), ...args], { cwd: ROOT, encoding: 'utf8' });
    return { code: r.status, json: JSON.parse(r.stdout) };
  };
  const load = (f: string) => {
    const r = parseProject(readFileSync(f, 'utf8'));
    assert.ok(r.ok);
    return (r as { project: Project }).project;
  };

  it('bind at setup / at a frame / clear equal the model; ik --bend writes the side; errors exit 1 or 2 and write nothing', () => {
    const src = path.join(dir, 'tail.rig.json');
    writeFileSync(src, serializeProject(tail()));
    const out = path.join(dir, 'bound.rig.json');
    let r = cli('bind', src, '--att', 'tail', '--anim', 'curl', '--at', '0', '--out', out);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.deepEqual([r.json.bound, r.json.bones], ['own', 3]);
    const want = tail();
    bindMesh(want.attachments[0], evaluate(want, want.animations[0], 0).world);
    assert.deepEqual(load(out).attachments[0].mesh!.bind, want.attachments[0].mesh!.bind);
    r = cli('bind', out, '--att', 'tail', '--clear', '--out', out);
    assert.equal(load(out).attachments[0].mesh!.bind, undefined);
    r = cli('bind', src, '--att', 'tail', '--out', out);
    assert.equal(r.json.bound, 'own');
    const ikOut = path.join(dir, 'ik.rig.json');
    r = cli('ik', src, '--bone', 'tail3', '--bend', 'negative', '--out', ikOut);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.deepEqual(r.json.ik, { name: 'tail3-ik', bones: ['tail2', 'tail3'], target: 'tail3-target', bendPositive: false });
    assert.equal(load(ikOut).ik![0].id, 'ik_tail3', 'deterministic ids');
    const before = readFileSync(out, 'utf8');
    for (const [args, re, code] of [
      [['bind', src, '--att', 'tail', '--anim', 'nope', '--at', '0', '--out', out], /No animation named/, 1],
      [['bind', src, '--att', 'tail', '--anim', 'curl', '--out', out], /--anim and --at go together/, 2],
      [['bind', src, '--att', 'tail', '--anim', 'curl', '--at', '0', '--clear', '--out', out], /exclude each other/, 2],
      [['ik', src, '--bone', 'tail3', '--bend', 'sideways', '--out', out], /--bend must be positive or negative/, 2],
      [['ik', src, '--bone', 'root', '--out', out], /Cannot add 2-bone IK ending at root/, 1],
    ] as [string[], RegExp, number][]) {
      const e = cli(...args);
      assert.equal(e.code, code, args.join(' '));
      assert.match(e.json.error, re);
      assert.equal(readFileSync(out, 'utf8'), before, 'nothing written');
    }
  });
});
