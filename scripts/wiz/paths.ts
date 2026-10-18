// Locations of the private Wiz acceptance-test assets (all under the git-ignored
// .hermes/assets/wiz/). Nothing here is committed except this code.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Manifest } from './rig-spec.ts';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const WIZ = path.join(ROOT, '.hermes/assets/wiz');
export const SOURCE = path.join(WIZ, 'source/wiz_master.png');
export const PREPARED = path.join(WIZ, 'prepared');
export const OUTPUT = path.join(WIZ, 'output');
export const PROJECT_FILE = path.join(OUTPUT, 'wiz.rig.json');
export const EVIDENCE = path.join(ROOT, '.hermes/evidence/wiz');

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(path.join(PREPARED, 'manifest.json'), 'utf8')) as Manifest;
}
