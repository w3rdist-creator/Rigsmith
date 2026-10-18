// Lightweight reference player for `rigsmith.runtime` files with texture atlases (or
// loose images). Input = the runtime JSON + atlas JSON + page images only; no project file.
// Shared with the editor (documented in docs/runtime.md): evaluation (src/model/evaluate,
// constraints, mesh, mix, animation, curve), sequence sampling/geometry
// (src/render/sequence.ts) and the Canvas2D renderer (src/render/draw.ts). Specific to
// the player: the runtime loader (src/runtime/load.ts) and the atlas-region lookup.
import type { AtlasMeta } from '../model/atlas.ts';
import { defaultRequest } from '../model/sequence.ts';
import type { MixPlan } from '../model/mix.ts';
import { DEFAULT_MIX, mixDuration } from '../model/mix.ts';
import type { ImageAsset, Project } from '../model/types.ts';
import type { ImageLookup, ImageRegion } from '../render/draw.ts';
import type { Prepared } from '../render/sequence.ts';
import { prepareMixSequence, prepareSequence } from '../render/sequence.ts';
import { loadRuntime } from './load.ts';

export interface PlayerTextures {
  atlas?: { meta: AtlasMeta; pages: CanvasImageSource[] };
  /** Loose images by name (used for any image without an atlas region). */
  images?: Map<string, CanvasImageSource>;
}

export class RigPlayer {
  readonly project: Project;
  private regions = new Map<string, ImageRegion>();
  private loose: Map<string, CanvasImageSource>;

  constructor(runtime: unknown, tex: PlayerTextures) {
    this.project = loadRuntime(runtime);
    this.loose = tex.images ?? new Map();
    if (tex.atlas) {
      const { meta, pages } = tex.atlas;
      if (meta.format !== 'rigsmith.atlas') throw new Error('Not a rigsmith.atlas file.');
      for (const r of meta.regions) {
        const page = pages[r.page];
        if (!page) throw new Error(`Atlas page ${r.page} (${meta.pages[r.page]?.file ?? '?'}) is missing.`);
        this.regions.set(r.name, { source: page, x: r.x, y: r.y, width: r.width, height: r.height, offsetX: r.offsetX, offsetY: r.offsetY });
      }
    }
  }

  /** Images the rig can show that have neither an atlas region nor a loose image. */
  missingImages(): string[] {
    return this.project.images.map((i) => i.name).filter((n) => !this.regions.has(n) && !this.loose.has(n));
  }

  readonly lookup: ImageLookup = (im: ImageAsset) => this.regions.get(im.name) ?? this.loose.get(im.name) ?? null;

  /** Frames 0..last of an animation at its own fps (loops omit the repeat of frame 0), one stable canvas. */
  prepare(animName: string, skin: string | null): Prepared {
    const anim = this.project.animations.find((a) => a.name === animName);
    if (!anim) return { ok: false, errors: [`No animation “${animName}”.`] };
    return prepareSequence(this.project, anim.id, defaultRequest(anim), skin);
  }

  /** A transition: `from` plays, `to` starts at `at` seconds and blends over the stored mix (default 0.2 s). */
  prepareMix(from: string, to: string, at: number, skin: string | null): Prepared {
    const a = this.project.animations.find((x) => x.name === from);
    if (!a) return { ok: false, errors: [`No animation “${from}”.`] };
    return prepareMixSequence(this.project, this.mixPlan(from, to, at), a.fps, skin);
  }

  mixPlan(from: string, to: string, at: number): MixPlan {
    return { entries: [{ animId: from, start: 0, mix: 0 }, { animId: to, start: at, mix: mixDuration(this.project, from, to, DEFAULT_MIX) }], missing: 'setup' };
  }
}
