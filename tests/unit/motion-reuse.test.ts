// RV-009: saved clip sequences, animation import with explicit mapping, durable
// cross-project key clipboard — model level (format, integrity, schedule, mapping).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { defaultMapping, importAnimations, usedRefs } from '../../src/model/animImport.ts';
import { parseStepList, scheduleSequence } from '../../src/model/clipSequence.ts';
import { parsePortable, resolvePortable, toPortable } from '../../src/model/clipboard.ts';
import { evaluate } from '../../src/model/evaluate.ts';
import { parseProject, requiredVersion, serializeProject } from '../../src/model/format.ts';
import { repairReferences } from '../../src/model/integrity.ts';
import { boneLane, copyKeys, pasteKeys } from '../../src/model/keys.ts';
import { evaluateMix, mixDuration, setMixRule } from '../../src/model/mix.ts';
import type { Project } from '../../src/model/types.ts';
import { cloneProject } from '../../src/model/types.ts';

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/legacy-v1.rig.json');
function load(text: string): Project {
  const r = parseProject(text);
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return (r as { project: Project }).project;
}
const legacy = () => load(readFileSync(FIXTURE, 'utf8'));
const animId = (p: Project, name: string) => p.animations.find((a) => a.name === name)!.id;

/** The fixture with every id renamed (a different project with the same names). */
function renamedCopy(p: Project): Project {
  let text = serializeProject(p);
  const ids = [...p.bones.map((b) => b.id), ...p.attachments.map((a) => a.id), ...p.images.map((i) => i.id), ...p.animations.map((a) => a.id)];
  for (const id of ids.sort((a, b) => b.length - a.length)) text = text.split(`"${id}"`).join(`"x_${id}"`);
  return load(text);
}

describe('saved clip sequences (format and integrity)', () => {
  it('round-trips, requires v2, and an old file without sequences re-saves byte-identically', () => {
    const text = readFileSync(FIXTURE, 'utf8');
    const p = load(text);
    assert.equal(serializeProject(p), text, 'v1 bytes unchanged');
    assert.ok(!('sequences' in p), 'no default field added on load');
    assert.equal(requiredVersion(p), 1);
    // A v2 file written before sequences existed (mixes + frame) re-saves identically.
    setMixRule(p, animId(p, 'walk'), animId(p, 'wave'), 0.3);
    p.frame = { x: -100, y: -200, width: 300, height: 400 };
    const v2text = serializeProject(p);
    assert.equal(serializeProject(load(v2text)), v2text);
    delete p.mixes;
    delete p.frame;
    const before = serializeProject(p);
    p.sequences = [];
    assert.equal(serializeProject(p), before, 'an empty list is not written (still v1, same bytes)');
    p.sequences = [{ id: 'seq1', name: 'show', steps: [{ animId: animId(p, 'walk'), repeat: 2 }, { animId: animId(p, 'wave'), repeat: 1 }], loop: true }];
    assert.equal(requiredVersion(p), 2);
    const back = load(serializeProject(p));
    assert.deepEqual(back.sequences, p.sequences);
    assert.equal(back.version, 2);
  });

  it('the validator rejects bad sequences and v1 files that carry them', () => {
    const p = legacy();
    const good = { id: 's', name: 'a', steps: [{ animId: animId(p, 'walk'), repeat: 1 }], loop: false };
    const obj = JSON.parse(serializeProject(p));
    const bad = (seqs: unknown, version = 2) => {
      const r = parseProject(JSON.stringify({ ...obj, version, sequences: seqs }));
      assert.equal(r.ok, false);
      return (r as { errors: string[] }).errors.join('\n');
    };
    assert.match(bad([good], 1), /requires project version 2/);
    assert.match(bad([{ ...good, steps: [{ animId: 'nope', repeat: 1 }] }]), /missing animation "nope"/);
    assert.match(bad([{ ...good, steps: [{ animId: good.steps[0].animId, repeat: 0 }] }]), /repeat must be a whole number/);
    assert.match(bad([{ ...good, steps: [{ animId: good.steps[0].animId, repeat: 1.5 }] }]), /repeat must be a whole number/);
    assert.match(bad([good, { ...good, id: 's2' }]), /name "a" is duplicated/);
    assert.match(bad([{ ...good, name: '  ' }]), /name must not be empty/);
    const ok = parseProject(JSON.stringify({ ...obj, version: 2, sequences: [{ ...good, steps: [] }] }));
    assert.ok(ok.ok, 'an empty sequence is a valid (unexportable) draft');
  });

  it('deleting an animation drops its steps (repair note); cloneProject copies sequences', () => {
    const p = legacy();
    p.version = 2;
    p.sequences = [{ id: 's', name: 'a', steps: [{ animId: animId(p, 'walk'), repeat: 1 }, { animId: animId(p, 'wave'), repeat: 3 }], loop: false }];
    const snap = cloneProject(p);
    assert.notEqual(snap.sequences, p.sequences);
    assert.deepEqual(snap.sequences, p.sequences);
    p.animations = p.animations.filter((a) => a.name !== 'wave');
    const notes = repairReferences(p);
    assert.deepEqual(p.sequences[0].steps, [{ animId: animId(p, 'walk'), repeat: 1 }]);
    assert.ok(notes.some((n) => /Sequence “a”: 1 step\(s\) removed/.test(n)), notes.join('\n'));
    assert.equal(snap.sequences![0].steps.length, 2, 'the undo snapshot is untouched');
  });
});

