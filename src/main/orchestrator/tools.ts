/**
 * 앱 도구 처리기 (15.3 역할별 앱 도구, CLI-08, SEC-01).
 * 프로그램은 요청에 적힌 이름을 믿지 않고 토큰으로 확인한 호출자 기준으로 역할·프로젝트·배정·상태를 다시 검사한다.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ActivityKind, AiConfig, AiKind, EffortTier, HoldReason, Member, NavTarget, Priority, Question, Role, RunnerKind, ScopeStop, Settings, StopMode, Task, TaskType, Turn } from '@shared/domain';
import { AI_KINDS, EFFORT_LEVELS, MAIN_AGENT_ID } from '@shared/domain';
import { HOLD_REASON_LABEL, TURN_END_LABEL, WORK_KIND_LABEL } from '@shared/labels';
import type { CliEvent } from '@shared/events';
import type { DeepPartial, RoleInput } from '@shared/ipc';
import { BackendError } from '../backend/types';
import { TOOL_FAILURE_CODES, type TokenIdentity, type ToolCallResult, type ToolImage } from '../mcp/types';
import type { MemberActivity, ReportReadout, WorkContext, WorkTaskCard } from '../mcp/catalog';
import type { Ctx, RedactorLike } from './context';
import type { JournalRefRow, SeatHolder } from '../db/store';
import { holderLabel, parseHolderSpec, type RunnerFields } from './seat';
import type { Core } from './core';
import { createApi, type ApiHandlers } from './api';
import { changedPaths, MAIN_SETTINGS, settingsOutside } from './settingsPolicy';
import { sendUrgentInstruction } from './urgent';
import { EFFORT_GUIDE, HIRING_GUIDE } from './aiGuide';
import { handUnseenAlertsOnResume, handUnseenOnMemberRelease, handUnseenOnRecovery, type CarryShown, type UnseenRefusal } from './alerts';
import { directiveKey, enqueue, mainKey, parseKey } from './records';
import { activeTaskOf, directiveTasks, liveMemberOrThrow, memberName, memberOrThrow, messageSessionOf, projectMembers, projectOrThrow, roleOf, taskOrThrow } from './lookups';
import { canSubmitReview } from '@core/reviewRules';
import { artifactWorkDir } from './paths';
import { hashTree, readTail } from './fsutil';
import { deriveMemberStatus } from '@core/memberStatus';
import { activeModelLimits } from '@core/usageLimits';
import { MEMBER_STATUS_LABEL } from '@shared/labels';

type Args = Record<string, unknown>;

const str = (a: Args, k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');
const optStr = (a: Args, k: string): string | undefined => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
const arr = (a: Args, k: string): string[] => (Array.isArray(a[k]) ? (a[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
const optArr = (a: Args, k: string): string[] | undefined => (Array.isArray(a[k]) ? arr(a, k) : undefined);

/** 조회 도구 — 정지 중에도, 정지 요청을 받은 턴에서도 받는다 (상태를 바꾸지 않는다). 나머지는 상태를 바꾸는 도구다 (assertNotStopped) */
const READ_ONLY_TOOLS = new Set([
  'get_work_context',
  'list_projects',
  'get_project_status',
  'read_memory',
  'get_review_target',
  'list_ai_options',
  'list_roles',
  'search_activity',
  'get_handover',
  // 전체 그림과 조회 (SERVER_DESIGN 5.2, 리드 결정 S5-6) — 정지 중에도, 인계 메모 턴에도 쓴다
  'get_overview',
  'get_member_activity',
  'read_report',
  'list_questions',
]);

/**
 * 메인 일지에 서버 기록(action)으로 남는 메인 도구 (SERVER_DESIGN 6.1 '메인이 상태를 바꾼 도구 호출') — 팀과 지시, 질문, 역할과 설정, 정지와 취소, 검수와 자리.
 * 보고서 제출은 보고 도착(report)으로 남는다. 서버 명령(host_exec)은 끝난 결과(종료 코드·시간)와 함께 hostExec.ts가 남긴다(리드 결정 S5-16), 화면 조작은
 * 턴마다 묶은 한 줄로 desktop/guiRecords.ts가 남긴다(리드 결정 S6-7 — 호출마다 남기지 않는다)
 */
const JOURNAL_ACTION_TOOLS = new Set([
  'register_directive',
  'instruct_member',
  'add_member',
  'remove_member',
  'replace_member',
  'update_member',
  'set_member_ai',
  'replace_producer',
  'create_project',
  'update_project',
  'ask_owner',
  'create_role',
  'update_role',
  'delete_role',
  'update_settings',
  'pause_project',
  'pause_member',
  'resume_project',
  'resume_member',
  'interrupt_member',
  'interrupt_task',
  'resume_task',
  'cancel_task',
  'cancel_directive',
  'revise_directive',
  'resolve_recovery',
  'submit_review',
  'hand_off_seat',
  // 메인이 멈춘 검수의 검수자를 직접 정한다 (리드 결정 48·S5-11)
  'assign_reviewer',
]);

/** 운영 조작(mainOp)으로 처리하는 도구 — 일지는 mainOp가 남긴다 */
const MAIN_OP_JOURNALED = new Set(['update_member', 'replace_producer', 'update_project', 'create_role', 'update_role', 'delete_role', 'update_settings', 'pause_project', 'pause_member', 'resume_project', 'resume_member', 'interrupt_member', 'interrupt_task', 'resume_task', 'cancel_task', 'cancel_directive', 'revise_directive', 'resolve_recovery', 'assign_reviewer']);

/**
 * 메인 자리 교체의 인계 메모 턴(SERVER_DESIGN 4.3 3번)이 쓸 수 있는 도구 — 일지와 기억 문서 쓰기, 그리고 상태를 바꾸지 않는 조회 (S4b). 기억 문서는 통째로 바꾸므로
 * 읽고 고쳐 쓰게 read_memory도 받는다
 */
const MEMO_TURN_TOOLS = new Set(['journal_write', 'write_memory', ...READ_ONLY_TOOLS]);

/**
 * 메인 에이전트 전용 도구 (SERVER_DESIGN 2.6·5.2) — 처리기도 호출자가 메인 에이전트인지 다시 본다. cancel_task는 프로듀서와 함께 쓴다. 메인 전용 조회 도구도
 * 넣는다 — 목록 공개(역할)만 믿지 않는다 (리드 결정 S5-6)
 */
const MAIN_OPS_TOOLS = new Set([
  'update_project',
  'pause_project',
  'resume_project',
  'update_member',
  'replace_producer',
  'replace_member',
  'pause_member',
  'resume_member',
  'interrupt_member',
  'interrupt_task',
  'resume_task',
  'cancel_directive',
  'revise_directive',
  'resolve_recovery',
  'update_settings',
  'set_skill_mode',
  'list_roles',
  'create_role',
  'update_role',
  'delete_role',
  'recheck_ai',
  'backup_now',
  'search_activity',
  'hand_off_seat',
  'journal_write',
  'journal_close',
  'get_handover',
  'list_projects',
  'get_project_status',
  'read_memory',
  'list_ai_options',
  'get_overview',
  'get_member_activity',
  'read_report',
  'list_questions',
  // 서버 명령 — 처리기(hostExec.run)도 메인인지 다시 본다 (리드 결정 S5-16)
  'host_exec',
  // 화면 조작 (리드 결정 S6-3) — 처리기(desktop/service.ts)도 메인인지 다시 본다
  'screen_capture',
  'screen_info',
  'gui_input',
  'get_screen_check',
  'answer_screen_check',
]);

/**
 * 화면 조작 도구 (SERVER_DESIGN 8.3.3, 리드 결정 S6-3·S6-6) — 조회 도구가 아니다: 긴급 정지·메인 일시정지·이 턴의 종료 요청 뒤와 인계 메모 턴에는 거부된다.
 * 정지 검사는 처리기가 정한 순서(S6-6 2단계 — 모양 검사 뒤)에 부른다. 결과의 이미지는 data 밖(images)이라 도구 중복 캐시에 남지 않는다
 */
export const SCREEN_TOOLS: ReadonlySet<string> = new Set(['screen_capture', 'screen_info', 'gui_input', 'get_screen_check', 'answer_screen_check']);

/**
 * 원래 인자가 있어야 하는 도구 (리드 결정 S6-8 '비밀') — 가린 글을 실행·입력하면 다른 것이 돈다. 처리기는 가린 글과 원래 글이 다르면(비밀 값이 들었으면) 거부하므로
 * 실제로 쓰는 값은 기록에 남는 값과 같다. 그 밖의 인자는 가린 값을 쓴다
 */
const RAW_ARG_TOOLS: ReadonlySet<string> = new Set(['host_exec', 'gui_input']);

const optBool = (a: Args, k: string): boolean | undefined => (typeof a[k] === 'boolean' ? (a[k] as boolean) : undefined);
const stopMode = (a: Args): StopMode => (str(a, 'mode') === 'immediate' ? 'immediate' : 'graceful');
const thenOf = (a: Args): 'hold' | 'cancel' => (str(a, 'then') === 'cancel' ? 'cancel' : 'hold');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * 메인 에이전트가 준 이름과 다른 이름으로 지었으면 그 까닭 (add_member·replace_producer의 결과) — 팀원 이름은 사람 이름만 받는다 (team.uniqueName,
 * 대표 지시 2026-11-16)
 */
function nameNote(asked: string | undefined, given: string): { nameNote?: string } {
  const a = asked?.trim();
  if (!a || a === given) return {};
  return { nameNote: `"${a}" 대신 "${given}"(으)로 지었습니다 — 팀원 이름은 한글 2~4자의 사람 이름만 받고(AI 종류·역할·번호를 넣지 않습니다), 같은 프로젝트 안에서 겹칠 수 없습니다. 다른 이름을 원하면 update_member로 바꾸세요` };
}

/** 앱 도구의 AI 인자(ai_kind·model·effort_tier·effort) → AI 설정 입력 — add_member와 같은 이름 */
const aiArgs = (a: Args) => ({
  kind: optStr(a, 'ai_kind') as AiKind | undefined,
  model: optStr(a, 'model'),
  effortTier: optStr(a, 'effort_tier') as EffortTier | undefined,
  effortOverride: optStr(a, 'effort'),
});
const hasAiArgs = (a: Args): boolean => ['ai_kind', 'model', 'effort_tier', 'effort'].some((k) => a[k] !== undefined);

/** 메인 에이전트 운영 조작 하나 (SERVER_DESIGN 2.6) — 사유 기록, 대표 정보 알림(notify: 화면 이동 위치, 없으면 알림 없음) */
interface MainOp {
  kind: ActivityKind;
  /** 활동 기록·알림에 쓰는 한 줄 (예: 'P-0001 일시정지(즉시)') */
  label: string;
  projectId?: string | null;
  memberId?: string | null;
  taskId?: string | null;
  directiveId?: string | null;
  notify?: NavTarget;
  /**
   * 알림 키의 대상 — 작업·팀원·지시·프로젝트 ID가 없는 조작(역할·스킬·설정)이 대상마다 따로 알림을 받게 한다: 역할 ID, 스킬 이름, 바뀐 설정 항목 (리드 결정 S5-13).
   * 같은 키의 읽지 않은 알림은 새 내용으로 덮이므로, 없으면 그 도구의 조작이 모두 한 알림을 나눠 써 앞의 조작이 대표에게 닿지 않는다
   */
  subject?: string;
}

/** get_review_target의 긴급 지시 안내 (CTL-06) */
const URGENT_INSTRUCTIONS_NOTE =
  '메인 에이전트가 이 작업에 보낸 긴급 지시입니다(대표 명령을 전한 것일 수 있습니다). 긴급 지시는 완료 조건·프로듀서 지시보다 우선합니다 — 긴급 지시와 완료 조건이 다르면 긴급 지시를 기준으로 판정하세요 (CTL-06).';

/**
 * 앱 도구 요청 ID를 저장해도 되는 값으로 바꾼다 (SEC-10, AC-20). 요청 ID는 캐시 키·활동 기록·상태 전이·실행 기록의 키·병합 커밋
 * 기록에 그대로 남으므로, 비밀 값이 섞이지 않은 ID는 그대로 두고 섞였으면 원래 값의 해시(`rq-…`)로 바꾼다. 같은 원래 값은 늘
 * 같은 값이 되어 중복 판정은 그대로이고, 서로 다른 값이 같은 가림 표시로 겹쳐 서로의 중복으로 잘못 묶이지 않는다
 */
export function safeRequestId(redact: RedactorLike, raw: string): string {
  return redact.text(raw) === raw ? raw : `rq-${createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 24)}`;
}

/**
 * 도구 중복 캐시 키 (REV-04, AC-45). 메인 에이전트는 자리 세대를 넣는다 — 새 메인이 이전 메인과 같은 request_id를 써도 예전 결과를 받지 않고 실제로
 * 처리된다 (SERVER_DESIGN 4.3 '같이 고칠 것', 리드 결정 S4-4). 같은 세대 안에서는 예전처럼 한 번만 처리한다
 */
export function toolCacheKey(memberId: string, generation: number | null, tool: string, requestId: string): string {
  return generation === null ? `toolreq:${memberId}:${tool}:${requestId}` : `toolreq:${memberId}:g${generation}:${tool}:${requestId}`;
}

/** 도구 중복 캐시를 보관하는 기간 (리드 결정 S4-4) */
export const TOOL_CACHE_KEEP_MS = 7 * 24 * 3600_000;

/** 보관 기간이 지난 도구 중복 캐시를 지운다 — 지운 수 (시작 때와 6시간마다, orchestrator.ts의 정리) */
export function purgeToolCache(ctx: Ctx): number {
  return ctx.store.kv.purgeStamped('toolreq:', new Date(ctx.clock.ms() - TOOL_CACHE_KEEP_MS).toISOString());
}

const immediateStop = (s: ScopeStop | undefined): boolean => !!s?.paused && s.mode === 'immediate';

export class ToolHandlers {
  /** 처리 중인 요청 (kv 캐시와 같은 키) — 같은 request_id가 처리 중에 다시 오면 다시 실행하지 않고 그 결과를 기다린다 (CONC-08, ERR-07) */
  private readonly inflight = new Map<string, Promise<ToolCallResult>>();
  private mainApiCache: ApiHandlers | null = null;

  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  /** 옛 대표 메서드와 같은 처리기 — 행위자만 메인 에이전트 (SERVER_DESIGN 10.1 'core 함수는 지금 API가 부르는 것을 그대로, 행위자만 main') */
  private get mainApi(): ApiHandlers {
    this.mainApiCache ??= createApi(this.core, MAIN_AGENT_ID);
    return this.mainApiCache;
  }

  /**
   * 메인 도구 한 번을 위한 같은 처리기 묶음 — 처리기 안에서 상태를 바꾸기 전에 기다리는 것(스킬 찾기·CLI 확인)은 그 기다림 뒤에 부른 메인 턴·자리 세대를 다시
   * 본다 (callerRecheck, 리드 결정 S5-63). 기다림이 없는 처리기는 mainApi를 쓴다
   */
  private callerApi(identity: TokenIdentity, tool: string): ApiHandlers {
    return createApi(this.core, MAIN_AGENT_ID, { recheck: this.callerRecheck(identity, tool) });
  }

  /** 메인 에이전트 전용 운영 도구 — 도구 목록 공개는 역할로 거르지만(mcp/server.ts) 처리기도 호출자를 다시 본다 (SEC-01) */
  private requireMain(member: Member): void {
    if (!member.isMain) throw new BackendError('forbidden', '메인 에이전트만 쓸 수 있는 도구입니다');
  }

  /**
   * 메인 에이전트의 운영 조작 (SERVER_DESIGN 2.6): 사유가 있어야 하고, 처리한 뒤 사유를 활동 기록(행위자 M-MAIN)에 남기고, 눈에 띄는 조작
   * (일시정지·취소·역할·설정 등)은 대표에게 정보 알림을 보낸다. request_id 중복 제거와 정지 검사(assertNotStopped)는 handle·run이 이미 했다.
   * 처리가 거부되면 사유도 알림도 남기지 않는다 (앱 도구 서버가 '<도구> 거부'로 기록한다)
   */
  private async mainOp<T>(identity: TokenIdentity, member: Member, tool: string, a: Args, requestId: string | null, op: (result: T) => MainOp, fn: () => T | Promise<T>): Promise<T> {
    this.requireMain(member);
    const reason = str(a, 'reason').trim();
    if (!reason) throw new BackendError('invalid', 'reason(사유)을 적으세요 — 대표가 활동 기록과 알림에서 봅니다');
    const result = await fn();
    // 기록 한 줄은 처리한 뒤에 만든다 — 처리 결과(만든 역할 ID 등)를 쓸 수 있다
    const o = op(result);
    const ctx = this.ctx;
    ctx.activity({
      kind: o.kind,
      actor: MAIN_AGENT_ID,
      projectId: o.projectId ?? null,
      memberId: o.memberId ?? null,
      taskId: o.taskId ?? null,
      directiveId: o.directiveId ?? null,
      requestId,
      text: `메인 에이전트 ${o.label} (${tool}) — 사유: ${reason}`,
    });
    if (o.notify) ctx.notify({ level: 'info', title: '메인 에이전트 조작', body: `${o.label} — 사유: ${reason}`, link: o.notify, key: `main-op:${tool}:${o.subject ?? o.taskId ?? o.memberId ?? o.directiveId ?? o.projectId ?? ''}` });
    // 6.1의 상태를 바꾼 도구 호출은 메인 일지에 서버 기록(action)으로도 남는다 — 활동 기록과 같은 글 (S4b)
    if (JOURNAL_ACTION_TOOLS.has(tool)) {
      const refs: JournalRefRow[] = [
        ...(o.directiveId ? [{ kind: 'directive' as const, id: o.directiveId }] : []),
        ...(o.taskId ? [{ kind: 'task' as const, id: o.taskId }] : []),
        ...(o.memberId ? [{ kind: 'member' as const, id: o.memberId }] : []),
        ...(o.projectId ? [{ kind: 'project' as const, id: o.projectId }] : []),
      ];
      this.journalAction(identity, `${o.label} (${tool}) — 사유: ${reason}`, o.projectId ?? null, refs);
    }
    return result;
  }

