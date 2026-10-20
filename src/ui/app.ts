// Application wiring: actions shared by the toolbar, panels, timeline and shortcuts.
import { smearAnimation } from '../model/smear.ts';
import { addPaintedView, type PaintedViewFit, type PaintedViewImages } from '../model/views.ts';
import { Editor } from '../editor/store.ts';
import type { Tool } from '../editor/store.ts';
import { findKeyIndex, insertSorted, keysBeyondEnd, removeKey, setInterp, setInterpY, snapToFrame } from '../model/animation.ts';
import { CURVE_PRESETS } from '../model/curve.ts';
import type { KeyRef } from '../model/keys.ts';
import { allLanes, boneLane, closeLoopSeam, copyKeys, deleteKeys, eventLane, findKey, laneKeys, parseLane, pasteKeys, sameRef, shiftKeys } from '../model/keys.ts';
import { drivenByConstraints } from '../model/animImport.ts';
import { parsePortable, resolvePortable, toPortable } from '../model/clipboard.ts';
import { buildDemoProject } from '../model/demo.ts';
import { exportRuntime, runtimeProblems } from '../model/exportRuntime.ts';
import { parseProject, serializeProject } from '../model/format.ts';
import { apply, invert } from '../model/math.ts';
import { keyChannels, makeBone, uniqueName } from '../model/ops.ts';
import { CycleError, attachmentWorld, boneTip, deleteBone, reparentBone } from '../model/skeleton.ts';
import type { Animation, Channel, Curve, EventKey, Key, Project } from '../model/types.ts';
import { CHANNELS, EVENT_NAME, cloneProject, emptyProject, emptyTrack, newId } from '../model/types.ts';
import { frameBounds } from '../model/evaluate.ts';
import { drawFrame, exportContext } from '../render/draw.ts';
import type { Autosave } from './autosave.ts';
import { buildDemoImages } from './demoArt.ts';
import { ExportDialog } from './exportDialog.ts';
import { MixDialog } from './mixDialog.ts';
import { SequenceDialog } from './sequenceDialog.ts';
import { GuideDialog } from './guideDialog.ts';
import { ImportAnimDialog } from './importAnimDialog.ts';
import { AtlasDialog } from './atlasDialog.ts';
import { LottieDialog } from './lottieDialog.ts';
import { CutoutDialog } from './cutoutDialog.ts';
import { MeshDialog } from './meshDialog.ts';
import { deleteConstraint, deletePath } from '../model/rigOps.ts';
import { h } from './dom.ts';
import { BROWSER_SAVE, CLIPBOARD, LEGACY_KEYS, isQuotaError, migrateLegacy, readRecord, readStored, writeRecord, writeStored } from './storage.ts';
import { ImageCache, importImageFile } from './images.ts';
import { Viewport, isTyping } from './viewport.ts';
import { applyClip, exportClip, formatClipSpec, parseClipText } from '../model/clipSpec.ts';

/** Legacy localStorage key of the browser save (migrated to IndexedDB, src/ui/storage.ts). */
export const STORAGE_KEY = LEGACY_KEYS[BROWSER_SAVE];

