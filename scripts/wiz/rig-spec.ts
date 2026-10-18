// Wiz rig + animation spec for the Rigsmith acceptance test. Pure data/maths: the
// numbers here are TYPED INTO THE EDITOR'S VISIBLE CONTROLS by build-in-editor.ts; this
// module never writes a project file itself.
//
// Coordinates: the prepared manifest is in source pixels of wiz_master.png (y down).
// Rigsmith world = source px - ground point (between the shoes, at the lowest matte row),
// so the setup pose reproduces the original artwork pixel for pixel at zoom 1.

export interface Manifest {
  source: { sha256: string; width: number; height: number };
  limbs: Record<string, { pivot: [number, number]; wrist?: [number, number]; axisAngleDeg: number }>;
  parts: Record<string, { file: string; sha256: string; bbox: [number, number, number, number]; centre: [number, number] }>;
  rigPoints: { hip: [number, number]; ground: [number, number] };
  drawOrder: string[];
}

export interface BoneSetup {
  name: string;
  parent: string | null;
  /** Local setup values exactly as typed into the inspector. */
  x: number;
  y: number;
  rotation: number;
  length: number;
  /** Expected world origin (Rigsmith world coords) and world angle, for assertions. */
  world: { x: number; y: number; angle: number };
}

export interface AttachmentSetup {
  file: string;
  name: string;
  bone: string;
  x: number;
  y: number;
  rotation: number;
}

export type Channel = 'translate' | 'rotate' | 'scale';

/** One key: `v` is a delta from the setup pose (rotate: degrees added; translate: px
 * added to setup x/y; scale: absolute factors, setup scale is 1). */
export interface KeySpec {
  bone: string;
  ch: Channel;
  frame: number;
  v: number[];
}

