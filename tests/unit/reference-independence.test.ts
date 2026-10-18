// The independent reference renderer (tests/support/reference-*.ts) must not share code
// with the product: following every import transitively, nothing may resolve under src/
// and only node: built-ins may be used (post-review FR-003). A planted import proves the
// check can fail.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SUPPORT = path.join(ROOT, 'tests/support');

/** Every module specifier of a source text: static/type imports, re-exports, import(). */
export function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const re of [/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g])
    for (const m of text.matchAll(re)) out.push(m[1]);
  return out;
}

/** Transitive closure from `entry`; returns the offending edges. */
function violations(entry: string, read: (f: string) => string): string[] {
  const bad: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of specifiers(read(file))) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) {
        bad.push(`${path.relative(ROOT, file)} → ${spec} (package)`);
        continue;
      }
      const target = path.resolve(path.dirname(file), spec);
      if (!path.relative(path.join(ROOT, 'src'), target).startsWith('..')) bad.push(`${path.relative(ROOT, file)} → ${path.relative(ROOT, target)} (src/)`);
      else visit(target);
    }
  };
  visit(entry);
  return bad;
}

const disk = (f: string) => readFileSync(f, 'utf8');

describe('reference renderer independence (FR-003)', () => {
  const entries = readdirSync(SUPPORT).filter((f) => /^reference-.*\.ts$/.test(f)).map((f) => path.join(SUPPORT, f));

  test('the reference modules exist', () => {
    assert.deepEqual(entries.map((f) => path.basename(f)).sort(), ['reference-composite.ts', 'reference-constraints.ts']);
  });

  test('nothing reachable from tests/support/reference-*.ts imports src/ or a package', () => {
    for (const e of entries) assert.deepEqual(violations(e, disk), [], path.basename(e));
  });

  test('the check catches a direct and a transitive src/ import', () => {
    const planted = (target: string, line: string) => (f: string) => (f === target ? `${line}\n${disk(f)}` : disk(f));
    const composite = path.join(SUPPORT, 'reference-composite.ts');
    const constraints = path.join(SUPPORT, 'reference-constraints.ts');
    assert.match(violations(constraints, planted(constraints, "import { solveIk } from '../../src/model/constraints.ts';")).join('\n'), /src\/model\/constraints\.ts \(src\/\)/);
    assert.match(violations(constraints, planted(composite, "import type { Project } from '../../src/model/types.ts';")).join('\n'), /reference-composite\.ts → src\/model\/types\.ts/);
    assert.match(violations(constraints, planted(path.join(SUPPORT, 'png-decode.ts'), "const m = await import('../../src/model/png.ts');")).join('\n'), /png-decode\.ts → src\/model\/png\.ts/);
    assert.match(violations(constraints, planted(constraints, "import x from 'playwright-core';")).join('\n'), /playwright-core \(package\)/);
  });
});
