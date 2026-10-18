// FR-002 reproduction probe (post-review): measures how Auto weights change between
// neighbouring points, and how far a skinned vertex jumps when two bones are rotated
// differently. Usage: node scripts/post-review/fr002-autoweights-probe.ts <out.json>
// Lines are sampled densely (0.05 px) on a 1000×1000 panel bound to a 30 px bone with a
// 30 px child (the review P1-1 shape, scaled up so far-field points exist):
//   contour  — x = 15 (over the root bone), y 60…140: crosses the 100 px influence cut;
//   bisector — y = 150, x −50…110: crosses x = 30, where the nearest bone changes.
// The P1-1 8×8 panel's own mesh edges are reported too.
import { writeFileSync } from 'node:fs';
import { samplePose } from '../../src/model/animation.ts';
import { evaluate } from '../../src/model/evaluate.ts';
import { autoWeights, gridPoints, triangulate } from '../../src/model/meshOps.ts';
import type { Project, VertexWeights } from '../../src/model/types.ts';

const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
function rig(W: number, points: number[], triangles: number[], hull: number): Project {
  return {
    format: 'rigsmith.project', version: 2, name: 'probe',
    images: [{ id: 'im', name: 'panel.png', mime: 'image/png', width: W, height: W, dataUrl: PNG1 }],
    bones: [
      { id: 'root', name: 'root', parentId: null, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 30, color: '#8fd3c8' },
      { id: 'tip', name: 'tip', parentId: 'root', x: 30, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 30, color: '#8fd3c8' },
    ],
    attachments: [{ id: 'a', name: 'panel', boneId: 'root', imageId: 'im', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, mesh: { points, triangles, hull } }],
    animations: [],
  };
}
const wOf = (l: VertexWeights, bone: string) => l.filter((x) => x.bone === bone).reduce((s, x) => s + x.w, 0);

/** Weights and skinned positions (tip bent by `bend` degrees) along a dense line of world points. */
function line(name: string, pts: [number, number][], bend: number) {
  const W = 1000;
  const points = pts.flatMap(([x, y]) => [x + W / 2, y + W / 2]);
  const p = rig(W, points, [], 0);
  const att = p.attachments[0];
  const w = autoWeights(p, att, ['root', 'tip']);
  att.mesh!.weights = w;
  const pose = samplePose(p.bones, null, 0);
  pose.get('tip')!.rotation += bend;
  const v = evaluate(p, null, 0, { pose }).attachments[0].vertices!;
  let maxDw = 0, at = -1, maxJump = 0, jumpAt = -1, sumBad = 0;
  for (let i = 1; i < pts.length; i++) {
    const dw = Math.abs(wOf(w[i], 'root') - wOf(w[i - 1], 'root'));
    if (dw > maxDw) { maxDw = dw; at = i; }
    const step = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const jump = Math.hypot(v[2 * i] - v[2 * i - 2], v[2 * i + 1] - v[2 * i - 1]) - step;
    if (jump > maxJump) { maxJump = jump; jumpAt = i; }
    const s = w[i].reduce((a, x) => a + x.w, 0);
    if (Math.abs(s - 1) > 1e-12) sumBad++;
  }
  const show = (i: number) => ({ point: pts[i], root: wOf(w[i], 'root'), tip: wOf(w[i], 'tip') });
  return {
    name, samples: pts.length, bendDeg: bend, weightSumNot1: sumBad,
    maxAdjacentDeltaWeight: maxDw, between: at > 0 ? [show(at - 1), show(at)] : null,
    maxSkinnedGapPx: maxJump, gapBetween: jumpAt > 0 ? [pts[jumpAt - 1], pts[jumpAt]] : null,
  };
}

const step = 0.05;
const contour: [number, number][] = [];
for (let y = 60; y <= 140 + 1e-9; y += step) contour.push([15, y]);
const bisector: [number, number][] = [];
for (let x = -50; x <= 110 + 1e-9; x += step) bisector.push([x, 150]);

// The P1-1 panel (400×400, 8×8 grid): max weight change across its own mesh edges.
const g = gridPoints(400, 400, 8, 8);
const mesh = triangulate(g.hull, g.interior);
const panel = rig(400, mesh.points, mesh.triangles, mesh.hull);
const pw = autoWeights(panel, panel.attachments[0], ['root', 'tip']);
// Overall, and over edges whose ends are both ≥ 70.7 px from both bones (where only the cut acts;
// nearer in, two vertices lying on different bones legitimately differ by almost 1).
const near = (i: number) => {
  const x = mesh.points[2 * i] - 200, y = mesh.points[2 * i + 1] - 200;
  const ds = (ax: number, bx: number) => { const t = Math.max(0, Math.min(1, (x - ax) / (bx - ax))); return Math.hypot(x - ax - t * (bx - ax), y); };
  return Math.min(ds(0, 30), ds(30, 60));
};
let edgeMax = 0, edge: number[] = [], farMax = 0, farEdge: number[] = [];
for (let t = 0; t < mesh.triangles.length; t += 3)
  for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
    const a = mesh.triangles[t + i], b = mesh.triangles[t + j];
    const d = Math.abs(wOf(pw[a], 'root') - wOf(pw[b], 'root'));
    if (d > edgeMax) { edgeMax = d; edge = [a, b]; }
    if (near(a) >= 70.7 && near(b) >= 70.7 && d > farMax) { farMax = d; farEdge = [a, b]; }
  }
const ends = (e: number[]) => e.map((i) => ({ point: [mesh.points[2 * i] - 200, mesh.points[2 * i + 1] - 200], weights: pw[i] }));

const out = {
  generated: new Date().toISOString(),
  lines: [line('contour (x=15, y 60…140)', contour, 40), line('bisector (y=150, x −50…110)', bisector, 40)],
  panelP1_1: {
    vertices: mesh.points.length / 2, maxEdgeDeltaWeight: edgeMax, edge: ends(edge),
    maxFarEdgeDeltaWeight: farMax, farEdge: ends(farEdge),
  },
};
const file = process.argv[2];
if (file) writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
