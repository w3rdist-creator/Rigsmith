// Root directory for raw test outputs (git-ignored). Defaults to .hermes/evidence/;
// RIGSMITH_EVIDENCE redirects a whole run (e.g. a review pass) to its own directory so
// earlier evidence is never overwritten.
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const EVIDENCE = process.env.RIGSMITH_EVIDENCE ? path.resolve(process.env.RIGSMITH_EVIDENCE) : path.join(ROOT, '.hermes/evidence');
