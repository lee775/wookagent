import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * 대표의 모의 체험 (리드 결정 S9-9, `scripts\try-server.cmd mock`이 WOOK_TRY=1로 부른다): tests/try의 *.try.ts만 — 프로세스 안 서버(모의 메인 에이전트·
 * 모의 프로젝트, 가짜 구글) + 서버용 웹 화면 + Edge 창. 웹 화면 폴더는 도구가 WOOK_TRY_WEB_DIR로 넘긴다(낡았으면 도구가 먼저 다시 만든다).
 * 사람이 창을 닫을 때까지 도므로 시험 시간 상한이 없다. 실행마다 임시 폴더 하나(runTemp — 끝날 때 지운다). 주 설정·웹 시험 설정은 *.try.ts를 돌리지 않는다
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@core': resolve('src/core'),
    },
  },
  test: {
    include: ['tests/try/**/*.try.ts'],
    environment: 'node',
    globalSetup: ['tests/setup/runTemp.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 0,
    hookTimeout: 180_000,
  },
});