describe('clip sequence schedule', () => {
  it('frame count is exactly the sum of each step’s plays; starts are frame aligned; mixes come from the stored rules', () => {
    const p = legacy();
    const walk = animId(p, 'walk'), wave = animId(p, 'wave');
    setMixRule(p, walk, wave, 0.3);
    const seq = { id: 's', name: 'show', steps: [{ animId: walk, repeat: 2 }, { animId: wave, repeat: 1 }, { animId: walk, repeat: 1 }], loop: false };
    const r = scheduleSequence(p, seq, 30);
    assert.ok(r.ok);
    const s = r.schedule;
    assert.deepEqual(s.steps.map((x) => [x.framesPerPlay, x.startFrame, x.frames, x.mix]), [[30, 0, 60, 0], [48, 60, 48, 0.3], [30, 108, 30, mixDuration(p, wave, walk)]]);
    assert.equal(s.totalFrames, 30 * 2 + 48 + 30);
    assert.deepEqual(s.plan.entries.map((e) => e.start), [0, 2, 108 / 30]);
    // At a different fps the identity still holds.
    const r24 = scheduleSequence(p, seq, 24);
    assert.ok(r24.ok);
    assert.equal(r24.schedule.totalFrames, 24 * 2 + Math.round(1.6 * 24) + 24);
  });

  it('errors are visible: empty sequence, missing animation, bad fps', () => {
    const p = legacy();
    const r = scheduleSequence(p, { id: 's', name: 'x', steps: [], loop: false }, 0);
    assert.equal(r.ok, false);
    const msg = (r as { errors: string[] }).errors.join('\n');
    assert.match(msg, /FPS must be/);
    assert.match(msg, /has no clips/);
  });

  it('a one-shot step repeats by restarting; a loop keeps looping; frames before the next step match a two-entry Mix plan exactly', () => {
    const p = legacy();
    const walk = animId(p, 'walk'), wave = animId(p, 'wave');
    p.animations.find((a) => a.id === wave)!.loop = false;
    const seq = { id: 's', name: 'x', steps: [{ animId: wave, repeat: 2 }, { animId: walk, repeat: 1 }], loop: false };
    const r = scheduleSequence(p, seq, 30);
    assert.ok(r.ok);
    const plan = r.schedule.plan;
    const pose = (T: number) => JSON.stringify([...evaluateMix(p, plan, T).world.entries()]);
    const waveAnim = p.animations.find((a) => a.id === wave)!;
    // Frame 48 + 10 (second play of the one-shot) equals frame 10 of the first play.
    assert.equal(pose(58 / 30), pose(10 / 30));
    assert.equal(pose(10 / 30), JSON.stringify([...evaluate(p, waveAnim, 10 / 30).world.entries()]));
    // Transition parity: a Mix-dialog plan (wave at 0, walk at the same switch time) gives
    // identical frames for every frame of the sequence that has only those two entries.
    const seq2 = { id: 's2', name: 'y', steps: [{ animId: walk, repeat: 2 }, { animId: wave, repeat: 1 }, { animId: walk, repeat: 1 }], loop: false };
    const r2 = scheduleSequence(p, seq2, 30);
    assert.ok(r2.ok);
    const mixPlan = { entries: [{ animId: walk, start: 0, mix: 0 }, { animId: wave, start: 2, mix: mixDuration(p, walk, wave) }], missing: 'setup' as const };
    for (let f = 0; f < 108; f++) {
      const a = evaluateMix(p, r2.schedule.plan, f / 30), b = evaluateMix(p, mixPlan, f / 30);
      assert.deepEqual([...a.world.entries()], [...b.world.entries()], `frame ${f}`);
    }
  });

  it('parses "name*N" step lists (CLI)', () => {
    const p = legacy();
    const r = parseStepList(p, 'walk*2, wave ,walk');
    assert.ok(r.ok);
    assert.deepEqual(r.steps.map((s) => s.repeat), [2, 1, 1]);
    const bad = parseStepList(p, 'walk*0,run');
    assert.equal(bad.ok, false);
    assert.match((bad as { errors: string[] }).errors.join('\n'), /repeat must be from 1[\s\S]*No animation named “run”/);
  });
});

