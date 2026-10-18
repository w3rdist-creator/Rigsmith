// "Create mesh…" dialog: click an outline around the art and add interior points (or
// fill a grid), preview the triangulation live, then apply it to the attachment as one
// undo step. Vertex positions are image pixels and double as texture coordinates.
import { gridPoints, meshProblem, setMesh, triangulate } from '../model/meshOps.ts';
import type { Mesh } from '../model/types.ts';
import type { App } from './app.ts';
import { append, clear, h } from './dom.ts';

type Mode = 'outline' | 'interior';
const VIEW_W = 520;
const VIEW_H = 400;

export class MeshDialog {
  private app: App;
  private dlg: HTMLDialogElement;
  private body: HTMLElement;
  private attId: string | null = null;
  private hull: number[] = [];
  private interior: number[] = [];
  private mode: Mode = 'outline';
  private cols = 6;
  private rows = 2;
  private errors: string[] = [];
  private canvas: HTMLCanvasElement | null = null;

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'export-body' });
    this.dlg = h('dialog', { class: 'help export cutout', 'data-testid': 'mesh-dialog', 'aria-label': 'Mesh' }, h('h2', {}, 'Mesh'), this.body) as HTMLDialogElement;
    document.body.append(this.dlg);
  }

  get isOpen(): boolean {
    return this.dlg.open;
  }

  open(attId: string): void {
    const att = this.app.ed.project.attachments.find((a) => a.id === attId);
    if (!att) return;
    this.attId = attId;
    this.hull = att.mesh ? att.mesh.points.slice(0, 2 * att.mesh.hull) : [];
    this.interior = att.mesh ? att.mesh.points.slice(2 * att.mesh.hull) : [];
    this.mode = 'outline';
    this.errors = [];
    this.render();
    this.dlg.showModal();
  }

  private source() {
    const p = this.app.ed.project;
    const att = p.attachments.find((a) => a.id === this.attId);
    const im = att && p.images.find((i) => i.id === att.imageId);
    return att && im ? { att, im } : null;
  }

  private geometry(im: { width: number; height: number }) {
    const scale = Math.min(VIEW_W / im.width, VIEW_H / im.height, 4);
    return { scale, ox: (VIEW_W - im.width * scale) / 2, oy: (VIEW_H - im.height * scale) / 2 };
  }

  /** Live triangulation (null + message when the points are not valid yet). */
  private preview(im: { width: number; height: number }): { mesh: Mesh | null; problem: string | null } {
    const problem = meshProblem(this.hull, this.interior, im);
    if (problem) return { mesh: null, problem };
    try {
      return { mesh: triangulate(this.hull, this.interior), problem: null };
    } catch (e) {
      return { mesh: null, problem: (e as Error).message };
    }
  }

  private render(): void {
    const src = this.source();
    clear(this.body);
    if (!src) return;
    const { att, im } = src;
    const g = this.geometry(im);
    const canvas = h('canvas', {
      class: 'cutout-canvas',
      width: VIEW_W * 2,
      height: VIEW_H * 2,
      style: `width:${VIEW_W}px;height:${VIEW_H}px`,
      'data-testid': 'mesh-canvas',
      'data-scale': String(g.scale),
      'data-ox': String(g.ox),
      'data-oy': String(g.oy),
      'aria-label': 'Mesh canvas: click to add points',
    });
    this.canvas = canvas;
    canvas.addEventListener('pointerdown', (e) => {
      const r = canvas.getBoundingClientRect();
      const x = Math.round(Math.min(im.width, Math.max(0, (e.clientX - r.left - g.ox) / g.scale)) * 10) / 10;
      const y = Math.round(Math.min(im.height, Math.max(0, (e.clientY - r.top - g.oy) / g.scale)) * 10) / 10;
      (this.mode === 'outline' ? this.hull : this.interior).push(x, y);
      this.errors = [];
      this.render();
    });
    const modeBtn = (m: Mode, label: string, title: string) =>
      h('button', { class: `mini${this.mode === m ? ' on' : ''}`, 'data-testid': `mesh-mode-${m}`, 'aria-pressed': this.mode === m ? 'true' : 'false', title, onclick: () => ((this.mode = m), this.render()) }, label);
    const num = (testId: string, label: string, value: number, set: (v: number) => void) => {
      const input = h('input', { type: 'number', min: 1, max: 24, step: 1, value: String(value), 'data-testid': testId, 'aria-label': label, class: 'w-num' });
      input.addEventListener('change', () => (set(Math.min(24, Math.max(1, Math.round(Number(input.value)) || 1))), this.render()));
      return h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, label), input);
    };
    const { mesh, problem } = this.preview(im);
    const summary = `${this.hull.length / 2} outline · ${this.interior.length / 2} interior point(s)${mesh ? ` · ${mesh.triangles.length / 3} triangles` : ''}`;
    const replacing = !!att.mesh;
    append(this.body,
      h('p', { class: 'dim' }, `${im.name} (${im.width}×${im.height}). Click around the art for the outline (in order), then add interior points where it should bend.`),
      h('div', { class: 'row-key' },
        modeBtn('outline', 'Outline', 'Click to add outline points in order'),
        modeBtn('interior', 'Interior', 'Click inside the outline to add bend points'),
        h('button', { class: 'mini', 'data-testid': 'mesh-undo-point', disabled: !this.hull.length && !this.interior.length, onclick: () => ((this.mode === 'interior' && this.interior.length ? this.interior : this.hull).splice(-2), this.render()) }, 'Undo point'),
        h('button', { class: 'mini', 'data-testid': 'mesh-clear', onclick: () => ((this.hull = []), (this.interior = []), this.render()) }, 'Clear'),
      ),
      canvas,
      h('p', { class: 'dim', 'data-testid': 'mesh-summary-dialog' }, summary),
      h('div', { class: 'seq-grid' },
        num('mesh-grid-cols', 'Grid columns', this.cols, (v) => (this.cols = v)),
        num('mesh-grid-rows', 'Grid rows', this.rows, (v) => (this.rows = v)),
      ),
      h('button', {
        class: 'mini',
        'data-testid': 'mesh-grid',
        title: 'Replace the points with the image rectangle and an evenly spaced interior grid',
        onclick: () => {
          const gp = gridPoints(im.width, im.height, this.cols, this.rows);
          this.hull = gp.hull;
          this.interior = gp.interior;
          this.errors = [];
          this.render();
        },
      }, 'Fill grid'),
      replacing ? h('p', { class: 'hint' }, 'Applying replaces the current mesh: its weights and deform keys are reset.') : null,
      problem && (this.hull.length >= 6 || this.errors.length) ? h('p', { class: 'hint', 'data-testid': 'mesh-problem' }, problem) : null,
      this.errors.length ? h('ul', { class: 'seq-errors', role: 'alert', 'data-testid': 'mesh-errors' }, ...this.errors.map((e) => h('li', {}, e))) : null,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'accent', 'data-testid': 'mesh-apply', title: problem ?? 'Apply the mesh', onclick: () => this.apply() }, replacing ? 'Replace mesh' : 'Create mesh'),
        h('button', { 'data-testid': 'mesh-cancel', onclick: () => this.dlg.close() }, 'Cancel'),
      ),
    );
    this.draw(mesh);
  }

  private draw(mesh: Mesh | null): void {
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
    const S = (flat: readonly number[], i: number) => ({ x: geo.ox + flat[2 * i] * geo.scale, y: geo.oy + flat[2 * i + 1] * geo.scale });
    if (mesh) {
      g.beginPath();
      for (let t = 0; t < mesh.triangles.length; t += 3) {
        const [a, b, d] = [0, 1, 2].map((k) => S(mesh.points, mesh.triangles[t + k]));
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.lineTo(d.x, d.y);
        g.closePath();
      }
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(120,200,255,0.8)';
      g.stroke();
    }
    const n = this.hull.length / 2;
    if (n) {
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const q = S(this.hull, i);
        if (i) g.lineTo(q.x, q.y);
        else g.moveTo(q.x, q.y);
      }
      g.closePath();
      g.lineWidth = 1.5;
      g.strokeStyle = '#ffd166';
      g.stroke();
      for (let i = 0; i < n; i++) {
        const q = S(this.hull, i);
        g.fillStyle = '#ffd166';
        g.fillRect(q.x - 3, q.y - 3, 6, 6);
      }
    }
    for (let i = 0; i < this.interior.length / 2; i++) {
      const q = S(this.interior, i);
      g.beginPath();
      g.arc(q.x, q.y, 3.5, 0, Math.PI * 2);
      g.fillStyle = '#78c8ff';
      g.fill();
    }
  }

  private apply(): void {
    const src = this.source();
    if (!src) return;
    const { att, im } = src;
    const { mesh, problem } = this.preview(im);
    if (!mesh) {
      this.errors = [problem ?? 'The mesh is not valid.'];
      return this.render();
    }
    const replacing = !!att.mesh;
    this.app.ed.mutate(replacing ? 'Replace mesh' : 'Create mesh', (p) => setMesh(p, att.id, mesh));
    this.dlg.close();
    this.app.ed.select({ kind: 'attachment', id: att.id });
    this.app.status(`Mesh: ${mesh.points.length / 2} vertices, ${mesh.triangles.length / 3} triangles on ${att.name}. Use Edit vertices / Paint weights on the canvas.`);
  }
}
