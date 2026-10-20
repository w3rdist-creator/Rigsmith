// Phase-3 inspector section for mesh attachments: create/re-mesh/remove, canvas tools
// (vertex editing, weight painting), the weight brush, per-vertex position/weights in
// Setup mode and per-vertex deform offsets + deform keys in Animate mode.
import { findKeyIndex, snapToFrame } from '../model/animation.ts';
import { laneKeys, slotLane } from '../model/keys.ts';
import { autoWeights, deformAt, keyDeform, meshSummary, moveMeshPoint, normalizeWeights, paintVertex, setMesh } from '../model/meshOps.ts';
import type { PaintMode } from '../model/meshOps.ts';
import { limbWeights, mirrorWeights, smoothWeights, suffixBoneMap } from '../model/limbWeights.ts';
import { isAncestorOrSelf } from '../model/skeleton.ts';
import { radialAlphas, withVertexAlpha } from '../model/color.ts';
import type { Attachment } from '../model/types.ts';
import type { App } from './app.ts';
import { h, numberField } from './dom.ts';

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Limb-weight form state per attachment (survives re-renders of the inspector). */
type LimbForm = {
  upper: string; lower: string; helper: string; inner: number; outer: number; side: 1 | -1;
  endBone: string; endAt: number; endBand: number; endMax: number; rootBone: string; rootFrom: number; rootTo: number;
  mirrorFrom: string; swapFrom: string; swapTo: string;
};
const limbForms = new Map<string, LimbForm>();

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
    out.push(...limbSection(app, a, setMeshAtt), ...alphaSection(app, a, setMeshAtt));
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
        numberField({ label: 'Vertex alpha', value: round3(mesh.alphas?.[vi] ?? 1), step: 0.05, min: 0, max: 1, testId: 'mv-alpha', onCommit: (v) => setMeshAtt('Edit vertex alpha', (x) => void (x.mesh!.alphas = withVertexAlpha(x, vi, v))) }),
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

/**
 * Limb weights (R1): one continuous limb image bends as a round tube. Upper → lower over a
 * band around the joint (tight inside the bend, wide outside), an optional helper bone
 * takes the joint line; plus smoothing and copying from the mirrored limb.
 */
