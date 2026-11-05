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
  | 'comment';

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
