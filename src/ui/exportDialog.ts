// "Export sequence…" dialog: range / FPS / scale / padding, endpoint policy, stable
// bounds, first/last frame preview, progress with cancel, visible errors. Output format:
// the PNG-sequence ZIP (default, the reliable alpha path) or one animated file made from
// the same PNG frames (APNG: lossless, full alpha; GIF: 256 colours, 1-bit alpha).
import type { MediaFormat, MediaStats } from '../model/media.ts';
import { GIF_MAX_FPS, MediaCancelled, encodeAnimated, gifDelays, mediaErrors } from '../model/media.ts';
import type { SequenceRequest } from '../model/sequence.ts';
import { defaultRequest, lastExportFrame } from '../model/sequence.ts';
import { cloneProject } from '../model/types.ts';
import type { Project } from '../model/types.ts';
import { Cancelled, encodeSequenceZip, prepareSequence, renderSequenceFrame, safeName } from '../render/sequence.ts';
import type { SequenceSetup } from '../render/sequence.ts';
import type { App } from './app.ts';
import { download } from './app.ts';
import { clear, h } from './dom.ts';

export class ExportDialog {
  private app: App;
  private dlg: HTMLDialogElement;
  private body: HTMLElement;
  private running = false;
  private cancelled = false;
  private req: SequenceRequest | null = null;
  private animId: string | null = null;
  private snapshot: Project | null = null;
  private format: 'zip' | MediaFormat = 'zip';

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'export-body' });
    this.dlg = h('dialog', { class: 'help export', 'data-testid': 'export-dialog', 'aria-label': 'Export sequence' }, h('h2', {}, 'Export sequence (PNG ZIP, APNG or GIF)'), this.body) as HTMLDialogElement;
    this.dlg.addEventListener('cancel', (e) => {
      // Esc: cancel a running export rather than closing over it.
      if (this.running) {
        e.preventDefault();
        this.cancelled = true;
      }
    });
    document.body.append(this.dlg);
  }

  open(): void {
    const ed = this.app.ed;
    const anim = ed.anim() ?? ed.project.animations[0] ?? null;
    this.snapshot = cloneProject(ed.project);
    this.animId = anim?.id ?? null;
    this.req = anim ? defaultRequest(anim) : { fps: 30, start: 0, end: 0, scale: 1, padding: 4 };
    this.render();
    this.dlg.showModal();
  }

  private render(): void {
    const p = this.snapshot!;
    const req = this.req!;
    clear(this.body);
    const anim = p.animations.find((a) => a.id === this.animId) ?? null;
    const num = (testId: string, label: string, value: number, step: number, set: (v: number) => void) => {
      const input = h('input', { type: 'number', step, value: String(value), 'data-testid': testId, 'aria-label': label, class: 'w-num' });
      input.addEventListener('change', () => {
        set(Number(input.value));
        this.render();
      });
      return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input);
    };
    const animSel = h('select', { 'data-testid': 'seq-anim', 'aria-label': 'Animation to export' }, ...p.animations.map((a) => h('option', { value: a.id }, a.name)));
    if (anim) animSel.value = anim.id;
    animSel.addEventListener('change', () => {
      this.animId = animSel.value;
      const a = p.animations.find((x) => x.id === this.animId);
      if (a) this.req = { ...defaultRequest(a), scale: this.req!.scale, padding: this.req!.padding };
      this.render();
    });
    const skins = p.skins ?? [];
    const skinSel = h('select', { 'data-testid': 'seq-skin', 'aria-label': 'Skin' }, h('option', { value: '' }, '(no skin)'), ...skins.map((s) => h('option', { value: s.id }, s.name)));
    skinSel.value = this.app.ed.skinId ?? '';
    // Exports use the editor's active skin; choosing here switches it (view state).
    skinSel.addEventListener('change', () => {
      this.app.ed.setSkin(skinSel.value || null);
      this.render();
    });

    const prepared = prepareSequence(p, this.animId, req, this.app.ed.skinId);
    const errors = [...(prepared.ok ? [] : prepared.errors), ...(this.format === 'zip' ? [] : mediaErrors(this.format, req.fps))];
    const formatSel = h('select', { 'data-testid': 'seq-format', 'aria-label': 'Output format' },
      h('option', { value: 'zip' }, 'PNG sequence (ZIP)'),
      h('option', { value: 'apng' }, 'Animated PNG (APNG)'),
      h('option', { value: 'gif' }, 'GIF'));
    formatSel.value = this.format;
    formatSel.addEventListener('change', () => {
      this.format = formatSel.value as 'zip' | MediaFormat;
      this.render();
    });
    const plays = anim?.loop ? 'loops forever' : 'plays once';
    const cs = gifDelays(Math.min(6, req.fps > 0 ? req.fps : 1), req.fps > 0 ? req.fps : 1).join('/');
    const formatNote = {
      zip: 'One transparent PNG per frame + sequence.json. Full 8-bit alpha, lossless. The reliable path for alpha.',
      apng: `One file, the PNG frames exactly (lossless, full 8-bit alpha), 1/${req.fps} s per frame, ${plays}. Verified in Rigsmith’s test suite with Pillow, ffmpeg and Chrome for Testing; other players not tested.`,
      gif: `One file, one 256-colour palette (no dithering) and 1-bit alpha: pixels with alpha ≥ 50% become opaque, the rest transparent (soft edges lose their blend; the count is reported). Delays are whole 1/100 s (${cs} cs…), up to ${GIF_MAX_FPS} fps, ${plays}. Verified in Rigsmith’s test suite with Pillow, ffmpeg and Chrome for Testing; other players not tested.`,
    }[this.format];
    const last = anim ? lastExportFrame(anim, Number.isInteger(req.fps) && req.fps > 0 ? req.fps : anim.fps) : 0;
    const policy = anim
      ? anim.loop
        ? `Looping: frames 0–${last} at ${req.fps} fps. Frame ${last + 1} is the loop point (it repeats frame 0) and is not exported.`
        : `One-shot: frames 0–${last} at ${req.fps} fps, including the final pose at frame ${last}.`
      : '';
    const summary = prepared.ok ? `${prepared.setup.frames.length} frames · ${prepared.setup.geometry.width}×${prepared.setup.geometry.height} px · transparent background · one size for every frame (union of all poses + ${req.padding}px padding)` : '';
    const progress = h('progress', { max: 1, value: 0, 'data-testid': 'seq-progress' });
    const progressText = h('span', { class: 'dim', 'data-testid': 'seq-progress-text' }, '');
    const first = h('canvas', { class: 'seq-preview', 'data-testid': 'seq-preview-first', 'aria-label': 'First frame preview' });
    const lastC = h('canvas', { class: 'seq-preview', 'data-testid': 'seq-preview-last', 'aria-label': 'Last frame preview' });
    const exportBtn = h('button', { class: 'accent', 'data-testid': 'seq-export', disabled: !prepared.ok || errors.length > 0 }, { zip: 'Export ZIP', apng: 'Export APNG', gif: 'Export GIF' }[this.format]);
    const cancelBtn = h('button', { 'data-testid': 'seq-cancel' }, 'Cancel');
    exportBtn.addEventListener('click', () => prepared.ok && !errors.length && void this.run(prepared.setup, progress, progressText, exportBtn));
    cancelBtn.addEventListener('click', () => {
      if (this.running) this.cancelled = true;
      else this.dlg.close();
    });
    this.body.append(
      h('div', { class: 'row2' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Animation'), animSel), h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Skin (from the editor)'), skinSel)),
      h('div', { class: 'export-grid' },
        num('seq-fps', 'FPS', req.fps, 1, (v) => {
          this.req = { ...this.req!, fps: v };
          if (anim && Number.isInteger(v) && v >= 1 && v <= 240) this.req.end = lastExportFrame(anim, v);
        }),
        num('seq-start', 'Start frame', req.start, 1, (v) => void (this.req = { ...this.req!, start: v })),
        num('seq-end', 'End frame', req.end, 1, (v) => void (this.req = { ...this.req!, end: v })),
        num('seq-scale', 'Scale', req.scale, 0.25, (v) => void (this.req = { ...this.req!, scale: v })),
        num('seq-padding', 'Padding px', req.padding, 1, (v) => void (this.req = { ...this.req!, padding: v })),
      ),
      h('div', { class: 'row2' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Format'), formatSel), h('p', { class: 'hint', 'data-testid': 'seq-format-note' }, formatNote)),
      h('p', { class: 'hint', 'data-testid': 'seq-policy' }, policy),
      errors.length ? h('ul', { class: 'errors', role: 'alert', 'data-testid': 'seq-errors' }, ...errors.map((e) => h('li', {}, e))) : h('p', { class: 'hint', 'data-testid': 'seq-summary' }, summary),
      h('div', { class: 'seq-previews' }, h('figure', {}, first, h('figcaption', {}, 'first')), h('figure', {}, lastC, h('figcaption', {}, 'last'))),
      h('div', { class: 'export-actions' }, progress, progressText, h('span', { class: 'tb-spacer' }), cancelBtn, exportBtn),
    );
    if (prepared.ok) {
      this.preview(first, prepared.setup, 0);
      this.preview(lastC, prepared.setup, prepared.setup.frames.length - 1);
    }
  }

  private preview(c: HTMLCanvasElement, setup: SequenceSetup, i: number): void {
    const { width, height } = setup.geometry;
    const s = Math.min(1, 220 / width, 160 / height);
    c.width = Math.max(1, Math.round(width * s));
    c.height = Math.max(1, Math.round(height * s));
    const off = document.createElement('canvas');
    off.width = width;
    off.height = height;
    renderSequenceFrame(off.getContext('2d')!, setup, i, (im) => this.app.images.get(im));
    const g = c.getContext('2d')!;
    g.drawImage(off, 0, 0, c.width, c.height);
    c.dataset.frame = String(setup.plan.frames[i]);
  }

  private async run(setup: SequenceSetup, progress: HTMLProgressElement, text: HTMLElement, btn: HTMLButtonElement): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    btn.disabled = true;
    const p = this.snapshot!;
    const canvas = document.createElement('canvas');
    const toPng = () => new Promise<Uint8Array>((resolve, reject) => canvas.toBlob((b) => (b ? b.arrayBuffer().then((x) => resolve(new Uint8Array(x)), reject) : reject(new Error('PNG encoding failed'))), 'image/png'));
    try {
      if (this.format !== 'zip') {
        await this.runMedia(this.format, setup, canvas, toPng, progress, text);
        return;
      }
      const zip = await encodeSequenceZip(
        p,
        setup,
        this.req!,
        (im) => this.app.images.get(im),
        canvas,
        toPng,
        (done, total) => {
          progress.value = done / total;
          text.textContent = `${done} / ${total}`;
        },
        () => this.cancelled,
      );
      const name = `${safeName(p.name)}-${safeName(setup.anim.name)}-${this.req!.fps}fps.zip`;
      download(new Blob([zip as BlobPart], { type: 'application/zip' }), name);
      this.app.status(`Exported ${setup.frames.length} transparent PNG frames (${setup.geometry.width}×${setup.geometry.height}) as ${name}.`);
      this.dlg.close();
    } catch (e) {
      if (e instanceof Cancelled || e instanceof MediaCancelled) {
        text.textContent = 'Cancelled — nothing was saved.';
        progress.value = 0;
        this.app.status(`${this.format === 'zip' ? 'Sequence' : this.format.toUpperCase()} export cancelled; nothing was saved.`);
      } else {
        this.app.error('Sequence export failed', [(e as Error).message]);
      }
    } finally {
      this.running = false;
      btn.disabled = false;
    }
  }

  /** Renders the PNG frames (same as the ZIP), then encodes them as one animated file. */
  private async runMedia(format: MediaFormat, setup: SequenceSetup, canvas: HTMLCanvasElement, toPng: () => Promise<Uint8Array>, progress: HTMLProgressElement, text: HTMLElement): Promise<void> {
    const p = this.snapshot!;
    canvas.width = setup.geometry.width;
    canvas.height = setup.geometry.height;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('Could not create a 2D canvas for export.');
    const total = setup.frames.length;
    const pngs: Uint8Array[] = [];
    for (let i = 0; i < total; i++) {
      if (this.cancelled) throw new Cancelled();
      renderSequenceFrame(g, setup, i, (im) => this.app.images.get(im));
      pngs.push(await toPng());
      progress.value = (i + 1) / (total * 2);
      text.textContent = `rendering ${i + 1} / ${total}`;
    }
    const { bytes, stats } = await encodeAnimated(format, total, (i) => pngs[i], {
      fps: this.req!.fps,
      loop: setup.anim.loop,
      isCancelled: () => this.cancelled,
      onProgress: (done, all) => {
        progress.value = 0.5 + done / all / 2;
        text.textContent = `encoding ${done} / ${all}`;
      },
    });
    const ext = format === 'apng' ? 'apng' : 'gif';
    const name = `${safeName(p.name)}-${safeName(setup.anim.name)}-${this.req!.fps}fps.${ext}`;
    download(new Blob([bytes as BlobPart], { type: format === 'apng' ? 'image/apng' : 'image/gif' }), name);
    this.app.status(`Exported ${total} frames (${stats.width}×${stats.height}) as ${name}. ${mediaSummary(stats)}`);
    this.dlg.close();
  }
}

export function mediaSummary(s: MediaStats): string {
  if (s.format === 'apng') return 'APNG: lossless, full alpha.';
  return `GIF: ${s.paletteColours} colours (${s.exactColours ? 'exact' : 'reduced, no dithering'}); ${s.partialAlphaPixels} of ${s.totalPixels} px had partial alpha and became binary (${s.partialToOpaque} opaque, ${s.partialToTransparent} transparent).`;
}
