// Timeline: animation settings, transport, scrubbing and per-channel key lanes.
import { findKeyIndex, frameCount, keysBeyondEnd, moveKey, snapToFrame } from '../model/animation.ts';
import { topoOrder } from '../model/skeleton.ts';
import type { Channel, Interp } from '../model/types.ts';
import { CHANNELS, INTERPS } from '../model/types.ts';
import type { App } from './app.ts';
import { append, clear, fmt, h } from './dom.ts';

const CH_LABEL: Record<Channel, string> = { translate: 'translate', rotate: 'rotate', scale: 'scale' };

export class Timeline {
  private root: HTMLElement;
  private app: App;
  private playhead: HTMLElement | null = null;
  private readout: HTMLElement | null = null;
  private playBtn: HTMLButtonElement | null = null;
  private lanes: HTMLElement | null = null;
  private keyDrag: { boneId: string; channel: Channel; time: number; moved: boolean; el: HTMLElement } | null = null;
  /** True while a scrub or key drag owns pointer capture; rebuilding the DOM then would drop it. */
  private interacting = false;

  constructor(app: App, root: HTMLElement) {
    this.app = app;
    this.root = root;
    app.ed.subscribe((r) => {
      if (r === 'time' || r === 'view' || this.interacting) this.updateTime();
      else this.render();
    });
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

  render(): void {
    const { app } = this;
    const ed = app.ed;
    const p = ed.project;
    const anim = ed.anim();
    clear(this.root);
    this.root.classList.toggle('setup-mode', ed.mode === 'setup');

    const animSel = h('select', { 'data-testid': 'anim-select', 'aria-label': 'Animation' }, ...p.animations.map((a) => h('option', { value: a.id }, a.name)));
    if (anim) animSel.value = anim.id;
    animSel.addEventListener('change', () => ed.setAnimation(animSel.value));

    const controls = h('div', { class: 'tl-controls' },
      p.animations.length ? animSel : h('span', { class: 'dim' }, 'No animations'),
      h('button', { class: 'mini', 'data-testid': 'new-animation', title: 'New animation', onclick: () => app.newAnimation() }, '+'),
      anim ? h('button', { class: 'mini', title: 'Delete this animation', 'aria-label': 'Delete animation', onclick: () => app.deleteAnimation() }, '🗑') : null,
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

    const ks = ed.keySel;
    const selKey = ks ? anim.tracks[ks.boneId]?.[ks.channel]?.find((k) => Math.abs(k.time - ks.time) < 1e-6) : undefined;
    const interpSel = h('select', { 'data-testid': 'key-interp', 'aria-label': 'Interpolation of selected key', disabled: !selKey }, ...INTERPS.map((i) => h('option', { value: i }, i)));
    if (selKey) interpSel.value = selKey.interp;
    interpSel.addEventListener('change', () => {
      if (!ks) return;
      app.updateAnimation('Change interpolation', (a) => {
        const k = a.tracks[ks.boneId]?.[ks.channel]?.find((x) => Math.abs(x.time - ks.time) < 1e-6);
        if (k) k.interp = interpSel.value as Interp;
      });
    });

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
      h('button', { class: 'mini', 'data-testid': 'delete-key', disabled: !selKey, title: 'Delete selected key (Del)', onclick: () => app.deleteSelectedKey() }, 'Delete key'),
      beyond ? h('span', { class: 'warn', title: 'Keys after the end are kept but not played.' }, `${beyond} key(s) past end`) : null,
    );

    // Lanes: every keyed bone/channel, plus all channels of the selected bone.
    const selBone = ed.selectedBoneId();
    const rows: { boneId: string; boneName: string; ch: Channel }[] = [];
    for (const b of topoOrder(p.bones)) {
      const tr = anim.tracks[b.id];
      for (const ch of CHANNELS) if ((tr && tr[ch].length) || b.id === selBone) rows.push({ boneId: b.id, boneName: b.name, ch });
    }

    const frames = frameCount(anim);
    const ruler = h('div', { class: 'tl-ruler', 'data-testid': 'timeline-ruler' });
    const tickEvery = frames <= 30 ? 1 : frames <= 120 ? 5 : 10;
    const labelEvery = frames <= 30 ? 5 : frames <= 120 ? 10 : 30;
    for (let f = 0; f <= frames; f += tickEvery) {
      ruler.append(h('div', { class: `tick${f % labelEvery === 0 ? ' major' : ''}`, style: `left:${(f / frames) * 100}%` }, f % labelEvery === 0 ? h('span', {}, String(f)) : null));
    }
    const labels = h('div', { class: 'tl-labels' }, h('div', { class: 'tl-label head' }, ed.mode === 'setup' ? 'Setup mode' : 'Frame'));
    const lanes = h('div', { class: 'tl-lanes', 'data-testid': 'timeline-lanes' }, ruler);
    this.lanes = lanes;
    const t = snapToFrame(ed.time, anim.fps);
    for (const r of rows) {
      const keys = anim.tracks[r.boneId]?.[r.ch] ?? [];
      labels.append(
        h('div', { class: `tl-label${r.boneId === selBone ? ' sel' : ''}`, title: `${r.boneName} · ${r.ch}` },
          h('button', { class: 'linklike', onclick: () => ed.select({ kind: 'bone', id: r.boneId }) }, r.boneName),
          h('span', { class: `ch ch-${r.ch}` }, CH_LABEL[r.ch]),
        ),
      );
      const lane = h('div', { class: `tl-lane${r.boneId === selBone ? ' sel' : ''}` });
      for (const k of keys) {
        const isSel = !!ks && ks.boneId === r.boneId && ks.channel === r.ch && Math.abs(ks.time - k.time) < 1e-6;
        const frame = Math.round(k.time * anim.fps);
        const d = h('button', {
          class: `key ch-${r.ch}${isSel ? ' selected' : ''}${Math.abs(k.time - t) < 1e-6 ? ' current' : ''}${k.time > anim.duration + 1e-6 ? ' beyond' : ''}`,
          style: `left:${Math.min(100, (k.time / anim.duration) * 100)}%`,
          title: `${r.boneName} ${r.ch} @ frame ${frame}: ${k.value.map((v) => fmt(v)).join(', ')} (${k.interp})`,
          'aria-label': `${r.boneName} ${r.ch} key at frame ${frame}`,
          'data-testid': `key-${r.boneName}-${r.ch}-${frame}`,
        });
        d.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.interacting = true;
          this.keyDrag = { boneId: r.boneId, channel: r.ch, time: k.time, moved: false, el: d };
          d.setPointerCapture(e.pointerId);
          ed.stop();
          ed.selectKey({ boneId: r.boneId, channel: r.ch, time: k.time });
          d.classList.add('selected');
        });
        d.addEventListener('pointermove', (e) => this.onKeyDrag(e));
        d.addEventListener('pointerup', () => {
          const moved = this.keyDrag?.moved;
          this.keyDrag = null;
          this.interacting = false;
          if (moved) ed.endGesture('Move key');
          this.render();
        });
        lane.append(d);
      }
      lanes.append(lane);
    }
    if (!rows.length) {
      labels.append(h('div', { class: 'tl-label dim' }, '—'));
      lanes.append(h('div', { class: 'tl-lane hint-lane' }, 'Select a bone to see its channels. Pose it in Animate mode (or press K) to add keys.'));
    }
    this.playhead = h('div', { class: 'playhead', 'data-testid': 'playhead' });
    lanes.append(this.playhead);
    this.attachScrub(lanes);

