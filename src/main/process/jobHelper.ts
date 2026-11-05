/**
 * taskkill 대체 방식의 작업 개체 도우미 (ARCHITECTURE.md 13장, CTL-07·11, 15.5, AC-29·36).
 *
 * 작업 개체 러너(WookJobRunner.exe)를 컴파일·실행할 수 없을 때의 대체 방식은 CLI를 Node로 직접 띄운다. 그대로면 `taskkill /T`가
 * 지금 살아 있는 부모-자식 연결만 따라가므로, 부모가 먼저 끝난 후손(셸 백그라운드 실행·스스로 분리되는 개발 서버 같은 고아)은
 * 긴급 정지·턴 종료 뒤에도 남는다. 그래서 Windows PowerShell을 하나 띄워 두고(P/Invoke는 Reflection.Emit — csc.exe가 필요 없다)
 * 러너가 띄운 프로세스를 띄우자마자 새 작업 개체(Job Object)에 넣는다. 그 뒤 생기는 후손은 부모가 먼저 끝나도 작업 개체에 남으므로
 * 종료·정리 때 작업 개체째 끝내고 비었는지 확인한다.
 *
 * - 넣기 전에 이미 생긴 후손: 넣는 순간의 프로세스 목록(Toolhelp)에서 부모 관계를 따라(생성 시각으로 PID 재사용 배제) 함께 넣는다.
 *   그 전에 부모가 끝난 후손(고아)은 찾을 수 없다 — 그래서 호출자는 띄우기 전에 ready()로 도우미를 준비해 두고, ADD가 알려 준
 *   루트 처지·목록 시각으로 넣기 전 창이 있었는지 판단한다 (늦게 넣었거나 못 넣었으면 종료 확인 불가, AC-29·36).
 * - 앱이 끝나면: Node가 자식(CLI·도우미)을 담아 둔 작업 개체가 닫히며, 그 안에 중첩된 이 작업 개체의 후손까지 함께 끝난다.
 * - 도우미가 먼저 끝나면: 실행 중인 CLI는 그대로 둔다(KILL_ON_JOB_CLOSE 없음). 그 CLI의 작업 개체는 쓸 수 없으므로 호출자는
 *   후손 종료를 확인하지 못한 것(-1)으로 다룬다. 다음 ready·adopt는 도우미를 다시 띄운다.
 * - 도우미를 띄우지 못하면(PowerShell 없음·제한 언어 모드·보안 제품 차단 등) adopt가 null — 호출자는 확인 불가로 다룬다.
 *   그 까닭은 problem()·onProblem으로 알린다 (설정 화면·긴급 알림, ENV 사전 조건).
 *
 * 프로토콜 (한 줄씩, ASCII 명령 · UTF-8 응답):
 *   시작:  READY <버전> <포인터 크기> | FAIL <사유> (제한 언어 모드면 FAIL LANGUAGE_MODE <모드>)
 *   <id> ADD <pid> <notBeforeMs> <notAfterMs>  → <id> OK <작업 개체> <루트> <함께 넣은 후손 수> <목록 시각 ms> | <id> ERR <사유>
 *                                                 루트: 1 넣음 · 0 넣기 전에 끝남(그 자식만 찾음) · 2 같은 PID를 다른 프로세스가 씀 · 3 실행 중인데 넣지 못함
 *   <id> LIST <작업 개체>                         → <id> OK <pid> <pid> ...
 *   <id> KILL <작업 개체>                         → <id> OK
 *   <id> CLOSE <작업 개체>                        → <id> OK
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';

/** processRunner.ts 의 RunnerLog와 같은 모양 */
type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

