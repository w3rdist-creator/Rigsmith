// Runtime loader: turns a `rigsmith.runtime` file (v1 or v2) into the in-memory rig the
// player evaluates. Everything is referenced by name in the file; names become ids here.
// The player then evaluates with the shared model code (src/model/evaluate.ts,
// constraints.ts, mesh.ts, mix.ts, animation.ts, curve.ts) — the same code the editor
// uses — so what this loader proves is that the runtime file alone carries the full rig.
// A v1 file has no curves, slots, constraints, skins or mixes; those load empty.
import type { RuntimeExport, RuntimeKey } from '../model/exportRuntime.ts';
import { RUNTIME_FORMAT_ID } from '../model/exportRuntime.ts';
import type { Animation, Attachment, Bone, ImageAsset, Key, Project } from '../model/types.ts';
import { FORMAT_ID } from '../model/types.ts';

export class RuntimeError extends Error {}

const keys = (ks: RuntimeKey[] | undefined): Key[] =>
  (ks ?? []).map((k) => ({ time: k.time, value: k.value.slice(), interp: k.interp, ...(k.curve ? { curve: [...k.curve] as Key['curve'] } : {}) }));

export function loadRuntime(raw: unknown): Project {
  const rt = raw as RuntimeExport;
  if (!rt || typeof rt !== 'object' || rt.format !== RUNTIME_FORMAT_ID) throw new RuntimeError('Not a rigsmith.runtime file.');
  if ((rt.version as number) !== 1 && rt.version !== 2) throw new RuntimeError(`Unsupported runtime version ${rt.version}.`);
  if (!Array.isArray(rt.bones) || !Array.isArray(rt.attachments) || !Array.isArray(rt.animations)) throw new RuntimeError('Runtime file is missing bones, attachments or animations.');
  const boneNames = new Set(rt.bones.map((b) => b.name));
  const need = (set: Set<string>, n: string, what: string) => {
    if (!set.has(n)) throw new RuntimeError(`Unknown ${what} “${n}”.`);
    return n;
  };
  const bones: Bone[] = rt.bones.map((b) => ({ id: b.name, name: b.name, parentId: b.parent === null ? null : need(boneNames, b.parent, 'parent bone'), x: b.x, y: b.y, rotation: b.rotation, scaleX: b.scaleX, scaleY: b.scaleY, length: b.length, color: '#8aa0ff' }));
  const imgList = rt.images ?? rt.attachments.map((a) => ({ name: a.image, width: a.width, height: a.height }));
  const images: ImageAsset[] = [];
  for (const im of imgList) if (!images.some((x) => x.id === im.name)) images.push({ id: im.name, name: im.name, mime: '', width: im.width, height: im.height, dataUrl: '' });
  const imageNames = new Set(images.map((i) => i.id));
  const attachments: Attachment[] = rt.attachments.map((a) => ({
    id: a.name,
    name: a.name,
    boneId: a.bone === null ? null : need(boneNames, a.bone, 'bone'),
    imageId: need(imageNames, a.image, 'image'),
    x: a.x,
    y: a.y,
    rotation: a.rotation,
    scaleX: a.scaleX,
    scaleY: a.scaleY,
    opacity: a.opacity,
    ...(a.hidden ? { hidden: true } : {}),
    ...(a.mesh
      ? { mesh: { points: a.mesh.uvs.slice(), triangles: a.mesh.triangles.slice(), hull: a.mesh.hull, ...(a.mesh.weights ? { weights: a.mesh.weights.map((l) => l.map((x) => ({ bone: need(boneNames, x.bone, 'weight bone'), w: x.w }))) } : {}) } }
      : {}),
  }));
  const attNames = new Set(attachments.map((a) => a.id));
  const animations: Animation[] = rt.animations.map((an) => {
    const tracks: Animation['tracks'] = {};
    for (const [bn, t] of Object.entries(an.keys ?? {})) tracks[need(boneNames, bn, 'bone')] = { translate: keys(t.translate), rotate: keys(t.rotate), scale: keys(t.scale) };
    const slots: NonNullable<Animation['slots']> = {};
    for (const [n, st] of Object.entries(an.slots ?? {})) {
      slots[need(attNames, n, 'attachment')] = {
        ...(st.visible ? { visible: keys(st.visible) } : {}),
        ...(st.opacity ? { opacity: keys(st.opacity) } : {}),
        ...(st.image ? { image: st.image.map((k) => ({ time: k.time, imageId: need(imageNames, k.image, 'image') })) } : {}),
        ...(st.deform ? { deform: keys(st.deform) } : {}),
      };
    }
    const constraints: NonNullable<Animation['constraints']> = {};
    for (const [n, ct] of Object.entries(an.constraints ?? {})) constraints[n] = { ...(ct.mix ? { mix: keys(ct.mix) } : {}), ...(ct.position ? { position: keys(ct.position) } : {}) };
    return {
      id: an.name,
      name: an.name,
      duration: an.duration,
      fps: an.fps,
      loop: an.loop,
      tracks,
      ...(Object.keys(slots).length ? { slots } : {}),
      ...(an.drawOrder?.length ? { drawOrder: an.drawOrder.map((k) => ({ time: k.time, order: k.order.map((n) => need(attNames, n, 'attachment')) })) } : {}),
      ...(Object.keys(constraints).length ? { constraints } : {}),
    };
  });
  const project: Project = { format: FORMAT_ID, version: 2, name: rt.name, bones, images, attachments, animations };
  if (rt.ik?.length) project.ik = rt.ik.map((k) => ({ id: k.name, name: k.name, bones: k.bones.map((b) => need(boneNames, b, 'IK bone')), target: need(boneNames, k.target, 'IK target'), mix: k.mix, bendPositive: k.bendPositive }));
  if (rt.paths?.length) project.paths = rt.paths.map((p) => ({ id: p.name, name: p.name, boneId: p.bone === null ? null : need(boneNames, p.bone, 'path bone'), closed: p.closed, nodes: p.nodes.map((n) => ({ ...n })) }));
  const pathNames = new Set((project.paths ?? []).map((p) => p.id));
  if (rt.pathConstraints?.length)
    project.pathConstraints = rt.pathConstraints.map((c) => ({ id: c.name, name: c.name, pathId: need(pathNames, c.path, 'path'), bones: c.bones.map((b) => need(boneNames, b, 'path bone')), position: c.position, spacing: c.spacing, mix: c.mix, rotate: c.rotate, rotateOffset: c.rotateOffset }));
  if (rt.skins?.length)
    project.skins = rt.skins.map((s) => ({ id: s.name, name: s.name, entries: s.entries.map((e) => ({ attachmentId: need(attNames, e.attachment, 'attachment'), imageId: need(imageNames, e.image, 'image'), ...(e.from ? { from: need(imageNames, e.from, 'image') } : {}) })) }));
  const animNames = new Set(animations.map((a) => a.id));
  if (rt.mixes?.length) project.mixes = rt.mixes.map((m) => ({ from: need(animNames, m.from, 'animation'), to: need(animNames, m.to, 'animation'), duration: m.duration }));
  return project;
}
