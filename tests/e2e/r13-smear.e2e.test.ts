// R13 browser checks: Smear fast frames from the visible control (timeline ≋ button) on a
// bar that whips 270° in six frames — it asks for an attachment first, then adds one smear
// image per fast frame and keys the swaps (the clip's image back on the next slow frame),
// with a viewport screenshot mid-whip; undo removes the keys and the images.
// window.__rigsmith is read-only (assertions).
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { setKey } from '../../src/model/animation.ts';
import { serializeProject } from '../../src/model/format.ts';
import { makeBone } from '../../src/model/ops.ts';
import type { Project } from '../../src/model/types.ts';
import { emptyProject, emptyTrack } from '../../src/model/types.ts';
import { encodePng } from '../support/png-encode.ts';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from './harness.ts';

const OUT = path.join(EVIDENCE, 'roadmap/r13-smear');
mkdirSync(OUT, { recursive: true });

// Original procedural art: a striped bar on an arm that idles, then whips 270° (45°/frame).
function rig(): Project {
  const p = emptyProject('whip');
  p.bones.push(makeBone('root', 'root', null, 0, 0, 0, 20), makeBone('arm', 'arm', 'root', 0, 0, 0, 60));
  const w = 80, h = 14, px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(Math.floor(x / 10) % 2 ? [230, 90, 40, 255] : [250, 210, 60, 255], (y * w + x) * 4);
  p.images.push({ id: 'i_bar', name: 'bar.png', mime: 'image/png', width: w, height: h, dataUrl: `data:image/png;base64,${encodePng(w, h, px).toString('base64')}` });
  p.attachments.push({ id: 'a_bar', name: 'bar', boneId: 'arm', imageId: 'i_bar', x: 50, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
  const twirl = { id: 'twirl', name: 'twirl', duration: 1, fps: 30, loop: false, tracks: { arm: emptyTrack() } };
  for (const [f, r] of [[0, 0], [10, 10], [16, 280], [30, 280]]) setKey(twirl.tracks.arm.rotate, f / 30, [r], 'linear');
  p.animations.push(twirl);
  return p;
}
const RIG = path.join(OUT, 'whip.rig.json');
writeFileSync(RIG, serializeProject(rig()));

let server: ChildProcess;
let ctx: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const project = () => probe<any>(page, 'project');
const status = async () => (await page.getByTestId('status').textContent()) ?? '';

async function gotoFrame(frame: number, frames = 30): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
}

before(async () => {
  const port = await pickPort([47658, 47659, 47660]);
  server = await startPreview(port);
  ctx = await launchIsolated('e2e-r13-smear');
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
  await page.getByTestId('open-input').setInputFiles(RIG);
  await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length > 0);
});

after(async () => {
  await ctx?.close();
  server?.kill();
});

describe('smears (R13)', () => {
  it('Smear fast frames: asks for an attachment, keys a smear per fast frame, undo removes it all', async () => {
    if ((await probe<any>(page, 'state')).mode !== 'animate') await page.getByTestId('mode-animate').click();
    const imagesBefore = (await project()).images.length;
    await page.getByTestId('tree-bone-root').click();
    await page.getByTestId('anim-smear').click();
    assert.match(await status(), /Select the attachment to smear/);
    assert.equal((await project()).animations[0].slots, undefined, 'nothing keyed without an attachment');

    await page.getByTestId('tree-att-bar').click();
    await page.getByTestId('anim-smear').click();
    await page.waitForFunction(() => /Smeared/.test(document.querySelector('[data-testid=status]')?.textContent ?? ''));
    const p = await project();
    const keys = p.animations[0].slots.a_bar.image.map((k: any) => [Math.round(k.time * 30), k.imageId]);
    assert.deepEqual(keys, [...[11, 12, 13, 14, 15, 16].map((f) => [f, `i_bar~smear~a_bar~twirl~${f}`]), [17, 'i_bar']]);
    assert.equal(p.images.length, imagesBefore + 6);
    const im = p.images.find((x: any) => x.id === 'i_bar~smear~a_bar~twirl~13');
    assert.ok(im.width > 80 && (im.width - 80) % 2 === 0, `padded about the centre: ${im.width}×${im.height}`);
    await gotoFrame(13);
    await page.getByTestId('frame-all').click();
    await page.screenshot({ path: path.join(OUT, 'whip-f13-smeared.png') });

    await page.getByTestId('undo').click();
    const q = await project();
    assert.equal(q.animations[0].slots?.a_bar?.image, undefined, 'undo removes the swap keys');
    assert.equal(q.images.length, imagesBefore, 'and the smear images');
    assert.deepEqual(pageErrors, []);
  });
});
