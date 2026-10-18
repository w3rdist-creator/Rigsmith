// Autosave + crash recovery. Policy:
// - While the project has unsaved changes, a copy is written to IndexedDB (src/ui/storage.ts)
//   under its own record (never the explicit "Save to browser" slot) ~1.5 s after the last
//   edit, never during a drag (only committed states are written). One write is in
//   flight at a time; edits made meanwhile are written right after it (latest wins).
// - On startup an existing autosave is never loaded automatically: a non-modal banner
//   offers Recover or Discard. Until the user chooses, autosaving is paused so the
//   recoverable copy cannot be overwritten by the new session.
// - Only a CONFIRMED explicit save clears the copy: "Save to browser" after its write
//   commits, or Save through the file picker after the file is closed. A fallback
//   download (the browser cannot report whether the file was written) keeps the copy,
//   annotated "downloaded as X at T", and keeps the project marked unsaved.
// - A storage failure (quota) is shown persistently in the status bar plus a toast.
import { serializeProject } from '../model/format.ts';
import type { App } from './app.ts';
import { h } from './dom.ts';
import type { StoredProject } from './storage.ts';
import { AUTOSAVE, deleteStored, isQuotaError, readStored, writeStored } from './storage.ts';

export class Autosave {
  private app: App;
  private timer = 0;
  private paused = false;
  private failedNotified = false;
  private indicator: HTMLElement;
  private banner: HTMLElement | null = null;
  private writing: Promise<void> | null = null;
  private again = false;
  private note: { downloadedAs: string; downloadedAt: string } | null = null;
  delayMs = 1500;

  constructor(app: App, indicator: HTMLElement) {
    this.app = app;
    this.indicator = indicator;
    app.ed.subscribe((r) => {
      if (r === 'project') {
        this.note = null;
        this.schedule();
      }
    });
  }

  /** Called once at startup: offers recovery if a previous session left a copy. */
  async checkForRecovery(host: HTMLElement): Promise<void> {
    this.paused = true;
    await this.app.storageReady;
    let stored: StoredProject | null = null;
    try {
      stored = await readStored(AUTOSAVE);
    } catch {
      stored = null;
    }
    if (!stored) {
      this.paused = false;
      return this.setIndicator('Autosave on', 'idle');
    }
    this.setIndicator('Autosave paused until you choose Recover or Discard', 'paused');
    const when = new Date(stored.savedAt);
    const dl = stored.downloadedAs ? ` It was downloaded as “${stored.downloadedAs}” at ${new Date(stored.downloadedAt!).toLocaleString()}; if that file exists, this copy may match it.` : '';
    const banner = h('div', { class: 'recovery-banner', role: 'status', 'data-testid': 'recovery-banner' },
      h('span', {}, `Unsaved work from ${when.toLocaleString()} (“${stored.name}”) can be recovered.${dl}`),
      h('button', { class: 'mini accent', 'data-testid': 'recovery-recover', onclick: () => void this.recover() }, 'Recover'),
      h('button', { class: 'mini', 'data-testid': 'recovery-discard', onclick: () => void this.discard() }, 'Discard'),
    );
    this.banner = banner;
    host.append(banner);
    this.app.ed.emit('view');
  }

  async recover(): Promise<void> {
    const stored = await readStored(AUTOSAVE).catch(() => null);
    if (!stored) return this.closeBanner();
    if (!this.app.confirmDiscard()) return;
    const ok = await this.app.loadProjectText(stored.project, 'recovered autosave');
    if (!ok) return;
    // The recovered work has not been saved to a file: keep it marked unsaved.
    this.app.ed.dirty = true;
    this.closeBanner();
    this.app.ed.emit('view');
    this.app.status(`Recovered unsaved work from ${new Date(stored.savedAt).toLocaleString()}. Save it to keep it.`);
    void this.writeNow();
  }

  async discard(): Promise<void> {
    if (!window.confirm('Discard the recoverable autosave? This cannot be undone.')) return;
    await deleteStored(AUTOSAVE).catch(() => undefined);
    this.closeBanner();
    this.app.status('Autosave discarded.');
    this.schedule();
  }

  private closeBanner(): void {
    this.banner?.remove();
    this.banner = null;
    this.paused = false;
    this.setIndicator('Autosave on', 'idle');
  }

  get pending(): boolean {
    return this.paused;
  }

  schedule(): void {
    if (this.paused) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.writeNow(), this.delayMs);
  }

  /** A save was confirmed written: the autosave copy is no longer needed. */
  async clearAfterExplicitSave(): Promise<void> {
    if (this.paused) return;
    window.clearTimeout(this.timer);
    this.note = null;
    await this.writing;
    // An edit made while the save was being written keeps the project dirty: keep the copy.
    if (this.app.ed.dirty) return this.schedule();
    await deleteStored(AUTOSAVE).catch(() => undefined);
    this.setIndicator('Saved', 'idle');
  }

  /** Fallback download (outcome unknowable): keep the copy, annotated, and write it now. */
  async noteDownload(filename: string): Promise<void> {
    this.note = { downloadedAs: filename, downloadedAt: new Date().toISOString() };
    window.clearTimeout(this.timer);
    await this.writeNow();
  }

  writeNow(): Promise<void> {
    if (this.paused) return Promise.resolve();
    const ed = this.app.ed;
    // Mid-drag the project holds an uncommitted pose (Esc may still cancel it): wait for
    // the gesture to end, then write the committed state.
    if (ed.inGesture) return (this.schedule(), Promise.resolve());
    if (!ed.dirty) return Promise.resolve();
    if (this.writing) {
      this.again = true;
      return this.writing;
    }
    const payload: StoredProject = { savedAt: new Date().toISOString(), name: ed.project.name, project: serializeProject(ed.project), ...(this.note ?? {}) };
    this.writing = writeStored(AUTOSAVE, payload)
      .then(() => {
        this.failedNotified = false;
        this.setIndicator(`Autosaved ${new Date(payload.savedAt).toLocaleTimeString()}${payload.downloadedAs ? ' (download kept as recovery copy)' : ''}`, 'ok');
      })
      .catch((e) => {
        const quota = isQuotaError(e);
        const msg = quota ? 'Autosave failed: the project is too large for browser storage. Use Save (download).' : `Autosave failed: ${(e as Error).message}`;
        this.setIndicator(msg, 'error');
        if (!this.failedNotified) this.app.error('Autosave failed', [quota ? 'The project is too large for browser storage. Your work is NOT being autosaved — use Save (download).' : (e as Error).message]);
        this.failedNotified = true;
      })
      .finally(() => {
        this.writing = null;
        if (this.again) {
          this.again = false;
          void this.writeNow();
        }
      });
    return this.writing;
  }

  private setIndicator(text: string, state: 'idle' | 'ok' | 'paused' | 'error'): void {
    this.indicator.textContent = text;
    this.indicator.dataset.state = state;
  }
}
