/**
 * 실제 화면 도우미(WookDesktopHelper.exe)를 띄우는 이음매 (리드 결정 S6-4·S6-5·S6-13).
 *
 * - 시험(VITEST) 중에는 실제 화면 시험 문(win32 + WOOK_REAL_DESKTOP=1 + WOOK_REAL_DESKTOP_HOST = 이 PC 이름)이 열렸을 때만 띄운다. 그 확인을
 *   컴파일보다 먼저 한다 — 문이 닫혀 있으면 컴파일도 하지 않는다. 에이전트는 이 문을 열지 않는다 (S6-15: 대표가 쓰는 PC)
 * - Windows 밖이면 쓸 수 없다 (서버 모드의 Windows만 — 리드 결정 S6-11. 모드 판정은 S6c의 몫)
 * - 준비(prepare): 원본에서 컴파일하거나 재사용한다 — 한 번만. 실패(csc 없음·컴파일 실패)면 다시 시작할 때까지 띄우지 않는다
 * - 띄우기(launch, 동기): 실행 파일을 다시 읽어 준비할 때의 해시와 견준다 (pinnedFile.ts, S5-21). 다르면 띄우지 않고 실행 환경 문제
 *   (binary_changed)를 알리고 원본에서 한 번 다시 컴파일한다. 그동안과, 그 한 번을 쓴 뒤 또 다르면 다시 시작할 때까지 띄우지 않는다
 * - 환경: 도우미는 프로세스를 띄우지 않으므로 작은 환경만 준다 (토큰·키를 넘기지 않는다). 화면 폴더·정책은 클라이언트가 더한다
 */
import {
  ensureCompiledTool,
  DESKTOP_HELPER_TOOL,
  probeCompiledTool,
  realDesktopGateOpen,
  toolLaunchRefusal,
  type CompiledToolOutcome,
} from '../process/compiledTool';
import { checkPinned, type FilePin } from '../process/pinnedFile';
import type { RunnerProblem } from '../process/types';
import type { DesktopHelperLauncher, DesktopLaunchRefusal, DesktopLaunchSpec } from './types';

export { realDesktopGateOpen };

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

export interface RealDesktopLauncherOptions {
  /** 앱 데이터 폴더 (실행 파일은 <dataDir>/bin) */
  dataDir: string;
  /** DesktopHelper.cs 경로 (없으면 resources/desktophelper/DesktopHelper.cs를 찾는다) */
  sourcePath?: string;
  log: Log;
  /** 실행 파일 해시가 달라지는 등 실행 환경 문제가 생길 때마다 (같은 글을 갱신하는 알림·활동 기록용) */
  onProblem?: (problem: RunnerProblem) => void;
  /** 시험 이음매: 환경 (기본 process.env) */
  env?: NodeJS.ProcessEnv;
  /**
   * 시험 이음매: 준비(컴파일·재사용) 대신 (force = 해시가 달라 다시 컴파일). 해시 확인 시험이 도우미 실행 파일 대신 아무 파일이나 견주게 한다 —
   * 그 시험은 launch()의 명세를 띄우지 않는다
   */
  ensure?: (force: boolean) => Promise<CompiledToolOutcome>;
}

/** 실행 파일 바꿔치기의 사실 글 */
export const DESKTOP_BINARY_CHANGED = '화면 도우미 파일(WookDesktopHelper.exe)이 준비할 때와 다릅니다';

/** 도우미에게 넘기는 환경 변수 (.NET Framework가 시작하는 데 필요한 것만) */
const HELPER_ENV_KEYS = ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMPUTERNAME', 'USERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];

/** 지금 이 환경에서 실제 도우미를 띄우지 않는 까닭 (Windows 밖·시험 중 문 닫힘). 띄워도 되면 null */
export function realDesktopRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform !== 'win32') return '화면 조작은 Windows 서버에서만 씁니다 (이 OS에는 화면 도우미가 없습니다)';
  return toolLaunchRefusal(DESKTOP_HELPER_TOOL, env);
}

