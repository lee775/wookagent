import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * 브라우저 끝까지 시험 (리드 결정 S8-7, `npm run test:web`): tests/web만. 실제 서버(프로세스 안) + 서버용 웹 빌드 + https 앞단 + headless Microsoft Edge.
 * 브라우저는 한 번에 하나라 파일을 차례로 돌린다. 주 설정(vitest.config.ts)은 tests/web을 뺀다.
 * 대표의 체험 도구 점검(tests/try/*.web.ts — trySmoke, 리드 결정 S9-11)도 여기서 돈다. 주 설정은 *.test.ts만 보므로 그 파일을 돌리지 않는다
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@core': resolve('src/core'),
    },
  },
  test: {
    include: ['tests/web/**/*.test.ts', 'tests/try/**/*.web.ts'],
    environment: 'node',
    // 실행 폴더(임시 폴더 정리, S4-24) 다음에 Edge 확인과 웹 화면 빌드
    globalSetup: ['tests/setup/runTemp.ts', 'tests/web/globalSetup.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
