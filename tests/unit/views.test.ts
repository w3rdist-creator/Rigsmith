// R10 view sets: a painted view registered onto the base view's alpha extent (size and chin
// line), drawn just above the base in the list and in every draw-order key; view keys that
// leave earlier frames alone, show exactly one view per frame and open the new view's eyes;
// swaps on blinks there and back; the file round trip and its validation; integrity repair.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setKey } from '../../src/model/animation.ts';
import { evaluate } from '../../src/model/evaluate.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { repairReferences } from '../../src/model/integrity.ts';
import { makeBone } from '../../src/model/ops.ts';
import { keySlotImage } from '../../src/model/rigOps.ts';
import type { Animation, Project } from '../../src/model/types.ts';
import { emptyProject, emptyTrack } from '../../src/model/types.ts';
import { addPaintedView, createViewSet, currentView, keyView, keyViewOnBlink, nextBlink, removeViewKeys, setEyes, setupAlphaExtent, showViewInSetup } from '../../src/model/views.ts';
import { encodePng } from '../support/png-encode.ts';

/** w×h image with an opaque w2×h2 block whose top-left is (ox, oy). */
function block(w: number, h: number, ox: number, oy: number, w2: number, h2: number, rgb = [230, 120, 40]): string {
  const px = new Uint8Array(w * h * 4);
  for (let y = oy; y < oy + h2; y++) for (let x = ox; x < ox + w2; x++) px.set([...rgb, 255], (y * w + x) * 4);
  return `data:image/png;base64,${encodePng(w, h, px).toString('base64')}`;
}

