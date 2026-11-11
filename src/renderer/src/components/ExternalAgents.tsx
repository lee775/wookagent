import { useEffect, useState } from 'react';
import type { ExternalAgentView, SeatView } from '../../../shared/views';
import { call } from '../api/store';
import { agentConnected, EXTERNAL_ACCESS_ENDED } from '../lib/agents';
import { date, Section } from '../lib/ui';

export function useExternalAgents(seat: SeatView) {
  const [agents, setAgents] = useState<ExternalAgentView[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true, busy = false;
    setAgents(null); setError('');
    const read = async () => {
      if ((typeof document !== 'undefined' && document.hidden) || busy) return;
      busy = true;
      try {
        const value = await call('agents.list');
        if (active) { setAgents(value); setError(''); }
      } catch {
        if (active) { setAgents(null); setError('외부 에이전트 정보를 불러오지 못했습니다.'); }
      } finally { busy = false; }
    };
    void read();
    const timer = setInterval(() => { void read(); }, 5000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', read);
    return () => { active = false; clearInterval(timer); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', read); };
  }, [seat.generation, seat.state, seat.unresponsiveSince]);
  return { agents, error };
}

export function AgentConnection({ agent, seat }: { agent: ExternalAgentView; seat: SeatView }) {
  const connected = agentConnected(agent, seat);
  return <div className="agent-connection">
    <span className={`agent-status ${connected ? 'connected' : 'disconnected'}`}>{connected ? '연결됨' : '연결 안 됨'}</span>
    {!connected && <span>마지막 접속: {agent.lastSeenAt ? date(agent.lastSeenAt) : '접속 기록 없음'}</span>}
  </div>;
}

export function ExternalHolderConnection({ seat, agents, error }: { seat: SeatView; agents: ExternalAgentView[] | null; error: string }) {
  if (seat.holder?.kind !== 'external') return null;
  const agentId = seat.holder.agentId;
  const agent = agents?.find(row => row.id === agentId);
  return <div className="external-holder-state" role="status" aria-label="메인 외부 에이전트 연결 상태">
    <p className="muted">에이전트 ID: {agentId}</p>
    {error ? <p>{error} 연결 상태를 확인할 수 없습니다.</p> : agents === null ? <p>연결 상태를 확인하는 중…</p> :
      agent ? <><AgentConnection agent={agent} seat={seat} />{agent.revokedAt && <p>{EXTERNAL_ACCESS_ENDED}</p>}</> : <p>등록 정보를 찾을 수 없어 연결 상태를 확인할 수 없습니다.</p>}
    {seat.state === 'stopped' && !agent?.revokedAt && <p>{EXTERNAL_ACCESS_ENDED}</p>}
  </div>;
}

export function ExternalAgents({ agents, error, seat }: { agents: ExternalAgentView[] | null; error: string; seat: SeatView }) {
  return <section className="external-agents" aria-label="등록된 외부 에이전트">
    <Section title="등록된 외부 에이전트" action={agents && <span className="agent-count">{agents.length}개</span>}>
      <p className="agent-list-help">서버 PC에서 등록한 별도 프로그램입니다. 등록과 접근 철회, 자리 배정은 서버 PC의 운영자가 합니다.</p>
      {error ? <p role="alert">{error}</p> : agents === null ? <p role="status">외부 에이전트를 불러오는 중…</p> : agents.length === 0 ?
        <p className="empty">등록된 외부 에이전트가 없습니다.</p> :
        <ul className="external-agent-list">{agents.map(agent => <li key={agent.id} aria-label={`외부 에이전트 ${agent.label} (${agent.id})`}>
          <div className="agent-heading"><div><h3>{agent.label}</h3><span className="agent-id">{agent.id}</span></div><span className="agent-seat">{agent.seat === 'seated' ? '메인 자리 보유' : agent.seat === 'incoming' ? '다음 보유자 · 교체 중' : '자리 없음'}</span></div>
          <AgentConnection agent={agent} seat={seat} />
          <dl className="seat-metadata"><div><dt>등록</dt><dd>{date(agent.createdAt)}</dd></div>
            <div><dt>접근 권한</dt><dd>{agent.revokedAt ? `철회됨 · ${date(agent.revokedAt)}` : '유효'}</dd></div>
            <div><dt>마지막 접속</dt><dd>{agent.lastSeenAt ? date(agent.lastSeenAt) : '접속 기록 없음'}</dd></div></dl>
          {agent.revokedAt && <p className="agent-revoked-note">{EXTERNAL_ACCESS_ENDED}</p>}
        </li>)}</ul>}
    </Section>
  </section>;
}
