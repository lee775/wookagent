/**
 * 자동 검사 (REV-01): 프로젝트의 빌드·테스트·형식 검사 명령을 작업 폴더에서 실행한다.
 * 명령은 대표가 프로젝트 설정에 적은 셸 명령이므로 셸로 실행하되, 프로세스 러너를 거쳐 정지 시 함께 종료된다.
 */
import { MAIN_AGENT_ID, OPERATOR, OWNER, type Actor, type ExecRecord, type Project, type Task } from '@shared/domain';
import { REDACT_FAILED_MARK } from '@core/redact';
import { unconfirmedEnvProblem, type ManagedProcess, type TerminateResult } from '../process/types';
import type { Core } from './core';
import { recordedExec } from './execlog';
import { HostExecOutput } from './hostExec';
import { isProgramRevert, memberName } from './lookups';

export interface CheckOutcome {
  status: 'passed' | 'failed' | 'not_applicable';
  detail: string;
  /** 정지·보류로 실행하지 않았거나 중간에 종료됨 — 검사 결과로 치지 않고 재개 때 다시 한다 */
  stopped?: boolean;
  /**
   * stopped일 때 재개하면 무엇을 하는지 (작업의 자동 검사 표시용). 없으면 '정지로 중단 — 재개 때 다시 검사'. 종료를 확인하지 못해 보류한 검사는
   * 재개 때 다시 돌리지 않고 기록한 결과로 이어 간다 (S7-C2)
   */
  resumeNote?: string;
}

const TAIL = 4000;

/**
 * 검사 출력의 끝 (리드 결정 S5-54): host_exec와 같은 출력 모으기(HostExecOutput — 개인 키 창, 긴 줄의 값싼 개인 키 검사 뒤 버리기, 앞 16KiB + 뒤 48KiB)로
 * 표준 출력·오류를 모으고, 끝날 때 그 가린 글(text — 남긴 64KiB 안을 한 번 가린다)의 끝 4,000자를 검사 결과로 쓴다. 자기 줄 다루기는 없다 — 한 가리기 규칙을
 * 두 곳에 두면 서로 어긋난다(S5-52.1의 따로 만든 끝 모으기가 4KiB 넘는 줄을 개인 키 검사 없이 버려 키 본문이 남았다). 줄을 넘기고 글을 받기만 한다
 */
export class CheckOutputTail {
  private readonly out: HostExecOutput;

  /** redact: 백엔드 가리개 (ctx.redact.text) */
  constructor(redact: (s: string) => string) {
    this.out = new HostExecOutput(redact);
  }

  push(line: string): void {
    this.out.push(line);
  }

  /** 모은 글을 가린 것의 끝 4,000자 — 가린 뒤에 자른다 */
  text(): string {
    return this.out.text().slice(-TAIL);
  }
}

/** 실행 기록에 남기는 '검사 뒤 커밋되지 않은 파일' 수의 상한 (기록 크기 보호 — 재개 때는 지금 작업 폴더와 겹치는지만 본다) */
const MAX_LEFT_FILES = 200;

/** 종료를 확인하지 못한 검사 실행의 결과 (그 실행 기록에 남은 값) — 대표가 그 보류를 재개하면 이 결과로 제출을 이어 간다 */
interface RecordedCheck {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  out: string;
  /**
   * 검사가 끝난 직후 작업 폴더의 커밋되지 않은 파일 (검사 전에는 깨끗했다 — 제출 전 정리·최신 main 반영 뒤라 검사가 만든 것, S8-C1). 보류 사유에
   * 적는다. 재개 때의 거부는 그때의 커밋되지 않은 파일 전부로 한다 (남은 프로세스가 나중에 쓴 파일, S9-C2) — 작업 폴더 HEAD가 그 검사 때와 같을
   * 때만 (S10-C1)
   */
  left: string[];
  /** 그 보류를 확인하고 재개한 쪽 (v0.6: 메인 에이전트, 예전 기록: 대표). 아직 재개 전(보류 사유를 쓸 때)이면 없다 */
  by?: Actor;
}

