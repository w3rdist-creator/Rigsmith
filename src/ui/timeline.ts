// Timeline: animation settings, transport, scrubbing, key lanes (bone channels, slot,
// constraint and draw-order lanes), multi-key selection, group retime, copy/paste,
// nudge, loop seam, and the curve editor.
import { frameCount, keysBeyondEnd, snapToFrame } from '../model/animation.ts';
import { describePortable } from '../model/clipboard.ts';
import type { KeyRef } from '../model/keys.ts';
import { DRAW_LANE, boneLane, constraintLane, laneKeys, refsInRange, sameRef, shiftKeys, slotLane } from '../model/keys.ts';
import { topoOrder } from '../model/skeleton.ts';
import type { Animation, Interp, Key } from '../model/types.ts';
import { CHANNELS, INTERPS } from '../model/types.ts';
import type { App } from './app.ts';
import { CurveEditor } from './curveEditor.ts';
import { append, clear, fmt, h } from './dom.ts';

/** Zoom levels in screen pixels per frame; "fit" shows the whole animation. */
export const PITCH_LEVELS = [2, 3, 4, 6, 8, 12, 16, 24] as const;
/** Spacing (frames) of ticks / numbered ticks for a pitch in px per frame. */
function rulerSpacing(pitch: number): { tick: number; label: number } {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  return { tick: steps.find((s) => s * pitch >= 4) ?? 1000, label: steps.find((s) => s * pitch >= 36) ?? 1000 };
}

const CH_LABEL: Record<string, string> = { translate: 'translate', rotate: 'rotate', scale: 'scale', visible: 'visible', opacity: 'opacity', image: 'image', deform: 'deform', mix: 'mix', position: 'position' };

interface Row {
  lane: string;
  owner: string;
  ch: string;
  selected: boolean;
  onLabel?: () => void;
}

type Drag =
  | { kind: 'keys'; anchorFrame: number; lastDelta: number; refs: KeyRef[]; primary: KeyRef; base: Animation; animIndex: number; moved: boolean; pointerId: number }
  | { kind: 'marquee'; x0: number; y0: number; additive: boolean; box: HTMLElement; pointerId: number }
  | { kind: 'scrub'; pointerId: number };

export class Timeline {
  private root: HTMLElement;
  private app: App;
  private playhead: HTMLElement | null = null;
  private readout: HTMLElement | null = null;
  private playBtn: HTMLButtonElement | null = null;
  private lanes: HTMLElement | null = null;
  private laneEls = new Map<string, HTMLElement>();
  private rows: Row[] = [];
  private drag: Drag | null = null;
  readonly curve: CurveEditor;
  /** True while a drag owns pointer capture; rebuilding the DOM then would drop it. */
  interacting = false;
  /** Time zoom: px per frame, or null = fit the whole animation (kept across rebuilds). */
  private pitch: number | null = null;
  private scrollX = 0;
  private body: HTMLElement | null = null;

  constructor(app: App, root: HTMLElement) {
    this.app = app;
    this.root = root;
    this.curve = new CurveEditor(app, this);
    app.ed.subscribe((r) => {
      if (r === 'time' || r === 'view' || this.interacting) {
        this.updateTime();
        if (this.interacting && this.drag?.kind === 'keys') this.drawKeys();
      } else this.render();
    });
    app.ed.cancelHooks.add(() => this.cancelDrag());
    this.render();
  }

  private updateTime(): void {
    const ed = this.app.ed;
    const anim = ed.anim();
    if (!anim) return;
    if (this.playhead) this.playhead.style.left = `${(ed.time / anim.duration) * 100}%`;
    if (this.readout) {
      const f = Math.round(ed.time * anim.fps);
      this.readout.textContent = `${String(f).padStart(3, ' ')} / ${frameCount(anim)}  ·  ${ed.time.toFixed(2)}s`;
    }
    if (this.playBtn) {
      this.playBtn.textContent = ed.playing ? '■ Pause' : '▶ Play';
      this.playBtn.setAttribute('aria-label', ed.playing ? 'Pause' : 'Play');
      this.playBtn.classList.toggle('on', ed.playing);
    }
    this.root.classList.toggle('playing', ed.playing);
  }

