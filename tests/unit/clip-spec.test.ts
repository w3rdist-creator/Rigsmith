// R6 clip specs: the YAML subset, lossless export → apply (identical evaluate() on every
// frame), authoring conveniences (poses, holds, eases by name, frames/seconds, image
// swaps by name, visibility, draw-order moves, constraint keys) and lint errors.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { applyClip, exportClip, formatClipSpec, lintClip, parseClipText } from '../../src/model/clipSpec.ts';
import type { ClipSpec } from '../../src/model/clipSpec.ts';
import { evaluate } from '../../src/model/evaluate.ts';
import { serializeProject } from '../../src/model/format.ts';
import { addRotationConstraint, keyConstraint, keySlotColor } from '../../src/model/rigOps.ts';
import { setInterpY } from '../../src/model/animation.ts';
import type { Project } from '../../src/model/types.ts';
import { parseYaml, stringifyYaml } from '../../src/model/yamlLite.ts';
import { lottieProject } from '../support/lottie-fixture.ts';
import { richProject } from '../support/runtime-fixture.ts';

/** richProject plus every key kind added since R1: angle keys, colour keys, y easing, off-frame times. */
function fullProject(): Project {
  const p = richProject();
  addRotationConstraint(p, 'tc_f1', 'f1', 'torso', 0.5);
  const wave = p.animations.find((a) => a.name === 'wave')!;
  keyConstraint(wave, 'tc_f1', 'angle', 0, 0);
  keyConstraint(wave, 'tc_f1', 'angle', 0.5, 30);
  keySlotColor(wave, 'a_torso', 0.2, [1, 0.5019607843137255, 0.25098039215686274, 1]);
  keySlotColor(wave, 'a_torso', 0.6, [0.3, 0.7, 0.1234, 0.9]);
  setInterpY(wave.tracks.arm_target.translate[0], 'bezier', [0.1, 0.9, 0.2, 1]);
  wave.tracks.m2.rotate.splice(1, 0, { time: 0.123, value: [12.5], interp: 'step' });
  wave.tracks.torso.translate.push({ time: 0, value: [0, 3.000000000000001], interp: 'linear' });
  return p;
}

function sameEverywhere(a: Project, aId: string, b: Project, bId: string): void {
  const A = a.animations.find((x) => x.id === aId)!, B = b.animations.find((x) => x.id === bId)!;
  assert.deepEqual([B.duration, B.fps, B.loop], [A.duration, A.fps, A.loop]);
  const n = Math.round(A.duration * A.fps);
  for (let f = 0; f <= n; f++) for (const t of [f / A.fps, (f + 0.37) / A.fps]) {
    if (t > A.duration) continue;
    assert.deepEqual(evaluate(b, B, t), evaluate(a, A, t), `${A.name} at ${t}`);
  }
  for (const skin of a.skins ?? []) assert.deepEqual(evaluate(b, B, 0.5, { skinId: skin.id }), evaluate(a, A, 0.5, { skinId: skin.id }));
}

