/**
 * 정지와 자동 검사 (concurrency:CONC-06, windows:F5, CTL-03·07·09, AC-29).
 * - 정지·보류 뒤에는 자동 검사 프로세스를 새로 띄우지 않는다 (제출 처리가 git을 기다리던 중이어도, 명령 사이에도)
 * - 정지로 못 끝낸 검사는 실패로 치지 않고 제출 요청을 남겨 재개 때 다시 한다
 * - 검사 프로세스 종료를 확인하지 못하면 긴급 정지를 완료로 표시하지 않는다
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIN_AGENT_ID, OWNER } from '@shared/domain';
import type { ManagedProcess } from '../../src/main/process/types';
import type { Env } from './helpers';
import { activate, boot, newTask, notices, waitFor } from './helpers';

let env: Env | null = null;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  await env?.close();
  env = null;
});

function scriptDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wook-test-reg-script-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'quick.js'), 'setTimeout(() => process.exit(0), 300);\n');
  writeFileSync(join(dir, 'slow.js'), 'setTimeout(() => process.exit(0), 30000);\n');
  return dir;
}

/** 제출할 준비가 된 작업 (변경 커밋 + 검수 요청) */
async function readyToSubmit(e: Env): Promise<string> {
  const t = newTask(e);
  await activate(e, t.id);
  e.core.tasks.setSteps(t.id, ['단계']);
  const ws = e.ctx.store.tasks.require(t.id).workspace!;
  writeFileSync(join(ws.worktreePath, `${t.id}.txt`), 'x\n');
  const dev = e.ctx.store.members.require(t.assigneeId);
  await e.core.tasks.completeStep(t.id, 0, '', dev, null);
  e.core.tasks.requestSubmit(t.id, '제출', dev);
  return t.id;
}

function spyStarts(e: Env): string[] {
  const labels: string[] = [];
  const runner = e.ctx.deps.runner;
  const orig = runner.start.bind(runner);
  runner.start = (spec) => {
    labels.push(spec.label);
    return orig(spec);
  };
  return labels;
}

describe('정지 뒤 자동 검사를 띄우지 않는다', () => {
  it('제출 처리가 최신 main 반영을 기다리는 중 긴급 정지 → 검사 프로세스 0개, 제출 요청 유지, 실패로 기록하지 않음', async () => {
    const dir = scriptDir();
    env = await boot({ runner: true, checkCommands: [`node ${join(dir, 'quick.js')}`] });
    const e = env;
    const id = await readyToSubmit(e);
    const starts = spyStarts(e);
    const g = e.ctx.deps.git;
    const orig = g.mergeBaseInto.bind(g);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    g.mergeBaseInto = async (...a) => {
      entered = true;
      await gate; // 큰 저장소에서 반영이 오래 걸리는 상황
      return orig(...a);
    };
    const sub = e.core.tasks.processSubmission(id);
    await waitFor(() => entered, '최신 main 반영 진입');
    const summary = await e.core.stops.emergency(OWNER);
    expect(summary.completed).toBe(true);
    release();
    await sub;
    expect(starts.filter((l) => l.startsWith('검사'))).toEqual([]);
    const t = e.ctx.store.tasks.require(id);
    expect(t.state).toBe('on_hold');
    expect(t.pendingSubmit).not.toBeNull();
    expect(t.review.autoCheck.status).not.toBe('failed');
    expect(e.ctx.store.execs.list({ ref1: id, ref2: 'auto_check' })).toEqual([]);
  });

  it('검사 명령 사이에 일시정지되면 다음 명령을 띄우지 않고 재개 때 다시 검사한다', async () => {
    const dir = scriptDir();
    env = await boot({ runner: true, checkCommands: [`node ${join(dir, 'quick.js')}`, `node ${join(dir, 'slow.js')}`] });
    const e = env;
    const id = await readyToSubmit(e);
    const starts: string[] = [];
    const runner = e.ctx.deps.runner;
    const orig = runner.start.bind(runner);
    runner.start = (spec) => {
      starts.push(spec.label);
      const proc = orig(spec);
      // 첫 검사가 도는 동안 대표가 프로젝트를 일시정지 (단계 마치고 — 실행 중 검사는 끝까지)
      if (starts.length === 1) void e.core.stops.pauseProject(e.project.id, 'graceful', MAIN_AGENT_ID);
      return proc;
    };
    await e.core.tasks.processSubmission(id);
    expect(starts).toHaveLength(1);
    const t = e.ctx.store.tasks.require(id);
    expect(t.state).toBe('on_hold');
    expect(t.pendingSubmit).not.toBeNull();
    expect(t.review.autoCheck.status).toBe('not_run');
    expect(e.ctx.store.queue.list({ state: 'queued' }).filter((q) => q.kind === 'task_work' && q.taskId === id)).toEqual([]);
  });

  it('보류된 작업에는 검사 명령을 하나도 실행하지 않는다', async () => {
    const dir = scriptDir();
    env = await boot({ runner: true, checkCommands: [`node ${join(dir, 'quick.js')}`] });
    const e = env;
    const id = await readyToSubmit(e);
    const starts = spyStarts(e);
    const held = e.core.tasks.hold(id, 'interrupted', 'task', '대표 중단', MAIN_AGENT_ID);
    const out = await e.core.checks.run(held, e.ctx.store.projects.require(e.project.id), held.workspace!.worktreePath);
    expect(out.status).toBe('failed');
    expect(out.stopped).toBe(true);
    expect(starts).toEqual([]);
  });
});

