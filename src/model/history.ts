/**
 * Snapshot-based undo/redo. Callers record the state *before* a mutation; undo swaps
 * the current state for the previous snapshot and keeps the current one for redo.
 *
 * Memory (drwdmrs3 review P3-2): with `share`, each recorded snapshot reuses every
 * subtree that is unchanged from the snapshot recorded just before it, so a long run of
 * small edits on a large rig retains roughly one copy of the rig plus the edited parts,
 * instead of one full copy per step. Shared subtrees are never handed out for in-place
 * mutation: `restore` (a deep copy) is applied to every state returned by undo/redo.
 */
export interface HistoryEntry<T> {
  label: string;
  state: T;
}

export interface HistoryOptions<T> {
  /** Maximum undo depth (oldest entries are dropped). */
  limit?: number;
  /** Returns `next` with subtrees equal to `prev` replaced by `prev`'s (structural sharing). */
  share?: (next: T, prev: T) => T;
  /** Copy handed back by undo/redo (required with `share`, so shared parts stay immutable). */
  restore?: (state: T) => T;
}

export class History<T> {
  private past: HistoryEntry<T>[] = [];
  private future: HistoryEntry<T>[] = [];
  private readonly limit: number;
  private readonly share: ((next: T, prev: T) => T) | null;
  private readonly restore: (state: T) => T;

  constructor(opts: number | HistoryOptions<T> = 200) {
    const o = typeof opts === 'number' ? { limit: opts } : opts;
    this.limit = o.limit ?? 200;
    this.share = o.share ?? null;
    this.restore = o.restore ?? ((s) => s);
    if (this.share && !o.restore) throw new Error('History: `share` needs `restore`.');
  }

  private push(label: string, state: T): void {
    const prev = this.past.at(-1);
    this.past.push({ label, state: prev && this.share ? this.share(state, prev.state) : state });
    if (this.past.length > this.limit) this.past.shift();
  }

  record(label: string, before: T): void {
    this.push(label, before);
    this.future = [];
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  undoLabel(): string | null {
    return this.past.at(-1)?.label ?? null;
  }

  redoLabel(): string | null {
    return this.future.at(-1)?.label ?? null;
  }

  /** Returns the state to restore, or null if nothing to undo. */
  undo(current: T): T | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ label: entry.label, state: current });
    return this.restore(entry.state);
  }

  redo(current: T): T | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.push(entry.label, current);
    return this.restore(entry.state);
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  get size(): { undo: number; redo: number } {
    return { undo: this.past.length, redo: this.future.length };
  }
}

const isPlain = (v: object) => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Structural equality of JSON-like data (plain objects, arrays, primitives; NaN equals NaN). */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqualJson(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b) || !isPlain(a) || !isPlain(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!own(b, k) || !deepEqualJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/**
 * Returns `next` with every subtree that is structurally equal to the corresponding
 * subtree of `prev` replaced by `prev`'s (so equal parts are stored once). Inputs are
 * not modified; containers that differ are new objects. Non-plain objects are kept as is.
 */
export function shareUnchanged<T>(next: T, prev: T): T {
  return share(next, prev)[0] as T;
}

function share(next: unknown, prev: unknown): [unknown, boolean] {
  if (Object.is(next, prev)) return [next, true];
  if (typeof next !== 'object' || typeof prev !== 'object' || next === null || prev === null) return [next, false];
  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return [next, false];
    let same = next.length === prev.length;
    const out = new Array<unknown>(next.length);
    for (let i = 0; i < next.length; i++) {
      const [v, eq] = share(next[i], prev[i]);
      out[i] = v;
      if (!eq) same = false;
    }
    return same ? [prev, true] : [out, false];
  }
  if (Array.isArray(prev) || !isPlain(next) || !isPlain(prev)) return [next, false];
  const n = next as Record<string, unknown>, p = prev as Record<string, unknown>;
  const keys = Object.keys(n);
  let same = keys.length === Object.keys(p).length;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const has = own(p, k);
    const [v, eq] = has ? share(n[k], p[k]) : [n[k], false];
    out[k] = v;
    if (!eq) same = false;
  }
  return same ? [prev, true] : [out, false];
}
