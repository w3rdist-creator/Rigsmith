// Independent decoding of exported media for tests: Pillow (tests/support/media_decode.py)
// for APNG / GIF frames, durations and loop count; ffprobe / ffmpeg for stream facts and
// WebM / MP4 frames. None of this is Rigsmith code.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

export function pillow(file: string): { info: any; frames: Uint8Array[] } {
  const dir = `${file}.decoded`;
  const r = spawnSync('python3', ['-I', path.join(ROOT, 'tests/support/media_decode.py'), file, dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const info = JSON.parse(r.stdout);
  return { info, frames: Array.from({ length: info.frames }, (_, i) => new Uint8Array(readFileSync(path.join(dir, `frame_${String(i).padStart(4, '0')}.rgba`)))) };
}

export const hasFfmpeg = () => spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0;

export function ffprobe(file: string): { codec: string; width: number; height: number; rate: string; frames: number; tags: Record<string, string> } {
  const r = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames,r_frame_rate:stream_tags', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout).streams[0];
  return { codec: s.codec_name, width: s.width, height: s.height, rate: s.r_frame_rate, frames: Number(s.nb_read_frames), tags: s.tags ?? {} };
}

/** All frames as straight RGBA. VP9 alpha needs the libvpx decoder chosen before -i. */
export function ffmpegFrames(file: string, width: number, height: number, vp9Alpha = false): Uint8Array[] {
  const r = spawnSync('ffmpeg', ['-v', 'error', ...(vp9Alpha ? ['-c:v', 'libvpx-vp9'] : []), '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: 'buffer', maxBuffer: 1 << 30 });
  assert.equal(r.status, 0, r.stderr.toString());
  const n = width * height * 4;
  assert.equal(r.stdout.length % n, 0, 'whole frames');
  return Array.from({ length: r.stdout.length / n }, (_, i) => new Uint8Array(r.stdout.subarray(i * n, (i + 1) * n)));
}
