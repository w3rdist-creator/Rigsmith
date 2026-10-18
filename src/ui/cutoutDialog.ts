// "Cut out piece…" dialog: draw a polygon (or drag a rectangle) over an attachment's
// image, set a pivot, overlap and options, then create the piece as a new derived image
// + attachment exactly where it was (optionally with a joint bone at the pivot and the
// source replaced by its remainder, optionally patched with a flat colour). The source
// image is never modified and stays in the project.
import type { Rgba } from '../model/cutout.ts';
import { cutOut, parseHexColor, patchBehind, polygonBounds, polygonProblem } from '../model/cutout.ts';
import { placeCutout } from '../model/rigOps.ts';
import type { ImageAsset } from '../model/types.ts';
import { newId } from '../model/types.ts';
import type { App } from './app.ts';
import { append, clear, h } from './dom.ts';

type Mode = 'polygon' | 'rect' | 'pivot';
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
  private errors: string[] = [];
  private busy = false;
  private canvas: HTMLCanvasElement | null = null;
  private rectStart: { x: number; y: number } | null = null;

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'export-body' });
    this.dlg = h('dialog', { class: 'help export cutout', 'data-testid': 'cutout-dialog', 'aria-label': 'Cut out piece' }, h('h2', {}, 'Cut out piece'), this.body) as HTMLDialogElement;
    document.body.append(this.dlg);
  }

  get isOpen(): boolean {
    return this.dlg.open;
  }

  open(attId: string): void {
    const p = this.app.ed.project;
    const att = p.attachments.find((a) => a.id === attId);
    if (!att) return;
    this.attId = attId;
    this.poly = [];
    this.pivot = null;
    this.mode = 'polygon';
    this.errors = [];
    this.name = `${att.name}-piece`;
    this.parentId = att.boneId;
    this.render();
    this.dlg.showModal();
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
    const num = (testId: string, label: string, value: number, set: (v: number) => void) => {
      const input = h('input', { type: 'number', min: 0, max: 64, step: 1, value: String(value), 'data-testid': testId, 'aria-label': label, class: 'w-num' });
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
    const problem = polygonProblem(this.poly, im.width, im.height);
    const b = this.poly.length >= 2 ? polygonBounds(this.poly) : null;
    const summary = `${this.poly.length / 2} point(s)${b ? ` · outline ${Math.round(b.width)}×${Math.round(b.height)} px at ${Math.round(b.x)},${Math.round(b.y)}` : ''} · overlap ${this.overlap} px · pivot ${this.pivot ? `${Math.round(this.pivot.x)},${Math.round(this.pivot.y)}` : 'not set'}`;
    append(this.body,
      h('p', { class: 'dim' }, `Source: ${im.name} (${im.width}×${im.height}) — never modified. The piece keeps its exact position.`),
      h('div', { class: 'row-key' },
        modeBtn('polygon', 'Polygon', 'Click to add outline points'),
        modeBtn('rect', 'Rectangle', 'Drag a crop rectangle'),
        modeBtn('pivot', 'Pivot', 'Click the joint (rotation point) of the piece'),
        h('button', { class: 'mini', 'data-testid': 'cut-undo-point', disabled: !this.poly.length, onclick: () => (this.poly.splice(-2), this.render()) }, 'Undo point'),
        h('button', { class: 'mini', 'data-testid': 'cut-clear', onclick: () => ((this.poly = []), (this.pivot = null), this.render()) }, 'Clear'),
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
      check('cut-bone', 'Create a joint bone at the pivot', this.makeBone, (v) => (this.makeBone = v)),
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

  private async apply(): Promise<void> {
    const src = this.source();
    if (!src || this.busy) return;
    const { att, im } = src;
    this.errors = [];
    const problem = polygonProblem(this.poly, im.width, im.height);
    if (problem) {
      this.errors = [problem];
      return this.render();
    }
    if (this.makeBone && !this.pivot) {
      this.errors = ['Set a pivot (Pivot mode, click the joint) or untick “Create a joint bone”.'];
      return this.render();
    }
    this.busy = true;
    try {
      const base = im.name.replace(/\.[a-z0-9]+$/i, '');
      const res = cutOut(this.pixels(im), this.poly, this.overlap);
      const piece = this.asset(res.piece, `${base}-${this.name}.png`, { kind: 'cutout', sourceId: im.id, offsetX: res.offsetX, offsetY: res.offsetY, polygon: this.poly.slice(), synthesized: 0, note: `overlap ${this.overlap}px` });
      let remainder: ImageAsset | undefined;
      if (this.replace) {
        if (this.patch) {
          const rgb = parseHexColor(this.patchColor) ?? [128, 128, 128];
          const patched = patchBehind(res.remainder, this.poly, 1, rgb);
          remainder = this.asset(patched.image, `${base}-rest.png`, { kind: 'patch', sourceId: im.id, offsetX: 0, offsetY: 0, polygon: this.poly.slice(), synthesized: patched.synthesized, note: `hole behind “${this.name}” filled with flat ${this.patchColor}; ${patched.synthesized} px synthesized` });
        } else {
          remainder = this.asset(res.remainder, `${base}-rest.png`, { kind: 'remainder', sourceId: im.id, offsetX: 0, offsetY: 0, polygon: this.poly.slice(), synthesized: 0 });
        }
      }
      await this.app.images.decodeAll(remainder ? [piece, remainder] : [piece]);
      const ids = { att: newId('att'), bone: newId('bone') };
      let placed = { attId: '', boneId: null as string | null };
      this.app.ed.mutate(`Cut out ${this.name}`, (p) => {
        placed = placeCutout(p, { sourceAttId: att.id, piece, remainder, name: this.name, pivot: this.pivot, createBone: this.makeBone, boneParentId: this.parentId, polygon: this.poly, ids });
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
}