describe('animation import with explicit mapping', () => {
  it('default mapping is by name; imported tracks equal the source tracks keyed by bone name', () => {
    const src = legacy();
    const dst = renamedCopy(src);
    dst.animations = [];
    const wave = animId(src, 'wave');
    const m = defaultMapping(src, dst, [wave]);
    assert.equal(Object.values(m.bones).filter(Boolean).length, 5);
    const rep = importAnimations(dst, src, [wave], m);
    assert.deepEqual(rep.unmatched, []);
    assert.deepEqual(rep.imported, [{ source: 'wave', name: 'wave' }]);
    const byName = (p: Project, anim: string) => {
      const a = p.animations.find((x) => x.name === anim)!;
      return Object.fromEntries(Object.entries(a.tracks).map(([id, t]) => [p.bones.find((b) => b.id === id)!.name, t]));
    };
    assert.deepEqual(byName(dst, 'wave'), byName(src, 'wave'));
    assert.ok(load(serializeProject(dst)), 'imported project re-opens');
  });

  it('a skipped or changed mapping is honoured; unmatched bones are reported with key counts; names stay unique; mixes copied', () => {
    const src = legacy();
    const dst = legacy();
    const walk = animId(src, 'walk'), wave = animId(src, 'wave');
    setMixRule(src, walk, wave, 0.4);
    // The target has no "head" bone.
    const head = dst.bones.find((b) => b.name === 'head')!;
    dst.bones = dst.bones.filter((b) => b !== head).map((b) => (b.parentId === head.id ? { ...b, parentId: null } : b));
    repairReferences(dst);
    const m = defaultMapping(src, dst, [walk, wave]);
    const srcHead = src.bones.find((b) => b.name === 'head')!.id;
    assert.equal(m.bones[srcHead], null);
    // Explicitly send the source "torso" motion to the target "root" bone and skip "windup-key".
    const id = (p: Project, n: string) => p.bones.find((b) => b.name === n)!.id;
    m.bones[id(src, 'torso')] = id(dst, 'root');
    m.bones[id(src, 'root')] = null;
    m.bones[id(src, 'windup-key')] = null;
    const rep = importAnimations(dst, src, [walk, wave], m);
    assert.deepEqual(rep.imported.map((x) => x.name), ['walk-2', 'wave-2']);
    const um = Object.fromEntries(rep.unmatched.map((u) => [u.name, u.keys]));
    assert.ok(um.head > 0 && um['windup-key'] > 0 && um.root > 0, JSON.stringify(rep.unmatched));
    const w2 = dst.animations.find((a) => a.name === 'walk-2')!;
    const sWalk = src.animations.find((a) => a.id === walk)!;
    assert.deepEqual(w2.tracks[id(dst, 'root')], sWalk.tracks[id(src, 'torso')], 'torso motion landed on root');
    assert.equal(w2.tracks[id(dst, 'windup-key')], undefined);
    assert.equal(rep.mixes, 1);
    assert.equal(mixDuration(dst, w2.id, dst.animations.find((a) => a.name === 'wave-2')!.id), 0.4);
    assert.equal(usedRefs(src, [walk]).bones.size, 12);
  });

  it('two sources onto one target is reported as a conflict (first wins); image/deform/draw-order keys are remapped or reported', () => {
    const src = legacy();
    src.version = 2;
    const dst = renamedCopy(src);
    dst.animations = [];
    const wave = src.animations.find((a) => a.name === 'wave')!;
    const head = src.attachments.find((a) => a.name === 'head')!;
    const key = src.attachments.find((a) => a.name === 'key')!;
    wave.slots = { [head.id]: { image: [{ time: 0.2, imageId: src.images[1].id }], opacity: [{ time: 0, value: [0.5], interp: 'linear' }], deform: [{ time: 0, value: [1, 2], interp: 'linear' }] } };
    wave.drawOrder = [{ time: 0.5, order: src.attachments.map((a) => a.id).reverse() }];
    const m = defaultMapping(src, dst, [wave.id]);
    const id = (p: Project, n: string) => p.bones.find((b) => b.name === n)!.id;
    m.bones[id(src, 'torso')] = id(dst, 'head');
    m.attachments[key.id] = null;
    const rep = importAnimations(dst, src, [wave.id], m);
    assert.ok(rep.conflicts.some((c) => /both map to “head”/.test(c)), rep.conflicts.join('\n'));
    assert.ok(rep.dropped.some((d) => /deform key/.test(d)));
    assert.ok(rep.dropped.some((d) => /draw-order keys list 1 unmatched/.test(d)));
    const out = dst.animations[0];
    const dHead = dst.attachments.find((a) => a.name === 'head')!;
    assert.equal(out.slots![dHead.id].image![0].imageId, dst.images.find((i) => i.name === src.images[1].name)!.id);
    repairReferences(dst);
    assert.equal(out.drawOrder![0].order.length, dst.attachments.length, 'integrity completes the draw order');
    assert.ok(parseProject(serializeProject(dst)).ok);
  });
});

