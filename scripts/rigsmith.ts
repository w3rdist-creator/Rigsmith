// Rigsmith command line. Usage: node scripts/rigsmith.ts <command> [args]  (docs/cli.md)
// Every command prints one JSON object on stdout ({"ok": true, …} or {"ok": false,
// "errors": […]}); progress goes to stderr. Exit codes: 0 ok, 1 invalid input,
// 2 usage, 3 environment (no build / no Chrome for Testing), 4 render failure/cancel.
// Outputs are written atomically (temp file + rename): a failed or cancelled command
// leaves no partial output.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MissingPolicy } from '../src/model/mix.ts';
import type { Project, ProjectFrame } from '../src/model/types.ts';
import { safeName } from '../src/render/sequence.ts';
import { resolveLimits } from '../src/model/sequence.ts';
import { applyClip, exportClip, formatClipSpec, lintClip, parseClipText } from '../src/model/clipSpec.ts';
import type { ClipMode, ClipSpec } from '../src/model/clipSpec.ts';
import { exportLottie } from '../src/model/lottie.ts';
import type { CliMediaFormat } from './lib/rigsmith-api.ts';
import type { TransformRequest, VertexAlphaRequest, WeightRequest } from './lib/rigsmith-api.ts';
import { ApiError, EXIT, addImage, addIkNamed, addTransform, setBind, setInherit, setTint, setVertexAlpha, atlas, encodeMedia, ffmpegEncoder, gridMesh, readProject, replaceImage, runtime, sequenceZip, setMix, setSequence, setSkin, setWeights, summary, withRenderer, writeOutput, writeProject } from './lib/rigsmith-api.ts';

const USAGE = `rigsmith <command> [options]
  validate <project.rig.json>
  info <project.rig.json>
  runtime <project> --out <file.runtime.json>
  atlas <project> --out <dir> [--padding 2] [--bleed 1] [--no-trim] [--pot] [--max 2048]
  render <project> --anim <name> --out <file.zip> [--skin <name>] [--fps N] [--start F] [--end F] [--scale S] [--padding P] [frame]
  mix <project> --from <anim> --to <anim> --at <seconds> --out <file.zip> [--duration S] [--missing setup|hold] [--skin <name>] [--fps N] [frame]
  lottie <project> --anim <name> --out <file.json> [--skin <name>] [frame]
  media <project> --format apng|gif|webm|mp4 (--anim <name> | --from <a> --to <b> --at <s>) --out <file> [render options] [--background #rrggbb] [frame]
  sequence <project> --name <sequence> --out <file> [--format zip|apng|gif|webm|mp4] [--skin <name>] [--fps N] [--scale S] [--padding P] [--background #rrggbb] [frame]
  set-sequence <project> --name <sequence> --steps "idle*2,greeting,idle" [--loop] --out <project>
  frame: --frame project|fit|<x,y,width,height>  (default fit: each export fits its animation)
         --frame-from <other.rig.json>           (use that project's frame, e.g. to align two versions)
  render options (render, mix, media, sequence):
         --max-frames N        raise the 2000-frame cap (at most 20000)
         --max-megapixels M    raise the 600-megapixel total cap (at most 6000)
         --profile-dir <dir>   where the headless browser's throw-away profile goes
                               (default .hermes/browser-profiles/cli; env RIGSMITH_PROFILE_DIR)
  add-image <project> --file <image.png> [--name <name>] --out <project>
  replace-image <project> --image <name> --file <image.png> [--allow-resize] --out <project>
  skin <project> --name <skin> [--set attachment=image ...] [--keyed attachment:fromImage=image ...] --out <project>
  set-mix <project> --from <anim> --to <anim> --duration <s|none> --out <project>
  mesh <project> --att <attachment> --grid <cols>x<rows> --out <project>
  weights <project> --att <attachment> --out <project> (one of:)
          --auto <bone,bone,…> [--max-influences 2]
          --along <upper,lower> [--helper <bone>] --band <inner>/<outer> [--side 1|-1]
                  [--end <bone>:<at>:<band>:<max>] [--root <bone>:<from>:<to>]
          --mirror-from <attachment> --swap <from>=<to>      (e.g. --swap _l=_r)
          [--smooth <passes>] [--smooth-amount 0.5]          (alone: smooth existing weights)
  constrain <project> --bone <bone> --out <project> [--name <n>] [--mix 1] (one of:)
          --copy-rotation <source> [--factor 0.5] [--offset 0] [--mitre <k>:<max>]
          --aim <degrees|hold> [--relative-to <bone>]
  inherit <project> --bone <bone> [--rotation on|off] [--scale on|off] [--reflection on|off] --out <project>
  tint <project> --att <attachment> [--blend normal|additive|screen|multiply] [--color #rrggbb[aa]]
          [--anim <name> --at <seconds>]  (key the colour instead of setting the setup tint) --out <project>
  vertex-alpha <project> --att <attachment> --out <project> (one of:)
          --radial <cx>,<cy>,<inner>,<outer> [--invert]   (image px: 1 inside inner, 0 beyond outer)
          --set <vertex>=<alpha>[,<vertex>=<alpha>…]
          --clear
  bind <project> --att <attachment> [--anim <name> --at <seconds> | --clear] --out <project>
          (bind a weighted mesh at the setup pose, or at an animation frame's pose; --clear: bind at setup)
  ik <project> --bone <bone> [--one-bone] [--bend positive|negative] --out <project>
          (2-bone IK ending at <bone>, target at its tip; the bend side follows the setup elbow unless given)
  clip export <project> --anim <name> --out <clip.yaml|clip.json>
  clip apply <project> --spec <clip.yaml|clip.json> [--replace | --merge] --out <project>
  clip lint <project> --spec <clip.yaml|clip.json> [--merge]
  key <project> --anim <name> --at <frame|Ns> (--bone <b> --channel translate|rotate|scale | --slot <att> --channel opacity|visible|color|image)
          --value <v[,v]> [--ease <name>] [--curve x1,y1,x2,y2] [--ease-y <name>] [--curve-y …] --out <project>
  deform-key <project> --anim <name> --att <attachment> --at <frame|Ns> (--rest | --offsets <file.json>) [--ease <name>] --out <project>
  draw-order <project> --anim <name> --at <frame|Ns> (--order a,b,… | --move <att> (--to front|back | --above <att> | --below <att>)) --out <project>
  constraint-key <project> --anim <name> --constraint <name> --channel mix|position|angle --at <frame|Ns> --value <v> [--ease <name>] --out <project>
  (times: a number is a frame, "0.25s" is seconds; specs: docs/cli.md → Clip specs)`;

