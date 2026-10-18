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
import { ApiError, EXIT, addImage, atlas, encodeMedia, ffmpegEncoder, readProject, replaceImage, runtime, sequenceZip, setMix, setSkin, summary, withRenderer, writeOutput, writeProject } from './lib/rigsmith-api.ts';

const USAGE = `rigsmith <command> [options]
  validate <project.rig.json>
  info <project.rig.json>
  runtime <project> --out <file.runtime.json>
  atlas <project> --out <dir> [--padding 2] [--bleed 1] [--no-trim] [--pot] [--max 2048]
  render <project> --anim <name> --out <file.zip> [--skin <name>] [--fps N] [--start F] [--end F] [--scale S] [--padding P] [frame]
  mix <project> --from <anim> --to <anim> --at <seconds> --out <file.zip> [--duration S] [--missing setup|hold] [--skin <name>] [--fps N] [frame]
  lottie <project> --anim <name> --out <file.json> [--skin <name>] [frame]
  media <project> --format apng|gif|webm|mp4 (--anim <name> | --from <a> --to <b> --at <s>) --out <file> [render options] [--background #rrggbb] [frame]
  frame: --frame project|fit|<x,y,width,height>  (default fit: each export fits its animation)
         --frame-from <other.rig.json>           (use that project's frame, e.g. to align two versions)
  add-image <project> --file <image.png> [--name <name>] --out <project>
  replace-image <project> --image <name> --file <image.png> [--allow-resize] --out <project>
  skin <project> --name <skin> [--set attachment=image ...] [--keyed attachment:fromImage=image ...] --out <project>
  set-mix <project> --from <anim> --to <anim> --duration <s|none> --out <project>`;

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
    case 'media': {
      const out = need('out');
      const format = (cmd === 'media' ? need('format') : 'zip') as CliMediaFormat | 'zip';
      if (!['zip', 'apng', 'gif', 'webm', 'mp4'].includes(format)) usage(`--format must be apng, gif, webm or mp4 (got “${format}”).`);
      // Fail before rendering when ffmpeg / the encoder is missing.
      if (format === 'webm' || format === 'mp4') ffmpegEncoder(format);
      const bgFlag = flag('background');
      if (bgFlag !== undefined && !/^#[0-9a-f]{6}$/i.test(bgFlag)) usage(`--background must be #rrggbb (got “${bgFlag}”).`);
      const asSequence = cmd === 'render' || (cmd === 'media' && !flag('from'));
      const frame = frameOption(p);
      const req =
        asSequence
          ? { kind: 'sequence' as const, anim: need('anim'), skin: flag('skin') ?? null, fps: num('fps'), start: num('start'), end: num('end'), scale: num('scale'), padding: num('padding'), frame }
          : { kind: 'mix' as const, from: need('from'), to: need('to'), at: num('at') ?? usage('--at is required.'), duration: num('duration'), missing: (flag('missing') ?? 'setup') as MissingPolicy, skin: flag('skin') ?? null, fps: num('fps'), scale: num('scale'), padding: num('padding'), frame };
      const r = await withRenderer((rd) => rd.render(p, req, { onProgress: progress, isCancelled: () => cancelled }));
      process.stderr.write('\n');
      for (const w of r.warnings) process.stderr.write(`warning: ${w}\n`);
      if (format !== 'zip') {
        const m = await encodeMedia(r, format, out, { background: flag('background'), isCancelled: () => cancelled, onProgress: (d, t) => process.stderr.write(`\rencode ${d}/${t}`) });
        process.stderr.write('\n');
        return { outputs: [out], animation: r.meta.animation, fps: r.meta.fps, ...m.stats, frame: r.meta.frame, warnings: r.warnings };
      }
      writeOutput(out, sequenceZip(r));
      return { outputs: [out], frames: r.files.length, width: r.meta.width, height: r.meta.height, animation: r.meta.animation, frame: r.meta.frame, warnings: r.warnings };
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
    case 'set-mix': {
      const out = need('out');
      const d = need('duration');
      setMix(p, need('from'), need('to'), d === 'none' ? null : Number(d));
      writeProject(out, p);
      return { outputs: [out], mixes: p.mixes ?? [] };
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

