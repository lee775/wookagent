import type { AppSnapshot } from '../../../shared/views';
import { TASK_STATE_LABEL } from '../../../shared/labels';

const events: Record<string, string> = {
  create: '작업 생성', activate: '작업 시작', submit: '검수 요청', review: '검수 완료',
  hold: '작업 보류', resume: '작업 재개', cancel: '작업 취소', complete: '작업 완료',
  merge: '결과 반영', reject: '수정 요청',
  basis_changed: '검수 기준 변경', reassign: '담당자 변경', review_pass: '검수 통과',
  replanned: '계획 변경', release: '보류 해제', reopen: '작업 다시 열기',
};
export function taskStateText(value: string): string {
  if (value === '-' || !value) return '시작 전';
  return Object.hasOwn(TASK_STATE_LABEL, value) ? TASK_STATE_LABEL[value as keyof typeof TASK_STATE_LABEL] : '상태 확인 중';
}
export function taskEventText(value: string): string { return events[value] ?? '상태 변경'; }
type DisplayContext = Partial<Pick<AppSnapshot, 'tasks' | 'directives' | 'projects' | 'members' | 'ownerTodos'>> | null;
const stateLabels: Record<string, string> = {
  in_progress: '진행 중', in_review: '검수 중', on_hold: '보류 중',
  awaiting_confirmation: '확인 대기', planning: '계획 중', reporting: '보고 중',
  waiting: '대기 중', cancelled: '취소됨', done: '완료됨',
};
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function particle(word: string, withFinal: string, withoutFinal: string): string {
  const code = word.trim().slice(-1).charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 ? withFinal : withoutFinal;
}
export function subjectParticle(word: string): string { return particle(word, '이', '가'); }
function titleFor(id: string, snapshot: DisplayContext): string {
  if (id.startsWith('T-')) return snapshot?.tasks?.find(task => task.id === id)?.title ?? '작업';
  if (id.startsWith('D-')) return snapshot?.directives?.find(directive => directive.id === id)?.title ?? '지시';
  if (id.startsWith('P-')) return snapshot?.projects?.find(project => project.id === id)?.name ?? '프로젝트';
  if (id.startsWith('M-')) return snapshot?.members?.find(member => member.id === id)?.name ?? '팀원';
  const reportTodo = snapshot?.ownerTodos?.find(todo => todo.kind === 'unread_report' && todo.reportId === id);
  if (reportTodo?.kind === 'unread_report') return reportTodo.title;
  return snapshot?.projects?.find(project => project.latestReport?.id === id)?.latestReport?.title ?? '보고서';
}

/** Converts backend event and error strings at the owner-facing display boundary. */
export function resolveDisplayText(value: string, snapshot: DisplayContext): string {
  return value.split('\n').map(line => resolveDisplayLine(line, snapshot)).join('\n');
}
function resolveDisplayLine(value: string, snapshot: DisplayContext): string {
  // Claude/Codex file and search summaries contain literal paths, including relative paths.
  if (/^(?:\[하위\] )?(?:파일 변경|파일 작성|파일 수정|파일 노트북 수정|읽기|파일 찾기|내용 검색):\s*\S/.test(value)) return value;
  if (/^(?:실행 권한 확인 발생 \(바이패스 불일치\): |\(같은 오류 반복\) )파일 변경이 승인 단계에서 거부되었습니다:\s*\S/.test(value)) return value;
  const titles: string[] = [];
  let result = value.replace(/\b([TDRPM]-\d{4})\b/gi, (_, raw: string) => {
    const title = titleFor(raw.toUpperCase(), snapshot);
    titles.push(title);
    return title;
  });
  for (const title of new Set(titles)) {
    if (['작업', '지시', '보고서', '팀원'].includes(title)) continue;
    const escaped = escapeRegExp(title);
    result = result.replace(new RegExp(escaped + '\\s+' + escaped, 'g'), title);
    const first = result.indexOf(title);
    const second = result.indexOf(title, first + title.length);
    if (second >= 0) result = result.slice(0, second).replace(/[:：]\s*$/, '').trimEnd() + result.slice(second + title.length);
  }
  result = result.replace(/이\(가\)|은\(는\)|을\(를\)/g, (match, offset: number) => {
    const word = result.slice(0, offset).trimEnd().match(/([^\s·:()]+)$/)?.[1] ?? '';
    if (match === '이(가)') return particle(word, '이', '가');
    if (match === '은(는)') return particle(word, '은', '는');
    return particle(word, '을', '를');
  });
  return result.replace(/\b(in_progress|in_review|on_hold|awaiting_confirmation|planning|reporting|waiting|cancelled|done)\b/g, state => stateLabels[state])
    .replace(/\bmerge\s*:/gi, '병합:')
    .replace(/\bmain\b/g, '기본 브랜치');
}
export function resolveWorkLabel(label: string, snapshot: DisplayContext): string {
  return resolveDisplayText(label, snapshot);
}
