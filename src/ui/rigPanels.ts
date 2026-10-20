// Phase-2 inspector sections: slot (attachment) keys and draw-order keys, IK, path and
// transform constraints, path editing, pivot mode, and the constraint list in the left panel.
import { findKeyIndex, snapToFrame } from '../model/animation.ts';
import { constraintMix, pathPosition, transformAngle } from '../model/constraints.ts';
import { drawOrderAt } from '../model/evaluate.ts';
import { constraintLane, laneKeys, slotLane } from '../model/keys.ts';
import {
  addAimConstraint,
  addIk,
  addPath,
  addPathConstraint,
  addPathNode,
  addRotationConstraint,
  deleteConstraint,
  deletePath,
  keyConstraint,
  keyDrawOrderStep,
  keySlotImage,
  keySlotScalar,
  slotValues,
  validIkTargets,
} from '../model/rigOps.ts';
import type { Animation, Attachment, Bone, IkConstraint, PathConstraint, Project, TransformConstraint } from '../model/types.ts';
import { newId } from '../model/types.ts';
import { setBoneInherit } from '../model/skeleton.ts';
import type { App } from './app.ts';
import { append, h, numberField } from './dom.ts';

function animOf(p: Project, id: string | null): Animation | undefined {
  return p.animations.find((a) => a.id === id);
}

function keyToggle(on: boolean, testId: string, label: string, onclick: () => void): HTMLElement {
  return h('button', { class: `keybtn${on ? ' on' : ''}`, 'data-testid': testId, title: on ? `Remove ${label} key at this frame` : `Key ${label} at this frame`, 'aria-pressed': on ? 'true' : 'false', 'aria-label': `${label} key at current frame`, onclick }, '◆');
}

function checkbox(label: string, checked: boolean, testId: string, onChange: (v: boolean) => void, title?: string): HTMLElement {
  const input = h('input', { type: 'checkbox', checked, 'data-testid': testId, 'aria-label': label });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'field check', title }, input, h('span', {}, label));
}

function select(testId: string, label: string, options: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLElement {
  const el = h('select', { 'data-testid': testId, 'aria-label': label }, ...options.map((o) => h('option', { value: o.value }, o.label)));
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), el);
}

// ---- Attachment: slot keys, draw order, cutout ------------------------------------------

