/**
 * Snapshot-based undo/redo. Callers record the state *before* a mutation; undo swaps
 * the current state for the previous snapshot and keeps the current one for redo.
 */
export interface HistoryEntry<T> {
  label: string;
  state: T;
}

export class History<T> {
  private past: HistoryEntry<T>[] = [];
  private future: HistoryEntry<T>[] = [];
  private readonly limit: number;

  constructor(limit = 200) {
    this.limit = limit;
  }

  record(label: string, before: T): void {
    this.past.push({ label, state: before });
    if (this.past.length > this.limit) this.past.shift();
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
    return entry.state;
  }

  redo(current: T): T | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({ label: entry.label, state: current });
    return entry.state;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  get size(): { undo: number; redo: number } {
    return { undo: this.past.length, redo: this.future.length };
  }
}
