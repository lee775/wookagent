/**
 * 앱 도구(MCP) 목록 — 이름·설명·입력 형식·역할 (15.3 역할별 앱 도구 표, CLI-07·08).
 * - 목록 공개는 역할 기준, 실제 허용 여부는 처리기(orchestrator/toolHandlers.ts)가 토큰·역할·프로젝트·배정·상태로 다시 확인한다.
 * - 상태를 바꾸는 도구는 request_id(선택)를 받는다. 같은 요청 재전송은 한 번만 반영 (REV-04, AC-45).
 * - 결과는 JSON 문자열 한 덩어리(text). 거부되면 isError + 한국어 사유.
 * - 모의 에이전트(resources/mock-agent/mock-agent.mjs)도 이 이름·인자를 그대로 쓴다.
 */
import { z } from 'zod';
import type {
  AiKind,
  DirectiveState,
  HoldReasonKind,
  MemberId,
  OutputMode,
  Priority,
  ProjectId,
  RunnerKind,
  SessionKind,
  TaskId,
  TaskState,
  TaskType,
  WorkKind,
} from '@shared/domain';
import { EFFORT_LEVELS } from '@shared/domain';
import type { AiStatusView, SeatView } from '@shared/views';
import { BACKUP_KEEP_LIMIT, EXECUTION_NO_LIMIT_NOTE, executionRangesText } from '../orchestrator/settingsPolicy';
import { HOST_COMMAND_GUARD_LIMITS } from '@core/hostCommandGuard';
import { HOST_EXEC_MAX_TIMEOUT_S } from '../agents/common';

/** main=메인 에이전트, producer=프로듀서, member=모든 프로젝트 팀원(프로듀서 포함), reviewer=검수 권한 팀원 */
export type ToolRole = 'main' | 'producer' | 'member' | 'reviewer';

export interface ToolSpec {
  name: string;
  description: string;
  roles: ToolRole[];
  /** zod 객체 모양 (MCP SDK registerTool의 inputSchema) */
  input: z.ZodRawShape;
  mutating: boolean;
}

const requestId = z.string().max(120).optional().describe('같은 요청을 다시 보낼 때 같은 값을 쓰면 한 번만 반영됩니다');
/** 작업 유형 — domain.ts TaskType에서 'revert'(프로그램이 만든다, GIT-10)만 뺀다. 'asset' = 음원·이미지·3D 모델 같은 에셋 (리드 결정 S5-2·S5-15) */
const taskType = z.enum(['plan', 'spec', 'architecture', 'development', 'bugfix', 'design', 'test', 'docs', 'research', 'simulation', 'asset']);
const priority = z.enum(['urgent', 'high', 'normal', 'low']);
const effortTier = z.enum(['high', 'normal', 'low']);
/** 노력치 값 안내는 실행 전 검사와 같은 목록에서 만든다 (windows:F7) */
const effortValues = `claude: ${EFFORT_LEVELS.claude.join('|')}, codex: ${EFFORT_LEVELS.codex.join('|')}`;
/** 메인 에이전트 운영 도구의 사유 — 활동 기록과 대표 알림에 남는다 (SERVER_DESIGN 2.6) */
const mainReason = z.string().min(1).max(2000).describe('이 조작을 하는 까닭 (대표 명령 요지 등). 활동 기록과 대표 알림에 남습니다');
/** 팀원 이름의 규칙 (team.uniqueName·renamed, 대표 지시 2026-11-16) — 사무실 화면에서 머리 위에 뜨는 이름이다 */
const MEMBER_NAME_RULE = '팀원 이름 — 한글 2~4자의 사람 이름(예: 서진, 윤슬). "코덱스 개발1"·"검수 담당"처럼 AI 종류·역할·번호로 만든 이름은 받지 않습니다';
/** 새 팀원의 이름 (add_member·replace_producer) — 생략하거나 사람 이름이 아니면 프로그램이 짓는다 */
const memberNameArg = z.string().max(40).optional().describe(`${MEMBER_NAME_RULE}. 생략하면 프로그램이 사람 이름을 지어 줍니다(권장) — 사람 이름이 아니거나 같은 프로젝트에 이미 있는 이름을 주어도 프로그램이 짓고, 결과의 name이 실제 이름입니다`);
const stopModeArg = z.enum(['graceful', 'immediate']).describe('graceful=지금 단계를 마치고 정지, immediate=바로 정지');
const interruptThen = z.enum(['hold', 'cancel']).describe('hold=보류(재개는 resume_task), cancel=작업 취소');
const roleAiArg = z.object({
  kind: z.enum(['claude', 'codex']),
  model: z.string().max(80).nullable().optional().describe('null이면 CLI 기본 모델'),
  effort_tier: effortTier,
  effort: z.string().max(20).nullable().optional().describe(`CLI 실제 노력치 값 (${effortValues})`),
});

