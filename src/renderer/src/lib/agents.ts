import type { ExternalAgentView, SeatHolderView, SeatView } from '../../../shared/views';

export function holderLabel(holder: SeatHolderView | null): string {
  if (!holder) return '메인 에이전트 없음';
  return holder.kind === 'external' ? `${holder.label} · 외부 에이전트` : holder.label;
}

export function agentConnected(agent: ExternalAgentView, seat: SeatView): boolean {
  return agent.connected && agent.revokedAt === null && seat.state !== 'stopped';
}

export const EXTERNAL_ACCESS_ENDED = '서버 접근이 철회됐습니다. 외부 프로그램의 종료 여부는 확인할 수 없습니다.';
