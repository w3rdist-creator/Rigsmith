// Rigsmith headless API (Node). Stable entry points for scripted authoring and export;
// the CLI (scripts/rigsmith.ts) and examples/brand-pipeline are thin wrappers over it.
// Documented in docs/cli.md.
//
// Pure Node (no browser): read / validate / write projects, authoring (images, skins,
// mix rules), runtime JSON, texture atlases. Rasterizing (PNG sequences, transitions,
// media) needs Canvas2D, so `withRenderer` starts headless Chrome for Testing with a
// project-local profile, serves the built `dist/` through request interception (no
// network socket is opened) and loads `render.html` — a dedicated render entry, not the
// editor. The browser is always closed before `withRenderer` returns or throws.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import type { AtlasMeta, AtlasOptions } from '../../src/model/atlas.ts';
import { DEFAULT_ATLAS, atlasItems, atlasMeta, packAtlas, renderAtlasPages } from '../../src/model/atlas.ts';
import type { RuntimeExport } from '../../src/model/exportRuntime.ts';
import { exportRuntime, runtimeProblems } from '../../src/model/exportRuntime.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import { setMixRule } from '../../src/model/mix.ts';
import { dataUrlBytes, decodePngExact, encodePngExact } from '../../src/model/png.ts';
import { addSkin, setSkinEntry } from '../../src/model/skinOps.ts';
import type { ImageAsset, Project } from '../../src/model/types.ts';
import { buildZip } from '../../src/model/zip.ts';
import type { PrepareRequest } from '../../src/render-main.ts';
import { safeName } from '../../src/render/sequence.ts';

export const ROOT = path.resolve(import.meta.dirname, '../..');

/** Exit codes used by the CLI. */
export const EXIT = { ok: 0, invalid: 1, usage: 2, environment: 3, failed: 4 } as const;

export class ApiError extends Error {
  readonly errors: string[];
  readonly code: number;
  constructor(message: string, errors: string[] = [message], code: number = EXIT.invalid) {
    super(message);
    this.errors = errors;
    this.code = code;
  }
}

// ---- Projects --------------------------------------------------------------------------

export function readProject(file: string): Project {
  if (!existsSync(file)) throw new ApiError(`No such file: ${file}`, undefined, EXIT.usage);
  const r = parseProject(readFileSync(file, 'utf8'));
  if (!r.ok) throw new ApiError(`${path.basename(file)} is not a valid Rigsmith project`, r.errors);
  return r.project;
}

/** Writes atomically (temp file + rename) so a failure never leaves a half-written file. */
export function writeOutput(file: string, data: string | Uint8Array): void {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.partial`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export function writeProject(file: string, project: Project): void {
  const text = serializeProject(project);
  const check = parseProject(text);
  if (!check.ok) throw new ApiError('Refusing to write an invalid project', check.errors);
  writeOutput(file, text);
}

export function summary(p: Project) {
  return {
    name: p.name,
    version: p.version,
    bones: p.bones.length,
    attachments: p.attachments.length,
    meshes: p.attachments.filter((a) => a.mesh).length,
    images: p.images.map((i) => `${i.name} ${i.width}×${i.height}`),
    animations: p.animations.map((a) => ({ name: a.name, duration: a.duration, fps: a.fps, loop: a.loop })),
    constraints: { ik: p.ik?.length ?? 0, path: p.pathConstraints?.length ?? 0 },
    skins: (p.skins ?? []).map((s) => s.name),
    mixes: (p.mixes ?? []).length,
  };
}

// ---- Authoring -------------------------------------------------------------------------

async function pngAsset(file: string): Promise<{ width: number; height: number; dataUrl: string }> {
  if (!existsSync(file)) throw new ApiError(`No such image: ${file}`, undefined, EXIT.usage);
  const bytes = new Uint8Array(readFileSync(file));
  let img;
  try {
    img = await decodePngExact(bytes);
  } catch (e) {
    throw new ApiError(`${path.basename(file)}: ${(e as Error).message} (PNG files only)`);
  }
  return { width: img.width, height: img.height, dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` };
}

