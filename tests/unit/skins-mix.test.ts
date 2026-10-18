import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { evaluate } from '../../src/model/evaluate.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { repairReferences } from '../../src/model/integrity.ts';
import type { MixPlan } from '../../src/model/mix.ts';
import { evaluateMix, mixDuration, mixPose, mixState, planLength, setMixRule } from '../../src/model/mix.ts';
import { addIk } from '../../src/model/rigOps.ts';
import { addSkin, attachmentImages, deleteSkin, duplicateSkin, renameSkin, setSkinEntry, skinDiagnostics, skinReplacement } from '../../src/model/skinOps.ts';
import type { Animation, Project } from '../../src/model/types.ts';
import { emptyTrack } from '../../src/model/types.ts';

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/legacy-v1.rig.json');
function load(text: string): Project {
  const r = parseProject(text);
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return (r as { project: Project }).project;
}
const legacy = () => load(readFileSync(FIXTURE, 'utf8'));
const imageOf = (p: Project, attName: string, anim: Animation | null, t: number, skinId?: string) =>
  p.images.find((i) => i.id === evaluate(p, anim, t, { skinId }).attachments.find((f) => f.att.name === attName)!.image!.id)!.name;

describe('skins', () => {
  it('entries replace the setup image wherever it shows (incl. image keys); `from` entries replace keyed images', () => {
    const p = legacy();
    p.version = 2;
    const head = p.attachments.find((a) => a.name === 'head')!;
    const [setupImg, keyedImg, gold, goldKeyed] = [head.imageId, 'img_key', 'img_torso', 'img_shin'];
    const anim = p.animations[0];
    anim.slots = { [head.id]: { image: [{ time: 0.2, imageId: keyedImg }, { time: 0.4, imageId: setupImg }] } };
    addSkin(p, 'skin_gold', 'gold');
    setSkinEntry(p, 'skin_gold', head.id, null, gold);
    const nm = (id: string) => p.images.find((i) => i.id === id)!.name;
    assert.equal(imageOf(p, 'head', anim, 0.1, 'skin_gold'), nm(gold), 'setup image replaced');
    assert.equal(imageOf(p, 'head', anim, 0.3, 'skin_gold'), nm(keyedImg), 'keyed image without a from-entry shows as keyed');
    assert.equal(imageOf(p, 'head', anim, 0.5, 'skin_gold'), nm(gold), 'an image key back to the setup image is skinned too');
    setSkinEntry(p, 'skin_gold', head.id, keyedImg, goldKeyed);
    assert.equal(imageOf(p, 'head', anim, 0.3, 'skin_gold'), nm(goldKeyed), 'from-entry replaces the keyed image');
    assert.equal(imageOf(p, 'head', anim, 0.3), nm(keyedImg), 'no skin: unchanged');
    assert.equal(skinReplacement(p, 'skin_gold', head.id, keyedImg), goldKeyed);
    assert.deepEqual(attachmentImages(p, head.id), [setupImg, keyedImg]);
    // Round trip incl. `from`; a from equal to the setup image normalizes to a plain entry.
    const back = load(serializeProject(p));
    assert.deepEqual(back.skins, p.skins);
    setSkinEntry(p, 'skin_gold', head.id, null, null);
    assert.deepEqual(p.skins![0].entries, [{ attachmentId: head.id, imageId: goldKeyed, from: keyedImg }], 'clearing one entry keeps the other');
  });

  it('add / duplicate / rename (unique) / delete; integrity drops entries of removed images; format rejects bad entries', () => {
    const p = legacy();
    p.version = 2;
    const head = p.attachments.find((a) => a.name === 'head')!;
    addSkin(p, 's1', 'gold');
    setSkinEntry(p, 's1', head.id, null, 'img_torso');
    const dup = duplicateSkin(p, 's1', 's2')!;
    assert.equal(dup.name, 'gold-copy');
    assert.deepEqual(dup.entries, p.skins![0].entries);
    assert.notEqual(dup.entries[0], p.skins![0].entries[0], 'entries copied, not shared');
    assert.match(renameSkin(p, 's2', 'gold')!, /already exists/);
    assert.match(renameSkin(p, 's2', '  ')!, /needs a name/);
    assert.equal(renameSkin(p, 's2', 'silver'), null);
    p.images = p.images.filter((i) => i.id !== 'img_torso');
    p.attachments = p.attachments.filter((a) => a.imageId !== 'img_torso');
    repairReferences(p);
    assert.deepEqual(p.skins!.map((s) => s.entries.length), [0, 0]);
    deleteSkin(p, 's2');
    assert.deepEqual(p.skins!.map((s) => s.name), ['gold']);
    const o = JSON.parse(serializeProject(p));
    o.skins[0].entries = [{ attachmentId: head.id, imageId: 'img_key', from: 'nope' }];
    const r = parseProject(JSON.stringify(o));
    assert.ok(!r.ok && r.errors.some((e) => /from references missing image/.test(e)));
    o.skins[0].entries = [{ attachmentId: head.id, imageId: 'img_key' }, { attachmentId: head.id, imageId: 'img_head' }];
    const r2 = parseProject(JSON.stringify(o));
    assert.ok(!r2.ok && r2.errors.some((e) => /appears twice/.test(e)));
  });

  it('diagnostics: aspect mismatch (stronger wording on meshes), size info, redundant, never-shown from, empty, shared images', () => {
    const p = legacy();
    p.version = 2;
    const head = p.attachments.find((a) => a.name === 'head')!;
    const headIm = p.images.find((i) => i.id === head.imageId)!;
    p.images.push({ ...headIm, id: 'img_wide', name: 'wide.png', width: headIm.width * 2, height: headIm.height });
    p.images.push({ ...headIm, id: 'img_big', name: 'big.png', width: headIm.width * 2, height: headIm.height * 2 });
    addSkin(p, 'a', 'a');
    addSkin(p, 'b', 'b');
    addSkin(p, 'c', 'c');
    setSkinEntry(p, 'a', head.id, null, 'img_wide');
    setSkinEntry(p, 'b', head.id, null, 'img_big');
    setSkinEntry(p, 'b', p.attachments[0].id, 'img_key', 'img_wide');
    const d = skinDiagnostics(p);
    const has = (lvl: string, re: RegExp) => d.some((x) => x.level === lvl && re.test(x.message));
    assert.ok(has('warning', /different aspect ratio/), JSON.stringify(d));
    assert.ok(has('info', /draws at its own size/));
    assert.ok(has('info', /never used/));
    assert.ok(has('info', /Empty/));
    assert.ok(has('info', /shared by 2 skins/));
    head.mesh = { points: [0, 0, headIm.width, 0, headIm.width, headIm.height, 0, headIm.height], triangles: [0, 1, 2, 0, 2, 3], hull: 4 };
    assert.ok(skinDiagnostics(p).some((x) => /on this mesh it will stretch/.test(x.message)));
  });
});

