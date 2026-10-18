// Brand pipeline example: one rigged mascot, one skin per brand colourway, every output
// produced by the documented CLI (node scripts/rigsmith.ts …) — no editor, no browser
// window, no probe. Art is original and procedural (signed-distance shapes, palette from
// brands.json), so the whole run is reproducible from this folder.
//
//   node examples/brand-pipeline/pipeline.ts [outDir]
//   (default outDir: .hermes/assets/roadmap-demos/brand-pipeline)
//
// Steps: 1 draw base + brand art · 2 build the base rig (model API) · 3 per brand:
// add-image ×5, skin --set … · 4 set-mix · 5 validate · 6 runtime + atlas · 7 per brand:
// render (wave), mix (idle → wave), media wave.gif (+ wave.webm with VP9 alpha when a local
// ffmpeg with libvpx-vp9 exists — recorded in the log) · 8 manifest.json with
// sha256 of every output (identical across runs on the same Chrome for Testing build).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeBone } from '../../src/model/ops.ts';
import { encodePngExact } from '../../src/model/png.ts';
import type { Animation, Key, Project } from '../../src/model/types.ts';
import { FORMAT_ID } from '../../src/model/types.ts';
import { writeProject } from '../../scripts/lib/rigsmith-api.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.resolve(ROOT, process.argv[2] ?? '.hermes/assets/roadmap-demos/brand-pipeline');
const config = JSON.parse(readFileSync(path.join(import.meta.dirname, 'brands.json'), 'utf8')) as { base: Palette; brands: { name: string; palette: Palette }[] };
type Palette = { primary: string; secondary: string; accent: string; ink: string };

// ---- 1. Procedural art -----------------------------------------------------------------

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
type Shape = { sdf: (x: number, y: number) => number; color: string };
const box = (cx: number, cy: number, hw: number, hh: number, r: number) => (x: number, y: number) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const circle = (cx: number, cy: number, r: number) => (x: number, y: number) => Math.hypot(x - cx, y - cy) - r;

async function paint(w: number, h: number, shapes: Shape[]): Promise<Uint8Array> {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const s of shapes) {
        const cov = Math.min(1, Math.max(0, 0.5 - s.sdf(x + 0.5, y + 0.5)));
        if (!cov) continue;
        const [sr, sg, sb] = hex(s.color);
        // Straight-alpha "over".
        const na = cov + a * (1 - cov);
        r = (sr * cov + r * a * (1 - cov)) / na;
        g = (sg * cov + g * a * (1 - cov)) / na;
        b = (sb * cov + b * a * (1 - cov)) / na;
        a = na;
      }
      d.set([Math.round(r), Math.round(g), Math.round(b), Math.round(a * 255)], (y * w + x) * 4);
    }
  return encodePngExact({ width: w, height: h, data: d });
}

const PARTS = ['body', 'head', 'arm', 'leg', 'flag'] as const;
function art(p: Palette): Record<(typeof PARTS)[number], [number, number, Shape[]]> {
  return {
    body: [70, 92, [{ sdf: box(35, 46, 32, 44, 18), color: p.primary }, { sdf: box(35, 56, 16, 26, 12), color: p.secondary }]],
    head: [66, 66, [{ sdf: circle(33, 33, 31), color: p.secondary }, { sdf: circle(22, 30, 4.5), color: p.ink }, { sdf: circle(44, 30, 4.5), color: p.ink }, { sdf: circle(16, 42, 5), color: p.accent }, { sdf: circle(50, 42, 5), color: p.accent }, { sdf: box(33, 46, 8, 2.2, 2), color: p.ink }]],
    arm: [56, 18, [{ sdf: box(28, 9, 26, 7, 7), color: p.primary }, { sdf: circle(48, 9, 7.5), color: p.secondary }]],
    leg: [20, 44, [{ sdf: box(10, 22, 8, 20, 8), color: p.ink }]],
    flag: [64, 44, [{ sdf: box(4, 22, 2.5, 21, 1.5), color: p.ink }, { sdf: box(36, 14, 26, 12, 3), color: p.accent }, { sdf: box(36, 14, 26, 3, 1), color: p.secondary }]],
  };
}

