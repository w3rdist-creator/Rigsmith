// RV-003 (use-case review): the project's fixed delivery frame — format round trip,
// validation, and export geometry / clipping notices.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseProject, requiredVersion, serializeProject, v2Features } from '../../src/model/format.ts';
import { fitFrameToAnimations, frameGeometry, frameOverflow, frameWarnings, requestGeometry, sequenceGeometry } from '../../src/model/sequence.ts';
import type { Project } from '../../src/model/types.ts';

const legacyText = readFileSync(path.resolve(import.meta.dirname, '../fixtures/legacy-v1.rig.json'), 'utf8');
const load = (text: string): Project => {
  const r = parseProject(text);
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return (r as { project: Project }).project;
};

test('a frame is a v2 feature that round-trips byte-identically; removing it writes v1 again', () => {
  const p = load(legacyText);
  assert.ok(!('frame' in p), 'no default frame on load');
  p.frame = { x: -120.5, y: -300, width: 640, height: 720 };
  assert.deepEqual(v2Features(p), ['project frame']);
  const text = serializeProject(p);
  assert.equal(JSON.parse(text).version, 2);
  const back = load(text);
  assert.deepEqual(back.frame, p.frame);
  assert.equal(serializeProject(back), text);
  delete back.frame;
  assert.equal(requiredVersion(back), 1);
  assert.equal(serializeProject(back), legacyText, 'without a frame the legacy file is byte-identical');
});

test('invalid frames are rejected with a message; a v1 file may not carry one', () => {
  const base = JSON.parse(legacyText);
  const bad = (frame: unknown, version = 2) => {
    const r = parseProject(JSON.stringify({ ...base, version, frame }));
    assert.equal(r.ok, false, JSON.stringify(frame));
    return (r as { errors: string[] }).errors.join('\n');
  };
  assert.match(bad({ x: 0, y: 0, width: 0, height: 10 }), /frame width and height/);
  assert.match(bad({ x: 0, y: 0, width: 10, height: 9000 }), /frame width and height/);
  assert.match(bad({ x: 0, y: 'a', width: 10, height: 10 }), /frame/);
  assert.match(bad([1, 2, 3, 4]), /frame must be an object/);
  assert.match(bad({ x: 0, y: 0, width: 10, height: 10 }, 1), /frame requires project version 2/);
});

test('frame geometry: fixed size and origin at any scale, independent of the art bounds', () => {
  const f = { x: -100, y: -50, width: 301, height: 200 };
  assert.deepEqual(frameGeometry(f, 1), { width: 301, height: 200, originX: -100, originY: -50, scale: 1 });
  assert.deepEqual(frameGeometry(f, 0.5), { width: 151, height: 100, originX: -100, originY: -50, scale: 0.5 });
  const small = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
  const large = { minX: -500, minY: -10, maxX: 10, maxY: 10 };
  assert.deepEqual(requestGeometry(small, 1, 4, f), requestGeometry(large, 1, 4, f), 'same canvas whatever the art does');
  assert.deepEqual(requestGeometry(small, 1, 4, null), sequenceGeometry(small, 1, 4), 'no frame = fit (unchanged)');
});

test('art outside the frame is reported per side; art inside reports nothing', () => {
  const f = { x: 0, y: 0, width: 100, height: 100 };
  assert.deepEqual(frameOverflow({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, f), { left: 0, top: 0, right: 0, bottom: 0 });
  assert.deepEqual(frameWarnings({ minX: 1, minY: 1, maxX: 99, maxY: 99 }, f, 'x'), []);
  assert.deepEqual(frameOverflow({ minX: -5, minY: 2, maxX: 112.2, maxY: 99 }, f), { left: 5, top: 0, right: 12.200000000000003, bottom: 0 });
  const [w] = frameWarnings({ minX: -5, minY: 2, maxX: 112.2, maxY: 99 }, f, '“idle”');
  assert.match(w, /“idle” extends outside the project frame \(left 5, right 13 world units\) and is clipped; the frame size is kept\./);
  assert.deepEqual(frameWarnings({ minX: -5, minY: 2, maxX: 112, maxY: 99 }, null, 'x'), [], 'fit mode never clips');
});

test('fit to all animations: rounded-out union of every sampled pose + padding', () => {
  const anims = [
    { id: 'a', name: 'a', duration: 1, fps: 2, loop: true, tracks: {} },
    { id: 'b', name: 'b', duration: 0.5, fps: 2, loop: true, tracks: {} },
  ];
  const seen: string[] = [];
  const sample = (an: { id: string }, t: number) => {
    seen.push(`${an.id}@${t}`);
    return an.id === 'a' ? { minX: -10.2 + t * 10, minY: 0, maxX: 5 + t, maxY: 20 } : { minX: 0, minY: -30.5, maxX: 2, maxY: 1 };
  };
  const f = fitFrameToAnimations({ animations: anims } as unknown as Project, sample as never, 4);
  assert.deepEqual(seen, ['a@0', 'a@0.5', 'a@1', 'b@0', 'b@0.5']);
  assert.deepEqual(f, { x: -15, y: -35, width: 25, height: 59 });
  assert.equal(fitFrameToAnimations({ animations: anims } as unknown as Project, () => null), null);
});
