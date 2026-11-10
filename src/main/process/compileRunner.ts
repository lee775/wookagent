/**
 * Windows Job Object 러너(resources/jobrunner/JobRunner.cs)를 OS에 들어 있는 .NET Framework C# 컴파일러로 빌드한다
 * (ARCHITECTURE.md 13장). 결과: <dataDir>/bin/WookJobRunner.exe + 같은 폴더의 WookJobRunner.sha256 (두 줄: source·exe).
 *
 * 컴파일·재사용·확인의 공통 부분은 ./compiledTool.ts (화면 도우미와 같은 코드, 리드 결정 S6-5). 이 파일은 러너용 얇은 겉면이다.
 * 준비 결과의 pin(실행 파일 바이트 해시)으로 프로세스 러너가 띄울 때마다 다시 견준다 (processRunner.ts, S5-21).
 * scripts/build-jobrunner.mjs는 Node 형식 제거로 compiledTool.ts를 직접 불러온다 (이 파일은 확장자 없는 상대 import를 쓴다).
 */
import {
  JOB_RUNNER_TOOL,
  defaultToolSourceCandidates,
  ensureCompiledTool,
  findCsc,
  probeCompiledTool,
  toolPaths,
  toolSourceHash,
  type CompiledToolOutcome,
} from './compiledTool';

export { findCsc };

export const RUNNER_EXE_NAME = JOB_RUNNER_TOOL.exeName;
export const RUNNER_HASH_NAME = JOB_RUNNER_TOOL.hashName;
/**
 * JobRunner.cs의 ProtocolVersion과 같아야 한다. 확인(--probe)에서 다르면 쓰지 않고 다시 컴파일한다.
 * 2: --verbatim-args (자동 검사 cmd 명령줄을 그대로 넘김, windows:F4) — 옛 러너는 이 옵션을 몰라 사용법 오류로 끝난다
 */
export const RUNNER_PROTOCOL_VERSION = JOB_RUNNER_TOOL.protocolVersion;

export type CompileOutcome = CompiledToolOutcome;

export interface EnsureJobRunnerOptions {
  /** 앱 데이터 폴더. 결과는 <dataDir>/bin 에 둔다 */
  dataDir: string;
  /** JobRunner.cs 경로. 없으면 defaultRunnerSourceCandidates() 순서로 찾는다 */
  sourcePath?: string;
  /** 해시가 같아도 다시 컴파일 */
  force?: boolean;
  /** csc.exe 경로를 직접 지정 (테스트·진단용) */
  cscPath?: string;
}

/**
 * 러너 소스를 찾을 위치. 패키지 앱은 resources(asar 밖), 개발 실행은 프로젝트 루트(현재 폴더).
 * 조립하는 쪽이 앱 루트를 알면 sourcePath(runnerSource)로 직접 넘기는 편이 확실하다.
 */
export function defaultRunnerSourceCandidates(): string[] {
  return defaultToolSourceCandidates(JOB_RUNNER_TOOL);
}

export function runnerPaths(dataDir: string): { binDir: string; exePath: string; hashPath: string } {
  return toolPaths(JOB_RUNNER_TOOL, dataDir);
}

/** 소스 해시 + 빌드 방법 해시 (저장된 값과 다르면 다시 컴파일) */
export function runnerSourceHash(source: Buffer): string {
  return toolSourceHash(JOB_RUNNER_TOOL, source);
}

/**
 * 러너가 준비돼 있으면 그대로, 없거나 소스·실행 파일이 바뀌었으면 컴파일한다. 마지막에 --probe로 실제 동작을 확인한다.
 * 실패해도 던지지 않고 한국어 사유를 돌려준다 (호출자가 taskkill 방식으로 대체).
 */
export function ensureJobRunner(opts: EnsureJobRunnerOptions): Promise<CompileOutcome> {
  return ensureCompiledTool(JOB_RUNNER_TOOL, opts);
}

/** `WookJobRunner.exe --probe`: 작업 개체 생성과 구조체 배치를 실제로 확인 */
export async function probeJobRunner(exePath: string, timeoutMs?: number): Promise<{ ok: true; detail: string } | { ok: false; reason: string }> {
  const r = await probeCompiledTool(JOB_RUNNER_TOOL, exePath, timeoutMs);
  return r.ok ? { ok: true, detail: r.detail } : r;
}
