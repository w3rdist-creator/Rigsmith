// Lottie (Bodymovin JSON) export of a *supported subset*, only where the result is exact
// under the Lottie model. Anything outside the subset is refused with a diagnostic that
// names the feature and the item; nothing is approximated.
//
// Supported: bone translate / rotate / scale keys (linear, step → hold, smooth and
// bezier → cubic easing handles; smooth = (1/3, 0, 2/3, 1), exactly 3t² − 2t³); flat
// image attachments (embedded PNG assets) with attachment offsets; opacity keys;
// visibility and image-swap keys and the chosen skin (as one image layer per run of
// constant image/visibility, using layer in/out points — exact at whole frames).
// Refused: IK and path constraints, meshes (and deform keys), draw-order keys.
//
// Mapping: every bone is a null layer (ty 3) parented like the skeleton; one extra root
// null moves the world so the composition matches the editor's PNG-sequence canvas
// (same size and origin at scale 1). Layer transform = T(p)·R(r)·S(s)·T(−a), parenting
// composes full matrices — the same as Rigsmith's bone model. Image layers (ty 2) are
// parented to their bone with p = attachment offset and a = image centre. Lottie draws
// layer 0 on top, so layers are written front to back. Position is split (p.s = true)
// so x and y ease independently exactly like Rigsmith's per-component interpolation.
import { flatEvents } from './events.ts';
import { isWhite, setupColor } from './color.ts';
import { lastExportFrame } from './sequence.ts';
import { frameWarnings, requestGeometry } from './sequence.ts';
import type { Bounds } from './evaluate.ts';
import { evaluate, frameBounds } from './evaluate.ts';
import type { Animation, Curve, Key, Project, ProjectFrame } from './types.ts';
import { hasInheritFlags } from './skeleton.ts';

export interface LottieDiagnostic {
  level: 'error' | 'note';
  feature: string;
  item: string;
  message: string;
}

export type LottieResult = { ok: true; lottie: Record<string, unknown>; diagnostics: LottieDiagnostic[] } | { ok: false; errors: string[]; diagnostics: LottieDiagnostic[] };

const LINEAR: Curve = [1 / 3, 1 / 3, 2 / 3, 2 / 3];
const SMOOTH: Curve = [1 / 3, 0, 2 / 3, 1];

/** Subset check without exporting: errors (refusals) and notes. */
export function lottieDiagnostics(project: Project, anim: Animation): LottieDiagnostic[] {
  const out: LottieDiagnostic[] = [];
  const err = (feature: string, item: string, message: string) => out.push({ level: 'error', feature, item, message });
  for (const k of project.ik ?? []) err('IK constraint', k.name, `IK “${k.name}” is solved at runtime; Lottie has no IK. Not exported. Rigsmith has no command that bakes IK into keys: to export this rig, delete the IK constraint and key the chain’s rotations by hand.`);
  for (const b of project.bones) if (hasInheritFlags(b)) err('inherit flags', b.name, `Bone “${b.name}” does not inherit its parent's full transform; Lottie parenting always does. Not exported.`);
  for (const k of project.transformConstraints ?? []) err('transform constraint', k.name, `Transform constraint “${k.name}” is solved at runtime; Lottie has no equivalent. Not exported.`);
  for (const k of project.springs ?? []) err('spring', k.name, `Spring “${k.name}” is simulated by Rigsmith; Lottie has no equivalent. Bake springs first (Bake springs, or rigsmith bake-springs).`);
  for (const k of project.pathConstraints ?? []) err('path constraint', k.name, `Path constraint “${k.name}” has no Lottie equivalent. Not exported.`);
  for (const a of project.attachments) if (a.mesh) err('mesh', a.name, `“${a.name}” is a mesh; Lottie image layers cannot deform. Not exported.`);
  for (const a of project.attachments) if (a.blend && a.blend !== 'normal') err('blend mode', a.name, `“${a.name}” uses the ${a.blend} blend mode; this exporter writes normal layers only. Not exported.`);
  for (const a of project.attachments) if (a.color && !isWhite(setupColor(a))) err('tint', a.name, `“${a.name}” is tinted; Lottie image layers have no tint in this subset. Not exported.`);
  if (anim.drawOrder?.length) err('draw-order keys', anim.name, `“${anim.name}” keys the draw order; Lottie layer order is fixed. Not exported.`);
  for (const [id, tr] of Object.entries(anim.tracks)) if (tr.translate.some((k) => k.interpY)) err('per-axis easing', project.bones.find((b) => b.id === id)?.name ?? id, 'Separate x / y easing on a translate key is not exported in this Lottie subset (one easing per keyframe). Not exported.');
  for (const [id, st] of Object.entries(anim.slots ?? {})) if (st.color?.length) err('colour keys', project.attachments.find((a) => a.id === id)?.name ?? id, 'Colour keys have no equivalent in this Lottie subset. Not exported.');
  for (const [id, st] of Object.entries(anim.slots ?? {})) if (st.deform?.length) err('deform keys', project.attachments.find((a) => a.id === id)?.name ?? id, 'Deform keys need meshes. Not exported.');
  if (anim.constraints && Object.keys(anim.constraints).length) err('constraint keys', anim.name, 'Constraint keys have no Lottie equivalent.');
  for (const im of project.images) if (im.mime !== 'image/png') err('image format', im.name, `${im.name} is ${im.mime}; only PNG assets are embedded.`);
  if (Object.values(anim.events ?? {}).some((ks) => ks.length)) out.push({ level: 'note', feature: 'timeline events', item: anim.name, message: 'Timeline events are written as Lottie markers (cm = name, or name|payload) at their frame.' });
  const discrete = Object.values(anim.slots ?? {}).some((s) => s.visible?.length || s.image?.length);
  if (discrete) out.push({ level: 'note', feature: 'visibility / image keys', item: anim.name, message: 'Exported as separate image layers switched by in/out points: exact at whole frames; a key between frames takes effect at the next frame (as in the PNG sequence).' });
  out.push({ level: 'note', feature: 'validation', item: anim.name, message: 'Fidelity is verified against Rigsmith’s own frames by an in-repo Lottie subset evaluator and by lottie-web 5.13.0 (canvas renderer, Chrome); not tested in lottie-web’s SVG/HTML renderers, After Effects or other players.' });
  return out;
}

