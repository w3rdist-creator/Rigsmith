// "Export Lottie…" dialog: exports one animation (with the editor's active skin) as a
// Lottie JSON of the supported subset (src/model/lottie.ts). Shows every diagnostic; the
// export is disabled while anything outside the subset is present.
import { exportLottie } from '../model/lottie.ts';
import { safeName } from '../render/sequence.ts';
import type { App } from './app.ts';
import { download } from './app.ts';
import { clear, h } from './dom.ts';

export class LottieDialog {
  private app: App;
  private dlg: HTMLDialogElement;
  private body: HTMLElement;
  private anim = '';

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'export-body' });
    this.dlg = h('dialog', { class: 'help export', 'data-testid': 'lottie-dialog', 'aria-label': 'Export Lottie' }, h('h2', {}, 'Export Lottie (supported subset)'), this.body) as HTMLDialogElement;
    document.body.append(this.dlg);
  }

  open(): void {
    const p = this.app.ed.project;
    this.anim = (this.app.ed.anim() ?? p.animations[0])?.name ?? '';
    this.render();
    this.dlg.showModal();
  }

  private render(): void {
    clear(this.body);
    const ed = this.app.ed;
    const p = ed.project;
    const skin = p.skins?.find((s) => s.id === ed.skinId)?.name ?? null;
    const sel = h('select', { 'data-testid': 'lottie-anim', 'aria-label': 'Animation' }, ...p.animations.map((a) => h('option', { value: a.name }, a.name)));
    sel.value = this.anim;
    sel.addEventListener('change', () => {
      this.anim = sel.value;
      this.render();
    });
    const r = exportLottie(p, this.anim, skin);
    const exportBtn = h('button', { class: 'accent', 'data-testid': 'lottie-export', disabled: !r.ok }, 'Export Lottie JSON');
    exportBtn.addEventListener('click', () => {
      if (!r.ok) return;
      const file = `${safeName(p.name)}-${safeName(this.anim)}${skin ? `-${safeName(skin)}` : ''}.lottie.json`;
      download(new Blob([JSON.stringify(r.lottie)], { type: 'application/json' }), file);
      this.app.status(`Exported ${file} (Lottie subset).`);
    });
    const L = r.ok ? (r.lottie as { w: number; h: number; op: number; fr: number; layers: { ty: number }[]; assets: unknown[] }) : null;
    this.body.append(
      h('div', { class: 'row2' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Animation'), sel), h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Skin (from the editor)'), h('span', {}, skin ?? '(default images)'))),
      h('p', { class: 'hint' }, 'Exports only what Lottie represents exactly: bone keys (linear, stepped, smooth, bezier), flat images, opacity, visibility and image swaps, and the active skin. IK, paths, meshes, deform and draw-order keys are refused, not approximated.'),
      L ? h('p', { class: 'hint', 'data-testid': 'lottie-summary' }, `${L.w}×${L.h} · ${L.op} frames at ${L.fr} fps · ${L.layers.filter((l) => l.ty === 2).length} image layer(s), ${L.layers.filter((l) => l.ty === 3).length} null layer(s), ${L.assets.length} embedded PNG(s)`) : '',
      h('ul', { class: 'skin-diags', 'data-testid': 'lottie-diagnostics' }, ...r.diagnostics.map((d) => h('li', { class: d.level === 'error' ? 'warning' : 'info' }, `${d.level === 'error' ? '✖ ' : ''}${d.feature} — ${d.item}: ${d.message}`))),
      h('div', { class: 'export-actions' }, h('span', { class: 'tb-spacer' }), h('button', { 'data-testid': 'lottie-cancel', onclick: () => this.dlg.close() }, 'Close'), exportBtn),
    );
  }
}
