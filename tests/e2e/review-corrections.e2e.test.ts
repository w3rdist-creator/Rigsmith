// Fable review corrections, driven through visible controls (window.__rigsmith is read
// only): LP-001/LP-002 import options, the paste report (retarget + constraint-driven
// keys), LP-006 Sequences dialog after undo/redo, LP-007 hint, LP-009 unknown-field
// warning on Open, LP-010 legacy storage migration order, LP-011 guide scope on the demo.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { serializeProject } from '../../src/model/format.ts';
import type { Project } from '../../src/model/types.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, readIdb, startPreview, waitUntil } from './harness.ts';

const OUT = path.join(EVIDENCE, 'review-corrections/e2e');
mkdirSync(OUT, { recursive: true });

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
let base = '';
const pageErrors: string[] = [];

const bone = (id: string, name: string, parentId: string | null, x: number, y: number, rotation: number, length: number) => ({ id, name, parentId, x, y, rotation, scaleX: 1, scaleY: 1, length, color: '#8fd3c8' });
const k = (time: number, value: number[]) => ({ time, value, interp: 'linear' });

/** Donor: arm setup −90°, "reach" keys arm −90 → −30 and fore 0. No constraints. */
function donor(): Project {
  return {
    format: 'rigsmith.project', version: 1, name: 'donor', images: [], attachments: [],
    bones: [bone('d-root', 'root', null, 0, 0, 0, 30), bone('d-arm', 'arm', 'd-root', 0, 0, -90, 80), bone('d-fore', 'fore', 'd-arm', 80, 0, 0, 60)],
    animations: [{ id: 'd-reach', name: 'reach', duration: 1, fps: 10, loop: false, tracks: {
      'd-arm': { translate: [], rotate: [k(0, [-90]), k(0.5, [-30])], scale: [] },
      'd-fore': { translate: [], rotate: [k(0, [0])], scale: [] },
    } }],
  } as unknown as Project;
}

/** Stage: arm setup −60°, a two-bone IK "arm-ik" on [arm, fore] at mix 1, a "pose" clip. */
function stage(): Project {
  return {
    format: 'rigsmith.project', version: 2, name: 'stage', images: [], attachments: [],
    bones: [bone('s-root', 'root', null, 0, 0, 0, 30), bone('s-arm', 'arm', 's-root', 0, 0, -60, 80), bone('s-fore', 'fore', 's-arm', 80, 0, 0, 60), bone('s-tgt', 'tgt', 's-root', 100, -60, 0, 10)],
    ik: [{ id: 's-ik', name: 'arm-ik', bones: ['s-arm', 's-fore'], target: 's-tgt', mix: 1, bendPositive: true }],
    animations: [{ id: 's-pose', name: 'pose', duration: 1, fps: 10, loop: true, tracks: { 's-arm': { translate: [], rotate: [k(0, [-60]), k(0.5, [-20])], scale: [] } } }],
  } as unknown as Project;
}

/** Re-hung donor: "fore" hangs from root here (from "arm" on the stage), one "flap" clip. */
function rehung(): Project {
  return {
    format: 'rigsmith.project', version: 1, name: 'rehung', images: [], attachments: [],
    bones: [bone('r-root', 'root', null, 0, 0, 0, 30), bone('r-fore', 'fore', 'r-root', 0, 0, 0, 60)],
    animations: [{ id: 'r-flap', name: 'flap', duration: 1, fps: 10, loop: false, tracks: { 'r-fore': { translate: [], rotate: [k(0, [0]), k(0.5, [30])], scale: [] } } }],
  } as unknown as Project;
}

const DONOR = path.join(OUT, 'donor.rig.json');
const REHUNG = path.join(OUT, 'rehung.rig.json');
const STAGE = path.join(OUT, 'stage.rig.json');
const FUTURE = path.join(OUT, 'future-field.rig.json');
writeFileSync(DONOR, serializeProject(donor()));
writeFileSync(REHUNG, serializeProject(rehung()));
writeFileSync(STAGE, serializeProject(stage()));
writeFileSync(FUTURE, JSON.stringify({ ...JSON.parse(serializeProject(stage())), name: 'future', timelines: [{ id: 't' }] }, null, 1));

const project = () => probe<any>(page, 'project');
const undoDepth = async () => (await probe<any>(page, 'state')).undo;
const status = () => page.getByTestId('status').innerText();
const armAngle = async () => (await probe<any>(page, 'bone', 'arm')).world.angle as number;

async function open(file: string, name: string): Promise<void> {
  await page.getByTestId('open-input').setInputFiles(file);
  await page.waitForFunction((n) => (window as any).__rigsmith.project().name === n, name);
}

