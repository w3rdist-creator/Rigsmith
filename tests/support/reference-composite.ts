// Independent reference renderer for correctness checks. It does NOT import src/: the
// pose sampling (linear / step / smoothstep / cubic-bezier via bisection), the TRS
// matrix chain, draw order, slot visibility/opacity/image keys, and the compositing
// (bilinear texture sampling × 4×4 supersampled quad coverage, premultiplied
// source-over) are re-derived here from the project JSON and the format docs.
// Meshes: vertices are re-skinned here (setup pose = bind pose, deform keys sampled
// here); each of the 4×4 subsamples per pixel belongs to the topmost (last-listed)
// triangle containing it, each triangle contributes its subsample coverage × one
// bilinear texture tap at the pixel centre through its own barycentric map (the quad
// model above), and the mesh is composited once with the attachment opacity.
// v3 colour: the tint (setup `#rrggbbaa` or sampled colour keys) multiplies each sample's
// rgb and the opacity; a mesh's vertex alpha is interpolated (barycentric) at the pixel
// centre through each owning triangle's map; blend modes use the W3C compositing
// formulas (additive = plus-lighter, clamped; screen and multiply = separable blends).
// v3 bind pose: a weighted mesh with `mesh.bind` skins from the stored matrices.
import type { Decoded } from './png-decode.ts';
import { decodePng } from './png-decode.ts';

export type M = [number, number, number, number, number, number]; // a b c d tx ty

const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

function trs(x: number, y: number, deg: number, sx: number, sy: number): M {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r) * sx, Math.sin(r) * sx, -Math.sin(r) * sy, Math.cos(r) * sy, x, y];
}

function inv(m: M): M {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

function bezierEase(c: number[], t: number): number {
  // Bisection on x(s) (monotonic for x handles in [0,1]); independent of src/model/curve.ts.
  const B = (p1: number, p2: number, s: number) => 3 * (1 - s) * (1 - s) * s * p1 + 3 * (1 - s) * s * s * p2 + s * s * s;
  let lo = 0, hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (B(c[0], c[2], mid) < t) lo = mid;
    else hi = mid;
  }
  return B(c[1], c[3], (lo + hi) / 2);
}

export function sampleTrack(keys: any[] | undefined, t: number, fallback: number[]): number[] {
  if (!keys?.length) return fallback;
  if (t <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.time) return last.value;
  let i = 0;
  while (keys[i + 1].time <= t) i++;
  const a = keys[i], b = keys[i + 1];
  const u = (t - a.time) / (b.time - a.time);
  const ease = (interp: string, curve: any) => (interp === 'step' ? 0 : interp === 'smooth' ? u * u * (3 - 2 * u) : interp === 'bezier' ? bezierEase(curve, u) : u);
  const e = ease(a.interp, a.curve);
  const ey = a.interpY ? ease(a.interpY, a.curveY) : e;
  return a.value.map((v: number, k: number) => v + (b.value[k] - v) * (k === 1 ? ey : e));
}

function stepped(keys: any[] | undefined, t: number): any {
  let out: any;
  for (const k of keys ?? []) if (k.time <= t + 1e-9) out = k;
  return out;
}

/** Keyed opacity of every attachment at time t (the value composite() uses). */
export function slotOpacities(project: any, anim: any | null, t: number): Map<string, number> {
  return new Map(project.attachments.map((a: any) => {
    const keys = anim?.slots?.[a.id]?.opacity;
    return [a.id, keys?.length ? sampleTrack(keys, t, [a.opacity])[0] : a.opacity];
  }));
}

