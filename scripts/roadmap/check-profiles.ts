// Browser profiles belong only in .hermes/browser-profiles/ (tests/e2e/harness.ts
// launchIsolated, scripts/lib/rigsmith-api.ts withRenderer). Fails if any directory named
// browser-profiles exists under .hermes/evidence/ (post-review FR-006).
// Usage: node scripts/roadmap/check-profiles.ts
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const EVIDENCE = path.join(ROOT, '.hermes/evidence');

function find(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    if (name === 'browser-profiles') out.push(path.relative(ROOT, p));
    else find(p, out);
  }
}

const found: string[] = [];
if (existsSync(EVIDENCE)) find(EVIDENCE, found);
for (const f of found) console.log(`  PROFILE TREE IN EVIDENCE ${f}`);
console.log(found.length ? `${found.length} browser-profile tree(s) under .hermes/evidence/` : 'no browser-profile trees under .hermes/evidence/');
process.exitCode = found.length ? 1 : 0;
