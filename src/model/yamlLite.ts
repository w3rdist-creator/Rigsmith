// A small, strict YAML subset for clip specs (src/model/clipSpec.ts), so Rigsmith keeps
// zero runtime dependencies. Supported: block maps (`key: value`), block lists (`- item`,
// including `- key: value` maps), flow lists `[a, b]` and flow maps `{a: 1}` (which may
// span lines), numbers, true/false, null/~, plain, 'single'- and "double"-quoted strings
// (JSON escapes) and `#` comments. Anything else — anchors, aliases, tags, block scalars
// (| >), multiple documents, tab indentation, duplicate keys — is refused with its line.

export type YamlValue = null | boolean | number | string | YamlValue[] | { [k: string]: YamlValue };
export type YamlResult = { ok: true; value: YamlValue } | { ok: false; errors: string[] };

class YamlError extends Error {}

interface Line {
  no: number;
  indent: number;
  text: string;
}

const fail = (no: number, msg: string): never => {
  throw new YamlError(`line ${no}: ${msg}`);
};

/** Removes a trailing comment (a `#` at the start or after a space, outside quotes). */
function stripComment(s: string, no: number): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || s[i - 1] === ' ')) return s.slice(0, i);
  }
  if (q) fail(no, 'unterminated quoted string');
  return s;
}

/** Bracket depth change of a line (outside quotes). */
function depth(s: string): number {
  let d = 0;
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') d++;
    else if (c === ']' || c === '}') d--;
  }
  return d;
}

function lines(text: string): Line[] {
  const out: Line[] = [];
  const raw = text.replace(/^﻿/, '').split(/\r?\n/);
  let open: Line | null = null;
  let d = 0;
  raw.forEach((r, i) => {
    const no = i + 1;
    const body = stripComment(r, no).replace(/\s+$/, '');
    if (open) {
      // Continuation of a flow collection that spans lines.
      open.text += ' ' + body.trim();
      d += depth(body);
      if (d <= 0) open = null;
      return;
    }
    if (!body.trim()) return;
    const lead = /^[ \t]*/.exec(body)![0];
    if (lead.includes('\t')) fail(no, 'tabs are not allowed for indentation (use spaces)');
    const t = body.slice(lead.length);
    if (t === '---' && !out.length) return;
    if (t === '---' || t === '...') fail(no, 'only one document is supported');
    if (/^%/.test(t)) fail(no, 'directives are not supported');
    const line: Line = { no, indent: lead.length, text: t };
    out.push(line);
    d = depth(t);
    if (d > 0) open = line;
  });
  if (open) fail((open as Line).no, 'unclosed [ or {');
  return out;
}

const NUM = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