  /** 메인이 상태를 바꾼 도구 호출 한 줄 (메인 일지 action, 6.1) — 그 턴의 세대·업무 세션으로 */
  private journalAction(identity: TokenIdentity, text: string, projectId: string | null, refs: JournalRefRow[]): void {
    this.core.journal.server('action', text, { projectId, refs, workKey: identity.sessionKey, turnId: identity.turnId, generation: identity.seatGeneration });
  }

  /**
   * 풀기 전 한 번 거부 (리드 결정 S5-45·S5-49·S5-50) — 메인이 아직 받지 않은 대기 항목이 있으면(find가 찾아 거부 글을 만든다) 그 글로 conflict 거부한다. 보인
   * 항목은 이 호출의 메인 턴에 싣고(메인 턴이 없는 신원이면 받아 마침, 그 턴이 기다리는 사이 이미 끝났으면 대기 그대로 — 리드 결정 S5-56), 거부한 호출을 메인
   * 일지에 서버 기록 한 줄로 남긴다 — 그 턴이 끊겨 새 세션·새 보유자가 이어도 인계 꾸러미가 그 거부를 보인다. 각 도구의 다른 거부를 모두 지난 뒤, 풀기 바로 전에 부른다
   */
  private refuseUnseen(identity: TokenIdentity, find: (carry: CarryShown) => UnseenRefusal | null): void {
    const r = find((entries) => this.core.turns.carryShown(identity.turnId, entries));
    if (!r) return;
    this.journalAction(identity, r.journal, r.projectId, r.refs);
    throw new BackendError('conflict', r.text);
  }

  /**
   * 운영 조작(mainOp)이 아닌 6.1의 메인 도구 — 처리한 뒤 결과로 일지 한 줄을 만든다 (S4b). 운영 조작은 mainOp 안에서 남긴다. 보고서 제출은 보고 도착(report)으로
   * ReportService가 남긴다
   */
  private journalAfter(identity: TokenIdentity, tool: string, a: Args, data: unknown): void {
    const ctx = this.ctx;
    const d = isRecord(data) ? data : {};
    const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
    const who = (id: string) => `${memberName(ctx, id)}(${id})`;
    const clipped = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
    const project = identity.projectId ?? this.projectOfMainSession(identity.sessionKey);
    switch (tool) {
      case 'register_directive': {
        const pid = str(a, 'project_id');
        return this.journalAction(identity, `지시 ${s('directiveId')} 등록 (${pid}): "${clipped(str(a, 'title'), 120)}" — ${clipped(str(a, 'text').replace(/\s+/g, ' '), 300)}`, pid, [
          { kind: 'directive', id: s('directiveId') },
          { kind: 'project', id: pid },
        ]);
      }
      case 'instruct_member': {
        const id = str(a, 'member_id');
        const m = ctx.store.members.get(id);
        const urgent = a.urgent === 'interrupt' ? '긴급 지시(지금 턴을 끊고)' : a.urgent === true ? '긴급 지시' : '지시';
        return this.journalAction(identity, `${who(id)}에게 ${urgent}: ${clipped(str(a, 'text').replace(/\s+/g, ' '), 400)}`, m?.projectId ?? project, [{ kind: 'member', id }]);
      }
      case 'add_member': {
        const id = s('memberId');
        const ai = isRecord(d.ai) ? (d.ai as unknown as AiConfig) : null;
        const reason = str(a, 'reason').trim();
        return this.journalAction(
          identity,
          `팀원 추가 ${who(id)} — 역할 ${str(a, 'role_id')}, ${ai?.kind ?? '?'} ${s('model') || 'CLI 기본 모델'}, 노력치 ${s('effort')}${reason ? ` — 사유: ${reason}` : ''}`,
          str(a, 'project_id') || null,
          [
            { kind: 'member', id },
            { kind: 'project', id: str(a, 'project_id') },
          ],
        );
      }
      case 'remove_member': {
        const id = str(a, 'member_id');
        return this.journalAction(identity, `팀원 삭제 ${ctx.store.members.get(id)?.name ?? id}(${id})`, ctx.store.members.get(id)?.projectId ?? null, [{ kind: 'member', id }]);
      }
      case 'replace_member': {
        const id = str(a, 'member_id');
        const pid = ctx.store.members.get(id)?.projectId ?? null;
        return this.journalAction(
          identity,
          `직원 교체 ${s('retiredName')}(${id}) 퇴직 → ${who(s('memberId'))} 채용 — ${isRecord(d.ai) ? String(d.ai.kind) : '?'} ${s('model') || 'CLI 기본 모델'}, 노력치 ${s('effort')} — 사유: ${str(a, 'reason')}`,
          pid,
          [
            { kind: 'member', id: s('memberId') },
            { kind: 'member', id },
          ],
        );
      }
      case 'set_member_ai': {
        const id = str(a, 'member_id');
        const ai = isRecord(d.pendingAi) ? (d.pendingAi as unknown as AiConfig) : isRecord(d.ai) ? (d.ai as unknown as AiConfig) : null;
        return this.journalAction(
          identity,
          `${who(id)}의 AI → ${ai?.kind ?? '?'} ${s('model') || 'CLI 기본 모델'}, 노력치 ${s('effort')}${d.appliesAfterCurrentTask ? ' (지금 작업을 마친 뒤 적용)' : ''} — 사유: ${str(a, 'reason')}`,
          ctx.store.members.get(id)?.projectId ?? null,
          [{ kind: 'member', id }],
        );
      }
      case 'create_project':
        return this.journalAction(identity, `프로젝트 등록 ${s('projectId')} ${s('name')}`, s('projectId') || null, [{ kind: 'project', id: s('projectId') }]);
      case 'ask_owner':
        return this.journalAction(identity, `대표에게 질문 ${s('questionId')}: ${clipped(str(a, 'question').replace(/\s+/g, ' '), 400)}`, ctx.store.questions.get(s('questionId'))?.projectId ?? project, [
          { kind: 'question', id: s('questionId') },
        ]);
      case 'submit_review': {
        // 메인이 검수자로 낸 판정 (6.1 '메인 검수 판정')
        const t = ctx.store.tasks.get(str(a, 'task_id'));
        if (!t || d.duplicate === true) return;
        return this.journalAction(identity, `메인 검수 판정 ${t.id} "${clipped(t.title, 80)}": ${s('verdict') === 'pass' ? '통과' : '반려'}${str(a, 'reason') ? ` — ${clipped(str(a, 'reason').replace(/\s+/g, ' '), 300)}` : ''}`, t.projectId, [
          { kind: 'task', id: t.id },
        ]);
      }
      case 'hand_off_seat':
        return this.journalAction(
          identity,
          d.sameGeneration === true
            ? `메인 자리 모델·노력치 변경 요청 (${s('to')}, 세대 ${String(d.generation)} 그대로) — 사유: ${str(a, 'reason')}`
            : `메인 자리를 ${s('to')}에게 넘기기로 함 (세대 ${String(d.generation)}부터, 이 턴을 마치면 넘어감) — 사유: ${str(a, 'reason')}${str(a, 'note') ? ` / 남긴 말: ${clipped(str(a, 'note').replace(/\s+/g, ' '), 300)}` : ''}`,
          null,
          [],
        );
    }
  }

  handle = async (identity: TokenIdentity, tool: string, args: Args): Promise<ToolCallResult> => {
    const ctx = this.ctx;
    // 메인 자리가 받지 않는 세대의 메인 토큰은 처리하지 않는다 — 자리가 바뀐 뒤 이전 보유자의 늦은 요청이다 (리드 결정 S4-4). 캐시보다 먼저 본다
    if (identity.isMain && identity.seatGeneration !== undefined && !this.core.seat.acceptsGeneration(identity.seatGeneration)) return this.seatChanged(identity, tool);
    // 요청 ID·캐시 키는 원래 인자로 정하되, 비밀 값이 섞인 ID는 원래 값의 해시로 바꿔 저장한다 (safeRequestId — 같은 원래 값이면 같은 키)
    const rawRequestId = optStr(args, 'request_id') ?? null;
    const requestId = rawRequestId === null ? null : safeRequestId(ctx.redact, rawRequestId);
    const generation = identity.isMain ? (identity.seatGeneration ?? this.core.seat.generation()) : null;
    const cacheKey = requestId ? toolCacheKey(identity.memberId, generation, tool, requestId) : null;
    if (!cacheKey) return this.run(identity, tool, args, null, null);
    const cached = ctx.store.kv.get<{ data: unknown }>(cacheKey) ?? this.legacyMainCache(identity, generation, tool, requestId!);
    if (cached) return { ok: true, data: { ...(cached.data as object), duplicateRequest: true } };
    const running = this.inflight.get(cacheKey);
    if (running) {
      const r = await running;
      return r.ok ? { ok: true, data: { ...(r.data as object), duplicateRequest: true } } : r;
    }
    // 확인과 등록 사이에 await가 없다 — 동시에 온 같은 요청 중 하나만 실행된다
    const p = this.run(identity, tool, args, requestId, cacheKey);
    this.inflight.set(cacheKey, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(cacheKey);
    }
  };

  /**
   * 4단계 이전 판이 남긴 메인 캐시 (리드 결정 S4-21) — 1세대는 그 판의 키(세대 없는 'toolreq:M-MAIN:<도구>:<요청ID>')도 본다. 업그레이드 전에 처리한 요청을 끊긴
   * 턴이 같은 request_id로 다시 보내도 두 번 처리하지 않는다 (AC-45). 보관 기간(7일 — 옮길 때 적은 때부터) 안의 것만 본다. 새로 쓰는 것은 늘 세대가 든 키다.
   * 옮긴 DB에만 있는 키다 — 4판부터 메인의 키에는 늘 세대가 들어, 새 DB에는 이 꼴의 메인 키가 생기지 않는다
   */
  private legacyMainCache(identity: TokenIdentity, generation: number | null, tool: string, requestId: string): { data: unknown } | null {
    if (!identity.isMain || generation !== 1) return null;
    const old = this.ctx.store.kv.get<{ data: unknown; at?: unknown }>(toolCacheKey(identity.memberId, null, tool, requestId));
    if (!old || typeof old.at !== 'string' || !(Date.parse(old.at) >= this.ctx.clock.ms() - TOOL_CACHE_KEEP_MS)) return null;
    return old;
  }

  /** 이전 세대의 메인 토큰 (리드 결정 S4-4) — 처리하지 않고 seat_changed로 답하고 활동 기록에 남긴다 */
  private seatChanged(identity: TokenIdentity, tool: string): ToolCallResult {
    return { ok: false, code: 'seat_changed', message: this.seatChangedText(identity, tool) };
  }

  /**
   * seat_changed의 글과 활동 기록 한 줄 (리드 결정 S4-4) — 부를 때(handle)와 처리 중 기다림 뒤(callerRecheck, 리드 결정 S5-63)가 같은 글을 쓴다. late: 기다림 뒤에
   * 알았다 — 활동 기록에 그 사실을, already: 거부할 때 이미 한 일(거부 글이 참이게)
   */
  private seatChangedText(identity: TokenIdentity, tool: string, late = false, already?: string): string {
    const now = this.core.seat.generation();
    this.ctx.activity({
      kind: 'seat',
      level: 'warn',
      actor: identity.memberId,
      memberId: identity.memberId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      // 기다림 뒤 거부면 이미 한 일도 같은 글로 남긴다 — 대표가 보는 기록이 그 결과를 사실대로 (리드 결정 S5-73 3)
      text: `이전 세대(${identity.seatGeneration}) 메인 토큰의 도구 요청을 거부함: ${tool}${late ? ' (처리하며 기다리는 사이 자리가 바뀜)' : ''} — 지금 메인 자리는 세대 ${now}입니다${already ? ` (${already})` : ''}`,
    });
    return `메인 자리가 바뀌었습니다 (이 턴은 세대 ${identity.seatGeneration}, 지금은 세대 ${now}) — 이 요청(${tool})은 처리하지 않았습니다. 지금 턴을 마치세요${already ? ` (${already})` : ''}`;
  }

  /**
   * 기다림 뒤 부른 쪽 다시 보기 (리드 결정 S5-63) — 메인 도구 처리기는 부를 때만 자리 세대(handle)와 정지(run)를 본다. 처리 중에 기다리면(프로듀서 교체의 정지 확인,
   * 복구 확인의 git.log, 스킬 찾기, CLI 확인, 프로젝트 등록의 연결 지점 검사, 서버 명령의 러너 준비) 그사이 자리가 바뀌거나 부른 메인 턴이 끝날 수 있다 — 그대로
   * 이어 가면 없는 CLI를 위해 조직을 바꾼다. 그래서 그 기다림 뒤, 처음 상태를 바꾸기 전에 부른다: 이 호출을 받은 세대를 자리가 더는 받지 않으면 S4-4의
   * seat_changed, 아니면 부른 메인 턴이 끝났거나(마무리 시작 포함) 즉시 종료 요청을 받았으면 stopped로 거부하고 더 바꾸지 않는다. 운영자·시험 신원(세대·메인 턴
   * 기록이 없음)은 다시 보지 않는다. already: 거부할 때 이미 한 일 — 거부 글과 활동 기록이 참이게 (프로듀서 교체는 이미 그 턴을 멈췄다). 거부할 때만 부르는 함수로도
   * 받는다 — 프로듀서 교체는 거부할 때만 멈춘 일을 다시 맡기고 그 뒤의 사실을 적는다 (리드 결정 S5-73 2·3).
   * turn: false면 세대만 본다 — 서버 명령은 턴을 제 글로 다시 본다(hostExec.run의 '이 턴의 종료 요청 뒤에는 …')
   */
  private callerRecheck(identity: TokenIdentity, tool: string, turn = true): (already?: string | (() => string)) => void {
    return (given) => {
      if (!identity.isMain) return;
      const already = (): string | undefined => (typeof given === 'function' ? given() : given);
      // 부를 때(handle)와 같은 판정 — 교체 중에는 나가는 세대도 받는다(마무리 기다림·인계 메모 턴). 강제 교체는 그 턴을 멈추므로 아래 턴 판정이 거부한다
      if (identity.seatGeneration !== undefined && !this.core.seat.acceptsGeneration(identity.seatGeneration)) {
        throw new BackendError('seat_changed', this.seatChangedText(identity, tool, true, already()));
      }
      if (!turn || !this.core.turns.mainCallerGone(identity.turnId)) return;
      const done = already();
      this.ctx.activity({
        kind: 'system',
        level: 'warn',
        actor: identity.memberId,
        memberId: identity.memberId,
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        text: `메인 턴 ${identity.turnId}이(가) 처리하며 기다리는 사이 끝났거나 종료 요청을 받아 ${tool}을(를) 마치지 않음${done ? ` — ${done}` : ''}`,
      });
      throw new BackendError('stopped', `처리하며 기다리는 사이 이 턴이 끝났거나 종료 요청을 받아 ${tool}은(는) 처리하지 않았습니다. 지금 턴을 마치세요${done ? ` (${done})` : ''}`);
    };
  }