/** World matrix per bone id at time t (anim null = setup pose). No constraints. */
export function boneWorlds(project: any, anim: any | null, t: number): Map<string, M> {
  const out = new Map<string, M>();
  const pending = [...project.bones];
  while (pending.length) {
    const i = pending.findIndex((b: any) => b.parentId === null || out.has(b.parentId));
    if (i < 0) throw new Error('cycle');
    const b = pending.splice(i, 1)[0];
    const tr = anim?.tracks?.[b.id];
    const [x, y] = sampleTrack(tr?.translate, t, [b.x, b.y]);
    const [r] = sampleTrack(tr?.rotate, t, [b.rotation]);
    const [sx, sy] = sampleTrack(tr?.scale, t, [b.scaleX, b.scaleY]);
    const local = trs(x, y, r, sx, sy);
    out.set(b.id, b.parentId ? mul(out.get(b.parentId)!, local) : local);
  }
  return out;
}

/** World matrices from explicit local poses (e.g. an independently blended pose). */
export function worldsFromLocal(project: any, local: Map<string, { x: number; y: number; rotation: number; scaleX: number; scaleY: number }>): Map<string, M> {
  const out = new Map<string, M>();
  const pending = [...project.bones];
  while (pending.length) {
    const i = pending.findIndex((b: any) => b.parentId === null || out.has(b.parentId));
    if (i < 0) throw new Error('cycle');
    const b = pending.splice(i, 1)[0];
    const l = local.get(b.id) ?? b;
    const m = trs(l.x, l.y, l.rotation, l.scaleX, l.scaleY);
    out.set(b.id, b.parentId ? childWorld(out.get(b.parentId)!, b.inherit, m) : m);
  }
  return out;
}

/**
 * Inherit flags (docs/architecture.md → Inherit flags): the origin always goes through the
 * full parent; the axes go through the parent's linear part with the dropped parts removed.
 * Restated with projections: X' = parent x column (negated when the parent mirrors), u =
 * X'/|X'|, v = u turned +90°; rotation = the basis (u, v); scale/shear = X' and the y column
 * written in (u, v); a kept reflection negates the result's x column.
 */
export function childWorld(P: M, inherit: any, L: M): M {
  if (!inherit || (inherit.rotation && inherit.scale && inherit.reflection)) return mul(P, L);
  const det = P[0] * P[3] - P[1] * P[2];
  const X = det < 0 ? [-P[0], -P[1]] : [P[0], P[1]], Y = [P[2], P[3]];
  const len = Math.hypot(X[0], X[1]);
  const u = len > 1e-12 ? [X[0] / len, X[1] / len] : [1, 0], v = [-u[1], u[0]];
  // Columns of the inherited linear part, built up as [col x, col y].
  let cx: number[], cy: number[];
  if (inherit.rotation && inherit.scale) [cx, cy] = [X, Y];
  else if (inherit.rotation) [cx, cy] = [u, v];
  else if (inherit.scale) [cx, cy] = [[len, 0], [Y[0] * u[0] + Y[1] * u[1], Y[0] * v[0] + Y[1] * v[1]]];
  else [cx, cy] = [[1, 0], [0, 1]];
  if (det < 0 && inherit.reflection) cx = [-cx[0], -cx[1]];
  const lin: M = [cx[0], cx[1], cy[0], cy[1], 0, 0];
  const o = mul(P, [1, 0, 0, 1, L[4], L[5]]);
  const axes = mul(lin, [L[0], L[1], L[2], L[3], 0, 0]);
  return [axes[0], axes[1], axes[2], axes[3], o[4], o[5]];
}

/** Blended continuous slot channels (a mixed frame): opacity and mesh deform per attachment id. */
export interface SlotOverride {
  opacity: Map<string, number>;
  deform: Map<string, number[]>;
}

export interface RefImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function decodeProjectImages(project: any): Map<string, Decoded> {
  const m = new Map<string, Decoded>();
  for (const im of project.images) m.set(im.id, decodePng(Buffer.from(im.dataUrl.split(',')[1], 'base64')));
  return m;
}

/**
 * Composites the project at time t into a w×h transparent RGBA buffer where world point
 * (x,y) maps to pixel ((x - originX)·scale, (y - originY)·scale).
 */