function limbSection(app: App, a: Attachment, setMeshAtt: (label: string, fn: (x: Attachment) => void) => void): HTMLElement[] {
  const { ed } = app;
  const p = ed.project;
  const mesh = a.mesh!;
  const upper0 = a.boneId ?? p.bones[0]?.id ?? '';
  const f = limbForms.get(a.id) ?? {
    upper: upper0, lower: p.bones.find((b) => b.parentId === upper0)?.id ?? upper0, helper: '',
    inner: 20, outer: 40, side: 1,
    endBone: '', endAt: p.images.find((i) => i.id === a.imageId)?.width ?? 100, endBand: 10, endMax: 0.5, rootBone: '', rootFrom: 0, rootTo: 20,
    mirrorFrom: '', swapFrom: '_l', swapTo: '_r',
  };
  limbForms.set(a.id, f);
  const bones = p.bones.map((b) => ({ value: b.id, label: b.name }));
  const mirrors = p.attachments.filter((x) => x.id !== a.id && x.mesh?.weights && x.mesh.points.length === mesh.points.length);
  const ok = !!f.upper && !!f.lower && f.upper !== f.lower;
  const run = (label: string, fn: (x: Attachment) => void) => {
    try {
      setMeshAtt(label, fn);
    } catch (e) {
      app.error('Weights not changed', [(e as Error).message]);
    }
  };
  return [
    h('div', { class: 'group-label' }, 'Limb weights'),
    h('div', { class: 'row2' },
      labeledSelect('lw-upper', 'Upper bone', bones, f.upper, (v) => ((f.upper = v), ed.emit('view'))),
      labeledSelect('lw-lower', 'Lower bone', bones, f.lower, (v) => ((f.lower = v), ed.emit('view'))),
    ),
    h('div', { class: 'row2' },
      labeledSelect('lw-helper', 'Joint helper', [{ value: '', label: '— none' }, ...bones], f.helper, (v) => ((f.helper = v), ed.emit('view'))),
      labeledSelect('lw-side', 'Bends toward', [{ value: '1', label: 'bone +y' }, { value: '-1', label: 'bone −y' }], String(f.side), (v) => ((f.side = v === '-1' ? -1 : 1), ed.emit('view'))),
    ),
    h('div', { class: 'row2' },
      numberField({ label: 'Inside band (px)', value: f.inner, min: 1, max: 1000, testId: 'lw-inner', onCommit: (v) => ((f.inner = Math.max(1, v)), ed.emit('view')) }),
      numberField({ label: 'Outside band (px)', value: f.outer, min: 1, max: 1000, testId: 'lw-outer', onCommit: (v) => ((f.outer = Math.max(1, v)), ed.emit('view')) }),
    ),
    h('div', { class: 'row2' },
      labeledSelect('lw-end-bone', 'Tip follows', [{ value: '', label: '— none' }, ...bones], f.endBone, (v) => ((f.endBone = v), ed.emit('view'))),
      numberField({ label: 'Tip share (max)', value: f.endMax, min: 0, max: 1, step: 0.05, testId: 'lw-end-max', onCommit: (v) => ((f.endMax = Math.min(1, Math.max(0, v))), ed.emit('view')) }),
    ),
    ...(f.endBone ? [h('div', { class: 'row2' },
      numberField({ label: 'Tip at (px along)', value: f.endAt, min: -10000, max: 10000, testId: 'lw-end-at', onCommit: (v) => ((f.endAt = v), ed.emit('view')) }),
      numberField({ label: 'Tip band (px)', value: f.endBand, min: 1, max: 1000, testId: 'lw-end-band', onCommit: (v) => ((f.endBand = Math.max(1, v)), ed.emit('view')) }),
    )] : []),
    h('div', { class: 'row2' },
      labeledSelect('lw-root-bone', 'Top stays on', [{ value: '', label: '— none' }, ...bones], f.rootBone, (v) => ((f.rootBone = v), ed.emit('view'))),
    ),
    ...(f.rootBone ? [h('div', { class: 'row2' },
      numberField({ label: 'Top full until (px)', value: f.rootFrom, min: -10000, max: 10000, testId: 'lw-root-from', onCommit: (v) => ((f.rootFrom = v), ed.emit('view')) }),
      numberField({ label: 'Top released at (px)', value: f.rootTo, min: -10000, max: 10000, testId: 'lw-root-to', onCommit: (v) => ((f.rootTo = v), ed.emit('view')) }),
    )] : []),
    h('div', { class: 'row2' },
      h('button', {
        class: 'mini', 'data-testid': 'weights-limb', disabled: !ok,
        title: 'Weight the mesh as one bending limb: upper → lower across the joint band, the helper on the joint line',
        onclick: () => run('Limb weights', (x) => void (x.mesh!.weights = limbWeights(ed.project, x, {
          upper: f.upper, lower: f.lower, ...(f.helper ? { helper: f.helper } : {}), band: { inner: f.inner, outer: f.outer, side: f.side },
          ...(f.endBone ? { end: { bone: f.endBone, at: f.endAt, band: f.endBand, max: f.endMax } } : {}),
          ...(f.rootBone ? { root: { bone: f.rootBone, from: f.rootFrom, to: f.rootTo } } : {}),
        }))),
      }, 'Apply limb weights'),
      h('button', {
        class: 'mini', 'data-testid': 'weights-smooth', disabled: !mesh.weights,
        title: 'One smoothing pass: each vertex moves halfway toward its neighbours’ weights',
        onclick: () => run('Smooth weights', (x) => void (x.mesh!.weights = smoothWeights(x, 1))),
      }, 'Smooth weights'),
    ),
    h('div', { class: 'row2' },
      labeledSelect('wm-source', 'Mirror from', [{ value: '', label: mirrors.length ? '—' : '(no matching mesh)' }, ...mirrors.map((x) => ({ value: x.id, label: x.name }))], f.mirrorFrom, (v) => ((f.mirrorFrom = v), ed.emit('view'))),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Swap names'),
        (() => {
          const el = h('input', { 'data-testid': 'wm-swap', 'aria-label': 'Swap bone-name part, e.g. _l=_r', value: `${f.swapFrom}=${f.swapTo}` }) as HTMLInputElement;
          el.addEventListener('change', () => {
            const [from, to] = el.value.split('=');
            if (from && to !== undefined) ((f.swapFrom = from), (f.swapTo = to));
          });
          return el;
        })()),
    ),
    h('button', {
      class: 'mini', 'data-testid': 'weights-mirror', disabled: !f.mirrorFrom,
      title: 'Copy the other limb’s weights vertex for vertex, renaming its bones (e.g. _l → _r)',
      onclick: () => run('Mirror weights', (x) => void (x.mesh!.weights = mirrorWeights(ed.project.attachments.find((y) => y.id === f.mirrorFrom)!, x, suffixBoneMap(ed.project, f.swapFrom, f.swapTo)))),
    }, 'Mirror weights'),
  ];
}

