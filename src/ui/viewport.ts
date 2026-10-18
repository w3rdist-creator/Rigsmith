// Canvas viewport: rendering, hit testing, pan/zoom and the pose/create tools.
import type { Editor } from '../editor/store.ts';
import type { Mat, Vec } from '../model/math.ts';
import { angleOf, apply, determinant, invert, multiply, wrapDegrees } from '../model/math.ts';
import { applyPoseEdit, makeBone, uniqueName } from '../model/ops.ts';
import { attachmentWorld, boneTip, parentWorld, toLocal, topoOrder } from '../model/skeleton.ts';
import type { Attachment, Bone, Project } from '../model/types.ts';
import { newId } from '../model/types.ts';
import type { ImageCache } from './images.ts';

export interface View {
  x: number;
  y: number;
  zoom: number;
}

type Drag =
  | { kind: 'pan'; startX: number; startY: number; viewX: number; viewY: number }
  | { kind: 'move-bone'; id: string; grab: Vec }
  | { kind: 'move-att'; id: string; grab: Vec }
  | { kind: 'rotate'; target: 'bone' | 'att'; id: string; origin: Vec; startRot: number; lastAngle: number; accum: number; sign: number }
  | { kind: 'scale'; target: 'bone' | 'att'; id: string; origin: Vec; startDist: number; sx: number; sy: number }
  | { kind: 'create'; id: string; start: Vec }
  | { kind: 'pending-pan'; startX: number; startY: number; viewX: number; viewY: number };

export interface Hit {
  kind: 'bone' | 'attachment';
  id: string;
}

const BONE_HIT_PX = 7;

export class Viewport {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  view: View = { x: 0, y: 0, zoom: 1 };
  private drag: Drag | null = null;
  private needsRender = true;
  private hover: Hit | null = null;
  private cssW = 0;
  private cssH = 0;
  onStatus: (msg: string) => void = () => {};
  private readonly ed: Editor;
  private readonly images: ImageCache;

  constructor(canvas: HTMLCanvasElement, ed: Editor, images: ImageCache) {
    this.ed = ed;
    this.images = images;
    this.canvas = canvas;
    this.g = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.resize();
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', () => this.cancelDrag());
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('dblclick', () => this.frameAll());
    ed.subscribe(() => this.invalidate());
  }

  invalidate(): void {
    this.needsRender = true;
  }

  get isDragging(): boolean {
    return this.drag !== null && this.drag.kind !== 'pending-pan';
  }

  private resize(): void {
    const parent = this.canvas.parentElement!;
    const r = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const firstLayout = this.cssW === 0;
    this.cssW = Math.max(1, Math.floor(r.width));
    this.cssH = Math.max(1, Math.floor(r.height));
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    if (firstLayout) this.view = { x: this.cssW / 2, y: this.cssH * 0.6, zoom: 1 };
    this.invalidate();
  }

  // ---- Coordinates ---------------------------------------------------------------

  viewMatrix(): Mat {
    return { a: this.view.zoom, b: 0, c: 0, d: this.view.zoom, tx: this.view.x, ty: this.view.y };
  }

  toWorld(sx: number, sy: number): Vec {
    return { x: (sx - this.view.x) / this.view.zoom, y: (sy - this.view.y) / this.view.zoom };
  }

  toScreen(p: Vec): Vec {
    return { x: p.x * this.view.zoom + this.view.x, y: p.y * this.view.zoom + this.view.y };
  }

  private local(e: PointerEvent | WheelEvent | MouseEvent): Vec {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const z = Math.min(16, Math.max(0.05, this.view.zoom * factor));
    const w = this.toWorld(sx, sy);
    this.view = { zoom: z, x: sx - w.x * z, y: sy - w.y * z };
    this.invalidate();
    this.ed.emit('view');
  }

