/**
 * 작업 개체 도우미를 쓸 수 없는 환경(taskkill 대체 방식 + 제한 언어 모드)의 시험 도우미 — 5단계 S5b부터 종료를 확인하지 못한 작업 보류는 메인 에이전트에게 알림
 * 업무(alert kill-failed:<작업>)로 간다 (리드 결정 S5-7). 그 알림을 실은 메인 턴도 이 환경에서는 종료를 확인하지 못해 프로그램이 메인 에이전트를 일시정지한다
 * (CTL-11 — 메인 실행의 출구는 대표의 '정지 해제', 리드 결정 6). 메인 에이전트 대신 도구를 부르는 시험은 그 턴이 끝나기를 기다리고, 메인이 일시정지됐으면
 * 대표처럼 정지 해제를 누른 뒤 부른다 — 알림이 안내하는 그대로다
 */
import { MAIN_AGENT_ID } from '@shared/domain';
import type { Harness } from '../e2e/harness';

export async function mainSettled(e: Harness): Promise<void> {
  const ctx = e.core.ctx;
  const paused = () => !!ctx.stop().members[MAIN_AGENT_ID]?.paused;
  for (let i = 0; i < 5; i++) {
    await e.waitFor(() => !e.core.turns.isMemberRunning(MAIN_AGENT_ID) && (paused() || !ctx.store.queue.list({ ref1: MAIN_AGENT_ID, state: 'queued' }).some((q) => q.kind === 'alert')), {
      label: '메인 에이전트의 알림 턴',
      timeoutMs: 60_000,
    });
    if (!paused()) return;
    await e.invoke('stop.release');
  }
  throw new Error('메인 에이전트의 알림 턴이 끝나지 않음');
}
