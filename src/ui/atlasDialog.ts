// "Export atlas…" dialog: packs every project image into texture pages (padding, bleed,
// trim, max size, power-of-two), previews the pages and downloads a ZIP with the page PNGs
// and `<name>.atlas.json`. Pixels are read with the exact PNG decoder so straight-alpha
// colours survive unchanged; non-PNG images fall back to the canvas (reported).
import type { AtlasLayout, AtlasOptions } from '../model/atlas.ts';
import { DEFAULT_ATLAS, atlasFill, atlasItems, atlasMeta, packAtlas, renderAtlasPages } from '../model/atlas.ts';
import type { Rgba } from '../model/cutout.ts';
import { dataUrlBytes, decodePngExact, encodePngExact } from '../model/png.ts';
import type { ImageAsset } from '../model/types.ts';
import { buildZip } from '../model/zip.ts';
import { safeName } from '../render/sequence.ts';
import type { App } from './app.ts';
import { download } from './app.ts';
import { clear, h } from './dom.ts';

export async function imagePixels(app: App, im: ImageAsset): Promise<{ pixels: Rgba; exact: boolean }> {
  if (im.mime === 'image/png') {
    try {
      return { pixels: await decodePngExact(dataUrlBytes(im.dataUrl)), exact: true };
    } catch {
      // Interlaced or unusual PNG: fall through to the canvas.
    }
  }
  const el = app.images.get(im);
  if (!el) throw new Error(`Image “${im.name}” is not decoded.`);
  const c = document.createElement('canvas');
  c.width = im.width;
  c.height = im.height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(el, 0, 0);
  return { pixels: { width: im.width, height: im.height, data: g.getImageData(0, 0, im.width, im.height).data }, exact: false };
}

