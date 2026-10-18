// "Import animations…" dialog (RV-009): copy animations from another Rigsmith project
// file into this one. Every bone, attachment, constraint and image the chosen
// animations reference gets an explicit target (defaulted by name, changeable, or
// skipped); the report of unmatched objects, dropped keys, keys a constraint of this
// project would override and hierarchy differences is shown *before* Import, together
// with two opt-in options (offset by the setup difference; key overriding constraints to
// mix 0 in the imported copy). The import itself is one undoable edit.
import type { ImportMapping, ImportOptions, ImportReport, RefKind } from '../model/animImport.ts';
import { defaultMapping, importAnimations, reportSummary, usedRefs } from '../model/animImport.ts';
import { parseProject } from '../model/format.ts';
import type { Project } from '../model/types.ts';
import { cloneProject } from '../model/types.ts';
import { safeName } from '../render/sequence.ts';
import type { App } from './app.ts';
import { clear, h } from './dom.ts';

const KINDS: { kind: RefKind; key: keyof ImportMapping; label: string; tid: string }[] = [
  { kind: 'bone', key: 'bones', label: 'Bones', tid: 'bone' },
  { kind: 'attachment', key: 'attachments', label: 'Attachments (slot, image, deform and draw-order keys)', tid: 'att' },
  { kind: 'constraint', key: 'constraints', label: 'Constraints (IK / path keys)', tid: 'con' },
  { kind: 'image', key: 'images', label: 'Images (image-swap keys)', tid: 'img' },
];

