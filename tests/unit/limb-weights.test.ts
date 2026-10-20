// R1 weight authoring: banded limb weights, mirroring and smoothing (src/model/limbWeights.ts)
// and the headless `mesh` / `weights` CLI commands. Expected weights are recomputed here
// from the documented formula on hand-placed vertex coordinates, not through the model's
// setup-pose helpers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { limbWeights, mirrorWeights, smoothWeights, smoothstep, suffixBoneMap } from '../../src/model/limbWeights.ts';
import { gridPoints, setMesh, triangulate } from '../../src/model/meshOps.ts';
import { makeBone } from '../../src/model/ops.ts';
import type { Attachment, Project, VertexWeights } from '../../src/model/types.ts';
import { FORMAT_ID } from '../../src/model/types.ts';
import { EVIDENCE, ROOT } from '../e2e/harness.ts';
import { encodePng } from '../support/png-encode.ts';

const W = 120, H = 30;
function limbProject(): Project {
  const d = new Uint8Array(W * H * 4).fill(200);
  const img = { id: 'i_limb', name: 'limb.png', mime: 'image/png', width: W, height: H, dataUrl: `data:image/png;base64,${encodePng(W, H, d).toString('base64')}` };
  const att = (id: string, name: string, boneId: string): Attachment => ({ id, name, boneId, imageId: 'i_limb', x: 60, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
  return {
    format: FORMAT_ID, version: 2, name: 'limbs',
    bones: [
      makeBone('root', 'root', null, 0, 0, 0, 10),
      makeBone('up_l', 'upper_l', 'root', 0, 0, 0, 60),
      makeBone('lo_l', 'lower_l', 'up_l', 60, 0, 0, 60),
      makeBone('kn_l', 'knee_l', 'up_l', 60, 0, 0, 8),
      makeBone('hd_l', 'hand_l', 'lo_l', 50, 0, 0, 10),
      makeBone('up_r', 'upper_r', 'root', 0, 100, 0, 60),
      makeBone('lo_r', 'lower_r', 'up_r', 60, 0, 0, 60),
      makeBone('kn_r', 'knee_r', 'up_r', 60, 0, 0, 8),
      makeBone('hd_r', 'hand_r', 'lo_r', 50, 0, 0, 10),
    ],
    images: [img],
    attachments: [att('a_l', 'limb_l', 'up_l'), att('a_r', 'limb_r', 'up_r')],
    animations: [],
  };
}
const COLS = 12, ROWS = 2;
function meshed(): Project {
  const p = limbProject();
  for (const id of ['a_l', 'a_r']) {
    const g = gridPoints(W, H, COLS, ROWS);
    setMesh(p, id, triangulate(g.hull, g.interior));
  }
  return p;
}
const wOf = (l: VertexWeights, bone: string) => l.find((x) => x.bone === bone)?.w ?? 0;

describe('limbWeights', () => {
  it('matches the banded formula at every vertex (upper bone at the origin along +x)', () => {
    const p = meshed();
    const a = p.attachments[0];
    const w = limbWeights(p, a, { upper: 'up_l', lower: 'lo_l', helper: 'kn_l', band: { inner: 10, outer: 30, side: 1 } });
    const pts = a.mesh!.points;
    assert.equal(w.length, pts.length / 2);
    for (let i = 0; i < pts.length / 2; i++) {
      // Attachment centred at x = 60 on a bone at the origin: world = image point − half size + (60, 0).
      const s = pts[2 * i] - W / 2 + 60, q = pts[2 * i + 1] - H / 2;
      const B = 30 + (10 - 30) * smoothstep(-W / 2, W / 2, q);
      const t = smoothstep(60 - B, 60 + B, s);
      const h = 4 * t * (1 - t);
      const sum = w[i].reduce((acc, x) => acc + x.w, 0);
      assert.ok(Math.abs(sum - 1) < 1e-12, `vertex ${i} sums to 1`);
      const raw = { up_l: (1 - t) * (1 - h), kn_l: h, lo_l: t * (1 - h) };
      for (const [bone, v] of Object.entries(raw)) if (v >= 1e-3) assert.ok(Math.abs(wOf(w[i], bone) - v) < 1e-6, `vertex ${i} ${bone}: ${wOf(w[i], bone)} vs ${v}`);
    }
    // The ends belong to one bone each; the joint line is mostly the helper.
    assert.equal(w[0][0].bone, 'up_l');
    assert.equal(wOf(w[0], 'up_l'), 1);
    const mid = pts.findIndex((_, k) => k % 2 === 0 && pts[k] === W / 2) / 2;
    assert.ok(wOf(w[mid], 'kn_l') > 0.9, `joint vertex ${mid} follows the helper`);
  });

  it('the inside of the bend hands over over a tighter band than the outside', () => {
    const p = meshed();
    const a = p.attachments[0];
    // Vertices at s = 70 (10 px past the joint) on the two long edges: top (q = −15) and bottom (q = +15).
    const g = a.mesh!.points;
    const at = (x: number, y: number) => {
      for (let i = 0; i < g.length / 2; i++) if (g[2 * i] === x && g[2 * i + 1] === y) return i;
      throw new Error(`no vertex at ${x},${y}`);
    };
    const top = at(70, 0), bottom = at(70, H);
    const w = limbWeights(p, a, { upper: 'up_l', lower: 'lo_l', band: { inner: 8, outer: 40, side: 1 } });
    // side +1 → inside is +y (bottom edge): tight band, so the lower bone already dominates there.
    assert.ok(wOf(w[bottom], 'lo_l') > wOf(w[top], 'lo_l') + 0.1, `${wOf(w[bottom], 'lo_l')} vs ${wOf(w[top], 'lo_l')}`);
    const flipped = limbWeights(p, a, { upper: 'up_l', lower: 'lo_l', band: { inner: 8, outer: 40, side: -1 } });
    assert.ok(Math.abs(wOf(flipped[top], 'lo_l') - wOf(w[bottom], 'lo_l')) < 1e-9, 'side −1 mirrors the band across the axis');
  });

  it('end and root blends cap their share and keep sums at 1', () => {
    const p = meshed();
    const a = p.attachments[0];
    const w = limbWeights(p, a, { upper: 'up_l', lower: 'lo_l', band: { inner: 10, outer: 10, side: 1 }, end: { bone: 'hd_l', at: 110, band: 5, max: 0.6 }, root: { bone: 'root', from: 0, to: 20 } });
    const pts = a.mesh!.points;
    for (let i = 0; i < w.length; i++) {
      const s = pts[2 * i];
      assert.ok(Math.abs(w[i].reduce((acc, x) => acc + x.w, 0) - 1) < 1e-12);
      if (s >= 115) assert.ok(Math.abs(wOf(w[i], 'hd_l') - 0.6) < 1e-9, `tip vertex ${i} gives the hand its max share`);
      if (s <= 100) assert.equal(wOf(w[i], 'hd_l'), 0);
      if (s === 0) assert.equal(wOf(w[i], 'root'), 1, 'the top belongs to the body bone');
      if (s >= 20) assert.equal(wOf(w[i], 'root'), 0);
    }
  });

  it('rejects bad input with a readable message', () => {
    const p = meshed();
    const a = p.attachments[0];
    assert.throws(() => limbWeights(p, a, { upper: 'up_l', lower: 'nope', band: { inner: 1, outer: 1, side: 1 } }), /Unknown bone nope/);
    assert.throws(() => limbWeights(p, a, { upper: 'up_l', lower: 'lo_l', band: { inner: 0, outer: 1, side: 1 } }), /positive/);
    assert.throws(() => limbWeights(p, a, { upper: 'up_l', lower: 'lo_l', band: { inner: 1, outer: 1, side: 1 }, root: { bone: 'root', from: 5, to: 5 } }), /from < to/);
    const bare = limbProject();
    assert.throws(() => limbWeights(bare, bare.attachments[0], { upper: 'up_l', lower: 'lo_l', band: { inner: 1, outer: 1, side: 1 } }), /has no mesh/);
  });
});

describe('mirrorWeights / suffixBoneMap', () => {
  it('maps every _l bone to its _r twin and copies vertex for vertex', () => {
    const p = meshed();
    const map = suffixBoneMap(p, '_l', '_r');
    assert.deepEqual([...map], [['up_l', 'up_r'], ['lo_l', 'lo_r'], ['kn_l', 'kn_r'], ['hd_l', 'hd_r']]);
    const [l, r] = p.attachments;
    l.mesh!.weights = limbWeights(p, l, { upper: 'up_l', lower: 'lo_l', helper: 'kn_l', band: { inner: 10, outer: 30, side: 1 }, root: { bone: 'root', from: 0, to: 15 } });
    const m = mirrorWeights(l, r, map);
    const direct = limbWeights(p, r, { upper: 'up_r', lower: 'lo_r', helper: 'kn_r', band: { inner: 10, outer: 30, side: 1 }, root: { bone: 'root', from: 0, to: 15 } });
    assert.deepEqual(m, direct, 'same as weighting the twin directly (identical local geometry); root stays shared');
  });

  it('refuses different topologies and unweighted sources', () => {
    const p = meshed();
    const [l, r] = p.attachments;
    assert.throws(() => mirrorWeights(l, r, new Map()), /no weights to mirror/);
    l.mesh!.weights = limbWeights(p, l, { upper: 'up_l', lower: 'lo_l', band: { inner: 10, outer: 30, side: 1 } });
    const g = gridPoints(W, H, 4, 2);
    setMesh(p, 'a_r', triangulate(g.hull, g.interior));
    assert.throws(() => mirrorWeights(l, p.attachments[1], new Map()), /different vertex counts/);
  });
});

describe('smoothWeights', () => {
  it('one pass blends each vertex halfway to its neighbours’ average (hand-checked on a hard step)', () => {
    const p = meshed();
    const a = p.attachments[0];
    const pts = a.mesh!.points;
    a.mesh!.weights = Array.from({ length: pts.length / 2 }, (_, i) => [{ bone: pts[2 * i] < 60 ? 'up_l' : 'lo_l', w: 1 }]);
    const tri = a.mesh!.triangles;
    const nb = Array.from({ length: pts.length / 2 }, () => new Set<number>());
    for (let t = 0; t < tri.length; t += 3) for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) (nb[tri[t + i]].add(tri[t + j]), nb[tri[t + j]].add(tri[t + i]));
    const s = smoothWeights(a, 1);
    for (let i = 0; i < s.length; i++) {
      const lowerShare = [...nb[i]].filter((j) => pts[2 * j] >= 60).length / nb[i].size;
      const own = pts[2 * i] >= 60 ? 1 : 0;
      const expect = 0.5 * own + 0.5 * lowerShare;
      if (expect >= 1e-4 && expect <= 1 - 1e-4) assert.ok(Math.abs(wOf(s[i], 'lo_l') - expect) < 1e-9, `vertex ${i}: ${wOf(s[i], 'lo_l')} vs ${expect}`);
      assert.ok(Math.abs(s[i].reduce((acc, x) => acc + x.w, 0) - 1) < 1e-12);
    }
    assert.deepEqual(smoothWeights(a, 0), a.mesh!.weights, 'zero passes is identity');
    assert.ok(smoothWeights(a, 3, 0.5, 1).every((l) => l.length === 1), 'maxInfluences caps the list');
    assert.throws(() => smoothWeights(a, 1.5), /whole number/);
    assert.throws(() => smoothWeights(a, 1, 0), /amount/);
  });
});

describe('CLI mesh / weights (subprocess, no browser)', () => {
  const OUT = path.join(EVIDENCE, 'roadmap/r1-weights');
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const IN = path.join(OUT, 'limbs.rig.json');
  writeFileSync(IN, serializeProject(limbProject()));
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), ...args], { cwd: ROOT, encoding: 'utf8' });
    return { code: r.status, json: JSON.parse(r.stdout) };
  };
  const load = (f: string) => {
    const r = parseProject(readFileSync(f, 'utf8'));
    assert.ok(r.ok);
    return (r as { project: Project }).project;
  };

  it('mesh → limb weights → mirror → smooth reproduces the model functions exactly', () => {
    const m = path.join(OUT, 'meshed.rig.json');
    for (const att of ['limb_l', 'limb_r']) {
      const r = cli('mesh', att === 'limb_l' ? IN : m, '--att', att, '--grid', `${COLS}x${ROWS}`, '--out', m);
      assert.equal(r.code, 0, JSON.stringify(r.json));
      assert.equal(r.json.ok, true);
    }
    const lw = path.join(OUT, 'limb.rig.json');
    let r = cli('weights', m, '--att', 'limb_l', '--along', 'upper_l,lower_l', '--helper', 'knee_l', '--band', '10/30', '--side', '1', '--end', 'hand_l:110:5:0.6', '--root', 'root:0:15', '--out', lw);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.deepEqual([r.json.mode, r.json.vertices], ['limb', (COLS + 1) * (ROWS + 1)]);
    const mirrored = path.join(OUT, 'mirrored.rig.json');
    r = cli('weights', lw, '--att', 'limb_r', '--mirror-from', 'limb_l', '--swap', '_l=_r', '--smooth', '2', '--out', mirrored);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.equal(r.json.smoothed, 2);

    const expectP = meshed();
    const [l, rr] = expectP.attachments;
    l.mesh!.weights = limbWeights(expectP, l, { upper: 'up_l', lower: 'lo_l', helper: 'kn_l', band: { inner: 10, outer: 30, side: 1 }, end: { bone: 'hd_l', at: 110, band: 5, max: 0.6 }, root: { bone: 'root', from: 0, to: 15 } });
    rr.mesh!.weights = mirrorWeights(l, rr, suffixBoneMap(expectP, '_l', '_r'));
    rr.mesh!.weights = smoothWeights(rr, 2);
    const got = load(mirrored);
    assert.deepEqual(got.attachments[0].mesh, l.mesh);
    assert.deepEqual(got.attachments[1].mesh, rr.mesh);
  });

  it('usage errors exit 2, invalid requests exit 1, and nothing is written on failure', () => {
    const bad = path.join(OUT, 'never.rig.json');
    const cases: [string[], number, RegExp][] = [
      [['mesh', IN, '--att', 'limb_l', '--grid', '3by2', '--out', bad], 2, /--grid/],
      [['weights', IN, '--att', 'limb_l', '--out', bad], 2, /give --auto/],
      [['weights', IN, '--att', 'limb_l', '--auto', 'upper_l', '--along', 'upper_l,lower_l', '--out', bad], 2, /one of/],
      [['weights', IN, '--att', 'limb_l', '--along', 'upper_l', '--band', '1/2', '--out', bad], 2, /--along/],
      [['weights', IN, '--att', 'limb_l', '--along', 'upper_l,lower_l', '--band', '1/2', '--side', '0', '--out', bad], 2, /--side/],
      [['weights', IN, '--att', 'limb_l', '--along', 'upper_l,lower_l', '--band', '1/2', '--out', bad], 1, /no mesh/],
      [['mesh', IN, '--att', 'nope', '--grid', '2x2', '--out', bad], 1, /nope/],
    ];
    for (const [args, code, msg] of cases) {
      const r = cli(...args);
      assert.equal(r.code, code, `${args.join(' ')} → ${JSON.stringify(r.json)}`);
      assert.equal(r.json.ok, false);
      assert.match(r.json.error + ' ' + (r.json.errors ?? []).join(' '), msg);
    }
    assert.equal(existsSync(bad), false, 'no output file on failure');
  });
});
