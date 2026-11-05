/**
 * Windows Job Object 러너(resources/jobrunner/JobRunner.cs)를 OS에 들어 있는 .NET Framework C# 컴파일러로 빌드한다
 * (ARCHITECTURE.md 13장). 결과: <dataDir>/bin/WookJobRunner.exe + 같은 폴더의 WookJobRunner.sha256.
 *
 * scripts/build-jobrunner.mjs 가 Node의 형식 제거(type stripping)로 이 파일을 직접 불러온다.
 * 그래서 런타임 import는 node: 모듈만 쓰고(경로 별칭·확장자 없는 상대 경로 금지), 지울 수 있는 TS 문법만 쓴다.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';

export const RUNNER_EXE_NAME = 'WookJobRunner.exe';
export const RUNNER_HASH_NAME = 'WookJobRunner.sha256';
/**
 * JobRunner.cs의 ProtocolVersion과 같아야 한다. 확인(--probe)에서 다르면 쓰지 않고 다시 컴파일한다.
 * 2: --verbatim-args (자동 검사 cmd 명령줄을 그대로 넘김, windows:F4) — 옛 러너는 이 옵션을 몰라 사용법 오류로 끝난다
 */
export const RUNNER_PROTOCOL_VERSION = 2;

/** 컴파일 방법도 해시에 넣는다: 옵션이 바뀌면 소스가 같아도 다시 빌드 */
const CSC_ARGS = ['/nologo', '/utf8output', '/target:exe', '/platform:anycpu', '/optimize+', '/warn:4'];
const BUILD_RECIPE = `csc ${CSC_ARGS.join(' ')}; protocol ${RUNNER_PROTOCOL_VERSION}`;
const COMPILE_TIMEOUT_MS = 120_000;
/** 새로 만든 실행 파일은 백신 검사로 첫 실행이 느릴 수 있다 */
const PROBE_TIMEOUT_MS = 20_000;
const STALE_FILE_MS = 60 * 60 * 1000;

export type CompileOutcome =
  | {
      ok: true;
      exePath: string;
      /** 이번에 새로 컴파일했는지 (false면 기존 파일 재사용) */
      compiled: boolean;
      sourcePath: string;
      sourceHash: string;
      cscPath: string | null;
      detail: string;
      durationMs: number;
    }
  | { ok: false; reason: string; durationMs: number };

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

/** csc.exe 위치: Framework64 → Framework (둘 다 .NET Framework 4.x, C# 5) */
export function findCsc(env: NodeJS.ProcessEnv = process.env): { path: string | null; checked: string[] } {
  const windir = env.WINDIR ?? env.windir ?? env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const checked = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const candidate of checked) {
    if (isFile(candidate)) return { path: candidate, checked };
  }
  return { path: null, checked };
}

/**
 * 러너 소스를 찾을 위치. 패키지 앱은 resources(asar 밖), 개발 실행은 프로젝트 루트(현재 폴더).
 * 조립하는 쪽이 앱 루트를 알면 sourcePath(runnerSource)로 직접 넘기는 편이 확실하다.
 */
export function defaultRunnerSourceCandidates(): string[] {
  const out: string[] = [];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    out.push(join(resourcesPath, 'jobrunner', 'JobRunner.cs'));
    out.push(join(resourcesPath, 'resources', 'jobrunner', 'JobRunner.cs'));
  }
  out.push(resolve(process.cwd(), 'resources', 'jobrunner', 'JobRunner.cs'));
  return out;
}

export function runnerPaths(dataDir: string): { binDir: string; exePath: string; hashPath: string } {
  const binDir = join(dataDir, 'bin');
  return { binDir, exePath: join(binDir, RUNNER_EXE_NAME), hashPath: join(binDir, RUNNER_HASH_NAME) };
}

/** 소스 해시 + 빌드 방법 해시 (저장된 값과 다르면 다시 컴파일) */
export function runnerSourceHash(source: Buffer): string {
  return createHash('sha256').update(source).update('\n--wook-build:').update(BUILD_RECIPE).digest('hex');
}

/**
 * 러너가 준비돼 있으면 그대로, 없거나 소스가 바뀌었으면 컴파일한다. 마지막에 --probe로 실제 동작을 확인한다.
 * 실패해도 던지지 않고 한국어 사유를 돌려준다 (호출자가 taskkill 방식으로 대체).
 */
