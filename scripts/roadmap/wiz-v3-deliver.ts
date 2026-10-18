// Wiz v3 delivery (use-case review §6.4–6.5), from the UI-built project and the dialog
// exports that scripts/roadmap/wiz-v3.ts saved in .hermes/assets/wiz/v3-output/:
//   rigsmith render / mix at --frame project → byte-identical to the dialog ZIPs;
//   rigsmith media → WebM (VP9 alpha) and MP4 (H.264, no alpha) of both loops and the mix,
//   APNG of the mix; every file decoded independently (Pillow / ffmpeg, libvpx-vp9 for the
//   WebM alpha) and compared with the PNG frames;
//   v2 idle / greeting-v2 (wiz-v2.rig.json, read only) and v3 rendered on one explicit
//   frame (v3 project frame ∪ fitted v2 frames) → aligned before/after sheets;
//   rigsmith lottie of the flat greeting-demo, and the refusal of the meshed IK v3.
// Writes .hermes/assets/wiz/v3-output/delivery/ (git-ignored) with MANIFEST.json (sha256).
// Usage: node scripts/roadmap/wiz-v3-deliver.ts   (after wiz-v3.ts)
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from '../../tests/support/png-decode.ts';
import { ffprobe, pillow } from '../../tests/support/media-check.ts';
import { readZip } from '../../tests/support/zip-read.ts';
import { ROOT, WIZ } from '../wiz/paths.ts';

const V2_FILE = path.join(WIZ, 'roadmap-output/wiz-v2.rig.json');
const V3_OUT = path.join(WIZ, 'v3-output');
const V3_FILE = path.join(V3_OUT, 'wiz-v3.rig.json');
const OUT = path.join(V3_OUT, 'delivery');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const v2Sha = sha(readFileSync(V2_FILE));
const lines: string[] = [];
const log = (m: string) => {
  console.log(m);
  lines.push(m);
};

function cli(...args: string[]): any {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, `rigsmith ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.warnings ?? [], [], `rigsmith ${args[0]}: no warnings`);
  return j;
}

function zipFrames(file: string): { meta: any; pngs: ReturnType<typeof decodePng>[] } {
  const files = readZip(readFileSync(file));
  const meta = JSON.parse(files.find((f) => f.name.endsWith('sequence.json'))!.data.toString('utf8'));
  return { meta, pngs: files.filter((f) => f.name.endsWith('.png')).sort((a, b) => a.name.localeCompare(b.name)).map((f) => decodePng(f.data)) };
}

/** One frame of a video as straight RGBA (VP9 alpha needs the libvpx decoder before -i). */
function videoFrame(file: string, index: number, w: number, h: number, vp9Alpha: boolean): Uint8Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', ...(vp9Alpha ? ['-c:v', 'libvpx-vp9'] : []), '-i', file, '-vf', `select=eq(n\\,${index})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, r.stderr.toString());
  assert.equal(r.stdout.length, w * h * 4, `${path.basename(file)} frame ${index}: one whole frame`);
  return new Uint8Array(r.stdout);
}

/**
 * Mean |Δ| over premultiplied RGB + alpha (WebM) or over RGB composited on `bg` (MP4), on
 * the PNG's w×h area (the video may be padded to even size: `gw` is its row width).
 */
function meanDiff(got: Uint8Array, gw: number, png: { width: number; height: number; data: Uint8Array }, bg: number[] | null): { mean: number; nonOpaque: number } {
  let sum = 0, nonOpaque = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4, a = png.data[o + 3] / 255;
    const g = ((Math.floor(i / png.width) * gw) + (i % png.width)) * 4;
    if (got[g + 3] < 255) nonOpaque++;
    if (bg) for (let c = 0; c < 3; c++) sum += Math.abs(got[g + c] - (png.data[o + c] * a + bg[c] * (1 - a)));
    else {
      const ga = got[g + 3] / 255;
      for (let c = 0; c < 3; c++) sum += Math.abs(got[g + c] * ga - png.data[o + c] * a);
      sum += Math.abs(got[g + 3] - png.data[o + 3]);
    }
  }
  return { mean: sum / (n * (bg ? 3 : 4)), nonOpaque };
}

const v3 = JSON.parse(readFileSync(V3_FILE, 'utf8'));
log(`project: ${path.relative(ROOT, V3_FILE)} — frame ${v3.frame.width}×${v3.frame.height} at (${v3.frame.x}, ${v3.frame.y})`);

