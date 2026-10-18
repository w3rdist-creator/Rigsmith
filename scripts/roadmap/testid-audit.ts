// "Delivered = a visible control exists and a test exercises it" — audit.
// Lists every data-testid literal in src/ui, src/main.ts and index.html, and fails if a
// static id is never referenced by any file under tests/. Templated ids
// (`tree-bone-${name}`) are checked by their static prefix. Exceptions need a reason
// in scripts/roadmap/testid-allow.json.
// Usage: node scripts/roadmap/testid-audit.ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, ext));
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

const sources = [...files(path.join(ROOT, 'src/ui'), /\.ts$/), path.join(ROOT, 'src/main.ts'), path.join(ROOT, 'index.html')];
const ids = new Map<string, string>(); // id or prefix* -> file
for (const f of sources) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/data-testid['"]?\s*[:=]\s*(['"`])([^'"`]+)\1/g)) {
    const raw = m[2];
    const key = raw.includes('${') ? `${raw.slice(0, raw.indexOf('${'))}*` : raw;
    if (!ids.has(key)) ids.set(key, path.relative(ROOT, f));
  }
  // testIds passed through helpers: testId: 'x' / keyToggle(…, 'x', …) / checkbox(…, 'x', …)
  for (const m of text.matchAll(/testId:\s*(['`])([^'`]+)\1/g)) {
    const key = m[2].includes('${') ? `${m[2].slice(0, m[2].indexOf('${'))}*` : m[2];
    if (!ids.has(key)) ids.set(key, path.relative(ROOT, f));
  }
  // Helper calls: the first hyphenated, space-free string literal argument is the test id.
  for (const m of text.matchAll(/\b(?:keyToggle|checkbox|select|textField|num|check|keyable)\(([^\n]*)/g)) {
    const id = [...m[1].matchAll(/'([a-z][a-z0-9]*(?:-[a-z0-9]+)+)'/g)].map((x) => x[1])[0];
    if (id && !ids.has(id)) ids.set(id, path.relative(ROOT, f));
  }
}

const tests = files(path.join(ROOT, 'tests'), /\.ts$/).map((f) => readFileSync(f, 'utf8')).join('\n');
const allow = JSON.parse(readFileSync(path.join(import.meta.dirname, 'testid-allow.json'), 'utf8')) as Record<string, string>;
const missing: string[] = [];
for (const [id, file] of [...ids.entries()].sort()) {
  if (allow[id]) continue;
  const needle = id.endsWith('*') ? id.slice(0, -1) : id;
  const used = id.endsWith('*') ? tests.includes(needle) : new RegExp(`['"\`]${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(tests);
  if (!used) missing.push(`${id}  (${file})`);
}
console.log(`${ids.size} test ids in the UI; ${Object.keys(allow).length} allow-listed; ${missing.length} never referenced by tests/`);
for (const m of missing) console.log(`  MISSING ${m}`);
process.exitCode = missing.length ? 1 : 0;
