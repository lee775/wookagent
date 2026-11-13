/**
 * 스크립트로 된 도구의 준비와 고정 (S10c, 리드 결정 S10-7.10·S10-7.11) — X11 화면 도우미(resources/desktophelper/x11Helper.mjs, 서버의 Node가 띄운다)와 그 곁
 * 도우미(x11Sidecar.py, python3 -I -B -s). 컴파일하는 도구(compiledTool.ts)처럼 <dataDir>/bin에 복사하고 `.sha256`(두 줄: source·exe — 같은 값)을 적어 두며,
 * 띄울 때마다 복사본의 바이트 해시를 다시 본다(pinnedFile.ts checkPinned). 리소스 파일을 그 자리에서 띄우지 않는다 — 고정한 복사본만 띄운다.
 *
 * 실제 화면 시험 문 (Linux, 리드 결정 S10-7.11): 시험(VITEST) 중에는 WOOK_REAL_DESKTOP=1 · WOOK_REAL_DESKTOP_HOST = 이 PC 이름 · WOOK_REAL_DESKTOP_DISPLAY =
 * 띄울 화면 · 그 화면의 X 서버가 Xvfb일 때만 X11 화면 도우미를 띄운다. 앞의 셋은 환경만 보고(realX11GateOpen), 마지막은 그 화면에 붙어 입력 장치 이름(Xvfb
 * keyboard·Xvfb mouse)을 읽어 본다(x11ServerIsXvfb — 그 연결로 실제로 닿는 X 서버를 본다). 도우미도 시작할 때 한 번 더 본다(WOOK_X11_REQUIRE_XVFB).
 * 그래서 시험은 사람이 쓰는 화면을 움직일 수 없다.
 *
 * 런타임 import는 node: 모듈만 (compiledTool.ts와 같은 규칙).
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { formatToolHashFile, parseToolHashFile } from './compiledTool';
import type { FilePin } from './pinnedFile';

export interface ScriptToolSpec {
  /** 사유 글에 쓰는 이름 */
  readonly label: string;
  /** resources/<resourceDir>/<sourceName> */
  readonly resourceDir: string;
  readonly sourceName: string;
  /** <dataDir>/bin 안의 복사본 이름과 해시 파일 이름 */
  readonly installName: string;
  readonly hashName: string;
}

export const X11_HELPER_SCRIPT: ScriptToolSpec = {
  label: 'X11 화면 도우미',
  resourceDir: 'desktophelper',
  sourceName: 'x11Helper.mjs',
  installName: 'wook-x11-helper.mjs',
  hashName: 'wook-x11-helper.sha256',
};

export const X11_SIDECAR_SCRIPT: ScriptToolSpec = {
  label: 'X11 곁 도우미',
  resourceDir: 'desktophelper',
  sourceName: 'x11Sidecar.py',
  installName: 'wook-x11-sidecar.py',
  hashName: 'wook-x11-sidecar.sha256',
};

export function scriptPaths(spec: ScriptToolSpec, dataDir: string): { binDir: string; path: string; hashPath: string } {
  const binDir = join(dataDir, 'bin');
  return { binDir, path: join(binDir, spec.installName), hashPath: join(binDir, spec.hashName) };
}

export type ScriptToolOutcome = { ok: true; pin: FilePin; copied: boolean; sourcePath: string } | { ok: false; reason: string };

/**
 * 원본 스크립트를 <dataDir>/bin에 복사해 두고 그 바이트 해시를 고정한다. 복사본과 해시 파일이 원본과 같으면 그대로 쓴다(force면 다시 쓴다). 쓰기는 임시 파일 뒤
 * 이름 바꾸기 — 반쯤 쓴 파일을 띄우지 않는다. 던지지 않는다
 */
