// "Delivered = a visible control exists and a test exercises it" — audit.
// Lists every data-testid literal in src/ui, src/main.ts, src/player-main.ts, index.html and
// player.html (templated ids such as `tree-bone-${name}` by their static prefix), then:
//   1. static check: every id is referenced by some file under tests/;
//   2. runtime check (post-review FR-004, with --recorded <dir>): every id received a
//      real interaction event during this run's browser tests. The recordings are written
//      by tests/e2e/harness.ts (RIGSMITH_TESTID_RECORD) and must carry the run id stored
//      in <dir>/run-id, so stale recordings never count.
//   3. completeness: every id rendered or interacted with at runtime is covered by the
//      static inventory, so a control the scan misses cannot escape checks 1 and 2.
// Ids that are read but never operated (status lines, readouts, containers) need a reason
// in scripts/roadmap/testid-allow.json. An allow-list entry that matches no id, or whose
// id was in fact exercised, is reported so the list cannot silently go stale.
// Usage: node scripts/roadmap/testid-audit.ts [--recorded <dir>]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

/** Every UI test id (or `prefix*` for templated ids) → the first source file that has it. */
export function uiTestIds(): Map<string, string> {
  const sources = [...files(path.join(ROOT, 'src/ui'), /\.ts$/), ...['src/main.ts', 'src/player-main.ts', 'index.html', 'player.html'].map((f) => path.join(ROOT, f))];
  const ids = new Map<string, string>();
  const add = (raw: string, f: string) => {
    const key = raw.includes('${') ? `${raw.slice(0, raw.indexOf('${'))}*` : raw;
    if (!ids.has(key)) ids.set(key, path.relative(ROOT, f));
  };
  // An id literal: a hyphenated '…' string, or the static prefix of a `…${…}` template.
  const LITERAL = /'([a-z][a-z0-9]*(?:-[a-z0-9]+)+)'|`([a-z][a-z0-9]*(?:-[a-z0-9]+)*-)\$\{|`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g;
  const literals = (text: string) => [...text.matchAll(LITERAL)].map((x) => x[1] ?? `${x[2] ?? x[3]}${x[2] ? '${' : ''}`);
  for (const f of sources) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/data-testid['"]?\s*[:=]\s*(['"`])([^'"`]+)\1/g)) add(m[2], f);
    // data-testid / testId set from a template literal (which may itself contain quotes).
    for (const m of text.matchAll(/(?:data-testid['"]?|testId)\s*:\s*`([^`$]*)\$\{/g)) add(`${m[1]}\${`, f);
    // testIds passed through helpers: testId: 'x'
    for (const m of text.matchAll(/testId:\s*(['`])([^'`]+)\1/g)) add(m[2], f);
    // const testId = cond ? 'a' : `b-${…}` — every literal on the line.
    for (const m of text.matchAll(/\btestId\s*=\s*([^;\n]*)/g)) for (const id of literals(m[1])) add(id, f);
    // Helper calls: the first id literal argument is the test id.
    for (const m of text.matchAll(/\b(?:keyToggle|checkbox|select|textField|num|check|keyable|numberlessText|reselectNum|speckNum|tool|animSelect|labeledSelect|row)\((?=([^\n]*))/g)) {
      const id = literals(m[1])[0];
      if (id) add(id, f);
    }
    // rigPanels keyable(ch, …, 'pc-position', …) also renders the key toggle `${'pc'}-key-${ch}`.
    for (const m of text.matchAll(/\bkeyable\('([a-z]+)'[^\n]*?'([a-z]+)-[a-z0-9-]+'/g)) add(`${m[2]}-key-${m[1]}`, f);
  }
  return ids;
}

export interface Recording { runId: string | null; profile: string; ids: Record<string, string[]>; rendered?: string[] }

/** Reads <dir>/run-id and every recording in <dir> carrying that run id. */
export function readRecordings(dir: string): { runId: string; used: Recording[]; stale: string[] } {
  const marker = path.join(dir, 'run-id');
  if (!existsSync(marker)) throw new Error(`${marker} is missing: record a run with scripts/roadmap/run-gates.sh`);
  const runId = readFileSync(marker, 'utf8').trim();
  const used: Recording[] = [];
  const stale: string[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const r = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Recording;
    if (r.runId === runId) used.push(r);
    else stale.push(name);
  }
  return { runId, used, stale };
}

export interface AuditResult {
  ids: number;
  allowListed: number;
  unreferenced: string[];
  unexercised: string[];
  staleAllow: string[];
  exercisedButAllowed: string[];
  /** Rendered or interacted ids that the static inventory does not cover (scan gaps). */
  notInInventory: string[];
  recordings: number;
  exercised: number;
}

export function audit(opts: { recorded?: Recording[]; allow?: Record<string, string>; tests?: string } = {}): AuditResult {
  const ids = uiTestIds();
  const allow = opts.allow ?? (JSON.parse(readFileSync(path.join(import.meta.dirname, 'testid-allow.json'), 'utf8')) as Record<string, string>);
  const tests = opts.tests ?? files(path.join(ROOT, 'tests'), /\.ts$/).map((f) => readFileSync(f, 'utf8')).join('\n');
  const recorded = new Set<string>();
  for (const r of opts.recorded ?? []) for (const id of Object.keys(r.ids)) recorded.add(id);
  const hit = (key: string) => (key.endsWith('*') ? [...recorded].some((r) => r.startsWith(key.slice(0, -1))) : recorded.has(key));
  const unreferenced: string[] = [];
  const unexercised: string[] = [];
  const exercisedButAllowed: string[] = [];
  for (const [id, file] of [...ids.entries()].sort()) {
    const needle = id.endsWith('*') ? id.slice(0, -1) : id;
    const referenced = id.endsWith('*') ? tests.includes(needle) : new RegExp(`['"\`]${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(tests);
    if (allow[id]) {
      if (opts.recorded && hit(id)) exercisedButAllowed.push(id);
      continue;
    }
    if (!referenced) unreferenced.push(`${id}  (${file})`);
    if (opts.recorded && !hit(id)) unexercised.push(`${id}  (${file})`);
  }
  const staleAllow = Object.keys(allow).filter((id) => !ids.has(id) || !String(allow[id]).trim());
  const keys = [...ids.keys()];
  const covered = (id: string) => keys.some((k) => (k.endsWith('*') ? id.startsWith(k.slice(0, -1)) : k === id));
  const observed = new Set(recorded);
  for (const r of opts.recorded ?? []) for (const id of r.rendered ?? []) observed.add(id);
  const notInInventory = [...observed].filter((id) => !covered(id)).sort();
  return {
    ids: ids.size, allowListed: Object.keys(allow).length, unreferenced, unexercised, staleAllow, exercisedButAllowed, notInInventory,
    recordings: opts.recorded?.length ?? 0, exercised: recorded.size,
  };
}

if (import.meta.main) {
  const at = process.argv.indexOf('--recorded');
  const dir = at > 0 ? process.argv[at + 1] : undefined;
  let recorded: Recording[] | undefined;
  let failed = false;
  if (dir) {
    const r = readRecordings(path.resolve(dir));
    recorded = r.used;
    console.log(`run ${r.runId}: ${r.used.length} recording(s) used, ${r.stale.length} from other runs ignored`);
    if (!r.used.length) {
      console.log('  NO RECORDINGS for this run — the runtime check cannot pass');
      failed = true;
    }
  } else console.log('static check only (no --recorded <dir>): interactions are not verified');
  const a = audit({ recorded });
  console.log(`${a.ids} test ids in the UI; ${a.allowListed} allow-listed; ${a.unreferenced.length} never referenced by tests/` + (recorded ? `; ${a.exercised} distinct ids interacted with; ${a.unexercised.length} never interacted with` : ''));
  for (const m of a.unreferenced) console.log(`  MISSING ${m}`);
  for (const m of a.unexercised) console.log(`  NOT EXERCISED ${m}`);
  for (const m of a.staleAllow) console.log(`  STALE ALLOW-LIST ENTRY ${m} (no such id, or no reason)`);
  for (const m of a.notInInventory) console.log(`  NOT IN INVENTORY ${m} (rendered or used at runtime, missed by the static scan)`);
  for (const m of a.exercisedButAllowed) console.log(`  note: allow-listed but exercised: ${m}`);
  process.exitCode = failed || a.unreferenced.length || a.unexercised.length || a.staleAllow.length || a.notInInventory.length ? 1 : 0;
}
