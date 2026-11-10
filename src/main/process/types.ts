/**
 * CLI 프로세스 실행·종료 계약 (CTL-03, CTL-07, CTL-11, 15.5 하위 프로세스 종료).
 * Windows: Job Object 러너(resources/jobrunner/JobRunner.cs → csc.exe로 컴파일)로 자식·후손까지 한 번에 종료.
 *   러너를 쓸 수 없으면 taskkill 방식 + 작업 개체 도우미(./jobHelper.ts, PowerShell)로 같은 범위를 정리한다.
 * macOS·Linux: 새 프로세스 그룹으로 실행하고 그룹 전체에 신호.
 * 구현: ./processRunner.ts 의 createProcessRunner()
 */

export interface RunSpec {
  /** 실행 파일 절대 경로 (.exe) 또는 PATH 이름. .cmd/.bat은 받지 않는다 */
  command: string;
  args: string[];
  cwd: string;
  /** 자식에게 줄 전체 환경 변수 (호출자가 process.env와 병합해서 넘김) */
  env: Record<string, string | undefined>;
  /**
   * 표준 입력으로 넣고 닫을 내용 (프롬프트). null이면 바로 닫음. taskkill 방식은 작업 개체에 넣은 뒤에 준다 — 프롬프트를 읽기 전에는 일을
   * 시작하지 않는 CLI라야 넣기 전에 후손을 만들지 않는다. 입력이 없는(null) 명세는 띄우자마자 일을 시작하므로 adoptGate가 없으면 그 실행의
   * 후손 종료를 확인하지 못한 것(-1)으로 다룬다
   */
  stdinText: string | null;
  /** 로그용 이름 */
  label: string;
  /**
   * Windows: args를 다시 인용하지 않고 공백으로만 이어 명령줄을 만든다. `cmd.exe /d /s /c "<명령>"` 전용 (Node shell:true와 같은 방식).
   * cmd는 역슬래시 이스케이프(\")를 모르므로 일반 인용으로 넘기면 명령 속 큰따옴표가 깨진다 (windows:F4). 다른 OS에서는 무시
   */
  verbatimArgs?: boolean;
  /**
   * Windows: 출력이 콘솔 코드 페이지(한국어 Windows는 CP949)일 수 있는 프로그램(cmd 자체 오류 문구·Windows 도구).
   * 줄마다 UTF-8로 읽고 UTF-8이 아니면 CP949로 읽는다 (windows:F10). 기본은 UTF-8 (CLI의 JSON 출력)
   */
  consoleOutput?: boolean;
  /**
   * taskkill 방식 전용: 표준 입력 없이 띄우자마자 일을 시작하는 명령(자동 검사 셸)을 작업 개체에 넣은 뒤에야 시작하게 하는 형태.
   * 이 방식은 args 대신 adoptGate.args로 띄우고, 작업 개체에 넣은 뒤(늦어도 넣기 대기 상한 뒤) go를 표준 입력으로 주고 닫는다.
   * 이 형태는 go를 읽기 전에는 프로세스를 하나도 띄우지 않아야 한다 — cmd.exe /d /s /c "pause>nul& <명령>" (autocheck.shellCommand).
   * stdinText가 null인 명세에만 쓴다. 다른 방식은 무시한다 (작업 개체 러너는 자식을 일시 중지 상태로 띄워 넣은 뒤 시작한다)
   */
  adoptGate?: { args: string[]; go: string };
}

/** 실행 환경 문제의 종류 (리드 결정 S6-5) — 알림·거부 글과 system.prereqs.jobRunner가 종류마다 맞는 사실을 쓴다 */
export type RunnerProblemKind = 'helper_unavailable' | 'binary_changed';

export interface RunnerProblem {
  kind: RunnerProblemKind;
  /** 까닭 (한국어 한 줄) */
  text: string;
}

/**
 * 종료를 확인하지 못한 실행의 '실행 환경 까닭' (turns.ts unconfirmedFacts의 envProblem). 작업 개체 도우미를 쓸 수 없을 때만 그 까닭이다 —
 * 러너 파일이 바뀐 것(binary_changed)은 종료 확인을 못 하게 하는 까닭이 아니므로 null (그 실행은 러너가 알려 준 까닭을 그대로 쓴다)
 */
export function unconfirmedEnvProblem(runner: Pick<ProcessRunner, 'problem'>): string | null {
  const p = runner.problem?.() ?? null;
  return p && p.kind === 'helper_unavailable' ? p.text : null;
}

