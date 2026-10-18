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
      h('button', { 'data-testid': 'save-project', title: 'Download project with embedded images (Ctrl/⌘+S)', onclick: () => app.saveDownload() }, 'Save'),
      h('button', { 'data-testid': 'save-browser', title: 'Keep a copy in this browser (local storage)', onclick: () => app.saveToBrowser() }, 'Save to browser'),
      h('button', { 'data-testid': 'restore-browser', title: 'Open the copy stored in this browser', disabled: !app.hasBrowserSave(), onclick: () => void app.restoreFromBrowser() }, 'Restore'),
    ),
    h('div', { class: 'tb-group', role: 'group', 'aria-label': 'Export' },
      h('button', { 'data-testid': 'export-runtime', title: 'Export animation data (rigsmith.runtime JSON)', onclick: () => app.exportRuntimeJson() }, 'Export data'),
      h('button', { 'data-testid': 'export-png', title: 'Export the current frame as a transparent PNG', onclick: () => app.exportPngFrame() }, 'Export PNG'),
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
    ),
    h('div', { class: 'tb-spacer' }),
    h('button', { class: 'accent', 'data-testid': 'load-demo', title: 'Open the built-in Tock demo rig', onclick: () => void app.loadDemo() }, 'Demo'),
    h('button', { 'data-testid': 'help', 'aria-label': 'Keyboard and mouse controls', title: 'Controls', onclick: onHelp }, '?'),
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
  ['Click / drag in the timeline', 'Scrub (snaps to frames); drag a ◆ to retime it'],
  ['Delete / Backspace', 'Delete the selected key, bone or image attachment'],
  ['Ctrl/⌘+Z · Ctrl/⌘+Shift+Z or Ctrl+Y', 'Undo · Redo'],
  ['Ctrl/⌘+S · Ctrl/⌘+O', 'Save (download) · Open project'],
  ['Shift while rotating / scaling', 'Snap to 15° / scale X only'],
  ['H · Esc', 'Toggle bones · deselect or cancel drag'],
];