/** Radial fade form state per attachment. */
const alphaForms = new Map<string, { cx: number; cy: number; r0: number; r1: number; invert: boolean }>();

/** Mesh ▸ Vertex alpha: a radial fade (e.g. a crease that shows only in the knee pit) and clear. */
function alphaSection(app: App, a: Attachment, setMeshAtt: (label: string, fn: (x: Attachment) => void) => void): HTMLElement[] {
  const mesh = a.mesh!;
  let xs = 0, ys = 0;
  for (let i = 0; i < mesh.points.length; i += 2) {
    xs += mesh.points[i];
    ys += mesh.points[i + 1];
  }
  const n = mesh.points.length / 2;
  const f = alphaForms.get(a.id) ?? { cx: Math.round(xs / n), cy: Math.round(ys / n), r0: 10, r1: 40, invert: false };
  alphaForms.set(a.id, f);
  const inv = h('input', { type: 'checkbox', checked: f.invert, 'data-testid': 'va-invert', 'aria-label': 'Invert fade' });
  inv.addEventListener('change', () => void (f.invert = inv.checked));
  const faded = mesh.alphas ? mesh.alphas.filter((v) => v < 1).length : 0;
  return [
    h('div', { class: 'group-label' }, 'Vertex alpha'),
    h('p', { class: 'dim', 'data-testid': 'va-summary' }, mesh.alphas ? `${faded} of ${n} vertices below 1` : 'All vertices opaque'),
    h('div', { class: 'row2' },
      numberField({ label: 'Centre X', value: f.cx, testId: 'va-cx', onCommit: (v) => void (f.cx = v) }),
      numberField({ label: 'Centre Y', value: f.cy, testId: 'va-cy', onCommit: (v) => void (f.cy = v) }),
    ),
    h('div', { class: 'row2' },
      numberField({ label: 'Solid radius', value: f.r0, min: 0, testId: 'va-r0', onCommit: (v) => void (f.r0 = Math.max(0, v)) }),
      numberField({ label: 'Fade radius', value: f.r1, min: 0, testId: 'va-r1', onCommit: (v) => void (f.r1 = Math.max(0, v)) }),
    ),
    h('label', { class: 'field check' }, inv, h('span', {}, 'Invert (fade in toward the centre)')),
    h('div', { class: 'row2' },
      h('button', { class: 'mini', 'data-testid': 'va-radial', title: 'Alpha 1 within the solid radius of the centre (image px), fading to 0 at the fade radius', onclick: () => {
        try {
          setMeshAtt('Radial vertex alpha', (x) => void (x.mesh!.alphas = radialAlphas(x, f.cx, f.cy, f.r0, f.r1, f.invert)));
        } catch (e) {
          app.error('Vertex alpha not changed', [(e as Error).message]);
        }
      } }, 'Apply radial fade'),
      h('button', { class: 'mini', 'data-testid': 'va-clear', disabled: !mesh.alphas, title: 'Every vertex back to alpha 1', onclick: () => setMeshAtt('Clear vertex alpha', (x) => void delete x.mesh!.alphas) }, 'Clear'),
    ),
  ];
}