export class ImportAnimDialog {
  private app: App;
  private dlg: HTMLDialogElement;
  private body: HTMLElement;
  private src: Project | null = null;
  private fileName = '';
  private chosen = new Set<string>();
  private mapping: ImportMapping = { bones: {}, attachments: {}, constraints: {}, images: {} };
  private offsetSetup = false;
  /** Target constraint ids the user chose to key to mix 0 in the imported copy. */
  private mute = new Set<string>();
  readonly input = h('input', { type: 'file', accept: '.json,.rig.json,application/json', hidden: true, 'data-testid': 'import-anims-input' });

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'export-body' });
    this.dlg = h('dialog', { class: 'help export', 'data-testid': 'import-dialog', 'aria-label': 'Import animations' }, h('h2', {}, 'Import animations from a project'), this.body) as HTMLDialogElement;
    document.body.append(this.dlg, this.input);
    this.input.addEventListener('change', () => {
      const f = this.input.files?.[0];
      this.input.value = '';
      if (f) void this.load(f);
    });
  }

  /** Asks for a source project file. */
  pick(): void {
    this.input.click();
  }

  async load(file: File): Promise<void> {
    const r = parseProject(await file.text());
    if (!r.ok) return this.app.error(`Cannot import from ${file.name}`, r.errors);
    if (!r.project.animations.length) return this.app.error(`Cannot import from ${file.name}`, ['That project has no animations.']);
    this.src = r.project;
    this.fileName = file.name;
    this.chosen = new Set(r.project.animations.map((a) => a.id));
    this.mapping = { bones: {}, attachments: {}, constraints: {}, images: {} };
    this.offsetSetup = false;
    this.mute = new Set();
    this.remap();
    this.render();
    this.dlg.showModal();
  }

  /** Name-based defaults for references not yet mapped by the user. */
  private remap(): void {
    const fresh = defaultMapping(this.src!, this.app.ed.project, [...this.chosen]);
    for (const k of KINDS) for (const [id, t] of Object.entries(fresh[k.key])) if (!(id in this.mapping[k.key])) this.mapping[k.key][id] = t;
  }

  private options(): ImportOptions {
    return { offsetSetup: this.offsetSetup, muteConstraints: [...this.mute] };
  }

  private preview(): ImportReport {
    return importAnimations(cloneProject(this.app.ed.project), this.src!, [...this.chosen], this.mapping, this.options());
  }

  private render(): void {
    const src = this.src!;
    const dst = this.app.ed.project;
    clear(this.body);
    this.body.append(h('p', { class: 'hint' }, `From “${src.name}” (${this.fileName}). Bone keys are absolute local values: copied unchanged, a target bone whose setup pose differs from the source bone jumps to the source values at its first key — turn on “Offset by the setup difference” to move it by the same amounts around its own setup instead. Mappings default to identical names; change or skip any of them.`));

    const animList = h('div', { class: 'import-anims', 'data-testid': 'imp-anims' }, ...src.animations.map((a) => {
      const box = h('input', { type: 'checkbox', checked: this.chosen.has(a.id), 'data-testid': `imp-anim-${safeName(a.name)}` });
      box.addEventListener('change', () => {
        if (box.checked) this.chosen.add(a.id);
        else this.chosen.delete(a.id);
        this.remap();
        this.render();
      });
      const exists = dst.animations.some((x) => x.name === a.name);
      return h('label', { class: 'field check' }, box, `${a.name} (${a.duration} s${a.loop ? ', loop' : ''})${exists ? ' — name taken here, imported with a suffix' : ''}`);
    }));
    this.body.append(h('div', { class: 'group-label' }, 'Animations'), animList);

    const used = usedRefs(src, [...this.chosen]);
    const pools: Record<RefKind, { id: string; name: string }[]> = {
      bone: dst.bones,
      attachment: dst.attachments,
      constraint: [...(dst.ik ?? []), ...(dst.pathConstraints ?? [])],
      image: dst.images,
    };
    const srcPools: Record<RefKind, { id: string; name: string }[]> = {
      bone: src.bones,
      attachment: src.attachments,
      constraint: [...(src.ik ?? []), ...(src.pathConstraints ?? [])],
      image: src.images,
    };
    for (const k of KINDS) {
      const ids = [...used[k.key].keys()];
      if (!ids.length) continue;
      const rows = ids.map((id) => {
        const name = srcPools[k.kind].find((x) => x.id === id)?.name ?? id;
        const sel = h('select', { 'data-testid': `imp-map-${k.tid}-${safeName(name)}`, 'aria-label': `Target for ${k.kind} ${name}` },
          h('option', { value: '' }, '(skip — do not import)'), ...pools[k.kind].map((x) => h('option', { value: x.id }, x.name)));
        sel.value = this.mapping[k.key][id] ?? '';
        sel.addEventListener('change', () => {
          this.mapping[k.key][id] = sel.value || null;
          this.render();
        });
        const keys = used[k.key].get(id) ?? 0;
        return h('tr', { class: sel.value ? '' : 'unmatched' }, h('td', {}, name), h('td', { class: 'dim' }, `${keys} key(s)`), h('td', {}, '→ ', sel));
      });
      this.body.append(h('div', { class: 'group-label' }, k.label), h('table', { class: 'import-map', 'data-testid': `imp-map-${k.tid}s` }, ...rows));
    }

    const offset = h('input', { type: 'checkbox', checked: this.offsetSetup, 'data-testid': 'imp-offset-setup' });
    offset.addEventListener('change', () => {
      this.offsetSetup = offset.checked;
      this.render();
    });
    this.body.append(h('div', { class: 'group-label' }, 'Options'), h('label', { class: 'field check' }, offset, 'Offset by the setup difference (translate and rotate: + target setup − source setup; scale: × target / source setup)'));

    const rep = this.chosen.size ? this.preview() : null;
    const report = h('div', { class: 'import-report', 'data-testid': 'imp-report', role: 'status' });
    if (!rep) report.append(h('p', { class: 'dim' }, 'Choose at least one animation.'));
    else {
      report.append(h('p', {}, `Will import: ${rep.imported.map((x) => (x.name === x.source ? x.name : `${x.source} as ${x.name}`)).join(', ')} — ${rep.keys} key(s)${rep.mixes ? `, ${rep.mixes} mix rule(s)` : ''}.`));
      if (rep.unmatched.length) report.append(h('p', { class: 'warning', 'data-testid': 'imp-unmatched' }, `Unmatched (not imported): ${rep.unmatched.map((u) => `${u.kind} “${u.name}” (${u.keys} key(s))`).join('; ')}.`));
      else report.append(h('p', { class: 'dim', 'data-testid': 'imp-unmatched' }, 'Every referenced object has a target.'));
      for (const c of rep.conflicts) report.append(h('p', { class: 'warning' }, c));
      for (const d of rep.dropped) report.append(h('p', { class: 'dim' }, `Dropped: ${d}`));
      if (rep.driven.length) {
        const box = h('div', { 'data-testid': 'imp-driven' });
        for (const d of rep.driven) {
          const kind = d.kind === 'ik' ? 'IK' : 'path';
          const bones = d.bones.map((b) => `${b.name} (${b.keys})`).join(', ');
          const mute = h('input', { type: 'checkbox', checked: this.mute.has(d.constraintId), 'data-testid': `imp-mute-${safeName(d.constraint)}` });
          mute.addEventListener('change', () => {
            if (mute.checked) this.mute.add(d.constraintId);
            else this.mute.delete(d.constraintId);
            this.render();
          });
          box.append(
            h('p', { class: d.muted ? 'dim' : 'warning' }, d.muted
              ? `${kind} “${d.constraint}” is keyed to mix 0 in the imported animation(s), so its ${d.keys} key(s) on ${bones} play; the constraint stops solving there.`
              : `${kind} “${d.constraint}” (mix ${d.mix}) overrides ${d.keys} imported key(s) on ${bones}: those keys will have no visible effect here.`),
            h('label', { class: 'field check' }, mute, `Key “${d.constraint}” to mix 0 in the imported copy`),
          );
        }
        report.append(box);
      }
      if (rep.rig.length) report.append(h('div', { 'data-testid': 'imp-rig' }, ...rep.rig.map((r) => h('p', { class: 'dim' }, `Rig difference: ${r}`))));
    }
    const apply = h('button', { class: 'accent', 'data-testid': 'imp-apply', disabled: !rep || !rep.imported.length }, 'Import');
    apply.addEventListener('click', () => this.apply());
    const cancel = h('button', { 'data-testid': 'imp-cancel' }, 'Cancel');
    cancel.addEventListener('click', () => this.dlg.close());
    this.body.append(h('div', { class: 'group-label' }, 'Report'), report, h('div', { class: 'export-actions' }, h('span', { class: 'tb-spacer' }), cancel, apply));
  }

  private apply(): void {
    const ed = this.app.ed;
    const src = this.src!;
    let rep: ImportReport | null = null;
    const ids = [...this.chosen];
    ed.mutate(`Import ${ids.length} animation(s)`, (p) => void (rep = importAnimations(p, src, ids, this.mapping, this.options())));
    const r = rep as ImportReport | null;
    if (!r) return;
    const first = ed.project.animations.find((a) => a.name === r.imported[0]?.name);
    if (first) ed.setAnimation(first.id);
    this.dlg.close();
    const repairs = ed.lastRepairs.length ? ` ${ed.lastRepairs.join(' ')}` : '';
    this.app.status(`Imported from “${src.name}”: ${reportSummary(r)}.${repairs}`);
  }
}
