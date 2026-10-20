// R13 smears: the rigid motion between frames, the smeared pixels (the current pose kept
// exactly, a trail only behind the motion, centre kept), and smearAnimation's keys (a swap
// on each fast frame, the clip's own image back on the next slow frame).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setKey } from '../../src/model/animation.ts';
import type { Rgba } from '../../src/model/cutout.ts';
import { evaluate } from '../../src/model/evaluate.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { fromTRS } from '../../src/model/math.ts';
import { makeBone } from '../../src/model/ops.ts';
import { motionBetween, motionSize, smearAnimation, smearPixels } from '../../src/model/smear.ts';
import type { Project } from '../../src/model/types.ts';
import { emptyProject, emptyTrack } from '../../src/model/types.ts';
import { encodePng } from '../support/png-encode.ts';

function bar(w = 60, h = 12): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([220, 80, 40, 255], i * 4);
  return { width: w, height: h, data };
}

function spinner(): Project {
  const p = emptyProject('spin');
  p.bones.push(makeBone('root', 'root', null, 0, 0, 0, 20), makeBone('arm', 'arm', 'root', 0, 0, 0, 60));
  const px = bar();
  p.images.push({ id: 'i_bar', name: 'bar.png', mime: 'image/png', width: 60, height: 12, dataUrl: `data:image/png;base64,${encodePng(60, 12, new Uint8Array(px.data)).toString('base64')}` });
  p.attachments.push({ id: 'a_bar', name: 'bar', boneId: 'arm', imageId: 'i_bar', x: 40, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
  // Slow for 10 frames, then a 270° whip over 6 frames (45°/frame), then still.
  const twirl = { id: 'twirl', name: 'twirl', duration: 1, fps: 30, loop: false, tracks: { arm: emptyTrack() } };
  for (const [f, r] of [[0, 0], [10, 10], [16, 280], [30, 280]]) setKey(twirl.tracks.arm.rotate, f / 30, [r], 'linear');
  p.animations.push(twirl);
  return p;
}

describe('motion and pixels', () => {
  it('motionBetween finds the rotation and its fixed point (the bone origin), or a slide', () => {
    const cur = fromTRS(0, 0, 45, 1, 1), prev = fromTRS(0, 0, 0, 1, 1);
    const att = fromTRS(40, 0, 0, 1, 1);
    const mo = motionBetween({ ...prevTimes(prev, att) }, { ...prevTimes(cur, att) });
    assert.ok(Math.abs(mo.angle + 45) < 1e-9, `${mo.angle}`);
    assert.ok(Math.hypot(mo.cx + 40, mo.cy) < 1e-9, 'pivot = the bone origin, 40 px left of the image centre');
    const slide = motionBetween(fromTRS(-30, 5, 0, 1, 1), fromTRS(0, 0, 0, 1, 1));
    assert.deepEqual([slide.angle, Math.round(slide.tx), Math.round(slide.ty)], [0, -30, 5]);
    assert.ok(Math.abs(motionSize(slide, 60, 12) - Math.hypot(30, 5)) < 1e-9);
  });

  it('smearPixels keeps the current pose exactly and centred; the trail lies only behind the motion', () => {
    const src = bar();
    const mo = motionBetween(fromTRS(-30, 0, 0, 1, 1), fromTRS(0, 0, 0, 1, 1)); // came from the left
    const out = smearPixels(src, mo);
    assert.equal((out.width - src.width) % 2, 0, 'symmetric padding keeps the centre');
    assert.equal(out.height, src.height);
    const padX = (out.width - src.width) / 2;
    for (let y = 0; y < src.height; y++)
      for (let x = 0; x < src.width; x++) {
        const o = (y * out.width + x + padX) * 4, s = (y * src.width + x) * 4;
        for (let c = 0; c < 4; c++) assert.ok(Math.abs(out.data[o + c] - src.data[s + c]) <= 1, `pixel ${x},${y}`);
      }
    const alphaAt = (x: number) => out.data[(6 * out.width + x) * 4 + 3];
    assert.ok(alphaAt(padX - 10) > 40, `trail to the left (behind): ${alphaAt(padX - 10)}`);
    assert.equal(alphaAt(out.width - 1), 0, 'nothing ahead of the motion');
    assert.deepEqual(smearPixels(src, mo).data, out.data, 'deterministic');
  });
});

function prevTimes(bone: ReturnType<typeof fromTRS>, att: ReturnType<typeof fromTRS>) {
  return { a: bone.a * att.a + bone.c * att.b, b: bone.b * att.a + bone.d * att.b, c: bone.a * att.c + bone.c * att.d, d: bone.b * att.c + bone.d * att.d, tx: bone.a * att.tx + bone.c * att.ty + bone.tx, ty: bone.b * att.tx + bone.d * att.ty + bone.ty };
}

describe('smearAnimation', () => {
  it('keys a smear on each fast frame and the clip image back on the next slow frame', async () => {
    const p = spinner();
    const r = await smearAnimation(p, 'twirl', { attachments: ['a_bar'] });
    assert.deepEqual(r.frames, { bar: [11, 12, 13, 14, 15, 16] });
    const keys = p.animations[0].slots!.a_bar.image!;
    assert.deepEqual(keys.map((k) => [Math.round(k.time * 30), k.imageId]), [
      ...[11, 12, 13, 14, 15, 16].map((f) => [f, `i_bar~smear~a_bar~twirl~${f}`]),
      [17, 'i_bar'],
    ]);
    const at = (f: number) => evaluate(p, p.animations[0], f / 30).attachments[0].image!.id;
    assert.deepEqual([at(10), at(13), at(17), at(25)], ['i_bar', 'i_bar~smear~a_bar~twirl~13', 'i_bar', 'i_bar']);
    const im = p.images.find((x) => x.id === 'i_bar~smear~a_bar~twirl~13')!;
    assert.ok(im.width > 60 && im.height > 12 && (im.width - 60) % 2 === 0);
    assert.ok(parseProject(serializeProject(p)).ok, 'the result is a valid project');
    const again = spinner();
    const r2 = await smearAnimation(again, 'twirl', { attachments: ['a_bar'] });
    assert.deepEqual(r2.images.map((x) => x.dataUrl), r.images.map((x) => x.dataUrl), 'reproducible');
  });

  it('skips slow clips, meshes and hidden frames', async () => {
    const p = spinner();
    assert.deepEqual((await smearAnimation(p, 'twirl', { attachments: ['a_bar'], minPx: 1000 })).frames, {});
    const q = spinner();
    setKey((q.animations[0].slots ??= { a_bar: {} }).a_bar.visible ??= [], 12 / 30, [0], 'step');
    q.animations[0].slots!.a_bar.visible!.push({ time: 14 / 30, value: [1], interp: 'step' });
    assert.deepEqual((await smearAnimation(q, 'twirl', { attachments: ['a_bar'] })).frames.bar, [11, 14, 15, 16]);
  });
});
