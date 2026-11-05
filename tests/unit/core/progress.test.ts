/**
 * 진행도 — 기획서 5.5 (작업: 완료 단계 ÷ 전체 단계, 단계 없으면 0% / 지시: 하위 작업 완료 단계 합 ÷ 전체 단계 합,
 * 단계 없는 작업은 1단계 / 표시: '단계 3/7', 검수 중이면 '검수 중' / 단계가 늘면 진행도가 내려갈 수 있음).
 */
import { describe, expect, it } from 'vitest';
import type { Step, Task } from '@shared/domain';
import { directiveProgress, progressLabel, ratio, taskProgress } from '@core/progress';
import { steps, taskIn } from './fixtures';

describe('작업 진행도', () => {
  it.each([
    { flags: [], done: 0, total: 0, r: 0 }, // 단계가 아직 없으면 0%
    { flags: [false, false, false], done: 0, total: 3, r: 0 },
    { flags: [true, false, false], done: 1, total: 3, r: 1 / 3 },
    { flags: [true, true, true, false, false, false, false], done: 3, total: 7, r: 3 / 7 },
    { flags: [true, true, true], done: 3, total: 3, r: 1 },
  ])('$done/$total → $r', ({ flags, done, total, r }) => {
    const p = taskProgress(steps('T-0001', flags));
    expect(p.done).toBe(done);
    expect(p.total).toBe(total);
    expect(p.ratio).toBeCloseTo(r, 10);
  });

  it('작업 도중 단계가 늘어나면 진행도가 내려갈 수 있다 (정상)', () => {
    const before = taskProgress(steps('T-0001', [true, true, false]));
    const after = taskProgress(steps('T-0001', [true, true, false, false, false]));
    expect(after.ratio).toBeLessThan(before.ratio);
  });

  it('ratio: 0으로 나누지 않고 1을 넘지 않는다', () => {
    expect(ratio(0, 0)).toBe(0);
    expect(ratio(3, 0)).toBe(0);
    expect(ratio(5, 4)).toBe(1);
  });
});

describe('지시 진행도', () => {
  type Row = { name: string; tasks: { t: Task; flags: boolean[] }[]; done: number; total: number };
  const A = (over: Partial<Task>, flags: boolean[]) => ({ t: taskIn(over.state ?? 'in_progress', over), flags });
  const table: Row[] = [
    { name: '작업 없음 → 0/0', tasks: [], done: 0, total: 0 },
    { name: '단계 없는 작업 1개 → 1단계로 계산', tasks: [A({ id: 'T-1', state: 'waiting' }, [])], done: 0, total: 1 },
    {
      name: '단계 합: 2/4 + 1/3 → 3/7',
      tasks: [A({ id: 'T-1' }, [true, true, false, false]), A({ id: 'T-2' }, [true, false, false])],
      done: 3,
      total: 7,
    },
    {
      name: '단계 없는 작업은 분모에 1 (2/4 + 0/1 → 2/5)',
      tasks: [A({ id: 'T-1' }, [true, true, false, false]), A({ id: 'T-2', state: 'waiting' }, [])],
      done: 2,
      total: 5,
    },
    {
      name: '취소된 작업은 빼고 계산',
      tasks: [A({ id: 'T-1' }, [true, false]), A({ id: 'T-2', state: 'cancelled' }, [true, true, true, true])],
      done: 1,
      total: 2,
    },
    {
      name: '완료된 단계 없는 작업 → 1/1',
      tasks: [A({ id: 'T-1', state: 'done' }, []), A({ id: 'T-2' }, [false])],
      done: 1,
      total: 2,
    },
    {
      name: '모든 작업 완료 → 100%',
      tasks: [A({ id: 'T-1', state: 'done' }, [true, true]), A({ id: 'T-2', state: 'done' }, [])],
      done: 3,
      total: 3,
    },
    {
      name: '검수·보류 중 작업도 단계 그대로 합산',
      tasks: [A({ id: 'T-1', state: 'in_review' }, [true, true, true]), A({ id: 'T-2', state: 'on_hold' }, [true, false, false, false])],
      done: 4,
      total: 7,
    },
  ];

  it.each(table)('$name', ({ tasks, done, total }) => {
    const byId = new Map<string, Step[]>(tasks.map(({ t, flags }) => [t.id, steps(t.id, flags)]));
    const p = directiveProgress(
      tasks.map((x) => x.t),
      (id) => byId.get(id) ?? [],
    );
    expect({ done: p.done, total: p.total }).toEqual({ done, total });
    expect(p.ratio).toBeCloseTo(total === 0 ? 0 : done / total, 10);
  });
});

describe('표시', () => {
  it("'단계 3/7'처럼 실제 개수", () => {
    expect(progressLabel(taskIn('in_progress'), taskProgress(steps('T-0001', [true, true, true, false, false, false, false])))).toBe('단계 3/7');
    expect(progressLabel(taskIn('waiting'), taskProgress([]))).toBe('단계 0/0');
  });

  it("검수 중이면 '검수 중'", () => {
    expect(progressLabel(taskIn('in_review'), taskProgress(steps('T-0001', [true, true])))).toBe('검수 중');
  });
});
