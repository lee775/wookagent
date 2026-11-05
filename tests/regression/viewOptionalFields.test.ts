/**
 * 화면이 보류 해제 경로·다시 판정 보류·확인 못 한 충돌 파일·바뀐 검수 기준·검사 실행 기록을 보여 줄 수 있게 작업 화면 데이터에 싣는다.
 * 7~9단계가 백엔드에 남긴 값(HoldReason.scope·refId, TaskConflict.unverifiable, Task.changedCriteria, auto_check exec 결과)이
 * TaskView·TaskDetail에 빠져 있어 화면이 표시할 수 없었다. 모두 선택 필드다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecRecord } from '@shared/domain';
import { boot, newTask, type Env } from './helpers';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('작업 화면 데이터의 선택 필드', () => {
  it('보류 사유에 범위와 관련 ID를 싣는다 (팀원 재개·다시 판정 보류 구분)', async () => {
    env = await boot();
    const t = newTask(env);
    const now = env.ctx.now();
    env.ctx.store.tasks.put({
      ...env.ctx.store.tasks.require(t.id),
      state: 'on_hold',
      hold: {
        reasons: [
          { kind: 'paused', scope: 'member', refId: null, note: '팀원 일시정지', since: now, by: 'M-MAIN' },
          { kind: 'error', scope: 'task', refId: 'rejudge', note: '다시 판정 못 함', since: now, by: 'system' },
        ],
        returnState: 'in_review',
      },
    });
    const v = env.core.views.taskView(env.ctx.store.tasks.require(t.id));
    expect(v.hold?.reasons.map((r) => [r.kind, r.scope, r.refId])).toEqual([
      ['paused', 'member', null],
      ['error', 'task', 'rejudge'],
    ]);
  });

  it('열린 충돌의 확인 못 한 파일과 최근 바뀐 검수 기준을 싣는다', async () => {
    env = await boot();
    const t = newTask(env);
    const before = env.core.views.taskView(env.ctx.store.tasks.require(t.id));
    expect(before.conflictUnverifiable).toEqual([]);
    expect(before.changedCriteria).toEqual([]);
    env.ctx.store.tasks.put({
      ...env.ctx.store.tasks.require(t.id),
      acceptanceCriteria: ['동작한다', '목차가 있다'],
      changedCriteria: ['목차가 있다'],
      conflict: { files: ['a.txt', 'logo.bin'], since: env.ctx.now(), resolverId: null, unverifiable: ['logo.bin'] },
    });
    const v = env.core.views.taskView(env.ctx.store.tasks.require(t.id));
    expect(v.conflictFiles).toEqual(['a.txt', 'logo.bin']);
    expect(v.conflictUnverifiable).toEqual(['logo.bin']);
    expect(v.changedCriteria).toEqual(['목차가 있다']);
  });

  it('작업 상세에 자동 검사 실행 기록을 오래된 것부터 싣는다 (대표 확인 시각·남은 프로세스·남은 파일)', async () => {
    env = await boot();
    const t = newTask(env);
    const other = newTask(env);
    const base = { projectId: env.project.id, cwd: env.projectDir, target: t.id, command: 'npm test' };
    const recs: ExecRecord[] = [
      {
        ...base,
        requestId: 'R-2',
        kind: 'auto_check',
        taskId: t.id,
        state: 'succeeded',
        startedAt: '2026-10-28T10:05:00.000Z',
        endedAt: '2026-10-28T10:05:09.000Z',
        result: { exitCode: 0, timedOut: false, output: 'ok', remaining: -1, heldSince: '2026-10-28T10:05:10.000Z', leftFiles: ['out.txt'], ownerConfirmedAt: '2026-10-28T10:20:00.000Z' },
      },
      { ...base, requestId: 'R-1', kind: 'auto_check', taskId: t.id, state: 'failed', startedAt: '2026-10-28T10:00:00.000Z', endedAt: '2026-10-28T10:00:30.000Z', result: { exitCode: null, timedOut: true, output: '' } },
      { ...base, requestId: 'R-3', kind: 'git_merge', taskId: t.id, state: 'succeeded', startedAt: '2026-10-28T10:30:00.000Z', endedAt: '2026-10-28T10:30:01.000Z', result: {} },
      { ...base, requestId: 'R-4', kind: 'auto_check', taskId: other.id, target: other.id, state: 'succeeded', startedAt: '2026-10-28T10:01:00.000Z', endedAt: null, result: { exitCode: 0 } },
    ];
    for (const r of recs) env.ctx.store.execs.put(r);
    const d = await env.core.views.taskDetail(t.id);
    expect(d.checkRuns).toEqual([
      { requestId: 'R-1', command: 'npm test', state: 'failed', startedAt: '2026-10-28T10:00:00.000Z', endedAt: '2026-10-28T10:00:30.000Z', exitCode: null, timedOut: true, remaining: null, ownerConfirmedAt: null, leftFiles: [] },
      {
        requestId: 'R-2',
        command: 'npm test',
        state: 'succeeded',
        startedAt: '2026-10-28T10:05:00.000Z',
        endedAt: '2026-10-28T10:05:09.000Z',
        exitCode: 0,
        timedOut: false,
        remaining: -1,
        ownerConfirmedAt: '2026-10-28T10:20:00.000Z',
        leftFiles: ['out.txt'],
      },
    ]);
  });
});
