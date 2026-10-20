// Reference for R8 springs: the showcase rigs' springBake() (rigsmith-showcase-2
// scripts/lib/anim.ts at tag v3), ported verbatim except that it writes unrounded keys at
// every frame (step 1). It bakes into the clip's rotate keys; the model simulates instead.
import { sampleKeys, setKey } from '../../src/model/animation.ts';
import { evaluate } from '../../src/model/evaluate.ts';
import { angleOf, apply } from '../../src/model/math.ts';
import type { Animation, Project } from '../../src/model/types.ts';
import { emptyTrack } from '../../src/model/types.ts';

export function springBakeRef(p: Project, anim: Animation, chain: string[], o: { k: number; damp: number; gain: number; max: number; blend?: number }): void {
  const { k, damp, gain, max } = o;
  const n = Math.round(anim.duration * anim.fps);
  for (const name of chain) {
    const bone = p.bones.find((b) => b.name === name)!;
    const track = (anim.tracks[bone.id] ??= emptyTrack());
    const keyed = (f: number) => sampleKeys(track.rotate, f / anim.fps, [bone.rotation])[0];
    const tgt: number[] = [], base: { x: number; y: number }[] = [];
    for (let f = 0; f <= n; f++) {
      const m = evaluate(p, anim, f / anim.fps).world.get(bone.id)!;
      tgt.push(angleOf(m));
      base.push(apply(m, { x: 0, y: 0 }));
    }
    const len = Math.max(20, bone.length);
    const passes = anim.loop ? 2 : 1;
    let phi = tgt[0], vel = 0;
    const off: number[] = new Array(n + 1).fill(0);
    for (let pass = 0; pass < passes; pass++) {
      for (let f = 0; f <= n; f++) {
        const fp = f === 0 ? (anim.loop ? n - 1 : 0) : f - 1, fn = f === n ? (anim.loop ? 1 : n) : f + 1;
        const ax = base[fn].x - 2 * base[f].x + base[fp].x, ay = base[fn].y - 2 * base[f].y + base[fp].y;
        const dir = (phi * Math.PI) / 180;
        const perp = -ax * Math.sin(dir) + ay * Math.cos(dir);
        let d = tgt[f] - phi;
        d = ((d + 540) % 360) - 180;
        vel += k * d - damp * vel - ((perp / len) * 180 / Math.PI) * gain * 0.5;
        phi += vel;
        let ofs = phi - tgt[f];
        ofs = ((ofs + 540) % 360) - 180;
        if (Math.abs(ofs) > max) { ofs = Math.sign(ofs) * max; phi = tgt[f] + ofs; vel *= 0.5; }
        if (pass === passes - 1) off[f] = ofs;
      }
    }
    if (anim.loop) {
      const blend = o.blend ?? 12;
      for (let i = 0; i < blend; i++) {
        const f = n - blend + i, w = (i + 1) / blend;
        off[f] = off[f] * (1 - w) + off[0] * w;
      }
      off[n] = off[0];
    }
    const vals = off.map((v, f) => keyed(f) + v);
    track.rotate = [];
    vals.forEach((v, f) => setKey(track.rotate, f / anim.fps, [v], 'linear'));
  }
}
