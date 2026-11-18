import type {
  AppSnapshot,
  ProjectView,
  MemberView,
  DirectiveView,
  TaskView,
  RoleView,
  ReportDetail,
  NotificationView,
  ActivityView,
  RecoveryItemView,
  ConversationView,
  SkillView,
} from '../../../../shared/views';
import type { Settings, TaskType } from '../../../../shared/domain';
import { LOCKED_SEAT } from '../../../../shared/views';
export const now = () => new Date().toISOString();
export const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const objectParticle = (word: string) => {
  const final = word.charCodeAt(word.length - 1);
  return final >= 0xac00 && final <= 0xd7a3 && (final - 0xac00) % 28 === 0 ? '를' : '을';
};
export const progress = (done: number, total: number) => ({
  done,
  total,
  ratio: total ? done / total : 0,
});
export const counts = () => ({
  working: 0,
  idle: 0,
  awaiting_answer: 0,
  paused: 0,
  error: 0,
});
const roleNames = [
  ['producer', '프로듀서', ['plan'], true, 'high'],
  ['planner', '기획자', ['spec', 'research'], false, 'normal'],
  ['architect', '설계자', ['architecture'], true, 'high'],
  ['developer', '개발자', ['development', 'bugfix'], false, 'normal'],
  ['ui_designer', 'UI 디자이너', ['design'], false, 'normal'],
  ['qa', 'QA', ['test'], true, 'normal'],
  ['docs', '문서 담당', ['docs'], false, 'low'],
] as const;
const roleDescriptions: Record<string, string> = {
  producer: '요청을 작업으로 나누고 결과를 모아 대표에게 보고합니다.',
  planner: '사용 흐름과 완료 조건을 정리해 작업 범위를 분명히 합니다.',
  architect: '데이터와 화면 사이의 구조를 설계하고 변경 영향을 확인합니다.',
  developer: '화면과 기능을 구현하고 실제 동작을 확인합니다.',
  ui_designer: '정보의 우선순위와 화면 표현을 다듬습니다.',
  qa: '완료 조건을 기준으로 결과를 검수하고 재현 경로를 남깁니다.',
  docs: '결정과 확인 방법을 문서로 남겨 다음 작업에 연결합니다.',
};
export const roles: RoleView[] = roleNames.map(([id, name, taskTypes, canReview, effortTier]) => ({
  id,
  name,
  instructions: roleDescriptions[id],
  taskTypes: [...taskTypes] as TaskType[],
  allowedSkills: ['문서 정리'],
  defaultAi: {
    kind: id === 'developer' || id === 'qa' ? 'codex' : 'claude',
    model: null,
    effortTier,
    effortOverride: null,
  },
  canReview,
  builtin: true,
  createdBy: 'seed',
}));
roles.push({ id: 'sound', name: '사운드', createdBy: 'main', builtin: false,
  instructions: '산책 기록에 어울리는 음원을 만들고 재생 환경을 확인합니다.',
  taskTypes: ['asset', 'research'], allowedSkills: [], canReview: false,
  defaultAi: { kind: 'claude', model: null, effortTier: 'normal', effortOverride: null } });
