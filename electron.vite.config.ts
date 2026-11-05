import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// 기본 진입점: src/main/index.ts, src/preload/index.ts, src/renderer/index.html
const alias = {
  '@shared': resolve('src/shared'),
  '@core': resolve('src/core'),
};

export default defineConfig({
  main: {
    resolve: { alias },
  },
  preload: {
    resolve: { alias },
  },
  renderer: {
    resolve: {
      alias: { ...alias, '@renderer': resolve('src/renderer/src') },
    },
    plugins: [react()],
  },
});