  /** 실제 처리. 거부하지 않고 결과로 돌려준다 (같은 요청을 기다리는 쪽도 같은 결과를 받게) */
  private async run(identity: TokenIdentity, tool: string, args: Args, requestId: string | null, cacheKey: string | null): Promise<ToolCallResult> {
    const ctx = this.ctx;
    try {
      const member = memberOrThrow(ctx, identity.memberId);
      if (member.deletedAt) throw new BackendError('forbidden', '삭제된 팀원입니다');
      // 메인 자리가 넘어가는 중인 인계 메모 턴은 일지·기억 쓰기와 조회만 한다 (SERVER_DESIGN 4.3 3번, S4b)
      if (identity.isMain && !MEMO_TURN_TOOLS.has(tool) && this.core.seat.isMemoTurn(identity.turnId)) {
        throw new BackendError('forbidden', `인계 메모 턴에는 journal_write·write_memory와 조회 도구만 쓸 수 있습니다 — 메인 자리가 넘어가는 중이라 ${tool}은(는) 처리하지 않았습니다. 다 적었으면 턴을 마치세요`);
      }
      // 화면 도구는 처리기가 정한 순서(모양 → 정지)로 본다 (리드 결정 S6-6)
      if (!SCREEN_TOOLS.has(tool)) this.assertNotStopped(identity, member, tool);
      // 에이전트가 넘긴 인자는 처리기가 저장하기 전에 한 번에 가린다 — 질문·지시·보고서 제목·작업 내용·메시지가 원문으로
      // DB·스냅샷·백업에 남지 않게 (SEC-10, AC-20). 깊은 복사이고 숫자·참거짓·배열 모양은 그대로, 여러 번 가려도 같다
      const safeArgs = ctx.redact.value(args);
      // host_exec는 원래 명령이 있어야 한다 — 가린 명령을 실행하면 다른 명령이 돈다. 처리기는 가린 글과 원문이 다른 명령(비밀 값이 든 명령)을 거부하므로 실행하는
      // 명령은 기록에 남는 글과 같다 (리드 결정 S5-17). 그 밖의 인자(purpose)는 가린 값을 쓴다
      let images: ToolImage[] | undefined;
      let data: unknown;
      if (tool === 'host_exec') data = await this.core.hostExec.run(identity, member, args, safeArgs, requestId, this.callerRecheck(identity, tool, false));
      else if (SCREEN_TOOLS.has(tool)) {
        if (!member.isMain) throw new BackendError('forbidden', '메인 에이전트만 쓸 수 있는 도구입니다');
        // args: 앱 도구 서버가 기록(onCall)에도 넘긴 원래 인자 개체 — 처리기가 '닿았다'는 표시를 여기에 한다 (가린 사본에 하면 onCall이 알아보지 못한다, S6-21 E1)
        const out = await this.screenTool(identity, member, tool, RAW_ARG_TOOLS.has(tool) ? args : safeArgs, requestId, args);
        data = out.data;
        images = out.images;
      } else data = await this.dispatch(identity, member, tool, safeArgs, requestId);
      // 메인이 상태를 바꾼 도구 호출은 메인 일지에 남는다 (6.1) — 일지를 남기지 못해도 처리한 결과는 그대로 돌려준다
      if (member.isMain && JOURNAL_ACTION_TOOLS.has(tool) && !MAIN_OP_JOURNALED.has(tool)) {
        try {
          this.journalAfter(identity, tool, safeArgs, data);
        } catch (e) {
          ctx.log('warn', `메인 일지에 ${tool} 기록을 남기지 못했습니다`, e);
        }
      }
      // 완료 전에 캐시를 남긴다 — 처리가 끝난 뒤 온 같은 요청은 캐시로 답한다. 남긴 때(at)로 7일 뒤 지운다 (S4-4). 이미지는 남기지 않는다 — 같은 요청에는
      // 글만 간다 (리드 결정 S6-6)
      if (cacheKey) ctx.store.kv.set(cacheKey, { data, at: ctx.now() });
      return images?.length ? { ok: true, data, images } : { ok: true, data };
    } catch (e) {
      // 거부·오류 글은 CLI(와 모델 문맥)로 가기 전에 가린다 — 원래 인자(host_exec)나 바깥 오류를 되풀이하는 글이 있어도 비밀 값이 나가지 않게 (리드 결정 S5-31)
      if (e instanceof BackendError) {
        // 거부 코드는 계약 목록 하나에서 (리드 결정 S6-3) — 모르는 코드는 error
        const code = TOOL_FAILURE_CODES.find((c) => c === e.code) ?? 'error';
        return { ok: false, code, message: ctx.redact.text(e.message) };
      }
      ctx.log('error', `앱 도구 처리 오류 ${tool}`, e);
      return { ok: false, code: 'error', message: ctx.redact.text(`처리 중 오류: ${e instanceof Error ? e.message : String(e)}`) };
    }
  }

  /** 화면 조작 도구 다섯 개 (desktop/service.ts) — 정지 검사와 기다림 뒤 다시 보기를 넘긴다 */
  private screenTool(identity: TokenIdentity, member: Member, tool: string, a: Args, requestId: string | null, callArgs: Args): Promise<{ data: unknown; images?: ToolImage[] }> {
    const desktop = this.core.desktop;
    const guards = { assertNotStopped: () => this.assertNotStopped(identity, member, tool), recheck: this.callerRecheck(identity, tool) };
    switch (tool) {
      case 'screen_capture':
        return desktop.capture(identity, member, a, guards, callArgs);
      case 'screen_info':
        return desktop.info(identity, member, a, guards);
      case 'gui_input':
        return desktop.input(identity, member, a, requestId, guards);
      case 'get_screen_check':
        this.assertNotStopped(identity, member, tool);
        return desktop.getCheck(identity, member);
      default:
        this.assertNotStopped(identity, member, tool);
        return desktop.answerCheck(identity, member, a);
    }
  }

  /**
   * 메인 자리 넘기기 (hand_off_seat — SERVER_DESIGN 4.3, 리드 결정 S4-3): 지금 메인만, 운영자가 정한 보유자 목록(seat.holders) 안에서 지금 쓸 수 있는
   * 보유자(설치되고 로그인된 CLI, 또는 운영자가 등록하고 폐기하지 않은 외부 에이전트 — 리드 결정 S7-4)에게. 바꾸는 것은 SeatService.assign이고, 이 턴이
   * 끝나면 넘어간다. 같은 종류에서 모델·노력치만 바꾸면 세대 그대로 다음 턴부터. 외부 에이전트의 이름은 등록 기록에서 온다(assign이 찾는다). 데스크톱 앱은
   * 외부 에이전트에게 넘기지 않는다 (S7-1)
   */
  private handOffSeat(identity: TokenIdentity, member: Member, a: Args): Record<string, unknown> {
    this.requireMain(member);
    const reason = str(a, 'reason').trim();
    if (!reason) throw new BackendError('invalid', 'reason(넘기는 까닭)을 적으세요 — 대표가 자리 이력과 알림에서 봅니다');
    const to = str(a, 'to').trim();
    const spec = parseHolderSpec((AI_KINDS as readonly string[]).includes(to) ? `launched:${to}` : to);
    if (!spec || spec.kind === 'any_external') throw new BackendError('invalid', "to에는 'claude'나 'codex'(또는 'launched:claude'·'launched:codex')를 넣으세요. 외부 에이전트는 'external:<ID>'입니다");
    let holder: SeatHolder;
    // 이름은 등록 기록에서 (리드 결정 S7-4) — 등록되지 않은 ID면 ID 그대로(assign이 거부한다)
    if (spec.kind === 'external') holder = { kind: 'external', agentId: spec.agentId, label: this.core.externalAgents.get(spec.agentId)?.label ?? spec.agentId };
    else {
      const cur = this.core.seat.launchedAi() ?? this.ctx.settings().general.mainAgent;
      // 같은 종류면 지금 설정에서, 다른 종류면 모델·노력치 값 없이 지금 노력치 단계로 시작한다 — 넘긴 칸만 바꾼다
      const base: AiConfig = cur.kind === spec.ai ? cur : { kind: spec.ai, model: null, effortTier: cur.effortTier, effortOverride: null };
      const ai = this.core.team.mainSeatAi(base, {
        model: a.model === null ? null : optStr(a, 'model'),
        effortTier: optStr(a, 'effort_tier') as EffortTier | undefined,
        effortOverride: a.effort === null ? null : optStr(a, 'effort'),
      });
      holder = { kind: 'launched', ai };
    }
    const r = this.core.seat.assign({ holder, by: 'main', reason, note: optStr(a, 'note') ?? null, callerTurnId: identity.turnId });
    const label = holderLabel(holder);
    if (r.outcome === 'same') {
      return { generation: r.generation, to: label, sameGeneration: true, message: `보유자는 그대로 ${label}이고 모델·노력치만 바꿨습니다. 세대 ${r.generation} 그대로, 다음 턴부터 적용됩니다` };
    }
    return { generation: r.generation, to: label, sameGeneration: false, message: '이 턴을 마치면 넘어갑니다. 남길 말은 journal_write로 적으세요' };
  }

  private requireTaskSession(identity: TokenIdentity, member: Member): Task {
    if (identity.sessionKind !== 'task') throw new BackendError('forbidden', '작업 세션에서만 쓸 수 있는 도구입니다');
    const task = taskOrThrow(this.ctx, parseKey(identity.sessionKey).ref);
    if (task.assigneeId !== member.id) throw new BackendError('forbidden', `작업 ${task.id}의 담당자가 아닙니다`);
    return task;
  }

  private requireProducerProject(member: Member, projectId: string): void {
    if (!member.isProducer || member.projectId !== projectId) throw new BackendError('forbidden', '이 프로젝트의 프로듀서만 할 수 있습니다');
  }

  /**
   * 정지 종류 검사 — 처리기에 들어가기 전에 한 곳에서 (AC-19 '정지 중 실행 요청은 앱 도구에서 거부·기록', 9장, CTL-09). 조회 도구는 늘 받는다.
   * 1) 긴급 정지·프로젝트/팀원 일시정지 중에는 상태를 바꾸는 도구를 받지 않는다. 단계 마치고 정지(기본 일시정지)의 마무리인 complete_step만
   *    처리기로 넘기고, 그 처리기가 정지 종류를 다시 본다 (assertStepWrapUp — 즉시 정지·정지가 아닌 보류 뒤에는 커밋하지 않음)
   * 2) 이 턴에 즉시 종료 요청이 있으면 그 턴의 상태 변경 요청은 받지 않는다 — 중단·긴급 정지·즉시 일시정지·시간 상한·응답 없음·헛돌기·
   *    긴급 지시 즉시 전달·질문 뒤 마침 등 (TurnRunner.terminate가 process.stopMode='immediate'를 바로 저장한다). 종료 확인(최대 2.8초) 동안
   *    CLI와 턴 토큰이 살아 있어 그 사이 질문·막힘 보고·충돌 해결 보고(프로그램 커밋)·제출·판정이 프로듀서 업무나 커밋을 만들던 길이다
   * 3) 이 작업·검수 세션의 작업이 중단·긴급 정지로 보류됐으면 받지 않는다 — 정지 선택을 실행 종료보다 먼저 저장하므로(CTL-08) 그 사이에 온 요청
   * 거부는 앱 도구 서버가 '<도구> 거부'로 기록한다. 변경 중이던 파일은 작업 폴더에 남아 재개 때 이어진다
   */
  private assertNotStopped(identity: TokenIdentity, member: Member, tool: string): void {
    if (READ_ONLY_TOOLS.has(tool)) return;
    const ctx = this.ctx;
    const stop = ctx.stop();
    const { kind, ref } = parseKey(identity.sessionKey);
    const task = kind === 'task' || kind === 'review' ? ctx.store.tasks.get(ref) : null;
    // 프로젝트 소속이 없는 메인 에이전트도 검수 세션(review:T)에서는 그 작업의 프로젝트 정지를 따른다 (REV-06 v0.6 메인 대체 검수)
    const projectId = member.projectId ?? task?.projectId ?? null;
    const paused = stop.global.active || (projectId && stop.projects[projectId]?.paused) || stop.members[member.id]?.paused;
    if (paused && tool !== 'complete_step') {
      // 어떤 정지인지 함께 알린다 — 긴급 정지는 대표만 풀고, 일시정지는 메인 에이전트가 푼다 (SERVER_DESIGN 2.2·2.6). 메인 에이전트 자신의 일시정지는
      // 대표의 정지 해제가 푼다 (리드 결정 6 — 정지된 메인은 턴이 뜨지 않는다)
      const which = stop.global.active ? '긴급 정지' : stop.members[member.id]?.paused ? '팀원 일시정지' : '프로젝트 일시정지';
      throw new BackendError('stopped', `${which} 중에는 이 도구를 쓸 수 없습니다. 턴을 마치세요`);
    }
    const held = task?.state === 'on_hold' ? task.hold.reasons.filter((r) => r.kind === 'interrupted' || r.kind === 'emergency_stop') : [];
    const why =
      ctx.store.turns.get(identity.turnId)?.process.stopMode === 'immediate'
        ? '이 턴의 종료 요청(중단·긴급 정지·즉시 일시정지·감시·긴급 지시 즉시 전달 등)'
        : held.length
          ? `작업 ${ref} 보류(${[...new Set(held.map((r) => HOLD_REASON_LABEL[r.kind]))].join(', ')})`
          : null;
    if (why) throw new BackendError('stopped', `${why} 뒤에는 이 턴의 요청(${tool})을 받지 않습니다. 지금 턴을 마치세요 — 재개되면 다음 턴에서 이어집니다`);
  }

  /**
   * 정지 중 단계 완료(프로그램 커밋)는 '단계 마치고 정지'(기본 일시정지)의 마무리로만 받는다 (9장 "[즉시]는 바로 종료", CTL-03, AC-19).
   * 긴급 정지·즉시 일시정지·이 턴의 즉시 종료 요청(중단·감시 등)·정지가 아닌 보류 뒤에는 커밋하지 않는다 — 종료 확인 중에도 CLI와
   * 턴 토큰이 잠깐 살아 있으므로 정지 상태만이 아니라 정지 종류와 이 턴의 정지 요청까지 본다. 변경은 작업 폴더에 남아 재개 때 이어진다
   */
  private assertStepWrapUp(identity: TokenIdentity, member: Member, task: Task): void {
    const ctx = this.ctx;
    const stop = ctx.stop();
    const heldOtherThanPause = task.state === 'on_hold' ? task.hold.reasons.filter((r) => !(r.kind === 'paused' && (r.scope === 'project' || r.scope === 'member'))) : [];
    const why = stop.global.active
      ? '긴급 정지'
      : immediateStop(stop.projects[task.projectId])
        ? '프로젝트 즉시 일시정지'
        : immediateStop(stop.members[member.id])
          ? '팀원 즉시 일시정지'
          : ctx.store.turns.get(identity.turnId)?.process.stopMode === 'immediate'
            ? '이 턴의 종료 요청'
            : heldOtherThanPause.length
              ? `작업 보류(${[...new Set(heldOtherThanPause.map((r) => HOLD_REASON_LABEL[r.kind]))].join(', ')})`
              : null;
    if (why) throw new BackendError('stopped', `${why} 뒤에는 단계를 완료(커밋)하지 않습니다. 변경은 작업 폴더에 남아 재개 때 이어집니다. 지금 턴을 마치세요`);
  }

  /**
   * 검수 도구(대상 조회·판정)는 그 작업의 검수 세션(review:<작업>) 토큰으로만 (CLI-03 고정된 검수 사본, 5.7 관리 업무는 별도 업무 세션,
   * CLI-08 세션 토큰·업무 배정 재확인, AC-32). 자격(배정·역할·작업자 아님)을 먼저 보고 세션을 본다 — 자격 거부 사유가 그대로 남게
   */
  private requireReviewTool(identity: TokenIdentity, member: Member, task: Task, prefix = ''): void {
    const ok = canSubmitReview(member, roleOf(this.ctx, member.roleId), task);
    if (!ok.ok) throw new BackendError('forbidden', `${prefix}${ok.reason}`);
    if (identity.sessionKind !== 'review' || parseKey(identity.sessionKey).ref !== task.id) {
      throw new BackendError('forbidden', `${prefix}작업 ${task.id}의 검수 세션(review:${task.id})에서만 검수 대상 조회·판정을 할 수 있습니다 (지금 세션: ${identity.sessionKey})`);
    }
  }

  /**
   * 검수 세션의 질문: 지금도 그 작업의 검수자이고 작업이 검수 단계일 때만 (CLI-08·SEC-01 배정·상태 재확인, AC-32). 검수자가 바뀐 뒤
   * 종료 확인 중인 이전 검수 턴이 보낸 질문으로 작업이 답변 대기로 보류되면 새 검수자가 판정하지 못한다
   */
  private requireAssignedReviewer(identity: TokenIdentity, member: Member): Task {
    const task = taskOrThrow(this.ctx, parseKey(identity.sessionKey).ref);
    if (task.reviewerId !== member.id) throw new BackendError('forbidden', `작업 ${task.id}의 검수자로 배정되지 않았습니다`);
    const reviewing = task.state === 'in_review' || (task.state === 'on_hold' && task.hold.returnState === 'in_review');
    if (!reviewing) throw new BackendError('conflict', `작업 ${task.id}은(는) 검수 상태가 아닙니다 (${task.state})`);
    return task;
  }

