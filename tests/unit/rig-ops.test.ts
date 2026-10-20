import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Rgba } from '../../src/model/cutout.ts';
import { coverage, cutOut, extendPiece, patchBehind, polygonCentroid, polygonProblem, signedDistance } from '../../src/model/cutout.ts';
import { evaluate, drawOrderAt } from '../../src/model/evaluate.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { repairReferences } from '../../src/model/integrity.ts';
import { apply } from '../../src/model/math.ts';
import { addIk, addPath, addPathConstraint, keyDrawOrderStep, keySlotImage, keySlotScalar, moveBonePivot, placeCutout, slotValues } from '../../src/model/rigOps.ts';
import { attachmentWorld, computeWorld, deleteBone } from '../../src/model/skeleton.ts';
import type { Attachment, Bone, ImageAsset, Project } from '../../src/model/types.ts';
import { emptyProject } from '../../src/model/types.ts';

const near = (a: number, b: number, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≈ ${b}`);
const bone = (id: string, parentId: string | null, x: number, y: number, rotation: number, length: number): Bone => ({ id, name: id, parentId, x, y, rotation, scaleX: 1, scaleY: 1, length, color: '#fff' });
const img = (id: string, w: number, h: number): ImageAsset => ({ id, name: `${id}.png`, mime: 'image/png', width: w, height: h, dataUrl: 'data:image/png;base64,AA==' });
const att = (id: string, boneId: string | null, imageId: string, x = 0, y = 0, rotation = 0): Attachment => ({ id, name: id, boneId, imageId, x, y, rotation, scaleX: 1, scaleY: 1, opacity: 1 });

function solid(w: number, h: number, rgba: [number, number, number, number]): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
}

function rig(): Project {
  const p = emptyProject('ops');
  p.bones = [bone('root', null, 0, 0, 0, 10), bone('arm', 'root', 10, 5, 30, 60), bone('hand', 'arm', 60, 0, 10, 20)];
  p.images = [img('i1', 40, 20), img('i2', 40, 20), img('i3', 10, 10)];
  p.attachments = [att('a1', 'arm', 'i1', 30, 0), att('a2', 'hand', 'i2', 10, 0, 5), att('a3', 'root', 'i3')];
  p.animations = [{ id: 'an', name: 'an', duration: 1, fps: 30, loop: true, tracks: {} }];
  return p;
}

describe('cutout pixel ops', () => {
  it('signed distance and coverage: inside 1, outside 0, 1-px anti-aliased edge, exact grow', () => {
    const sq = [10, 10, 30, 10, 30, 30, 10, 30];
    near(signedDistance(sq, 20, 20), -10);
    near(signedDistance(sq, 35, 20), 5);
    const c0 = coverage(sq, 0, { x: 0, y: 0, width: 40, height: 40 });
    assert.equal(c0[20 * 40 + 20], 1);
    assert.equal(c0[20 * 40 + 35], 0);
    near(c0[20 * 40 + 9], 0, 1e-9, 'pixel centre 9.5 is 0.5 outside');
    near(c0[20 * 40 + 10], 1, 1e-9, 'pixel centre 10.5 is 0.5 inside');
    const c4 = coverage(sq, 4, { x: 0, y: 0, width: 40, height: 40 });
    assert.equal(c4[20 * 40 + 33], 1, 'grown by 4 px');
    assert.equal(c4[20 * 40 + 35], 0);
  });

  it('piece + remainder recompose the source exactly at overlap 0; the source buffer is untouched', () => {
    const src = solid(50, 40, [200, 100, 50, 255]);
    const before = new Uint8ClampedArray(src.data);
    const tri = [5.3, 4.1, 44.7, 12.2, 20.5, 35.9];
    const r = cutOut(src, tri, 0);
    assert.deepEqual(src.data, before, 'source not modified');
    let maxErr = 0;
    for (let y = 0; y < 40; y++) for (let x = 0; x < 50; x++) {
      const px = x - r.offsetX, py = y - r.offsetY;
      const pa = px >= 0 && py >= 0 && px < r.piece.width && py < r.piece.height ? r.piece.data[(py * r.piece.width + px) * 4 + 3] : 0;
      const ra = r.remainder.data[(y * 50 + x) * 4 + 3];
      maxErr = Math.max(maxErr, Math.abs(pa + ra - 255));
    }
    assert.ok(maxErr <= 1, `alpha sums to the source (max rounding error ${maxErr})`);
    assert.ok(r.holePixels > 100, 'a hole was cut');
    assert.equal(r.piece.data[((Math.round(12 - r.offsetY)) * r.piece.width + Math.round(20 - r.offsetX)) * 4], 200, 'piece keeps source colour');
  });

  it('overlap grows the piece outward and crops it tightly; problems are reported', () => {
    const src = solid(60, 60, [0, 0, 255, 255]);
    const sq = [20, 20, 40, 20, 40, 40, 20, 40];
    const a = cutOut(src, sq, 0), b = cutOut(src, sq, 6);
    assert.deepEqual([a.offsetX, a.offsetY, a.piece.width, a.piece.height], [20, 20, 20, 20]);
    assert.deepEqual([b.offsetX, b.offsetY, b.piece.width, b.piece.height], [14, 14, 32, 32]);
    assert.equal(polygonProblem([1, 1, 2, 2], 10, 10), 'Place at least 3 points.');
    assert.equal(polygonProblem([1, 1, 5, 5, 9, 9], 10, 10), 'The outline encloses no area.');
    assert.equal(polygonProblem([100, 100, 120, 100, 120, 120], 10, 10), 'The outline lies outside the image.');
  });

  it('patch fills only transparent pixels inside the outline, behind existing ones, and counts them', () => {
    const src = solid(30, 30, [10, 20, 30, 255]);
    const hole = cutOut(src, [10, 10, 20, 10, 20, 20, 10, 20], 0).remainder;
    const p = patchBehind(hole, [10, 10, 20, 10, 20, 20, 10, 20], 1, [255, 0, 0]);
    assert.ok(p.synthesized >= 100 && p.synthesized <= 121, `synthesized ${p.synthesized}`);
    const at = (x: number, y: number) => Array.from(p.image.data.subarray((y * 30 + x) * 4, (y * 30 + x) * 4 + 4));
    assert.deepEqual(at(15, 15), [255, 0, 0, 255], 'hole filled');
    assert.deepEqual(at(2, 2), [10, 20, 30, 255], 'outside untouched');
    assert.deepEqual(at(9, 15)[3], 255, 'edge stays opaque');
  });
});

describe('cutout placement and pivot editing', () => {
  it('the piece lands exactly over its source pixels; the joint bone sits at the pivot', () => {
    const p = rig();
    const src = p.attachments[0];
    const before = attachmentWorld(src, computeWorld(p.bones));
    const piece: ImageAsset = { ...img('pc', 12, 8), derived: { kind: 'cutout', sourceId: 'i1', offsetX: 25, offsetY: 6, synthesized: 0 } };
    const rem: ImageAsset = { ...img('rem', 40, 20), derived: { kind: 'remainder', sourceId: 'i1', offsetX: 0, offsetY: 0, synthesized: 0 } };
    const r = placeCutout(p, { sourceAttId: 'a1', piece, remainder: rem, name: 'fore', pivot: { x: 26, y: 10 }, createBone: true, boneParentId: 'arm', polygon: [25, 6, 37, 6, 37, 14, 25, 14], ids: { att: 'n1', bone: 'nb' } });
    const w = computeWorld(p.bones);
    const pieceAtt = p.attachments.find((a) => a.id === r.attId)!;
    assert.equal(p.attachments.indexOf(pieceAtt), 1, 'directly above the source');
    assert.equal(pieceAtt.boneId, 'nb');
    // Piece pixel (u,v) must map to source pixel (25+u, 6+v).
    const pw = attachmentWorld(pieceAtt, w);
    for (const [u, v] of [[0, 0], [12, 8], [3, 5]]) {
      const a = apply(pw, { x: u - 6, y: v - 4 });
      const b = apply(before, { x: 25 + u - 20, y: 6 + v - 10 });
      near(a.x, b.x, 2e-3, 'x');
      near(a.y, b.y, 2e-3, 'y');
    }
    const pivot = apply(before, { x: 26 - 20, y: 0 });
    near(w.get('nb')!.tx, pivot.x, 2e-3, 'bone at pivot');
    near(w.get('nb')!.ty, pivot.y, 2e-3);
    assert.equal(p.attachments[0].imageId, 'rem', 'source shows the remainder');
    assert.ok(p.images.some((i) => i.id === 'i1'), 'original image kept');
    const back = parseProject(serializeProject(p));
    assert.ok(back.ok, back.ok ? '' : back.errors.join('\n'));
    assert.equal(back.project.version, 2, 'derived images need v2');
  });

  it('moving a pivot keeps images and child bones in place (setup) and shifts translate keys', () => {
    const p = rig();
    p.animations[0].tracks.arm = { translate: [{ time: 0, value: [10, 5], interp: 'linear' }], rotate: [], scale: [] };
    p.animations[0].tracks.hand = { translate: [{ time: 0, value: [60, 0], interp: 'linear' }], rotate: [], scale: [] };
    const w0 = computeWorld(p.bones);
    const atts0 = p.attachments.map((a) => attachmentWorld(a, w0));
    moveBonePivot(p, 'arm', 25, -4);
    const w1 = computeWorld(p.bones);
    near(w1.get('hand')!.tx, w0.get('hand')!.tx, 1e-3, 'child stays');
    near(w1.get('hand')!.ty, w0.get('hand')!.ty, 1e-3);
    p.attachments.forEach((a, i) => {
      const m = attachmentWorld(a, w1);
      near(m.tx, atts0[i].tx, 1e-3, `${a.id} stays`);
      near(m.ty, atts0[i].ty, 1e-3);
    });
    assert.deepEqual(p.animations[0].tracks.arm.translate[0].value, [25, -4], 'own key shifted with the pivot');
    const f = evaluate(p, p.animations[0], 0).world;
    near(f.get('hand')!.tx, w0.get('hand')!.tx, 1e-3, 'animated child stays when rotation is at setup');
  });
});

describe('slot, draw-order and constraint ops', () => {
  it('visibility (stepped), opacity and image keys evaluate per frame', () => {
    const p = rig();
    const an = p.animations[0];
    keySlotScalar(an, 'a1', 'visible', 0.5, 0);
    keySlotScalar(an, 'a1', 'opacity', 0, 1);
    keySlotScalar(an, 'a1', 'opacity', 1, 0);
    keySlotImage(an, 'a1', 0.2, 'i2');
    assert.equal(an.slots!.a1.visible![0].interp, 'step');
    const f = (t: number) => evaluate(p, an, t).attachments.find((x) => x.att.id === 'a1')!;
    assert.equal(f(0.4).visible, true, 'no key before 0.5: setup visibility');
    assert.equal(f(0.5).visible, false);
    near(f(0.25).opacity, 0.75);
    assert.equal(f(0.1).image!.id, 'i1');
    assert.equal(f(0.2).image!.id, 'i2');
    assert.deepEqual(slotValues(p.attachments[0], an, 0.6), { visible: false, opacity: 0.4, color: [1, 1, 1, 1], imageId: 'i2' });
  });

  it('draw-order keys swap neighbours from the evaluated order and stay valid after edits', () => {
    const p = rig();
    const an = p.animations[0];
    assert.ok(keyDrawOrderStep(p, an, 0.5, 'a3', -1));
    assert.deepEqual(drawOrderAt(p, an, 0.5).map((a) => a.id), ['a1', 'a3', 'a2']);
    assert.deepEqual(drawOrderAt(p, an, 0.4).map((a) => a.id), ['a1', 'a2', 'a3'], 'stepped: before the key = setup');
    assert.ok(!keyDrawOrderStep(p, an, 0.5, 'a1', -1), 'already at the back');
    p.attachments.push(att('a4', 'root', 'i3'));
    p.attachments = p.attachments.filter((a) => a.id !== 'a2');
    repairReferences(p);
    assert.deepEqual(an.drawOrder![0].order, ['a1', 'a3', 'a4']);
    assert.ok(parseProject(serializeProject(p)).ok, 'repaired project re-opens');
  });

  it('addIk creates a target at the tip outside the chain without moving the limb', () => {
    const p = rig();
    const w0 = computeWorld(p.bones);
    const ik = addIk(p, 'hand', true, { ik: 'k', target: 't' })!;
    assert.deepEqual(ik.bones, ['arm', 'hand']);
    const t = p.bones.find((b) => b.id === 't')!;
    assert.equal(t.parentId, 'root');
    const f = evaluate(p, null, 0).world;
    for (const id of ['arm', 'hand']) {
      near(f.get(id)!.tx, w0.get(id)!.tx, 1e-6, `${id} unchanged`);
      near(Math.atan2(f.get(id)!.b, f.get(id)!.a), Math.atan2(w0.get(id)!.b, w0.get(id)!.a), 1e-6, `${id} angle unchanged`);
    }
    assert.equal(addIk(p, 'root', true, { ik: 'k2', target: 't2' }), null, 'a root bone has no 2-bone chain');
  });

  it('deleting a bone drops dependent constraints and keeps paths in place', () => {
    const p = rig();
    addIk(p, 'hand', true, { ik: 'k', target: 't' });
    const path = addPath(p, 'pa', 'arm', { x: 50, y: 50 });
    const pw0 = computeWorld(p.bones).get('arm')!;
    const node0 = apply(pw0, path.nodes[0]);
    addPathConstraint(p, 'pc', 'pa', ['t']);
    deleteBone(p, 'arm');
    const notes = repairReferences(p);
    assert.equal(p.ik!.length, 0);
    assert.ok(notes.some((n) => /IK/.test(n)));
    assert.equal(p.paths![0].boneId, 'root');
    const node1 = apply(computeWorld(p.bones).get('root')!, p.paths![0].nodes[0]);
    near(node1.x, node0.x, 1e-6);
    near(node1.y, node0.y, 1e-6);
    assert.equal(p.pathConstraints!.length, 1, 'path constraint on the target survives');
  });
});

describe('loop seam on stepped lanes', () => {
  it('a stepped lane whose first key is after frame 0 closes to the setup value, not the first key', async () => {
    const { closeLoopSeam } = await import('../../src/model/keys.ts');
    const p = rig();
    const an = p.animations[0];
    keySlotScalar(an, 'a1', 'visible', 0.3, 0);
    keySlotImage(an, 'a1', 0.4, 'i2');
    keyDrawOrderStep(p, an, 0.5, 'a3', -1);
    keySlotScalar(an, 'a2', 'visible', 0, 0); // first key at frame 0: copied as-is
    const lanes = closeLoopSeam(an, undefined, p);
    assert.equal(lanes.length, 4);
    const at1 = evaluate(p, an, 1);
    const at0 = evaluate(p, an, 0);
    assert.deepEqual(at1.attachments.map((f) => [f.att.id, f.visible, f.image!.id]), at0.attachments.map((f) => [f.att.id, f.visible, f.image!.id]), 'end frame shows what frame 0 shows');
  });
});

describe('patch limits', () => {
  it('a loose outline never paints background the source did not cover', () => {
    // Opaque disk (r = 8) inside a transparent 30×30 square; outline covers the whole square.
    const data = new Uint8ClampedArray(30 * 30 * 4);
    for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) {
      const a = Math.min(1, Math.max(0, 8.5 - Math.hypot(x + 0.5 - 15, y + 0.5 - 15)));
      data.set([0, 0, 255, Math.round(255 * a)], (y * 30 + x) * 4);
    }
    const src: Rgba = { width: 30, height: 30, data };
    const all = [0, 0, 30, 0, 30, 30, 0, 30];
    const { remainder } = cutOut(src, [10, 10, 20, 10, 20, 20, 10, 20], 0);
    const p = patchBehind(remainder, all, 1, [255, 0, 0], src);
    assert.equal(p.image.data[(2 * 30 + 2) * 4 + 3], 0, 'corner stays transparent');
    assert.equal(p.image.data[(15 * 30 + 15) * 4 + 3], 255, 'hole restored to source alpha');
    let over = 0;
    for (let i = 0; i < 900; i++) if (p.image.data[i * 4 + 3] > src.data[i * 4 + 3]) over++;
    assert.equal(over, 0, 'never more alpha than the source had');
    assert.ok(p.synthesized <= 121, `only hole pixels counted (${p.synthesized})`);
  });
});

describe('joint extension', () => {
  it('axis aims at the outline area centroid (a rectangle cut from its left-edge midpoint runs horizontally)', () => {
    const c = polygonCentroid([100, 0, 200, 0, 200, 44, 100, 44]);
    assert.deepEqual(c, { x: 150, y: 22 });
    // Vertex-dense side does not pull the centroid: extra points along the top edge.
    const d = polygonCentroid([100, 0, 125, 0, 150, 0, 175, 0, 200, 0, 200, 44, 100, 44]);
    assert.ok(Math.abs(d.x - 150) < 1e-9 && Math.abs(d.y - 22) < 1e-9, JSON.stringify(d));
    assert.deepEqual(polygonCentroid([0, 0, 10, 0, 20, 0]), { x: 10, y: 0 }, 'degenerate falls back to vertex mean');
  });

  // A horizontal bar (rows 4..15, opaque, colour varies by row) across a 100×20 image.
  function bar(): Rgba {
    const data = new Uint8ClampedArray(100 * 20 * 4);
    for (let y = 4; y < 16; y++) for (let x = 0; x < 100; x++) data.set([y * 10, 50, 200, 255], (y * 100 + x) * 4);
    return { width: 100, height: 20, data };
  }

  it('sweeps the clean cross-section back under opaque cover only, counting synthesized pixels', () => {
    const src = bar();
    const cut = cutOut(src, [50, 0, 100, 0, 100, 20, 50, 20], 0);
    const ext = extendPiece(cut.piece, cut.offsetX, cut.offsetY, { x: 50, y: 10 }, { x: 1, y: 0 }, 20, cut.remainder);
    assert.equal(ext.offsetX, 30, 'grew 20 px back past the cut');
    assert.equal(ext.offsetY, 4);
    assert.ok(ext.synthesized >= 20 * 12 - 12 && ext.synthesized <= 20 * 12, `synthesized ${ext.synthesized}`);
    const px = (x: number, y: number) => Array.from(ext.piece.data.subarray(((y - ext.offsetY) * ext.piece.width + (x - ext.offsetX)) * 4, ((y - ext.offsetY) * ext.piece.width + (x - ext.offsetX)) * 4 + 4));
    assert.deepEqual(px(35, 8), [80, 50, 200, 255], 'row colour continued from the clean section');
    assert.deepEqual(px(60, 8), [80, 50, 200, 255], 'original piece pixels untouched');
  });

  it('does not synthesize where nothing opaque covers the joint at rest', () => {
    const src = bar();
    const cut = cutOut(src, [50, 0, 100, 0, 100, 20, 50, 20], 0);
    const empty: Rgba = { width: 100, height: 20, data: new Uint8ClampedArray(100 * 20 * 4) };
    const ext = extendPiece(cut.piece, cut.offsetX, cut.offsetY, { x: 50, y: 10 }, { x: 1, y: 0 }, 20, empty);
    assert.equal(ext.synthesized, 0);
    assert.equal(ext.offsetX, 50);
  });
});
