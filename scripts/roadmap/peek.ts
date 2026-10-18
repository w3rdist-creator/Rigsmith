// Ad-hoc screenshot helper for visual review during development (not a test).
// Usage: node scripts/roadmap/peek.ts <out.png> [p1|p2]
import path from 'node:path';
import type { Page } from 'playwright-core';
import { EVIDENCE, launchIsolated, pickPort, probe, startPreview } from '../../tests/e2e/harness.ts';

const out = process.argv[2] ?? path.join(EVIDENCE, 'roadmap/peek.png');
const scenario = process.argv[3] ?? 'p1';
const port = await pickPort([47621, 47622, 47623]);
const server = await startPreview(port);
const ctx = await launchIsolated('peek');
const shot = (page: Page, suffix: string) => page.screenshot({ path: out.replace('.png', `${suffix}.png`) });

async function p1(page: Page): Promise<void> {
  await page.getByTestId('play').click();
  await page.getByTestId('tree-bone-thigh-front').click();
  await page.getByTestId('key-thigh-front-rotate-0').click();
  await page.getByTestId('curve-preset').selectOption('overshoot');
  await page.getByTestId('onion-toggle').check();
  await page.getByTestId('next-frame').click();
  await shot(page, '');
  await page.getByTestId('export-sequence').click();
  await page.waitForTimeout(300);
  await shot(page, '-export');
}

async function p2(page: Page): Promise<void> {
  await page.getByTestId('play').click();
  await page.getByTestId('tree-bone-forearm-front').click();
  await page.getByTestId('ik-add-2').click();
  const t = await probe<{ origin: { x: number; y: number } }>(page, 'bone', 'forearm-front-target');
  await page.mouse.move(t.origin.x, t.origin.y);
  await page.mouse.down();
  await page.mouse.move(t.origin.x + 30, t.origin.y - 60, { steps: 5 });
  await page.mouse.up();
  await shot(page, '-ik');
  await page.getByTestId('add-path').click();
  await shot(page, '-path');
  await page.getByTestId('tree-att-head').click();
  await shot(page, '-slot');
}

try {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('empty-demo').click();
  await page.waitForTimeout(300);
  await (scenario === 'p2' ? p2(page) : p1(page));
} finally {
  await ctx.close();
  server.kill();
}
