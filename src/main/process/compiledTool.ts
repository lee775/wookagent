/**
 * OS에 들어 있는 .NET Framework C# 컴파일러(csc.exe, C# 5)로 만드는 실행 파일 두 개의 공통 준비 (ARCHITECTURE.md 13장, 리드 결정 S6-4·S6-5).
 * - 작업 개체 러너: resources/jobrunner/JobRunner.cs → <dataDir>/bin/WookJobRunner.exe (+ WookJobRunner.sha256)
 * - 화면 도우미: resources/desktophelper/DesktopHelper.cs → <dataDir>/bin/WookDesktopHelper.exe (+ WookDesktopHelper.sha256)
 *
 * .sha256 파일은 두 줄이다: `source <원본과 만드는 법의 해시>` · `exe <실행 파일 바이트의 해시>`. 다시 쓸 때 둘 다 맞아야 한다 — 원본이 같아도
 * 실행 파일이 바뀌었으면(누가 바꿔 넣음) 다시 컴파일한다. 준비한 뒤 돌려주는 pin(실행 파일 경로 + 바이트 해시)으로 띄울 때마다 다시 견준다
 * (pinnedFile.ts checkPinned, S5-21). 옛 한 줄 형식(원본 해시만)은 실행 파일 해시가 없으므로 한 번 다시 컴파일한다.
 *
 * scripts/build-jobrunner.mjs 가 Node의 형식 제거(type stripping)로 이 파일을 직접 불러온다. 그래서 런타임 import는 node: 모듈만 쓰고
 * (경로 별칭·확장자 없는 상대 경로 금지 — 형식만 가져오는 import type은 지워지므로 괜찮다), 지울 수 있는 TS 문법만 쓴다.
 *
 * 화면 도우미 실행 파일은 이 PC(대표가 쓰는 PC)에서 시험이 띄우면 안 된다 (S6-15): 확인(--probe)도 시험 중에는 실제 화면 시험 문(S6-13)이
 * 열렸을 때만 띄운다(probeCompiledTool). 시험은 probe:false로 컴파일만 한다.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type { FilePin } from './pinnedFile';

export interface CompiledToolSpec {
  /** 사유 글에 쓰는 이름 */
  readonly label: string;
  readonly exeName: string;
  readonly hashName: string;
  /** resources/<resourceDir>/<sourceName> */
  readonly resourceDir: string;
  readonly sourceName: string;
  /** csc 폴더 기준 상대 경로의 추가 참조 (예: WPF\UIAutomationClient.dll). 만드는 법 해시에 이름 그대로 들어간다 */
  readonly references: readonly string[];
  /** C# 소스의 ProtocolVersion과 같아야 한다. 확인(--probe)에서 다르면 쓰지 않는다 */
  readonly protocolVersion: number;
  /** --probe 응답 JSON의 첫 키 (예: {"__wookRunner":"probe",...}) */
  readonly probeKey: string;
}

/**
 * 작업 개체 러너. 2: --verbatim-args (자동 검사 cmd 명령줄을 그대로 넘김, windows:F4) — 옛 러너는 이 옵션을 몰라 사용법 오류로 끝난다
 */
export const JOB_RUNNER_TOOL: CompiledToolSpec = {
  // 예전 사유 글('러너 컴파일 실패 …')을 그대로 두려고 짧은 이름
  label: '러너',
  exeName: 'WookJobRunner.exe',
  hashName: 'WookJobRunner.sha256',
  resourceDir: 'jobrunner',
  sourceName: 'JobRunner.cs',
  references: [],
  protocolVersion: 2,
  probeKey: '__wookRunner',
};

/**
 * 화면 도우미 (리드 결정 S6-4). 3: 한 줄 프로토콜 3판 (src/main/desktop/desktopHelper.ts DESKTOP_PROTOCOL_VERSION과 같다).
 * UI Automation(암호 칸 판정)은 WPF 폴더의 참조가 필요하다. System.Drawing·System.Windows.Forms는 csc.rsp 기본 참조다
 */
