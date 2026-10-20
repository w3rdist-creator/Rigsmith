// R4: per-attachment blend modes, keyable tint colour and per-vertex alpha — format v3
// gating and round trip, evaluation and mixing, runtime v3, Lottie refusal, animation
// import, the vertex-alpha gradient construction and the CLI (`tint`, `vertex-alpha`).
// Rendering is checked against the independent reference compositor in
// tests/e2e/r4-color.e2e.test.ts (Chrome).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { keysBeyondEnd } from '../../src/model/animation.ts';
import { defaultMapping, importAnimations } from '../../src/model/animImport.ts';
import { formatColor, parseColor, radialAlphas, withVertexAlpha } from '../../src/model/color.ts';
import { evaluate } from '../../src/model/evaluate.ts';
import { exportRuntime } from '../../src/model/exportRuntime.ts';
import { parseProject, requiredVersion, serializeProject, v3Features } from '../../src/model/format.ts';
import { lottieDiagnostics } from '../../src/model/lottie.ts';
import { gridPoints, triangulate } from '../../src/model/meshOps.ts';
import { evaluateMix } from '../../src/model/mix.ts';
import { makeBone } from '../../src/model/ops.ts';
import { keySlotColor, slotValues } from '../../src/model/rigOps.ts';
import type { Animation, Key, Project } from '../../src/model/types.ts';
import { FORMAT_ID } from '../../src/model/types.ts';
import { alphaGradient } from '../../src/render/draw.ts';
import { loadRuntime } from '../../src/runtime/load.ts';
import { EVIDENCE, ROOT } from '../e2e/harness.ts';
import { refTint } from '../support/reference-composite.ts';

const k = (time: number, value: number[]): Key => ({ time, value, interp: 'linear' });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function scene(): Project {
  const root = makeBone('root', 'root', null, 0, 0, 0, 40);
  const g = gridPoints(80, 20, 4, 1);
  const mesh = triangulate(g.hull, g.interior);
  return {
    format: FORMAT_ID, version: 2, name: 'colour', bones: [root],
    images: [{ id: 'i1', name: 'glow.png', mime: 'image/png', width: 80, height: 20, dataUrl: PNG }],
    attachments: [
      { id: 'a_glow', name: 'glow', boneId: 'root', imageId: 'i1', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 },
      { id: 'a_band', name: 'band', boneId: 'root', imageId: 'i1', x: 0, y: 30, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, mesh },
    ],
    animations: [{ id: 'pulse', name: 'pulse', duration: 1, fps: 30, loop: true, tracks: { root: { translate: [], rotate: [k(0, [0]), k(1, [10])], scale: [] } } }],
  };
}

function coloured(): Project {
  const p = scene();
  p.attachments[0].blend = 'additive';
  p.attachments[0].color = '#ff800080';
  p.attachments[1].blend = 'multiply';
  p.attachments[1].mesh!.alphas = radialAlphas(p.attachments[1], 40, 10, 5, 30);
  p.animations[0].slots = { a_glow: { color: [k(0, [1, 0.5, 0, 0.5]), k(0.5, [0, 0, 1, 1])] } };
  return p;
}

const roundTrip = (p: Project) => {
  const r = parseProject(serializeProject(p));
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  return (r as { project: Project }).project;
};

describe('colour values', () => {
  it('parses #rrggbb / #rrggbbaa and formats canonically', () => {
    assert.deepEqual(parseColor('#ff0000'), [1, 0, 0, 1]);
    assert.deepEqual(parseColor('#00FF0080')!.map((v) => Math.round(v * 255)), [0, 255, 0, 128]);
    assert.equal(parseColor('red'), null);
    assert.equal(parseColor('#fff'), null);
    assert.equal(formatColor([1, 0.5, 0, 0.5]), '#ff800080');
    assert.equal(formatColor([2, -1, 0, 1]), '#ff0000ff', 'clamped');
  });

  it('the reference reads the same setup and keyed tint', () => {
    const p = coloured();
    for (const t of [0, 0.2, 0.5, 0.9]) {
      const ours = evaluate(p, p.animations[0], t).attachments.find((a) => a.att.id === 'a_glow')!.color;
      const ref = refTint(p.attachments[0], p.animations[0].slots!.a_glow, t);
      ours.forEach((v, i) => assert.ok(Math.abs(v - ref[i]) < 1e-12, `t=${t} channel ${i}`));
    }
  });
});

