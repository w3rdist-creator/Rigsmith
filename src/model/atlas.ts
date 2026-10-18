// Texture-atlas packing (pure, deterministic). Images are optionally trimmed to their
// non-transparent bounds plus a 1 px transparent margin (so bilinear sampling at the
// trimmed edge still sees transparency), then shelf-packed — tallest first, ties by
// width then name — into the smallest page (area, then longest side, then width) up to
// `maxSize`, spilling onto further pages when needed. Regions are never rotated.
//
// Page layout: `padding` transparent pixels around every region and the page edge;
// `bleed` (≤ padding/2) extrudes each region's edge pixels outward into its padding so a
// renderer that filters across the region edge picks up the region's own colour, not a
// neighbour's or transparent black.
//
// A region maps back to its source image: source pixel (offsetX + i, offsetY + j) is page
// pixel (x + i, y + j) for 0 ≤ i < width, 0 ≤ j < height; everything outside the trimmed
// rectangle is fully transparent in the source.
import type { Rgba } from './cutout.ts';

export interface AtlasOptions {
  padding: number;
  bleed: number;
  trim: boolean;
  maxSize: number;
  /** Round page sizes up to powers of two. */
  pot: boolean;
}

export const DEFAULT_ATLAS: AtlasOptions = { padding: 2, bleed: 1, trim: true, maxSize: 2048, pot: false };