export function attachmentSlotSection(app: App, a: Attachment): HTMLElement[] {
  const { ed } = app;
  const p = ed.project;
  const anim = ed.anim();
  const out: HTMLElement[] = [];
  if (ed.mode !== 'animate' || !anim) {
    out.push(
      checkbox('Hidden in setup pose', !!a.hidden, 'att-hidden', (v) => ed.mutate(v ? 'Hide attachment' : 'Show attachment', (q) => {
        const x = q.attachments.find((y) => y.id === a.id)!;
        if (v) x.hidden = true;
        else delete x.hidden;
      }), 'Visibility keys can show it during animations.'),
      h('div', { class: 'group-label' }, 'Cutout'),
      h('button', { class: 'mini', 'data-testid': 'att-cutout', title: 'Cut a piece out of this image (non-destructive), optionally with a new joint bone', onclick: () => app.cutout.open(a.id) }, '✂ Cut out piece…'),
    );
    return out;
  }
  const t = snapToFrame(ed.time, anim.fps);
  const frame = Math.round(t * anim.fps);
  const cur = slotValues(a, anim, t);
  const has = (ch: 'visible' | 'opacity' | 'image') => findKeyIndex(laneKeys(anim, slotLane(a.id, ch)) ?? [], t) >= 0;
  const mutateAnim = (label: string, fn: (an: Animation) => void) => ed.mutate(label, (q) => fn(animOf(q, anim.id)!));
  const toggle = (ch: 'visible' | 'opacity' | 'image') => {
    if (has(ch)) {
      mutateAnim(`Remove ${ch} key`, (an) => {
        const keys = laneKeys(an, slotLane(a.id, ch))!;
        keys.splice(findKeyIndex(keys, t), 1);
      });
    } else if (ch === 'image') mutateAnim('Key image', (an) => keySlotImage(an, a.id, t, cur.imageId));
    else mutateAnim(`Key ${ch}`, (an) => keySlotScalar(an, a.id, ch, t, ch === 'visible' ? (cur.visible ? 1 : 0) : cur.opacity));
  };
  const visIn = h('input', { type: 'checkbox', checked: cur.visible, 'data-testid': 'slot-visible', 'aria-label': 'Visible at this frame' });
  visIn.addEventListener('change', () => mutateAnim(visIn.checked ? 'Key show' : 'Key hide', (an) => keySlotScalar(an, a.id, 'visible', t, visIn.checked ? 1 : 0)));
  const imgSel = h('select', { 'data-testid': 'slot-image', 'aria-label': 'Image shown from this frame' }, ...p.images.map((im) => h('option', { value: im.id }, im.name)));
  imgSel.value = cur.imageId;
  imgSel.addEventListener('change', () => mutateAnim('Key image swap', (an) => keySlotImage(an, a.id, t, imgSel.value)));
  const order = drawOrderAt(p, anim, t);
  const idx = order.findIndex((x) => x.id === a.id);
  out.push(
    h('div', { class: 'group-label' }, `Slot keys · frame ${frame}`),
    h('div', { class: 'row-key' }, h('label', { class: 'field check' }, visIn, h('span', {}, 'Visible')), keyToggle(has('visible'), 'slot-key-visible', 'visibility', () => toggle('visible'))),
    h('div', { class: 'row-key' },
      numberField({ label: 'Opacity', value: cur.opacity, step: 0.05, min: 0, max: 1, testId: 'slot-opacity', onCommit: (v) => mutateAnim('Key opacity', (an) => keySlotScalar(an, a.id, 'opacity', t, v)) }),
      keyToggle(has('opacity'), 'slot-key-opacity', 'opacity', () => toggle('opacity')),
    ),
    h('div', { class: 'row-key' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Image'), imgSel), keyToggle(has('image'), 'slot-key-image', 'image', () => toggle('image'))),
    h('div', { class: 'group-label' }, `Draw order at frame ${frame}: ${idx + 1} of ${order.length}`),
    h('div', { class: 'row2' },
      h('button', { class: 'mini', 'data-testid': 'draw-backward', disabled: idx <= 0, title: 'Key a draw order with this attachment one step further back', onclick: () => mutateAnim('Key draw order', (an) => keyDrawOrderStep(ed.project, an, t, a.id, -1)) }, 'Key backward'),
      h('button', { class: 'mini', 'data-testid': 'draw-forward', disabled: idx >= order.length - 1, title: 'Key a draw order with this attachment one step further forward', onclick: () => mutateAnim('Key draw order', (an) => keyDrawOrderStep(ed.project, an, t, a.id, 1)) }, 'Key forward'),
    ),
    h('p', { class: 'hint' }, 'Visibility, image and draw-order keys are stepped; opacity interpolates. Offsets stay setup data (Tab).'),
  );
  return out;
}

// ---- Bone: IK creation, constraint membership, pivot mode -----------------------------------

export function boneRigSection(app: App, b: Bone): HTMLElement[] {
  const { ed } = app;
  const p = ed.project;
  const out: HTMLElement[] = [h('div', { class: 'group-label' }, 'Constraints')];
  const involved = [
    ...(p.ik ?? []).filter((k) => k.bones.includes(b.id) || k.target === b.id).map((k) => ({ id: k.id, name: k.name, role: k.target === b.id ? 'IK target' : 'IK chain' })),
    ...(p.pathConstraints ?? []).filter((k) => k.bones.includes(b.id)).map((k) => ({ id: k.id, name: k.name, role: 'on path' })),
    ...(p.transformConstraints ?? []).filter((k) => k.bone === b.id || k.source === b.id || k.relativeTo === b.id).map((k) => ({ id: k.id, name: k.name, role: k.bone === b.id ? (k.kind === 'aim' ? 'aim' : 'copies rotation') : 'drives' })),
  ];
  for (const c of involved) out.push(h('button', { class: 'linklike', 'data-testid': `goto-constraint-${c.name}`, onclick: () => ed.select({ kind: 'constraint', id: c.id }) }, `${c.role}: ${c.name}`));
  const parent = p.bones.find((x) => x.id === b.parentId);
  const add = (two: boolean) => {
    const ids = { ik: newId('ik'), target: newId('bone') };
    ed.mutate(two ? 'Add 2-bone IK' : 'Add 1-bone IK', (q) => void addIk(q, b.id, two, ids));
    if (ed.project.ik?.some((k) => k.id === ids.ik)) {
      ed.select({ kind: 'constraint', id: ids.ik });
      app.status('IK added with a pink target. Drag the target (Animate mode keys it) to bend the limb.');
    }
  };
  out.push(
    h('div', { class: 'row2' },
      h('button', { class: 'mini', 'data-testid': 'ik-add-2', disabled: !parent, title: parent ? `IK chain ${parent.name} → ${b.name}, target at this bone's tip` : 'Needs a parent bone', onclick: () => add(true) }, '+ 2-bone IK'),
      h('button', { class: 'mini', 'data-testid': 'ik-add-1', title: 'Aim this bone at a new target', onclick: () => add(false) }, '+ 1-bone IK'),
    ),
  );
  // Transform constraints: copy a fraction of another bone's bend (joint helpers), or hold a world angle.
  const others = p.bones.filter((x) => x.id !== b.id);
  const sibling = others.find((x) => x.parentId === b.parentId && b.parentId) ?? others.find((x) => x.parentId === b.id) ?? others[0];
  const srcSel = h('select', { 'data-testid': 'tc-add-source', 'aria-label': 'Bend source bone' }, ...others.map((x) => h('option', { value: x.id }, x.name))) as HTMLSelectElement;
  if (sibling) srcSel.value = sibling.id;
  const addTc = (kind: 'rotation' | 'aim') => {
    const id = newId('tc');
    ed.mutate(kind === 'aim' ? 'Add aim constraint' : 'Add rotation constraint', (q) => void (kind === 'aim' ? addAimConstraint(q, id, b.id) : addRotationConstraint(q, id, b.id, srcSel.value, 0.5)));
    if (ed.project.transformConstraints?.some((k) => k.id === id)) {
      ed.select({ kind: 'constraint', id });
      app.status(kind === 'aim' ? 'Aim added: the bone holds its current screen angle while its parents move.' : 'Rotation constraint added: the bone takes half the source bone’s bend.');
    }
  };
  out.push(
    h('div', { class: 'row2' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Bend of'), srcSel),
      h('button', { class: 'mini', 'data-testid': 'tc-add-rotation', disabled: !others.length, title: 'Rotate this bone by a fraction of the chosen bone’s bend (e.g. a joint helper at half the elbow angle)', onclick: () => addTc('rotation') }, '+ Rotation'),
    ),
    h('button', { class: 'mini', 'data-testid': 'tc-add-aim', title: 'Hold this bone at its current screen angle (e.g. a prop that stays level while the hand moves)', onclick: () => addTc('aim') }, '+ Aim (hold angle)'),
  );
  if (ed.mode === 'setup') {
    // Inherit flags (v3): which parts of the parent's transform this bone follows.
    const ikChild = p.ik?.some((k) => k.bones.length === 2 && k.bones[1] === b.id) ?? false;
    const inh = { rotation: true, scale: true, reflection: true, ...b.inherit };
    const flag = (key: 'rotation' | 'scale' | 'reflection', label: string, hint: string) => {
      const el = checkbox(label, inh[key], `bone-inherit-${key}`, (v) => app.guard(() => ed.mutate(`Inherit ${key}`, (q) => setBoneInherit(q, b.id, { [key]: v }))), ikChild ? 'The second bone of an IK chain always inherits its parent fully.' : hint);
      if (ikChild) (el.querySelector('input') as HTMLInputElement).disabled = true;
      return el;
    };
    if (b.parentId)
      out.push(
        h('div', { class: 'group-label' }, 'Inherit from parent'),
        flag('rotation', 'Rotation', 'Off: the bone keeps its own screen angle when its parent turns (its position still follows).'),
        flag('scale', 'Scale', 'Off: a squashed or stretched parent does not squash, shear or shorten this bone.'),
        flag('reflection', 'Reflection', 'Off: the bone stays unmirrored under a mirrored parent.'),
      );
  }
  if (ed.mode === 'setup')
    out.push(checkbox('Pivot mode (Move tool moves only this origin)', ed.pivotMode, 'pivot-mode', (v) => {
      ed.pivotMode = v;
      ed.emit('view');
      app.status(v ? 'Pivot mode: drag a bone to move its rotation point; its images and child bones stay where they are.' : 'Pivot mode off.');
    }));
  return out;
}

// ---- Constraint inspector -------------------------------------------------------------------

export function renderConstraintInspector(app: App, root: HTMLElement, id: string): void {
  const { ed } = app;
  const p = ed.project;
  const ik = p.ik?.find((k) => k.id === id);
  const pc = p.pathConstraints?.find((k) => k.id === id);
  const tc = p.transformConstraints?.find((k) => k.id === id);
  if (!ik && !pc && !tc) return;
  const anim = ed.mode === 'animate' ? ed.anim() : null;
  const t = anim ? snapToFrame(ed.time, anim.fps) : 0;
  const name = (bid: string) => p.bones.find((b) => b.id === bid)?.name ?? '?';
  const setC = <T extends IkConstraint | PathConstraint | TransformConstraint>(label: string, fn: (c: T) => void) =>
    ed.mutate(label, (q) => fn(([...(q.ik ?? []), ...(q.pathConstraints ?? []), ...(q.transformConstraints ?? [])] as (IkConstraint | PathConstraint | TransformConstraint)[]).find((c) => c.id === id) as T));
  const keyable = (ch: 'mix' | 'position' | 'angle', value: number, base: number, testId: string, label: string, opts: { min?: number; max?: number; step?: number }) => {
    if (!anim) return numberField({ label, value: base, ...opts, testId, onCommit: (v) => setC(`Edit ${ch}`, (c) => void ((c as unknown as Record<string, number>)[ch] = ch === 'mix' ? Math.min(1, Math.max(0, v)) : v)) });
    const keys = laneKeys(anim, constraintLane(id, ch)) ?? [];
    const has = findKeyIndex(keys, t) >= 0;
    return h('div', { class: 'row-key' },
      numberField({ label, value, ...opts, testId, onCommit: (v) => ed.mutate(`Key ${ch}`, (q) => keyConstraint(animOf(q, anim.id)!, id, ch, t, v)) }),
      keyToggle(has, `${testId.split('-')[0]}-key-${ch}`, ch, () => ed.mutate(has ? `Remove ${ch} key` : `Key ${ch}`, (q) => {
        const an = animOf(q, anim.id)!;
        if (has) {
          const ks = laneKeys(an, constraintLane(id, ch))!;
          ks.splice(findKeyIndex(ks, t), 1);
        } else keyConstraint(an, id, ch, t, value);
      })),
    );
  };
  if (ik) {
    const targets = validIkTargets(p, ik.bones).map((b) => ({ value: b.id, label: b.name }));
    append(root,
      h('div', { class: 'kind-badge' }, `${ik.bones.length}-bone IK${anim ? ` · keying at frame ${Math.round(t * anim.fps)}` : ' · setup'}`),
      textField('Name', ik.name, 'constraint-name', (v) => setC('Rename constraint', (c) => void (c.name = v))),
      h('p', { class: 'dim', 'data-testid': 'ik-chain' }, `Chain: ${ik.bones.map(name).join(' → ')}`),
      select('ik-target', 'Target', targets, ik.target, (v) => setC<IkConstraint>('IK target', (c) => void (c.target = v))),
      keyable('mix', constraintMix(anim, id, t, ik.mix), ik.mix, 'ik-mix', 'Mix', { min: 0, max: 1, step: 0.05 }),
      ik.bones.length === 2 ? checkbox('Bend clockwise (elbow side)', ik.bendPositive, 'ik-bend', (v) => setC<IkConstraint>('IK bend direction', (c) => void (c.bendPositive = v))) : null,
      h('button', { class: 'linklike', 'data-testid': 'goto-ik-target', onclick: () => ed.select({ kind: 'bone', id: ik.target }) }, `Select target “${name(ik.target)}”`),
      h('p', { class: 'hint' }, 'Unreachable targets straighten the chain toward them; a target on the chain root leaves the keyed pose. Mirrored parents mirror the bend.'),
      h('button', { class: 'mini danger', 'data-testid': 'constraint-delete', onclick: () => deleteC(app, id) }, 'Delete constraint'),
    );
    return;
  }
  if (tc) {
    const bones = p.bones.filter((b) => b.id !== tc.bone).map((b) => ({ value: b.id, label: b.name }));
    const rot = tc.kind === 'rotation';
    append(root,
      h('div', { class: 'kind-badge' }, `${rot ? 'Rotation' : 'Aim'} constraint${anim ? ` · keying at frame ${Math.round(t * anim.fps)}` : ' · setup'}`),
      textField('Name', tc.name, 'constraint-name', (v) => setC('Rename constraint', (c) => void (c.name = v))),
      h('p', { class: 'dim', 'data-testid': 'tc-bone' }, `Bone: ${name(tc.bone)}`),
      rot
        ? select('tc-source', 'Bend of', bones, tc.source ?? '', (v) => setC<TransformConstraint>('Constraint source', (c) => void (c.source = v)))
        : select('tc-relative', 'Angle relative to', [{ value: '', label: '— screen' }, ...bones], tc.relativeTo ?? '', (v) => setC<TransformConstraint>('Aim reference', (c) => void (c.relativeTo = v || null))),
      rot ? numberField({ label: 'Fraction of the bend', value: tc.factor, step: 0.05, testId: 'tc-factor', onCommit: (v) => setC<TransformConstraint>('Constraint fraction', (c) => void (c.factor = v)) }) : null,
      keyable('angle', transformAngle(anim, tc, t), tc.angle, 'tc-angle', rot ? 'Offset (°)' : 'Held angle (°)', { step: 1 }),
      keyable('mix', constraintMix(anim, id, t, tc.mix), tc.mix, 'tc-mix', 'Mix', { min: 0, max: 1, step: 0.05 }),
      rot ? checkbox('Keep joint volume (mitre scale Y)', !!tc.mitre, 'tc-mitre', (v) => setC<TransformConstraint>('Constraint mitre', (c) => void (v ? (c.mitre = { k: 1, max: 2.2 }) : delete c.mitre))) : null,
      rot && tc.mitre
        ? h('div', { class: 'row2' },
            numberField({ label: 'Mitre amount', value: tc.mitre.k, min: 0, max: 4, step: 0.05, testId: 'tc-mitre-k', onCommit: (v) => setC<TransformConstraint>('Mitre amount', (c) => void (c.mitre!.k = Math.max(0, v))) }),
            numberField({ label: 'Max scale', value: tc.mitre.max, min: 1, max: 10, step: 0.1, testId: 'tc-mitre-max', onCommit: (v) => setC<TransformConstraint>('Mitre max', (c) => void (c.mitre!.max = Math.max(1, v))) }),
          )
        : null,
      h('p', { class: 'hint' }, rot
        ? 'Rotation = offset + fraction × the source bone’s bend (its angle to its parent). Mitre scales Y by up to 1/cos(bend/2) so the joint keeps its width. Applied after IK and paths.'
        : 'Holds the bone’s screen angle (plus the reference bone’s angle) whatever its parents do. Key the angle to turn it. Applied after IK and paths.'),
      h('button', { class: 'mini danger', 'data-testid': 'constraint-delete', onclick: () => deleteC(app, id) }, 'Delete constraint'),
    );
    return;
  }
  const c = pc!;
  const paths = (p.paths ?? []).map((x) => ({ value: x.id, label: x.name }));
  append(root,
    h('div', { class: 'kind-badge' }, `Path constraint${anim ? ` · keying at frame ${Math.round(t * anim.fps)}` : ' · setup'}`),
    textField('Name', c.name, 'constraint-name', (v) => setC('Rename constraint', (x) => void (x.name = v))),
    select('pc-path', 'Path', paths, c.pathId, (v) => setC<PathConstraint>('Constraint path', (x) => void (x.pathId = v))),
    h('p', { class: 'dim', 'data-testid': 'pc-bones' }, `Bones: ${c.bones.map(name).join(', ')}`),
    keyable('position', pathPosition(anim, c, t), c.position, 'pc-position', 'Position (0–1)', { step: 0.05 }),
    keyable('mix', constraintMix(anim, id, t, c.mix), c.mix, 'pc-mix', 'Mix', { min: 0, max: 1, step: 0.05 }),
    numberField({ label: 'Spacing (px)', value: c.spacing, testId: 'pc-spacing', onCommit: (v) => setC<PathConstraint>('Path spacing', (x) => void (x.spacing = v)) }),
    checkbox('Rotate to path', c.rotate, 'pc-rotate', (v) => setC<PathConstraint>('Path rotate', (x) => void (x.rotate = v))),
    numberField({ label: 'Rotation offset', value: c.rotateOffset, testId: 'pc-offset', onCommit: (v) => setC<PathConstraint>('Path rotation offset', (x) => void (x.rotateOffset = v)) }),
    h('p', { class: 'hint' }, 'Bones sit at arc length position × length + i × spacing. Open paths clamp at the ends; closed paths wrap.'),
    h('button', { class: 'mini danger', 'data-testid': 'constraint-delete', onclick: () => deleteC(app, id) }, 'Delete constraint'),
  );
}

function deleteC(app: App, id: string): void {
  app.ed.mutate('Delete constraint', (q) => deleteConstraint(q, id));
  app.ed.select(null);
}

// ---- Path inspector ------------------------------------------------------------------------

export function renderPathInspector(app: App, root: HTMLElement, id: string): void {
  const { ed } = app;
  const p = ed.project;
  const path = p.paths?.find((x) => x.id === id);
  if (!path) return;
  const setP = (label: string, fn: (x: NonNullable<Project['paths']>[number]) => void) => ed.mutate(label, (q) => fn(q.paths!.find((x) => x.id === id)!));
  const ni = Math.min(ed.pathNode, path.nodes.length - 1);
  const n = path.nodes[ni];
  const owners = new Set((p.pathConstraints ?? []).filter((c) => c.pathId === id).flatMap((c) => c.bones));
  const picks = new Map<string, HTMLInputElement>();
  const boneChoices = p.bones.filter((b) => !(path.boneId && isUnder(p, b.id, path.boneId)));
  append(root,
    h('div', { class: 'kind-badge' }, 'Path · setup data'),
    textField('Name', path.name, 'path-name', (v) => setP('Rename path', (x) => void (x.name = v))),
    h('p', { class: 'dim' }, `Space: ${p.bones.find((b) => b.id === path.boneId)?.name ?? 'world'} · ${path.nodes.length} nodes`),
    checkbox('Closed', path.closed, 'path-closed', (v) => setP(v ? 'Close path' : 'Open path', (x) => void (x.closed = v))),
    h('div', { class: 'group-label' }, `Node ${ni + 1} (drag squares/handles on the canvas)`),
    h('div', { class: 'row2' },
      numberField({ label: 'X', value: n.x, testId: 'path-node-x', onCommit: (v) => setP('Move path node', (x) => void (x.nodes[ni].x = v)) }),
      numberField({ label: 'Y', value: n.y, testId: 'path-node-y', onCommit: (v) => setP('Move path node', (x) => void (x.nodes[ni].y = v)) }),
    ),
    h('div', { class: 'row2' },
      h('button', { class: 'mini', 'data-testid': 'path-add-node', onclick: () => setP('Add path node', addPathNode) }, '+ Node'),
      h('button', { class: 'mini', 'data-testid': 'path-remove-node', disabled: path.nodes.length <= 2, onclick: () => setP('Remove path node', (x) => void x.nodes.splice(ni, 1)) }, 'Remove node'),
    ),
    h('div', { class: 'group-label' }, 'Constrain bones to this path'),
    h('div', { class: 'bone-picks' }, ...boneChoices.map((b) => {
      const input = h('input', { type: 'checkbox', 'data-testid': `pc-bone-${b.name}`, 'aria-label': b.name, disabled: owners.has(b.id) });
      picks.set(b.id, input);
      return h('label', { class: 'pick' }, input, b.name);
    })),
    h('button', { class: 'mini accent', 'data-testid': 'path-constrain', onclick: () => {
      const chosen = [...picks.entries()].filter(([, el]) => el.checked).map(([bid]) => bid);
      if (!chosen.length) return app.status('Tick the bones to place along the path (in order).');
      const cid = newId('pc');
      ed.mutate('Add path constraint', (q) => void addPathConstraint(q, cid, id, chosen));
      ed.select({ kind: 'constraint', id: cid });
    } }, 'Create path constraint'),
    h('button', { class: 'mini danger', 'data-testid': 'path-delete', onclick: () => {
      ed.mutate('Delete path', (q) => deletePath(q, id));
      ed.select(null);
    } }, 'Delete path'),
  );
}

function isUnder(p: Project, boneId: string, ancestor: string): boolean {
  let cur: string | null = boneId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = p.bones.find((b) => b.id === cur)?.parentId ?? null;
  }
  return false;
}

// ---- Left panel: constraints and paths list -------------------------------------------------

export function renderConstraintList(app: App, root: HTMLElement): void {
  const { ed } = app;
  const p = ed.project;
  const sel = ed.selection;
  const row = (kind: 'constraint' | 'path', id: string, label: string, glyph: string, testId: string) =>
    h('button', { class: `tree-row${sel?.kind === kind && sel.id === id ? ' selected' : ''}`, 'data-testid': testId, onclick: () => ed.select({ kind, id }) }, h('span', { class: 'glyph' }, glyph), label);
  const items = [
    ...(p.ik ?? []).map((k) => row('constraint', k.id, k.name, '⤳', `tree-constraint-${k.name}`)),
    ...(p.paths ?? []).map((x) => row('path', x.id, x.name, '∿', `tree-path-${x.name}`)),
    ...(p.pathConstraints ?? []).map((k) => row('constraint', k.id, k.name, '⇢', `tree-constraint-${k.name}`)),
    ...(p.transformConstraints ?? []).map((k) => row('constraint', k.id, k.name, k.kind === 'aim' ? '➚' : '↻', `tree-constraint-${k.name}`)),
  ];
  root.append(
    h('div', { class: 'panel-head' },
      h('h2', {}, 'Constraints'),
      h('button', { class: 'mini', 'data-testid': 'add-path', title: 'Add a Bezier path (in the selected bone’s space, else world)', onclick: () => {
        const id = newId('path');
        const c = app.viewport.toWorld(app.viewport.canvas.clientWidth / 2, app.viewport.canvas.clientHeight / 2);
        ed.mutate('Add path', (q) => void addPath(q, id, ed.selectedBoneId(), c));
        ed.select({ kind: 'path', id });
      } }, '+ Path'),
    ),
    items.length ? h('div', { class: 'tree', 'data-testid': 'constraint-list' }, ...items) : h('p', { class: 'empty' }, 'No constraints or paths. Select a bone and use “+ 2-bone IK”, “+ Rotation” or “+ Aim” in the inspector, or add a path.'),
  );
}

function textField(label: string, value: string, testId: string, onCommit: (v: string) => void): HTMLElement {
  const input = h('input', { type: 'text', value, 'data-testid': testId, 'aria-label': label, spellcheck: 'false' });
  input.addEventListener('change', () => input.value.trim() && onCommit(input.value.trim()));
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input);
}