describe('format v3 gating', () => {
  it('a rig without colour features keeps its version; blend, tint, colour keys and vertex alpha each make it v3', () => {
    const plain = scene();
    assert.deepEqual(v3Features(plain), []);
    assert.equal(requiredVersion(plain), 2);
    const white = scene();
    white.attachments[0].color = '#ffffffff';
    white.attachments[0].blend = 'normal';
    assert.equal(requiredVersion(white), 2, 'white tint and normal blend are defaults');
    const saved = JSON.parse(serializeProject(white));
    assert.equal(saved.attachments[0].color, undefined);
    assert.equal(saved.attachments[0].blend, undefined);
    const cases: [string, (p: Project) => void][] = [
      ['blend modes', (p) => void (p.attachments[0].blend = 'screen')],
      ['tint colours', (p) => void (p.attachments[0].color = '#80808080')],
      ['colour keys', (p) => void (p.animations[0].slots = { a_glow: { color: [k(0, [1, 1, 1, 1])] } })],
      ['vertex alpha', (p) => void (p.attachments[1].mesh!.alphas = new Array(p.attachments[1].mesh!.points.length / 2).fill(1))],
    ];
    for (const [feature, fn] of cases) {
      const p = scene();
      fn(p);
      assert.deepEqual(v3Features(p), [feature]);
      assert.equal(JSON.parse(serializeProject(p)).version, 3);
    }
  });

  it('round-trips every colour field exactly (colour stored canonical lowercase)', () => {
    const p = coloured();
    p.attachments[0].color = '#FF800080';
    const q = roundTrip(p);
    assert.equal(q.version, 3);
    assert.equal(q.attachments[0].blend, 'additive');
    assert.equal(q.attachments[0].color, '#ff800080');
    assert.equal(q.attachments[1].blend, 'multiply');
    assert.deepEqual(q.attachments[1].mesh!.alphas, p.attachments[1].mesh!.alphas);
    assert.deepEqual(q.animations[0].slots!.a_glow.color, p.animations[0].slots!.a_glow.color);
    assert.equal(serializeProject(q), serializeProject(roundTrip(q)), 'stable');
  });

  it('the validator rejects colour data in a v2 file and malformed values', () => {
    const bad = (mut: (raw: any) => void, re: RegExp) => {
      const raw = JSON.parse(serializeProject(coloured()));
      mut(raw);
      const r = parseProject(JSON.stringify(raw));
      assert.ok(!r.ok, `expected rejection for ${re}`);
      assert.ok(r.errors.some((e) => re.test(e)), r.errors.join('\n'));
    };
    bad((r) => void (r.version = 2), /blend requires project version 3/);
    bad((r) => void (r.version = 2), /color requires project version 3/);
    bad((r) => void (r.version = 2), /colour keys requires project version 3/);
    bad((r) => void (r.version = 2), /vertex alpha requires project version 3/);
    bad((r) => void (r.attachments[0].blend = 'overlay'), /blend must be one of normal, additive, screen, multiply/);
    bad((r) => void (r.attachments[0].color = 'orange'), /color must be #rrggbb or #rrggbbaa/);
    bad((r) => void (r.animations[0].slots.a_glow.color[0].value = [1, 1, 1]), /must be four numbers/);
    bad((r) => void (r.animations[0].slots.a_glow.color[0].value = [1, 1, 1, 2]), /must be four numbers/);
    bad((r) => void r.attachments[1].mesh.alphas.pop(), /alphas must hold one number from 0 to 1 per vertex/);
    bad((r) => void (r.attachments[1].mesh.alphas[0] = -0.1), /alphas must hold one number from 0 to 1 per vertex/);
  });
});

describe('evaluation, keys and mixing', () => {
  it('colour keys interpolate per channel; tint alpha does not change the stored opacity', () => {
    const p = coloured();
    const at = (t: number) => evaluate(p, p.animations[0], t).attachments.find((a) => a.att.id === 'a_glow')!;
    assert.deepEqual(at(0).color, [1, 0.5, 0, 0.5]);
    const mid = at(0.25).color;
    [0.5, 0.25, 0.5, 0.75].forEach((v, i) => assert.ok(Math.abs(mid[i] - v) < 1e-12, `channel ${i}`));
    assert.deepEqual(at(0.8).color, [0, 0, 1, 1], 'holds the last key');
    assert.equal(at(0.25).opacity, 1);
    assert.equal(at(0).blend, 'additive');
    const none = evaluate(p, null, 0).attachments.find((a) => a.att.id === 'a_glow')!;
    assert.deepEqual(none.color.map((v) => Math.round(v * 255)), [255, 128, 0, 128], 'no animation: the setup tint');
  });

  it('keySlotColor snaps to the frame, clamps and replaces; slotValues reports the sampled tint', () => {
    const p = scene();
    const an = p.animations[0];
    keySlotColor(an, 'a_glow', 0.3333, [2, 0.5, -1, 0.25]);
    keySlotColor(an, 'a_glow', 0.3333, [1, 0.5, 0, 0.5]);
    assert.deepEqual(an.slots!.a_glow.color, [{ time: 10 / 30, value: [1, 0.5, 0, 0.5], interp: 'linear' }]);
    assert.deepEqual(slotValues(p.attachments[0], an, 0.9).color, [1, 0.5, 0, 0.5]);
  });

  it('a mix blends the tint from the outgoing to the incoming animation', () => {
    const p = coloured();
    const b: Animation = { id: 'calm', name: 'calm', duration: 1, fps: 30, loop: true, tracks: {}, slots: { a_glow: { color: [k(0, [0, 1, 0, 1])] } } };
    p.animations.push(b);
    const plan = { entries: [{ animId: 'pulse', start: 0, mix: 0 }, { animId: 'calm', start: 0.6, mix: 0.4 }], missing: 'setup' as const };
    const tint = (T: number) => evaluateMix(p, plan, T).attachments.find((a) => a.att.id === 'a_glow')!.color;
    assert.deepEqual(tint(0.55), [0, 0, 1, 1], 'before the mix: the outgoing tint');
    assert.deepEqual(tint(1.2), [0, 1, 0, 1], 'after the mix: the incoming tint');
    const m = tint(0.8);
    assert.ok(m[1] > 0.05 && m[1] < 0.95 && m[2] > 0.05 && m[2] < 0.95 && Math.abs(m[1] + m[2] - 1) < 1e-9, `blended: ${m}`);
  });

  it('keys past the end count colour (and transform-angle) keys', () => {
    const p = coloured();
    p.animations[0].slots!.a_glow.color!.push(k(1.5, [1, 1, 1, 1]));
    p.animations[0].constraints = { c: { angle: [k(2, [5])] } };
    assert.equal(keysBeyondEnd(p.animations[0]), 2);
  });

  it('animation import carries colour keys to the mapped attachment', () => {
    const src = coloured();
    const dst = scene();
    dst.animations = [];
    const r = importAnimations(dst, src, ['pulse'], defaultMapping(src, dst, ['pulse']), {});
    assert.equal(r.keys, 4, 'two rotate + two colour keys');
    assert.deepEqual(dst.animations[0].slots!.a_glow.color, src.animations[0].slots!.a_glow.color);
  });
});

describe('vertex alpha', () => {
  it('radial: 1 inside the solid radius, 0 beyond the fade radius, smooth between; invert; per-vertex set', () => {
    const a = scene().attachments[1];
    const al = radialAlphas(a, 40, 10, 5, 30);
    const pts = a.mesh!.points;
    for (let i = 0; i < al.length; i++) {
      const d = Math.hypot(pts[2 * i] - 40, pts[2 * i + 1] - 10);
      if (d <= 5) assert.equal(al[i], 1);
      else if (d >= 30) assert.equal(al[i], 0);
      else assert.ok(al[i] > 0 && al[i] < 1);
    }
    assert.deepEqual(radialAlphas(a, 40, 10, 5, 30, true), al.map((v) => 1 - v));
    assert.throws(() => radialAlphas(a, 0, 0, 10, 10), /inner < outer/);
    const set = withVertexAlpha(a, 2, 1.7);
    assert.equal(set[2], 1, 'clamped');
    assert.equal(withVertexAlpha({ ...a, mesh: { ...a.mesh!, alphas: al } }, 0, 0.25)[0], 0.25);
    assert.throws(() => withVertexAlpha(a, 999, 0), /out of range/);
  });

  it('the canvas gradient for a triangle reproduces the plane through its three vertex alphas', () => {
    // Fake context: records the gradient line and stops, then evaluates it like a canvas.
    let rec: { x0: number; y0: number; x1: number; y1: number; stops: [number, number][] } | null = null;
    const g = {
      createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
        rec = { x0, y0, x1, y1, stops: [] };
        return { addColorStop: (o: number, c: string) => rec!.stops.push([o, Number(/,([\d.e-]+)\)$/.exec(c)![1])]) };
      },
    } as unknown as CanvasRenderingContext2D;
    const valueAt = (x: number, y: number) => {
      const r = rec!;
      const dx = r.x1 - r.x0, dy = r.y1 - r.y0;
      const s = Math.min(1, Math.max(0, ((x - r.x0) * dx + (y - r.y0) * dy) / (dx * dx + dy * dy)));
      return r.stops[0][1] + s * (r.stops[1][1] - r.stops[0][1]);
    };
    const cases = [
      { p: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], a: [0, 1, 0.5] },
      { p: [{ x: 3.5, y: -2 }, { x: -7, y: 4.25 }, { x: 12, y: 9 }], a: [0.9, 0.1, 0.4] },
      { p: [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 40, y: 1 }], a: [0.2, 0.2, 0.8] },
    ];
    for (const { p, a } of cases) {
      const area2 = (p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[2].x - p[0].x) * (p[1].y - p[0].y);
      const fill = alphaGradient(g, p, a, area2);
      assert.notEqual(typeof fill, 'string');
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(valueAt(p[i].x, p[i].y) - a[i]) < 1e-9, `vertex ${i}: ${valueAt(p[i].x, p[i].y)} vs ${a[i]}`);
      const c = { x: (p[0].x + p[1].x + p[2].x) / 3, y: (p[0].y + p[1].y + p[2].y) / 3 };
      assert.ok(Math.abs(valueAt(c.x, c.y) - (a[0] + a[1] + a[2]) / 3) < 1e-9, 'centroid = mean (linear)');
    }
    assert.equal(alphaGradient(g, cases[0].p, [0.4, 0.4, 0.4], 100), 'rgba(0,0,0,0.4)', 'constant alpha: a solid fill');
  });
});

