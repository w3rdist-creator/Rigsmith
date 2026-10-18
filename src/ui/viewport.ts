// Canvas viewport: rendering, hit testing, pan/zoom and the pose/create tools.
import type { Editor } from '../editor/store.ts';
import type { AttachmentFrame, Frame } from '../model/evaluate.ts';
import { attachmentPoints, evaluate } from '../model/evaluate.ts';
import type { Mat, Vec } from '../model/math.ts';
import { angleOf, apply, determinant, invert, wrapDegrees } from '../model/math.ts';
import { applyPoseEdit, makeBone, uniqueName } from '../model/ops.ts';
import { PathTable, pathWorldMatrix } from '../model/constraints.ts';
import { snapToFrame } from '../model/animation.ts';
import { bindAll, deformAt, keyDeform, moveMeshPoint, paintVertex, vertexJacobian, worldDeltaToLocal } from '../model/meshOps.ts';
import { moveBonePivot } from '../model/rigOps.ts';
import { attachmentWorld, boneTip, computeWorld, parentWorld, toLocal, topoOrder } from '../model/skeleton.ts';
import type { Bone, PathShape, Project } from '../model/types.ts';
import { cloneProject, newId } from '../model/types.ts';
import { drawFrame } from '../render/draw.ts';
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
  | { kind: 'pivot'; id: string; grab: Vec; base: Project }
  | { kind: 'path-point'; pathId: string; index: number; part: PathPart }
  /** Setup: moves the point (position + texture coordinate); Animate: keys a deform. */
  | { kind: 'mesh-vertex'; attId: string; index: number; start: Vec; point: Vec; deform: number[]; jac: Mat; animate: boolean }
  | { kind: 'weight-paint'; attId: string }
  | { kind: 'pending-pan'; startX: number; startY: number; viewX: number; viewY: number };

export interface Hit {
  kind: 'bone' | 'attachment' | 'path';
  id: string;
}

type PathPart = 'node' | 'in' | 'out';