export interface JobHandle {
  readonly id: string;
  /**
   * 넣을 때 띄운 프로세스(루트)의 처지: in 넣음 · gone 넣기 전에 이미 끝남(부모 PID로 그 자식만 찾아 넣음) ·
   * other 같은 PID를 다른 프로세스가 씀(아무것도 넣지 않음) · denied 실행 중인데 넣지 못함
   */
  readonly root: 'in' | 'gone' | 'other' | 'denied';
  /** 넣는 순간 함께 넣은(이미 생긴) 후손 수 */
  readonly swept: number;
  /** 넣는 순간 프로세스 목록을 찍은 시각 (epoch ms). 띄운 뒤 이 시각 전에 부모가 끝난 후손은 찾지 못했다 */
  readonly scopeAt: number;
  /** 작업 개체에 지금 들어 있는 프로세스 PID. 알 수 없으면(도우미가 끝남·조회 실패) null */
  list(): Promise<number[] | null>;
  /** 작업 개체 안 프로세스를 모두 끝낸다 (요청이 받아들여졌으면 true) */
  terminate(): Promise<boolean>;
  /** 핸들을 닫는다. 안의 프로세스는 건드리지 않는다 */
  close(): void;
}

export interface JobHelper {
  /**
   * 도우미를 띄우고(이미 떠 있으면 그대로) ADD를 받을 수 있을 때까지 기다린다 (상한 timeoutMs). 준비됐으면 true, 쓸 수 없으면 false.
   * 프로세스를 띄우기 전에 부른다 — 띄우자마자 넣어야 넣기 전 창에 부모가 먼저 끝난 후손이 생기지 않는다 (AC-29·36)
   */
  ready(timeoutMs: number): Promise<boolean>;
  /** 지금 ADD를 바로 받을 수 있는지 (준비됨) */
  isReady(): boolean;
  /** 도우미를 쓸 수 없는 까닭 (띄우지 못함·더 띄우지 않음). 쓸 수 있거나 아직 띄워 보지 않았으면 null */
  problem(): string | null;
  /** 도우미를 띄우지 못할 때마다(그 까닭 글로) 부른다. 해제 함수를 돌려준다 */
  onProblem(cb: (problem: string) => void): () => void;
  /**
   * 방금 띄운 프로세스(pid)와 지금 살아 있는 그 후손을 새 작업 개체에 넣는다. window는 그 프로세스를 띄우기 직전·직후 시각(epoch ms) —
   * 같은 PID를 다른 프로세스가 쓰고 있으면 넣지 않는다(root=other). 도우미를 쓸 수 없으면 null
   */
  adopt(pid: number, window: { notBefore: number; notAfter: number }): Promise<JobHandle | null>;
  /** 도우미를 끝낸다 (작업 개체 안 프로세스는 건드리지 않는다). 다음 ready·adopt는 새로 띄운다 */
  dispose(): void;
}

const PROTOCOL_VERSION = 2;
/** PowerShell 시작 + 형식 정의 (보통 0.2~1초, 바쁜 PC·첫 실행은 더) */
const START_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** 시작 실패·뜻밖의 종료가 이만큼 되면 더 띄우지 않는다 (같은 실패를 되풀이하지 않게) */
const MAX_FAILED_STARTS = 3;
const ROOT_STATES = ['gone', 'in', 'other', 'denied'] as const;

/**
 * scriptPrefix: 테스트 이음매 — 도우미 스크립트 앞에 넣을 줄 (예: 세션을 제한 언어 모드로 바꿔 보안 정책 환경을 흉내).
 * 실제 앱은 쓰지 않는다
 */
export function createJobHelper(o: { log: Log; scriptPrefix?: string }): JobHelper {
  return new PowerShellJobHelper(o.log, o.scriptPrefix ?? '');
}

interface Instance {
  proc: ChildProcessWithoutNullStreams;
  ready: Promise<boolean>;
  /** 요청을 받을 수 있는지 (준비 전·끝난 뒤·dispose 뒤 false) */
  alive: boolean;
  /** dispose로 끝내는 중 — 이 뒤의 종료는 실패로 세지 않는다 */
  closing: boolean;
}

