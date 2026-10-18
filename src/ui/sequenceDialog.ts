// "Sequences…" dialog (RV-009): saved clip sequences — ordered clips with repeat counts,
// the stored mix durations between them, a frame-accurate preview and export as a PNG
// ZIP, APNG or GIF (same frames as the CLI `sequence` command). Edits to the saved
// sequence and to mix durations are undoable project edits; FPS, canvas and format are
// export settings of this dialog.
import { describeSequence, scheduleSequence, sequenceFps } from '../model/clipSequence.ts';
import type { MediaFormat } from '../model/media.ts';
import { GIF_MAX_FPS, MediaCancelled, encodeAnimated, mediaErrors } from '../model/media.ts';
import { DEFAULT_MIX, mixDuration, setMixRule } from '../model/mix.ts';
import { uniqueName } from '../model/ops.ts';
import type { ClipSequence, Project } from '../model/types.ts';
import { SEQUENCE_MAX_REPEAT, newId } from '../model/types.ts';
import { Cancelled, encodeSequenceZip, exportContext, prepareClipSequence, renderSequenceFrame, safeName } from '../render/sequence.ts';
import type { SequenceSetup } from '../render/sequence.ts';
import type { App } from './app.ts';
import { download } from './app.ts';
import { clear, h } from './dom.ts';
import { frameSelect, frameWarning, mediaSummary } from './exportDialog.ts';

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

