// Minimal, hand-written type declarations for the Node.js APIs used by Rigsmith's
// tests and scripts (tsconfig.node.json). @types/node is not installed and this
// project avoids network installs, so these declare only what the code uses, with real
// signatures (no blanket `any`). If a test uses an undeclared API, typecheck fails —
// add a precise declaration here rather than casting.

declare class Buffer extends Uint8Array {
  static alloc(size: number): Buffer;
  static from(data: string, encoding?: 'utf8' | 'base64' | 'ascii' | 'hex'): Buffer;
  static from(data: ArrayBuffer | ArrayLike<number> | Uint8Array): Buffer;
  static concat(list: readonly Uint8Array[]): Buffer;
  toString(encoding?: 'utf8' | 'base64' | 'ascii' | 'hex', start?: number, end?: number): string;
  subarray(start?: number, end?: number): Buffer;
  copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
  equals(other: Uint8Array): boolean;
  readUInt16LE(offset: number): number;
  readUInt32LE(offset: number): number;
  readUInt32BE(offset: number): number;
  readInt32LE(offset: number): number;
  writeUInt16LE(value: number, offset?: number): number;
  writeUInt32LE(value: number, offset?: number): number;
  writeUInt32BE(value: number, offset?: number): number;
  writeUInt16BE(value: number, offset?: number): number;
  writeInt32BE(value: number, offset?: number): number;
  writeUInt8(value: number, offset?: number): number;
}

interface ImportMeta {
  /** Directory of the current module (Node ≥ 20.11). */
  dirname: string;
  filename: string;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  cwd(): string;
  platform: string;
  exitCode: number | undefined;
  stdout: { write(s: string | Uint8Array): boolean };
  stderr: { write(s: string | Uint8Array): boolean };
  on(event: 'SIGINT' | 'SIGTERM', fn: () => void): void;
  execPath: string;
};

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, regExp: RegExp, message?: string): void;
    throws(fn: () => unknown, error?: RegExp | (new (...args: never[]) => Error) | ((e: unknown) => boolean), message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}

declare module 'node:test' {
  type Fn = (t: unknown) => void | Promise<void>;
  interface TestOptions {
    timeout?: number;
    skip?: boolean | string;
    concurrency?: number | boolean;
  }
  export function test(name: string, fn: Fn): Promise<void>;
  export function test(name: string, opts: TestOptions, fn: Fn): Promise<void>;
  export function describe(name: string, fn: () => void | Promise<void>): Promise<void>;
  export function describe(name: string, opts: TestOptions, fn: () => void | Promise<void>): Promise<void>;
  export function it(name: string, fn: Fn): Promise<void>;
  export function it(name: string, opts: TestOptions, fn: Fn): Promise<void>;
  export function before(fn: () => void | Promise<void>, opts?: TestOptions): void;
  export function after(fn: () => void | Promise<void>, opts?: TestOptions): void;
}

declare module 'node:fs' {
  export function readFileSync(path: string): Buffer;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): string | undefined;
  export function existsSync(path: string): boolean;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  export function readdirSync(path: string): string[];
  export function copyFileSync(src: string, dest: string): void;
  export function statSync(path: string): { size: number; isDirectory(): boolean; isFile(): boolean };
  export function mkdtempSync(prefix: string): string;
  export function renameSync(from: string, to: string): void;
}

declare module 'node:path' {
  interface Path {
    join(...parts: string[]): string;
    resolve(...parts: string[]): string;
    dirname(p: string): string;
    basename(p: string, ext?: string): string;
    extname(p: string): string;
    relative(from: string, to: string): string;
    isAbsolute(p: string): boolean;
    sep: string;
  }
  const path: Path;
  export default path;
}

declare module 'node:child_process' {
  interface Readable {
    on(event: 'data', fn: (chunk: Buffer) => void): this;
  }
  interface Writable {
    write(chunk: Uint8Array, cb?: (err?: Error | null) => void): boolean;
    end(): void;
    once(event: 'drain', fn: () => void): this;
    on(event: 'error', fn: (err: Error) => void): this;
  }
  export interface ChildProcess {
    pid?: number;
    stdin: Writable | null;
    stdout: Readable | null;
    stderr: Readable | null;
    kill(signal?: string): boolean;
    on(event: 'exit', fn: (code: number | null, signal: string | null) => void): this;
    on(event: 'error', fn: (err: Error) => void): this;
  }
  export function spawn(cmd: string, args: readonly string[], opts?: { cwd?: string; stdio?: readonly ('ignore' | 'pipe' | 'inherit')[]; env?: Record<string, string | undefined> }): ChildProcess;
  export function execFileSync(cmd: string, args: readonly string[], opts?: { cwd?: string; encoding?: 'utf8'; stdio?: readonly ('ignore' | 'pipe' | 'inherit')[]; maxBuffer?: number }): string;
  export function spawnSync(cmd: string, args: readonly string[], opts: { cwd?: string; encoding: 'buffer'; maxBuffer?: number; input?: Uint8Array }): { status: number | null; stdout: Buffer; stderr: Buffer; error?: Error };
  export function spawnSync(cmd: string, args: readonly string[], opts?: { cwd?: string; encoding?: 'utf8'; maxBuffer?: number; input?: string | Uint8Array; env?: Record<string, string | undefined> }): { status: number | null; stdout: string; stderr: string; error?: Error };
}

declare module 'node:net' {
  interface Server {
    once(event: 'error', fn: (e: Error) => void): this;
    listen(port: number, host: string, cb: () => void): this;
    close(cb?: () => void): this;
  }
  export function createServer(): Server;
  const net: { createServer: typeof createServer };
  export default net;
}

declare module 'node:zlib' {
  export function crc32(data: Uint8Array | string, value?: number): number;
  export function deflateSync(data: Uint8Array, opts?: { level?: number }): Buffer;
  export function inflateSync(data: Uint8Array): Buffer;
  export function inflateRawSync(data: Uint8Array): Buffer;
}

declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: 'hex' | 'base64'): string;
  }
  export function createHash(algorithm: 'sha256' | 'sha1' | 'md5'): Hash;
  export function randomBytes(size: number): Buffer;
}
