// Lottie subset exporter: an independent evaluator (tests/support/lottie-eval.ts, no
// src/ imports) reproduces the editor's bone and attachment transforms, opacity and
// visible image on every frame; out-of-subset rigs are refused with named diagnostics.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluate, frameBounds } from '../../src/model/evaluate.ts';
import type { Bounds } from '../../src/model/evaluate.ts';
import { exportLottie, lottieDiagnostics } from '../../src/model/lottie.ts';
import { sequenceGeometry } from '../../src/model/sequence.ts';
import { cubicEase, layerWorld, lottieFrame } from '../support/lottie-eval.ts';
import { lottieProject } from '../support/lottie-fixture.ts';
import { richProject } from '../support/runtime-fixture.ts';

describe('Lottie subset export', () => {
  it('smooth = cubic (1/3, 0, 2/3, 1) exactly (3t² − 2t³), by the independent solver', () => {
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      assert.ok(Math.abs(cubicEase(1 / 3, 0, 2 / 3, 1, t) - (3 * t * t - 2 * t * t * t)) < 1e-12);
    }
  });

  for (const skin of [null, 'alt']) {
    it(`every frame: transforms, opacity and shown image equal the editor (skin ${skin ?? 'none'})`, () => {
      const p = lottieProject();
      const r = exportLottie(p, 'hop', skin);
      assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
      const L = JSON.parse(JSON.stringify(r.lottie));
      const anim = p.animations[0];
      const skinId = skin ? p.skins![0].id : null;
      let b: Bounds | null = null;
      const frames = Array.from({ length: L.op }, (_, f) => evaluate(p, anim, f / anim.fps, { skinId }));
      for (const fr of frames) b = frameBounds(fr, b);
      const geo = sequenceGeometry(b!, 1, 4);
      assert.deepEqual([L.w, L.h, L.fr, L.op], [geo.width, geo.height, 30, 30]);
      let worst = 0;
      frames.forEach((fr, f) => {
        // Bones: null-layer world = T(−origin) · editor world.
        const lw = layerWorld(L, f);
        for (const bn of p.bones) {
          const layer = L.layers.find((l: any) => l.nm === `bone:${bn.name}`);
          const m = lw.get(layer.ind)!, e = fr.world.get(bn.id)!;
          const want = [e.a, e.b, e.c, e.d, e.tx - geo.originX, e.ty - geo.originY];
          want.forEach((v, k) => (worst = Math.max(worst, Math.abs(v - m[k]))));
        }
        // Image draws: same attachments in the same order with the same image, matrix, opacity.
        const draws = lottieFrame(L, f);
        const shown = fr.attachments.filter((a) => a.visible && a.image && a.opacity > 0);
        assert.deepEqual(draws.map((d) => d.layer), shown.map((a) => `${a.att.name}:${a.image!.name}`), `frame ${f}: layers`);
        draws.forEach((d, i) => {
          const e = shown[i];
          const want = [e.world.a, e.world.b, e.world.c, e.world.d, e.world.tx - geo.originX, e.world.ty - geo.originY];
          want.forEach((v, k) => (worst = Math.max(worst, Math.abs(v - d.m[k]))));
          worst = Math.max(worst, Math.abs(d.opacity - e.opacity));
        });
      });
      assert.ok(worst < 1e-6, `max difference ${worst}`);
      // Keys between frames: the torso key at 0.517 s (frame 15.51) is kept fractional.
      const torso = L.layers.find((l: any) => l.nm === 'bone:torso');
      assert.ok(torso.ks.r.k.some((k: any) => Math.abs(k.t - 15.51) < 1e-9));
      // The image swap at 0.51 s (frame 15.3) switches layers at frame 16, like the sequence.
      const wink = L.layers.find((l: any) => l.nm.startsWith('head:') && l.nm.includes('wink'));
      assert.deepEqual([wink.ip, wink.op], [16, 21]);
    });
  }

  it('refuses rigs outside the subset, naming each feature and item', () => {
    const p = richProject();
    const r = exportLottie(p, 'wave', null);
    assert.equal(r.ok, false);
    const errs = r.diagnostics.filter((d) => d.level === 'error').map((d) => `${d.feature}|${d.item}`).sort();
    assert.deepEqual(errs, ['IK constraint|lower-ik', 'constraint keys|wave', 'deform keys|band', 'draw-order keys|wave', 'mesh|band', 'path constraint|path-follow']);
    assert.ok(!r.ok && r.errors.every((e) => /Not exported|no Lottie equivalent|Constraint keys/.test(e)));
    const notes = lottieDiagnostics(lottieProject(), lottieProject().animations[0]).filter((d) => d.level === 'note').map((d) => d.feature);
    assert.deepEqual(notes, ['visibility / image keys', 'validation']);
    assert.match(exportLottie(lottieProject(), 'nope', null).ok ? '' : (exportLottie(lottieProject(), 'nope', null) as any).errors[0], /No animation named “nope”/);
  });
});
