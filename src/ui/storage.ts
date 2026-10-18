// Browser storage for the explicit "Save to browser" slot and the autosave copy.
// IndexedDB (database "rigsmith", store "kv") replaces localStorage, whose ~5 MB string
// quota a real character project with embedded images exceeds. The old localStorage
// keys are migrated once: copied into IndexedDB, then removed only after the write
// has committed — or when IndexedDB already holds the same or a newer copy (see
// migrateLegacy; a copy that cannot be ordered is kept).
export const DB_NAME = 'rigsmith';
export const DB_STORE = 'kv';
/** Record keys inside the store. */
export const BROWSER_SAVE = 'browser-save';
export const AUTOSAVE = 'autosave';
/** The durable key clipboard (src/model/clipboard.ts); never touched by save/recovery. */
export const CLIPBOARD = 'clipboard';
/** Legacy localStorage keys (read once for migration). */
export const LEGACY_KEYS: Record<string, string> = { [BROWSER_SAVE]: 'rigsmith:project:v1', [AUTOSAVE]: 'rigsmith:autosave:v1' };

export interface StoredProject {
  savedAt: string;
  name: string;
  /** Serialized project file text. */
  project: string;
  /** Fallback download: the browser cannot confirm the file was written. */
  downloadedAs?: string;
  downloadedAt?: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => void req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB is unavailable.'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab.'));
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(DB_STORE, mode);
    const req = run(t.objectStore(DB_STORE));
    // Resolve on commit (not request success): a quota failure surfaces as a tx abort.
    t.oncomplete = () => resolve(req.result);
    t.onabort = () => reject(t.error ?? req.error ?? new Error('Storage write aborted.'));
    t.onerror = () => reject(t.error ?? req.error ?? new Error('Storage write failed.'));
  });
}

export async function readStored(key: string): Promise<StoredProject | null> {
  const v = await tx<unknown>('readonly', (s) => s.get(key));
  const o = v as StoredProject | undefined;
  return o && typeof o.project === 'string' ? o : null;
}

export function writeStored(key: string, value: StoredProject): Promise<void> {
  return tx('readwrite', (s) => s.put(value, key)).then(() => undefined);
}

/** Any structured-clonable record (e.g. the key clipboard). */
export async function readRecord(key: string): Promise<unknown> {
  return (await tx<unknown>('readonly', (s) => s.get(key))) ?? null;
}

export function writeRecord(key: string, value: unknown): Promise<void> {
  return tx('readwrite', (s) => s.put(value, key)).then(() => undefined);
}

export function deleteStored(key: string): Promise<void> {
  return tx('readwrite', (s) => s.delete(key)).then(() => undefined);
}

export function isQuotaError(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22);
}

/**
 * Moves the legacy localStorage copies into IndexedDB. A legacy copy is removed only when
 * nothing is lost: it was written into IndexedDB (no record there yet, or — autosave, which
 * carries `savedAt` — the legacy copy is newer), or the IndexedDB record is the same
 * project text, or it is an autosave older than the IndexedDB one. Otherwise (a differing
 * "Save to browser" copy, which has no timestamp) it stays in localStorage untouched.
 */
export async function migrateLegacy(): Promise<string[]> {
  const moved: string[] = [];
  for (const [key, legacy] of Object.entries(LEGACY_KEYS)) {
    let text: string | null = null;
    try {
      text = localStorage.getItem(legacy);
    } catch {
      text = null;
    }
    if (text === null) continue;
    let value: StoredProject;
    if (key === AUTOSAVE) {
      try {
        value = JSON.parse(text) as StoredProject;
      } catch {
        continue;
      }
      if (typeof value?.project !== 'string') continue;
    } else value = { savedAt: new Date().toISOString(), name: projectName(text), project: text };
    const existing = await readStored(key);
    const time = (v: StoredProject) => Date.parse(v.savedAt);
    let write = !existing;
    let remove = write;
    if (existing && existing.project === value.project) remove = true;
    else if (existing && key === AUTOSAVE && Number.isFinite(time(value)) && Number.isFinite(time(existing))) {
      write = time(value) > time(existing);
      remove = true;
    }
    if (write) await writeStored(key, value);
    if (!remove) continue;
    try {
      localStorage.removeItem(legacy);
    } catch {
      /* ignore */
    }
    moved.push(legacy);
  }
  return moved;
}

function projectName(text: string): string {
  try {
    return String((JSON.parse(text) as { name?: unknown }).name ?? 'rig');
  } catch {
    return 'rig';
  }
}
