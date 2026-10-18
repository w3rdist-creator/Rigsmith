// scripts/roadmap/run-gates.sh must propagate gate failures: its exit status is non-zero
// when any gate fails (it used to end with an `echo`, which always exited 0). The gates
// themselves are replaced by PATH shims so this runs in milliseconds and never builds.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/roadmap/run-gates.sh');

function runWithShims(failing: 'none' | 'npm' | 'python3'): { status: number | null; out: string; summary: string } {
  mkdirSync(path.join(ROOT, '.hermes/evidence'), { recursive: true });
  const dir = mkdtempSync(path.join(ROOT, '.hermes/evidence/tmp-gates-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    for (const tool of ['npm', 'node', 'python3']) {
      const code = tool === failing ? 1 : 0;
      writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "shim ${tool} $*"\necho "ℹ fail ${code}"\nexit ${code}\n`);
      chmodSync(path.join(bin, tool), 0o755);
    }
    const out = path.join(dir, 'out');
    const r = spawnSync('sh', [SCRIPT, out], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` } });
    return { status: r.status, out: r.stdout + r.stderr, summary: readFileSync(path.join(out, 'summary.txt'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('run-gates.sh exits 0 when every gate passes and writes to an absolute output dir', () => {
  const r = runWithShims('none');
  assert.equal(r.status, 0, r.out);
  assert.match(r.summary, /^unit exit=0/m);
  assert.match(r.out, /ALL GATES PASSED/);
});

test('run-gates.sh exits non-zero when an npm gate fails', () => {
  const r = runWithShims('npm');
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.summary, /^unit exit=1/m);
  assert.match(r.summary, /^wiz exit=1/m);
  assert.match(r.out, /GATES FAILED: .*unit/);
});

test('run-gates.sh exits non-zero when only the preservation check fails', () => {
  const r = runWithShims('python3');
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.summary, /^preservation exit=1/m);
  assert.match(r.summary, /^unit exit=0/m);
});