export class SequenceDialog {
  private app: App;
  private dlg: HTMLDialogElement;
  private body: HTMLElement;
  private seqId: string | null = null;
  private fps = 30;
  private scale = 1;
  private format: 'zip' | MediaFormat = 'zip';
  private frameMode: 'project' | 'fit' = 'fit';
  private index = 0;
  private running = false;
  private cancelled = false;
  private staleAfterRun = false;

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'export-body' });
    this.dlg = h('dialog', { class: 'help export mix', 'data-testid': 'sequence-dialog', 'aria-label': 'Clip sequences' }, h('h2', {}, 'Clip sequences'), this.body) as HTMLDialogElement;
    this.dlg.addEventListener('cancel', (e) => {
      if (this.running) {
        e.preventDefault();
        this.cancelled = true;
      }
    });
    document.body.append(this.dlg);
    // Undo/redo (Ctrl/⌘+Z with focus on a dialog button) and loads change the project under
    // the open dialog: re-render from the project, never during an export (its frames are
    // already prepared and a rebuilt Close button would lose its cancel click).
    app.ed.subscribe((r) => {
      if (!this.dlg.open || (r !== 'project' && r !== 'load')) return;
      if (this.running) this.staleAfterRun = true;
      else this.render();
    });
  }

  open(): void {
    const p = this.app.ed.project;
    if (!p.sequences?.some((q) => q.id === this.seqId)) this.seqId = p.sequences?.[0]?.id ?? null;
    const seq = this.current();
    this.fps = seq ? sequenceFps(p, seq) : (this.app.ed.anim()?.fps ?? 30);
    this.frameMode = p.frame ? 'project' : 'fit';
    this.index = 0;
    this.render();
    this.dlg.showModal();
  }

  private current(): ClipSequence | null {
    return this.app.ed.project.sequences?.find((q) => q.id === this.seqId) ?? null;
  }

  /** One undoable edit of the current sequence. */
  private edit(label: string, fn: (q: ClipSequence, p: Project) => void): void {
    const id = this.seqId;
    this.app.ed.mutate(label, (p) => {
      const q = p.sequences?.find((x) => x.id === id);
      if (q) fn(q, p);
    });
    this.render();
  }

  private createSequence(): void {
    const ed = this.app.ed;
    const p = ed.project;
    const first = ed.anim() ?? p.animations[0];
    const id = newId('seq');
    ed.mutate('New sequence', (q) => {
      q.sequences = [...(q.sequences ?? []), { id, name: uniqueName((q.sequences ?? []).map((x) => x.name), 'sequence'), steps: first ? [{ animId: first.id, repeat: 1 }] : [], loop: false }];
    });
    this.seqId = id;
    this.fps = first?.fps ?? this.fps;
    this.index = 0;
    this.render();
  }

  private render(): void {
    const ed = this.app.ed;
    const p = ed.project;
    clear(this.body);
    // The shown sequence may have been removed by undo/redo or a load.
    if (!p.sequences?.some((q) => q.id === this.seqId)) this.seqId = p.sequences?.[0]?.id ?? null;
    const seqs = p.sequences ?? [];
    const seq = this.current();
    const anims = p.animations;
    const animName = (id: string) => anims.find((a) => a.id === id)?.name ?? '?';

    const seqSel = h('select', { 'data-testid': 'seqd-select', 'aria-label': 'Saved sequence', disabled: !seqs.length }, ...(seqs.length ? seqs.map((q) => h('option', { value: q.id }, q.name)) : [h('option', { value: '' }, '(no sequences yet)')]));
    if (seq) seqSel.value = seq.id;
    seqSel.addEventListener('change', () => {
      this.seqId = seqSel.value;
      const q = this.current();
      if (q) this.fps = sequenceFps(p, q);
      this.index = 0;
      this.render();
    });
    const newBtn = h('button', { class: 'mini', 'data-testid': 'seqd-new', disabled: !anims.length, title: 'New sequence starting with the current animation' }, '+ New');
    newBtn.addEventListener('click', () => this.createSequence());
    const delBtn = h('button', { class: 'mini', 'data-testid': 'seqd-delete', disabled: !seq, title: 'Delete this sequence (undoable)' }, 'Delete');
    delBtn.addEventListener('click', () => {
      const id = this.seqId;
      ed.mutate('Delete sequence', (q) => {
        q.sequences = (q.sequences ?? []).filter((x) => x.id !== id);
      });
      this.seqId = ed.project.sequences?.[0]?.id ?? null;
      this.render();
    });
    this.body.append(h('div', { class: 'export-actions' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Sequence'), seqSel), newBtn, delBtn));

    if (!seq) {
      this.body.append(
        h('p', { class: 'hint', 'data-testid': 'seqd-empty' }, anims.length ? 'No saved sequences. “+ New” starts one with the current animation; add clips, set repeats and mixes, then export.' : 'Create an animation first.'),
        h('div', { class: 'export-actions' }, h('span', { class: 'tb-spacer' }), this.closeButton()),
      );
      return;
    }

    const nameIn = h('input', { type: 'text', value: seq.name, 'data-testid': 'seqd-name', 'aria-label': 'Sequence name' });
    nameIn.addEventListener('change', () => {
      const v = nameIn.value.trim();
      if (!v) return this.render();
      this.edit('Rename sequence', (q, pp) => void (q.name = uniqueName((pp.sequences ?? []).filter((x) => x.id !== q.id).map((x) => x.name), v)));
    });
    const loopIn = h('input', { type: 'checkbox', checked: seq.loop, 'data-testid': 'seqd-loop' });
    loopIn.addEventListener('change', () => this.edit(loopIn.checked ? 'Sequence loops' : 'Sequence plays once', (q) => void (q.loop = loopIn.checked)));
    this.body.append(h('div', { class: 'row2' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), nameIn),
      h('label', { class: 'field check' }, loopIn, 'Exported files loop')));

    // Steps, with the mix into each step between rows.
    const rows: HTMLElement[] = [];
    seq.steps.forEach((st, i) => {
      if (i > 0) {
        const from = seq.steps[i - 1].animId;
        const mixIn = h('input', { type: 'number', min: 0, max: 10, step: 0.05, value: fmt(mixDuration(p, from, st.animId)), class: 'w-num', 'data-testid': `seqd-mix-${i}`, 'aria-label': `Mix ${animName(from)} → ${animName(st.animId)} (s)` });
        mixIn.addEventListener('change', () => {
          const v = Number(mixIn.value);
          if (!(Number.isFinite(v) && v >= 0 && v <= 10)) return this.render();
          ed.mutate('Set mix duration', (q) => setMixRule(q, from, st.animId, v));
          this.render();
        });
        rows.push(h('li', { class: 'seq-mix' }, h('span', { class: 'dim' }, `↓ mix ${animName(from)} → ${animName(st.animId)}`), mixIn, h('span', { class: 'dim' }, 's (stored rule, shared with Mix…)')));
      }
      const animSel = h('select', { 'data-testid': `seqd-step-anim-${i}`, 'aria-label': `Clip ${i + 1}` }, ...anims.map((a) => h('option', { value: a.id }, a.name)));
      animSel.value = st.animId;
      animSel.addEventListener('change', () => this.edit('Change sequence clip', (q) => {
        if (q.steps[i]) q.steps[i].animId = animSel.value;
      }));
      const repIn = h('input', { type: 'number', min: 1, max: SEQUENCE_MAX_REPEAT, step: 1, value: String(st.repeat), class: 'w-num', 'data-testid': `seqd-step-repeat-${i}`, 'aria-label': `Repeat clip ${i + 1}` });
      repIn.addEventListener('change', () => {
        const v = Number(repIn.value);
        if (!(Number.isInteger(v) && v >= 1 && v <= SEQUENCE_MAX_REPEAT)) {
          this.app.status(`Repeat must be a whole number from 1 to ${SEQUENCE_MAX_REPEAT}.`);
          return this.render();
        }
        this.edit('Set clip repeat', (q) => {
          if (q.steps[i]) q.steps[i].repeat = v;
        });
      });
      const move = (d: -1 | 1) => this.edit('Reorder sequence', (q) => {
        if (!q.steps[i] || !q.steps[i + d]) return;
        const [x] = q.steps.splice(i, 1);
        q.steps.splice(i + d, 0, x);
      });
      rows.push(h('li', { class: 'seq-step', 'data-testid': `seqd-step-${i}` },
        h('span', { class: 'dim' }, `${i + 1}.`), animSel, h('span', { class: 'dim' }, '×'), repIn,
        h('button', { class: 'mini', 'data-testid': `seqd-step-up-${i}`, disabled: i === 0, title: 'Move earlier', onclick: () => move(-1) }, '↑'),
        h('button', { class: 'mini', 'data-testid': `seqd-step-down-${i}`, disabled: i === seq.steps.length - 1, title: 'Move later', onclick: () => move(1) }, '↓'),
        h('button', { class: 'mini', 'data-testid': `seqd-step-remove-${i}`, title: 'Remove this clip', onclick: () => this.edit('Remove sequence clip', (q) => void (q.steps[i] && q.steps.splice(i, 1))) }, '×')));
    });
    const addBtn = h('button', { class: 'mini', 'data-testid': 'seqd-add-step', title: 'Append a clip (the current animation)' }, '+ Clip');
    addBtn.addEventListener('click', () => {
      const a = ed.anim() ?? anims[0];
      if (a) this.edit('Add sequence clip', (q) => void q.steps.push({ animId: a.id, repeat: 1 }));
    });
    this.body.append(h('div', { class: 'group-label' }, 'Clips (in order)'), h('ol', { class: 'seq-steps', 'data-testid': 'seqd-steps' }, ...rows), h('div', { class: 'export-actions' }, addBtn, h('span', { class: 'dim', 'data-testid': 'seqd-describe' }, describeSequence(p, seq))));

    // Export settings and preview.
    const num = (testId: string, label: string, value: number, step: number, set: (v: number) => void) => {
      const input = h('input', { type: 'number', step, min: step, value: String(value), 'data-testid': testId, 'aria-label': label, class: 'w-num' });
      input.addEventListener('change', () => {
        set(Number(input.value));
        this.index = 0;
        this.render();
      });
      return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input);
    };
    const frame = this.frameMode === 'project' && p.frame ? p.frame : null;
    const prepared = prepareClipSequence(p, seq, this.fps, ed.skinId, this.scale, 4, frame);
    const setup = prepared.ok ? prepared.setup : null;
    if (setup) this.index = Math.min(this.index, setup.frames.length - 1);
    const errors = [...(prepared.ok ? [] : prepared.errors), ...(this.format === 'zip' ? [] : mediaErrors(this.format, this.fps))];
    const formatSel = h('select', { 'data-testid': 'seqd-format', 'aria-label': 'Output format' },
      h('option', { value: 'zip' }, 'PNG sequence (ZIP)'),
      h('option', { value: 'apng' }, 'Animated PNG (APNG)'),
      h('option', { value: 'gif' }, `GIF (≤ ${GIF_MAX_FPS} fps)`));
    formatSel.value = this.format;
    formatSel.addEventListener('change', () => {
      this.format = formatSel.value as 'zip' | MediaFormat;
      this.render();
    });
    const frameSel = frameSelect('seqd-frame', p, this.frameMode, (m) => {
      this.frameMode = m;
      this.render();
    });
    this.body.append(h('div', { class: 'export-grid' },
      num('seqd-fps', 'Export FPS', this.fps, 1, (v) => void (this.fps = v)),
      num('seqd-scale', 'Scale', this.scale, 0.25, (v) => void (this.scale = v)),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Canvas'), frameSel),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Format'), formatSel)));

    const sched = scheduleSequence(p, seq, this.fps);
    const breakdown = sched.ok ? sched.schedule.steps.map((s) => `${s.name}${s.repeat > 1 ? `×${s.repeat}` : ''} ${s.frames}`).join(' + ') : '';
    this.body.append(
      errors.length
        ? h('ul', { class: 'errors', role: 'alert', 'data-testid': 'seqd-errors' }, ...errors.map((e) => h('li', {}, e)))
        : h('p', { class: 'hint', 'data-testid': 'seqd-summary', 'data-frames': String(setup!.frames.length) }, `${setup!.frames.length} frames (${breakdown}) · ${setup!.geometry.width}×${setup!.geometry.height} px · transparent${frame ? ' · project frame' : ''} · ${seq.loop ? 'loops' : 'plays once'}`),
      frameWarning('seqd-frame-warning', setup?.warnings ?? []),
      h('p', { class: 'hint' }, `Each play of a clip contributes round(duration × FPS) frames; a clip blends in from the live pose over the stored mix (default ${DEFAULT_MIX} s). Repeats are back to back: loops keep looping, one-shots restart. A channel a clip does not key returns to the setup pose during its transition (the Mix dialog’s “setup” policy; sequences do not offer “hold”). Constraint mix blends across a transition like any channel.`),
    );

    const canvas = h('canvas', { class: 'mix-canvas', 'data-testid': 'seqd-canvas', 'aria-label': 'Sequence frame' });
    const slider = h('input', { type: 'range', min: 0, max: setup ? setup.frames.length - 1 : 0, step: 1, value: this.index, 'data-testid': 'seqd-time', 'aria-label': 'Sequence frame', disabled: !setup });
    const label = h('span', { class: 'dim', 'data-testid': 'seqd-time-label' });
    const show = () => {
      if (!setup) return;
      this.drawFrame(canvas, setup, this.index);
      const st = sched.ok ? [...sched.schedule.steps].reverse().find((s) => s.startFrame <= this.index) : null;
      label.textContent = `frame ${this.index} · ${setup.plan.times[this.index].toFixed(3)} s${st ? ` · ${st.name}` : ''}`;
    };
    slider.addEventListener('input', () => {
      this.index = Number(slider.value);
      show();
    });
    const progress = h('progress', { max: 1, value: 0, 'data-testid': 'seqd-progress' });
    const progressText = h('span', { class: 'dim', 'data-testid': 'seqd-progress-text' }, '');
    const exportBtn = h('button', { class: 'accent', 'data-testid': 'seqd-export', disabled: !setup || errors.length > 0 }, { zip: 'Export ZIP', apng: 'Export APNG', gif: 'Export GIF' }[this.format]);
    exportBtn.addEventListener('click', () => setup && !errors.length && void this.run(setup, progress, progressText, exportBtn));
    this.body.append(
      h('div', { class: 'mix-stage' }, canvas),
      h('div', { class: 'export-actions' }, slider, label),
      h('div', { class: 'export-actions' }, progress, progressText, h('span', { class: 'tb-spacer' }), this.closeButton(), exportBtn),
    );
    show();
  }

  private closeButton(): HTMLElement {
    const b = h('button', { 'data-testid': 'seqd-close' }, 'Close');
    b.addEventListener('click', () => {
      if (this.running) this.cancelled = true;
      else this.dlg.close();
    });
    return b;
  }

  private drawFrame(c: HTMLCanvasElement, setup: SequenceSetup, i: number): void {
    const geo = setup.geometry;
    c.width = geo.width;
    c.height = geo.height;
    c.dataset.frame = String(i);
    renderSequenceFrame(c.getContext('2d')!, setup, i, (im) => this.app.images.get(im));
  }

  private async run(setup: SequenceSetup, progress: HTMLProgressElement, text: HTMLElement, btn: HTMLButtonElement): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    btn.disabled = true;
    const p = this.app.ed.project;
    const canvas = document.createElement('canvas');
    const toPng = () => new Promise<Uint8Array>((resolve, reject) => canvas.toBlob((b) => (b ? b.arrayBuffer().then((x) => resolve(new Uint8Array(x)), reject) : reject(new Error('PNG encoding failed'))), 'image/png'));
    const req = { fps: this.fps, start: 0, end: setup.plan.lastFrame, scale: this.scale, padding: 4, frame: this.frameMode === 'project' ? (p.frame ?? null) : null };
    const base = `${safeName(p.name)}-${safeName(setup.anim.name)}-${this.fps}fps`;
    try {
      if (this.format === 'zip') {
        const zip = await encodeSequenceZip(p, setup, req, (im) => this.app.images.get(im), canvas, toPng, (done, total) => {
          progress.value = done / total;
          text.textContent = `${done} / ${total}`;
        }, () => this.cancelled);
        download(new Blob([zip as BlobPart], { type: 'application/zip' }), `${base}.zip`);
        this.app.status(`Exported sequence “${setup.anim.name}”: ${setup.frames.length} frames (${setup.geometry.width}×${setup.geometry.height}) as ${base}.zip.`);
        return;
      }
      canvas.width = setup.geometry.width;
      canvas.height = setup.geometry.height;
      const g = exportContext(canvas);
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
      const format = this.format;
      const { bytes, stats } = await encodeAnimated(format, total, (i) => pngs[i], {
        fps: this.fps,
        loop: setup.anim.loop,
        isCancelled: () => this.cancelled,
        onProgress: (done, all) => {
          progress.value = 0.5 + done / all / 2;
          text.textContent = `encoding ${done} / ${all}`;
        },
      });
      const name = `${base}.${format}`;
      download(new Blob([bytes as BlobPart], { type: format === 'apng' ? 'image/apng' : 'image/gif' }), name);
      this.app.status(`Exported sequence “${setup.anim.name}”: ${total} frames (${stats.width}×${stats.height}) as ${name}. ${mediaSummary(stats)}`);
    } catch (e) {
      if (e instanceof Cancelled || e instanceof MediaCancelled) {
        text.textContent = 'Cancelled — nothing was saved.';
        progress.value = 0;
      } else this.app.error('Sequence export failed', [(e as Error).message]);
    } finally {
      this.running = false;
      btn.disabled = false;
      if (this.staleAfterRun && this.dlg.open) {
        this.staleAfterRun = false;
        this.render();
      }
    }
  }
}
