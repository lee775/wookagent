/**
 * X11 화면 도우미를 띄우는 이음매 (S10c, 리드 결정 S10-7) — Linux 서버. 도우미는 서버의 Node로 띄우는 스크립트(resources/desktophelper/x11Helper.mjs)이고
 * X 도구(xdotool·maim·…)를 자식으로 부른다. 곁 도우미(x11Sidecar.py)는 python3 -I -B -s로 도우미가 띄운다.
 *
 * - 시험(VITEST) 중에는 Linux 실제 화면 시험 문(process/scriptTool.ts)이 열렸을 때만 띄운다. 문 확인이 준비보다 먼저다 — 닫혀 있으면 아무것도 복사·실행하지 않는다
 * - 준비(prepare — 한 번): 도구를 정해진 시스템 폴더(/usr/local/bin·/usr/bin·/bin)에서만 찾아 절대 경로로 고정한다(PATH를 보지 않는다 — 에이전트가 앞자리
 *   폴더에 둔 같은 이름의 파일을 부르지 않게). 그룹·다른 사용자가 쓸 수 있는 파일은 쓰지 않는다. 꼭 필요한 도구가 없으면 그 이름을 말하고 다시 시작할 때까지
 *   띄우지 않는다. 두 스크립트를 <dataDir>/bin에 복사해 해시를 고정한다. 시험 중이면 그 화면이 Xvfb인지 붙어 본다
 * - 띄우기(launch, 동기): 두 복사본을 다시 읽어 해시를 견준다 — 다르면 띄우지 않고 실행 환경 문제(binary_changed)를 알리고 원본에서 한 번 다시 복사한다
 *   (Windows 도우미와 같은 규칙). 환경은 작게 준다: 화면(DISPLAY·XAUTHORITY), 말(LANG), 고정 PATH, AT-SPI가 쓰는 세션 버스 주소 — 토큰·키·NODE_OPTIONS는 넘기지 않는다
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { checkPinned, type FilePin } from '../process/pinnedFile';
import { ensurePinnedScript, x11Identity, x11LaunchRefusal, x11ServerIsXvfb, X11_HELPER_SCRIPT, X11_SIDECAR_SCRIPT, type ScriptToolOutcome } from '../process/scriptTool';
import type { RunnerProblem } from '../process/types';
import type { DesktopHelperLauncher, DesktopLaunchRefusal, DesktopLaunchSpec } from './types';

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

/** 도우미가 꼭 쓰는 X 도구 (x11Helper.mjs TOOL_NAMES와 같다) — 우분투 꾸러미: xdotool · maim · x11-utils · x11-xserver-utils · xinput · xprintidle */
export const X11_TOOLS = ['xdotool', 'maim', 'xprop', 'xwininfo', 'xrandr', 'xinput', 'xprintidle', 'xdpyinfo', 'xmodmap', 'xset'] as const;
const TOOL_PACKAGE: Readonly<Record<string, string>> = {
  xdotool: 'xdotool',
  maim: 'maim',
  xprop: 'x11-utils',
  xwininfo: 'x11-utils',
  xdpyinfo: 'x11-utils',
  xrandr: 'x11-xserver-utils',
  xmodmap: 'x11-xserver-utils',
  xset: 'x11-xserver-utils',
  python3: 'python3',
  xinput: 'xinput',
  xprintidle: 'xprintidle',
};
/** 도구를 찾는 폴더 — 이 차례, 이 폴더들만 */
export const X11_TOOL_DIRS = ['/usr/local/bin', '/usr/bin', '/bin'] as const;

export const X11_HELPER_CHANGED = 'X11 화면 도우미 파일(<데이터 폴더>/bin/wook-x11-helper.mjs·wook-x11-sidecar.py)이 준비할 때와 다릅니다';

/** 정해진 폴더에서 그 이름의 실행 파일 — 그룹·다른 사용자가 쓸 수 있으면 쓰지 않는다. 없으면 null */
export function findSystemTool(name: string, dirs: readonly string[] = X11_TOOL_DIRS): string | null {
  for (const d of dirs) {
    const p = join(d, name);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      if ((st.mode & 0o111) === 0) continue;
      if ((st.mode & 0o022) !== 0) continue;
      return p;
    } catch {
      // 없다 — 다음 폴더
    }
  }
  return null;
}

/**
 * 도구 이름 → 띄울 명령 (첫 칸이 절대 경로). 빠진 도구의 이름 목록 — python3도 든다: 화면의 주인 확인(리드 결정 S10-13 SC-1)이 python으로 하므로 Linux 화면 조작에
 * 꼭 있어야 한다 (python3-xlib는 곁 도우미의 단축키·표시에만 — 없어도 된다)
 */
