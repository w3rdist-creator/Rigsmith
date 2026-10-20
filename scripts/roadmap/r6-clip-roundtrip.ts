// R6 evidence: every animation of a project goes export → YAML → apply (replace) and must
// evaluate identically (deep-equal Frames, every frame and a mid-frame sample, every skin).
// Usage: node scripts/roadmap/r6-clip-roundtrip.ts <project.rig.json> <out dir>
// Run on showcase 2's Mapo (v3 tag) for the react_win acceptance; the rig is not a fixture.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { applyClip, exportClip, formatClipSpec, parseClipText } from '../../src/model/clipSpec.ts';
import { evaluate } from '../../src/model/evaluate.ts';
import { parseProject } from '../../src/model/format.ts';

const [file, out] = process.argv.slice(2);
const r = parseProject(readFileSync(file, 'utf8'));
if (!r.ok) throw new Error(r.errors.join('\n'));
const p = r.project;
mkdirSync(out, { recursive: true });
const lines: string[] = [`project ${path.basename(file)}: ${p.bones.length} bones, ${p.attachments.length} attachments, ${p.animations.length} animations`];
let failures = 0;
for (const a of p.animations) {
  const text = formatClipSpec(exportClip(p, a.id));
  const spec = path.join(out, `${a.name}.clip.yaml`);
  writeFileSync(spec, text);
  const parsed = parseClipText(text, spec);
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  const applied = applyClip(p, parsed.spec, 'replace');
  if (!applied.ok) throw new Error(`${a.name}: ${applied.errors.join('\n')}`);
  const b = applied.project.animations.find((x) => x.id === applied.animId)!;
  let samples = 0, diffs = 0;
  const n = Math.round(a.duration * a.fps);
  for (let f = 0; f <= n; f++)
    for (const t of [f / a.fps, (f + 0.5) / a.fps]) {
      if (t > a.duration) continue;
      for (const skinId of [null, ...(p.skins ?? []).map((s) => s.id)]) {
        samples++;
        try {
          assert.deepEqual(evaluate(applied.project, b, t, { skinId }), evaluate(p, a, t, { skinId }));
        } catch {
          diffs++;
        }
      }
    }
  failures += diffs;
  lines.push(`${a.name}: ${n + 1} frames, ${applied.keys} keys, spec ${text.length} bytes; ${samples} evaluate() samples, ${diffs} differ`);
}
lines.push(failures ? `FAIL: ${failures} differing samples` : 'PASS: every sample identical');
writeFileSync(path.join(out, 'report.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
process.exit(failures ? 1 : 0);
