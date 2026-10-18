// "Cut out piece…" dialog: draw a polygon (or drag a rectangle) over an attachment's
// image, set a pivot, overlap and options, then create the piece as a new derived image
// + attachment exactly where it was (optionally with a joint bone at the pivot and the
// source replaced by its remainder, optionally patched with a flat colour). The source
// image is never modified and stays in the project.
// Pixel tools (the remaining hand-preparation steps): "Select colour" picks pixels by colour —
// the 4-connected region from the clicked pixel (flood fill) or, unticked, every pixel in
// the colour box (threshold); Shift+click adds. A selection replaces the outline for the
// cut. "Remove specks" makes a cleaned copy (faint pixels far from solid art removed) and
// points the attachment at it in one undo step.
import type { PixelMask, Rgba, SpeckOptions } from '../model/cutout.ts';
import { DEFAULT_SPECKS, cutOut, cutOutMask, extendPiece, farthestMaskPixel, findSpecks, maskBounds, maskCentroid, parseHexColor, patchBehind, patchBehindMask, polygonBounds, polygonCentroid, polygonProblem, removeSpecks, selectColour, unionMask } from '../model/cutout.ts';
import { encodePngExact } from '../model/png.ts';
import { placeCutout } from '../model/rigOps.ts';
import type { ImageAsset } from '../model/types.ts';
import { newId } from '../model/types.ts';
import type { App } from './app.ts';
import { imagePixels } from './atlasDialog.ts';
import { append, clear, h } from './dom.ts';

type Mode = 'polygon' | 'rect' | 'pivot' | 'pick' | 'wand';
/** Starting values instead of the defaults (the onboarding guide, RV-012), plus a visible note. */
export interface CutPreset {
  mode?: Mode;
  overlap?: number;
  extend?: number;
  tolerance?: number;
  hint?: string;
}
const VIEW_W = 520;
const VIEW_H = 400;