  private async dispatch(identity: TokenIdentity, member: Member, tool: string, a: Args, requestId: string | null): Promise<unknown> {
    const ctx = this.ctx;
    const core = this.core;
    if (MAIN_OPS_TOOLS.has(tool)) this.requireMain(member);
    switch (tool) {
      // ───── 공통 ─────
      case 'get_work_context':
        return this.workContext(identity, member);
      case 'send_message':
        return this.sendMessage(identity, member, str(a, 'to'), str(a, 'text'), requestId);

      // ───── 메인 에이전트 ─────
      case 'list_projects':
        return ctx.store.projects.list({ state: 'active' }).map((p) => {
          const view = core.views.projectView(p);
          return { id: p.id, name: p.name, path: p.path, activeDirectives: view.activeDirectiveCount, progress: view.progress, paused: view.paused, members: view.memberStatusCounts };
        });
      case 'get_project_status': {
        const p = projectOrThrow(ctx, str(a, 'project_id'));
        const directives = ctx.store.directives.list({ project_id: p.id }).slice(-10);
        return {
          project: { id: p.id, name: p.name, path: p.path, baseBranch: p.baseBranch, checkCommands: p.checkCommands, mock: p.mock.enabled },
          team: this.team(p.id),
          directives: directives.map((d) => ({ id: d.id, title: d.title, state: d.state, round: d.round, tasks: directiveTasks(ctx, d.id, d.round).map((t) => ({ id: t.id, title: t.title, state: t.state, assigneeId: t.assigneeId })) })),
          recentReports: ctx.store.reports.list({ project_id: p.id }, { desc: true, limit: 5 }).map((r) => ({ id: r.id, title: r.title, status: r.status, createdAt: r.createdAt })),
        };
      }
      case 'create_project': {
        // 폴더를 만들거나 git을 건드리기 전의 기다림(연결 지점 검사 등) 뒤마다 부른 메인 턴·자리 세대를 다시 본다 (리드 결정 S5-63)
        const p = await core.projects.create({ name: str(a, 'name'), path: str(a, 'path'), mode: str(a, 'mode') === 'new' ? 'new' : 'existing' }, MAIN_AGENT_ID, { recheck: this.callerRecheck(identity, tool) });
        return { projectId: p.id, name: p.name, producerId: p.producerId, baseBranch: p.baseBranch };
      }
      case 'add_member': {
        const m = core.team.add(
          {
            projectId: str(a, 'project_id'),
            roleId: str(a, 'role_id'),
            name: optStr(a, 'name'),
            ai: {
              kind: optStr(a, 'ai_kind') as AiKind | undefined,
              model: optStr(a, 'model'),
              effortTier: optStr(a, 'effort_tier') as EffortTier | undefined,
              effortOverride: optStr(a, 'effort'),
            },
            reason: optStr(a, 'reason'),
          },
          MAIN_AGENT_ID,
        );
        return { memberId: m.id, name: m.name, ...nameNote(optStr(a, 'name'), m.name), ai: m.ai, model: core.team.modelValue(m.ai), effort: core.team.effortValue(m.ai) };
      }
      case 'list_ai_options': {
        const s = ctx.settings();
        const pid = optStr(a, 'project_id');
        const members = ctx.store.members.list({ state: 'active' }).filter((m) => !m.isMain && (!pid || m.projectId === pid));
        return {
          effortLevels: EFFORT_LEVELS,
          effortTierMapping: s.team.effortMapping,
          models: s.team.modelCatalog ?? { claude: [], codex: [] },
          // 채용할 때 보는 안내 — 노력치가 무엇이고 왜 중요한지, 고르는 차례. 모델마다의 장점은 models의 note에 있다 (aiGuide.ts, 대표 지시 2026-11-18)
          guide: { effort: EFFORT_GUIDE, hiring: HIRING_GUIDE },
          // 모델을 정하지 않았을 때(model null) 실제로 쓰는 모델 (windows:F1, 19.1)
          defaultModels: { claude: core.team.defaultModel('claude'), codex: core.team.defaultModel('codex') },
          // 걸려 있는 사용량 한도: until은 그 AI 종류 전체, models는 모델별 주간 한도(계열 → 기한). 모델별 한도는 그 계열 모델(정하지 않은 모델 포함)의
          // 턴만 막는다 — 팀원에게 다른 계열 모델을 정하면 새 세션부터 돈다 (리드 결정 22)
          usageLimits: Object.fromEntries(
            (['claude', 'codex'] as const).map((k) => {
              const st = ctx.ai(k);
              const now = ctx.clock.ms();
              const until = st.usageLimitedUntil && Date.parse(st.usageLimitedUntil) > now ? st.usageLimitedUntil : null;
              return [k, { until, models: Object.fromEntries(activeModelLimits(st, now).map((x) => [x.family, x.until])) }];
            }),
          ),
          members: members.map((m) => ({
            memberId: m.id,
            name: m.name,
            projectId: m.projectId,
            roleId: m.roleId,
            roleName: roleOf(ctx, m.roleId)?.name ?? m.roleId,
            ai: m.ai,
            model: core.team.modelValue(m.ai),
            effort: core.team.effortValue(m.ai),
            pendingAi: m.pendingAi,
            decidedBy: m.aiDecision ? memberName(ctx, m.aiDecision.by) : null,
            reason: m.aiDecision?.reason ?? null,
          })),
        };
      }
      case 'set_member_ai': {
        const m = core.team.setAiByMain(
          str(a, 'member_id'),
          {
            kind: optStr(a, 'ai_kind') as AiKind | undefined,
            model: a.model === null ? null : optStr(a, 'model'),
            effortTier: optStr(a, 'effort_tier') as EffortTier | undefined,
            effortOverride: a.effort === null ? null : optStr(a, 'effort'),
          },
          str(a, 'reason'),
        );
        // 진행 중 세션은 첫 턴의 모델·노력치를 끝까지 쓴다 (19.1) — 어떤 세션이 이전 설정으로 남는지 알려 준다
        const kept = core.team.sessionsKeepingPrevious(m, m.pendingAi ?? m.ai);
        const next = m.pendingAi ?? m.ai;
        return {
          memberId: m.id,
          ai: m.ai,
          pendingAi: m.pendingAi,
          model: core.team.modelValue(next),
          effort: core.team.effortValue(next),
          appliesAfterCurrentTask: !!m.pendingAi,
          ...(kept.length ? { openSessionsKeepPreviousAi: kept } : {}),
        };
      }
      case 'remove_member':
        // 이미 삭제된 팀원은 다시 지우지 않고 그 사실을 알린다 — 교체된 프로듀서면 지금 프로듀서도 (리드 결정 S5-74)
        liveMemberOrThrow(ctx, str(a, 'member_id'));
        core.team.remove(str(a, 'member_id'), MAIN_AGENT_ID);
        return { removed: str(a, 'member_id') };
      case 'replace_member': {
        // 직원 교체 — 퇴직 → 채용 → 인수인계 (대표 지시 2026-11-18). 한 번 정한 직원의 AI는 바꿀 수 없으므로 다른 모델·노력치가 필요할 때의 길이다
        const r = core.team.replaceMember(str(a, 'member_id'), {
          name: optStr(a, 'name'),
          roleId: optStr(a, 'role_id'),
          ai: {
            kind: optStr(a, 'ai_kind') as AiKind | undefined,
            model: optStr(a, 'model'),
            effortTier: optStr(a, 'effort_tier') as EffortTier | undefined,
            effortOverride: optStr(a, 'effort'),
          },
          reason: str(a, 'reason'),
          handover: optStr(a, 'handover') === 'skip' ? 'skip' : 'ask',
        });
        return {
          status: 'replaced',
          retiredMemberId: r.retired.id,
          retiredName: r.retired.name,
          memberId: r.hired.id,
          name: r.hired.name,
          ...nameNote(optStr(a, 'name'), r.hired.name),
          ai: r.hired.ai,
          model: core.team.modelValue(r.hired.ai),
          effort: core.team.effortValue(r.hired.ai),
          tasks: r.tasks,
        };
      }
      case 'register_directive': {
        const d = core.directives.register({ projectId: str(a, 'project_id'), title: str(a, 'title'), text: str(a, 'text'), attachmentIds: arr(a, 'attachment_ids') }, MAIN_AGENT_ID, requestId);
        return { directiveId: d.id, state: d.state, message: `지시 ${d.id}을(를) 등록해 프로듀서에게 전달했습니다.` };
      }
      case 'instruct_member': {
        // 긴급 지시(urgent: true | 'interrupt')는 옛 대표 직접 메시지의 전달 보장을 잇는다 — 지금 턴이 끝난 뒤 그 세션 맨 앞, 검수·병합 전 전달, 통과 뒤 다시
        // 판정 (SERVER_DESIGN 2.7, CLI-10 v0.6). 대표가 팀원에게 할 말을 명령하면 메인이 이 길로 전한다
        const urgent = a.urgent === true || a.urgent === 'interrupt' ? a.urgent : null;
        // 삭제된 팀원에게는 지시하지 않는다 — 교체된 프로듀서면 지금 프로듀서를 알린다 (리드 결정 S5-74)
        liveMemberOrThrow(ctx, str(a, 'member_id'));
        if (urgent) return sendUrgentInstruction(core, str(a, 'member_id'), str(a, 'text'), { mode: urgent, skill: optStr(a, 'skill') ?? null, requestId });
        return this.instruct(str(a, 'member_id'), str(a, 'text'), optStr(a, 'skill') ?? null, requestId);
      }
      case 'ask_owner': {
        const q: Question = {
          id: ctx.store.nextId('question'),
          projectId: identity.projectId ?? this.projectOfMainSession(identity.sessionKey),
          fromId: member.id,
          to: 'owner',
          taskId: null,
          directiveId: null,
          sessionKey: identity.sessionKey,
          text: str(a, 'question'),
          status: 'open',
          answer: null,
          answeredBy: null,
          createdAt: ctx.now(),
          answeredAt: null,
        };
        ctx.store.questions.insert(q);
        ctx.notify({ level: 'normal', title: '메인 에이전트 질문', body: q.text, link: q.projectId ? { tab: 'projects', projectId: q.projectId } : { tab: 'projects' }, key: `question:${q.id}` });
        ctx.activity({ kind: 'question', actor: member.id, projectId: q.projectId, text: `${q.id} 대표에게 질문: ${q.text}` });
        core.commands.appendAgentReply(q.projectId ?? 'main', `질문: ${q.text}`);
        return { questionId: q.id, message: '대표에게 질문했습니다. 지금 턴을 마치세요. 답변은 다음 턴에 전달됩니다.' };
      }
      case 'submit_report': {
        const r = await core.reports.submit(
          {
            directiveId: optStr(a, 'directive_id') ?? null,
            title: optStr(a, 'title') ?? null,
            sections: {
              summary: str(a, 'summary'),
              results: str(a, 'results'),
              changedFiles: arr(a, 'changed_files'),
              howToVerify: str(a, 'how_to_verify'),
              issues: str(a, 'issues'),
              nextSteps: str(a, 'next_steps'),
            },
          },
          MAIN_AGENT_ID,
          requestId,
        );
        return { reportId: r.id, filePath: r.filePath };
      }
      case 'read_memory':
        return { projectId: optStr(a, 'project_id') ?? null, content: core.memory.read(optStr(a, 'project_id') ?? null) };
      case 'write_memory':
        core.memory.write(optStr(a, 'project_id') ?? null, str(a, 'content'));
        return { saved: true };
      case 'hand_off_seat':
        return this.handOffSeat(identity, member, a);
      // 메인 일지와 인계 꾸러미 (SERVER_DESIGN 6.1·6.2, 리드 결정 S4-6)
      case 'journal_write':
        return core.journal.write(identity, { kind: str(a, 'kind'), text: str(a, 'text'), projectId: optStr(a, 'project_id'), refs: optArr(a, 'refs'), reason: optStr(a, 'reason') });
      case 'journal_close':
        return core.journal.close(identity, { id: str(a, 'id'), resolution: str(a, 'resolution') });
      case 'get_handover':
        return core.handover.toolGet(identity, { generation: typeof a.generation === 'number' ? a.generation : undefined, latest: a.latest === true });

      // ───── 메인 에이전트 운영 도구 (SERVER_DESIGN 2.6) — 옛 대표 메서드와 같은 처리, 행위자 M-MAIN ─────
      case 'update_project': {
        const p = projectOrThrow(ctx, str(a, 'project_id'));
        const patch: Parameters<ApiHandlers['projects.update']>[1] = {};
        if (optStr(a, 'name') !== undefined) patch.name = str(a, 'name');
        if (optArr(a, 'check_commands')) patch.checkCommands = arr(a, 'check_commands');
        if (str(a, 'network_policy') === 'allow' || str(a, 'network_policy') === 'restricted') patch.networkPolicy = str(a, 'network_policy') as 'allow' | 'restricted';
        if (isRecord(a.deploy)) {
          const dep = a.deploy;
          const val = (k: string, cur: string | null) => (dep[k] === null ? null : typeof dep[k] === 'string' ? (dep[k] as string) : cur);
          patch.deploy = { pushRemote: val('push_remote', p.deploy.pushRemote), deployCommand: val('deploy_command', p.deploy.deployCommand) };
        }
        if (!Object.keys(patch).length) throw new BackendError('invalid', '바꿀 항목(name·check_commands·network_policy·deploy)을 하나 이상 주세요');
        const v = await this.mainOp(identity, member, tool, a, requestId, () => ({ kind: 'settings', label: `프로젝트 ${p.id} 설정 변경 (${Object.keys(patch).join(', ')})`, projectId: p.id, notify: { tab: 'projects', projectId: p.id } }), () =>
          this.mainApi['projects.update'](p.id, patch),
        );
        return { projectId: v.id, name: v.name, checkCommands: v.checkCommands, networkPolicy: v.networkPolicy, deploy: v.deploy };
      }
      case 'pause_project': {
        const p = projectOrThrow(ctx, str(a, 'project_id'));
        const mode = stopMode(a);
        await this.mainOp(identity, member, tool, a, requestId, () => ({ kind: 'stop', label: `프로젝트 ${p.id} ${p.name} 일시정지 (${mode === 'immediate' ? '즉시' : '단계 마치고'})`, projectId: p.id, notify: { tab: 'projects', projectId: p.id } }), () =>
          this.mainApi['projects.pause'](p.id, mode),
        );
        return { projectId: p.id, paused: true, mode };
      }
      case 'resume_project': {
        const p = projectOrThrow(ctx, str(a, 'project_id'));
        // 옛 대표 메서드처럼 정지가 없으면 아무것도 하지 않는다 (기록·알림도 남기지 않음)
        if (!ctx.stop().projects[p.id]?.paused) return { projectId: p.id, paused: false, note: '일시정지 상태가 아니었습니다' };
        await this.mainOp(identity, member, tool, a, requestId, () => ({ kind: 'resume', label: `프로젝트 ${p.id} ${p.name} 재개`, projectId: p.id, notify: { tab: 'projects', projectId: p.id } }), () =>
          this.mainApi['projects.resume'](p.id),
        );
        return { projectId: p.id, paused: false };
      }
      case 'update_member': {
        // 삭제된 팀원은 바꾸지 않는다 (리드 결정 S5-74 — team.update도 같은 판정)
        const m = liveMemberOrThrow(ctx, str(a, 'member_id'));
        const name = optStr(a, 'name');
        const roleId = optStr(a, 'role_id');
        if (name === undefined && roleId === undefined) throw new BackendError('invalid', '바꿀 항목(name·role_id)을 주세요. AI는 set_member_ai로 정합니다');
        const v = await this.mainOp(identity, member, tool, a, requestId, () => ({ kind: 'settings', label: `팀원 ${m.id} 변경 (${[name !== undefined ? '이름' : '', roleId !== undefined ? `역할 → ${roleId}` : ''].filter(Boolean).join(', ')})`, projectId: m.projectId, memberId: m.id }), () =>
          this.mainApi['members.update'](m.id, { name, roleId }),
        );
        return { memberId: v.id, name: v.name, roleId: v.roleId, roleName: v.roleName };
      }
      case 'replace_producer': {
        const p = projectOrThrow(ctx, str(a, 'project_id'));
        const old = p.producerId;
        const v = await this.mainOp(identity, member, tool, a, requestId, () => ({ kind: 'system', label: `프로젝트 ${p.id} 프로듀서 교체 (${memberName(ctx, old)} → ${memberName(ctx, ctx.store.projects.require(p.id).producerId)})`, projectId: p.id, notify: { tab: 'projects', projectId: p.id } }), () => {
          // 바꾸면 이 프로듀서 앞에 멈춘 관리 업무를 새 프로듀서가 바로 이어 받는다(일시정지는 이 프로듀서의 것) — 그 프로듀서에 관해 메인이 아직 받지 않은 알림(남은
          // 프로세스 등)이 대기 중이면 resume_member처럼 한 번 거부하고 그 글을 보여 준다 (리드 결정 S5-50). 옛 대표 메서드(members.replaceProducer)와 같은 교체에
          // 기다림 뒤 다시 보기를 더한다 — 그 프로듀서의 정지를 기다리는 사이 자리가 바뀌었거나 이 턴이 끝났으면 바꾸지 않는다 (리드 결정 S5-63)
          this.refuseUnseen(identity, (carry) => handUnseenOnMemberRelease(ctx, old, 'replace_producer', carry));
          return core.team
            .replaceProducer(p.id, { name: optStr(a, 'name'), ...(hasAiArgs(a) ? { ai: aiArgs(a) } : {}) }, MAIN_AGENT_ID, { recheck: this.callerRecheck(identity, tool) })
            .then((m) => core.views.memberView(m));
        });
        return { projectId: p.id, previousProducerId: old, producerId: v.id, name: v.name, ...nameNote(optStr(a, 'name'), v.name), ai: { kind: v.ai.kind, model: v.ai.modelValue ?? null, effort: v.ai.effortValue } };
      }
      case 'pause_member': {
        // 삭제된 팀원은 일시정지하지 않는다 — 멈출 것이 없고 정지 기록만 남는다. 교체된 프로듀서면 지금 프로듀서를 알린다 (리드 결정 S5-62 2·S5-74)
        const m = liveMemberOrThrow(ctx, str(a, 'member_id'));
        if (m.isMain) throw new BackendError('forbidden', '메인 에이전트 자신은 일시정지할 수 없습니다 — 일시정지하면 다시 풀 도구도 쓸 수 없습니다');
        const mode = stopMode(a);
        await this.mainOp(identity, member, tool, a, requestId, () => ({ kind: 'stop', label: `팀원 ${m.id} ${m.name} 일시정지 (${mode === 'immediate' ? '즉시' : '단계 마치고'})`, projectId: m.projectId, memberId: m.id, notify: { tab: 'projects', projectId: m.projectId ?? undefined, memberId: m.id } }), () =>
          this.mainApi['members.pause'](m.id, mode),
        );
        return { memberId: m.id, paused: true, mode };
      }
      case 'resume_member': {
        // 삭제된 팀원은 풀 것이 없다 — '일시정지 상태가 아니었습니다'가 아니라 그 사실을 알린다 (리드 결정 S5-74)
        const m = liveMemberOrThrow(ctx, str(a, 'member_id'));
        // 옛 대표 메서드처럼 정지가 없으면 아무것도 하지 않는다 (기록·알림도 남기지 않음)
        if (!ctx.stop().members[m.id]?.paused) return { memberId: m.id, paused: false, note: '일시정지 상태가 아니었습니다' };
        await this.mainOp(identity, member, tool, a, requestId, () => ({ kind: 'resume', label: `팀원 ${m.id} ${m.name} 재개`, projectId: m.projectId, memberId: m.id, notify: { tab: 'projects', projectId: m.projectId ?? undefined, memberId: m.id } }), () => {
          // 그 팀원에 관해 메인이 아직 받지 않은 알림(남은 프로세스 등)이 대기 중이면 한 번 거부하고 그 글을 보여 준다 — 다음 호출은 재개 (리드 결정 S5-50)
          this.refuseUnseen(identity, (carry) => handUnseenOnMemberRelease(ctx, m.id, 'resume_member', carry));
          this.mainApi['members.resume'](m.id);
        });
        return { memberId: m.id, paused: false };
      }
      case 'interrupt_member': {
        // 삭제된 팀원은 중단할 일이 없다 (리드 결정 S5-74)
        const m = liveMemberOrThrow(ctx, str(a, 'member_id'));
        if (m.isMain) throw new BackendError('forbidden', '메인 에이전트 자신은 중단할 수 없습니다 — 지금 턴을 마치세요');
        const then = thenOf(a);
        await this.mainOp(identity, member, tool, a, requestId, () => ({ kind: 'stop', label: `팀원 ${m.id} ${m.name} 중단 → ${then === 'cancel' ? '취소' : '보류'}`, projectId: m.projectId, memberId: m.id, notify: { tab: 'projects', projectId: m.projectId ?? undefined, memberId: m.id } }), () =>
          this.mainApi['members.interrupt'](m.id, then),
        );
        return { memberId: m.id, then };
      }
      case 'interrupt_task': {
        const t = taskOrThrow(ctx, str(a, 'task_id'));
        const then = thenOf(a);
        await this.mainOp(identity, member, tool, a, requestId, () => ({ kind: 'stop', label: `작업 ${t.id} 중단 → ${then === 'cancel' ? '취소' : '보류'}`, projectId: t.projectId, taskId: t.id, notify: { tab: 'projects', projectId: t.projectId, taskId: t.id } }), () =>
          this.mainApi['tasks.interrupt'](t.id, then),
        );
        return { taskId: t.id, then, state: taskOrThrow(ctx, t.id).state };
      }
      case 'resume_task': {
        const t = taskOrThrow(ctx, str(a, 'task_id'));
        // mainApi['tasks.resume']와 같은 재개(행위자 M-MAIN)에, 풀기 바로 전 한 단계를 더한다: 함께 풀릴 사유의 알림을 메인이 아직 받지 않았으면(대기 중) 한 번
        // conflict로 거부하고 그 알림을 거부 글로 보여 준다 — 그 알림은 이 호출의 메인 턴에 실리므로(없으면 받아 마침) 다음 호출은 재개한다. 다른 거부(정지·취소
        // 중·바로 풀 수 없는 보류·닫힌 지시)가 먼저다. 결과에는 푼 사유(종류·이름·메모 200자)가 있다 (리드 결정 S5-45·S5-49)
        let released: HoldReason[] = [];
        await this.mainOp(identity, member, tool, a, requestId, () => ({ kind: 'resume', label: `작업 ${t.id} 재개 → ${taskOrThrow(ctx, t.id).state}`, projectId: t.projectId, taskId: t.id }), () => {
          this.core.tasks.resumeByOwner(t.id, MAIN_AGENT_ID, {
            beforeRelease: (cur, reasons) => {
              this.refuseUnseen(identity, (carry) => handUnseenAlertsOnResume(ctx, cur, reasons, carry));
              released = reasons;
            },
          });
        });
        const after = taskOrThrow(ctx, t.id);
        // 보류 메모는 원문으로 저장된다 — 결과에 넣기 전에 가린다 (리드 결정 S5-3)
        const note = (r: HoldReason) => ctx.redact.text(r.note).replace(/\s+/g, ' ').trim();
        return {
          taskId: t.id,
          state: after.state,
          released: released.map((r) => {
            const n = note(r);
            return { kind: r.kind, label: HOLD_REASON_LABEL[r.kind], note: n.length > 200 ? `${n.slice(0, 199)}…` : n };
          }),
          ...(after.state === 'on_hold' ? { remainingHolds: after.hold.reasons.map((r) => `${r.kind}: ${ctx.redact.text(r.note)}`) } : {}),
        };
      }
      case 'cancel_directive': {
        const d = ctx.store.directives.get(str(a, 'directive_id'));
        if (!d) throw new BackendError('not_found', `지시 ${str(a, 'directive_id')}을(를) 찾을 수 없습니다`);
        await this.mainOp(identity, member, tool, a, requestId, () => ({ kind: 'directive', label: `지시 ${d.id} 취소`, projectId: d.projectId, directiveId: d.id, notify: { tab: 'projects', projectId: d.projectId ?? undefined, directiveId: d.id } }), () =>
          this.mainApi['directives.cancel'](d.id),
        );
        return { directiveId: d.id, state: ctx.store.directives.require(d.id).state };
      }
      case 'revise_directive': {
        // 대표의 수정 요청(change_request 업무)을 받아 다음 회차를 연다 (FBK-03 v0.6) — instructions가 사유로 활동 기록·대표 알림에 남는다
        const d = ctx.store.directives.get(str(a, 'directive_id'));
        if (!d) throw new BackendError('not_found', `지시 ${str(a, 'directive_id')}을(를) 찾을 수 없습니다`);
        const instructions = str(a, 'instructions').trim();
        if (!instructions) throw new BackendError('invalid', 'instructions(프로듀서에게 줄 이번 회차 지시)를 적으세요');
        const nd = await this.mainOp(
          identity,
          member,
          tool,
          { ...a, reason: instructions },
          requestId,
          () => ({
            kind: 'directive',
            label: `지시 ${d.id} ${d.round + 1}회차 시작 (보고서 ${str(a, 'report_id')} 수정 요청)`,
            projectId: d.projectId,
            directiveId: d.id,
            notify: { tab: 'projects', projectId: d.projectId ?? undefined, directiveId: d.id },
          }),
          () => core.reports.revise(d.id, str(a, 'report_id'), instructions, MAIN_AGENT_ID, requestId),
        );
        return { directiveId: nd.id, round: nd.round, state: nd.state };
      }
      case 'resolve_recovery': {
        const id = str(a, 'recovery_id');
        const e = ctx.store.execs.get(id);
        if (!e) throw new BackendError('not_found', `복구 항목 ${id}을(를) 찾을 수 없습니다 (recovery_id는 복구 확인 목록의 requestId)`);
        const action = str(a, 'action');
        if (action !== 'applied' && action !== 'retry' && action !== 'cancel') throw new BackendError('invalid', 'action은 applied(이미 반영됨)·retry(다시 실행)·cancel(작업 취소) 중 하나입니다');
        // mainApi['recovery.resolve']와 같은 처리(행위자 M-MAIN)에, 정하기 바로 전 한 단계: 그 복구 확인의 알림을 메인이 아직 받지 않았으면(대기 중) 한 번 거부하고
        // 그 글을 보여 준다 — resolve의 다른 거부(이미 처리됨은 아무것도 하지 않음, 병합 커밋을 찾지 못함)가 먼저다 (리드 결정 S5-50). 그다음 기다림(병합 커밋을 찾는
        // git.log) 뒤 다시 보기 — 그사이 자리가 바뀌었거나 이 턴이 끝났으면 정하지 않는다. 못 본 알림이 있으면 앞의 한 번 거부가 먼저 그 알림을 대기 그대로 둔
        // 채 거부한다 (리드 결정 S5-56·S5-63)
        const recheck = this.callerRecheck(identity, tool);
        await this.mainOp(identity, member, tool, a, requestId, () => ({ kind: 'exec', label: `복구 확인 ${id} → ${action === 'applied' ? '이미 반영됨' : action === 'retry' ? '다시 실행' : '작업 취소'}`, projectId: e.projectId, taskId: e.taskId }), () =>
          this.core.recovery.resolve(id, action, MAIN_AGENT_ID, {
            beforeResolve: () => {
              this.refuseUnseen(identity, (carry) => handUnseenOnRecovery(ctx, id, carry));
              recheck();
            },
          }),
        );
        return { recoveryId: id, action, state: ctx.store.execs.require(id).state, ...(e.taskId ? { taskState: ctx.store.tasks.get(e.taskId)?.state ?? null } : {}) };
      }
      case 'update_settings': {
        const patch = a.patch;
        const outside = settingsOutside(patch, MAIN_SETTINGS);
        if (outside.length) {
          throw new BackendError(
            'forbidden',
            `메인 에이전트가 바꿀 수 없는 설정입니다: ${outside.join(', ')} — 바꿀 수 있는 것: ${MAIN_SETTINGS.join(', ')}. 계정·구글·API 키 값·데이터 위치·CLI 실행 파일 위치·메인 AI(자리 넘기기로만)·메인 자리 정책(seat.* — 앉을 수 있는 보유자·마무리 기다림)·개발자 옵션과 보안 정책·기록 보관 기간·자동 백업 켜기·로그인 때 실행은 운영자 몫입니다`,
          );
        }
        // 알림은 바뀐 항목마다 따로 — 다른 항목을 바꾼 앞의 알림을 덮지 않는다 (리드 결정 S5-13)
        const paths = changedPaths(patch);
        const next = await this.mainOp(
          identity,
          member,
          tool,
          a,
          requestId,
          () => ({ kind: 'settings', label: `운영 설정 변경 (${paths.join(', ') || '바뀐 항목 없음'})`, notify: { tab: 'settings' }, subject: [...paths].sort().join(',') }),
          () => this.mainApi['settings.update'](patch as DeepPartial<Settings>),
        );
        return {
          execution: next.execution,
          team: { effortMapping: next.team.effortMapping, modelCatalog: next.team.modelCatalog },
          account: { authMode: next.account.authMode },
          general: { backup: { keep: next.general.backup.keep } },
        };
      }
      case 'set_skill_mode': {
        const name = str(a, 'name').trim();
        if (!name) throw new BackendError('invalid', '스킬 이름(name)을 주세요');
        const mode = str(a, 'mode') === 'manual' ? 'manual' : 'auto';
        await this.mainOp(
          identity,
          member,
          tool,
          a,
          requestId,
          () => ({ kind: 'settings', label: `스킬 ${name} → ${mode === 'manual' ? '수동' : '자동'}`, notify: { tab: 'settings', section: 'skills' }, subject: name }),
          () => this.callerApi(identity, tool)['skills.setMode'](name, mode),
        );
        return { name, mode };
      }
      case 'list_roles':
        return ctx.store.roles.list().map((r) => ({
          roleId: r.id,
          name: r.name,
          builtin: r.builtin,
          // 만든 쪽 — 기록으로만 둔다. 누가 만들었든 고칠 수 있다(잠금 없음, 리드 결정 S5-12)
          createdBy: r.createdBy ?? null,
          canReview: r.canReview,
          taskTypes: r.taskTypes,
          allowedSkills: r.allowedSkills,
          defaultAi: r.defaultAi,
          members: ctx.store.members.list({ ref1: r.id, state: 'active' }).filter((m) => !m.isMain).length,
          instructions: r.instructions.length > 2000 ? `${r.instructions.slice(0, 2000)}…` : r.instructions,
        }));
      case 'create_role': {
        const input = this.roleInput(a, null);
        const v = await this.mainOp(
          identity,
          member,
          tool,
          a,
          requestId,
          (made) => ({ kind: 'settings', label: `역할 추가 ${input.name}${input.canReview ? ' (검수 권한 있음)' : ''}`, notify: { tab: 'settings', section: 'team' }, subject: made.id }),
          () => this.callerApi(identity, tool)['roles.create'](input),
        );
        return { roleId: v.id, name: v.name, canReview: v.canReview, createdBy: v.createdBy ?? null };
      }
      case 'update_role': {
        const r = ctx.store.roles.get(str(a, 'role_id'));
        if (!r) throw new BackendError('not_found', `역할 ${str(a, 'role_id')}을(를) 찾을 수 없습니다`);
        const input = this.roleInput(a, r);
        const granted = input.canReview && !r.canReview;
        // 검수 권한을 끄면 그 역할 팀원이 맡은 검수를 다시 정한다(roles.update) — 대표가 알 수 있게 표시한다 (리드 결정 S5-13)
        const revoked = !input.canReview && r.canReview;
        const v = await this.mainOp(
          identity,
          member,
          tool,
          a,
          requestId,
          () => ({ kind: 'settings', label: `역할 수정 ${r.id} ${input.name}${granted ? ' (검수 권한 부여)' : revoked ? ' (검수 권한 해제)' : ''}`, notify: { tab: 'settings', section: 'team' }, subject: r.id }),
          () => this.callerApi(identity, tool)['roles.update'](r.id, input),
        );
        return { roleId: v.id, name: v.name, canReview: v.canReview, allowedSkills: v.allowedSkills };
      }
      case 'delete_role': {
        const r = ctx.store.roles.get(str(a, 'role_id'));
        if (!r) throw new BackendError('not_found', `역할 ${str(a, 'role_id')}을(를) 찾을 수 없습니다`);
        await this.mainOp(
          identity,
          member,
          tool,
          a,
          requestId,
          () => ({ kind: 'settings', label: `역할 삭제 ${r.id} ${r.name}`, notify: { tab: 'settings', section: 'team' }, subject: r.id }),
          () => this.mainApi['roles.delete'](r.id),
        );
        return { deleted: r.id };
      }
      case 'recheck_ai': {
        const kind = str(a, 'kind') === 'codex' ? 'codex' : 'claude';
        await this.mainOp(identity, member, tool, a, requestId, () => ({ kind: 'auth', label: `${kind} CLI 다시 확인` }), () => this.callerApi(identity, tool)['system.recheckAi'](kind));
        const st = ctx.ai(kind);
        return { kind, installed: st.cliInstalled, version: st.cliVersion, problem: st.cliProblem, authRequired: st.authRequired };
      }
      case 'backup_now': {
        const r = await this.mainOp(identity, member, tool, a, requestId, () => ({ kind: 'system', label: '백업' }), () => this.mainApi['system.backupNow']());
        return { path: r.path };
      }
      case 'search_activity': {
        const limit = typeof a.limit === 'number' ? Math.min(Math.max(Math.trunc(a.limit), 1), 200) : 50;
        const level = optStr(a, 'level');
        // 대표의 logs.search와 같은 함수·같은 줄 — 도구 결과로 모델 문맥에 들어가므로 줄마다 글과 결과를 1,000자로 자르고 한 번 더 가린다 (리드 결정 S5-6)
        const rows = await this.mainApi['logs.search']({
          text: optStr(a, 'text'),
          projectId: optStr(a, 'project_id') ?? null,
          memberId: optStr(a, 'member_id') ?? null,
          taskId: optStr(a, 'task_id') ?? null,
          kinds: optArr(a, 'kinds'),
          level: level === 'info' || level === 'warn' || level === 'error' ? level : undefined,
          from: optStr(a, 'from'),
          to: optStr(a, 'to'),
          limit,
          beforeSeq: typeof a.before_seq === 'number' ? a.before_seq : undefined,
        });
        const cut = (t: string) => cutText(ctx.redact.text(t), ACTIVITY_TEXT_MAX);
        return ctx.redact.value(rows.map((r) => ({ ...r, text: cut(r.text), result: r.result === null ? null : cut(r.result) })));
      }
      // 전체 그림과 조회 (SERVER_DESIGN 5.2, 리드 결정 S5-3·S5-6) — 메인 전용, 읽을 때 다시 가린다
      case 'get_overview': {
        const pid = optStr(a, 'project_id');
        if (pid) projectOrThrow(ctx, pid);
        return core.overview.build({ projectId: pid ?? null, detail: a.detail === true, excludeEntryIds: this.carried(identity) });
      }
      case 'get_member_activity':
        return this.memberActivity(str(a, 'member_id'), { limit: typeof a.limit === 'number' ? a.limit : undefined, turnId: optStr(a, 'turn_id') });
      case 'read_report':
        return this.readReport(str(a, 'report_id'));
      case 'list_questions': {
        const pid = optStr(a, 'project_id');
        if (pid && pid !== 'general') projectOrThrow(ctx, pid);
        return core.overview.questions(pid);
      }

      // ───── 프로듀서 ─────
      case 'create_task': {
        const d = ctx.store.directives.get(str(a, 'directive_id'));
        if (!d) throw new BackendError('not_found', `지시 ${str(a, 'directive_id')}을(를) 찾을 수 없습니다`);
        this.requireProducerProject(member, d.projectId ?? '');
        const type = str(a, 'type') as TaskType;
        // 출력 방식을 정하지 않으면 에셋은 산출물형, 그 밖은 저장소 변경형 — 저장소에 넣을 에셋은 "repo"를 그대로 받는다 (SERVER_DESIGN 7장, 리드 결정 S5-15)
        const output = optStr(a, 'output_mode');
        const t = core.tasks.create(
          {
            directiveId: d.id,
            title: str(a, 'title'),
            goal: str(a, 'goal'),
            type,
            assigneeId: str(a, 'assignee_id'),
            reviewerId: optStr(a, 'reviewer_id') ?? null,
            priority: (optStr(a, 'priority') as Priority | undefined) ?? 'normal',
            prerequisiteIds: arr(a, 'prerequisite_ids'),
            acceptanceCriteria: arr(a, 'acceptance_criteria'),
            plannedAreas: arr(a, 'planned_areas'),
            outputMode: output === 'artifact' || output === 'repo' ? output : type === 'asset' ? 'artifact' : 'repo',
          },
          member.id,
        );
        return { taskId: t.id, reviewerId: t.reviewerId, state: t.state };
      }
      case 'update_task': {
        const t = taskOrThrow(ctx, str(a, 'task_id'));
        this.requireProducerProject(member, t.projectId);
        const nt = core.tasks.update(
          t.id,
          {
            priority: optStr(a, 'priority') as Priority | undefined,
            prerequisiteIds: optArr(a, 'prerequisite_ids'),
            assigneeId: optStr(a, 'assignee_id'),
            reviewerId: optStr(a, 'reviewer_id'),
            acceptanceCriteria: optArr(a, 'acceptance_criteria'),
            plannedAreas: optArr(a, 'planned_areas'),
            goal: optStr(a, 'goal'),
          },
          member.id,
        );
        return { taskId: nt.id, state: nt.state, assigneeId: nt.assigneeId, reviewerId: nt.reviewerId };
      }
      case 'replan_task': {
        const t = taskOrThrow(ctx, str(a, 'task_id'));
        this.requireProducerProject(member, t.projectId);
        const nt = core.tasks.replan(
          t.id,
          { note: str(a, 'note'), goal: optStr(a, 'goal'), acceptanceCriteria: optArr(a, 'acceptance_criteria'), assigneeId: optStr(a, 'assignee_id'), reviewerId: optStr(a, 'reviewer_id') },
          member.id,
        );
        return { taskId: nt.id, state: nt.state, reviewRound: nt.review.round };
      }
      case 'resolve_hold': {
        const t = taskOrThrow(ctx, str(a, 'task_id'));
        this.requireProducerProject(member, t.projectId);
        const nt = core.tasks.resolveHold(t.id, str(a, 'kind') === 'prereq_cancelled' ? 'prereq_cancelled' : 'blocked', str(a, 'note'), member.id);
        return { taskId: nt.id, state: nt.state };
      }
      case 'cancel_task': {
        const t = taskOrThrow(ctx, str(a, 'task_id'));
        // 메인 에이전트는 모든 프로젝트에서 쓴다 (옛 대표 tasks.cancel, SERVER_DESIGN 2.6). 프로듀서는 자기 프로젝트만
        if (member.isMain) {
          await this.mainOp(identity, member, tool, a, requestId, () => ({ kind: 'task', label: `작업 ${t.id} 취소`, projectId: t.projectId, taskId: t.id, notify: { tab: 'projects', projectId: t.projectId, taskId: t.id } }), () =>
            this.mainApi['tasks.cancel'](t.id),
          );
          return { taskId: t.id, state: 'cancelled' };
        }
        this.requireProducerProject(member, t.projectId);
        await core.tasks.cancel(t.id, str(a, 'reason'), member.id);
        return { taskId: t.id, state: 'cancelled' };
      }
      case 'assign_reviewer': {
        const t = taskOrThrow(ctx, str(a, 'task_id'));
        // 검수자 교체는 한 곳에서 (이전 검수 정리 → 새 검수자에게 등록, CONC-11). 같은 검수자를 다시 정하면 멈춘 검수를 다시 등록한다 (리드 결정 11)
        const assign = () => {
          const reviewer = core.tasks.resolveReviewer(t, str(a, 'reviewer_id'));
          const done = core.tasks.changeReviewer(t.id, reviewer, '검수자 변경');
          return { taskId: t.id, reviewerId: reviewer, ...(done === 'redispatched' ? { reviewRequeued: true } : {}) };
        };
        const who = (id: string | null) => (!id ? '없음' : id === MAIN_AGENT_ID ? '메인 에이전트' : `${memberName(ctx, id)}(${id})`);
        // 메인 에이전트는 모든 프로젝트에서 쓴다 — 멈춘 검수 넘김에서 검수 권한 팀원을 더한 뒤 검수자를 바꾸는 길이다(dispatchReview는 자격 있는 지금 검수자를 그대로
        // 둔다). cancel_task처럼 운영 조작(사유·활동 기록·대표 알림·일지)으로 (리드 결정 48·S5-11). 프로듀서는 자기 프로젝트만
        if (member.isMain) {
          // 삭제된 팀원을 검수자로 정하지 않는다 — 교체된 프로듀서면 지금 프로듀서를 알린다 (리드 결정 S5-74). 없는 ID·자격은 resolveReviewer가 본다
          if (ctx.store.members.get(str(a, 'reviewer_id'))?.deletedAt) liveMemberOrThrow(ctx, str(a, 'reviewer_id'));
          let out: ReturnType<typeof assign> | null = null;
          await this.mainOp(
            identity,
            member,
            tool,
            a,
            requestId,
            () => ({
              kind: 'review',
              label: `작업 ${t.id} 검수자 → ${who(out!.reviewerId)}${out!.reviewRequeued ? ' (같은 검수자 — 검수를 다시 등록)' : ''}`,
              projectId: t.projectId,
              taskId: t.id,
              notify: { tab: 'projects', projectId: t.projectId, taskId: t.id },
            }),
            () => (out = assign()),
          );
          return out!;
        }
        this.requireProducerProject(member, t.projectId);
        const r = assign();
        const again = r.reviewRequeued ? ' (같은 검수자 — 검수를 다시 등록)' : '';
        ctx.activity({ kind: 'review', actor: member.id, projectId: t.projectId, taskId: t.id, text: `${t.id} 검수자 배정 → ${r.reviewerId === MAIN_AGENT_ID ? '메인 에이전트' : r.reviewerId}${again}` });
        return r;
      }
      case 'answer_question': {
        const q = ctx.store.questions.get(str(a, 'question_id'));
        if (!q) throw new BackendError('not_found', '질문을 찾을 수 없습니다');
        if (q.to !== 'producer' || q.projectId !== member.projectId || !member.isProducer) throw new BackendError('forbidden', '이 질문에 답할 수 없습니다');
        const done = core.tasks.answer(q.id, str(a, 'answer'), member.id);
        return { questionId: done.id, status: done.status };
      }
      case 'request_merge':
        return core.merges.requestMerge(str(a, 'task_id'), member, requestId);
      case 'request_revert': {
        // 요청을 보낸 턴을 넘긴다 — 지시 취소 전에 시작된 그 지시의 턴이 취소 뒤에 보낸 요청은 받지 않는다 (AC-46, merges.requestRevert)
        const turn = ctx.store.turns.get(identity.turnId);
        return core.merges.requestRevert(str(a, 'task_id'), member, str(a, 'reason'), { sessionKey: identity.sessionKey, turnId: identity.turnId, turnStartedAt: turn?.startedAt ?? null });
      }
      case 'submit_final_result': {
        const d = core.directives.submitFinalResult(
          {
            directiveId: str(a, 'directive_id'),
            summary: str(a, 'summary'),
            outputs: arr(a, 'outputs'),
            changedFiles: arr(a, 'changed_files'),
            issues: arr(a, 'issues'),
            nextSteps: arr(a, 'next_steps'),
          },
          member,
          requestId,
        );
        return { directiveId: d.id, state: d.state };
      }

      // ───── 팀원 ─────
      case 'set_steps': {
        const t = this.requireTaskSession(identity, member);
        if (t.state !== 'in_progress') throw new BackendError('conflict', `작업 ${t.id}이(가) 진행 상태가 아닙니다`);
        const steps = core.tasks.setSteps(t.id, arr(a, 'steps'));
        return { steps: steps.map((s) => ({ idx: s.idx, title: s.title, done: s.done })) };
      }
      case 'add_steps': {
        const t = this.requireTaskSession(identity, member);
        if (t.state !== 'in_progress') throw new BackendError('conflict', `작업 ${t.id}이(가) 진행 상태가 아닙니다`);
        const steps = core.tasks.addSteps(t.id, arr(a, 'steps'));
        return { steps: steps.map((s) => ({ idx: s.idx, title: s.title, done: s.done })) };
      }
      case 'complete_step': {
        const t = this.requireTaskSession(identity, member);
        this.assertStepWrapUp(identity, member, t);
        if (t.state !== 'in_progress' && t.state !== 'on_hold') throw new BackendError('conflict', `작업 ${t.id}이(가) 진행 상태가 아닙니다`);
        const idx = typeof a.step_index === 'number' ? a.step_index : -1;
        const r = await core.tasks.completeStep(t.id, idx, str(a, 'note'), member, identity.turnId);
        const steps = ctx.store.steps.list(t.id);
        const stopRequested = !!ctx.store.turns.get(identity.turnId)?.process.stopRequestedAt;
        return {
          step: { idx: r.step.idx, title: r.step.title, done: true },
          commitSha: r.commitSha,
          already: r.already,
          progress: `${steps.filter((s) => s.done).length}/${steps.length}`,
          message: stopRequested ? '일시정지 요청이 있어 이 단계에서 멈춥니다. 지금 턴을 마치세요.' : undefined,
        };
      }
      case 'submit_for_review': {
        const t = this.requireTaskSession(identity, member);
        return core.tasks.requestSubmit(t.id, str(a, 'note'), member);
      }
      case 'ask_producer': {
        let task: Task;
        if (identity.sessionKind === 'task') task = this.requireTaskSession(identity, member);
        else if (identity.sessionKind === 'review') task = this.requireAssignedReviewer(identity, member);
        else throw new BackendError('forbidden', '작업·검수 세션에서만 질문할 수 있습니다');
        if (member.isProducer) throw new BackendError('invalid', '프로듀서는 스스로에게 질문할 수 없습니다. 대표에게 물을 일은 결과 보고에 남기세요');
        const q = core.tasks.askProducer(task, member, str(a, 'question'), identity.sessionKey);
        // 질문하면 그 작업은 보류되고 팀원 프로세스는 끝난다 — CLI가 턴을 스스로 끝내지 않아도 프로그램이 끝내 자리를 돌려준다 (15.4, AC-37)
        core.turns.endAfterQuestion(identity.turnId, `질문 ${q.id} 뒤 답변 대기 — 프로그램이 턴을 마침`);
        return { questionId: q.id, message: '프로듀서에게 질문했습니다. 작업이 답변 대기로 보류됐으니 지금 턴을 마치세요.' };
      }
      case 'report_blocked': {
        const t = this.requireTaskSession(identity, member);
        core.tasks.reportBlocked(t, member, str(a, 'reason'));
        core.turns.endAfterQuestion(identity.turnId, '막힘 보고 뒤 보류 — 프로그램이 턴을 마침');
        return { message: '막힘을 프로듀서에게 보고했습니다. 작업이 보류됐으니 지금 턴을 마치세요.' };
      }
      case 'write_handover': {
        // 퇴직하는 담당의 인수인계 메모 (직원 교체 — team.replaceMember가 요청한다). 그 작업의 턴에서만 남긴다
        const t = this.requireTaskSession(identity, member);
        return core.team.writeHandover(member, taskOrThrow(ctx, t.id), str(a, 'memo'));
      }
      case 'report_conflict_resolved': {
        const t = this.requireTaskSession(identity, member);
        // 병합을 취소한 뒤의 보고처럼 해결된 것이 없으면 conflict로 거부된다 (사실과 다음 일을 알려 줌, conflictResolved)
        const r = await core.tasks.conflictResolved(t, member, str(a, 'note'));
        const next = '턴을 마치면 프로그램이 최신 main 반영·자동 검사·재검수(해결자가 아닌 검수자)를 다시 진행합니다.';
        const unverified = r.unverified.length ? ` 내용으로 확인할 수 없는 충돌 파일(${r.unverified.join(', ')})은 작업 폴더에 있던 그대로 커밋됐습니다.` : '';
        const message =
          r.outcome === 'concluded'
            ? `진행 중인 병합이 없어(병합이 이미 커밋돼 있음) 충돌 파일에 충돌 표시가 남지 않은 것을 확인하고 충돌 기록을 정리했습니다.${unverified} git 명령은 쓰지 마세요. ${next}`
            : `충돌 해결을 커밋했습니다.${unverified} ${next}`;
        return { commitSha: r.sha, unverified: r.unverified, message };
      }
      case 'record_skill_use': {
        const t = this.requireTaskSession(identity, member);
        const skill = str(a, 'skill');
        if (!t.skillsUsed.includes(skill)) ctx.store.tasks.patch(t.id, { skillsUsed: [...t.skillsUsed, skill] });
        return { recorded: skill };
      }

      // ───── 검수 ─────
      case 'get_review_target': {
        const t = taskOrThrow(ctx, str(a, 'task_id'));
        this.requireReviewTool(identity, member, t);
        if (t.state !== 'in_review' || !t.review.target) throw new BackendError('conflict', `작업 ${t.id}은(는) 검수 상태가 아닙니다`);
        const target = t.review.target;
        const project = projectOrThrow(ctx, t.projectId);
        const diff = target.kind === 'repo' ? await ctx.deps.git.diffStat(project.path, target.baseMainSha, target.taskCommitSha).catch(() => []) : [];
        // 산출물형에서 저장소 변경형으로 전환된 작업: 산출물 폴더 결과 파일도 이 버전의 사본으로 보인다 (AC-47, REV-08)
        const deliverables = core.tasks.deliverablesCopyOf(t);
        const unchecked = core.tasks.uncheckedConflictFiles(t.id);
        // 메인 에이전트가 이 작업에 보낸 긴급 지시 — 완료 조건·프로듀서 지시보다 우선한다 (CTL-06). 이 턴에 보인 것으로 적는다 (판정 때 확인, submit_review)
        const owner = core.tasks.ownerInstructionsFor(t.id);
        core.turns.markOwnerNotesShown(identity.turnId, owner.map((m) => m.id));
        return {
          taskId: t.id,
          title: t.title,
          goal: t.goal,
          outputMode: t.outputMode,
          reviewRound: t.review.round,
          rejectsInRound: t.review.rejectsInRound,
          target,
          reviewCopyPath: core.tasks.reviewCopyOf(t),
          acceptanceCriteria: t.acceptanceCriteria,
          autoCheck: t.review.autoCheck,
          changedFiles: diff,
          artifacts: target.kind === 'artifact' ? target.files : deliverables ? hashTree(deliverables) : [],
          ...(deliverables ? { artifactCopyPath: deliverables } : {}),
          ...(unchecked.length ? { uncheckedConflictFiles: unchecked } : {}),
          ...(owner.length ? { urgentInstructions: owner.map((m) => core.tasks.ownerInstructionView(m)), urgentInstructionsNote: URGENT_INSTRUCTIONS_NOTE } : {}),
          previousReviews: ctx.store.reviews.list({ ref1: t.id }).map((r) => ({ round: r.reviewRound, verdict: r.verdict, reason: r.reason })),
        };
      }
      case 'submit_review': {
        const t = taskOrThrow(ctx, str(a, 'task_id'));
        this.requireReviewTool(identity, member, t, '검수 결과 등록 거부: ');
        const criteria = Array.isArray(a.criteria)
          ? (a.criteria as { criterion?: unknown; pass?: unknown; note?: unknown }[]).map((c) => ({ criterion: String(c.criterion ?? ''), pass: c.pass === true, note: String(c.note ?? '') }))
          : [];
        // 이 검수 세션에 긴급 지시가 와 있으면(이 턴이 시작된 뒤 도착) 판정을 받지 않는다 — 긴급 지시를 먼저 전달하고(같은 세션
        // 다음 턴 맨 앞) 그 뒤에 판정한다 (CLI-10 우선 전달, CTL-06, AC-36). 받으면 산출물형은 곧바로 확정·완료돼 그 검수 세션이 다시 돌지
        // 않아 지시가 전달되지 못한다. 판정 없이 끝난 검수 턴은 판정 재촉과 함께 다시 넣고(judgeReview), 프로그램이 이 턴을 마친다
        // 프로그램이 끊는 턴이라 판정 재촉·검수자 교체 요청으로 세지 않는다 (endForOwnerMessage)
        if (core.tasks.ownerMessagesWaiting(identity.sessionKey, member.id).length) {
          core.turns.endForOwnerMessage(identity.turnId, '긴급 지시를 먼저 전달 — 프로그램이 턴을 마침');
          throw new BackendError(
            'conflict',
            '긴급 지시가 이 검수 세션에 도착해 판정을 등록하지 않았습니다. 지금 턴을 마치세요 — 다음 턴 맨 앞에 긴급 지시가 전달되니 확인한 뒤 다시 판정하세요 (CLI-10).',
          );
        }
        // 메인 에이전트가 이 작업에 보낸 긴급 지시를 모두 본 뒤에만 판정을 받는다 (CTL-06 — 그 작업을 판정하는 쪽은 프로듀서든 아니든 긴급 지시를 안다). 이 턴을 띄운 뒤
        // 작업자에게 온 긴급 지시를 아직 보지 않았으면(검수 대상·업무 문맥을 그 뒤에 조회하지 않음) 받지 않고 그 지시를 이 응답으로 보인다 — 다시 판정하면 받는다
        const unseen = new Set(core.turns.ownerNotesUnseen(identity.turnId, core.tasks.ownerInstructionsFor(t.id).map((m) => m.id)) ?? []);
        if (unseen.size) {
          const fresh = core.tasks.ownerInstructionsFor(t.id).filter((m) => unseen.has(m.id));
          core.turns.markOwnerNotesShown(identity.turnId, [...unseen]);
          throw new BackendError(
            'conflict',
            `검수 결과를 등록하지 않았습니다 — 이 턴이 시작된 뒤 메인 에이전트가 이 작업에 보낸 긴급 지시 ${fresh.length}건을 아직 보지 않았습니다. 아래 지시를 확인하고 다시 판정하세요 (긴급 지시는 완료 조건·프로듀서 지시보다 우선, CTL-06):\n${fresh
              .map((m) => `- ${core.tasks.ownerInstructionLine(m)}`)
              .join('\n')}`,
          );
        }
        // 판정을 그 턴이 본 버전에 묶는다 — 턴을 띄울 때 고정돼 있던 대상(턴 기록 reviewPinnedAt)이 지금 대상과 같은지로 본다. 시각 순서로 보지 않으므로
        // 시계가 뒤로 맞춰져도 바뀐 것이 없는 버전의 판정은 받는다 (REV-07, AC-43). 띄울 때의 고정을 남기지 않은 옛 턴 기록만 시작 시각으로
        const turn = ctx.store.turns.get(identity.turnId);
        const seen = turn ? (turn.reviewPinnedAt !== undefined ? { turnPinnedAt: turn.reviewPinnedAt } : { turnStartedAt: turn.startedAt }) : {};
        const r = core.tasks.submitReview(t.id, member, { verdict: str(a, 'verdict') === 'pass' ? 'pass' : 'reject', criteria, reason: str(a, 'reason') }, requestId, seen);
        return {
          reviewId: r.review.id,
          verdict: r.review.verdict,
          duplicate: r.duplicate,
          taskState: r.task.state,
          message: r.duplicate
            ? '이미 같은 대상에 판정을 등록했습니다.'
            : r.reopenedForOwnerMessage
              ? '검수 결과를 등록했습니다. 작업자에게 온 긴급 지시가 아직 전달되지 않아 완료하기 전에 작업을 진행으로 돌렸습니다 (반려 아님). 반영한 새 버전이 제출되면 다시 검수를 요청합니다. 지금 턴을 마치세요.'
              : '검수 결과를 등록했습니다.',
        };
      }
      default:
        throw new BackendError('forbidden', `알 수 없는 도구: ${tool}`);
    }
  }

