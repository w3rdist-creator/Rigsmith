// Left (skeleton + images) and right (inspector) panels.
import { findKeyIndex, sampleBone, snapToFrame } from '../model/animation.ts';
import { applyPoseEdit } from '../model/ops.ts';
import { descendantIds, depthOf, topoOrder } from '../model/skeleton.ts';
import type { Attachment, Channel, LocalPose } from '../model/types.ts';
import type { App } from './app.ts';
import { append, clear, h, numberField } from './dom.ts';
import { setAttachmentImage } from '../model/meshOps.ts';
import { meshSection } from './meshPanels.ts';
import { skinSection } from './skinPanels.ts';
import { attachmentSlotSection, boneRigSection, renderConstraintInspector, renderPathInspector } from './rigPanels.ts';

export function renderSkeleton(app: App, root: HTMLElement): void {
  const { ed } = app;
  const p = ed.project;
  clear(root);
  const sel = ed.selection;
  const list = h('div', { class: 'tree', role: 'tree', 'aria-label': 'Bone hierarchy', 'data-testid': 'bone-tree' });
  const attRow = (aId: string, depth: number) => {
    const a = p.attachments.find((x) => x.id === aId)!;
    const im = p.images.find((i) => i.id === a.imageId);
    const isSel = sel?.kind === 'attachment' && sel.id === a.id;
    return h(
      'button',
      {
        class: `tree-row att${isSel ? ' selected' : ''}`,
        role: 'treeitem',
        'aria-selected': isSel ? 'true' : 'false',
        style: `padding-left:${10 + depth * 14}px`,
        'data-testid': `tree-att-${a.name}`,
        title: im ? `${im.name} — ${im.width}×${im.height}` : 'missing image',
        onclick: () => ed.select({ kind: 'attachment', id: a.id }),
      },
      h('span', { class: 'glyph img' }, '▣'),
      a.name,
    );
  };
  const unbound = p.attachments.filter((a) => !a.boneId);
  for (const a of unbound) list.append(attRow(a.id, 0));
  for (const b of topoOrder(p.bones)) {
    const depth = depthOf(p.bones, b.id);
    const isSel = sel?.kind === 'bone' && sel.id === b.id;
    list.append(
      h(
        'button',
        {
          class: `tree-row bone${isSel ? ' selected' : ''}`,
          role: 'treeitem',
          'aria-selected': isSel ? 'true' : 'false',
          style: `padding-left:${10 + depth * 14}px`,
          'data-testid': `tree-bone-${b.name}`,
          onclick: () => ed.select({ kind: 'bone', id: b.id }),
        },
        h('span', { class: 'glyph', style: `color:${b.color}` }, '◆'),
        b.name,
      ),
    );
    for (const a of p.attachments) if (a.boneId === b.id) list.append(attRow(a.id, depth + 1));
  }
  root.append(
    h(
      'div',
      { class: 'panel-head' },
      h('h2', {}, 'Skeleton'),
      h('div', { class: 'head-actions' },
        h('button', { class: 'mini', 'data-testid': 'add-bone', title: 'Add a bone (child of the selected bone)', onclick: () => app.addBone() }, '+ Bone'),
        h('button', { class: 'mini', 'data-testid': 'delete-selection', title: 'Delete selection (Del)', disabled: !sel, onclick: () => app.deleteSelection() }, 'Delete'),
      ),
    ),
    p.bones.length || p.attachments.length
      ? list
      : h('p', { class: 'empty', 'data-testid': 'empty-skeleton' }, 'No bones yet. Pick the Bone tool (B) and drag on the canvas, or press “+ Bone”. Open the demo to explore a finished rig.'),
  );
}

