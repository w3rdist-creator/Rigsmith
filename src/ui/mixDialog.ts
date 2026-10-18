// "Mix…" dialog: preview a transition (crossfade) between two animations, optionally
// interrupted by a third, scrub or play it, tune the stored per-pair mix duration and
// export the transition as a transparent PNG sequence.
import type { MissingPolicy, MixPlan } from '../model/mix.ts';
import { DEFAULT_MIX, mixDuration, mixState, setMixRule } from '../model/mix.ts';
import { Cancelled, encodeSequenceZip, prepareMixSequence, renderSequenceFrame, safeName } from '../render/sequence.ts';
import type { SequenceSetup } from '../render/sequence.ts';
import type { App } from './app.ts';
import { download } from './app.ts';
import { frameSelect, frameWarning } from './exportDialog.ts';
import { clear, h } from './dom.ts';

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

export class MixDialog {
  private app: App;
  private dlg: HTMLDialogElement;
  private body: HTMLElement;
  private from = '';
  private to = '';
  /** Global time (s) the transition to `to` starts. */
  private start = 0;
  private missing: MissingPolicy = 'setup';
  private interrupt = false;
  private third = '';
  private interruptAt = 0;
  private interruptMix = DEFAULT_MIX;
  private fps = 30;
  private index = 0;
  private playing = 0;
  private running = false;
  private cancelled = false;
  private frameMode: 'project' | 'fit' = 'fit';

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'export-body' });
    this.dlg = h('dialog', { class: 'help export mix', 'data-testid': 'mix-dialog', 'aria-label': 'Mix preview' }, h('h2', {}, 'Transition preview'), this.body) as HTMLDialogElement;
    this.dlg.addEventListener('cancel', (e) => {
      if (this.running) {
        e.preventDefault();
        this.cancelled = true;
      }
    });
    this.dlg.addEventListener('close', () => this.stop());
    document.body.append(this.dlg);
  }

  open(): void {
    const p = this.app.ed.project;
    const anims = p.animations;
    const cur = this.app.ed.anim() ?? anims[0];
    this.from = cur?.id ?? '';
    this.to = anims.find((a) => a.id !== this.from)?.id ?? this.from;
    this.third = this.from;
    this.start = cur ? Math.min(cur.duration, 0.5) : 0;
    this.interruptAt = this.start + mixDuration(p, this.from, this.to) / 2;
    this.interruptMix = mixDuration(p, this.to, this.third);
    this.fps = cur?.fps ?? 30;
    this.index = 0;
    this.interrupt = false;
    this.frameMode = p.frame ? 'project' : 'fit';
    this.render();
    this.dlg.showModal();
  }

  plan(): MixPlan {
    const p = this.app.ed.project;
    const entries = [
      { animId: this.from, start: 0, mix: 0 },
      { animId: this.to, start: this.start, mix: mixDuration(p, this.from, this.to) },
    ];
    if (this.interrupt) entries.push({ animId: this.third, start: this.interruptAt, mix: this.interruptMix });
    return { entries, missing: this.missing };
  }

  private stop(): void {
    if (this.playing) cancelAnimationFrame(this.playing);
    this.playing = 0;
  }

  private render(): void {
    const ed = this.app.ed;
    const p = ed.project;
    clear(this.body);
    const anims = p.animations;
    const name = (id: string) => anims.find((a) => a.id === id)?.name ?? '?';
    const animSelect = (testId: string, label: string, value: string, set: (v: string) => void) => {
      const s = h('select', { 'data-testid': testId, 'aria-label': label }, ...anims.map((a) => h('option', { value: a.id }, a.name)));
      s.value = value;
      s.addEventListener('change', () => {
        set(s.value);
        this.index = 0;
        this.render();
      });
      return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), s);
    };
    const num = (testId: string, label: string, value: number, step: number, set: (v: number) => void, disabled = false) => {
      const input = h('input', { type: 'number', step, min: 0, value: fmt(value), 'data-testid': testId, 'aria-label': label, class: 'w-num', disabled });
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v) && v >= 0) set(v);
        this.render();
      });
      return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input);
    };

    const plan = this.plan();
    const frame = this.frameMode === 'project' && p.frame ? p.frame : null;
    const prepared = prepareMixSequence(p, plan, this.fps, ed.skinId, 1, 4, frame);
    const frameSel = frameSelect('mix-frame', p, this.frameMode, (m) => {
      this.frameMode = m;
      this.render();
    });
    const setup = prepared.ok ? prepared.setup : null;
    if (setup) this.index = Math.min(this.index, setup.frames.length - 1);

    const missingSel = h('select', { 'data-testid': 'mix-missing', 'aria-label': 'Channels the incoming animation does not key' },
      h('option', { value: 'setup' }, 'blend to setup pose'),
      h('option', { value: 'hold' }, 'keep the previous pose'));
    missingSel.value = this.missing;
    missingSel.addEventListener('change', () => {
      this.missing = missingSel.value as MissingPolicy;
      this.render();
    });
    const interruptIn = h('input', { type: 'checkbox', checked: this.interrupt, 'data-testid': 'mix-interrupt' });
    interruptIn.addEventListener('change', () => {
      this.interrupt = interruptIn.checked;
      this.render();
    });

    const canvas = h('canvas', { class: 'mix-canvas', 'data-testid': 'mix-canvas', 'aria-label': 'Transition frame' });
    const slider = h('input', { type: 'range', min: 0, max: setup ? setup.frames.length - 1 : 0, step: 1, value: this.index, 'data-testid': 'mix-time', 'aria-label': 'Transition time (frame)', disabled: !setup });
    const label = h('span', { class: 'dim', 'data-testid': 'mix-time-label' });
    const weights = h('span', { class: 'dim', 'data-testid': 'mix-weights' });
    const show = () => {
      if (!setup) return;
      this.drawFrame(canvas, setup, this.index);
      const t = setup.plan.times[this.index];
      label.textContent = `frame ${setup.plan.frames[this.index]} · ${t.toFixed(3)} s`;
      const st = mixState(plan, t);
      weights.textContent = plan.entries.map((e, i) => `${name(e.animId)} ${Math.round(this.share(st.weights, i) * 100)}%`).join(' · ');
      slider.value = String(this.index);
    };
    slider.addEventListener('input', () => {
      this.stop();
      this.index = Number(slider.value);
      show();
    });
    const playBtn = h('button', { class: 'mini', 'data-testid': 'mix-play', disabled: !setup }, 'Play');
    playBtn.addEventListener('click', () => {
      if (!setup) return;
      if (this.playing) {
        this.stop();
        playBtn.textContent = 'Play';
        return;
      }
      playBtn.textContent = 'Pause';
      const t0 = performance.now() - setup.plan.times[this.index] * 1000;
      const tick = (now: number) => {
        const f = Math.floor(((now - t0) / 1000) * this.fps);
        if (f >= setup.frames.length) {
          this.index = setup.frames.length - 1;
          show();
          this.stop();
          playBtn.textContent = 'Play';
          return;
        }
        this.index = f;
        show();
        this.playing = requestAnimationFrame(tick);
      };
      this.playing = requestAnimationFrame(tick);
    });

    const rules = p.mixes ?? [];
    const progress = h('progress', { max: 1, value: 0, 'data-testid': 'mix-progress' });
    const progressText = h('span', { class: 'dim', 'data-testid': 'mix-progress-text' }, '');
    const exportBtn = h('button', { class: 'accent', 'data-testid': 'mix-export', disabled: !setup }, 'Export transition ZIP');
    exportBtn.addEventListener('click', () => setup && void this.run(setup, progress, progressText, exportBtn));
    const closeBtn = h('button', { 'data-testid': 'mix-close' }, 'Close');
    closeBtn.addEventListener('click', () => {
      if (this.running) this.cancelled = true;
      else this.dlg.close();
    });

    this.body.append(
      h('div', { class: 'row2' },
        animSelect('mix-from', 'From', this.from, (v) => void (this.from = v)),
        animSelect('mix-to', 'To', this.to, (v) => void (this.to = v))),
      h('div', { class: 'export-grid' },
        num('mix-start', 'Switch at (s)', this.start, 0.05, (v) => void (this.start = v)),
        num('mix-duration', `Mix ${name(this.from)} → ${name(this.to)} (s)`, mixDuration(p, this.from, this.to), 0.05, (v) => ed.mutate('Set mix duration', (q) => setMixRule(q, this.from, this.to, v))),
        num('mix-fps', 'Preview FPS', this.fps, 1, (v) => void (this.fps = Math.round(v))),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Channels not keyed'), missingSel),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Canvas'), frameSel),
      ),
      h('div', { class: 'export-grid' },
        h('label', { class: 'inline' }, interruptIn, 'Interrupt with'),
        animSelect('mix-interrupt-anim', 'Interrupting animation', this.third, (v) => {
          this.third = v;
          this.interruptMix = mixDuration(p, this.to, v);
        }),
        num('mix-interrupt-at', 'at (s)', this.interruptAt, 0.05, (v) => void (this.interruptAt = v), !this.interrupt),
        num('mix-interrupt-duration', 'mix (s)', this.interruptMix, 0.05, (v) => void (this.interruptMix = Math.min(10, v)), !this.interrupt),
      ),
      h('p', { class: 'hint' }, 'Each entry blends from the live pose before it; an interruption starts from the current blended pose, so nothing jumps. IK and paths are solved after blending; visibility, image and draw order switch at 50%.'),
      prepared.ok ? h('p', { class: 'hint', 'data-testid': 'mix-summary' }, `${setup!.frames.length} frames · ${setup!.geometry.width}×${setup!.geometry.height} px · transparent${frame ? ' · project frame' : ''}`) : h('ul', { class: 'errors', role: 'alert', 'data-testid': 'mix-errors' }, ...prepared.errors.map((e) => h('li', {}, e))),
      frameWarning('mix-frame-warning', setup?.warnings ?? []),
      h('div', { class: 'mix-stage' }, canvas),
      h('div', { class: 'export-actions' }, playBtn, slider, label, weights),
      h('div', { class: 'group-label' }, 'Stored mix durations'),
      rules.length
        ? h('ul', { class: 'mix-rules', 'data-testid': 'mix-rules' }, ...rules.map((r) => h('li', {},
          `${name(r.from)} → ${name(r.to)}: ${fmt(r.duration)} s `,
          h('button', { class: 'mini', 'data-testid': `mix-rule-delete-${name(r.from)}-${name(r.to)}`, title: 'Remove this rule (use the default)', onclick: () => {
            ed.mutate('Remove mix rule', (q) => setMixRule(q, r.from, r.to, null));
            this.render();
          } }, '×'))))
        : h('p', { class: 'dim', 'data-testid': 'mix-rules' }, `None: every pair uses ${DEFAULT_MIX} s.`),
      h('div', { class: 'export-actions' }, progress, progressText, h('span', { class: 'tb-spacer' }), closeBtn, exportBtn),
    );
    show();
  }

  /** Share of entry i in the final pose: w_i · Π_{j>i} (1 − w_j). */
  private share(w: number[], i: number): number {
    let s = w[i];
    for (let j = i + 1; j < w.length; j++) s *= 1 - w[j];
    return s;
  }

  private drawFrame(c: HTMLCanvasElement, setup: SequenceSetup, i: number): void {
    const geo = setup.geometry;
    c.width = geo.width;
    c.height = geo.height;
    c.dataset.ox = String(geo.originX);
    c.dataset.oy = String(geo.originY);
    c.dataset.scale = String(geo.scale);
    c.dataset.time = String(setup.plan.times[i]);
    renderSequenceFrame(c.getContext('2d')!, setup, i, (im) => this.app.images.get(im));
  }

  private async run(setup: SequenceSetup, progress: HTMLProgressElement, text: HTMLElement, btn: HTMLButtonElement): Promise<void> {
    if (this.running) return;
    this.stop();
    this.running = true;
    this.cancelled = false;
    btn.disabled = true;
    const p = this.app.ed.project;
    const canvas = document.createElement('canvas');
    const req = { fps: this.fps, start: 0, end: setup.plan.lastFrame, scale: 1, padding: 4, frame: this.frameMode === 'project' ? (p.frame ?? null) : null };
    try {
      const zip = await encodeSequenceZip(
        p, setup, req, (im) => this.app.images.get(im), canvas,
        () => new Promise<Uint8Array>((resolve, reject) => canvas.toBlob((b) => (b ? b.arrayBuffer().then((x) => resolve(new Uint8Array(x)), reject) : reject(new Error('PNG encoding failed'))), 'image/png')),
        (done, total) => {
          progress.value = done / total;
          text.textContent = `${done} / ${total}`;
        },
        () => this.cancelled,
      );
      const file = `${safeName(p.name)}-${safeName(setup.anim.name)}-${this.fps}fps.zip`;
      download(new Blob([zip as BlobPart], { type: 'application/zip' }), file);
      this.app.status(`Exported a ${setup.frames.length}-frame transition (${setup.geometry.width}×${setup.geometry.height}) as ${file}.`);
    } catch (e) {
      if (e instanceof Cancelled) text.textContent = 'Cancelled — nothing was saved.';
      else this.app.error('Transition export failed', [(e as Error).message]);
    } finally {
      this.running = false;
      btn.disabled = false;
    }
  }
}
