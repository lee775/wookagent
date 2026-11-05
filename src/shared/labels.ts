/** 한국어 표시 이름 (UI-04). 화면과 보고서·알림 문구가 같은 이름을 쓰도록 여기 모은다. */
import type {
  ActivityKind,
  AiKind,
  AutoCheckStatus,
  DirectiveState,
  EffortTier,
  HoldReasonKind,
  MockScenario,
  NotificationLevel,
  OutputMode,
  Priority,
  ReportStatus,
  RoleCreator,
  SessionKind,
  TaskState,
  TaskType,
  TurnEndReason,
  WorkKind,
} from './domain';
import type { MemberStatus } from './views';

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  waiting: '대기',
  in_progress: '진행',
  on_hold: '보류',
  in_review: '검수',
  done: '완료',
  cancelled: '취소',
};

export const DIRECTIVE_STATE_LABEL: Record<DirectiveState, string> = {
  received: '접수',
  planning: '계획',
  in_progress: '진행',
  reporting: '보고',
  awaiting_confirmation: '확인 대기',
  closed: '종료',
  cancelled: '취소',
};

export const MEMBER_STATUS_LABEL: Record<MemberStatus, string> = {
  working: '업무 중',
  idle: '대기',
  awaiting_answer: '답변 대기',
  paused: '일시정지',
  error: '오류',
};

/** 상태 색 (5.4). 색만으로 구분하지 않고 아이콘·글자를 함께 쓴다 */
export const MEMBER_STATUS_COLOR: Record<MemberStatus, 'green' | 'gray' | 'yellow' | 'blue' | 'red'> = {
  working: 'green',
  idle: 'gray',
  awaiting_answer: 'yellow',
  paused: 'blue',
  error: 'red',
};

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  plan: '계획',
  spec: '기획',
  architecture: '설계',
  development: '개발',
  bugfix: '버그 수정',
  design: '디자인',
  test: '테스트',
  docs: '문서',
  research: '조사',
  simulation: '시뮬레이션',
  asset: '에셋',
  revert: '되돌리기',
};

/** 역할을 만든 쪽 (리드 결정 S5-12) — 기록으로만 보인다 */
export const ROLE_CREATOR_LABEL: Record<RoleCreator, string> = {
  seed: '기본',
  owner: '대표(예전)',
  main: '메인 에이전트',
  operator: '운영자',
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: '긴급',
  high: '높음',
  normal: '보통',
  low: '낮음',
};

export const OUTPUT_MODE_LABEL: Record<OutputMode, string> = {
  repo: '저장소 변경형',
  artifact: '산출물형',
};

export const HOLD_REASON_LABEL: Record<HoldReasonKind, string> = {
  answer_wait: '답변 대기',
  error: '오류',
  paused: '일시정지',
  emergency_stop: '긴급 정지',
  replan: '재계획',
  prereq_cancelled: '선행 작업 취소',
  recovery_check: '복구 확인',
  interrupted: '중단',
  blocked: '막힘 보고',
  merge_blocked: '병합 보류',
};

export const EFFORT_TIER_LABEL: Record<EffortTier, string> = {
  high: '높게',
  normal: '보통',
  low: '낮게',
};

export const AI_KIND_LABEL: Record<AiKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  new: '새 보고',
  read: '확인함',
  approved: '결과 승인',
  changes_requested: '수정 요청',
};

export const AUTO_CHECK_LABEL: Record<AutoCheckStatus, string> = {
  not_run: '검사 전',
  running: '검사 중',
  passed: '통과',
  failed: '실패',
  not_applicable: '해당 없음',
};

export const WORK_KIND_LABEL: Record<WorkKind, string> = {
  task_work: '작업',
  conflict_fix: '충돌 해결',
  review: '검수',
  plan: '계획',
  replan: '재계획',
  answer: '질문 응답',
  merge_decision: '병합 판단',
  final_result: '최종 결과 정리',
  reviewer_assign: '검수자 배정',
  main_command: '명령 처리',
  main_report: '보고서 작성',
  memory_update: '기억 갱신',
  change_request: '수정 요청',
  stop_released: '정지 해제',
  no_reviewer: '검수자 없음',
  alert: '보류·실패 처리',
  message: '메시지 확인',
};

export const SESSION_KIND_LABEL: Record<SessionKind, string> = {
  task: '작업',
  review: '검수',
  directive: '지시 관리',
  main_project: '프로젝트 대화',
  main_general: '직접 명령',
};

export const TURN_END_LABEL: Record<TurnEndReason, string> = {
  completed: '정상 종료',
  user_stop: '정지 요청으로 종료',
  crashed: '비정상 종료',
  no_response: '응답 없음',
  timeout: '시간 상한 초과',
  usage_limit: '사용량 한도',
  auth_required: '인증 만료',
  bypass_mismatch: '바이패스 설정 불일치',
  app_restart: '앱 재시작',
  spawn_failed: '실행 실패',
  spin: '헛돌기',
};

export const NOTIFICATION_LEVEL_LABEL: Record<NotificationLevel, string> = {
  urgent: '긴급',
  normal: '일반',
  info: '정보',
};

export const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = {
  app_tool: '앱 도구',
  command: '명령',
  file_change: '파일 변경',
  directive: '지시',
  task: '작업',
  review: '검수',
  merge: '병합',
  revert: '되돌리기',
  report: '보고',
  question: '질문',
  message: '메시지',
  error: '오류',
  stop: '정지',
  resume: '재개',
  git: 'git',
  exec: '외부 실행',
  auth: '인증',
  settings: '설정',
  session: '세션',
  system: '시스템',
  seat: '메인 자리',
  journal: '메인 일지',
};

export const MOCK_SCENARIO_LABEL: Record<MockScenario, string> = {
  normal: '정상 완료',
  slow: '느린 진행',
  crash: '비정상 종료(1회)',
  crash_loop: '비정상 종료 반복',
  hang: '응답 없음',
  spin: '헛돌기',
  bypass_mismatch: '바이패스 설정 불일치',
  answer_wait: '답변 대기',
  usage_limit: '사용량 한도',
  review_violation: '검수 권한 위반',
  triple_reject: '3회 반려',
  merge_conflict: '병합 충돌',
  revert: '선택 되돌리기',
  duplicate_tool: '앱 도구 중복 요청',
};

/** 역할 약칭 (스튜디오 이름표) */
export const ROLE_SHORT: Record<string, string> = {
  producer: 'PD',
  planner: 'PLAN',
  architect: 'ARCH',
  developer: 'DEV',
  ui_designer: 'UI',
  qa: 'QA',
  docs: 'DOC',
  main: 'MAIN',
};
