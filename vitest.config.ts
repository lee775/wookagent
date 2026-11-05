import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@core': resolve('src/core'),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['src/renderer/**', 'node_modules/**', 'out/**'],
    environment: 'node',
    // 실행마다 임시 폴더 하나 — 시험이 만든 wook-test-* 폴더를 끝날 때 한꺼번에 지운다 (리드 결정 S4-24)
    globalSetup: ['tests/setup/runTemp.ts'],
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
