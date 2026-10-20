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
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import type { AtlasMeta, AtlasOptions } from '../../src/model/atlas.ts';
import { DEFAULT_ATLAS, atlasItems, atlasMeta, packAtlas, renderAtlasPages } from '../../src/model/atlas.ts';
import type { RuntimeExport } from '../../src/model/exportRuntime.ts';
import { exportRuntime, runtimeProblems } from '../../src/model/exportRuntime.ts';
import { parseProject, serializeProject } from '../../src/model/format.ts';
import type { MediaFormat } from '../../src/model/media.ts';
import { MediaCancelled, encodeAnimated, mediaErrors } from '../../src/model/media.ts';
import type { LimbSpec } from '../../src/model/limbWeights.ts';
import { limbWeights, mirrorWeights, smoothWeights, suffixBoneMap } from '../../src/model/limbWeights.ts';
import { autoWeights, gridPoints, meshSummary, setMesh, triangulate } from '../../src/model/meshOps.ts';
import { setMixRule } from '../../src/model/mix.ts';
import { addAimConstraint, addRotationConstraint, constraintNames } from '../../src/model/rigOps.ts';
import { dataUrlBytes, decodePngExact, encodePngExact } from '../../src/model/png.ts';
import { addSkin, setSkinEntry } from '../../src/model/skinOps.ts';
import type { ClipSequence, ImageAsset, Project } from '../../src/model/types.ts';
import { newId } from '../../src/model/types.ts';
import { parseStepList } from '../../src/model/clipSequence.ts';
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
    constraints: { ik: p.ik?.length ?? 0, path: p.pathConstraints?.length ?? 0, transform: p.transformConstraints?.length ?? 0 },
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

/** Creates or replaces the saved clip sequence `name` (steps: "idle*2,greeting,idle"). */
export function setSequence(p: Project, name: string, stepList: string, loop: boolean): ClipSequence {
  if (!name.trim()) fail('The sequence needs a name.');
  const r = parseStepList(p, stepList);
  if (!r.ok) throw new ApiError(r.errors[0], r.errors);
  const existing = p.sequences?.find((q) => q.name === name);
  const seq: ClipSequence = { id: existing?.id ?? newId('seq'), name, steps: r.steps, loop };
  p.sequences = [...(p.sequences ?? []).filter((q) => q !== existing), seq];
  return seq;
}

// ---- Meshes and weights (R1) ----------------------------------------------------------

function attachmentNamed(p: Project, name: string) {
  return p.attachments.find((a) => a.name === name) ?? fail(`No attachment named “${name}”.`);
}
export type TransformRequest =
  | { kind: 'rotation'; bone: string; source: string; factor: number; offset: number; mitre?: { k: number; max: number }; name?: string; mix: number }
  | { kind: 'aim'; bone: string; angle: number | 'hold'; relativeTo?: string; name?: string; mix: number };

/**
 * Adds a transform constraint (bone names). Rotation: offset + factor × the source's bend
 * (offset default 0, like a joint helper). Aim: the held world angle, or 'hold' = the
 * bone's current setup angle (relative to `relativeTo`'s).
 */
export function addTransform(p: Project, req: TransformRequest): { name: string; kind: string; angle: number } {
  if (!(req.mix >= 0 && req.mix <= 1)) fail('--mix must be between 0 and 1.');
  if (req.name && constraintNames(p).includes(req.name)) fail(`A constraint named “${req.name}” already exists.`);
  const bone = boneNamed(p, req.bone);
  const id = `tc_${p.bones.find((b) => b.id === bone)!.name}_${(p.transformConstraints?.length ?? 0) + 1}`;
  let tc;
  if (req.kind === 'rotation') {
    const src = boneNamed(p, req.source);
    if (src === bone) fail('A bone cannot copy its own rotation.');
    if (req.mitre && !(req.mitre.k >= 0 && req.mitre.max >= 1)) fail('--mitre expects <k ≥ 0>:<max ≥ 1>.');
    tc = addRotationConstraint(p, id, bone, src, req.factor)!;
    tc.angle = req.offset;
    if (req.mitre) tc.mitre = { ...req.mitre };
  } else {
    const rel = req.relativeTo ? boneNamed(p, req.relativeTo) : null;
    if (rel === bone) fail('A bone cannot aim relative to itself.');
    tc = addAimConstraint(p, id, bone, rel)!;
    if (req.angle !== 'hold') tc.angle = req.angle;
  }
  tc.mix = req.mix;
  if (req.name) tc.name = req.name;
  return { name: tc.name, kind: tc.kind, angle: tc.angle };
}

