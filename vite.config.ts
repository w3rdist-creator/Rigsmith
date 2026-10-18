// Pages: the editor (index.html), the reference runtime player (player.html) and the
// headless render entry used by the CLI (render.html).
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        player: resolve(import.meta.dirname, 'player.html'),
        render: resolve(import.meta.dirname, 'render.html'),
      },
    },
  },
});