export function composite(project: any, anim: any | null, t: number, images: Map<string, Decoded>, w: number, h: number, originX: number, originY: number, scale: number, worldOverride?: Map<string, M>, skinId?: string | null, slotOverride?: SlotOverride): RefImage {
  // Constraints (IK/paths) and mixing are not solved here: callers pass bone world
  // matrices (e.g. from reference-constraints.ts) and, for a blended frame, the blended
  // opacity/deform; (anim, t) then supply only the stepped slot and draw-order state.
  const worlds = worldOverride ?? boneWorlds(project, anim, t);
  // Premultiplied float accumulation.
  const acc = new Float64Array(w * h * 4);
  const view: M = [scale, 0, 0, scale, -originX * scale, -originY * scale];
  const dk = stepped(anim?.drawOrder, t);
  const byId = new Map(project.attachments.map((a: any) => [a.id, a]));
  const order: any[] = dk ? dk.order.map((id: string) => byId.get(id)) : project.attachments;
  let setup: Map<string, M> | undefined;
  for (const a of order) {
    const st = anim?.slots?.[a.id];
    // Stepped channels show the setup value before their first key.
    const vk = stepped(st?.visible, t);
    const visible = vk ? vk.value[0] >= 0.5 : !a.hidden;
    const tint = refTint(a, st, t);
    const opacity = (slotOverride?.opacity.get(a.id) ?? (st?.opacity?.length ? sampleTrack(st.opacity, t, [a.opacity])[0] : a.opacity)) * tint[3];
    if (!visible || opacity <= 0) continue;
    const fx: Fx = { tint, blend: a.blend ?? 'normal' };
    let imageId = stepped(st?.image, t)?.imageId ?? a.imageId;
    // Skin rule (independent restatement): an entry without `from` stands in for the
    // setup image, an entry with `from` for that keyed image.
    const skin = skinId ? project.skins?.find((s: any) => s.id === skinId) : null;
    const rep = skin?.entries.find((e: any) => e.attachmentId === a.id && (e.from ?? a.imageId) === imageId);
    if (rep) imageId = rep.imageId;
    const meta = project.images.find((i: any) => i.id === imageId);
    const img = images.get(imageId)!;
    const base = a.boneId ? worlds.get(a.boneId)! : ([1, 0, 0, 1, 0, 0] as M);
    if (a.mesh) {
      setup ??= boneWorlds(project, null, 0);
      compositeMesh(acc, w, h, view, a, st, t, project, worlds, setup, meta, img, opacity, slotOverride?.deform.get(a.id), fx);
      continue;
    }
    quad(acc, w, h, mul(view, mul(base, trs(a.x, a.y, a.rotation, a.scaleX, a.scaleY))), meta, img, opacity, fx);
  }
  return toImage(acc, w, h);
}

function toImage(acc: Float64Array, w: number, h: number): RefImage {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = acc[i * 4 + 3];
    data[i * 4 + 3] = Math.round(a * 255);
    for (let c = 0; c < 3; c++) data[i * 4 + c] = a > 0 ? Math.round(Math.min(1, acc[i * 4 + c] / a) * 255) : 0;
  }
  return { width: w, height: h, data };
}

/** Source-over of one image quad (image centred on the origin of `m`) into a premultiplied float buffer. */
type Fx = { tint: number[]; blend: string };
const PLAIN: Fx = { tint: [1, 1, 1, 1], blend: 'normal' };

/** Setup tint (#rrggbbaa / #rrggbb) or sampled colour keys, channels 0..1. */
export function refTint(a: any, st: any, t: number): number[] {
  const hex = typeof a.color === 'string' ? a.color : '#ffffffff';
  const setup = [1, 3, 5, 7].map((i) => (i < hex.length ? parseInt(hex.slice(i, i + 2), 16) / 255 : 1));
  const c = st?.color?.length ? sampleTrack(st.color, t, setup) : setup;
  return c.map((v: number) => Math.min(1, Math.max(0, v)));
}

