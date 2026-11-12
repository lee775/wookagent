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
    exclude: ['src/renderer/**', 'node_modules/**', 'out/**', 'tests/web/**'],
    environment: 'node',
    // 실행마다 임시 폴더 하나 — 시험이 만든 wook-test-* 폴더를 끝날 때 한꺼번에 지운다 (리드 결정 S4-24).
    // 그다음 서버 도우미를 이 실행에 한 번만 컴파일한다 — 빌드한 서버의 데이터 폴더에 복사한다 (리드 결정 S9-11, tests/setup/serverHelper.ts)
    globalSetup: ['tests/setup/runTemp.ts', 'tests/setup/serverHelper.ts'],
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
