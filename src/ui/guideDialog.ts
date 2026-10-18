// "Flat-art guide" (RV-012): a non-modal checklist from one flat character PNG to a first
// idle. Every step is a visible button on top of an existing tool — the image import,
// the Cut out piece… dialog (opened with guide presets and a note), the mesh grid + auto
// weights, and a starter idle — and every edit is one undo step. Progress is derived
// from the project (src/model/onboarding.ts), so undo, reload and old files just work.
// The step notes carry the RV-010 real-art findings (docs/RV010-CUTOUT-SHORTFALLS.md).
import type { GuideStep, GuideStepId } from '../model/onboarding.ts';
import { firstIdle, guideArt, guideSteps, meshArt, startRig } from '../model/onboarding.ts';
import { newId } from '../model/types.ts';
import type { App } from './app.ts';
import { clear, h } from './dom.ts';

const LIMB_HINT =
  'Guide preset: Overlap 0, Extend under joint 40 px. Outline one limb with the cut line exactly on the joint edge, then Pivot at the joint. ' +
  'Measured limits on real art: extension reaches only back past the pivot (not the far end) and at most 64 px; the canvas has no zoom; a point exactly on the image edge is not registered — click just inside.';
const COLOUR_HINT =
  'Guide preset: Select colour, tolerance 255, Overlap 0. With the limb above it already cut, one click takes the whole connected hand or shoe including its dark outline. Pivot at the wrist/ankle and pick the limb’s bone as Bone parent.';
const CLEAN_HINT = 'Use “Remove specks” below (defaults: faint α < 100 with no α > 200 within 6 px). It makes a cleaned copy; the original stays in the project.';

const TIPS: Record<GuideStepId, string> = {
  import: 'One PNG with a transparent background, the character front-on, with some background between the limbs and the body — that gap is what lets each limb come off cleanly.',
  rig: 'Creates a root bone at the centre of the view and puts the art on it, centred. One undo step.',
  clean: 'Faint strays far from the art (the Wiz test art had 3,004) would otherwise ride along with whatever piece you cut around them.',
  limbs: 'Cut every arm and leg before hands or feet. Each cut gets a joint bone at its pivot and the art keeps the rest, unchanged in place.',
  colour: 'Hands and shoes with a dark outline come off in one click once the limb above them is gone.',
  mesh: 'Fills the art with a grid and weights each vertex to the nearest of its bone and the bones below it (Create mesh… → Fill grid, then Auto weights). Refine with Paint weights.',
  idle: 'A 2 s loop: the root bobs by 1 % of the art’s height and the bones that start above the art’s centre sway ±3°; lower bones stay planted. Edit the keys in Animate mode.',
};