/** Adds a PNG as a new image (id derived from the name, so scripted runs are reproducible). */
export async function addImage(p: Project, file: string, name = path.basename(file)): Promise<ImageAsset> {
  if (p.images.some((i) => i.name === name)) throw new ApiError(`An image named “${name}” already exists.`);
  const a = await pngAsset(file);
  let id = `img_${safeName(name)}`;
  for (let n = 2; p.images.some((i) => i.id === id); n++) id = `img_${safeName(name)}_${n}`;
  const im: ImageAsset = { id, name, mime: 'image/png', ...a };
  p.images.push(im);
  return im;
}

/**
 * Replaces an image's pixels (same id and name: every attachment, key and skin that uses
 * it follows). The new image must have the same size unless `allowResize`.
 */
export async function replaceImage(p: Project, imageName: string, file: string, allowResize = false): Promise<ImageAsset> {
  const im = p.images.find((i) => i.name === imageName);
  if (!im) throw new ApiError(`No image named “${imageName}”.`);
  const a = await pngAsset(file);
  if (!allowResize && (a.width !== im.width || a.height !== im.height))
    throw new ApiError(`${path.basename(file)} is ${a.width}×${a.height} but “${imageName}” is ${im.width}×${im.height}; pass --allow-resize to accept the change.`);
  Object.assign(im, a, { mime: 'image/png' });
  delete im.derived;
  return im;
}

/**
 * Creates (or extends) a skin. `entries`: attachment name → image name for the setup
 * image; `keyed`: "attachment:fromImage" → image name for keyed images.
 */
export function setSkin(p: Project, skinName: string, entries: Record<string, string>, keyed: Record<string, string> = {}): void {
  let skin = p.skins?.find((s) => s.name === skinName);
  if (!skin) skin = addSkin(p, `skin_${safeName(skinName)}`, skinName);
  if (skin.name !== skinName) throw new ApiError(`Could not create a skin named “${skinName}”.`);
  const att = (n: string) => p.attachments.find((a) => a.name === n) ?? fail(`No attachment named “${n}”.`);
  const img = (n: string) => p.images.find((i) => i.name === n) ?? fail(`No image named “${n}”.`);
  for (const [a, i] of Object.entries(entries)) setSkinEntry(p, skin.id, att(a).id, null, img(i).id);
  for (const [k, i] of Object.entries(keyed)) {
    const [a, from] = k.split(':');
    setSkinEntry(p, skin.id, att(a).id, img(from).id, img(i).id);
  }
}

export function setMix(p: Project, from: string, to: string, duration: number | null): void {
  const id = (n: string) => p.animations.find((a) => a.name === n)?.id ?? fail(`No animation named “${n}”.`);
  if (duration !== null && !(duration >= 0 && duration <= 10)) fail('Mix duration must be 0–10 seconds.');
  setMixRule(p, id(from), id(to), duration);
}

function fail(msg: string): never {
  throw new ApiError(msg);
}

// ---- Data exports (pure Node) -----------------------------------------------------------

export function runtime(p: Project): RuntimeExport {
  const problems = runtimeProblems(p);
  if (problems.length) throw new ApiError('Runtime export needs unique names', problems);
  return exportRuntime(p);
}

export async function atlas(p: Project, o: Partial<AtlasOptions> = {}): Promise<{ meta: AtlasMeta; pages: { file: string; data: Uint8Array }[] }> {
  const opts = { ...DEFAULT_ATLAS, ...o };
  const pixels = new Map<string, Awaited<ReturnType<typeof decodePngExact>>>();
  for (const im of p.images) {
    if (im.mime !== 'image/png') throw new ApiError(`${im.name}: only PNG images can be packed headlessly (${im.mime}).`);
    pixels.set(im.name, await decodePngExact(dataUrlBytes(im.dataUrl)));
  }
  const r = packAtlas(atlasItems(p.images.map((im) => ({ name: im.name, pixels: pixels.get(im.name)! })), opts.trim), opts);
  if (!r.ok) throw new ApiError('Atlas packing failed', r.errors);
  const base = safeName(p.name);
  const file = (i: number) => `${base}-${i}.png`;
  const pages = renderAtlasPages(r.layout, pixels, opts.bleed);
  const out = [];
  for (let i = 0; i < pages.length; i++) out.push({ file: file(i), data: await encodePngExact(pages[i]) });
  return { meta: atlasMeta(r.layout, opts, file), pages: out };
}