const project = (id: string, name: string, path: string, producerId: string, mock: boolean): ProjectView => ({
  id,
  name,
  path,
  baseBranch: 'main',
  createdAt: ago(10000),
  paused: false,
  pauseMode: null,
  mock: {
    enabled: mock,
    speed: 2,
    defaultScenario: 'normal',
  },
  producerId,
  checkCommands: mock ? ['npm run build', 'npm test'] : [],
  networkPolicy: 'allow',
  activeDirectiveCount: 1,
  deploy: {
    pushRemote: null,
    deployCommand: null,
  },
  progress: progress(4, 10),
  memberStatusCounts: counts(),
  latestReport: null,
});
export const projects: ProjectView[] = [
  project('P-0001', '동네 산책 기록장', 'C:\\Projects\\walk-journal', 'M-0001', true),
  project('P-0002', '사내 위키 정리', 'C:\\Projects\\team-wiki', 'M-0007', false),
  project('P-0003', '열두 팀원 스튜디오', 'C:\\Projects\\large-studio', 'M-0013', true),
];
const member = (
  id: string,
  projectId: string | null,
  name: string,
  roleId: string,
  status: MemberView['status'],
  taskId?: string,
): MemberView => {
  const role = roles.find((item) => item.id === roleId);
  const ai = role?.defaultAi ?? {
    kind: 'claude' as const,
    model: null,
    effortTier: 'high' as const,
    effortOverride: null,
  };
  const taskTitle =
    taskId === 'T-0001'
      ? '기록 화면 흐름 만들기'
      : taskId === 'T-0002'
        ? '산책 장소 데이터 연결'
        : taskId === 'T-0003'
          ? '시각 요소 다듬기'
          : taskId === 'T-0004'
            ? '기록 흐름 검수'
            : '위키 검색 구조 정리';
  return {
    id,
    projectId,
    name,
    roleId,
    roleName: role?.name ?? '메인 에이전트',
    isProducer: roleId === 'producer',
    isMain: projectId === null,
    canReview: role?.canReview ?? true,
    ai: {
      ...ai,
      effortValue: ai.effortTier === 'high' ? 'high' : ai.effortTier === 'normal' ? 'medium' : 'low',
      mock: projectId === 'P-0001' || projectId === 'P-0003',
      mockScenario: null,
    },
    pendingAiChange: null,
    aiDecision:
      projectId === null
        ? null
        : {
            byName: '메인 에이전트',
            byOwner: false,
            reason: '역할과 현재 작업에 맞춰 선택',
            at: ago(120),
          },
    status,
    statusReasons:
      status === 'working'
        ? [taskId ? `${taskId} 진행 중` : '현재 턴을 실행하고 있습니다.']
        : status === 'awaiting_answer'
          ? ['대표의 답변을 기다리고 있습니다.']
          : status === 'paused'
            ? ['대표가 일시정지했습니다.']
            : status === 'error'
              ? ['CLI 실행 중 오류가 발생했습니다.']
              : [taskId ? `${taskId} 검수 결과 대기` : '다음 업무를 기다리고 있습니다.'],
    currentTask: taskId
      ? {
          id: taskId,
          title: taskTitle,
          state:
            status === 'paused' ? 'on_hold' : status === 'awaiting_answer' ? 'on_hold' : status === 'idle' ? 'in_review' : 'in_progress',
          progress: progress(status === 'idle' ? 3 : 2, 4),
          currentStep: '화면과 데이터 연결',
          inReview: status === 'idle',
          branch: `work/${taskId.toLowerCase()}`,
        }
      : null,
    currentWork:
      status === 'working'
        ? {
            kind: projectId === null ? 'main_command' : roleId === 'producer' ? 'plan' : 'task_work',
            label: taskId ? taskTitle : roleId === 'producer' && projectId === 'P-0001' ? '계획 D-0001' : '지시 계획 세우기',
            turnId: `TN-${id}`,
            startedAt: ago(13),
          }
        : null,
    queuedCount: status === 'working' ? 1 : 0,
    runSeconds: 3520 + Number(id.replace(/\D/g, '') || 0) * 421,
    currentSessionId: status === 'working' ? `S-${id}` : null,
    lastActivityAt: ago(4),
    lastLine: status === 'working' ? '단계를 정리하고 있어요.' : null,
    deleted: false,
  };
};
export const members: MemberView[] = [
  member('M-MAIN', null, '해온', 'main', 'working'),
  member('M-0001', 'P-0001', '하음', 'producer', 'working'),
  member('M-0002', 'P-0001', '시안', 'developer', 'working', 'T-0002'),
  member('M-0003', 'P-0001', '여울', 'ui_designer', 'working', 'T-0003'),
  member('M-0004', 'P-0001', '서아', 'planner', 'awaiting_answer', 'T-0001'),
  member('M-0005', 'P-0001', '담이', 'qa', 'idle', 'T-0004'),
  member('M-0006', 'P-0001', '은재', 'docs', 'paused'),
  member('M-0007', 'P-0002', '지우', 'producer', 'idle'),
  member('M-0008', 'P-0002', '현우', 'architect', 'working', 'T-0005'),
  member('M-0009', 'P-0002', '수진', 'developer', 'idle'),
  member('M-0010', 'P-0002', '채원', 'docs', 'error'),
  member('M-0011', 'P-0002', '유나', 'qa', 'idle'),
  member('M-0012', 'P-0002', '민재', 'planner', 'idle'),
  member('M-0013', 'P-0003', '다온', 'producer', 'idle'),
  member('M-0014', 'P-0003', '서윤', 'planner', 'working'),
  member('M-0015', 'P-0003', '루카', 'architect', 'idle'),
  member('M-0016', 'P-0003', '하린', 'developer', 'working'),
  member('M-0017', 'P-0003', '지오', 'developer', 'awaiting_answer'),
  member('M-0018', 'P-0003', '나래', 'ui_designer', 'working'),
  member('M-0019', 'P-0003', '마루', 'ui_designer', 'idle'),
  member('M-0020', 'P-0003', '이든', 'qa', 'paused'),
  member('M-0021', 'P-0003', '유진', 'qa', 'working'),
  member('M-0022', 'P-0003', '민서', 'docs', 'error'),
  member('M-0023', 'P-0003', '선우', 'docs', 'idle'),
  member('M-0024', 'P-0003', '태오', 'developer', 'working'),
];
for (const [id, effortTier] of [['M-0017', 'high'], ['M-0020', 'low'], ['M-0021', 'high']] as const) {
  const person = members.find(member => member.id === id);
  if (person) {
    person.ai.effortTier = effortTier;
    person.ai.effortValue = effortTier === 'high' ? 'high' : 'low';
  }
}
const specialist = members.find(member => member.id === 'M-0024');
if (specialist) { specialist.ai.model = 'gpt-6-sol'; specialist.ai.modelValue = 'gpt-6-sol'; }
const visualDesigner = members.find(member => member.id === 'M-0019');
if (visualDesigner) { visualDesigner.ai.model = 'sonnet'; visualDesigner.ai.modelValue = 'sonnet'; }
const ownerChosen = members.find((member) => member.id === 'M-0003');
if (ownerChosen) {
  ownerChosen.aiDecision = {
    byName: '대표',
    byOwner: true,
    reason: '화면 디자인 작업에 맞춰 직접 지정',
    at: ago(90),
  };
}
const pendingChange = members.find((member) => member.id === 'M-0002');
if (pendingChange) {
  pendingChange.pendingAiChange = {
    kind: 'codex',
    model: 'gpt-6-sol',
    effortTier: 'high',
    effortOverride: null,
  };
}
const largeStudio = projects.find((project) => project.id === 'P-0003');
if (largeStudio) largeStudio.progress = progress(0, 0);
const directive = (
  id: string,
  projectId: string | null,
  title: string,
  state: DirectiveView['state'],
  taskIds: string[],
  reportId: string | null,
  round = 1,
): DirectiveView => ({
  id,
  projectId,
  title,
  text: `${title}${objectParticle(title)} 완성하고 확인 방법까지 정리해 주세요.`,
  round,
  state,
  createdAt: ago(2000),
  updatedAt: ago(14),
  progress: progress(state === 'closed' ? 5 : 2, 5),
  taskIds,
  latestReportId: reportId,
  attachments: [],
});
export const directives: DirectiveView[] = [
  directive('D-0001', 'P-0001', '산책 기록 화면 만들기', 'awaiting_confirmation', ['T-0001', 'T-0002', 'T-0003', 'T-0004'], 'R-0001', 2),
  directive('D-0002', 'P-0002', '위키 구조와 검색 개선', 'planning', ['T-0005', 'T-0006', 'T-0007', 'T-0012'], 'R-0002'),
  directive('D-0003', null, '이번 주 작업 정리', 'awaiting_confirmation', [], 'R-0003'),
  directive('D-0004', 'P-0001', '초기 콘셉트 검토', 'closed', [], 'R-0004'),
  directive('D-0005', 'P-0001', '취소된 화면 정리', 'cancelled', ['T-0010'], null),
];
const task = (
  id: string,
  directiveId: string,
  projectId: string,
  title: string,
  assigneeId: string,
  state: TaskView['state'],
  reviewerId: string | null,
  type: TaskView['type'],
): TaskView => ({
  id,
  directiveId,
  projectId,
  round: directiveId === 'D-0001' ? 2 : 1,
  title,
  goal: `${title}${objectParticle(title)} 완료하고 대표가 확인할 수 있게 결과를 남깁니다.`,
  type,
  priority: id === 'T-0004' ? 'high' : 'normal',
  state,
  assigneeId,
  reviewerId,
  prerequisiteIds: id === 'T-0004' ? ['T-0002'] : [],
  acceptanceCriteria: ['핵심 흐름이 동작한다', '자동 검사가 통과한다'],
  plannedAreas: ['src/ui/', 'docs/'],
  outputMode: type === 'docs' || type === 'asset' ? 'artifact' : 'repo',
  steps: ['요구사항 확인', '초안 작성', '기능 구현', '검증 및 정리'].map((title, idx) => ({
    idx: idx + 1,
    title,
    done: idx < (state === 'done' || state === 'in_review' ? 4 : state === 'waiting' ? 0 : 2),
    doneAt: idx < 2 ? ago(100 - idx * 30) : null,
    commitSha: idx === 1 ? 'a41c0f2' : null,
  })),
  progress: progress(state === 'done' || state === 'in_review' ? 4 : state === 'waiting' ? 0 : 2, 4),
  hold:
    state === 'on_hold'
      ? {
          reasons: [
            {
              kind: 'answer_wait',
              label: '답변 대기',
              note: '색상 선택을 기다립니다.',
              since: ago(45),
            },
          ],
          returnState: 'in_progress',
        }
      : null,
  review: { ...{
    round: 1,
    rejectsInRound: 0,
    rejectsTotal: 1,
    autoCheck: state === 'in_review' ? 'passed' : 'not_run',
    autoCheckDetail: state === 'in_review' ? 'npm test 통과' : '검사 전',
    targetPinnedAt: state === 'in_review' ? ago(90) : null,
    passed: state === 'done',
  } },
  branch: `work/${id.toLowerCase()}`,
  worktreePath: `C:\\Projects\\worktrees\\${id}`,
  conflictFiles: [],
  createdAt: ago(1000),
  activatedAt: ago(400),
  completedAt: state === 'done' ? ago(60) : null,
  merge:
    state === 'done'
      ? {
          mergeCommitSha: 'a41c0f2',
          mergedAt: ago(58),
        }
      : null,
  revertOfTaskId: null,
  revertedByTaskId: null,
});
export const tasks: TaskView[] = [
  task('T-0001', 'D-0001', 'P-0001', '기록 화면 흐름 만들기', 'M-0004', 'on_hold', 'M-0001', 'spec'),
  task('T-0002', 'D-0001', 'P-0001', '산책 장소 데이터 연결', 'M-0002', 'in_progress', 'M-0005', 'development'),
  task('T-0003', 'D-0001', 'P-0001', '시각 요소 다듬기', 'M-0003', 'in_progress', 'M-MAIN', 'design'),
  task('T-0004', 'D-0001', 'P-0001', '기록 흐름 검수', 'M-0005', 'in_review', 'M-MAIN', 'test'),
  task('T-0005', 'D-0002', 'P-0002', '위키 검색 구조 정리', 'M-0008', 'in_progress', 'M-0011', 'architecture'),
  task('T-0006', 'D-0002', 'P-0002', '문서 체계 점검', 'M-0010', 'waiting', 'M-0011', 'docs'),
  task('T-0007', 'D-0002', 'P-0002', '위키 배포 점검', 'M-0011', 'on_hold', 'M-0007', 'test'),
];
tasks[6].hold = {
  returnState: 'in_progress',
  reasons: [
    {
      kind: 'emergency_stop',
      label: '긴급 정지',
      note: '메인 에이전트가 지난 긴급 정지로 보류된 작업을 확인하고 재개합니다.',
      since: ago(150),
    },
  ],
};
tasks.push(
  task('T-0008', 'D-0001', 'P-0001', '검수 의견 다시 확인', 'M-0002', 'on_hold', 'M-0005', 'development'),
  task('T-0009', 'D-0001', 'P-0001', '자동 검사 결과 확인', 'M-0003', 'on_hold', 'M-0001', 'test'),
  task('T-0010', 'D-0005', 'P-0001', '병합된 화면 정리', 'M-0004', 'on_hold', 'M-0001', 'development'),
  task('T-0011', 'D-0002', 'P-0002', '위키 파일 충돌 해결', 'M-0010', 'in_progress', 'M-0011', 'development'),
  { ...task('T-0012', 'D-0002', 'P-0002', '위키 검색 결과 검수', 'M-0008', 'on_hold', null, 'test'),
    hold: { returnState: 'in_review', reasons: [{ kind: 'error', scope: 'task', refId: 'no_reviewer', reachesMain: true, label: '검수자 없음',
      note: '메인 에이전트가 검수 권한 팀원을 더하거나 검수자를 정한 뒤 재개합니다.', since: ago(17) }] } },
);
tasks.push(
  { ...task('T-0013', 'D-0002', 'P-0002', '위키 변경 병합', 'M-0010', 'on_hold', 'M-0011', 'development'),
    hold: { returnState: 'in_review', reasons: [{ kind: 'merge_blocked', label: '병합 기록 확인 필요', reachesMain: true,
      note: '병합 기록을 확인하지 못했습니다. 명령창으로 메인 에이전트에게 알려 주세요.', since: ago(20) }] } },
  { ...task('T-0014', 'D-0002', 'P-0002', '위키 실행 결과 복구 확인', 'M-0010', 'on_hold', 'M-0011', 'test'),
    hold: { returnState: 'in_progress', reasons: [{ kind: 'recovery_check', label: '복구 확인', reachesMain: true,
      refId: 'RQ-0007', note: '실행 결과가 남아 있습니다. 명령창으로 메인 에이전트에게 알려 주세요.', since: ago(90) }] } },
  { ...task('T-0015', 'D-0002', 'P-0002', '위키 안내 음원 만들기', 'M-0010', 'done', 'M-0011', 'asset'),
    goal: '위키의 주요 기능을 안내하는 음원을 만들고 재생 상태를 확인합니다.',
    acceptanceCriteria: ['음원이 끊김 없이 재생된다', '음량과 길이를 확인한 기록이 있다'],
    plannedAreas: ['deliverables/audio/'], merge: null, branch: null, worktreePath: null },
);
directives[1].taskIds.push('T-0013', 'T-0014', 'T-0015');
tasks[7].hold = { returnState: 'in_review', reasons: [{ kind: 'error', refId: 'rejudge', label: '다시 판정 실패',
  note: '다시 판정 못 함: 통과 뒤 검수자 담이에게 온 메인 에이전트 긴급 지시를 보고 다시 판정할 검수 턴이 3번 이어서 끊겼습니다. 검수자에게 메시지를 보낸 뒤 재개하면 그 판정대로 이어 가고, 메시지 없이 재개하면 등록한 통과로 병합 판단을 이어 갑니다.', since: ago(7) }] };
