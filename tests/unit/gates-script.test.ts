// scripts/roadmap/run-gates.sh must propagate gate failures: its exit status is non-zero
// when any gate fails (it used to end with an `echo`, which always exited 0). The gates
// themselves are replaced by PATH shims so this runs in milliseconds and never builds.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EVIDENCE } from '../support/evidence.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/roadmap/run-gates.sh');

interface ShimRun { status: number | null; out: string; summary: string; logs: Record<string, string>; runId: string; staleGone: boolean }

function runWithShims(failing: 'none' | 'npm' | 'python3'): ShimRun {
  mkdirSync(EVIDENCE, { recursive: true });
  const dir = mkdtempSync(path.join(EVIDENCE, 'tmp-gates-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    for (const tool of ['npm', 'node', 'python3']) {
      const code = tool === failing ? 1 : 0;
      writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "shim ${tool} $*"\necho "env $RIGSMITH_RUN_ID $RIGSMITH_TESTID_RECORD $RIGSMITH_EVIDENCE"\necho "ℹ fail ${code}"\nexit ${code}\n`);
      chmodSync(path.join(bin, tool), 0o755);
    }
    const out = path.join(dir, 'out');
    // A recording left over from an earlier run must not survive into this one.
    mkdirSync(path.join(out, 'testid-interactions'), { recursive: true });
    writeFileSync(path.join(out, 'testid-interactions/old.json'), '{"runId":"old","profile":"x","ids":{"weights-auto":["click"]}}');
    const r = spawnSync('sh', [SCRIPT, out], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` } });
    const logs: Record<string, string> = {};
    for (const g of ['preservation', 'unit', 'typecheck', 'build', 'e2e', 'cli', 'wiz', 'testid-audit', 'profiles']) logs[g] = readFileSync(path.join(out, `${g}.log`), 'utf8');
    return {
      status: r.status, out: r.stdout + r.stderr, summary: readFileSync(path.join(out, 'summary.txt'), 'utf8'), logs,
      runId: readFileSync(path.join(out, 'testid-interactions/run-id'), 'utf8').trim(),
      staleGone: !existsSync(path.join(out, 'testid-interactions/old.json')),
    };
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

test('run-gates.sh audits test ids and profile placement last, against a cleared recording tagged with this run, and exports RIGSMITH_EVIDENCE', () => {
  const r = runWithShims('none');
  const order = [...r.summary.matchAll(/^(\S+) exit=/gm)].map((m) => m[1]);
  assert.deepEqual(order, ['preservation', 'unit', 'typecheck', 'build', 'e2e', 'cli', 'wiz', 'testid-audit', 'profiles']);
  assert.match(r.logs.profiles, /shim node scripts\/roadmap\/check-profiles\.ts/);
  assert.ok(r.staleGone, 'the old recording was removed');
  assert.match(r.runId, /^\d{8}T\d{6}Z-\d+$/);
  assert.match(r.logs['testid-audit'], /shim node scripts\/roadmap\/testid-audit\.ts --recorded \S+\/out\/testid-interactions/);
  for (const g of ['e2e', 'cli', 'wiz']) assert.match(r.logs[g], new RegExp(`^env ${r.runId} \\S+/out/testid-interactions \\S+/out/run-evidence$`, 'm'), g);
});
