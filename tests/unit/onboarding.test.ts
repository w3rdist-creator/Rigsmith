// RV-012 guided flat-art onboarding — model level: progress is derived from the project
// (no stored state, so old files and undo need nothing), and the guide's one-step
// operations (root + attach, grid mesh + weights, first idle).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { History } from '../../src/model/history.ts';
import { firstIdle, guideArt, guidePieces, guideSteps, meshArt, startRig } from '../../src/model/onboarding.ts';
import { makeBone } from '../../src/model/ops.ts';
import { computeWorld } from '../../src/model/skeleton.ts';
import type { ImageAsset, Project } from '../../src/model/types.ts';
import { cloneProject, emptyProject } from '../../src/model/types.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/legacy-v1.rig.json');
const done = (p: Project) => Object.fromEntries(guideSteps(p).map((s) => [s.id, s.done]));

function withArt(): Project {
  const p = emptyProject('guide');
  p.images.push({ id: 'img_art', name: 'hero.png', mime: 'image/png', width: 200, height: 300, dataUrl: PNG });
  return p;
}
function derive(p: Project, id: string, sourceId: string, kind: NonNullable<ImageAsset['derived']>['kind'], polygon?: number[]): ImageAsset {
  const im: ImageAsset = { id, name: `${id}.png`, mime: 'image/png', width: 50, height: 80, dataUrl: PNG, derived: { kind, sourceId, offsetX: 0, offsetY: 0, synthesized: 0, ...(polygon ? { polygon } : {}) } };
  p.images.push(im);
  return im;
}