describe('durable key clipboard', () => {
  it('stores names; resolves into another project by name; drops and reports what does not resolve', () => {
    const a = legacy();
    const b = renamedCopy(a);
    const wave = a.animations.find((x) => x.name === 'wave')!;
    const arm = a.bones.find((x) => x.name === 'arm-front')!;
    const head = a.bones.find((x) => x.name === 'head')!;
    const refs = [...wave.tracks[arm.id].rotate, ...wave.tracks[head.id].rotate].map((k, i) => ({ lane: boneLane(i < wave.tracks[arm.id].rotate.length ? arm.id : head.id, 'rotate'), time: k.time }));
    const clip = copyKeys(wave, refs)!;
    const pc = parsePortable(JSON.parse(JSON.stringify(toPortable(a, clip))))!;
    assert.ok(pc, 'survives a JSON (storage) round trip');
    assert.equal(pc.names.bones[arm.id], 'arm-front');
    b.bones = b.bones.filter((x) => x.name !== 'head').map((x) => (x.parentId === `x_${head.id}` ? { ...x, parentId: null } : x));
    repairReferences(b);
    const r = resolvePortable(b, pc);
    assert.deepEqual(r.unresolved, ['bone “head”']);
    assert.equal(r.dropped, wave.tracks[head.id].rotate.length);
    const bWave = b.animations.find((x) => x.name === 'wave')!;
    bWave.tracks[`x_${arm.id}`].rotate = [];
    const res = pasteKeys(bWave, r.clip, 0);
    assert.equal(res.refs.length, wave.tracks[arm.id].rotate.length);
    assert.deepEqual(bWave.tracks[`x_${arm.id}`].rotate.map((k) => k.value), wave.tracks[arm.id].rotate.map((k) => k.value));
  });

  it('same project: ids are kept, single-bone retarget still works; malformed records are rejected', () => {
    const a = legacy();
    const wave = a.animations.find((x) => x.name === 'wave')!;
    const arm = a.bones.find((x) => x.name === 'arm-front')!;
    const clip = copyKeys(wave, wave.tracks[arm.id].rotate.map((k) => ({ lane: boneLane(arm.id, 'rotate'), time: k.time })))!;
    const r = resolvePortable(a, toPortable(a, clip));
    assert.deepEqual(r.clip, clip);
    assert.equal(parsePortable({ format: 'rigsmith.keys', version: 1, items: [{ lane: 'zzz', dt: 0, key: {} }], names: { bones: {}, attachments: {}, constraints: {}, images: {} } }), null);
    assert.equal(parsePortable(null), null);
    assert.equal(parsePortable({ format: 'other' }), null);
  });
});
