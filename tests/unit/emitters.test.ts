// R9 FX sockets: emitter attachments in the v3 format, keyable rate, evaluation (rate
// sampled, nothing drawn or bounded), runtime export/load, Lottie refusal, clip specs,
// integrity and the editor's deterministic stand-in.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyClip, exportClip, formatClipSpec, parseClipText } from '../../src/model/clipSpec.ts';
import { standInParticles } from '../../src/model/emitters.ts';
import { evaluate, frameBounds } from '../../src/model/evaluate.ts';
import { exportRuntime } from '../../src/model/exportRuntime.ts';
import { parseProject, requiredVersion, serializeProject, v3Features } from '../../src/model/format.ts';
import { repairReferences } from '../../src/model/integrity.ts';
import { exportLottie } from '../../src/model/lottie.ts';
import { keySlotScalar } from '../../src/model/rigOps.ts';
import { loadRuntime } from '../../src/runtime/load.ts';
import { lottieProject } from '../support/lottie-fixture.ts';
import { richProject } from '../support/runtime-fixture.ts';

function withEmitter() {
  const p = richProject();
  const bead = p.attachments.find((a) => a.name === 'bead1')!;
  bead.emitter = { recipe: 'glint.sparkle', rate: 12 };
  const wave = p.animations.find((a) => a.name === 'wave')!;
  keySlotScalar(wave, bead.id, 'rate', 0.2, 0);
  keySlotScalar(wave, bead.id, 'rate', 0.6, 40);
  return { p, bead, wave };
}

describe('format and evaluation', () => {
  it('v3 round-trip; bad recipes, rates, rate keys on a plain attachment and emitter meshes are refused', () => {
    const { p } = withEmitter();
    assert.ok(v3Features(p).includes('emitters'));
    assert.equal(requiredVersion(p), 3);
    const text = serializeProject(p);
    const back = parseProject(text);
    assert.ok(back.ok);
    if (back.ok) {
      assert.deepEqual(back.project.attachments.find((a) => a.name === 'bead1')!.emitter, { recipe: 'glint.sparkle', rate: 12 });
      assert.deepEqual(back.project.animations.find((a) => a.name === 'wave')!.slots!.a_bead1.rate!.map((k) => k.value[0]), [0, 40]);
    }
    const raw = JSON.parse(text);
    const i = raw.attachments.findIndex((a: any) => a.name === 'bead1');
    const w = raw.animations.findIndex((a: any) => a.name === 'wave');
    const bad = (f: (x: any) => void, re: RegExp) => {
      const r = structuredClone(raw);
      f(r);
      const res = parseProject(JSON.stringify(r));
      assert.ok(!res.ok && res.errors.some((e) => re.test(e)), `${re}: ${JSON.stringify(res)}`);
    };
    bad((r) => (r.version = 2), /emitters requires project version 3/);
    bad((r) => (r.attachments[i].emitter.recipe = 'has space'), /recipe must be/);
    bad((r) => (r.attachments[i].emitter.rate = -1), /rate must be from 0 to 1000/);
    bad((r) => (r.animations[w].slots.a_bead1.rate[1].value = [2000]), /from 0 to 1000/);
    bad((r) => (r.animations[w].slots.a_torso = { rate: [{ time: 0, value: [1], interp: 'linear' }] }), /needs the attachment to be an emitter/);
    bad((r) => (r.attachments.find((a: any) => a.mesh).emitter = { recipe: 'x', rate: 1 }), /cannot have a mesh/);
  });

  it('evaluation samples the rate; emitters draw nothing and do not count toward bounds', () => {
    const { p, wave } = withEmitter();
    const at = (t: number) => evaluate(p, wave, t).attachments.find((f) => f.att.name === 'bead1')!.emitter!;
    assert.deepEqual(at(0.1), { recipe: 'glint.sparkle', rate: 0 }, 'holds the first key');
    assert.ok(Math.abs(at(0.4).rate - 20) < 1e-9);
    assert.equal(evaluate(p, null, 0).attachments.find((f) => f.att.name === 'bead1')!.emitter!.rate, 12, 'setup rate');
    const plain = richProject();
    // bead2 sits where bead1 does, so hide it: then only bead1's quad can extend the bounds.
    for (const q of [p, plain]) q.attachments.find((a) => a.name === 'bead2')!.hidden = true;
    const b1 = frameBounds(evaluate(p, null, 0))!, b2 = frameBounds(evaluate(plain, null, 0))!;
    const plainNoBead = structuredClone(plain);
    plainNoBead.attachments = plainNoBead.attachments.filter((a) => a.name !== 'bead1');
    assert.deepEqual(b1, frameBounds(evaluate(plainNoBead, null, 0)));
    assert.notDeepEqual(b1, b2, 'the fixture bead does extend the bounds when drawn');
  });

  it('removing the emitter drops its rate keys (integrity)', () => {
    const { p, bead, wave } = withEmitter();
    delete bead.emitter;
    const notes = repairReferences(p);
    assert.equal(wave.slots!.a_bead1.rate, undefined);
    assert.ok(notes.some((n) => /rate key\(s\) of bead1 removed/.test(n)));
  });
});