describe('YAML subset', () => {
  it('parses block maps, lists, `- key:` maps, flow lists/maps over lines, scalars and comments', () => {
    const r = parseYaml(`# head
name: "wave #1"   # trailing comment
fps: 30
loop: false
none: ~
list:
  - 1
  - -2.5e3
  - [a, 'it''s', "q\\"x"]
  - at: 3
    value: [1,
      2]
  -
    nested: {a: 1, b: [true, null]}
map:
  k: v
same:
- x
- y
`);
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.deepEqual(r.value, {
      name: 'wave #1', fps: 30, loop: false, none: null,
      list: [1, -2500, ['a', "it's", 'q"x'], { at: 3, value: [1, 2] }, { nested: { a: 1, b: [true, null] } }],
      map: { k: 'v' }, same: ['x', 'y'],
    });
  });

  it('refuses what it does not support, with the line', () => {
    const cases: [string, RegExp][] = [
      ['a: &x 1', /line 1: .*anchors/],
      ['a: *x', /line 1: .*aliases/],
      ['a: !!str 1', /line 1: .*tags/],
      ['a: |\n  text', /line 1: .*block scalars/],
      ['a: 1\n---\nb: 2', /line 2: only one document/],
      ['a:\n\tb: 1', /line 2: tabs/],
      ['a: 1\na: 2', /line 2: duplicate key “a”/],
      ['a: [1, 2', /line 1: unclosed/],
      ['a: 1\n   b: 2', /line 2: unexpected indentation/],
      ['a: "x', /line 1: unterminated/],
    ];
    for (const [text, re] of cases) {
      const r = parseYaml(text);
      assert.ok(!r.ok && re.test(r.errors[0]), `${JSON.stringify(text)} → ${JSON.stringify(r)}`);
    }
  });

  it('the example in docs/cli.md parses as a clip spec', () => {
    const doc = readFileSync(new URL('../../docs/cli.md', import.meta.url).pathname, 'utf8');
    const block = /### Clip specs[\s\S]*?```yaml\n([\s\S]*?)```/.exec(doc)![1];
    const r = parseClipText(block, 'doc.yaml');
    assert.ok(r.ok, JSON.stringify(r));
    if (r.ok) assert.deepEqual(Object.keys(r.spec), ['format', 'version', 'name', 'fps', 'length', 'loop', 'ease', 'poses', 'timeline', 'bones', 'slots', 'drawOrder', 'constraints', 'events']);
  });

  it('writes what it reads: exact numbers (−0, 17 digits), quoted awkward strings', () => {
    const v = { a: [-0, 0.1 + 0.2, 1e-12, 123456789.123], s: ['true', 'x: y', '#c', 'plain-name', ''], n: { deep: [[1, 2], [3, 'step']], o: { at: 1, value: [2] } }, e: [], m: {} };
    const text = stringifyYaml(v as any);
    const r = parseYaml(text);
    assert.ok(r.ok, text);
    if (r.ok) {
      assert.deepEqual(r.value, v);
      assert.ok(Object.is((r.value as any).a[0], -0));
    }
  });
});

describe('lossless export → apply', () => {
  for (const [label, make] of [['rich fixture + v3 keys', fullProject], ['lottie fixture', lottieProject]] as const) {
    it(`${label}: every animation, through YAML and JSON, evaluates identically on and between frames`, () => {
      const p = make();
      for (const a of p.animations) {
        for (const json of [false, true]) {
          const text = formatClipSpec(exportClip(p, a.id), json);
          const parsed = parseClipText(text, json ? 'x.json' : 'x.yaml');
          assert.ok(parsed.ok, JSON.stringify(parsed));
          if (!parsed.ok) return;
          // Into a copy without the animation (create), and in place (replace).
          const without = { ...p, animations: p.animations.filter((x) => x.id !== a.id), mixes: (p.mixes ?? []).filter((m) => m.from !== a.id && m.to !== a.id), sequences: [] };
          const created = applyClip(without, parsed.spec, 'create');
          assert.ok(created.ok, JSON.stringify(created));
          if (created.ok) sameEverywhere(p, a.id, created.project, created.animId);
          const replaced = applyClip(p, parsed.spec, 'replace');
          assert.ok(replaced.ok, JSON.stringify(replaced));
          if (!replaced.ok) return;
          assert.equal(replaced.animId, a.id, 'replace keeps the id (mixes, sequences)');
          sameEverywhere(p, a.id, replaced.project, a.id);
          // Re-exporting the result gives the same text; applying twice gives the same bytes.
          assert.equal(formatClipSpec(exportClip(replaced.project, a.id), json), text);
          const again = applyClip(replaced.project, parsed.spec, 'replace');
          assert.ok(again.ok);
          if (again.ok) assert.equal(serializeProject(again.project), serializeProject(replaced.project));
        }
      }
    });
  }

  it('export writes frames where exact, seconds otherwise, preset names where exact, raw curves and easeY', () => {
    const p = fullProject();
    const spec = exportClip(p, 'wave') as any;
    assert.equal(spec.length, 30);
    const m2 = spec.bones.m2.rotate;
    assert.ok(m2.some((k: any) => Array.isArray(k) && k[0] === '0.123s' && k[2] === 'step'), JSON.stringify(m2));
    const torso = spec.bones.torso.rotate;
    assert.deepEqual(torso[0], { at: 0, value: -90, ease: 'bezier', curve: [0.3, 0, 0.2, 1.4] });
    assert.deepEqual(torso[1].slice(0, 3), [15, -75, 'ease-in-out']);
    const tgt = spec.bones['lower-target'].translate[0];
    assert.equal(tgt.easeY, 'bezier');
    assert.deepEqual(tgt.curveY, [0.1, 0.9, 0.2, 1]);
    assert.deepEqual(spec.slots.torso.color[0].slice(0, 2), [6, '#ff8040ff']);
    assert.deepEqual(spec.slots.upper.image, [[15, 'arm-raised.png']]);
    assert.equal(spec.constraints['f1-rotation'].angle.length, 2);
  });
});