class PowerShellJobHelper implements JobHelper {
  private current: Instance | null = null;
  private failedStarts = 0;
  private seq = 0;
  private readonly pending = new Map<string, { inst: Instance; resolve: (reply: string | null) => void; timer: NodeJS.Timeout }>();
  /** 도우미를 쓸 수 없는 까닭 (마지막으로 띄우지 못한 까닭). 준비되면 지운다 */
  private lastProblem: string | null = null;
  private readonly problemListeners = new Set<(problem: string) => void>();

  constructor(
    private readonly log: Log,
    private readonly scriptPrefix: string,
  ) {}

  async ready(timeoutMs: number): Promise<boolean> {
    const inst = this.ensure();
    if (!inst) return false;
    if (inst.alive) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), Math.max(0, timeoutMs));
      timer.unref?.();
    });
    try {
      return await Promise.race([inst.ready, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  isReady(): boolean {
    return !!this.current && this.current.alive && !this.current.closing;
  }

  problem(): string | null {
    return this.lastProblem;
  }

  onProblem(cb: (problem: string) => void): () => void {
    this.problemListeners.add(cb);
    return () => this.problemListeners.delete(cb);
  }

  async adopt(pid: number, window: { notBefore: number; notAfter: number }): Promise<JobHandle | null> {
    const inst = this.ensure();
    if (!inst || !(await inst.ready)) return null;
    const reply = await this.request(inst, `ADD ${pid} ${Math.floor(window.notBefore)} ${Math.ceil(window.notAfter)}`);
    const m = reply === null ? null : /^OK (\S+) ([0-3]) (\d+) (\d+)$/.exec(reply);
    if (!m) {
      if (reply !== null) this.log('warn', `작업 개체 도우미가 PID ${pid}를 작업 개체에 넣지 못했습니다: ${reply}`);
      return null;
    }
    return new Handle(this, inst, m[1]!, ROOT_STATES[Number(m[2])]!, Number(m[3]), Number(m[4]));
  }

  /** 도우미를 쓸 수 없게 됐다 — 까닭을 남기고 알린다 (받는 쪽은 같은 알림을 갱신한다) */
  private noteProblem(problem: string): void {
    this.lastProblem = problem;
    this.log('warn', `작업 개체 도우미를 쓸 수 없습니다: ${problem}`);
    for (const cb of this.problemListeners) {
      try {
        cb(problem);
      } catch (err) {
        this.log('error', '작업 개체 도우미 문제 알림 처리 오류', err);
      }
    }
  }

  dispose(): void {
    const inst = this.current;
    this.current = null;
    if (!inst) return;
    inst.closing = true;
    inst.alive = false;
    this.settleAll(inst);
    try {
      inst.proc.stdin.end();
    } catch {
      // 이미 닫혔다
    }
  }

  /** 지금 쓸 도우미 (없으면 띄운다 — 준비 중이면 그것). 더 띄울 수 없으면 null */
  private ensure(): Instance | null {
    if (this.current && !this.current.closing) return this.current;
    if (process.platform !== 'win32' || this.failedStarts >= MAX_FAILED_STARTS) return null;
    try {
      this.current = this.start();
    } catch (err) {
      this.current = null;
      this.startFailed(`Windows PowerShell을 실행하지 못했습니다 (${err instanceof Error ? err.message : String(err)})`);
    }
    return this.current;
  }

  /** 띄우지 못함·준비 전 종료 (센다). 상한에 닿으면 더 띄우지 않는다는 것까지 알린다 */
  private startFailed(problem: string): void {
    this.failedStarts += 1;
    this.noteProblem(this.failedStarts >= MAX_FAILED_STARTS ? `${problem} — ${MAX_FAILED_STARTS}번 실패해 더 띄우지 않습니다 (앱을 다시 시작하면 다시 시도)` : problem);
  }

  private start(): Instance {
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir ?? 'C:\\Windows';
    const exe = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // 명령줄 길이 제한(32767자) 안에 넉넉히 들도록 주석 줄은 빼고 넘긴다
    const script = (this.scriptPrefix ? `${this.scriptPrefix}\n` : '') + HELPER_SCRIPT.split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let resolveReady!: (ok: boolean) => void;
    const ready = new Promise<boolean>((r) => (resolveReady = r));
    const proc = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const inst: Instance = { proc, ready, alive: false, closing: false };
    let readySeen = false;
    let failed = false;
    /**
     * 시작 실패·뜻밖의 종료 (한 번만). 준비 전 실패는 그 까닭을 알린다(problem). 쓰다가 끝난 것도 센다 — 계속 죽으면 더 띄우지 않는다.
     * 쓰다가 끝나면 실행 중인 CLI의 작업 개체는 잃는다 (호출자는 확인 불가로 다룬다). 다음 ready·adopt가 다시 띄운다
     */
    const fail = (why: string, extra?: unknown) => {
      if (failed || inst.closing) return;
      failed = true;
      inst.alive = false;
      if (this.current === inst) this.current = null;
      this.settleAll(inst);
      resolveReady(false);
      if (!readySeen) {
        if (extra !== undefined) this.log('warn', '작업 개체 도우미(PowerShell) 시작 실패', extra);
        this.startFailed(why);
        return;
      }
      this.failedStarts += 1;
      this.log('warn', `작업 개체 도우미(PowerShell)가 끝났습니다: ${why}`, extra);
      if (this.failedStarts >= MAX_FAILED_STARTS) this.noteProblem(`작업 개체 도우미(PowerShell)가 ${MAX_FAILED_STARTS}번 끝나 더 띄우지 않습니다 (마지막: ${why}). 앱을 다시 시작하면 다시 시도합니다`);
    };
    const timer = setTimeout(() => {
      if (readySeen) return;
      fail(`Windows PowerShell이 ${START_TIMEOUT_MS / 1000}초 안에 준비되지 않았습니다`);
      try {
        proc.kill();
      } catch {
        // 이미 끝났다
      }
    }, START_TIMEOUT_MS);
    timer.unref?.();
    let buf = '';
    let errText = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!readySeen) {
          if (line.startsWith(`READY ${PROTOCOL_VERSION} `)) {
            readySeen = true;
            clearTimeout(timer);
            if (!inst.closing) {
              inst.alive = true;
              this.lastProblem = null;
            }
            resolveReady(!inst.closing);
          } else if (line.startsWith('FAIL') || line.startsWith('READY')) {
            clearTimeout(timer);
            fail(failText(line));
          }
          continue;
        }
        this.onReply(inst, line);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      if (errText.length < 4000) errText += chunk;
    });
    proc.stdin.on('error', () => undefined); // 끝난 도우미에 쓰기 — 'exit'가 처리한다
    proc.on('error', (err) => {
      clearTimeout(timer);
      fail(`Windows PowerShell(powershell.exe)을 실행하지 못했습니다 (${err.message})`, err);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (inst.closing) {
        resolveReady(false);
        return;
      }
      const err = cleanStderr(errText);
      fail(`${readySeen ? '' : 'Windows PowerShell이 준비 전에 끝났습니다 — '}종료 코드 ${String(code)}${err ? ` (${err})` : ''}`);
    });
    // 도우미가 앱 종료를 붙잡지 않게 한다 (앱이 끝나면 Node의 작업 개체가 도우미도 끝낸다)
    proc.unref();
    for (const s of [proc.stdin, proc.stdout, proc.stderr] as unknown as { unref?: () => void }[]) s.unref?.();
    return inst;
  }

  request(inst: Instance, command: string): Promise<string | null> {
    if (!inst.alive) return Promise.resolve(null);
    const id = String(++this.seq);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.log('warn', `작업 개체 도우미가 ${REQUEST_TIMEOUT_MS}ms 안에 답하지 않았습니다: ${command}`);
          resolve(null);
        }
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { inst, resolve, timer });
      try {
        inst.proc.stdin.write(`${id} ${command}\n`);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  private onReply(inst: Instance, line: string): void {
    const sp = line.indexOf(' ');
    const id = sp < 0 ? line : line.slice(0, sp);
    const p = this.pending.get(id);
    if (!p || p.inst !== inst) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(sp < 0 ? '' : line.slice(sp + 1));
  }

  private settleAll(inst: Instance): void {
    for (const [id, p] of this.pending) {
      if (p.inst !== inst) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(null);
    }
  }
}

