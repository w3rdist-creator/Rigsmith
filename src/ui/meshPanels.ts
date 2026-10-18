// Phase-3 inspector section for mesh attachments: create/re-mesh/remove, canvas tools
// (vertex editing, weight painting), the weight brush, per-vertex position/weights in
// Setup mode and per-vertex deform offsets + deform keys in Animate mode.
import { findKeyIndex, snapToFrame } from '../model/animation.ts';
import { laneKeys, slotLane } from '../model/keys.ts';
import { autoWeights, deformAt, keyDeform, meshSummary, moveMeshPoint, normalizeWeights, paintVertex, setMesh } from '../model/meshOps.ts';
import type { PaintMode } from '../model/meshOps.ts';
import { isAncestorOrSelf } from '../model/skeleton.ts';
import type { Attachment } from '../model/types.ts';
import type { App } from './app.ts';
import { h, numberField } from './dom.ts';

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function labeledSelect(testId: string, label: string, options: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLElement {
  const el = h('select', { 'data-testid': testId, 'aria-label': label }, ...options.map((o) => h('option', { value: o.value }, o.label)));
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), el);
}

export function meshSection(app: App, a: Attachment): HTMLElement[] {
  const { ed } = app;
  const p = ed.project;
  const anim = ed.anim();
  const animating = ed.mode === 'animate' && !!anim;
  const out: HTMLElement[] = [h('div', { class: 'group-label' }, 'Mesh')];
  if (!a.mesh) {
    if (animating) out.push(h('p', { class: 'hint' }, 'No mesh. Create one in Setup mode (Tab) to bend this image.'));
    else out.push(h('button', { class: 'mini', 'data-testid': 'mesh-create', title: 'Outline the image and add interior points; the image then bends with its vertices', onclick: () => app.meshDialog.open(a.id) }, '▦ Create mesh…'));
    return out;
  }
  const mesh = a.mesh;
  const setMeshAtt = (label: string, fn: (x: Attachment) => void) => ed.mutate(label, (q) => fn(q.attachments.find((x) => x.id === a.id)!));
  const tool = (t: 'vertices' | 'weights', label: string, testId: string, title: string, disabled = false) =>
    h('button', {
      class: `mini${ed.meshTool === t ? ' on' : ''}`,
      'data-testid': testId,
      'aria-pressed': ed.meshTool === t ? 'true' : 'false',
      title,
      disabled,
      onclick: () => {
        ed.meshTool = ed.meshTool === t ? 'off' : t;
        ed.emit('selection');
      },
    }, label);
  out.push(h('p', { class: 'dim', 'data-testid': 'mesh-summary' }, meshSummary(mesh)));
  const vi = ed.meshVertex;
  if (!animating) {
    const fallback = a.boneId;
    const auto = fallback ? p.bones.filter((b) => isAncestorOrSelf(p.bones, fallback, b.id)) : [];
    out.push(
      h('div', { class: 'row2' },
        tool('vertices', 'Edit vertices', 'mesh-tool-vertices', 'Drag vertices on the canvas: moves the point on the image (the art stays put)'),
        tool('weights', 'Paint weights', 'mesh-tool-weights', 'Drag on the canvas to paint the brush bone’s influence', !fallback),
      ),
      h('div', { class: 'row2' },
        h('button', { class: 'mini', 'data-testid': 'mesh-edit', title: 'Re-draw the outline / interior points (resets weights and deform keys)', onclick: () => app.meshDialog.open(a.id) }, 'Re-mesh…'),
        h('button', { class: 'mini', 'data-testid': 'mesh-remove', title: 'Back to a flat image (its deform keys are removed)', onclick: () => ed.mutate('Remove mesh', (q) => setMesh(q, a.id, null)) }, 'Remove mesh'),
      ),
      h('div', { class: 'row2' },
        h('button', {
          class: 'mini',
          'data-testid': 'weights-auto',
          disabled: !auto.length,
          title: `Weight every vertex to the nearest of: ${auto.map((b) => b.name).join(', ') || '(no bone)'}`,
          onclick: () => setMeshAtt('Auto weights', (x) => void (x.mesh!.weights = autoWeights(ed.project, x, auto.map((b) => b.id)))),
        }, 'Auto weights'),
        h('button', { class: 'mini', 'data-testid': 'weights-rigid', disabled: !mesh.weights, title: 'Remove weights: the mesh follows its attachment’s bone rigidly', onclick: () => setMeshAtt('Make mesh rigid', (x) => void delete x.mesh!.weights) }, 'Make rigid'),
      ),
    );
    if (ed.meshTool === 'weights') {
      const b = ed.brush;
      const opts = p.bones.map((x) => ({ value: x.id, label: x.name }));
      out.push(
        h('div', { class: 'group-label' }, 'Weight brush'),
        labeledSelect('wp-bone', 'Bone', opts, b.boneId ?? fallback ?? '', (v) => ((b.boneId = v), ed.emit('view'))),
        labeledSelect('wp-mode', 'Mode', [{ value: 'add', label: 'Add' }, { value: 'subtract', label: 'Subtract' }, { value: 'replace', label: 'Replace' }], b.mode, (v) => ((b.mode = v as PaintMode), ed.emit('view'))),
        h('div', { class: 'row2' },
          numberField({ label: 'Radius (px)', value: b.radius, min: 2, max: 400, testId: 'wp-radius', onCommit: (v) => ((b.radius = Math.min(400, Math.max(2, v))), ed.emit('view')) }),
          numberField({ label: 'Strength', value: b.strength, step: 0.05, min: 0, max: 1, testId: 'wp-strength', onCommit: (v) => ((b.strength = Math.min(1, Math.max(0, v))), ed.emit('view')) }),
        ),
        h('p', { class: 'hint' }, 'Each dab adds strength × (1 − distance/radius); weights renormalize to 1 per vertex. One stroke = one undo step.'),
      );
    }
    if (vi >= 0) {
      const list = mesh.weights?.[vi];
      out.push(
        h('div', { class: 'group-label' }, `Vertex ${vi}${vi < mesh.hull ? ' (outline)' : ''}`),
        h('div', { class: 'row2' },
          numberField({ label: 'Image X', value: mesh.points[2 * vi], testId: 'mv-x', onCommit: (v) => setMeshAtt('Move mesh vertex', (x) => moveMeshPoint(ed.project, x, vi, v, x.mesh!.points[2 * vi + 1])) }),
          numberField({ label: 'Image Y', value: mesh.points[2 * vi + 1], testId: 'mv-y', onCommit: (v) => setMeshAtt('Move mesh vertex', (x) => moveMeshPoint(ed.project, x, vi, x.mesh!.points[2 * vi], v)) }),
        ),
      );
      if (list && fallback) {
        const nameOf = (id: string) => p.bones.find((x) => x.id === id)?.name ?? id;
        for (const inf of list)
          out.push(numberField({
            label: `Weight · ${nameOf(inf.bone)}`,
            value: round3(inf.w),
            step: 0.05,
            min: 0,
            max: 1,
            testId: `mv-w-${nameOf(inf.bone)}`,
            onCommit: (v) => setMeshAtt('Edit vertex weight', (x) => void (x.mesh!.weights![vi] = paintVertex(x.mesh!.weights![vi], inf.bone, v, 'replace', fallback))),
          }));
        const missing = p.bones.filter((x) => !list.some((i) => i.bone === x.id));
        if (missing.length)
          out.push(labeledSelect('mv-add-bone', 'Add influence', [{ value: '', label: '—' }, ...missing.map((x) => ({ value: x.id, label: x.name }))], '', (v) => {
            if (v) setMeshAtt('Add vertex influence', (x) => void (x.mesh!.weights![vi] = normalizeWeights([...x.mesh!.weights![vi].map((i) => ({ ...i, w: i.w * 0.5 })), { bone: v, w: 0.5 }])!));
          }));
      } else out.push(h('p', { class: 'hint' }, 'Rigid mesh: paint weights or use Auto weights to bend it with several bones.'));
    }
    return out;
  }

  const an = anim!;
  const t = snapToFrame(ed.time, an.fps);
  const frame = Math.round(t * an.fps);
  const keys = laneKeys(an, slotLane(a.id, 'deform')) ?? [];
  const keyed = findKeyIndex(keys, t) >= 0;
  const cur = deformAt(an, a, t);
  const mutateAnim = (label: string, fn: (q: typeof an) => void) => ed.mutate(label, (q) => fn(q.animations.find((x) => x.id === an.id)!));
  out.push(
    h('div', { class: 'row-key' },
      tool('vertices', 'Deform vertices', 'mesh-tool-vertices', 'Drag vertices on the canvas to key a deform at this frame'),
      h('button', {
        class: `keybtn${keyed ? ' on' : ''}`,
        'data-testid': 'slot-key-deform',
        'aria-pressed': keyed ? 'true' : 'false',
        'aria-label': 'deform key at current frame',
        title: keyed ? 'Remove the deform key at this frame' : 'Key the current deform at this frame',
        onclick: () => {
          if (keyed) mutateAnim('Remove deform key', (q) => {
            const ks = laneKeys(q, slotLane(a.id, 'deform'))!;
            ks.splice(findKeyIndex(ks, t), 1);
          });
          else mutateAnim('Key deform', (q) => keyDeform(q, a.id, t, cur));
        },
      }, '◆'),
    ),
    h('button', { class: 'mini', 'data-testid': 'deform-reset', title: 'Key the undeformed mesh at this frame', onclick: () => mutateAnim('Reset deform', (q) => keyDeform(q, a.id, t, cur.map(() => 0))) }, `Reset deform at frame ${frame}`),
  );
  if (vi >= 0)
    out.push(
      h('div', { class: 'group-label' }, `Vertex ${vi} deform · frame ${frame}`),
      h('div', { class: 'row2' },
        numberField({ label: 'Offset X', value: cur[2 * vi], testId: 'mv-dx', onCommit: (v) => mutateAnim('Key deform', (q) => keyDeform(q, a.id, t, cur.map((o, k) => (k === 2 * vi ? v : o)))) }),
        numberField({ label: 'Offset Y', value: cur[2 * vi + 1], testId: 'mv-dy', onCommit: (v) => mutateAnim('Key deform', (q) => keyDeform(q, a.id, t, cur.map((o, k) => (k === 2 * vi + 1 ? v : o)))) }),
      ),
    );
  out.push(h('p', { class: 'hint' }, 'Deform offsets are in image pixels, keyed for the whole mesh at once, and interpolate between keys.'));
  return out;
}