// ---- CLI sequences = dialog exports ---------------------------------------------------
const seqs: Record<string, string> = {};
for (const anim of ['idle-v3', 'greeting-v3']) {
  const file = path.join(OUT, `${anim}.seq.zip`);
  cli('render', V3_FILE, '--anim', anim, '--frame', 'project', '--out', file);
  assert.ok(readFileSync(file).equals(readFileSync(path.join(V3_OUT, `${anim}.seq.zip`))), `${anim}: CLI render = dialog ZIP`);
  seqs[anim] = file;
  log(`${anim}.seq.zip: rigsmith render --frame project is byte-identical to the Export sequence… ZIP`);
}
const mixArgs = ['--from', 'idle-v3', '--to', 'greeting-v3', '--at', '1'];
const mixZip = path.join(OUT, 'idle-v3-to-greeting-v3.seq.zip');
cli('mix', V3_FILE, ...mixArgs, '--frame', 'project', '--out', mixZip);
assert.ok(readFileSync(mixZip).equals(readFileSync(path.join(V3_OUT, 'idle-v3-to-greeting-v3.seq.zip'))), 'mix: CLI = Mix… dialog ZIP');
seqs.mix = mixZip;
log('idle-v3-to-greeting-v3.seq.zip: rigsmith mix --at 1 (stored 0.3 s rule) --frame project is byte-identical to the Mix… dialog ZIP');

// ---- Media -----------------------------------------------------------------------------
const media: [string, string[], string][] = [
  ['idle-v3', ['--anim', 'idle-v3'], seqs['idle-v3']],
  ['greeting-v3', ['--anim', 'greeting-v3'], seqs['greeting-v3']],
  ['idle-v3-to-greeting-v3', mixArgs, mixZip],
];
const BG = '#ffffff';
for (const [name, sel, zip] of media) {
  const { meta, pngs } = zipFrames(zip);
  const [w, h] = [meta.width, meta.height];
  const formats = name.includes('-to-') ? (['apng', 'webm', 'mp4'] as const) : (['webm', 'mp4'] as const);
  for (const format of formats) {
    const file = path.join(OUT, `${name}.${format === 'apng' ? 'apng' : format}`);
    const j = cli('media', V3_FILE, '--format', format, ...sel, '--frame', 'project', ...(format === 'mp4' ? ['--background', BG] : []), '--out', file);
    if (format === 'apng') {
      const { info, frames } = pillow(file);
      assert.equal(info.frames, pngs.length);
      frames.forEach((f, i) => assert.ok(Buffer.from(f).equals(Buffer.from(pngs[i].data)), `${name}.apng frame ${i} = PNG frame (lossless)`));
      rmSync(`${file}.decoded`, { recursive: true, force: true });
      log(`${name}.apng: ${info.frames} frames ${w}×${h}, Pillow-decoded frames identical to the PNG sequence (lossless, full alpha)`);
      continue;
    }
    const pr = ffprobe(file);
    const [vw, vh] = format === 'mp4' ? [w + (w % 2), h + (h % 2)] : [w, h];
    assert.deepEqual([pr.width, pr.height, pr.frames], [vw, vh, pngs.length], `${name}.${format} stream`);
    const probes = [0, Math.floor(pngs.length / 3), Math.floor((2 * pngs.length) / 3)];
    const stats = probes.map((i) => ({ i, ...meanDiff(videoFrame(file, i, vw, vh, format === 'webm'), vw, pngs[i], format === 'mp4' ? [255, 255, 255] : null) }));
    if (format === 'webm') for (const s of stats) assert.ok(s.nonOpaque > 0.5 * w * h, `${name}.webm frame ${s.i}: alpha decoded (libvpx-vp9): ${s.nonOpaque} non-opaque px`);
    for (const s of stats) assert.ok(s.mean < 3, `${name}.${format} frame ${s.i}: mean |Δ| ${s.mean.toFixed(3)} vs PNG`);
    log(`${name}.${format}: ${pr.codec} ${vw}×${vh} ${pr.frames} frames @ ${pr.rate}; ${format === 'webm' ? 'alpha via libvpx-vp9 decode' : `no alpha, composited on ${BG}`}; mean |Δ| vs PNG at frames ${stats.map((s) => `${s.i}: ${s.mean.toFixed(2)}`).join(', ')}${format === 'webm' ? `; non-opaque px ${stats.map((s) => s.nonOpaque).join(' / ')} of ${w * h}` : ''} — ${j.label}`);
  }
}

