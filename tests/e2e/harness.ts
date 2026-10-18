// Shared e2e harness: an isolated Chrome for Testing instance (dedicated profile under
// .hermes/browser-profiles/, headless, never the user's Chrome) plus a vite preview
// server bound to 127.0.0.1 on a port verified free before use.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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
  return chromium.launchPersistentContext(dir, {
    executablePath: CFT,
    headless: true,
    viewport: opts.viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: opts.deviceScaleFactor,
    acceptDownloads: true,
    downloadsPath: downloads,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', ...extraArgs],
  });
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