function head(): Project {
  const p = emptyProject('views');
  p.version = 3;
  p.bones.push(makeBone('root', 'root', null, 0, 0, 0, 20), makeBone('b_head', 'head', 'root', 10, -100, 0, 40));
  const img = (id: string, w: number, h: number, url: string) => p.images.push({ id, name: `${id}.png`, mime: 'image/png', width: w, height: h, dataUrl: url });
  img('i_front', 60, 80, block(60, 80, 10, 10, 40, 60)); // painted 40×60, centred
  img('i_eo', 20, 6, block(20, 6, 0, 0, 20, 6, [20, 20, 20]));
  img('i_eh', 20, 6, block(20, 6, 0, 2, 20, 3, [20, 20, 20]));
  img('i_ec', 20, 6, block(20, 6, 0, 3, 20, 1, [20, 20, 20]));
  // The 3/4: painted 25×50 off-centre in a 64×64 canvas, eyes closed/half variants.
  img('i_34o', 64, 64, block(64, 64, 30, 6, 25, 50, [210, 110, 40]));
  img('i_34h', 64, 64, block(64, 64, 30, 6, 25, 50, [200, 100, 40]));
  img('i_34c', 64, 64, block(64, 64, 30, 6, 25, 50, [190, 90, 40]));
  img('i_body', 30, 30, block(30, 30, 0, 0, 30, 30, [90, 60, 30]));
  const a = (id: string, boneId: string, imageId: string, x: number, y: number) => p.attachments.push({ id, name: id, boneId, imageId, x, y, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
  a('att_body', 'root', 'i_body', 0, 0);
  a('att_head', 'b_head', 'i_front', 0, 0);
  a('att_eyes', 'b_head', 'i_eo', 0, -10);
  a('att_hat', 'root', 'i_body', 0, -200); // drawn above the head unit
  // Idle: blinks at f30–35 and f96–101 (closed at f31 and f97), a draw-order key, a little head bob.
  const idle: Animation = { id: 'idle', name: 'idle', duration: 4, fps: 30, loop: true, tracks: { b_head: emptyTrack() }, slots: {}, drawOrder: [{ time: 0, order: ['att_body', 'att_head', 'att_eyes', 'att_hat'] }] };
  for (const [f, y] of [[0, -100], [60, -96], [120, -100]]) setKey(idle.tracks.b_head.translate, f / 30, [10, y], 'linear');
  for (const [f, im] of [[0, 'i_eo'], [30, 'i_eh'], [31, 'i_ec'], [33, 'i_eh'], [35, 'i_eo'], [96, 'i_eh'], [97, 'i_ec'], [99, 'i_eh'], [101, 'i_eo']] as const) keySlotImage(idle, 'att_eyes', f / 30, im);
  p.animations.push(idle);
  return p;
}

const BASE = ['att_head', 'att_eyes'];

async function withThreeQuarter(scale = 1) {
  const p = head();
  const set = createViewSet(p, 'b_head', 'head', BASE);
  setEyes(p, set.id, 'base', { attachment: 'att_eyes', open: 'i_eo', half: 'i_eh', closed: 'i_ec' });
  const { view, attachment } = await addPaintedView(p, set.id, '34', { open: 'i_34o', half: 'i_34h', closed: 'i_34c' }, { scale });
  return { p, set, view, attachment, idle: p.animations[0] };
}

/** Which of the set's views are visible at frame f. */
function shown(p: Project, anim: Animation | null, ids: string[][], f: number): number[] {
  const fr = evaluate(p, anim, f / (anim?.fps ?? 30));
  return ids.map((v, i) => (v.some((id) => fr.attachments.find((a) => a.att.id === id)!.visible) ? i : -1)).filter((i) => i >= 0);
}

const sameFrame = (a: ReturnType<typeof evaluate>, b: ReturnType<typeof evaluate>) =>
  JSON.stringify(a.attachments.map((x) => [x.att.id, x.visible, x.image?.id, x.world])) === JSON.stringify(b.attachments.map((x) => [x.att.id, x.visible, x.image?.id, x.world]));

describe('view sets: registration and draw order', () => {
  it('a painted view matches the base union height × scale and its chin line within 1 px', async () => {
    for (const scale of [1, 0.88]) {
      const { p, set, attachment } = await withThreeQuarter(scale);
      const base = await setupAlphaExtent(p, set.views[0].attachments);
      attachment.hidden = false;
      const view = await setupAlphaExtent(p, [attachment.id]);
      assert.ok(Math.abs(view.y1 - view.y0 - (base.y1 - base.y0) * scale) <= 1, `height ${view.y1 - view.y0} vs ${(base.y1 - base.y0) * scale}`);
      assert.ok(Math.abs(view.y1 - base.y1) <= 1, `chin ${view.y1} vs ${base.y1}`);
      assert.ok(Math.abs((view.x0 + view.x1) / 2 - (base.x0 + base.x1) / 2) <= 1, 'centred in x');
    }
  });

  it('fit width and anchor center register on the other axis', async () => {
    const p = head();
    const set = createViewSet(p, 'b_head', 'head', BASE);
    const { attachment } = await addPaintedView(p, set.id, 'wide', { open: 'i_34o' }, { fit: 'width', anchor: 'center' });
    const base = await setupAlphaExtent(p, BASE);
    const v = await setupAlphaExtent(p, [attachment.id]);
    assert.ok(Math.abs(v.x1 - v.x0 - (base.x1 - base.x0)) <= 1);
    assert.ok(Math.abs((v.y0 + v.y1) / 2 - (base.y0 + base.y1) / 2) <= 1);
  });

  it('is hidden in setup and drawn just above the base topmost — in the list and in every draw-order key', async () => {
    const { p, attachment, idle } = await withThreeQuarter();
    assert.equal(attachment.hidden, true);
    assert.deepEqual(p.attachments.map((a) => a.id), ['att_body', 'att_head', 'att_eyes', attachment.id, 'att_hat']);
    assert.deepEqual(idle.drawOrder![0].order, ['att_body', 'att_head', 'att_eyes', attachment.id, 'att_hat']);
    assert.ok(serializeProject(p).length > 0);
    assert.ok(parseProject(serializeProject(p)).ok, 'still a valid file (each key lists every attachment)');
  });

  it('createViewSet defaults to the bone attachments and refuses a second set on the bone', () => {
    const p = head();
    const set = createViewSet(p, 'b_head', 'head');
    assert.deepEqual(set.views[0].attachments, BASE);
    assert.throws(() => createViewSet(p, 'b_head', 'again'), /already has a view set/);
    assert.throws(() => createViewSet(p, 'nope', 'x'), /no bone/);
  });
});

describe('view sets: keys', () => {
  it('keyView at f leaves earlier frames identical and shows exactly one view per frame', async () => {
    const { p, set, view, idle } = await withThreeQuarter();
    const before = Array.from({ length: 31 }, (_, f) => evaluate(p, idle, f / 30));
    keyView(p, idle, set.id, view.id, 31);
    for (let f = 0; f < 31; f++) assert.ok(sameFrame(before[f], evaluate(p, idle, f / 30)), `frame ${f} changed`);
    const ids = set.views.map((v) => v.attachments);
    for (let f = 0; f <= 120; f++) assert.equal(shown(p, idle, ids, f).length, 1, `frame ${f}`);
    assert.deepEqual(shown(p, idle, ids, 31), [1]);
    assert.deepEqual(shown(p, idle, ids, 30), [0]);
  });

  it('writes the target eyes: closed at f, half at f+2, open at f+4 — but not over user keys', async () => {
    const { p, set, view, idle, attachment } = await withThreeQuarter();
    keyView(p, idle, set.id, view.id, 40);
    const img = (f: number) => evaluate(p, idle, f / 30).attachments.find((a) => a.att.id === attachment.id)!.image!.id;
    assert.deepEqual([img(40), img(41), img(42), img(44)], ['i_34c', 'i_34c', 'i_34h', 'i_34o']);
    const q = await withThreeQuarter();
    keySlotImage(q.idle, q.attachment.id, 43 / 30, 'i_34h'); // the user's own key inside the window
    keyView(q.p, q.idle, q.set.id, q.view.id, 40);
    const keys = q.idle.slots![q.attachment.id].image!.map((k) => Math.round(k.time * 30));
    assert.deepEqual(keys, [40, 43], 'only the closed key was added');
  });

  it('nextBlink finds the shown view closed-eye frame; keyViewOnBlink errors without one', async () => {
    const { p, set, view, idle } = await withThreeQuarter();
    assert.equal(nextBlink(p, idle, set.id, 0), 31);
    assert.equal(nextBlink(p, idle, set.id, 32), 32, 'still closed until the half key at f33');
    assert.equal(nextBlink(p, idle, set.id, 33), 97);
    assert.equal(nextBlink(p, idle, set.id, 99), null);
    assert.throws(() => keyViewOnBlink(p, idle, set.id, view.id, 99), /no closed-eye frame after f99; key a blink first/);
  });

  it('there and back on blinks: 3/4 at f31, front at f97 — frames ≥ 97 equal the original', async () => {
    const { p, set, view, idle } = await withThreeQuarter();
    const orig = structuredClone(p);
    const origIdle = orig.animations[0];
    assert.equal(keyViewOnBlink(p, idle, set.id, view.id, 30), 31);
    // While the 3/4 shows, the base eyes keep their own keys; the 3/4's next closed frame is f31
    // itself, so the way back searches from after its eyes opened.
    assert.equal(currentView(p, idle, set.id, 50 / 30)!.id, view.id);
    keySlotImage(idle, view.attachments[0], 97 / 30, 'i_34c'); // the 3/4 blinks too
    assert.equal(keyViewOnBlink(p, idle, set.id, 'base', 40), 97);
    for (let f = 97; f <= 120; f++) {
      const a = evaluate(p, idle, f / 30), b = evaluate(orig, origIdle, f / 30);
      const vis = (fr: typeof a) => fr.attachments.filter((x) => x.visible && x.att.id !== view.attachments[0]).map((x) => [x.att.id, x.image?.id, x.world]);
      assert.deepEqual(vis(a), vis(b), `frame ${f}`);
      assert.equal(a.attachments.find((x) => x.att.id === view.attachments[0])!.visible, false);
    }
  });

  it('removeViewKeys clears the set visibility keys in range', async () => {
    const { p, set, view, idle } = await withThreeQuarter();
    keyView(p, idle, set.id, view.id, 31);
    assert.equal(removeViewKeys(p, idle, set.id, 31, 31), 3);
    const ids = set.views.map((v) => v.attachments);
    assert.deepEqual(shown(p, idle, ids, 50), [0]);
  });

  it('showViewInSetup previews a view without keys', async () => {
    const { p, set, view, idle } = await withThreeQuarter();
    const keysBefore = JSON.stringify(idle.slots);
    showViewInSetup(p, set.id, view.id);
    assert.deepEqual(shown(p, null, set.views.map((v) => v.attachments), 0), [1]);
    assert.equal(JSON.stringify(idle.slots), keysBefore);
  });
});

describe('view sets: file and integrity', () => {
  it('a file without view sets round-trips byte-identical; one with them round-trips too', async () => {
    const p = head();
    const text = serializeProject(p);
    const r = parseProject(text);
    assert.ok(r.ok);
    assert.equal(serializeProject(r.project), text);
    const { p: q } = await withThreeQuarter();
    const t2 = serializeProject(q);
    const r2 = parseProject(t2);
    assert.ok(r2.ok, JSON.stringify(!r2.ok && r2.errors));
    assert.equal(serializeProject(r2.project), t2);
    assert.equal(r2.project.viewSets![0].views[1].eyes!.half, 'i_34h');
  });

  it('validation rejects bad view sets with clear errors', async () => {
    const { p } = await withThreeQuarter();
    const bad = (mut: (o: any) => void, re: RegExp) => {
      const o = JSON.parse(serializeProject(p));
      mut(o);
      const r = parseProject(JSON.stringify(o));
      assert.equal(r.ok, false);
      assert.match((r as { errors: string[] }).errors.join('\n'), re);
    };
    bad((o) => { o.viewSets[0].views[1].id = o.viewSets[0].views[0].id; }, /is duplicated/);
    bad((o) => { o.viewSets[0].views[1].attachments.push('att_head'); }, /appears more than once/);
    bad((o) => { o.viewSets[0].views[1].attachments = ['att_ghost']; }, /missing attachment "att_ghost"/);
    bad((o) => { o.viewSets[0].views[1].eyes.closed = 'i_ghost'; }, /missing image "i_ghost"/);
    bad((o) => { o.viewSets[0].boneId = 'b_ghost'; }, /missing bone "b_ghost"/);
    bad((o) => { o.viewSets[0].views = []; }, /base view/);
    bad((o) => { o.version = 2; }, /view sets/);
  });

  it('integrity repair drops deleted attachments and images, and sets that lost their base', async () => {
    const { p, set, view, attachment } = await withThreeQuarter();
    p.images = p.images.filter((i) => i.id !== 'i_34h');
    repairReferences(p);
    assert.equal(view.eyes!.half, undefined);
    p.attachments = p.attachments.filter((a) => a.id !== attachment.id);
    for (const an of p.animations) for (const k of an.drawOrder ?? []) k.order = k.order.filter((id) => id !== attachment.id);
    repairReferences(p);
    assert.equal(set.views.length, 1);
    p.attachments = p.attachments.filter((a) => !BASE.includes(a.id));
    const notes = repairReferences(p);
    assert.equal(p.viewSets, undefined);
    assert.ok(notes.some((n) => /view set/.test(n)));
  });
});