export function renderImages(app: App, root: HTMLElement): void {
  const { ed } = app;
  const p = ed.project;
  clear(root);
  const bone = p.bones.find((b) => b.id === ed.selectedBoneId());
  root.append(
    h('div', { class: 'panel-head' },
      h('h2', {}, 'Images'),
      h('button', { class: 'mini', 'data-testid': 'import-images', title: 'Import PNG/JPEG/WebP/GIF files (or drop them on the canvas)', onclick: () => app.imageInput.click() }, 'Import…'),
    ),
  );
  if (!p.images.length) {
    root.append(h('p', { class: 'empty', 'data-testid': 'empty-images' }, 'No images. Import PNG/JPEG/WebP/GIF files or drop them onto the canvas.'));
    return;
  }
  const list = h('div', { class: 'image-list', 'data-testid': 'image-list' });
  for (const im of p.images) {
    const uses = p.attachments.filter((a) => a.imageId === im.id).length;
    list.append(
      h('div', { class: 'image-row', 'data-testid': `image-${im.name}` },
        h('img', { src: im.dataUrl, alt: '', class: 'thumb' }),
        h('div', { class: 'image-meta' },
          h('div', { class: 'image-name', title: im.name }, im.name),
          h('div', { class: 'dim' }, `${im.width}×${im.height}${uses ? ` · used ${uses}×` : ''}`),
          im.derived ? h('div', { class: 'dim derived', 'data-testid': `image-derived-${im.name}`, title: im.derived.note ?? '' }, `${im.derived.kind} of ${p.images.find((x) => x.id === im.derived!.sourceId)?.name ?? '(removed image)'}${im.derived.synthesized ? ` · ${im.derived.synthesized} px synthesized` : ''}`) : null,
        ),
        h('button', {
          class: 'mini',
          'data-testid': `attach-${im.name}`,
          title: bone ? `Attach to bone “${bone.name}”` : 'No bone selected: place in world space',
          onclick: () => app.attachImage(im.id),
        }, bone ? 'Attach' : 'Place'),
        h('button', { class: 'mini icon', title: 'Remove image', 'aria-label': `Remove ${im.name}`, onclick: () => app.removeImage(im.id) }, '×'),
      ),
    );
  }
  root.append(list);
  root.append(h('p', { class: 'hint' }, bone ? `“Attach” binds the image to “${bone.name}”.` : 'Select a bone first to attach an image to it.'));
}