  private projectOfMainSession(key: string): string | null {
    return key.startsWith('main:') && key !== 'main:general' ? key.slice(5) : null;
  }

  /**
   * 역할 도구 인자 → 역할 입력 (SERVER_DESIGN 7장, ROLE-05). base가 있으면(update_role) 주지 않은 항목은 지금 값 그대로. 기본 역할도 모든 항목(이름·지침·
   * 작업 유형·기본 AI·허용 스킬·검수 권한)을 고칠 수 있지만, 프로듀서 역할의 검수 권한은 끌 수 없다 (프로듀서가 기본 검수자, REV-02, 리드 결정 S5-13 — roleRules).
   * 지침은 8,000자까지. 허용 스킬이 찾은 스킬인지는 처리기(api.ts roles.create·update)가 본다 (리드 결정 S5-14)
   */
  private roleInput(a: Args, base: Role | null): RoleInput {
    const name = (optStr(a, 'name') ?? base?.name ?? '').trim();
    const instructions = optStr(a, 'instructions') ?? base?.instructions ?? '';
    if (instructions.length > 8000) throw new BackendError('invalid', `역할 지침은 8,000자까지입니다 (지금 ${instructions.length}자)`);
    const taskTypes = (optArr(a, 'task_types') ?? base?.taskTypes ?? []) as TaskType[];
    if (!taskTypes.length) throw new BackendError('invalid', 'task_types(맡는 작업 유형)를 하나 이상 주세요');
    const canReview = optBool(a, 'can_review') ?? base?.canReview ?? false;
    if (base?.id === 'producer' && !canReview) throw new BackendError('forbidden', '프로듀서 역할의 검수 권한은 끌 수 없습니다 — 프로듀서가 기본 검수자입니다 (REV-02)');
    const cur: Role['defaultAi'] = base?.defaultAi ?? { kind: 'claude', model: null, effortTier: 'normal', effortOverride: null };
    const d = isRecord(a.default_ai) ? a.default_ai : null;
    let defaultAi = cur;
    if (d) {
      const kind: AiKind = d.kind === 'claude' || d.kind === 'codex' ? d.kind : cur.kind;
      const same = kind === cur.kind;
      const tier = d.effort_tier === 'high' || d.effort_tier === 'normal' || d.effort_tier === 'low' ? d.effort_tier : cur.effortTier;
      defaultAi = {
        kind,
        model: d.model === null ? null : typeof d.model === 'string' ? d.model.trim() || null : same ? cur.model : null,
        effortTier: tier,
        effortOverride: d.effort === null ? null : typeof d.effort === 'string' ? d.effort.trim() || null : same ? cur.effortOverride : null,
      };
    }
    return { name, instructions, taskTypes, allowedSkills: [...new Set(optArr(a, 'allowed_skills') ?? base?.allowedSkills ?? [])], defaultAi, canReview };
  }

