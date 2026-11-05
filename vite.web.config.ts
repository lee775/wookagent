import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 브라우저에서 화면만 띄워 보는 개발용 설정 (npm run dev:web).
// window.wook이 없으면 화면이 가짜 API(src/renderer/src/api/fake)를 쓴다.
export default defineConfig({
  root: resolve('src/renderer'),
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src'),
    },
  },
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5199, strictPort: true },
  build: { outDir: resolve('out/web'), emptyOutDir: true },
});
