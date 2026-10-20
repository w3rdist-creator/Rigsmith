// R11 clipping masks: the v3 format (one level, no self/emitter masks), integrity when a
// mask goes away, runtime export/load by name and Lottie refusal. Pixels: the R11 e2e
// compares exports with the independent reference compositor.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportRuntime } from '../../src/model/exportRuntime.ts';
import { parseProject, requiredVersion, serializeProject, v3Features } from '../../src/model/format.ts';
import { repairReferences } from '../../src/model/integrity.ts';
import { exportLottie } from '../../src/model/lottie.ts';
import { setClip } from '../../src/model/masks.ts';
import { loadRuntime } from '../../src/runtime/load.ts';
import { lottieProject } from '../support/lottie-fixture.ts';
import { richProject } from '../support/runtime-fixture.ts';

function clipped() {
  const p = richProject();
  assert.deepEqual(setClip(p.attachments, 'a_bead2', 'a_bead1'), []);
  return p;
}

describe('clipping masks', () => {
  it('setClip refuses self, chains, emitters and missing masks', () => {
    const p = clipped();
    assert.match(setClip(p.attachments, 'a_torso', 'a_torso')[0], /cannot clip itself/);
    assert.match(setClip(p.attachments, 'a_bead1', 'a_torso')[0], /is a mask for another attachment/);
    assert.match(setClip(p.attachments, 'a_torso', 'a_bead2')[0], /is itself clipped/);
    assert.match(setClip(p.attachments, 'a_torso', 'nope')[0], /missing attachment/);
    p.attachments.find((a) => a.id === 'a_upper')!.emitter = { recipe: 'x', rate: 1 };
    assert.match(setClip(p.attachments, 'a_torso', 'a_upper')[0], /emitter/);
    assert.deepEqual(setClip(p.attachments, 'a_bead2', null), []);
    assert.equal(p.attachments.find((a) => a.id === 'a_bead2')!.clip, undefined);
  });

  it('v3 round-trip; invalid clips in a file are refused', () => {
    const p = clipped();
    assert.ok(v3Features(p).includes('clipping masks'));
    assert.equal(requiredVersion(p), 3);
    const text = serializeProject(p);
    const back = parseProject(text);
    assert.ok(back.ok && back.project.attachments.find((a) => a.id === 'a_bead2')!.clip === 'a_bead1');
    const raw = JSON.parse(text);
    const i = (id: string) => raw.attachments.findIndex((a: any) => a.id === id);
    const bad = (f: (x: any) => void, re: RegExp) => {
      const r = structuredClone(raw);
      f(r);
      const res = parseProject(JSON.stringify(r));
      assert.ok(!res.ok && res.errors.some((e) => re.test(e)), `${re}: ${JSON.stringify(res)}`);
    };
    bad((r) => (r.version = 2), /clipping masks requires project version 3/);
    bad((r) => (r.attachments[i('a_bead2')].clip = 'gone'), /missing attachment "gone"/);
    bad((r) => (r.attachments[i('a_bead1')].clip = 'a_torso'), /one level deep/);
  });

  it('deleting the mask unclips (integrity); runtime export names the mask; Lottie refuses', () => {
    const p = clipped();
    const rt = exportRuntime(p);
    assert.equal(rt.attachments.find((a) => a.name === 'bead2')!.clip, 'bead1');
    assert.equal(loadRuntime(JSON.parse(JSON.stringify(rt))).attachments.find((a) => a.name === 'bead2')!.clip, 'bead1');
    p.attachments = p.attachments.filter((a) => a.id !== 'a_bead1');
    const notes = repairReferences(p);
    assert.equal(p.attachments.find((a) => a.id === 'a_bead2')!.clip, undefined);
    assert.ok(notes.some((n) => /bead2 is no longer clipped/.test(n)));
    const lp = lottieProject();
    setClip(lp.attachments, lp.attachments[1].id, lp.attachments[0].id);
    const l = exportLottie(lp, lp.animations[0].name, null);
    assert.ok(!l.ok && l.diagnostics.some((d) => d.feature === 'clipping mask'));
  });
});