/** Composites a premultiplied source (rgb already premultiplied, alpha sa) into acc[o..o+3]. */
function blendInto(acc: Float64Array, o: number, src: number[], sa: number, mode: string): void {
  const ba = acc[o + 3];
  if (mode === 'additive') {
    for (let c = 0; c < 3; c++) acc[o + c] = Math.min(1, acc[o + c] + src[c]);
    acc[o + 3] = Math.min(1, ba + sa);
    return;
  }
  if (mode === 'screen' || mode === 'multiply') {
    for (let c = 0; c < 3; c++) {
      const Cs = sa > 0 ? src[c] / sa : 0, Cb = ba > 0 ? acc[o + c] / ba : 0;
      const B = mode === 'screen' ? Cb + Cs - Cb * Cs : Cb * Cs;
      acc[o + c] = src[c] * (1 - ba) + acc[o + c] * (1 - sa) + sa * ba * B;
    }
    acc[o + 3] = sa + ba * (1 - sa);
    return;
  }
  for (let c = 0; c < 3; c++) acc[o + c] = src[c] + acc[o + c] * (1 - sa);
  acc[o + 3] = sa + ba * (1 - sa);
}

function quad(acc: Float64Array, w: number, h: number, m: M, meta: { width: number; height: number }, img: Decoded, opacity: number, fx: Fx = PLAIN): void {
  const im = inv(m);
  const hw = meta.width / 2, hh = meta.height / 2;
  // Screen bounding box of the quad.
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0])))), x1 = Math.min(w - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1])))), y1 = Math.min(h - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))));
  const sx = meta.width / img.width, sy = meta.height / img.height;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      // Coverage of the pixel by the quad (4×4 subsamples).
      let cov = 0;
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const qx = px + (i + 0.5) / 4, qy = py + (j + 0.5) / 4;
          const u = im[0] * qx + im[2] * qy + im[4], v = im[1] * qx + im[3] * qy + im[5];
          if (u >= -hw && u <= hw && v >= -hh && v <= hh) cov++;
        }
      if (!cov) continue;
      const cx = px + 0.5, cy = py + 0.5;
      const u = (im[0] * cx + im[2] * cy + im[4] + hw) / sx - 0.5;
      const v = (im[1] * cx + im[3] * cy + im[5] + hh) / sy - 0.5;
      const s = bilinear(img, u, v);
      const k = (cov / 16) * opacity;
      const o = (py * w + px) * 4;
      blendInto(acc, o, [s[0] * k * fx.tint[0], s[1] * k * fx.tint[1], s[2] * k * fx.tint[2]], s[3] * k, fx.blend);
    }
  }
}

/**
 * Composites explicit draws (back to front): each maps centred image coordinates to world
 * points; world (x,y) → pixel ((x − originX)·scale, (y − originY)·scale).
 */
export function compositeDraws(draws: { m: M; width: number; height: number; img: Decoded; opacity: number }[], w: number, h: number, originX: number, originY: number, scale: number): RefImage {
  const acc = new Float64Array(w * h * 4);
  const view: M = [scale, 0, 0, scale, -originX * scale, -originY * scale];
  for (const d of draws) if (d.opacity > 0) quad(acc, w, h, mul(view, d.m), { width: d.width, height: d.height }, d.img, d.opacity);
  return toImage(acc, w, h);
}