const ease = (k: Key): { h?: 1; o?: { x: number[]; y: number[] }; i?: { x: number[]; y: number[] } } => {
  if (k.interp === 'step') return { h: 1 };
  const c = k.interp === 'bezier' && k.curve ? k.curve : k.interp === 'smooth' ? SMOOTH : LINEAR;
  return { o: { x: [c[0]], y: [c[1]] }, i: { x: [c[2]], y: [c[3]] } };
};

/** Animated property from keys (component `pick` of each value, scaled), or a static value. */
function prop(keys: readonly Key[] | undefined, fps: number, value: (k: Key) => number[], fallback: number[]): Record<string, unknown> {
  if (!keys?.length) return { a: 0, k: fallback };
  if (keys.length === 1) return { a: 0, k: value(keys[0]) };
  return {
    a: 1,
    k: keys.map((k, i) => {
      const last = i === keys.length - 1;
      return { t: k.time * fps, s: value(k), ...(last ? {} : ease(k)) };
    }),
  };
}

const scalarOf = (v: number[]) => (v.length === 1 ? v[0] : v);
function prop1(keys: readonly Key[] | undefined, fps: number, value: (k: Key) => number, fallback: number) {
  const p = prop(keys, fps, (k) => [value(k)], [fallback]);
  if (p.a === 0) return { a: 0, k: scalarOf(p.k as number[]) };
  return p;
}