export function resolveX11Tools(dirs: readonly string[] = X11_TOOL_DIRS): { tools: Record<string, string[]>; missing: string[]; python3: string | null } {
  const tools: Record<string, string[]> = {};
  const missing: string[] = [];
  for (const n of X11_TOOLS) {
    const p = findSystemTool(n, dirs);
    if (p) tools[n] = [p];
    else missing.push(n);
  }
  const python3 = findSystemTool('python3', dirs);
  if (!python3) missing.push('python3');
  return { tools, missing, python3 };
}

/** 빠진 도구 → 운영자에게 보일 글 (설치할 꾸러미 이름까지) */
export function missingToolsText(missing: readonly string[]): string {
  const pkgs = [...new Set(missing.map((m) => TOOL_PACKAGE[m] ?? m))];
  return `화면 도우미에 필요한 X 도구가 없습니다: ${missing.join(', ')} — 서버 PC의 운영자가 설치해야 합니다 (sudo apt install ${pkgs.join(' ')})`;
}

/** 도우미에게 넘기는 서버 환경 변수 (AT-SPI가 세션 버스를 찾는 데 쓴다) — 그 밖은 넘기지 않는다 */
const PASS_ENV = ['HOME', 'USER', 'LOGNAME', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'AT_SPI_BUS_ADDRESS'];

export interface X11LauncherOptions {
  dataDir: string;
  /** 저장소(앱) 루트 — resources/desktophelper/의 원본 */
  appRoot: string;
  /** 도우미를 띄울 Node (서버 자신의 process.execPath) */
  nodePath: string;
  display: string;
  xauthority: string | null;
  /** server.json screen.typeWithoutA11y (리드 결정 S10-7.6) */
  typeWithoutA11y: boolean;
  log: Log;
  onProblem?: (problem: RunnerProblem) => void;
  /** 시험 이음매: 환경 (기본 process.env) */
  env?: NodeJS.ProcessEnv;
  /** 시험 이음매: 도구 (기본 resolveX11Tools()) — 가짜 도구 [node, 가짜.mjs, 이름] */
  tools?: Record<string, string[]>;
  /** 시험 이음매: 곁 도우미를 띄울 명령 앞부분 (기본 [python3 절대 경로, '-I', '-B', '-s']). null이면 곁 도우미 없음 */
  sidecarCommand?: string[] | null;
  /** 시험 이음매: 화면의 주인 확인 명령 (기본 [python3, '-I', '-B', '-s', 곁 도우미 복사본, '--identity']) — 화면 번호를 붙여 부른다 */
  identityCommand?: string[];
  /** 시험 이음매: 도우미에 더할 환경 (가짜 도구의 장면 등) */
  extraEnv?: Record<string, string>;
}

export interface X11DesktopLauncher extends DesktopHelperLauncher {
  /** 준비를 기다린 뒤 고정한 도우미 명령 (사전 점검의 --probe가 쓴다). 쓸 수 없으면 그 까닭 */
  preparedSpec(): Promise<{ ok: true; spec: DesktopLaunchSpec } | { ok: false; reason: string }>;
}

export function createX11DesktopLauncher(o: X11LauncherOptions): X11DesktopLauncher {
  return new X11Launcher(o);
}

class X11Launcher implements X11DesktopLauncher {
  private readonly o: X11LauncherOptions;
  private prepared: Promise<void> | null = null;
  private helperPin: FilePin | null = null;
  private sidecarPin: FilePin | null = null;
  private tools: Record<string, string[]> | null = null;
  private sidecarCmd: string[] | null = null;
  private dead: string | null = null;
  private recopying = false;
  private recopyUsed = false;

  constructor(o: X11LauncherOptions) {
    this.o = o;
  }

  private env(): NodeJS.ProcessEnv {
    return this.o.env ?? process.env;
  }

