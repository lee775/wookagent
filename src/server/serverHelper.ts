/**
 * 서버 도우미 `WookServerHelper.exe` (SERVER_DESIGN 3.2, 리드 결정 S9-5·S9-7) — 관리 채널 파이프(`pipe`, adminPipe.ts)와 절전 방지(`power`, power.ts)를
 * 맡는 C# 도우미의 준비와 띄우기. 원본은 `resources/serverhelper/ServerHelper.cs`, 실행 파일은 `<dataDir>/bin/WookServerHelper.exe`와 `.sha256`
 * (화면 도우미·작업 개체 러너와 같은 모양 — compiledTool.ts, 리드 결정 S6-5).
 * - 준비(prepare)는 한 번만: 원본에서 컴파일하거나 해시가 맞는 것을 재사용한다(확인 실행 없이 — 도우미의 READY 줄이 판과 동작을 확인한다). csc가 없거나
 *   컴파일이 실패하면 그 까닭을 돌려준다 — 파이프는 Node 파이프로 물러나고(경고), 절전 방지는 쓸 수 없다
 * - 띄우기(spec, 동기): 띄우기 바로 전에 실행 파일을 다시 읽어 준비할 때의 해시와 견준다(pinnedFile.ts). 다르면 띄우지 않고 그 까닭을 돌려준다
 * - 환경: 도우미는 프로세스를 띄우지 않으므로 .NET이 시작하는 데 필요한 것만 준다 (토큰·키를 넘기지 않는다)
 * 시험은 가짜 도우미(tests/fixtures/serverhelper/fakeServerHelper.mjs)를 같은 모양의 launcher로 넘긴다
 */
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { ensureCompiledTool, type CompiledToolOutcome, type CompiledToolSpec } from '../main/process/compiledTool';
import { checkPinned, type FilePin } from '../main/process/pinnedFile';

/** ServerHelper.cs ProtocolVersion과 같아야 한다 (READY 줄의 판) */
export const SERVER_HELPER_PROTOCOL = 1;

export const SERVER_HELPER_TOOL: CompiledToolSpec = {
  label: '서버 도우미',
  exeName: 'WookServerHelper.exe',
  hashName: 'WookServerHelper.sha256',
  resourceDir: 'serverhelper',
  sourceName: 'ServerHelper.cs',
  references: [],
  protocolVersion: SERVER_HELPER_PROTOCOL,
  probeKey: '__wookServer',
};

/** 도우미 한 줄의 상한 — 넘으면 그 도우미를 끝낸다 (리드 결정 S9-7) */
export const SERVER_HELPER_MAX_LINE = 1024 * 1024;

export type ServerHelperMode = 'pipe' | 'power';

export interface ServerHelperSpawn {
  file: string;
  args: string[];
  env: Record<string, string>;
}

/** 서버 도우미를 띄우는 이음매 — 제품은 createServerHelperLauncher, 시험은 가짜 도우미 */
export interface ServerHelperLauncher {
  /** 준비 (한 번만 — 두 번째부터는 첫 결과). 실패하면 그 까닭 */
  prepare(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 띄울 명세 — 준비가 끝난 뒤에만. 띄우지 않을 까닭(준비 안 됨·해시가 다름)이면 refuse */
  spec(mode: ServerHelperMode, args: readonly string[]): ServerHelperSpawn | { refuse: string };
}

/** 도우미에게 넘기는 환경 변수 (.NET Framework가 시작하는 데 필요한 것만 — 화면 도우미와 같다) */
const HELPER_ENV_KEYS = ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMPUTERNAME', 'USERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];

export function serverHelperEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of HELPER_ENV_KEYS) {
    const v = src[k];
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

export interface ServerHelperLauncherOptions {
  dataDir: string;
  /** 앱 루트 (resources/serverhelper/ServerHelper.cs를 찾는다) */
  appRoot: string;
  /** 시험 이음매: 준비 대신 */
  ensure?: () => Promise<CompiledToolOutcome>;
  env?: NodeJS.ProcessEnv;
}

/** 제품의 이음매: 원본에서 컴파일(또는 해시로 재사용)하고, 띄울 때마다 해시를 견준다 */
export function createServerHelperLauncher(o: ServerHelperLauncherOptions): ServerHelperLauncher {
  let prepared: Promise<{ ok: true } | { ok: false; reason: string }> | null = null;
  let pin: FilePin | null = null;
  const ensure =
    o.ensure ??
    (() =>
      ensureCompiledTool(SERVER_HELPER_TOOL, {
        dataDir: o.dataDir,
        sourcePath: join(o.appRoot, 'resources', SERVER_HELPER_TOOL.resourceDir, SERVER_HELPER_TOOL.sourceName),
        // 확인 실행(--probe)은 하지 않는다 — 띄울 때의 READY 줄이 판과 동작을 확인하고, 실패하면 물러난다
        probe: false,
      }));
  return {
    prepare() {
      if (process.platform !== 'win32') return Promise.resolve({ ok: false as const, reason: '서버 도우미는 Windows 전용입니다' });
      prepared ??= ensure()
        .catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error), durationMs: 0 }))
        .then((r) => {
          if (!r.ok) return { ok: false as const, reason: r.reason };
          pin = r.pin;
          return { ok: true as const };
        });
      return prepared;
    },
    spec(mode, args) {
      if (!pin) return { refuse: '서버 도우미가 준비되지 않았습니다' };
      // 띄우기 바로 전에 해시를 견준다 (S5-21) — 다르면 그 파일로는 띄우지 않는다
      const check = checkPinned(pin);
      if (!check.ok) return { refuse: `서버 도우미 파일(${SERVER_HELPER_TOOL.exeName})이 준비할 때와 다릅니다 — ${check.reason}` };
      return { file: pin.path, args: [mode, ...args], env: serverHelperEnv(o.env) };
    },
  };
}

/**
 * 도우미 표준 출력을 줄로 나눈다 (ASCII, \n). 한 줄이 상한을 넘으면 onOverflow 한 번 뒤 더 읽지 않는다 — 부르는 쪽이 도우미를 끝낸다
 */
export function readHelperLines(stream: Readable, onLine: (line: string) => void, onOverflow: () => void, maxLine = SERVER_HELPER_MAX_LINE): void {
  let pending = '';
  let dead = false;
  stream.setEncoding('latin1');
  stream.on('data', (chunk: string) => {
    if (dead) return;
    pending += chunk;
    for (let nl = pending.indexOf('\n'); nl >= 0 && !dead; nl = pending.indexOf('\n')) {
      const line = pending.slice(0, nl).replace(/\r$/, '');
      pending = pending.slice(nl + 1);
      if (line.length > maxLine) {
        dead = true;
        onOverflow();
        return;
      }
      onLine(line);
    }
    if (pending.length > maxLine) {
      dead = true;
      pending = '';
      onOverflow();
    }
  });
  stream.on('error', () => undefined);
}

/** p가 ms 안에 끝나면 true — 타이머는 남기지 않는다 */
export async function settles(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** 도우미 표준 오류의 첫 줄 (기록용, 200자) — 바이트·비밀 값은 도우미가 쓰지 않는다 */
export function firstStderrLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  return line.trim().slice(0, 200);
}