function boneNamed(p: Project, name: string): string {
  return p.bones.find((b) => b.name === name)?.id ?? fail(`No bone named “${name}”.`);
}

/** Replaces an attachment's mesh with an outline + cols×rows interior grid (weights and deform keys reset). */
export function gridMesh(p: Project, attName: string, cols: number, rows: number): string {
  if (!(Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && rows >= 1 && cols * rows <= 4096)) fail('Grid must be whole numbers ≥ 1 with at most 4096 cells.');
  const att = attachmentNamed(p, attName);
  if (!att.imageId) fail(`${attName} has no image.`);
  const im = p.images.find((i) => i.id === att.imageId)!;
  const g = gridPoints(im.width, im.height, cols, rows);
  let mesh;
  try {
    mesh = triangulate(g.hull, g.interior);
  } catch (e) {
    fail(`${attName}: ${(e as Error).message}`);
  }
  setMesh(p, att.id, mesh);
  return meshSummary(mesh);
}

export type WeightRequest =
  | { kind: 'auto'; bones: string[]; maxInfluences?: number }
  | { kind: 'limb'; upper: string; lower: string; helper?: string; band: LimbSpec['band']; end?: { bone: string; at: number; band: number; max: number }; root?: { bone: string; from: number; to: number } }
  | { kind: 'mirror'; from: string; swap: [string, string] }
  | { kind: 'none' };

