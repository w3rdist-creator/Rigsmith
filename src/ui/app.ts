// Application wiring: actions shared by the toolbar, panels, timeline and shortcuts.
import { Editor } from '../editor/store.ts';
import type { Tool } from '../editor/store.ts';
import { findKeyIndex, keysBeyondEnd, removeKey, snapToFrame } from '../model/animation.ts';
import { buildDemoProject } from '../model/demo.ts';
import { exportRuntime } from '../model/exportRuntime.ts';
import { parseProject, serializeProject } from '../model/format.ts';
import { apply, invert } from '../model/math.ts';
import { keyChannels, makeBone, uniqueName } from '../model/ops.ts';
import { CycleError, attachmentWorld, boneTip, deleteBone, reparentBone } from '../model/skeleton.ts';
import type { Animation, Channel, Project } from '../model/types.ts';
import { CHANNELS, emptyProject, newId } from '../model/types.ts';
import { buildDemoImages } from './demoArt.ts';
import { h } from './dom.ts';
import { ImageCache, importImageFile } from './images.ts';
import { Viewport, isTyping } from './viewport.ts';

export const STORAGE_KEY = 'rigsmith:project:v1';

export class App {
  readonly ed = new Editor();
  readonly images = new ImageCache();
  viewport!: Viewport;
  private statusEl!: HTMLElement;
  private toastEl!: HTMLElement;
  private statusTimer = 0;
  readonly fileInput = h('input', { type: 'file', accept: '.json,.rig.json,application/json', hidden: true, 'data-testid': 'open-input' });
  readonly imageInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true, 'data-testid': 'image-input' });

  mount(canvas: HTMLCanvasElement, statusEl: HTMLElement, toastEl: HTMLElement): void {
    this.statusEl = statusEl;
    this.toastEl = toastEl;
    this.viewport = new Viewport(canvas, this.ed, this.images);
    this.viewport.onStatus = (m) => this.status(m);
    document.body.append(this.fileInput, this.imageInput);
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

  private guard(fn: () => void): void {
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

  saveDownload(): void {
    download(new Blob([serializeProject(this.ed.project)], { type: 'application/json' }), `${this.fileBaseName()}.rig.json`);
    this.ed.dirty = false;
    this.ed.emit('view');
    this.status('Project downloaded (images embedded).');
  }

  saveToBrowser(): void {
    try {
      localStorage.setItem(STORAGE_KEY, serializeProject(this.ed.project));
      this.ed.dirty = false;
      this.ed.emit('view');
      this.status('Saved to this browser’s local storage.');
    } catch (e) {
      const quota = e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22);
      this.error('Browser save failed', [quota ? 'The project is too large for browser storage. Use Save (download) instead.' : (e as Error).message]);
    }
  }

  hasBrowserSave(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      return false;
    }
  }

  async restoreFromBrowser(): Promise<void> {
    let text: string | null = null;
    try {
      text = localStorage.getItem(STORAGE_KEY);
    } catch {
      text = null;
    }
    if (!text) return this.error('Nothing saved in this browser yet.');
    if (!this.confirmDiscard()) return;
    await this.loadProjectText(text, 'browser save');
  }

  exportRuntimeJson(): void {
    if (!this.ed.project.bones.length) return this.error('Nothing to export', ['Create at least one bone first.']);
    const data = exportRuntime(this.ed.project);
    download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `${this.fileBaseName()}.runtime.json`);
    this.status('Exported runtime JSON (keys + baked per-frame world transforms).');
  }

  /** Renders the current pose without editor chrome to a transparent PNG cropped to the art. */
  exportPngFrame(): void {
    const p = this.ed.project;
    const world = this.ed.world();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const a of p.attachments) {
      const im = p.images.find((i) => i.id === a.imageId);
      if (!im) continue;
      const m = attachmentWorld(a, world);
      for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const q = apply(m, { x: (x * im.width) / 2, y: (y * im.height) / 2 });
        minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
        minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
      }
    }
    if (!Number.isFinite(minX)) return this.error('Nothing to render', ['Attach at least one image first.']);
    const pad = 8;
    const w = Math.ceil(maxX - minX + pad * 2), hh = Math.ceil(maxY - minY + pad * 2);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = hh;
    this.viewport.render(c.getContext('2d')!, w, hh, 1, false, { zoom: 1, x: -minX + pad, y: -minY + pad });
    c.toBlob((blob) => {
      if (!blob) return this.error('PNG export failed');
      const frame = this.ed.anim() && this.ed.mode === 'animate' ? `-f${Math.round(this.ed.time * this.ed.anim()!.fps)}` : '-setup';
      download(blob, `${this.fileBaseName()}${frame}.png`);
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
    const users = this.ed.project.attachments.filter((a) => a.imageId === imageId).length;
    if (users && !window.confirm(`“${im.name}” is used by ${users} attachment(s). Remove it and them?`)) return;
    this.ed.mutate(`Remove ${im.name}`, (p) => {
      p.images = p.images.filter((i) => i.id !== imageId);
      p.attachments = p.attachments.filter((a) => a.imageId !== imageId);
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
    if (ed.keySel && ed.mode === 'animate') return this.deleteSelectedKey();
    const sel = ed.selection;
    if (!sel) return;
    if (sel.kind === 'bone') {
      const b = ed.project.bones.find((x) => x.id === sel.id);
      ed.mutate(`Delete bone ${b?.name ?? ''}`, (p) => deleteBone(p, sel.id));
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

  deleteAnimation(): void {
    const anim = this.ed.anim();
    if (!anim) return;
    this.ed.mutate(`Delete animation ${anim.name}`, (p) => {
      p.animations = p.animations.filter((a) => a.id !== anim.id);
    });
    this.ed.setAnimation(this.ed.project.animations[0]?.id ?? null);
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
    ed.selectKey({ boneId, channel: channels[0], time: snapToFrame(ed.time, ed.anim()!.fps) });
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
    const k = ed.keySel;
    const anim = ed.anim();
    if (!k || !anim) return;
    ed.mutate('Delete key', (p) => {
      const a = p.animations.find((x) => x.id === anim.id);
      const keys = a?.tracks[k.boneId]?.[k.channel];
      if (keys) removeKey(keys, k.time);
    });
    ed.selectKey(null);
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
      this.saveDownload();
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
        if (this.viewport.isDragging) this.viewport.cancelDrag();
        else ed.select(null);
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

  attachmentScreen(name: string): { x: number; y: number } | null {
    const a = this.ed.project.attachments.find((x) => x.name === name);
    if (!a) return null;
    const m = attachmentWorld(a, this.ed.world());
    const r = this.viewport.canvas.getBoundingClientRect();
    const s = this.viewport.toScreen({ x: m.tx, y: m.ty });
    return { x: r.left + s.x, y: r.top + s.y };
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

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
