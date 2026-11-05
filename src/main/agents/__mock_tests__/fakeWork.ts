/**
 * 시험용 가짜 업무 처리기: 모의 에이전트가 부르는 앱 도구에 정해진 결과를 돌려주고 호출을 모두 기록한다.
 * 오케스트레이터(orchestrator/tools.ts)의 결과 모양·거부 규칙 중 모의 에이전트가 기대는 부분만 흉내 낸다.
 */
import type { WorkContext } from '../../mcp/catalog';

export type FakeResult = { ok: true; data: unknown } | { ok: false; code: string; message: string };

export interface RecordedCall {
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  /** performance.now() 기준 ms */
  at: number;
  result: FakeResult;
}

export interface FakeAgentSetup {
  ctx: WorkContext;
  /** 검수 대상의 차수·반려 횟수 (get_review_target 결과) */
  reviewRound?: number;
  rejectsInRound?: number;
  /** read_memory가 돌려줄 기억 문서 */
  memory?: string;
  /** complete_step 결과에 정지 요청 안내("지금 턴을 마치세요")를 붙인다 (9장 일시정지 graceful) */
  stopAfterStep?: boolean;
  /** 이 도구들은 conflict로 거부한다 (도구 이름 → 사유) */
  failTools?: Record<string, string>;
}

interface AgentState {
  setup: FakeAgentSetup;
  steps: { idx: number; title: string; done: boolean }[];
  cache: Map<string, unknown>;
  nextTask: number;
  memory: string;
}

export class FakeWork {
  readonly calls: RecordedCall[] = [];
  private readonly agents = new Map<string, AgentState>();

  register(agent: string, setup: FakeAgentSetup): void {
    this.agents.set(agent, {
      setup,
      steps: (setup.ctx.task?.steps ?? []).map((s) => ({ ...s })),
      cache: new Map(),
      nextTask: 101,
      memory: setup.memory ?? '# 프로젝트 기억\n\n## 목표\n\n## 대표 선호\n',
    });
  }

  has(agent: string): boolean {
    return this.agents.has(agent);
  }

  /** 다음 턴을 위해 문맥을 바꾼다 (단계 진행 상태는 유지) */
  update(agent: string, patch: Partial<FakeAgentSetup>): void {
    const a = this.state(agent);
    a.setup = { ...a.setup, ...patch };
  }

  steps(agent: string): { idx: number; title: string; done: boolean }[] {
    return this.state(agent).steps.map((s) => ({ ...s }));
  }

  memoryOf(agent: string): string {
    return this.state(agent).memory;
  }

  callsOf(agent: string, tool?: string): RecordedCall[] {
    return this.calls.filter((c) => c.agent === agent && (tool === undefined || c.tool === tool));
  }

  handle(agent: string, tool: string, args: Record<string, unknown>): FakeResult {
    const result = this.dispatch(agent, tool, args);
    this.calls.push({ agent, tool, args, at: performance.now(), result });
    return result;
  }

  /** 서버 단계에서 거부한 호출(입력 형식 오류 등)도 같은 기록에 남긴다 */
  reject(agent: string, tool: string, args: Record<string, unknown>, code: string, message: string): FakeResult {
    const result: FakeResult = { ok: false, code, message };
    this.calls.push({ agent, tool, args, at: performance.now(), result });
    return result;
  }

  private state(agent: string): AgentState {
    const a = this.agents.get(agent);
    if (!a) throw new Error(`등록되지 않은 시험 에이전트: ${agent}`);
    return a;
  }

  private dispatch(agent: string, tool: string, args: Record<string, unknown>): FakeResult {
    const a = this.state(agent);
    const rid = typeof args.request_id === 'string' ? args.request_id : null;
    const key = rid ? `${tool}:${rid}` : null;
    // orchestrator/tools.ts처럼 같은 요청 ID는 처음 결과를 그대로 돌려준다 (AC-45)
    if (key && a.cache.has(key)) return { ok: true, data: { ...(a.cache.get(key) as object), duplicateRequest: true } };
    const r = this.run(a, tool, args);
    if (key && r.ok) a.cache.set(key, r.data);
    return r;
  }

