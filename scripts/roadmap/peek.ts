// Ad-hoc screenshot helper for visual review during development (not a test).
// Usage: node scripts/roadmap/peek.ts <out.png> [demo]
import path from 'node:path';
import { EVIDENCE, launchIsolated, pickPort, startPreview } from '../../tests/e2e/harness.ts';

const out = process.argv[2] ?? path.join(EVIDENCE, 'roadmap/peek.png');
const port = await pickPort([47621, 47622, 47623]);
const server = await startPreview(port);
const ctx = await launchIsolated('peek');
try {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('empty-demo').click();
  await page.waitForTimeout(300);
  await page.getByTestId('play').click();
  await page.getByTestId('tree-bone-thigh-front').click();
  await page.getByTestId('key-thigh-front-rotate-0').click();
  await page.getByTestId('curve-preset').selectOption('overshoot');
  await page.getByTestId('onion-toggle').check();
  await page.getByTestId('next-frame').click();
  await page.screenshot({ path: out });
  await page.getByTestId('export-sequence').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: out.replace('.png', '-export.png') });
} finally {
  await ctx.close();
  server.kill();
}
