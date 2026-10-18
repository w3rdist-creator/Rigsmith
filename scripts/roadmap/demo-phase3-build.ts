// Phase-3 bendy-limb / secondary-motion demo, built only through visible controls:
// one continuous "rubber-hose" arm image is meshed (Fill grid) and auto-weighted to a
// shoulder → elbow chain so it bends without a joint seam; a tapered tail is meshed over
// a three-bone chain with delayed rotations (follow-through) and a deform-key flick drawn
// with the vertex tool. Shared by `npm run demo:phase3` and tests/e2e/p3-demo.e2e.test.ts.
import type { Page } from 'playwright-core';
import { probe } from '../../tests/e2e/harness.ts';

type Pt = { x: number; y: number };
export const DEMO_FRAMES = 60;

async function setField(page: Page, testId: string, v: string | number): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(String(v));
  await el.press('Enter');
}

export async function gotoFrame(page: Page, frame: number, frames = DEMO_FRAMES): Promise<void> {
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  await ruler.click({ position: { x: Math.min(box.width - 0.5, (box.width * frame) / frames), y: box.height / 2 } });
}

async function drag(page: Page, from: Pt, to: Pt): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

async function bone(page: Page, name: string, f: { x?: number; y?: number; rotation?: number; length?: number }): Promise<void> {
  await page.getByTestId('add-bone').click();
  await setField(page, 'bone-name', name);
  if (f.x !== undefined) await setField(page, 'bone-x', f.x);
  if (f.y !== undefined) await setField(page, 'bone-y', f.y);
  if (f.rotation !== undefined) await setField(page, 'bone-rotation', f.rotation);
  if (f.length !== undefined) await setField(page, 'bone-length', f.length);
}

async function gridMesh(page: Page, att: string, cols: number, rows: number): Promise<string> {
  await page.getByTestId(`tree-att-${att}`).click();
  await page.getByTestId('mesh-create').click();
  await setField(page, 'mesh-grid-cols', cols);
  await setField(page, 'mesh-grid-rows', rows);
  await page.getByTestId('mesh-grid').click();
  await page.getByTestId('mesh-apply').click();
  await page.getByTestId('mesh-dialog').waitFor({ state: 'hidden' });
  await page.getByTestId('weights-auto').click();
  return page.getByTestId('mesh-summary').innerText();
}

/** Builds the demo rig + 2 s loop in an empty editor page; returns a step log. */
export async function buildBendyDemo(page: Page, art: Record<string, string>): Promise<string[]> {
  const log: string[] = [];
  await page.getByTestId('image-input').setInputFiles([art['body.png'], art['hose-arm.png'], art['tail.png']]);
  await page.getByTestId('image-tail.png').waitFor();
  await bone(page, 'body', { rotation: 0, length: 30 });
  await page.getByTestId('attach-body.png').click();
  await setField(page, 'att-x', 0);
  await page.getByTestId('tree-bone-body').click();
  await bone(page, 'shoulder', { x: 18, y: -26, rotation: -15, length: 72 });
  await bone(page, 'elbow', { length: 72 });
  await page.getByTestId('tree-bone-shoulder').click();
  await page.getByTestId('attach-hose-arm.png').click();
  await setField(page, 'att-x', 96);
  await page.getByTestId('tree-bone-body').click();
  await bone(page, 'tail1', { x: -26, y: 38, rotation: 150, length: 52 });
  await bone(page, 'tail2', { length: 52 });
  await bone(page, 'tail3', { length: 52 });
  await page.getByTestId('tree-bone-tail1').click();
  await page.getByTestId('attach-tail.png').click();
  await setField(page, 'att-x', 76);
  // Tail behind the body.
  for (let i = 0; i < 2; i++) await page.getByTestId('att-backward').click();
  log.push('rig: body, shoulder → elbow, tail1 → tail2 → tail3; images body / hose-arm (on shoulder) / tail (on tail1, behind the body)');
  log.push(`arm mesh: ${await gridMesh(page, 'hose-arm', 12, 2)} (Fill grid 12×2 + Auto weights)`);
  log.push(`tail mesh: ${await gridMesh(page, 'tail', 9, 2)} (Fill grid 9×2 + Auto weights)`);
  await page.getByTestId('frame-all').click();

  await page.getByTestId('new-animation').click();
  await setField(page, 'anim-name', 'wave');
  await setField(page, 'anim-duration', 2);
  const keys: [string, [number, number][]][] = [
    ['shoulder', [[0, -15], [30, 15]]],
    ['elbow', [[0, 0], [15, -80], [30, -10], [45, -80]]],
    // Follow-through: each tail bone repeats the swing 5 frames after its parent.
    ['tail1', [[0, 150], [20, 135], [40, 165]]],
    ['tail2', [[5, 15], [25, -20], [45, 20]]],
    ['tail3', [[10, 20], [30, -25], [50, 25]]],
  ];
  for (const [name, ks] of keys) {
    await page.getByTestId(`tree-bone-${name}`).click();
    for (const [f, deg] of ks) {
      await gotoFrame(page, f);
      await setField(page, 'bone-rotation', deg);
      // Typing the value already shown commits nothing: key it with the rotate toggle.
      const p = await probe<any>(page, 'project');
      const id = p.bones.find((b: any) => b.name === name).id;
      const rot = p.animations[0].tracks[id]?.rotate ?? [];
      if (!rot.some((k: any) => Math.round(k.time * 30) === f)) await page.getByTestId('key-toggle-rotate').click();
    }
  }
  log.push(`bone keys: ${keys.map(([n, ks]) => `${n} ${ks.map(([f, d]) => `f${f}:${d}°`).join(' ')}`).join('; ')}`);

  // Secondary motion on the tail tip: deform keys drawn with the vertex tool.
  await page.getByTestId('tree-att-tail').click();
  await gotoFrame(page, 0);
  await page.getByTestId('deform-reset').click();
  await gotoFrame(page, 33);
  await page.getByTestId('mesh-tool-vertices').click();
  const v = (await probe<Pt[]>(page, 'mesh', 'tail'))!;
  // Hull order (gridPoints 9×2): 0–8 top edge, 9–10 right edge (10 = tip middle).
  await drag(page, v[10], { x: v[10].x + 14, y: v[10].y - 12 });
  await drag(page, v[8], { x: v[8].x + 8, y: v[8].y - 10 });
  await page.keyboard.press('Escape');
  log.push('deform: tail tip flicked at f33 by dragging two vertices (Deform vertices), rest pose keyed at f0');

  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  await page.getByTestId('curve-preset').selectOption('smooth');
  await page.getByTestId('loop-seam').click();
  log.push(`eased all keys and closed the loop: ${await page.getByTestId('status').innerText()}`);
  return log;
}