export class AtlasDialog {
  private app: App;
  private dlg: HTMLDialogElement;
  private body: HTMLElement;
  private opts: AtlasOptions = { ...DEFAULT_ATLAS };
  private pixels = new Map<string, Rgba>();
  private inexact: string[] = [];
  private busy = false;

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'export-body' });
    this.dlg = h('dialog', { class: 'help export atlas', 'data-testid': 'atlas-dialog', 'aria-label': 'Export texture atlas' }, h('h2', {}, 'Export texture atlas'), this.body) as HTMLDialogElement;
    document.body.append(this.dlg);
  }

  async open(): Promise<void> {
    const p = this.app.ed.project;
    this.pixels.clear();
    this.inexact = [];
    try {
      for (const im of p.images) {
        const r = await imagePixels(this.app, im);
        this.pixels.set(im.name, r.pixels);
        if (!r.exact) this.inexact.push(im.name);
      }
    } catch (e) {
      return this.app.error('Atlas export failed', [(e as Error).message]);
    }
    this.render();
    this.dlg.showModal();
  }

  private pack(): ReturnType<typeof packAtlas> {
    const p = this.app.ed.project;
    return packAtlas(atlasItems(p.images.map((im) => ({ name: im.name, pixels: this.pixels.get(im.name)! })), this.opts.trim), this.opts);
  }

  private render(): void {
    clear(this.body);
    const o = this.opts;
    const num = (testId: string, label: string, value: number, set: (v: number) => void) => {
      const input = h('input', { type: 'number', step: 1, min: 0, value: String(value), 'data-testid': testId, 'aria-label': label, class: 'w-num' });
      input.addEventListener('change', () => {
        set(Number(input.value));
        this.render();
      });
      return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input);
    };
    const check = (testId: string, label: string, value: boolean, set: (v: boolean) => void) => {
      const input = h('input', { type: 'checkbox', checked: value, 'data-testid': testId });
      input.addEventListener('change', () => {
        set(input.checked);
        this.render();
      });
      return h('label', { class: 'inline' }, input, label);
    };
    const maxSel = h('select', { 'data-testid': 'atlas-max', 'aria-label': 'Max page size' }, ...[64, 128, 256, 512, 1024, 2048, 4096].map((v) => h('option', { value: v }, `${v}`)));
    maxSel.value = String(o.maxSize);
    maxSel.addEventListener('change', () => {
      this.opts = { ...this.opts, maxSize: Number(maxSel.value) };
      this.render();
    });
    const r = this.pack();
    const pages = h('div', { class: 'atlas-pages' });
    const exportBtn = h('button', { class: 'accent', 'data-testid': 'atlas-export', disabled: !r.ok }, 'Export atlas ZIP');
    exportBtn.addEventListener('click', () => r.ok && void this.run(r.layout));
    const cancel = h('button', { 'data-testid': 'atlas-cancel', onclick: () => this.dlg.close() }, 'Close');
    this.body.append(
      h('div', { class: 'export-grid' },
        num('atlas-padding', 'Padding px', o.padding, (v) => void (this.opts = { ...this.opts, padding: v })),
        num('atlas-bleed', 'Bleed px', o.bleed, (v) => void (this.opts = { ...this.opts, bleed: v })),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Max page'), maxSel),
        h('div', {}, check('atlas-trim', 'Trim transparent edges', o.trim, (v) => void (this.opts = { ...this.opts, trim: v })), check('atlas-pot', 'Power-of-two pages', o.pot, (v) => void (this.opts = { ...this.opts, pot: v }))),
      ),
      h('p', { class: 'hint' }, 'Regions are never rotated. Trim keeps a 1 px transparent margin; bleed copies each region’s edge pixels into its padding so filtering at the edge never picks up a neighbour.'),
      r.ok
        ? h('p', { class: 'hint', 'data-testid': 'atlas-summary' }, `${r.layout.regions.length} region(s) on ${r.layout.pages.length} page(s): ${r.layout.pages.map((p) => `${p.width}×${p.height}`).join(', ')} · ${Math.round(atlasFill(r.layout) * 100)}% filled`)
        : h('ul', { class: 'errors', role: 'alert', 'data-testid': 'atlas-errors' }, ...r.errors.map((e) => h('li', {}, e))),
      this.inexact.length ? h('p', { class: 'warn', 'data-testid': 'atlas-inexact' }, `Read through the canvas (colours under partial alpha may round): ${this.inexact.join(', ')}`) : '',
      pages,
      h('div', { class: 'export-actions' }, h('span', { class: 'tb-spacer' }), cancel, exportBtn),
    );
    if (r.ok) {
      renderAtlasPages(r.layout, this.pixels, o.bleed).forEach((pg, i) => {
        const c = h('canvas', { class: 'atlas-page', 'data-testid': `atlas-page-${i}`, width: pg.width, height: pg.height });
        c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pg.data), pg.width, pg.height), 0, 0);
        pages.append(h('figure', {}, c, h('figcaption', {}, `page ${i} · ${pg.width}×${pg.height}`)));
      });
    }
  }

  private async run(layout: AtlasLayout): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const base = safeName(this.app.ed.project.name);
      const file = (i: number) => `${base}-${i}.png`;
      const pages = renderAtlasPages(layout, this.pixels, this.opts.bleed);
      const entries = [];
      for (let i = 0; i < pages.length; i++) entries.push({ name: `${base}-atlas/${file(i)}`, data: await encodePngExact(pages[i]) });
      const meta = atlasMeta(layout, this.opts, file);
      entries.push({ name: `${base}-atlas/${base}.atlas.json`, data: new TextEncoder().encode(JSON.stringify(meta, null, 1)) });
      download(new Blob([buildZip(entries) as BlobPart], { type: 'application/zip' }), `${base}-atlas.zip`);
      this.app.status(`Exported a ${pages.length}-page atlas with ${layout.regions.length} region(s).`);
    } catch (e) {
      this.app.error('Atlas export failed', [(e as Error).message]);
    } finally {
      this.busy = false;
    }
  }
}