/** 실제 도우미 이음매 — 띄우기와, 사전 점검이 쓰는 '준비가 고정한 실행 파일' */
export interface RealDesktopLauncher extends DesktopHelperLauncher {
  /**
   * 준비(prepare — 한 번만)를 기다린 뒤 그 준비가 고정한 실행 파일과 해시. 사전 점검(probeRealDesktopHelper)은 따로 준비하지 않고 이것을 쓴다 — 둘이 따로
   * 컴파일하면 한쪽의 해시가 덮인 파일의 것이 된다 (리드 결정 S6-21 H3). 쓸 수 없으면(문 닫힘·준비 실패·다시 컴파일하는 중) 그 까닭
   */
  preparedPin(): Promise<{ ok: true; pin: FilePin } | { ok: false; reason: string }>;
}

export function createRealDesktopLauncher(o: RealDesktopLauncherOptions): RealDesktopLauncher {
  return new RealDesktopLauncherImpl(o);
}

class RealDesktopLauncherImpl implements RealDesktopLauncher {
  private readonly o: RealDesktopLauncherOptions;
  private prepared: Promise<void> | null = null;
  private pin: FilePin | null = null;
  /** 띄우지 않을 까닭 (다시 시작할 때까지 그대로인 것) */
  private dead: string | null = null;
  /** 해시가 달라져 다시 컴파일하는 중 */
  private reensuring = false;
  private reensureUsed = false;

  constructor(o: RealDesktopLauncherOptions) {
    this.o = o;
  }

  prepare(): Promise<void> {
    // 문 확인이 컴파일보다 먼저다 — 시험 중이면 csc도 부르지 않는다
    const refusal = realDesktopRefusal(this.env());
    if (refusal) {
      this.dead = refusal;
      return Promise.resolve();
    }
    if (!this.prepared) {
      this.prepared = (async () => {
        const r = await this.ensure(false);
        if (r.ok) {
          this.pin = r.pin;
          this.o.log('info', `화면 도우미 준비: ${r.exePath} — ${r.detail}`);
          return;
        }
        // csc 없음·컴파일 실패·확인 실패: 곧바로 쓸 수 없다 (다시 시작할 때까지)
        this.dead = `화면 도우미를 준비하지 못했습니다: ${r.reason}`;
        this.o.log('warn', this.dead);
      })();
    }
    return this.prepared;
  }

  async preparedPin(): Promise<{ ok: true; pin: FilePin } | { ok: false; reason: string }> {
    await this.prepare();
    const refusal = realDesktopRefusal(this.env());
    if (refusal) return { ok: false, reason: refusal };
    if (this.dead) return { ok: false, reason: this.dead };
    if (this.reensuring) return { ok: false, reason: `${DESKTOP_BINARY_CHANGED} — 원본에서 다시 컴파일하는 중입니다` };
    if (!this.pin) return { ok: false, reason: '화면 도우미가 아직 준비되지 않았습니다' };
    return { ok: true, pin: this.pin };
  }

  launch(): DesktopLaunchSpec | DesktopLaunchRefusal {
    const refusal = realDesktopRefusal(this.env());
    if (refusal) return { refuse: refusal };
    if (this.dead) return { refuse: this.dead };
    if (this.reensuring) return { refuse: `${DESKTOP_BINARY_CHANGED} — 원본에서 다시 컴파일하는 중이라 띄우지 않았습니다` };
    if (!this.pin) return { refuse: '화면 도우미가 아직 준비되지 않았습니다' };
    const check = checkPinned(this.pin);
    if (!check.ok) return { refuse: this.pinMismatch(check.reason) };
    return { file: this.pin.path, args: [], env: this.helperEnv() };
  }