  private buildRows(anim: Animation): Row[] {
    const ed = this.app.ed;
    const p = ed.project;
    const selBone = ed.selectedBoneId();
    const selAtt = ed.selection?.kind === 'attachment' ? ed.selection.id : null;
    const rows: Row[] = [];
    for (const b of topoOrder(p.bones)) {
      const tr = anim.tracks[b.id];
      for (const ch of CHANNELS)
        if ((tr && tr[ch].length) || b.id === selBone) rows.push({ lane: boneLane(b.id, ch), owner: b.name, ch, selected: b.id === selBone, onLabel: () => ed.select({ kind: 'bone', id: b.id }) });
    }
    for (const a of p.attachments) {
      const st = anim.slots?.[a.id];
      const chans = (['visible', 'opacity', 'image', 'deform'] as const).filter((ch) => st?.[ch]?.length || (a.id === selAtt && ch !== 'deform') || (a.id === selAtt && ch === 'deform' && a.mesh));
      for (const ch of chans) rows.push({ lane: slotLane(a.id, ch), owner: a.name, ch, selected: a.id === selAtt, onLabel: () => ed.select({ kind: 'attachment', id: a.id }) });
    }
    const selC = ed.selection?.kind === 'constraint' ? ed.selection.id : null;
    for (const c of [...(p.ik ?? []), ...(p.pathConstraints ?? [])]) {
      const ct = anim.constraints?.[c.id];
      const chans = 'pathId' in c ? (['mix', 'position'] as const) : (['mix'] as const);
      for (const ch of chans)
        if (ct?.[ch]?.length || c.id === selC) rows.push({ lane: constraintLane(c.id, ch), owner: c.name, ch, selected: c.id === selC, onLabel: () => ed.select({ kind: 'constraint', id: c.id }) });
    }
    if (anim.drawOrder?.length) rows.push({ lane: DRAW_LANE, owner: 'draw order', ch: 'order', selected: false });
    return rows;
  }

