// Editor state container. All project mutations go through mutate() or a gesture so
// undo/redo captures them; view/time/selection changes are deliberately not undoable.
import { playbackTime, snapToFrame } from '../model/animation.ts';
import type { Frame } from '../model/evaluate.ts';
import { evaluate } from '../model/evaluate.ts';
import { History } from '../model/history.ts';
import type { KeyClipboard, KeyRef } from '../model/keys.ts';
import { parseLane, sameRef, validRefs } from '../model/keys.ts';
import type { Mat } from '../model/math.ts';
import type { PaintMode } from '../model/meshOps.ts';
import type { EditMode } from '../model/ops.ts';
import { animationById } from '../model/ops.ts';
import type { Animation, LocalPose, Project } from '../model/types.ts';
import { cloneProject, emptyProject } from '../model/types.ts';
import { repairReferences } from '../model/integrity.ts';

export type Selection =
  | { kind: 'bone'; id: string }
  | { kind: 'attachment'; id: string }
  /** IK or path constraint (ids are unique across both). */
  | { kind: 'constraint'; id: string }
  | { kind: 'path'; id: string }
  | null;
export type Tool = 'move' | 'rotate' | 'scale' | 'create';
export type KeySelection = KeyRef;
export type ChangeReason = 'project' | 'selection' | 'time' | 'view' | 'mode' | 'load';

/** Onion skin / ghost frames: editor view state (not undoable, not saved in the project). */
export interface OnionSettings {
  enabled: boolean;
  before: number;
  after: number;
  /** Frames between ghosts. */
  step: number;
}

export class Editor {
  project: Project = emptyProject();
  selection: Selection = null;
  /** Primary selected key (drives the curve editor and interpolation control). */
  keySel: KeySelection | null = null;
  /** All selected keys (includes keySel). */
  keySels: KeySelection[] = [];
  clipboard: KeyClipboard | null = null;
  onion: OnionSettings = { enabled: false, before: 2, after: 2, step: 2 };
  /** Active skin for display/export (view state). */
  skinId: string | null = null;
  /**
   * In-progress drags outside the canvas (timeline keys, curve handles) register a
   * canceller here; Esc calls them. Each returns true if it cancelled something.
   */
  readonly cancelHooks = new Set<() => boolean>();
  /** Setup-mode Move tool moves a bone's origin only (images/children stay put). */
  pivotMode = false;
  /** Selected node of the selected path (view state). */
  pathNode = 0;
  /** Notes from the last reference repair (e.g. constraints removed with a bone). */
  lastRepairs: string[] = [];
  /** Canvas tool on the selected mesh attachment (view state): drag vertices or paint weights. */
  meshTool: 'off' | 'vertices' | 'weights' = 'off';
  /** Selected vertex of the selected mesh (-1 = none). */
  meshVertex = -1;
  /** Weight brush: radius in screen px, strength 0..1 per dab at the centre (linear falloff). */
  brush: { boneId: string | null; radius: number; strength: number; mode: PaintMode } = { boneId: null, radius: 40, strength: 0.2, mode: 'add' };
  mode: EditMode = 'setup';
  tool: Tool = 'move';
  animId: string | null = null;
  time = 0;
  playing = false;
  showBones = true;
  dirty = false;
  readonly history = new History<Project>();

  private listeners = new Set<(r: ChangeReason) => void>();
  private gestureBefore: Project | null = null;
  private gestureChanged = false;
  private playStart = 0;