describe('runtime v3, Lottie', () => {
  it('runtime: v2 without colour features; v3 with them, and a rebuilt project evaluates the same tints', () => {
    assert.equal(exportRuntime(scene()).version, 2);
    const p = coloured();
    const rt = exportRuntime(p);
    assert.equal(rt.version, 3);
    assert.equal(rt.attachments[0].blend, 'additive');
    assert.equal(rt.attachments[0].color, '#ff800080');
    assert.equal(rt.attachments[1].mesh!.alphas!.length, p.attachments[1].mesh!.points.length / 2);
    assert.ok(rt.animations[0].bakedSlots![15].find((s) => s.attachment === 'glow')!.color, 'baked tint per frame');
    const back = loadRuntime(JSON.parse(JSON.stringify(rt)));
    for (let f = 0; f <= 30; f++) {
      const t = f / 30;
      const a = evaluate(p, p.animations[0], t).attachments, b = evaluate(back, back.animations[0], t).attachments;
      a.forEach((x, i) => {
        assert.deepEqual(b[i].color, x.color, `frame ${f} ${x.att.name}`);
        assert.equal(b[i].blend, x.blend);
      });
    }
    assert.deepEqual(back.attachments[1].mesh!.alphas, p.attachments[1].mesh!.alphas);
  });

  it('Lottie refuses blend modes, tints and colour keys with a reason', () => {
    const d = lottieDiagnostics(coloured(), coloured().animations[0]).filter((x) => x.level === 'error').map((x) => x.feature);
    for (const f of ['blend mode', 'tint', 'colour keys']) assert.ok(d.includes(f), `${f} in ${d}`);
  });
});

