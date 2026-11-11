/** ID 형식 (5.2: 작업 T-0001, 지시 D-0001). 번호는 DB 카운터가 발급한다. */
export type IdKind =
  | 'project'
  | 'member'
  | 'role'
  | 'directive'
  | 'task'
  | 'session'
  | 'turn'
  | 'queue'
  | 'question'
  | 'report'
  | 'review'
  | 'message'
  | 'request'
  | 'notification'
  | 'attachment'
  | 'conversation'
  | 'comment'
  | 'capture'
  | 'external_agent';

const FORMAT: Record<IdKind, { prefix: string; width: number }> = {
  project: { prefix: 'P', width: 4 },
  member: { prefix: 'M', width: 4 },
  role: { prefix: 'role', width: 4 },
  directive: { prefix: 'D', width: 4 },
  task: { prefix: 'T', width: 4 },
  session: { prefix: 'S', width: 6 },
  turn: { prefix: 'TN', width: 6 },
  queue: { prefix: 'W', width: 6 },
  question: { prefix: 'Q', width: 4 },
  report: { prefix: 'R', width: 4 },
  review: { prefix: 'RV', width: 4 },
  message: { prefix: 'MSG', width: 6 },
  request: { prefix: 'RQ', width: 6 },
  notification: { prefix: 'N', width: 6 },
  attachment: { prefix: 'A', width: 6 },
  conversation: { prefix: 'C', width: 6 },
  comment: { prefix: 'RC', width: 5 },
  // 화면 캡처 (리드 결정 S6-3) — 'S-'는 세션이다
  capture: { prefix: 'SC', width: 6 },
  // 외부 에이전트 (SERVER_DESIGN 4.5, 리드 결정 S7-2) — 운영자가 등록할 때 낸다('X-0001'). 폐기한 ID는 다시 쓰지 않는다
  external_agent: { prefix: 'X', width: 4 },
};

export function formatId(kind: IdKind, n: number): string {
  const f = FORMAT[kind];
  return `${f.prefix}-${String(n).padStart(f.width, '0')}`;
}

/** 브랜치 이름용 짧은 이름 (task/T-0012-login-ui). 한글 제목이면 작업 ID만 */
export function branchSlug(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return ascii;
}

export function taskBranchName(taskId: string, title: string): string {
  const slug = branchSlug(title);
  return slug ? `task/${taskId}-${slug}` : `task/${taskId}`;
}
