// Procedurally drawn original art for the built-in "Tock" demo. Nothing here is
// sourced from any third-party asset; each part is painted with Canvas 2D at runtime.
import { DEMO_PARTS } from '../model/demo.ts';
import type { ImageAsset } from '../model/types.ts';

type Painter = (g: CanvasRenderingContext2D, w: number, h: number) => void;

const INK = '#2b2d42';
const TIN = '#ef8354';
const TIN_DARK = '#c8553d';
const CREAM = '#f4f1de';
const TEAL = '#4f9d9a';
const BRASS = '#e0b24a';

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function outline(g: CanvasRenderingContext2D, fill: string): void {
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = 2.5;
  g.strokeStyle = INK;
  g.stroke();
}

function rivet(g: CanvasRenderingContext2D, x: number, y: number): void {
  g.beginPath();
  g.arc(x, y, 1.8, 0, Math.PI * 2);
  g.fillStyle = INK;
  g.fill();
}

const painters: Record<string, Painter> = {
  img_torso(g, w, h) {
    rr(g, 3, 3, w - 6, h - 6, 16);
    outline(g, TIN);
    rr(g, 12, 18, w - 24, h - 40, 8);
    outline(g, CREAM);
    // Parcel strap across the chest.
    g.save();
    g.beginPath();
    g.moveTo(8, 10);
    g.lineTo(w - 10, h - 14);
    g.lineWidth = 7;
    g.strokeStyle = TEAL;
    g.stroke();
    g.restore();
    for (const [x, y] of [[10, 10], [w - 10, 10], [10, h - 10], [w - 10, h - 10]]) rivet(g, x, y);
    // Dial.
    g.beginPath();
    g.arc(w / 2, h / 2 + 4, 9, 0, Math.PI * 2);
    outline(g, BRASS);
    g.beginPath();
    g.moveTo(w / 2, h / 2 + 4);
    g.lineTo(w / 2 + 6, h / 2 - 1);
    g.lineWidth = 2;
    g.stroke();
  },
  img_head(g, w, h) {
    rr(g, 4, 10, w - 8, h - 14, 14);
    outline(g, TIN);
    // Antenna.
    g.beginPath();
    g.moveTo(w / 2, 10);
    g.lineTo(w / 2, 3);
    g.lineWidth = 2.5;
    g.strokeStyle = INK;
    g.stroke();
    g.beginPath();
    g.arc(w / 2, 4, 3, 0, Math.PI * 2);
    outline(g, BRASS);
    // Visor with one big lens looking forward (+x).
    rr(g, 14, 20, w - 22, 22, 10);
    outline(g, INK);
    g.beginPath();
    g.arc(w - 22, 31, 7, 0, Math.PI * 2);
    outline(g, '#9fe7e0');
    g.beginPath();
    g.arc(w - 20, 29, 2.2, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
    rivet(g, 10, h - 10);
    rivet(g, w - 10, h - 10);
  },
  img_upperarm(g, w, h) {
    rr(g, 3, 3, w - 6, h - 6, (w - 6) / 2);
    outline(g, TIN_DARK);
    rr(g, 3, h / 2 - 3, w - 6, 6, 2);
    outline(g, BRASS);
  },
  img_forearm(g, w, h) {
    rr(g, 4, 2, w - 8, h - 16, (w - 8) / 2);
    outline(g, TIN_DARK);
    // Mitten hand at the far (bottom) end.
    g.beginPath();
    g.arc(w / 2, h - 9, 7.5, 0, Math.PI * 2);
    outline(g, CREAM);
  },
  img_thigh(g, w, h) {
    rr(g, 3, 3, w - 6, h - 6, 8);
    outline(g, TEAL);
    rivet(g, w / 2, 9);
  },
  img_shin(g, w, h) {
    rr(g, 5, 2, w - 14, h - 14, 6);
    outline(g, TEAL);
    // Boot pointing forward (+x).
    rr(g, 3, h - 16, w - 4, 13, 6);
    outline(g, INK);
  },
  img_key(g, w, h) {
    g.beginPath();
    g.moveTo(2, h / 2);
    g.lineTo(w - 18, h / 2);
    g.lineWidth = 5;
    g.strokeStyle = INK;
    g.stroke();
    for (const dy of [-7, 7]) {
      g.beginPath();
      g.ellipse(w - 11, h / 2 + dy, 9, 6, 0, 0, Math.PI * 2);
      outline(g, BRASS);
    }
  },
};

export function buildDemoImages(): ImageAsset[] {
  return DEMO_PARTS.map((part) => {
    const c = document.createElement('canvas');
    c.width = part.width;
    c.height = part.height;
    const g = c.getContext('2d')!;
    painters[part.id]?.(g, part.width, part.height);
    return { id: part.id, name: part.name, mime: 'image/png', width: part.width, height: part.height, dataUrl: c.toDataURL('image/png') };
  });
}