const author = (over: ClipSpec): ClipSpec => ({ name: 'hop', fps: 30, length: 20, loop: false, ...over });

describe('authoring', () => {
  it('poses + timeline: union of channels keyed at every entry, setup value where omitted, holds, named eases', () => {
    const p = richProject();
    const r = applyClip(p, author({
      poses: { up: { torso: -60, root: { translate: [0, -12] } }, tilt: { m2: 20 } },
      timeline: [{ at: 0, pose: {} }, { at: 8, pose: ['up', 'tilt'], ease: 'ease-out' }, { at: 12, hold: true }, { at: 20, pose: 'tilt', ease: 'step' }],
    }));
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    const a = r.project.animations.find((x) => x.id === r.animId)!;
    assert.deepEqual(a.tracks.torso.rotate.map((k) => [Math.round(k.time * 30), k.value[0], k.interp]), [[0, -90, 'linear'], [8, -60, 'bezier'], [12, -60, 'linear'], [20, -90, 'step']]);
    assert.deepEqual(a.tracks.torso.rotate[1].curve, [0, 0, 0.58, 1]);
    assert.deepEqual(a.tracks.root.translate.map((k) => k.value), [[0, 0], [0, -12], [0, -12], [0, 0]]);
    assert.deepEqual(a.tracks.m2.rotate.map((k) => k.value[0]), [0, 20, 20, 20]);
    assert.equal(a.tracks.torso.translate.length, 0, 'unused channels stay unkeyed');
  });

  it('explicit keys: frames or seconds, default ease, easeY, image swaps by name, visibility, colour, deform rest, draw-order moves, constraint keys', () => {
    const p = richProject();
    const r = applyClip(p, author({
      ease: 'smooth',
      bones: { torso: { rotate: [[0, -90], ['0.25s', -80, 'overshoot'], { at: 20, value: -90, ease: 'bezier', curve: [0.2, 0, 0.4, 1.2] }] }, root: { translate: [{ at: 0, value: [0, 0], easeY: 'step' }, [20, 10, 5]] } },
      slots: { upper: { image: [[0, 'arm.png'], [10, 'arm-raised.png']] }, bead2: { visible: [[0, true], [5, false]] }, torso: { color: [[0, '#ffffff'], [10, '#ff000080', 'linear']] }, band: { deform: [{ at: 0, value: 'rest' }] } },
      drawOrder: [{ at: 4, move: 'band', to: 'front' }, { at: 8, move: 'band', below: 'torso' }],
      constraints: { 'lower-ik': { mix: [[0, 1], [10, 0]] }, 'path-follow': { position: [[0, 0.2]] } },
    }));
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    const a = r.project.animations.find((x) => x.id === r.animId)!;
    assert.deepEqual(a.tracks.torso.rotate.map((k) => [k.time, k.interp]), [[0, 'smooth'], [0.25, 'bezier'], [20 / 30, 'bezier']]);
    assert.deepEqual(a.tracks.root.translate[0].interpY, 'step');
    assert.deepEqual(a.slots!.a_upper.image, [{ time: 0, imageId: 'i_arm' }, { time: 10 / 30, imageId: 'i_arm2' }]);
    assert.deepEqual(a.slots!.a_bead2.visible!.map((k) => [k.value[0], k.interp]), [[1, 'step'], [0, 'step']]);
    assert.deepEqual(a.slots!.a_torso.color![1].value, [1, 0, 0, 128 / 255]);
    assert.ok(a.slots!.a_band.deform![0].value.every((v) => v === 0));
    const ids = p.attachments.map((x) => x.id);
    assert.deepEqual(a.drawOrder![0].order, [...ids.filter((x) => x !== 'a_band'), 'a_band']);
    assert.equal(a.drawOrder![1].order.indexOf('a_band'), a.drawOrder![1].order.indexOf('a_torso') - 1, 'band just below torso');
    assert.deepEqual(a.constraints!.ik_arm.mix!.map((k) => k.value[0]), [1, 0]);
  });

  it('merge adds keys to an existing animation; create refuses an existing name; events are keyed', () => {
    const p = richProject();
    const m = applyClip(p, { name: 'wave', bones: { f1: { rotate: [[5, 10]] } } }, 'merge');
    assert.ok(m.ok);
    if (m.ok) {
      const w = m.project.animations.find((a) => a.name === 'wave')!;
      assert.equal(w.tracks.f1.rotate.length, 1);
      assert.equal(w.tracks.torso.rotate.length, 3, 'existing keys kept');
    }
    const c = applyClip(p, { name: 'wave', length: 30, bones: {} });
    assert.ok(!c.ok && /exists; apply with replace/.test(c.errors[0]));
    const e = applyClip(p, author({ events: [{ at: 1, name: 'x' }] }));
    assert.ok(e.ok && e.project.animations.find((a) => a.id === e.animId)!.events!.x[0].time === 1 / 30, 'events (R7)');
  });
});

