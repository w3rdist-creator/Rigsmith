// Rigsmith command line. Usage: node scripts/rigsmith.ts <command> [args]  (docs/cli.md)
// Every command prints one JSON object on stdout ({"ok": true, …} or {"ok": false,
// "errors": […]}); progress goes to stderr. Exit codes: 0 ok, 1 invalid input,
// 2 usage, 3 environment (no build / no Chrome for Testing), 4 render failure/cancel.
// Outputs are written atomically (temp file + rename): a failed or cancelled command
// leaves no partial output.
import path from 'node:path';
import type { MissingPolicy } from '../src/model/mix.ts';
import type { Project, ProjectFrame } from '../src/model/types.ts';
import { safeName } from '../src/render/sequence.ts';
import { exportLottie } from '../src/model/lottie.ts';
import type { CliMediaFormat } from './lib/rigsmith-api.ts';
import type { TransformRequest, WeightRequest } from './lib/rigsmith-api.ts';
import { ApiError, EXIT, addImage, addTransform, atlas, encodeMedia, ffmpegEncoder, gridMesh, readProject, replaceImage, runtime, sequenceZip, setMix, setSequence, setSkin, setWeights, summary, withRenderer, writeOutput, writeProject } from './lib/rigsmith-api.ts';

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
          --aim <degrees|hold> [--relative-to <bone>]`;

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

async function main(): Promise<Record<string, unknown>> {
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
      const req =
        cmd === 'sequence'
          ? { kind: 'clips' as const, sequence: need('name'), skin: flag('skin') ?? null, fps: num('fps'), scale: num('scale'), padding: num('padding'), frame }
          : asSequence
          ? { kind: 'sequence' as const, anim: need('anim'), skin: flag('skin') ?? null, fps: num('fps'), start: num('start'), end: num('end'), scale: num('scale'), padding: num('padding'), frame }
          : { kind: 'mix' as const, from: need('from'), to: need('to'), at: num('at') ?? usage('--at is required.'), duration: num('duration'), missing: (flag('missing') ?? 'setup') as MissingPolicy, skin: flag('skin') ?? null, fps: num('fps'), scale: num('scale'), padding: num('padding'), frame };
      const r = await withRenderer((rd) => rd.render(p, req, { onProgress: progress, isCancelled: () => cancelled }));
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