/** 보류를 사람(또는 사람 대신 메인 에이전트)이 확인하고 푼 재개 — 프로그램이 스스로 푼 것은 확인이 아니다 (CTL-11, CTL-10) */
const CONFIRMING_ACTORS: ReadonlySet<string> = new Set<string>([OWNER, MAIN_AGENT_ID, OPERATOR]);

/** 검사 결과 한마디 (보류 사유·활동 기록) */
function resultText(c: RecordedCheck): string {
  return c.ok ? '통과 — 종료 코드 0' : c.timedOut ? '실패 — 시간 초과' : `실패 — 종료 코드 ${String(c.code)}`;
}

function shortList(files: readonly string[]): string {
  return files.length > 5 ? `${files.slice(0, 5).join(', ')} 외 ${files.length - 5}개` : files.join(', ');
}

/**
 * 종료를 확인하지 못해 보류한 검사를 메인 에이전트가 확인하고 재개하면 무엇을 하는지 (보류 사유·알림·자동 검사 표시, CTL-11). 재개는 v0.6에서
 * 메인 에이전트 몫이다 — 대표가 확인한다고 말하지 않는다 (리드 결정 21). 기록한 결과는 그 버전에만 쓴다 — 그사이
 * main이나 작업 폴더가 바뀌면 다시 검사한다 (S7-C2, 검사가 파일을 남겼어도 같다 — S9-C3). 재개 때 작업 폴더의 커밋은 그대로인데 커밋되지 않은 파일이
 * 있으면 검사(나 남은 프로세스)가 쓴 것으로 보고 커밋하지 않는다: 확인한 검사의 '검사 뒤 상태' 규칙대로 제출을 거부하고, 실패한 되돌리기면 확인한
 * 경로처럼 되돌리기 보류 (leftByConfirmedRun, S8-C1·S9-C1·C2). 작업 폴더에 커밋이 생겼으면 그 파일도 커밋해 다시 검사 (S10-C1). revert: 프로그램
 * 되돌리기 작업
 */
function resumeText(c: RecordedCheck, revert: boolean): string {
  const left = c.left.length ? `검사 뒤 커밋되지 않은 파일(${shortList(c.left)})이 생겼습니다 — ` : '';
  const dirty = !c.ok && revert ? '되돌리기를 보류해 프로듀서가 조정 범위를 계획하게 합니다' : '제출을 거부해 담당에게 돌려보냅니다(빌드 산출물이면 .gitignore에 추가하라고 안내)';
  return `${left}남은 프로세스를 확인하고 재개할지는 메인 에이전트가 정합니다. 재개했을 때 같은 버전이면 검사를 다시 돌리지 않고 이 결과(${resultText(c)})로 제출을 이어 갑니다 (그사이 main이나 작업 폴더가 바뀌어 검사할 버전이 달라지면 다시 검사). 다만 작업 폴더의 커밋은 그대로인데 커밋되지 않은 파일이 있으면(검사나 검사가 남긴 프로세스가 쓴 파일 등) 그 파일을 커밋하지 않고 검사도 다시 돌리지 않은 채 ${dirty}`;
}