  // ───────────────────────── 메시지 ─────────────────────────

  /** 팀원의 현재 업무 세션 (CLI-10: 받는 쪽 다음 턴에 전달) — 멈춘 검수 넘김의 안내와 같은 판정이다 (lookups.messageSessionOf, 리드 결정 45) */
  private sessionFor(m: Member): { key: string; kind: 'message'; taskId: string | null; directiveId: string | null } | null {
    return messageSessionOf(this.ctx, m);
  }

  /** 받는 작업 세션이 검수 중이면 바로 전달되지 않는다 — 보낸 쪽에 알린다 (REV-08: 검수 중 작업 폴더에 턴을 띄우지 않음, F12) */
  private deferredNote(key: string): string | undefined {
    const { kind, ref } = parseKey(key);
    const t = kind === 'task' ? this.ctx.store.tasks.get(ref) : null;
    return t?.state === 'in_review' ? `${t.id}이(가) 검수 중이라 재작업(반려·재고정) 때 함께 전달됩니다. 그대로 완료되면 전달되지 않습니다` : undefined;
  }

  private sendMessage(identity: TokenIdentity, from: Member, to: string, text: string, requestId: string | null): unknown {
    const ctx = this.ctx;
    let note: string | undefined;
    let target: Member;
    if (to === 'main') target = memberOrThrow(ctx, MAIN_AGENT_ID);
    else if (to === 'producer') {
      if (!from.projectId) throw new BackendError('invalid', '프로젝트 소속이 아닙니다');
      target = memberOrThrow(ctx, projectOrThrow(ctx, from.projectId).producerId);
    } else target = memberOrThrow(ctx, to);
    // 메인 에이전트는 삭제된 팀원에게 보내지 않는다 — 교체된 프로듀서면 지금 프로듀서를 알린다 (리드 결정 S5-74)
    if (from.isMain && target.deletedAt) liveMemberOrThrow(ctx, target.id);
    if (!from.isMain && !from.isProducer && !target.isProducer) throw new BackendError('forbidden', '일반 팀원은 프로듀서에게만 메시지를 보낼 수 있습니다');
    if (!from.isMain && target.projectId !== from.projectId && !target.isMain) throw new BackendError('forbidden', '다른 프로젝트 팀원에게 보낼 수 없습니다');
    // 메시지 기록 ID를 먼저 정해 대기 항목에 단다 — 그 항목을 실은 턴의 CLI를 띄우면 전달됨으로 적는다 (AC-36)
    const messageId = ctx.store.nextId('message');
    if (target.isMain) {
      enqueue(ctx, { kind: 'message', memberId: MAIN_AGENT_ID, sessionKey: mainKey(from.projectId), projectId: from.projectId, message: `${from.name}(${from.id})의 메시지: ${text}`, requestId, messageId });
    } else {
      // 질문·메시지는 보낸 업무와 같은 지시 세션으로 (다른 업무 세션과 섞지 않음, MEM-11)
      let dest = this.sessionFor(target);
      if (target.isProducer && identity.sessionKind === 'task') {
        const t = ctx.store.tasks.get(parseKey(identity.sessionKey).ref);
        if (t) dest = { key: directiveKey(t.directiveId), kind: 'message', taskId: t.id, directiveId: t.directiveId };
      }
      if (!dest) throw new BackendError('conflict', `${target.name}은(는) 지금 진행 중인 업무가 없습니다. 작업으로 지시하세요`);
      enqueue(ctx, {
        kind: 'message',
        memberId: target.id,
        sessionKey: dest.key,
        projectId: target.projectId,
        taskId: dest.taskId,
        directiveId: dest.directiveId,
        message: `${from.name}(${from.id})의 메시지: ${text}`,
        requestId,
        messageId,
      });
      note = this.deferredNote(dest.key);
    }
    const msg = {
      id: messageId,
      requestId,
      fromActor: from.id,
      toMemberId: target.id,
      sessionKey: null,
      text: ctx.redact.text(text),
      kind: 'agent' as const,
      sharedWith: [],
      urgent: false,
      createdAt: ctx.now(),
      deliveredAt: null,
    };
    ctx.store.messages.insert(msg);
    ctx.activity({ kind: 'message', actor: from.id, projectId: from.projectId ?? target.projectId, memberId: target.id, text: `${from.name} → ${target.name}: ${text.slice(0, 200)}` });
    return note ? { messageId: msg.id, to: target.id, note } : { messageId: msg.id, to: target.id };
  }