export const DESKTOP_HELPER_TOOL: CompiledToolSpec = {
  label: '화면 도우미',
  exeName: 'WookDesktopHelper.exe',
  hashName: 'WookDesktopHelper.sha256',
  resourceDir: 'desktophelper',
  sourceName: 'DesktopHelper.cs',
  references: ['WPF\\UIAutomationClient.dll', 'WPF\\UIAutomationTypes.dll'],
  protocolVersion: 3,
  probeKey: '__wookDesktop',
};

/** 컴파일 방법도 해시에 넣는다: 옵션이 바뀌면 소스가 같아도 다시 빌드 */
const CSC_ARGS = ['/nologo', '/utf8output', '/target:exe', '/platform:anycpu', '/optimize+', '/warn:4'];
const COMPILE_TIMEOUT_MS = 120_000;
/** 새로 만든 실행 파일은 백신 검사로 첫 실행이 느릴 수 있다 */
const PROBE_TIMEOUT_MS = 20_000;
const STALE_FILE_MS = 60 * 60 * 1000;

export type CompiledToolOutcome =
  | {
      ok: true;
      exePath: string;
      /** 이번에 새로 컴파일했는지 (false면 기존 파일 재사용) */
      compiled: boolean;
      sourcePath: string;
      /** 원본 + 만드는 법의 해시 (.sha256의 source 줄) */
      sourceHash: string;
      /** 실행 파일 바이트의 해시 (.sha256의 exe 줄) */
      exeSha256: string;
      /** 띄울 때마다 견줄 값 (pinnedFile.ts checkPinned) */
      pin: FilePin;
      cscPath: string | null;
      detail: string;
      durationMs: number;
    }
  | { ok: false; reason: string; durationMs: number };

export interface EnsureCompiledToolOptions {
  /** 앱 데이터 폴더. 결과는 <dataDir>/bin 에 둔다 */
  dataDir: string;
  /** 소스 경로. 없으면 defaultToolSourceCandidates() 순서로 찾는다 */
  sourcePath?: string;
  /** 해시가 같아도 다시 컴파일 */
  force?: boolean;
  /** csc.exe 경로를 직접 지정 (테스트·진단용) */
  cscPath?: string;
  /**
   * 컴파일·재사용 뒤 --probe로 실제 동작을 확인한다 (기본 true). 화면 도우미의 컴파일만 하는 시험은 false — 그 실행 파일은 이 PC에서 띄우지 않는다
   * (S6-15). false면 재사용도 해시만으로 정한다
   */
  probe?: boolean;
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
 * 소스를 찾을 위치. 패키지 앱은 resources(asar 밖), 개발 실행은 프로젝트 루트(현재 폴더).
 * 조립하는 쪽이 앱 루트를 알면 sourcePath로 직접 넘기는 편이 확실하다.
 */
export function defaultToolSourceCandidates(spec: CompiledToolSpec): string[] {
  const out: string[] = [];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    out.push(join(resourcesPath, spec.resourceDir, spec.sourceName));
    out.push(join(resourcesPath, 'resources', spec.resourceDir, spec.sourceName));
  }
  out.push(resolve(process.cwd(), 'resources', spec.resourceDir, spec.sourceName));
  return out;
}

export function toolPaths(spec: CompiledToolSpec, dataDir: string): { binDir: string; exePath: string; hashPath: string } {
  const binDir = join(dataDir, 'bin');
  return { binDir, exePath: join(binDir, spec.exeName), hashPath: join(binDir, spec.hashName) };
}

/** 만드는 법 (해시에 들어간다). 참조가 없는 러너는 예전과 같은 글이라 원본 해시가 그대로다 */
export function buildRecipe(spec: CompiledToolSpec): string {
  const refs = spec.references.map((r) => ` /r:${r}`).join('');
  return `csc ${CSC_ARGS.join(' ')}${refs}; protocol ${spec.protocolVersion}`;
}

/** 소스 해시 + 빌드 방법 해시 (저장된 값과 다르면 다시 컴파일) */
export function toolSourceHash(spec: CompiledToolSpec, source: Buffer): string {
  return createHash('sha256').update(source).update('\n--wook-build:').update(buildRecipe(spec)).digest('hex');
}

