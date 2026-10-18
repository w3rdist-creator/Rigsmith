import type { Tool } from '../editor/store.ts';
import type { App } from './app.ts';
import { clear, h } from './dom.ts';

const TOOLS: { tool: Tool; label: string; key: string; hint: string }[] = [
  { tool: 'move', label: 'Move', key: 'V', hint: 'Drag bones or images to move them. Drag empty canvas to pan.' },
  { tool: 'rotate', label: 'Rotate', key: 'R', hint: 'Drag around a joint to rotate. Shift snaps to 15°.' },
  { tool: 'scale', label: 'Scale', key: 'S', hint: 'Drag away from / toward the joint to scale. Shift scales X only.' },
  { tool: 'create', label: 'Bone', key: 'B', hint: 'Press-drag to draw a bone (child of the selected bone).' },
];

export function toolHint(tool: Tool): string {
  return TOOLS.find((t) => t.tool === tool)?.hint ?? '';
}

export function renderToolbar(app: App, root: HTMLElement, onHelp: () => void): void {
  const { ed } = app;
  clear(root);
  const undoLabel = ed.history.undoLabel();
  const redoLabel = ed.history.redoLabel();
  root.append(
    h('div', { class: 'brand', title: 'Rigsmith — independent 2D skeletal animation editor' }, h('span', { class: 'brand-mark' }, '⟁'), 'Rigsmith'),
    h('div', { class: 'tb-group', role: 'group', 'aria-label': 'File' },
      h('button', { 'data-testid': 'new-project', onclick: () => app.newProject() }, 'New'),
      h('button', { 'data-testid': 'open-project', title: 'Open a .rig.json project (Ctrl/⌘+O)', onclick: () => app.fileInput.click() }, 'Open…'),
      h('button', { 'data-testid': 'save-project', title: 'Save the project with embedded images (Ctrl/⌘+S): file picker where supported, otherwise a download', onclick: () => void app.saveDownload() }, 'Save'),
      h('button', { 'data-testid': 'save-browser', title: 'Keep a copy in this browser (IndexedDB)', onclick: () => void app.saveToBrowser() }, 'Save to browser'),
      h('button', { 'data-testid': 'import-anims', title: 'Import animations from another Rigsmith project, mapping its bones to this rig by name (editable)', onclick: () => app.importDialog.pick() }, 'Import anims…'),
      h('button', { 'data-testid': 'restore-browser', title: 'Open the copy stored in this browser', disabled: !app.hasBrowserSave(), onclick: () => void app.restoreFromBrowser() }, 'Restore'),
    ),
    h('div', { class: 'tb-group', role: 'group', 'aria-label': 'Export' },
      h('button', { 'data-testid': 'export-runtime', title: 'Export animation data (rigsmith.runtime JSON)', onclick: () => app.exportRuntimeJson() }, 'Export data'),
      h('button', { 'data-testid': 'export-png', title: 'Export the current frame as a transparent PNG', onclick: () => app.exportPngFrame() }, 'Export PNG'),
      h('button', { 'data-testid': 'export-sequence', title: 'Export an animation as a transparent PNG sequence (ZIP), APNG or GIF', onclick: () => app.exportDialog.open() }, 'Export sequence…'),
      h('button', { 'data-testid': 'export-atlas', title: 'Pack every image into texture pages (PNG + atlas JSON)', onclick: () => void app.atlasDialog.open() }, 'Export atlas…'),
      h('button', { 'data-testid': 'export-lottie', title: 'Export an animation as Lottie JSON (supported subset, with diagnostics)', onclick: () => app.lottieDialog.open() }, 'Export Lottie…'),
    ),
    h('div', { class: 'tb-group', role: 'group', 'aria-label': 'History' },
      h('button', { 'data-testid': 'undo', disabled: !ed.history.canUndo(), title: undoLabel ? `Undo ${undoLabel} (Ctrl/⌘+Z)` : 'Nothing to undo', onclick: () => ed.undo() && app.status(ed.lastUndoRedo) }, '↶ Undo'),
      h('button', { 'data-testid': 'redo', disabled: !ed.history.canRedo(), title: redoLabel ? `Redo ${redoLabel} (Ctrl/⌘+Shift+Z)` : 'Nothing to redo', onclick: () => ed.redo() && app.status(ed.lastUndoRedo) }, '↷ Redo'),
    ),
    h('div', { class: 'tb-group seg', role: 'radiogroup', 'aria-label': 'Mode' },
      h('button', { role: 'radio', 'aria-checked': String(ed.mode === 'setup'), class: ed.mode === 'setup' ? 'on' : '', 'data-testid': 'mode-setup', title: 'Setup mode: edit the rest pose (Tab)', onclick: () => ed.setMode('setup') }, 'Setup'),
      h('button', { role: 'radio', 'aria-checked': String(ed.mode === 'animate'), class: ed.mode === 'animate' ? 'on animate' : '', 'data-testid': 'mode-animate', disabled: !ed.anim(), title: ed.anim() ? 'Animate mode: posing writes keys (Tab)' : 'Create an animation first', onclick: () => ed.setMode('animate') }, 'Animate'),
    ),
    h('div', { class: 'tb-group seg', role: 'radiogroup', 'aria-label': 'Tool' },
      ...TOOLS.map((t) =>
        h('button', { role: 'radio', 'aria-checked': String(ed.tool === t.tool), class: ed.tool === t.tool ? 'on' : '', 'data-testid': `tool-${t.tool}`, 'aria-label': `${t.label} tool (${t.key})`, title: `${t.label} (${t.key}) — ${t.hint}`, onclick: () => ed.setTool(t.tool) }, t.label, h('kbd', {}, t.key)),
      ),
    ),
    h('div', { class: 'tb-group', role: 'group', 'aria-label': 'View' },
      h('button', { 'data-testid': 'frame-all', title: 'Frame everything (F or double-click canvas)', onclick: () => app.viewport.frameAll() }, 'Fit'),
      h('label', { class: 'inline', title: 'Show bones (H)' }, h('input', { type: 'checkbox', checked: ed.showBones, 'data-testid': 'show-bones', onchange: (e: Event) => { ed.showBones = (e.target as HTMLInputElement).checked; ed.emit('view'); } }), 'Bones'),
      onionControls(app),
    ),
    h('div', { class: 'tb-spacer' }),
    h('button', { 'data-testid': 'guide-open', title: 'Step-by-step checklist from one flat character PNG to a first idle (import, cut limbs, bones, mesh, idle)', onclick: () => app.guide.open() }, 'Flat-art guide…'),
    h('button', { class: 'accent', 'data-testid': 'load-demo', title: 'Open the built-in Tock demo rig', onclick: () => void app.loadDemo() }, 'Demo'),
    h('button', { 'data-testid': 'help', 'aria-label': 'Keyboard and mouse controls', title: 'Controls', onclick: onHelp }, '?'),
  );
}