  /** 메인 에이전트 직접 지시 (CMD-06): 같은 내용을 프로듀서에게 공유 */
  private instruct(memberId: string, text: string, skill: string | null, requestId: string | null): unknown {
    const ctx = this.ctx;
    const target = memberOrThrow(ctx, memberId);
    if (target.isMain || target.deletedAt) throw new BackendError('invalid', '지시할 수 없는 대상입니다');
    if (skill) {
      const role = roleOf(ctx, target.roleId);
      if (!role?.allowedSkills.includes(skill)) throw new BackendError('forbidden', `${target.name}의 역할에 허용되지 않은 스킬입니다: ${skill} (SKL-04)`);
    }
    const dest = this.sessionFor(target);
    if (!dest) throw new BackendError('conflict', `${target.name}은(는) 지금 진행 중인 업무가 없습니다. 프로듀서를 통해 작업으로 지시하세요`);
    const body = `메인 에이전트 직접 지시${skill ? ` (스킬 ${skill} 사용)` : ''}: ${text}`;
    const messageId = ctx.store.nextId('message');
    enqueue(ctx, { kind: 'message', memberId: target.id, sessionKey: dest.key, projectId: target.projectId, taskId: dest.taskId, directiveId: dest.directiveId, message: body, requestId, messageId });
    const shared: string[] = [];
    if (target.projectId && !target.isProducer) {
      const producer = memberOrThrow(ctx, projectOrThrow(ctx, target.projectId).producerId);
      const pdest = this.sessionFor(producer) ?? (dest.directiveId ? { key: directiveKey(dest.directiveId), taskId: null, directiveId: dest.directiveId } : null);
      if (pdest) {
        enqueue(ctx, { kind: 'message', memberId: producer.id, sessionKey: pdest.key, projectId: target.projectId, directiveId: pdest.directiveId, message: `[공유] 메인 에이전트가 ${target.name}에게 직접 지시함: ${text}` });
        shared.push(producer.id);
      }
    }
    ctx.store.messages.insert({
      id: messageId,
      requestId,
      fromActor: MAIN_AGENT_ID,
      toMemberId: target.id,
      sessionKey: dest.key,
      text: ctx.redact.text(body),
      kind: 'agent',
      sharedWith: shared,
      urgent: false,
      createdAt: ctx.now(),
      deliveredAt: null,
    });
    ctx.activity({ kind: 'message', actor: MAIN_AGENT_ID, projectId: target.projectId, memberId: target.id, text: `메인 에이전트 직접 지시 → ${target.name}: ${text.slice(0, 200)}` });
    const note = this.deferredNote(dest.key);
    if (note) return { delivered: dest.key, sharedWith: shared, note };
    return { delivered: dest.key, sharedWith: shared };
  }

  // ───────────────────────── 업무 문맥 ─────────────────────────

  /**
   * 그 팀원의 턴을 실행하는 쪽 (리드 결정 S7-17 F5) — 외부 에이전트가 메인 자리를 가졌으면 메인 에이전트는 external이고 CLI 종류가 없다(aiKind null). M-MAIN의 AI 칸은
   * 마지막 CLI 그대로라 그대로 내면 외부 보유자에게 그 CLI라고 말하게 된다. 그 밖에는 서버가 띄우는 CLI의 AI 종류
   */
  private runnerOf(m: Member): { runner: RunnerKind; aiKind: AiKind | null } {
    return m.isMain && this.core.seat.externalHolder() ? { runner: 'external', aiKind: null } : { runner: m.ai.kind, aiKind: m.ai.kind };
  }

  private team(projectId: string): WorkContext['team'] {
    const ctx = this.ctx;
    return projectMembers(ctx, projectId).map((m) => {
      const role = roleOf(ctx, m.roleId);
      const st = deriveMemberStatus({
        member: m,
        stop: ctx.stop(),
        runningLabel: this.core.turns.liveOf(m.id)?.label ?? null,
        assignedTasks: this.core.tasks.openTasks(m.id),
        queued: 0,
        ai: null,
        memberError: null,
        openQuestions: [],
        nowMs: ctx.clock.ms(),
      });
      return {
        memberId: m.id,
        name: m.name,
        roleId: m.roleId,
        roleName: role?.name ?? m.roleId,
        // 역할이 맡는 작업 유형 — 프로듀서가 사운드 같은 새 역할에 맞는 작업(에셋 등)을 만들 수 있게 (리드 결정 S5-15)
        taskTypes: role?.taskTypes ?? [],
        canReview: !!role?.canReview || m.isProducer,
        ...this.runnerOf(m),
        status: MEMBER_STATUS_LABEL[st.status],
        activeTaskId: activeTaskOf(ctx, m.id)?.id ?? null,
      };
    });
  }

  private taskCard(t: Task): WorkTaskCard {
    const ctx = this.ctx;
    const handover = this.core.team.handoversFor(t.id);
    const lastReject = ctx.store.reviews
      .list({ ref1: t.id })
      .filter((r) => r.verdict === 'reject')
      .pop();
    return {
      id: t.id,
      title: t.title,
      goal: t.goal,
      type: t.type,
      priority: t.priority,
      state: t.state,
      outputMode: t.outputMode,
      acceptanceCriteria: t.acceptanceCriteria,
      plannedAreas: t.plannedAreas,
      prerequisiteIds: t.prerequisiteIds,
      steps: ctx.store.steps.list(t.id).map((s) => ({ idx: s.idx, title: s.title, done: s.done })),
      branch: t.workspace?.branch ?? null,
      worktreePath: t.workspace?.worktreePath ?? null,
      // 산출물형이면 그 결과 폴더 — 저장소 변경형으로 전환된 뒤에도 그 폴더에 만든 결과 파일이 남아 있으면 계속 보인다 (AC-47: 함께 검수·보관됨)
      artifactDir: t.outputMode === 'artifact' || existsSync(artifactWorkDir(ctx.paths, t.projectId, t.id)) ? artifactWorkDir(ctx.paths, t.projectId, t.id) : null,
      reviewRound: t.review.round,
      rejectsInRound: t.review.rejectsInRound,
      lastRejectReason: lastReject ? `${lastReject.reason} ${lastReject.criteria.filter((c) => !c.pass).map((c) => `[${c.criterion}: ${c.note}]`).join(' ')}`.trim() : null,
      conflictFiles: t.conflict?.files ?? [],
      autoCheck: { status: t.review.autoCheck.status, detail: t.review.autoCheck.detail.slice(-1500) },
      // 다른 직원에게서 넘어온 작업이면 그 내역과 앞 담당의 메모 (직원 교체)
      ...(handover.length ? { handover: handover.map((h) => ({ from: `${h.fromName}(${h.fromId})`, fromAi: h.fromAi, at: h.at, memo: h.memo })) } : {}),
    };
  }