export class App {
  readonly ed = new Editor();
  readonly images = new ImageCache();
  viewport!: Viewport;
  autosave: Autosave | null = null;
  /** Legacy localStorage migration + browser-save lookup (IndexedDB); awaited before storage reads. */
  storageReady: Promise<void> = Promise.resolve();
  private browserSaved = false;
  exportDialog!: ExportDialog;
  mixDialog!: MixDialog;
  sequenceDialog!: SequenceDialog;
  importDialog!: ImportAnimDialog;
  atlasDialog!: AtlasDialog;
  lottieDialog!: LottieDialog;
  cutout!: CutoutDialog;
  meshDialog!: MeshDialog;
  guide!: GuideDialog;
  private statusEl!: HTMLElement;
  private toastEl!: HTMLElement;
  private statusTimer = 0;
  readonly fileInput = h('input', { type: 'file', accept: '.json,.rig.json,application/json', hidden: true, 'data-testid': 'open-input' });
  readonly imageInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true, 'data-testid': 'image-input' });
  readonly clipSpecInput = h('input', { type: 'file', accept: '.yaml,.yml,.json', hidden: true, 'data-testid': 'clip-spec-input' });

  mount(canvas: HTMLCanvasElement, statusEl: HTMLElement, toastEl: HTMLElement): void {
    this.statusEl = statusEl;
    this.toastEl = toastEl;
    this.viewport = new Viewport(canvas, this.ed, this.images);
    this.viewport.onStatus = (m) => this.status(m);
    this.exportDialog = new ExportDialog(this);
    this.mixDialog = new MixDialog(this);
    this.sequenceDialog = new SequenceDialog(this);
    this.importDialog = new ImportAnimDialog(this);
    this.atlasDialog = new AtlasDialog(this);
    this.lottieDialog = new LottieDialog(this);
    this.cutout = new CutoutDialog(this);
    this.meshDialog = new MeshDialog(this);
    this.guide = new GuideDialog(this);
    this.storageReady = migrateLegacy()
      .then(async (moved) => {
        this.browserSaved = !!(await readStored(BROWSER_SAVE));
        await this.restoreClipboard();
        if (moved.length) this.status('Moved the browser copies of your project from local storage to IndexedDB.');
        this.ed.emit('view');
      })
      .catch((e) => this.error('Browser storage unavailable', [(e as Error).message]));
    document.body.append(this.fileInput, this.imageInput, this.clipSpecInput);
    this.clipSpecInput.addEventListener('change', () => {
      const f = this.clipSpecInput.files?.[0];
      this.clipSpecInput.value = '';
      if (f) void f.text().then((text) => this.applyClipSpec(text, f.name));
    });
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (f) void this.openFile(f);
    });
    this.imageInput.addEventListener('change', () => {
      const files = [...(this.imageInput.files ?? [])];
      this.imageInput.value = '';
      void this.importImages(files);
    });
    const stage = canvas.parentElement!;
    stage.addEventListener('dragover', (e) => {
      e.preventDefault();
      stage.classList.add('drop-target');
    });
    stage.addEventListener('dragleave', () => stage.classList.remove('drop-target'));
    stage.addEventListener('drop', (e) => {
      e.preventDefault();
      stage.classList.remove('drop-target');
      const files = [...(e.dataTransfer?.files ?? [])];
      const json = files.find((f) => f.name.endsWith('.json'));
      if (json) void this.openFile(json);
      else void this.importImages(files);
    });
    // Safety net: an exception escaping a control's handler (a failed mutate() has
    // already rolled the project back) is reported instead of failing silently.
    window.addEventListener('error', (e) => {
      if (/ResizeObserver loop/.test(e.message ?? '')) return;
      this.error('Action failed', [e.error instanceof Error ? e.error.message : e.message || 'Unknown error']);
    });
    window.addEventListener('unhandledrejection', (e) => {
      this.error('Action failed', [e.reason instanceof Error ? e.reason.message : String(e.reason)]);
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('beforeunload', (e) => {
      if (this.ed.dirty) e.preventDefault();
    });
    const loop = (now: number) => {
      this.ed.tick(now);
      this.viewport.renderIfNeeded();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---- Feedback ------------------------------------------------------------------

  status(msg: string): void {
    this.statusEl.textContent = msg;
    window.clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => {
      this.statusEl.textContent = '';
    }, 6000);
  }

  error(title: string, details: string[] = []): void {
    const box = h(
      'div',
      { class: 'toast error', role: 'alert', 'data-testid': 'error-toast' },
      h('strong', {}, title),
      details.length ? h('ul', {}, ...details.slice(0, 8).map((d) => h('li', {}, d))) : null,
      details.length > 8 ? h('div', {}, `…and ${details.length - 8} more`) : null,
      h('button', { class: 'toast-close', 'aria-label': 'Dismiss', onclick: () => box.remove() }, '×'),
    );
    this.toastEl.append(box);
    window.setTimeout(() => box.remove(), 12000);
  }

  /** Runs an edit; a thrown error is reported instead of escaping (mutate() has rolled back). */
  guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (e instanceof CycleError) this.error('Invalid parent', [e.message]);
      else this.error('Action failed', [(e as Error).message]);
    }
  }

  // ---- Project lifecycle -----------------------------------------------------------

  confirmDiscard(): boolean {
    return !this.ed.dirty || window.confirm('Discard unsaved changes to the current rig?');
  }

  newProject(): void {
    if (!this.confirmDiscard()) return;
    this.ed.load(emptyProject());
    this.viewport.frameAll();
    this.status('New empty rig. Import images or create bones with the Bone tool (B).');
  }

  async loadDemo(): Promise<void> {
    if (!this.confirmDiscard()) return;
    const images = buildDemoImages();
    await this.images.decodeAll(images);
    this.ed.load(buildDemoProject(images), { mode: 'animate' });
    this.viewport.frameAll();
    this.ed.play();
    this.status('Demo loaded and playing. Space toggles playback; Tab switches to Setup.');
  }

  /** Validates, decodes every image, and only then swaps the project in. */
  async loadProjectText(text: string, source: string): Promise<boolean> {
    const r = parseProject(text);
    if (!r.ok) {
      this.error(`Could not open ${source}`, r.errors);
      return false;
    }
    try {
      await this.images.decodeAll(r.project.images);
    } catch (e) {
      this.error(`Could not open ${source}`, [(e as Error).message]);
      return false;
    }
    this.ed.load(r.project);
    this.viewport.frameAll();
    this.status(`Opened ${source}${r.warnings.length ? ` — ${r.warnings.join(' ')}` : ''}`);
    return true;
  }

  async openFile(file: File): Promise<void> {
    if (!this.confirmDiscard()) return;
    if (file.size > 200 * 1024 * 1024) return this.error('File too large', [`${file.name} is over 200 MB.`]);
    await this.loadProjectText(await file.text(), `"${file.name}"`);
  }

  fileBaseName(): string {
    return (this.ed.project.name || 'rig').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'rig';
  }

  /**
   * Save with embedded images. Where the File System Access API exists the file picker is
   * used, and only a write that completed marks the project saved and clears the autosave
   * copy (cancel changes nothing). Otherwise the file is downloaded — the browser cannot
   * report whether that file was written, so the project stays marked unsaved and the
   * autosave copy is kept, annotated with the download.
   */
  async saveDownload(): Promise<void> {
    const text = serializeProject(this.ed.project);
    const name = `${this.fileBaseName()}.rig.json`;
    const blob = new Blob([text], { type: 'application/json' });
    const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    if (typeof picker === 'function') {
      let handle: FileSystemFileHandle;
      try {
        handle = await picker.call(window, { suggestedName: name, types: [{ description: 'Rigsmith project', accept: { 'application/json': ['.json'] } }] });
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return this.status('Save cancelled — nothing was written; the project is still unsaved.');
        return this.error('Save failed', [(e as Error).message]);
      }
      try {
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
      } catch (e) {
        return this.error('Save failed', [`“${handle.name}” was not written: ${(e as Error).message}`, 'The project is still unsaved and its autosave copy is kept.']);
      }
      if (serializeProject(this.ed.project) === text) {
        this.ed.dirty = false;
        await this.autosave?.clearAfterExplicitSave();
      }
      this.ed.emit('view');
      return this.status(`Saved “${handle.name}” (images embedded).`);
    }
    download(blob, name);
    await this.autosave?.noteDownload(name);
    this.ed.emit('view');
    this.status(`Downloaded “${name}” (images embedded). The browser cannot confirm the file was written, so the project stays marked unsaved and its recovery copy is kept.`);
  }

  async saveToBrowser(): Promise<void> {
    const text = serializeProject(this.ed.project);
    try {
      await this.storageReady;
      await writeStored(BROWSER_SAVE, { savedAt: new Date().toISOString(), name: this.ed.project.name, project: text });
    } catch (e) {
      return this.error('Browser save failed', [isQuotaError(e) ? 'The project is too large for browser storage. Use Save (download) instead.' : (e as Error).message]);
    }
    this.browserSaved = true;
    if (serializeProject(this.ed.project) === text) {
      this.ed.dirty = false;
      await this.autosave?.clearAfterExplicitSave();
    }
    this.ed.emit('view');
    this.status('Saved to this browser (IndexedDB).');
  }

  hasBrowserSave(): boolean {
    return this.browserSaved;
  }

  async restoreFromBrowser(): Promise<void> {
    await this.storageReady;
    const stored = await readStored(BROWSER_SAVE).catch(() => null);
    if (!stored) return this.error('Nothing saved in this browser yet.');
    if (!this.confirmDiscard()) return;
    await this.loadProjectText(stored.project, 'browser save');
  }

  exportRuntimeJson(): void {
    if (!this.ed.project.bones.length) return this.error('Nothing to export', ['Create at least one bone first.']);
    const problems = runtimeProblems(this.ed.project);
    if (problems.length) return this.error('Runtime export needs unique names', problems);
    const data = exportRuntime(this.ed.project);
    download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `${this.fileBaseName()}.runtime.json`);
    this.status('Exported runtime JSON v2 (keys, constraints, meshes, skins, mixes + baked per-frame world transforms).');
  }

  /** Renders the current pose without editor chrome to a transparent PNG cropped to the art. */
  exportPngFrame(): void {
    const frame = this.ed.frame();
    const b = frameBounds(frame);
    if (!b) return this.error('Nothing to render', ['Attach at least one image first.']);
    const pad = 8;
    const minX = b.minX, minY = b.minY;
    const w = Math.ceil(b.maxX - minX + pad * 2), hh = Math.ceil(b.maxY - minY + pad * 2);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = hh;
    const g = exportContext(c)!;
    drawFrame(g, frame, (im) => this.images.get(im), { a: 1, b: 0, c: 0, d: 1, tx: -minX + pad, ty: -minY + pad });
    c.toBlob((blob) => {
      if (!blob) return this.error('PNG export failed');
      const fr = this.ed.anim() && this.ed.mode === 'animate' ? `-f${Math.round(this.ed.time * this.ed.anim()!.fps)}` : '-setup';
      download(blob, `${this.fileBaseName()}${fr}.png`);
      this.status(`Exported ${w}×${hh} PNG frame.`);
    }, 'image/png');
  }

  // ---- Images ------------------------------------------------------------------------

  async importImages(files: File[]): Promise<void> {
    if (!files.length) return;
    const errors: string[] = [];
    for (const f of files) {
      try {
        const asset = await importImageFile(f, this.images);
        this.ed.mutate(`Import ${asset.name}`, (p) => {
          p.images.push(asset);
        });
        this.status(`Imported ${asset.name} (${asset.width}×${asset.height}). Select a bone and click “Attach”.`);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    if (errors.length) this.error('Some files were not imported', errors);
  }

  attachImage(imageId: string): void {
    const ed = this.ed;
    const im = ed.project.images.find((i) => i.id === imageId);
    if (!im) return;
    const boneId = ed.selectedBoneId();
    const bone = ed.project.bones.find((b) => b.id === boneId);
    const id = newId('att');
    ed.mutate(`Attach ${im.name}`, (p) => {
      let x = 0, y = 0;
      if (bone) {
        x = bone.length / 2;
      } else {
        // Unbound: drop it at the centre of the current view.
        const c = this.viewport.toWorld(this.viewport.canvas.clientWidth / 2, this.viewport.canvas.clientHeight / 2);
        x = Math.round(c.x);
        y = Math.round(c.y);
      }
      p.attachments.push({
        id,
        name: uniqueName(p.attachments.map((a) => a.name), im.name.replace(/\.[a-z0-9]+$/i, '')),
        boneId: bone?.id ?? null,
        imageId,
        x,
        y,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
      });
    });
    ed.select({ kind: 'attachment', id });
    this.status(bone ? `Attached to “${bone.name}”. Drag it (Move tool) or edit the offset in the inspector.` : 'Placed in world space (no bone selected).');
  }

  removeImage(imageId: string): void {
    const im = this.ed.project.images.find((i) => i.id === imageId);
    if (!im) return;
    const p0 = this.ed.project;
    const users = p0.attachments.filter((a) => a.imageId === imageId).length;
    const skins = (p0.skins ?? []).filter((s) => s.entries.some((e) => e.imageId === imageId || e.from === imageId)).map((s) => s.name);
    const keyed = p0.animations.filter((an) => Object.values(an.slots ?? {}).some((st) => st.image?.some((k) => k.imageId === imageId))).map((an) => an.name);
    const uses = [
      users ? `${users} attachment(s) (removed with it)` : '',
      skins.length ? `skin(s) ${skins.join(', ')} (those entries are removed)` : '',
      keyed.length ? `image keys in ${keyed.join(', ')} (those keys are removed)` : '',
    ].filter(Boolean);
    if (uses.length && !window.confirm(`“${im.name}” is used by ${uses.join('; ')}. Remove it?`)) return;
    this.ed.mutate(`Remove ${im.name}`, (p) => {
      p.images = p.images.filter((i) => i.id !== imageId);
      p.attachments = p.attachments.filter((a) => a.imageId !== imageId);
      for (const s of p.skins ?? []) s.entries = s.entries.filter((e) => e.imageId !== imageId && e.from !== imageId);
      for (const an of p.animations) for (const st of Object.values(an.slots ?? {})) if (st.image) st.image = st.image.filter((k) => k.imageId !== imageId);
    });
  }

  // ---- Bones / attachments -----------------------------------------------------------

  addBone(): void {
    const ed = this.ed;
    const parent = ed.project.bones.find((b) => b.id === ed.selectedBoneId());
    const id = newId('bone');
    ed.mutate('Add bone', (p) => {
      const name = uniqueName(p.bones.map((b) => b.name), 'bone');
      if (parent) p.bones.push(makeBone(id, name, parent.id, parent.length, 0, 0, 40));
      else {
        const c = this.viewport.toWorld(this.viewport.canvas.clientWidth / 2, this.viewport.canvas.clientHeight / 2);
        p.bones.push(makeBone(id, name, null, Math.round(c.x), Math.round(c.y), -90, 60));
      }
    });
    ed.select({ kind: 'bone', id });
  }

  setParent(boneId: string, parentId: string | null): void {
    this.guard(() => this.ed.mutate('Change parent', (p) => reparentBone(p, boneId, parentId, true)));
  }

  deleteSelection(): void {
    const ed = this.ed;
    if (ed.keySels.length && ed.mode === 'animate') return this.deleteSelectedKey();
    const sel = ed.selection;
    if (!sel) return;
    if (sel.kind === 'bone') {
      const b = ed.project.bones.find((x) => x.id === sel.id);
      ed.mutate(`Delete bone ${b?.name ?? ''}`, (p) => deleteBone(p, sel.id));
      if (ed.lastRepairs.length) this.status(ed.lastRepairs.join(' '));
    } else if (sel.kind === 'constraint') {
      ed.mutate('Delete constraint', (p) => deleteConstraint(p, sel.id));
    } else if (sel.kind === 'path') {
      ed.mutate('Delete path', (p) => deletePath(p, sel.id));
    } else {
      ed.mutate('Delete attachment', (p) => {
        p.attachments = p.attachments.filter((a) => a.id !== sel.id);
      });
    }
    ed.select(null);
  }

  moveAttachmentOrder(id: string, dir: -1 | 1): void {
    const list = this.ed.project.attachments;
    const i = list.findIndex((a) => a.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    this.ed.mutate(dir > 0 ? 'Bring forward' : 'Send backward', (p) => {
      const [a] = p.attachments.splice(i, 1);
      p.attachments.splice(j, 0, a);
    });
  }

  /** Alpha registration decodes images asynchronously; commit only against the unchanged editor. */
  async addView(setId: string, name: string, images: PaintedViewImages, fit: PaintedViewFit): Promise<void> {
    const original = JSON.stringify(this.ed.project);
    const work = cloneProject(this.ed.project);
    this.status(`Registering view “${name}”…`);
    try {
      await addPaintedView(work, setId, name, images, fit);
      if (JSON.stringify(this.ed.project) !== original || this.ed.mode !== 'setup') return this.status('View not added: the editor changed during registration. Try Add view again.');
      this.ed.mutate(`Add view ${name}`, (p) => {
        p.viewSets = work.viewSets;
        p.attachments = work.attachments;
        p.animations = work.animations;
      });
      this.status(`Added view “${name}”: fitted by ${fit.fit ?? 'height'}, scale ${fit.scale ?? 1}.`);
    } catch (e) {
      this.error('View not added', [(e as Error).message]);
    }
  }

  // ---- Animation ---------------------------------------------------------------------

  newAnimation(): void {
    const id = newId('anim');
    this.ed.mutate('New animation', (p) => {
      p.animations.push({ id, name: uniqueName(p.animations.map((a) => a.name), 'animation'), duration: 1, fps: 30, loop: true, tracks: {} });
    });
    this.ed.setAnimation(id);
    this.ed.setMode('animate');
    this.status('New animation. Pose bones in Animate mode to set keys.');
  }

  /** Downloads the current animation as a clip spec (`<name>.clip.yaml`, docs/cli.md → Clip specs). */
  /** Smears (R13): smear images for this animation's fast frames, keyed as image swaps — one undo step. */
  async smearFastFrames(): Promise<void> {
    const anim = this.ed.anim();
    const sel = this.ed.selection;
    if (!anim) return;
    const att = sel?.kind === 'attachment' ? this.ed.project.attachments.find((a) => a.id === sel.id) : undefined;
    if (!att) return this.status('Select the attachment to smear (a prop or limb that whips, e.g. a whisk), then Smear fast frames.');
    if (att.mesh || att.emitter) return this.status(`“${att.name}” is a ${att.mesh ? 'mesh' : 'emitter'}; only flat image attachments can be smeared.`);
    this.status(`Smearing fast frames of “${att.name}” in “${anim.name}”…`);
    try {
      const work = cloneProject(this.ed.project);
      const r = await smearAnimation(work, anim.id, { attachments: [att.id] });
      const n = Object.values(r.frames).reduce((s, f) => s + f.length, 0);
      if (!n) return this.status(`No fast frames for “${att.name}” in “${anim.name}” (no image corner moves 40 px in a frame).`);
      await this.images.decodeAll(r.images);
      const slots = structuredClone(work.animations.find((a) => a.id === anim.id)!.slots);
      this.ed.mutate('Smear fast frames', (q) => {
        for (const im of r.images) if (!q.images.some((x) => x.id === im.id)) q.images.push(im);
        q.animations.find((a) => a.id === anim.id)!.slots = slots;
      });
      this.status(`Smeared ${n} frame(s): ${Object.entries(r.frames).map(([a, f]) => `${a} ${f.join(', ')}`).join('; ')}.`);
    } catch (e) {
      this.error('Smear failed', [(e as Error).message]);
    }
  }

  exportClipSpec(): void {
    const anim = this.ed.anim();
    if (!anim) return;
    try {
      const text = formatClipSpec(exportClip(this.ed.project, anim.id));
      download(new Blob([text], { type: 'application/yaml' }), `${anim.name.replace(/[^\w.-]+/g, '_')}.clip.yaml`);
      this.status(`Exported “${anim.name}” as a clip spec.`);
    } catch (e) {
      this.status(`Clip spec not exported: ${(e as Error).message}`);
    }
  }

  /**
   * Applies a clip spec as one undo step: a new animation, or the same-named one rebuilt
   * in place (its id kept, so mixes and sequences still use it). Nothing changes on errors.
   */
  applyClipSpec(text: string, fileName: string): void {
    const parsed = parseClipText(text, fileName);
    const fail = (errors: string[]) => this.status(`Clip spec not applied (${errors.length} problem${errors.length > 1 ? 's' : ''}): ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '; …' : ''}`);
    if (!parsed.ok) return fail(parsed.errors);
    const name = parsed.spec.name;
    const replace = this.ed.project.animations.some((a) => a.name === name);
    const r = applyClip(this.ed.project, parsed.spec, replace ? 'replace' : 'create');
    if (!r.ok) return fail(r.errors);
    this.ed.mutate(`${replace ? 'Replace' : 'Create'} animation ${String(name)} from clip spec`, (p) => {
      p.animations = r.project.animations;
    });
    this.ed.setAnimation(r.animId);
    this.ed.setMode('animate');
    this.status(`${replace ? 'Replaced' : 'Created'} “${String(name)}” from ${fileName} (${r.keys} keys).`);
  }

  deleteAnimation(): void {
    const anim = this.ed.anim();
    if (!anim) return;
    this.ed.mutate(`Delete animation ${anim.name}`, (p) => {
      p.animations = p.animations.filter((a) => a.id !== anim.id);
    });
    // Mix rules and saved sequences that used it are repaired in the same step; say so.
    const repairs = this.ed.lastRepairs;
    this.ed.setAnimation(this.ed.project.animations[0]?.id ?? null);
    this.status(`Deleted animation “${anim.name}”.${repairs.length ? ` ${repairs.join(' ')}` : ''}`);
  }

  updateAnimation(label: string, fn: (a: Animation) => void): void {
    const id = this.ed.animId;
    if (!id) return;
    this.ed.mutate(label, (p) => {
      const a = p.animations.find((x) => x.id === id);
      if (a) fn(a);
    });
    const anim = this.ed.anim();
    if (anim) {
      const n = keysBeyondEnd(anim);
      if (n) this.status(`${n} key(s) lie past the end and will not play. Extend the duration to use them.`);
    }
  }

  /** K / Key button: keys the selected bone (all channels or one). */
  keySelected(channels: readonly Channel[] = CHANNELS): void {
    const ed = this.ed;
    const boneId = ed.selectedBoneId();
    if (!boneId) return this.status('Select a bone to key it.');
    if (!ed.animId) return this.status('Create an animation first (+ in the timeline).');
    if (ed.mode !== 'animate') ed.setMode('animate');
    ed.mutate('Set key', (p) => keyChannels(p, ed.animId!, ed.time, boneId, channels));
    ed.selectKey({ lane: boneLane(boneId, channels[0]), time: snapToFrame(ed.time, ed.anim()!.fps) });
  }

  /** Toggles a single channel key at the current frame. */
  toggleKey(boneId: string, ch: Channel): void {
    const ed = this.ed;
    const anim = ed.anim();
    if (!anim) return;
    const t = snapToFrame(ed.time, anim.fps);
    const keys = anim.tracks[boneId]?.[ch] ?? [];
    if (findKeyIndex(keys, t) >= 0) {
      ed.mutate(`Remove ${ch} key`, (p) => {
        const a = p.animations.find((x) => x.id === anim.id)!;
        removeKey(a.tracks[boneId][ch], t);
      });
    } else {
      ed.mutate(`Key ${ch}`, (p) => keyChannels(p, anim.id, t, boneId, [ch]));
    }
  }

  deleteSelectedKey(): void {
    const ed = this.ed;
    const refs = ed.keySels.slice();
    const anim = ed.anim();
    if (!refs.length || !anim) return;
    ed.mutate(refs.length > 1 ? `Delete ${refs.length} keys` : 'Delete key', (p) => {
      const a = p.animations.find((x) => x.id === anim.id);
      if (a) deleteKeys(a, refs);
    });
    ed.selectKey(null);
  }

  // ---- Multi-key editing ------------------------------------------------------------

  /** The primary selected key object (any lane type). */
  primaryKey(): { time: number } | undefined {
    const anim = this.ed.anim();
    return anim && this.ed.keySel ? findKey(anim, this.ed.keySel) : undefined;
  }

  /** Adds (or replaces) event `name` at the playhead's frame and selects it. */
  addEventAtPlayhead(name: string, payload?: string): void {
    const anim = this.ed.anim();
    const n = name.trim();
    if (!anim) return;
    if (!EVENT_NAME.test(n)) return this.status('Event names are 1–64 letters, digits and _ . : - (e.g. prop_flash, sfx:win).');
    const time = snapToFrame(this.ed.time, anim.fps);
    const value = parsePayload(payload);
    this.mutateAnim(`Add event ${n}`, (a) => {
      const keys = laneKeys(a, eventLane(n), true) as EventKey[];
      const i = findKeyIndex(keys, time);
      const key: EventKey = { time, ...(value !== undefined ? { payload: value } : {}) };
      if (i >= 0) keys[i] = key;
      else insertSorted(keys, key);
    });
    this.ed.selectKey({ lane: eventLane(n), time });
    this.status(`Event “${n}” at frame ${Math.round(time * anim.fps)}.`);
  }

  /** Renames (moves to another event lane) and/or sets the payload of the selected event key. */
  updateSelectedEvent(change: { name?: string; payload?: string }): void {
    const anim = this.ed.anim();
    const ref = this.ed.keySel;
    const info = ref && parseLane(ref.lane);
    if (!anim || !ref || info?.kind !== 'event') return;
    const name = change.name?.trim() ?? info.name;
    if (!EVENT_NAME.test(name)) return this.status('Event names are 1–64 letters, digits and _ . : - (e.g. prop_flash, sfx:win).');
    const old = findKey(anim, ref) as EventKey | undefined;
    if (!old) return;
    const payload = change.payload !== undefined ? parsePayload(change.payload) : old.payload;
    this.mutateAnim(name !== info.name ? `Rename event ${info.name} → ${name}` : `Event ${name} payload`, (a) => {
      const from = laneKeys(a, ref.lane) as EventKey[];
      from.splice(findKeyIndex(from, ref.time), 1);
      if (!from.length) delete a.events![info.name];
      const to = laneKeys(a, eventLane(name), true) as EventKey[];
      const i = findKeyIndex(to, ref.time);
      const key: EventKey = { time: old.time, ...(payload !== undefined ? { payload } : {}) };
      if (i >= 0) to[i] = key;
      else insertSorted(to, key);
    });
    this.ed.selectKey({ lane: eventLane(name), time: ref.time });
  }

  private mutateAnim(label: string, fn: (a: Animation) => void): void {
    const id = this.ed.animId;
    if (!id) return;
    this.ed.mutate(label, (p) => {
      const a = p.animations.find((x) => x.id === id);
      if (a) fn(a);
    });
  }

  /** Selected keys that carry an interpolation (not image/draw-order/visibility keys). */
  private curveKeys(a: Animation): Key[] {
    const out: Key[] = [];
    for (const r of this.ed.keySels) {
      if (/:(visible)$/.test(r.lane)) continue;
      const k = findKey(a, r);
      if (k && 'interp' in k) out.push(k as Key);
    }
    return out;
  }

  /** Selected bone translate keys (the only keys with a separate y easing). */
  private translateKeys(a: Animation): Key[] {
    const out: Key[] = [];
    for (const r of this.ed.keySels) {
      const info = parseLane(r.lane);
      if (info?.kind !== 'bone' || info.channel !== 'translate') continue;
      const k = findKey(a, r);
      if (k) out.push(k as Key);
    }
    return out;
  }

  /**
   * `axis` 'y': the separate y easing of the selected translate keys (other keys are left
   * alone); 'x': the key's own interpolation (x, and y unless it has its own).
   */
  setInterpForSelection(interp: Key['interp'], axis: 'x' | 'y' = 'x'): void {
    const n = this.ed.keySels.length;
    this.mutateAnim(n > 1 ? `Interpolation of ${n} keys${axis === 'y' ? ' (y)' : ''}` : `Change interpolation${axis === 'y' ? ' (y)' : ''}`, (a) => {
      if (axis === 'y') for (const k of this.translateKeys(a)) setInterpY(k, interp);
      else for (const k of this.curveKeys(a)) setInterp(k, interp);
    });
  }

  /** Writes a curve onto every selected curve-capable key (used inside gestures too). */
  applyCurveTo(p: Project, curve: Curve, axis: 'x' | 'y' = 'x'): void {
    const a = p.animations.find((x) => x.id === this.ed.animId);
    if (!a) return;
    if (axis === 'y') for (const k of this.translateKeys(a)) setInterpY(k, 'bezier', curve);
    else for (const k of this.curveKeys(a)) setInterp(k, 'bezier', curve);
  }

  setCurveForSelection(curve: Curve, label: string, axis: 'x' | 'y' = 'x'): void {
    this.ed.mutate(label, (p) => this.applyCurveTo(p, curve, axis));
  }

  applyCurvePreset(name: string, axis: 'x' | 'y' = 'x'): void {
    if (name === 'step') return this.setInterpForSelection('step', axis);
    const c = CURVE_PRESETS[name];
    if (c) this.setCurveForSelection(c, `Curve preset ${name}${axis === 'y' ? ' (y)' : ''}`, axis);
    this.status(`Applied “${name}” easing to ${this.ed.keySels.length} key(s)${axis === 'y' ? ' (y only)' : ''}.`);
  }

  /**
   * Separate y easing on/off for the selected translate keys. On: y starts as a copy of
   * the key's easing (nothing moves until it is edited); off: y follows x again.
   */
  splitTranslateY(on: boolean): void {
    this.mutateAnim(on ? 'Separate Y easing' : 'Join X / Y easing', (a) => {
      for (const k of this.translateKeys(a)) {
        if (!on) setInterpY(k, null);
        else if (!k.interpY) setInterpY(k, k.interp, k.curve);
      }
    });
  }

  nudgeKeys(frames: number): void {
    const ed = this.ed;
    const anim = ed.anim();
    if (!anim || !ed.keySels.length) return;
    const refs = ed.keySels.slice();
    const primary = ed.keySel;
    let moved: KeyRef[] = [];
    ed.mutate(refs.length > 1 ? `Nudge ${refs.length} keys` : 'Nudge key', (p) => {
      const a = p.animations.find((x) => x.id === anim.id)!;
      moved = shiftKeys(a, refs, frames / anim.fps);
    });
    const idx = primary ? refs.findIndex((r) => sameRef(r, primary)) : 0;
    ed.setKeySelection(moved, moved[idx]);
    if (ed.keySel) ed.setTime(ed.keySel.time);
  }

  copySelectedKeys(): void {
    const anim = this.ed.anim();
    if (!anim) return;
    const clip = copyKeys(anim, this.ed.keySels);
    if (!clip) return this.status('Select keys to copy.');
    const portable = toPortable(this.ed.project, clip);
    this.ed.clipboard = portable;
    this.ed.emit('selection');
    const done = `Copied ${clip.items.length} key(s). Move the playhead (and select another bone to retarget) and Paste — also after a reload or in another project.`;
    this.status(done);
    // Durable copy: survives reloads and project switches (RV-009). Memory-only if storage fails.
    void this.storageReady
      .then(() => writeRecord(CLIPBOARD, portable))
      .catch((e) => this.status(`Copied ${clip.items.length} key(s) for this session only — browser storage refused the clipboard (${(e as Error).message}).`));
  }

  /** Restores the durable clipboard after startup (called once storage is ready). */
  private async restoreClipboard(): Promise<void> {
    const pc = parsePortable(await readRecord(CLIPBOARD));
    if (pc && !this.ed.clipboard) {
      this.ed.clipboard = pc;
      this.ed.emit('selection');
    }
  }

  pasteKeysAtPlayhead(): void {
    const ed = this.ed;
    const anim = ed.anim();
    const portable = ed.clipboard;
    if (!anim || !portable) return this.status('Nothing to paste. Copy keys first.');
    const { clip, unresolved, dropped } = resolvePortable(ed.project, portable);
    if (!clip.items.length) return this.status(`None of the ${portable.items.length} copied key(s) fit this project: no ${unresolved.join(', ')} here.`);
    const t = snapToFrame(ed.time, anim.fps);
    let result: ReturnType<typeof pasteKeys> = { refs: [], skipped: 0, retarget: null };
    ed.mutate(`Paste ${clip.items.length} key(s)`, (p) => {
      const a = p.animations.find((x) => x.id === anim.id)!;
      result = pasteKeys(a, clip, t, ed.selectedBoneId());
    });
    // The integrity pass may drop pasted keys that do not fit (e.g. an old mesh's deform key).
    const pasted = result.refs.filter((r) => findKey(ed.anim()!, r));
    ed.setKeySelection(pasted);
    const repairs = ed.lastRepairs.length ? ` ${ed.lastRepairs.join(' ')}` : '';
    const missing = dropped ? ` ${dropped} key(s) not pasted: no ${unresolved.join(', ')} in this project.` : '';
    const boneName = (id: string) => ed.project.bones.find((b) => b.id === id)?.name ?? id;
    const onto = result.retarget ? ` onto the selected bone “${boneName(result.retarget.to)}” (copied from “${boneName(result.retarget.from)}”)` : '';
    // Pasted keys a constraint of this project overrides (as in the import report).
    const only: Animation = { ...ed.anim()!, tracks: {} };
    for (const r of pasted) {
      const info = parseLane(r.lane);
      if (info?.kind !== 'bone') continue;
      ((only.tracks[info.id] ??= emptyTrack())[info.channel] as Key[]).push(findKey(ed.anim()!, r) as Key);
    }
    const driven = drivenByConstraints(ed.project, only);
    const over = driven.length ? ` ${driven.reduce((n, d) => n + d.keys, 0)} pasted key(s) are overridden by ${driven.map((d) => `“${d.constraint}”`).join(', ')} (constraint mix > 0) and have no visible effect.` : '';
    this.status(`Pasted ${pasted.length} key(s) at frame ${Math.round(t * anim.fps)}${onto}${result.skipped ? `; ${result.skipped} would land past the end and were skipped` : ''}.${over}${missing}${repairs}`);
  }

  closeLoop(): void {
    const ed = this.ed;
    const anim = ed.anim();
    if (!anim) return;
    const lanes = ed.keySels.length ? [...new Set(ed.keySels.map((r) => r.lane))] : allLanes(anim);
    if (!lanes.length) return this.status('No keyed lanes to close.');
    let changed: string[] = [];
    ed.mutate('Close loop seam', (p) => {
      const a = p.animations.find((x) => x.id === anim.id)!;
      changed = closeLoopSeam(a, lanes, p);
    });
    this.status(`Loop seam closed on ${changed.length} lane(s): each lane’s first key copied to frame ${Math.round(anim.duration * anim.fps)}.`);
  }

  selectAllKeys(): void {
    const anim = this.ed.anim();
    if (!anim) return;
    const refs: KeyRef[] = [];
    for (const lane of allLanes(anim)) for (const k of laneKeys(anim, lane) ?? []) refs.push({ lane, time: k.time });
    this.ed.setKeySelection(refs);
    this.status(`Selected all ${refs.length} keys.`);
  }

  stepFrame(dir: number): void {
    const anim = this.ed.anim();
    if (!anim) return;
    this.ed.stop();
    if (this.ed.mode !== 'animate') this.ed.setMode('animate');
    const f = Math.round(this.ed.time * anim.fps) + dir;
    const max = Math.round(anim.duration * anim.fps);
    this.ed.setTime(((f % (max + 1)) + (max + 1)) % (max + 1) / anim.fps);
  }

  // ---- Keyboard ------------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    const ed = this.ed;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void this.saveDownload();
      return;
    }
    if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      this.fileInput.click();
      return;
    }
    if (isTyping(e)) return;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      const ok = e.shiftKey ? ed.redo() : ed.undo();
      if (ok) this.status(ed.lastUndoRedo);
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      if (ed.redo()) this.status(ed.lastUndoRedo);
      return;
    }
    if (mod && e.key.toLowerCase() === 'c' && ed.keySels.length) {
      e.preventDefault();
      this.copySelectedKeys();
      return;
    }
    if (mod && e.key.toLowerCase() === 'v' && ed.clipboard) {
      e.preventDefault();
      this.pasteKeysAtPlayhead();
      return;
    }
    if (mod && e.key.toLowerCase() === 'a' && ed.anim()) {
      e.preventDefault();
      this.selectAllKeys();
      return;
    }
    if (mod || e.altKey) return;
    // Leave Space/Tab to native behaviour on focused buttons/links (activation, focus order).
    const tag = (e.target as HTMLElement | null)?.tagName;
    if ((e.key === ' ' || e.key === 'Tab') && (tag === 'BUTTON' || tag === 'A')) return;
    const tools: Record<string, Tool> = { v: 'move', r: 'rotate', s: 'scale', b: 'create' };
    const k = e.key.toLowerCase();
    if (tools[k]) {
      ed.setTool(tools[k]);
      return;
    }
    switch (e.key) {
      case ' ':
        e.preventDefault();
        ed.togglePlay();
        break;
      case 'Tab':
        e.preventDefault();
        if (ed.mode === 'setup' && !ed.anim()) this.status('Create an animation first (+ in the timeline).');
        ed.setMode(ed.mode === 'setup' ? 'animate' : 'setup');
        break;
      case 'k':
      case 'K':
        this.keySelected();
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        this.deleteSelection();
        break;
      case 'Escape':
        if (ed.cancelActiveDrag()) break;
        if (this.viewport.isDragging) this.viewport.cancelDrag();
        else if (ed.keySels.length) ed.setKeySelection([]);
        else if (ed.meshTool !== 'off') {
          ed.meshTool = 'off';
          ed.meshVertex = -1;
          ed.emit('selection');
        } else ed.select(null);
        break;
      case '[':
        this.nudgeKeys(-1);
        break;
      case ']':
        this.nudgeKeys(1);
        break;
      case 'f':
      case 'F':
        this.viewport.frameAll();
        break;
      case 'h':
      case 'H':
        ed.showBones = !ed.showBones;
        ed.emit('view');
        break;
      case ',':
        this.stepFrame(-1);
        break;
      case '.':
        this.stepFrame(1);
        break;
      case 'Home':
        ed.stop();
        ed.setTime(0);
        break;
      case 'End': {
        const anim = ed.anim();
        ed.stop();
        if (anim) ed.setTime(anim.duration);
        break;
      }
    }
  }

  // ---- Read-only test/debug probe -----------------------------------------------------

  /** Screen-space (client px) positions of a bone, for tests that drive the mouse. */
  boneScreen(name: string): { origin: { x: number; y: number }; tip: { x: number; y: number }; mid: { x: number; y: number }; world: { x: number; y: number; angle: number } } | null {
    const b = this.ed.project.bones.find((x) => x.name === name);
    if (!b) return null;
    const m = this.ed.world().get(b.id);
    if (!m) return null;
    const r = this.viewport.canvas.getBoundingClientRect();
    const o = this.viewport.toScreen({ x: m.tx, y: m.ty });
    const t = this.viewport.toScreen(boneTip(b, m));
    const c = (p: { x: number; y: number }) => ({ x: r.left + p.x, y: r.top + p.y });
    return { origin: c(o), tip: c(t), mid: c({ x: (o.x + t.x) / 2, y: (o.y + t.y) / 2 }), world: { x: m.tx, y: m.ty, angle: (Math.atan2(m.b, m.a) * 180) / Math.PI } };
  }

  /** Evaluated attachments in draw order (what the canvas shows now). */
  frameState(): { name: string; visible: boolean; opacity: number; image: string | null }[] {
    return this.ed.frame().attachments.map((f) => ({ name: f.att.name, visible: f.visible, opacity: f.opacity, image: f.image?.name ?? null }));
  }

  /** Client-space positions of a path's node i and its handles. */
  pathScreen(name: string, i: number): { node: { x: number; y: number }; in: { x: number; y: number }; out: { x: number; y: number } } | null {
    const path = this.ed.project.paths?.find((x) => x.name === name);
    const n = path?.nodes[i];
    if (!path || !n) return null;
    const m = (path.boneId && this.ed.world().get(path.boneId)) || { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    const r = this.viewport.canvas.getBoundingClientRect();
    const c = (x: number, y: number) => {
      const s = this.viewport.toScreen(apply(m, { x, y }));
      return { x: r.left + s.x, y: r.top + s.y };
    };
    return { node: c(n.x, n.y), in: c(n.x + n.inX, n.y + n.inY), out: c(n.x + n.outX, n.y + n.outY) };
  }

  attachmentScreen(name: string): { x: number; y: number } | null {
    const a = this.ed.project.attachments.find((x) => x.name === name);
    if (!a) return null;
    const m = attachmentWorld(a, this.ed.world());
    const r = this.viewport.canvas.getBoundingClientRect();
    const s = this.viewport.toScreen({ x: m.tx, y: m.ty });
    return { x: r.left + s.x, y: r.top + s.y };
  }

  /** Client-space positions of a mesh attachment's vertices in the displayed frame. */
  meshScreen(name: string): { x: number; y: number }[] | null {
    const f = this.ed.frame().attachments.find((x) => x.att.name === name);
    if (!f?.vertices) return null;
    const r = this.viewport.canvas.getBoundingClientRect();
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < f.vertices.length; i += 2) {
      const s = this.viewport.toScreen({ x: f.vertices[i], y: f.vertices[i + 1] });
      out.push({ x: r.left + s.x, y: r.top + s.y });
    }
    return out;
  }

  /** World point under a client-space coordinate (inverse of the view). */
  worldAt(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.viewport.canvas.getBoundingClientRect();
    const v = this.viewport.viewMatrix();
    return apply(invert(v), { x: clientX - r.left, y: clientY - r.top });
  }

  snapshot(): Project {
    return JSON.parse(serializeProject(this.ed.project)) as Project;
  }
}

/** An event payload typed in a field: blank → none, a plain number → number, else the text. */
export function parsePayload(text: string | undefined): string | number | undefined {
  if (text === undefined) return undefined;
  const t = text.trim();
  if (!t) return undefined;
  return /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(t) ? Number(t) : t.slice(0, 256);
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
