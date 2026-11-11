import { useEffect, useState } from 'react';
import { Armchair, CircleAlert } from 'lucide-react';
import type { AppSnapshot } from '../../../shared/views';
import { duration } from '../lib/ui';
import { openCommand } from '../lib/commands';
import { runtime } from '../api/runtime';
import { holderLabel } from '../lib/agents';

export function SeatChip({ snapshot, open }: { snapshot: AppSnapshot; open: () => void }) {
  if (!snapshot.auth.loggedIn) return null;
  const seat = snapshot.seat;
  const holder = seat.holder?.label ?? '보유자 없음';
  const label = seat.state === 'vacant' ? '메인 에이전트 없음' : seat.state === 'stopped' ? `메인 에이전트 정지됨 · ${holderLabel(seat.holder)}` :
    `메인 에이전트: ${holderLabel(seat.holder)}${seat.state === 'switching' ? ` → ${holderLabel(seat.pendingHolder)} 교체 중` : ''}`;
  const compact = seat.state === 'active' ? holder : seat.state === 'switching' ? `${holder} → ${seat.pendingHolder?.label ?? '다음 보유자'}` : label;
  const external = seat.holder?.kind === 'external' || seat.pendingHolder?.kind === 'external';
  return <button className={`seat-chip seat-${seat.state}${external ? ' seat-external' : ''}`} onClick={open} aria-label={label} title={label}>
    <Armchair size={17} aria-hidden="true" /><span className="seat-chip-full">{label}</span><span className="seat-chip-compact">{external ? label : compact}</span>
    {seat.holder?.kind === 'launched' && <small>{seat.holder.ai.model ?? '기본 모델'}</small>}
  </button>;
}

export function SeatUnresponsive({ snapshot, stop }: { snapshot: AppSnapshot; stop: () => void }) {
  const [now, setNow] = useState(Date.now);
  const { seat } = snapshot;
  const stopped = snapshot.stop.global.active || seat.state === 'stopped';
  const desktop = runtime(snapshot).desktop;
  useEffect(() => {
    if (!snapshot.auth.loggedIn || !seat.unresponsiveSince || stopped) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snapshot.auth.loggedIn, seat.unresponsiveSince, stopped]);
  if (!snapshot.auth.loggedIn || !seat.unresponsiveSince) return null;
  const elapsed = Math.max(0, (now - Date.parse(seat.unresponsiveSince)) / 1000);
  const seatChangeNotice = seat.state === 'switching'
    ? `메인 자리를 ${seat.pendingHolder?.label ?? '다음 보유자'}에게 넘기고 있습니다.${snapshot.stop.pausedMembers.some(item => item.memberId === 'M-MAIN') ? ' 교체가 보류되어 있습니다. 메인 에이전트 정지 안내에서 정지 해제를 눌러 주세요.' : ''}`
    : `${desktop ? '자리를 바꾸는 것은 메인 에이전트, 또는 이 PC의 운영자가 운영 설정의 메인 AI로 할 수 있습니다' : '자리를 바꾸는 것은 메인 에이전트와 서버 PC의 운영자만 할 수 있습니다'}.`;
  return <section className="seat-unresponsive" aria-label="메인 에이전트 응답 없음">
    <CircleAlert size={20} aria-hidden="true" /><div className="seat-unresponsive-copy">
      <strong>메인 에이전트: {holderLabel(seat.holder)} — {stopped ? '긴급 정지 중이라 세지 않습니다' : `응답 없음 ${duration(elapsed)}`}</strong>
      {seat.unresponsiveReason && <p>{seat.unresponsiveReason}</p>}
      <p>{seat.holder?.kind === 'external' ? '명령은 계속 보낼 수 있습니다. 연결과 접근 권한은 자리와 인계에서 확인하세요. 급하면 긴급 정지를 쓰세요.' : '명령은 계속 보낼 수 있고, 보유자가 돌아오면 이어서 처리합니다. 급하면 긴급 정지를 쓰세요.'} {seatChangeNotice}</p>
      <div className="heading-actions"><button onClick={() => openCommand(null, '메인 에이전트의 응답을 기다리고 있습니다. ')}>메인 에이전트에게 말하기</button><button onClick={stop}>긴급 정지</button></div>
    </div>
  </section>;
}
