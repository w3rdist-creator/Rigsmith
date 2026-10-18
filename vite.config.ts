// Two pages: the editor (index.html) and the reference runtime player (player.html).
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        player: resolve(import.meta.dirname, 'player.html'),
      },
    },
  },
});