export async function ensureJobRunner(opts: EnsureJobRunnerOptions): Promise<CompileOutcome> {
  const t0 = performance.now();
  const elapsed = (): number => Math.round(performance.now() - t0);
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'Job Object 러너는 Windows 전용입니다', durationMs: elapsed() };
  }

  let sourcePath: string;
  if (opts.sourcePath) {
    sourcePath = resolve(opts.sourcePath);
  } else {
    const candidates = defaultRunnerSourceCandidates();
    const found = candidates.find(isFile);
    if (!found) {
      return {
        ok: false,
        reason: `러너 소스(JobRunner.cs)를 찾을 수 없습니다. 확인한 위치: ${candidates.join(', ')}`,
        durationMs: elapsed(),
      };
    }
    sourcePath = found;
  }

  let source: Buffer;
  try {
    source = await readFile(sourcePath);
  } catch (err) {
    return { ok: false, reason: `러너 소스를 읽지 못했습니다: ${sourcePath} (${errorText(err)})`, durationMs: elapsed() };
  }
  const sourceHash = runnerSourceHash(source);
  const { binDir, exePath, hashPath } = runnerPaths(opts.dataDir);

  let reuseNote = '';
  if (!opts.force && isFile(exePath) && (await readStoredHash(hashPath)) === sourceHash) {
    const probe = await probeJobRunner(exePath);
    if (probe.ok) {
      return {
        ok: true,
        exePath,
        compiled: false,
        sourcePath,
        sourceHash,
        cscPath: null,
        detail: `기존 러너 사용 (${probe.detail})`,
        durationMs: elapsed(),
      };
    }
    // 백신 격리·손상 등: 한 번 다시 만든다
    reuseNote = ` (기존 러너 확인 실패로 다시 컴파일: ${probe.reason})`;
  }

  const csc = opts.cscPath ? { path: isFile(opts.cscPath) ? opts.cscPath : null, checked: [opts.cscPath] } : findCsc();
  if (!csc.path) {
    return {
      ok: false,
      reason: `C# 컴파일러(csc.exe, .NET Framework 4.x)를 찾을 수 없습니다. 확인한 위치: ${csc.checked.join(', ')}`,
      durationMs: elapsed(),
    };
  }

  try {
    await mkdir(binDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `러너 폴더를 만들지 못했습니다: ${binDir} (${errorText(err)})`, durationMs: elapsed() };
  }
  const cleanupNotes = await removeStaleBuildFiles(binDir);
  const notes = cleanupNotes.length > 0 ? ` (지난 빌드 파일 정리 실패: ${cleanupNotes.join(', ')})` : '';

  const tag = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  // 해시를 계산한 바로 그 내용을 컴파일한다 (asar 안 소스도 csc가 읽을 수 있게 복사)
  const tmpSource = join(binDir, `JobRunner.${tag}.build.cs`);
  const tmpExe = join(binDir, `WookJobRunner.${tag}.build.exe`);
  try {
    await writeFile(tmpSource, source);
    const compiled = await runCsc(csc.path, [...CSC_ARGS, `/out:${tmpExe}`, tmpSource]);
    if (!compiled.ok) {
      return { ok: false, reason: compiled.reason, durationMs: elapsed() };
    }
    const probe = await probeJobRunner(tmpExe);
    if (!probe.ok) {
      return { ok: false, reason: `컴파일한 러너가 동작하지 않습니다: ${probe.reason}`, durationMs: elapsed() };
    }
    const installed = await installExe(tmpExe, exePath, tag);
    if (!installed.ok) {
      return { ok: false, reason: installed.reason, durationMs: elapsed() };
    }
    await writeFile(hashPath, `${sourceHash}\n`, 'utf8');
    return {
      ok: true,
      exePath,
      compiled: true,
      sourcePath,
      sourceHash,
      cscPath: csc.path,
      detail: `러너를 새로 컴파일했습니다 (${probe.detail})${reuseNote}${notes}`,
      durationMs: elapsed(),
    };
  } catch (err) {
    return { ok: false, reason: `러너를 준비하지 못했습니다: ${errorText(err)}`, durationMs: elapsed() };
  } finally {
    // 백신 검사 등으로 지금 못 지운 임시 파일은 다음 컴파일 때 removeStaleBuildFiles가 지운다
    await rm(tmpSource, { force: true }).catch(() => undefined);
    await rm(tmpExe, { force: true }).catch(() => undefined);
  }
}

/** `WookJobRunner.exe --probe`: 작업 개체 생성과 구조체 배치를 실제로 확인 */
export async function probeJobRunner(
  exePath: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ ok: true; detail: string } | { ok: false; reason: string }> {
  const result = await runCaptured(exePath, ['--probe'], timeoutMs);
  if (result.error) return { ok: false, reason: `러너를 실행하지 못했습니다 (${result.error})` };
  if (result.timedOut) return { ok: false, reason: `러너 확인이 ${timeoutMs}ms 안에 끝나지 않았습니다` };
  const stdout = result.stdout.toString('utf8');
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('{"__wookRunner":"probe"'));
  let parsed: ProbeReply | null = null;
  if (line) {
    try {
      parsed = JSON.parse(line) as ProbeReply;
    } catch {
      parsed = null; // 깨진 응답은 아래에서 '응답 없음'으로 보고한다
    }
  }
  if (!parsed) {
    const stderr = result.stderr.toString('utf8').trim();
    return {
      ok: false,
      reason: `러너 확인 응답이 없습니다 (종료 코드 ${String(result.code)}${stderr ? `, ${firstLines(stderr, 3)}` : ''})`,
    };
  }
  if (parsed.ok !== true) {
    return { ok: false, reason: `러너 확인 실패: ${typeof parsed.error === 'string' ? parsed.error : '사유 없음'}` };
  }
  if (parsed.version !== RUNNER_PROTOCOL_VERSION) {
    return { ok: false, reason: `러너 프로토콜 버전이 다릅니다 (${String(parsed.version)} ≠ ${RUNNER_PROTOCOL_VERSION})` };
  }
  return { ok: true, detail: `프로토콜 ${RUNNER_PROTOCOL_VERSION}, ${String(parsed.bits)}비트` };
}