export async function ensurePinnedScript(spec: ScriptToolSpec, o: { dataDir: string; sourcePath: string; force?: boolean }): Promise<ScriptToolOutcome> {
  let source: Buffer;
  try {
    source = await readFile(o.sourcePath);
  } catch (err) {
    return { ok: false, reason: `${spec.label} 원본(${spec.sourceName})을 읽지 못했습니다: ${o.sourcePath} (${errorText(err)})` };
  }
  const hash = createHash('sha256').update(source).digest('hex');
  const { binDir, path, hashPath } = scriptPaths(spec, o.dataDir);
  if (!o.force) {
    try {
      const [copy, stored] = await Promise.all([readFile(path), readFile(hashPath, 'utf8')]);
      const parsed = parseToolHashFile(stored);
      const copyHash = createHash('sha256').update(copy).digest('hex');
      if (parsed && parsed.source === hash && parsed.exe === hash && copyHash === hash) return { ok: true, pin: { path, sha256: hash }, copied: false, sourcePath: o.sourcePath };
    } catch {
      // 없거나 읽지 못함 — 아래에서 새로 쓴다
    }
  }
  const tmp = join(binDir, `${spec.installName}.${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    await mkdir(binDir, { recursive: true });
    await writeFile(tmp, source, { mode: 0o600 });
    await rename(tmp, path);
    await writeFile(hashPath, formatToolHashFile(hash, hash), 'utf8');
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    return { ok: false, reason: `${spec.label}를 ${binDir}에 두지 못했습니다 (${errorText(err)})` };
  }
  return { ok: true, pin: { path, sha256: hash }, copied: true, sourcePath: o.sourcePath };
}

/**
 * Linux 실제 화면 시험 문의 환경 부분 (리드 결정 S10-7.11·S10-13 SC-2): WOOK_REAL_DESKTOP=1, 이 PC 이름, 그 화면(WOOK_REAL_DESKTOP_DISPLAY), 그 화면의 X 서버 PID
 * (WOOK_REAL_DESKTOP_XPID — 시험이 띄운 Xvfb의 PID를 적어 둔다). 그 PID가 정말 그 화면의 주인(추상 이름·소켓 파일)인지와 Xvfb인지는 준비가 붙기 전에 본다
 */
export function realX11GateOpen(env: NodeJS.ProcessEnv, display: string, host: string = hostname()): boolean {
  return (
    env.WOOK_REAL_DESKTOP === '1' &&
    !!env.WOOK_REAL_DESKTOP_HOST &&
    env.WOOK_REAL_DESKTOP_HOST === host &&
    !!env.WOOK_REAL_DESKTOP_DISPLAY &&
    env.WOOK_REAL_DESKTOP_DISPLAY === display &&
    /^\d{1,10}$/.test(env.WOOK_REAL_DESKTOP_XPID ?? '')
  );
}

export const X11_TEST_REFUSAL =
  '시험 중에는 실제 X11 화면 도우미를 띄우지 않습니다 — 가짜 도우미를 쓰세요 (실제 화면 시험은 WOOK_REAL_DESKTOP·WOOK_REAL_DESKTOP_HOST·WOOK_REAL_DESKTOP_DISPLAY·WOOK_REAL_DESKTOP_XPID 문이 열리고 그 화면이 시험이 띄운 Xvfb일 때만)';

/** 화면의 주인 확인의 답 (곁 도우미 파일의 --identity — x11Sidecar.py identity) */
export type X11Identity = { ok: true; pid: number } | { ok: false; detail: string };

/**
 * 화면의 주인 확인 (리드 결정 S10-13 SC-1): python으로 그 화면의 추상 이름과 소켓 파일에 연결만 해(아무것도 보내지 않는다) 듣는 쪽의 PID·uid를 본다. 같은 프로세스이고
 * 이 사용자의 것이면 { ok, pid }. 이 기계의 화면 이름이 아니면 remote, 확인 도구가 답하지 않으면 unverified
 */
export function x11Identity(o: { command: readonly string[]; display: string; timeoutMs?: number }): Promise<X11Identity> {
  const m = /^(?:unix)?:(\d{1,5})(?:\.\d{1,3})?$/.exec(o.display);
  if (!m) return Promise.resolve({ ok: false, detail: 'remote' });
  const [file, ...args] = o.command;
  if (!file) return Promise.resolve({ ok: false, detail: 'unverified' });
  return new Promise((resolve) => {
    execFile(file, [...args, m[1]!], { env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' }, timeout: o.timeoutMs ?? 4000, encoding: 'utf8' }, (err, stdout) => {
      try {
        const v = JSON.parse(String(stdout).trim().split('\n').pop() ?? '') as { ok?: unknown; pid?: unknown; detail?: unknown };
        if (v.ok === true && typeof v.pid === 'number' && Number.isInteger(v.pid)) resolve({ ok: true, pid: v.pid });
        else resolve({ ok: false, detail: typeof v.detail === 'string' && /^[a-z]{1,16}$/.test(v.detail) ? v.detail : 'unverified' });
      } catch {
        resolve({ ok: false, detail: 'unverified' });
      }
    });
  });
}

/** 시험(VITEST) 중이고 문이 닫혔으면 그 까닭. 시험이 아니면 null (운영 서버는 이 문을 보지 않는다) */
export function x11LaunchRefusal(env: NodeJS.ProcessEnv, display: string): string | null {
  if (env.VITEST && !realX11GateOpen(env, display)) return X11_TEST_REFUSAL;
  return null;
}

/**
 * 그 화면의 X 서버가 Xvfb인지 — 그 화면에 붙어 입력 장치 이름을 읽는다(xinput list --name-only: 'Xvfb keyboard'와 'Xvfb mouse'). 입력·캡처는 하지 않는다.
 * 붙지 못하거나 모르면 false
 */
export function x11ServerIsXvfb(o: { xinput: string; display: string; xauthority: string | null; timeoutMs?: number }): Promise<boolean> {
  const env: Record<string, string> = { DISPLAY: o.display, LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' };
  if (o.xauthority) env.XAUTHORITY = o.xauthority;
  return new Promise((resolve) => {
    execFile(o.xinput, ['list', '--name-only'], { env, timeout: o.timeoutMs ?? 4000, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        resolve(false);
        return;
      }
      const names = String(stdout)
        .split('\n')
        .map((s) => s.trim());
      resolve(names.includes('Xvfb keyboard') && names.includes('Xvfb mouse'));
    });
  });
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
