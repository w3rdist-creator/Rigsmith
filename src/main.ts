import { App } from './ui/app.ts';
import { Autosave } from './ui/autosave.ts';
import { h } from './ui/dom.ts';
import { renderImages, renderInspector, renderSkeleton } from './ui/panels.ts';
import { renderConstraintList } from './ui/rigPanels.ts';
import { renderSkinsPanel } from './ui/skinPanels.ts';
import { Timeline } from './ui/timeline.ts';
import { HELP_ROWS, renderToolbar, toolHint } from './ui/toolbar.ts';
import './styles.css';

const app = new App();
const $ = (id: string) => document.getElementById(id)!;

const helpDialog = $('help-dialog') as HTMLDialogElement;
helpDialog.querySelector('tbody')!.append(...HELP_ROWS.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))));
const openHelp = () => helpDialog.showModal();

app.mount($('stage-canvas') as HTMLCanvasElement, $('status-msg'), $('toasts'));
new Timeline(app, $('timeline'));
app.autosave = new Autosave(app, $('autosave-status'));
app.autosave.checkForRecovery($('banners'));

const toolbar = $('toolbar');
const skeleton = $('skeleton-panel');
const images = $('images-panel');
const constraints = $('constraints-panel');
const skinsPanel = $('skins-panel');
const inspector = $('inspector-panel');
const modeBadge = $('mode-badge');
const toolHintEl = $('tool-hint');
const emptyStage = $('empty-stage');

function refresh(full: boolean): void {
  const ed = app.ed;
  renderToolbar(app, toolbar, openHelp);
  if (full) {
    renderSkeleton(app, skeleton);
    constraints.replaceChildren();
    renderConstraintList(app, constraints);
    renderSkinsPanel(app, skinsPanel);
    renderImages(app, images);
  }
  if (!ed.playing) renderInspector(app, inspector);
  document.body.classList.toggle('animate-mode', ed.mode === 'animate');
  modeBadge.textContent = ed.mode === 'animate' ? `ANIMATE · ${ed.anim()?.name ?? ''}` : 'SETUP';
  toolHintEl.textContent = toolHint(ed.tool);
  const p = ed.project;
  emptyStage.hidden = p.bones.length > 0 || p.attachments.length > 0;
  document.title = `${ed.dirty ? '• ' : ''}${p.name} — Rigsmith`;
}

let wasPlaying = false;
app.ed.subscribe((reason) => {
  if (reason === 'time') {
    // Keep per-frame work tiny during playback; refresh the inspector when it stops.
    if (wasPlaying !== app.ed.playing) refresh(false);
    else if (!app.ed.playing) renderInspector(app, inspector);
    wasPlaying = app.ed.playing;
    return;
  }
  refresh(reason !== 'view');
});

$('empty-demo').addEventListener('click', () => void app.loadDemo());
$('empty-import').addEventListener('click', () => app.imageInput.click());
$('empty-open').addEventListener('click', () => app.fileInput.click());
$('empty-bone').addEventListener('click', () => app.ed.setTool('create'));

refresh(true);
app.status('Welcome to Rigsmith. Open the demo, import images, or draw bones with the Bone tool (B). Press ? for controls.');
// `?demo` opens straight into the playing demo (handy as a shareable start link).
if (new URLSearchParams(location.search).has('demo')) void app.loadDemo();

// Read-only probe for automated browser tests. It exposes copies of state and
// screen coordinates; it never mutates the editor (tests drive the visible UI).
Object.defineProperty(window, '__rigsmith', {
  value: Object.freeze({
    state: () => ({
      mode: app.ed.mode,
      tool: app.ed.tool,
      time: app.ed.time,
      playing: app.ed.playing,
      animName: app.ed.anim()?.name ?? null,
      selection: app.ed.selection ? { ...app.ed.selection } : null,
      keySel: app.ed.keySel ? { ...app.ed.keySel } : null,
      keySels: app.ed.keySels.map((k) => ({ ...k })),
      onion: { ...app.ed.onion },
      skinId: app.ed.skinId,
      pivotMode: app.ed.pivotMode,
      pathNode: app.ed.pathNode,
      meshTool: app.ed.meshTool,
      meshVertex: app.ed.meshVertex,
      brush: { ...app.ed.brush },
      autosavePending: app.autosave?.pending ?? false,
      undo: app.ed.history.size.undo,
      redo: app.ed.history.size.redo,
      dirty: app.ed.dirty,
    }),
    project: () => app.snapshot(),
    bone: (name: string) => app.boneScreen(name),
    attachment: (name: string) => app.attachmentScreen(name),
    frame: () => app.frameState(),
    path: (name: string, i: number) => app.pathScreen(name, i),
    mesh: (name: string) => app.meshScreen(name),
    worlds: () => Object.fromEntries([...app.ed.world()].map(([id, m]) => [id, [m.a, m.b, m.c, m.d, m.tx, m.ty]])),
    worldAt: (x: number, y: number) => app.worldAt(x, y),
  }),
});
