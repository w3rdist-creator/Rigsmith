// Screenshot tour (not an assertion suite): `node tests/e2e/tour.ts` writes
// .hermes/evidence/screens/*.png of the main editor states for visual review.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { EVIDENCE, launchIsolated, pickPort, startPreview } from './harness.ts';

const port = await pickPort([47621, 47622, 47623]);
const server = await startPreview(port);
const ctx = await launchIsolated('tour');
const out = path.join(EVIDENCE, 'screens');
mkdirSync(out, { recursive: true });
try {
  const page = await ctx.newPage();
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.screenshot({ path: path.join(out, '01-empty.png') });
  await page.getByTestId('empty-demo').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, '02-demo-playing.png') });
  await page.keyboard.press('Space');
  await page.getByTestId('tree-bone-forearm-front').click();
  await page.screenshot({ path: path.join(out, '03-demo-paused-selected.png') });
  await page.keyboard.press('Tab');
  await page.screenshot({ path: path.join(out, '04-setup-mode.png') });
  await page.getByTestId('help').click();
  await page.screenshot({ path: path.join(out, '05-help.png') });
  console.log(logs.join('\n') || '(no console output)');
} finally {
  await ctx.close();
  server.kill();
}