  subscribe(fn: (r: ChangeReason) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(reason: ChangeReason): void {
    this.revision++;
    for (const fn of this.listeners) fn(reason);
  }

  // ---- Mutation -----------------------------------------------------------------

  /** One undoable step. If fn throws, the project is left untouched and the error propagates. */
  mutate(label: string, fn: (p: Project) => void): void {
    if (this.gestureBefore) this.endGesture(label);
    const before = cloneProject(this.project);
    try {
      fn(this.project);
      this.lastRepairs = repairReferences(this.project);
    } catch (e) {
      this.project = before;
      this.emit('project');
      throw e;
    }
    this.history.record(label, before);
    this.dirty = true;
    this.sanitize();
    this.emit('project');
  }

  beginGesture(): void {
    this.gestureBefore = cloneProject(this.project);
    this.gestureChanged = false;
  }

  gestureMutate(fn: (p: Project) => void): void {
    if (!this.gestureBefore) this.beginGesture();
    fn(this.project);
    this.gestureChanged = true;
    this.emit('project');
  }

  /** Commits the gesture as a single undo step (no-op if nothing changed). */
  endGesture(label: string): void {
    const before = this.gestureBefore;
    this.gestureBefore = null;
    if (before && this.gestureChanged) {
      this.lastRepairs = repairReferences(this.project);
      this.history.record(label, before);
      this.dirty = true;
      this.emit('project');
    }
    this.gestureChanged = false;
  }

  cancelGesture(): void {
    if (this.gestureBefore) {
      this.project = this.gestureBefore;
      this.gestureBefore = null;
      this.gestureChanged = false;
      this.sanitize();
      this.emit('project');
    }
  }

  get inGesture(): boolean {
    return this.gestureBefore !== null;
  }

  undo(): boolean {
    if (this.gestureBefore) return false;
    const label = this.history.undoLabel();
    const s = this.history.undo(this.project);
    if (!s) return false;
    this.project = s;
    this.dirty = true;
    this.sanitize();
    this.emit('project');
    this.lastUndoRedo = label ? `Undid: ${label}` : 'Undid';
    return true;
  }

  redo(): boolean {
    if (this.gestureBefore) return false;
    const label = this.history.redoLabel();
    const s = this.history.redo(this.project);
    if (!s) return false;
    this.project = s;
    this.dirty = true;
    this.sanitize();
    this.emit('project');
    this.lastUndoRedo = label ? `Redid: ${label}` : 'Redid';
    return true;
  }

  lastUndoRedo = '';

  /** Replaces the whole project (new/open/demo). Clears history. */
  load(project: Project, opts: { animId?: string | null; mode?: EditMode } = {}): void {
    this.stop();
    this.project = project;
    this.history.clear();
    this.selection = null;
    this.keySel = null;
    this.keySels = [];
    this.skinId = null;
    this.animId = opts.animId === undefined ? (project.animations[0]?.id ?? null) : opts.animId;
    this.mode = opts.mode ?? 'setup';
    this.time = 0;
    this.dirty = false;
    this.emit('load');
  }

  /** Drops dangling selection/animation references after undo or deletion. */
  private sanitize(): void {
    const p = this.project;
    if (this.selection?.kind === 'bone' && !p.bones.some((b) => b.id === this.selection!.id)) this.selection = null;
    if (this.selection?.kind === 'attachment' && !p.attachments.some((a) => a.id === this.selection!.id)) this.selection = null;
    if (this.selection?.kind === 'constraint' && ![...(p.ik ?? []), ...(p.pathConstraints ?? [])].some((c) => c.id === this.selection!.id)) this.selection = null;
    if (this.selection?.kind === 'path' && !p.paths?.some((x) => x.id === this.selection!.id)) this.selection = null;
    const path = this.selection?.kind === 'path' ? p.paths?.find((x) => x.id === this.selection!.id) : undefined;
    if (path && this.pathNode >= path.nodes.length) this.pathNode = path.nodes.length - 1;
    const meshAtt = this.selection?.kind === 'attachment' ? p.attachments.find((a) => a.id === this.selection!.id) : undefined;
    if (!meshAtt?.mesh) {
      this.meshTool = 'off';
      this.meshVertex = -1;
    } else if (this.meshVertex >= meshAtt.mesh.points.length / 2) this.meshVertex = -1;
    if (this.brush.boneId && !p.bones.some((b) => b.id === this.brush.boneId)) this.brush.boneId = null;
    if (this.animId && !p.animations.some((a) => a.id === this.animId)) this.animId = p.animations[0]?.id ?? null;
    if (!this.animId && this.mode === 'animate') this.mode = 'setup';
    const anim = this.anim();
    this.keySels = anim ? validRefs(anim, this.keySels) : [];
    if (this.keySel && !this.keySels.some((r) => sameRef(r, this.keySel!))) this.keySel = this.keySels[0] ?? null;
    if (this.skinId && !p.skins?.some((s) => s.id === this.skinId)) this.skinId = null;
    if (anim && this.time > anim.duration) this.time = anim.duration;
  }

  /** Shows a skin in the viewport and exports (null = default images). View state, not undoable. */
  setSkin(id: string | null): void {
    this.skinId = id && this.project.skins?.some((s) => s.id === id) ? id : null;
    this.emit('selection');
  }

  // ---- Selection / mode / time ---------------------------------------------------

  select(sel: Selection): void {
    const prev = this.selection;
    if (!(sel?.kind === 'attachment' && prev?.kind === 'attachment' && prev.id === sel.id)) {
      this.meshTool = 'off';
      this.meshVertex = -1;
    }
    this.selection = sel;
    // Keep selected keys that belong to the newly selected item; drop the rest.
    const owner = (r: KeyRef) => {
      const info = parseLane(r.lane);
      if (!info || info.kind === 'draw') return null;
      return { kind: info.kind === 'bone' ? 'bone' : info.kind === 'slot' ? 'attachment' : 'constraint', id: info.id };
    };
    if (sel?.kind === 'path' && (this.selection?.kind !== 'path' || this.selection.id !== sel.id)) this.pathNode = 0;
    this.keySels = sel ? this.keySels.filter((r) => {
      const o = owner(r);
      return !o || (o.kind === sel.kind && o.id === sel.id);
    }) : [];
    if (this.keySel && !this.keySels.some((r) => sameRef(r, this.keySel!))) this.keySel = this.keySels[0] ?? null;
    this.emit('selection');
  }

  /** Selects exactly one key (or none), jumping the playhead to it. */
  selectKey(k: KeySelection | null): void {
    this.keySel = k;
    this.keySels = k ? [k] : [];
    if (k) {
      const info = parseLane(k.lane);
      if (info?.kind === 'bone') this.selection = { kind: 'bone', id: info.id };
      else if (info?.kind === 'slot') this.selection = { kind: 'attachment', id: info.id };
      else if (info?.kind === 'constraint') this.selection = { kind: 'constraint', id: info.id };
      this.setTime(k.time);
      if (this.mode !== 'animate') this.setMode('animate');
    }
    this.emit('selection');
  }

  /** Replaces the multi-key selection (primary = `primary` or the first ref). */
  setKeySelection(refs: KeySelection[], primary?: KeySelection | null): void {
    const anim = this.anim();
    this.keySels = anim ? validRefs(anim, refs) : [];
    this.keySel = primary && this.keySels.some((r) => sameRef(r, primary)) ? primary : (this.keySels[0] ?? null);
    if (this.keySels.length && this.mode !== 'animate') this.setMode('animate');
    this.emit('selection');
  }

  /** Adds or removes one key from the selection (Shift/Ctrl-click). */
  toggleKeyInSelection(k: KeySelection): void {
    const has = this.keySels.some((r) => sameRef(r, k));
    this.setKeySelection(has ? this.keySels.filter((r) => !sameRef(r, k)) : [...this.keySels, k], has ? this.keySel : k);
  }

  isKeySelected(k: KeySelection): boolean {
    return this.keySels.some((r) => sameRef(r, k));
  }

  /** Esc: cancels the active non-canvas drag, if any. */
  cancelActiveDrag(): boolean {
    for (const fn of this.cancelHooks) if (fn()) return true;
    return false;
  }

  setMode(mode: EditMode): void {
    if (mode === 'animate' && !this.anim()) return;
    if (this.inGesture) return;
    if (mode === 'setup') this.stop();
    this.mode = mode;
    this.emit('mode');
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.emit('view');
  }

  setAnimation(id: string | null): void {
    this.stop();
    this.animId = id;
    this.keySel = null;
    this.keySels = [];
    this.time = 0;
    if (!id) this.mode = 'setup';
    this.emit('mode');
  }

  setTime(t: number): void {
    const anim = this.anim();
    const max = anim?.duration ?? 0;
    this.time = Math.min(Math.max(0, t), max);
    if (this.playing) this.playStart = performance.now() - this.time * 1000;
    this.emit('time');
  }

  play(): void {
    const anim = this.anim();
    if (!anim) return;
    if (this.mode !== 'animate') this.setMode('animate');
    if (!anim.loop && this.time >= anim.duration) this.time = 0;
    this.playing = true;
    this.playStart = performance.now() - this.time * 1000;
    this.emit('time');
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    // Land on a whole frame so the pose shown is exactly the frame that edits will key
    // (otherwise an edit keys frame N while the display samples N + a fraction).
    const anim = this.anim();
    if (anim) this.time = Math.min(anim.duration, snapToFrame(this.time, anim.fps));
    this.emit('time');
  }

  togglePlay(): void {
    if (this.playing) this.stop();
    else this.play();
  }

  /** Advances the playhead from the wall clock; called once per animation frame. */
  tick(now: number): void {
    if (!this.playing) return;
    const anim = this.anim();
    if (!anim) {
      this.playing = false;
      return;
    }
    const { time, finished } = playbackTime(anim, (now - this.playStart) / 1000);
    this.time = time;
    if (finished) this.playing = false;
    this.emit('time');
  }

  // ---- Derived -------------------------------------------------------------------

  anim(): Animation | null {
    return animationById(this.project, this.animId);
  }

  /** Animation shown on the canvas: the current one in animate mode, none in setup. */
  shownAnim(): Animation | null {
    return this.mode === 'animate' ? this.anim() : null;
  }

  /** Fully evaluated frame displayed on the canvas (constraints, slots, meshes, skin). */
  frame(): Frame {
    const key = `${this.mode}|${this.animId}|${this.time}|${this.skinId}|${this.revision}`;
    if (this.frameCache?.key === key && this.frameCache.project === this.project) return this.frameCache.frame;
    const frame = evaluate(this.project, this.shownAnim(), this.time, { skinId: this.skinId });
    this.frameCache = { key, project: this.project, frame };
    return frame;
  }

  private frameCache: { key: string; project: Project; frame: Frame } | null = null;
  /** Bumped on every emit so cached frames never outlive a mutation. */
  private revision = 0;

  /** Local pose displayed on the canvas (after constraints). */
  pose(): Map<string, LocalPose> {
    return this.frame().pose;
  }

  world(): Map<string, Mat> {
    return this.frame().world;
  }

  selectedBoneId(): string | null {
    return this.selection?.kind === 'bone' ? this.selection.id : null;
  }
}