export interface AtlasItem {
  name: string;
  /** Rectangle of the source image kept (trim), in source pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

export interface AtlasRegion {
  name: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  originalWidth: number;
  originalHeight: number;
}

export interface AtlasLayout {
  pages: { width: number; height: number }[];
  regions: AtlasRegion[];
}

export function atlasOptionErrors(o: AtlasOptions): string[] {
  const e: string[] = [];
  const int = (v: number) => Number.isInteger(v);
  if (!int(o.padding) || o.padding < 0 || o.padding > 64) e.push('Padding must be a whole number of pixels from 0 to 64.');
  if (!int(o.bleed) || o.bleed < 0 || o.bleed * 2 > o.padding) e.push('Bleed must be a whole number from 0 to half the padding (so neighbours never overlap).');
  if (!int(o.maxSize) || o.maxSize < 16 || o.maxSize > 8192) e.push('Max page size must be from 16 to 8192 px.');
  return e;
}

/** Non-transparent bounds + 1 px margin (clipped to the image); a blank image keeps 1×1. */
export function trimRect(img: Rgba): { x: number; y: number; width: number; height: number } {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return { x: 0, y: 0, width: 1, height: 1 };
  x0 = Math.max(0, x0 - 1);
  y0 = Math.max(0, y0 - 1);
  x1 = Math.min(img.width - 1, x1 + 1);
  y1 = Math.min(img.height - 1, y1 + 1);
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

const pot = (v: number) => 2 ** Math.ceil(Math.log2(Math.max(1, v)));

type Placed = { item: AtlasItem; x: number; y: number };

/** Shelf-packs items in order into a page of width W; returns placements and used height. */
function shelf(items: AtlasItem[], W: number, pad: number, maxH: number): { placed: Placed[]; height: number; rest: AtlasItem[] } {
  const placed: Placed[] = [];
  const rest: AtlasItem[] = [];
  let x = pad, y = pad, rowH = 0;
  for (const it of items) {
    if (x + it.width + pad > W && x > pad) {
      y += rowH + pad;
      x = pad;
      rowH = 0;
    }
    if (x + it.width + pad > W || y + it.height + pad > maxH) {
      rest.push(it);
      continue;
    }
    placed.push({ item: it, x, y });
    x += it.width + pad;
    rowH = Math.max(rowH, it.height);
  }
  return { placed, height: placed.length ? y + rowH + pad : 0, rest };
}

export function packAtlas(itemsIn: AtlasItem[], o: AtlasOptions): { ok: true; layout: AtlasLayout } | { ok: false; errors: string[] } {
  const errors = atlasOptionErrors(o);
  if (errors.length) return { ok: false, errors };
  if (!itemsIn.length) return { ok: false, errors: ['The project has no images to pack.'] };
  const names = new Set<string>();
  for (const it of itemsIn) {
    if (names.has(it.name)) errors.push(`Two images are named “${it.name}”; atlas regions need unique names.`);
    names.add(it.name);
    if (it.width + 2 * o.padding > o.maxSize || it.height + 2 * o.padding > o.maxSize)
      errors.push(`${it.name} (${it.width}×${it.height} after trim) does not fit a ${o.maxSize}×${o.maxSize} page with ${o.padding}px padding.`);
  }
  if (errors.length) return { ok: false, errors };
  const items = [...itemsIn].sort((a, b) => b.height - a.height || b.width - a.width || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const pages: AtlasLayout['pages'] = [];
  const regions: AtlasRegion[] = [];
  let todo = items;
  while (todo.length) {
    const widest = Math.max(...todo.map((i) => i.width)) + 2 * o.padding;
    let best: { W: number; H: number; r: ReturnType<typeof shelf> } | null = null;
    const widths: number[] = [];
    if (o.pot) for (let w = pot(widest); w <= o.maxSize; w *= 2) widths.push(w);
    else for (let w = widest; w <= o.maxSize; w += 4) widths.push(w);
    if (!o.pot && widths[widths.length - 1] !== o.maxSize) widths.push(o.maxSize);
    for (const W of widths) {
      const r = shelf(todo, W, o.padding, o.maxSize);
      if (!r.placed.length) continue;
      const H = o.pot ? pot(r.height) : r.height;
      if (H > o.maxSize) continue;
      // Prefer packing more items on this page, then the smaller page.
      const score = (c: { W: number; H: number; r: ReturnType<typeof shelf> }) => [-c.r.placed.length, c.W * c.H, Math.max(c.W, c.H), c.W];
      const cand = { W, H, r };
      if (!best || lexLess(score(cand), score(best))) best = cand;
    }
    if (!best) return { ok: false, errors: ['Could not pack the images; raise the max page size.'] };
    const page = pages.length;
    // Shrink the width to the content (non-power-of-two pages only).
    const usedW = Math.max(...best.r.placed.map((p) => p.x + p.item.width)) + o.padding;
    pages.push({ width: o.pot ? best.W : usedW, height: best.H });
    for (const p of best.r.placed)
      regions.push({ name: p.item.name, page, x: p.x, y: p.y, width: p.item.width, height: p.item.height, offsetX: p.item.x, offsetY: p.item.y, originalWidth: p.item.originalWidth, originalHeight: p.item.originalHeight });
    todo = best.r.rest;
  }
  regions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, layout: { pages, regions } };
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** Page pixels: regions copied from their sources, then `bleed` px of edge extrusion. */
export function renderAtlasPages(layout: AtlasLayout, sources: Map<string, Rgba>, bleed: number): Rgba[] {
  const pages = layout.pages.map((p) => ({ width: p.width, height: p.height, data: new Uint8ClampedArray(p.width * p.height * 4) }));
  for (const r of layout.regions) {
    const src = sources.get(r.name);
    if (!src) throw new Error(`No pixels for ${r.name}.`);
    const pg = pages[r.page];
    for (let j = -bleed; j < r.height + bleed; j++)
      for (let i = -bleed; i < r.width + bleed; i++) {
        const sx = r.offsetX + Math.min(r.width - 1, Math.max(0, i));
        const sy = r.offsetY + Math.min(r.height - 1, Math.max(0, j));
        const s = (sy * src.width + sx) * 4, d = ((r.y + j) * pg.width + r.x + i) * 4;
        for (let c = 0; c < 4; c++) pg.data[d + c] = src.data[s + c];
      }
  }
  return pages;
}

export interface AtlasMeta {
  format: 'rigsmith.atlas';
  version: 1;
  padding: number;
  bleed: number;
  trim: boolean;
  pot: boolean;
  maxSize: number;
  pages: { file: string; width: number; height: number }[];
  regions: AtlasRegion[];
}

export function atlasMeta(layout: AtlasLayout, o: AtlasOptions, pageFile: (i: number) => string): AtlasMeta {
  return {
    format: 'rigsmith.atlas',
    version: 1,
    padding: o.padding,
    bleed: o.bleed,
    trim: o.trim,
    pot: o.pot,
    maxSize: o.maxSize,
    pages: layout.pages.map((p, i) => ({ file: pageFile(i), width: p.width, height: p.height })),
    regions: layout.regions,
  };
}

/** Builds pack items from decoded images (trim optional). */
export function atlasItems(images: { name: string; pixels: Rgba }[], trim: boolean): AtlasItem[] {
  return images.map(({ name, pixels }) => {
    const t = trim ? trimRect(pixels) : { x: 0, y: 0, width: pixels.width, height: pixels.height };
    return { name, ...t, originalWidth: pixels.width, originalHeight: pixels.height };
  });
}

/** Fraction of page area covered by regions. */
export function atlasFill(layout: AtlasLayout): number {
  const area = layout.pages.reduce((s, p) => s + p.width * p.height, 0);
  return area ? layout.regions.reduce((s, r) => s + r.width * r.height, 0) / area : 0;
}
