import { useEffect, useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import type { AppSnapshot, MemberDetail, MemberView, DiffView } from '../../../shared/views';
import type { CliEvent } from '../../../shared/events';
import type { Settings } from '../../../shared/domain';
import {
  AI_KIND_LABEL,
  EFFORT_TIER_LABEL,
  SESSION_KIND_LABEL,
  TASK_STATE_LABEL,
  TURN_END_LABEL,
  MEMBER_STATUS_LABEL,
} from '../../../shared/labels';
import { getBridge } from '../api/bridge';
import { call } from '../api/store';
import { date, Diff, duration, LabelValue, Progress, Section, StatusBadge } from '../lib/ui';
import { openCommand } from '../lib/commands';
import { MainPauseNotice } from './MainPauseNotice';
import { Member3DPortrait } from '../studio3d/Member3DPortrait';
import { resolveDisplayText, resolveWorkLabel, subjectParticle } from '../lib/displayText';
import { messageDeliveryStatus } from '../lib/taskSignals';
const eventLabel: Record<CliEvent['kind'], string> = {
  session: '세션',
  text: '대화',
  thinking: '생각 요약',
  tool_call: '도구 호출',
  tool_result: '도구 결과',
  command_start: '명령 시작',
  command_end: '명령 종료',
  file_change: '파일 변경',
  mcp_call: '앱 도구 호출',
  usage: '사용량',
  error: '오류',
  result: '턴 결과',
  system: '시스템',
  stderr: '표준 오류',
};
function MemberAiSummary({ member, effortMapping }: { member: MemberView; effortMapping: Settings['team']['effortMapping'] | null }) {
  const decisionMaker = member.aiDecision?.byName ?? '메인 에이전트';
  return (
    <>
      <p className="muted">
        {AI_KIND_LABEL[member.ai.kind]} · {member.ai.modelValue ?? '기본 모델'} · {EFFORT_TIER_LABEL[member.ai.effortTier]} ({member.ai.effortValue}){member.ai.mock ? ' · 모의' : ''}
      </p>
      {member.aiDecision && <div className="ai-decision">
        <span>
          {decisionMaker}{subjectParticle(decisionMaker)} AI 설정을 골랐습니다.
          {member.aiDecision?.reason && <small> 선택할 때 참고한 내용: {member.aiDecision.reason}</small>}
          {member.aiDecision?.at && <small className="decision-date">{date(member.aiDecision.at)}</small>}
        </span>

      </div>}
      {member.pendingAiChange && (
        <p className="hint">
          다음 작업부터 적용: {AI_KIND_LABEL[member.pendingAiChange.kind]} · {member.pendingAiChange.model ?? '기본 모델'} ·{' '}
          {EFFORT_TIER_LABEL[member.pendingAiChange.effortTier]} ({member.pendingAiChange.effortOverride ?? effortMapping?.[member.pendingAiChange.kind][member.pendingAiChange.effortTier] ?? '설정값 확인 중'})
        </p>
      )}
    </>
  );
}
export function MemberPanel({
  id,
  snapshot,
  close,
  openTask,
}: {
  id: string;
  snapshot: AppSnapshot;
  close: () => void;
  openTask: (id: string) => void;
}) {
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [events, setEvents] = useState<CliEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [turnId, setTurnId] = useState('');
  const [lastLiveTurn, setLastLiveTurn] = useState('');
  const snapshotMember = snapshot.members?.find(item => item.id === id);
  const currentLiveTurn = snapshotMember?.currentWork?.turnId ?? '';
  const [raw, setRaw] = useState(false);
  const [diff, setDiff] = useState<DiffView | null>(null);
  const [effortMapping, setEffortMapping] = useState<Settings['team']['effortMapping'] | null>(null);
  useEffect(() => { void call('settings.get').then(value => setEffortMapping(value.team.effortMapping)).catch(() => undefined); }, [snapshot.version]);
  useEffect(() => {
    setDetail(null);
    setTurnId('');
    setLastLiveTurn('');
    setEvents([]);
    setCursor(null);

  }, [id]);
  useEffect(() => {
    void call('members.getDetail', id)
      .then((value) => {
        setDetail(value);
        const live = value.member.currentWork?.turnId ?? value.recentTurns.find(turn => turn.running)?.id ?? '';
        if (live && live !== lastLiveTurn) { setLastLiveTurn(live); setTurnId(live); }
        else setTurnId((old) => old || value.recentTurns[0]?.id || '');
      })
      .catch(() => undefined);
  }, [id, snapshot.version]);
  useEffect(() => {
    if (currentLiveTurn && currentLiveTurn !== lastLiveTurn) {
      setLastLiveTurn(currentLiveTurn);
      setTurnId(currentLiveTurn);
    }
  }, [currentLiveTurn, lastLiveTurn]);
  useEffect(() => {
    if (!turnId) return;
    void call('members.getEvents', id, {
      turnId,
      limit: 40,
    })
      .then((page) => {
        setEvents(page.events);
        setCursor(page.nextCursor);
      })
      .catch(() => undefined);
  }, [id, turnId]);
  useEffect(
    () =>
      getBridge().subscribe('cliEvents', (payload) => {
        if (payload.memberId !== id) return;
        if (payload.turnId !== turnId && payload.turnId === currentLiveTurn) setTurnId(payload.turnId);
        if (payload.turnId === turnId) setEvents((old) => [...old, ...payload.events].slice(-300));
      }),
    [id, turnId, currentLiveTurn],
  );
  useEffect(() => {
    const taskId = detail?.currentTask?.id;
    if (taskId)
      void call('tasks.getDiff', taskId)
        .then(setDiff)
        .catch(() => undefined);
    else setDiff(null);
  }, [detail?.currentTask?.id]);
  const member = detail?.member;
  const automaticPause = snapshot.stop?.pausedMembers?.find(entry => entry.memberId === id && entry.by === 'system');
  const talk = () => { if (member) { close(); openCommand(member.projectId, `${member.id} ${member.name}(${member.roleName})에 대해: `); } };
  return (
    <aside className="member-panel" aria-label="팀원 상세">
      <div className="slide-head">
        <span>팀원 상세</span>
        <button className="icon-button" onClick={close} aria-label="팀원 상세 닫기">
          <X size={20} />
        </button>
      </div>
      {!detail || !member ? (
        <p className="loading">불러오는 중…</p>
      ) : (
        <div className="slide-scroll">
          <div className="member-hero">
            <Member3DPortrait member={member} className="member-hero-art" />
            <div className="member-hero-copy">
              <span className="eyebrow">{member.roleName}</span>
              <h2>{member.name}</h2>
              <StatusBadge status={member.status} />
            </div>
          </div>
          <MemberAiSummary member={member} effortMapping={effortMapping} />
          <button className="primary-button command-shortcut" onClick={talk}>메인 에이전트에게 말하기</button>
          {member.isMain && <MainPauseNotice snapshot={snapshot} />}
          {!(member.isMain && member.status === 'paused') && member.statusReasons[0] && member.statusReasons[0] !== `${MEMBER_STATUS_LABEL[member.status]}입니다.` &&
            <p className="status-reason">{resolveDisplayText(member.statusReasons[0], snapshot)}</p>}
          {!member.isMain && automaticPause && <p className="status-reason">자동 일시정지 · {automaticPause.reason ? resolveDisplayText(automaticPause.reason, snapshot) : '시스템이 실행을 멈췄습니다.'}</p>}
          <div className="detail-grid">
            <LabelValue label="가동 시간">{duration(member.runSeconds)}</LabelValue>
            <LabelValue label="대기 작업">{member.queuedCount}개</LabelValue>
            <LabelValue label="최근 활동">{date(member.lastActivityAt)}</LabelValue>
          </div>
          <Section title="현재 작업">
            {detail.currentTask ? (
              <>
                <button className="list-link" onClick={() => openTask(detail.currentTask!.id)}>
                  <strong>{detail.currentTask.title}</strong> · {TASK_STATE_LABEL[detail.currentTask.state]} →
                </button>
                <Progress value={detail.currentTask.progress} />
                <div className="step-list">
                  {detail.currentTask.steps.map((step) => (
                    <div
                      key={step.idx}
                      className={`step ${step.done ? 'done' : ''} ${!step.done && step.idx === detail.currentTask!.progress.done + 1 ? 'current' : ''}`}
                    >
                      <span>{step.done ? '✓' : step.idx}</span>
                      {step.title}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              member.currentWork ? <p>지금 하는 일: {resolveWorkLabel(member.currentWork.label, snapshot)}<br /><small>시작: {date(member.currentWork.startedAt)}</small></p> : <p className="muted">지금은 쉬고 있습니다.</p>
            )}
          </Section>
          <Section
            title="CLI 기록"
            action={
              <label className="small-toggle">
                <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> 원본 형식 보기
              </label>
            }
          >
            <p className="muted small">기록에 포함된 비밀 값은 저장 전에 가립니다.</p>
            <select value={turnId} onChange={(e) => setTurnId(e.target.value)} aria-label="턴 선택">
              {detail.recentTurns.map((turn) => (
                <option key={turn.id} value={turn.id}>
                  {date(turn.startedAt)} · {turn.endReason ? TURN_END_LABEL[turn.endReason] : '실행 중'}
                </option>
              ))}
            </select>
            <div className="turn-chips">
              {detail.recentTurns
                .filter((t) => t.id === turnId)
                .map((turn) => (
                  <span key={turn.id}>
                    <span className={`mini-chip ${turn.bypass === 'mismatch' ? 'error' : ''}`}>
                      바이패스 {turn.bypass === 'verified' ? '검증됨' : turn.bypass === 'requested' ? '요청됨' : '불일치'}
                    </span>{' '}
                    <span className={`mini-chip ${turn.mcp === 'failed' ? 'error' : ''}`}>
                      MCP {turn.mcp === 'connected' ? '연결됨' : turn.mcp === 'failed' ? '실패' : '미확인'}
                    </span>
                  </span>
                ))}
            </div>
            <div className="cli-list">
              {events.map((event) => (
                <div key={`${event.turnId}-${event.seq}`} className={`cli-event cli-${event.kind}`}>
                  <time>{date(event.ts)}</time>
                  <span className="cli-kind">{eventLabel[event.kind]}</span>
                  <p>{event.text}</p>
                  {event.data?.command && <code>{event.data.command}</code>}
                  {event.data?.paths?.map((path) => (
                    <code key={path}>{path}</code>
                  ))}
                  {raw && <pre>{JSON.stringify(event.raw ?? event, null, 2)}</pre>}
                </div>
              ))}
            </div>
            {cursor && (
              <button
                className="list-link"
                onClick={() =>
                  void call('members.getEvents', id, {
                    turnId,
                    cursor,
                    limit: 40,
                  })
                    .then((page) => {
                      setEvents((old) => [...page.events, ...old]);
                      setCursor(page.nextCursor);
                    })
                    .catch(() => undefined)
                }
              >
                이전 기록 더 보기 <ChevronDown size={15} />
              </button>
            )}
          </Section>
          <Section title="변경 파일">
            <Diff value={diff} />
          </Section>
          <Section title="세션 교체 이력">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>세션</th>
                    <th>종류</th>
                    <th>교체 사유</th>
                    <th>턴</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.sessions.map((session) => (
                    <tr key={session.id}>
                      <td>
                        {date(session.createdAt)}
                        {session.current && ' · 현재'}
                      </td>
                      <td>{SESSION_KIND_LABEL[session.kind]}</td>
                      <td>{session.replaceReason ?? '—'}</td>
                      <td>{session.turnCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
          <Section title="작업 이력">
            {detail.history.length ? <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>작업</th>
                    <th>결과</th>
                    <th>시간</th>
                    <th>반려</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.history.map((item) => (
                    <tr key={item.taskId}>
                      <td>
                        <button className="text-button" onClick={() => openTask(item.taskId)}>
                          {item.title}
                        </button>
                      </td>
                      <td>{TASK_STATE_LABEL[item.state]}</td>
                      <td>{duration(item.durationSec)}</td>
                      <td>{item.rejects}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div> : <p className="empty-history">아직 끝난 작업이 없습니다.</p>}
          </Section>
          <Section title="메인 에이전트 지시">
            {detail.messages.map((m) => (
              <p className="message-record" key={m.id}>
                {m.from} · {date(m.createdAt)} · {messageDeliveryStatus(m)}{m.undelivered && ` · ${resolveDisplayText(m.undelivered, snapshot)}`}
                <br />
                {m.text}
              </p>
            ))}
          </Section>
          <details className="developer-details"><summary>개발자 정보</summary><p className="muted">현재 세션 ID: {member.currentSessionId ?? '없음'}</p></details>
          <Section title="사용량">
            <p className="muted">팀원별 사용량 표시는 준비 중입니다.</p>
          </Section>
        </div>
      )}
    </aside>
  );
}
