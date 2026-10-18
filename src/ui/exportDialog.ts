// "Export sequence…" dialog: range / FPS / scale / padding, endpoint policy, stable
// bounds, first/last frame preview, progress with cancel, visible errors.
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

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'export-body' });
    this.dlg = h('dialog', { class: 'help export', 'data-testid': 'export-dialog', 'aria-label': 'Export PNG sequence' }, h('h2', {}, 'Export PNG sequence'), this.body) as HTMLDialogElement;
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

    const prepared = prepareSequence(p, this.animId, req, this.app.ed.skinId);
    const errors = prepared.ok ? [] : prepared.errors;
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
    const exportBtn = h('button', { class: 'accent', 'data-testid': 'seq-export', disabled: !prepared.ok }, 'Export ZIP');
    const cancelBtn = h('button', { 'data-testid': 'seq-cancel' }, 'Cancel');
    exportBtn.addEventListener('click', () => prepared.ok && void this.run(prepared.setup, progress, progressText, exportBtn));
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
      h('p', { class: 'hint', 'data-testid': 'seq-policy' }, policy),
      errors.length ? h('ul', { class: 'errors', role: 'alert', 'data-testid': 'seq-errors' }, ...errors.map((e) => h('li', {}, e))) : h('p', { class: 'hint', 'data-testid': 'seq-summary' }, summary),
      h('div', { class: 'seq-previews' }, h('figure', {}, first, h('figcaption', {}, 'first')), h('figure', {}, lastC, h('figcaption', {}, 'last'))),
      h('div', { class: 'export-actions' }, progress, progressText, h('span', { class: 'tb-spacer' }), cancelBtn, exportBtn),
    );
    skinSel.disabled = true;
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
    try {
      const zip = await encodeSequenceZip(
        p,
        setup,
        this.req!,
        (im) => this.app.images.get(im),
        canvas,
        () => new Promise<Uint8Array>((resolve, reject) => canvas.toBlob((b) => (b ? b.arrayBuffer().then((x) => resolve(new Uint8Array(x)), reject) : reject(new Error('PNG encoding failed'))), 'image/png')),
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
      if (e instanceof Cancelled) {
        text.textContent = 'Cancelled — nothing was saved.';
        progress.value = 0;
        this.app.status('Sequence export cancelled; nothing was saved.');
      } else {
        this.app.error('Sequence export failed', [(e as Error).message]);
      }
    } finally {
      this.running = false;
      btn.disabled = false;
    }
  }
}