export class GuideDialog {
  private app: App;
  private dlg: HTMLDialogElement;
  private body: HTMLElement;
  private cols = 4;
  private rows = 6;

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'export-body' });
    this.dlg = h('dialog', { class: 'help guide', 'data-testid': 'guide-dialog', 'aria-label': 'Flat-art guide' }, h('h2', {}, 'Flat-art guide'), this.body) as HTMLDialogElement;
    document.body.append(this.dlg);
    // Progress depends on the project only: re-render on edits, undo/redo and loads, never on
    // playback ticks or selection (a rebuilt button between pointerdown and up loses the click).
    app.ed.subscribe((r) => {
      if (this.dlg.open && (r === 'project' || r === 'load')) this.render();
    });
  }

  get isOpen(): boolean {
    return this.dlg.open;
  }

  open(): void {
    this.render();
    // Non-modal: the stage, inspector and timeline stay usable next to the checklist.
    if (!this.dlg.open) this.dlg.show();
  }

  close(): void {
    this.dlg.close();
  }

  private art() {
    return guideArt(this.app.ed.project);
  }

  private action(step: GuideStep, steps: GuideStep[]): HTMLElement | null {
    const app = this.app;
    const ed = app.ed;
    const rigged = steps.find((s) => s.id === 'rig')!.done;
    const btn = (testId: string, label: string, onclick: () => void, disabled = false, title = '') => h('button', { class: 'mini', 'data-testid': testId, disabled, title, onclick }, label);
    switch (step.id) {
      case 'import':
        return btn('guide-import', step.done ? 'Import another…' : 'Choose PNG…', () => app.imageInput.click());
      case 'rig': {
        const original = ed.project.images.find((i) => !i.derived);
        return btn('guide-rig', 'Create root bone + attach', () => this.rig(), step.done || !original, original ? '' : 'Import the art first');
      }
      case 'clean':
        return btn('guide-clean', 'Open clean-up…', () => this.cut({ hint: CLEAN_HINT }), !rigged, rigged ? '' : 'Attach the art first');
      case 'limbs':
        return btn('guide-limb', 'Cut a limb…', () => this.cut({ mode: 'polygon', overlap: 0, extend: 40, hint: LIMB_HINT }), !rigged, rigged ? '' : 'Attach the art first');
      case 'colour':
        return btn('guide-colour', 'Cut by colour…', () => this.cut({ mode: 'wand', overlap: 0, extend: 0, tolerance: 255, hint: COLOUR_HINT }), !rigged, rigged ? '' : 'Attach the art first');
      case 'mesh': {
        const num = (testId: string, label: string, value: number, set: (v: number) => void) => {
          const input = h('input', { type: 'number', min: 1, max: 24, step: 1, value: String(value), 'data-testid': testId, 'aria-label': label, class: 'w-num' });
          input.addEventListener('change', () => (set(Math.min(24, Math.max(1, Math.round(Number(input.value)) || 1))), this.render()));
          return h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, label), input);
        };
        return h('div', { class: 'row-key' },
          num('guide-grid-cols', 'Columns', this.cols, (v) => (this.cols = v)),
          num('guide-grid-rows', 'Rows', this.rows, (v) => (this.rows = v)),
          btn('guide-mesh', step.done ? 'Re-mesh + weigh' : 'Mesh + weigh the body', () => this.mesh(), !rigged, rigged ? '' : 'Attach the art first'));
      }
      case 'idle':
        return btn('guide-idle', step.done ? 'Add another idle' : 'Create idle', () => this.idle(), !ed.project.bones.length, ed.project.bones.length ? '' : 'Create the root bone first');
    }
  }

  private render(): void {
    const steps = guideSteps(this.app.ed.project);
    const required = steps.filter((s) => !s.optional);
    clear(this.body);
    this.body.append(
      h('p', { class: 'dim', 'data-testid': 'guide-progress' }, `${required.filter((s) => s.done).length} of ${required.length} required steps done${steps.some((s) => s.optional && s.done) ? ` · ${steps.filter((s) => s.optional && s.done).length} optional` : ''}. Progress is read from the project: undo a step and it shows as open again.`),
      h('ol', { class: 'guide-steps' }, ...steps.map((s) =>
        h('li', { class: `guide-step${s.done ? ' done' : ''}`, 'data-testid': `guide-step-${s.id}`, 'data-done': String(s.done) },
          h('div', { class: 'guide-title' }, h('span', { class: 'guide-mark', 'aria-hidden': 'true' }, s.done ? '✓' : '○'), s.title, s.optional ? h('span', { class: 'dim' }, ' (optional)') : null),
          h('p', { class: 'dim' }, s.detail),
          h('p', { class: 'hint' }, TIPS[s.id]),
          this.action(s, steps),
        ))),
      h('p', { class: 'hint' }, 'Honest limits: the cut tools do not reproduce a hand-prepared cut pixel for pixel. On the Wiz real-art test 3 of 9 pieces met the tolerance (body and both gloves); the legs’ hidden joint extension differed, the arms lacked the extension past their far end, and separate sleeve-hole patch layers cannot be made.'),
      h('div', { class: 'export-actions' }, h('span', { class: 'tb-spacer' }), h('button', { 'data-testid': 'guide-close', onclick: () => this.close() }, 'Close')),
    );
  }

  private rig(): void {
    const app = this.app;
    const im = app.ed.project.images.find((i) => !i.derived);
    if (!im) return;
    const c = app.viewport.toWorld(app.viewport.canvas.clientWidth / 2, app.viewport.canvas.clientHeight / 2);
    const ids = { bone: newId('bone'), att: newId('att') };
    app.guard(() => app.ed.mutate('Guide: root bone + attach', (p) => startRig(p, im.id, ids, c)));
    const art = this.art();
    if (art) app.ed.select({ kind: 'attachment', id: art.att.id });
    app.viewport.frameAll();
    app.status(`Guide: “${art?.att.name}” is on the root bone. Next: cut the limbs.`);
  }

  private cut(preset: Parameters<App['cutout']['open']>[1]): void {
    const art = this.art();
    if (art) this.app.cutout.open(art.att.id, preset);
  }

  private mesh(): void {
    const art = this.art();
    if (!art) return;
    let r = { vertices: 0, bones: [] as string[] };
    this.app.guard(() => this.app.ed.mutate('Guide: mesh + weights', (p) => void (r = meshArt(p, art.att.id, this.cols, this.rows))));
    if (r.vertices) this.app.status(`Guide: ${art.att.name} meshed (${this.cols}×${this.rows} grid, ${r.vertices} vertices), weighted to ${r.bones.join(', ')}.`);
  }

  private idle(): void {
    const id = newId('anim');
    let r = { name: '', swaying: [] as string[] };
    this.app.guard(() => this.app.ed.mutate('Guide: first idle', (p) => void (r = firstIdle(p, id))));
    if (!r.name) return;
    this.app.ed.setAnimation(id);
    this.app.status(`Guide: “${r.name}” created — root bob${r.swaying.length ? `, sway on ${r.swaying.join(', ')}` : ''}. Press Play.`);
  }
}
