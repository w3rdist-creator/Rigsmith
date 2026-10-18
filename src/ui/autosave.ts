// Autosave + crash recovery. Policy:
// - While the project has unsaved changes, a copy is written to localStorage under its
//   own key (never the explicit "Save to browser" slot) ~1.5 s after the last edit,
//   never during a drag (only committed states are written).
// - On startup an existing autosave is never loaded automatically: a non-modal banner
//   offers Recover or Discard. Until the user chooses, autosaving is paused so the
//   recoverable copy cannot be overwritten by the new session.
// - Saving explicitly (download or browser slot) marks the project clean and clears
//   the autosave copy (the work is safe elsewhere).
// - A storage failure (quota) is shown persistently in the status bar plus a toast.
import { serializeProject } from '../model/format.ts';
import type { App } from './app.ts';
import { h } from './dom.ts';

export const AUTOSAVE_KEY = 'rigsmith:autosave:v1';

interface Stored {
  savedAt: string;
  name: string;
  project: string;
}

export class Autosave {
  private app: App;
  private timer = 0;
  private paused = false;
  private failedNotified = false;
  private indicator: HTMLElement;
  private banner: HTMLElement | null = null;
  delayMs = 1500;

  constructor(app: App, indicator: HTMLElement) {
    this.app = app;
    this.indicator = indicator;
    app.ed.subscribe((r) => {
      if (r === 'project') this.schedule();
    });
  }

  /** Called once at startup: offers recovery if a previous session left a copy. */
  checkForRecovery(host: HTMLElement): void {
    const stored = this.read();
    if (!stored) return this.setIndicator('Autosave on', 'idle');
    this.paused = true;
    this.setIndicator('Autosave paused until you choose Recover or Discard', 'paused');
    const when = new Date(stored.savedAt);
    const banner = h('div', { class: 'recovery-banner', role: 'status', 'data-testid': 'recovery-banner' },
      h('span', {}, `Unsaved work from ${when.toLocaleString()} (“${stored.name}”) can be recovered.`),
      h('button', { class: 'mini accent', 'data-testid': 'recovery-recover', onclick: () => void this.recover() }, 'Recover'),
      h('button', { class: 'mini', 'data-testid': 'recovery-discard', onclick: () => this.discard() }, 'Discard'),
    );
    this.banner = banner;
    host.append(banner);
  }

  private read(): Stored | null {
    try {
      const text = localStorage.getItem(AUTOSAVE_KEY);
      if (!text) return null;
      const s = JSON.parse(text) as Stored;
      return typeof s.project === 'string' ? s : null;
    } catch {
      return null;
    }
  }

  async recover(): Promise<void> {
    const stored = this.read();
    if (!stored) return this.closeBanner();
    if (!this.app.confirmDiscard()) return;
    const ok = await this.app.loadProjectText(stored.project, 'recovered autosave');
    if (!ok) return;
    // The recovered work has not been saved to a file: keep it marked unsaved.
    this.app.ed.dirty = true;
    this.closeBanner();
    this.app.ed.emit('view');
    this.app.status(`Recovered unsaved work from ${new Date(stored.savedAt).toLocaleString()}. Save it to keep it.`);
    this.writeNow();
  }

  discard(): void {
    if (!window.confirm('Discard the recoverable autosave? This cannot be undone.')) return;
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
      /* ignore */
    }
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
    this.timer = window.setTimeout(() => this.writeNow(), this.delayMs);
  }

  /** The project was saved explicitly: the autosave copy is no longer needed. */
  clearAfterExplicitSave(): void {
    if (this.paused) return;
    window.clearTimeout(this.timer);
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
      /* ignore */
    }
    this.setIndicator('Saved', 'idle');
  }

  writeNow(): void {
    if (this.paused) return;
    const ed = this.app.ed;
    // Mid-drag the project holds an uncommitted pose (Esc may still cancel it): wait for
    // the gesture to end, then write the committed state.
    if (ed.inGesture) return this.schedule();
    if (!ed.dirty) return;
    const payload: Stored = { savedAt: new Date().toISOString(), name: ed.project.name, project: serializeProject(ed.project) };
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
      this.failedNotified = false;
      this.setIndicator(`Autosaved ${new Date(payload.savedAt).toLocaleTimeString()}`, 'ok');
    } catch (e) {
      const quota = e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22);
      const msg = quota ? 'Autosave failed: the project is too large for browser storage. Use Save (download).' : `Autosave failed: ${(e as Error).message}`;
      this.setIndicator(msg, 'error');
      if (!this.failedNotified) this.app.error('Autosave failed', [quota ? 'The project is too large for browser storage. Your work is NOT being autosaved — use Save (download).' : (e as Error).message]);
      this.failedNotified = true;
    }
  }

  private setIndicator(text: string, state: 'idle' | 'ok' | 'paused' | 'error'): void {
    this.indicator.textContent = text;
    this.indicator.dataset.state = state;
  }
}