const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Screen-space (pixel) vertex positions of a mesh attachment at time t. */
export function meshScreenVertices(a: any, st: any, t: number, project: any, worlds: Map<string, M>, setup: Map<string, M>, view: M, deformOverride?: number[]): number[] {
  const mesh = a.mesh;
  const setupMeta = project.images.find((i: any) => i.id === a.imageId);
  const n = mesh.points.length / 2;
  const deform = deformOverride ?? sampleTrack(st?.deform, t, new Array(mesh.points.length).fill(0));
  const attLocal = trs(a.x, a.y, a.rotation, a.scaleX, a.scaleY);
  const ident: M = [1, 0, 0, 1, 0, 0];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const lx = mesh.points[2 * i] - setupMeta.width / 2 + deform[2 * i];
    const ly = mesh.points[2 * i + 1] - setupMeta.height / 2 + deform[2 * i + 1];
    let x: number, y: number;
    if (!mesh.weights) {
      [x, y] = apply(mul(a.boneId ? worlds.get(a.boneId)! : ident, attLocal), lx, ly);
    } else {
      // v3 bind pose: the stored matrices replace the setup pose (bones without one: setup).
      const bind = mesh.bind;
      const rest: M = bind ? (bind.attachment as M) : mul(a.boneId ? setup.get(a.boneId)! : ident, attLocal);
      const [rx, ry] = apply(rest, lx, ly);
      x = 0;
      y = 0;
      for (const inf of mesh.weights[i]) {
        const B: M = (bind?.bones[inf.bone] as M) ?? setup.get(inf.bone)!;
        const [qx, qy] = apply(mul(worlds.get(inf.bone)!, inv(B)), rx, ry);
        x += qx * inf.w;
        y += qy * inf.w;
      }
    }
    const [sx, sy] = apply(view, x, y);
    out.push(sx, sy);
  }
  return out;
}