describe('guide progress is derived from the project', () => {
  it('an empty project has nothing done; required vs optional steps are fixed', () => {
    const steps = guideSteps(emptyProject());
    assert.deepEqual(steps.map((s) => s.id), ['import', 'rig', 'clean', 'limbs', 'colour', 'mesh', 'idle']);
    assert.deepEqual(steps.filter((s) => s.optional).map((s) => s.id), ['clean', 'colour']);
    assert.ok(steps.every((s) => !s.done));
  });

  it('walks the steps: import → rig → clean → limbs → colour → mesh → idle', () => {
    const p = withArt();
    assert.deepEqual(done(p), { import: true, rig: false, clean: false, limbs: false, colour: false, mesh: false, idle: false });

    startRig(p, 'img_art', { bone: 'b_root', att: 'a_art' }, { x: 10.4, y: -3.6 });
    const root = p.bones.find((b) => b.id === 'b_root')!;
    assert.deepEqual([root.name, root.parentId, root.x, root.y, root.length], ['root', null, 10, -4, 60]);
    assert.deepEqual(p.attachments.map((a) => [a.name, a.boneId, a.imageId, a.x, a.y]), [['hero', 'b_root', 'img_art', 0, 0]]);
    assert.equal(done(p).rig, true);

    // Clean-up: the art now shows a cleaned copy; the original stays in the project.
    derive(p, 'img_clean', 'img_art', 'cleanup');
    p.attachments[0].imageId = 'img_clean';
    assert.equal(done(p).clean, true);
    assert.equal(guideArt(p)!.im.id, 'img_clean');

    // A polygon cut leaves a remainder on the art and a piece with its polygon.
    derive(p, 'img_rest', 'img_clean', 'remainder', [0, 0, 10, 0, 10, 10]);
    derive(p, 'img_arm', 'img_clean', 'cutout', [0, 0, 10, 0, 10, 10]);
    p.attachments[0].imageId = 'img_rest';
    p.bones.push(makeBone('b_arm', 'arm', 'b_root', -40, -60, 0, 50));
    p.attachments.push({ id: 'a_arm', name: 'arm', boneId: 'b_arm', imageId: 'img_arm', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
    assert.equal(done(p).limbs, true);
    assert.equal(done(p).clean, true, 'clean-up found through the remainder lineage');
    assert.equal(guideArt(p)!.att.id, 'a_art', 'a cut piece is never taken for the art');

    // A colour (selection) cut has no polygon.
    derive(p, 'img_hand', 'img_rest', 'cutout');
    p.attachments.push({ id: 'a_hand', name: 'hand', boneId: 'b_arm', imageId: 'img_hand', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
    assert.deepEqual(Object.fromEntries(Object.entries(guidePieces(p)).map(([k, v]) => [k, v.map((a) => a.id)])), { limbs: ['a_arm'], colour: ['a_hand'] });

    const m = meshArt(p, 'a_art', 2, 3);
    assert.ok(m.vertices >= 6);
    assert.deepEqual(m.bones.sort(), ['arm', 'root']);
    assert.equal(p.attachments[0].mesh!.weights!.length, m.vertices);
    assert.equal(done(p).mesh, true);

    const idle = firstIdle(p, 'anim_idle');
    assert.equal(idle.name, 'idle');
    assert.deepEqual(done(p), { import: true, rig: true, clean: true, limbs: true, colour: true, mesh: true, idle: true });
  });

  it('a cycle in derived lineage does not hang and is not "cleaned"', () => {
    const p = withArt();
    startRig(p, 'img_art', { bone: 'b', att: 'a' }, { x: 0, y: 0 });
    derive(p, 'x1', 'x2', 'remainder');
    derive(p, 'x2', 'x1', 'remainder');
    p.attachments[0].imageId = 'x1';
    assert.equal(done(p).clean, false);
  });
});

describe('guide operations', () => {
  it('startRig reuses an existing root and re-binds an existing art attachment', () => {
    const p = withArt();
    p.bones.push(makeBone('b_old', 'hips', null, 5, 5, 0, 30));
    p.attachments.push({ id: 'a_old', name: 'hero', boneId: null, imageId: 'img_art', x: 33, y: 44, rotation: 12, scaleX: 1, scaleY: 1, opacity: 1 });
    startRig(p, 'img_art', { bone: 'b_new', att: 'a_new' }, { x: 0, y: 0 });
    assert.equal(p.bones.length, 1, 'no second root');
    assert.deepEqual(p.attachments.map((a) => [a.id, a.boneId, a.x, a.y, a.rotation]), [['a_old', 'b_old', 0, 0, 0]]);
    assert.throws(() => startRig(p, 'nope', { bone: 'b', att: 'a' }, { x: 0, y: 0 }), /no longer exists/);
  });

  it('meshArt refuses an unattached art and weights only its bone and the bones below it', () => {
    const p = withArt();
    p.attachments.push({ id: 'a', name: 'hero', boneId: null, imageId: 'img_art', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
    assert.throws(() => meshArt(p, 'a', 3, 3), /Attach the art/);
    p.bones.push(makeBone('r', 'root', null, 0, 0, 0, 60), makeBone('c', 'child', 'r', 0, -50, 0, 40), makeBone('o', 'other', null, 300, 0, 0, 40));
    p.attachments[0].boneId = 'r';
    const m = meshArt(p, 'a', 3, 4);
    assert.deepEqual(m.bones.sort(), ['child', 'root']);
    const used = new Set(p.attachments[0].mesh!.weights!.flat().map((w) => w.bone));
    assert.ok(!used.has('o'), 'an unrelated root is not used');
    for (const list of p.attachments[0].mesh!.weights!) assert.ok(Math.abs(list.reduce((s, w) => s + w.w, 0) - 1) < 1e-9);
  });

  it('firstIdle: 2 s smooth loop, root bob of 1 % of the art height, upper bones sway ±3°, lower bones stay', () => {
    const p = withArt();
    startRig(p, 'img_art', { bone: 'r', att: 'a' }, { x: 0, y: 0 });
    // y grows downward: two bones above the art centre (y < 0), one below.
    p.bones.push(makeBone('al', 'arm_l', 'r', -40, -60, 10, 40), makeBone('ar', 'arm_r', 'r', 40, -60, -10, 40), makeBone('lg', 'leg', 'r', 0, 80, 90, 60));
    const r = firstIdle(p, 'anim');
    const an = p.animations.find((a) => a.id === 'anim')!;
    assert.deepEqual([an.name, an.duration, an.fps, an.loop], ['idle', 2, 30, true]);
    assert.deepEqual(r.swaying, ['arm_l', 'arm_r']);
    assert.deepEqual(an.tracks.r.translate.map((k) => [k.time, ...k.value]), [[0, 0, 0], [1, 0, 3], [2, 0, 0]]);
    assert.deepEqual(an.tracks.al.rotate.map((k) => k.value[0]), [10, 13, 10]);
    assert.deepEqual(an.tracks.ar.rotate.map((k) => k.value[0]), [-10, -13, -10]);
    assert.ok(!an.tracks.lg, 'leg below the centre stays planted');
    assert.ok(Object.values(an.tracks).every((t) => [...t.translate, ...t.rotate].every((k) => k.interp === 'smooth')));
    assert.equal(firstIdle(p, 'anim2').name, 'idle-2', 'a second idle gets a unique name');
    assert.ok(computeWorld(p.bones).size === 4);
    assert.throws(() => firstIdle(emptyProject(), 'x'), /root bone/);
  });
});

describe('undo, recovery and old files', () => {
  it('undoing a guide step shows it open again (one history entry per step)', () => {
    const h = new History<Project>();
    let p = withArt();
    const step = (label: string, f: (q: Project) => void) => {
      const before = cloneProject(p);
      f(p);
      h.record(label, before);
    };
    step('Guide: root bone + attach', (q) => startRig(q, 'img_art', { bone: 'r', att: 'a' }, { x: 0, y: 0 }));
    step('Guide: mesh + weights', (q) => void meshArt(q, 'a', 2, 2));
    step('Guide: first idle', (q) => void firstIdle(q, 'idle'));
    assert.equal(h.size.undo, 3);
    assert.equal(done(p).idle, true);
    p = h.undo(p)!;
    assert.deepEqual([done(p).mesh, done(p).idle], [true, false]);
    p = h.undo(p)!;
    assert.deepEqual([done(p).rig, done(p).mesh], [true, false]);
    p = h.undo(p)!;
    assert.equal(done(p).rig, false);
    p = h.redo(p)!;
    assert.equal(done(p).rig, true);
  });

  it('progress survives save → load (autosave recovery) and adds no field to the file', () => {
    const p = withArt();
    startRig(p, 'img_art', { bone: 'r', att: 'a' }, { x: 0, y: 0 });
    meshArt(p, 'a', 2, 2);
    const text = serializeProject(p);
    const keys = Object.keys(JSON.parse(text));
    const plain = Object.keys(JSON.parse(serializeProject(withArt())));
    assert.deepEqual(keys.filter((k) => !plain.includes(k)).sort(), ['animations', 'attachments', 'bones'].filter((k) => !plain.includes(k)), 'no guide field');
    assert.ok(!/onboarding|guideStep/i.test(text));
    const r = parseProject(text);
    assert.ok(r.ok);
    assert.deepEqual(done((r as { project: Project }).project), done(p));
  });

  it('the v1 legacy fixture is read without migration and re-saves byte-identically', () => {
    const text = readFileSync(FIXTURE, 'utf8');
    const r = parseProject(text);
    assert.ok(r.ok);
    const p = (r as { project: Project }).project;
    const steps = guideSteps(p);
    assert.equal(steps.length, 7);
    assert.equal(serializeProject(p), text);
  });
});