/**
 * 대표가 적은 명령을 셸 그대로 실행한다. Windows는 Node shell:true와 같은 방식 — cmd.exe /d /s /c "<명령>"을 인용 없이 넘긴다.
 * cmd는 역슬래시 이스케이프를 모르므로 일반 인자 인용(\")이면 명령 속 큰따옴표가 깨져 실패하는 검사가 통과로, 공백 있는 경로가 실패로 나온다 (windows:F4).
 * cmd 자체 오류 문구는 콘솔 코드 페이지(CP949)로 나오므로 줄마다 UTF-8 → CP949로 읽는다 (windows:F10).
 * adoptGate (taskkill 대체 방식만 쓴다, S7-C1): 검사 셸은 띄우자마자 일을 시작하므로 작업 개체에 넣기 전에 중간 프로세스가 고아를 남길 수 있다
 * (cmd 이중 start 사슬은 약 20ms). 그래서 맨 앞에서 표준 입력 한 바이트를 기다리게 띄운다 — `pause>nul`은 한 바이트만 읽고(남은 입력·종료 코드·
 * 출력·환경을 바꾸지 않는다) 그 전에는 아무것도 띄우지 않으며, `&`는 cmd에서 가장 느슨하게 묶여 명령 전체가 그 뒤에 그대로 돈다
 */
export function shellCommand(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; verbatimArgs: boolean; consoleOutput: boolean; adoptGate?: { args: string[]; go: string } } {
  if (platform === 'win32') {
    return {
      command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', `"${cmd}"`],
      verbatimArgs: true,
      consoleOutput: true,
      adoptGate: { args: ['/d', '/s', '/c', `"pause>nul& ${cmd}"`], go: '\n' },
    };
  }
  return { command: '/bin/sh', args: ['-c', cmd], verbatimArgs: false, consoleOutput: false };
}

export class AutoChecker {
  /** 정지 시 종료할 실행 중 검사 (작업 ID → 프로세스) */
  readonly running = new Map<string, ManagedProcess>();

  constructor(private readonly core: Core) {}