function compositeMesh(acc: Float64Array, w: number, h: number, view: M, a: any, st: any, t: number, project: any, worlds: Map<string, M>, setup: Map<string, M>, meta: any, img: Decoded, opacity: number, deform?: number[], fx: Fx = PLAIN): void {
  const mesh = a.mesh;
  const setupMeta = project.images.find((i: any) => i.id === a.imageId);
  const v = meshScreenVertices(a, st, t, project, worlds, setup, view, deform);
  // Texture coordinates in the shown image's pixels (scaled from the setup image).
  const ku = meta.width / setupMeta.width, kv = meta.height / setupMeta.height;
  const S = 4;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < v.length; i += 2) {
    minX = Math.min(minX, v[i]);
    maxX = Math.max(maxX, v[i]);
    minY = Math.min(minY, v[i + 1]);
    maxY = Math.max(maxY, v[i + 1]);
  }
  const X0 = Math.max(0, Math.floor(minX)), X1 = Math.min(w - 1, Math.ceil(maxX));
  const Y0 = Math.max(0, Math.floor(minY)), Y1 = Math.min(h - 1, Math.ceil(maxY));
  if (X1 < X0 || Y1 < Y0) return;
  const bw = X1 - X0 + 1, bh = Y1 - Y0 + 1;
  // Per triangle: the affine map screen → texture (u = A·x + B·y + C), from barycentrics.
  const nt = mesh.triangles.length / 3;
  const tex = new Float64Array(nt * 6);
  // Per triangle: vertex alpha as an affine function of the screen point (x, y).
  const alf = new Float64Array(nt * 3);
  const va: number[] | undefined = mesh.alphas;
  // Topmost (last-listed) triangle per subsample, −1 = none.
  const owner = new Int32Array(bw * S * bh * S).fill(-1);
  const p = mesh.points;
  for (let k = 0; k < nt; k++) {
    const [i0, i1, i2] = [mesh.triangles[3 * k], mesh.triangles[3 * k + 1], mesh.triangles[3 * k + 2]];
    const ax = v[2 * i0], ay = v[2 * i0 + 1], bx = v[2 * i1], by = v[2 * i1 + 1], cx = v[2 * i2], cy = v[2 * i2 + 1];
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    const uvArea = (p[2 * i1] - p[2 * i0]) * (p[2 * i2 + 1] - p[2 * i0 + 1]) - (p[2 * i2] - p[2 * i0]) * (p[2 * i1 + 1] - p[2 * i0 + 1]);
    if (Math.abs(area) < 1e-9 || Math.abs(uvArea) < 1e-9) continue; // degenerate: draws nothing
    // l1 = ((x−ax)(cy−ay) − (cx−ax)(y−ay))/area, l2 = ((bx−ax)(y−ay) − (x−ax)(by−ay))/area
    const l1x = (cy - ay) / area, l1y = -(cx - ax) / area, l1c = (-ax * (cy - ay) + (cx - ax) * ay) / area;
    const l2x = -(by - ay) / area, l2y = (bx - ax) / area, l2c = (-(bx - ax) * ay + ax * (by - ay)) / area;
    if (va) {
      const [a0, a1, a2] = [va[i0], va[i1], va[i2]];
      alf[3 * k] = (a1 - a0) * l1x + (a2 - a0) * l2x;
      alf[3 * k + 1] = (a1 - a0) * l1y + (a2 - a0) * l2y;
      alf[3 * k + 2] = a0 + (a1 - a0) * l1c + (a2 - a0) * l2c;
    }
    for (let c = 0; c < 2; c++) {
      const q0 = p[2 * i0 + c] * (c ? kv : ku), q1 = p[2 * i1 + c] * (c ? kv : ku), q2 = p[2 * i2 + c] * (c ? kv : ku);
      tex[6 * k + 3 * c] = (q1 - q0) * l1x + (q2 - q0) * l2x;
      tex[6 * k + 3 * c + 1] = (q1 - q0) * l1y + (q2 - q0) * l2y;
      tex[6 * k + 3 * c + 2] = q0 + (q1 - q0) * l1c + (q2 - q0) * l2c;
    }
    const sx0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - X0) * S)), sx1 = Math.min(bw * S - 1, Math.ceil((Math.max(ax, bx, cx) - X0) * S));
    const sy0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - Y0) * S)), sy1 = Math.min(bh * S - 1, Math.ceil((Math.max(ay, by, cy) - Y0) * S));
    for (let j = sy0; j <= sy1; j++) {
      for (let i = sx0; i <= sx1; i++) {
        const qx = X0 + (i + 0.5) / S, qy = Y0 + (j + 0.5) / S;
        const l1 = l1x * qx + l1y * qy + l1c, l2 = l2x * qx + l2y * qy + l2c;
        if (l1 < 0 || l2 < 0 || 1 - l1 - l2 < 0) continue;
        owner[j * bw * S + i] = k;
      }
    }
  }
  const tx = img.width / meta.width, ty = img.height / meta.height;
  const uvAt = (k: number, x: number, y: number): [number, number] => [tex[6 * k] * x + tex[6 * k + 1] * y + tex[6 * k + 2], tex[6 * k + 3] * x + tex[6 * k + 4] * y + tex[6 * k + 5]];
  const counts = new Map<number, number>();
  for (let py = 0; py < bh; py++) {
    for (let px = 0; px < bw; px++) {
      // Coverage per owning triangle (subsamples whose texture point lies on the image),
      // colour: one bilinear tap at the pixel centre through that triangle's map — the
      // same model as the quad path above (coverage × centre sample).
      counts.clear();
      for (let j = 0; j < S; j++)
        for (let i = 0; i < S; i++) {
          const k = owner[(py * S + j) * bw * S + px * S + i];
          if (k < 0) continue;
          const [u, vv] = uvAt(k, X0 + px + (i + 0.5) / S, Y0 + py + (j + 0.5) / S);
          if (u < 0 || vv < 0 || u > meta.width || vv > meta.height) continue;
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
      if (!counts.size) continue;
      const col = [0, 0, 0, 0];
      for (const [k, n] of counts) {
        const [u, vv] = uvAt(k, X0 + px + 0.5, Y0 + py + 0.5);
        const s = bilinear(img, u * tx - 0.5, vv * ty - 0.5);
        const cx = X0 + px + 0.5, cy = Y0 + py + 0.5;
        const vAlpha = va ? Math.min(1, Math.max(0, alf[3 * k] * cx + alf[3 * k + 1] * cy + alf[3 * k + 2])) : 1;
        for (let c = 0; c < 4; c++) col[c] += (s[c] * n * vAlpha) / (S * S);
      }
      const o = ((Y0 + py) * w + X0 + px) * 4;
      blendInto(acc, o, [col[0] * opacity * fx.tint[0], col[1] * opacity * fx.tint[1], col[2] * opacity * fx.tint[2]], col[3] * opacity, fx.blend);
    }
  }
}