/** `frame`: fixed composition (world rect at scale 1, art outside it clipped); default fits the animation. */
export function exportLottie(project: Project, animName: string, skinName: string | null, frame: ProjectFrame | null = null): LottieResult {
  const anim = project.animations.find((a) => a.name === animName);
  if (!anim) return { ok: false, errors: [`No animation named “${animName}”.`], diagnostics: [] };
  let skinId: string | null = null;
  if (skinName) {
    skinId = project.skins?.find((s) => s.name === skinName)?.id ?? null;
    if (!skinId) return { ok: false, errors: [`No skin named “${skinName}”.`], diagnostics: [] };
  }
  const diagnostics = lottieDiagnostics(project, anim);
  const errors = diagnostics.filter((d) => d.level === 'error').map((d) => `${d.feature} — ${d.item}: ${d.message}`);
  if (errors.length) return { ok: false, errors, diagnostics };

  const fps = anim.fps;
  const op = lastExportFrame(anim, fps) + 1;
  // Discrete state per frame and the canvas the PNG sequence would use.
  const frames = Array.from({ length: op }, (_, f) => evaluate(project, anim, Math.min(anim.duration, f / fps), { skinId }));
  let b: Bounds | null = null;
  for (const fr of frames) b = frameBounds(fr, b);
  if (!b) return { ok: false, errors: ['Nothing visible to export.'], diagnostics };
  const geo = requestGeometry(b, 1, 4, frame);
  for (const w of frameWarnings(b, frame, `“${anim.name}”`)) diagnostics.push({ level: 'note', feature: 'project frame', item: anim.name, message: w });

  let ind = 1;
  const base = (nm: string, ks: Record<string, unknown>, parent?: number) => ({ ddd: 0, ind: ind++, nm, sr: 1, ks, ao: 0, ip: 0, op, st: 0, bm: 0, ...(parent ? { parent } : {}) });
  const staticKs = (p: number[], r: number, s: number[], a: number[] = [0, 0, 0]) => ({ o: { a: 0, k: 100 }, r: { a: 0, k: r }, p: { a: 0, k: [...p, 0] }, a: { a: 0, k: a }, s: { a: 0, k: [...s.map((v) => v * 100), 100] } });

  const world = { ...base('world', staticKs([-geo.originX, -geo.originY], 0, [1, 1])), ty: 3 };
  const nulls: Record<string, unknown>[] = [world];
  const boneLayer = new Map<string, number>();
  const pending = [...project.bones];
  while (pending.length) {
    const i = pending.findIndex((x) => x.parentId === null || boneLayer.has(x.parentId));
    const bn = pending.splice(i, 1)[0];
    const tr = anim.tracks[bn.id];
    const ks = {
      o: { a: 0, k: 100 },
      r: prop1(tr?.rotate, fps, (k) => k.value[0], bn.rotation),
      p: { s: true, x: prop1(tr?.translate, fps, (k) => k.value[0], bn.x), y: prop1(tr?.translate, fps, (k) => k.value[1], bn.y) },
      a: { a: 0, k: [0, 0, 0] },
      s: prop(tr?.scale, fps, (k) => [k.value[0] * 100, k.value[1] * 100, 100], [bn.scaleX * 100, bn.scaleY * 100, 100]),
    };
    const layer = { ...base(`bone:${bn.name}`, ks, bn.parentId ? boneLayer.get(bn.parentId)! : (world.ind as number)), ty: 3 };
    boneLayer.set(bn.id, layer.ind as number);
    nulls.push(layer);
  }

  const assets = new Map<string, { id: string; w: number; h: number; u: string; p: string; e: 1 }>();
  const imageLayers: Record<string, unknown>[] = [];
  for (const att of project.attachments) {
    // Runs of frames with one (visible, image) state; hidden runs produce no layer.
    const runs: { from: number; to: number; imageId: string }[] = [];
    frames.forEach((fr, f) => {
      const af = fr.attachments.find((x) => x.att.id === att.id)!;
      const id = af.visible && af.image ? af.image.id : '';
      const last = runs[runs.length - 1];
      if (last && last.imageId === id && last.to === f) last.to = f + 1;
      else runs.push({ from: f, to: f + 1, imageId: id });
    });
    const opacity = anim.slots?.[att.id]?.opacity;
    for (const run of runs) {
      if (!run.imageId) continue;
      const im = project.images.find((x) => x.id === run.imageId)!;
      if (!assets.has(im.id)) assets.set(im.id, { id: `image_${assets.size}`, w: im.width, h: im.height, u: '', p: im.dataUrl, e: 1 });
      const ks = {
        o: prop1(opacity, fps, (k) => k.value[0] * 100, att.opacity * 100),
        ...(() => {
          const s = staticKs([att.x, att.y], att.rotation, [att.scaleX, att.scaleY], [im.width / 2, im.height / 2, 0]);
          return { r: s.r, p: s.p, a: s.a, s: s.s };
        })(),
      };
      const parent = att.boneId ? boneLayer.get(att.boneId)! : (world.ind as number);
      imageLayers.push({ ...base(`${att.name}:${im.name}`, ks, parent), ty: 2, refId: assets.get(im.id)!.id, ip: run.from, op: run.to });
    }
  }
  const events = flatEvents(anim);
  // Lottie draws the first layer on top: images front → back, then the (invisible) nulls.
  const lottie = {
    v: '5.7.0',
    fr: fps,
    ip: 0,
    op,
    w: geo.width,
    h: geo.height,
    nm: `${project.name} — ${anim.name}${skinName ? ` (${skinName})` : ''}`,
    ddd: 0,
    assets: [...assets.values()],
    layers: [...imageLayers.reverse(), ...nulls],
    meta: { g: 'Rigsmith Lottie subset exporter 1', origin: [geo.originX, geo.originY], loop: anim.loop },
    // Timeline events as Lottie markers (cm = event name, or name|payload).
    ...(events.length ? { markers: events.map((e) => ({ tm: e.time * fps, cm: e.payload !== undefined ? `${e.name}|${e.payload}` : e.name, dr: 0 })) } : {}),
  };
  return { ok: true, lottie, diagnostics };
}
