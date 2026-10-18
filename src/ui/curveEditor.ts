// Curve editor: shows the easing of the segment leaving the primary selected key, with
// two draggable Bezier handles, numeric handle fields and presets. Edits apply to every
// selected key that has an interpolation. A handle drag is one undo step; Esc cancels.
import { CURVE_PRESETS, clampCurve, curveFor, evalCurve } from '../model/curve.ts';
import { laneKeys, parseLane, sameRef } from '../model/keys.ts';
import type { Curve, Key } from '../model/types.ts';
import type { App } from './app.ts';
import { h, numberField } from './dom.ts';
import type { Timeline } from './timeline.ts';

const W = 210;
const H = 104;
const PAD_X = 18;
const Y_MIN = -0.6;
const Y_MAX = 1.6;

export class CurveEditor {
  private app: App;
  private timeline: Timeline;
  private canvas: HTMLCanvasElement | null = null;
  private drag: { handle: 1 | 2; pointerId: number; moved: boolean } | null = null;

  constructor(app: App, timeline: Timeline) {
    this.app = app;
    this.timeline = timeline;
    app.ed.cancelHooks.add(() => this.cancelDrag());
  }

  /** The primary key if it is curve-capable, plus its segment's end time. */
  private target(): { key: Key; next: { time: number } | undefined; label: string } | null {
    const ed = this.app.ed;
    const anim = ed.anim();
    const ref = ed.keySel;
    if (!anim || !ref) return null;
    const keys = laneKeys(anim, ref.lane);
    const i = keys?.findIndex((k) => sameRef({ lane: ref.lane, time: k.time }, ref)) ?? -1;
    if (!keys || i < 0 || !('interp' in keys[i])) return null;
    const info = parseLane(ref.lane);
    const owner = info && info.kind === 'bone' ? ed.project.bones.find((b) => b.id === info.id)?.name : info && info.kind === 'slot' ? ed.project.attachments.find((a) => a.id === info.id)?.name : info && info.kind === 'constraint' ? info.id : 'key';
    const ch = info && info.kind !== 'draw' ? info.channel : '';
    return { key: keys[i] as Key, next: keys[i + 1], label: `${owner ?? ''} ${ch}` };
  }

  private toPx(x: number, y: number): { x: number; y: number } {
    return { x: PAD_X + x * (W - 2 * PAD_X), y: H - ((y - Y_MIN) / (Y_MAX - Y_MIN)) * H };
  }

  private fromPx(px: number, py: number): { x: number; y: number } {
    return { x: (px - PAD_X) / (W - 2 * PAD_X), y: Y_MIN + ((H - py) / H) * (Y_MAX - Y_MIN) };
  }

  render(): HTMLElement {
    const ed = this.app.ed;
    const t = this.target();
    const anim = ed.anim();
    const root = h('div', { class: 'curve-panel', 'data-testid': 'curve-panel' });
    if (!t || !anim) {
      this.canvas = null;
      root.append(h('div', { class: 'panel-head' }, h('h2', {}, 'Curve')), h('p', { class: 'hint' }, 'Select a key to edit the easing of the segment that leaves it. Drag the handles above/below the lines to overshoot or anticipate.'));
      return root;
    }
    const curve = curveFor(t.key.interp, t.key.curve);
    const f0 = Math.round(t.key.time * anim.fps);
    const f1 = t.next ? Math.round(t.next.time * anim.fps) : null;
    const preset = h('select', { 'data-testid': 'curve-preset', 'aria-label': 'Curve preset' },
      h('option', { value: '' }, 'Preset…'),
      ...Object.keys(CURVE_PRESETS).map((n) => h('option', { value: n }, n)),
      h('option', { value: 'step' }, 'step (hold)'),
    );
    preset.addEventListener('change', () => preset.value && this.app.applyCurvePreset(preset.value));
    const canvas = h('canvas', { class: 'curve-canvas', 'data-testid': 'curve-editor', width: W * 2, height: H * 2, style: `width:${W}px;height:${H}px`, 'aria-label': 'Easing curve. Drag the round handles.' });
    this.canvas = canvas;
    this.attach(canvas);
    const c = curve ?? CURVE_PRESETS.linear;
    const field = (i: 0 | 1 | 2 | 3, label: string) =>
      numberField({ label, value: c[i], step: 0.05, min: i % 2 === 0 ? 0 : undefined, max: i % 2 === 0 ? 1 : undefined, testId: `curve-${['x1', 'y1', 'x2', 'y2'][i]}`, onCommit: (v) => {
        const next = c.slice() as Curve;
        next[i] = v;
        this.app.setCurveForSelection(clampCurve(next), 'Edit curve');
      } });
    root.append(
      h('div', { class: 'panel-head' }, h('h2', {}, 'Curve'), h('span', { class: 'dim', 'data-testid': 'curve-segment' }, `${t.label} · f${f0}${f1 !== null ? `→f${f1}` : ' (last key)'}`)),
      canvas,
      h('div', { class: 'curve-fields' }, preset, h('span', { class: 'dim' }, t.key.interp)),
      h('div', { class: 'curve-fields' }, field(0, 'x1'), field(1, 'y1'), field(2, 'x2'), field(3, 'y2')),
    );
    this.draw();
    return root;
  }

