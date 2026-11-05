/** 진행도 계산 (기획서 5.5) */
import type { Step, Task } from '@shared/domain';
import type { ProgressView } from '@shared/views';

export function ratio(done: number, total: number): number {
  return total <= 0 ? 0 : Math.min(1, done / total);
}

/** 작업: 완료 단계 ÷ 전체 단계. 단계가 없으면 0% */
export function taskProgress(steps: readonly Step[]): ProgressView {
  const total = steps.length;
  const done = steps.filter((s) => s.done).length;
  return { done, total, ratio: ratio(done, total) };
}

/**
 * 지시: 하위 작업 전체의 완료 단계 합 ÷ 전체 단계 합. 단계가 없는 작업은 1단계로 계산.
 * 취소된 작업은 빼고, 완료된 작업은 단계가 없더라도 1/1로 본다.
 */
export function directiveProgress(tasks: readonly Task[], stepsOf: (taskId: string) => readonly Step[]): ProgressView {
  let done = 0;
  let total = 0;
  for (const t of tasks) {
    if (t.state === 'cancelled') continue;
    const steps = stepsOf(t.id);
    if (steps.length === 0) {
      total += 1;
      if (t.state === 'done') done += 1;
    } else {
      total += steps.length;
      done += t.state === 'done' ? steps.length : steps.filter((s) => s.done).length;
    }
  }
  return { done, total, ratio: ratio(done, total) };
}

/** '단계 3/7' 또는 '검수 중' */
export function progressLabel(task: Pick<Task, 'state'>, p: ProgressView): string {
  if (task.state === 'in_review') return '검수 중';
  return `단계 ${p.done}/${p.total}`;
}