tasks[8].hold = { returnState: 'in_progress', reasons: [{ kind: 'error', scope: 'task', refId: 'RQ-CHECK-1', reachesMain: false, label: '검사 종료 확인 필요',
  note: '검사 뒤 커밋되지 않은 파일(dist/index.js, build/report.json)이 생겼습니다 — 재개하면 메인 에이전트가 확인한 것으로 보고, 같은 버전이면 검사를 다시 돌리지 않고 이 결과로 제출을 이어 갑니다. 파일이 그대로면 커밋하지 않고 제출을 거부해 담당에게 돌려보냅니다(빌드 산출물이면 .gitignore에 추가하라고 안내).', since: ago(12) }] };
tasks[9].merge = { mergeCommitSha: 'd55a771', mergedAt: ago(31) };
tasks[9].hold = { returnState: 'done', reasons: [{ kind: 'paused', scope: 'member', label: '일시정지',
  note: '지시가 취소됐어도 이미 병합된 작업은 보류 중입니다 (일시정지 — 팀원 서아 재개로 풀림).', since: ago(22) }] };
tasks[10].conflictFiles = ['src/wiki/SearchIndex.ts', 'assets/wiki-map.bin'];
tasks[10].conflictUnverifiable = ['assets/wiki-map.bin'];
tasks[3].changedCriteria = ['자동 검사가 통과한다'];
const markdown = (title: string, summary: string, projectId: string | null) => projectId === 'P-0002'
  ? `# ${title}\n\n## 요약\n${summary}\n\n## 결과\n- 위키 문서를 주제별로 분류했습니다.\n- 검색 결과에서 문서 제목과 분류를 함께 표시했습니다.\n\n## 변경 파일\n- \`src/wiki/SearchIndex.ts\`\n- \`docs/wiki-search.md\`\n\n## 확인 방법\n1. 문서 제목으로 검색합니다.\n2. 결과 목록에서 분류와 문서 연결을 확인합니다.\n\n## 이슈·리스크\n이름이 비슷한 문서의 정렬 기준을 더 확인해야 합니다.\n\n## 다음 할 일\n검색 결과의 정렬 기준을 검수합니다.\n`
  : projectId === null
    ? `# ${title}\n\n## 요약\n${summary}\n\n## 이번 주 결과\n- 산책 기록 화면의 장소 저장 기능을 연결했습니다.\n- 위키 검색 결과의 분류를 점검했습니다.\n\n## 다음 할 일\n남은 검수 의견을 확인합니다.\n`
    : `# ${title}\n\n## 요약\n${summary}\n\n## 결과\n- 산책 장소를 저장하고 지난 기록에서 다시 찾을 수 있게 했습니다.\n- 장소 이름과 방문 날짜가 기록 카드에 함께 보이도록 다듬었습니다.\n\n## 변경 파일\n- \`src/ui/WalkLog.tsx\`\n- \`docs/walk-log-flow.md\`\n\n## 확인 방법\n1. 산책 장소를 저장합니다.\n2. 기록 목록에서 장소와 날짜를 확인합니다.\n\n## 이슈·리스크\n모바일 폭에서 긴 장소 이름이 줄바꿈될 수 있습니다.\n\n## 다음 할 일\n대표 피드백 후 장소 카드의 문구를 정리합니다.\n`;