/** Onion skin controls (view state: not undoable, not saved in the project). */
function onionControls(app: App): HTMLElement {
  const { ed } = app;
  const o = ed.onion;
  const num = (testId: string, label: string, value: number, min: number, max: number, set: (v: number) => void) => {
    const input = h('input', { type: 'number', min, max, step: 1, value: String(value), class: 'w-tiny', 'data-testid': testId, 'aria-label': label, title: label, disabled: !o.enabled });
    input.addEventListener('change', () => {
      const v = Math.round(Number(input.value));
      if (!(v >= min && v <= max)) return void (input.value = String(value));
      set(v);
      ed.emit('view');
    });
    return input;
  };
  return h('span', { class: 'onion', role: 'group', 'aria-label': 'Onion skin' },
    h('label', { class: 'inline', title: 'Onion skin: show ghosts of earlier (red) and later (green) frames' },
      h('input', { type: 'checkbox', checked: o.enabled, 'data-testid': 'onion-toggle', onchange: (e: Event) => { o.enabled = (e.target as HTMLInputElement).checked; ed.emit('view'); } }), 'Onion'),
    num('onion-before', 'Ghosts before', o.before, 0, 8, (v) => void (o.before = v)),
    num('onion-after', 'Ghosts after', o.after, 0, 8, (v) => void (o.after = v)),
    num('onion-step', 'Frames between ghosts', o.step, 1, 30, (v) => void (o.step = v)),
  );
}