describe('exports', () => {
  it('runtime: the emitter, its rate keys and the per-frame rate; the loader keeps them', () => {
    const { p } = withEmitter();
    const rt = exportRuntime(p);
    assert.equal(rt.version, 3);
    assert.deepEqual(rt.attachments.find((a) => a.name === 'bead1')!.emitter, { recipe: 'glint.sparkle', rate: 12 });
    const wave = rt.animations.find((a) => a.name === 'wave')!;
    assert.deepEqual(wave.slots.bead1.rate!.map((k) => k.value), [[0], [40]]);
    const f12 = wave.bakedSlots![12].find((s) => s.attachment === 'bead1')!;
    assert.equal(f12.rate, 20);
    assert.equal(wave.bakedSlots![12].find((s) => s.attachment === 'torso')!.rate, undefined);
    const back = loadRuntime(JSON.parse(JSON.stringify(rt)));
    assert.deepEqual(back.attachments.find((a) => a.name === 'bead1')!.emitter, { recipe: 'glint.sparkle', rate: 12 });
    assert.equal(back.animations.find((a) => a.name === 'wave')!.slots!.bead1.rate!.length, 2);
  });

  it('Lottie refuses emitters by name', () => {
    const lp = lottieProject();
    lp.attachments[0].emitter = { recipe: 'sparkle', rate: 5 };
    const r = exportLottie(lp, lp.animations[0].name, null);
    assert.ok(!r.ok && r.diagnostics.some((d) => d.feature === 'emitter' && /particle recipe “sparkle”/.test(d.message)));
  });

  it('clip specs carry rate keys; rate on a plain attachment is an error', () => {
    const { p, wave } = withEmitter();
    const spec = exportClip(p, wave.id);
    assert.deepEqual((spec.slots as any).bead1.rate.map((k: any) => k[1]), [0, 40]);
    const parsed = parseClipText(formatClipSpec(spec), 'w.yaml');
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const r = applyClip(p, parsed.spec, 'replace');
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.project.animations.find((a) => a.id === wave.id)!.slots!.a_bead1.rate, wave.slots!.a_bead1.rate);
    const bad = applyClip(p, { name: 'wave', slots: { torso: { rate: [[0, 5]] }, bead1: { rate: [[0, 5000]] } } }, 'merge');
    assert.ok(!bad.ok && bad.errors.some((e) => /not an emitter/.test(e)) && bad.errors.some((e) => /rate must be from 0 to 1000/.test(e)), JSON.stringify(bad));
  });
});

describe('stand-in preview', () => {
  it('deterministic; none at rate 0; about rate × life particles, fading with age', () => {
    assert.deepEqual(standInParticles(0, 1), []);
    assert.deepEqual(standInParticles(30, 1.234), standInParticles(30, 1.234));
    const ps = standInParticles(30, 2);
    assert.ok(ps.length >= 17 && ps.length <= 19, `${ps.length}`);
    assert.ok(ps.every((q) => q.alpha > 0 && q.alpha <= 1 && Math.abs(Math.atan2(q.y, q.x)) <= (35.01 * Math.PI) / 180));
    assert.ok(standInParticles(1000, 5).length <= 200, 'capped');
  });
});