  render(): void {
    const { app } = this;
    const ed = app.ed;
    const p = ed.project;
    const anim = ed.anim();
    clear(this.root);
    this.laneEls.clear();
    this.root.classList.toggle('setup-mode', ed.mode === 'setup');

    const animSel = h('select', { 'data-testid': 'anim-select', 'aria-label': 'Animation' }, ...p.animations.map((a) => h('option', { value: a.id }, a.name)));
    if (anim) animSel.value = anim.id;
    animSel.addEventListener('change', () => ed.setAnimation(animSel.value));

    const controls = h('div', { class: 'tl-controls' },
      p.animations.length ? animSel : h('span', { class: 'dim' }, 'No animations'),
      h('button', { class: 'mini', 'data-testid': 'new-animation', title: 'New animation', onclick: () => app.newAnimation() }, '+'),
      anim ? h('button', { class: 'mini', title: 'Delete this animation', 'aria-label': 'Delete animation', onclick: () => app.deleteAnimation() }, '🗑') : null,
      h('button', { class: 'mini', 'data-testid': 'mix-open', title: 'Preview a transition (mix) between animations', disabled: p.animations.length < 2, onclick: () => app.mixDialog.open() }, '⇄ Mix…'),
      h('button', { class: 'mini', 'data-testid': 'sequences-open', title: 'Saved clip sequences: ordered clips, repeats and mixes; export as ZIP, APNG or GIF', disabled: !p.animations.length, onclick: () => app.sequenceDialog.open() }, '▤ Sequences…'),
    );

    if (!anim) {
      this.playhead = this.readout = this.playBtn = this.lanes = null;
      this.root.append(controls, h('div', { class: 'tl-empty', 'data-testid': 'timeline-empty' }, 'No animation yet. Press “+” to create one, then pose bones in Animate mode to set keys.'));
      return;
    }

    const nameIn = h('input', { type: 'text', value: anim.name, class: 'w-name', 'aria-label': 'Animation name', 'data-testid': 'anim-name' });
    nameIn.addEventListener('change', () => nameIn.value.trim() && app.updateAnimation('Rename animation', (a) => void (a.name = nameIn.value.trim())));
    const durIn = h('input', { type: 'number', min: 0.05, step: 0.1, value: fmt(anim.duration, 3), class: 'w-num', 'aria-label': 'Duration (seconds)', 'data-testid': 'anim-duration' });
    durIn.addEventListener('change', () => {
      const v = Number(durIn.value);
      if (!(v > 0) || v > 3600) return void (durIn.value = fmt(anim.duration, 3));
      app.updateAnimation('Change duration', (a) => void (a.duration = v));
    });
    const fpsIn = h('input', { type: 'number', min: 1, max: 240, step: 1, value: anim.fps, class: 'w-num', 'aria-label': 'Frames per second', 'data-testid': 'anim-fps' });
    fpsIn.addEventListener('change', () => {
      const v = Math.round(Number(fpsIn.value));
      if (!(v >= 1 && v <= 240)) return void (fpsIn.value = String(anim.fps));
      app.updateAnimation('Change FPS', (a) => void (a.fps = v));
    });
    const loopIn = h('input', { type: 'checkbox', checked: anim.loop, 'data-testid': 'anim-loop', 'aria-label': 'Loop' });
    loopIn.addEventListener('change', () => app.updateAnimation('Toggle loop', (a) => void (a.loop = loopIn.checked)));

    this.playBtn = h('button', { class: 'transport play', 'data-testid': 'play', title: 'Play / pause (Space)', 'aria-label': 'Play', onclick: () => ed.togglePlay() }, '▶ Play');
    this.readout = h('span', { class: 'readout', 'data-testid': 'time-readout' });

    const selKey = app.primaryKey();
    const curveCapable = selKey && 'interp' in selKey;
    const interpSel = h('select', { 'data-testid': 'key-interp', 'aria-label': 'Interpolation of selected keys', disabled: !curveCapable }, ...INTERPS.map((i) => h('option', { value: i }, i)));
    if (curveCapable) interpSel.value = (selKey as Key).interp;
    interpSel.addEventListener('change', () => app.setInterpForSelection(interpSel.value as Interp));
    const nSel = ed.keySels.length;

    const beyond = keysBeyondEnd(anim);
    append(
      controls,
      nameIn,
      h('label', { class: 'inline' }, 'Length', durIn, 's'),
      h('label', { class: 'inline' }, 'FPS', fpsIn),
      h('label', { class: 'inline' }, loopIn, 'Loop'),
      h('span', { class: 'sep' }),
      h('button', { class: 'transport', title: 'First frame (Home)', 'aria-label': 'First frame', onclick: () => (ed.stop(), ed.setTime(0)) }, '⏮'),
      h('button', { class: 'transport', title: 'Previous frame (,)', 'aria-label': 'Previous frame', 'data-testid': 'prev-frame', onclick: () => app.stepFrame(-1) }, '◀'),
      this.playBtn,
      h('button', { class: 'transport', title: 'Next frame (.)', 'aria-label': 'Next frame', 'data-testid': 'next-frame', onclick: () => app.stepFrame(1) }, '▶|'),
      this.readout,
      h('span', { class: 'sep' }),
      h('button', { class: 'mini accent', 'data-testid': 'key-selected', title: 'Key all channels of the selected bone at this frame (K)', disabled: !ed.selectedBoneId(), onclick: () => app.keySelected() }, '◆ Key bone'),
      h('label', { class: 'inline' }, 'Interp', interpSel),
      h('button', { class: 'mini', 'data-testid': 'delete-key', disabled: !nSel, title: 'Delete selected keys (Del)', onclick: () => app.deleteSelectedKey() }, nSel > 1 ? `Delete ${nSel} keys` : 'Delete key'),
      h('span', { class: 'sep' }),
      h('span', { class: 'dim', 'data-testid': 'key-sel-count' }, nSel ? `${nSel} key${nSel > 1 ? 's' : ''} selected` : 'no keys selected'),
      h('button', { class: 'mini', 'data-testid': 'nudge-left', disabled: !nSel, title: 'Nudge selected keys one frame earlier ([)', 'aria-label': 'Nudge keys left', onclick: () => app.nudgeKeys(-1) }, '◂1f'),
      h('button', { class: 'mini', 'data-testid': 'nudge-right', disabled: !nSel, title: 'Nudge selected keys one frame later (])', 'aria-label': 'Nudge keys right', onclick: () => app.nudgeKeys(1) }, '1f▸'),
      h('button', { class: 'mini', 'data-testid': 'copy-keys', disabled: !nSel, title: 'Copy selected keys (Ctrl/⌘+C)', onclick: () => app.copySelectedKeys() }, 'Copy'),
      h('button', { class: 'mini', 'data-testid': 'paste-keys', disabled: !ed.clipboard, title: ed.clipboard ? `Paste ${describePortable(ed.clipboard)} at the playhead (Ctrl/⌘+V); onto the selected bone if the keys came from one other bone` : 'Paste keys at the playhead (Ctrl/⌘+V)', 'data-clip': ed.clipboard ? String(ed.clipboard.items.length) : '0', onclick: () => app.pasteKeysAtPlayhead() }, 'Paste'),
      h('button', { class: 'mini', 'data-testid': 'loop-seam', title: 'Close the loop: copy each lane’s first key to the end (selected lanes, or all)', onclick: () => app.closeLoop() }, '⟲ Close loop'),
      beyond ? h('span', { class: 'warn', title: 'Keys after the end are kept but not played.' }, `${beyond} key(s) past end`) : null,
    );

    this.rows = this.buildRows(anim);
    const frames = frameCount(anim);
    const ruler = h('div', { class: 'tl-ruler', 'data-testid': 'timeline-ruler' });
    const zoomed = this.pitch !== null;
    const spacing = zoomed ? rulerSpacing(this.pitch!) : null;
    const tickEvery = spacing ? spacing.tick : frames <= 30 ? 1 : frames <= 120 ? 5 : 10;
    const labelEvery = spacing ? spacing.label : frames <= 30 ? 5 : frames <= 120 ? 10 : 30;
    for (let f = 0; f <= frames; f += tickEvery) {
      ruler.append(h('div', { class: `tick${f % labelEvery === 0 ? ' major' : ''}`, style: `left:${(f / frames) * 100}%` }, f % labelEvery === 0 ? h('span', {}, String(f)) : null));
    }
    const labels = h('div', { class: 'tl-labels' }, h('div', { class: 'tl-label head' }, ed.mode === 'setup' ? 'Setup mode' : 'Frame'));
    const lanes = h('div', { class: 'tl-lanes', 'data-testid': 'timeline-lanes', style: zoomed ? `width:${this.pitch! * frames}px` : '' }, ruler);
    this.lanes = lanes;
    for (const r of this.rows) {
      labels.append(
        h('div', { class: `tl-label${r.selected ? ' sel' : ''}`, title: `${r.owner} · ${r.ch}` },
          r.onLabel ? h('button', { class: 'linklike', onclick: r.onLabel }, r.owner) : h('span', {}, r.owner),
          h('span', { class: `ch ch-${r.ch}` }, CH_LABEL[r.ch] ?? r.ch),
        ),
      );
      const lane = h('div', { class: `tl-lane${r.selected ? ' sel' : ''}`, 'data-lane': r.lane });
      this.laneEls.set(r.lane, lane);
      lanes.append(lane);
    }
    if (!this.rows.length) {
      labels.append(h('div', { class: 'tl-label dim' }, '—'));
      lanes.append(h('div', { class: 'tl-lane hint-lane' }, 'Select a bone to see its channels. Pose it in Animate mode (or press K) to add keys. Shift-drag here to box-select keys.'));
    }
    this.playhead = h('div', { class: 'playhead', 'data-testid': 'playhead' });
    lanes.append(this.playhead);
    this.attachPointer(lanes);
    this.drawKeys();

    const body = h('div', { class: `tl-body${zoomed ? ' zoomed' : ''}` }, labels, lanes);
    this.body = body;
    body.addEventListener('scroll', () => void (this.scrollX = body.scrollLeft));
    body.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    append(controls,
      h('span', { class: 'sep' }),
      h('button', { class: 'mini', 'data-testid': 'tl-zoom-out', title: 'Zoom time out (Ctrl/⌘ + wheel)', 'aria-label': 'Zoom timeline out', disabled: !zoomed, onclick: () => this.zoomStep(-1) }, '−'),
      h('span', { class: 'dim', 'data-testid': 'tl-zoom-readout', title: 'Timeline zoom (screen pixels per frame)' }, zoomed ? `${this.pitch} px/frame` : 'fit'),
      h('button', { class: 'mini', 'data-testid': 'tl-zoom-in', title: 'Zoom time in (Ctrl/⌘ + wheel); Shift + wheel scrolls', 'aria-label': 'Zoom timeline in', disabled: this.pitch === PITCH_LEVELS[PITCH_LEVELS.length - 1], onclick: () => this.zoomStep(1) }, '+'),
      h('button', { class: 'mini', 'data-testid': 'tl-zoom-fit', title: 'Show the whole animation', disabled: !zoomed, onclick: () => this.setPitch(null, null) }, 'Fit'),
    );
    const main = h('div', { class: 'tl-main' }, body, this.curve.render());
    this.root.append(controls, main);
    const selLabel = labels.querySelector<HTMLElement>('.tl-label.sel');
    if (selLabel) body.scrollTop = Math.max(0, selLabel.offsetTop - 24 - 22);
    if (zoomed) body.scrollLeft = this.scrollX;
    this.updateTime();
  }