  /** 해시가 다름: 처음이면 알리고 한 번 다시 컴파일한다. 그 한 번을 썼으면 다시 시작할 때까지 띄우지 않는다 */
  private pinMismatch(reason: string): string {
    if (this.reensureUsed) {
      this.dead = `${DESKTOP_BINARY_CHANGED} (${reason}) — 한 번 다시 컴파일한 뒤에도 또 달라 다시 시작할 때까지 화면 도우미를 띄우지 않습니다`;
      this.raise(this.dead);
      return this.dead;
    }
    this.reensureUsed = true;
    this.reensuring = true;
    this.raise(`${DESKTOP_BINARY_CHANGED} (${reason}) — 누군가 앱 데이터 폴더의 실행 파일을 바꿨을 수 있습니다. 그 파일로는 띄우지 않고 원본에서 한 번 다시 컴파일합니다`);
    void this.ensure(true)
      .catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err), durationMs: 0 }))
      .then((r) => {
        this.reensuring = false;
        if (r.ok) {
          this.pin = r.pin;
          this.o.log('info', `화면 도우미를 원본에서 다시 컴파일해 다시 씁니다: ${r.exePath}`);
          return;
        }
        this.dead = `${DESKTOP_BINARY_CHANGED} — 원본에서 다시 컴파일하지 못해(${r.reason}) 다시 시작할 때까지 화면 도우미를 띄우지 않습니다`;
        this.raise(this.dead);
      });
    return `${DESKTOP_BINARY_CHANGED} (${reason}) — 이 파일로는 띄우지 않았습니다`;
  }

  private raise(text: string): void {
    this.o.log('error', `실행 환경 문제: ${text}`);
    try {
      this.o.onProblem?.({ kind: 'binary_changed', text });
    } catch (err) {
      this.o.log('error', '화면 도우미 문제 알림 처리 오류', err);
    }
  }

  private ensure(force: boolean): Promise<CompiledToolOutcome> {
    if (this.o.ensure) return this.o.ensure(force);
    return ensureCompiledTool(DESKTOP_HELPER_TOOL, { dataDir: this.o.dataDir, sourcePath: this.o.sourcePath, force });
  }

  private env(): NodeJS.ProcessEnv {
    return this.o.env ?? process.env;
  }

  private helperEnv(): Record<string, string> {
    const src = this.env();
    const out: Record<string, string> = {};
    for (const k of HELPER_ENV_KEYS) {
      const v = src[k];
      if (typeof v === 'string' && v) out[k] = v;
    }
    return out;
  }
}

/**
 * 사전 점검용 `WookDesktopHelper.exe --probe` (리드 결정 S6-11: 준비 뒤 비동기로 한 번, 60초 기억은 부르는 쪽). 창·훅·캡처 없이 세션·잠김·모니터 수·
 * 빌드·권한만 읽는다. 시험 중(문 닫힘)·Windows 밖이면 띄우지 않고 그 까닭을 돌려준다. 실행 파일은 띄우는 이음매가 준비해 고정한 것을 쓴다 — 따로 준비하지
 * 않는다 (리드 결정 S6-21 H3). 해시가 다르면 확인하지 않고 그 까닭만 준다 — 알림과 한 번의 다시 컴파일은 다음 띄우기(launch)가 한다
 */
export async function probeRealDesktopHelper(o: { launcher: Pick<RealDesktopLauncher, 'preparedPin'>; env?: NodeJS.ProcessEnv }): Promise<
  { ok: true; reply: Record<string, unknown> } | { ok: false; reason: string }
> {
  const refusal = realDesktopRefusal(o.env ?? process.env);
  if (refusal) return { ok: false, reason: refusal };
  const r = await o.launcher.preparedPin();
  if (!r.ok) return { ok: false, reason: r.reason };
  const check = checkPinned(r.pin);
  if (!check.ok) return { ok: false, reason: `${DESKTOP_BINARY_CHANGED} (${check.reason})` };
  const probe = await probeCompiledTool(DESKTOP_HELPER_TOOL, r.pin.path);
  return probe.ok ? { ok: true, reply: probe.reply } : { ok: false, reason: probe.reason };
}
