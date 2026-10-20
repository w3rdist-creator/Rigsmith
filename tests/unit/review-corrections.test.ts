// Fable review corrections (LP-001, LP-002, LP-007, LP-009, LP-011, paste retarget,
// the Lottie IK wording and the constraint-mix blend that
// the LP-001 option relies on during sequence transitions) — model level.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { defaultMapping, drivenByConstraints, importAnimations, reportSummary } from '../../src/model/animImport.ts';
import { scheduleSequence } from '../../src/model/clipSequence.ts';
import { evaluate } from '../../src/model/evaluate.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { boneLane, copyKeys, pasteKeys } from '../../src/model/keys.ts';
import { lottieDiagnostics } from '../../src/model/lottie.ts';
import { checkCapacity } from '../../src/model/sequence.ts';
import { evaluateMix, mixConstraintValues } from '../../src/model/mix.ts';
import { firstIdle, guideArt, guideBlocked, guideSteps, meshArt, startRig } from '../../src/model/onboarding.ts';
import type { Animation, Bone, Project } from '../../src/model/types.ts';
import { emptyProject, emptyTrack } from '../../src/model/types.ts';

const bone = (id: string, name: string, parentId: string | null, x: number, rotation: number, length: number, scaleX = 1): Bone => ({ id, name, parentId, x, y: 0, rotation, scaleX, scaleY: 1, length, color: '#fff' });
const deg = (m: { a: number; b: number }) => (Math.atan2(m.b, m.a) * 180) / Math.PI;
const near = (a: number, b: number, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≈ ${b}`);

/** Source: root → upper (setup −90°) → lower, no constraints; "raise" keys upper −90 → −30. */
function source(): Project {
  const p = emptyProject('src');
  p.version = 2;
  p.bones = [bone('s_root', 'root', null, 0, 0, 0), bone('s_upper', 'upper', 's_root', 0, -90, 100), bone('s_lower', 'lower', 's_upper', 100, 0, 100)];
  const raise: Animation = { id: 's_raise', name: 'raise', duration: 1, fps: 30, loop: false, tracks: {} };
  raise.tracks.s_upper = { ...emptyTrack(), rotate: [{ time: 0, value: [-90], interp: 'linear' }, { time: 1, value: [-30], interp: 'linear' }] };
  raise.tracks.s_lower = { ...emptyTrack(), translate: [{ time: 0, value: [100, 5], interp: 'linear' }], scale: [{ time: 0, value: [1.5, 1], interp: 'linear' }] };
  p.animations = [raise];
  return p;
}

/** Target: same names, upper setup −60°, lower setup x 120 / scaleX 2, one two-bone IK at mix 1. */
function target(ikMix = 1): Project {
  const p = emptyProject('dst');
  p.version = 2;
  p.bones = [bone('t_root', 'root', null, 0, 0, 0), bone('t_upper', 'upper', 't_root', 0, -60, 100), bone('t_lower', 'lower', 't_upper', 120, 0, 100, 2), bone('t_tgt', 'tgt', 't_root', 150, -90, 0)];
  p.ik = [{ id: 'ik1', name: 'arm-ik', bones: ['t_upper', 't_lower'], target: 't_tgt', mix: ikMix, bendPositive: true }];
  return p;
}

function importRaise(dst: Project, options?: Parameters<typeof importAnimations>[4]) {
  const src = source();
  const rep = importAnimations(dst, src, ['s_raise'], defaultMapping(src, dst, ['s_raise']), options);
  return { rep, out: dst.animations.find((a) => a.name === rep.imported[0].name)! };
}

describe('LP-001: imported keys on constraint-driven bones', () => {
  it('default (option off): the IK is reported as overriding the keys, and the keys indeed have no effect', () => {
    const dst = target();
    const { rep, out } = importRaise(dst);
    assert.deepEqual(rep.driven, [{ constraintId: 'ik1', constraint: 'arm-ik', kind: 'ik', mix: 1, bones: [{ name: 'upper', keys: 2 }, { name: 'lower', keys: 0 }].filter((b) => b.keys), keys: 2, muted: false }]);
    assert.match(reportSummary(rep), /2 key\(s\) overridden by arm-ik/);
    assert.equal(out.constraints, undefined, 'nothing is changed without the option');
    // Proof the keys are dead: upper's world angle is the same at the −90 key and the −30 key.
    const a = deg(evaluate(dst, out, 0).world.get('t_upper')!), b = deg(evaluate(dst, out, 1).world.get('t_upper')!);
    near(a, b, 1e-9, 'IK overrides the rotate keys');
  });

  it('option on: the imported copy keys that IK to mix 0, so the keys play; the setup IK is untouched', () => {
    const dst = target();
    const { rep, out } = importRaise(dst, { muteConstraints: ['ik1'] });
    assert.equal(rep.driven[0].muted, true);
    assert.match(reportSummary(rep), /mix keyed to 0: arm-ik/);
    assert.ok(!/overridden/.test(reportSummary(rep)));
    assert.deepEqual(out.constraints, { ik1: { mix: [{ time: 0, value: [0], interp: 'step' }] } });
    assert.equal(dst.ik![0].mix, 1, 'setup mix unchanged');
    near(evaluate(dst, out, 1).pose.get('t_upper')!.rotation, -30, 1e-9, 'the key plays');
    near(deg(evaluate(dst, out, 1).world.get('t_upper')!) - deg(evaluate(dst, out, 0).world.get('t_upper')!), 60, 1e-9, 'moves by the keyed 60°');
    assert.ok(parseProject(serializeProject(dst)).ok, 're-opens');
    // Muting an unrelated or unknown id changes nothing.
    const d2 = target();
    const r2 = importRaise(d2, { muteConstraints: ['nope'] });
    assert.equal(r2.out.constraints, undefined);
    assert.equal(r2.rep.driven[0].muted, false);
  });

  it('an IK at setup mix 0 is not reported; keyed mix decides when present', () => {
    assert.deepEqual(importRaise(target(0)).rep.driven, []);
    const p = target(0);
    const anim: Animation = { id: 'a', name: 'a', duration: 1, fps: 30, loop: false, tracks: { t_upper: { ...emptyTrack(), rotate: [{ time: 0, value: [0], interp: 'linear' }] } } };
    anim.constraints = { ik1: { mix: [{ time: 0, value: [0], interp: 'linear' }, { time: 1, value: [0.5], interp: 'linear' }] } };
    assert.equal(drivenByConstraints(p, anim).length, 1, 'keyed mix > 0 somewhere ⇒ reported');
    const q = target(1);
    anim.constraints = { ik1: { mix: [{ time: 0, value: [0], interp: 'step' }] } };
    assert.deepEqual(drivenByConstraints(q, anim), [], 'keyed to 0 throughout ⇒ not reported even at setup mix 1');
  });

  it('existing mix keys of a muted constraint are replaced and the replacement is reported', () => {
    const src = source();
    src.ik = [{ id: 's_ik', name: 'arm-ik', bones: ['s_upper', 's_lower'], target: 's_root', mix: 1, bendPositive: true }];
    src.animations[0].constraints = { s_ik: { mix: [{ time: 0, value: [1], interp: 'linear' }, { time: 1, value: [0.4], interp: 'linear' }] } };
    const dst = target();
    const rep = importAnimations(dst, src, ['s_raise'], defaultMapping(src, dst, ['s_raise']), { muteConstraints: ['ik1'] });
    const out = dst.animations.find((a) => a.name === 'raise')!;
    assert.deepEqual(out.constraints!.ik1.mix, [{ time: 0, value: [0], interp: 'step' }]);
    assert.ok(rep.dropped.some((d) => /2 mix key\(s\) of arm-ik replaced by mix 0/.test(d)), rep.dropped.join('\n'));
  });

  it('rig notes: a different parent and scale keys that reach other descendants here', () => {
    const src = source();
    const dst = target();
    dst.bones.push(bone('t_hand', 'hand', 't_lower', 100, 0, 30));
    dst.bones.find((b) => b.name === 'upper')!.parentId = 't_tgt';
    const rep = importAnimations(dst, src, ['s_raise'], defaultMapping(src, dst, ['s_raise']));
    assert.ok(rep.rig.some((r) => /“upper”: its parent here is “tgt”, in the source “root”/.test(r)), rep.rig.join('\n'));
    assert.ok(rep.rig.some((r) => /“lower” has scale keys; here they also scale 1 bone\(s\).*hand/.test(r)), rep.rig.join('\n'));
  });
});

describe('LP-002: setup-pose offset option', () => {
  it('off copies absolute values (−90 stays −90); on moves by the same amounts around the target setup (−90 → −60)', () => {
    const off = importRaise(target(0)).out;
    assert.deepEqual(off.tracks.t_upper.rotate.map((k) => k.value[0]), [-90, -30]);
    assert.deepEqual(off.tracks.t_lower.translate[0].value, [100, 5]);
    assert.deepEqual(off.tracks.t_lower.scale[0].value, [1.5, 1]);
    const dst = target(0);
    const on = importRaise(dst, { offsetSetup: true }).out;
    assert.deepEqual(on.tracks.t_upper.rotate.map((k) => k.value[0]), [-60, 0]);
    assert.deepEqual(on.tracks.t_lower.translate[0].value, [120, 5]);
    assert.deepEqual(on.tracks.t_lower.scale[0].value, [3, 1]);
    // At the first key the target bone sits at its own setup (no jump).
    near(evaluate(dst, on, 0).pose.get('t_upper')!.rotation, dst.bones[1].rotation);
    const src = source();
    assert.deepEqual(src.animations[0].tracks.s_upper.rotate.map((k) => k.value[0]), [-90, -30], 'source untouched');
  });

  it('equal setups: the offset copies every key exactly (no rounding noise)', () => {
    // Found on Wiz: 65.265 + 145.265 − 145.265 = 65.26499999999999 when added left to right.
    const src = source(), dst = target(0);
    for (const [i, b] of src.bones.entries()) Object.assign(dst.bones[i], { x: b.x, y: b.y, rotation: b.rotation, scaleX: b.scaleX, scaleY: b.scaleY });
    src.bones[1].rotation = dst.bones[1].rotation = 145.265;
    src.animations[0].tracks.s_upper.rotate = [{ time: 0, value: [65.265], interp: 'linear' }, { time: 0.5, value: [77.265], interp: 'linear' }];
    importAnimations(dst, src, ['s_raise'], defaultMapping(src, dst, ['s_raise']), { offsetSetup: true });
    const byName = (p: Project, a: Animation) => Object.fromEntries(Object.entries(a.tracks).map(([id, t]) => [p.bones.find((b) => b.id === id)!.name, t]));
    assert.deepEqual(byName(dst, dst.animations[0]), byName(src, src.animations[0]));
  });

  it('a zero source setup scale copies scale keys unscaled and says so', () => {
    const src = source();
    src.bones[2].scaleX = 0;
    const dst = target(0);
    const rep = importAnimations(dst, src, ['s_raise'], defaultMapping(src, dst, ['s_raise']), { offsetSetup: true });
    assert.deepEqual(dst.animations[0].tracks.t_lower.scale[0].value, [1.5, 1]);
    assert.ok(rep.dropped.some((d) => /“lower”: its source setup scale is 0/.test(d)), rep.dropped.join('\n'));
  });
});

describe('constraint mix blends across a mix transition (no pop at weight 0.5)', () => {
  it('mix values interpolate with the entry weight; the solved pose is continuous', () => {
    const dst = target(1);
    const on: Animation = { id: 'on', name: 'on', duration: 1, fps: 30, loop: true, tracks: {} };
    const off: Animation = { id: 'off', name: 'off', duration: 1, fps: 30, loop: true, tracks: {}, constraints: { ik1: { mix: [{ time: 0, value: [0], interp: 'step' }] } } };
    dst.animations = [on, off];
    const plan = { entries: [{ animId: 'on', start: 0, mix: 0 }, { animId: 'off', start: 1, mix: 0.4 }], missing: 'setup' as const };
    const v = (T: number) => mixConstraintValues(dst, plan, T).mix('ik1', 1);
    near(v(0.5), 1);
    near(v(1.1), 0.75);
    near(v(1.2), 0.5);
    near(v(1.3), 0.25);
    near(v(1.4), 0);
    // Continuous: no frame-to-frame jump larger than the steady IK-to-FK drift at 30 fps.
    let prev = deg(evaluateMix(dst, plan, 1).world.get('t_upper')!), maxStep = 0;
    for (let f = 31; f <= 45; f++) {
      const a = deg(evaluateMix(dst, plan, f / 30).world.get('t_upper')!);
      maxStep = Math.max(maxStep, Math.abs(a - prev));
      prev = a;
    }
    const total = Math.abs(deg(evaluateMix(dst, plan, 1).world.get('t_upper')!) - deg(evaluateMix(dst, plan, 1.5).world.get('t_upper')!));
    assert.ok(total > 1, `the transition moves the arm (${total}°)`);
    assert.ok(maxStep < total / 2, `no pop: largest step ${maxStep}° of ${total}°`);
  });
});

describe('LP-007: clip sequences use the "setup" missing-channel policy', () => {
  it('a sequence plan is missing: "setup" and equals evaluateMix with "setup", not "hold"', () => {
    const p = target(0);
    const a: Animation = { id: 'a', name: 'a', duration: 1, fps: 30, loop: false, tracks: { t_upper: { ...emptyTrack(), rotate: [{ time: 0, value: [20], interp: 'linear' }] } } };
    const b: Animation = { id: 'b', name: 'b', duration: 1, fps: 30, loop: false, tracks: {} };
    p.animations = [a, b];
    const r = scheduleSequence(p, { id: 's', name: 's', steps: [{ animId: 'a', repeat: 1 }, { animId: 'b', repeat: 1 }], loop: false }, 30);
    assert.ok(r.ok);
    assert.equal(r.schedule.plan.missing, 'setup');
    const rot = (plan: typeof r.schedule.plan, T: number) => evaluateMix(p, plan, T).pose.get('t_upper')!.rotation;
    near(rot(r.schedule.plan, 1.9), -60, 1e-9, 'b lacks upper → setup');
    near(rot({ ...r.schedule.plan, missing: 'hold' }, 1.9), 20, 1e-9, '"hold" would keep a’s value');
  });
});

describe('LP-009: unknown top-level fields are reported, not dropped silently', () => {
  it('a v2 file with an unknown top-level key parses with a warning naming it; known files warn nothing new', () => {
    const p = target();
    const obj = JSON.parse(serializeProject(p));
    const r = parseProject(JSON.stringify({ ...obj, timelines: [], 'x-note': 1 }));
    assert.ok(r.ok);
    assert.deepEqual(r.warnings.filter((w) => /Unknown/.test(w)), ['Unknown top-level field(s) ignored — they will not be saved again: "timelines", "x-note".']);
    const plain = parseProject(serializeProject(p));
    assert.ok(plain.ok);
    assert.ok(!plain.warnings.some((w) => /Unknown/.test(w)));
  });
});

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
describe('LP-011: the guide acts only on a project with exactly one original image', () => {
  it('two original images: no art is named, rig/mesh/idle refuse with the reason; one image works as before', () => {
    const p = emptyProject('layered');
    p.images.push({ id: 'i1', name: 'body.png', mime: 'image/png', width: 100, height: 100, dataUrl: PNG }, { id: 'i2', name: 'arm.png', mime: 'image/png', width: 40, height: 20, dataUrl: PNG });
    p.bones.push(bone('r', 'root', null, 0, 0, 40));
    p.attachments.push({ id: 'a1', name: 'body', boneId: null, imageId: 'i1', x: 7, y: 8, rotation: 9, scaleX: 1, scaleY: 1, opacity: 1 }, { id: 'a2', name: 'arm', boneId: 'r', imageId: 'i2', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
    assert.match(guideBlocked(p)!, /one flat PNG .* 2 original images/);
    assert.equal(guideArt(p), null);
    const steps = Object.fromEntries(guideSteps(p).map((s) => [s.id, s]));
    for (const id of ['rig', 'mesh', 'idle']) assert.match(steps[id].detail, /2 original images/, id);
    const before = JSON.stringify(p);
    assert.throws(() => startRig(p, 'i1', { bone: 'b', att: 'a' }, { x: 0, y: 0 }), /one flat PNG/);
    assert.throws(() => meshArt(p, 'a2', 2, 2), /one flat PNG/);
    assert.throws(() => firstIdle(p, 'idle'), /one flat PNG/);
    assert.equal(JSON.stringify(p), before, 'nothing re-bound or zeroed');
    p.images.pop();
    p.attachments.pop();
    assert.equal(guideBlocked(p), null);
    assert.equal(guideArt(p)!.att.id, 'a1');
  });
});

describe('paste retarget is reported', () => {
  it('a one-bone clip pasted with another bone selected says where it went', () => {
    const a: Animation = { id: 'a', name: 'a', duration: 1, fps: 30, loop: false, tracks: { t_upper: { ...emptyTrack(), rotate: [{ time: 0, value: [5], interp: 'linear' }] } } };
    const clip = copyKeys(a, [{ lane: boneLane('t_upper', 'rotate'), time: 0 }])!;
    assert.deepEqual(pasteKeys(a, clip, 0.5, 't_lower').retarget, { from: 't_upper', to: 't_lower' });
    assert.equal(pasteKeys(a, clip, 0.5, 't_upper').retarget, null);
    assert.equal(pasteKeys(a, clip, 0.5, null).retarget, null);
  });
});

describe('RV-008 (carried): the Lottie IK refusal names no command that does not exist', () => {
  it('names the bake that exists (R14: Constraints ▸ Bake, rigsmith bake-constraints)', () => {
    const p = target();
    const d = lottieDiagnostics(p, { id: 'x', name: 'x', duration: 1, fps: 30, loop: false, tracks: {} }).find((x) => x.feature === 'IK constraint')!;
    assert.match(d.message, /Bake constraints first \(Constraints ▸ Bake, or rigsmith bake-constraints\)/);
    assert.match(readFileSync(new URL('../../scripts/rigsmith.ts', import.meta.url).pathname, 'utf8'), /case 'bake-constraints'/);
    assert.match(readFileSync(new URL('../../src/ui/rigPanels.ts', import.meta.url).pathname, 'utf8'), /'data-testid': 'bake-constraints'/);
  });
});

describe('LP-003: the total-pixel limit message', () => {
  it('names the shared CLI limit and the frame budget; a sequence is not told to shorten a range', () => {
    // The Wiz intro at 30 fps, full size (rv009-output/log.txt:9): 342 × 1341 × 1617 ≈ 741.6 M > 600 M.
    const geo = { width: 1341, height: 1617, originX: 0, originY: 0, scale: 1 } as Parameters<typeof checkCapacity>[0];
    const [seq] = checkCapacity(geo, 342, false);
    assert.equal(seq, '342 frames of 1341×1617 px is too large to export (over 600 megapixels in total; the command-line renderer has the same limit). At this size at most 276 frames fit. Lower the scale or FPS.');
    assert.match(checkCapacity(geo, 342)[0], /Lower the scale, FPS or range\.$/);
    assert.deepEqual(checkCapacity(geo, 276, false), [], 'the stated budget fits');
    assert.equal(checkCapacity(geo, 277, false).length, 1);
  });
});