function plainScalar(s: string, no: number): YamlValue {
  if (/^[&*!|>%@`]/.test(s)) fail(no, `“${s[0]}” (anchors, aliases, tags, block scalars) is not supported`);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (NUM.test(s)) return Number(s);
  return s;
}

/** Flow / scalar parser over one (joined) line from position `i`. */
class Inline {
  i = 0;
  readonly s: string;
  readonly no: number;
  constructor(s: string, no: number) {
    this.s = s;
    this.no = no;
  }

  ws(): void {
    while (this.s[this.i] === ' ') this.i++;
  }

  value(flow: boolean): YamlValue {
    this.ws();
    const c = this.s[this.i];
    if (c === '[') return this.list();
    if (c === '{') return this.map();
    if (c === '"' || c === "'") return this.quoted();
    // Plain scalar: to the end (block) or to , ] } (flow).
    const start = this.i;
    while (this.i < this.s.length && !(flow && /[,\]}]/.test(this.s[this.i])) && !(flow && this.s[this.i] === ':' && this.s[this.i + 1] === ' ')) this.i++;
    const t = this.s.slice(start, this.i).trim();
    if (!t) fail(this.no, 'missing value');
    return plainScalar(t, this.no);
  }

  quoted(): string {
    const q = this.s[this.i];
    const start = this.i;
    this.i++;
    if (q === '"') {
      while (this.i < this.s.length && this.s[this.i] !== '"') this.i += this.s[this.i] === '\\' ? 2 : 1;
      if (this.s[this.i] !== '"') fail(this.no, 'unterminated string');
      this.i++;
      try {
        return JSON.parse(this.s.slice(start, this.i)) as string;
      } catch {
        return fail(this.no, `bad escape in ${this.s.slice(start, this.i)}`);
      }
    }
    let out = '';
    for (;;) {
      if (this.i >= this.s.length) fail(this.no, 'unterminated string');
      if (this.s[this.i] === "'") {
        if (this.s[this.i + 1] === "'") {
          out += "'";
          this.i += 2;
          continue;
        }
        this.i++;
        return out;
      }
      out += this.s[this.i++];
    }
  }

  list(): YamlValue[] {
    this.i++;
    const out: YamlValue[] = [];
    this.ws();
    if (this.s[this.i] === ']') return this.i++, out;
    for (;;) {
      out.push(this.value(true));
      this.ws();
      const c = this.s[this.i++];
      if (c === ']') return out;
      if (c !== ',') fail(this.no, 'expected , or ] in a flow list');
    }
  }

  map(): { [k: string]: YamlValue } {
    this.i++;
    const out: { [k: string]: YamlValue } = {};
    this.ws();
    if (this.s[this.i] === '}') return this.i++, out;
    for (;;) {
      this.ws();
      const k = this.s[this.i] === '"' || this.s[this.i] === "'" ? this.quoted() : this.key();
      this.ws();
      if (this.s[this.i++] !== ':') fail(this.no, `expected “:” after “${k}” in a flow map`);
      if (Object.hasOwn(out, k)) fail(this.no, `duplicate key “${k}”`);
      out[k] = this.value(true);
      this.ws();
      const c = this.s[this.i++];
      if (c === '}') return out;
      if (c !== ',') fail(this.no, 'expected , or } in a flow map');
    }
  }

  key(): string {
    const start = this.i;
    while (this.i < this.s.length && !/[:,{}[\]]/.test(this.s[this.i])) this.i++;
    const k = this.s.slice(start, this.i).trim();
    if (!k) fail(this.no, 'empty key');
    return k;
  }

  /** The whole rest of the line as one value; trailing text is an error. */
  all(): YamlValue {
    const v = this.value(false);
    this.ws();
    if (this.i < this.s.length) fail(this.no, `unexpected “${this.s.slice(this.i)}”`);
    return v;
  }
}

/** Splits `key: rest` (key plain or quoted); null when the line is not a map entry. */
function splitKey(t: string, no: number): { key: string; rest: string } | null {
  if (t[0] === '"' || t[0] === "'") {
    const p = new Inline(t, no);
    const key = p.quoted();
    const after = t.slice(p.i);
    const m = /^\s*:(\s|$)/.exec(after);
    return m ? { key, rest: after.slice(m[0].length).trim() } : null;
  }
  if (t[0] === '[' || t[0] === '{') return null;
  const m = /^([^:#{}[\],]+?)\s*:(\s|$)/.exec(t);
  return m ? { key: m[1], rest: t.slice(m[0].length).trim() } : null;
}

class Block {
  i = 0;
  readonly ls: Line[];
  constructor(ls: Line[]) {
    this.ls = ls;
  }

  parse(): YamlValue {
    if (!this.ls.length) return null;
    const v = this.node(this.ls[0].indent);
    if (this.i < this.ls.length) fail(this.ls[this.i].no, 'unexpected indentation');
    return v;
  }

  node(indent: number): YamlValue {
    const l = this.ls[this.i];
    if (l.text === '-' || l.text.startsWith('- ')) return this.seq(indent);
    if (splitKey(l.text, l.no)) return this.map(indent);
    this.i++;
    return new Inline(l.text, l.no).all();
  }

  /** Value after `key:` / `-` with nothing on the line: the indented block below (or null). */
  child(parent: number, allowSameIndentSeq: boolean): YamlValue {
    const n = this.ls[this.i];
    if (n && n.indent > parent) return this.node(n.indent);
    if (n && allowSameIndentSeq && n.indent === parent && (n.text === '-' || n.text.startsWith('- '))) return this.seq(parent);
    return null;
  }

  seq(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    while (this.i < this.ls.length) {
      const l = this.ls[this.i];
      if (l.indent < indent) break;
      if (l.indent > indent) fail(l.no, 'unexpected indentation');
      if (!(l.text === '-' || l.text.startsWith('- '))) break;
      const rest = l.text.slice(1).trimStart();
      if (!rest) {
        this.i++;
        out.push(this.child(indent, false));
      } else if (splitKey(rest, l.no) && rest[0] !== '[' && rest[0] !== '{') {
        // `- key: value`: a map whose first entry shares the dash's line.
        l.indent = indent + (l.text.length - rest.length);
        l.text = rest;
        out.push(this.map(l.indent));
      } else {
        this.i++;
        out.push(new Inline(rest, l.no).all());
      }
    }
    return out;
  }

  map(indent: number): { [k: string]: YamlValue } {
    const out: { [k: string]: YamlValue } = {};
    while (this.i < this.ls.length) {
      const l = this.ls[this.i];
      if (l.indent < indent) break;
      if (l.indent > indent) fail(l.no, 'unexpected indentation');
      const kv = splitKey(l.text, l.no);
      if (!kv) {
        if (l.text === '-' || l.text.startsWith('- ')) fail(l.no, 'a list item where a “key: value” entry was expected');
        fail(l.no, `expected “key: value” (got “${l.text}”)`);
      }
      const { key, rest } = kv!;
      if (Object.hasOwn(out, key)) fail(l.no, `duplicate key “${key}”`);
      this.i++;
      out[key] = rest ? new Inline(rest, l.no).all() : this.child(indent, true);
    }
    return out;
  }
}

export function parseYaml(text: string): YamlResult {
  try {
    return { ok: true, value: new Block(lines(text)).parse() };
  } catch (e) {
    if (e instanceof YamlError) return { ok: false, errors: [e.message] };
    throw e;
  }
}

// ---- writer --------------------------------------------------------------------------

const RESERVED = /^(true|false|null|~|yes|no|on|off)$/i;

function scalar(v: null | boolean | number | string): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`cannot write ${v}`);
    return Object.is(v, -0) ? '-0' : String(v);
  }
  return /^[A-Za-z_][\w.\-]*$/.test(v) && !RESERVED.test(v) ? v : JSON.stringify(v);
}

const isFlat = (v: YamlValue): boolean => v === null || typeof v !== 'object' || (Array.isArray(v) ? v.every(isFlat) : Object.values(v).every(isFlat));

function flow(v: YamlValue): string {
  if (v === null || typeof v !== 'object') return scalar(v);
  if (Array.isArray(v)) return `[${v.map(flow).join(', ')}]`;
  return `{${Object.entries(v).map(([k, x]) => `${scalar(k)}: ${flow(x)}`).join(', ')}}`;
}

function block(v: YamlValue, indent: string, out: string[]): void {
  if (Array.isArray(v)) {
    for (const x of v) {
      if (x !== null && typeof x === 'object' && !Array.isArray(x) && !isFlat(x)) {
        const sub: string[] = [];
        block(x, indent + '  ', sub);
        sub[0] = `${indent}- ${sub[0].slice(indent.length + 2)}`;
        out.push(...sub);
      } else out.push(`${indent}- ${flow(x)}`);
    }
    return;
  }
  for (const [k, x] of Object.entries(v as Record<string, YamlValue>)) {
    if (x !== null && typeof x === 'object' && (Array.isArray(x) ? x.length && !x.every((e) => e === null || typeof e !== 'object') : Object.keys(x).length)) {
      out.push(`${indent}${scalar(k)}:`);
      block(x, indent + '  ', out);
    } else out.push(`${indent}${scalar(k)}: ${flow(x)}`);
  }
}

/**
 * Writes a value in the subset above: maps as blocks, lists of scalars as one flow line,
 * lists of keys/records one per line. `parseYaml(stringifyYaml(v))` gives back v exactly
 * (numbers keep full precision and −0).
 */
export function stringifyYaml(v: YamlValue, header = ''): string {
  const out: string[] = header ? header.split('\n').map((l) => `# ${l}`.trimEnd()) : [];
  if (v === null || typeof v !== 'object') out.push(scalar(v));
  else block(v, '', out);
  return out.join('\n') + '\n';
}