    const body = h('div', { class: 'tl-body' }, labels, lanes);
    this.root.append(controls, body);
    // Keep the selected bone's lanes in view.
    const selLabel = labels.querySelector<HTMLElement>('.tl-label.sel');
    if (selLabel) body.scrollTop = Math.max(0, selLabel.offsetTop - 24 - 22);
    this.updateTime();
  }

  private timeAt(clientX: number): number {
    const anim = this.app.ed.anim();
    if (!anim || !this.lanes) return 0;
    const r = this.lanes.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return snapToFrame(frac * anim.duration, anim.fps);
  }

  private onKeyDrag(e: PointerEvent): void {
    const kd = this.keyDrag;
    const ed = this.app.ed;
    const anim = ed.anim();
    if (!kd || !anim) return;
    const nt = this.timeAt(e.clientX);
    if (Math.abs(nt - kd.time) < 1e-6) return;
    const keys = anim.tracks[kd.boneId]?.[kd.channel];
    if (!keys || findKeyIndex(keys, nt) >= 0) return; // don't drop onto another key
    if (!kd.moved) ed.beginGesture();
    kd.moved = true;
    const from = kd.time;
    ed.gestureMutate((p) => {
      const a = p.animations.find((x) => x.id === anim.id)!;
      moveKey(a.tracks[kd.boneId][kd.channel], from, nt);
    });
    kd.time = nt;
    kd.el.style.left = `${Math.min(100, (nt / anim.duration) * 100)}%`;
    ed.keySel = { boneId: kd.boneId, channel: kd.channel, time: nt };
    ed.setTime(nt);
  }

  private attachScrub(lanes: HTMLElement): void {
    const ed = this.app.ed;
    let scrubbing = false;
    lanes.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      scrubbing = true;
      this.interacting = true;
      lanes.setPointerCapture(e.pointerId);
      ed.stop();
      if (ed.mode !== 'animate') ed.setMode('animate');
      if (ed.keySel) ed.selectKey(null);
      ed.setTime(this.timeAt(e.clientX));
    });
    lanes.addEventListener('pointermove', (e) => {
      if (scrubbing) ed.setTime(this.timeAt(e.clientX));
    });
    lanes.addEventListener('pointerup', () => {
      if (!scrubbing) return;
      scrubbing = false;
      this.interacting = false;
      // Rebuild so key highlights and the inspector reflect the final frame.
      ed.emit('selection');
    });
  }
}
