// Skins: the left-panel list (add / duplicate / rename / delete, active-skin switch,
// validation) and the attachment-inspector section that maps each image an attachment
// can show to its replacement in the active skin.
import { addSkin, attachmentImages, deleteSkin, duplicateSkin, renameSkin, setSkinEntry, skinDiagnostics, skinReplacement } from '../model/skinOps.ts';
import type { Attachment } from '../model/types.ts';
import { newId } from '../model/types.ts';
import type { App } from './app.ts';
import { append, h } from './dom.ts';

export function renderSkinsPanel(app: App, root: HTMLElement): void {
  const { ed } = app;
  const p = ed.project;
  const skins = p.skins ?? [];
  root.replaceChildren();
  const add = () => {
    const id = newId('skin');
    ed.mutate('Add skin', (q) => void addSkin(q, id));
    ed.setSkin(id);
  };
  append(root,
    h('div', { class: 'panel-head' }, h('h2', {}, 'Skins'), h('div', { class: 'head-actions' }, h('button', { class: 'mini', 'data-testid': 'skin-add', title: 'New skin (attachment set): pick replacement images per attachment', onclick: add }, '+ Skin'))),
  );
  if (!skins.length) {
    root.append(h('p', { class: 'dim' }, 'No skins. A skin swaps attachment images as a set (colourways, outfits) without touching the rig or animations.'));
    return;
  }
  const active = skins.find((s) => s.id === ed.skinId) ?? null;
  const sel = h('select', { 'data-testid': 'skin-active', 'aria-label': 'Active skin' }, h('option', { value: '' }, '(default images)'), ...skins.map((s) => h('option', { value: s.id }, s.name)));
  sel.value = active?.id ?? '';
  sel.addEventListener('change', () => ed.setSkin(sel.value || null));
  root.append(h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Showing'), sel));
  if (!active) {
    root.append(h('p', { class: 'hint' }, 'Pick a skin to edit it; select an image attachment to set its replacement.'));
    return;
  }
  const name = h('input', { type: 'text', value: active.name, 'data-testid': 'skin-name', 'aria-label': 'Skin name', spellcheck: 'false' });
  name.addEventListener('change', () => {
    const err = renameSkin(structuredClone(p), active.id, name.value);
    if (err) {
      name.value = active.name;
      return app.error('Skin not renamed', [err]);
    }
    ed.mutate('Rename skin', (q) => void renameSkin(q, active.id, name.value));
  });
  const diags = skinDiagnostics(p).filter((d) => d.skin.split(', ').includes(active.name));
  append(root,
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
    h('div', { class: 'row2' },
      h('button', {
        class: 'mini',
        'data-testid': 'skin-duplicate',
        onclick: () => {
          const id = newId('skin');
          ed.mutate('Duplicate skin', (q) => void duplicateSkin(q, active.id, id));
          ed.setSkin(id);
        },
      }, 'Duplicate'),
      h('button', {
        class: 'mini',
        'data-testid': 'skin-delete',
        onclick: () => {
          ed.mutate('Delete skin', (q) => deleteSkin(q, active.id));
          ed.setSkin(null);
        },
      }, 'Delete'),
    ),
    h('p', { class: 'dim', 'data-testid': 'skin-summary' }, `${active.entries.length} replacement(s) · ${new Set(active.entries.map((e) => e.attachmentId)).size} attachment(s)`),
    diags.length
      ? h('ul', { class: 'skin-diags', 'data-testid': 'skin-diagnostics' }, ...diags.map((d) => h('li', { class: d.level }, `${d.level === 'warning' ? '⚠ ' : ''}${d.message}`)))
      : h('p', { class: 'dim', 'data-testid': 'skin-diagnostics' }, 'No issues found.'),
  );
}

/** Attachment inspector: replacement images in the active skin. */
export function skinSection(app: App, a: Attachment): HTMLElement[] {
  const { ed } = app;
  const p = ed.project;
  const skin = p.skins?.find((s) => s.id === ed.skinId);
  if (!skin) return [];
  const out: HTMLElement[] = [h('div', { class: 'group-label' }, `Skin “${skin.name}”`)];
  const imgs = attachmentImages(p, a.id);
  imgs.forEach((from, i) => {
    const fromIm = p.images.find((x) => x.id === from);
    if (!fromIm) return;
    const cur = skinReplacement(p, skin.id, a.id, from);
    const testId = i === 0 ? 'skin-image' : `skin-from-${fromIm.name}`;
    const el = h('select', { 'data-testid': testId, 'aria-label': `${fromIm.name} in ${skin.name}` }, h('option', { value: '' }, '(default)'), ...p.images.map((im) => h('option', { value: im.id }, im.name)));
    el.value = cur ?? '';
    el.addEventListener('change', () => ed.mutate('Set skin image', (q) => setSkinEntry(q, skin.id, a.id, i === 0 ? null : from, el.value || null)));
    out.push(h('label', { class: 'field' }, h('span', { class: 'field-label' }, i === 0 ? `${fromIm.name} (setup) →` : `${fromIm.name} (keyed) →`), el));
  });
  out.push(h('p', { class: 'hint' }, 'The setup entry also applies when an image key shows the setup image. Images are shared, never modified.'));
  return out;
}