  private draw(): void {
    const canvas = this.canvas;
    const t = this.target();
    if (!canvas || !t) return;
    const g = canvas.getContext('2d')!;
    g.setTransform(2, 0, 0, 2, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#13151b';
    g.fillRect(0, 0, W, H);
    // Key value levels (0 = this key, 1 = next key): anything beyond them over/undershoots.
    for (const y of [0, 1]) {
      const a = this.toPx(0, y), b = this.toPx(1, y);
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(0, a.y);
      g.lineTo(W, b.y);
      g.stroke();
    }
    g.setLineDash([]);
    const curve = curveFor(t.key.interp, t.key.curve);
    g.strokeStyle = '#ffd166';
    g.lineWidth = 2;
    g.beginPath();
    if (!curve) {
      const a = this.toPx(0, 0), b = this.toPx(1, 0), c = this.toPx(1, 1);
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.lineTo(c.x, c.y);
    } else {
      for (let i = 0; i <= 64; i++) {
        const x = i / 64;
        const p = this.toPx(x, evalCurve(curve, x));
        if (i === 0) g.moveTo(p.x, p.y);
        else g.lineTo(p.x, p.y);
      }
    }
    g.stroke();
    const c = curve ?? CURVE_PRESETS.linear;
    const p0 = this.toPx(0, 0), p3 = this.toPx(1, 1), h1 = this.toPx(c[0], c[1]), h2 = this.toPx(c[2], c[3]);
    g.strokeStyle = 'rgba(76,201,240,0.8)';
    g.lineWidth = 1;
    for (const [from, to] of [[p0, h1], [p3, h2]]) {
      g.beginPath();
      g.moveTo(from.x, from.y);
      g.lineTo(to.x, to.y);
      g.stroke();
    }
    for (const q of [h1, h2]) {
      g.beginPath();
      g.arc(q.x, q.y, 5, 0, Math.PI * 2);
      g.fillStyle = '#4cc9f0';
      g.fill();
      g.strokeStyle = '#0b0c10';
      g.stroke();
    }
    // Handle positions for automation and assistive tech (CSS px from the canvas corner).
    canvas.dataset.h1 = `${h1.x.toFixed(1)},${h1.y.toFixed(1)}`;
    canvas.dataset.h2 = `${h2.x.toFixed(1)},${h2.y.toFixed(1)}`;
  }

  private attach(canvas: HTMLCanvasElement): void {
    const ed = this.app.ed;
    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    canvas.addEventListener('pointerdown', (e) => {
      const t = this.target();
      if (!t || e.button !== 0) return;
      const c = curveFor(t.key.interp, t.key.curve) ?? CURVE_PRESETS.linear;
      const s = local(e);
      const d1 = Math.hypot(s.x - this.toPx(c[0], c[1]).x, s.y - this.toPx(c[0], c[1]).y);
      const d2 = Math.hypot(s.x - this.toPx(c[2], c[3]).x, s.y - this.toPx(c[2], c[3]).y);
      if (Math.min(d1, d2) > 12) return;
      e.preventDefault();
      this.timeline.interacting = true;
      canvas.setPointerCapture(e.pointerId);
      ed.beginGesture();
      this.drag = { handle: d1 <= d2 ? 1 : 2, pointerId: e.pointerId, moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
      const d = this.drag;
      const t = this.target();
      if (!d || !t) return;
      const s = local(e);
      let { x, y } = this.fromPx(s.x, s.y);
      if (e.shiftKey) {
        x = Math.round(x * 20) / 20;
        y = Math.round(y * 20) / 20;
      }
      y = Math.min(2, Math.max(-1, y));
      const c = (curveFor(t.key.interp, t.key.curve) ?? CURVE_PRESETS.linear).slice() as Curve;
      if (d.handle === 1) [c[0], c[1]] = [x, y];
      else [c[2], c[3]] = [x, y];
      d.moved = true;
      ed.gestureMutate((p) => this.app.applyCurveTo(p, clampCurve(c).map((v) => Math.round(v * 1000) / 1000) as Curve));
      this.draw();
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      this.timeline.interacting = false;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (d.moved) ed.endGesture('Edit curve handle');
      else ed.cancelGesture();
      this.timeline.render();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', () => this.cancelDrag());
  }

  cancelDrag(): boolean {
    const d = this.drag;
    if (!d) return false;
    this.drag = null;
    this.timeline.interacting = false;
    if (this.canvas?.hasPointerCapture(d.pointerId)) this.canvas.releasePointerCapture(d.pointerId);
    this.app.ed.cancelGesture();
    this.app.status('Curve edit cancelled.');
    this.timeline.render();
    return true;
  }
}
