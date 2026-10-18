// Plays an exported Lottie JSON in the third-party lottie-web 5.13.0 canvas renderer
// (devDependency only): a blank page of the isolated Chrome for Testing, the player script
// injected from node_modules. Shared by the Lottie e2e test and the Wiz Lottie acceptance.
import path from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { ROOT } from './harness.ts';

/** Each requested frame as PNG bytes; page errors are reported through `onError`. */
export async function lottieWebFrames(ctx: BrowserContext, lottie: any, frames: number[], onError: (msg: string) => void): Promise<Buffer[]> {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => onError(`lottie-web: ${e.message}`));
  try {
    await p.goto('about:blank');
    await p.addScriptTag({ path: path.join(ROOT, 'node_modules/lottie-web/build/player/lottie_canvas.js') });
    const urls: string[] = await p.evaluate(async ([data, list]) => {
      const host = document.createElement('div');
      host.style.cssText = `position:absolute;left:0;top:0;width:${data.w}px;height:${data.h}px`;
      document.body.style.margin = '0';
      document.body.appendChild(host);
      const anim = (window as any).lottie.loadAnimation({
        container: host, renderer: 'canvas', loop: false, autoplay: false, animationData: data,
        rendererSettings: { clearCanvas: true, dpr: 1, preserveAspectRatio: 'xMidYMid meet' },
      });
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error('lottie-web did not load')), 10000);
        anim.addEventListener('DOMLoaded', () => { clearTimeout(t); res(); });
      });
      const canvas = host.querySelector('canvas')!;
      if (canvas.width !== data.w || canvas.height !== data.h) throw new Error(`canvas ${canvas.width}×${canvas.height}`);
      return list.map((f: number) => { anim.goToAndStop(f, true); return canvas.toDataURL('image/png'); });
    }, [lottie, frames] as const);
    return urls.map((u) => Buffer.from(u.split(',')[1], 'base64'));
  } finally {
    await p.close();
  }
}