  prepare(): Promise<void> {
    // 문 확인이 준비보다 먼저다 — 시험 중이면 아무것도 복사·실행하지 않는다
    const refusal = x11LaunchRefusal(this.env(), this.o.display);
    if (refusal) {
      this.dead = refusal;
      return Promise.resolve();
    }
    if (!this.prepared) {
      this.prepared = (async () => {
        const resolved = this.o.tools ? { tools: this.o.tools, missing: X11_TOOLS.filter((n) => !this.o.tools![n]), python3: null } : resolveX11Tools();
        if (resolved.missing.length > 0) {
          this.dead = missingToolsText(resolved.missing);
          this.o.log('warn', this.dead);
          return;
        }
        this.tools = resolved.tools;
        if (this.o.sidecarCommand !== undefined) this.sidecarCmd = this.o.sidecarCommand;
        else this.sidecarCmd = resolved.python3 ? [resolved.python3, '-I', '-B', '-s'] : null;
        const pinned = await this.pinBoth(false);
        if (!pinned.ok) {
          this.dead = pinned.reason;
          this.o.log('warn', this.dead);
          return;
        }
        // 시험 중에는 그 화면이 시험이 띄운 Xvfb인지 본다 (리드 결정 S10-7.11·S10-13 SC-2) — 먼저 주인 확인(연결만 하고 아무것도 보내지 않는다)으로 그 화면의 X 서버
        // PID가 시험이 적어 둔 것인지, 그다음에야 붙어서(쿠키를 보낸다) Xvfb인지. 도우미도 시작할 때와 무장할 때마다 한 번 더 본다
        if (this.env().VITEST && !this.o.tools) {
          const idCmd = this.identityCmd();
          const id = idCmd ? await x11Identity({ command: idCmd, display: this.o.display }) : ({ ok: false, detail: 'unverified' } as const);
          const want = Number(this.env().WOOK_REAL_DESKTOP_XPID);
          if (!id.ok || id.pid !== want) {
            this.dead = `시험 중에는 시험이 띄운 Xvfb에만 붙습니다 — ${this.o.display}의 주인이 그 Xvfb가 아닙니다 (${id.ok ? `PID ${id.pid}` : id.detail})`;
            return;
          }
          const xinput = this.tools.xinput?.[0];
          const ok = xinput ? await x11ServerIsXvfb({ xinput, display: this.o.display, xauthority: this.o.xauthority }) : false;
          if (!ok) {
            this.dead = `시험 중에는 Xvfb 화면에만 붙습니다 — ${this.o.display}의 X 서버가 Xvfb가 아니거나 붙지 못했습니다`;
            return;
          }
        }
        this.o.log('info', `X11 화면 도우미 준비: ${this.helperPin?.path} (화면 ${this.o.display}${this.sidecarCmd ? '' : ', 곁 도우미 없음'})`);
      })();
    }
    return this.prepared;
  }

  private async pinBoth(force: boolean): Promise<{ ok: true } | { ok: false; reason: string }> {
    const dir = join(this.o.appRoot, 'resources', 'desktophelper');
    const helper: ScriptToolOutcome = await ensurePinnedScript(X11_HELPER_SCRIPT, { dataDir: this.o.dataDir, sourcePath: join(dir, X11_HELPER_SCRIPT.sourceName), force });
    if (!helper.ok) return helper;
    this.helperPin = helper.pin;
    if (this.sidecarCmd) {
      const side = await ensurePinnedScript(X11_SIDECAR_SCRIPT, { dataDir: this.o.dataDir, sourcePath: join(dir, X11_SIDECAR_SCRIPT.sourceName), force });
      if (!side.ok) return side;
      this.sidecarPin = side.pin;
    }
    return { ok: true };
  }

  /** 화면의 주인 확인 명령 (곁 도우미 복사본의 --identity) */
  private identityCmd(): string[] | null {
    if (this.o.identityCommand) return this.o.identityCommand;
    return this.sidecarCmd && this.sidecarPin ? [...this.sidecarCmd, this.sidecarPin.path, '--identity'] : null;
  }

  async preparedSpec(): Promise<{ ok: true; spec: DesktopLaunchSpec } | { ok: false; reason: string }> {
    await this.prepare();
    const spec = this.launch();
    return 'refuse' in spec ? { ok: false, reason: spec.refuse } : { ok: true, spec };
  }

  launch(): DesktopLaunchSpec | DesktopLaunchRefusal {
    const refusal = x11LaunchRefusal(this.env(), this.o.display);
    if (refusal) return { refuse: refusal };
    if (this.dead) return { refuse: this.dead };
    if (this.recopying) return { refuse: `${X11_HELPER_CHANGED} — 원본에서 다시 복사하는 중이라 띄우지 않았습니다` };
    if (!this.helperPin || !this.tools) return { refuse: '화면 도우미가 아직 준비되지 않았습니다' };
    for (const pin of [this.helperPin, this.sidecarPin]) {
      if (!pin) continue;
      const check = checkPinned(pin);
      if (!check.ok) return { refuse: this.pinMismatch(check.reason) };
    }
    return { file: this.o.nodePath, args: [this.helperPin.path], env: this.helperEnv() };
  }

