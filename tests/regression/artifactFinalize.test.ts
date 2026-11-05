/**
 * 산출물 확정 실패 처리 (concurrency:CONC-14, REV-05).
 * 검수 통과 뒤의 확정(보관 복사)이 파일 오류로 실패하면 예전에는 처리되지 않은 거부만 남고 작업이 검수(통과) 상태로 멈췄다.
 * 지금은 오류 보류 + 긴급 알림 → 대표가 원인을 정리하고 재개하면 다시 확정한다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID } from '@shared/domain';
import type { Env } from './helpers';
import { activate, boot, newTask, notices, pass, sleep, waitFor } from './helpers';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { artifactWorkDir } from '../../src/main/orchestrator/paths';

let env: Env | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

async function artifactInReview(e: Env) {
  const t = newTask(e, { outputMode: 'artifact', type: 'docs' });
  await activate(e, t.id);
  e.core.tasks.setSteps(t.id, ['문서']);
  const dir = artifactWorkDir(e.ctx.paths, t.projectId, t.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.md'), '# 문서\n', 'utf8');
  const assignee = e.ctx.store.members.require(t.assigneeId);
  await e.core.tasks.completeStep(t.id, 0, '완료', assignee, null);
  e.core.tasks.requestSubmit(t.id, '제출', assignee);
  await e.core.tasks.processSubmission(t.id);
  expect(e.ctx.store.tasks.require(t.id).state).toBe('in_review');
  return t;
}

describe('산출물 확정 실패 (CONC-14)', () => {
  it('확정이 파일 오류로 실패하면 오류 보류 + 긴급 알림, 재개하면 다시 확정해 완료한다', async () => {
    env = await boot();
    const e = env;
    const t = await artifactInReview(e);
    const merges = e.core.merges;
    const real = merges.finalizeArtifact.bind(merges);
    merges.finalizeArtifact = async () => {
      throw new Error("EBUSY: resource busy or locked, rmdir 'C:\\...\\v1'");
    };
    pass(e, t.id);
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'on_hold', '오류 보류');
    const held = e.ctx.store.tasks.require(t.id);
    expect(held.hold.reasons.map((r) => r.kind)).toEqual(['error']);
    expect(held.hold.returnState).toBe('in_review');
    expect(notices(e, '산출물 확정 실패')).toHaveLength(1);

    merges.finalizeArtifact = real;
    e.core.tasks.resumeByOwner(t.id, MAIN_AGENT_ID);
    await waitFor(() => e.ctx.store.tasks.require(t.id).state === 'done', '재개 후 확정');
    await sleep(20);
    expect(e.ctx.store.tasks.require(t.id).artifact?.files.map((f) => f.path)).toEqual(['spec.md']);
  });
});
