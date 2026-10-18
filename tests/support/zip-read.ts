// Independent ZIP reader for tests (stored and deflated entries; via the central directory).
import { inflateRawSync, crc32 } from 'node:zlib';

export interface ZipFile {
  name: string;
  data: Buffer;
}

export function readZip(buf: Buffer): ZipFile[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let o = buf.readUInt32LE(eocd + 16);
  const out: ZipFile[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(o + 10);
    const crc = buf.readUInt32LE(o + 16);
    const csize = buf.readUInt32LE(o + 20);
    const nlen = buf.readUInt16LE(o + 28), xlen = buf.readUInt16LE(o + 30), clen = buf.readUInt16LE(o + 32);
    const lho = buf.readUInt32LE(o + 42);
    const name = buf.toString('utf8', o + 46, o + 46 + nlen);
    o += 46 + nlen + xlen + clen;
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : (() => { throw new Error(`unsupported ZIP method ${method}`); })();
    if ((crc32(data) >>> 0) !== crc) throw new Error(`CRC mismatch for ${name}`);
    out.push({ name, data });
  }
  return out;
}