/** Premultiplied bilinear sample (clamped to the image), channels in 0..1. */
function bilinear(img: Decoded, u: number, v: number): [number, number, number, number] {
  const cu = Math.min(img.width - 1, Math.max(0, u)), cv = Math.min(img.height - 1, Math.max(0, v));
  const x0 = Math.floor(cu), y0 = Math.floor(cv);
  const x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1);
  const fx = cu - x0, fy = cv - y0;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  const tap = (x: number, y: number, wgt: number) => {
    const o = (y * img.width + x) * 4;
    const a = img.data[o + 3] / 255;
    out[0] += (img.data[o] / 255) * a * wgt;
    out[1] += (img.data[o + 1] / 255) * a * wgt;
    out[2] += (img.data[o + 2] / 255) * a * wgt;
    out[3] += a * wgt;
  };
  tap(x0, y0, (1 - fx) * (1 - fy));
  tap(x1, y0, fx * (1 - fy));
  tap(x0, y1, (1 - fx) * fy);
  tap(x1, y1, fx * fy);
  return out;
}

export interface DiffStats {
  /** Max abs difference over premultiplied RGBA channels (0..255). */
  maxDiff: number;
  meanDiff: number;
  /** Pixels where any premultiplied channel differs by more than `tol`. */
  over: number;
  /** Pixels with alpha > 0 in either image. */
  covered: number;
  tol: number;
}

/** Compares two straight-alpha RGBA buffers in premultiplied space. */
export function diffImages(a: { width: number; height: number; data: Uint8Array }, b: { width: number; height: number; data: Uint8Array }, tol: number): DiffStats {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size mismatch ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  let maxDiff = 0, sum = 0, over = 0, covered = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    const o = i * 4;
    const aa = a.data[o + 3], ba = b.data[o + 3];
    if (aa || ba) covered++;
    let worst = Math.abs(aa - ba);
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs((a.data[o + c] * aa) / 255 - (b.data[o + c] * ba) / 255));
    maxDiff = Math.max(maxDiff, worst);
    sum += worst;
    if (worst > tol) over++;
  }
  return { maxDiff, meanDiff: sum / (a.width * a.height), over, covered, tol };
}

/**
 * Alpha of a render over the reference's flat interior: pixels whose reference alpha is
 * within ±1 of `target` and whose 8 neighbours are too (away from the art boundary).
 * Mesh seams cross this interior, so a crack or a doubled seam shows here.
 */
export function interiorAlpha(got: { width: number; data: Uint8Array }, ref: { width: number; height: number; data: Uint8Array }, target: number, tol: number) {
  let n = 0, bad = 0, min = 255, max = 0;
  const W = ref.width;
  for (let y = 1; y < ref.height - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      let flat = true;
      for (let dy = -1; dy <= 1 && flat; dy++) for (let dx = -1; dx <= 1; dx++) if (Math.abs(ref.data[((y + dy) * W + x + dx) * 4 + 3] - target) > 1) flat = false;
      if (!flat) continue;
      const a = got.data[(y * W + x) * 4 + 3];
      n++;
      min = Math.min(min, a);
      max = Math.max(max, a);
      if (Math.abs(a - target) > tol) bad++;
    }
  return { n, bad, min, max };
}
