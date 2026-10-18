// "Delivery frame" section of the project inspector (use-case review RV-003): a fixed
// export canvas stored in the project, so every loop and transition of a character is
// delivered at one size and origin. Exports offer it; art outside it is clipped (with a
// visible warning), never resized.
import { frameBounds, evaluate } from '../model/evaluate.ts';
import { fitFrameToAnimations } from '../model/sequence.ts';
import type { ProjectFrame } from '../model/types.ts';
import type { App } from './app.ts';
import { h, numberField } from './dom.ts';

/** The frame enclosing every animation (active skin) + 4 px; the setup pose if there are none. */
export function fitFrame(app: App): ProjectFrame | null {
  const p = app.ed.project;
  const skinId = app.ed.skinId;
  const sample = (a: Parameters<typeof evaluate>[1], t: number) => frameBounds(evaluate(p, a, t, { skinId }));
  return fitFrameToAnimations(p, sample) ?? fitFrameToAnimations({ ...p, animations: [{ id: 'setup', name: 'setup', duration: 0, fps: 1, loop: false, tracks: {} }] }, sample);
}

export function frameSection(app: App): HTMLElement {
  const { ed } = app;
  const f = ed.project.frame;
  const fit = () => {
    const nf = fitFrame(app);
    if (!nf) return app.status('Nothing visible to frame: attach at least one image.');
    ed.mutate(f ? 'Fit project frame' : 'Set project frame', (q) => void (q.frame = nf));
    app.status(`Project frame ${nf.width}×${nf.height} at (${nf.x}, ${nf.y}) encloses every animation. Exports can use it (art outside a frame is clipped).`);
  };
  const fitBtn = h('button', { class: 'mini', 'data-testid': 'frame-fit', title: 'Set the frame to enclose every pose of every animation (+4 px)', onclick: fit }, f ? 'Fit to all animations' : 'Set frame: fit to all animations');
  if (!f)
    return h('div', { class: 'frame-section', 'data-testid': 'frame-section' },
      h('div', { class: 'group-label' }, 'Delivery frame'),
      h('p', { class: 'hint' }, 'No fixed frame: each export fits its own animation, so sizes differ between loops.'),
      fitBtn);
  const set = (k: keyof ProjectFrame, label: string) => (v: number) => {
    if ((k === 'width' || k === 'height') && !(v >= 1 && v <= 8192)) return app.status('Frame width and height must be from 1 to 8192.');
    ed.mutate(`Frame ${label}`, (q) => void (q.frame = { ...q.frame!, [k]: v }));
  };
  return h('div', { class: 'frame-section', 'data-testid': 'frame-section' },
    h('div', { class: 'group-label' }, 'Delivery frame'),
    h('div', { class: 'row2' },
      numberField({ label: 'Left (world X)', value: f.x, testId: 'frame-x', onCommit: set('x', 'left') }),
      numberField({ label: 'Top (world Y)', value: f.y, testId: 'frame-y', onCommit: set('y', 'top') })),
    h('div', { class: 'row2' },
      numberField({ label: 'Width', value: f.width, min: 1, testId: 'frame-width', onCommit: set('width', 'width') }),
      numberField({ label: 'Height', value: f.height, min: 1, testId: 'frame-height', onCommit: set('height', 'height') })),
    h('p', { class: 'hint', 'data-testid': 'frame-summary' }, `${Math.round(f.width)}×${Math.round(f.height)} px at scale 1, shown dashed on the canvas. Exports choosing “Project frame” use exactly this canvas; art outside it is clipped with a warning.`),
    h('div', { class: 'row2' },
      fitBtn,
      h('button', { class: 'mini', 'data-testid': 'frame-clear', title: 'Remove the fixed frame (exports fit each animation again)', onclick: () => ed.mutate('Remove project frame', (q) => void delete q.frame) }, 'Remove frame')),
  );
}