describe('CLI: tint and vertex-alpha', () => {
  const dir = path.join(EVIDENCE, 'r4-color/cli');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), ...args], { cwd: ROOT, encoding: 'utf8' });
    return { code: r.status, json: JSON.parse(r.stdout) };
  };
  const load = (f: string) => {
    const r = parseProject(readFileSync(f, 'utf8'));
    assert.ok(r.ok);
    return (r as { project: Project }).project;
  };

  it('sets blend and setup tint, keys a tint, and fades a mesh radially; errors are reported', () => {
    const src = path.join(dir, 'scene.rig.json');
    writeFileSync(src, serializeProject(scene()));
    const out1 = path.join(dir, 'tinted.rig.json');
    let r = cli('tint', src, '--att', 'glow', '--blend', 'additive', '--color', '#ff8000cc', '--out', out1);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.deepEqual([r.json.blend, r.json.color], ['additive', '#ff8000cc']);
    let p = load(out1);
    assert.equal(p.version, 3);
    assert.equal(p.attachments[0].blend, 'additive');
    const out2 = path.join(dir, 'keyed.rig.json');
    r = cli('tint', out1, '--att', 'glow', '--color', '#0000ff', '--anim', 'pulse', '--at', '0.5', '--out', out2);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.deepEqual(load(out2).animations[0].slots!.a_glow.color, [{ time: 0.5, value: [0, 0, 1, 1], interp: 'linear' }]);
    const out3 = path.join(dir, 'faded.rig.json');
    r = cli('vertex-alpha', out2, '--att', 'band', '--radial', '40,10,5,30', '--out', out3);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    p = load(out3);
    assert.deepEqual(p.attachments[1].mesh!.alphas, radialAlphas(scene().attachments[1], 40, 10, 5, 30));
    assert.equal(r.json.faded, p.attachments[1].mesh!.alphas!.filter((v) => v < 1).length);
    r = cli('vertex-alpha', out3, '--att', 'band', '--set', '0=0.5,1=0.25', '--out', out3);
    assert.deepEqual(load(out3).attachments[1].mesh!.alphas!.slice(0, 2), [0.5, 0.25]);
    r = cli('vertex-alpha', out3, '--att', 'band', '--clear', '--out', out3);
    assert.equal(load(out3).attachments[1].mesh!.alphas, undefined);
    assert.equal(r.json.faded, 0);
    for (const [args, re, code] of [
      [['tint', src, '--att', 'glow', '--blend', 'overlay', '--out', out1], /Blend mode must be one of/, 1],
      [['tint', src, '--att', 'glow', '--color', 'orange', '--out', out1], /Colour must be/, 1],
      [['tint', src, '--att', 'glow', '--blend', 'screen', '--anim', 'pulse', '--at', '0', '--out', out1], /cannot be keyed/, 1],
      [['tint', src, '--att', 'glow', '--out', out1], /give --blend and\/or --color/, 2],
      [['vertex-alpha', src, '--att', 'glow', '--clear', '--out', out1], /has no mesh/, 1],
      [['vertex-alpha', src, '--att', 'band', '--radial', '1,2,3', '--out', out1], /--radial expects/, 2],
      [['vertex-alpha', src, '--att', 'band', '--clear', '--set', '0=1', '--out', out1], /exactly one of/, 2],
    ] as [string[], RegExp, number][]) {
      const before = readFileSync(out1, 'utf8');
      const e = cli(...args);
      assert.equal(e.code, code, args.join(' '));
      assert.match(e.json.error, re);
      assert.equal(readFileSync(out1, 'utf8'), before, 'nothing written on failure');
    }
  });
});