async function gotoFrame(frame: number, frames: number): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
  await page.waitForFunction((f) => Math.round((window as any).__rigsmith.state().time * 10) === f, frame);
}

async function pickDonor(file = DONOR): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('import-anims').click()]);
  await chooser.setFiles(file);
  await page.getByTestId('import-dialog').waitFor({ state: 'visible' });
}

before(async () => {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-review-corrections');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  base = `http://127.0.0.1:${port}/`;
  await page.goto(base);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('LP-001 / LP-002: Import anims… on an IK rig', () => {
  it('the report warns that the IK overrides the imported keys; imported as is, the arm does not move', async () => {
    await open(STAGE, 'stage');
    await pickDonor();
    const hint = await page.getByTestId('import-dialog').innerText();
    assert.ok(!/plays the same local motion/.test(hint), 'old retargeting claim removed');
    assert.match(hint, /jumps to the source values at its first key/);
    assert.equal(await page.getByTestId('imp-offset-setup').isChecked(), false, 'offset is opt-in');
    assert.equal(await page.getByTestId('imp-mute-arm-ik').isChecked(), false, 'muting is opt-in');
    assert.equal((await page.getByTestId('imp-driven').innerText()).replace(/\n+/g, '\n'), 'IK “arm-ik” (mix 1) overrides 3 imported key(s) on arm (2), fore (1): those keys will have no visible effect here.\nKey “arm-ik” to mix 0 in the imported copy');
    await page.screenshot({ path: path.join(OUT, 'import-driven-warning.png') });
    const u0 = await undoDepth();
    await page.getByTestId('imp-apply').click();
    await page.getByTestId('import-dialog').waitFor({ state: 'hidden' });
    assert.equal(await undoDepth(), u0 + 1);
    assert.match(await status(), /^Imported from “donor”: 1 animation\(s\), 3 key\(s\) · 3 key\(s\) overridden by arm-ik\./);
    const reach = (await project()).animations.find((a: any) => a.name === 'reach');
    assert.deepEqual(reach.tracks['s-arm'].rotate.map((x: any) => x.value[0]), [-90, -30], 'absolute values copied unchanged');
    assert.equal(reach.constraints, undefined);
    await page.getByTestId('mode-animate').click();
    await gotoFrame(0, 10);
    const a0 = await armAngle();
    await gotoFrame(5, 10);
    assert.ok(Math.abs((await armAngle()) - a0) < 1e-6, 'the IK holds the arm: the −90 → −30 keys have no effect');
    await page.getByTestId('undo').click();
    assert.ok(!(await project()).animations.some((a: any) => a.name === 'reach'), 'undo removes the import');
  });

  it('with “Offset by the setup difference” and “Key arm-ik to mix 0”, the keys play around the target setup', async () => {
    await pickDonor();
    await page.getByTestId('imp-offset-setup').check();
    await page.getByTestId('imp-mute-arm-ik').check();
    assert.match(await page.getByTestId('imp-driven').innerText(), /^IK “arm-ik” is keyed to mix 0 in the imported animation\(s\), so its 3 key\(s\) on arm \(2\), fore \(1\) play; the constraint stops solving there\./);
    assert.match(await page.getByTestId('imp-report').innerText(), /Will import: reach — 3 key\(s\)\./);
    await page.screenshot({ path: path.join(OUT, 'import-options-on.png') });
    await page.getByTestId('imp-apply').click();
    await page.getByTestId('import-dialog').waitFor({ state: 'hidden' });
    assert.match(await status(), /^Imported from “donor”: 1 animation\(s\), 3 key\(s\) · mix keyed to 0: arm-ik\./);
    const p = await project();
    const reach = p.animations.find((a: any) => a.name === 'reach');
    assert.deepEqual(reach.tracks['s-arm'].rotate.map((x: any) => x.value[0]), [-60, 0], '−90 → −60 (setup −60): moves by the same 60°');
    assert.deepEqual(reach.constraints, { 's-ik': { mix: [{ time: 0, value: [0], interp: 'step' }] } });
    assert.equal(p.ik[0].mix, 1, 'the setup IK is unchanged');
    await gotoFrame(0, 10);
    const a0 = await armAngle();
    await gotoFrame(5, 10);
    assert.ok(Math.abs((await armAngle()) - a0 - 60) < 1e-6, `the arm turns by the keyed 60° (${(await armAngle()) - a0})`);
    assert.deepEqual(pageErrors, []);
  });

  it('a mapped bone whose parent differs is named as a rig difference', async () => {
    await pickDonor(REHUNG);
    assert.equal(await page.getByTestId('imp-rig').innerText(), 'Rig difference: “fore”: its parent here is “arm”, in the source “root”.');
    await page.getByTestId('imp-cancel').click();
    await page.getByTestId('import-dialog').waitFor({ state: 'hidden' });
    assert.ok(!(await project()).animations.some((a: any) => a.name === 'flap'), 'cancel imports nothing');
  });
});

describe('paste report: retarget and constraint-driven keys', () => {
  it('a one-bone clip pasted with another bone selected says where it went and that the IK overrides it', async () => {
    await page.getByTestId('anim-select').selectOption({ label: 'pose' });
    await page.getByTestId('key-arm-rotate-5').click();
    await page.getByTestId('copy-keys').click();
    await page.getByTestId('tree-bone-fore').click();
    await gotoFrame(8, 10);
    await page.getByTestId('paste-keys').click();
    assert.equal(await status(), 'Pasted 1 key(s) at frame 8 onto the selected bone “fore” (copied from “arm”). 1 pasted key(s) are overridden by “arm-ik” (constraint mix > 0) and have no visible effect.');
    const pose = (await project()).animations.find((a: any) => a.name === 'pose');
    assert.deepEqual(pose.tracks['s-fore'].rotate.map((x: any) => [Math.round(x.time * 10), x.value[0]]), [[8, -20]]);
    await page.getByTestId('undo').click();
  });
});

describe('LP-006 / LP-007: Sequences… stays in step with undo/redo', () => {
  it('Ctrl+Z with focus on Close shrinks the list, no error; redo restores; undoing the sequence itself shows the empty state', async () => {
    await page.getByTestId('sequences-open').click();
    await page.getByTestId('sequence-dialog').waitFor({ state: 'visible' });
    await page.getByTestId('seqd-new').click();
    assert.match(await page.getByTestId('sequence-dialog').innerText(), /sequences do not offer “hold”/, 'LP-007 policy stated');
    await page.getByTestId('seqd-add-step').click();
    assert.equal(await page.getByTestId('seqd-steps').locator('li.seq-step').count(), 2);
    const toasts = await page.getByTestId('error-toast').count();
    await page.getByTestId('seqd-close').focus();
    await page.keyboard.press('Control+z');
    assert.equal(await page.getByTestId('seqd-steps').locator('li.seq-step').count(), 1, 'the list follows the undo');
    assert.equal(await page.getByTestId('seqd-step-1').count(), 0);
    // The remaining row is live: editing it is one clean edit, no "Action failed".
    const u = await undoDepth();
    await page.getByTestId('seqd-step-repeat-0').fill('3');
    await page.getByTestId('seqd-step-repeat-0').press('Enter');
    assert.equal(await undoDepth(), u + 1);
    assert.equal((await project()).sequences[0].steps[0].repeat, 3);
    await page.getByTestId('seqd-close').focus();
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+Shift+z');
    await page.keyboard.press('Control+z');
    assert.equal(await page.getByTestId('seqd-step-repeat-0').inputValue(), '1');
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await page.getByTestId('seqd-steps').locator('li.seq-step').count(), 1);
    // Undo past "New sequence": the dialog drops to the empty state instead of a stale view.
    await page.getByTestId('seqd-close').focus();
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.getByTestId('seqd-empty').waitFor();
    assert.equal((await project()).sequences, undefined);
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await page.getByTestId('seqd-name').inputValue(), 'sequence', 'redo brings it back into view');
    assert.equal(await page.getByTestId('error-toast').count(), toasts, 'no error toast');
    await page.getByTestId('seqd-close').click();
    assert.deepEqual(pageErrors, []);
  });
});

