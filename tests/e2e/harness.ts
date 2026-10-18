// Shared e2e harness: an isolated Chrome for Testing instance (dedicated profile under
// .hermes/browser-profiles/, headless, never the user's Chrome) plus a vite preview
// server bound to 127.0.0.1 on a port verified free before use.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

export { EVIDENCE, ROOT } from '../support/evidence.ts';
import { EVIDENCE, ROOT } from '../support/evidence.ts';
export const CFT =
  process.env.RIGSMITH_CFT ??
  '/Users/w3rd/chrome-for-testing/chrome/mac_arm-155.0.8059.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

export async function pickPort(candidates: number[]): Promise<number> {
  for (const p of candidates) if (await portFree(p)) return p;
  throw new Error(`No free port among ${candidates.join(', ')}`);
}

export async function startPreview(port: number): Promise<ChildProcess> {
  if (!existsSync(path.join(ROOT, 'dist/index.html'))) throw new Error('dist/ missing — run `npm run build` first');
  const child = spawn(path.join(ROOT, 'node_modules/.bin/vite'), ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  throw new Error('preview server did not start');
}

export async function launchIsolated(
  profileName: string,
  extraArgs: string[] = [],
  opts: { viewport?: { width: number; height: number }; deviceScaleFactor?: number } = {},
): Promise<BrowserContext> {
  if (!existsSync(CFT)) throw new Error(`Chrome for Testing not found at ${CFT}`);
  const dir = path.join(ROOT, '.hermes/browser-profiles', profileName);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const downloads = path.join(EVIDENCE, 'downloads');
  mkdirSync(downloads, { recursive: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: CFT,
    headless: true,
    viewport: opts.viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: opts.deviceScaleFactor,
    acceptDownloads: true,
    downloadsPath: downloads,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', ...extraArgs],
  });
  if (process.env.RIGSMITH_TESTID_RECORD) await recordInteractions(ctx, profileName, process.env.RIGSMITH_TESTID_RECORD);
  return ctx;
}

/** Interaction events that count as exercising a control. */
export const RECORDED_EVENTS = ['pointerdown', 'click', 'dblclick', 'input', 'change', 'keydown', 'wheel', 'contextmenu', 'drop'] as const;
let recordings = 0;

/**
 * Test-side instrumentation for the test-id audit (post-review FR-004): when
 * RIGSMITH_TESTID_RECORD names a directory, every page of the context reports which
 * data-testid element (the innermost one around the event target) received a trusted
 * interaction event, in the capture phase, before the app sees it. The page is never
 * changed; the list is written to <dir>/<profile>-<pid>-<n>.json, tagged with
 * RIGSMITH_RUN_ID so the audit can reject recordings from another run. Every data-testid
 * that was ever rendered is listed too (`rendered`), so the audit can prove its static
 * inventory of ids is complete.
 */
async function recordInteractions(ctx: BrowserContext, profile: string, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${profile}-${process.pid}-${++recordings}.json`);
  const seen = new Map<string, Set<string>>();
  const rendered = new Set<string>();
  const save = () => writeFileSync(file, JSON.stringify({ runId: process.env.RIGSMITH_RUN_ID ?? null, profile, ids: Object.fromEntries([...seen].sort().map(([id, t]) => [id, [...t].sort()])), rendered: [...rendered].sort() }, null, 1));
  save();
  await ctx.exposeBinding('__rigsmithTestidRendered', (_source, ids: unknown) => {
    if (!Array.isArray(ids)) return;
    const n = rendered.size;
    for (const id of ids) if (typeof id === 'string') rendered.add(id);
    if (rendered.size !== n) save();
  });
  await ctx.exposeBinding('__rigsmithTestidRecord', (_source, id: string, type: string) => {
    if (typeof id !== 'string' || typeof type !== 'string') return;
    const had = seen.get(id);
    if (had?.has(type)) return;
    seen.set(id, (had ?? new Set()).add(type));
    save();
  });
  await ctx.addInitScript((types: readonly string[]) => {
    const sent = new Set<string>();
    // Rendered ids: scanned whenever nodes are added or a data-testid changes, batched.
    const shown = new Set<string>();
    let pending: string[] = [];
    const note = (el: Element) => {
      const id = el.getAttribute('data-testid');
      if (id && !shown.has(id)) {
        shown.add(id);
        pending.push(id);
      }
    };
    const scan = (root: Element) => {
      note(root);
      for (const el of root.querySelectorAll('[data-testid]')) note(el);
      if (pending.length && !scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    };
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      const batch = pending;
      pending = [];
      void (window as any).__rigsmithTestidRendered?.(batch);
    };
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.target instanceof Element) scan(r.target);
        for (const n of r.addedNodes) if (n instanceof Element) scan(n);
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-testid'] });
    document.addEventListener('DOMContentLoaded', () => scan(document.documentElement));
    for (const type of types)
      document.addEventListener(type, (e) => {
        // Programmatic clicks (app code calling .click()) are untrusted and do not count;
        // input/change may be untrusted because Playwright's selectOption dispatches them.
        if (!e.isTrusted && type !== 'input' && type !== 'change') return;
        const t = e.target as Node | null;
        // A key only exercises a field it types into, not whatever control has focus.
        if (type === 'keydown' && !(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)) return;
        const el = (t instanceof Element ? t : t?.parentElement)?.closest('[data-testid]');
        const id = el?.getAttribute('data-testid');
        if (!id || sent.has(`${id} ${type}`)) return;
        sent.add(`${id} ${type}`);
        void (window as any).__rigsmithTestidRecord?.(id, type);
      }, true);
  }, RECORDED_EVENTS);
}

export interface Probe {
  state(): { mode: string; tool: string; time: number; playing: boolean; animName: string | null; selection: { kind: string; id: string } | null; keySel: unknown; undo: number; redo: number; dirty: boolean };
  project(): any;
  bone(name: string): { origin: { x: number; y: number }; tip: { x: number; y: number }; mid: { x: number; y: number }; world: { x: number; y: number; angle: number } } | null;
  attachment(name: string): { x: number; y: number } | null;
  worldAt(x: number, y: number): { x: number; y: number };
}

/** Calls the read-only window.__rigsmith probe. */
export function probe<T>(page: Page, fn: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([f, a]) => (window as any).__rigsmith[f as string](...(a as unknown[])), [fn, args] as const);
}
