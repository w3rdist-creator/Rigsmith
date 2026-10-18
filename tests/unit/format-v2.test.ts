import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseProject, requiredVersion, serializeProject, v2Features } from '../../src/model/format.ts';
import { History } from '../../src/model/history.ts';
import { cloneProject } from '../../src/model/types.ts';
import type { Project } from '../../src/model/types.ts';

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/legacy-v1.rig.json');
const legacyText = readFileSync(FIXTURE, 'utf8');

function load(text: string): Project {
  const r = parseProject(text);
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return (r as { project: Project }).project;
}

test('a v1 file written by the original serializer loads and re-saves byte-identically', () => {
  const p = load(legacyText);
  assert.equal(p.version, 1);
  assert.equal(requiredVersion(p), 1);
  assert.equal(serializeProject(p), legacyText);
  for (const k of ['ik', 'paths', 'pathConstraints', 'skins', 'mixes']) assert.ok(!(k in p), `no default "${k}" added on load`);
  for (const a of p.animations) assert.ok(!('slots' in a) && !('drawOrder' in a) && !('constraints' in a), 'no default animation fields');
});

test('using a v2 feature writes version 2; removing it again writes version 1', () => {
  const p = load(legacyText);
  const k = p.animations[0].tracks.b_torso.rotate[0];
  k.interp = 'bezier';
  k.curve = [0.3, 0, 0.35, 1.45];
  assert.deepEqual(v2Features(p), ['bezier curves']);
  const text = serializeProject(p);
  assert.equal(JSON.parse(text).version, 2);
  const back = load(text);
  assert.deepEqual(back.animations[0].tracks.b_torso.rotate[0], { time: 0, value: [-86], interp: 'bezier', curve: [0.3, 0, 0.35, 1.45] });
  assert.equal(serializeProject(back), text, 'v2 round trip is lossless');
  k.interp = 'smooth';
  delete k.curve;
  assert.equal(serializeProject(p), legacyText, 'back to the exact v1 bytes');
});

test('empty v2 collections never force version 2', () => {
  const p = load(legacyText);
  p.ik = [];
  p.skins = [];
  p.animations[0].slots = { att_head: {} };
  p.animations[0].drawOrder = [];
  assert.equal(serializeProject(p), legacyText);
});

const reject: [string, (o: any) => void, RegExp][] = [
  ['bezier in a v1 file', (o) => Object.assign(o.animations[0].tracks.b_torso.rotate[0], { interp: 'bezier', curve: [0, 0, 1, 1] }), /requires project version 2/],
  ['bezier without curve', (o) => ((o.version = 2), (o.animations[0].tracks.b_torso.rotate[0].interp = 'bezier')), /curve must be/],
  ['curve x outside [0,1]', (o) => ((o.version = 2), Object.assign(o.animations[0].tracks.b_torso.rotate[0], { interp: 'bezier', curve: [1.5, 0, 0.5, 1] })), /x handles/],
  ['curve on a non-bezier key', (o) => ((o.version = 2), (o.animations[0].tracks.b_torso.rotate[0].curve = [0, 0, 1, 1])), /only allowed on bezier/],
  ['v2 field in a v1 file', (o) => (o.ik = []), /requires project version 2/],
  ['version 3', (o) => (o.version = 3), /newer than this editor/],
  ['version 0', (o) => (o.version = 0), /Unsupported project version/],
  ['IK chain not parent→child', (o) => ((o.version = 2), (o.ik = [{ id: 'k', name: 'k', bones: ['b_thigh_front', 'b_shin_back'], target: 'b_key', mix: 1, bendPositive: true }])), /child of the first/],
  ['IK target inside its chain', (o) => ((o.version = 2), (o.ik = [{ id: 'k', name: 'k', bones: ['b_thigh_front', 'b_shin_front'], target: 'b_shin_front', mix: 1, bendPositive: true }])), /target must not/],
  ['draw order not a permutation', (o) => ((o.version = 2), (o.animations[0].drawOrder = [{ time: 0, order: ['att_head'] }])), /every attachment id/],
  ['deform without mesh', (o) => ((o.version = 2), (o.animations[0].slots = { att_head: { deform: [{ time: 0, value: [0, 0], interp: 'linear' }] } })), /needs the attachment to have a mesh/],
  ['mesh weights not normalized', (o) => ((o.version = 2), (o.attachments[0].mesh = { points: [0, 0, 10, 0, 0, 10], triangles: [0, 1, 2], hull: 3, weights: [[{ bone: 'b_root', w: 0.5 }], [{ bone: 'b_root', w: 1 }], [{ bone: 'b_root', w: 1 }]] })), /sum to 1/],
  ['skin entry for missing image', (o) => ((o.version = 2), (o.skins = [{ id: 's', name: 's', entries: [{ attachmentId: 'att_head', imageId: 'nope' }] }])), /missing image/],
];
for (const [name, mutate, re] of reject) {
  test(`v2 validation rejects: ${name}`, () => {
    const o = JSON.parse(legacyText);
    mutate(o);
    const r = parseProject(JSON.stringify(o));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors.join('\n'), re);
  });
}

test('undo snapshots deep-clone every v2 nested field (only image assets are shared)', () => {
  const p = load(legacyText);
  p.version = 2;
  p.ik = [{ id: 'ik1', name: 'leg', bones: ['b_thigh_front', 'b_shin_front'], target: 'b_key', mix: 1, bendPositive: true }];
  p.skins = [{ id: 's1', name: 'gold', entries: [{ attachmentId: 'att_head', imageId: 'img_torso' }] }];
  p.attachments[0].mesh = { points: [0, 0, 20, 0, 0, 50], triangles: [0, 1, 2], hull: 3, weights: [[{ bone: 'b_root', w: 1 }], [{ bone: 'b_root', w: 1 }], [{ bone: 'b_root', w: 1 }]] };
  p.animations[0].tracks.b_torso.rotate[0] = { time: 0, value: [-86], interp: 'bezier', curve: [0.1, 0.2, 0.3, 0.4] };
  p.animations[0].slots = { att_head: { image: [{ time: 0, imageId: 'img_head' }] } };
  p.animations[0].drawOrder = [{ time: 0, order: p.attachments.map((a) => a.id) }];
  const h = new History<Project>();
  const before = cloneProject(p);
  const pristine = JSON.parse(JSON.stringify(before));
  h.record('edit', before);
  p.ik[0].mix = 0.2;
  p.skins[0].entries[0].imageId = 'img_key';
  p.attachments[0].mesh.points[0] = 5;
  p.attachments[0].mesh.weights![0][0].w = 0.3;
  p.animations[0].tracks.b_torso.rotate[0].curve![1] = 9;
  p.animations[0].slots.att_head.image![0].imageId = 'img_key';
  p.animations[0].drawOrder[0].order.reverse();
  const restored = h.undo(p)!;
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), pristine, 'snapshot unaffected by later mutation');
  assert.equal(restored.images[0], p.images[0], 'image assets shared by reference');
});