describe('LP-009: Open reports a field this version does not know', () => {
  it('the status names the ignored field', async () => {
    await open(FUTURE, 'future');
    assert.match(await status(), /Unknown top-level field\(s\) ignored — they will not be saved again: "timelines"\./);
  });
});

describe('LP-011: the flat-art guide on a layered project (the demo)', () => {
  it('names no attachment; Create root bone, Mesh and Create idle are disabled with the reason', async () => {
    await page.getByTestId('load-demo').click();
    await page.waitForFunction(() => (window as any).__rigsmith.project().images.length > 1);
    await page.getByTestId('guide-open').click();
    await page.getByTestId('guide-dialog').waitFor({ state: 'visible' });
    const n = (await project()).images.filter((i: any) => !i.derived).length;
    assert.equal(await page.getByTestId('guide-scope').innerText(), `This guide is for one flat PNG of the whole character; this project has ${n} original images, so the guide does not act on it.`);
    for (const id of ['guide-rig', 'guide-mesh', 'guide-idle']) {
      assert.equal(await page.getByTestId(id).isDisabled(), true, id);
      assert.match((await page.getByTestId(id).getAttribute('title'))!, /one flat PNG/, id);
    }
    assert.match(await page.getByTestId('guide-step-rig').innerText(), /original images/);
    assert.ok(!/Wiz/.test(await page.getByTestId('guide-dialog').innerText()), 'LP-012: no private test vocabulary');
    await page.getByTestId('guide-dialog').screenshot({ path: path.join(OUT, 'guide-on-demo.png') });
    await page.getByTestId('guide-close').click();
    assert.deepEqual(pageErrors, []);
  });
});