// ---- v2 and v3 on one canvas, before/after sheets ---------------------------------------
// greeting-v2 reaches outside the v3 project frame (rigsmith warns and would clip it), so
// the comparison uses one explicit frame: the v3 project frame ∪ the fitted v2 frames.
// The delivered v3 files above stay on the v3 project frame.
const tmp = path.join(OUT, '.fit');
mkdirSync(tmp);
let U = { x0: v3.frame.x, y0: v3.frame.y, x1: v3.frame.x + v3.frame.width, y1: v3.frame.y + v3.frame.height };
for (const anim of ['idle', 'greeting-v2']) {
  const j = cli('render', V2_FILE, '--anim', anim, '--out', path.join(tmp, `${anim}.zip`));
  const { meta } = zipFrames(j.outputs[0]);
  U = { x0: Math.min(U.x0, meta.origin.x), y0: Math.min(U.y0, meta.origin.y), x1: Math.max(U.x1, meta.origin.x + meta.width), y1: Math.max(U.y1, meta.origin.y + meta.height) };
}
rmSync(tmp, { recursive: true });
const rect = `${U.x0},${U.y0},${U.x1 - U.x0},${U.y1 - U.y0}`;
const cmp: Record<string, string> = {};
for (const [label, file, anim] of [['v2-idle', V2_FILE, 'idle'], ['v2-greeting-v2', V2_FILE, 'greeting-v2'], ['v3-idle-v3', V3_FILE, 'idle-v3'], ['v3-greeting-v3', V3_FILE, 'greeting-v3']] as const) {
  cmp[label] = path.join(OUT, `compare-${label}.seq.zip`);
  cli('render', file, '--anim', anim, '--frame', rect, '--out', cmp[label]);
}
log(`compare-*.seq.zip: v2 idle / greeting-v2 (wiz-v2.rig.json, read only) and v3 idle-v3 / greeting-v3 rendered on one frame ${rect} (v3 project frame ∪ fitted v2 frames; no clipping warnings)`);
const sheet = (out: string, frames: string, rows: string[]) =>
  execFileSync('python3', ['-I', path.join(ROOT, 'scripts/roadmap/contact_sheet.py'), path.join(OUT, out), ...rows, '--frames', frames, '--cell', '260', '--crop'], { stdio: ['ignore', 'inherit', 'inherit'] });
sheet('greeting-v2-vs-v3.png', '0,4,8,10,15,18,24,30,36,48,60,66', [`greeting-v2 (FK, rigid parts)=${cmp['v2-greeting-v2']}`, `greeting-v3 (IK + meshes, same frames)=${cmp['v3-greeting-v3']}`]);
sheet('idle-v2-vs-v3.png', '0,15,30,40,45,50,60,75,89', [`idle (v2, FK)=${cmp['v2-idle']}`, `idle-v3 (IK + meshes, same frames)=${cmp['v3-idle-v3']}`]);
sheet('mix-idle-v3-to-greeting-v3.png', '0,20,29,30,32,34,36,39,45,60,80,102', [`idle-v3 → greeting-v3 at 1 s, 0.3 s mix=${mixZip}`]);
log('sheets: greeting-v2-vs-v3.png, idle-v2-vs-v3.png (same frame numbers, one shared crop per sheet), mix-idle-v3-to-greeting-v3.png');

// RV-008: Lottie of the flat greeting-demo (read only); the lottie-web comparison is
// tests/acceptance/wiz-lottie.acceptance.test.ts. The meshed IK v3 is refused.
const DEMO_FILE = path.join(ROOT, '.hermes/evidence/wiz-v2-demo/project/wiz-greeting-demo.rig.json');
const demoSha = sha(readFileSync(DEMO_FILE));
cli('lottie', DEMO_FILE, '--anim', 'greeting-demo', '--out', path.join(OUT, 'greeting-demo.lottie.json'));
const refused = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rigsmith.ts'), 'lottie', V3_FILE, '--anim', 'greeting-v3', '--out', path.join(OUT, 'greeting-v3.lottie.json')], { encoding: 'utf8' });
assert.equal(refused.status, 1, 'v3 Lottie refused');
log(`lottie: greeting-demo.lottie.json (flat demo); greeting-v3 refused (exit 1):\n  ${JSON.parse(refused.stdout).errors.join('\n  ')}`);
assert.equal(sha(readFileSync(DEMO_FILE)), demoSha, 'greeting-demo project unchanged');

assert.equal(sha(readFileSync(V2_FILE)), v2Sha, 'wiz-v2.rig.json unchanged');
const manifest = Object.fromEntries(readdirSync(OUT).sort().map((f) => [f, { bytes: statSync(path.join(OUT, f)).size, sha256: sha(readFileSync(path.join(OUT, f))) }]));
writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify({ project: { file: path.relative(ROOT, V3_FILE), sha256: sha(readFileSync(V3_FILE)) }, v2Source: { file: path.relative(ROOT, V2_FILE), sha256: v2Sha, unchanged: true }, files: manifest }, null, 1));
writeFileSync(path.join(OUT, 'delivery-log.txt'), lines.join('\n') + '\n');
log(`MANIFEST.json: ${Object.keys(manifest).length} files`);