/** .sha256 파일 내용: 두 줄 (source·exe) */
export function formatToolHashFile(sourceHash: string, exeSha256: string): string {
  return `source ${sourceHash}\nexe ${exeSha256}\n`;
}

/**
 * .sha256 파일 읽기. 두 줄 형식이면 둘 다, 옛 한 줄 형식(원본 해시만)이면 exe는 null — 실행 파일을 확인할 수 없으므로 호출자가 다시 컴파일한다.
 * 읽지 못하거나 모르는 형식이면 null
 */
export function parseToolHashFile(text: string): { source: string; exe: string | null } | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hex = /^[0-9a-f]{64}$/;
  if (lines.length === 1 && hex.test(lines[0]!)) return { source: lines[0]!, exe: null };
  let source: string | null = null;
  let exe: string | null = null;
  for (const line of lines) {
    const m = /^(source|exe) ([0-9a-f]{64})$/.exec(line);
    if (!m) return null;
    if (m[1] === 'source') source = m[2]!;
    else exe = m[2]!;
  }
  return source && exe ? { source, exe } : null;
}

/** 실행 파일 바이트의 SHA-256 (pinnedFile.ts sha256File과 같은 값 — 이 파일은 node: 모듈만 불러오므로 따로 둔다) */
export function exeSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * 실제 화면 시험 문 (리드 결정 S6-13): Windows이고 WOOK_REAL_DESKTOP=1이고 WOOK_REAL_DESKTOP_HOST가 이 PC 이름일 때만 열린다.
 * 시험(VITEST) 중에는 이 문이 열렸을 때만 화면 도우미를 띄운다 — 확인(--probe)도. 에이전트는 이 변수를 쓰지 않는다 (S6-15)
 */
export function realDesktopGateOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === 'win32' && env.WOOK_REAL_DESKTOP === '1' && !!env.WOOK_REAL_DESKTOP_HOST && env.WOOK_REAL_DESKTOP_HOST === hostname();
}

/** 이 실행 파일을 지금 띄워도 되는지. 화면 도우미는 시험 중에 실제 화면 시험 문이 닫혀 있으면 띄우지 않는다 */
export function toolLaunchRefusal(spec: CompiledToolSpec, env: NodeJS.ProcessEnv = process.env): string | null {
  if (spec.probeKey !== DESKTOP_HELPER_TOOL.probeKey) return null;
  if (env.VITEST && !realDesktopGateOpen(env)) {
    return '시험 중에는 실제 화면 도우미를 띄우지 않습니다 — 가짜 도우미를 쓰세요 (실제 화면 시험은 WOOK_REAL_DESKTOP 문이 열렸을 때만)';
  }
  return null;
}

/** 실행 파일마다(<dataDir>/bin/<exe>) 지금 도는 준비 — 이 프로세스 안에서 같은 실행 파일의 준비는 한 번에 하나다 */
const ensuring = new Map<string, Promise<CompiledToolOutcome>>();