export function zip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  return buildZip(entries);
}

// ---- Rendering (headless Chrome for Testing) --------------------------------------------

export const CHROME =
  process.env.RIGSMITH_CFT ??
  '/Users/w3rd/chrome-for-testing/chrome/mac_arm-155.0.8059.39/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ORIGIN = 'http://rigsmith.invalid';
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

export interface SequenceResult {
  meta: { width: number; height: number; fps: number; animation: string; frames: { file: string; time: number; frame: number }[] } & Record<string, unknown>;
  /** PNG frames in order, with their ZIP paths. */
  files: { name: string; data: Uint8Array }[];
}

export interface Renderer {
  /** Renders a sequence or transition exactly like the editor's export dialogs. */
  render(p: Project, req: PrepareRequest, opts?: { onProgress?: (done: number, total: number) => void; isCancelled?: () => boolean }): Promise<SequenceResult>;
}

export async function withRenderer<T>(fn: (r: Renderer) => Promise<T>, opts: { profile?: string } = {}): Promise<T> {
  const dist = path.join(ROOT, 'dist');
  if (!existsSync(path.join(dist, 'render.html'))) throw new ApiError('dist/render.html is missing — run `npm run build` first.', undefined, EXIT.environment);
  if (!existsSync(CHROME)) throw new ApiError(`Chrome for Testing not found at ${CHROME} (set RIGSMITH_CFT).`, undefined, EXIT.environment);
  const profile = path.join(ROOT, '.hermes/browser-profiles', opts.profile ?? 'cli');
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    headless: true,
    // Ctrl+C is a cancel request handled by the caller (which then closes the browser in
    // `finally`); Playwright's default would exit the process immediately with 130.
    handleSIGINT: false,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking'],
  });
  try {
    // Serve dist/ from disk; anything else is refused (no network access at all).
    await ctx.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      const file = path.join(dist, decodeURIComponent(url.pathname));
      if (!file.startsWith(dist + path.sep) || !existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
    });
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${ORIGIN}/render.html`);
    await page.waitForFunction(() => 'rigsmithRender' in window, undefined, { timeout: 15000 });
    let loaded: Project | null = null;
    const renderer: Renderer = {
      async render(p, req, o = {}) {
        if (loaded !== p) {
          const r = await page.evaluate((text) => (window as any).rigsmithRender.load(text), serializeProject(p));
          if (!r.ok) throw new ApiError('The renderer rejected the project', r.errors);
          loaded = p;
        }
        const prep = await page.evaluate((q) => (window as any).rigsmithRender.prepare(q), req as any);
        if (!prep.ok) throw new ApiError('Nothing rendered', prep.errors);
        const files: SequenceResult['files'] = [];
        for (let i = 0; i < prep.frames; i++) {
          if (o.isCancelled?.()) throw new ApiError('Cancelled — nothing was written.', undefined, EXIT.failed);
          const b64: string = await page.evaluate((k) => (window as any).rigsmithRender.frame(k), i);
          files.push({ name: prep.files[i], data: new Uint8Array(Buffer.from(b64, 'base64')) });
          o.onProgress?.(i + 1, prep.frames);
        }
        if (pageErrors.length) throw new ApiError('Renderer error', pageErrors, EXIT.failed);
        return { meta: prep.meta, files };
      },
    };
    return await fn(renderer);
  } finally {
    await ctx.close();
  }
}

/** The editor's sequence ZIP layout: frames + `<anim>/sequence.json`. */
export function sequenceZip(r: SequenceResult): Uint8Array {
  const dir = r.files[0]?.name.split('/')[0] ?? 'sequence';
  return zip([...r.files, { name: `${dir}/sequence.json`, data: new TextEncoder().encode(JSON.stringify(r.meta, null, 1)) }]);
}
