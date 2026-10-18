import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keysBeyondEnd, moveKey, playbackTime, removeKey, sampleBone, sampleKeys, setKey, snapToFrame } from '../../src/model/animation.ts';
import { applyPoseEdit, keyChannels } from '../../src/model/ops.ts';
import type { Animation, Key, Project } from '../../src/model/types.ts';
import { emptyProject } from '../../src/model/types.ts';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const k = (time: number, value: number[], interp: Key['interp'] = 'linear'): Key => ({ time, value, interp });

test('linear interpolation between keys, holds outside the key range', () => {
  const keys = [k(0, [0, 10]), k(1, [100, 20])];
  assert.deepEqual(sampleKeys(keys, 0.25, [9, 9]), [25, 12.5]);
  assert.deepEqual(sampleKeys(keys, -1, [9, 9]), [0, 10]);
  assert.deepEqual(sampleKeys(keys, 5, [9, 9]), [100, 20]);
  assert.deepEqual(sampleKeys([], 0.5, [9, 9]), [9, 9], 'empty channel falls back to setup');
});

test('step interpolation holds the left key until the next key', () => {
  const keys = [k(0, [1], 'step'), k(1, [2])];
  assert.deepEqual(sampleKeys(keys, 0.999, [0]), [1]);
  assert.deepEqual(sampleKeys(keys, 1, [0]), [2]);
});

test('smooth interpolation eases in and out and matches at the midpoint', () => {
  const keys = [k(0, [0], 'smooth'), k(2, [100])];
  close(sampleKeys(keys, 1, [0])[0], 50);
  const early = sampleKeys(keys, 0.2, [0])[0];
  assert.ok(early < 10, `smooth should start slower than linear (${early})`);
});

test('multi-segment lookup picks the right segment', () => {
  const keys = [k(0, [0]), k(1, [10]), k(2, [30]), k(4, [30]), k(5, [0])];
  close(sampleKeys(keys, 1.5, [0])[0], 20);
  close(sampleKeys(keys, 3, [0])[0], 30);
  close(sampleKeys(keys, 4.5, [0])[0], 15);
});

test('rotation interpolates raw degrees (350→10 passes 180; 350→370 passes 360)', () => {
  close(sampleKeys([k(0, [350]), k(1, [10])], 0.5, [0])[0], 180);
  close(sampleKeys([k(0, [350]), k(1, [370])], 0.5, [0])[0], 360);
});

test('setKey inserts sorted and replaces at the same time; remove/move work', () => {
  const keys: Key[] = [];
  setKey(keys, 1, [1]);
  setKey(keys, 0, [0]);
  setKey(keys, 0.5, [5]);
  assert.deepEqual(keys.map((x) => x.time), [0, 0.5, 1]);
  setKey(keys, 0.5, [7]);
  assert.equal(keys.length, 3);
  assert.deepEqual(keys[1].value, [7]);
  assert.equal(removeKey(keys, 0.5), true);
  assert.equal(removeKey(keys, 0.5), false);
  assert.equal(moveKey(keys, 1, 0.25), true);
  assert.deepEqual(keys.map((x) => x.time), [0, 0.25]);
});

test('playback loops or clamps; frame snapping', () => {
  const anim: Animation = { id: 'a', name: 'a', duration: 2, fps: 24, loop: true, tracks: {} };
  close(playbackTime(anim, 5).time, 1);
  anim.loop = false;
  assert.deepEqual(playbackTime(anim, 5), { time: 2, finished: true });
  close(snapToFrame(0.51, 24), 12 / 24);
});

test('keys stored in seconds survive an fps change; keys past a shortened end are kept and counted', () => {
  const anim: Animation = { id: 'a', name: 'a', duration: 2, fps: 30, loop: true, tracks: { b: { translate: [], rotate: [k(0, [0]), k(1.5, [90])], scale: [] } } };
  anim.fps = 12;
  close(anim.tracks.b.rotate[1].time, 1.5);
  assert.equal(keysBeyondEnd(anim), 0);
  anim.duration = 1;
  assert.equal(keysBeyondEnd(anim), 1);
});

function rigProject(): Project {
  return {
    ...emptyProject(),
    bones: [{ id: 'b', name: 'b', parentId: null, x: 1, y: 2, rotation: 3, scaleX: 1, scaleY: 1, length: 10, color: '#fff' }],
    animations: [{ id: 'an', name: 'an', duration: 1, fps: 10, loop: true, tracks: {} }],
  };
}

test('animate-mode edits write keys at the snapped frame and leave the setup pose alone', () => {
  const p = rigProject();
  applyPoseEdit(p, 'animate', 'an', 0.52, 'b', { rotation: 45 });
  assert.equal(p.bones[0].rotation, 3, 'setup pose untouched');
  const rot = p.animations[0].tracks.b.rotate;
  assert.equal(rot.length, 1);
  close(rot[0].time, 0.5);
  assert.deepEqual(rot[0].value, [45]);
  assert.equal(p.animations[0].tracks.b.translate.length, 0, 'only the touched channel is keyed');
  assert.equal(sampleBone(p.bones[0], p.animations[0], 0.9).rotation, 45);
  // Editing again at the same frame updates instead of duplicating.
  applyPoseEdit(p, 'animate', 'an', 0.5, 'b', { rotation: 60 });
  assert.equal(rot.length, 1);
  assert.deepEqual(rot[0].value, [60]);
});

test('setup-mode edits change the bone; keyChannels captures the sampled pose', () => {
  const p = rigProject();
  applyPoseEdit(p, 'setup', 'an', 0, 'b', { x: 10, y: 20 });
  assert.equal(p.bones[0].x, 10);
  keyChannels(p, 'an', 0.3, 'b', ['translate', 'rotate', 'scale']);
  const t = p.animations[0].tracks.b;
  assert.deepEqual(t.translate[0].value, [10, 20]);
  assert.deepEqual(t.rotate[0].value, [3]);
  assert.deepEqual(t.scale[0].value, [1, 1]);
});