interface ProbeReply {
  ok?: unknown;
  version?: unknown;
  bits?: unknown;
  error?: unknown;
}

async function runCsc(cscPath: string, args: string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await runCaptured(cscPath, args, COMPILE_TIMEOUT_MS);
  if (result.error) return { ok: false, reason: `csc.exe를 실행하지 못했습니다: ${result.error}` };
  if (result.timedOut) return { ok: false, reason: `러너 컴파일이 ${COMPILE_TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다` };
  if (result.code !== 0) {
    const output = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`;
    const errors = output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /error CS\d+/i.test(l));
    const summary = errors.length > 0 ? errors.slice(0, 5).join(' / ') : firstLines(output.trim(), 5);
    return { ok: false, reason: `러너 컴파일 실패 (csc 종료 코드 ${String(result.code)}): ${summary}` };
  }
  return { ok: true };
}

/** 실행 중인 exe는 지울 수 없지만 이름은 바꿀 수 있다 → 옛 파일을 비키고 새 파일을 넣는다 */
async function installExe(
  tmpExe: string,
  exePath: string,
  tag: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await rm(exePath, { force: true });
  } catch (err) {
    if (!isBusyError(err)) return { ok: false, reason: `기존 러너를 지우지 못했습니다: ${exePath} (${errorText(err)})` };
    try {
      await retryWhileBusy(() => rename(exePath, join(dirname(exePath), `WookJobRunner.${tag}.old.exe`)));
    } catch (renameErr) {
      return { ok: false, reason: `사용 중인 기존 러너를 비키지 못했습니다: ${exePath} (${errorText(renameErr)})` };
    }
  }
  try {
    // 막 만든 exe는 백신이 잠깐 잡고 있을 수 있다
    await retryWhileBusy(() => rename(tmpExe, exePath));
  } catch (err) {
    return { ok: false, reason: `러너 파일을 설치하지 못했습니다: ${exePath} (${errorText(err)})` };
  }
  return { ok: true };
}

async function retryWhileBusy(fn: () => Promise<void>, attempts = 10, delayMs = 100): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      if (i >= attempts || !isBusyError(err)) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/**
 * 지난 빌드의 임시 파일·비켜 둔 옛 러너 정리. 아직 쓰는 중(EBUSY·EPERM)이면 다음 기회에 지운다.
 * 그 밖의 실패는 컴파일을 막지 않고 설명으로 돌려준다.
 */
async function removeStaleBuildFiles(binDir: string): Promise<string[]> {
  const notes: string[] = [];
  let names: string[];
  try {
    names = await readdir(binDir);
  } catch (err) {
    return [`${binDir} 목록 읽기 실패 (${errorText(err)})`];
  }
  const now = Date.now();
  for (const name of names) {
    const isOld = /^WookJobRunner\..+\.old\.exe$/i.test(name);
    const isBuildLeftover = /\.build\.(cs|exe)$/i.test(name);
    if (!isOld && !isBuildLeftover) continue;
    const full = join(binDir, name);
    try {
      // 다른 프로세스가 지금 빌드 중일 수 있어 오래된 임시 파일만 지운다
      if (isBuildLeftover && now - (await stat(full)).mtimeMs < STALE_FILE_MS) continue;
      await rm(full, { force: true });
    } catch (err) {
      if (!isBusyError(err)) notes.push(`${name} (${errorText(err)})`);
    }
  }
  return notes;
}

/** 읽을 수 없으면 null → 다시 컴파일한다 (그때 쓰기 실패가 있으면 그 사유가 드러난다) */
async function readStoredHash(hashPath: string): Promise<string | null> {
  try {
    return (await readFile(hashPath, 'utf8')).trim();
  } catch {
    return null;
  }
}

interface Captured {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  error: string | null;
}

function runCaptured(file: string, args: string[], timeoutMs: number): Promise<Captured> {
  return new Promise((resolvePromise) => {
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let timedOut = false;
    let spawnError: string | null = null;
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolvePromise({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, error: errorText(err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => errOut.push(d));
    child.on('error', (err) => {
      spawnError = errorText(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(errOut),
        timedOut,
        error: spawnError,
      });
    });
  });
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function isBusyError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

function firstLines(text: string, n: number): string {
  return text.split(/\r?\n/).filter(Boolean).slice(0, n).join(' / ');
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