  /**
   * version: 검사하는 버전(작업 폴더 HEAD — 제출 처리가 최신 main을 반영한 커밋). 종료를 확인하지 못한 실행의 결과는 이 버전·이 제출 요청에만
   * 다시 쓴다 (S7-C2). 모르면(생략) 그 결과를 남기지도 쓰지도 않는다 — 재개 때 다시 검사한다
   */
  async run(task: Task, project: Project, cwd: string, version: string | null = null): Promise<CheckOutcome> {
    const ctx = this.core.ctx;
    if (project.checkCommands.length === 0) {
      return { status: 'not_applicable', detail: '해당 없음 — 프로젝트에 자동 검사 명령이 등록되어 있지 않습니다' };
    }
    const timeoutMs = ctx.settings().execution.commandMaxMin * 60_000;
    const outputs: string[] = [];
    const head = version;
    for (const cmd of project.checkCommands) {
      // 러너가 띄우자마자 하위 프로세스를 추적할 수 있을 때까지 (taskkill 방식의 작업 개체 도우미 준비, AC-29) — 정지 확인보다 먼저
      await ctx.deps.runner.ready?.();
      // 정지·보류·취소 중이면 새 검사 프로세스를 띄우지 않는다 (CTL-03·09). 이 확인부터 running 등록까지 await가 없어,
      // 뒤에 오는 정지는 실행 중 목록에서 반드시 찾아 종료한다
      const cur = ctx.store.tasks.get(task.id);
      if (!cur || !this.core.stops.runAllowedForTask(cur)) {
        return { status: 'failed', detail: `'${cmd}' 실행 안 함 (정지로 중단)`, stopped: true };
      }
      // 이 버전에서 종료를 확인하지 못해 보류했던 실행을 대표가 확인하고 재개했으면 다시 돌리지 않고 그 결과로 이어 간다 — 다시 돌리면 같은 환경(작업 개체
      // 도우미를 쓸 수 없음 등)에서 또 확인하지 못해 몇 번을 재개해도 검수로 가지 못한다 (S7-C2, CTL-11은 보류가 지킨다)
      const confirmed = this.ownerConfirmedRun(cur, cmd, cwd, head);
      if (confirmed) {
        outputs.push(`$ ${cmd}\n${confirmed.out}`);
        if (!confirmed.ok) {
          return { status: 'failed', detail: `'${cmd}' 실패 (${confirmed.timedOut ? '시간 초과' : `종료 코드 ${String(confirmed.code)}`}, 재개 때 확인한 실행의 결과)\n${confirmed.out}` };
        }
        continue;
      }
      const sh = shellCommand(cmd);
      let requestId = '';
      const result = await recordedExec(
        ctx,
        { kind: 'auto_check', projectId: project.id, taskId: task.id, cwd, command: cmd, target: task.id, pre: { headSha: head, submitAt: cur.pendingSubmit?.requestedAt ?? null } },
        async (rid) => {
          requestId = rid;
          const proc = ctx.deps.runner.start({
            command: sh.command,
            args: sh.args,
            verbatimArgs: sh.verbatimArgs,
            consoleOutput: sh.consoleOutput,
            ...(sh.adoptGate ? { adoptGate: sh.adoptGate } : {}),
            cwd,
            env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
            stdinText: null,
            label: `검사 ${task.id}: ${cmd}`,
          });
          this.running.set(task.id, proc);
          ctx.bus.changed(); // 검사 프로세스도 진행 중 작업이다 (절전 방지, AC-31)
          // host_exec와 같은 출력 모으기로 — 백엔드 가리개로 가린 글의 끝만 쓴다 (리드 결정 S5-54)
          const tail = new CheckOutputTail((t) => ctx.redact.text(t));
          proc.onStdoutLine((l) => tail.push(l));
          proc.onStderrLine((l) => tail.push(l));
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            void proc.terminate({ reason: '자동 검사 시간 초과' });
          }, timeoutMs);
          try {
            const exit = await proc.exited;
            // 프로그램이 끝낸 검사(시간 초과·정지)면 그 종료 확인 결과 — 프로세스는 같은 약속을 돌려준다 (요청하지 않았으면 terminated가 false)
            const stopRes = exit.terminated ? await proc.terminate() : null;
            // 남은 하위 프로세스 수 (0 = 종료 확인, -1 = 확인하지 못함). 정지의 종료 확인이 실패했으면 ExitInfo가 0이어도 확인하지 못한 것 (CTL-11)
            const leftover = exit.remaining !== 0 ? exit.remaining : stopRes && !stopRes.ok ? (stopRes.remaining > 0 ? stopRes.remaining : -1) : 0;
            const leftoverDetail = leftover === 0 ? null : stopRes && !stopRes.ok ? stopRes.detail : (exit.detail ?? null);
            // 출력은 try 안에서 — 가리기가 실패해도 그 글만 표시가 되고, 남은 프로세스(CTL-11)의 보류·알림과 검사 결과는 그대로 이어진다 (리드 결정 S5-83)
            let out: string;
            try {
              out = tail.text();
            } catch {
              out = REDACT_FAILED_MARK;
            }
            const ok = exit.code === 0 && !timedOut && !exit.terminated && leftover === 0;
            return {
              value: { ok, out, code: exit.code, timedOut, terminated: exit.terminated, leftover, leftoverDetail },
              result: { exitCode: exit.code, timedOut, output: out, ...(leftover !== 0 ? { remaining: leftover, leftoverDetail, terminated: exit.terminated } : {}) },
              failed: !ok,
            };
          } finally {
            clearTimeout(timer);
            this.running.delete(task.id);
            ctx.bus.changed();
          }
        },
      );
      outputs.push(`$ ${cmd}\n${result.out}`);
      if (result.leftover !== 0) {
        // 검사 프로세스 트리의 종료를 확인하지 못했다 (검사가 띄운 개발 서버 등이 남았거나 확인 불가) — 그 작업 폴더에 다음 검사·턴을 겹쳐
        // 띄우지 않게 작업을 보류(오류)하고 알린다 (CTL-11). 제출 요청은 남긴다. 검사가 스스로 끝났거나 시간 초과로 끝났으면 그 결과(종료 코드)가
        // 있다 — 메인 에이전트가 남은 프로세스를 확인하고 재개하면 그 재개를 확인으로 보고 다시 돌리지 않고 그 결과로 이어 간다(통과면 검수로, 실패면
        // 보통의 실패 처리, S7-C2). 정지로 끊긴 검사는 결과가 없어 재개 때 다시 검사한다. 이 보류는 메인 에이전트에게 알림 업무로 간다(alert
        // kill-failed:<작업>, blockUnconfirmedRun — 리드 결정 S5-7·S5-8). 보류 사유 글은 사실과 재개 때 이어 가는 길만 담는다 (리드 결정 S5-9).
        // 검사 뒤 커밋되지 않은 파일도 결과와 함께 남긴다 — 확인한 검사라면 제출 처리의 '검사 뒤 상태' 확인이 제출을 거부한다. 재개 때도 같은 규칙을
        // 쓴다: 그 파일을 커밋하지 않고 거부한다 (S8-C1). 그 상태를 읽지 못했으면 결과를 쓰지 않는다 (재개 때 다시 검사)
        const left = head && (!result.terminated || result.timedOut) ? await this.filesLeft(cwd) : null;
        const recorded: RecordedCheck | null = left
          ? { ok: result.code === 0 && !result.timedOut && !result.terminated, code: result.code, timedOut: result.timedOut, out: result.out, left }
          : null;
        const resumeNote = recorded ? resumeText(recorded, isProgramRevert(task)) : null;
        const note = await this.core.turns.blockUnconfirmedRun(
          { label: `${task.id} 자동 검사 '${cmd}'`, sessionKind: 'task', sessionKey: `check:${task.id}`, memberId: task.assigneeId, projectId: project.id, taskId: task.id, turnId: null, refId: requestId },
          { envProblem: unconfirmedEnvProblem(ctx.deps.runner), remaining: result.leftover, cause: result.leftoverDetail, what: '자동 검사', tail: resumeNote },
        );
        if (recorded) this.noteHeld(task.id, requestId, recorded.left);
        return {
          status: 'failed',
          detail: `'${cmd}' 검사 프로세스의 종료를 확인하지 못함 — ${note}\n${result.out}`,
          stopped: true,
          ...(resumeNote ? { resumeNote: `하위 프로세스 종료 확인 못 함 — ${resumeNote}` } : {}),
        };
      }
      if (!result.ok) {
        const stopped = result.terminated && !result.timedOut;
        const why = result.timedOut ? '시간 초과' : stopped ? '정지로 중단' : `종료 코드 ${result.code}`;
        return { status: 'failed', detail: `'${cmd}' 실패 (${why})\n${result.out}`, ...(stopped ? { stopped: true } : {}) };
      }
    }
    return { status: 'passed', detail: outputs.join('\n\n').slice(-TAIL) };
  }

  /**
   * 종료를 확인하지 못해 보류한 검사 실행: 그 보류(오류, refId = 실행 기록 ID)가 생긴 시각을 실행 기록에 남긴다 — 대표가 그 보류를 재개했는지 볼 기준.
   * 보류하지 않았으면(앱 종료 중 등) 남기지 않는다 → 그 실행의 결과는 쓰지 않고 다시 검사한다
   */
  private noteHeld(taskId: string, requestId: string, left: readonly string[]): void {
    const ctx = this.core.ctx;
    const held = ctx.store.tasks.get(taskId)?.hold.reasons.find((r) => r.kind === 'error' && r.refId === requestId);
    const rec = held ? ctx.store.execs.get(requestId) : null;
    if (held && rec) ctx.store.execs.put({ ...rec, result: { ...rec.result, heldSince: held.since, leftFiles: left.slice(0, MAX_LEFT_FILES) } });
  }

  /** 검사가 끝난 뒤 작업 폴더의 커밋되지 않은 파일. 읽지 못하면 null */
  private async filesLeft(cwd: string): Promise<string[] | null> {
    try {
      return (await this.core.ctx.deps.git.status(cwd)).files.map((f) => f.path);
    } catch (e) {
      this.core.ctx.log('warn', `자동 검사 뒤 작업 폴더 상태를 읽지 못했습니다 (${cwd})`, e);
      return null;
    }
  }

  /**
   * 대표가 확인하고 재개한 '종료를 확인하지 못한 검사 실행'의 결과 (S7-C2). 이 작업·이 명령·이 작업 폴더의 마지막 검사 실행이 지금 제출 요청과 지금
   * 버전(HEAD)에서 종료를 확인하지 못해 보류됐고, 그 보류가 풀렸으며(오류 보류는 대표 재개로만 풀린다) 그 뒤 대표가 재개했으면 그 결과. 아니면 null —
   * 다시 검사한다. 처음 쓸 때 실행 기록에 대표 확인을 적고 활동 기록을 남긴다 (재시작 뒤 다시 들어와도 같은 결과)
   */
  private ownerConfirmedRun(task: Task, cmd: string, cwd: string, head: string | null): RecordedCheck | null {
    const ctx = this.core.ctx;
    if (!head) return null;
    const command = ctx.redact.text(cmd);
    const last: ExecRecord | undefined = ctx.store.execs
      .list({ ref1: task.id, ref2: 'auto_check' })
      .filter((x) => x.command === command && x.cwd === cwd)
      .at(-1);
    if (!last || last.result.headSha !== head) return null;
    const recorded = this.confirmedHeld(task, last);
    if (recorded) this.markConfirmed(task, last, recorded, cmd);
    return recorded;
  }

  /**
   * 이 작업 폴더의 마지막 검사 실행이 대표가 확인하고 재개한 '종료를 확인하지 못한 검사 실행'이고 작업 폴더 HEAD(head)가 그 실행이 검사한 버전
   * 그대로인데 지금 작업 폴더에 커밋되지 않은 파일(dirty)이 있으면 그 파일과 그 실행의 결과 (S8-C1). 검사 전에는 깨끗했고(제출 전 정리·최신 main 반영
   * 뒤) 보류 중에는 턴이 돌지 않으니 HEAD가 그대로면 그 파일은 검사나 검사가 남긴 프로세스가 쓴 것으로 본다(검사가 끝난 뒤 늦게 쓴 파일은 leftFiles에 없다,
   * S9-C2. 보류 중 대표가 바꾼 파일도 같게 본다). 확인한 검사라면 제출 처리의 '검사 뒤 상태' 확인이 제출을 거부했을 것이다 — 제출 처리는 그 파일을
   * '제출 전 변경 정리'로 커밋하지 않고 같은 규칙으로 거부한다. 커밋하면 버전이 바뀌어 그 결과를 쓰지 못하고 다시 검사·다시 보류를 되풀이하거나, 검사
   * 산출물을 프로그램이 커밋한 채 검수로 간다. HEAD가 바뀌었으면(재개 때 최신 main 반영이 충돌해 해결 턴이 돌고 프로그램이 해결을 커밋한 경우 등) 그
   * 결과는 지금 버전의 것이 아니므로 제출 처리가 그 파일을 커밋하고 새 버전을 다시 검사한다 (S10-C1). 아니면 null
   */
  leftByConfirmedRun(task: Task, cwd: string, dirty: readonly string[], head: string | null): { files: string[]; status: 'passed' | 'failed'; detail: string } | null {
    const last = this.core.ctx.store.execs
      .list({ ref1: task.id, ref2: 'auto_check' })
      .filter((x) => x.cwd === cwd)
      .at(-1);
    const recorded = last && head && last.result.headSha === head && dirty.length ? this.confirmedHeld(task, last) : null;
    if (!last || !recorded) return null;
    const files = [...dirty];
    this.markConfirmed(task, last, recorded, last.command);
    const why = recorded.ok ? '통과' : `실패 (${recorded.timedOut ? '시간 초과' : `종료 코드 ${String(recorded.code)}`}, 재개 때 확인한 실행의 결과)`;
    return { files, status: recorded.ok ? 'passed' : 'failed', detail: `'${last.command}' ${why}\n${recorded.out}` };
  }

  /**
   * 그 실행 기록이 지금 제출 요청에서 종료를 확인하지 못해 보류한 실행이고, 결과가 있으며(스스로·시간 초과로 끝남), 그 보류가 풀린 뒤 대표가 재개했으면
   * 그 결과 (S7-C2). 버전은 보지 않는다 (부르는 쪽이 정한다)
   */
  private confirmedHeld(task: Task, last: ExecRecord): RecordedCheck | null {
    const ctx = this.core.ctx;
    const submitAt = task.pendingSubmit?.requestedAt ?? null;
    const r = last.result;
    if (!submitAt || last.state === 'started' || r.submitAt !== submitAt || typeof r.heldSince !== 'string') return null;
    if (typeof r.remaining !== 'number' || r.remaining === 0 || (r.terminated === true && r.timedOut !== true)) return null;
    if (task.hold.reasons.some((h) => h.kind === 'error' && h.refId === last.requestId)) return null;
    const heldSince = r.heldSince;
    const confirmed = ctx.store.transitions.list(task.id).find((x) => x.event === 'release' && CONFIRMING_ACTORS.has(x.actor) && x.at >= heldSince);
    if (!confirmed) return null;
    const code = typeof r.exitCode === 'number' ? r.exitCode : null;
    const timedOut = r.timedOut === true;
    const left = Array.isArray(r.leftFiles) ? r.leftFiles.filter((p): p is string => typeof p === 'string') : [];
    return { ok: code === 0 && !timedOut && r.terminated !== true, code, timedOut, out: typeof r.output === 'string' ? r.output : '', left, by: confirmed.actor };
  }

  /** 대표가 확인한 실행을 처음 쓸 때: 실행 기록에 대표 확인을 적고(통과면 succeeded) 활동 기록을 남긴다 — 다시 들어와도 한 번만 */
  private markConfirmed(task: Task, last: ExecRecord, recorded: RecordedCheck, cmd: string): void {
    const ctx = this.core.ctx;
    const r = last.result;
    if (typeof r.ownerConfirmedAt !== 'string') {
      // 실행 기록도 대표 확인 뒤의 판정으로 (통과면 succeeded) — 남은 프로세스를 확인하지 못했다는 기록(remaining·leftoverDetail)은 그대로 둔다
      ctx.store.execs.put({ ...last, state: recorded.ok ? 'succeeded' : last.state, result: { ...r, ownerConfirmedAt: ctx.now() } });
      ctx.activity({
        kind: 'task',
        actor: recorded.by ?? OWNER,
        projectId: task.projectId,
        taskId: task.id,
        requestId: last.requestId,
        text: `${task.id} 자동 검사 '${cmd}': 종료를 확인하지 못한 실행을 ${memberName(ctx, recorded.by ?? OWNER)}가 확인하고 재개함 — 다시 검사하지 않고 그 결과(${resultText(recorded)})로 이어 감`,
      });
    }
  }

  /** 실행 중 검사 종료 — 결과를 돌려줘 정지 요약이 남은 프로세스를 알 수 있게 한다 (CTL-03: 남으면 완료로 표시하지 않음) */
  async terminateFor(taskIds: (id: string) => boolean): Promise<{ taskId: string; result: TerminateResult }[]> {
    return Promise.all(
      [...this.running]
        .filter(([id]) => taskIds(id))
        .map(async ([taskId, proc]) => ({
          taskId,
          result: await proc
            .terminate({ reason: '정지' })
            .catch((e: unknown): TerminateResult => ({ ok: false, remaining: -1, detail: e instanceof Error ? e.message : String(e), durationMs: 0 })),
        })),
    );
  }
}