async function writeArt(dir: string, p: Palette, prefix: string): Promise<Record<string, string>> {
  mkdirSync(dir, { recursive: true });
  const out: Record<string, string> = {};
  for (const [part, [w, h, shapes]] of Object.entries(art(p))) {
    const f = path.join(dir, `${prefix}${part}.png`);
    writeFileSync(f, await paint(w, h, shapes));
    out[part] = f;
  }
  return out;
}

// ---- 2. Base rig (model API) ------------------------------------------------------------

function baseRig(files: Record<string, string>): Project {
  const img = (part: string, w: number, h: number) => ({ id: `img_${part}`, name: `${part}.png`, mime: 'image/png', width: w, height: h, dataUrl: `data:image/png;base64,${readFileSync(files[part]).toString('base64')}` });
  const sizes = Object.fromEntries(Object.entries(art(config.base)).map(([k, [w, h]]) => [k, [w, h]]));
  const att = (id: string, boneId: string, part: string, x: number, y: number, rotation: number) => ({ id, name: id, boneId, imageId: `img_${part}`, x, y, rotation, scaleX: 1, scaleY: 1, opacity: 1 });
  const p: Project = {
    format: FORMAT_ID,
    version: 2,
    name: 'mascot',
    bones: [
      makeBone('root', 'root', null, 0, 0, 0, 20),
      makeBone('hips', 'hips', 'root', 0, -40, -90, 20),
      makeBone('body', 'body', 'hips', 0, 0, 0, 80),
      makeBone('head', 'head', 'body', 84, 0, 0, 40),
      makeBone('arm-back', 'arm-back', 'body', 62, -26, -155, 50),
      makeBone('arm-front', 'arm-front', 'body', 62, 24, 70, 50),
      makeBone('leg-back', 'leg-back', 'root', -14, -42, 90, 40),
      makeBone('leg-front', 'leg-front', 'root', 14, -42, 90, 40),
    ],
    images: PARTS.map((k) => img(k, sizes[k][0], sizes[k][1])),
    attachments: [
      att('arm-back', 'arm-back', 'arm', 26, 0, 0),
      att('leg-back', 'leg-back', 'leg', 20, 0, -90),
      att('leg-front', 'leg-front', 'leg', 20, 0, -90),
      att('body', 'body', 'body', 42, 0, 90),
      att('head', 'head', 'head', 28, 0, 90),
      att('flag', 'arm-front', 'flag', 75, 12, 50),
      att('arm-front', 'arm-front', 'arm', 26, 0, 0),
    ],
    animations: [],
  };
  const k = (time: number, value: number[], interp: Key['interp'] = 'smooth', curve?: Key['curve']): Key => ({ time, value, interp, ...(curve ? { curve } : {}) });
  const t = (rotate: Key[] = [], translate: Key[] = [], scale: Key[] = []) => ({ rotate, translate, scale });
  const wave: Animation = {
    id: 'wave', name: 'wave', duration: 1.2, fps: 24, loop: true,
    tracks: {
      'arm-front': t([k(0, [30]), k(0.3, [72], 'bezier', [0.3, 0, 0.2, 1.3]), k(0.6, [24]), k(0.9, [72]), k(1.2, [30])]),
      head: t([k(0, [0]), k(0.3, [-8]), k(0.9, [6]), k(1.2, [0])]),
      hips: t([], [k(0, [0, -40]), k(0.3, [0, -46]), k(0.6, [0, -40]), k(0.9, [0, -46]), k(1.2, [0, -40])]),
      body: t([k(0, [0]), k(0.6, [-4]), k(1.2, [0])]),
    },
  };
  const idle: Animation = {
    id: 'idle', name: 'idle', duration: 1.6, fps: 24, loop: true,
    tracks: {
      body: t([], [], [k(0, [1, 1]), k(0.8, [1.03, 0.98]), k(1.6, [1, 1])]),
      head: t([k(0, [0]), k(0.8, [3]), k(1.6, [0])]),
      'arm-front': t([k(0, [70]), k(0.8, [76]), k(1.6, [70])]),
    },
  };
  p.animations.push(wave, idle);
  return p;
}