describe('긴급 정지 요약 (CTL-03)', () => {
  it('실행 중 검사를 종료하고 결과를 돌려준다', async () => {
    const dir = scriptDir();
    env = await boot({ runner: true, checkCommands: [`node ${join(dir, 'slow.js')}`] });
    const e = env;
    const id = await readyToSubmit(e);
    const sub = e.core.tasks.processSubmission(id);
    await waitFor(() => e.core.checks.running.has(id), '검사 시작');
    const results = await e.core.checks.terminateFor(() => true);
    expect(results.map((r) => [r.taskId, r.result.ok])).toEqual([[id, true]]);
    await sub;
    expect(e.ctx.store.tasks.require(id).pendingSubmit).not.toBeNull();
  });

  it('팀원 즉시 일시정지는 그 팀원이 맡은 작업의 실행 중 검사도 끝낸다 (프로젝트 즉시 정지와 같게, CTL-07)', async () => {
    const dir = scriptDir();
    env = await boot({ runner: true, checkCommands: [`node ${join(dir, 'slow.js')}`] });
    const e = env;
    const id = await readyToSubmit(e);
    const assignee = e.ctx.store.tasks.require(id).assigneeId;
    const sub = e.core.tasks.processSubmission(id);
    await waitFor(() => e.core.checks.running.has(id), '검사 시작');
    const t0 = Date.now();
    await e.core.stops.pauseMember(assignee, 'immediate', MAIN_AGENT_ID);
    await sub;
    // 30초짜리 검사를 기다리지 않고 끝나야 한다
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(e.core.checks.running.has(id)).toBe(false);
    const t = e.ctx.store.tasks.require(id);
    expect(t.pendingSubmit).not.toBeNull();
    expect(t.hold.reasons.some((r) => r.kind === 'paused' && r.scope === 'member')).toBe(true);
  });

  it('검사 프로세스 종료를 확인하지 못하면 완료로 표시하지 않고 종료 실패를 알린다', async () => {
    env = await boot();
    const e = env;
    const t = newTask(e);
    const stuck: ManagedProcess = {
      pid: null,
      childPid: Promise.resolve(null),
      exited: new Promise(() => undefined),
      onStdoutLine() {},
      onStderrLine() {},
      terminate: async () => ({ ok: false, remaining: 2, detail: '남은 프로세스 2개', durationMs: 3000 }),
    };
    e.core.checks.running.set(t.id, stuck);
    const summary = await e.core.stops.emergency(OWNER);
    e.core.checks.running.delete(t.id);
    expect(summary.completed).toBe(false);
    expect(summary.failures.map((f) => f.detail)).toEqual([`자동 검사 ${t.id}: 남은 프로세스 2개`]);
    expect(notices(e, '긴급 정지 — 종료 실패')).toHaveLength(1);
  });
});