/** World positions of a path's nodes and handles. */
export function pathPoints(path: PathShape, m: Mat): { node: Vec; in: Vec; out: Vec }[] {
  return path.nodes.map((n) => ({
    node: apply(m, { x: n.x, y: n.y }),
    in: apply(m, { x: n.x + n.inX, y: n.y + n.inY }),
    out: apply(m, { x: n.x + n.outX, y: n.y + n.outY }),
  }));
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
    for (const f of this.ed.frame().attachments) pts.push(...attachmentPoints(f));
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
      for (const path of p.paths ?? []) {
        const t = new PathTable(path, pathWorldMatrix(path, world));
        for (let s = 0; s <= t.length; s += 4) {
          const q = this.toScreen(t.at(s).point);
          if (Math.hypot(q.x - sx, q.y - sy) <= 6) return { kind: 'path', id: path.id };
        }
      }
    }
    const drawn = this.ed.frame().attachments;
    for (let i = drawn.length - 1; i >= 0; i--) {
      if (drawn[i].visible && this.insideAttachment(drawn[i].att.id, sx, sy, world)) return { kind: 'attachment', id: drawn[i].att.id };
    }
    return null;
  }

  /** Node/handle of the selected path under the cursor. */
  pathPointAt(sx: number, sy: number): { pathId: string; index: number; part: PathPart } | null {
    const sel = this.ed.selection;
    if (sel?.kind !== 'path' || !this.ed.showBones) return null;
    const path = this.ed.project.paths?.find((x) => x.id === sel.id);
    if (!path) return null;
    const pts = pathPoints(path, pathWorldMatrix(path, this.ed.world()));
    let best: { pathId: string; index: number; part: PathPart; d: number } | null = null;
    pts.forEach((pt, index) => {
      for (const part of ['node', 'in', 'out'] as const) {
        if (part !== 'node' && index !== this.ed.pathNode) continue;
        const q = this.toScreen(pt[part]);
        const d = Math.hypot(q.x - sx, q.y - sy);
        if (d <= 8 && (!best || d < best.d)) best = { pathId: path.id, index, part, d };
      }
    });
    return best;
  }

  /** Bone that moves the art of attachment `id` at world point `wp` (null: placed in world). */
  boneForArt(id: string, wp: Vec): string | null {
    const f = this.ed.frame().attachments.find((x) => x.att.id === id);
    if (!f) return null;
    const weights = f.att.mesh?.weights;
    if (weights && f.vertices) {
      let best = -1, bestD = Infinity;
      for (let i = 0; i < weights.length; i++) {
        const d = Math.hypot(f.vertices[2 * i] - wp.x, f.vertices[2 * i + 1] - wp.y);
        if (d < bestD) (bestD = d), (best = i);
      }
      const top = best >= 0 ? weights[best].reduce<{ bone: string; w: number } | null>((m, x) => (!m || x.w > m.w ? x : m), null) : null;
      if (top && this.ed.project.bones.some((b) => b.id === top.bone)) return top.bone;
    }
    return f.att.boneId;
  }

  private insideAttachment(id: string, sx: number, sy: number, _world: Map<string, Mat>): boolean {
    const f = this.ed.frame().attachments.find((x) => x.att.id === id);
    if (!f?.image) return false;
    const w = this.toWorld(sx, sy);
    if (f.vertices && f.att.mesh) return insideMesh(f.vertices, f.att.mesh.triangles, w);
    const q = apply(invert(f.world), w);
    return Math.abs(q.x) <= f.image.width / 2 && Math.abs(q.y) <= f.image.height / 2;
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
    if (this.meshDown(s, wp)) return;

    const pp = this.pathPointAt(s.x, s.y);
    if (pp) {
      ed.pathNode = pp.index;
      ed.beginGesture();
      this.drag = { kind: 'path-point', ...pp };
      ed.emit('selection');
      return;
    }
    const hit = this.hitTest(s.x, s.y);
    if (hit?.kind === 'path') {
      ed.select({ kind: 'path', id: hit.id });
      return;
    }
    let target: { kind: 'bone' | 'attachment'; id: string } | null = hit as { kind: 'bone' | 'attachment'; id: string } | null;
    // Animate mode keys bones, never attachment offsets: clicking art acts on the bone
    // that moves it (for a weighted mesh, the strongest influence of the vertex nearest
    // the click). Attachments stay selectable from the tree for slot keys.
    if (target?.kind === 'attachment' && ed.mode === 'animate') {
      const boneId = this.boneForArt(target.id, wp);
      if (boneId) target = { kind: 'bone', id: boneId };
    }
    if (target) ed.select({ kind: target.kind, id: target.id });
    else if ((ed.tool === 'rotate' || ed.tool === 'scale') && (ed.selection?.kind === 'bone' || ed.selection?.kind === 'attachment')) {
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
      if (tKind === 'bone' && ed.pivotMode && ed.mode === 'setup') this.drag = { kind: 'pivot', id: target.id, grab, base: cloneProject(ed.project) };
      else this.drag = tKind === 'bone' ? { kind: 'move-bone', id: target.id, grab } : { kind: 'move-att', id: target.id, grab };
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
      if (this.ed.meshTool === 'weights') {
        this.brushAt = s;
        this.invalidate();
      }
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
      case 'pivot': {
        const pw = parentWorld(d.base.bones, computeWorld(d.base.bones), d.id);
        const local = toLocal(pw, { x: wp.x + d.grab.x, y: wp.y + d.grab.y });
        // Recompute from the drag's start state so compensation never accumulates error.
        ed.gestureMutate((p) => {
          Object.assign(p, cloneProject(d.base));
          moveBonePivot(p, d.id, round2(local.x), round2(local.y));
        });
        return;
      }
      case 'mesh-vertex': {
        const dl = worldDeltaToLocal(d.jac, wp.x - d.start.x, wp.y - d.start.y);
        if (!dl) return;
        const anim = ed.anim();
        if (!d.animate) {
          ed.gestureMutate((p) => {
            const a = p.attachments.find((x) => x.id === d.attId);
            if (a) moveMeshPoint(p, a, d.index, round2(d.point.x + dl.x), round2(d.point.y + dl.y));
          });
        } else if (anim) {
          const t = snapToFrame(ed.time, anim.fps);
          const off = d.deform.slice();
          off[2 * d.index] = round2(d.deform[2 * d.index] + dl.x);
          off[2 * d.index + 1] = round2(d.deform[2 * d.index + 1] + dl.y);
          ed.gestureMutate((p) => keyDeform(p.animations.find((x) => x.id === anim.id)!, d.attId, t, off));
        }
        return;
      }
      case 'weight-paint':
        this.brushAt = s;
        this.paintAt(wp);
        return;
      case 'path-point': {
        const path = ed.project.paths?.find((x) => x.id === d.pathId);
        const n = path?.nodes[d.index];
        if (!path || !n) return;
        const q = toLocal(pathWorldMatrix(path, ed.world()), wp);
        ed.gestureMutate(() => {
          if (d.part === 'node') {
            n.x = round2(q.x);
            n.y = round2(q.y);
          } else if (d.part === 'in') {
            n.inX = round2(q.x - n.x);
            n.inY = round2(q.y - n.y);
          } else {
            n.outX = round2(q.x - n.x);
            n.outY = round2(q.y - n.y);
          }
        });
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
      case 'pivot':
        ed.endGesture('Move pivot');
        break;
      case 'path-point':
        ed.endGesture(d.part === 'node' ? 'Move path node' : 'Edit path handle');
        break;
      case 'mesh-vertex':
        ed.endGesture(d.animate ? 'Key deform' : 'Move mesh vertex');
        break;
      case 'weight-paint':
        ed.endGesture('Paint weights');
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

  /** Draws the scene. `editorChrome` = grid, onion skins, bones and selection overlays. */
  render(g: CanvasRenderingContext2D, pxW: number, pxH: number, dpr: number, editorChrome: boolean, viewOverride?: View, frameOverride?: Frame): void {
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
      this.drawOnion(g, pxW, pxH, vm);
    }
    const frame = frameOverride ?? ed.frame();
    const world = frame.world;
    drawFrame(g, frame, (im) => this.images.get(im), vm, { missingPlaceholder: editorChrome });
    if (!editorChrome) return;
    if (p.frame) this.drawProjectFrame(g, vm, dpr, p.frame);
    // Attachment selection/hover outlines.
    for (const f of frame.attachments) {
      const a = f.att;
      const isSel = ed.selection?.kind === 'attachment' && ed.selection.id === a.id;
      const isHover = this.hover?.kind === 'attachment' && this.hover.id === a.id;
      if (!isSel && !isHover) continue;
      this.outlineAttachment(g, vm, f, isSel ? '#ffd166' : 'rgba(255,209,102,0.5)');
    }
    this.drawMeshOverlay(g, vm, dpr, frame);
    if (ed.showBones) {
      this.drawPaths(g, p, world, vm, dpr);
      this.drawBones(g, p, world, vm, dpr);
      this.drawIk(g, p, world, vm, dpr);
    }
  }

  /** The fixed delivery frame: dashed outline plus its pixel size (exports clip to it). */
  private drawProjectFrame(g: CanvasRenderingContext2D, vm: Mat, dpr: number, f: { x: number; y: number; width: number; height: number }): void {
    const a = apply(vm, { x: f.x, y: f.y });
    const b = apply(vm, { x: f.x + f.width, y: f.y + f.height });
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.setLineDash([6 * dpr, 4 * dpr]);
    g.lineWidth = 1.5 * dpr;
    g.strokeStyle = 'rgba(122,215,255,0.85)';
    g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    g.setLineDash([]);
    g.font = `${11 * dpr}px system-ui, sans-serif`;
    g.fillStyle = 'rgba(122,215,255,0.95)';
    g.fillText(`frame ${Math.round(f.width)}×${Math.round(f.height)}`, a.x + 4 * dpr, a.y - 5 * dpr);
  }

  private drawPaths(g: CanvasRenderingContext2D, p: Project, world: Map<string, Mat>, vm: Mat, dpr: number): void {
    const sel = this.ed.selection;
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (const path of p.paths ?? []) {
      const m = pathWorldMatrix(path, world);
      const isSel = sel?.kind === 'path' && sel.id === path.id;
      const t = new PathTable(path, m);
      g.beginPath();
      for (const s of t.segs) {
        const [a, b, c, d] = s.map((q) => apply(vm, q));
        if (s === t.segs[0]) g.moveTo(a.x, a.y);
        g.bezierCurveTo(b.x, b.y, c.x, c.y, d.x, d.y);
      }
      g.lineWidth = (isSel ? 2.5 : 1.5) * dpr;
      g.strokeStyle = isSel ? '#c792ff' : 'rgba(199,146,255,0.6)';
      g.stroke();
      if (!isSel) continue;
      pathPoints(path, m).forEach((pt, i) => {
        const n = apply(vm, pt.node);
        if (i === this.ed.pathNode) {
          for (const h of [pt.in, pt.out]) {
            const q = apply(vm, h);
            g.beginPath();
            g.moveTo(n.x, n.y);
            g.lineTo(q.x, q.y);
            g.lineWidth = 1 * dpr;
            g.strokeStyle = 'rgba(255,255,255,0.6)';
            g.stroke();
            g.beginPath();
            g.arc(q.x, q.y, 3.5 * dpr, 0, Math.PI * 2);
            g.fillStyle = '#ffffff';
            g.fill();
          }
        }
        g.beginPath();
        g.rect(n.x - 4.5 * dpr, n.y - 4.5 * dpr, 9 * dpr, 9 * dpr);
        g.fillStyle = i === this.ed.pathNode ? '#ffd166' : '#c792ff';
        g.fill();
        g.strokeStyle = '#111';
        g.stroke();
      });
    }
  }

  private drawIk(g: CanvasRenderingContext2D, p: Project, world: Map<string, Mat>, vm: Mat, dpr: number): void {
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (const ik of p.ik ?? []) {
      const t = world.get(ik.target), r = world.get(ik.bones[0]);
      if (!t || !r) continue;
      const tq = apply(vm, { x: t.tx, y: t.ty });
      const rq = apply(vm, { x: r.tx, y: r.ty });
      g.setLineDash([2 * dpr, 4 * dpr]);
      g.beginPath();
      g.moveTo(rq.x, rq.y);
      g.lineTo(tq.x, tq.y);
      g.lineWidth = 1 * dpr;
      g.strokeStyle = 'rgba(255,107,154,0.7)';
      g.stroke();
      g.setLineDash([]);
      g.beginPath();
      g.arc(tq.x, tq.y, 9 * dpr, 0, Math.PI * 2);
      g.moveTo(tq.x - 13 * dpr, tq.y);
      g.lineTo(tq.x + 13 * dpr, tq.y);
      g.moveTo(tq.x, tq.y - 13 * dpr);
      g.lineTo(tq.x, tq.y + 13 * dpr);
      g.lineWidth = 1.5 * dpr;
      g.strokeStyle = '#ff6b9a';
      g.stroke();
    }
  }

  /** Onion skin: translucent tinted ghosts of neighbouring frames (view state only). */
  private drawOnion(g: CanvasRenderingContext2D, pxW: number, pxH: number, vm: Mat): void {
    const ed = this.ed;
    const o = ed.onion;
    const anim = ed.shownAnim();
    if (!o.enabled || !anim || ed.playing) return;
    const frameNow = Math.round(ed.time * anim.fps);
    const last = Math.round(anim.duration * anim.fps);
    const ghosts: { frame: number; color: string; alpha: number }[] = [];
    for (let i = o.before; i >= 1; i--) ghosts.push({ frame: frameNow - i * o.step, color: '#ff5d73', alpha: 0.45 * (1 - (i - 1) / Math.max(1, o.before)) });
    for (let i = o.after; i >= 1; i--) ghosts.push({ frame: frameNow + i * o.step, color: '#3ddc97', alpha: 0.45 * (1 - (i - 1) / Math.max(1, o.after)) });
    if (!ghosts.length) return;
    const off = this.ghostCanvas(pxW, pxH);
    const og = off.getContext('2d')!;
    for (const gh of ghosts) {
      let f = gh.frame;
      if (anim.loop) f = ((f % last) + last) % last;
      else if (f < 0 || f > last) continue;
      const frame = evaluate(ed.project, anim, Math.min(anim.duration, f / anim.fps), { skinId: ed.skinId });
      og.setTransform(1, 0, 0, 1, 0, 0);
      og.globalCompositeOperation = 'source-over';
      og.clearRect(0, 0, pxW, pxH);
      drawFrame(og, frame, (im) => this.images.get(im), vm);
      og.setTransform(1, 0, 0, 1, 0, 0);
      og.globalCompositeOperation = 'source-atop';
      og.globalAlpha = 0.65;
      og.fillStyle = gh.color;
      og.fillRect(0, 0, pxW, pxH);
      og.globalAlpha = 1;
      og.globalCompositeOperation = 'source-over';
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = gh.alpha;
      g.drawImage(off, 0, 0);
      g.globalAlpha = 1;
    }
  }

  private ghost: HTMLCanvasElement | null = null;
  private ghostCanvas(w: number, h: number): HTMLCanvasElement {
    if (!this.ghost) this.ghost = document.createElement('canvas');
    if (this.ghost.width !== w || this.ghost.height !== h) {
      this.ghost.width = w;
      this.ghost.height = h;
    }
    return this.ghost;
  }

  // ---- Mesh tools ----------------------------------------------------------------------

  /** Last pointer position (canvas px) for the weight-brush outline. */
  private brushAt: Vec | null = null;

  /** The selected mesh attachment while a mesh tool is active. */
  private meshTarget(frame: Frame = this.ed.frame()): AttachmentFrame | null {
    const ed = this.ed;
    const sel = ed.selection;
    if (ed.meshTool === 'off' || sel?.kind !== 'attachment') return null;
    const f = frame.attachments.find((x) => x.att.id === sel.id);
    return f?.vertices && f.att.mesh ? f : null;
  }

  /** Nearest vertex within 8 px of canvas point s (-1 = none). */
  private vertexAt(f: AttachmentFrame, s: Vec): number {
    let best = -1, bd = 8;
    for (let i = 0; i < f.vertices!.length / 2; i++) {
      const q = this.toScreen({ x: f.vertices![2 * i], y: f.vertices![2 * i + 1] });
      const d = Math.hypot(q.x - s.x, q.y - s.y);
      if (d <= bd) (bd = d), (best = i);
    }
    return best;
  }

  private meshDown(s: Vec, wp: Vec): boolean {
    const ed = this.ed;
    const f = this.meshTarget();
    if (!f) return false;
    const att = f.att;
    if (ed.meshTool === 'weights') {
      if (ed.mode !== 'setup' || !att.boneId) return true;
      ed.beginGesture();
      this.drag = { kind: 'weight-paint', attId: att.id };
      this.brushAt = s;
      this.paintAt(wp);
      return true;
    }
    const i = this.vertexAt(f, s);
    if (i < 0) {
      if (ed.meshVertex !== -1) {
        ed.meshVertex = -1;
        ed.emit('selection');
      }
      this.drag = { kind: 'pending-pan', startX: s.x, startY: s.y, viewX: this.view.x, viewY: this.view.y };
      return true;
    }
    ed.meshVertex = i;
    const anim = ed.anim();
    const animate = ed.mode === 'animate' && !!anim;
    const frame = ed.frame();
    // Points and deform offsets enter the skinning formula the same way (p + deform), so
    // one Jacobian at the current pose converts the drag for both modes.
    const jac = vertexJacobian(att, i, frame.world, computeWorld(ed.project.bones));
    const mesh = att.mesh!;
    ed.beginGesture();
    this.drag = {
      kind: 'mesh-vertex',
      attId: att.id,
      index: i,
      start: wp,
      point: { x: mesh.points[2 * i], y: mesh.points[2 * i + 1] },
      deform: animate ? deformAt(anim!, att, snapToFrame(ed.time, anim!.fps)) : [],
      jac,
      animate,
    };
    ed.emit('selection');
    return true;
  }

  /** One brush dab at world point wp (inside a weight-paint gesture). */
  private paintAt(wp: Vec): void {
    const ed = this.ed;
    const f = this.meshTarget();
    if (!f || !f.att.boneId) return;
    const fallback = f.att.boneId;
    const bone = ed.brush.boneId ?? fallback;
    const r = ed.brush.radius / this.view.zoom;
    const v = f.vertices!;
    ed.gestureMutate((p) => {
      const a = p.attachments.find((x) => x.id === f.att.id);
      const m = a?.mesh;
      if (!m) return;
      m.weights ??= bindAll(m, fallback);
      for (let i = 0; i < v.length / 2; i++) {
        const d = Math.hypot(v[2 * i] - wp.x, v[2 * i + 1] - wp.y);
        if (d >= r) continue;
        m.weights[i] = paintVertex(m.weights[i], bone, ed.brush.strength * (1 - d / r), ed.brush.mode, fallback);
      }
    });
  }

  private drawMeshOverlay(g: CanvasRenderingContext2D, vm: Mat, dpr: number, frame: Frame): void {
    const f = this.meshTarget(frame);
    if (!f) return;
    const ed = this.ed;
    const m = f.att.mesh!;
    const v = f.vertices!;
    const P = (i: number) => apply(vm, { x: v[2 * i], y: v[2 * i + 1] });
    g.setTransform(1, 0, 0, 1, 0, 0);
    const painting = ed.meshTool === 'weights';
    const bone = ed.brush.boneId ?? f.att.boneId;
    const wOf = (i: number) => (m.weights ? (m.weights[i].find((x) => x.bone === bone)?.w ?? 0) : bone === f.att.boneId ? 1 : 0);
    const heat = (w: number, a: number) => `rgba(${Math.round(60 + 195 * w)},${Math.round(90 + 40 * (1 - Math.abs(w - 0.5) * 2))},${Math.round(255 - 205 * w)},${a})`;
    for (let t = 0; t < m.triangles.length; t += 3) {
      const [a, b, c] = [m.triangles[t], m.triangles[t + 1], m.triangles[t + 2]];
      const [pa, pb, pc] = [P(a), P(b), P(c)];
      g.beginPath();
      g.moveTo(pa.x, pa.y);
      g.lineTo(pb.x, pb.y);
      g.lineTo(pc.x, pc.y);
      g.closePath();
      if (painting) {
        g.fillStyle = heat((wOf(a) + wOf(b) + wOf(c)) / 3, 0.35);
        g.fill();
      }
      g.lineWidth = dpr;
      g.strokeStyle = 'rgba(120,200,255,0.7)';
      g.stroke();
    }
    for (let i = 0; i < v.length / 2; i++) {
      const q = P(i);
      const sel = i === ed.meshVertex;
      const r = (sel ? 5 : i < m.hull ? 3.5 : 3) * dpr;
      g.beginPath();
      if (i < m.hull) g.rect(q.x - r, q.y - r, r * 2, r * 2);
      else g.arc(q.x, q.y, r, 0, Math.PI * 2);
      g.fillStyle = sel ? '#ffd166' : painting ? heat(wOf(i), 1) : '#78c8ff';
      g.fill();
      g.lineWidth = dpr;
      g.strokeStyle = '#101218';
      g.stroke();
    }
    if (painting && this.brushAt) {
      g.beginPath();
      g.arc(this.brushAt.x * dpr, this.brushAt.y * dpr, ed.brush.radius * dpr, 0, Math.PI * 2);
      g.lineWidth = 1.5 * dpr;
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.stroke();
    }
  }

  private outlineAttachment(g: CanvasRenderingContext2D, vm: Mat, f: AttachmentFrame, color: string): void {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.setLineDash([6, 4]);
    g.lineWidth = 1.5;
    g.strokeStyle = color;
    g.beginPath();
    if (f.vertices && f.att.mesh) {
      const m = f.att.mesh;
      for (let i = 0; i < m.hull; i++) {
        const q = apply(vm, { x: f.vertices[2 * i], y: f.vertices[2 * i + 1] });
        if (i) g.lineTo(q.x, q.y);
        else g.moveTo(q.x, q.y);
      }
    } else {
      const pts = attachmentPoints(f).map((q) => apply(vm, q));
      pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
    }
    g.closePath();
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

function insideMesh(v: readonly number[], tris: readonly number[], p: Vec): boolean {
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]].map((i) => ({ x: v[2 * i], y: v[2 * i + 1] }));
    const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
    const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y);
    const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(neg && pos)) return true;
  }
  return false;
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