/** 시작 실패 줄(FAIL …·맞지 않는 READY)을 대표가 읽을 까닭 글로 */
function failText(line: string): string {
  const mode = /^FAIL LANGUAGE_MODE (\S+)/.exec(line);
  if (mode) {
    return `Windows PowerShell이 제한 언어 모드(${mode[1]})로 실행돼 작업 개체를 만들 수 없습니다 — 보안 정책(WDAC·AppLocker 등)이 .NET 호출을 막고 있습니다`;
  }
  if (line.startsWith('READY')) return `작업 개체 도우미 버전이 맞지 않습니다 (${line})`;
  return `작업 개체 도우미를 준비하지 못했습니다: ${line.replace(/^FAIL\s*/, '')}`;
}

/** PowerShell 오류 출력(CLIXML일 수 있음)을 짧은 한 줄로 */
function cleanStderr(text: string): string {
  return text
    .replace(/^#< CLIXML/, '')
    .replace(/_x000D__x000A_/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

class Handle implements JobHandle {
  private closed = false;

  constructor(
    private readonly helper: PowerShellJobHelper,
    private readonly inst: Instance,
    readonly id: string,
    readonly root: JobHandle['root'],
    readonly swept: number,
    readonly scopeAt: number,
  ) {}

  async list(): Promise<number[] | null> {
    if (this.closed) return null;
    const reply = await this.helper.request(this.inst, `LIST ${this.id}`);
    if (reply === null || !(reply === 'OK' || reply.startsWith('OK '))) return null;
    return reply
      .slice(2)
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isSafeInteger(n) && n > 0);
  }

  async terminate(): Promise<boolean> {
    if (this.closed) return false;
    return (await this.helper.request(this.inst, `KILL ${this.id}`)) === 'OK';
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.helper.request(this.inst, `CLOSE ${this.id}`);
  }
}

/**
 * Windows PowerShell 5.1 스크립트. Add-Type은 csc.exe가 필요해(작업 개체 러너 컴파일이 실패한 환경일 수 있다) P/Invoke를
 * Reflection.Emit으로 정의한다. PowerShell 변수 이름은 대소문자를 가리지 않으므로 한 글자 이름은 겹치지 않게 쓴다.
 * 구조체는 포인터 크기별 오프셋으로 직접 읽고 쓴다: PROCESSENTRY32W(64비트 568바이트·부모 PID 32 / 32비트 556·24),
 * JOBOBJECT_EXTENDED_LIMIT_INFORMATION(144 / 112, LimitFlags 16), JOBOBJECT_BASIC_PROCESS_ID_LIST(목록 8부터).
 */
const HELPER_SCRIPT = String.raw`
# 제한 언어 모드(WDAC·AppLocker 정책)에서는 아래 .NET 호출이 막힌다 — 그보다 먼저 까닭을 알리고 끝낸다
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { 'FAIL LANGUAGE_MODE ' + $ExecutionContext.SessionState.LanguageMode; exit 4 }
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$stdout = [Console]::Out
$stdin = [Console]::In
function Say([string]$text) { $stdout.WriteLine($text); $stdout.Flush() }
function Clean([string]$text) { return ($text -replace '[\r\n]+', ' ') }
try {
  $asmb = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object System.Reflection.AssemblyName 'WookJobHelper'), [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
  $typeb = $asmb.DefineDynamicModule('WookJobHelper').DefineType('WookJobNative', 'Public, Class, Sealed, Abstract')
  $dllCtor = [System.Runtime.InteropServices.DllImportAttribute].GetConstructor(@([string]))
  $sleField = [System.Runtime.InteropServices.DllImportAttribute].GetField('SetLastError')
  function Def([string]$fnName, [Type]$retType, [Type[]]$argTypes) {
    $meth = $typeb.DefineMethod($fnName, 'Public, Static, PinvokeImpl, HideBySig', $retType, $argTypes)
    $meth.SetCustomAttribute((New-Object System.Reflection.Emit.CustomAttributeBuilder($dllCtor, [object[]]@('kernel32.dll'), [System.Reflection.FieldInfo[]]@($sleField), [object[]]@($true))))
  }
  Def 'CreateJobObjectW' ([IntPtr]) @([IntPtr], [IntPtr])
  Def 'SetInformationJobObject' ([bool]) @([IntPtr], [Int32], [IntPtr], [UInt32])
  Def 'AssignProcessToJobObject' ([bool]) @([IntPtr], [IntPtr])
  Def 'TerminateJobObject' ([bool]) @([IntPtr], [UInt32])
  Def 'QueryInformationJobObject' ([bool]) @([IntPtr], [Int32], [IntPtr], [UInt32], [IntPtr])
  Def 'OpenProcess' ([IntPtr]) @([UInt32], [bool], [UInt32])
  Def 'CloseHandle' ([bool]) @([IntPtr])
  Def 'GetProcessTimes' ([bool]) @([IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr])
  Def 'GetExitCodeProcess' ([bool]) @([IntPtr], [IntPtr])
  Def 'CreateToolhelp32Snapshot' ([IntPtr]) @([UInt32], [UInt32])
  Def 'Process32FirstW' ([bool]) @([IntPtr], [IntPtr])
  Def 'Process32NextW' ([bool]) @([IntPtr], [IntPtr])
  $Native = $typeb.CreateType()
} catch {
  Say ('FAIL ' + (Clean $_.Exception.Message))
  exit 3
}
$Mar = [System.Runtime.InteropServices.Marshal]
$ptrSize = [IntPtr]::Size
$jobTable = @{}
$jobSeq = 0
$timeBuf = $Mar::AllocHGlobal(32)
# PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION
$openAccess = [UInt32]0x1101
# 띄운 시각과 프로세스 생성 시각의 차이 허용 (ms). 생성 시각은 시계 틱 단위로 찍혀 실제보다 조금 이르다 — 이보다 벗어나면 다른 프로세스다 (PID 재사용)
$skew = 50

function LastErr() { return $Mar::GetLastWin32Error() }
function NowMs() { return [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

# 열린 프로세스의 생성 시각 (epoch ms). 읽지 못하면 -1
function CreatedMs([IntPtr]$hproc) {
  if (-not $Native::GetProcessTimes($hproc, $timeBuf, [IntPtr]::Add($timeBuf, 8), [IntPtr]::Add($timeBuf, 16), [IntPtr]::Add($timeBuf, 24))) { return [long]-1 }
  return [long][Math]::Truncate($Mar::ReadInt64($timeBuf) / 10000) - [long]11644473600000
}

# 열린 프로세스가 아직 실행 중인지 (STILL_ACTIVE). 읽지 못하면 실행 중으로 본다
function Running([IntPtr]$hproc) {
  if (-not $Native::GetExitCodeProcess($hproc, $timeBuf)) { return $true }
  return ($Mar::ReadInt32($timeBuf) -eq 259)
}

# 지금 프로세스 목록 (Toolhelp): pid -> 부모 pid
function ProcessTable() {
  $table = @{}
  $snap = $Native::CreateToolhelp32Snapshot([UInt32]2, [UInt32]0)
  if ($snap -eq [IntPtr]::Zero -or $snap -eq [IntPtr](-1)) { return $table }
  $entrySize = if ($ptrSize -eq 8) { 568 } else { 556 }
  $parentAt = if ($ptrSize -eq 8) { 32 } else { 24 }
  $entry = $Mar::AllocHGlobal($entrySize)
  try {
    $Mar::WriteInt32($entry, 0, $entrySize)
    $more = $Native::Process32FirstW($snap, $entry)
    while ($more) {
      $table[[long]$Mar::ReadInt32($entry, 8)] = [long]$Mar::ReadInt32($entry, $parentAt)
      $more = $Native::Process32NextW($snap, $entry)
    }
  } finally {
    $Mar::FreeHGlobal($entry)
    [void]$Native::CloseHandle($snap)
  }
  return $table
}

function NewJob() {
  $hjob = $Native::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)
  if ($hjob -eq [IntPtr]::Zero) { throw ('작업 개체를 만들지 못했습니다 (' + (LastErr) + ')') }
  # 후손이 죽을 때 오류 보고 창으로 멈춘 채 남지 않게 (DIE_ON_UNHANDLED_EXCEPTION, 작업 개체 러너와 같다)
  $limSize = if ($ptrSize -eq 8) { 144 } else { 112 }
  $lim = $Mar::AllocHGlobal($limSize)
  try {
    for ($off = 0; $off -lt $limSize; $off += 4) { $Mar::WriteInt32($lim, $off, 0) }
    $Mar::WriteInt32($lim, 16, 0x400)
    [void]$Native::SetInformationJobObject($hjob, 9, $lim, [UInt32]$limSize)
  } finally {
    $Mar::FreeHGlobal($lim)
  }
  return $hjob
}

function AddProcess([long]$rootPid, [long]$notBefore, [long]$notAfter) {
  $hjob = NewJob
  $script:jobSeq++
  $jobId = [string]$script:jobSeq
  $jobTable[$jobId] = $hjob
  # 루트: 1 넣음 / 0 넣기 전에 끝남(그 자식만 찾는다) / 2 같은 PID를 다른 프로세스가 씀 / 3 실행 중인데 넣지 못함
  $rootState = 0
  $known = @{}
  $hroot = $Native::OpenProcess($openAccess, $false, [UInt32]$rootPid)
  if ($hroot -ne [IntPtr]::Zero) {
    try {
      $made = CreatedMs $hroot
      if ($made -ge 0 -and ($made -lt $notBefore - $skew -or $made -gt $notAfter + $skew)) {
        # 같은 PID를 다른 프로세스가 쓰고 있다 (띄운 프로세스는 이미 끝났다) — 넣지도, 그 후손을 찾지도 않는다
        return ('OK ' + $jobId + ' 2 0 ' + (NowMs))
      }
      if ($Native::AssignProcessToJobObject($hjob, $hroot)) { $rootState = 1 }
      elseif (Running $hroot) { $rootState = 3 }
      $known[$rootPid] = $(if ($made -ge 0) { $made } else { $notBefore - $skew })
    } finally {
      [void]$Native::CloseHandle($hroot)
    }
  } else {
    # 이미 끝났다 — 띄운 뒤에 생긴 그 자식만 찾는다 (띄우기 전부터 있던 남의 프로세스는 생성 시각으로 뺀다)
    $known[$rootPid] = $notBefore - $skew
  }
  # 넣기 전에 이미 생긴 후손도 넣는다: 부모가 아는 프로세스이고 부모보다 늦게 생긴 것 (PID 재사용 배제).
  # 이 목록을 찍기 전에 부모가 끝난 후손은 찾을 수 없다 — 찍은 시각을 알려 호출자가 넣기 전 창을 판단한다
  $swept = 0
  $scopeAt = NowMs
  $table = ProcessTable
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($row in @($table.GetEnumerator())) {
      $childPid = [long]$row.Key
      $parentPid = [long]$row.Value
      if ($childPid -eq $parentPid -or $known.ContainsKey($childPid) -or -not $known.ContainsKey($parentPid)) { continue }
      $hchild = $Native::OpenProcess($openAccess, $false, [UInt32]$childPid)
      if ($hchild -eq [IntPtr]::Zero) { continue }
      try {
        $made = CreatedMs $hchild
        if ($made -lt 0 -or $made -lt $known[$parentPid]) { continue }
        if ($Native::AssignProcessToJobObject($hjob, $hchild)) { $swept++ }
        $known[$childPid] = $made
        $grew = $true
      } finally {
        [void]$Native::CloseHandle($hchild)
      }
    }
  }
  return ('OK ' + $jobId + ' ' + $rootState + ' ' + $swept + ' ' + $scopeAt)
}

function ListJob([string]$jobId) {
  $hjob = $jobTable[$jobId]
  if ($null -eq $hjob) { throw '모르는 작업 개체입니다' }
  $cap = 256
  for ($try = 0; $try -lt 8; $try++) {
    $bufSize = 8 + $cap * $ptrSize
    $list = $Mar::AllocHGlobal($bufSize)
    try {
      $Mar::WriteInt64($list, 0, [long]0)
      $okq = $Native::QueryInformationJobObject($hjob, 3, $list, [UInt32]$bufSize, [IntPtr]::Zero)
      $code = LastErr
      $assignedN = $Mar::ReadInt32($list, 0)
      $listed = $Mar::ReadInt32($list, 4)
      # 실패해도 버퍼가 작아서(ERROR_MORE_DATA)면 전체 수가 채워져 있다 — 늘려 다시
      if (-not $okq -and $assignedN -le $cap) { throw ('작업 개체 목록을 읽지 못했습니다 (' + $code + ')') }
      if ($okq -and $listed -ge $assignedN) {
        $ids = New-Object System.Collections.Generic.List[string]
        for ($n2 = 0; $n2 -lt $listed; $n2++) { $ids.Add([string]$Mar::ReadIntPtr($list, 8 + $n2 * $ptrSize).ToInt64()) }
        return ('OK ' + ($ids -join ' ')).TrimEnd()
      }
      $cap = [Math]::Max($cap * 2, $assignedN + 64)
    } finally {
      $Mar::FreeHGlobal($list)
    }
  }
  throw '작업 개체 목록이 너무 깁니다'
}

# 첫 ADD가 함수·P/Invoke 첫 실행 준비(약 0.1초)로 늦어지면 그만큼 넣기 전 창이 길어진다 — 준비를 알리기 전에 같은 길을 한 번 돈다.
# PID 0과 먼 미래 시각이라 아무 프로세스도 넣지 않는다 (부모 PID가 0인 시스템 프로세스는 열리지 않거나 생성 시각이 그보다 이르다)
try {
  $warm = AddProcess ([long]0) ([long]4000000000000000) ([long]4000000000000000)
  $warmId = $warm.Split(' ')[1]
  [void]$Native::CloseHandle($jobTable[$warmId])
  $jobTable.Remove($warmId)
  $hself = $Native::OpenProcess($openAccess, $false, [UInt32]$PID)
  if ($hself -ne [IntPtr]::Zero) {
    [void](CreatedMs $hself)
    [void](Running $hself)
    [void]$Native::CloseHandle($hself)
  }
} catch {
}
Say ('READY 2 ' + $ptrSize)
while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split(' ')
  $reqId = $parts[0]
  try {
    $reply = switch ($parts[1]) {
      'ADD' { AddProcess ([long]$parts[2]) ([long]$parts[3]) ([long]$parts[4]) }
      'LIST' { ListJob $parts[2] }
      'KILL' {
        $hjob = $jobTable[$parts[2]]
        if ($null -eq $hjob) { throw '모르는 작업 개체입니다' }
        if (-not $Native::TerminateJobObject($hjob, [UInt32]1)) { throw ('작업 개체를 끝내지 못했습니다 (' + (LastErr) + ')') }
        'OK'
      }
      'CLOSE' {
        $hjob = $jobTable[$parts[2]]
        if ($null -ne $hjob) {
          [void]$Native::CloseHandle($hjob)
          $jobTable.Remove($parts[2])
        }
        'OK'
      }
      default { throw ('모르는 명령: ' + $parts[1]) }
    }
    Say ($reqId + ' ' + $reply)
  } catch {
    Say ($reqId + ' ERR ' + (Clean $_.Exception.Message))
  }
}
foreach ($hjob in @($jobTable.Values)) { [void]$Native::CloseHandle($hjob) }
`;
