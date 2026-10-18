// Animated media encoders (src/model/media.ts), checked by decoders that are not Rigsmith
// code: Pillow (tests/support/media_decode.py, frames + durations + loop) and ffprobe
// (frame count). APNG must reproduce every input pixel; GIF must match the stated
// reduction (1-bit alpha at 128, palette, centisecond timing).
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GIF_MAX_FPS, MediaCancelled, encodeAnimated, gifDelays, mediaErrors } from '../../src/model/media.ts';
import { ffprobe, hasFfmpeg, pillow } from '../support/media-check.ts';
import { encodePng } from '../support/png-encode.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, '.hermes/evidence/roadmap/unit-media');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

type Frame = { width: number; height: number; data: Uint8Array };

/** Moving shapes over transparency: gradients (many colours), a soft (partial-alpha) edge. */
function frames(n: number, w: number, h: number, colours: 'many' | 'few'): Frame[] {
  return Array.from({ length: n }, (_, f) => {
    const d = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const cx = 8 + f * 3, cy = h / 2;
        const r = Math.hypot(x - cx, y - cy);
        if (r < 9) {
          const a = r < 6 ? 255 : Math.round(255 * (9 - r) / 3);
          const base = colours === 'many' ? [(x * 7 + f * 11) & 255, (y * 9) & 255, (x * y) & 255] : [[200, 40, 40], [40, 200, 40], [40, 40, 200]][(x + y + f) % 3];
          d.set([...base, a], o);
        } else if (x > w - 10 && y < 8) d.set(colours === 'many' ? [x * 5, 120, f * 30, 255] : [250, 250, 250, 255], o);
        else d.set([(x * 13) & 255, 0, 99, 0], o); // transparent with leftover colour
      }
    return { width: w, height: h, data: d };
  });
}

const png = (f: Frame) => new Uint8Array(encodePng(f.width, f.height, f.data));

function ffprobeFrames(file: string): { frames: number; rate: string } | null {
  if (!hasFfmpeg()) return null;
  const p = ffprobe(file);
  return { frames: p.frames, rate: p.rate };
}

async function encode(format: 'apng' | 'gif', fr: Frame[], fps: number, loop: boolean, name: string) {
  const pngs = fr.map(png);
  const r = await encodeAnimated(format, pngs.length, (i) => pngs[i], { fps, loop });
  const file = path.join(OUT, name);
  writeFileSync(file, r.bytes);
  return { ...r, file };
}

describe('APNG', () => {
  for (const loop of [true, false]) {
    it(`every decoded frame equals the input exactly; delay 1/fps; plays ${loop ? 'forever' : 'once'} (Pillow, ffprobe)`, async () => {
      const fr = frames(7, 41, 23, 'many');
      const r = await encode('apng', fr, 24, loop, `t-${loop}.png`);
      const d = pillow(r.file);
      assert.deepEqual([d.info.format, d.info.width, d.info.height, d.info.frames], ['PNG', 41, 23, 7]);
      assert.equal(d.info.loop, loop ? 0 : 1);
      for (const ms of d.info.durations) assert.ok(Math.abs(ms - 1000 / 24) < 1e-6, `duration ${ms}`);
      d.frames.forEach((got, i) => assert.deepEqual(got, fr[i].data, `frame ${i}`));
      const p = ffprobeFrames(r.file);
      if (p) assert.deepEqual(p, { frames: 7, rate: '24/1' });
    });
  }

  it('deterministic, cancellable, rejects mixed frame sizes', async () => {
    const fr = frames(4, 30, 20, 'many');
    const a = await encode('apng', fr, 30, true, 'd1.png');
    const b = await encode('apng', fr, 30, true, 'd2.png');
    assert.deepEqual(a.bytes, b.bytes);
    let n = 0;
    await rejectsWith(() => encodeAnimated('apng', 4, (i) => png(fr[i]), { fps: 30, loop: true, isCancelled: () => n++ >= 2 }), MediaCancelled);
    const odd = [png(fr[0]), png(frames(1, 31, 20, 'many')[0])];
    await rejectsWith(() => encodeAnimated('apng', 2, (i) => odd[i], { fps: 30, loop: true }), Error, /expected 30×20/);
  });
});