const reportSummaries: Record<string, string> = {
  'R-0001': '산책 장소 저장과 날짜 표시를 연결했습니다. 기록 목록에서 두 값이 함께 보이는지 확인해 주세요.',
  'R-0002': '위키 문서의 분류와 검색 진입점을 정리했습니다. 오래된 문서도 검색 결과에서 찾을 수 있습니다.',
  'R-0003': '이번 주에는 산책 기록 화면과 위키 검색 구조를 손봤고, 남은 검수 항목을 정리했습니다.',
  'R-0004': '첫 화면에서 장소를 고르고 기록을 남기는 흐름을 확정했습니다.',
  'R-0005': '장소 카드 초안을 만들었고, 날짜 표시에 대한 검수 의견을 받았습니다.',
};
const report = (
  id: string,
  projectId: string | null,
  projectName: string,
  directiveId: string | null,
  round: number,
  title: string,
  status: ReportDetail['status'],
): ReportDetail => ({
  id,
  projectId,
  projectName,
  directiveId,
  round,
  title,
  status,
  createdAt: ago(round === 2 ? 32 : 1700),
  markdown: markdown(title, reportSummaries[id], projectId),
  sections: {
    summary: reportSummaries[id],
    results: projectId === 'P-0002' ? '위키 문서를 분류하고 검색 결과의 제목 표시를 다듬었습니다.' : '장소와 날짜가 기록 카드에 함께 보입니다.',
    changedFiles: projectId === 'P-0002' ? ['src/wiki/SearchIndex.ts', 'docs/wiki-search.md'] : ['src/ui/WalkLog.tsx', 'docs/walk-log-flow.md'],
    howToVerify: projectId === 'P-0002' ? '문서 제목으로 검색해 분류와 결과 목록을 확인합니다.' : '산책 장소를 저장한 뒤 기록 목록에서 확인합니다.',
    issues: projectId === 'P-0002' ? '이름이 비슷한 문서의 정렬 기준을 더 확인해야 합니다.' : '모바일 폭에서 긴 장소 이름이 줄바꿈될 수 있습니다.',
    nextSteps: projectId === 'P-0002' ? '검색 결과의 정렬 기준을 검수합니다.' : '대표 피드백 후 장소 카드의 문구를 정리합니다.',
  },
  stats: {
    taskCount: 3,
    rejectCount: 1,
    durationSec: 7800,
    inputTokens: 18500,
    outputTokens: 4300,
    costUsd: null,
  },
  comments: [],
  otherRounds: [],
  filePath: `C:\\Users\\owner\\AppData\\Roaming\\Wook\\reports\\${id}.md`,
});
export const reports: ReportDetail[] = [
  report('R-0001', 'P-0001', '동네 산책 기록장', 'D-0001', 2, '산책 기록 화면 · 2회차 보고', 'new'),
  report('R-0002', 'P-0002', '사내 위키 정리', 'D-0002', 1, '위키 구조 개선 검토', 'read'),
  report('R-0003', null, '일반', null, 1, '이번 주 작업 요약', 'new'),
  report('R-0004', 'P-0001', '동네 산책 기록장', 'D-0004', 1, '초기 콘셉트 검토 결과', 'approved'),
  report('R-0005', 'P-0001', '동네 산책 기록장', 'D-0001', 1, '산책 기록 화면 · 1회차 보고', 'changes_requested'),
];
export const notifications: NotificationView[] = [
  { id: 'N-REVIEW-STUCK', key: 'review-stuck:T-0004:M-MAIN', level: 'normal', title: '검수 멈춤',
    body: 'D-0001: T-0004 검수가 같은 검수자로 다시 해도 판정 없이 끝나 메인 에이전트에게 넘겼습니다.',
    link: { tab: 'projects', projectId: 'P-0001', directiveId: 'D-0001', taskId: 'T-0004' }, createdAt: ago(2), read: false },
  { id: 'N-CRASH-DROP', key: 'crash:main:P-0001:Q-000123', level: 'urgent', title: '자동 복구 실패',
    body: '명령 처리 — 비정상 종료가 반복됩니다. 메인 에이전트에게 전하지 못한 대표 요청: 산책 기록 화면(P-0001) 명령 "기록을 저장한 뒤 산책 경로와 사진을 함께 확인할 수 있게 해 줘. 저장에 실패하면 작성하던 내용도 남겨 줘." — 필요하면 명령창으로 메인 에이전트에게 다시 말해 주세요',
    link: { tab: 'projects', projectId: 'P-0001', memberId: 'M-MAIN' }, createdAt: ago(3), read: false },
  { id: 'N-0004', level: 'urgent', title: '프로젝트 폴더 동기화 필요',
    body: 'main에는 병합(d55a771)됐지만 프로젝트 폴더에서 파일에 대표 변경이 섞여 있어 맞추지 않았습니다 — 아직 병합 전 내용: src/wiki/SearchIndex.ts / 병합 전 내용에 대표 변경이 더해짐: docs/wiki.md / 병합 변경이 들어 있는지 확인 못 함: assets/wiki-map.bin. 변경을 정리한 뒤 폴더를 최신 main으로 맞추세요.',
    link: { tab: 'projects', projectId: 'P-0002', taskId: 'T-0011' }, createdAt: ago(4), read: true },
  {
    id: 'N-0001',
    level: 'urgent',
    title: '메인 에이전트가 검수 중입니다',
    body: '메인 에이전트가 기록 흐름 검수를 맡았습니다.',
    link: {
      tab: 'projects',
      projectId: 'P-0001',
      taskId: 'T-0004',
    },
    createdAt: ago(8),
    read: false,
  },
  {
    id: 'N-0002',
    level: 'normal',
    title: '새 작업 보고를 확인해 주세요',
    body: '산책 기록 화면 · 2회차 보고',
    link: {
      tab: 'documents',
      reportId: 'R-0001',
    },
    createdAt: ago(30),
    read: false,
  },
  {
    id: 'N-0003',
    level: 'info',
    title: '팀 구성이 완료됐습니다',
    body: '사내 위키 정리 스튜디오가 준비됐습니다.',
    link: {
      tab: 'projects',
      projectId: 'P-0002',
    },
    createdAt: ago(800),
    read: true,
  },
  { id: 'N-CHAT-DEMO', key: 'main-reply:chat-demo', level: 'normal', title: '메인 에이전트의 답',
    body: '확인했습니다. 모바일 화면부터 살펴보고, 수정한 내용을 보고서에 모아 두겠습니다.',
    link: { tab: 'projects' }, createdAt: ago(1), read: false },
];
export const activity: ActivityView[] = [
  [members.find(member => member.id === 'M-MAIN')!.name, 'task', '위키 파일 충돌의 보류 사유를 확인하고 있습니다.', 'P-0002', 'M-MAIN'],
  ['지우', 'task', 'T-0011 main 병합(d55a771) 뒤 프로젝트 폴더를 맞추지 않음 — 아직 병합 전 내용: src/wiki/SearchIndex.ts / 병합 전 내용에 대표 변경이 더해짐: docs/wiki.md / 병합 변경이 들어 있는지 확인 못 함: assets/wiki-map.bin', 'P-0002', 'M-0007'],
  ['하음', 'report', '보고서 R-0001 제출', 'P-0001', 'M-0001'],
  ['시안', 'file_change', 'T-0002 진행 중 → 검수 중 · 장소 데이터 파일 수정', 'P-0001', 'M-0002'],
  ['지우', 'directive', '위키 검색 구조를 작업으로 나눴습니다.', 'P-0002', 'M-0007'],
  ['여울', 'task', '작업 생성 T-0003 · 검수 M-0005', 'P-0001', 'M-0003'],
  ['채원', 'error', 'CLI 연결이 중단됐습니다.', 'P-0002', 'M-0010'],
].map(([actorName, kind, text, projectId, memberId], index) => ({
  seq: 100 - index,
  ts: ago(index * 18 + 3),
  actor: memberId,
  actorName,
  projectId,
  taskId: null,
  memberId,
  kind: kind as ActivityView['kind'],
  level: kind === 'error' ? 'error' : 'info',
  text,
  result: null,
  requestId: null,
  sessionId: null,
  turnId: null,
}));
export const recovery: RecoveryItemView[] = [
  {
    requestId: 'RQ-0007',
    kind: 'git_merge',
    projectId: 'P-0002',
    taskId: 'T-0014',
    command: 'git merge',
    startedAt: ago(90),
    finding: '프로그램 종료 전에 병합 결과를 확인하지 못했습니다.',
  },
];
export const conversations: Record<string, ConversationView[]> = {
  'P-0001': [
    {
      id: 'C-0001',
      role: 'owner',
      text: '산책 기록 화면을 만들고 확인 방법을 알려줘.',
      attachments: [],
      directiveId: 'D-0001',
      createdAt: ago(2000),
    },
    {
      id: 'C-0002',
      role: 'main_agent',
      text: '프로듀서가 작업을 나누어 진행하고 있습니다.',
      attachments: [],
      directiveId: 'D-0001',
      createdAt: ago(1900),
    },
  ],
  'P-0002': [],
  main: [
    {
      id: 'C-0003',
      role: 'owner',
      text: '이번 주 작업을 정리해 줘.',
      attachments: [],
      directiveId: 'D-0003',
      createdAt: ago(1000),
    },
    { id: 'C-CHAT-1', role: 'main_agent', text: '이번 주에는 산책 기록 화면과 자료 검색을 진행했습니다. 산책 기록은 검수를 마쳤고, 검색 화면은 조건을 바꾸며 확인하고 있습니다.', attachments: [], directiveId: null, createdAt: ago(900) },
    { id: 'C-CHAT-2', role: 'owner', text: '휴대폰에서 쓰는 화면을 먼저 봐 줘. 확인할 내용도 적어 뒀어.', attachments: [{ id: 'A-9001', name: '모바일 확인 메모.txt', path: 'demo/mobile-review.txt', size: 84, mime: 'text/plain' }], directiveId: null, createdAt: ago(700) },
    { id: 'C-CHAT-3', role: 'main_agent', text: '메모를 읽었습니다. 버튼 간격과 긴 제목이 잘리는 부분부터 확인하겠습니다. 결과는 어느 부서에 남길까요?', attachments: [], directiveId: null, createdAt: ago(600) },
    { id: 'C-CHAT-4', role: 'owner', text: '산책 기록장 쪽에 남겨 줘. 바뀐 화면도 같이 보고 싶어.', attachments: [], directiveId: null, createdAt: ago(400) },
    { id: 'C-CHAT-5', role: 'system', text: '모바일 화면 점검 요청을 전달했습니다.', attachments: [], directiveId: null, createdAt: ago(350) },
    { id: 'C-CHAT-6', role: 'main_agent', text: '확인했습니다. 모바일 화면부터 살펴보고, 수정한 내용을 보고서에 모아 두겠습니다.', attachments: [], directiveId: null, createdAt: ago(1) },
  ],
};
export const skills: SkillView[] = [
  {
    name: '문서 정리',
    description: '작업 결과를 문서로 정리합니다.',
    source: 'claude',
    path: 'skills/docs',
    mode: 'auto',
    allowedRoles: ['producer', 'docs'],
  },
  {
    name: '코드 검수',
    description: '변경 코드를 점검합니다.',
    source: 'codex',
    path: 'skills/review',
    mode: 'manual',
    allowedRoles: ['architect', 'qa'],
  },
];
export const settings: Settings = {
  general: {
    mainAgent: {
      kind: 'claude',
      model: null,
      effortTier: 'high',
      effortOverride: null,
    },
    backup: {
      enabled: true,
      keep: 7,
    },
    launchAtLogin: false,
  },
  account: {
    googleClientId: '',
    googleClientSecretSet: false,
    authMode: {
      claude: 'subscription',
      codex: 'subscription',
    },
  },
  team: {
    effortMapping: {
      claude: {
        high: 'high',
        normal: 'medium',
        low: 'low',
      },
      codex: {
        high: 'high',
        normal: 'medium',
        low: 'low',
      },
    },
    modelCatalog: {
      claude: [
        { id: 'fable', label: 'Fable (최신 최상위)', note: '가장 어려운 설계와 추론에 쓰며, 느리고 사용량이 큽니다.' },
        { id: 'opus', label: 'Opus', note: '깊은 추론, 설계, 검수와 복잡한 구현에 씁니다.' },
        {
          id: 'sonnet',
          label: 'Sonnet',
          note: '일반 문서와 기획 작업',
        },
        { id: 'haiku', label: 'Haiku', note: '빠르고 저렴하며, 단순 반복과 정리 작업에 씁니다.' },
      ],
      codex: [
        {
          id: 'gpt-6-sol',
          label: 'GPT-6 Sol',
          note: '코드 구현과 검토',
        },
      ],
    },
  },
  execution: {
    maxConcurrent: 5,
    turnTimeoutMin: 60,
    claudeMaxTurns: null,
    noOutputMin: 10,
    commandMaxMin: 30,
    healthCheckMin: 3,
    crashRetryMax: 2,
    spinSameErrorCount: 5,
    spinNoProgressMin: 30,
    spinNoProgressResumes: 3,
    preventSleep: true,
  },
  policy: {
    emergencyShortcut: 'Ctrl+Shift+F12',
    sensitiveAreas: [
      {
        kind: 'system',
        paths: ['C:\\Windows'],
      },
      {
        kind: 'personal',
        paths: ['C:\\Users\\owner\\Documents'],
      },
      {
        kind: 'secret',
        paths: ['.env'],
      },
      {
        kind: 'app',
        paths: ['AppData\\Roaming\\Wook'],
      },
    ],
  },
  skills: {
    overrides: {},
  },
  logs: {
    retentionDays: 90,
  },
  developer: {
    mainAgentMock: true,
    mockSpeed: 2,
  },
  cli: {
    claudePath: null,
    codexPath: null,
  },
};
export const snapshot: AppSnapshot = {
  seat: structuredClone(LOCKED_SEAT),
  version: 1,
  generatedAt: now(),
  auth: {
    loggedIn: false,
    owner: null,
    googleConfigured: false,
    googleSecretSet: false,
    ownerRegistered: false,
    googleSetupOpen: true,
    devLoginAllowed: true,
  },
  stop: {
    global: {
      active: false,
      since: null,
    },
    pausedProjects: [],
    pausedMembers: [{ memberId: 'M-0020', since: ago(25), mode: 'immediate', by: 'system', reason: '작업 프로세스 종료를 확인하지 못해 일시정지했습니다.' },
      { memberId: 'M-0004', since: ago(22), mode: 'graceful', by: 'owner' }],
    lastEmergency: null,
    heldByEmergency: 1,
  },
  projects,
  members,
  directives,
  tasks,
  ownerTodos: [
    {
      kind: 'question',
      id: 'todo-question',
      questionId: 'Q-0001',
      fromId: 'M-MAIN',
      fromName: '메인 에이전트',
      text: '기록 저장 버튼은 초록색으로 통일할까요?',
      projectId: 'P-0001',
      since: ago(44),
    },
    {
      kind: 'unread_report',
      id: 'todo-report',
      reportId: 'R-0001',
      title: '산책 기록 화면 · 2회차 보고',
      projectId: 'P-0001',
      since: ago(30),
    },
    {
      kind: 'error',
      id: 'todo-error',
      memberId: 'M-0003',
      taskId: 'T-0009',
      projectId: 'P-0001',
      message: 'T-0009 자동 검사 결과 확인: 여울의 검사 종료를 확인하지 못했습니다. 메인에게 전달한 업무가 중단됐습니다.',
      reachesMain: false,
      since: ago(16),
    },
    { kind: 'error', id: 'todo-no-reviewer', memberId: 'M-0008', taskId: 'T-0012', projectId: 'P-0002',
      message: 'T-0012 검수자 없음 — 메인 에이전트가 현우의 작업에 검수자를 정합니다.', reachesMain: true, since: ago(17) },
    { kind: 'error', id: 'todo-merge', memberId: null, taskId: 'T-0013', projectId: 'P-0002',
      message: 'T-0013 위키 변경 병합: 병합 기록을 확인하지 못했습니다. 명령창으로 메인 에이전트에게 알려 주세요.', reachesMain: true, since: ago(20) },
    // Older servers omit reachesMain. Keep that path visible in the preview too.
    { kind: 'error', id: 'todo-legacy-error', memberId: 'M-0002', taskId: 'T-0008', projectId: 'P-0001',
      message: 'T-0008 시안의 작업에 다시 판정을 받을지 확인해야 합니다.', since: ago(18) },
    {
      kind: 'recovery_check',
      id: 'todo-recovery',
      requestId: 'RQ-0007',
      taskId: 'T-0014',
      projectId: 'P-0002',
      message: 'T-0014 위키 실행 결과 복구 확인이 필요합니다. 명령창으로 메인 에이전트에게 알려 주세요.',
      reachesMain: true,
      since: ago(90),
    },
    {
      kind: 'auth_required',
      id: 'todo-auth',
      aiKind: 'codex',
      since: ago(32),
    },
    {
      kind: 'emergency_held',
      id: 'todo-held-undelivered',
      count: 2,
      reachesMain: false,
      since: ago(145),
    },
    // Keep the older-server emergency list without reachesMain too.
    {
      kind: 'emergency_held',
      id: 'todo-held',
      count: 1,
      since: ago(150),
    },
  ],
  notifications: {
    unread: 2,
    urgentUnread: 1,
  },
  recentActivity: activity,
  ai: [
    {
      kind: 'claude',
      installed: true,
      version: '2.1.0',
      problem: null,
      usageLimitedUntil: null,
      authRequired: false,
      blocked: false,
    },
    {
      kind: 'codex',
      installed: true,
      version: '0.113.0',
      problem: null,
      usageLimitedUntil: null,
      authRequired: true,
      blocked: true,
    },
  ],
  running: {
    total: 5,
    general: 3,
    management: 2,
    cap: 5,
    generalCap: 4,
    queued: 2,
  },
  trayStatus: 'awaiting',
  roles,
};
