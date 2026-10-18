// LP-001 measurement (model level, no browser): import greeting-v2 from the Wiz v2 rig
// into the Wiz v3 rig with the same model code the "Import anims…" dialog runs, then
// measure what the imported keys do. Prints per-frame world angles:
//   forearm_r − chest  (constant ⇒ the arm_r rotate keys have no effect: IK overrides them)
//   arm_r − chest      (the upper arm's world angle relative to the chest)
// for the default import and, when the model supports it, with the driving constraints
// keyed to mix 0 in the imported copy. Reads both rigs; writes nothing but stdout (and
// the optional JSON report path given as argv[2]).
// Usage: node scripts/roadmap/lp001-measure.ts [report.json]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as imp from '../../src/model/animImport.ts';
import { evaluate } from '../../src/model/evaluate.ts';
import { parseProject } from '../../src/model/format.ts';
import type { Project } from '../../src/model/types.ts';
import { WIZ } from '../wiz/paths.ts';

const load = (f: string): Project => {
  const r = parseProject(readFileSync(f, 'utf8'));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.project;
};
const V2 = path.join(WIZ, 'roadmap-output/wiz-v2.rig.json');
const V3 = path.join(WIZ, 'v3-output/wiz-v3.rig.json');
const deg = (m: { a: number; b: number }) => (Math.atan2(m.b, m.a) * 180) / Math.PI;
// Distance from the shin's tip (bone end) to the foot bone's origin, world px.
const gap = (m: { a: number; b: number; tx: number; ty: number }, len: number, f: { tx: number; ty: number }) => Math.hypot(m.tx + m.a * len - f.tx, m.ty + m.b * len - f.ty);
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

function run(mute: boolean, skipArmR = false) {
  const src = load(V2), dst = load(V3);
  const anim = src.animations.find((a) => a.name === 'greeting-v2')!;
  const mapping = imp.defaultMapping(src, dst, [anim.id]);
  if (skipArmR) mapping.bones[src.bones.find((b) => b.name === 'arm_r')!.id] = null;
  const all = (dst.ik ?? []).map((k) => k.id);
  const options = mute ? { muteConstraints: all } : undefined;
  const rep = (imp.importAnimations as (...a: unknown[]) => imp.ImportReport)(dst, src, [anim.id], mapping, options);
  const out = dst.animations.find((a) => a.name === rep.imported[0].name)!;
  const id = (n: string) => dst.bones.find((b) => b.name === n)!.id;
  const n = Math.round(out.duration * out.fps);
  const rows: { f: number; forearmRel: number; armRel: number; armLocal: number; footGap: number }[] = [];
  const shin = dst.bones.find((b) => b.name === 'shin_l')!;
  for (let f = 0; f < n; f++) {
    const fr = evaluate(dst, out, f / out.fps);
    const w = fr.world;
    const chest = deg(w.get(id('chest'))!);
    rows.push({ f, forearmRel: wrap(deg(w.get(id('forearm_r'))!) - chest), armRel: wrap(deg(w.get(id('arm_r'))!) - chest), armLocal: fr.pose.get(id('arm_r'))!.rotation, footGap: gap(w.get(shin.id)!, shin.length, w.get(id('foot_l'))!) });
  }
  const range = (k: 'forearmRel' | 'armRel') => Math.max(...rows.map((r) => r[k])) - Math.min(...rows.map((r) => r[k]));
  const srcTrack = anim.tracks[src.bones.find((b) => b.name === 'arm_r')!.id].rotate;
  const srcArm = srcTrack.map((k) => k.value[0]);
  // The raise frame: the arm_r key furthest from the key at frame 0.
  const raise = srcTrack.reduce((b, k) => (Math.abs(k.value[0] - srcArm[0]) > Math.abs(b.value[0] - srcArm[0]) ? k : b));
  const rf = Math.round(raise.time * out.fps);
  const raiseCheck = { frame: rf, keyDelta: raise.value[0] - srcArm[0], localDelta: rows[rf].armLocal - rows[0].armLocal, worldRelDelta: rows[rf].armRel - rows[0].armRel };
  return { mute, skipArmR, report: rep, raiseCheck, mixKeys: Object.fromEntries((dst.ik ?? []).map((k) => [k.name, out.constraints?.[k.id]?.mix ?? null])), forearmRange: range('forearmRel'), armRange: range('armRel'), sourceArmKeyRange: Math.max(...srcArm) - Math.min(...srcArm), rows };
}

const results = [run(false), run(false, true), run(true)];
// Dead keys: the default import and an import that skips arm_r entirely pose arm_r identically.
const deadDiff = Math.max(...results[0].rows.map((r, i) => Math.abs(r.armRel - results[1].rows[i].armRel)));
console.log(`default import vs arm_r skipped: max |Δ arm_r−chest| over ${results[0].rows.length} frames = ${deadDiff.toExponential(2)}° (0 ⇒ the 10 arm_r keys have no effect)`);
for (const r of [results[0], results[2]]) {
  console.log(`== ${r.mute ? 'with the driving IK keyed to mix 0 (option on)' : 'default import (option off)'}`);
  console.log(`report: ${imp.reportSummary(r.report)}`);
  console.log(`driven: ${JSON.stringify((r.report as unknown as { driven?: unknown }).driven ?? '(not reported)')}`);
  console.log(`rig notes: ${JSON.stringify((r.report as unknown as { rig?: unknown }).rig ?? '(not reported)')}`);
  console.log(`raise frame ${r.raiseCheck.frame}: arm_r key Δ ${r.raiseCheck.keyDelta.toFixed(2)}°, solved local Δ ${r.raiseCheck.localDelta.toFixed(2)}°, world (rel. chest) Δ ${r.raiseCheck.worldRelDelta.toFixed(2)}°`);
  console.log(`shin_l tip → foot_l origin gap: max ${Math.max(...r.rows.map((x) => x.footGap)).toFixed(1)} px, frame 0 ${r.rows[0].footGap.toFixed(1)} px`);
  console.log(`imported mix keys: ${JSON.stringify(r.mixKeys)}`);
  console.log(`range over ${r.rows.length} frames: forearm_r−chest ${r.forearmRange.toFixed(4)}°, arm_r−chest ${r.armRange.toFixed(4)}° (source arm_r rotate keys span ${r.sourceArmKeyRange.toFixed(2)}°)`);
  console.log(`frames 0/12/24/36/48/60: ${[0, 12, 24, 36, 48, 60].map((f) => `${f}: fa ${r.rows[f].forearmRel.toFixed(2)} arm ${r.rows[f].armRel.toFixed(2)}`).join(' | ')}`);
}
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ deadDiff }) + '\n' + JSON.stringify(results.map(({ report, ...r }) => ({ ...r, summary: imp.reportSummary(report), report })), null, 1));