type Args = { _: string[]; flags: Record<string, string[]> };

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next === undefined || next.startsWith('--') ? 'true' : (i++, next);
      (out.flags[key] ??= []).push(value);
    } else out._.push(a);
  }
  return out;
}

function usage(msg: string): never {
  throw new ApiError(msg, [msg, USAGE], EXIT.usage);
}

const args = parseArgs(process.argv.slice(2));
const flag = (k: string): string | undefined => args.flags[k]?.at(-1);
const need = (k: string): string => flag(k) ?? usage(`--${k} is required.`);
const num = (k: string): number | undefined => {
  const v = flag(k);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) usage(`--${k} must be a number (got “${v}”).`);
  return n;
};
const pairs = (k: string, sep: string): Record<string, string> =>
  Object.fromEntries((args.flags[k] ?? []).map((s) => {
    const i = s.lastIndexOf(sep);
    if (i <= 0) usage(`--${k} expects name${sep}value (got “${s}”).`);
    return [s.slice(0, i), s.slice(i + 1)];
  }));

/** The fixed frame selected by --frame / --frame-from (null = fit each export to its animation). */
function frameOption(p: Project): ProjectFrame | null {
  const from = flag('frame-from');
  const f = flag('frame');
  if (from !== undefined && f !== undefined) usage('Use either --frame or --frame-from, not both.');
  if (from !== undefined) {
    const other = readProject(from);
    if (!other.frame) throw new ApiError(`${from} has no project frame.`, [`${from} has no project frame (set one in the editor: Project ▸ Frame).`]);
    return other.frame;
  }
  if (f === undefined || f === 'fit') return null;
  if (f === 'project') {
    if (!p.frame) throw new ApiError('The project has no frame.', ['The project has no frame (set one in the editor: Project ▸ Frame), or use --frame x,y,width,height.']);
    return p.frame;
  }
  const v = f.split(',').map(Number);
  if (v.length !== 4 || !v.every(Number.isFinite) || !(v[2] >= 1) || !(v[3] >= 1)) usage(`--frame must be project, fit or x,y,width,height (got “${f}”).`);
  return { x: v[0], y: v[1], width: v[2], height: v[3] };
}

