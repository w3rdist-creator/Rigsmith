import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDemoProject, DEMO_PARTS } from '../../src/model/demo.ts';
import { exportRuntime } from '../../src/model/exportRuntime.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { History } from '../../src/model/history.ts';
import { applyPoseEdit } from '../../src/model/ops.ts';
import { cloneProject } from '../../src/model/types.ts';
import type { ImageAsset, Project } from '../../src/model/types.ts';

// 1×1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function demo(): Project {
  const images: ImageAsset[] = DEMO_PARTS.map((p) => ({ id: p.id, name: p.name, mime: 'image/png', width: p.width, height: p.height, dataUrl: PNG }));
  return buildDemoProject(images);
}

test('save → load roundtrip is lossless', () => {
  const p = demo();
  const text = serializeProject(p);
  const r = parseProject(text);
  assert.equal(r.ok, true, r.ok ? '' : r.errors.join('\n'));
  if (!r.ok) return;
  assert.deepEqual(r.project, p);
  assert.equal(serializeProject(r.project), text);
});

test('demo project validates and has a visibly animated loop', () => {
  const p = demo();
  assert.ok(p.bones.length >= 10);
  assert.ok(p.animations.length >= 1 && p.animations[0].loop);
  const rt = exportRuntime(p);
  const tip = rt.animations[0].baked['forearm-front'];
  const xs = new Set(tip.map((f) => Math.round(f[0])));
  assert.ok(xs.size > 5, 'forearm world position changes across frames');
  assert.equal(rt.animations[0].frames, 30);
});

const bad: [string, (o: any) => void, RegExp][] = [
  ['wrong format id', (o) => (o.format = 'something.else'), /Not a Rigsmith project/],
  ['newer version', (o) => (o.version = 99), /newer than this editor/],
  ['missing parent', (o) => (o.bones[1].parentId = 'nope'), /missing parent/],
  ['cycle', (o) => (o.bones[0].parentId = o.bones[1].id), /cycle/],
  ['missing image', (o) => (o.attachments[0].imageId = 'gone'), /missing image/],
  ['missing bone in attachment', (o) => (o.attachments[0].boneId = 'gone'), /missing bone/],
  ['non-image data URL', (o) => (o.images[0].dataUrl = 'data:text/html;base64,PGgxPg=='), /data URL/],
  ['remote image URL', (o) => (o.images[0].dataUrl = 'https://example.com/x.png'), /data URL/],
  ['NaN coordinate', (o) => (o.bones[0].x = 'NaN'), /finite number/],
  ['unsorted keys', (o) => o.animations[0].tracks.b_torso.rotate.reverse(), /sorted/],
  ['wrong value arity', (o) => (o.animations[0].tracks.b_root.translate[0].value = [1]), /2 finite/],
  ['bad interp', (o) => (o.animations[0].tracks.b_root.translate[0].interp = 'bounce'), /interp/],
  ['track for missing bone', (o) => (o.animations[0].tracks.ghost = { translate: [], rotate: [], scale: [] }), /missing bone/],
  ['bad fps', (o) => (o.animations[0].fps = 0), /fps/],
  ['duplicate bone id', (o) => (o.bones[1].id = o.bones[0].id), /duplicated/],
];

for (const [name, mutate, re] of bad) {
  test(`invalid project rejected: ${name}`, () => {
    const o = JSON.parse(serializeProject(demo()));
    mutate(o);
    const r = parseProject(JSON.stringify(o));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.errors.some((e) => re.test(e)), `expected ${re} in:\n${r.errors.join('\n')}`);
  });
}

test('garbage input is rejected without throwing', () => {
  for (const text of ['', '{', 'null', '[]', '42', '{"format":"rigsmith.project"}']) {
    const r = parseProject(text);
    assert.equal(r.ok, false, text);
  }
});

test('undo/redo restores project snapshots in order and clears redo on new edits', () => {
  let p = demo();
  const h = new History<Project>();
  const torso = () => p.bones.find((b) => b.id === 'b_torso')!.rotation;
  const r0 = torso();

  h.record('rotate 1', cloneProject(p));
  applyPoseEdit(p, 'setup', null, 0, 'b_torso', { rotation: 10 });
  h.record('rotate 2', cloneProject(p));
  applyPoseEdit(p, 'setup', null, 0, 'b_torso', { rotation: 20 });
  assert.equal(torso(), 20);

  p = h.undo(p)!;
  assert.equal(torso(), 10);
  p = h.undo(p)!;
  assert.equal(torso(), r0);
  assert.equal(h.undo(p), null);

  p = h.redo(p)!;
  assert.equal(torso(), 10);
  assert.equal(h.redoLabel(), 'rotate 2');

  h.record('branch', cloneProject(p));
  applyPoseEdit(p, 'setup', null, 0, 'b_torso', { rotation: 99 });
  assert.equal(h.canRedo(), false, 'new edit discards redo stack');
  p = h.undo(p)!;
  assert.equal(torso(), 10);
});

test('undo snapshots are isolated from later mutation (keys included)', () => {
  const p = demo();
  const snap = cloneProject(p);
  p.animations[0].tracks.b_root.translate[0].value[1] = 999;
  p.bones[0].x = 999;
  assert.equal(snap.animations[0].tracks.b_root.translate[0].value[1], 0);
  assert.equal(snap.bones[0].x, 0);
  assert.equal(snap.images[0], p.images[0], 'immutable images are shared, not copied');
});

test('history limit drops the oldest entries', () => {
  const h = new History<number>(3);
  for (let i = 0; i < 5; i++) h.record(`s${i}`, i);
  assert.deepEqual(h.size, { undo: 3, redo: 0 });
  assert.equal(h.undo(5), 4);
});
