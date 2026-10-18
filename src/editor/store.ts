// Editor state container. All project mutations go through mutate() or a gesture so
// undo/redo captures them; view/time/selection changes are deliberately not undoable.
import { playbackTime, samplePose, snapToFrame } from '../model/animation.ts';
import { History } from '../model/history.ts';
import type { Mat } from '../model/math.ts';
import type { EditMode } from '../model/ops.ts';
import { animationById } from '../model/ops.ts';
import { computeWorld } from '../model/skeleton.ts';
import type { Animation, Channel, LocalPose, Project } from '../model/types.ts';
import { cloneProject, emptyProject } from '../model/types.ts';

export type Selection = { kind: 'bone'; id: string } | { kind: 'attachment'; id: string } | null;
export type Tool = 'move' | 'rotate' | 'scale' | 'create';
export interface KeySelection {
  boneId: string;
  channel: Channel;
  time: number;
}
export type ChangeReason = 'project' | 'selection' | 'time' | 'view' | 'mode' | 'load';

export class Editor {
  project: Project = emptyProject();
  selection: Selection = null;
  keySel: KeySelection | null = null;
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
    for (const fn of this.listeners) fn(reason);
  }

  // ---- Mutation -----------------------------------------------------------------

  /** One undoable step. If fn throws, the project is left untouched and the error propagates. */
  mutate(label: string, fn: (p: Project) => void): void {
    if (this.gestureBefore) this.endGesture(label);
    const before = cloneProject(this.project);
    try {
      fn(this.project);
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
    if (this.animId && !p.animations.some((a) => a.id === this.animId)) this.animId = p.animations[0]?.id ?? null;
    if (!this.animId && this.mode === 'animate') this.mode = 'setup';
    if (this.keySel) {
      const anim = this.anim();
      const keys = anim?.tracks[this.keySel.boneId]?.[this.keySel.channel];
      if (!keys || !keys.some((k) => Math.abs(k.time - this.keySel!.time) < 1e-6)) this.keySel = null;
    }
    const anim = this.anim();
    if (anim && this.time > anim.duration) this.time = anim.duration;
  }

  // ---- Selection / mode / time ---------------------------------------------------

  select(sel: Selection): void {
    this.selection = sel;
    if (!sel || sel.kind !== 'bone' || (this.keySel && this.keySel.boneId !== sel.id)) this.keySel = null;
    this.emit('selection');
  }

  selectKey(k: KeySelection | null): void {
    this.keySel = k;
    if (k) {
      this.selection = { kind: 'bone', id: k.boneId };
      this.setTime(k.time);
      if (this.mode !== 'animate') this.setMode('animate');
    }
    this.emit('selection');
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

  /** Pose displayed on the canvas: animated in animate mode, setup pose otherwise. */
  pose(): Map<string, LocalPose> {
    const anim = this.mode === 'animate' ? this.anim() : null;
    return samplePose(this.project.bones, anim, this.time);
  }

  world(): Map<string, Mat> {
    return computeWorld(this.project.bones, this.pose());
  }

  selectedBoneId(): string | null {
    return this.selection?.kind === 'bone' ? this.selection.id : null;
  }
}