export interface AnimSpec {
  name: string;
  duration: number;
  fps: number;
  interp: 'linear' | 'smooth' | 'step';
  keys: KeySpec[];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000 || 0; // no -0
const wrap = (d: number) => {
  let a = ((d + 180) % 360 + 360) % 360 - 180;
  if (a === -180) a = 180;
  return a;
};
const rad = (d: number) => (d * Math.PI) / 180;

/** Which bone each prepared image follows. */
export const PART_BONE: Record<string, string> = {
  leg_l: 'leg_l',
  leg_r: 'leg_r',
  sleeve_hole_l: 'body',
  sleeve_hole_r: 'body',
  arm_l: 'arm_l',
  arm_r: 'arm_r',
  body: 'body',
  hand_l: 'hand_l',
  hand_r: 'hand_r',
};

export function buildRig(m: Manifest): { bones: BoneSetup[]; attachments: AttachmentSetup[] } {
  const [gx, gy] = m.rigPoints.ground;
  const w = (p: [number, number]) => ({ x: p[0] - gx, y: p[1] - gy });
  const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const L = m.limbs;
  // name, parent, world origin (source px), world angle, length
  const spec: [string, string | null, [number, number], number, number][] = [
    ['root', null, [gx, gy], -90, 110],
    ['body', 'root', m.rigPoints.hip, -90, 520],
    ['leg_l', 'root', L.leg_l.pivot, L.leg_l.axisAngleDeg, 200],
    ['leg_r', 'root', L.leg_r.pivot, L.leg_r.axisAngleDeg, 200],
    ['arm_l', 'body', L.arm_l.pivot, L.arm_l.axisAngleDeg, dist(L.arm_l.pivot, L.arm_l.wrist!)],
    ['hand_l', 'arm_l', L.arm_l.wrist!, L.arm_l.axisAngleDeg, 130],
    ['arm_r', 'body', L.arm_r.pivot, L.arm_r.axisAngleDeg, dist(L.arm_r.pivot, L.arm_r.wrist!)],
    ['hand_r', 'arm_r', L.arm_r.wrist!, L.arm_r.axisAngleDeg, 130],
  ];
  const bones: BoneSetup[] = [];
  const byName = new Map<string, BoneSetup>();
  for (const [name, parent, origin, angle, length] of spec) {
    const wo = w(origin);
    let x = wo.x, y = wo.y, rotation = angle;
    const p = parent ? byName.get(parent)! : null;
    if (p) {
      // Parent scale is 1 in setup, so local = R(-parentAngle) · (origin - parentOrigin).
      const dx = wo.x - p.world.x, dy = wo.y - p.world.y;
      const c = Math.cos(rad(-p.world.angle)), s = Math.sin(rad(-p.world.angle));
      x = c * dx - s * dy;
      y = s * dx + c * dy;
      rotation = wrap(angle - p.world.angle);
    }
    const b: BoneSetup = { name, parent, x: r3(x), y: r3(y), rotation: r3(rotation), length: r3(length), world: { x: wo.x, y: wo.y, angle } };
    bones.push(b);
    byName.set(name, b);
  }
  const attachments: AttachmentSetup[] = m.drawOrder.map((part) => {
    const P = m.parts[part];
    const bone = byName.get(PART_BONE[part])!;
    const cw = w(P.centre);
    const dx = cw.x - bone.world.x, dy = cw.y - bone.world.y;
    const c = Math.cos(rad(-bone.world.angle)), s = Math.sin(rad(-bone.world.angle));
    return { file: P.file, name: part, bone: bone.name, x: r3(c * dx - s * dy), y: r3(s * dx + c * dy), rotation: r3(-bone.world.angle) };
  });
  return { bones, attachments };
}

// Rotation signs (y-down, clockwise positive): for arm_l / leg_l (pointing down-left)
// a positive delta swings the limb outward; for arm_r / leg_r a negative delta does.
const rot = (bone: string, pairs: [number, number][]): KeySpec[] => pairs.map(([frame, d]) => ({ bone, ch: 'rotate', frame, v: [d] }));
const scl = (bone: string, triples: [number, number, number][]): KeySpec[] => triples.map(([frame, sx, sy]) => ({ bone, ch: 'scale', frame, v: [sx, sy] }));
const mov = (bone: string, triples: [number, number, number][]): KeySpec[] => triples.map(([frame, dx, dy]) => ({ bone, ch: 'translate', frame, v: [dx, dy] }));

/** Subtle idle: 3 s breathing + small sway, arms and gloves drifting out of phase. */
export const IDLE: AnimSpec = {
  name: 'idle',
  duration: 3,
  fps: 30,
  interp: 'smooth',
  keys: [
    // body bone points up, so its local scaleX is the vertical stretch (breath in).
    ...scl('body', [[0, 1, 1], [45, 1.016, 0.992], [90, 1, 1]]),
    ...rot('body', [[0, 0.8], [45, -0.8], [90, 0.8]]),
    ...rot('arm_l', [[0, 0], [40, 4], [90, 0]]),
    ...rot('arm_r', [[0, 0], [50, -4], [90, 0]]),
    ...rot('hand_l', [[0, 0], [52, 7], [90, 0]]),
    ...rot('hand_r', [[0, 0], [62, -7], [90, 0]]),
  ],
};

/** Greeting: a little hop, then Wiz throws up his (screen-right) arm and waves the glove
 * with a cocky lean, then settles back to the rest pose so the clip loops. */
export const GREETING: AnimSpec = {
  name: 'greeting',
  duration: 2.4,
  fps: 30,
  interp: 'smooth',
  keys: [
    ...mov('root', [[0, 0, 0], [5, 0, -34], [10, 0, 0]]),
    ...scl('body', [[0, 1, 1], [10, 0.965, 1.025], [15, 1.01, 0.995], [20, 1, 1]]),
    ...rot('leg_l', [[0, 0], [5, 7], [10, 0]]),
    ...rot('leg_r', [[0, 0], [5, -7], [10, 0]]),
    ...rot('body', [[0, 0], [14, 3.5], [46, 3.5], [60, 0], [72, 0]]),
    ...rot('arm_r', [[0, 0], [12, -80], [18, -68], [24, -84], [30, -68], [36, -84], [42, -70], [48, -80], [62, 0], [72, 0]]),
    ...rot('hand_r', [[0, 0], [12, -12], [18, 22], [24, -22], [30, 22], [36, -22], [42, 22], [48, 0], [62, 0], [72, 0]]),
    ...rot('arm_l', [[0, 0], [8, 14], [20, 7], [48, 7], [62, 0], [72, 0]]),
    ...rot('hand_l', [[0, 0], [10, 12], [48, 10], [62, 0], [72, 0]]),
  ],
};

export const ANIMS: AnimSpec[] = [IDLE, GREETING];

/** Absolute local value of a key, as typed into the inspector. */
export function keyValue(bone: BoneSetup, k: KeySpec): number[] {
  if (k.ch === 'rotate') return [r3(bone.rotation + k.v[0])];
  if (k.ch === 'translate') return [r3(bone.x + k.v[0]), r3(bone.y + k.v[1])];
  return [r3(k.v[0]), r3(k.v[1])];
}
