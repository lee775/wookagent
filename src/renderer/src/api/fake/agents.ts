import type { ExternalAgentView } from '../../../../shared/views';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

// IDs and times only: these viewing fixtures contain no authentication material.
export function createFakeAgents(scenario: string | null): ExternalAgentView[] {
  if (!scenario || scenario === 'none') return [];
  const seated: ExternalAgentView = { id: 'X-0001', label: '산책 도우미', createdAt: ago(4320), revokedAt: null,
    lastSeenAt: ago(0.1), seat: 'seated', connected: true };
  switch (scenario) {
    case 'connected': return [seated];
    case 'disconnected': return [{ ...seated, connected: false, lastSeenAt: ago(1) }];
    case 'unresponsive': return [{ ...seated, connected: false, lastSeenAt: ago(8) }];
    case 'revoked': return [{ ...seated, connected: false, revokedAt: ago(2), lastSeenAt: ago(3) }];
    case 'incoming': return [seated, { ...seated, id: 'X-0002', label: '기록 정리 도우미', createdAt: ago(1440), lastSeenAt: null, seat: 'incoming', connected: false }];
    case 'several': return [seated,
      { ...seated, id: 'X-0002', label: '기록 정리 도우미', lastSeenAt: ago(120), seat: null, connected: false },
      { ...seated, id: 'X-0003', label: '지난 점검 도우미', revokedAt: ago(1440), lastSeenAt: ago(1500), seat: null, connected: false },
      { ...seated, id: 'X-0004', label: '새 점검 도우미', createdAt: ago(60), lastSeenAt: null, seat: null, connected: false }];
    default: return [];
  }
}
