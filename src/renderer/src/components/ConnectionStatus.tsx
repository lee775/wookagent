import { useEffect, useRef, useState } from 'react';
import type { WebConnectionState } from '../../../shared/ipc';
import { getBridge } from '../api/bridge';

export function connectionLabel(state: WebConnectionState, now: number, restored: boolean) {
  if (state.status === 'connecting') return '서버 연결 중';
  if (state.status === 'open') return restored ? '다시 연결됐습니다' : '서버 연결됨';
  const elapsed = Math.max(0, Math.floor((now - state.lostAt) / 1000));
  const retry = state.retryAt === null ? '지금 재시도 중' : `${Math.max(0, Math.ceil((state.retryAt - now) / 1000))}초 뒤 재시도`;
  return `연결 끊김 ${elapsed}초 · ${retry}`;
}
export function ConnectionStatus() {
  const web = getBridge().web;
  const [state, setState] = useState<WebConnectionState>({ status: 'connecting' });
  const [now, setNow] = useState(Date.now);
  const [restored, setRestored] = useState(false);
  const lost = useRef(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const off = web?.onConnection(next => {
      setState(next);
      if (next.status === 'reconnecting') lost.current = true;
      if (next.status === 'open' && lost.current) {
        lost.current = false; setRestored(true); clearTimeout(timer);
        timer = setTimeout(() => setRestored(false), 5000);
      }
    });
    return () => { off?.(); clearTimeout(timer); };
  }, [web]);
  useEffect(() => {
    if (state.status !== 'reconnecting') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.status]);
  if (!web) return null;
  return <div className={`web-connection connection-${state.status}`} role="status" aria-label="서버 연결 상태"><span aria-hidden="true" />{connectionLabel(state, now, restored)}</div>;
}
