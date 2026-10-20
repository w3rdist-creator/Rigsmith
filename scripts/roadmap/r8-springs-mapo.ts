// R8 evidence: in-model springs against the showcase's springBake() on a real rig. Every
// animation of the project has the spring bones' rotate keys stripped (showcase 2 bakes
// its springs into them); then (a) the springs are added to the project and simulated by
// the model, and (b) the reference port bakes them into keys in the showcase's order.
// World angles of every bone are compared at every frame; timings are reported.
// Usage: node scripts/roadmap/r8-springs-mapo.ts <mapo.rig.json> <out dir>
// Run on showcase 2's Mapo (v3 tag); the rig is not a fixture.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evaluate } from '../../src/model/evaluate.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { angleOf } from '../../src/model/math.ts';
import { addSpring, bakeSprings } from '../../src/model/rigOps.ts';
import { springOffsets } from '../../src/model/springs.ts';
import type { Project } from '../../src/model/types.ts';
import { springBakeRef } from '../../tests/support/spring-reference.ts';

// showcase 2 scripts/clips.ts springs() at s = 1, in its order.
const CHAINS: [string, string[], { k: number; damp: number; gain: number; max: number }][] = [
  ['ear_l', ['ear_l'], { k: 0.12, damp: 0.22, gain: 0.9, max: 25 }],
  ['ear_r', ['ear_r'], { k: 0.12, damp: 0.22, gain: 0.9, max: 25 }],
  ['toque', ['toque1', 'toque2', 'cherry'], { k: 0.15, damp: 0.24, gain: 0.75, max: 10 }],
  ['scarf', ['scarf_tail1', 'scarf_tail2'], { k: 0.09, damp: 0.16, gain: 1.4, max: 40 }],
  ['tail', ['tail1', 'tail2', 'tail3', 'tail4', 'tail5'], { k: 0.07, damp: 0.16, gain: 0.7, max: 30 }],
  ['hand_r', ['hand_r'], { k: 0.16, damp: 0.24, gain: 0.55, max: 14 }],
];

const [file, out] = process.argv.slice(2);
const r = parseProject(readFileSync(file, 'utf8'));
if (!r.ok) throw new Error(r.errors.join('\n'));
mkdirSync(out, { recursive: true });
const idOf = (p: Project, n: string) => p.bones.find((b) => b.name === n)!.id;
const sprungIds = (p: Project) => new Set(CHAINS.flatMap(([, bones]) => bones.map((n) => idOf(p, n))));

const stripped = structuredClone(r.project);
for (const a of stripped.animations) for (const id of sprungIds(stripped)) if (a.tracks[id]) a.tracks[id].rotate = [];

const model = structuredClone(stripped);
for (const [name, bones, o] of CHAINS) {
  const s = addSpring(model, `spring_${name}`, bones.map((n) => idOf(model, n)), { stiffness: o.k, damping: o.damp, gain: o.gain, max: o.max });
  if ('error' in s) throw new Error(s.error);
}
const ref = structuredClone(stripped);
const lines = [`project ${path.basename(file)}: ${ref.bones.length} bones, ${ref.animations.length} animations; springs: ${CHAINS.map(([n, b]) => `${n} (${b.length})`).join(', ')}`, ''];
const wrap = (d: number) => Math.abs(((d + 540) % 360) - 180);
let worstAll = 0;
for (let i = 0; i < ref.animations.length; i++) {
  const ra = ref.animations[i], ma = model.animations[i];
  let t0 = performance.now();
  for (const [, bones, o] of CHAINS) springBakeRef(ref, ra, bones, o);
  const refMs = performance.now() - t0;
  t0 = performance.now();
  const offs = springOffsets(model, ma);
  const simMs = performance.now() - t0;
  const n = Math.round(ma.duration * ma.fps);
  let worst = 0, lag = 0;
  t0 = performance.now();
  for (let f = 0; f <= n; f++) {
    const wm = evaluate(model, ma, f / ma.fps).world, wr = evaluate(ref, ra, f / ra.fps).world;
    for (const [id, m] of wm) worst = Math.max(worst, wrap(angleOf(m) - angleOf(wr.get(id)!)));
  }
  const evalMs = (performance.now() - t0) / (2 * (n + 1));
  for (const o of offs.values()) for (const v of o) lag = Math.max(lag, Math.abs(v));
  worstAll = Math.max(worstAll, worst);
  lines.push(`${ma.name.padEnd(13)} ${String(n + 1).padStart(4)} frames${ma.loop ? ' loop' : '     '}  max |model − reference| ${worst.toExponential(2)}°  max spring lag ${lag.toFixed(1)}°  simulate ${simMs.toFixed(0)} ms (reference bake ${refMs.toFixed(0)} ms)  evaluate ${evalMs.toFixed(2)} ms/frame cached`);
}
const baked = structuredClone(model);
const bk = bakeSprings(baked);
let bakeWorst = 0;
for (let i = 0; i < baked.animations.length; i++) {
  const a = baked.animations[i], b = model.animations[i];
  for (let f = 0; f <= Math.round(a.duration * a.fps); f++) {
    const wa = evaluate(baked, a, f / a.fps).world, wb = evaluate(model, b, f / b.fps).world;
    for (const [id, m] of wa) bakeWorst = Math.max(bakeWorst, wrap(angleOf(m) - angleOf(wb.get(id)!)));
  }
}
lines.push('', `bakeSprings: ${bk.bones} bone tracks in ${bk.animations} animations; max |baked − simulated| ${bakeWorst.toExponential(2)}°`);
lines.push(`result: ${worstAll < 1e-6 && bakeWorst < 1e-6 ? 'PASS' : 'FAIL'} (tolerance 1e-6°)`);
writeFileSync(path.join(out, 'mapo-springs.rig.json'), serializeProject(model));
writeFileSync(path.join(out, 'report.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
if (!(worstAll < 1e-6 && bakeWorst < 1e-6)) process.exitCode = 1;