  workContext(identity: TokenIdentity, member: Member): WorkContext {
    const ctx = this.ctx;
    const role = member.isMain ? null : roleOf(ctx, member.roleId);
    const session = ctx.store.sessions.get(identity.sessionId);
    const entries = ctx.store.queue.list({ ref2: identity.sessionKey }).filter((q) => q.turnId === identity.turnId);
    const kinds = [...new Set(entries.map((e) => e.kind))];
    const { kind, ref } = parseKey(identity.sessionKey);
    // 메인 에이전트의 검수 세션(review:T, REV-06 v0.6)은 그 작업의 프로젝트를 보인다
    const sessionTaskProject = kind === 'task' || kind === 'review' ? (ctx.store.tasks.get(ref)?.projectId ?? null) : null;
    const project = member.projectId
      ? ctx.store.projects.get(member.projectId)
      : identity.sessionKey.startsWith('main:P')
        ? ctx.store.projects.get(identity.sessionKey.slice(5))
        : sessionTaskProject
          ? ctx.store.projects.get(sessionTaskProject)
          : null;
    let directive: WorkContext['directive'] = null;
    let task: WorkContext['task'] = null;
    let reviewTasks: WorkContext['reviewTasks'] = [];
    let questions: WorkContext['questions'] = [];
    let mergeCandidates: WorkContext['mergeCandidates'] = [];
    let tasks: WorkContext['tasks'] = [];
    const directiveId = kind === 'directive' ? ref : kind === 'task' || kind === 'review' ? ctx.store.tasks.get(ref)?.directiveId : entries.find((e) => e.directiveId)?.directiveId;
    const d = directiveId ? ctx.store.directives.get(directiveId) : null;
    if (d) {
      directive = {
        id: d.id,
        title: d.title,
        text: d.text,
        round: d.round,
        state: d.state,
        rounds: d.rounds.map((r) => ({ round: r.round, text: r.text, anchored: r.anchored.map((x) => ({ quote: x.quote, comment: x.comment })) })),
      };
    }
    if (kind === 'task') task = this.taskCard(taskOrThrow(ctx, ref));
    if (kind === 'review') {
      const t = taskOrThrow(ctx, ref);
      const artifactCopyPath = this.core.tasks.deliverablesCopyOf(t);
      // 메인 에이전트가 이 작업에 보낸 긴급 지시 — 완료 조건·프로듀서 지시보다 우선 (CTL-06). 이 턴에 보인 것으로 적는다 (판정 때 확인)
      const owner = this.core.tasks.ownerInstructionsFor(t.id);
      this.core.turns.markOwnerNotesShown(identity.turnId, owner.map((m) => m.id));
      reviewTasks = [
        {
          taskId: t.id,
          title: t.title,
          outputMode: t.outputMode,
          acceptanceCriteria: t.acceptanceCriteria,
          reviewRound: t.review.round,
          target: t.review.target,
          reviewCopyPath: this.core.tasks.reviewCopyOf(t),
          ...(artifactCopyPath ? { artifactCopyPath } : {}),
          ...(owner.length ? { urgentInstructions: owner.map((m) => this.core.tasks.ownerInstructionView(m)) } : {}),
        },
      ];
    }
    if (kind === 'directive' && d) {
      questions = ctx.store.questions
        .list({ state: 'open' })
        .filter((q) => q.to === 'producer' && q.directiveId === d.id)
        .map((q) => ({ questionId: q.id, fromId: q.fromId, fromName: memberName(ctx, q.fromId), taskId: q.taskId, text: q.text }));
      // 통과 뒤 그 검수자에게 온 긴급 지시로 병합 판단을 미룬 작업(지시 대기·다시 판정 턴 진행 중)은 빼낸다 — request_merge가 거부한다 (CTL-06, S8-B3)
      mergeCandidates = directiveTasks(ctx, d.id)
        .filter((t) => t.state === 'in_review' && t.review.passed && t.outputMode === 'repo' && !this.core.merges.isPending(t.id) && !this.core.tasks.mergeDeferredForReviewer(t))
        .map((t) => ({ taskId: t.id, title: t.title, reviewerId: String(t.review.passed?.reviewerId) }));
      tasks = directiveTasks(ctx, d.id).map((t) => ({ id: t.id, title: t.title, state: t.state, assigneeId: t.assigneeId, reviewerId: t.reviewerId, holdReasons: t.hold.reasons.map((r) => `${r.kind}: ${r.note}`) }));
    }
    const instructions = kinds.length
      ? kinds.map((k) => `- ${WORK_KIND_LABEL[k]}: ${INSTRUCTION[k]}`).join('\n')
      : '전달된 일이 없습니다. 상태만 확인하고 턴을 마치세요.';
    return {
      you: {
        memberId: member.id,
        name: member.name,
        roleId: member.roleId,
        roleName: member.isMain ? '메인 에이전트' : (role?.name ?? member.roleId),
        isProducer: member.isProducer,
        isMain: member.isMain,
        canReview: !!role?.canReview || member.isProducer,
        projectId: member.projectId,
        // 이 턴을 실행하는 쪽 — 외부 보유자의 턴(토큰이 그 에이전트에 묶임)이면 external, CLI 종류 없음 (리드 결정 S7-17 F5)
        ...(identity.externalAgentId ? { runner: 'external' as const, aiKind: null } : this.runnerOf(member)),
      },
      session: { sessionKey: identity.sessionKey, kind, turnNumber: (session?.turnCount ?? 0) + 1 },
      workKinds: kinds,
      instructions,
      project: project ? { id: project.id, name: project.name, path: project.path, baseBranch: project.baseBranch, checkCommands: project.checkCommands } : null,
      directive,
      task,
      reviewTasks,
      questions,
      mergeCandidates,
      team: member.isMain ? (project ? this.team(project.id) : []) : member.isProducer && member.projectId ? this.team(member.projectId) : [],
      tasks,
      messages: entries.map((e) => ({ from: e.urgent ? '긴급 지시' : e.ownerShared ? '긴급 지시(공유)' : '욱채', text: e.message, at: e.queuedAt })),
      // 메인 대화 세션: 부를 때 계산한 현황 요약 — 이 턴이 실은 일은 빼고 센다. 메인 검수 세션에는 넣지 않는다 (SERVER_DESIGN 5.1, 리드 결정 S5-4)
      ...(member.isMain && (kind === 'main_project' || kind === 'main_general') ? { digest: this.core.overview.digest({ sessionKey: identity.sessionKey, excludeEntryIds: new Set(entries.map((e) => e.id)) }) } : {}),
    };
  }

  /** 부른 턴이 실은 업무 — 현황의 '메인이 할 일'에서 뺀다 */
  private carried(identity: TokenIdentity): Set<string> {
    return new Set(this.ctx.store.queue.list({ ref2: identity.sessionKey }).filter((q) => q.turnId === identity.turnId).map((q) => q.id));
  }

  /**
   * get_member_activity (SERVER_DESIGN 5.2, 리드 결정 S5-6) — 팀원 한 줄, 최근 턴 5개, 한 턴의 마지막 이벤트. 어느 팀원이든(메인 에이전트·지운 팀원 포함) 본다 — 없는
   * ID만 not_found. 이벤트 파일은 끝에서 정해진 크기만 읽고, 원본(raw)은 싣지 않으며 글은 300자, data는 정해진 칸만. 전체가 12,000자를 넘으면 오래된 이벤트부터
   * 뺀다. 저장할 때 가렸어도 나중에 등록된 비밀 값까지 읽을 때 다시 가린다
   */
  private memberActivity(memberId: string, o: { limit?: number; turnId?: string }): MemberActivity {
    const ctx = this.ctx;
    const core = this.core;
    const m = ctx.store.members.get(memberId);
    if (!m) throw new BackendError('not_found', `팀원 ${memberId}을(를) 찾을 수 없습니다`);
    const limit = Math.min(Math.max(Math.trunc(o.limit ?? MEMBER_EVENTS_DEFAULT), 1), MEMBER_EVENTS_MAX);
    const view = core.views.memberView(m);
    const live = core.turns.liveOf(m.id);
    const last = core.turns.lastLineOf(m.id);
    const turns = ctx.store.turns.list({ ref1: m.id }, { desc: true, limit: MEMBER_TURNS_SHOWN });
    let turn: Turn | null = turns[0] ?? null;
    if (o.turnId) {
      turn = ctx.store.turns.get(o.turnId);
      if (!turn || turn.memberId !== m.id) throw new BackendError('not_found', `${m.name}(${m.id})의 턴 ${o.turnId}을(를) 찾을 수 없습니다`);
    }
    const out: MemberActivity = {
      member: {
        memberId: m.id,
        name: m.name,
        roleName: view.roleName,
        projectId: m.projectId,
        isProducer: m.isProducer,
        isMain: m.isMain,
        deleted: !!m.deletedAt,
        status: MEMBER_STATUS_LABEL[view.status],
        currentWork: live ? { turnId: live.turnId, work: live.label || WORK_KIND_LABEL[live.kind], startedAt: live.startedAt } : null,
        lastLine: last ? { text: cutText(ctx.redact.text(last.text), MEMBER_EVENT_TEXT_MAX), at: last.at } : null,
      },
      turns: turns.map((t) => {
        const generation = (t as typeof t & RunnerFields).seatGeneration;
        return {
          turnId: t.id,
          sessionKey: ctx.store.sessions.get(t.sessionId)?.workKey ?? '',
          projectId: t.projectId ?? t.workProjectId ?? null,
          taskId: t.taskId,
          startedAt: t.startedAt,
          endedAt: t.endedAt,
          endReason: t.endReason ? TURN_END_LABEL[t.endReason] : null,
          endDetail: cutText(ctx.redact.text(t.endDetail), 200),
          eventCount: t.eventCount,
          running: !t.endedAt || live?.turnId === t.id,
          ...(m.isMain && typeof generation === 'number' ? { generation } : {}),
        };
      }),
      turnId: turn?.id ?? null,
      events: [],
      omittedEvents: 0,
    };
    if (!turn) return ctx.redact.value({ ...out, message: '아직 턴 기록이 없습니다' });
    const tail = readTail(turn.eventsFile, MEMBER_EVENTS_TAIL_BYTES);
    const parsed: CliEvent[] = [];
    for (const raw of tail.lines) {
      try {
        parsed.push(JSON.parse(raw) as CliEvent);
      } catch {
        // 쓰는 중인 마지막 줄은 다음 조회에서 읽는다
      }
    }
    const shown = parsed.slice(-limit).map((ev) => {
      const data = ev.data ? pickEventData(ev.data, (x) => ctx.redact.text(x)) : null;
      return { seq: ev.seq, ts: ev.ts, kind: ev.kind, text: cutText(ctx.redact.text(ev.text ?? ''), MEMBER_EVENT_TEXT_MAX), ...(data ? { data } : {}) };
    });
    const total = Math.max(turn.eventCount, shown.length ? shown[shown.length - 1]!.seq : 0);
    const result = ctx.redact.value({ ...out, events: shown, omittedEvents: Math.max(0, total - shown.length) });
    // 전체 12,000자 안으로(안내 글 포함) — 오래된 이벤트부터 뺀다
    const note = (n: number): string | undefined => (n ? `앞 이벤트 ${n}건은 싣지 않았습니다 — turn_id·limit로 다시 보거나 search_activity로 찾으세요` : undefined);
    while (result.events.length && JSON.stringify({ ...result, message: note(result.omittedEvents) }).length > MEMBER_ACTIVITY_MAX_CHARS) {
      result.events.shift();
      result.omittedEvents += 1;
    }
    const message = note(result.omittedEvents);
    return message ? { ...result, message } : result;
  }

  /**
   * read_report (SERVER_DESIGN 5.2, 리드 결정 S5-6) — 보고 본문·대표 코멘트·통계·판정. 마크다운 원문과 파일 경로는 싣지 않는다(SEC-02). 변경 파일은 200개, 코멘트는
   * 50건 × 2,000자까지. 읽어도 대표의 읽음 표시('새 보고')는 그대로다 — 그것은 대표의 읽지 않음이다
   */
  private readReport(reportId: string): ReportReadout {
    const ctx = this.ctx;
    const r = ctx.store.reports.get(reportId);
    if (!r) throw new BackendError('not_found', `보고서 ${reportId}을(를) 찾을 수 없습니다`);
    const files = r.sections.changedFiles ?? [];
    const comments = ctx.store.reportComments.list({ ref1: r.id });
    const others = r.directiveId ? ctx.store.reports.list({ ref1: r.directiveId }).filter((x) => x.id !== r.id) : [];
    const text = (s: string, max: number) => cutText(ctx.redact.text(s), max);
    return ctx.redact.value({
      reportId: r.id,
      title: r.title,
      projectId: r.projectId,
      projectName: r.projectId ? (ctx.store.projects.get(r.projectId)?.name ?? r.projectId) : '일반',
      directiveId: r.directiveId,
      round: r.round,
      status: r.status,
      unread: r.status === 'new',
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      sections: {
        summary: r.sections.summary,
        results: r.sections.results,
        howToVerify: r.sections.howToVerify,
        issues: r.sections.issues,
        nextSteps: r.sections.nextSteps,
        changedFiles: { total: files.length, items: files.slice(0, REPORT_FILES_MAX).map((f) => text(f, 300)) },
      },
      stats: { ...r.stats },
      comments: { total: comments.length, items: comments.slice(0, REPORT_COMMENTS_MAX).map((c) => ({ id: c.id, kind: c.kind, quote: c.quote === null ? null : text(c.quote, REPORT_COMMENT_MAX), text: text(c.text, REPORT_COMMENT_MAX), createdAt: c.createdAt })) },
      otherRounds: others.map((x) => ({ reportId: x.id, round: x.round, status: x.status })),
      canApprove: this.core.reports.approveRefusal(r) === null,
      canRequestChanges: this.core.reports.requestChangesRefusal(r) === null,
    });
  }
}

/** search_activity 줄마다 글·결과의 상한 (리드 결정 S5-6) */
const ACTIVITY_TEXT_MAX = 1_000;
/** get_member_activity 상한 (리드 결정 S5-6) — 이벤트 기본 30·최대 100, 최근 턴 5개, 이벤트 글 300자, 전체 12,000자, 이벤트 파일은 끝에서 1MiB까지만 읽는다 */
const MEMBER_EVENTS_DEFAULT = 30;
const MEMBER_EVENTS_MAX = 100;
const MEMBER_TURNS_SHOWN = 5;
const MEMBER_EVENT_TEXT_MAX = 300;
const MEMBER_ACTIVITY_MAX_CHARS = 12_000;
const MEMBER_EVENTS_TAIL_BYTES = 1024 * 1024;
/** read_report 상한 (리드 결정 S5-6) */
const REPORT_FILES_MAX = 200;
const REPORT_COMMENTS_MAX = 50;
const REPORT_COMMENT_MAX = 2_000;
/** get_member_activity가 싣는 이벤트 data 칸 — 원본 출력·세션 ID 같은 것은 싣지 않는다 */
const EVENT_DATA_FIELDS = ['tool', 'server', 'command', 'exitCode', 'paths', 'ok', 'errorKind', 'isError', 'resetAt'] as const;

/** 줄 모양은 그대로 두고 max자에서 자른다 */
function cutText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 이벤트 data에서 정해진 칸만 — 명령은 300자, 파일은 20개 × 200자까지. 자르기 전에 가린다(잘린 비밀 값 앞부분이 남지 않게) */
function pickEventData(d: NonNullable<CliEvent['data']>, redact: (s: string) => string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const k of EVENT_DATA_FIELDS) {
    const v = d[k];
    if (v === undefined) continue;
    if (k === 'command' && typeof v === 'string') out[k] = cutText(redact(v), MEMBER_EVENT_TEXT_MAX);
    else if (k === 'paths' && Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => cutText(redact(String(x)), 200));
    else out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

const INSTRUCTION: Record<string, string> = {
  task_work: '작업 카드(task)를 확인하고 단계를 진행하세요. 단계마다 complete_step, 다 끝나면 submit_for_review 후 턴을 마치세요.',
  conflict_fix: 'conflictFiles의 충돌 표시를 정리해 두 변경을 합친 뒤 report_conflict_resolved를 호출하세요 (git 명령 없이 파일만 고침, 제출은 하지 않음).',
  review: 'get_review_target으로 고정된 대상을 확인하고, 완료 조건마다 근거를 남겨 submit_review로 판정하세요. 긴급 지시(urgentInstructions)가 있으면 그 지시가 완료 조건보다 우선합니다 (CTL-06).',
  plan: '지시를 작업으로 쪼개 create_task로 배정하세요. 수정 예정 영역이 겹치면 선행 작업으로 순서를 정하세요.',
  replan: '보류된 작업을 확인하고 replan_task(재계획·재배정) 또는 resolve_hold(막힘·선행 취소 조치)를 하세요.',
  answer: 'questions의 질문에 answer_question으로 답하세요.',
  merge_decision: 'mergeCandidates의 작업을 확인하고 request_merge로 병합을 요청하세요.',
  final_result: '이 회차 작업 결과를 정리해 submit_final_result를 호출하세요.',
  reviewer_assign:
    '검수가 지연된 작업에 assign_reviewer로 검수자를 정하세요 — 다른 적격 검수자, 적격 팀원이 없으면 "main"(메인 에이전트). 같은 검수자를 다시 정하면 그 검수자에게 검수를 다시 등록합니다. 그렇게 다시 등록한 검수도 판정 없이 끝나면 메인 에이전트에게 넘어갑니다.',
  main_command: '대표 명령을 처리하세요: 프로젝트 일이면 register_directive, 모호하면 ask_owner, 직접 처리할 일이면 처리 후 결과를 마지막 메시지로.',
  main_report: '프로듀서 결과를 정리해 submit_report로 대표에게 보고하세요.',
  memory_update: 'read_memory로 기억 문서를 읽고 대표 선호·결정을 반영해 write_memory로 저장하세요.',
  change_request:
    '대표가 보고서에 수정 요청을 했습니다. 다음 회차를 열려면 revise_directive(directive_id, report_id, instructions)를 호출하세요 — 대표 코멘트는 그대로 프로듀서에게 넘어갑니다. 요청이 모호하면 ask_owner로 묻고, 따로 처리할 일이면 새 지시로 처리해도 됩니다. 어떻게 처리했는지 마지막 메시지로 대표에게 알리세요.',
  ai_suggestion:
    '대표가 팀원의 AI(모델·노력치) 변경을 건의했습니다 — 명령이 아니라 건의라 대표 명령 우선(CTL-06)을 적용하지 않습니다. 그 팀원이 지금 맡은 일을 보고, 바꾸는 편이 나으면 아직 AI를 정하지 않은 팀원은 set_member_ai, 정한 팀원은 replace_member(프로듀서는 replace_producer)로 바꾸고, 지금 AI가 그 일에 맞으면 그대로 두세요. 어느 쪽이든 정한 것과 그 까닭을 마지막 메시지로 대표에게 알리세요.',
  stop_released:
    '대표가 긴급 정지를 해제했습니다. 보류된 작업은 저절로 재개되지 않습니다 — 목록의 작업마다 상태를 확인하고, 이어 가도 되는 것만 resume_task로 재개하세요. 재개하지 않은 것과 그 까닭은 마지막 메시지로 대표에게 알리세요.',
  no_reviewer:
    '적격 검수자가 없어 작업을 보류했습니다. 검수 권한 팀원을 add_member로 더하거나 프로듀서에게 assign_reviewer를 지시한 뒤 resume_task로 재개하세요 (메인 에이전트는 기여한 작업을 검수할 수 없습니다).',
  alert:
    '대표에게만 알림이 가던 보류·실패를 넘겨받았습니다. 항목마다 첫 줄의 대상과 원인, 보류 사유를 확인하고 적힌 도구(resume_task·resolve_recovery·resume_member·cancel_task·assign_reviewer·instruct_member 등)로 처리하세요 — 적힌 "못 하는 것"은 그 도구로 풀리지 않습니다. 같은 보류로는 다시 오지 않습니다. 처리하지 않은 것과 그 까닭은 마지막 메시지로 대표에게 알리세요.',
  message: '전달된 메시지를 확인하고 필요한 조치를 하세요.',
  screen_check:
    '새 메인 보유자가 화면 이미지를 볼 수 있는지 확인합니다. get_screen_check로 시험 이미지를 받아 보이는 네 자리 숫자를 answer_screen_check로 답하세요(한 번만). 파일을 프로그램으로 풀어 읽지 말고 이미지로 보세요 — 볼 수 없으면 짐작하지 말고 답하지 않은 채 턴을 마치세요.',
};
