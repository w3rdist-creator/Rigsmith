// The runtime test-id audit (post-review FR-004): an id passes only if this run's browser
// tests interacted with it, or it is allow-listed with a reason. Synthetic recordings stand
// in for the harness output, so these checks run without a browser.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { EVIDENCE } from '../support/evidence.ts';
import { audit, readRecordings, uiTestIds, type Recording } from '../../scripts/roadmap/testid-audit.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ALLOW = JSON.parse(readFileSync(path.join(ROOT, 'scripts/roadmap/testid-allow.json'), 'utf8')) as Record<string, string>;

/** One recording that interacted with every non-allow-listed id except `skip`. */
function recordingWithout(skip: string[], runId = 'run-1'): Recording {
  const ids: Record<string, string[]> = {};
  for (const id of uiTestIds().keys()) {
    if (ALLOW[id] || skip.includes(id)) continue;
    ids[id.endsWith('*') ? `${id.slice(0, -1)}sample` : id] = ['click'];
  }
  return { runId, profile: 'synthetic', ids };
}

describe('test-id audit (FR-004)', () => {
  test('every allow-list entry names a real id and gives a reason', () => {
    const ids = uiTestIds();
    for (const [id, reason] of Object.entries(ALLOW)) {
      assert.ok(ids.has(id), `allow-listed ${id} exists in the UI`);
      assert.ok(reason.trim().length > 10, `allow-listed ${id} has a reason`);
    }
  });

  test('a complete recording passes; dropping weights-auto fails naming weights-auto', () => {
    const full = audit({ recorded: [recordingWithout([])] });
    assert.deepEqual(full.unexercised, []);
    assert.deepEqual(full.staleAllow, []);
    const missing = audit({ recorded: [recordingWithout(['weights-auto'])] });
    assert.equal(missing.unexercised.length, 1);
    assert.match(missing.unexercised[0], /^weights-auto\s/);
  });

  test('templated ids are matched by their static prefix', () => {
    const r = recordingWithout(['tree-bone-*']);
    assert.match(audit({ recorded: [r] }).unexercised.join('\n'), /tree-bone-\*/);
    r.ids['tree-bone-hip'] = ['click'];
    assert.deepEqual(audit({ recorded: [r] }).unexercised, []);
  });

  test('the static scan covers ids built by helpers and templates (gaps found from runtime recordings)', () => {
    const ids = uiTestIds();
    const covered = (id: string) => [...ids.keys()].some((k) => (k.endsWith('*') ? id.startsWith(k.slice(0, -1)) : k === id));
    for (const id of ['atlas-pot', 'bone-name', 'curve-y2', 'cut-min-alpha', 'cut-speck-dist', 'cut-speck-faint', 'cut-speck-solid', 'cut-tolerance', 'mesh-tool-vertices', 'mesh-tool-weights', 'mix-from', 'mix-interrupt-anim', 'mix-to', 'mv-add-bone', 'pc-key-position', 'pc-key-mix', 'ik-key-mix', 'project-name', 'att-name', 'skin-from-green.png', 'skin-image', 'att-tint', 'att-tint-alpha', 'slot-color', 'slot-color-alpha', 'tree-constraint-forearm-front-ik', 'tree-path-rail', 'wp-bone', 'wp-mode'])
      assert.ok(covered(id), id);
    assert.ok(![...ids.keys()].includes('*'), 'no template without a static prefix');
  });

  test('an id rendered or used at runtime but missing from the inventory fails the audit', () => {
    const r = recordingWithout([]);
    r.rendered = ['tree-bone-hip', 'status', 'made-up-id'];
    r.ids['other-made-up'] = ['click'];
    assert.deepEqual(audit({ recorded: [r] }).notInInventory, ['made-up-id', 'other-made-up']);
  });

  test('an allow-listed id that no test references is still reported as unreferenced', () => {
    assert.ok(ALLOW.status, 'status is allow-listed');
    const tests = "page.getByTestId('weights-auto'); page.getByTestId('play');";
    const a = audit({ recorded: [recordingWithout([])], tests });
    assert.ok(a.unreferenced.some((m) => /^status\s.*\[allow-listed\]/.test(m)), a.unreferenced.slice(0, 5).join('\n'));
    assert.ok(!a.unreferenced.some((m) => /^weights-auto\s/.test(m)), 'a referenced id is not reported');
    assert.deepEqual(audit({ recorded: [recordingWithout([])] }).unreferenced, [], 'every id, allow-listed or not, is referenced by the real tests/');
  });

  test('an allow-list entry for an unknown id, or without a reason, is stale', () => {
    const a = audit({ recorded: [recordingWithout([])], allow: { ...ALLOW, 'no-such-id': 'reason given here', status: ' ' } });
    assert.deepEqual(a.staleAllow.sort(), ['no-such-id', 'status']);
  });

  test('recordings from another run are ignored; a missing run-id marker throws', () => {
    mkdirSync(EVIDENCE, { recursive: true });
    const dir = mkdtempSync(path.join(EVIDENCE, 'tmp-testid-'));
    try {
      assert.throws(() => readRecordings(dir), /run-id is missing/);
      writeFileSync(path.join(dir, 'run-id'), 'run-2\n');
      writeFileSync(path.join(dir, 'old.json'), JSON.stringify(recordingWithout([], 'run-1')));
      writeFileSync(path.join(dir, 'new.json'), JSON.stringify(recordingWithout(['weights-auto'], 'run-2')));
      const r = readRecordings(dir);
      assert.equal(r.runId, 'run-2');
      assert.deepEqual(r.stale, ['old.json']);
      assert.equal(r.used.length, 1);
      assert.match(audit({ recorded: r.used }).unexercised.join('\n'), /weights-auto/, 'the stale full recording does not hide the gap');
      // The CLI exits 1 and names the id.
      const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts/roadmap/testid-audit.ts'), '--recorded', dir], { encoding: 'utf8' });
      assert.equal(cli.status, 1, cli.stdout + cli.stderr);
      assert.match(cli.stdout, /NOT EXERCISED weights-auto/);
      writeFileSync(path.join(dir, 'new.json'), JSON.stringify(recordingWithout([], 'run-2')));
      const ok = spawnSync(process.execPath, [path.join(ROOT, 'scripts/roadmap/testid-audit.ts'), '--recorded', dir], { encoding: 'utf8' });
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
