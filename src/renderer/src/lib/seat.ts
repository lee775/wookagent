import type { NavTarget } from '../../../shared/domain';
import type { JournalKind, JournalRef, AppSnapshot } from '../../../shared/views';

// Journal questions scroll to an answer field; all screen targets use the shared contract.
export type RendererTarget = NavTarget | { tab: 'question'; questionId: string };
export const journalLabels = {
  command: '받은 명령', action: '메인 행동', report: '보고', seat: '자리', stop: '긴급 정지',
  decision: '결정', promise: '약속', note: '메모', rollup: '월별 묶음',
} satisfies Record<JournalKind, string>;

export function journalTarget(ref: JournalRef, snapshot: AppSnapshot): RendererTarget | null {
  if (ref.label === '(지워짐)') return null;
  switch (ref.kind) {
    case 'project': return snapshot.projects.some(p => p.id === ref.id) ? { tab: 'projects', projectId: ref.id } : null;
    case 'member': return snapshot.members.some(m => m.id === ref.id && !m.deleted) ? { tab: 'projects', memberId: ref.id } : null;
    case 'task': return snapshot.tasks.some(t => t.id === ref.id) ? { tab: 'projects', taskId: ref.id } : null;
    case 'directive': return snapshot.directives.some(d => d.id === ref.id) ? { tab: 'projects', directiveId: ref.id } : null;
    case 'report': return { tab: 'documents', reportId: ref.id };
    case 'question': return snapshot.ownerTodos.some(todo => todo.kind === 'question' && todo.questionId === ref.id) ? { tab: 'question', questionId: ref.id } : null;
  }
}