let cancelled = false;
process.on('SIGINT', () => {
  cancelled = true;
  process.stderr.write('\ncancelling…\n');
});
const progress = (done: number, total: number) => process.stderr.write(`\rframe ${done}/${total}`);

/** --at / spec times: a number is a frame, "<n>s" seconds. */
const atFlag = (): number | string => {
  const v = need('at');
  return /s$/.test(v) ? v : Number.isFinite(Number(v)) ? Number(v) : usage(`--at must be a frame number or "<seconds>s" (got “${v}”).`);
};
const curveFlag = (k: string): number[] | undefined => {
  const v = flag(k);
  if (v === undefined) return undefined;
  const c = v.split(',').map(Number);
  if (c.length !== 4 || !c.every(Number.isFinite)) usage(`--${k} expects x1,y1,x2,y2.`);
  return c;
};

/** Applies a spec (one code path for clip apply and the single-key commands); exit 1 with every problem. */
function applySpec(p: Project, spec: ClipSpec, mode: ClipMode): Project {
  const r = applyClip(p, spec, mode);
  if (!r.ok) throw new ApiError('The clip spec does not fit this project', r.errors);
  return r.project;
}

/** One key as a merge spec for the existing animation --anim. */
function singleKeySpec(cmd: string): ClipSpec {
  const name = need('anim');
  const at = atFlag();
  const ease = flag('ease'), curve = curveFlag('curve');
  const easeFields = { ...(ease !== undefined ? { ease } : {}), ...(curve ? { curve } : {}) };
  if (cmd === 'deform-key') {
    if ((flag('rest') === undefined) === (flag('offsets') === undefined)) usage('deform-key: give --rest or --offsets <file.json>.');
    const value = flag('rest') !== undefined ? 'rest' : JSON.parse(readFileSync(need('offsets'), 'utf8'));
    return { name, slots: { [need('att')]: { deform: [{ at, value, ...easeFields }] } } };
  }
  if (cmd === 'draw-order') {
    const order = flag('order');
    if ((order === undefined) === (flag('move') === undefined)) usage('draw-order: give --order a,b,… or --move <att> with --to, --above or --below.');
    if (order !== undefined) return { name, drawOrder: [{ at, order: order.split(',') }] };
    const dest = (['to', 'above', 'below'] as const).filter((k) => flag(k) !== undefined);
    if (dest.length !== 1) usage('draw-order --move: give exactly one of --to front|back, --above <att>, --below <att>.');
    return { name, drawOrder: [{ at, move: need('move'), [dest[0]]: need(dest[0]) }] };
  }
  const raw = need('value');
  const nums = raw.split(',').map(Number);
  const numeric = nums.every(Number.isFinite);
  if (cmd === 'constraint-key') {
    if (!numeric || nums.length !== 1) usage('--value: one number.');
    return { name, constraints: { [need('constraint')]: { [need('channel')]: [{ at, value: nums[0], ...easeFields }] } } };
  }
  const ch = need('channel');
  if (flag('bone') !== undefined) {
    if (!numeric) usage('--value: numbers, comma-separated (translate/scale x,y).');
    const easeY = flag('ease-y'), curveY = curveFlag('curve-y');
    const yFields = { ...(easeY !== undefined ? { easeY } : {}), ...(curveY ? { curveY } : {}) };
    return { name, bones: { [need('bone')]: { [ch]: [{ at, value: nums.length === 1 ? nums[0] : nums, ...easeFields, ...yFields }] } } };
  }
  const slot = flag('slot') ?? usage('key: give --bone or --slot.');
  if (ch === 'image') return { name, slots: { [slot]: { image: [[at, raw]] } } };
  const value = ch === 'visible' ? (raw === 'true' ? true : raw === 'false' ? false : usage('--value for visible: true or false.')) : ch === 'color' && raw.startsWith('#') ? raw : numeric ? (nums.length === 1 ? nums[0] : nums) : usage(`--value: numbers${ch === 'color' ? ' or #rrggbb[aa]' : ''}.`);
  return { name, slots: { [slot]: { [ch]: [{ at, value, ...easeFields }] } } };
}