  /** Fits all attachments and bones into view. */
  frameAll(): void {
    const world = this.ed.world();
    const pts: Vec[] = [];
    for (const b of this.ed.project.bones) {
      const m = world.get(b.id);
      if (!m) continue;
      pts.push({ x: m.tx, y: m.ty }, boneTip(b, m));
    }
    for (const a of this.ed.project.attachments) {
      const im = this.ed.project.images.find((i) => i.id === a.imageId);
      if (!im) continue;
      const m = attachmentWorld(a, world);
      for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pts.push(apply(m, { x: (x * im.width) / 2, y: (y * im.height) / 2 }));
    }
    if (!pts.length) {
      this.view = { x: this.cssW / 2, y: this.cssH / 2, zoom: 1 };
    } else {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const w = Math.max(40, maxX - minX), h = Math.max(40, maxY - minY);
      const zoom = Math.min(8, Math.max(0.1, Math.min((this.cssW * 0.7) / w, (this.cssH * 0.7) / h)));
      this.view = { zoom, x: this.cssW / 2 - ((minX + maxX) / 2) * zoom, y: this.cssH / 2 - ((minY + maxY) / 2) * zoom };
    }
    this.invalidate();
    this.ed.emit('view');
  }

  // ---- Hit testing ---------------------------------------------------------------

  hitTest(sx: number, sy: number): Hit | null {
    const p = this.ed.project;
    const world = this.ed.world();
    // A selected image stays grabbable even where a bone overlaps it.
    const sel = this.ed.selection;
    if (sel?.kind === 'attachment' && this.insideAttachment(sel.id, sx, sy, world)) return { kind: 'attachment', id: sel.id };
    if (this.ed.showBones) {
      let best: { id: string; d: number } | null = null;
      for (const b of topoOrder(p.bones)) {
        const m = world.get(b.id);
        if (!m) continue;
        const o = this.toScreen({ x: m.tx, y: m.ty });
        const t = this.toScreen(boneTip(b, m));
        const d = Math.min(distToSegment({ x: sx, y: sy }, o, t), Math.hypot(sx - o.x, sy - o.y) - 2);
        if (d <= BONE_HIT_PX && (!best || d <= best.d)) best = { id: b.id, d };
      }
      if (best) return { kind: 'bone', id: best.id };
    }
    for (let i = p.attachments.length - 1; i >= 0; i--) {
      if (this.insideAttachment(p.attachments[i].id, sx, sy, world)) return { kind: 'attachment', id: p.attachments[i].id };
    }
    return null;
  }

  private insideAttachment(id: string, sx: number, sy: number, world: Map<string, Mat>): boolean {
    const p = this.ed.project;
    const a = p.attachments.find((x) => x.id === id);
    const im = a && p.images.find((x) => x.id === a.imageId);
    if (!a || !im) return false;
    const q = apply(invert(multiply(this.viewMatrix(), attachmentWorld(a, world))), { x: sx, y: sy });
    return Math.abs(q.x) <= im.width / 2 && Math.abs(q.y) <= im.height / 2;
  }

  // ---- Pointer handling ------------------------------------------------------------