export const HELP_ROWS: [string, string][] = [
  ['Left-drag bone / image', 'Move, rotate or scale it (current tool)'],
  ['V / R / S / B', 'Move, Rotate, Scale, Bone tool'],
  ['Bone tool drag', 'Draw a new bone; it becomes a child of the selected bone'],
  ['Wheel', 'Zoom at cursor'],
  ['Middle/right-drag, Alt+drag, or drag empty canvas', 'Pan'],
  ['F or double-click', 'Fit all in view'],
  ['Tab', 'Toggle Setup / Animate mode'],
  ['Space', 'Play / pause'],
  [', / .  ·  Home / End', 'Previous / next frame · first / last frame'],
  ['K', 'Key all channels of the selected bone'],
  ['Click / drag in the timeline', 'Scrub (snaps to frames); drag a ◆ to retime it (all selected keys move together)'],
  ['Shift/Ctrl-click ◆ · Shift-drag lanes · Ctrl/⌘+A', 'Add/remove a key from the selection · box-select keys · select all keys'],
  ['[ / ]  ·  Ctrl/⌘+C / V', 'Nudge selected keys one frame · copy / paste keys at the playhead (the copy is kept in this browser: paste after a reload or into another project; lanes resolve by bone/attachment name)'],
  ['File · Import anims…', 'Copy animations from another project; map each bone (by name, editable, or skip) and read the unmatched report before importing'],
  ['Timeline · ▤ Sequences…', 'Saved clip sequences: ordered clips × repeats with stored mixes; export ZIP / APNG / GIF (CLI: rigsmith sequence)'],
  ['Curve panel', 'Drag the round handles (Shift snaps); presets include overshoot and anticipate'],
  ['Delete / Backspace', 'Delete the selected key, bone or image attachment'],
  ['Ctrl/⌘+Z · Ctrl/⌘+Shift+Z or Ctrl+Y', 'Undo · Redo'],
  ['Ctrl/⌘+S · Ctrl/⌘+O', 'Save (download) · Open project'],
  ['Shift while rotating / scaling', 'Snap to 15° / scale X only'],
  ['H · Esc', 'Toggle bones · cancel the current drag (canvas, keys, curve handle, path node) or deselect'],
  ['Inspector (image, Animate mode)', 'Key visibility, opacity, image swaps and draw order at the current frame'],
  ['Inspector (bone) · + 2-bone IK', 'Adds a pink target at the bone tip; drag it to bend the limb (keys it in Animate mode)'],
  ['Constraints · + Path', 'Bezier path: drag squares (nodes) and round handles; tick bones and “Create path constraint”'],
  ['Inspector (image, Setup) · ✂ Cut out piece…', 'Polygon/rectangle mask, pivot, overlap, remainder and flat patch — the source image is kept'],
  ['Inspector (bone, Setup) · Pivot mode', 'Move tool moves only the bone origin; its images and children stay put'],
  ['Inspector (image) · ▦ Create mesh…', 'Outline + interior points (or Fill grid) → textured triangles that bend with their bones'],
  ['Mesh · Edit vertices / Paint weights', 'Drag vertices (Setup: on the image · Animate: keys a deform) · paint the brush bone’s weight; Esc leaves the tool'],
];