  /** Px per frame when the whole animation fits (measured). */
  private fitPitch(): number {
    const anim = this.app.ed.anim();
    if (!anim || !this.body) return 0;
    const labels = this.body.querySelector<HTMLElement>('.tl-labels');
    return Math.max(0, this.body.clientWidth - (labels?.offsetWidth ?? 0) - 28) / frameCount(anim);
  }

  /** Levels strictly finer than fitting the whole animation. */
  private levels(): number[] {
    const fit = this.fitPitch();
    return PITCH_LEVELS.filter((x) => x > fit + 1e-6);
  }

  private zoomStep(dir: 1 | -1, clientX: number | null = null): void {
    const levels = this.levels();
    const cur = this.pitch;
    let next: number | null;
    if (dir > 0) next = cur === null ? (levels[0] ?? null) : (levels.find((x) => x > cur) ?? cur);
    else next = cur === null ? null : ([...levels].reverse().find((x) => x < cur) ?? null);
    if (next === cur) return;
    this.setPitch(next, clientX);
  }

  /** Changes the zoom, keeping the time under `clientX` (default: the playhead) in place. */
  private setPitch(pitch: number | null, clientX: number | null): void {
    const anim = this.app.ed.anim();
    const body = this.body;
    if (!anim || !body || !this.lanes) return;
    const r = this.lanes.getBoundingClientRect();
    const bodyLeft = body.getBoundingClientRect().left;
    const x = clientX ?? r.left + (this.app.ed.time / anim.duration) * r.width;
    const frac = Math.min(1, Math.max(0, (x - r.left) / Math.max(1, r.width)));
    const lanesOffset = r.left - bodyLeft + body.scrollLeft;
    this.pitch = pitch;
    this.render();
    const nb = this.body!;
    const nr = this.lanes!.getBoundingClientRect();
    nb.scrollLeft = Math.max(0, lanesOffset + frac * nr.width - (x - bodyLeft));
    this.scrollX = nb.scrollLeft;
    this.app.status(pitch === null ? 'Timeline: whole animation.' : `Timeline zoom: ${pitch} px per frame.`);
  }