function ensureKey(spec: CompiledToolSpec, dataDir: string): string {
  const p = resolve(toolPaths(spec, dataDir).exePath);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * 실행 파일이 준비돼 있으면 그대로, 없거나 소스·실행 파일이 바뀌었으면 컴파일한다. 마지막에 --probe로 실제 동작을 확인한다(probe:false면 건너뛴다).
 * 실패해도 던지지 않고 한국어 사유를 돌려준다 (러너는 taskkill 방식으로 대체, 화면 도우미는 쓸 수 없음).
 *
 * 같은 실행 파일(데이터 폴더·이름)의 준비는 줄을 세운다 (리드 결정 S6-21 H3): 둘이 함께 컴파일해 같은 자리에 차례로 설치하면, 먼저 끝난 쪽이 돌려준 해시는
 * 이미 덮인 파일의 것이다 — 그 쪽의 첫 띄우기가 '파일이 바뀜'으로 거부되고 한 번뿐인 다시 컴파일을 쓴다. 줄을 서면 뒤의 준비는 앞이 설치한 파일을 해시로
 * 재사용한다 (force면 다시 컴파일한다)
 */
export async function ensureCompiledTool(spec: CompiledToolSpec, opts: EnsureCompiledToolOptions): Promise<CompiledToolOutcome> {
  const key = ensureKey(spec, opts.dataDir);
  const before = ensuring.get(key);
  const mine = (async (): Promise<CompiledToolOutcome> => {
    if (before) await before.catch(() => undefined);
    return ensureCompiledToolNow(spec, opts);
  })();
  ensuring.set(key, mine);
  try {
    return await mine;
  } finally {
    if (ensuring.get(key) === mine) ensuring.delete(key);
  }
}

async function ensureCompiledToolNow(spec: CompiledToolSpec, opts: EnsureCompiledToolOptions): Promise<CompiledToolOutcome> {
  const t0 = performance.now();
  const elapsed = (): number => Math.round(performance.now() - t0);
  const probing = opts.probe !== false;
  if (process.platform !== 'win32') {
    return { ok: false, reason: `${spec.label}는 Windows 전용입니다`, durationMs: elapsed() };
  }

  let sourcePath: string;
  if (opts.sourcePath) {
    sourcePath = resolve(opts.sourcePath);
  } else {
    const candidates = defaultToolSourceCandidates(spec);
    const found = candidates.find(isFile);
    if (!found) {
      return {
        ok: false,
        reason: `${spec.label} 소스(${spec.sourceName})를 찾을 수 없습니다. 확인한 위치: ${candidates.join(', ')}`,
        durationMs: elapsed(),
      };
    }
    sourcePath = found;
  }

  let source: Buffer;
  try {
    source = await readFile(sourcePath);
  } catch (err) {
    return { ok: false, reason: `${spec.label} 소스를 읽지 못했습니다: ${sourcePath} (${errorText(err)})`, durationMs: elapsed() };
  }
  const sourceHash = toolSourceHash(spec, source);
  const { binDir, exePath, hashPath } = toolPaths(spec, opts.dataDir);

  let reuseNote = '';
  if (!opts.force && isFile(exePath)) {
    const stored = await readStoredHash(hashPath);
    if (stored && stored.source === sourceHash) {
      const actual = safeExeHash(exePath);
      if (stored.exe !== null && actual === stored.exe) {
        const probe = probing ? await probeCompiledTool(spec, exePath) : ({ ok: true, detail: '확인 실행 안 함' } as const);
        if (probe.ok) {
          return {
            ok: true,
            exePath,
            compiled: false,
            sourcePath,
            sourceHash,
            exeSha256: actual,
            pin: { path: exePath, sha256: actual },
            cscPath: null,
            detail: `기존 ${spec.label} 사용 (${probe.detail})`,
            durationMs: elapsed(),
          };
        }
        // 백신 격리·손상 등: 한 번 다시 만든다
        reuseNote = ` (기존 ${spec.label} 확인 실패로 다시 컴파일: ${probe.reason})`;
      } else {
        reuseNote =
          stored.exe === null
            ? ` (옛 해시 파일에 실행 파일 해시가 없어 다시 컴파일)`
            : ` (실행 파일이 적어 둔 해시와 달라 다시 컴파일)`;
      }
    }
  }

  const csc = opts.cscPath ? { path: isFile(opts.cscPath) ? opts.cscPath : null, checked: [opts.cscPath] } : findCsc();
  if (!csc.path) {
    return {
      ok: false,
      reason: `C# 컴파일러(csc.exe, .NET Framework 4.x)를 찾을 수 없습니다. 확인한 위치: ${csc.checked.join(', ')}`,
      durationMs: elapsed(),
    };
  }
  const cscDir = dirname(csc.path);
  const refs: string[] = [];
  for (const ref of spec.references) {
    const full = join(cscDir, ref);
    if (!isFile(full)) {
      return { ok: false, reason: `${spec.label} 컴파일에 필요한 참조(${ref})를 찾을 수 없습니다: ${full}`, durationMs: elapsed() };
    }
    refs.push(`/r:${full}`);
  }

  try {
    await mkdir(binDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `${spec.label} 폴더를 만들지 못했습니다: ${binDir} (${errorText(err)})`, durationMs: elapsed() };
  }
  const cleanupNotes = await removeStaleBuildFiles(spec, binDir);
  const notes = cleanupNotes.length > 0 ? ` (지난 빌드 파일 정리 실패: ${cleanupNotes.join(', ')})` : '';

  const tag = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  // 해시를 계산한 바로 그 내용을 컴파일한다 (asar 안 소스도 csc가 읽을 수 있게 복사)
  const tmpSource = join(binDir, `${baseName(spec.sourceName)}.${tag}.build.cs`);
  const tmpExe = join(binDir, `${baseName(spec.exeName)}.${tag}.build.exe`);
  try {
    await writeFile(tmpSource, source);
    const compiled = await runCsc(spec, csc.path, [...CSC_ARGS, ...refs, `/out:${tmpExe}`, tmpSource]);
    if (!compiled.ok) {
      return { ok: false, reason: compiled.reason, durationMs: elapsed() };
    }
    let probeDetail = '확인 실행 안 함';
    if (probing) {
      const probe = await probeCompiledTool(spec, tmpExe);
      if (!probe.ok) {
        return { ok: false, reason: `컴파일한 ${spec.label}가 동작하지 않습니다: ${probe.reason}`, durationMs: elapsed() };
      }
      probeDetail = probe.detail;
    }
    const installed = await installExe(spec, tmpExe, exePath, tag);
    if (!installed.ok) {
      return { ok: false, reason: installed.reason, durationMs: elapsed() };
    }
    const exeHash = exeSha256(exePath);
    await writeFile(hashPath, formatToolHashFile(sourceHash, exeHash), 'utf8');
    return {
      ok: true,
      exePath,
      compiled: true,
      sourcePath,
      sourceHash,
      exeSha256: exeHash,
      pin: { path: exePath, sha256: exeHash },
      cscPath: csc.path,
      detail: `${spec.label}를 새로 컴파일했습니다 (${probeDetail})${reuseNote}${notes}`,
      durationMs: elapsed(),
    };
  } catch (err) {
    return { ok: false, reason: `${spec.label}를 준비하지 못했습니다: ${errorText(err)}`, durationMs: elapsed() };
  } finally {
    // 백신 검사 등으로 지금 못 지운 임시 파일은 다음 컴파일 때 removeStaleBuildFiles가 지운다
    await rm(tmpSource, { force: true }).catch(() => undefined);
    await rm(tmpExe, { force: true }).catch(() => undefined);
  }
}

/**
 * `<exe> --probe`: 러너는 작업 개체 생성과 구조체 배치를, 화면 도우미는 세션·화면 상태(창·훅·캡처 없이)를 확인한다.
 * 응답은 `{"<probeKey>":"probe","ok":true,"version":N,...}` 한 줄. 화면 도우미는 시험 중에 띄우지 않는다(toolLaunchRefusal)
 */
export async function probeCompiledTool(
  spec: CompiledToolSpec,
  exePath: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ ok: true; detail: string; reply: Record<string, unknown> } | { ok: false; reason: string }> {
  const refusal = toolLaunchRefusal(spec);
  if (refusal) return { ok: false, reason: refusal };
  const result = await runCaptured(exePath, ['--probe'], timeoutMs);
  if (result.error) return { ok: false, reason: `${spec.label}를 실행하지 못했습니다 (${result.error})` };
  if (result.timedOut) return { ok: false, reason: `${spec.label} 확인이 ${timeoutMs}ms 안에 끝나지 않았습니다` };
  const stdout = result.stdout.toString('utf8');
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith(`{"${spec.probeKey}":"probe"`));
  let parsed: (Record<string, unknown> & ProbeReply) | null = null;
  if (line) {
    try {
      parsed = JSON.parse(line) as Record<string, unknown> & ProbeReply;
    } catch {
      parsed = null; // 깨진 응답은 아래에서 '응답 없음'으로 보고한다
    }
  }
  if (!parsed) {
    const stderr = result.stderr.toString('utf8').trim();
    return {
      ok: false,
      reason: `${spec.label} 확인 응답이 없습니다 (종료 코드 ${String(result.code)}${stderr ? `, ${firstLines(stderr, 3)}` : ''})`,
    };
  }
  if (parsed.ok !== true) {
    return { ok: false, reason: `${spec.label} 확인 실패: ${typeof parsed.error === 'string' ? parsed.error : '사유 없음'}` };
  }
  if (parsed.version !== spec.protocolVersion) {
    return { ok: false, reason: `${spec.label} 프로토콜 버전이 다릅니다 (${String(parsed.version)} ≠ ${spec.protocolVersion})` };
  }
  const bits = typeof parsed.bits === 'number' ? `, ${String(parsed.bits)}비트` : '';
  return { ok: true, detail: `프로토콜 ${spec.protocolVersion}${bits}`, reply: parsed };
}