/** Sets an attachment's weights (bone and attachment names, not ids), then optionally smooths them. */
export function setWeights(p: Project, attName: string, req: WeightRequest, smooth?: { passes: number; amount?: number }): { vertices: number; maxInfluences: number } {
  const att = attachmentNamed(p, attName);
  if (!att.mesh) fail(`${attName} has no mesh (create one with \`mesh\` first).`);
  try {
    if (req.kind === 'auto') {
      if (!req.bones.length) fail('Auto weights need at least one bone.');
      att.mesh.weights = autoWeights(p, att, req.bones.map((b) => boneNamed(p, b)), req.maxInfluences ?? 2);
    } else if (req.kind === 'limb') {
      att.mesh.weights = limbWeights(p, att, {
        upper: boneNamed(p, req.upper), lower: boneNamed(p, req.lower),
        ...(req.helper ? { helper: boneNamed(p, req.helper) } : {}),
        band: req.band,
        ...(req.end ? { end: { ...req.end, bone: boneNamed(p, req.end.bone) } } : {}),
        ...(req.root ? { root: { ...req.root, bone: boneNamed(p, req.root.bone) } } : {}),
      });
    } else if (req.kind === 'mirror') {
      att.mesh.weights = mirrorWeights(attachmentNamed(p, req.from), att, suffixBoneMap(p, req.swap[0], req.swap[1]));
    } else if (!att.mesh.weights) fail(`${attName} has no weights to smooth.`);
    if (smooth) att.mesh.weights = smoothWeights(att, smooth.passes, smooth.amount);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    fail(`${attName}: ${(e as Error).message}`);
  }
  const w = att.mesh.weights!;
  return { vertices: w.length, maxInfluences: Math.max(...w.map((l) => l.length)) };
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
  /** Non-blocking notices, e.g. art clipped by a fixed frame. */
  warnings: string[];
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
        return { meta: prep.meta, files, warnings: prep.warnings ?? [] };
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

// ---- Animated media -------------------------------------------------------------------
// APNG / GIF: the same pure-TS encoders as the editor (src/model/media.ts) over the
// rendered PNG frames. WebM (VP9 + alpha) / MP4 (H.264, no alpha): encoded by the local
// ffmpeg if it exists and has the encoder (exit 3 otherwise); single-threaded bitexact
// settings so repeated runs on one machine give the same bytes.

export type CliMediaFormat = MediaFormat | 'webm' | 'mp4';
export const FFMPEG = process.env.RIGSMITH_FFMPEG ?? 'ffmpeg';

export function ffmpegEncoder(format: 'webm' | 'mp4'): string {
  const enc = format === 'webm' ? 'libvpx-vp9' : 'libx264';
  const r = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', maxBuffer: 16 << 20 });
  if (r.status !== 0 || r.error) throw new ApiError(`${format.toUpperCase()} needs ffmpeg (not found as “${FFMPEG}”; set RIGSMITH_FFMPEG). APNG, GIF and the PNG sequence need nothing extra.`, undefined, EXIT.environment);
  if (!new RegExp(`\\s${enc}\\s`).test(r.stdout)) throw new ApiError(`This ffmpeg has no ${enc} encoder, needed for ${format.toUpperCase()}.`, undefined, EXIT.environment);
  return enc;
}

export function mediaLabel(format: CliMediaFormat, loop: boolean, background?: string): string {
  const plays = loop ? 'loops forever' : 'plays once';
  switch (format) {
    case 'apng':
      return `APNG: lossless, full 8-bit alpha, ${plays}`;
    case 'gif':
      return `GIF: 256-colour palette, 1-bit alpha (α ≥ 128 opaque), centisecond delays, ${plays}`;
    case 'webm':
      return 'WebM VP9 (yuva420p): lossy, 8-bit alpha; no loop flag in the file (the player decides); alpha verified by ffmpeg libvpx-vp9 decode on this machine';
    case 'mp4':
      return `MP4 H.264 (yuv420p): lossy, NO alpha — composited on ${background}; padded to even width/height; no loop flag`;
  }
}

export async function encodeMedia(r: SequenceResult, format: CliMediaFormat, out: string, o: { background?: string; isCancelled?: () => boolean; onProgress?: (d: number, t: number) => void } = {}): Promise<{ stats: Record<string, unknown> }> {
  const fps = r.meta.fps;
  const loop = !!r.meta.loop;
  if (format === 'apng' || format === 'gif') {
    const errors = mediaErrors(format, fps);
    if (errors.length) throw new ApiError(errors[0], errors);
    try {
      const { bytes, stats } = await encodeAnimated(format, r.files.length, (i) => r.files[i].data, { fps, loop, isCancelled: o.isCancelled, onProgress: o.onProgress });
      writeOutput(out, bytes);
      return { stats: { ...stats, label: mediaLabel(format, loop) } };
    } catch (e) {
      if (e instanceof MediaCancelled) throw new ApiError('Cancelled — nothing was written.', undefined, EXIT.failed);
      throw e;
    }
  }
  const enc = ffmpegEncoder(format);
  const bg = o.background ?? '#ffffff';
  if (!/^#[0-9a-f]{6}$/i.test(bg)) throw new ApiError(`--background must be #rrggbb (got “${bg}”).`, undefined, EXIT.usage);
  const { width: w, height: h } = r.meta;
  const codec =
    format === 'webm'
      ? ['-c:v', enc, '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '18', '-deadline', 'good', '-cpu-used', '1', '-row-mt', '0', '-auto-alt-ref', '0']
      : ['-filter_complex', `color=c=0x${bg.slice(1)}:s=${w}x${h}:r=${fps}[bg];[bg][0:v]overlay=shortest=1:format=auto,pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=0x${bg.slice(1)},format=yuv420p`, '-c:v', enc, '-preset', 'medium', '-crf', '16', '-x264-params', 'threads=1', '-movflags', '+faststart'];
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const tmp = `${out}.partial`;
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', ...codec, '-threads', '1', '-r', String(fps), '-fflags', '+bitexact', '-flags', '+bitexact', '-f', format, tmp];
  const child = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', (c) => (stderr += c.toString()));
  const done = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(-1));
  });
  child.stdin!.on('error', () => undefined);
  let cancelled = false;
  for (let i = 0; i < r.files.length; i++) {
    if (o.isCancelled?.()) {
      cancelled = true;
      break;
    }
    if (!child.stdin!.write(r.files[i].data)) await new Promise<void>((res) => child.stdin!.once('drain', res));
    o.onProgress?.(i + 1, r.files.length);
  }
  if (cancelled) child.kill('SIGKILL');
  else child.stdin!.end();
  // Ctrl+C while ffmpeg is still encoding (after the last frame was piped) also cancels.
  const code = await new Promise<number | null>((resolve) => {
    const poll = setInterval(() => {
      if (!cancelled && o.isCancelled?.()) {
        cancelled = true;
        child.kill('SIGKILL');
      }
    }, 50);
    void done.then((c) => {
      clearInterval(poll);
      resolve(c);
    });
  });
  if (!cancelled && o.isCancelled?.()) cancelled = true;
  if (cancelled || code !== 0) {
    rmSync(tmp, { force: true });
    if (cancelled) throw new ApiError('Cancelled — nothing was written.', undefined, EXIT.failed);
    throw new ApiError(`ffmpeg failed (exit ${code})`, stderr.trim().split('\n').slice(-5), EXIT.failed);
  }
  renameSync(tmp, out);
  return { stats: { format, frames: r.files.length, width: format === 'mp4' ? w + (w % 2) : w, height: format === 'mp4' ? h + (h % 2) : h, encoder: enc, label: mediaLabel(format, loop, bg), ...(format === 'mp4' ? { background: bg } : {}) } };
}
