// Decoded image cache and local file import. Image bytes are kept as base64 data URLs
// so they persist inside the project file.
import type { ImageAsset } from '../model/types.ts';
import { newId } from '../model/types.ts';

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export class ImageCache {
  private byId = new Map<string, { url: string; el: HTMLImageElement }>();

  get(asset: ImageAsset): HTMLImageElement | null {
    const hit = this.byId.get(asset.id);
    return hit && hit.url === asset.dataUrl ? hit.el : null;
  }

  async decode(asset: ImageAsset): Promise<HTMLImageElement> {
    const cached = this.get(asset);
    if (cached) return cached;
    const el = new Image();
    el.src = asset.dataUrl;
    await el.decode();
    this.byId.set(asset.id, { url: asset.dataUrl, el });
    return el;
  }

  /** Decodes every asset; rejects with the names of images that failed. */
  async decodeAll(assets: readonly ImageAsset[]): Promise<void> {
    const results = await Promise.allSettled(assets.map((a) => this.decode(a)));
    const failed = assets.filter((_, i) => results[i].status === 'rejected').map((a) => a.name);
    if (failed.length) throw new Error(`Could not decode image(s): ${failed.join(', ')}`);
  }
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(file);
  });
}

/** Reads a local image file into an ImageAsset (and primes the cache). */
export async function importImageFile(file: File, cache: ImageCache): Promise<ImageAsset> {
  if (!ACCEPTED.includes(file.type)) throw new Error(`"${file.name}" is not a PNG, JPEG, WebP or GIF image.`);
  if (file.size > MAX_IMAGE_BYTES) throw new Error(`"${file.name}" is larger than 8 MB.`);
  const dataUrl = await readAsDataUrl(file);
  const probe: ImageAsset = { id: newId('img'), name: file.name, mime: file.type, width: 0, height: 0, dataUrl };
  let el: HTMLImageElement;
  try {
    el = await cache.decode(probe);
  } catch {
    throw new Error(`"${file.name}" could not be decoded as an image.`);
  }
  return { ...probe, width: el.naturalWidth, height: el.naturalHeight };
}
