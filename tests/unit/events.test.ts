// R7 timeline events: firing windows, the v3 file format, runtime export/load, sequence
// metadata, Lottie markers, clip specs and lane operations (copy/paste/shift).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyClip, exportClip, formatClipSpec, parseClipText } from '../../src/model/clipSpec.ts';
import { eventsBetween, flatEvents } from '../../src/model/events.ts';
import { exportRuntime } from '../../src/model/exportRuntime.ts';
import { parseProject, requiredVersion, serializeProject, v3Features } from '../../src/model/format.ts';
import { allLanes, copyKeys, eventLane, pasteKeys } from '../../src/model/keys.ts';
import { exportLottie } from '../../src/model/lottie.ts';
import { defaultRequest } from '../../src/model/sequence.ts';
import type { Animation } from '../../src/model/types.ts';
import { prepareSequence, sequenceMeta } from '../../src/render/sequence.ts';
import { loadRuntime } from '../../src/runtime/load.ts';
import { lottieProject } from '../support/lottie-fixture.ts';
import { richProject } from '../support/runtime-fixture.ts';

const anim = (loop: boolean): Animation => ({
  id: 'a', name: 'a', duration: 1, fps: 30, loop, tracks: {},
  events: { start: [{ time: 0 }], flash: [{ time: 0.2 }, { time: 0.6, payload: 2 }], sfx: [{ time: 0.2, payload: 'win' }], end: [{ time: 1 }] },
});

function withEvents() {
  const p = richProject();
  const wave = p.animations.find((a) => a.name === 'wave')!;
  wave.events = { prop_flash: [{ time: 0.2 }, { time: 0.8, payload: 'big' }], 'sfx:win': [{ time: 0.5, payload: 3 }] };
  return p;
}

describe('firing', () => {
  it('flat list sorted by time then name; windows are (prev, now]; −1 starts at 0', () => {
    assert.deepEqual(flatEvents(anim(true)).map((e) => `${e.time}:${e.name}`), ['0:start', '0.2:flash', '0.2:sfx', '0.6:flash', '1:end']);
    assert.deepEqual(eventsBetween(anim(true), -1, 0).map((e) => e.name), ['start']);
    assert.deepEqual(eventsBetween(anim(true), 0, 0.2).map((e) => e.name), ['flash', 'sfx']);
    assert.deepEqual(eventsBetween(anim(true), 0.2, 0.5), []);
    assert.deepEqual(eventsBetween(anim(true), 0.5, 0.6)[0].payload, 2);
  });

  it('a loop wrap fires the rest of the old pass then the new one; the end event once', () => {
    assert.deepEqual(eventsBetween(anim(true), 0.9, 0.1).map((e) => e.name), ['end', 'start']);
    assert.deepEqual(eventsBetween(anim(false), 0.9, 1).map((e) => e.name), ['end']);
  });
});

describe('storage and export', () => {
  it('v3 file format round-trips; v2, bad names, unsorted keys and bad payloads are refused', () => {
    const p = withEvents();
    assert.ok(v3Features(p).includes('timeline events'));
    assert.equal(requiredVersion(p), 3);
    const text = serializeProject(p);
    const back = parseProject(text);
    assert.ok(back.ok);
    if (back.ok) assert.deepEqual(back.project.animations.find((a) => a.name === 'wave')!.events, p.animations.find((a) => a.name === 'wave')!.events);
    const raw = JSON.parse(text);
    const w = raw.animations.findIndex((a: any) => a.name === 'wave');
    const bad = (f: (x: any) => void, re: RegExp) => {
      const r = structuredClone(raw);
      f(r);
      const res = parseProject(JSON.stringify(r));
      assert.ok(!res.ok && res.errors.some((e) => re.test(e)), `${re}: ${JSON.stringify(res)}`);
    };
    bad((r) => (r.version = 2), /timeline events requires project version 3/);
    bad((r) => (r.animations[w].events['bad name'] = [{ time: 0 }]), /event names are/);
    bad((r) => r.animations[w].events.prop_flash.reverse(), /strictly increasing time/);
    bad((r) => (r.animations[w].events.prop_flash[0].payload = { x: 1 }), /payload must be a string/);
  });

  it('runtime export lists them flat; the loader regroups them; sequence.json names their frames; Lottie writes markers', () => {
    const p = withEvents();
    const rt = exportRuntime(p);
    const wave = rt.animations.find((a) => a.name === 'wave')!;
    assert.deepEqual(wave.events, [{ time: 0.2, name: 'prop_flash' }, { time: 0.5, name: 'sfx:win', payload: 3 }, { time: 0.8, name: 'prop_flash', payload: 'big' }]);
    assert.equal(rt.animations.find((a) => a.name === 'rest')!.events, undefined);
    const loaded = loadRuntime(JSON.parse(JSON.stringify(rt)));
    assert.deepEqual(loaded.animations.find((a) => a.name === 'wave')!.events, { prop_flash: [{ time: 0.2 }, { time: 0.8, payload: 'big' }], 'sfx:win': [{ time: 0.5, payload: 3 }] });
    const a = p.animations.find((x) => x.name === 'wave')!;
    const req = { ...defaultRequest(a), start: 0, end: 20 };
    const prep = prepareSequence(p, a.id, req);
    assert.ok(prep.ok);
    if (prep.ok) assert.deepEqual(sequenceMeta(p, prep.setup, req).events, [{ time: 0.2, frame: 6, index: 6, name: 'prop_flash' }, { time: 0.5, frame: 15, index: 15, name: 'sfx:win', payload: 3 }]);
    const lp = lottieProject();
    lp.animations[0].events = { beat: [{ time: 0.5 }], sfx: [{ time: 0.25, payload: 'pop' }] };
    const l = exportLottie(lp, lp.animations[0].name, null);
    assert.ok(l.ok);
    if (l.ok) {
      const fps = lp.animations[0].fps;
      assert.deepEqual((l.lottie as any).markers, [{ tm: 0.25 * fps, cm: 'sfx|pop', dr: 0 }, { tm: 0.5 * fps, cm: 'beat', dr: 0 }]);
      assert.ok(l.diagnostics.some((d) => d.feature === 'timeline events' && d.level === 'note'));
    }
  });

  it('clip specs carry them (export → apply is exact; authored [at, name, payload])', () => {
    const p = withEvents();
    const wave = p.animations.find((a) => a.name === 'wave')!;
    const spec = exportClip(p, wave.id);
    assert.deepEqual(spec.events, [[6, 'prop_flash'], [15, 'sfx:win', 3], [24, 'prop_flash', 'big']]);
    const parsed = parseClipText(formatClipSpec(spec), 'w.yaml');
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const r = applyClip(p, parsed.spec, 'replace');
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.project.animations.find((a) => a.id === wave.id)!.events, wave.events);
    const bad = applyClip(p, { name: 'wave', events: [[3, 'no spaces'], [99, 'late']] }, 'merge');
    assert.ok(!bad.ok && bad.errors.length === 2, JSON.stringify(bad));
  });

  it('event lanes behave like other lanes: listed, copied and pasted (by name)', () => {
    const p = withEvents();
    const wave = p.animations.find((a) => a.name === 'wave')!;
    assert.ok(allLanes(wave).includes(eventLane('sfx:win')));
    const clip = copyKeys(wave, [{ lane: eventLane('sfx:win'), time: 0.5 }])!;
    const rest = p.animations.find((a) => a.name === 'rest')!;
    pasteKeys(rest, clip, 0.1);
    assert.deepEqual(rest.events, { 'sfx:win': [{ time: 0.1, payload: 3 }] });
  });
});
