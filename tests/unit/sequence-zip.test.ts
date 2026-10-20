import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMIT_CEILINGS, SEQUENCE_LIMITS, checkCapacity, defaultRequest, lastExportFrame, planSequence, resolveLimits, sequenceGeometry } from '../../src/model/sequence.ts';
import { buildZip, crc32 } from '../../src/model/zip.ts';
import type { Animation } from '../../src/model/types.ts';
import { readZip } from '../support/zip-read.ts';
import { crc32 as nodeCrc } from 'node:zlib';

const anim = (loop: boolean, duration = 1, fps = 30): Animation => ({ id: 'a', name: 'a', duration, fps, loop, tracks: {} });

test('endpoint policy: loops omit the duplicate end sample, one-shots include the final pose', () => {
  assert.equal(lastExportFrame(anim(true), 30), 29);
  assert.equal(lastExportFrame(anim(false), 30), 30);
  const loop = planSequence(anim(true), defaultRequest(anim(true)));
  assert.ok(loop.ok);
  if (loop.ok) {
    assert.equal(loop.plan.frames.length, 30);
    assert.ok(loop.plan.times.at(-1)! < 1, 'last loop sample is before the duration');
  }
  const once = planSequence(anim(false), defaultRequest(anim(false)));
  assert.ok(once.ok && once.plan.frames.length === 31 && once.plan.times.at(-1) === 1);
  // Export FPS differs from the animation FPS: counts follow the export FPS.
  const r = planSequence(anim(true, 2.4, 30), { ...defaultRequest(anim(true, 2.4, 30)), fps: 12, end: lastExportFrame(anim(true, 2.4, 30), 12) });
  assert.ok(r.ok && r.plan.frames.length === 29 && Math.abs(r.plan.times[1] - 1 / 12) < 1e-12);
});

test('range and parameter errors', () => {
  const a = anim(true);
  const req = defaultRequest(a);
  const bad: [Partial<typeof req>, RegExp][] = [
    [{ end: 30 }, /between 0 and 29.*repeats frame 0/],
    [{ start: -1 }, /Start frame/],
    [{ start: 10, end: 5 }, /zero frames/],
    [{ fps: 0 }, /FPS/],
    [{ scale: 0 }, /Scale/],
    [{ padding: 1 }, /Padding/],
    [{ start: 1.5 }, /whole frame/],
  ];
  for (const [patch, re] of bad) {
    const r = planSequence(a, { ...req, ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    if (!r.ok) assert.match(r.errors.join(' '), re);
  }
  const none = planSequence(null, req);
  assert.ok(!none.ok && /no/.test(none.errors[0]));
  const many = planSequence(anim(true, 100, 30), { ...req, end: 2999 });
  assert.ok(!many.ok && /limit/.test(many.errors[0]));
});

test('geometry: one size for all frames with padding on every side; capacity limits', () => {
  const g = sequenceGeometry({ minX: -10.3, minY: -20.7, maxX: 30.2, maxY: 5.1 }, 2, 4);
  assert.ok(g.width >= (30.2 + 10.3) * 2 + 8 && g.height >= (5.1 + 20.7) * 2 + 8);
  assert.ok((-10.3 - g.originX) * 2 >= 4 - 1e-9, 'left padding ≥ 4 px');
  assert.ok((g.originX + g.width / 2 - 30.2) * 2 >= 4 - 1e-9, 'right padding ≥ 4 px');
  assert.deepEqual(checkCapacity({ ...g, width: 9000 }, 10).length, 1);
  assert.deepEqual(checkCapacity({ ...g, width: 4000, height: 4000 }, 100).length, 1);
  assert.deepEqual(checkCapacity(g, 100), []);
});

test('ZIP writer: CRC matches zlib, archive reads back with an independent reader, output is deterministic', () => {
  const data = new TextEncoder().encode('hello rigsmith');
  assert.equal(crc32(data), nodeCrc(Buffer.from(data)) >>> 0);
  const entries = [
    { name: 'a/f0000.png', data: new Uint8Array([1, 2, 3]) },
    { name: 'sequence.json', data },
    { name: 'empty.bin', data: new Uint8Array(0) },
  ];
  const z1 = buildZip(entries);
  const z2 = buildZip(entries);
  assert.deepEqual(z1, z2, 'byte-identical for identical input');
  const back = readZip(Buffer.from(z1));
  assert.deepEqual(back.map((f) => f.name), entries.map((e) => e.name));
  assert.deepEqual([...back[0].data], [1, 2, 3]);
  assert.equal(back[1].data.toString('utf8'), 'hello rigsmith');
  assert.equal(back[2].data.length, 0);
});

test('R12 render limits: overrides within the ceilings reach planSequence and checkCapacity; defaults unchanged', () => {
  assert.deepEqual(resolveLimits(), { ok: true, limits: SEQUENCE_LIMITS });
  const r = resolveLimits({ maxFrames: 5000, maxMegapixels: 1500 });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.limits.maxFrames, 5000);
  assert.equal(r.limits.maxTotalPixels, 1.5e9);
  assert.equal(r.limits.maxSide, SEQUENCE_LIMITS.maxSide, 'per-frame caps are not raisable');
  for (const bad of [{ maxFrames: 0 }, { maxFrames: 2.5 }, { maxFrames: LIMIT_CEILINGS.maxFrames + 1 }, { maxMegapixels: 0.5 }, { maxMegapixels: NaN }, { maxMegapixels: LIMIT_CEILINGS.maxTotalPixels / 1e6 + 1 }]) assert.equal(resolveLimits(bad).ok, false, JSON.stringify(bad));
  const long = anim(true, 100, 30);
  const req = { ...defaultRequest(long), end: 2999 };
  assert.equal(planSequence(long, req).ok, false, '3000 frames is over the default');
  assert.equal(planSequence(long, req, r.limits).ok, true);
  const g = { width: 1000, height: 1000, originX: 0, originY: 0, scale: 1 };
  assert.equal(checkCapacity(g, 700).length, 1);
  assert.deepEqual(checkCapacity(g, 700, true, r.limits), []);
  assert.match(checkCapacity(g, 1600, true, r.limits)[0], /over 1500 megapixels in total; the --max-megapixels limit/);
});
