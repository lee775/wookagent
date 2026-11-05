/**
 * 중단·취소 (concurrency:CONC-05, spec:F11, windows:F6, spec:F2 취소 부분).
 * - 대표의 선택(보류·취소)은 실행 종료·정리보다 먼저 저장한다 (CTL-08) → 정리 중에 새 턴·검사·작업 재개가 생기지 않는다
 * - 실행 종료 확인 → 중간 결과 보관 → 취소 → 작업 공간 정리 (5.3). 정리는 최선 노력이고 다음 시작 때 다시 한다
 * - 같은 작업의 취소가 겹치면 하나로, 취소 중에는 재개·재배정을 받지 않는다. 재시작해도 취소를 마저 한다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIN_AGENT_ID } from '@shared/domain';
import { CANCEL_HOLD_REF } from '@core/taskMachine';
import { BackendError } from '../../src/main/backend/types';
import { taskKey } from '../../src/main/orchestrator/records';
import type { Env } from './helpers';
import { activate, boot, git, mergeAndSettle, newTask, notices, passedTask, sleep, waitFor } from './helpers';

let env: Env | null = null;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  await env?.close();
  env = null;
});

async function activeTask(e: Env, o: Parameters<typeof newTask>[1] = {}) {
  return activate(e, newTask(e, o).id);
}

function spyContinueWork(e: Env): string[] {
  const calls: string[] = [];
  const tasks = e.core.tasks;
  const orig = tasks.continueWork.bind(tasks);
  tasks.continueWork = (id, msg, kind, attempts) => {
    calls.push(`${id}:${e.ctx.store.tasks.require(id).state}`);
    return orig(id, msg, kind, attempts);
  };
  return calls;
}

describe('선택을 먼저 저장 (CTL-08)', () => {
  it('중단 → 보류: 실행 종료를 기다리기 전에 보류가 저장된다', async () => {
    env = await boot();
    const t = await activeTask(env);
    const p = env.core.tasks.interrupt(t.id, 'hold', MAIN_AGENT_ID);
    const now = env.ctx.store.tasks.require(t.id);
    expect(now.state).toBe('on_hold');
    expect(now.hold.reasons.map((r) => r.kind)).toEqual(['interrupted']);
    await p;
  });

  it('취소: 정리 전에 보류로 바뀌고, 보관 → 취소 → 작업 폴더·브랜치 정리', async () => {
    env = await boot();
    const e = env;
    const t = await activeTask(e);
    writeFileSync(join(t.workspace!.worktreePath, 'half.txt'), '중간 결과\n');
    const calls = spyContinueWork(e);
    const p = e.core.tasks.cancel(t.id, '대표 취소', MAIN_AGENT_ID);
    expect(e.ctx.store.tasks.require(t.id).state).toBe('on_hold');
    expect(e.core.tasks.isCancelling(t.id)).toBe(true);
    await p;
    const c = e.ctx.store.tasks.require(t.id);
    expect(c.state).toBe('cancelled');
    expect(c.hold.reasons).toEqual([]);
    expect(e.core.tasks.isCancelling(t.id)).toBe(false);
    // 중간 결과는 보관 ref에 남는다 (GIT-10)
    const archived = git(e.projectDir, ['rev-parse', '--verify', `refs/wook/archive/${t.id}-cancel`]);
    expect(git(e.projectDir, ['show', '--name-only', '--format=', archived])).toContain('half.txt');
    expect(existsSync(t.workspace!.worktreePath)).toBe(false);
    expect(git(e.projectDir, ['branch', '--list', t.workspace!.branch])).toBe('');
    expect(calls).toEqual([]);
    expect(e.ctx.store.queue.list({ ref2: taskKey(t.id), state: 'queued' })).toEqual([]);
  });
});

describe('자동 검사 중 취소 (CONC-05)', () => {
  it('검사가 끊겨도 제출 처리가 작업을 다시 진행시키지 않고, 취소가 끝난 뒤 남은 업무가 없다', async () => {
    const scripts = mkdtempSync(join(tmpdir(), 'wook-test-reg-script-'));
    cleanups.push(() => rmSync(scripts, { recursive: true, force: true }));
    const sleeper = join(scripts, 'sleep.js');
    writeFileSync(sleeper, 'setTimeout(() => process.exit(0), 30000);\n');
    env = await boot({ runner: true, checkCommands: [`node ${sleeper}`] });
    const e = env;
    const t = await activeTask(e);
    e.core.tasks.setSteps(t.id, ['단계']);
    writeFileSync(join(t.workspace!.worktreePath, 'a.txt'), 'a\n');
    const dev = e.ctx.store.members.require(t.assigneeId);
    await e.core.tasks.completeStep(t.id, 0, '', dev, null);
    e.core.tasks.requestSubmit(t.id, '제출', dev);
    const sub = e.core.tasks.processSubmission(t.id);
    await waitFor(() => e.core.checks.running.has(t.id), '자동 검사 시작');
    const calls = spyContinueWork(e);
    await e.core.tasks.cancel(t.id, '대표 취소', MAIN_AGENT_ID);
    await sub;
    const c = e.ctx.store.tasks.require(t.id);
    expect(c.state).toBe('cancelled');
    expect(calls).toEqual([]);
    expect(e.ctx.store.queue.list({ ref2: taskKey(t.id), state: 'queued' })).toEqual([]);
    expect(e.core.checks.running.has(t.id)).toBe(false);
    expect(existsSync(t.workspace!.worktreePath)).toBe(false);
  });
});

describe('겹치는 조작', () => {
  it('같은 작업의 취소가 겹치면 하나로 처리하고, 취소 중에는 재개·재배정을 받지 않는다', async () => {
    env = await boot({ team: ['developer', 'developer'] });
    const e = env;
    const t = await activeTask(e);
    const a = e.core.tasks.cancel(t.id, '대표 취소', MAIN_AGENT_ID);
    const b = e.core.tasks.cancel(t.id, '프로듀서 취소', e.producer.id);
    expect(b).toBe(a);
    expect(() => e.core.tasks.resumeByOwner(t.id, MAIN_AGENT_ID)).toThrow(BackendError);
    expect(() => e.core.tasks.reassign(t.id, e.members[1]!.id, MAIN_AGENT_ID)).toThrow(/취소 처리 중/);
    await Promise.all([a, b]);
    const cancels = e.ctx.store.transitions.list(t.id).filter((x) => x.event === 'cancel');
    expect(cancels).toHaveLength(1);
  });

  it('이미 완료된 작업은 취소하지 않고 이유를 알린다 (조용히 "취소됨"으로 답하지 않음)', async () => {
    env = await boot();
    const e = env;
    const t = await passedTask(e, { reviewer: 'main' });
    expect((await mergeAndSettle(e, t.id)).state).toBe('done');
    const err = await e.core.tasks.cancel(t.id, '프로듀서 취소', e.producer.id).then(
      () => null,
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(BackendError);
    expect((err as BackendError).code).toBe('conflict');
    expect(e.ctx.store.tasks.require(t.id).state).toBe('done');
  });

  it('재시작: 취소 처리 중에 끊긴 작업은 재시작 복구가 취소를 마저 한다 (진행으로 되살리지 않음)', async () => {
    env = await boot();
    const e = env;
    const t = await activeTask(e);
    // 취소가 보류를 저장한 뒤 앱이 꺼진 상태
    e.core.tasks.hold(t.id, 'interrupted', 'task', '취소 처리 중: 대표 취소', MAIN_AGENT_ID, CANCEL_HOLD_REF);
    await e.core.recovery.run();
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'cancelled', '재시작 후 취소 마무리');
    expect(e.ctx.store.queue.list({ ref2: taskKey(t.id), state: 'queued' })).toEqual([]);
  });
});

describe('작업 폴더를 지우지 못해도 취소는 끝난다 (windows:F6)', () => {
  it('폴더가 잠겨 정리에 실패해도 취소·후속 보류·알림까지 하고, 다음 시작 때 정리를 마친다', async () => {
    env = await boot();
    const e = env;
    const directiveId = e.core.directives.register({ projectId: e.project.id, title: 'D', text: 'D' }, 'M-MAIN', null).id;
    const t = await activeTask(e, { directiveId });
    const dep = newTask(e, { directiveId, prerequisiteIds: [t.id], title: '후속' });
    const wt = t.workspace!.worktreePath;
    let holder: ChildProcess | null = null;
    let restore: (() => void) | null = null;
    if (process.platform === 'win32') {
      // 다른 프로그램(터미널 등)이 작업 폴더를 현재 폴더로 잡고 있는 상황
      holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: wt, stdio: 'ignore', windowsHide: true });
      await sleep(800);
    } else {
      const g = e.ctx.deps.git;
      const orig = g.removeWorktree.bind(g);
      g.removeWorktree = async (repo, p) => {
        if (p === wt) throw new Error('EBUSY: resource busy or locked (모의)');
        return orig(repo, p);
      };
      restore = () => (g.removeWorktree = orig);
    }
    const kill = () => {
      if (holder?.pid) spawnSync('taskkill', ['/PID', String(holder.pid), '/T', '/F']);
      holder = null;
    };
    cleanups.push(kill);
    await e.core.tasks.cancel(t.id, '대표 취소', MAIN_AGENT_ID);
    expect(e.ctx.store.tasks.require(t.id).state).toBe('cancelled');
    const d = e.ctx.store.tasks.require(dep.id);
    expect(d.state).toBe('on_hold');
    expect(d.hold.reasons.map((r) => r.kind)).toEqual(['prereq_cancelled']);
    expect(notices(e, '작업 폴더 정리 실패')).toHaveLength(1);
    expect(existsSync(wt)).toBe(true);

    // 잠금이 풀린 뒤 시작하면 정리를 마친다 (멱등)
    kill();
    restore?.();
    await sleep(500);
    await e.core.recovery.run();
    expect(existsSync(wt)).toBe(false);
    expect(git(e.projectDir, ['branch', '--list', t.workspace!.branch])).toBe('');
    expect(e.ctx.store.tasks.require(t.id).state).toBe('cancelled');
  });
});