// ---- 3–8. Pipeline through the CLI -------------------------------------------------------

const log: string[] = [];
function cli(...args: string[]): any {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), ...args], { cwd: ROOT, encoding: 'utf8' });
  const out = JSON.parse(r.stdout || '{}');
  log.push(`$ rigsmith ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : path.isAbsolute(a) ? path.relative(ROOT, a) : a)).join(' ')}  → exit ${r.status}`);
  if (r.status !== 0) throw new Error(`rigsmith ${args[0]} failed (exit ${r.status}): ${JSON.stringify(out.errors ?? r.stderr)}`);
  return out;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const baseArt = await writeArt(path.join(OUT, 'art/base'), config.base, '');
  const project = path.join(OUT, 'work/mascot.rig.json');
  mkdirSync(path.dirname(project), { recursive: true });
  writeProject(project, baseRig(baseArt));
  log.push(`base rig written: ${path.relative(ROOT, project)}`);
  for (const b of config.brands) {
    const a = await writeArt(path.join(OUT, `art/${b.name}`), b.palette, `${b.name}-`);
    for (const part of PARTS) cli('add-image', project, '--file', a[part], '--out', project);
    cli('skin', project, '--name', b.name, ...['body', 'head', 'arm-back', 'arm-front', 'leg-back', 'leg-front', 'flag'].flatMap((att) => ['--set', `${att}=${b.name}-${att.replace(/-(back|front)$/, '')}.png`]), '--out', project);
  }
  cli('set-mix', project, '--from', 'idle', '--to', 'wave', '--duration', '0.3', '--out', project);
  const v = cli('validate', project);
  log.push(`valid: ${v.bones} bones, ${v.attachments} attachments, ${v.images.length} images, skins ${v.skins.join(', ')}`);
  const out = path.join(OUT, 'out');
  cli('runtime', project, '--out', path.join(out, 'mascot.runtime.json'));
  cli('atlas', project, '--out', path.join(out, 'atlas'));
  const webm = spawnSync(process.env.RIGSMITH_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  const hasWebm = webm.status === 0 && /\slibvpx-vp9\s/.test(webm.stdout);
  log.push(hasWebm ? 'ffmpeg with libvpx-vp9 found: also writing wave.webm' : 'no ffmpeg/libvpx-vp9: skipping wave.webm (GIF and PNG sequences need nothing extra)');
  for (const b of [{ name: 'base' }, ...config.brands]) {
    const skin = b.name === 'base' ? [] : ['--skin', b.name];
    cli('render', project, '--anim', 'wave', ...skin, '--out', path.join(out, b.name, 'wave.zip'));
    cli('mix', project, '--from', 'idle', '--to', 'wave', '--at', '0.5', ...skin, '--out', path.join(out, b.name, 'idle-to-wave.zip'));
    cli('media', project, '--anim', 'wave', '--format', 'gif', ...skin, '--out', path.join(out, b.name, 'wave.gif'));
    if (hasWebm) cli('media', project, '--anim', 'wave', '--format', 'webm', ...skin, '--out', path.join(out, b.name, 'wave.webm'));
  }
  const manifest = files(out).sort().map((f) => ({ file: path.relative(out, f), bytes: statSync(f).size, sha256: createHash('sha256').update(readFileSync(f)).digest('hex') }));
  writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  writeFileSync(path.join(OUT, 'pipeline-log.txt'), log.join('\n') + '\n');
  process.stdout.write(JSON.stringify({ ok: true, out: path.relative(ROOT, OUT), outputs: manifest.length }) + '\n');
}

await main();
