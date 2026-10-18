// player.html: load a runtime JSON + atlas (JSON + page PNGs) or loose images, pick an
// animation / skin / optional transition, scrub or play. Read-only probe for tests:
// window.__rigsmithPlayer.
import type { AtlasMeta } from './model/atlas.ts';
import type { RuntimeExport } from './model/exportRuntime.ts';
import { renderSequenceFrame } from './render/sequence.ts';
import type { SequenceSetup } from './render/sequence.ts';
import { RigPlayer } from './runtime/player.ts';
import { h } from './ui/dom.ts';
import './styles.css';

const $ = (id: string) => document.getElementById(id)!;
const root = $('player');
let player: RigPlayer | null = null;
let setup: SequenceSetup | null = null;
let index = 0;
let raf = 0;
let runtimeName = '';
const state = { anim: '', skin: '', mixTo: '', mixAt: 0.5 };

const fileIn = h('input', { type: 'file', multiple: true, accept: '.json,image/png', 'data-testid': 'player-files', 'aria-label': 'Runtime JSON, atlas JSON and page images' });
const status = h('p', { class: 'hint', 'data-testid': 'player-status' }, 'Load a .runtime.json plus its .atlas.json and page PNGs (or the loose images).');
const errors = h('ul', { class: 'errors', role: 'alert', 'data-testid': 'player-errors', hidden: true });
const animSel = h('select', { 'data-testid': 'player-anim', 'aria-label': 'Animation' });
const skinSel = h('select', { 'data-testid': 'player-skin', 'aria-label': 'Skin' });
const mixSel = h('select', { 'data-testid': 'player-mix-to', 'aria-label': 'Transition to' });
const mixAt = h('input', { type: 'number', step: 0.05, min: 0, value: '0.5', class: 'w-num', 'data-testid': 'player-mix-at', 'aria-label': 'Transition starts at (s)' });
const slider = h('input', { type: 'range', min: 0, max: 0, step: 1, value: 0, 'data-testid': 'player-time', 'aria-label': 'Frame' });
const label = h('span', { class: 'dim', 'data-testid': 'player-frame-label' });
const playBtn = h('button', { class: 'mini', 'data-testid': 'player-play' }, 'Play');
const canvas = h('canvas', { class: 'player-canvas', 'data-testid': 'player-canvas' });

root.append(
  h('h1', {}, 'Rigsmith runtime player'),
  h('p', { class: 'hint' }, 'Reference player for rigsmith.runtime v2 + rigsmith.atlas files. Plays animations, IK/path constraints, meshes, skins and mixes from the runtime file alone.'),
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Files'), fileIn),
  status,
  errors,
  h('div', { class: 'export-grid' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Animation'), animSel),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Skin'), skinSel),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Transition to'), mixSel),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'at (s)'), mixAt),
  ),
  h('div', { class: 'export-actions' }, playBtn, slider, label),
  h('div', { class: 'mix-stage' }, canvas),
);

function showErrors(list: string[]): void {
  errors.replaceChildren(...list.map((e) => h('li', {}, e)));
  errors.hidden = !list.length;
}

function decodeImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not decode ${file.name}.`));
    img.src = URL.createObjectURL(file);
  });
}

fileIn.addEventListener('change', async () => {
  const files = [...(fileIn.files ?? [])];
  stop();
  status.textContent = 'Loading…';
  showErrors([]);
  try {
    const json = await Promise.all(files.filter((f) => f.name.endsWith('.json')).map(async (f) => ({ f, v: JSON.parse(await f.text()) })));
    const rt = json.find((j) => j.v?.format === 'rigsmith.runtime');
    if (!rt) throw new Error('No rigsmith.runtime JSON among the files.');
    const atlasJ = json.find((j) => j.v?.format === 'rigsmith.atlas');
    const pngs = new Map<string, HTMLImageElement>();
    for (const f of files.filter((x) => /\.png$/i.test(x.name))) pngs.set(f.name, await decodeImage(f));
    let atlas: { meta: AtlasMeta; pages: CanvasImageSource[] } | undefined;
    if (atlasJ) {
      const meta = atlasJ.v as AtlasMeta;
      const pages = meta.pages.map((p) => {
        const el = pngs.get(p.file);
        if (!el) throw new Error(`Atlas page ${p.file} was not loaded.`);
        if (el.naturalWidth !== p.width || el.naturalHeight !== p.height) throw new Error(`Atlas page ${p.file} is ${el.naturalWidth}×${el.naturalHeight}, expected ${p.width}×${p.height}.`);
        return el;
      });
      atlas = { meta, pages };
    }
    player = new RigPlayer(rt.v, { atlas, images: new Map([...pngs].map(([n, el]) => [n, el as CanvasImageSource])) });
    runtimeName = (rt.v as RuntimeExport).name;
    const missing = player.missingImages();
    if (missing.length) throw new Error(`No texture for: ${missing.join(', ')}.`);
    const anims = player.project.animations.map((a) => a.name);
    animSel.replaceChildren(...anims.map((n) => h('option', { value: n }, n)));
    skinSel.replaceChildren(h('option', { value: '' }, '(default)'), ...(player.project.skins ?? []).map((s) => h('option', { value: s.name }, s.name)));
    mixSel.replaceChildren(h('option', { value: '' }, '(none)'), ...anims.map((n) => h('option', { value: n }, n)));
    state.anim = anims[0] ?? '';
    state.skin = '';
    state.mixTo = '';
    status.textContent = `Loaded “${runtimeName}” (runtime v${(rt.v as RuntimeExport).version}): ${player.project.bones.length} bones, ${player.project.attachments.length} attachments, ${anims.length} animation(s)${atlas ? `, atlas with ${atlas.meta.regions.length} region(s) on ${atlas.pages.length} page(s)` : ', loose images'}.`;
    showErrors([]);
    prepare();
  } catch (e) {
    player = null;
    setup = null;
    status.textContent = 'Not loaded.';
    showErrors([(e as Error).message]);
  }
});

function prepare(): void {
  if (!player) return;
  const r = state.mixTo ? player.prepareMix(state.anim, state.mixTo, state.mixAt, state.skin || null) : player.prepare(state.anim, state.skin || null);
  if (!r.ok) {
    setup = null;
    showErrors(r.errors);
    return;
  }
  showErrors([]);
  setup = r.setup;
  index = Math.min(index, setup.frames.length - 1);
  slider.max = String(setup.frames.length - 1);
  show();
}

function show(): void {
  if (!player || !setup) return;
  const geo = setup.geometry;
  canvas.width = geo.width;
  canvas.height = geo.height;
  Object.assign(canvas.dataset, { ox: String(geo.originX), oy: String(geo.originY), scale: String(geo.scale), time: String(setup.plan.times[index]), frame: String(setup.plan.frames[index]) });
  renderSequenceFrame(canvas.getContext('2d')!, setup, index, player.lookup);
  slider.value = String(index);
  label.textContent = `frame ${setup.plan.frames[index]} / ${setup.plan.lastFrame} · ${setup.plan.times[index].toFixed(3)} s`;
}

function stop(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  playBtn.textContent = 'Play';
}

animSel.addEventListener('change', () => {
  state.anim = animSel.value;
  index = 0;
  prepare();
});
skinSel.addEventListener('change', () => {
  state.skin = skinSel.value;
  prepare();
});
mixSel.addEventListener('change', () => {
  state.mixTo = mixSel.value;
  index = 0;
  prepare();
});
mixAt.addEventListener('change', () => {
  const v = Number(mixAt.value);
  if (Number.isFinite(v) && v >= 0) state.mixAt = v;
  prepare();
});
slider.addEventListener('input', () => {
  stop();
  index = Number(slider.value);
  show();
});
playBtn.addEventListener('click', () => {
  if (!setup) return;
  if (raf) return stop();
  playBtn.textContent = 'Pause';
  const s = setup;
  const fps = s.anim.fps;
  const t0 = performance.now() - s.plan.times[index] * 1000;
  const loop = s.anim.loop;
  const tick = (now: number) => {
    let f = Math.floor(((now - t0) / 1000) * fps);
    if (f >= s.frames.length) {
      if (!loop) {
        index = s.frames.length - 1;
        show();
        return stop();
      }
      f %= s.frames.length;
    }
    index = f;
    show();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
});

Object.defineProperty(window, '__rigsmithPlayer', {
  value: Object.freeze({
    state: () => ({ loaded: !!player, ...state, index, frames: setup?.frames.length ?? 0, playing: !!raf }),
    /** Evaluated bone world matrices and mesh vertices of the shown frame. */
    frame: () => {
      if (!player || !setup) return null;
      const fr = setup.frames[index];
      return {
        time: setup.plan.times[index],
        bones: Object.fromEntries([...fr.world].map(([id, m]) => [id, { ...m }])),
        attachments: fr.attachments.map((a) => ({ name: a.att.name, image: a.image?.name ?? null, visible: a.visible, opacity: a.opacity, vertices: a.vertices ? [...a.vertices] : null })),
      };
    },
  }),
});