export const TOOL_SPECS = [
  // ───── 공통 ─────
  {
    name: 'get_work_context',
    description: '지금 맡은 업무의 전체 정보(작업 카드, 지시, 검수 대상, 질문, 팀 구성, 지금 할 일)를 받습니다. 턴을 시작하면 가장 먼저 호출하세요.',
    roles: ['main', 'producer', 'member', 'reviewer'],
    input: {},
    mutating: false,
  },
  {
    name: 'send_message',
    description: '다른 팀원에게 메시지를 보냅니다. 일반 팀원은 프로듀서에게만 보낼 수 있습니다. to에 팀원 ID 또는 "producer"·"main"을 넣으세요.',
    roles: ['main', 'producer', 'member'],
    input: { to: z.string().min(1), text: z.string().min(1).max(8000), request_id: requestId },
    mutating: true,
  },

  // ───── 메인 에이전트 ─────
  {
    name: 'list_projects',
    description: '등록된 프로젝트와 각 프로젝트의 진행 상황 요약을 봅니다.',
    roles: ['main'],
    input: {},
    mutating: false,
  },
  {
    name: 'get_project_status',
    description: '프로젝트의 팀 구성, 진행 중 지시·작업, 최근 보고를 봅니다.',
    roles: ['main'],
    input: { project_id: z.string() },
    mutating: false,
  },
  {
    name: 'create_project',
    description: '새 프로젝트를 등록합니다. mode=existing은 기존 폴더 연결, new는 새 폴더 생성. 프로듀서가 자동 배치됩니다.',
    roles: ['main'],
    input: { name: z.string().min(1).max(80), path: z.string().min(1), mode: z.enum(['existing', 'new']), request_id: requestId },
    mutating: true,
  },
  {
    name: 'add_member',
    description:
      '프로젝트에 팀원을 추가합니다. 역할을 고르면 AI 종류·모델·노력치 기본값이 채워지고, 맡길 일의 난이도에 맞게 ai_kind·model·effort를 직접 정할 수 있습니다(list_ai_options 참고). AI를 직접 정할 때는 model도 함께 정합니다 — 모델이 비면 거부됩니다. 아무것도 정하지 않고 추가하면 역할 기본값이고, 모델은 이어서 set_member_ai로 정합니다. 정했으면 reason에 판단 근거를 적으세요.',
    roles: ['main'],
    input: {
      project_id: z.string(),
      role_id: z.string(),
      name: memberNameArg,
      ai_kind: z.enum(['claude', 'codex']).optional(),
      model: z.string().max(80).optional().describe('list_ai_options의 models[ai_kind]에 있는 id (표시 이름 아님). 생략하면 역할 기본값'),
      effort_tier: effortTier.optional(),
      effort: z.string().max(20).optional().describe(`CLI 실제 노력치 값 (${effortValues}). effort_tier보다 우선`),
      reason: z.string().max(1000).optional(),
      request_id: requestId,
    },
    mutating: true,
  },
  {
    name: 'list_ai_options',
    description:
      '팀원에게 정할 수 있는 AI 종류별 모델 목록(용도 설명 포함)·노력치 값, 노력치 단계 연결, 그리고 각 팀원의 현재 AI 설정과 정한 주체·사유를 봅니다. 팀원의 model·effort는 실제로 CLI에 넘기는 값입니다 (모델을 정하지 않은 Codex 팀원은 models.codex 첫 항목). usageLimits는 걸려 있는 사용량 한도입니다: until은 그 AI 종류 전체, models는 모델별 주간 한도(opus·sonnet·fable → 기한)로 그 계열 모델(모델을 정하지 않은 팀원 포함)의 턴만 쉽니다 — 다른 계열 모델을 정하면 새 세션부터 그 모델로 실행됩니다.',
    roles: ['main'],
    input: { project_id: z.string().optional() },
    mutating: false,
  },
  {
    name: 'set_member_ai',
    description:
      '팀원의 AI 종류·모델·노력치를 판단해 정합니다. 모델은 꼭 정합니다 — 정한 결과에 모델이 없으면 거부하고 그 AI 종류의 모델 목록을 알려 줍니다. 맡은 일이 어렵거나 검수·설계처럼 깊은 판단이 필요하면 모델과 노력치를 높게, 단순 반복이면 낮게. 실행 중인 작업이 있으면 그 작업이 끝난 뒤 적용됩니다.',
    roles: ['main'],
    input: {
      member_id: z.string(),
      ai_kind: z.enum(['claude', 'codex']).optional(),
      model: z
        .string()
        .max(80)
        .nullable()
        .optional()
        .describe('list_ai_options의 models[ai_kind]에 있는 id (표시 이름 아님). 생략하면 지금 값 유지 — 지금 모델이 정해져 있지 않으면 꼭 줍니다. ai_kind를 바꾸면 그 종류의 모델을 함께 줍니다. null(CLI 기본 모델)은 그 AI 종류의 모델 목록이 비어 있을 때만 받습니다'),
      effort_tier: effortTier.optional(),
      effort: z.string().max(20).nullable().optional().describe(`CLI 실제 노력치 값 (${effortValues}). null이면 단계(effort_tier) 연결값 사용`),
      reason: z.string().min(1).max(1000),
      request_id: requestId,
    },
    mutating: true,
  },
  {
    name: 'remove_member',
    description: '팀원을 삭제합니다. 프로듀서는 삭제할 수 없습니다(교체만 가능).',
    roles: ['main'],
    input: { member_id: z.string(), request_id: requestId },
    mutating: true,
  },
  {
    name: 'register_directive',
    description: '대표의 명령을 지시로 등록해 프로젝트 프로듀서에게 전달합니다. 명령이 모호하면 등록하지 말고 ask_owner로 먼저 질문하세요.',
    roles: ['main'],
    input: {
      project_id: z.string(),
      title: z.string().min(1).max(120),
      text: z.string().min(1).max(20000),
      attachment_ids: z.array(z.string()).optional(),
      request_id: requestId,
    },
    mutating: true,
  },
  {
    name: 'instruct_member',
    description:
      '프로듀서를 거치지 않고 팀원에게 직접 지시합니다(수동 스킬 사용 지시 등 필요할 때만). 같은 내용이 프로듀서에게 공유됩니다. urgent=true는 긴급 지시입니다 — 그 팀원의 지금 턴이 끝난 뒤 같은 업무 세션 맨 앞에 전달하고, 검수·병합 전에 반드시 전달하며, 통과 뒤에 오면 검수자가 다시 판정합니다(완료 조건·프로듀서 지시보다 우선). 대표의 정정처럼 병합에 늦으면 안 되는 지시에 쓰세요. urgent="interrupt"는 지금 턴을 끝내고 바로 전달합니다. 팀원·프로젝트 일시정지나 작업 보류 중이면 저장만 하고 재개 때 먼저 전달합니다(긴급 정지 중에는 거부됩니다). 대표 화면에는 팀원에게 직접 보내는 길이 없으니, 대표가 팀원에게 할 말을 명령하면 이것으로 전합니다.',
    roles: ['main'],
    input: {
      member_id: z.string(),
      text: z.string().min(1).max(8000),
      skill: z.string().optional(),
      urgent: z.union([z.boolean(), z.literal('interrupt')]).optional().describe('true=긴급 지시(지금 턴 뒤 맨 앞 전달), "interrupt"=지금 턴을 끝내고 바로 전달, 생략·false=보통 지시'),
      request_id: requestId,
    },
    mutating: true,
  },
  {
    name: 'ask_owner',
    description: '대표에게 질문합니다. 호출 후 턴을 마치세요. 답변은 다음 턴에 전달됩니다.',
    roles: ['main'],
    input: { question: z.string().min(1).max(4000), request_id: requestId },
    mutating: true,
  },
  {
    name: 'submit_report',
    description: '대표에게 보고서를 제출합니다. 작업 통계는 프로그램이 채웁니다. directive_id가 없으면 메인 에이전트 직접 명령 보고서(일반 폴더)입니다.',
    roles: ['main'],
    input: {
      directive_id: z.string().optional(),
      title: z.string().max(120).optional(),
      summary: z.string().min(1).max(1200).describe('결과 요약 3줄 이내 (넘으면 거부 — 자세한 내용은 results에)'),
      results: z.string().max(20000).describe('한 일, 산출물'),
      changed_files: z.array(z.string()).default([]),
      how_to_verify: z.string().max(8000).describe('대표가 결과를 직접 확인하는 방법'),
      issues: z.string().max(8000).default(''),
      next_steps: z.string().max(8000).default(''),
      request_id: requestId,
    },
    mutating: true,
  },
  {
    name: 'read_memory',
    description: '프로젝트 기억 문서(목표·상태·주요 결정·진행 중 지시·최근 보고·대표 선호)를 읽습니다. project_id가 없으면 일반 기억.',
    roles: ['main'],
    input: { project_id: z.string().optional() },
    mutating: false,
  },
  {
    name: 'write_memory',
    description: '프로젝트 기억 문서를 통째로 갱신합니다. 기존 내용을 읽고 필요한 부분만 고쳐서 전체를 보내세요.',
    roles: ['main'],
    input: { project_id: z.string().optional(), content: z.string().max(60000), request_id: requestId },
    mutating: true,
  },
  {
    // 메인 자리 넘기기 (SERVER_DESIGN 4.3, 리드 결정 S4-3) — 자리를 바꾸는 것은 처리기의 SeatService.assign 하나다
    name: 'hand_off_seat',
    description:
      '메인 에이전트 자리를 다른 AI에게 넘깁니다 (대표가 "Codex에게 메인을 넘겨"라고 명령할 때 등). to: "claude"·"codex" — 서버가 띄우는 CLI입니다. 운영자가 정한 보유자 목록 안에서 설치되고 로그인된 CLI에게만 넘길 수 있습니다. 이 턴을 마치면 넘어가고, 그동안 다른 메인 일은 시작하지 않습니다. 같은 AI에서 모델·노력치만 바꾸면 자리는 그대로이고 다음 턴부터 적용됩니다. 외부 에이전트에게는 "external:<ID>"(예: "external:X-0001")로 넘깁니다 — 서버 PC의 운영자가 등록하고 폐기하지 않은 에이전트만 됩니다.',
    roles: ['main'],
    input: {
      to: z.string().min(1).max(80).describe('넘길 보유자: "claude"·"codex" (또는 "launched:claude"·"launched:codex"), 등록된 외부 에이전트는 "external:<ID>"'),
      model: z.string().max(80).nullable().optional().describe('그 AI의 모델 목록 id (null이면 CLI 기본 모델, 생략하면 같은 AI일 때 지금 값)'),
      effort_tier: effortTier.optional(),
      effort: z.string().max(20).nullable().optional().describe(`CLI 실제 노력치 값 (${effortValues})`),
      reason: mainReason,
      note: z.string().max(2000).optional().describe('다음 메인 에이전트에게 남길 말 (자리 이력에 남습니다)'),
      request_id: requestId,
    },
    mutating: true,
  },
  {
    // 메인 일지 (SERVER_DESIGN 6.1, 리드 결정 S4-6) — 서버가 쓰는 사실과 따로, 메인이 남기는 주장이다. 쓴 보유자와 세대가 붙는다
    name: 'journal_write',
    description:
      '메인 일지에 다음 메인 에이전트가 이어받을 것을 적습니다 — kind "decision"(정한 것), "promise"(지킬 약속), "note"(그 밖에 알릴 것). 약속은 지시(D-)나 질문(Q-) ID를 refs에 넣거나, 언제 무엇으로 닫을지 reason에 적어야 하고, 지킨 뒤에는 journal_close로 닫습니다. 한 줄 1,000자, 한 턴에 5건까지입니다. 비밀 값은 가려져 저장됩니다. 메인 자리가 바뀌면 인계 꾸러미의 메모 칸으로 새 메인에게 갑니다.',
    roles: ['main'],
    input: {
      kind: z.enum(['decision', 'promise', 'note']),
      text: z.string().min(1).max(4000).describe('남길 내용 (1,000자까지 — 넘으면 거부됩니다)'),
      project_id: z.string().optional().describe('관련 프로젝트 (없으면 이 대화의 프로젝트, 직접 명령이면 전체)'),
      refs: z.array(z.string().max(40)).max(10).optional().describe('관련 ID: 지시 D-…, 질문 Q-…, 보고서 R-…, 작업 T-…, 프로젝트 P-…, 팀원 M-…'),
      reason: z.string().max(1000).optional().describe('지시·질문을 참조하지 않는 약속은 언제 무엇으로 닫을지'),
      request_id: requestId,
    },
    mutating: true,
  },
  {
    name: 'journal_close',
    description: '메인 일지의 열린 약속을 닫습니다. 이전 메인 에이전트가 한 약속도 지금 메인이 닫습니다. resolution에 어떻게 지켰는지(또는 왜 더 지키지 않는지)를 적으세요.',
    roles: ['main'],
    input: { id: z.string().min(1).max(40).describe('약속 ID (J-…)'), resolution: z.string().min(1).max(4000), request_id: requestId },
    mutating: true,
  },
  {
    name: 'get_handover',
    description:
      '메인 자리 인계 꾸러미를 봅니다 — 서버가 기록에서 만든 자리 정보·확인된 사실·이전 메인의 메모·기억 문서 위치입니다. 기본은 이 세대가 넘겨받은 꾸러미이고, latest: true면 지금 기록으로 다시 만든 최신판입니다.',
    roles: ['main'],
    input: { generation: z.number().int().positive().optional().describe('그 세대가 넘겨받은 꾸러미'), latest: z.boolean().optional() },
    mutating: false,
  },

  // ───── 메인 에이전트 운영 도구 (SERVER_DESIGN 2.6) — 대표는 명령만 하고, 운영은 메인 에이전트가 이 도구로 한다 ─────
  {
    name: 'update_project',
    description: '프로젝트 이름·자동 검사 명령·네트워크 방침·배포 설정을 바꿉니다. 바꿀 항목만 주세요.',
    roles: ['main'],
    input: {
      project_id: z.string(),
      name: z.string().min(1).max(80).optional(),
      check_commands: z.array(z.string().min(1).max(400)).max(20).optional(),
      network_policy: z.enum(['allow', 'restricted']).optional(),
      deploy: z.object({ push_remote: z.string().max(200).nullable().optional(), deploy_command: z.string().max(400).nullable().optional() }).optional().describe('null이면 그 작업을 만들지 않음'),
      reason: mainReason,
      request_id: requestId,
    },
    mutating: true,
  },
  {
    name: 'pause_project',
    description: '프로젝트를 일시정지합니다. graceful은 지금 단계를 마치고, immediate는 바로 멈춥니다. 재개는 resume_project로 합니다.',
    roles: ['main'],
    input: { project_id: z.string(), mode: stopModeArg, reason: mainReason, request_id: requestId },
    mutating: true,
  },
  {
    name: 'resume_project',
    description: '일시정지한 프로젝트를 재개합니다. 긴급 정지로 보류된 작업은 풀지 않습니다(긴급 정지 해제는 대표, 그 뒤 항목별 재개는 resume_task).',
    roles: ['main'],
    input: { project_id: z.string(), reason: mainReason, request_id: requestId },
    mutating: true,
  },
  {
    name: 'update_member',
    description: '팀원의 이름이나 역할을 바꿉니다. 프로듀서를 다른 역할로, 다른 팀원을 프로듀서 역할로 바꿀 수는 없습니다(교체는 replace_producer). AI는 set_member_ai로 정합니다.',
    roles: ['main'],
    input: { member_id: z.string(), name: z.string().min(1).max(40).optional().describe(MEMBER_NAME_RULE), role_id: z.string().optional(), reason: mainReason, request_id: requestId },
    mutating: true,
  },
  {
    name: 'replace_producer',
    description:
      '프로젝트의 프로듀서를 새 프로듀서로 교체합니다. 남은 관리 업무와 맡던 작업·검수는 새 프로듀서가 잇습니다. AI 인자는 add_member와 같습니다. 지금 프로듀서에 관한 "보류·실패 처리" 알림(남은 프로세스 등)을 아직 받지 않았으면(대기 중) 바꾸지 않고 그 알림을 거부 글(conflict)에 옮겨 한 번 보여 줍니다 — 확인한 뒤 다시 부르면 바꿉니다.',
    roles: ['main'],
    input: {
      project_id: z.string(),
      name: memberNameArg,
      ai_kind: z.enum(['claude', 'codex']).optional(),
      model: z.string().max(80).optional().describe('list_ai_options의 models[ai_kind]에 있는 id'),
      effort_tier: effortTier.optional(),
      effort: z.string().max(20).optional().describe(`CLI 실제 노력치 값 (${effortValues})`),
      reason: mainReason,
      request_id: requestId,
    },
    mutating: true,
  },
  {
    name: 'pause_member',
    description: '팀원을 일시정지합니다(맡은 작업은 보류). graceful은 지금 단계를 마치고, immediate는 바로 멈춥니다. 재개는 resume_member로 합니다.',
    roles: ['main'],
    input: { member_id: z.string(), mode: stopModeArg, reason: mainReason, request_id: requestId },
    mutating: true,
  },
  {
    name: 'resume_member',
    description:
      '일시정지한 팀원을 재개합니다. 프로세스 종료를 확인하지 못해 프로그램이 건 일시정지도 남은 프로세스를 확인한 뒤 이것으로 풉니다. 메인 에이전트 자신의 일시정지는 대표의 정지 해제로 풀립니다. 그 팀원에 관한 알림(남은 프로세스·일시정지된 팀원의 재개 등)을 아직 받지 않았으면(대기 중) 재개하지 않고 그 알림을 거부 글(conflict)에 옮겨 한 번 보여 줍니다 — 확인한 뒤 다시 부르면 재개합니다.',
    roles: ['main'],
    input: { member_id: z.string(), reason: mainReason, request_id: requestId },
    mutating: true,
  },
  {
    name: 'interrupt_member',
    description: '팀원의 지금 작업(또는 검수 중인 작업)을 중단합니다. then=hold는 보류(재개는 resume_task), cancel은 그 작업을 취소합니다.',
    roles: ['main'],
    input: { member_id: z.string(), then: interruptThen, reason: mainReason, request_id: requestId },
    mutating: true,
  },
  {
    name: 'interrupt_task',
    description: '작업을 중단합니다. then=hold는 보류(재개는 resume_task), cancel은 작업을 취소합니다.',
    roles: ['main'],
    input: { task_id: z.string(), then: interruptThen, reason: mainReason, request_id: requestId },
    mutating: true,
  },
  {
    name: 'resume_task',
    description:
      '보류된 작업을 항목별로 재개합니다(중단 보류, 긴급 정지 해제 뒤 보류, 종료 확인 실패 보류, 오류 보류 등). 업무 "정지 해제"의 목록, 업무 "검수자 없음"(검수자를 정할 길을 마련한 뒤), 다시 판정 실패 보류(재개하면 등록한 통과로 이어 감)도 이것으로 재개합니다. 긴급 정지 중에는 쓸 수 없고, 다른 보류 사유(답변 대기·재계획·일시정지 등)가 남으면 실행하지 않고 남은 사유를 알려 줍니다. 함께 풀릴 보류의 "보류·실패 처리" 알림을 아직 받지 않았으면(대기 중) 재개하지 않고 그 알림을 거부 글(conflict)에 옮겨 한 번 보여 줍니다 — 확인한 뒤 다시 부르면 재개합니다. 재개하면 결과에 푼 보류 사유(released)가 있습니다.',
    roles: ['main'],
    input: { task_id: z.string(), reason: mainReason, request_id: requestId },
    mutating: true,
  },
  {
    name: 'cancel_directive',
    description: '지시 전체를 취소합니다. 미완료 하위 작업만 취소되고 완료된 결과는 유지됩니다(TSK-09). 되돌려야 하면 프로듀서에게 되돌리기를 지시하세요.',
    roles: ['main'],
    input: { directive_id: z.string(), reason: mainReason, request_id: requestId },
    mutating: true,
  },
  {
    name: 'revise_directive',
    description:
      '대표가 보고서에 수정 요청을 하면(업무 "수정 요청") 그 지시의 다음 회차를 엽니다: 회차 +1, 확인 대기 → 계획, 프로듀서가 새 작업으로 계획합니다(이전 회차 작업·보고서는 그대로). 대표 코멘트(전체·부분)는 그대로 프로듀서에게 넘어가고 instructions를 함께 줍니다. 확인 대기 지시의 지금 회차 보고서만 받습니다. 회차를 열지 않고 대표에게 되묻거나 새 지시로 처리해도 됩니다 — 그때는 대표에게 그 보고서를 그대로 결과 승인할 수 있다고 알리거나 cancel_directive로 지시를 취소합니다. 대표가 그대로 승인한 뒤에는 거부됩니다(conflict).',
    roles: ['main'],
    input: {
      directive_id: z.string(),
      report_id: z.string().describe('대표가 수정 요청한 보고서 ID (업무 "수정 요청"에 있음)'),
      instructions: z.string().min(1).max(8000).describe('프로듀서에게 줄 이번 회차 지시 — 활동 기록과 대표 알림에 사유로 남습니다'),
      request_id: requestId,
    },
    mutating: true,
  },
  {
    name: 'resolve_recovery',
    description:
      '실행 여부가 불명확해 복구 확인으로 보류된 항목을 처리합니다(ERR-08 — v0.6에서 대표 대신 메인 에이전트가 함). recovery_id는 그 실행의 requestId — 업무 "보류·실패 처리"로 온 복구 확인 글과 get_overview의 메인이 할 일(main.recovery)에 있습니다. action: applied(이미 반영됨 — 결과를 직접 확인한 뒤), retry(다시 실행), cancel(작업 취소). 그 복구 확인의 알림을 아직 받지 않았으면(대기 중) 처리하지 않고 그 알림을 거부 글(conflict)에 옮겨 한 번 보여 줍니다 — 확인한 뒤 다시 부르면 처리합니다.',
    roles: ['main'],
    input: { recovery_id: z.string().min(1), action: z.enum(['applied', 'retry', 'cancel']), reason: mainReason, request_id: requestId },
    mutating: true,
  },
  {
    name: 'update_settings',
    description:
      '운영 설정을 바꿉니다. patch는 바꿀 항목만 담은 부분 설정입니다. 바꿀 수 있는 것: execution(실행 상한 maxConcurrent·턴 상한·오류 기준·preventSleep 절전 방지), team.effortMapping(노력치 연결), team.modelCatalog(모델 목록), account.authMode(AI 종류별 "subscription"(구독)·"api_key"(API 키 방식) — 키 값은 운영자가 등록), general.backup.keep(백업 보관 수). 그 밖의 항목은 운영자 몫이라 거부됩니다(바꾼 것 없이 거부·기록): 계정·구글·API 키 값·CLI 실행 파일 위치·메인 AI·개발자 옵션, 보안 정책 policy(민감 영역·긴급 정지 단축키), 기록 보관 기간 logs.retentionDays, 자동 백업 켜기 general.backup.enabled, 로그인 때 실행 general.launchAtLogin. ' +
      `execution 값의 단위와 범위: ${executionRangesText()}. general.backup.keep은 ${BACKUP_KEEP_LIMIT.min}~${BACKUP_KEEP_LIMIT.max} 정수, team.modelCatalog는 claude·codex별 배열이고 항목은 {id: 문자열, label: 문자열, note: 문자열(생략 가능)}입니다. 범위 밖이거나 형식이 다른 값(문자열 "0", 객체 등)은 invalid로 거부되고 아무것도 저장되지 않습니다. ${EXECUTION_NO_LIMIT_NOTE}.`,
    roles: ['main'],
    input: { patch: z.record(z.string(), z.unknown()), reason: mainReason, request_id: requestId },
    mutating: true,
  },
  {
    name: 'set_skill_mode',
    description: '스킬의 자동·수동 구분을 바꿉니다. 수동 스킬은 팀원에게 사용을 지시할 때만 씁니다. 이름은 프로그램이 찾은 스킬이나 이미 구분을 정해 둔 스킬만 받습니다.',
    roles: ['main'],
    input: { name: z.string().min(1).max(120), mode: z.enum(['auto', 'manual']), reason: mainReason, request_id: requestId },
    mutating: true,
  },
  {
    name: 'list_roles',
    description:
      '역할 목록(이름·지침·맡는 작업 유형·기본 AI·허용 스킬·검수 권한·만든 쪽(createdBy — 기록일 뿐 누가 만들었든 고칠 수 있음)·그 역할의 팀원 수)을 봅니다. add_member의 role_id는 여기서 고르세요.',
    roles: ['main'],
    input: {},
    mutating: false,
  },
  {
    name: 'create_role',
    description:
      '새 역할(예: 사운드 — task_types ["asset","research"])을 만듭니다. allowed_skills는 프로그램이 찾은 스킬 이름만 받습니다(없는 이름이면 찾은 스킬 목록과 함께 거부합니다). 검수 권한(can_review)을 주면 그 역할 팀원이 검수자가 될 수 있습니다. 대표에게 알림이 갑니다.',
    roles: ['main'],
    input: {
      name: z.string().min(1).max(40),
      instructions: z.string().max(8000),
      task_types: z.array(taskType).min(1),
      default_ai: roleAiArg,
      allowed_skills: z.array(z.string().min(1).max(120)).default([]),
      can_review: z.boolean(),
      reason: mainReason,
      request_id: requestId,
    },
    mutating: true,
  },
  {
    name: 'update_role',
    description:
      '역할을 고칩니다. 주지 않은 항목은 그대로입니다. 기본 역할도 이름·지침·맡는 작업 유형·기본 AI·허용 스킬·검수 권한을 고칠 수 있지만, 프로듀서 역할의 검수 권한은 끌 수 없습니다. 검수 권한을 끄면 그 역할 팀원이 맡던 검수는 바로 다른 검수자로 바뀝니다. allowed_skills에 새로 넣는 이름은 프로그램이 찾은 스킬만 받고, 이미 있던 이름은 그대로 둡니다. 대표에게 알림이 갑니다.',
    roles: ['main'],
    input: {
      role_id: z.string(),
      name: z.string().min(1).max(40).optional(),
      instructions: z.string().max(8000).optional(),
      task_types: z.array(taskType).min(1).optional(),
      default_ai: roleAiArg.optional(),
      allowed_skills: z.array(z.string().min(1).max(120)).optional(),
      can_review: z.boolean().optional(),
      reason: mainReason,
      request_id: requestId,
    },
    mutating: true,
  },
  {
    name: 'delete_role',
    description: '역할을 지웁니다. 기본 역할과 팀원이 있는 역할은 지울 수 없습니다.',
    roles: ['main'],
    input: { role_id: z.string(), reason: mainReason, request_id: requestId },
    mutating: true,
  },
  {
    name: 'recheck_ai',
    description: 'Claude·Codex CLI의 설치·버전·로그인 상태를 다시 확인합니다.',
    roles: ['main'],
    input: { kind: z.enum(['claude', 'codex']), reason: mainReason, request_id: requestId },
    mutating: true,
  },
  {
    name: 'backup_now',
    description: '앱 데이터(DB·보고서·기억)를 지금 백업합니다. 하루 1회 자동 백업은 따로 돕니다.',
    roles: ['main'],
    input: { reason: mainReason, request_id: requestId },
    mutating: true,
  },
  {
    name: 'search_activity',
    description: '활동 기록을 찾습니다(대표의 활동 기록 화면과 같은 기록). 최근 것부터, limit 기본 50·최대 200. 줄마다 글(text)과 결과(result)는 1,000자까지 보입니다.',
    roles: ['main'],
    input: {
      text: z.string().max(200).optional(),
      project_id: z.string().optional(),
      member_id: z.string().optional(),
      task_id: z.string().optional(),
      kinds: z.array(z.string()).optional(),
      level: z.enum(['info', 'warn', 'error']).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      before_seq: z.number().int().optional(),
    },
    mutating: false,
  },
  // 서버 명령 (SERVER_DESIGN 8.2·8.4, 리드 결정 S5-16~S5-19) — 상태를 바꾸는 도구라 정지 중·인계 메모 턴에는 거부된다
  {
    name: 'host_exec',
    description: [
      '이 앱이 도는 PC에서 셸 명령 하나를 돌리고 끝날 때까지 기다립니다 — 설치(winget·npm -g·apt 등)도 됩니다. 앱의 기록과 정지 안에서 돌아 긴급 정지·턴 끝·앱 종료 때 함께 끝납니다.',
      'cwd를 주지 않으면 메인 작업 폴더에서 돕니다. 앱 데이터 폴더와 등록된 프로젝트 폴더(그 안, 그 폴더를 품은 상위 폴더, 연결 지점이 닿는 폴더 포함)는 cwd로 받지 않습니다 — 이 검사는 실행 위치(cwd)만 보며 격리가 아닙니다(명령 안의 cd·절대 경로는 보지 않습니다). 프로젝트 파일은 이 도구로 고치지 말고 지시로 처리하세요.',
      `디스크 포맷·diskpart·mkfs·디스크로 dd·루트 삭제·서버 PC 종료·재시작·서버 종료 명령, 서버 운영자 명령(wook-server·node out/server/index.mjs·npm run start:server — 하위 명령 모두), 앱 데이터 폴더나 그 안의 관리 파일(admin.token·admin.endpoint·setup-code.txt)을 가리키는 명령은 거부합니다. ${HOST_COMMAND_GUARD_LIMITS}`,
      '명령이나 cwd에 비밀 값이 들어 있으면 실행하지 않습니다. 출력에 찍힌 비밀 값(앱이 아는 키·토큰과 그 형식)은 가려서 돌려줍니다. 환경 변수에서 앱 도구 토큰·API 키와 토큰·비밀번호 이름의 변수를 빼므로, 토큰이 필요한 설치는 그 PC의 운영자가 해야 합니다 — ask_owner로 대표에게 알리세요.',
      '표준 입력이 닫혀 있어 묻는 설치는 답을 받지 못합니다 — winget은 --accept-source-agreements --accept-package-agreements를 붙이세요. 관리자 권한(UAC)이 필요한 명령은 실패하거나 시간 상한까지 기다립니다.',
      `timeout_s는 기본 300초·최대 ${HOST_EXEC_MAX_TIMEOUT_S.toLocaleString('en-US')}초이고 실행 명령 상한과 이 턴의 남은 시간 안으로 줄어듭니다. 한 번에 하나만 돕니다. request_id는 꼭 주세요 — 다시 보낼 때 같은 값이면 한 번만 실행됩니다.`,
      '결과: 종료 코드(exit_code), 시간 초과(timed_out), 무엇이 끝냈는지(stopped), 출력(output — 비밀 값은 가리고 앞 16KiB + 뒤 48KiB, 줄 단위로 자름), 남은 하위 프로세스(leftover — 0이 아니면 이 턴에는 더 실행하지 않고 턴이 끝나면 메인 에이전트가 일시정지됩니다). background는 6단계에서 붙습니다.',
    ].join(' '),
    roles: ['main'],
    input: {
      command: z.string().min(1).max(8000).describe('실행할 셸 명령 (Windows는 cmd.exe, 그 밖은 /bin/sh)'),
      cwd: z.string().max(1024).optional().describe('실행할 폴더의 절대 경로 — 없으면 메인 작업 폴더'),
      timeout_s: z.number().int().min(1).max(HOST_EXEC_MAX_TIMEOUT_S).optional().describe('시간 상한(초), 기본 300'),
      purpose: z.string().min(1).max(300).describe('이 명령을 돌리는 까닭 — 활동 기록과 메인 일지에 남습니다'),
      request_id: z.string().min(1).max(120).describe('꼭 주세요 — 같은 호출을 다시 보낼 때 같은 값이면 명령이 한 번만 돕니다'),
      background: z.boolean().optional().describe('6단계에서 붙습니다 — 지금은 켜면 거부됩니다'),
    },
    mutating: true,
  },
  // 전체 그림과 조회 (SERVER_DESIGN 5.2, 리드 결정 S5-3·S5-6) — 모두 조회 도구라 정지 중에도, 인계 메모 턴에도 쓴다
  {
    name: 'get_overview',
    description:
      '전체 현황을 봅니다: 메인 자리(응답 없음 포함), 정지 상태, AI 가용성, 대표 쪽(답을 기다리는 질문·승인을 기다리는 보고·처리하지 않은 수정 요청), 메인이 할 일(세션 키별 대기열·메인이 검수자인 작업·복구 확인·넘겨받은 보류), 프로젝트별(프로듀서·일시정지·지시와 작업 수·보류와 사유·실행 중 턴·팀원·프로듀서에게 온 질문), 읽지 않은 긴급 알림, 메인 일지의 열린 약속과 최근 10건. 목록은 20건(detail: true면 100건)까지 싣고 total이 전체 건수입니다. project_id를 주면 프로젝트 칸만 그 프로젝트로 거릅니다.',
    roles: ['main'],
    input: { project_id: z.string().optional(), detail: z.boolean().optional() },
    mutating: false,
  },
  {
    name: 'get_member_activity',
    description:
      '팀원의 최근 CLI 활동을 봅니다: 팀원 상태, 최근 턴 5개, 한 턴(turn_id, 없으면 가장 최근 턴)의 마지막 이벤트 limit개(기본 30·최대 100, 오래된 것부터). 이벤트 글은 300자까지이고 원본 출력은 싣지 않습니다. 메인 에이전트(M-MAIN)와 지운 팀원도 볼 수 있습니다.',
    roles: ['main'],
    input: { member_id: z.string().min(1), limit: z.number().int().min(1).max(100).optional(), turn_id: z.string().optional() },
    mutating: false,
  },
  {
    name: 'read_report',
    description: '보고서 본문(요약·결과·변경 파일·확인 방법·이슈·다음 할 일), 대표 코멘트, 작업 통계와 대표가 지금 그대로 승인하거나 수정 요청할 수 있는지를 봅니다. 읽어도 대표의 읽음 표시는 바뀌지 않습니다.',
    roles: ['main'],
    input: { report_id: z.string().min(1) },
    mutating: false,
  },
  {
    name: 'list_questions',
    description: '답을 기다리는 질문(대표에게·프로듀서에게)을 오래된 것부터 100건까지 봅니다. project_id를 주면 그 프로젝트, "general"이면 프로젝트가 없는 질문만 봅니다.',
    roles: ['main'],
    input: { project_id: z.string().optional() },
    mutating: false,
  },
  // 화면 조작 (SERVER_DESIGN 8.3·10.6, 리드 결정 S6-3·S6-6·S6-8) — 메인 전용, 서버 모드의 서버 PC에서만. 처리기는 6단계 S6b가 붙인다
  {
    name: 'screen_capture',
    description: [
      '서버 PC의 화면을 캡처합니다. screen을 주지 않으면 주 모니터, "all"이면 모든 모니터입니다. 이미지는 max_width(기본 1280) 안으로 줄이고 키우지 않습니다.',
      '결과의 capture_id는 30초 동안(expires_at까지) gui_input에 씁니다. 좌표는 이 캡처 이미지의 픽셀로 주면 서버가 실제 픽셀로 바꿉니다.',
      '이미지는 결과에 붙습니다(image: "attached"). 이미지를 볼 수 없으면 file을 Read(Claude)나 view_image(Codex)로 여세요. 4MiB를 넘으면 0.7배로 한 번 다시 찍고, 그래도 크면 파일만 남깁니다(too_large).',
      '서버 PC 앞 사람이 입력한 뒤 30초와 멈춤 단축키를 누른 뒤 5분 동안은 거부됩니다(human_active). 캡처는 초당 2장, 한 턴에 60장까지입니다(rate_limited).',
    ].join(' '),
    roles: ['main'],
    input: {
      screen: z.union([z.number().int().min(1).max(16), z.literal('all')]).optional(),
      max_width: z.number().int().min(320).max(1568).optional(),
    },
    mutating: false,
  },
  {
    name: 'screen_info',
    description:
      '서버 PC의 모니터(위치·크기·DPI — 실제 픽셀), 열린 창 50개(제목·프로그램·위치·최소화 여부·막힌 창)와 지금 포커스를 봅니다. 화면을 캡처하지 않고, 서버 PC 앞 사람이 입력하는 중에도 씁니다. blocked인 창(욱채 서버·화면, 관리자 권한으로 도는 창 등)에는 입력할 수 없습니다.',
    roles: ['main'],
    input: {},
    mutating: false,
  },
  {
    name: 'gui_input',
    description: [
      '서버 PC에 마우스·키보드 입력 하나를 보냅니다. action: move·click·double_click·drag·scroll·key·type·release.',
      'release 밖에는 30초 안의 capture_id가 꼭 있어야 하고, x·y(drag는 x2·y2도)는 그 캡처 이미지의 픽셀입니다. key는 "ctrl+s" 같은 키 조합, type은 칠 글(2,000자까지), scroll은 amount(-20~20), click은 button·count.',
      'type의 글에는 탭·줄바꿈을 넣지 않습니다(invalid) — 탭은 key "tab", 줄바꿈은 key "enter"로 따로 보내세요. type은 지금 포커스가 있는 칸에 치고, 치는 동안 포커스가 암호 칸이나 알 수 없는 곳으로 옮겨 가면 멈춥니다(secret_blocked — 이미 보낸 몇 글자는 그 칸에 들어갔을 수 있습니다).', // S6F2b: 리드 결정 S6-23 K2
      '비밀 값이 든 글, 암호 칸이나 포커스를 알 수 없는 칸에 치는 글과 글자 키는 보내지 않습니다(secret_blocked). Win+L·Ctrl+Alt+Del·붙여넣기 조합·멈춤 단축키, 욱채 서버·화면 창과 관리자 권한 창은 거부합니다(denied_target).',
      '서버 PC 앞 사람이 입력한 뒤 30초와 멈춤 단축키(Ctrl+Alt+Shift+F12)를 누른 뒤 5분 동안은 거부합니다(human_active). 입력은 초당 5번, 분당 300번까지입니다(rate_limited).',
      'then_capture: true면 0.5초 뒤 캡처를 함께 돌려줍니다. release는 눌린 키·버튼을 모두 뗍니다. request_id는 꼭 주세요 — 같은 값으로 다시 보내면 한 번만 입력합니다.',
    ].join(' '),
    roles: ['main'],
    input: {
      action: z.enum(['move', 'click', 'double_click', 'drag', 'scroll', 'key', 'type', 'release']),
      capture_id: z.string().regex(/^SC-\d{6,12}$/).optional(), // release 밖에는 필수
      x: z.number().int().min(0).optional(),
      y: z.number().int().min(0).optional(),
      x2: z.number().int().min(0).optional(),
      y2: z.number().int().min(0).optional(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      count: z.number().int().min(1).max(3).optional(),
      keys: z.string().min(1).max(60).optional(),
      text: z.string().min(1).max(4000).optional(), // 처리기: 코드 포인트 2,000
      amount: z.number().int().min(-20).max(20).optional(),
      then_capture: z.boolean().optional(),
      request_id: z.string().min(1).max(120), // 필수 (AC-45)
    },
    mutating: true,
  },
  {
    name: 'get_screen_check',
    description:
      '화면 이미지를 볼 수 있는지 확인하는 시험 이미지를 받습니다 — 업무 "화면 확인"에서만 씁니다. 이미지에 보이는 네 자리 숫자를 answer_screen_check로 답하세요. 파일을 프로그램으로 풀어 읽지 말고 이미지로 보세요. 볼 수 없으면 짐작하지 말고 그대로 턴을 마치세요.',
    roles: ['main'],
    input: {},
    mutating: false,
  },
  {
    name: 'answer_screen_check',
    description:
      '시험 이미지(get_screen_check)에 보인 네 자리 숫자를 답합니다. 한 확인에 한 번만 답할 수 있습니다. 맞으면 지금 보유자는 화면 이미지를 본다고(verified), 틀리면 볼 수 없다고(failed) 기록되고, failed면 screen_capture는 글 정보만 돌려줍니다.',
    roles: ['main'],
    input: { code: z.string().min(1).max(20), request_id: requestId },
    mutating: true,
  },

  // ───── 프로듀서 ─────
  {
    name: 'create_task',
    description:
      '지시를 작업으로 쪼개 팀원에게 배정합니다. 한 명이 한 번에 끝낼 크기(단계 3~10개). 수정 예정 영역이 다른 작업과 겹치면 선행 작업으로 순서를 정하세요. reviewer_id 생략 시 프로그램이 적격 검수자를 정합니다.',
    roles: ['producer'],
    input: {
      directive_id: z.string(),
      title: z.string().min(1).max(120),
      goal: z.string().min(1).max(8000),
      type: taskType,
      assignee_id: z.string(),
      reviewer_id: z.string().optional().describe('검수 권한 팀원 ID 또는 "main"(메인 에이전트 — 적격 팀원이 없을 때)'),
      priority: priority.default('normal'),
      prerequisite_ids: z.array(z.string()).default([]),
      acceptance_criteria: z.array(z.string().min(1)).min(1),
      planned_areas: z.array(z.string()).default([]),
      output_mode: z
        .enum(['repo', 'artifact'])
        .optional()
        .describe('repo=저장소 변경형, artifact=저장소를 바꾸지 않는 산출물형. 생략하면 type이 asset이면 artifact, 그 밖은 repo — 저장소에 넣을 에셋이면 repo로 정하세요'),
      request_id: requestId,
    },
    mutating: true,
  },
  {
    name: 'update_task',
    description: '작업의 우선순위·선행 작업·담당(재배정)·검수자·완료 조건·수정 예정 영역·목표를 바꿉니다.',
    roles: ['producer'],
    input: {
      task_id: z.string(),
      priority: priority.optional(),
      prerequisite_ids: z.array(z.string()).optional(),
      assignee_id: z.string().optional(),
      reviewer_id: z.string().optional(),
      acceptance_criteria: z.array(z.string().min(1)).optional(),
      planned_areas: z.array(z.string()).optional(),
      goal: z.string().optional(),
      request_id: requestId,
    },
    mutating: true,
  },
  {
    name: 'replan_task',
    description: '재계획으로 보류된 작업(3회 반려·헛돌기 등)의 계획을 고치고 다시 진행시킵니다. 새 검수 차수가 열립니다.',
    roles: ['producer'],
    input: {
      task_id: z.string(),
      note: z.string().min(1).max(4000),
      goal: z.string().optional(),
      acceptance_criteria: z.array(z.string().min(1)).optional(),
      assignee_id: z.string().optional(),
      reviewer_id: z.string().optional(),
      request_id: requestId,
    },
    mutating: true,
  },
  {
    name: 'resolve_hold',
    description: '막힘 보고나 선행 작업 취소로 보류된 작업을 프로듀서가 조치한 뒤 보류 사유를 해제합니다.',
    roles: ['producer'],
    input: { task_id: z.string(), kind: z.enum(['blocked', 'prereq_cancelled']), note: z.string().min(1).max(4000), request_id: requestId },
    mutating: true,
  },
  {
    name: 'cancel_task',
    description: '작업을 취소합니다. 실행을 끝내고 중간 결과를 보관한 뒤 작업 공간을 정리합니다. 프로듀서는 자기 프로젝트, 메인 에이전트는 모든 프로젝트의 작업을 취소합니다.',
    roles: ['producer', 'main'],
    input: { task_id: z.string(), reason: z.string().min(1).max(2000), request_id: requestId },
    mutating: true,
  },
  {
    name: 'assign_reviewer',
    description:
      '작업의 검수자를 정합니다. 작업자·실질 수정 참여자는 검수자가 될 수 없습니다. 적격 팀원이 없으면 "main"(메인 에이전트). 지금 검수자를 다시 정하면 멈춘 검수(대기·실행 중인 검수가 없을 때)를 그 검수자에게 다시 등록합니다. 그렇게 다시 등록한 검수도 판정 없이 끝나면 더 되풀이하지 않고 메인 에이전트에게 넘어갑니다. 프로듀서는 자기 프로젝트, 메인 에이전트는 모든 프로젝트의 작업에 씁니다 — 메인 에이전트는 reason을 꼭 적습니다(멈춘 검수에서 검수 권한 팀원을 add_member로 더한 뒤 그 팀원으로 바꾸는 길).',
    roles: ['producer', 'main'],
    input: { task_id: z.string(), reviewer_id: z.string(), reason: mainReason.optional(), request_id: requestId },
    mutating: true,
  },
  {
    name: 'answer_question',
    description: '팀원의 질문에 답합니다. 답변은 그 팀원의 다음 턴에 전달됩니다.',
    roles: ['producer'],
    input: { question_id: z.string(), answer: z.string().min(1).max(8000), request_id: requestId },
    mutating: true,
  },
  {
    name: 'request_merge',
    description: '독립 검수를 통과한 저장소 변경형 작업의 main 병합을 요청합니다. 실제 병합은 프로그램이 순서대로 합니다.',
    roles: ['producer'],
    input: { task_id: z.string(), request_id: requestId },
    mutating: true,
  },
  {
    name: 'request_revert',
    description: '작업 단위 되돌리기를 요청합니다. 병합 전이면 중간 결과를 보관하고 브랜치를 폐기, 병합 후면 되돌리기 작업을 만들어 검수 후 적용합니다.',
    roles: ['producer'],
    input: { task_id: z.string(), reason: z.string().min(1).max(4000), request_id: requestId },
    mutating: true,
  },
  {
    name: 'submit_final_result',
    description: '지시의 현재 회차 결과를 정리해 메인 에이전트에게 제출합니다. 모든 작업이 완료·취소된 뒤에 호출하세요.',
    roles: ['producer'],
    input: {
      directive_id: z.string(),
      summary: z.string().min(1).max(4000),
      outputs: z.array(z.string()).default([]),
      changed_files: z.array(z.string()).default([]),
      issues: z.array(z.string()).default([]),
      next_steps: z.array(z.string()).default([]),
      request_id: requestId,
    },
    mutating: true,
  },

  // ───── 팀원 (프로듀서가 직접 작업할 때도 사용) ─────
  {
    name: 'set_steps',
    description: '작업을 시작할 때 단계 목록(3~10개)을 만듭니다. 이미 완료한 단계는 유지되고 남은 단계만 바뀝니다.',
    roles: ['member'],
    input: { steps: z.array(z.string().min(1).max(200)).min(1).max(30), request_id: requestId },
    mutating: true,
  },
  {
    name: 'add_steps',
    description: '진행 중에 단계를 추가합니다(진행도가 내려갈 수 있으며 정상입니다).',
    roles: ['member'],
    input: { steps: z.array(z.string().min(1).max(200)).min(1).max(20), request_id: requestId },
    mutating: true,
  },
  {
    name: 'complete_step',
    description: '단계를 끝낼 때마다 호출합니다. 파일 변경이 있으면 프로그램이 [작업ID] 커밋을 만듭니다. 직접 git commit 하지 마세요.',
    roles: ['member'],
    input: { step_index: z.number().int().min(0), note: z.string().max(2000).default(''), request_id: requestId },
    mutating: true,
  },
  {
    name: 'submit_for_review',
    description: '작업을 검수에 제출합니다. 호출 후 턴을 마치세요. 프로그램이 자동 검사 후 검수자에게 넘깁니다.',
    roles: ['member'],
    input: { note: z.string().max(4000).default(''), request_id: requestId },
    mutating: true,
  },
  {
    name: 'ask_producer',
    description: '프로듀서에게 질문합니다. 작업이 답변 대기로 보류되니 호출 후 턴을 마치세요.',
    roles: ['member'],
    input: { question: z.string().min(1).max(4000), request_id: requestId },
    mutating: true,
  },
  {
    name: 'report_blocked',
    description: '혼자 해결할 수 없는 막힘을 프로듀서에게 보고합니다. 작업이 보류되니 호출 후 턴을 마치세요.',
    roles: ['member'],
    input: { reason: z.string().min(1).max(4000), request_id: requestId },
    mutating: true,
  },
  {
    name: 'report_conflict_resolved',
    description:
      '최신 main 반영 중 생긴 충돌 파일을 모두 고친 뒤 호출합니다. git 명령 없이 파일만 고치면 됩니다 — 스테이징·병합 커밋은 프로그램이 합니다. 충돌 표시가 남은 파일이 있거나 병합을 취소해(git merge --abort 등) 해결된 것이 없으면 거부되고 그 까닭과 다음 일(턴이 끝나면 프로그램이 최신 main을 다시 반영 — 여전히 충돌하면 충돌 표시가 되살아남)을 알려 줍니다.',
    roles: ['member'],
    input: { note: z.string().max(2000).default(''), request_id: requestId },
    mutating: true,
  },
  {
    name: 'record_skill_use',
    description: '작업에 스킬을 사용했으면 기록합니다.',
    roles: ['member'],
    input: { skill: z.string().min(1).max(120) },
    mutating: true,
  },

  // ───── 검수 권한 팀원 ─────
  {
    name: 'get_review_target',
    description:
      '본인이 검수자로 배정된 작업의 검수 대상(고정 버전, 변경 파일, diff 요약, 읽기용 사본 위치, 완료 조건, 자동 검사 결과)과 메인 에이전트가 그 작업에 보낸 긴급 지시(urgentInstructions — 완료 조건·프로듀서 지시보다 우선)를 봅니다.',
    roles: ['reviewer'],
    input: { task_id: z.string() },
    mutating: false,
  },
  {
    name: 'submit_review',
    description:
      '검수 결과를 등록합니다. 완료 조건마다 통과 여부와 메모를 적으세요 — 통과는 지금 완료 조건(get_review_target의 acceptanceCriteria) 모두에 통과 결과가 있어야 받습니다. criterion에는 그 조건 글을 적으세요: 바뀌거나 빠진 이전 조건의 결과, 빈 글의 결과는 지금 조건의 결과로 치지 않고, 새로 더해지거나 바뀐 조건은 같은 글의 결과만 칩니다. 검수 대상 파일(읽기용 사본·산출물 사본)을 직접 수정하지 마세요(REV-08). 본인 작업·미배정 작업은 거부됩니다.',
    roles: ['reviewer'],
    input: {
      task_id: z.string(),
      verdict: z.enum(['pass', 'reject']),
      criteria: z.array(z.object({ criterion: z.string(), pass: z.boolean(), note: z.string().default('') })).min(1),
      reason: z.string().max(8000).default(''),
      request_id: requestId,
    },
    mutating: true,
  },
] as const satisfies readonly ToolSpec[];

export type ToolName = (typeof TOOL_SPECS)[number]['name'];

export function toolSpec(name: string): ToolSpec | undefined {
  return (TOOL_SPECS as readonly ToolSpec[]).find((t) => t.name === name);
}

/**
 * 토큰의 역할 → 공개할 도구 역할 목록. 메인 에이전트가 대체 검수자로 도는 검수 세션(review:T)에는 검수 도구만 연다 — 그 세션의 역할은 reviewer다
 * (REV-06 v0.6, SERVER_DESIGN 2.6). 그 밖의 메인 세션은 메인 도구
 */
export function rolesFor(identity: { isMain: boolean; isProducer: boolean; canReview: boolean; sessionKind?: SessionKind }): ToolRole[] {
  if (identity.isMain) return identity.sessionKind === 'review' ? ['reviewer'] : ['main'];
  const roles: ToolRole[] = ['member'];
  if (identity.isProducer) roles.push('producer');
  if (identity.canReview || identity.isProducer) roles.push('reviewer');
  return roles;
}

// ───────────────────────── host_exec 결과 (리드 결정 S5-16) ─────────────────────────

/** 명령이 시작됐으면 늘 ok — 종료 코드·시간 초과·정지·남은 프로세스로 결과를 말한다 */
export interface HostExecResult {
  /** 보낸 request_id (비밀 값이 섞였으면 그 해시) */
  request_id: string;
  exit_code: number | null;
  timed_out: boolean;
  /** 무엇이 끝냈는지 — 시간 초과는 timed_out */
  stopped: null | '긴급 정지' | '턴 종료' | '메인 자리 교체' | '앱 종료';
  duration_ms: number;
  cwd: string;
  /** 가린 출력 — 앞 16KiB + 뒤 48KiB(줄 단위, '…(n바이트 생략)…') */
  output: string;
  output_truncated: boolean;
  output_omitted_bytes: number;
  /** 남은 하위 프로세스 (0 = 종료 확인, n = 남음, -1 = 확인하지 못함) */
  leftover: number;
  message: string;
}

// ───────────────────────── 화면 조작 결과 (SERVER_DESIGN 8.3, 리드 결정 S6-3·S6-6) ─────────────────────────
// 좌표는 따로 말하지 않으면 실제 픽셀이다. screen_capture의 windows는 캡처 좌표다(text_only 보유자)

export interface ScreenFocusSummary {
  app: string;
  title: string;
  control: string | null;
  password: boolean | null;
}

export interface ScreenWindowInfo {
  title: string;
  app: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  blocked: boolean;
}

export interface ScreenInfoResult {
  screens: { index: number; primary: boolean; x: number; y: number; width: number; height: number; dpi: number }[];
  /** 50개까지, 실제 픽셀 */
  windows: ScreenWindowInfo[];
  windows_total: number;
  focus: ScreenFocusSummary | null;
  note: string;
}

export interface ScreenCaptureResult {
  capture_id: string;
  screen: number | 'all';
  width: number;
  height: number;
  scale: number;
  origin: { x: number; y: number };
  taken_at: string;
  /** taken_at + 30초 */
  expires_at: string;
  file: string;
  image: 'attached' | 'text_only' | 'too_large';
  focus: ScreenFocusSummary | null;
  windows?: ScreenWindowInfo[];
  note: string | null;
}

export interface GuiInputResult {
  request_id: string;
  action: string;
  real: { x: number; y: number; x2?: number; y2?: number } | null;
  focus: ScreenFocusSummary | null;
  after: ScreenCaptureResult | null;
  after_note: string | null;
  message: string;
}

export interface ScreenCheckImage {
  file: string;
  image: 'attached';
  instruction: string;
}

export interface ScreenCheckAnswer {
  result: 'verified' | 'failed';
  message: string;
}

// ───────────────────────── get_work_context 결과 ─────────────────────────

export interface WorkContext {
  you: {
    memberId: MemberId;
    name: string;
    roleId: string;
    roleName: string;
    isProducer: boolean;
    isMain: boolean;
    canReview: boolean;
    projectId: ProjectId | null;
    /** 이 턴을 실행하는 쪽 — 서버가 띄운 CLI(claude·codex) 또는 외부 에이전트(external, 리드 결정 S7-17 F5) */
    runner: RunnerKind;
    /** 서버가 띄운 CLI의 AI 종류 — 외부 에이전트가 실행하는 턴이면 null (CLI 종류가 없다) */
    aiKind: AiKind | null;
  };
  session: { sessionKey: string; kind: SessionKind; turnNumber: number };
  /** 이번 턴에 묶여 전달된 업무 종류 */
  workKinds: WorkKind[];
  /** 지금 할 일 (한국어 안내) */
  instructions: string;
  project: { id: ProjectId; name: string; path: string; baseBranch: string; checkCommands: string[] } | null;
  directive: {
    id: string;
    title: string;
    text: string;
    round: number;
    state: DirectiveState;
    /** 회차별 요청 (2회차부터는 수정 요청 코멘트) */
    rounds: { round: number; text: string; anchored: { quote: string; comment: string }[] }[];
  } | null;
  /** 일반 작업 세션: 내 작업 카드 */
  task: WorkTaskCard | null;
  /** 검수 업무: 검수할 작업 */
  reviewTasks: {
    taskId: TaskId;
    title: string;
    outputMode: OutputMode;
    acceptanceCriteria: string[];
    reviewRound: number;
    target: unknown;
    reviewCopyPath: string | null;
    /** 산출물형에서 저장소 변경형으로 전환된 작업: 산출물 폴더 결과 파일의 이 버전 사본 (함께 검수, 병합 완료 때 보관). 없으면 생략 */
    artifactCopyPath?: string;
    /** 메인 에이전트가 이 작업에 보낸 긴급 지시(작업자·검수자에게) — 완료 조건·프로듀서 지시보다 우선한다 (CTL-06). 없으면 생략 */
    urgentInstructions?: UrgentInstructionView[];
  }[];
  /** 프로듀서 응답 업무: 답할 질문 */
  questions: { questionId: string; fromId: MemberId; fromName: string; taskId: TaskId | null; text: string }[];
  /** 프로듀서 병합 판단: 검수 통과한 작업 */
  mergeCandidates: { taskId: TaskId; title: string; reviewerId: string }[];
  /**
   * 프로듀서·메인: 팀 구성. taskTypes = 그 팀원 역할이 맡는 작업 유형 (리드 결정 S5-15). runner = 그 팀원의 턴을 실행하는 쪽, aiKind = 서버가 띄우는 CLI의 AI 종류
   * (외부 에이전트가 메인 자리를 가진 메인 에이전트면 runner 'external', aiKind null — 리드 결정 S7-17 F5)
   */
  team: { memberId: MemberId; name: string; roleId: string; roleName: string; taskTypes: TaskType[]; canReview: boolean; runner: RunnerKind; aiKind: AiKind | null; status: string; activeTaskId: TaskId | null }[];
  /** 프로듀서: 이 지시의 작업 목록 */
  tasks: { id: TaskId; title: string; state: TaskState; assigneeId: MemberId; reviewerId: string | null; holdReasons: string[] }[];
  /** 이번 턴에 전달된 메시지·답변·반려 사유 */
  messages: { from: string; text: string; at: string }[];
  /**
   * 메인 대화 세션(main:*)만: 지금 기록으로 부를 때 계산한 현황 요약 (1,500자 이하 — 턴 메시지 맨 앞의 것과 같은 함수, 이 턴이 실은 일은 빼고 센다). 메인 검수
   * 세션·팀원에게는 없다 (SERVER_DESIGN 5.1, 리드 결정 S5-4)
   */
  digest?: string;
}

// ───────────────────────── 메인 조회 도구 결과 (SERVER_DESIGN 5.2, 리드 결정 S5-3·S5-6) ─────────────────────────

/** 목록 하나 — total은 기록에 있는 전체 건수, items는 상한까지 (items가 total보다 적으면 그만큼 '외 n건') */
export interface Listed<T> {
  total: number;
  items: T[];
}

/** 보류 사유 한 줄 — 메모는 보일 때 가린다(저장할 때는 가리지 않은 사유가 있다). reachesMain: 그 보류가 메인 업무로 와 있는지 (대표 화면과 같은 판정) */
export interface OverviewHoldReason {
  kind: HoldReasonKind;
  label: string;
  note: string;
  since: string;
  by: string;
  reachesMain: boolean;
}

/** get_overview의 프로젝트 칸 */
export interface OverviewProject {
  id: ProjectId;
  name: string;
  producer: { memberId: MemberId; name: string; status: string } | null;
  /** 프로젝트 일시정지 (없으면 null) */
  paused: { mode: string; by: string; since: string | null; reason?: string } | null;
  /** active: 열린 지시 중 확인 대기를 뺀 것(프로젝트 화면과 같은 정의), awaitingConfirmation: 대표 확인을 기다리는 지시 */
  directives: { active: number; awaitingConfirmation: number };
  /** 열린 지시의 지금 회차 작업을 상태별로. otherOpenTasks: 그 밖의 끝나지 않은 작업(되돌리기 작업·이전 회차에 남은 것 등) */
  tasks: Record<TaskState, number> & { otherOpenTasks: number };
  holds: Listed<{ taskId: TaskId; title: string; reasons: OverviewHoldReason[] }>;
  /** 실행 중 턴 — lastOutputAt: 턴 기록의 마지막 활동 시각, lastLine: CLI의 마지막 한 줄(이 앱이 띄운 뒤의 것만) */
  running: Listed<{ turnId: string; memberId: MemberId; name: string; taskId: TaskId | null; work: string; startedAt: string; lastOutputAt: string | null; lastLine: string | null }>;
  members: Listed<{ memberId: MemberId; name: string; roleName: string; isProducer: boolean; status: string; queued: number }>;
  /** 프로듀서에게 온 열린 질문 */
  producerQuestions: Listed<{ questionId: string; fromId: MemberId; fromName: string; taskId: TaskId | null; text: string; createdAt: string }>;
}

/**
 * get_overview 결과 (SERVER_DESIGN 5.2, 리드 결정 S5-3) — 목록마다 상한(기본 20건, detail이면 100건 — 일지 최근 10건, 열린 약속 50건)과 total. 제목은 80자, 메모·글은
 * 200자까지. 결과 전체를 가린다. project_id는 프로젝트 칸만 거른다
 */
export interface Overview {
  generatedAt: string;
  /** 메인 자리 — unresponsiveForMs: 응답 없음이 이어진 시간(긴급 정지한 시간은 세지 않음), unresponsiveNote: 그 표시가 언제 지워지는지 */
  seat: SeatView & { unresponsiveForMs: number | null; unresponsiveNote?: string };
  stop: {
    emergency: { active: boolean; since: string | null };
    pausedProjects: { projectId: ProjectId; mode: string; by: string; since: string | null; reason?: string }[];
    pausedMembers: { memberId: MemberId; name: string; mode: string; by: string; since: string | null; reason?: string }[];
    /** 긴급 정지 보류가 남은 작업 수 (정지 해제 뒤 메인이 항목별로 재개한다) */
    heldByEmergency: number;
  };
  ai: AiStatusView[];
  /** 대표 쪽 — 대표가 답하지 않은 질문, 승인을 기다리는 보고(새 보고·읽은 보고, unread는 대표가 아직 읽지 않음), 처리하지 않은 수정 요청 */
  owner: {
    questions: Listed<{ questionId: string; projectId: ProjectId | null; text: string; createdAt: string }>;
    reportsAwaitingApproval: Listed<{ reportId: string; title: string; projectId: ProjectId | null; directiveId: string | null; round: number; unread: boolean; createdAt: string }>;
    changeRequests: Listed<{ reportId: string; title: string; projectId: ProjectId | null; directiveId: string | null; round: number; comments: number }>;
  };
  /**
   * 메인이 할 일 — queue: 대기·실행 중인 메인 업무를 세션 키별로(kinds는 업무 종류별 수), byKind: 모두 더한 종류별 수, reviews: 메인이 검수자인 작업, recovery: 복구 확인
   * (resolve_recovery의 recovery_id = requestId), alerts: 메인에게 넘긴 보류와 남는 업무(정지 해제 목록·검수자 없음·멈춘 검수·일시정지된 팀원의 재개·대표에게만 가던
   * 보류·실패를 넘긴 알림 업무 — alertKey 'alert:<종류>:<대상>', 리드 결정 S5-7)
   */
  main: {
    queue: Listed<{ sessionKey: string; projectId: ProjectId | null; total: number; kinds: Partial<Record<WorkKind, number>>; running: boolean }>;
    byKind: Partial<Record<WorkKind, number>>;
    reviews: Listed<{ taskId: TaskId; title: string; projectId: ProjectId; state: TaskState }>;
    recovery: Listed<{ requestId: string; kind: string; projectId: ProjectId | null; taskId: TaskId | null; finding: string; startedAt: string }>;
    alerts: Listed<{ entryId: string; kind: WorkKind; label: string; sessionKey: string; projectId: ProjectId | null; taskId: TaskId | null; memberId: MemberId | null; state: string; text: string; alertKey?: string }>;
  };
  projects: Listed<OverviewProject>;
  /** 읽지 않은 긴급 알림 — 새 것부터 */
  notices: { unreadUrgent: Listed<{ id: string; title: string; body: string; key: string | null; createdAt: string }> };
  /** 메인 일지 — 열린 약속(오래된 것부터, stale: 7일 넘게 열림, needsCheck: 참조한 지시가 닫힘), 최근 10건(월별 묶음 빼고 새 것부터 — 서버 기록은 사실, 에이전트 기록은 확인되지 않은 주장) */
  journal: {
    openPromises: Listed<{ id: string; at: string; generation: number; holder: string; text: string; refs: string[]; stale: boolean; needsCheck: boolean }>;
    recent: Listed<{ id: string; at: string; kind: string; author: 'server' | 'agent'; trust: 'fact' | 'claim'; projectId: ProjectId | null; text: string }>;
  };
}

/** get_member_activity 결과 — 원본 출력(raw)은 싣지 않고, 이벤트 글은 300자까지. 전체 12,000자를 넘으면 오래된 이벤트부터 뺀다 (리드 결정 S5-6) */
export interface MemberActivity {
  member: {
    memberId: MemberId;
    name: string;
    roleName: string;
    projectId: ProjectId | null;
    isProducer: boolean;
    isMain: boolean;
    deleted: boolean;
    status: string;
    currentWork: { turnId: string; work: string; startedAt: string } | null;
    lastLine: { text: string; at: string } | null;
  };
  /** 최근 턴 5개까지 — 새 것부터. generation: 메인 에이전트 턴의 자리 세대 */
  turns: {
    turnId: string;
    sessionKey: string;
    projectId: ProjectId | null;
    taskId: TaskId | null;
    startedAt: string;
    endedAt: string | null;
    endReason: string | null;
    endDetail: string;
    eventCount: number;
    running: boolean;
    generation?: number;
  }[];
  /** 이벤트를 보인 턴 (없으면 null) */
  turnId: string | null;
  /** 그 턴의 마지막 이벤트 — 오래된 것부터. data는 정해진 칸만 */
  events: { seq: number; ts: string; kind: string; text: string; data?: Record<string, unknown> }[];
  /** 보이지 않은 앞 이벤트 수 (limit·글 상한·읽은 범위 밖) */
  omittedEvents: number;
  message?: string;
}

/** read_report 결과 — 보고서 파일 경로와 마크다운 원문은 싣지 않는다(SEC-02). 읽어도 대표의 읽음 표시는 그대로다 */
export interface ReportReadout {
  reportId: string;
  title: string;
  projectId: ProjectId | null;
  projectName: string;
  directiveId: string | null;
  round: number;
  status: string;
  /** 대표가 아직 읽지 않음 (status 'new') */
  unread: boolean;
  createdAt: string;
  decidedAt: string | null;
  sections: { summary: string; results: string; howToVerify: string; issues: string; nextSteps: string; changedFiles: Listed<string> };
  stats: Record<string, unknown>;
  comments: Listed<{ id: string; kind: 'overall' | 'anchored'; quote: string | null; text: string; createdAt: string }>;
  otherRounds: { reportId: string; round: number; status: string }[];
  /** 대표가 지금 이 보고서를 그대로 승인할 수 있는지, 수정 요청할 수 있는지 (대표 화면과 같은 판정) */
  canApprove: boolean;
  canRequestChanges: boolean;
}

/** list_questions 결과 — 열린 질문만, 오래된 것부터 100건까지 */
export interface QuestionList extends Listed<{ questionId: string; to: 'owner' | 'producer'; fromId: MemberId; fromName: string; projectId: ProjectId | null; taskId: TaskId | null; directiveId: string | null; text: string; createdAt: string }> {
  message?: string;
}

/**
 * 검수자에게 보이는 긴급 지시 한 건 — 메인 에이전트가 그 작업의 작업자(작업 세션)·검수자(검수 세션)에게 보낸 긴급 지시 (CTL-06, AC-17. 옛 대표 직접 메시지 포함).
 * delivered: 받는 쪽 업무 세션에 전달됨 (아직이면 검수 중이라 전달 대기 — 반려되면 재작업 첫 턴, 통과해도 완료 전에 진행으로 돌려 전달)
 */
export interface UrgentInstructionView {
  messageId: string;
  at: string;
  /** 받은 팀원 — "이름(ID, 작업자|검수자)" */
  to: string;
  text: string;
  delivered: boolean;
}

export interface WorkTaskCard {
  id: TaskId;
  title: string;
  goal: string;
  type: TaskType;
  priority: Priority;
  state: TaskState;
  outputMode: OutputMode;
  acceptanceCriteria: string[];
  plannedAreas: string[];
  prerequisiteIds: TaskId[];
  steps: { idx: number; title: string; done: boolean }[];
  branch: string | null;
  worktreePath: string | null;
  /** 산출물형 작업의 결과 저장 폴더 (저장소 밖). 산출물형에서 전환된 작업은 그 폴더가 남아 있는 동안 계속 보인다. 처음부터 저장소 변경형이면 null */
  artifactDir: string | null;
  reviewRound: number;
  rejectsInRound: number;
  lastRejectReason: string | null;
  conflictFiles: string[];
  autoCheck: { status: string; detail: string };
}