describe('GIF', () => {
  for (const [colours, loop] of [['few', true], ['many', false]] as const) {
    it(`${colours} colours, ${loop ? 'loop' : 'one-shot'}: binary alpha at 128, palette, centisecond timing (Pillow, ffprobe)`, async () => {
      const fr = frames(9, 45, 25, colours);
      const r = await encode('gif', fr, 30, loop, `t-${colours}.gif`);
      const d = pillow(r.file);
      assert.deepEqual([d.info.format, d.info.width, d.info.height, d.info.frames], ['GIF', 45, 25, 9]);
      assert.equal(d.info.loop, loop ? 0 : null, 'NETSCAPE loop only for loops');
      assert.deepEqual(d.info.durations, gifDelays(9, 30).map((c) => c * 10));
      let partial = 0, toOpaque = 0, colourErr = 0, colourMax = 0, opaque = 0;
      d.frames.forEach((got, i) => {
        const src = fr[i].data;
        for (let p = 0; p < src.length; p += 4) {
          const a = src[p + 3];
          if (a > 0 && a < 255) {
            partial++;
            if (a >= 128) toOpaque++;
          }
          assert.equal(got[p + 3], a >= 128 ? 255 : 0, `frame ${i} px ${p / 4} alpha`);
          if (a >= 128) {
            opaque++;
            for (let c = 0; c < 3; c++) {
              const e = Math.abs(got[p + c] - src[p + c]);
              colourErr += e;
              colourMax = Math.max(colourMax, e);
            }
          }
        }
      });
      assert.deepEqual([r.stats.partialAlphaPixels, r.stats.partialToOpaque, r.stats.partialToTransparent], [partial, toOpaque, partial - toOpaque], 'reported alpha loss = independent count');
      assert.ok(partial > 0);
      const mean = colourErr / (opaque * 3);
      if (colours === 'few') {
        assert.equal(r.stats.exactColours, true);
        assert.equal(colourMax, 0, 'exact palette: colours exact');
      } else {
        assert.equal(r.stats.exactColours, false);
        assert.equal(r.stats.paletteColours, 255);
        // Worst case on purpose (three independent gradients, thousands of colours, no
        // dithering): measured mean 4.41, max 40 of 255. Bound = measured + margin.
        assert.ok(mean < 5 && colourMax <= 48, `median cut error mean ${mean} max ${colourMax}`);
        writeFileSync(path.join(OUT, 'gif-median-cut.txt'), `mean abs error ${mean.toFixed(3)} / 255, max ${colourMax}\n`);
      }
      const p = ffprobeFrames(r.file);
      if (p) assert.equal(p.frames, 9);
    });
  }

  it('LZW across many table resets decodes exactly (noise, 200 colours, 300×300)', async () => {
    let s = 7;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % 200);
    const d = new Uint8Array(300 * 300 * 4);
    for (let i = 0; i < 300 * 300; i++) {
      const k = rnd();
      d.set([k, 255 - k, (k * 3) & 255, 255], i * 4);
    }
    const r = await encode('gif', [{ width: 300, height: 300, data: d }, { width: 300, height: 300, data: d.slice().reverse().map((v, i) => (i % 4 === 3 ? v : v)) }], 10, true, 'noise.gif');
    const got = pillow(r.file).frames;
    assert.deepEqual(got[0], d);
    assert.ok(r.bytes.length > 300 * 300, 'noise does not compress: many table resets exercised');
  });

  it('timing, fps cap, determinism, cancel', async () => {
    for (const fps of [1, 7, 24, 25, 30, 50]) {
      const dl = gifDelays(fps * 3, fps);
      assert.equal(dl.reduce((a, b) => a + b, 0), 300, `fps ${fps}: 3 s total`);
      assert.ok(dl.every((x) => x >= 2), 'no delay below 2 cs');
    }
    assert.deepEqual(gifDelays(6, 30), [3, 4, 3, 3, 4, 3]);
    assert.deepEqual(mediaErrors('gif', GIF_MAX_FPS), []);
    assert.match(mediaErrors('gif', 60)[0], /at most 50 fps/);
    assert.deepEqual(mediaErrors('apng', 240), []);
    const fr = frames(3, 20, 20, 'many');
    await rejectsWith(() => encodeAnimated('gif', 3, (i) => png(fr[i]), { fps: 60, loop: true }), Error, /at most 50 fps/);
    const a = await encode('gif', fr, 20, true, 'g1.gif');
    const b = await encode('gif', fr, 20, true, 'g2.gif');
    assert.deepEqual(a.bytes, b.bytes);
    let n = 0;
    await rejectsWith(() => encodeAnimated('gif', 3, (i) => png(fr[i]), { fps: 20, loop: true, isCancelled: () => n++ >= 4 }), MediaCancelled);
  });
});

async function rejectsWith(fn: () => Promise<unknown>, type: Function, re?: RegExp): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof type, `${(e as Error).name}`);
    if (re) assert.match((e as Error).message, re);
    return;
  }
  assert.fail('expected a rejection');
}