/** Two animations on the legacy rig: A rotates the torso to 170°, B to −170° and keys the head; B leaves the arm unkeyed. */
function mixRig(): { p: Project; A: string; B: string; C: string; torso: string; arm: string; head: string } {
  const p = legacy();
  p.version = 2;
  const id = (n: string) => p.bones.find((b) => b.name === n)!.id;
  const [torso, arm, head] = [id('torso'), id('arm-front'), id('head')];
  const mk = (aid: string, name: string, tracks: Record<string, any>): Animation => ({ id: aid, name, duration: 1, fps: 30, loop: true, tracks });
  const k = (v: number[]) => [{ time: 0, value: v, interp: 'linear' as const }];
  p.animations = [
    mk('A', 'a', { [torso]: { ...emptyTrack(), rotate: k([170]) }, [arm]: { ...emptyTrack(), rotate: k([40]) } }),
    mk('B', 'b', { [torso]: { ...emptyTrack(), rotate: k([-170]) }, [head]: { ...emptyTrack(), translate: k([90, 10]) } }),
    mk('C', 'c', { [torso]: { ...emptyTrack(), rotate: k([-120]) } }),
  ];
  return { p, A: 'A', B: 'B', C: 'C', torso, arm, head };
}
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('mixing', () => {
  it('starts exactly on A, ends exactly on B, rotates the short way round', () => {
    const { p, torso } = mixRig();
    const plan: MixPlan = { entries: [{ animId: 'A', start: 0, mix: 0 }, { animId: 'B', start: 0.5, mix: 0.4 }], missing: 'setup' };
    const a = evaluate(p, p.animations[0], 0.5);
    const atStart = evaluateMix(p, plan, 0.5);
    for (const [bid, m] of a.world) assert.deepEqual(atStart.world.get(bid), m, 'transition start = A');
    const b = evaluate(p, p.animations[1], 0.4);
    const atEnd = evaluateMix(p, plan, 0.9);
    for (const [bid, m] of b.world) for (const k of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) assert.ok(close(atEnd.world.get(bid)![k], m[k], 1e-9), 'transition end = B (setup policy)');
    const mid = mixPose(p, plan, 0.7).get(torso)!.rotation;
    assert.ok(close(Math.abs(mid), 180), `170° → −170° passes through 180°, not 0° (${mid})`);
    assert.equal(planLength(p, plan), 1.5);
  });

  it('missing tracks: setup blends the unkeyed arm back to setup; hold keeps following A; the head keyed only in B blends in under both', () => {
    const { p, arm, head } = mixRig();
    const setupArm = p.bones.find((b) => b.id === arm)!.rotation;
    const setupHead = p.bones.find((b) => b.id === head)!;
    for (const missing of ['setup', 'hold'] as const) {
      const plan: MixPlan = { entries: [{ animId: 'A', start: 0, mix: 0 }, { animId: 'B', start: 0, mix: 1 }], missing };
      const end = mixPose(p, plan, 1);
      const half = mixPose(p, plan, 0.5);
      if (missing === 'setup') {
        assert.ok(close(end.get(arm)!.rotation, setupArm), 'arm back to setup');
        assert.ok(close(half.get(arm)!.rotation, (40 + setupArm) / 2), 'halfway');
      } else {
        assert.ok(close(end.get(arm)!.rotation, 40) && close(half.get(arm)!.rotation, 40), 'arm keeps A’s value');
      }
      assert.ok(close(half.get(head)!.x, (setupHead.x + 90) / 2) && close(end.get(head)!.x, 90), `${missing}: head blends from setup to B`);
    }
  });

  it('an interruption is continuous: the pose just before and at the interrupt agree, then blends to C', () => {
    const { p, torso } = mixRig();
    const plan: MixPlan = { entries: [{ animId: 'A', start: 0, mix: 0 }, { animId: 'B', start: 0.2, mix: 0.6 }, { animId: 'C', start: 0.5, mix: 0.4 }], missing: 'setup' };
    const before = mixPose(p, { ...plan, entries: plan.entries.slice(0, 2) }, 0.5).get(torso)!.rotation;
    const at = mixPose(p, plan, 0.5).get(torso)!.rotation;
    const after = mixPose(p, plan, 0.5 + 1e-6).get(torso)!.rotation;
    assert.ok(close(at, before) && Math.abs(after - at) < 1e-3, `no pop at the interrupt (${before} / ${at} / ${after})`);
    assert.ok(close(mixPose(p, plan, 0.9).get(torso)!.rotation, -120), 'ends on C');
    assert.deepEqual(mixState(plan, 0.35).weights.map((w) => Math.round(w * 100) / 100), [1, 0.25, 0]);
    assert.equal(mixState(plan, 0.55).discrete, 1, 'B dominates discrete state until C reaches 0.5');
    assert.equal(mixState(plan, 0.75).discrete, 2);
  });

  it('constraints run after blending (IK reaches a blended target); opacity blends; mix rules persist', () => {
    const { p } = mixRig();
    const ids = { ik: 'ik1', target: 'tgt' };
    addIk(p, 'b_fore_front', true, ids);
    const tgt = p.bones.find((b) => b.id === 'tgt')!;
    // A keys the target near the shoulder (reachable), B far away (unreachable).
    p.animations[0].tracks.tgt = { ...emptyTrack(), translate: [{ time: 0, value: [tgt.x - 20, tgt.y + 10], interp: 'linear' }] };
    p.animations[1].tracks.tgt = { ...emptyTrack(), translate: [{ time: 0, value: [tgt.x + 200, tgt.y + 150], interp: 'linear' }] };
    const plan: MixPlan = { entries: [{ animId: 'A', start: 0, mix: 0 }, { animId: 'B', start: 0, mix: 1 }], missing: 'setup' };
    const [L1, L2] = ['b_arm_front', 'b_fore_front'].map((id) => p.bones.find((b) => b.id === id)!.length);
    for (const T of [0, 0.3, 0.6, 1]) {
      const fr = evaluateMix(p, plan, T);
      const sh = fr.world.get('b_arm_front')!, fm = fr.world.get('b_fore_front')!, t = fr.world.get('tgt')!;
      const tip = { x: fm.tx + fm.a * L2, y: fm.ty + fm.b * L2 };
      const d = Math.hypot(t.tx - sh.tx, t.ty - sh.ty);
      const gap = Math.hypot(tip.x - t.tx, tip.y - t.ty);
      const want = d > L1 + L2 ? d - (L1 + L2) : 0;
      assert.ok(Math.abs(gap - want) < 1e-6, `T=${T}: IK solved on the blended pose (gap ${gap}, expected ${want})`);
    }
    const head = p.attachments.find((a) => a.name === 'head')!;
    p.animations[1].slots = { [head.id]: { opacity: [{ time: 0, value: [0], interp: 'linear' }] } };
    assert.ok(close(evaluateMix(p, plan, 0.25).attachments.find((f) => f.att.id === head.id)!.opacity, 0.75), 'opacity 1 → 0, a quarter in');
    setMixRule(p, 'A', 'B', 0.3);
    assert.equal(mixDuration(p, 'A', 'B'), 0.3);
    assert.equal(mixDuration(p, 'B', 'A'), 0.2, 'default');
    assert.deepEqual(load(serializeProject(p)).mixes, [{ from: 'A', to: 'B', duration: 0.3 }]);
    setMixRule(p, 'A', 'B', null);
    assert.deepEqual(p.mixes, []);
    // Rules for deleted animations are dropped on repair.
    setMixRule(p, 'A', 'B', 0.3);
    p.animations = p.animations.filter((a) => a.id !== 'B');
    repairReferences(p);
    assert.deepEqual(p.mixes, []);
  });
});