  private onDown(e: PointerEvent): void {
    this.canvas.focus();
    const s = this.local(e);
    const wantsPan = e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey);
    if (wantsPan) {
      this.drag = { kind: 'pan', startX: s.x, startY: s.y, viewX: this.view.x, viewY: this.view.y };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const ed = this.ed;
    if (ed.playing) ed.stop();
    const wp = this.toWorld(s.x, s.y);

    if (ed.tool === 'create') {
      this.startCreate(wp);
      return;
    }

    const hit = this.hitTest(s.x, s.y);
    let target: Hit | null = hit;
    if (hit) ed.select({ kind: hit.kind, id: hit.id });
    else if ((ed.tool === 'rotate' || ed.tool === 'scale') && ed.selection) {
      // Rotate/scale tools act on the current selection when dragging empty canvas.
      target = { kind: ed.selection.kind, id: ed.selection.id };
    } else {
      ed.select(null);
      this.drag = { kind: 'pending-pan', startX: s.x, startY: s.y, viewX: this.view.x, viewY: this.view.y };
      return;
    }
    if (!target) return;
    const world = ed.world();

    if (target.kind === 'attachment' && ed.mode === 'animate') {
      this.onStatus('Attachment offsets are part of the setup pose — switch to Setup (Tab) to move images.');
      return;
    }

    const originOf = (): { origin: Vec; m: Mat; rot: number; sx: number; sy: number; parentDet: number } | null => {
      if (target!.kind === 'bone') {
        const m = world.get(target!.id);
        const pose = ed.pose().get(target!.id);
        if (!m || !pose) return null;
        const pw = parentWorld(ed.project.bones, world, target!.id);
        return { origin: { x: m.tx, y: m.ty }, m, rot: pose.rotation, sx: pose.scaleX, sy: pose.scaleY, parentDet: determinant(pw) };
      }
      const a = ed.project.attachments.find((x) => x.id === target!.id);
      if (!a) return null;
      const m = attachmentWorld(a, world);
      const base = (a.boneId && world.get(a.boneId)) || { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
      return { origin: { x: m.tx, y: m.ty }, m, rot: a.rotation, sx: a.scaleX, sy: a.scaleY, parentDet: determinant(base) };
    };
    const info = originOf();
    if (!info) return;
    const tKind = target.kind === 'bone' ? 'bone' : 'att';
    ed.beginGesture();
    if (ed.tool === 'move') {
      const grab = { x: info.origin.x - wp.x, y: info.origin.y - wp.y };
      this.drag = tKind === 'bone' ? { kind: 'move-bone', id: target.id, grab } : { kind: 'move-att', id: target.id, grab };
    } else if (ed.tool === 'rotate') {
      const ang = Math.atan2(wp.y - info.origin.y, wp.x - info.origin.x) * (180 / Math.PI);
      this.drag = { kind: 'rotate', target: tKind, id: target.id, origin: info.origin, startRot: info.rot, lastAngle: ang, accum: 0, sign: info.parentDet < 0 ? -1 : 1 };
    } else if (ed.tool === 'scale') {
      const d = Math.max(1e-3, Math.hypot(wp.x - info.origin.x, wp.y - info.origin.y));
      this.drag = { kind: 'scale', target: tKind, id: target.id, origin: info.origin, startDist: d, sx: info.sx, sy: info.sy };
    }
  }

  private startCreate(wp: Vec): void {
    const ed = this.ed;
    const parentId = ed.selectedBoneId();
    const world = ed.world();
    const pw = (parentId && world.get(parentId)) || { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    const local = toLocal(pw, wp);
    const id = newId('bone');
    ed.beginGesture();
    ed.gestureMutate((p) => {
      const name = uniqueName(p.bones.map((b) => b.name), 'bone');
      p.bones.push(makeBone(id, name, parentId, local.x, local.y, 0, 0));
    });
    ed.select({ kind: 'bone', id });
    this.drag = { kind: 'create', id, start: wp };
  }

  private onMove(e: PointerEvent): void {
    const s = this.local(e);
    const d = this.drag;
    if (!d) {
      const h = this.hitTest(s.x, s.y);
      if (h?.id !== this.hover?.id) {
        this.hover = h;
        this.invalidate();
      }
      this.canvas.style.cursor = this.ed.tool === 'create' ? 'crosshair' : h ? 'pointer' : 'default';
      return;
    }
    const ed = this.ed;
    const wp = this.toWorld(s.x, s.y);
    switch (d.kind) {
      case 'pending-pan':
      case 'pan': {
        if (d.kind === 'pending-pan') {
          if (Math.hypot(s.x - d.startX, s.y - d.startY) < 3) return;
          this.drag = { ...d, kind: 'pan' };
        }
        this.view = { ...this.view, x: d.viewX + (s.x - d.startX), y: d.viewY + (s.y - d.startY) };
        this.canvas.style.cursor = 'grabbing';
        this.invalidate();
        return;
      }
      case 'move-bone': {
        const world = ed.world();
        const pw = parentWorld(ed.project.bones, world, d.id);
        const target = { x: wp.x + d.grab.x, y: wp.y + d.grab.y };
        const local = toLocal(pw, target);
        ed.gestureMutate((p) => applyPoseEdit(p, ed.mode, ed.animId, ed.time, d.id, { x: round2(local.x), y: round2(local.y) }));
        return;
      }
      case 'move-att': {
        const a = ed.project.attachments.find((x) => x.id === d.id);
        if (!a) return;
        const world = ed.world();
        const base = (a.boneId && world.get(a.boneId)) || { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
        const local = toLocal(base, { x: wp.x + d.grab.x, y: wp.y + d.grab.y });
        ed.gestureMutate(() => {
          a.x = round2(local.x);
          a.y = round2(local.y);
        });
        return;
      }
      case 'rotate': {
        const ang = Math.atan2(wp.y - d.origin.y, wp.x - d.origin.x) * (180 / Math.PI);
        d.accum += wrapDegrees(ang - d.lastAngle);
        d.lastAngle = ang;
        let rot = d.startRot + d.sign * d.accum;
        if (e.shiftKey) rot = Math.round(rot / 15) * 15;
        rot = round2(rot);
        if (d.target === 'bone') ed.gestureMutate((p) => applyPoseEdit(p, ed.mode, ed.animId, ed.time, d.id, { rotation: rot }));
        else
          ed.gestureMutate((p) => {
            const a = p.attachments.find((x) => x.id === d.id);
            if (a) a.rotation = rot;
          });
        return;
      }
      case 'scale': {
        const f = Math.hypot(wp.x - d.origin.x, wp.y - d.origin.y) / d.startDist;
        const sx = round2(d.sx * f);
        const sy = e.shiftKey ? d.sy : round2(d.sy * f);
        if (d.target === 'bone') ed.gestureMutate((p) => applyPoseEdit(p, ed.mode, ed.animId, ed.time, d.id, { scaleX: sx, scaleY: sy }));
        else
          ed.gestureMutate((p) => {
            const a = p.attachments.find((x) => x.id === d.id);
            if (a) {
              a.scaleX = sx;
              a.scaleY = sy;
            }
          });
        return;
      }
      case 'create': {
        const bone = ed.project.bones.find((b) => b.id === d.id);
        if (!bone) return;
        const world = ed.world();
        const pw = parentWorld(ed.project.bones, world, d.id);
        const len = Math.hypot(wp.x - d.start.x, wp.y - d.start.y);
        const worldAng = Math.atan2(wp.y - d.start.y, wp.x - d.start.x) * (180 / Math.PI);
        let rot = worldAng - angleOf(pw);
        if (e.shiftKey) rot = Math.round(rot / 15) * 15;
        ed.gestureMutate(() => {
          bone.length = round2(len / Math.max(1e-6, Math.hypot(pw.a, pw.b)));
          bone.rotation = round2(wrapDegrees(rot));
        });
        return;
      }
    }
  }

  private onUp(e: PointerEvent): void {
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const d = this.drag;
    this.drag = null;
    this.canvas.style.cursor = 'default';
    if (!d) return;
    const ed = this.ed;
    switch (d.kind) {
      case 'move-bone':
        ed.endGesture(ed.mode === 'animate' ? 'Key bone position' : 'Move bone');
        break;
      case 'move-att':
        ed.endGesture('Move attachment');
        break;
      case 'rotate':
        ed.endGesture(d.target === 'bone' ? (ed.mode === 'animate' ? 'Key bone rotation' : 'Rotate bone') : 'Rotate attachment');
        break;
      case 'scale':
        ed.endGesture(d.target === 'bone' ? (ed.mode === 'animate' ? 'Key bone scale' : 'Scale bone') : 'Scale attachment');
        break;
      case 'create': {
        const bone = ed.project.bones.find((b) => b.id === d.id);
        if (bone && bone.length < 4) {
          // A click without a drag still creates a usable bone.
          ed.gestureMutate(() => {
            bone.length = 40;
          });
        }
        ed.endGesture('Create bone');
        this.onStatus('Bone created. Drag again to add a child of the selected bone.');
        break;
      }
      default:
        ed.emit('view');
    }
    this.invalidate();
  }

  cancelDrag(): void {
    if (!this.drag) return;
    const k = this.drag.kind;
    this.drag = null;
    if (k !== 'pan' && k !== 'pending-pan') this.ed.cancelGesture();
    this.invalidate();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const s = this.local(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.zoomAt(s.x, s.y, Math.exp(-delta * 0.0015));
  }

  // ---- Rendering ---------------------------------------------------------------------

  renderIfNeeded(): void {
    if (!this.needsRender) return;
    this.needsRender = false;
    this.render(this.g, this.canvas.width, this.canvas.height, window.devicePixelRatio || 1, true);
  }

  /** Draws the scene. `editorChrome` = grid, bones and selection overlays. */
  render(g: CanvasRenderingContext2D, pxW: number, pxH: number, dpr: number, editorChrome: boolean, viewOverride?: View): void {
    const ed = this.ed;
    const p = ed.project;
    const view = viewOverride ?? this.view;
    const vm: Mat = { a: view.zoom * dpr, b: 0, c: 0, d: view.zoom * dpr, tx: view.x * dpr, ty: view.y * dpr };
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, pxW, pxH);
    if (editorChrome) {
      g.fillStyle = ed.mode === 'animate' ? '#1c1a22' : '#17191f';
      g.fillRect(0, 0, pxW, pxH);
      this.drawGrid(g, pxW, pxH, dpr, view);
    }
    const world = ed.world();
    // Attachments in draw order.
    for (const a of p.attachments) {
      const im = p.images.find((x) => x.id === a.imageId);
      if (!im) continue;
      const m = multiply(vm, attachmentWorld(a, world));
      g.setTransform(m.a, m.b, m.c, m.d, m.tx, m.ty);
      g.globalAlpha = a.opacity;
      const el = this.images.get(im);
      if (el) g.drawImage(el, -im.width / 2, -im.height / 2, im.width, im.height);
      else {
        g.fillStyle = 'rgba(255,80,80,0.4)';
        g.fillRect(-im.width / 2, -im.height / 2, im.width, im.height);
      }
      g.globalAlpha = 1;
    }
    if (!editorChrome) return;
    // Attachment selection/hover outlines.
    for (const a of p.attachments) {
      const isSel = ed.selection?.kind === 'attachment' && ed.selection.id === a.id;
      const isHover = this.hover?.kind === 'attachment' && this.hover.id === a.id;
      if (!isSel && !isHover) continue;
      const im = p.images.find((x) => x.id === a.imageId);
      if (!im) continue;
      this.outlineAttachment(g, vm, world, a, im.width, im.height, isSel ? '#ffd166' : 'rgba(255,209,102,0.5)');
    }
    if (ed.showBones) this.drawBones(g, p, world, vm, dpr);
  }

  private outlineAttachment(g: CanvasRenderingContext2D, vm: Mat, world: Map<string, Mat>, a: Attachment, w: number, h: number, color: string): void {
    const m = multiply(vm, attachmentWorld(a, world));
    const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => apply(m, { x, y }));
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.beginPath();
    pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
    g.closePath();
    g.setLineDash([6, 4]);
    g.lineWidth = 1.5;
    g.strokeStyle = color;
    g.stroke();
    g.setLineDash([]);
  }

  private drawGrid(g: CanvasRenderingContext2D, pxW: number, pxH: number, dpr: number, view: View): void {
    let step = 50;
    while (step * view.zoom < 24) step *= 2;
    while (step * view.zoom > 160) step /= 2;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.beginPath();
    const x0 = Math.floor(-view.x / view.zoom / step) * step;
    const y0 = Math.floor(-view.y / view.zoom / step) * step;
    for (let x = x0; x * view.zoom + view.x < pxW / dpr; x += step) {
      const sx = Math.round((x * view.zoom + view.x) * dpr) + 0.5;
      g.moveTo(sx, 0);
      g.lineTo(sx, pxH);
    }
    for (let y = y0; y * view.zoom + view.y < pxH / dpr; y += step) {
      const sy = Math.round((y * view.zoom + view.y) * dpr) + 0.5;
      g.moveTo(0, sy);
      g.lineTo(pxW, sy);
    }
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.14)';
    g.beginPath();
    g.moveTo(Math.round(view.x * dpr) + 0.5, 0);
    g.lineTo(Math.round(view.x * dpr) + 0.5, pxH);
    g.moveTo(0, Math.round(view.y * dpr) + 0.5);
    g.lineTo(pxW, Math.round(view.y * dpr) + 0.5);
    g.stroke();
  }

  private drawBones(g: CanvasRenderingContext2D, p: Project, world: Map<string, Mat>, vm: Mat, dpr: number): void {
    const ed = this.ed;
    g.setTransform(1, 0, 0, 1, 0, 0);
    const selId = ed.selection?.kind === 'bone' ? ed.selection.id : null;
    const ordered = topoOrder(p.bones);
    // Parent→child connectors.
    g.setLineDash([3 * dpr, 3 * dpr]);
    g.lineWidth = 1 * dpr;
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    for (const b of ordered) {
      if (!b.parentId) continue;
      const pm = world.get(b.parentId);
      const m = world.get(b.id);
      const parent = p.bones.find((x) => x.id === b.parentId);
      if (!pm || !m || !parent) continue;
      const from = apply(vm, boneTip(parent, pm));
      const to = apply(vm, { x: m.tx, y: m.ty });
      if (Math.hypot(from.x - to.x, from.y - to.y) < 2 * dpr) continue;
      g.beginPath();
      g.moveTo(from.x, from.y);
      g.lineTo(to.x, to.y);
      g.stroke();
    }
    g.setLineDash([]);
    for (const b of ordered) {
      const m = world.get(b.id);
      if (!m) continue;
      this.drawBone(g, b, m, vm, dpr, b.id === selId, this.hover?.kind === 'bone' && this.hover.id === b.id);
    }
  }

  private drawBone(g: CanvasRenderingContext2D, b: Bone, m: Mat, vm: Mat, dpr: number, selected: boolean, hover: boolean): void {
    const o = apply(vm, { x: m.tx, y: m.ty });
    const t = apply(vm, boneTip(b, m));
    const len = Math.hypot(t.x - o.x, t.y - o.y);
    const ang = Math.atan2(t.y - o.y, t.x - o.x);
    const w = Math.min(9 * dpr, Math.max(3 * dpr, len * 0.14));
    g.save();
    g.translate(o.x, o.y);
    g.rotate(ang);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(Math.min(len * 0.2, 14 * dpr), -w);
    g.lineTo(len, 0);
    g.lineTo(Math.min(len * 0.2, 14 * dpr), w);
    g.closePath();
    g.fillStyle = selected ? 'rgba(255,209,102,0.85)' : hexAlpha(b.color, hover ? 0.75 : 0.5);
    g.fill();
    g.lineWidth = (selected ? 2 : 1) * dpr;
    g.strokeStyle = selected ? '#fff6d6' : 'rgba(10,10,14,0.8)';
    g.stroke();
    g.restore();
    g.beginPath();
    g.arc(o.x, o.y, (selected ? 5 : 4) * dpr, 0, Math.PI * 2);
    g.fillStyle = selected ? '#ffd166' : '#e8e8ef';
    g.fill();
    g.lineWidth = 1.5 * dpr;
    g.strokeStyle = '#111';
    g.stroke();
  }
}

function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function hexAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(143,211,200,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