  private helperEnv(): Record<string, string> {
    const src = this.env();
    const out: Record<string, string> = { DISPLAY: this.o.display, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/local/bin:/usr/bin:/bin' };
    if (this.o.xauthority) out.XAUTHORITY = this.o.xauthority;
    for (const k of PASS_ENV) {
      const v = src[k];
      if (typeof v === 'string' && v) out[k] = v;
    }
    out.WOOK_X11_TOOLS = JSON.stringify(this.tools);
    if (this.sidecarCmd && this.sidecarPin) out.WOOK_X11_SIDECAR = JSON.stringify([...this.sidecarCmd, this.sidecarPin.path]);
    const idCmd = this.identityCmd();
    if (idCmd) out.WOOK_X11_IDENTITY = JSON.stringify(idCmd);
    if (src.VITEST) {
      out.WOOK_X11_REQUIRE_XVFB = '1';
      if (/^\d{1,10}$/.test(src.WOOK_REAL_DESKTOP_XPID ?? '')) out.WOOK_X11_REQUIRE_XPID = src.WOOK_REAL_DESKTOP_XPID!;
    }
    if (this.o.typeWithoutA11y) out.WOOK_X11_TYPE_UNKNOWN = '1';
    return { ...out, ...(this.o.extraEnv ?? {}) };
  }

  /** 해시가 다름: 처음이면 알리고 원본에서 한 번 다시 복사한다. 그 한 번을 썼으면 다시 시작할 때까지 띄우지 않는다 */
  private pinMismatch(reason: string): string {
    if (this.recopyUsed) {
      this.dead = `${X11_HELPER_CHANGED} (${reason}) — 한 번 다시 복사한 뒤에도 또 달라 다시 시작할 때까지 화면 도우미를 띄우지 않습니다`;
      this.raise(this.dead);
      return this.dead;
    }
    this.recopyUsed = true;
    this.recopying = true;
    this.raise(`${X11_HELPER_CHANGED} (${reason}) — 누군가 앱 데이터 폴더의 파일을 바꿨을 수 있습니다. 그 파일로는 띄우지 않고 원본에서 한 번 다시 복사합니다`);
    void this.pinBoth(true)
      .catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }))
      .then((r) => {
        this.recopying = false;
        if (r.ok) {
          this.o.log('info', 'X11 화면 도우미를 원본에서 다시 복사해 다시 씁니다');
          return;
        }
        this.dead = `${X11_HELPER_CHANGED} — 원본에서 다시 복사하지 못해(${r.reason}) 다시 시작할 때까지 화면 도우미를 띄우지 않습니다`;
        this.raise(this.dead);
      });
    return `${X11_HELPER_CHANGED} (${reason}) — 이 파일로는 띄우지 않았습니다`;
  }

  private raise(text: string): void {
    this.o.log('error', `실행 환경 문제: ${text}`);
    try {
      this.o.onProblem?.({ kind: 'binary_changed', text });
    } catch (err) {
      this.o.log('error', '화면 도우미 문제 알림 처리 오류', err);
    }
  }
}

/**
 * 사전 점검용 `x11Helper.mjs --probe` (창·입력·캡처 없이 화면에 붙어 보기만 한다). 띄우는 이음매가 고정한 명령을 쓴다. 시험 중(문 닫힘)이면 띄우지 않는다
 */
export async function probeX11Helper(o: { launcher: Pick<X11DesktopLauncher, 'preparedSpec'>; timeoutMs?: number }): Promise<
  { ok: true; reply: Record<string, unknown> } | { ok: false; reason: string }
> {
  const r = await o.launcher.preparedSpec();
  if (!r.ok) return { ok: false, reason: r.reason };
  const { execFile } = await import('node:child_process');
  return await new Promise((resolve) => {
    execFile(r.spec.file, [...r.spec.args, '--probe'], { env: r.spec.env, timeout: o.timeoutMs ?? 20_000, encoding: 'utf8' }, (err, stdout) => {
      const lineText = String(stdout ?? '')
        .split('\n')
        .find((l) => l.startsWith('{"__wookDesktop":"probe"'));
      if (!lineText) {
        resolve({ ok: false, reason: `X11 화면 도우미 확인 응답이 없습니다${err ? ` (${err.message.split('\n')[0]})` : ''}` });
        return;
      }
      try {
        const reply = JSON.parse(lineText) as Record<string, unknown>;
        resolve(reply.ok === true ? { ok: true, reply } : { ok: false, reason: `X11 화면 도우미 확인 실패: ${String(reply.error ?? '사유 없음')}` });
      } catch {
        resolve({ ok: false, reason: 'X11 화면 도우미 확인 응답을 알아볼 수 없습니다' });
      }
    });
  });
}