function readSpec(): ClipSpec {
  const file = need('spec');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new ApiError(`No such file: ${file}`, undefined, EXIT.usage);
  }
  const r = parseClipText(text, file);
  if (!r.ok) throw new ApiError(`${path.basename(file)} is not a valid clip spec`, r.errors);
  return r.spec;
}

async function main(): Promise<Record<string, unknown>> {
  if (args._[0] === 'clip') {
    const sub = args._[1];
    const file = args._[2];
    if (!['export', 'apply', 'lint'].includes(sub ?? '')) usage('clip: export, apply or lint.');
    if (!file) usage(`clip ${sub}: give a project file.`);
    const p = readProject(file);
    if (sub === 'export') {
      const out = need('out');
      const anim = p.animations.find((a) => a.name === need('anim'));
      if (!anim) throw new ApiError(`No animation named “${flag('anim')}”.`, [`No animation named “${flag('anim')}”.`]);
      let spec: ClipSpec;
      try {
        spec = exportClip(p, anim.id);
      } catch (e) {
        throw new ApiError((e as Error).message, [(e as Error).message]);
      }
      writeOutput(out, formatClipSpec(spec, /\.json$/i.test(out)));
      return { outputs: [out], animation: anim.name };
    }
    const spec = readSpec();
    const mode: ClipMode = flag('merge') !== undefined ? 'merge' : flag('replace') !== undefined || sub === 'lint' ? 'replace' : 'create';
    if (flag('merge') !== undefined && flag('replace') !== undefined) usage('clip: --replace or --merge, not both.');
    if (sub === 'lint') {
      const problems = lintClip(p, spec, mode);
      if (problems.length) throw new ApiError(`${problems.length} problem(s) in the clip spec`, problems);
      return { clean: true, animation: spec.name };
    }
    const out = need('out');
    const r = applyClip(p, spec, mode);
    if (!r.ok) throw new ApiError('The clip spec does not fit this project', r.errors);
    writeProject(out, r.project);
    return { outputs: [out], animation: spec.name, created: r.created, keys: r.keys, mode };
  }
  const [cmd, file] = args._;
  if (!cmd || cmd === 'help' || flag('help')) usage('Choose a command.');
  if (!file) usage(`${cmd}: give a project file.`);
  const p = readProject(file);
  switch (cmd) {
    case 'validate':
      return { valid: true, ...summary(p) };
    case 'info':
      return summary(p);
    case 'runtime': {
      const out = need('out');
      const rt = runtime(p);
      writeOutput(out, JSON.stringify(rt, null, 1));
      return { outputs: [out], version: rt.version, animations: rt.animations.length };
    }
    case 'atlas': {
      const dir = need('out');
      const a = await atlas(p, {
        ...(num('padding') !== undefined ? { padding: num('padding') } : {}),
        ...(num('bleed') !== undefined ? { bleed: num('bleed') } : {}),
        ...(num('max') !== undefined ? { maxSize: num('max') } : {}),
        trim: !flag('no-trim'),
        pot: !!flag('pot'),
      });
      const outputs = [];
      for (const pg of a.pages) {
        const f = path.join(dir, pg.file);
        writeOutput(f, pg.data);
        outputs.push(f);
      }
      const metaFile = path.join(dir, `${safeName(p.name)}.atlas.json`);
      writeOutput(metaFile, JSON.stringify(a.meta, null, 1));
      return { outputs: [metaFile, ...outputs], pages: a.meta.pages, regions: a.meta.regions.length };
    }
    case 'render':
    case 'mix':
    case 'media':
    case 'sequence': {
      const out = need('out');
      const format = (cmd === 'media' ? need('format') : cmd === 'sequence' ? (flag('format') ?? 'zip') : 'zip') as CliMediaFormat | 'zip';
      if (!['zip', 'apng', 'gif', 'webm', 'mp4'].includes(format)) usage(`--format must be apng, gif, webm or mp4 (got “${format}”).`);
      // Fail before rendering when ffmpeg / the encoder is missing.
      if (format === 'webm' || format === 'mp4') ffmpegEncoder(format);
      const bgFlag = flag('background');
      if (bgFlag !== undefined && !/^#[0-9a-f]{6}$/i.test(bgFlag)) usage(`--background must be #rrggbb (got “${bgFlag}”).`);
      const asSequence = cmd === 'render' || (cmd === 'media' && !flag('from'));
      const frame = frameOption(p);
      const limits = { maxFrames: num('max-frames'), maxMegapixels: num('max-megapixels') };
      const lim = resolveLimits(limits);
      if (!lim.ok) usage(lim.errors.join(' '));
      const req =
        cmd === 'sequence'
          ? { kind: 'clips' as const, sequence: need('name'), skin: flag('skin') ?? null, fps: num('fps'), scale: num('scale'), padding: num('padding'), frame, limits }
          : asSequence
          ? { kind: 'sequence' as const, anim: need('anim'), skin: flag('skin') ?? null, fps: num('fps'), start: num('start'), end: num('end'), scale: num('scale'), padding: num('padding'), frame, limits }
          : { kind: 'mix' as const, from: need('from'), to: need('to'), at: num('at') ?? usage('--at is required.'), duration: num('duration'), missing: (flag('missing') ?? 'setup') as MissingPolicy, skin: flag('skin') ?? null, fps: num('fps'), scale: num('scale'), padding: num('padding'), frame, limits };
      const r = await withRenderer((rd) => rd.render(p, req, { onProgress: progress, isCancelled: () => cancelled }), { profileDir: flag('profile-dir') });
      process.stderr.write('\n');
      for (const w of r.warnings) process.stderr.write(`warning: ${w}\n`);
      if (format !== 'zip') {
        const m = await encodeMedia(r, format, out, { background: flag('background'), isCancelled: () => cancelled, onProgress: (d, t) => process.stderr.write(`\rencode ${d}/${t}`) });
        process.stderr.write('\n');
        return { outputs: [out], animation: r.meta.animation, fps: r.meta.fps, ...m.stats, frame: r.meta.frame, ...(cmd === 'sequence' ? { frames: r.files.length, sequence: r.meta.sequence } : {}), warnings: r.warnings };
      }
      writeOutput(out, sequenceZip(r));
      return { outputs: [out], frames: r.files.length, width: r.meta.width, height: r.meta.height, animation: r.meta.animation, frame: r.meta.frame, ...(cmd === 'sequence' ? { sequence: r.meta.sequence } : {}), warnings: r.warnings };
    }
    case 'lottie': {
      const out = need('out');
      const r = exportLottie(p, need('anim'), flag('skin') ?? null, frameOption(p));
      if (!r.ok) throw new ApiError('Not exportable as the Lottie subset', r.errors);
      writeOutput(out, JSON.stringify(r.lottie));
      return { outputs: [out], diagnostics: r.diagnostics };
    }
    case 'add-image': {
      const out = need('out');
      const im = await addImage(p, need('file'), flag('name'));
      writeProject(out, p);
      return { outputs: [out], image: { name: im.name, width: im.width, height: im.height } };
    }
    case 'replace-image': {
      const out = need('out');
      const im = await replaceImage(p, need('image'), need('file'), !!flag('allow-resize'));
      writeProject(out, p);
      return { outputs: [out], image: { name: im.name, width: im.width, height: im.height } };
    }
    case 'skin': {
      const out = need('out');
      setSkin(p, need('name'), pairs('set', '='), pairs('keyed', '='));
      writeProject(out, p);
      return { outputs: [out], skins: (p.skins ?? []).map((s) => ({ name: s.name, entries: s.entries.length })) };
    }
    case 'set-sequence': {
      const out = need('out');
      const seq = setSequence(p, need('name'), need('steps'), !!flag('loop'));
      writeProject(out, p);
      return { outputs: [out], sequence: { name: seq.name, loop: seq.loop, steps: seq.steps.map((st) => ({ animation: p.animations.find((a) => a.id === st.animId)!.name, repeat: st.repeat })) } };
    }
    case 'set-mix': {
      const out = need('out');
      const d = need('duration');
      setMix(p, need('from'), need('to'), d === 'none' ? null : Number(d));
      writeProject(out, p);
      return { outputs: [out], mixes: p.mixes ?? [] };
    }
    case 'mesh': {
      const out = need('out');
      const g = /^(\d+)x(\d+)$/.exec(need('grid')) ?? usage('--grid must be <cols>x<rows>, e.g. 2x28.');
      const mesh = gridMesh(p, need('att'), Number(g[1]), Number(g[2]));
      writeProject(out, p);
      return { outputs: [out], attachment: flag('att'), mesh };
    }
    case 'weights': {
      const out = need('out');
      const picked = ['auto', 'along', 'mirror-from'].filter((k) => flag(k) !== undefined);
      if (picked.length > 1) usage('Use one of --auto, --along or --mirror-from.');
      const triple = (k: string, n: number): string[] => {
        const v = need(k).split(':');
        if (v.length !== n) usage(`--${k} expects ${n} colon-separated fields (got “${flag(k)}”).`);
        return v;
      };
      const number = (k: string, v: string): number => {
        const x = Number(v);
        if (!Number.isFinite(x)) usage(`--${k}: “${v}” is not a number.`);
        return x;
      };
      let req: WeightRequest = { kind: 'none' };
      if (flag('auto') !== undefined) req = { kind: 'auto', bones: need('auto').split(',').filter(Boolean), maxInfluences: num('max-influences') };
      else if (flag('mirror-from') !== undefined) {
        const sw = need('swap').split('=');
        if (sw.length !== 2 || !sw[0]) usage('--swap expects <from>=<to>, e.g. _l=_r.');
        req = { kind: 'mirror', from: need('mirror-from'), swap: [sw[0], sw[1]] };
      } else if (flag('along') !== undefined) {
        const chain = need('along').split(',');
        if (chain.length !== 2) usage('--along expects <upper>,<lower>.');
        const band = need('band').split('/');
        if (band.length !== 2) usage('--band expects <inner>/<outer>, e.g. 36/50.');
        const side = num('side') ?? 1;
        if (side !== 1 && side !== -1) usage('--side must be 1 or -1.');
        const e = flag('end') !== undefined ? triple('end', 4) : null;
        const r = flag('root') !== undefined ? triple('root', 3) : null;
        req = {
          kind: 'limb', upper: chain[0], lower: chain[1], helper: flag('helper'),
          band: { inner: number('band', band[0]), outer: number('band', band[1]), side: side as 1 | -1 },
          ...(e ? { end: { bone: e[0], at: number('end', e[1]), band: number('end', e[2]), max: number('end', e[3]) } } : {}),
          ...(r ? { root: { bone: r[0], from: number('root', r[1]), to: number('root', r[2]) } } : {}),
        };
      } else if (flag('smooth') === undefined) usage('weights: give --auto, --along, --mirror-from or --smooth.');
      const passes = num('smooth');
      const res = setWeights(p, need('att'), req, passes !== undefined ? { passes, amount: num('smooth-amount') } : undefined);
      writeProject(out, p);
      return { outputs: [out], attachment: flag('att'), mode: req.kind, ...(passes !== undefined ? { smoothed: passes } : {}), ...res };
    }
    case 'inherit': {
      const out = need('out');
      const change: Record<string, boolean> = {};
      for (const k of ['rotation', 'scale', 'reflection']) {
        const v = flag(k);
        if (v === undefined) continue;
        if (v !== 'on' && v !== 'off') usage(`--${k} must be on or off (got “${v}”).`);
        change[k] = v === 'on';
      }
      if (!Object.keys(change).length) usage('inherit: give at least one of --rotation, --scale or --reflection.');
      const inherit = setInherit(p, need('bone'), change);
      writeProject(out, p);
      return { outputs: [out], bone: flag('bone'), inherit };
    }
    case 'tint': {
      const out = need('out');
      if (flag('blend') === undefined && flag('color') === undefined) usage('tint: give --blend and/or --color.');
      if ((flag('anim') === undefined) !== (flag('at') === undefined)) usage('tint: --anim and --at go together.');
      const at = num('at');
      const res = setTint(p, need('att'), { blend: flag('blend'), color: flag('color'), ...(flag('anim') !== undefined ? { key: { anim: need('anim'), time: at! } } : {}) });
      writeProject(out, p);
      return { outputs: [out], attachment: flag('att'), ...res };
    }
    case 'vertex-alpha': {
      const out = need('out');
      const modes = ['radial', 'set', 'clear'].filter((k) => flag(k) !== undefined);
      if (modes.length !== 1) usage('vertex-alpha: give exactly one of --radial, --set or --clear.');
      let req: VertexAlphaRequest;
      if (modes[0] === 'radial') {
        const v = need('radial').split(',').map(Number);
        if (v.length !== 4 || !v.every(Number.isFinite)) usage('--radial expects <cx>,<cy>,<inner>,<outer>.');
        req = { kind: 'radial', cx: v[0], cy: v[1], r0: v[2], r1: v[3], invert: flag('invert') !== undefined };
      } else if (modes[0] === 'set') {
        const values = need('set').split(',').map((pair) => pair.split('=').map(Number) as [number, number]);
        if (!values.every((x) => x.length === 2 && x.every(Number.isFinite))) usage('--set expects <vertex>=<alpha>[,…].');
        req = { kind: 'set', values };
      } else req = { kind: 'clear' };
      const res = setVertexAlpha(p, need('att'), req);
      writeProject(out, p);
      return { outputs: [out], attachment: flag('att'), mode: req.kind, ...res };
    }
    case 'bind': {
      const out = need('out');
      if (flag('clear') !== undefined && flag('anim') !== undefined) usage('bind: --clear and --anim exclude each other.');
      if ((flag('anim') === undefined) !== (flag('at') === undefined)) usage('bind: --anim and --at go together.');
      const res = setBind(p, need('att'), { clear: flag('clear') !== undefined, anim: flag('anim'), at: num('at') });
      writeProject(out, p);
      return { outputs: [out], attachment: flag('att'), ...res };
    }
    case 'ik': {
      const out = need('out');
      const bend = flag('bend');
      if (bend !== undefined && bend !== 'positive' && bend !== 'negative') usage(`--bend must be positive or negative (got “${bend}”).`);
      if (bend !== undefined && flag('one-bone') !== undefined) usage('--bend applies to 2-bone IK only.');
      const res = addIkNamed(p, need('bone'), { oneBone: flag('one-bone') !== undefined, bend: bend as 'positive' | 'negative' | undefined });
      writeProject(out, p);
      return { outputs: [out], ik: res };
    }
    case 'key':
    case 'deform-key':
    case 'draw-order':
    case 'constraint-key': {
      const out = need('out');
      const spec = singleKeySpec(cmd);
      writeProject(out, applySpec(p, spec, 'merge'));
      return { outputs: [out], animation: spec.name };
    }
    case 'constrain': {
      const out = need('out');
      const copy = flag('copy-rotation'), aim = flag('aim');
      if ((copy === undefined) === (aim === undefined)) usage('constrain: give exactly one of --copy-rotation or --aim.');
      let req: TransformRequest;
      if (copy !== undefined) {
        const m = flag('mitre') !== undefined ? need('mitre').split(':').map(Number) : null;
        if (m && (m.length !== 2 || !m.every(Number.isFinite))) usage('--mitre expects <k>:<max>, e.g. 0.7:1.5.');
        req = { kind: 'rotation', bone: need('bone'), source: copy, factor: num('factor') ?? 0.5, offset: num('offset') ?? 0, ...(m ? { mitre: { k: m[0], max: m[1] } } : {}), name: flag('name'), mix: num('mix') ?? 1 };
      } else {
        const a = aim === 'hold' ? 'hold' : Number(aim);
        if (a !== 'hold' && !Number.isFinite(a)) usage(`--aim expects degrees or "hold" (got “${aim}”).`);
        req = { kind: 'aim', bone: need('bone'), angle: a, relativeTo: flag('relative-to'), name: flag('name'), mix: num('mix') ?? 1 };
      }
      const res = addTransform(p, req);
      writeProject(out, p);
      return { outputs: [out], constraint: res };
    }
    default:
      return usage(`Unknown command “${cmd}”.`);
  }
}

main().then(
  (r) => {
    process.stdout.write(JSON.stringify({ ok: true, command: args._[0], ...r }, null, 1) + '\n');
    process.exit(EXIT.ok);
  },
  (e) => {
    const err = e instanceof ApiError ? e : new ApiError((e as Error).message ?? String(e), undefined, EXIT.failed);
    process.stdout.write(JSON.stringify({ ok: false, command: args._[0] ?? null, error: err.message, errors: err.errors }, null, 1) + '\n');
    process.exit(err.code);
  },
);

