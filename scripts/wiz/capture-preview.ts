// Captures the Wiz animations FROM RIGSMITH'S OWN CANVAS. A fresh isolated profile
// (.hermes/browser-profiles/wiz-capture) opens the saved project through the Open file
// input, hides bones with the visible "Bones" checkbox, then for every frame 0..N-1 of
// each animation clicks the timeline ruler (exact frame) and reads the stage canvas with
// toDataURL (read-only). Frame N is skipped because it equals frame 0 in a loop.
// Output: .hermes/assets/wiz/output/frames/<anim>/f###.png and frames/<anim>/pose.json
// (per-frame world transforms read from the probe). Encode with make_media.py.
// Usage: npm run build && node scripts/wiz/capture-preview.ts
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchIsolated, pickPort, probe, startPreview } from '../../tests/e2e/harness.ts';
import { OUTPUT, PROJECT_FILE } from './paths.ts';
import { ANIMS } from './rig-spec.ts';

const BONES = ['root', 'body', 'leg_l', 'leg_r', 'arm_l', 'hand_l', 'arm_r', 'hand_r'];

async function main(): Promise<void> {
  const port = await pickPort([47614, 47615, 47616, 47617]);
  const server = await startPreview(port);
  const ctx = await launchIsolated('wiz-capture', [], { viewport: { width: 1500, height: 1300 }, deviceScaleFactor: 2 });
  const errors: string[] = [];
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByTestId('empty-stage').waitFor({ state: 'visible' });
    await page.getByTestId('open-input').setInputFiles(PROJECT_FILE);
    await page.waitForFunction(() => (window as any).__rigsmith.project().bones.length === 8);
    await page.getByTestId('show-bones').uncheck();
    await page.getByTestId('frame-all').click();
    // Leave room for the hop and the raised arm: zoom out one notch around the stage centre.
    const stage = (await page.getByTestId('stage').boundingBox())!;
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height * 0.45);
    await page.mouse.wheel(0, 60);
    // Park the pointer over empty canvas so no hover outline is drawn on an attachment.
    await page.mouse.move(stage.x + 6, stage.y + 6);

    for (const anim of ANIMS) {
      await page.getByTestId('anim-select').selectOption({ label: anim.name });
      const frames = Math.round(anim.duration * anim.fps);
      const dir = path.join(OUTPUT, 'frames', anim.name);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const poses: Record<string, unknown>[] = [];
      const ruler = page.getByTestId('timeline-ruler');
      for (let f = 0; f < frames; f++) {
        const box = (await ruler.boundingBox())!;
        await ruler.click({ position: { x: (box.width * f) / frames, y: box.height / 2 } });
        const s = await probe<{ time: number; mode: string; animName: string }>(page, 'state');
        assert.equal(s.animName, anim.name);
        assert.ok(Math.abs(s.time - f / anim.fps) < 1e-6, `frame ${f}`);
        const png = await page.evaluate(async () => {
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          return (document.getElementById('stage-canvas') as HTMLCanvasElement).toDataURL('image/png');
        });
        writeFileSync(path.join(dir, `f${String(f).padStart(3, '0')}.png`), Buffer.from(png.split(',')[1], 'base64'));
        const pose: Record<string, unknown> = { frame: f, time: s.time };
        for (const b of BONES) pose[b] = (await probe<any>(page, 'bone', b)).world;
        poses.push(pose);
      }
      writeFileSync(path.join(dir, 'pose.json'), JSON.stringify(poses, null, 1));
      console.log(`${anim.name}: captured ${frames} frames from the editor canvas → ${dir}`);
    }
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await ctx.close();
    server.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
