/**
 * 서버 도우미를 시험 실행마다 한 번만 컴파일한다 (리드 결정 S9-11 CPU) — 주 설정(vitest.config.ts)의 globalSetup, runTemp.ts 다음.
 * - 빌드한 서버(serve.ts)는 Windows에서 `<데이터 폴더>/bin/WookServerHelper.exe`를 준비한다(없으면 csc로 컴파일). 시험마다 새 데이터 폴더라 그대로 두면
 *   서버를 띄울 때마다 csc가 돈다. 그래서 여기서 이 실행의 임시 폴더(runTemp.ts가 정한 TEMP 아래)에 한 번 컴파일하고, 그 폴더를
 *   WOOK_TEST_SERVER_HELPER_BIN으로 일꾼에게 알린다. tests/server/helpers.ts의 seedServerHelper(startBuilt가 부른다)가 실행 파일과 .sha256을 데이터
 *   폴더의 bin에 복사한다 — 서버의 ensureCompiledTool은 원본 해시와 실행 파일 해시가 맞으면 csc 없이 재사용한다
 * - csc가 없거나(Windows 밖 포함) 컴파일이 실패하면 아무것도 알리지 않는다 — 그때 빌드한 서버는 스스로 준비하거나 Node 파이프로 물러난다
 * - 이 실행의 임시 폴더는 runTemp.ts의 끝이 지운다
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureCompiledTool, findCsc, toolPaths } from '../../src/main/process/compiledTool';
import { SERVER_HELPER_TOOL } from '../../src/server/serverHelper';

/** 일꾼이 읽는 환경 변수 — 컴파일한 실행 파일과 .sha256이 든 폴더 */
export const SERVER_HELPER_BIN_ENV = 'WOOK_TEST_SERVER_HELPER_BIN';

export default async function setup(): Promise<() => void> {
  const before = process.env[SERVER_HELPER_BIN_ENV];
  const restore = (): void => {
    if (before === undefined) delete process.env[SERVER_HELPER_BIN_ENV];
    else process.env[SERVER_HELPER_BIN_ENV] = before;
  };
  if (process.platform !== 'win32' || !findCsc().path) return restore;
  const root = join(process.env.TEMP ?? process.env.TMPDIR ?? '.', 'serverhelper');
  mkdirSync(root, { recursive: true });
  const r = await ensureCompiledTool(SERVER_HELPER_TOOL, {
    dataDir: root,
    sourcePath: resolve('resources', SERVER_HELPER_TOOL.resourceDir, SERVER_HELPER_TOOL.sourceName),
    probe: false,
  });
  if (!r.ok) {
    console.warn(`[서버 도우미] 시험용으로 컴파일하지 못했습니다 — 빌드한 서버가 스스로 준비합니다: ${r.reason}`);
    return restore;
  }
  process.env[SERVER_HELPER_BIN_ENV] = toolPaths(SERVER_HELPER_TOOL, root).binDir;
  return restore;
}