  private run(a: AgentState, tool: string, args: Record<string, unknown>): FakeResult {
    const ctx = a.setup.ctx;
    const fail = (code: string, message: string): FakeResult => ({ ok: false, code, message });
    const ok = (data: unknown): FakeResult => ({ ok: true, data });
    const forced = a.setup.failTools?.[tool];
    if (forced !== undefined) return fail('conflict', forced);
    switch (tool) {
      case 'get_work_context':
        return ok(ctx.task ? { ...ctx, task: { ...ctx.task, steps: a.steps.map((s) => ({ ...s })) } } : ctx);
      case 'set_steps': {
        if (ctx.session.kind !== 'task') return fail('forbidden', '작업 세션에서만 쓸 수 있는 도구입니다');
        const done = a.steps.filter((s) => s.done);
        const titles = (args.steps as string[]) ?? [];
        a.steps = [...done, ...titles.map((title, i) => ({ idx: done.length + i, title, done: false }))];
        return ok({ steps: a.steps.map((s) => ({ ...s })) });
      }
      case 'add_steps': {
        const titles = (args.steps as string[]) ?? [];
        a.steps = [...a.steps, ...titles.map((title, i) => ({ idx: a.steps.length + i, title, done: false }))];
        return ok({ steps: a.steps.map((s) => ({ ...s })) });
      }
      case 'complete_step': {
        const s = a.steps.find((x) => x.idx === args.step_index);
        if (!s) return fail('invalid', `단계 ${String(args.step_index)}이(가) 없습니다`);
        const already = s.done;
        s.done = true;
        return ok({
          step: { idx: s.idx, title: s.title, done: true },
          commitSha: null,
          already,
          progress: `${a.steps.filter((x) => x.done).length}/${a.steps.length}`,
          message: a.setup.stopAfterStep ? '일시정지 요청이 있어 이 단계에서 멈춥니다. 지금 턴을 마치세요.' : undefined,
        });
      }
      case 'submit_for_review': {
        const left = a.steps.filter((s) => !s.done);
        if (!a.steps.length || left.length) return fail('invalid', `남은 단계가 있습니다: ${left.map((s) => s.idx).join(', ')}`);
        return ok({ message: '검수 요청을 받았습니다. 지금 턴을 마치세요.' });
      }
      case 'ask_producer':
        return ok({ questionId: 'Q-0001', message: '프로듀서에게 질문했습니다. 작업이 답변 대기로 보류됐으니 지금 턴을 마치세요.' });
      case 'report_conflict_resolved':
        return ok({ commitSha: 'c'.repeat(40), message: '충돌 해결을 커밋했습니다.' });
      case 'get_review_target': {
        const rt = ctx.reviewTasks.find((x) => x.taskId === args.task_id);
        if (!rt) return fail('forbidden', '이 작업의 검수자로 배정되지 않았습니다');
        return ok({
          taskId: rt.taskId,
          title: rt.title,
          goal: '시험 목표',
          outputMode: rt.outputMode,
          reviewRound: a.setup.reviewRound ?? rt.reviewRound,
          rejectsInRound: a.setup.rejectsInRound ?? 0,
          target: rt.target,
          reviewCopyPath: rt.reviewCopyPath,
          acceptanceCriteria: rt.acceptanceCriteria,
          autoCheck: { status: 'passed', detail: '', at: null },
          changedFiles: [],
          artifacts: [],
          previousReviews: [],
        });
      }
      case 'submit_review': {
        const rt = ctx.reviewTasks.find((x) => x.taskId === args.task_id);
        if (!rt) return fail('forbidden', '이 작업의 검수자로 배정되지 않았습니다');
        const verdict = args.verdict === 'pass' ? 'pass' : 'reject';
        const criteria = (args.criteria as { pass: boolean }[]) ?? [];
        if (verdict === 'pass' && criteria.some((c) => !c.pass)) return fail('invalid', '통과 판정인데 실패로 표시한 완료 조건이 있습니다');
        return ok({ reviewId: 'RV-0001', verdict, duplicate: false, taskState: verdict === 'pass' ? 'in_review' : 'in_progress', message: '검수 결과를 등록했습니다.' });
      }
      case 'create_task': {
        const id = `T-${String(a.nextTask++).padStart(4, '0')}`;
        return ok({ taskId: id, reviewerId: ctx.you.memberId, state: 'waiting' });
      }
      case 'register_directive':
        return ok({ directiveId: 'D-0009', state: 'planning', message: '지시 D-0009을(를) 등록해 프로듀서에게 전달했습니다.' });
      case 'ask_owner':
        return ok({ questionId: 'Q-0002', message: '대표에게 질문했습니다. 지금 턴을 마치세요. 답변은 다음 턴에 전달됩니다.' });
      case 'submit_report':
        return ok({ reportId: 'R-0001', filePath: 'C:\\reports\\R-0001.md' });
      case 'read_memory':
        return ok({ projectId: args.project_id ?? null, content: a.memory });
      case 'write_memory':
        a.memory = String(args.content ?? '');
        return ok({ saved: true });
      case 'answer_question':
        return ok({ questionId: args.question_id, status: 'answered' });
      case 'replan_task':
        return ok({ taskId: args.task_id, state: 'in_progress', reviewRound: 2 });
      case 'resolve_hold':
      case 'update_task':
        return ok({ taskId: args.task_id, state: 'in_progress' });
      case 'request_merge':
        return ok({ status: 'queued' });
      case 'request_revert':
        return ok({ mode: 'revert_task', revertTaskId: 'T-0099' });
      case 'submit_final_result':
        return ok({ directiveId: args.directive_id, state: 'reporting' });
      case 'assign_reviewer':
        return ok({ taskId: args.task_id, reviewerId: args.reviewer_id });
      default:
        return ok({ tool });
    }
  }
}
