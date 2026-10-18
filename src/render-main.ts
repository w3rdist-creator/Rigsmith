// render.html: the headless rendering entry used by the CLI / Node API
// (scripts/lib/rigsmith-api.ts). Not part of the editor and holds no editor state: it
// receives a project file, prepares a sequence or a transition with the same code as the
// editor's export dialogs, and returns PNG frames one by one. It never modifies the
// project it is given.
import { parseProject } from './model/format.ts';
import type { MissingPolicy } from './model/mix.ts';
import { mixDuration } from './model/mix.ts';
import { sequenceFps } from './model/clipSequence.ts';
import type { SequenceRequest } from './model/sequence.ts';
import { defaultRequest, lastExportFrame } from './model/sequence.ts';
import type { Project, ProjectFrame } from './model/types.ts';
import type { SequenceSetup } from './render/sequence.ts';
import { prepareClipSequence, prepareMixSequence, prepareSequence, renderSequenceFrame, sequenceFileName, sequenceMeta } from './render/sequence.ts';

let project: Project | null = null;
const images = new Map<string, HTMLImageElement>();
let setup: SequenceSetup | null = null;
let request: SequenceRequest | null = null;
const canvas = document.createElement('canvas');

function decode(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('An embedded image could not be decoded.'));
    img.src = url;
  });
}

/** `frame`: a fixed canvas (world rect, e.g. the project frame); absent/null fits the animation. */
export type PrepareRequest =
  | { kind: 'sequence'; anim: string; skin?: string | null; fps?: number; start?: number; end?: number; scale?: number; padding?: number; frame?: ProjectFrame | null }
  | { kind: 'mix'; from: string; to: string; at: number; duration?: number; missing?: MissingPolicy; skin?: string | null; fps?: number; scale?: number; padding?: number; frame?: ProjectFrame | null }
  /** A saved clip sequence by name; fps defaults to the first step's animation fps. */
  | { kind: 'clips'; sequence: string; skin?: string | null; fps?: number; scale?: number; padding?: number; frame?: ProjectFrame | null };

const api = {
  /** Parses and validates a project file and decodes its images. */
  async load(text: string): Promise<{ ok: true } | { ok: false; errors: string[] }> {
    const r = parseProject(text);
    if (!r.ok) return { ok: false, errors: r.errors };
    project = r.project;
    images.clear();
    for (const im of project.images) images.set(im.id, await decode(im.dataUrl));
    return { ok: true };
  },

  /** Prepares frames; names resolve animations / skins. Returns the sequence metadata or errors. */
  prepare(req: PrepareRequest): { ok: true; frames: number; meta: unknown; files: string[]; warnings: string[] } | { ok: false; errors: string[] } {
    const p = project;
    if (!p) return { ok: false, errors: ['No project loaded.'] };
    const animId = (name: string) => p.animations.find((a) => a.name === name)?.id ?? null;
    let skinId: string | null = null;
    if (req.skin) {
      skinId = p.skins?.find((s) => s.name === req.skin)?.id ?? null;
      if (!skinId) return { ok: false, errors: [`No skin named “${req.skin}”.`] };
    }
    if (req.kind === 'sequence') {
      const id = animId(req.anim);
      if (!id) return { ok: false, errors: [`No animation named “${req.anim}”.`] };
      const anim = p.animations.find((a) => a.id === id)!;
      const d = defaultRequest(anim);
      const fps = req.fps ?? d.fps;
      request = { fps, start: req.start ?? 0, end: req.end ?? lastExportFrame(anim, fps), scale: req.scale ?? d.scale, padding: req.padding ?? d.padding, frame: req.frame ?? null };
      const r = prepareSequence(p, id, request, skinId);
      if (!r.ok) return r;
      setup = r.setup;
    } else if (req.kind === 'clips') {
      const seq = p.sequences?.find((q) => q.name === req.sequence);
      if (!seq) return { ok: false, errors: [`No sequence named “${req.sequence}”.`] };
      const fps = req.fps ?? sequenceFps(p, seq);
      const r = prepareClipSequence(p, seq, fps, skinId, req.scale ?? 1, req.padding ?? 4, req.frame ?? null);
      if (!r.ok) return r;
      setup = r.setup;
      request = { fps, start: 0, end: r.setup.plan.lastFrame, scale: req.scale ?? 1, padding: req.padding ?? 4, frame: req.frame ?? null };
    } else {
      const from = animId(req.from), to = animId(req.to);
      if (!from || !to) return { ok: false, errors: [`No animation named “${!from ? req.from : req.to}”.`] };
      const fps = req.fps ?? p.animations.find((a) => a.id === from)!.fps;
      const plan = { entries: [{ animId: from, start: 0, mix: 0 }, { animId: to, start: req.at, mix: req.duration ?? mixDuration(p, from, to) }], missing: req.missing ?? 'setup' };
      const r = prepareMixSequence(p, plan, fps, skinId, req.scale ?? 1, req.padding ?? 4, req.frame ?? null);
      if (!r.ok) return r;
      setup = r.setup;
      request = { fps, start: 0, end: r.setup.plan.lastFrame, scale: req.scale ?? 1, padding: req.padding ?? 4, frame: req.frame ?? null };
    }
    return { ok: true, frames: setup.frames.length, meta: sequenceMeta(p, setup, request), files: setup.frames.map((_, i) => sequenceFileName(setup!, i)), warnings: setup.warnings };
  },

  /** PNG bytes (base64) of prepared frame i, drawn exactly as the editor's sequence export draws it. */
  async frame(i: number): Promise<string> {
    if (!setup) throw new Error('Nothing prepared.');
    canvas.width = setup.geometry.width;
    canvas.height = setup.geometry.height;
    renderSequenceFrame(canvas.getContext('2d')!, setup, i, (im) => images.get(im.id) ?? null);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG encoding failed.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
    return btoa(bin);
  },
};

Object.defineProperty(window, 'rigsmithRender', { value: Object.freeze(api) });
document.title = 'Rigsmith render (ready)';