export function renderInspector(app: App, root: HTMLElement): void {
  const { ed } = app;
  const p = ed.project;
  clear(root);
  const sel = ed.selection;
  root.append(h('div', { class: 'panel-head' }, h('h2', {}, 'Inspector')));

  if (!sel) {
    root.append(
      numberlessText('Project name', p.name, 'project-name', (v) => ed.mutate('Rename project', (q) => void (q.name = v))),
      h('dl', { class: 'stats' },
        h('dt', {}, 'Bones'), h('dd', {}, String(p.bones.length)),
        h('dt', {}, 'Images'), h('dd', {}, String(p.images.length)),
        h('dt', {}, 'Attachments'), h('dd', {}, String(p.attachments.length)),
        h('dt', {}, 'Animations'), h('dd', {}, String(p.animations.length)),
      ),
      h('p', { class: 'empty' }, 'Select a bone or image on the canvas or in the Skeleton list to edit it.'),
    );
    return;
  }

  if (sel.kind === 'constraint') return renderConstraintInspector(app, root, sel.id);
  if (sel.kind === 'path') return renderPathInspector(app, root, sel.id);

  if (sel.kind === 'bone') {
    const b = p.bones.find((x) => x.id === sel.id);
    if (!b) return;
    const anim = ed.anim();
    const animate = ed.mode === 'animate' && !!anim;
    const pose: LocalPose = animate ? sampleBone(b, anim, ed.time) : b;
    const t = anim ? snapToFrame(ed.time, anim.fps) : 0;
    const keyBtn = (ch: Channel) => {
      if (!animate) return null;
      const has = findKeyIndex(anim!.tracks[b.id]?.[ch] ?? [], t) >= 0;
      return h('button', {
        class: `keybtn${has ? ' on' : ''}`,
        'data-testid': `key-toggle-${ch}`,
        title: has ? `Remove ${ch} key at this frame` : `Key ${ch} at this frame`,
        'aria-pressed': has ? 'true' : 'false',
        'aria-label': `${ch} key at current frame`,
        onclick: () => app.toggleKey(b.id, ch),
      }, '◆');
    };
    const edit = (patch: Partial<LocalPose>, label: string) => {
      ed.mutate(animate ? `Key ${label}` : `Edit ${label}`, (q) => applyPoseEdit(q, ed.mode, ed.animId, ed.time, b.id, patch));
    };
    // Animate mode: Enter on the value already shown still keys that channel here (the
    // user asked for a key, not an edit); a key with that value already present is a no-op.
    const keyAnyway = (patch: Partial<LocalPose>, label: string) =>
      animate
        ? () => {
            const frame = Math.round(t * anim!.fps);
            const wrote = ed.mutate(`Key ${label}`, (q) => applyPoseEdit(q, ed.mode, ed.animId, ed.time, b.id, patch));
            app.status(wrote ? `Key written (unchanged value): ${b.name} ${label} at frame ${frame}.` : `${b.name} ${label} is already keyed with this value at frame ${frame}.`);
          }
        : undefined;
    const excluded = descendantIds(p.bones, b.id);
    excluded.add(b.id);
    const parentSel = h('select', { 'data-testid': 'bone-parent', 'aria-label': 'Parent bone' },
      h('option', { value: '' }, '(none — root)'),
      ...p.bones.filter((x) => !excluded.has(x.id)).map((x) => h('option', { value: x.id }, x.name)),
    );
    parentSel.value = b.parentId ?? '';
    parentSel.addEventListener('change', () => app.setParent(b.id, parentSel.value || null));
    append(
      root,
      h('div', { class: 'kind-badge' }, animate ? `Bone · keying at frame ${Math.round(t * anim!.fps)}` : 'Bone · setup pose'),
      numberlessText('Name', b.name, 'bone-name', (v) => {
        if (!v.trim()) return;
        ed.mutate('Rename bone', (q) => void (q.bones.find((x) => x.id === b.id)!.name = v.trim()));
      }),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Parent'), parentSel),
      h('div', { class: 'group-label' }, 'Translate', keyBtn('translate')),
      h('div', { class: 'row2' },
        numberField({ label: 'X', value: pose.x, testId: 'bone-x', onCommit: (v) => edit({ x: v }, 'position'), onEnterUnchanged: keyAnyway({ x: pose.x }, 'position') }),
        numberField({ label: 'Y', value: pose.y, testId: 'bone-y', onCommit: (v) => edit({ y: v }, 'position'), onEnterUnchanged: keyAnyway({ y: pose.y }, 'position') }),
      ),
      h('div', { class: 'group-label' }, 'Rotate', keyBtn('rotate')),
      numberField({ label: 'Degrees', value: pose.rotation, testId: 'bone-rotation', onCommit: (v) => edit({ rotation: v }, 'rotation'), onEnterUnchanged: keyAnyway({ rotation: pose.rotation }, 'rotation') }),
      h('div', { class: 'group-label' }, 'Scale', keyBtn('scale')),
      h('div', { class: 'row2' },
        numberField({ label: 'X', value: pose.scaleX, step: 0.05, testId: 'bone-scale-x', onCommit: (v) => edit({ scaleX: v }, 'scale'), onEnterUnchanged: keyAnyway({ scaleX: pose.scaleX }, 'scale') }),
        numberField({ label: 'Y', value: pose.scaleY, step: 0.05, testId: 'bone-scale-y', onCommit: (v) => edit({ scaleY: v }, 'scale'), onEnterUnchanged: keyAnyway({ scaleY: pose.scaleY }, 'scale') }),
      ),
      h('div', { class: 'group-label' }, 'Setup'),
      h('div', { class: 'row2' },
        numberField({ label: 'Length', value: b.length, min: 0, testId: 'bone-length', onCommit: (v) => ed.mutate('Edit length', (q) => void (q.bones.find((x) => x.id === b.id)!.length = Math.max(0, v))) }),
        colorField(b.color, (v) => ed.mutate('Bone colour', (q) => void (q.bones.find((x) => x.id === b.id)!.color = v))),
      ),
      animate ? h('p', { class: 'hint' }, 'Animate mode: edits here and on the canvas write keys at the current frame. Setup values live under Setup mode (Tab).') : null,
      ...boneRigSection(app, b),
    );
    return;
  }

  const a = p.attachments.find((x) => x.id === sel.id);
  if (!a) return;
  const setA = (label: string, fn: (x: Attachment) => void) => ed.mutate(label, (q) => fn(q.attachments.find((x) => x.id === a.id)!));
  const boneSel = h('select', { 'data-testid': 'att-bone', 'aria-label': 'Attachment bone' }, h('option', { value: '' }, '(world)'), ...p.bones.map((b) => h('option', { value: b.id }, b.name)));
  boneSel.value = a.boneId ?? '';
  boneSel.addEventListener('change', () => setA('Rebind attachment', (x) => void (x.boneId = boneSel.value || null)));
  const imgSel = h('select', { 'data-testid': 'att-image', 'aria-label': 'Attachment image' }, ...p.images.map((im) => h('option', { value: im.id }, im.name)));
  imgSel.value = a.imageId;
  // A mesh keeps its shape relative to the image: its points rescale to the new image size.
  imgSel.addEventListener('change', () => setA('Swap image', (x) => setAttachmentImage(ed.project, x, imgSel.value)));
  const idx = p.attachments.indexOf(a);
  const animating = ed.mode === 'animate' && !!ed.anim();
  // Animate mode: slot keys first (what can be keyed now), setup fields below.
  if (animating) root.append(h('div', { class: 'kind-badge' }, `Image attachment · keying at frame ${Math.round(ed.time * ed.anim()!.fps)}`), ...attachmentSlotSection(app, a), ...meshSection(app, a), h('div', { class: 'group-label' }, 'Setup (shared by all animations)'));
  append(
    root,
    animating ? null : h('div', { class: 'kind-badge' }, 'Image attachment · setup'),
    numberlessText('Name', a.name, 'att-name', (v) => v.trim() && setA('Rename attachment', (x) => void (x.name = v.trim()))),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Bone'), boneSel),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Image'), imgSel),
    h('div', { class: 'group-label' }, 'Offset from bone'),
    h('div', { class: 'row2' },
      numberField({ label: 'X', value: a.x, testId: 'att-x', onCommit: (v) => setA('Edit offset', (x) => void (x.x = v)) }),
      numberField({ label: 'Y', value: a.y, testId: 'att-y', onCommit: (v) => setA('Edit offset', (x) => void (x.y = v)) }),
    ),
    numberField({ label: 'Rotation', value: a.rotation, testId: 'att-rotation', onCommit: (v) => setA('Edit rotation', (x) => void (x.rotation = v)) }),
    h('div', { class: 'row2' },
      numberField({ label: 'Scale X', value: a.scaleX, step: 0.05, testId: 'att-scale-x', onCommit: (v) => setA('Edit scale', (x) => void (x.scaleX = v)) }),
      numberField({ label: 'Scale Y', value: a.scaleY, step: 0.05, testId: 'att-scale-y', onCommit: (v) => setA('Edit scale', (x) => void (x.scaleY = v)) }),
    ),
    numberField({ label: 'Opacity', value: a.opacity, step: 0.05, min: 0, max: 1, testId: 'att-opacity', onCommit: (v) => setA('Edit opacity', (x) => void (x.opacity = Math.min(1, Math.max(0, v)))) }),
    h('div', { class: 'group-label' }, `Setup draw order ${idx + 1} of ${p.attachments.length}`),
    h('div', { class: 'row2' },
      h('button', { class: 'mini', 'data-testid': 'att-backward', disabled: idx === 0, onclick: () => app.moveAttachmentOrder(a.id, -1) }, 'Send backward'),
      h('button', { class: 'mini', 'data-testid': 'att-forward', disabled: idx === p.attachments.length - 1, onclick: () => app.moveAttachmentOrder(a.id, 1) }, 'Bring forward'),
    ),
    ...(animating ? [] : attachmentSlotSection(app, a)),
    ...(animating ? [] : meshSection(app, a)),
    ...skinSection(app, a),
  );
}

function numberlessText(label: string, value: string, testId: string, onCommit: (v: string) => void): HTMLElement {
  const input = h('input', { type: 'text', value, 'data-testid': testId, 'aria-label': label, spellcheck: 'false' });
  input.addEventListener('change', () => onCommit(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input);
}

function colorField(value: string, onCommit: (v: string) => void): HTMLElement {
  const input = h('input', { type: 'color', value, 'aria-label': 'Bone colour' });
  input.addEventListener('change', () => onCommit(input.value));
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Colour'), input);
}