interface ProbeReply {
  ok?: unknown;
  version?: unknown;
  bits?: unknown;
  error?: unknown;
}

async function runCsc(spec: CompiledToolSpec, cscPath: string, args: string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await runCaptured(cscPath, args, COMPILE_TIMEOUT_MS);
  if (result.error) return { ok: false, reason: `csc.exe를 실행하지 못했습니다: ${result.error}` };
  if (result.timedOut) return { ok: false, reason: `${spec.label} 컴파일이 ${COMPILE_TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다` };
  if (result.code !== 0) {
    const output = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`;
    const errors = output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /error CS\d+/i.test(l));
    const summary = errors.length > 0 ? errors.slice(0, 5).join(' / ') : firstLines(output.trim(), 5);
    return { ok: false, reason: `${spec.label} 컴파일 실패 (csc 종료 코드 ${String(result.code)}): ${summary}` };
  }
  return { ok: true };
}

/** 실행 중인 exe는 지울 수 없지만 이름은 바꿀 수 있다 → 옛 파일을 비키고 새 파일을 넣는다 */
async function installExe(
  spec: CompiledToolSpec,
  tmpExe: string,
  exePath: string,
  tag: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await rm(exePath, { force: true });
  } catch (err) {
    if (!isBusyError(err)) return { ok: false, reason: `기존 ${spec.label}를 지우지 못했습니다: ${exePath} (${errorText(err)})` };
    try {
      await retryWhileBusy(() => rename(exePath, join(dirname(exePath), `${baseName(spec.exeName)}.${tag}.old.exe`)));
    } catch (renameErr) {
      return { ok: false, reason: `사용 중인 기존 ${spec.label}를 비키지 못했습니다: ${exePath} (${errorText(renameErr)})` };
    }
  }
  try {
    // 막 만든 exe는 백신이 잠깐 잡고 있을 수 있다
    await retryWhileBusy(() => rename(tmpExe, exePath));
  } catch (err) {
    return { ok: false, reason: `${spec.label} 파일을 설치하지 못했습니다: ${exePath} (${errorText(err)})` };
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
 * 지난 빌드의 임시 파일·비켜 둔 옛 실행 파일 정리. 아직 쓰는 중(EBUSY·EPERM)이면 다음 기회에 지운다.
 * 그 밖의 실패는 컴파일을 막지 않고 설명으로 돌려준다.
 */
async function removeStaleBuildFiles(spec: CompiledToolSpec, binDir: string): Promise<string[]> {
  const notes: string[] = [];
  let names: string[];
  try {
    names = await readdir(binDir);
  } catch (err) {
    return [`${binDir} 목록 읽기 실패 (${errorText(err)})`];
  }
  const now = Date.now();
  const oldRe = new RegExp(`^${escapeRe(baseName(spec.exeName))}\\..+\\.old\\.exe$`, 'i');
  for (const name of names) {
    const isOld = oldRe.test(name);
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
async function readStoredHash(hashPath: string): Promise<{ source: string; exe: string | null } | null> {
  try {
    return parseToolHashFile(await readFile(hashPath, 'utf8'));
  } catch {
    return null;
  }
}

function safeExeHash(path: string): string | null {
  try {
    return exeSha256(path);
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

function baseName(file: string): string {
  return file.replace(/\.[^.]+$/, '');
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