export class CutoutDialog {
  private app: App;
  private dlg: HTMLDialogElement;
  private body: HTMLElement;
  private attId: string | null = null;
  private poly: number[] = [];
  private pivot: { x: number; y: number } | null = null;
  private mode: Mode = 'polygon';
  private overlap = 4;
  private name = 'piece';
  private replace = true;
  private makeBone = true;
  private parentId: string | null = null;
  private patch = false;
  private patchColor = '#808080';
  private extend = 0;
  private behind = false;
  private errors: string[] = [];
  private busy = false;
  private canvas: HTMLCanvasElement | null = null;
  private rectStart: { x: number; y: number } | null = null;
  private seeds: { x: number; y: number }[] = [];
  private mask: PixelMask | null = null;
  private tolerance = 32;
  private minAlpha = 0;
  private contiguous = true;
  private specks: SpeckOptions = { ...DEFAULT_SPECKS };
  private exact: { id: string; px: Rgba } | null = null;
  private speckCache: { key: string; count: number } | null = null;
  private hint = '';

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'export-body' });
    this.dlg = h('dialog', { class: 'help export cutout', 'data-testid': 'cutout-dialog', 'aria-label': 'Cut out piece' }, h('h2', {}, 'Cut out piece'), this.body) as HTMLDialogElement;
    document.body.append(this.dlg);
  }

  get isOpen(): boolean {
    return this.dlg.open;
  }

  open(attId: string, preset: CutPreset = {}): void {
    const p = this.app.ed.project;
    const att = p.attachments.find((a) => a.id === attId);
    if (!att) return;
    this.attId = attId;
    this.poly = [];
    this.pivot = null;
    this.mode = 'polygon';
    this.errors = [];
    // Every cut starts from the documented defaults.
    this.overlap = 4;
    this.replace = true;
    this.makeBone = true;
    this.patch = false;
    this.patchColor = '#808080';
    this.extend = 0;
    this.behind = false;
    this.name = `${att.name}-piece`;
    this.parentId = att.boneId;
    this.seeds = [];
    this.mask = null;
    this.tolerance = 32;
    this.minAlpha = 0;
    this.contiguous = true;
    this.specks = { ...DEFAULT_SPECKS };
    if (preset.mode) this.mode = preset.mode;
    if (preset.overlap !== undefined) this.overlap = preset.overlap;
    if (preset.extend !== undefined) this.extend = preset.extend;
    if (this.extend > 0) this.behind = true;
    if (preset.tolerance !== undefined) this.tolerance = preset.tolerance;
    this.hint = preset.hint ?? '';
    this.dlg.scrollTop = 0;
    this.render();
    this.dlg.showModal();
    this.dlg.scrollTop = 0;
    void this.loadExact();
  }

  /** Exact source pixels (PNG decoded without a canvas round trip) for the pixel tools. */
  private async loadExact(): Promise<Rgba | null> {
    const src = this.source();
    if (!src) return null;
    if (this.exact?.id !== src.im.id) {
      this.exact = { id: src.im.id, px: (await imagePixels(this.app, src.im)).pixels };
      if (this.dlg.open) this.render();
    }
    return this.exact.px;
  }

  private reselect(): void {
    const px = this.exact?.px;
    if (!px || !this.seeds.length) {
      this.mask = null;
      return;
    }
    const o = { tolerance: this.tolerance, minAlpha: this.minAlpha, contiguous: this.contiguous };
    this.mask = this.seeds.map((q) => selectColour(px, q.x, q.y, o)).reduce((a, b) => unionMask(a, b));
  }

  private speckCount(): number | null {
    const px = this.exact?.px;
    if (!px || this.exact!.id !== this.source()?.im.id) return null;
    const key = `${this.exact!.id}|${this.specks.faintBelow}|${this.specks.solidAbove}|${this.specks.distance}`;
    if (this.speckCache?.key !== key) this.speckCache = { key, count: findSpecks(px, this.specks).count };
    return this.speckCache.count;
  }

  private source() {
    const p = this.app.ed.project;
    const att = p.attachments.find((a) => a.id === this.attId);
    const im = att && p.images.find((i) => i.id === att.imageId);
    return att && im ? { att, im } : null;
  }

  private geometry(im: ImageAsset) {
    const scale = Math.min(VIEW_W / im.width, VIEW_H / im.height, 4);
    return { scale, ox: (VIEW_W - im.width * scale) / 2, oy: (VIEW_H - im.height * scale) / 2 };
  }

  private render(): void {
    // The dialog can be taller than the window and scroll. Rebuilding the body would move
    // the scroll offset — and the canvas under the pointer — after each click (RV-012 on
    // real art: every outline point after the first landed ~124 CSS px off). Keep it.
    const scroll = this.dlg.scrollTop;
    try {
      this.renderBody();
    } finally {
      this.dlg.scrollTop = scroll;
    }
  }

  private renderBody(): void {
    const src = this.source();
    clear(this.body);
    if (!src) return;
    const { im } = src;
    const p = this.app.ed.project;
    const g = this.geometry(im);
    const canvas = h('canvas', {
      class: 'cutout-canvas',
      width: VIEW_W * 2,
      height: VIEW_H * 2,
      style: `width:${VIEW_W}px;height:${VIEW_H}px`,
      'data-testid': 'cutout-canvas',
      'data-scale': String(g.scale),
      'data-ox': String(g.ox),
      'data-oy': String(g.oy),
      'aria-label': 'Cutout canvas: click to add outline points',
    });
    this.canvas = canvas;
    this.attachPointer(canvas, im);
    const modeBtn = (m: Mode, label: string, title: string) =>
      h('button', { class: `mini${this.mode === m ? ' on' : ''}`, 'data-testid': `cut-mode-${m}`, 'aria-pressed': this.mode === m ? 'true' : 'false', title, onclick: () => ((this.mode = m), this.render()) }, label);
    const num = (testId: string, label: string, value: number, set: (v: number) => void, max = 64) => {
      const input = h('input', { type: 'number', min: 0, max, step: 1, value: String(value), 'data-testid': testId, 'aria-label': label, class: 'w-num' });
      input.addEventListener('change', () => (set(Number(input.value)), this.render()));
      return h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, label), input);
    };
    const check = (testId: string, label: string, value: boolean, set: (v: boolean) => void) => {
      const input = h('input', { type: 'checkbox', checked: value, 'data-testid': testId, 'aria-label': label });
      input.addEventListener('change', () => (set(input.checked), this.render()));
      return h('label', { class: 'field check' }, input, h('span', {}, label));
    };
    const nameIn = h('input', { type: 'text', value: this.name, 'data-testid': 'cut-name', 'aria-label': 'Piece name' });
    nameIn.addEventListener('change', () => (this.name = nameIn.value.trim() || this.name));
    const parentSel = h('select', { 'data-testid': 'cut-parent', 'aria-label': 'Parent of the new bone', disabled: !this.makeBone }, h('option', { value: '' }, '(root)'), ...p.bones.map((b) => h('option', { value: b.id }, b.name)));
    parentSel.value = this.parentId ?? '';
    parentSel.addEventListener('change', () => (this.parentId = parentSel.value || null));
    const color = h('input', { type: 'color', value: this.patchColor, 'data-testid': 'cut-patch-color', 'aria-label': 'Patch colour', disabled: !this.patch || !this.replace });
    color.addEventListener('change', () => (this.patchColor = color.value));
    const problem = this.cutProblem(im);
    const b = this.poly.length >= 2 ? polygonBounds(this.poly) : null;
    const mb = this.mask ? maskBounds(this.mask) : null;
    const shape = this.mask
      ? `selection ${this.mask.count} px${mb ? ` · ${mb.width}×${mb.height} px at ${mb.x},${mb.y}` : ''} (${this.contiguous ? 'flood fill' : 'colour threshold'}, tolerance ${this.tolerance}, α > ${this.minAlpha}${this.seeds.length > 1 ? `, ${this.seeds.length} clicks` : ''})`
      : `${this.poly.length / 2} point(s)${b ? ` · outline ${Math.round(b.width)}×${Math.round(b.height)} px at ${Math.round(b.x)},${Math.round(b.y)}` : ''}`;
    const summary = `${shape} · overlap ${this.overlap} px · pivot ${this.pivot ? `${Math.round(this.pivot.x)},${Math.round(this.pivot.y)}` : 'not set'}`;
    const specks = this.speckCount();
    const speckNum = (testId: string, label: string, key: keyof SpeckOptions, max: number) => num(testId, label, this.specks[key], (v) => (this.specks = { ...this.specks, [key]: Math.min(max, Math.max(0, Math.round(v) || 0)) }), max);
    const reselectNum = (testId: string, label: string, value: number, set: (v: number) => void, max: number) => num(testId, label, value, (v) => (set(Math.min(max, Math.max(0, Math.round(v) || 0))), this.reselect()), max);
    append(this.body,
      h('p', { class: 'dim' }, `Source: ${im.name} (${im.width}×${im.height}) — never modified. The piece keeps its exact position.`),
      this.hint ? h('p', { class: 'hint guide-hint', 'data-testid': 'cut-guide-hint' }, this.hint) : null,
      h('div', { class: 'row-key' },
        modeBtn('polygon', 'Polygon', 'Click to add outline points'),
        modeBtn('rect', 'Rectangle', 'Drag a crop rectangle'),
        modeBtn('pivot', 'Pivot', 'Click the joint (rotation point) of the piece'),
        modeBtn('pick', 'Pick colour', 'Click the image to take the patch colour from it'),
        modeBtn('wand', 'Select colour', 'Click a colour to select it (Shift+click adds); the selection is cut instead of an outline'),
        h('button', { class: 'mini', 'data-testid': 'cut-undo-point', disabled: !this.poly.length, onclick: () => (this.poly.splice(-2), this.render()) }, 'Undo point'),
        h('button', { class: 'mini', 'data-testid': 'cut-clear', onclick: () => ((this.poly = []), (this.pivot = null), (this.seeds = []), (this.mask = null), this.render()) }, 'Clear'),
      ),
      h('div', { class: 'seq-grid' },
        reselectNum('cut-tolerance', 'Colour tolerance', this.tolerance, (v) => (this.tolerance = v), 255),
        reselectNum('cut-min-alpha', 'Only alpha above', this.minAlpha, (v) => (this.minAlpha = v), 254),
        check('cut-contiguous', 'Contiguous (flood fill)', this.contiguous, (v) => ((this.contiguous = v), this.reselect())),
      ),
      canvas,
      h('p', { class: 'dim', 'data-testid': 'cut-summary' }, summary),
      h('div', { class: 'seq-grid' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), nameIn),
        num('cut-overlap', 'Overlap (px)', this.overlap, (v) => (this.overlap = Math.min(64, Math.max(0, Math.round(v) || 0)))),
      ),
      check('cut-remainder', 'Replace the source with the remainder (original image kept)', this.replace, (v) => (this.replace = v)),
      check('cut-patch', 'Patch the hole behind the piece with a flat colour', this.patch, (v) => (this.patch = v)),
      h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, 'Patch colour'), color),
      h('div', { class: 'seq-grid' },
        num('cut-extend', 'Extend under joint (px)', this.extend, (v) => {
          this.extend = Math.min(64, Math.max(0, Math.round(v) || 0));
          if (this.extend > 0) this.behind = true;
        }),
        check('cut-behind', 'Place the piece behind the source', this.behind, (v) => (this.behind = v)),
      ),
      h('p', { class: 'hint' }, 'Extension sweeps the piece’s cross-section back past the pivot, only under fully opaque art (hidden at rest); synthesized pixels are counted.'),
      check('cut-bone', 'Create a joint bone at the pivot', this.makeBone, (v) => (this.makeBone = v)),
      h('p', { class: 'hint' }, 'Clean up: remove faint specks — pixels with alpha below the first value and no pixel above the second within the distance. Makes a cleaned copy; the source image is kept.'),
      h('div', { class: 'seq-grid' },
        speckNum('cut-speck-faint', 'Faint: alpha below', 'faintBelow', 255),
        speckNum('cut-speck-solid', 'Solid: alpha above', 'solidAbove', 254),
        speckNum('cut-speck-dist', 'Within (px)', 'distance', 64),
      ),
      h('div', { class: 'row-key' },
        h('span', { class: 'dim', 'data-testid': 'cut-speck-count' }, specks === null ? 'Counting specks…' : `${specks} speck px in ${im.name}`),
        h('button', { class: 'mini', 'data-testid': 'cut-despeckle', disabled: !specks || this.busy, onclick: () => void this.despeckle() }, 'Remove specks'),
      ),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Bone parent'), parentSel),
      this.errors.length ? h('ul', { class: 'seq-errors', role: 'alert', 'data-testid': 'cut-errors' }, ...this.errors.map((e) => h('li', {}, e))) : null,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'accent', 'data-testid': 'cut-apply', disabled: !!problem || this.busy, title: problem ?? 'Create the piece', onclick: () => void this.apply() }, 'Cut out'),
        h('button', { 'data-testid': 'cut-cancel', onclick: () => this.dlg.close() }, 'Cancel'),
      ),
    );
    this.draw();
  }

  private toImage(e: PointerEvent, im: ImageAsset): { x: number; y: number } {
    const r = this.canvas!.getBoundingClientRect();
    const g = this.geometry(im);
    const x = (e.clientX - r.left - g.ox) / g.scale, y = (e.clientY - r.top - g.oy) / g.scale;
    return { x: Math.round(Math.min(im.width, Math.max(0, x)) * 10) / 10, y: Math.round(Math.min(im.height, Math.max(0, y)) * 10) / 10 };
  }

  private attachPointer(canvas: HTMLCanvasElement, im: ImageAsset): void {
    canvas.addEventListener('pointerdown', (e) => {
      const q = this.toImage(e, im);
      if (this.mode === 'pivot') {
        this.pivot = q;
        return this.render();
      }
      if (this.mode === 'pick') {
        const px = this.pixels(im);
        const i = (Math.min(im.height - 1, Math.floor(q.y)) * im.width + Math.min(im.width - 1, Math.floor(q.x))) * 4;
        this.patchColor = `#${[0, 1, 2].map((k) => px.data[i + k].toString(16).padStart(2, '0')).join('')}`;
        this.patch = true;
        return this.render();
      }
      if (this.mode === 'wand') {
        void this.loadExact().then(() => {
          this.seeds = e.shiftKey ? [...this.seeds, q] : [q];
          this.poly = [];
          this.reselect();
          this.render();
        });
        return;
      }
      if (this.seeds.length) {
        // Drawing an outline replaces a colour selection.
        this.seeds = [];
        this.mask = null;
      }
      if (this.mode === 'rect') {
        canvas.setPointerCapture(e.pointerId);
        this.rectStart = q;
        this.poly = [q.x, q.y, q.x, q.y, q.x, q.y, q.x, q.y];
        return this.draw();
      }
      this.poly.push(q.x, q.y);
      this.render();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.mode !== 'rect' || !this.rectStart) return;
      const a = this.rectStart, b = this.toImage(e, im);
      this.poly = [a.x, a.y, b.x, a.y, b.x, b.y, a.x, b.y];
      this.draw();
    });
    canvas.addEventListener('pointerup', () => {
      if (!this.rectStart) return;
      this.rectStart = null;
      this.render();
    });
  }

  private draw(): void {
    const src = this.source();
    const c = this.canvas;
    if (!src || !c) return;
    const g = c.getContext('2d')!;
    const geo = this.geometry(src.im);
    g.setTransform(2, 0, 0, 2, 0, 0);
    g.clearRect(0, 0, VIEW_W, VIEW_H);
    for (let y = 0; y < VIEW_H; y += 12) for (let x = 0; x < VIEW_W; x += 12) {
      g.fillStyle = (x / 12 + y / 12) % 2 ? '#2a2c34' : '#22242b';
      g.fillRect(x, y, 12, 12);
    }
    const el = this.app.images.get(src.im);
    if (el) g.drawImage(el, geo.ox, geo.oy, src.im.width * geo.scale, src.im.height * geo.scale);
    if (this.mask) {
      const ov = document.createElement('canvas');
      ov.width = this.mask.width;
      ov.height = this.mask.height;
      const id = new ImageData(this.mask.width, this.mask.height);
      for (let i = 0; i < this.mask.data.length; i++) if (this.mask.data[i]) id.data.set([255, 209, 102, 150], i * 4);
      ov.getContext('2d')!.putImageData(id, 0, 0);
      g.imageSmoothingEnabled = false;
      g.drawImage(ov, geo.ox, geo.oy, src.im.width * geo.scale, src.im.height * geo.scale);
      g.imageSmoothingEnabled = true;
    }
    const pts = [];
    for (let i = 0; i < this.poly.length; i += 2) pts.push({ x: geo.ox + this.poly[i] * geo.scale, y: geo.oy + this.poly[i + 1] * geo.scale });
    if (pts.length) {
      g.beginPath();
      pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
      g.closePath();
      if (this.overlap > 0) {
        g.lineJoin = 'round';
        g.lineWidth = this.overlap * 2 * geo.scale;
        g.strokeStyle = 'rgba(255,209,102,0.25)';
        g.stroke();
      }
      g.fillStyle = 'rgba(255,209,102,0.18)';
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = '#ffd166';
      g.stroke();
      for (const q of pts) {
        g.fillStyle = '#ffd166';
        g.fillRect(q.x - 3, q.y - 3, 6, 6);
      }
    }
    if (this.pivot) {
      const q = { x: geo.ox + this.pivot.x * geo.scale, y: geo.oy + this.pivot.y * geo.scale };
      g.beginPath();
      g.arc(q.x, q.y, 7, 0, Math.PI * 2);
      g.moveTo(q.x - 11, q.y);
      g.lineTo(q.x + 11, q.y);
      g.moveTo(q.x, q.y - 11);
      g.lineTo(q.x, q.y + 11);
      g.lineWidth = 2;
      g.strokeStyle = '#ff6b9a';
      g.stroke();
    }
  }

  private pixels(im: ImageAsset): Rgba {
    const el = this.app.images.get(im);
    if (!el) throw new Error(`Image “${im.name}” is not decoded.`);
    const c = document.createElement('canvas');
    c.width = im.width;
    c.height = im.height;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(el, 0, 0);
    const d = g.getImageData(0, 0, im.width, im.height);
    return { width: im.width, height: im.height, data: d.data };
  }

  private asset(rgba: Rgba, name: string, derived: ImageAsset['derived']): ImageAsset {
    const c = document.createElement('canvas');
    c.width = rgba.width;
    c.height = rgba.height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba.data), rgba.width, rgba.height), 0, 0);
    return { id: newId('img'), name, mime: 'image/png', width: rgba.width, height: rgba.height, dataUrl: c.toDataURL('image/png'), derived };
  }

  private cutProblem(im: ImageAsset): string | null {
    if (this.mask) return this.mask.count ? null : 'The selection is empty: click a visible pixel, or raise the tolerance.';
    if (this.seeds.length) return 'Reading the image…';
    return polygonProblem(this.poly, im.width, im.height);
  }

  private async exactAsset(rgba: Rgba, name: string, derived: ImageAsset['derived']): Promise<ImageAsset> {
    const bytes = await encodePngExact(rgba);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { id: newId('img'), name, mime: 'image/png', width: rgba.width, height: rgba.height, dataUrl: `data:image/png;base64,${btoa(bin)}`, derived };
  }

  /** Cleaned copy of the source (specks removed); the attachment points at it (one undo step). */
  private async despeckle(): Promise<void> {
    const src = this.source();
    if (!src || this.busy) return;
    const { att, im } = src;
    this.busy = true;
    try {
      const px = await this.loadExact();
      const res = removeSpecks(px!, this.specks);
      const base = im.name.replace(/\.[a-z0-9]+$/i, '');
      const o = this.specks;
      const clean = await this.exactAsset(res.image, `${base}-clean.png`, { kind: 'cleanup', sourceId: im.id, offsetX: 0, offsetY: 0, synthesized: 0, note: `${res.removed} faint speck px removed (alpha < ${o.faintBelow} with no alpha > ${o.solidAbove} within ${o.distance} px)` });
      await this.app.images.decodeAll([clean]);
      this.app.ed.mutate(`Remove specks from ${im.name}`, (p) => {
        p.images.push(clean);
        p.attachments.find((a) => a.id === att.id)!.imageId = clean.id;
      });
      this.seeds = [];
      this.mask = null;
      this.app.status(`Removed ${res.removed} speck px: ${att.name} now uses ${clean.name}. ${im.name} is unchanged.`);
    } catch (e) {
      this.errors = [(e as Error).message];
    } finally {
      this.busy = false;
      this.render();
      void this.loadExact();
    }
  }

  private async apply(): Promise<void> {
    const src = this.source();
    if (!src || this.busy) return;
    const { att, im } = src;
    this.errors = [];
    if (this.mask) return this.applyMask(this.mask);
    const problem = polygonProblem(this.poly, im.width, im.height);
    if (problem) {
      this.errors = [problem];
      return this.render();
    }
    if (this.extend > 0 && !this.pivot) {
      this.errors = ['Joint extension needs a pivot (the joint it extends past).'];
      return this.render();
    }
    if (this.makeBone && !this.pivot) {
      this.errors = ['Set a pivot (Pivot mode, click the joint) or untick “Create a joint bone”.'];
      return this.render();
    }
    this.busy = true;
    try {
      const base = im.name.replace(/\.[a-z0-9]+$/i, '');
      const srcPx = this.pixels(im);
      const res = cutOut(srcPx, this.poly, this.overlap);
      let pieceRgba = res.piece, ox = res.offsetX, oy = res.offsetY, synth = 0;
      if (this.extend > 0 && this.pivot) {
        // Axis: from the pivot toward the outline's area centroid (the piece's direction). The
        // farthest vertex is not used: on a rectangle it is a corner, which skews the sweep.
        const far = polygonCentroid(this.poly);
        const ext = extendPiece(res.piece, res.offsetX, res.offsetY, this.pivot, { x: far.x - this.pivot.x, y: far.y - this.pivot.y }, this.extend, this.replace ? res.remainder : srcPx);
        pieceRgba = ext.piece;
        ox = ext.offsetX;
        oy = ext.offsetY;
        synth = ext.synthesized;
      }
      const piece = this.asset(pieceRgba, `${base}-${this.name}.png`, {
        kind: synth ? 'extension' : 'cutout',
        sourceId: im.id,
        offsetX: ox,
        offsetY: oy,
        polygon: this.poly.slice(),
        synthesized: synth,
        note: `overlap ${this.overlap}px${synth ? `; joint extension ${this.extend}px swept from one cross-section under opaque art, ${synth} px synthesized` : ''}`,
      });
      let remainder: ImageAsset | undefined;
      if (this.replace) {
        if (this.patch) {
          const rgb = parseHexColor(this.patchColor) ?? [128, 128, 128];
          const patched = patchBehind(res.remainder, this.poly, 1, rgb, srcPx);
          remainder = this.asset(patched.image, `${base}-rest.png`, { kind: 'patch', sourceId: im.id, offsetX: 0, offsetY: 0, polygon: this.poly.slice(), synthesized: patched.synthesized, note: `hole behind “${this.name}” filled with flat ${this.patchColor}; ${patched.synthesized} px synthesized` });
        } else {
          remainder = this.asset(res.remainder, `${base}-rest.png`, { kind: 'remainder', sourceId: im.id, offsetX: 0, offsetY: 0, polygon: this.poly.slice(), synthesized: 0 });
        }
      }
      await this.app.images.decodeAll(remainder ? [piece, remainder] : [piece]);
      const ids = { att: newId('att'), bone: newId('bone') };
      let placed = { attId: '', boneId: null as string | null };
      this.app.ed.mutate(`Cut out ${this.name}`, (p) => {
        placed = placeCutout(p, { sourceAttId: att.id, piece, remainder, name: this.name, pivot: this.pivot, createBone: this.makeBone, boneParentId: this.parentId, polygon: this.poly, ids, behind: this.behind });
      });
      this.dlg.close();
      this.app.ed.select(placed.boneId ? { kind: 'bone', id: placed.boneId } : { kind: 'attachment', id: placed.attId });
      this.app.status(`Cut “${this.name}” (${res.piece.width}×${res.piece.height}) from ${im.name}${placed.boneId ? ' with a joint bone' : ''}. The source image is unchanged.`);
    } catch (e) {
      this.errors = [(e as Error).message];
      this.render();
    } finally {
      this.busy = false;
    }
  }

  /** Cut of a colour selection: same options as an outline cut (overlap, remainder, patch, extension, bone). */
  private async applyMask(mask: PixelMask): Promise<void> {
    const src = this.source()!;
    const { att, im } = src;
    if (!mask.count) {
      this.errors = ['The selection is empty.'];
      return this.render();
    }
    if ((this.extend > 0 || this.makeBone) && !this.pivot) {
      this.errors = ['Set a pivot (Pivot mode, click the joint) or untick “Create a joint bone”.'];
      return this.render();
    }
    this.busy = true;
    try {
      const base = im.name.replace(/\.[a-z0-9]+$/i, '');
      const srcPx = (await this.loadExact())!;
      const res = cutOutMask(srcPx, mask, this.overlap);
      let pieceRgba = res.piece, ox = res.offsetX, oy = res.offsetY, synth = 0;
      if (this.extend > 0 && this.pivot) {
        const c = maskCentroid(mask);
        const ext = extendPiece(res.piece, res.offsetX, res.offsetY, this.pivot, { x: c.x - this.pivot.x, y: c.y - this.pivot.y }, this.extend, this.replace ? res.remainder : srcPx);
        pieceRgba = ext.piece;
        ox = ext.offsetX;
        oy = ext.offsetY;
        synth = ext.synthesized;
      }
      const how = `${this.contiguous ? 'flood fill' : 'colour threshold'} from ${this.seeds.map((q) => `${Math.floor(q.x)},${Math.floor(q.y)}`).join(' + ')}, tolerance ${this.tolerance}, alpha > ${this.minAlpha}: ${mask.count} px`;
      const piece = await this.exactAsset(pieceRgba, `${base}-${this.name}.png`, { kind: synth ? 'extension' : 'cutout', sourceId: im.id, offsetX: ox, offsetY: oy, synthesized: synth, note: `${how}; overlap ${this.overlap}px${synth ? `; joint extension ${this.extend}px, ${synth} px synthesized` : ''}` });
      let remainder: ImageAsset | undefined;
      if (this.replace) {
        if (this.patch) {
          const patched = patchBehindMask(res.remainder, mask, parseHexColor(this.patchColor) ?? [128, 128, 128], srcPx);
          remainder = await this.exactAsset(patched.image, `${base}-rest.png`, { kind: 'patch', sourceId: im.id, offsetX: 0, offsetY: 0, synthesized: patched.synthesized, note: `${how}; hole filled with flat ${this.patchColor}; ${patched.synthesized} px synthesized` });
        } else remainder = await this.exactAsset(res.remainder, `${base}-rest.png`, { kind: 'remainder', sourceId: im.id, offsetX: 0, offsetY: 0, synthesized: 0, note: how });
      }
      await this.app.images.decodeAll(remainder ? [piece, remainder] : [piece]);
      const ids = { att: newId('att'), bone: newId('bone') };
      const far = this.pivot ? farthestMaskPixel(mask, this.pivot) : maskCentroid(mask);
      let placed = { attId: '', boneId: null as string | null };
      this.app.ed.mutate(`Cut out ${this.name}`, (p) => {
        placed = placeCutout(p, { sourceAttId: att.id, piece, remainder, name: this.name, pivot: this.pivot, createBone: this.makeBone, boneParentId: this.parentId, polygon: [far.x, far.y], ids, behind: this.behind });
      });
      this.dlg.close();
      this.app.ed.select(placed.boneId ? { kind: 'bone', id: placed.boneId } : { kind: 'attachment', id: placed.attId });
      this.app.status(`Cut “${this.name}” (${res.piece.width}×${res.piece.height}, ${mask.count} selected px) from ${im.name}${placed.boneId ? ' with a joint bone' : ''}. The source image is unchanged.`);
    } catch (e) {
      this.errors = [(e as Error).message];
      this.render();
    } finally {
      this.busy = false;
    }
  }
}
