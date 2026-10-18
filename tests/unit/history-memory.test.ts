// Undo history memory (drwdmrs3 review P3-2): 200 snapshots of a large rig retained
// ~1.1 GB because every mutation, even a no-op, stored a full deep copy. Snapshots now
// share unchanged subtrees with the previous one and no-op mutations add no step; undo
// and redo must still restore every state exactly.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Editor } from '../../src/editor/store.ts';
import { serializeProject } from '../../src/model/format.ts';
import { gridPoints, keyDeform, setMesh } from '../../src/model/meshOps.ts';
import { makeBone } from '../../src/model/ops.ts';
import type { Project } from '../../src/model/types.ts';
import { triangulate } from '../../src/model/meshOps.ts';

/** 60 bones × 33 rotate keys, a 400-vertex mesh with 10 deform keys. */
function bigRig(): Project {
  const bones = Array.from({ length: 60 }, (_, i) => makeBone(`b${i}`, `b${i}`, i === 0 ? null : `b${Math.floor((i - 1) / 2)}`, 20, 0, 10, 20));
  const p: Project = {
    format: 'rigsmith.project', version: 2, name: 'big', bones,
    images: [{ id: 'im', name: 'im.png', mime: 'image/png', width: 400, height: 400, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
    attachments: [{ id: 'a', name: 'a', boneId: 'b0', imageId: 'im', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 }],
    animations: [{ id: 'an', name: 'an', duration: 10, fps: 30, loop: true, tracks: {} }],
  };
  const g = gridPoints(400, 400, 20, 20);
  setMesh(p, 'a', triangulate(g.hull, g.interior));
  const anim = p.animations[0];
  for (const b of bones) {
    anim.tracks[b.id] = { translate: [], rotate: [], scale: [] };
    for (let k = 0; k < 33; k++) anim.tracks[b.id].rotate.push({ time: k * 0.3, value: [k * 3], interp: 'bezier', curve: [0.3, 0, 0.35, 1.45] });
  }
  const nv = p.attachments[0].mesh!.points.length / 2;
  for (let k = 0; k < 10; k++) keyDeform(anim, 'a', k * 0.5, Array.from({ length: nv * 2 }, (_, i) => Math.sin(i + k)));
  return p;
}

/** Distinct objects/arrays reachable from the roots (shared subtrees count once). */
function uniqueNodes(roots: unknown[]): number {
  const seen = new Set<object>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
  };
  roots.forEach(walk);
  return seen.size;
}

/** History states (read through the public undo/redo API, restored afterwards). */
function historyStates(ed: Editor): Project[] {
  const h = ed.history as unknown as { past: { state: Project }[]; future: { state: Project }[] };
  return [...h.past, ...h.future].map((e) => e.state);
}

const editKey = (i: number) => (p: Project) => {
  p.animations[0].tracks[`b${i % 60}`].rotate[i % 33].value[0] += 1;
};

describe('undo history memory (review P3-2)', () => {
  it('a mutation that changes nothing adds no undo step; a real one adds one', () => {
    const ed = new Editor();
    ed.load(bigRig());
    ed.mutate('nothing', () => {});
    ed.mutate('same value', (p) => { p.bones[0].x = p.bones[0].x; });
    assert.deepEqual(ed.history.size, { undo: 0, redo: 0 });
    ed.mutate('move', (p) => { p.bones[0].x += 1; });
    assert.deepEqual(ed.history.size, { undo: 1, redo: 0 });
    assert.equal(ed.history.undoLabel(), 'move');
  });

  it('200 key edits retain about one copy of the rig, not 200', () => {
    const ed = new Editor();
    ed.load(bigRig());
    const one = uniqueNodes([ed.project]);
    for (let i = 0; i < 200; i++) ed.mutate(`edit ${i}`, editKey(i));
    assert.equal(ed.history.size.undo, 200);
    const all = uniqueNodes(historyStates(ed));
    assert.ok(all < 1.5 * one, `200 snapshots hold ${all} distinct nodes; one rig has ${one}`);
  });

  it('undo and redo restore every state exactly, including after branching', () => {
    const ed = new Editor();
    ed.load(bigRig());
    const states = [serializeProject(ed.project)];
    for (let i = 0; i < 40; i++) {
      ed.mutate(`edit ${i}`, editKey(i * 7));
      states.push(serializeProject(ed.project));
    }
    for (let i = 39; i >= 20; i--) {
      assert.ok(ed.undo());
      assert.equal(serializeProject(ed.project), states[i], `undo to state ${i}`);
    }
    // Branch: a new edit after undo; the older snapshots must be untouched by it and by
    // later in-place edits of the restored project.
    ed.mutate('branch', (p) => { p.animations[0].tracks.b0.rotate[0].value[0] = 999; p.bones[3].x = -5; });
    ed.mutate('branch 2', (p) => { p.animations[0].tracks.b1.rotate[1].value[0] = 777; });
    const branched = serializeProject(ed.project);
    assert.ok(ed.undo());
    assert.ok(ed.undo());
    assert.equal(serializeProject(ed.project), states[20], 'back at the branch point');
    for (let i = 19; i >= 0; i--) {
      assert.ok(ed.undo());
      assert.equal(serializeProject(ed.project), states[i], `undo to state ${i}`);
    }
    assert.equal(ed.undo(), false);
    for (let i = 1; i <= 20; i++) {
      assert.ok(ed.redo());
      assert.equal(serializeProject(ed.project), states[i], `redo to state ${i}`);
    }
    assert.ok(ed.redo());
    assert.ok(ed.redo());
    assert.equal(serializeProject(ed.project), branched, 'redo replays the branch');
  });

  it('a gesture commits one shared snapshot and cancel restores the start', () => {
    const ed = new Editor();
    ed.load(bigRig());
    const start = serializeProject(ed.project);
    ed.mutate('first', editKey(1));
    const afterFirst = serializeProject(ed.project);
    ed.beginGesture();
    ed.gestureMutate((p) => { p.bones[2].x += 3; });
    ed.gestureMutate((p) => { p.bones[2].x += 3; });
    ed.endGesture('drag');
    assert.equal(ed.history.size.undo, 2);
    assert.ok(uniqueNodes(historyStates(ed)) < 1.5 * uniqueNodes([ed.project]));
    ed.beginGesture();
    ed.gestureMutate((p) => { p.bones[2].x += 100; });
    ed.cancelGesture();
    assert.ok(ed.undo());
    assert.equal(serializeProject(ed.project), afterFirst);
    assert.ok(ed.undo());
    assert.equal(serializeProject(ed.project), start);
  });
});

describe('shareUnchanged / History options', () => {
  it('shares equal subtrees, copies changed containers, never modifies its inputs', async () => {
    const { shareUnchanged, deepEqualJson } = await import('../../src/model/history.ts');
    const prev = { a: { x: [1, 2, 3] }, b: { y: 1 }, c: [{ z: NaN }] };
    const next = { a: { x: [1, 2, 3] }, b: { y: 2 }, c: [{ z: NaN }] };
    const frozen = JSON.stringify([prev, next]);
    const out = shareUnchanged(next, prev);
    assert.equal(out.a, prev.a, 'equal subtree shared');
    assert.equal(out.c, prev.c, 'NaN compares equal');
    assert.notEqual(out.b, prev.b);
    assert.notEqual(out, next, 'changed container is a new object');
    assert.ok(deepEqualJson(out, next));
    assert.equal(JSON.stringify([prev, next]), frozen);
    assert.equal(shareUnchanged({ ...prev }, prev), prev, 'fully equal → previous object');
  });

  it('sharing without a restoring copy is refused', async () => {
    const { History, shareUnchanged } = await import('../../src/model/history.ts');
    assert.throws(() => new History<object>({ share: shareUnchanged }), /needs `restore`/);
  });
});