describe('LP-010: legacy localStorage copies are never removed unless nothing is lost', () => {
  let p2: Page;
  const textA = serializeProject({ ...stage(), name: 'copy-a' });
  const textB = serializeProject({ ...stage(), name: 'copy-b' });

  /** Seeds both stores exactly (storage seeding, like the RV-007 migration test). */
  async function seed(idb: Record<string, unknown>, ls: Record<string, string>): Promise<void> {
    await p2.evaluate(async ([idbRecords, lsRecords]) => {
      localStorage.clear();
      for (const [k2, v] of Object.entries(lsRecords)) localStorage.setItem(k2, v);
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('rigsmith', 1);
        req.onupgradeneeded = () => void req.result.createObjectStore('kv');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const t = db.transaction('kv', 'readwrite');
          const s = t.objectStore('kv');
          s.delete('autosave');
          s.delete('browser-save');
          for (const [k2, v] of Object.entries(idbRecords)) s.put(v, k2);
          t.oncomplete = () => (db.close(), resolve());
          t.onerror = () => (db.close(), reject(t.error));
        };
      });
    }, [idb, ls] as const);
  }
  const legacyAuto = () => p2.evaluate(() => localStorage.getItem('rigsmith:autosave:v1'));

  before(async () => {
    p2 = await ctx.newPage();
    p2.on('pageerror', (e) => pageErrors.push(e.message));
    await p2.goto(base);
    await p2.getByTestId('empty-stage').waitFor({ state: 'visible' });
  });

  it('a newer legacy autosave replaces an older IndexedDB one; the banner offers the newer', async () => {
    await seed({ autosave: { savedAt: '2026-10-01T10:00:00.000Z', name: 'idb-older', project: textA } }, { 'rigsmith:autosave:v1': JSON.stringify({ savedAt: '2026-10-05T10:00:00.000Z', name: 'legacy-newer', project: textB }) });
    await p2.reload();
    await p2.getByTestId('recovery-banner').waitFor();
    assert.match(await p2.getByTestId('recovery-banner').innerText(), /“legacy-newer”/);
    assert.equal((await waitUntil(() => readIdb(p2, 'autosave'), (v) => v?.name === 'legacy-newer', 5000, 'migrated newer copy')).project, textB);
    assert.equal(await legacyAuto(), null, 'removed after it was written');
  });

  it('an older legacy autosave is removed and the newer IndexedDB copy is kept', async () => {
    await seed({ autosave: { savedAt: '2026-10-05T10:00:00.000Z', name: 'idb-newer', project: textA } }, { 'rigsmith:autosave:v1': JSON.stringify({ savedAt: '2026-10-01T10:00:00.000Z', name: 'legacy-older', project: textB }) });
    await p2.reload();
    await p2.getByTestId('recovery-banner').waitFor();
    assert.match(await p2.getByTestId('recovery-banner').innerText(), /“idb-newer”/);
    await waitUntil(legacyAuto, (v) => v === null, 5000, 'older legacy copy removed');
    assert.equal((await readIdb(p2, 'autosave')).name, 'idb-newer');
  });

  it('a differing legacy “Save to browser” copy (no timestamp) is kept in localStorage, the IndexedDB one untouched', async () => {
    await seed({ 'browser-save': { savedAt: '2026-10-05T10:00:00.000Z', name: 'copy-a', project: textA } }, { 'rigsmith:project:v1': textB });
    await p2.reload();
    await p2.getByTestId('open-input').waitFor({ state: 'attached' });
    await p2.waitForFunction(() => /Ready|Open|Demo|empty/i.test(document.body.innerText));
    assert.equal(await p2.evaluate(() => localStorage.getItem('rigsmith:project:v1')), textB, 'not deleted');
    assert.equal((await readIdb(p2, 'browser-save')).project, textA);
    // Same text in both: the legacy copy is redundant and goes.
    await seed({ 'browser-save': { savedAt: '2026-10-05T10:00:00.000Z', name: 'copy-a', project: textA } }, { 'rigsmith:project:v1': textA });
    await p2.reload();
    await waitUntil(() => p2.evaluate(() => localStorage.getItem('rigsmith:project:v1')), (v) => v === null, 5000, 'identical legacy copy removed');
    await p2.close();
    assert.deepEqual(pageErrors, []);
  });
});