describe('lint', () => {
  it('names every problem: unknown names, value counts, deform vertex count, ease names, times past the end', () => {
    const p = richProject();
    const errors = lintClip(p, author({
      bones: { nobone: { rotate: [[0, 1]] }, torso: { rotate: [[0, 1, 2]], translate: [[0, 1, 'wobbly']], spin: [] } },
      slots: { upper: { image: [[0, 'missing.png']] }, band: { deform: [{ at: 0, value: [1, 2, 3] }] }, torso: { opacity: [[25, 0.5]] }, ghost: {} },
      constraints: { nocon: { mix: [] }, 'lower-ik': { angle: [[0, 1]] } },
      drawOrder: [{ at: 2, order: ['band'] }],
    }), 'create');
    const expect = [
      /bones\.nobone: unknown bone “nobone”/,
      /bones\.torso\.rotate\[0\]: rotate needs 1 number\(s\), got 2/,
      /bones\.torso\.translate\[0\]: unknown ease “wobbly”/,
      /bones\.torso: unknown channel “spin”/,
      /slots\.upper\.image\[0\]: unknown image “missing\.png”/,
      /slots\.band\.deform\[0\]: deform needs \d+ offsets \(2 per mesh vertex; the mesh has \d+ vertices\), got 3/,
      /slots\.torso\.opacity\[0\]\.at: time frame 25 is past the clip's end \(frame 20\)/,
      /slots\.ghost: unknown attachment “ghost”/,
      /constraints\.nocon: unknown constraint “nocon”/,
      /constraints\.lower-ik\.angle: only transform constraints have an angle/,
      /drawOrder\[0\]\.order: must list every attachment exactly once/,
    ];
    for (const re of expect) assert.ok(errors.some((e) => re.test(e)), `${re} in\n${errors.join('\n')}`);
    assert.deepEqual(lintClip(p, exportClip(p, 'wave')), [], 'an exported clip lints clean');
  });
});
