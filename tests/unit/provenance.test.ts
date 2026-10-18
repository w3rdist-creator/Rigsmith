// Provenance completeness (drwdmrs3 review P3-3): docs/provenance.md omitted ffmpeg,
// which the CLI spawns for WebM/MP4. Every external program the repo's code launches by
// name must be listed there; POSIX base utilities (sh, pgrep) are part of the OS.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OS_UTILITIES = new Set(['sh', 'pgrep']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|sh)$/.test(n) ? [p] : [];
  });
}

/** Program names launched by literal name: spawn/exec calls, defaults, gate commands. */
function launchedPrograms(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (name: string, where: string) => found.set(name, [...(found.get(name) ?? []), where]);
  for (const f of ['src', 'scripts', 'tests', 'examples'].flatMap((d) => files(path.join(ROOT, d)))) {
    const text = readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    for (const m of text.matchAll(/\b(?:spawnSync|spawn|execFileSync|execFile|execSync)\(\s*['"`]([^'"`\s]+)/g)) add(path.basename(m[1]), rel);
    for (const m of text.matchAll(/\?\?\s*['"]([a-z][\w-]*)['"];\s*$/gm)) if (/FFMPEG|FFPROBE/.test(text.slice(Math.max(0, m.index! - 80), m.index))) add(m[1], rel);
    if (f.endsWith('.sh')) for (const m of text.matchAll(/^run \S+ (\S+)/gm)) if (!['npm', 'node'].includes(m[1])) add(m[1], rel);
  }
  return found;
}

describe('provenance lists every external program (review P3-3)', () => {
  it('each program launched by name appears in docs/provenance.md', () => {
    const doc = readFileSync(path.join(ROOT, 'docs/provenance.md'), 'utf8');
    const progs = launchedPrograms();
    assert.ok(progs.has('ffmpeg') && progs.has('python3'), `inventory found ${[...progs.keys()].join(', ')}`);
    const missing = [...progs].filter(([name]) => !OS_UTILITIES.has(name) && !new RegExp(`\\b${name}\\b`).test(doc));
    assert.deepEqual(missing.map(([n, w]) => `${n} (${[...new Set(w)].join(', ')})`), []);
  });

  it('documents ffmpeg as user-installed, not bundled, with its licence position', () => {
    const doc = readFileSync(path.join(ROOT, 'docs/provenance.md'), 'utf8');
    const row = doc.split('\n').find((l) => l.startsWith('| ffmpeg'));
    assert.ok(row, 'an ffmpeg row');
    assert.match(row, /not distributed|not bundled/i);
    assert.match(row, /LGPL/);
    assert.match(row, /user installs/i);
  });
});