export interface ExitInfo {
  /** CLI 종료 코드 */
  code: number | null;
  signal: string | null;
  /** 정상 종료 뒤 남아 있어서 정리한 하위 프로세스 수 */
  leftoverKilled: number;
  /** 정리 후에도 남은 프로세스 수 (0이어야 정상). 확인하지 못했으면 -1 — 호출자는 종료 확인 실패로 다룬다 (CTL-11) */
  remaining: number;
  durationMs: number;
  /** terminate()로 끝났는지 */
  terminated: boolean;
  /** remaining이 0이 아닐 때 그 까닭 (기록용, 예: 작업 개체에 늦게 넣어 그 전에 부모가 끝난 후손은 확인하지 못함) */
  detail?: string;
}

export interface TerminateResult {
  /** 프로세스 트리 전체 종료 확인 */
  ok: boolean;
  /** 확인 시점에 남은 프로세스 수 (확인 불가면 -1) */
  remaining: number;
  detail: string;
  durationMs: number;
}

export interface ManagedProcess {
  /** 직접 띄운 프로세스(러너 또는 CLI) PID */
  readonly pid: number | null;
  /** 실제 CLI 프로세스 PID (러너가 알려주면). 알 수 없으면 null */
  readonly childPid: Promise<number | null>;
  /** 표준 출력 한 줄 (줄바꿈 제외, UTF-8). 러너 제어 줄은 전달하지 않음 */
  onStdoutLine(cb: (line: string) => void): void;
  onStderrLine(cb: (line: string) => void): void;
  /** 프로세스(와 남은 후손 정리)가 끝나면 해결 */
  readonly exited: Promise<ExitInfo>;
  /**
   * 프로세스 트리 전체 종료 후 종료 확인 (기본 제한 3000ms).
   * 이미 끝났으면 즉시 ok. 여러 번 불러도 같은 결과
   */
  terminate(opts?: { timeoutMs?: number; reason?: string }): Promise<TerminateResult>;
}

export interface ProcessRunner {
  /** jobobject = Windows Job Object 러너, taskkill = 러너 없는 Windows 대체 방식, pgroup = POSIX 프로세스 그룹 */
  readonly mode: 'jobobject' | 'taskkill' | 'pgroup';
  /** 러너 준비 상태 설명 (설정 화면 표시용). 지금 쓸 수 없는 보조 도구가 있으면 그 까닭도 붙는다 */
  readonly detail: string;
  /**
   * 프로세스를 띄우기 바로 전에 부른다 (턴·자동 검사). taskkill 방식이면 작업 개체 도우미가 준비될 때까지(상한 있음) 기다린다 —
   * 띄우자마자 작업 개체에 넣어야 넣기 전에 부모가 먼저 끝난 후손(고아)이 생기지 않는다 (AC-29·36). 다른 방식은 바로 끝난다
   */
  ready?(): Promise<void>;
  /**
   * 지금의 실행 환경 문제. 없으면 null.
   * - helper_unavailable: taskkill 방식에서 작업 개체 도우미를 쓸 수 없음 — 턴·검사가 끝날 때마다 남은 후손을 확인하지 못한다(-1)
   * - binary_changed: 작업 개체 러너 실행 파일이 준비할 때와 다름 (띄울 때마다 해시를 본다, S5-21) — 그 파일로는 아무것도 띄우지 않는다
   */
  problem?(): RunnerProblem | null;
  /** problem이 생길 때마다 부른다. 해제 함수를 돌려준다 */
  onProblem?(cb: (problem: RunnerProblem) => void): () => void;
  start(spec: RunSpec): ManagedProcess;
  /** 재시작 복구 (ERR-08): 이전 실행의 PID가 아직 살아 있는지 */
  isAlive(pid: number): Promise<boolean>;
  /**
   * 재시작 복구: 지금 그 PID를 가진 프로세스의 생성 시각(epoch ms). 없거나 읽지 못한 PID는 빠진다 — 호출자는 '모름'으로 다룬다.
   * PID는 재사용되므로 종료 전에 기록한 시작 시각과 대조한다 (windows:F2). 여러 PID를 한 번에 조회한다 (Windows는 약 1초)
   */
  processCreatedAt(pids: number[]): Promise<Map<number, number>>;
  /**
   * 재시작 복구: 이전 실행의 프로세스 트리 종료. ok는 후손까지 종료를 확인했을 때만 — taskkill 방식(작업 개체 러너 없음)은
   * 부모가 먼저 끝난 후손을 확인할 수 없으므로 트리를 끊어도 ok=false·remaining=-1이다 (CTL-03·11)
   */
  killTree(pid: number): Promise<TerminateResult>;
  /** 앱 종료: 러너가 띄워 둔 보조 프로세스(taskkill 방식의 작업 개체 도우미)를 끝낸다. 실행 중인 프로세스는 건드리지 않는다 */
  dispose?(): void;
}
