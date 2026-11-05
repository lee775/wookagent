/**
 * 프로그램이 수행하는 외부 실행·git 작업 기록 (ERR-07, SEC-11, GIT-15).
 * 시작 전에 요청 ID와 함께 'started'로 남기고, 끝나면 결과로 갱신한다.
 * 재시작 때 'started'로 남은 기록은 recovery.ts가 결과를 대조한다.
 */
import type { ExecKind, ExecRecord, Member, ProjectId, TaskId } from '@shared/domain';
import type { GitIdentity } from '../git/types';
import type { Ctx } from './context';

export interface ExecInput {
  kind: ExecKind;
  projectId: ProjectId | null;
  taskId: TaskId | null;
  cwd: string;
  command: string;
  target: string;
  /** 이미 정한 요청 ID (멱등 재시도). 없으면 새로 발급 */
  requestId?: string;
  /** 시작 시 함께 남길 값 (preSha 등) */
  pre?: Record<string, unknown>;
}

export async function recordedExec<T>(
  ctx: Ctx,
  input: ExecInput,
  fn: (requestId: string) => Promise<{ value: T; result?: Record<string, unknown>; failed?: boolean }>,
): Promise<T> {
  const requestId = input.requestId ?? ctx.store.nextId('request');
  const rec: ExecRecord = {
    requestId,
    kind: input.kind,
    projectId: input.projectId,
    taskId: input.taskId,
    cwd: input.cwd,
    command: ctx.redact.text(input.command),
    target: input.target,
    state: 'started',
    startedAt: ctx.now(),
    endedAt: null,
    result: { ...(input.pre ?? {}) },
  };
  ctx.store.execs.put(rec);
  try {
    const out = await fn(requestId);
    ctx.store.execs.put({
      ...rec,
      state: out.failed ? 'failed' : 'succeeded',
      endedAt: ctx.now(),
      result: ctx.redact.value({ ...rec.result, ...(out.result ?? {}) }),
    });
    return out.value;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 실패 기록은 저장된 기록에서 만든다 — fn이 그 사이 남긴 값(host_exec의 PID·띄운 시각)이 남아 재시작 복구와 같은 요청 확인(AC-45)이 그 실행을 본다
    // (리드 결정 S5-83). 처음 남긴 기록만 쓰면 띄운 뒤의 오류가 그 값을 지웠다
    const stored = ctx.store.execs.get(requestId) ?? rec;
    ctx.store.execs.put({ ...stored, state: 'failed', endedAt: ctx.now(), result: ctx.redact.value({ ...stored.result, error: msg }) });
    ctx.activity({
      kind: 'exec',
      level: 'error',
      projectId: input.projectId,
      taskId: input.taskId,
      requestId,
      text: `${input.kind} 실패: ${input.command}`,
      result: msg,
    });
    throw e;
  }
}

export function memberIdentity(m: Member | null): GitIdentity {
  if (!m) return { name: '욱채', email: 'wook@wook.local' };
  return { name: m.name, email: `${m.id}@wook.local` };
}

/** 프로젝트별 main 변경 직렬화 (GIT-13). 잠금은 프로그램이 소유한다 */
export class ProjectLocks {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly holders = new Map<string, string>();

  async run<T>(projectId: string, label: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.tails.set(
      projectId,
      prev.then(() => mine),
    );
    await prev;
    this.holders.set(projectId, label);
    try {
      return await fn();
    } finally {
      this.holders.delete(projectId);
      release();
    }
  }

  holder(projectId: string): string | null {
    return this.holders.get(projectId) ?? null;
  }

  /** 어느 프로젝트든 잠금 안에서 처리가 돌고 있는지 (앱 종료가 저장소를 닫기 전에 기다린다) */
  busy(): boolean {
    return this.holders.size > 0;
  }
}