  private onWheel(e: WheelEvent): void {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (e.deltaY) this.zoomStep(e.deltaY < 0 ? 1 : -1, e.clientX);
    } else if (e.shiftKey && this.pitch !== null && this.body) {
      e.preventDefault();
      this.body.scrollLeft += e.deltaY || e.deltaX;
    }
  }

  /** (Re)draws the key diamonds inside the existing lane elements. */
  private drawKeys(): void {
    const ed = this.app.ed;
    const anim = ed.anim();
    if (!anim) return;
    const t = snapToFrame(ed.time, anim.fps);
    for (const r of this.rows) {
      const lane = this.laneEls.get(r.lane);
      if (!lane) continue;
      for (const el of [...lane.querySelectorAll('.key')]) el.remove();
      const keys = laneKeys(anim, r.lane) ?? [];
      for (const k of keys) {
        const ref = { lane: r.lane, time: k.time };
        const isSel = ed.isKeySelected(ref);
        const isPrimary = !!ed.keySel && sameRef(ed.keySel, ref);
        const frame = Math.round(k.time * anim.fps);
        const value = 'value' in k ? (k as Key).value.map((v) => fmt(v)).join(', ') : 'imageId' in k ? String((k as { imageId: string }).imageId) : 'order';
        const interp = 'interp' in k ? ` (${(k as Key).interp})` : '';
        lane.append(
          h('button', {
            class: `key ch-${r.ch}${isSel ? ' selected' : ''}${isPrimary ? ' primary' : ''}${Math.abs(k.time - t) < 1e-6 ? ' current' : ''}${k.time > anim.duration + 1e-6 ? ' beyond' : ''}`,
            style: `left:${Math.min(100, (k.time / anim.duration) * 100)}%`,
            title: `${r.owner} ${r.ch} @ frame ${frame}: ${value}${interp}`,
            'aria-label': `${r.owner} ${r.ch} key at frame ${frame}`,
            'aria-pressed': isSel ? 'true' : 'false',
            'data-testid': `key-${r.owner}-${r.ch}-${frame}`,
            'data-lane': r.lane,
            'data-time': String(k.time),
          }),
        );
      }
    }
  }

  private timeAt(clientX: number): number {
    const anim = this.app.ed.anim();
    if (!anim || !this.lanes) return 0;
    const r = this.lanes.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return snapToFrame(frac * anim.duration, anim.fps);
  }

  private attachPointer(lanes: HTMLElement): void {
    const ed = this.app.ed;
    lanes.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const anim = ed.anim();
      if (!anim) return;
      const keyEl = (e.target as HTMLElement).closest<HTMLElement>('.key');
      // Mark the interaction first: emits below must not rebuild (and detach) these lanes.
      this.interacting = true;
      ed.stop();
      if (keyEl) {
        e.preventDefault();
        const ref: KeyRef = { lane: keyEl.dataset.lane!, time: Number(keyEl.dataset.time) };
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          this.interacting = false;
          ed.toggleKeyInSelection(ref);
          return;
        }
        lanes.setPointerCapture(e.pointerId);
        if (!ed.isKeySelected(ref)) ed.selectKey(ref);
        else {
          ed.keySel = ref;
          ed.setTime(ref.time);
        }
        this.drag = {
          kind: 'keys',
          anchorFrame: Math.round(ref.time * anim.fps),
          lastDelta: 0,
          refs: ed.keySels.slice(),
          primary: ref,
          base: structuredClone(anim),
          animIndex: ed.project.animations.indexOf(anim),
          moved: false,
          pointerId: e.pointerId,
        };
        this.drawKeys();
        return;
      }
      if ((e.target as HTMLElement).closest('.tl-ruler') === null && e.shiftKey) {
        const r = lanes.getBoundingClientRect();
        const box = h('div', { class: 'marquee', 'data-testid': 'key-marquee' });
        lanes.append(box);
        lanes.setPointerCapture(e.pointerId);
        this.drag = { kind: 'marquee', x0: e.clientX - r.left, y0: e.clientY - r.top, additive: e.ctrlKey || e.metaKey, box, pointerId: e.pointerId };
        this.updateMarquee(e);
        return;
      }
      lanes.setPointerCapture(e.pointerId);
      this.drag = { kind: 'scrub', pointerId: e.pointerId };
      if (ed.mode !== 'animate') ed.setMode('animate');
      if (ed.keySels.length) ed.selectKey(null);
      ed.setTime(this.timeAt(e.clientX));
    });
    lanes.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      if (d.kind === 'scrub') ed.setTime(this.timeAt(e.clientX));
      else if (d.kind === 'marquee') this.updateMarquee(e);
      else this.moveKeys(d, e);
    });
    const finish = (e: PointerEvent) => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      this.interacting = false;
      if (lanes.hasPointerCapture(e.pointerId)) lanes.releasePointerCapture(e.pointerId);
      if (d.kind === 'scrub') {
        // Rebuild so key highlights and the inspector reflect the final frame.
        ed.emit('selection');
      } else if (d.kind === 'marquee') {
        this.finishMarquee(d, e);
      } else {
        if (d.moved) ed.endGesture(d.refs.length > 1 ? `Move ${d.refs.length} keys` : 'Move key');
        // A click (no drag) on a key inside a multi-selection selects just that key.
        else if (d.refs.length > 1) ed.selectKey(d.primary);
        this.render();
      }
    };
    lanes.addEventListener('pointerup', finish);
    lanes.addEventListener('pointercancel', () => this.cancelDrag());
  }

  private moveKeys(d: Extract<Drag, { kind: 'keys' }>, e: PointerEvent): void {
    const ed = this.app.ed;
    const anim = ed.anim();
    if (!anim) return;
    const delta = Math.round(this.timeAt(e.clientX) * anim.fps) - d.anchorFrame;
    if (delta === d.lastDelta) return;
    d.lastDelta = delta;
    if (!d.moved) ed.beginGesture();
    d.moved = true;
    let moved: KeyRef[] = [];
    // Recompute from the drag's start state every time: keys passed over reappear.
    ed.gestureMutate((p) => {
      const a = structuredClone(d.base);
      moved = shiftKeys(a, d.refs, delta / anim.fps);
      p.animations[d.animIndex] = a;
    });
    const idx = d.refs.findIndex((r) => sameRef(r, d.primary));
    ed.keySels = moved;
    ed.keySel = moved[idx] ?? moved[0] ?? null;
    if (ed.keySel) ed.setTime(ed.keySel.time);
    this.drawKeys();
  }

  private updateMarquee(e: PointerEvent): void {
    const d = this.drag;
    if (d?.kind !== 'marquee' || !this.lanes) return;
    const r = this.lanes.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    Object.assign(d.box.style, { left: `${Math.min(x, d.x0)}px`, top: `${Math.min(y, d.y0)}px`, width: `${Math.abs(x - d.x0)}px`, height: `${Math.abs(y - d.y0)}px` });
  }

  private finishMarquee(d: Extract<Drag, { kind: 'marquee' }>, e: PointerEvent): void {
    const ed = this.app.ed;
    const anim = ed.anim();
    d.box.remove();
    if (!anim || !this.lanes) return;
    const r = this.lanes.getBoundingClientRect();
    const x0 = Math.min(d.x0, e.clientX - r.left), x1 = Math.max(d.x0, e.clientX - r.left);
    const y0 = Math.min(d.y0, e.clientY - r.top) + r.top, y1 = Math.max(d.y0, e.clientY - r.top) + r.top;
    const lanes = [...this.laneEls.entries()].filter(([, el]) => {
      const b = el.getBoundingClientRect();
      return b.bottom >= y0 && b.top <= y1;
    }).map(([lane]) => lane);
    const t0 = (x0 / r.width) * anim.duration, t1 = (x1 / r.width) * anim.duration;
    const hits = refsInRange(anim, lanes, t0, t1);
    ed.setKeySelection(d.additive ? [...ed.keySels, ...hits] : hits);
    this.app.status(hits.length ? `Selected ${ed.keySels.length} key(s).` : 'No keys in the box.');
  }

  /** Esc during a timeline drag restores the state from before it. */
  cancelDrag(): boolean {
    const d = this.drag;
    if (!d) return false;
    this.drag = null;
    this.interacting = false;
    const ed = this.app.ed;
    if (this.lanes?.hasPointerCapture(d.pointerId)) this.lanes.releasePointerCapture(d.pointerId);
    if (d.kind === 'marquee') d.box.remove();
    if (d.kind === 'keys') {
      if (d.moved) ed.cancelGesture();
      ed.setKeySelection(d.refs, d.primary);
      ed.setTime(d.primary.time);
      this.app.status('Key drag cancelled.');
    }
    this.render();
    return true;
  }
}
